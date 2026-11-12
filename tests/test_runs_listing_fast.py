"""0.45.57: run listings stay fast with many lost markers and a big ledger; old lost markers are archived; a marker
without a task is never listed; `runs --lost` shows the last 7 days (--all: everything)."""
import datetime
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)

import lean_common  # noqa: E402


def iso(days_ago=0.0):
    return (datetime.datetime.now() - datetime.timedelta(days=days_ago)).strftime("%Y-%m-%dT%H:%M:%S")


def dead_pid():
    p = subprocess.Popen([sys.executable, "-c", "pass"])
    p.wait()
    return p.pid


class Listing(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.tmp, "running"))
        self.pid = dead_pid()
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("LEAN_AGENT_")}
        self.env["LEAN_AGENT_HOME"] = self.tmp
        self.env["LEAN_AGENT_TEST"] = "1"

    def marker(self, rid, days_ago, **extra):
        m = {"run": rid, "pid": self.pid, "started": iso(days_ago), "task": f"task {rid}", "model": "sonnet", "project": "demo",
             "detached": True, "thread": "t1"}
        m.update(extra)
        with open(os.path.join(self.tmp, "running", rid + ".json"), "w") as fh:
            json.dump(m, fh)

    def ledger(self, n):
        with open(os.path.join(self.tmp, "ledger.jsonl"), "a") as fh:
            for i in range(n):
                fh.write(json.dumps({"id": f"0101-{i:06d}-abcd", "ts": "2026-01-01T00:00:00", "started": "2026-01-01T00:00:00",
                                     "project": "demo", "model": "sonnet", "task": "t", "status": "done", "thread": "t1"}) + "\n")

    def threads(self):
        with open(os.path.join(self.tmp, "threads.json"), "w") as fh:
            json.dump({"threads": {"t1": {"created": "2026-01-01T00:00:00"}}, "aliases": {}, "overrides": {}}, fh)

    def cli(self, *args):
        t = time.time()
        p = subprocess.run([sys.executable, os.path.join(ROOT, "lean_agent.py"), *args], env=self.env, capture_output=True, text=True, timeout=120)
        return p.stdout, time.time() - t

    def test_listings_fast_with_many_lost_and_big_ledger(self):
        self.ledger(2500)
        self.threads()
        for i in range(120):
            self.marker(f"1001-{i:06d}-beef", 0.5 + (i % 5) * 0.1)
        for args in (("runs", "--running"), ("runs",), ("runs", "--lost"), ("now",)):
            out, secs = self.cli(*args)
            self.assertLess(secs, 4, f"{args} took {secs:.1f}s")  # was 5 s+ before; generous for slow CI machines
        out, secs = self.cli("runs", "--lost")
        self.assertIn("lost", out)

    def test_settle_reads_the_ledger_once(self):
        import lean_goals
        self.ledger(300)
        for i in range(30):
            self.marker(f"1001-{i:06d}-beef", 0.1, thread="")
        os.environ["LEAN_AGENT_HOME"] = self.tmp
        try:
            opened = []
            real = open

            def spy(f, *a, **k):
                if str(f).endswith("ledger.jsonl") and "a" not in (a[0] if a else k.get("mode", "r")):
                    opened.append(f)
                return real(f, *a, **k)
            import builtins
            builtins.open = spy
            try:
                lean_goals.settle_orphan_markers({"threads": {}, "aliases": {}, "overrides": {}})
            finally:
                builtins.open = real
        finally:
            os.environ.pop("LEAN_AGENT_HOME", None)
        self.assertLessEqual(len(opened), 6)  # a few passes, not one per marker

    def test_old_lost_markers_are_archived_with_their_row(self):
        self.marker("1001-000001-beef", 3, thread="")
        self.marker("1001-000002-beef", 0.2, thread="")
        self.cli("runs", "--lost")  # settles: rows for both; a row written just now archives nothing yet
        run = os.path.join(self.tmp, "running")
        self.assertTrue(os.path.exists(os.path.join(run, "1001-000001-beef.json")))
        with open(os.path.join(self.tmp, "ledger.jsonl"), encoding="utf-8") as fh:
            rows = [json.loads(x) for x in fh]
        self.assertEqual({r["id"] for r in rows}, {"1001-000001-beef", "1001-000002-beef"})
        with open(os.path.join(self.tmp, "ledger.jsonl"), "w", encoding="utf-8") as fh:  # the rows are old now
            for r in rows:
                r["ts"] = iso(2)
                fh.write(json.dumps(r) + "\n")
        self.cli("runs", "--lost")
        self.assertFalse(os.path.exists(os.path.join(run, "1001-000001-beef.json")))
        self.assertTrue(os.path.exists(os.path.join(run, "archive", "1001-000001-beef.json")))
        self.assertTrue(os.path.exists(os.path.join(run, "1001-000002-beef.json")))  # younger than a day: stays
        out, _ = self.cli("runs", "--show", "1001-000001-beef")  # the archived run is still found
        self.assertIn("lost", out)

    def test_lost_window_default_seven_days_all_shows_everything(self):
        self.marker("1001-000001-beef", 10, thread="")
        self.marker("1001-000002-beef", 2, thread="")
        os.makedirs(os.path.join(self.tmp, "running", "archive"))
        out, _ = self.cli("runs", "--lost")
        self.assertIn("1001-000002-beef", out)
        self.assertIn("1001-000001-beef", out)  # not archived yet: listed whatever its age
        for rid, d in (("1001-000003-beef", 10), ("1001-000004-beef", 2)):  # archived ones: only the last 7 days
            self.marker(rid, d, thread="")
            os.replace(os.path.join(self.tmp, "running", rid + ".json"), os.path.join(self.tmp, "running", "archive", rid + ".json"))
        out, _ = self.cli("runs", "--lost")
        self.assertIn("1001-000004-beef", out)
        self.assertNotIn("1001-000003-beef", out)
        out, _ = self.cli("runs", "--lost", "--all")
        self.assertIn("1001-000003-beef", out)
        out, _ = self.cli("runs", "--lost", "--all")
        self.assertIn("1001-000001-beef", out)
        self.assertIn("1001-000002-beef", out)

    def test_backlog_archived_once_by_the_startup_cleanup(self):
        import service_session
        os.environ["LEAN_AGENT_HOME"] = self.tmp
        try:
            for i in range(5):
                self.marker(f"1001-00000{i}-beef", 5 + i, thread="")
            self.assertEqual(service_session.archive_lost_backlog(), 5)
            self.marker("1001-000009-beef", 5, thread="")
            self.assertEqual(service_session.archive_lost_backlog(), 0)  # one time only (the new marker stays)
            self.assertEqual(len(os.listdir(os.path.join(self.tmp, "running", "archive"))), 5)
        finally:
            os.environ.pop("LEAN_AGENT_HOME", None)

    def test_taskless_marker_alive_is_listed_dead_is_settled(self):
        with open(os.path.join(self.tmp, "running", "abcdef0123456789.json"), "w") as fh:
            json.dump({"pid": os.getpid(), "started": iso()}, fh)  # alive, no task: still a live run
        with open(os.path.join(self.tmp, "running", "0123456789abcdef.json"), "w") as fh:
            json.dump({"pid": self.pid, "started": iso()}, fh)  # gone, no task: a leftover
        self.assertEqual([r for r, _ in lean_common.running_runs(self.tmp)], ["abcdef0123456789"])
        self.assertEqual(lean_common.lost_runs(self.tmp), [])
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "running", "0123456789abcdef.json")))
        self.assertTrue(os.path.exists(os.path.join(self.tmp, "running", "abcdef0123456789.json")))

    def test_early_marker_of_a_starting_run_shows_starting_with_its_id(self):
        self.marker("1001-000001-beef", 0, pid=os.getpid(), early=True)
        out, _ = self.cli("runs", "--running")
        self.assertIn("1001-000001-beef  starting", out)

    def test_two_markers_of_one_run_list_once(self):
        self.marker("1001-000001-beef", 0, pid=os.getpid(), early=True)
        with open(os.path.join(self.tmp, "running", "feedfeedfeedfeed.json"), "w") as fh:
            json.dump({"run": "1001-000001-beef", "pid": os.getpid(), "started": iso(), "task": "x", "early": True}, fh)
        self.assertEqual(len(lean_common.running_runs(self.tmp)), 1)


if __name__ == "__main__":
    unittest.main()
