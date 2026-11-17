"""Plan usage on the map: snapshot "plan", alerts, history series, `map --usage`."""
import datetime
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import lean_map  # noqa: E402
import usage  # noqa: E402



def iso(t):
    return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).isoformat(timespec="seconds")


class Home(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        p = mock.patch.dict(os.environ, {"LEAN_AGENT_HOME": self.tmp})
        p.start()
        self.addCleanup(p.stop)
        usage._plan_cache.clear()

    def write(self, age=60, status="allowed", five=(42.0, 7300), week=(61.0, 3 * 86400), extra=None):
        now = time.time()
        wins = {"five_hour": {"pct": five[0], "resets_at": now + five[1]},
                "seven_day": {"pct": week[0], "resets_at": now + week[1]}}
        wins.update(extra or {})
        with open(usage.plan_usage_path(), "w") as fh:
            json.dump({"at": iso(now - age), "status": status, "windows": wins}, fh)
        return now


class SnapshotTest(Home):
    def test_fresh(self):
        now = self.write(age=120, extra={"seven_day_opus": {"pct": 10.0, "resets_at": time.time() + 86400}})
        p = usage.plan_report(now)
        self.assertEqual([w["name"] for w in p["windows"]], ["five_hour", "seven_day", "seven_day_opus"])
        w = p["windows"][0]
        self.assertEqual((w["label"], w["pct"], w["source"]), ("5-hour", 42.0, "claude"))
        self.assertAlmostEqual(w["resets_in_s"], 7300, delta=2)
        self.assertEqual(p["status"], "allowed")
        self.assertAlmostEqual(p["age_s"], 120, delta=2)
        self.assertIn(p["windows"][1]["pace"], ("on pace", "30 points ahead") + tuple(f"{i} points ahead" for i in range(11, 100)))
        self.assertIsNone(w["pace"])

    def test_passed_reset(self):
        now = self.write(five=(90.0, -10))
        w = usage.plan_report(now)["windows"][0]
        self.assertEqual((w["pct"], w["resets_at"], w["resets_in_s"]), (0.0, None, None))

    def test_stale_falls_back_to_estimate(self):
        now = self.write(age=7 * 3600)
        p = usage.plan_report(now)
        self.assertEqual(p["windows"], [])  # no cached buckets: nothing to estimate from
        est = {"5h": {"plan_pct": 33.3, "reset": datetime.datetime.fromtimestamp(now + 3600, datetime.timezone.utc)},
               "week": {"plan_pct": 12.0, "reset": None}}
        os.makedirs(self.tmp, exist_ok=True)
        with open(os.path.join(self.tmp, "windows.json"), "w") as fh:
            json.dump({"v": 2, "buckets": {"2020-01-01T00:00": {"lean": 1, "all": 1}}}, fh)
        with mock.patch.object(usage, "window_usage", return_value=est):
            p = usage.plan_report(now)
        self.assertEqual([(w["name"], w["source"], w["pct"]) for w in p["windows"]],
                         [("five_hour", "estimate", 33.3), ("seven_day", "estimate", 12.0)])
        self.assertAlmostEqual(p["windows"][0]["resets_in_s"], 3600, delta=2)
        self.assertIsNone(p["windows"][1]["resets_at"])
        self.assertIsNotNone(p["as_of"])

    def test_none(self):
        p = usage.plan_report()
        self.assertEqual((p["as_of"], p["windows"], p["status"]), (None, [], None))

    def test_build_has_plan(self):
        self.write()
        with mock.patch.object(lean_map, "service_context", return_value={}):
            s = lean_map.snapshot_now()
        self.assertEqual(s["plan"]["windows"][0]["name"], "five_hour")


class AlertTest(Home):
    def alerts(self, **kw):
        now = self.write(**kw)
        extra = {"plan": usage.plan_report(now)}
        return [a for a in lean_map.alerts({}, [], extra, now) if a["kind"] == "plan"]

    def test_levels(self):
        self.assertEqual(self.alerts(five=(79.0, 3000), week=(10.0, 86400 * 3)), [])
        a = self.alerts(five=(80.0, 3000), week=(10.0, 86400 * 3))
        self.assertEqual([(x["id"], x["level"]) for x in a], [("plan:five_hour", "warn")])
        a = self.alerts(five=(96.0, 2340), week=(85.0, 86400 * 3))
        self.assertEqual({x["id"]: x["level"] for x in a}, {"plan:five_hour": "bad", "plan:seven_day": "warn"})
        t = [x for x in a if x["id"] == "plan:five_hour"][0]["text"]
        self.assertTrue(t.startswith("5-hour limit 96 % - resets "), t)
        self.assertIn("(in 38 min)", t)

    def test_rejected(self):
        a = self.alerts(status="rejected", five=(50.0, 3000), week=(20.0, 86400))
        self.assertEqual([(x["id"], x["level"]) for x in a], [("plan:five_hour", "bad")])


class HistoryTest(Home):
    def test_append_and_bounds(self):
        now = time.time()
        usage._append_plan_history({"five_hour": {"pct": 5.0}, "seven_day": {"pct": 9.0}}, now - 8 * 86400)
        usage._append_plan_history({"five_hour": {"pct": 6.0}}, now - 86400)
        usage._append_plan_history({"seven_day": {"pct": 11.0}}, now)
        usage._append_plan_history({}, now)  # nothing to record
        rows = usage.plan_history(now)
        self.assertEqual([(r["five_hour"], r["seven_day"]) for r in rows], [(6.0, None), (None, 11.0)])
        with open(usage.plan_history_path()) as fh:
            self.assertEqual(len(fh.read().splitlines()), 2)  # the 8-day-old line was rotated out

    def test_max_lines(self):
        now = time.time()
        with mock.patch.object(usage, "PLAN_HISTORY_MAX", 10):
            for i in range(25):
                usage._append_plan_history({"five_hour": {"pct": float(i)}}, now - 100 + i)
            rows = usage.plan_history(now)
            with open(usage.plan_history_path()) as fh:
                n = len(fh.read().splitlines())
        self.assertEqual(len(rows), 10)
        self.assertEqual(rows[-1]["five_hour"], 24.0)
        self.assertLessEqual(n, 11)

    def test_record_and_history_endpoint(self):
        usage.record_plan_usage({"status": "allowed", "unifiedWindows": {
            "five_hour": {"utilization": 0.42, "resetsAt": time.time() + 3600},
            "seven_day": {"utilization": 0.61, "resetsAt": time.time() + 86400}}})
        h = lean_map.history(self.tmp, rows=[])
        self.assertEqual(len(h["plan"]), 1)
        self.assertEqual((h["plan"][0]["five_hour"], h["plan"][0]["seven_day"]), (42.0, 61.0))
        self.assertIn("ts", h["plan"][0])


class UsageCmdTest(Home):
    def run_cmd(self):
        env = {"HOME": self.tmp, "LEAN_AGENT_HOME": self.tmp, "PATH": "/usr/bin:/bin", "LEAN_AGENT_TEST": "1"}
        return subprocess.run([sys.executable, os.path.join(ROOT, "lean_agent.py"), "map", "--usage"], env=env,
                              capture_output=True, text=True, timeout=60)

    def test_lines(self):
        self.write(five=(42.0, 7260), week=(61.0, 3 * 86400))
        r = self.run_cmd()
        self.assertEqual(r.returncode, 0, r.stderr)
        lines = r.stdout.strip().splitlines()
        self.assertEqual(len(lines), 2, r.stdout)
        self.assertRegex(lines[0], r"^5-hour 42% resets \d\d:\d\d \(in 2h 0[01]m\)$")
        self.assertRegex(lines[1], r"^week 61% resets \w{3} \d\d:\d\d \((on pace|\d+ points ahead)\)$")

    def test_none(self):
        r = self.run_cmd()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("no plan usage", r.stdout)


if __name__ == "__main__":
    unittest.main()
