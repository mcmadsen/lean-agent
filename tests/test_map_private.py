"""Hidden private projects leave the map entirely: snapshot, history, --svg/--json/--alerts, pane data, caches across a private on/off switch."""
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from unittest import mock

from _env import clean_environ

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)

import lean_activity as act  # noqa: E402
import lean_map  # noqa: E402
import lean_private  # noqa: E402
import lean_threads  # noqa: E402
import service_session as ss  # noqa: E402

SLUG, TID, TITLE, RUN, FILE = "vaultcorp", "t1", "Secret roadmap", "0101-000001-priv", "secretplan.md"
PUB_RUN = "0101-000002-pub"
SECRETS = [SLUG, TITLE, RUN, FILE]


def started():
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(time.time() - 30))


class MapPrivate(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        p = mock.patch.dict(os.environ, {**clean_environ(), "LEAN_AGENT_HOME": self.tmp}, clear=True)
        p.start()
        self.addCleanup(p.stop)
        self.write("projects.json", {SLUG: {"path": os.path.join(self.tmp, SLUG), "private": True}, "openproj": {"path": self.tmp}})
        self.threads = {TID: {"id": TID, "title": TITLE, "project": SLUG}, "t2": {"id": "t2", "title": "Public work", "project": "openproj"}}
        self.write("threads.json", {"threads": self.threads, "aliases": {}, "overrides": {}})
        day = time.strftime("%Y-%m-%d")
        rows = [{"id": RUN, "ts": day + "T00:00:01", "project": SLUG, "thread": TID, "model": "haiku", "status": "done", "cost_usd": 7.0, "weighted": 700},
                {"id": PUB_RUN, "ts": day + "T00:00:02", "project": "openproj", "thread": "t2", "model": "haiku", "status": "done", "cost_usd": 1.0, "weighted": 100}]
        with open(os.path.join(self.tmp, "ledger.jsonl"), "w") as fh:
            for r in rows:
                fh.write(json.dumps(r) + "\n")
        self.set_hidden(True)
        lean_map.reset()
        act.reset()
        lean_map._tcache.clear()
        lean_map._rcache[:] = [0.0, []]
        lean_map._pn.update(key=None, t=float("-inf"))
        lean_map._hcache.clear()
        runs = [(RUN, {"thread": TID, "project": SLUG, "model": "haiku", "started": started(), "workdir": self.tmp}),
                (PUB_RUN, {"thread": "t2", "project": "openproj", "model": "haiku", "started": started(), "workdir": self.tmp})]
        for patch in (mock.patch.object(lean_threads, "load_ro", return_value={"threads": self.threads}),
                      mock.patch.object(ss, "alive_thread", return_value=True), mock.patch.object(ss, "mid_turn", return_value=True),
                      mock.patch.object(ss, "spool_pending", return_value=[]), mock.patch.object(ss, "session_transcript", return_value=None),
                      mock.patch("lean_common.running_runs", return_value=runs)):
            patch.start()
            self.addCleanup(patch.stop)
        now = time.time()
        for node in (TID, "run:" + RUN, "t2"):
            act.ingest({"node": node, "tool": "Edit", "target": FILE if node != "t2" else "readme.md", "phase": "post", "ok": False, "id": node + "a"}, now=now - 5)
        lean_map.record("message", "main", TID, "send", node=TID, dir="out", text=f"please look at {SLUG} now")
        lean_map.record("message", "main", "t2", "send", node="t2", dir="out", text="hello there")
        lean_map.record("message", "main", "t2", "mentions " + SLUG)
        lean_map.run_ended(RUN, TID, "done")

    def write(self, name, data):
        with open(os.path.join(self.tmp, name), "w") as fh:
            json.dump(data, fh)

    def set_hidden(self, off):
        self.write("config.json", {"private": "off"} if off else {})

    def check_clean(self, text, what):
        for s in SECRETS + [TID + '"']:
            self.assertNotIn(s, text, f"{what} leaks {s}")

    def snap(self):
        return lean_map.snapshot_now()

    def test_snapshot_clean_and_totals(self):
        s = self.snap()
        self.check_clean(json.dumps(s), "snapshot")
        self.assertIn("t2", json.dumps(s))
        self.assertEqual(s["totals"]["runs_today"], 1)
        self.assertEqual(s["totals"]["usd_today"], 1.0)
        self.assertFalse([p for p in s["projects"] if p["slug"] == SLUG])

    def test_shown_has_them(self):
        self.set_hidden(False)
        s = self.snap()
        text = json.dumps(s)
        for x in (SLUG, TITLE, RUN, FILE):
            self.assertIn(x, text)
        self.assertEqual(s["totals"]["usd_today"], 8.0)

    def test_redact_catches_everything_even_from_an_old_service(self):
        self.set_hidden(False)
        raw = self.snap()
        self.set_hidden(True)
        lean_map._pn.update(key=None, t=float("-inf"))
        raw["alerts"] = raw.get("alerts", []) + [{"id": "x", "kind": "stuck", "node": TID, "level": "warn", "text": "x", "since": 1},
                                                 {"id": "y", "kind": "stuck", "node": None, "level": "warn", "text": f"{SLUG} slow", "since": 1}]
        raw["edges"].append({"from": "main", "to": "t2", "kind": "message", "label": SLUG, "age_s": 1})
        with mock.patch("lean_sock.call", return_value={"ok": True, "map": raw}):
            s = lean_map.fetch()
        self.check_clean(json.dumps(s), "fetch/--json")
        self.check_clean(lean_map.svg(raw), "svg")
        self.check_clean(lean_map.svg(raw, mini=True), "mini svg")
        for a in s.get("alerts") or []:
            self.assertNotIn(SLUG, a["text"])
        self.assertTrue([n for n in s["nodes"] if n["id"] == "t2"])

    def test_history(self):
        h = lean_map.history_cached(self.tmp, 3)
        self.check_clean(json.dumps(h), "history")
        self.assertEqual(sum(d["usd"] for d in h["days"]), 1.0)
        self.assertNotIn("Edit", json.dumps([t for t in h["tools_7d"] if t[1] > 1]))
        self.set_hidden(False)
        h2 = lean_map.history_cached(self.tmp, 3)
        self.assertEqual(sum(d["usd"] for d in h2["days"]), 8.0)

    def test_pane_data_shape_redaction_and_speed(self):
        now = time.time()
        goals = [{"id": "g1", "ref": "PR#1", "thread": TID, "state": "active", "target": "pr", "next": "secret next", "created": "2026-01-01T00:00:00"},
                 {"id": "g2", "ref": "PR#2", "thread": "t2", "state": "waiting-user", "target": "pr", "next": "answer: push",
                  "last_activity": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(now - 60))},
                 {"id": "g3", "ref": "PR#3", "thread": "t2", "state": "stuck", "target": "pr", "next": "x",
                  "last_activity": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(now - 5))}]
        self.write("goals.json", {"items": goals})
        qs = [{"id": "u1", "ts": now - 90, "text": "how is it?\nsecond line", "target": TID, "status": "answered", "answer": "private reply",
               "answered_ts": now - 60, "answer_read": False},
              {"id": "u2", "ts": now - 90, "text": "what now?", "target": "t2", "status": "answered", "answer": "do this\nmore", "answered_ts": now - 30,
               "answer_read": False},
              {"id": "u3", "ts": now - 900, "text": "old one", "target": "t2", "status": "answered", "answer": "done", "answered_ts": now - 800,
               "answer_read": True}]
        self.write("my-questions.json", {"items": qs})
        with mock.patch("lean_sock.call", return_value=None):
            p = lean_map.pane_data(now)
            self.assertEqual(sorted(p), ["answers", "desk", "goals", "inbox", "service", "ts", "v"])
            self.assertFalse(p["service"]["up"])
            self.assertEqual([g["id"] for g in p["goals"]], ["g3", "g2"])  # newest first, the private goal is left out
            self.assertEqual([g["state"] for g in p["goals"]], ["stuck", "waiting"])
            self.assertEqual([a["id"] for a in p["answers"]], ["q2", "q3"])  # unread first, the private answer is left out
            self.assertEqual((p["answers"][0]["unread"], p["answers"][1]["unread"]), (True, False))
            self.assertEqual(p["answers"][0]["a"], "do this")
            self.check_clean(json.dumps(p), "pane data")
            self.set_hidden(False)
            p2 = lean_map.pane_data(now)
            self.assertEqual(len(p2["goals"]), 3)
            self.assertEqual([a["id"] for a in p2["answers"]], ["q2", "q1", "q3"])
            t0 = time.time()
            for _ in range(5):
                lean_map.pane_data()
            self.assertLess((time.time() - t0) / 5, 0.15)


if __name__ == "__main__":
    unittest.main()
