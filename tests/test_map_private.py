"""Hidden private projects leave the live map entirely: snapshot, /snap, /history, /replay, /map.svg, --svg/--json/--html/--alerts,
caches across a private on/off switch."""
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
import lean_maplive  # noqa: E402
import lean_private  # noqa: E402
import lean_threads  # noqa: E402
import service_session as ss  # noqa: E402
from test_map_alerts import http_get  # noqa: E402

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
        page = lean_maplive.build_html(s, {"port": 1, "token": "x"})
        self.check_clean(page, "html")
        self.assertTrue([n for n in s["nodes"] if n["id"] == "t2"])

    def test_history(self):
        h = lean_map.history_cached(self.tmp, 3)
        self.check_clean(json.dumps(h), "history")
        self.assertEqual(sum(d["usd"] for d in h["days"]), 1.0)
        self.assertNotIn("Edit", json.dumps([t for t in h["tools_7d"] if t[1] > 1]))
        self.set_hidden(False)
        h2 = lean_map.history_cached(self.tmp, 3)
        self.assertEqual(sum(d["usd"] for d in h2["days"]), 8.0)

    def test_live_endpoints_and_switch(self):
        live = lean_maplive.Live(lean_map.snapshot_now, self.tmp, interval=0.2).start()
        self.addCleanup(live.stop)
        live.record_replay("tool", {"node": TID, "tool": "Edit", "target": FILE, "ok": True})
        live.record_replay("tool", {"node": "t2", "tool": "Edit", "target": "readme.md", "ok": True})
        live.record_replay("tool", {"node": "t2", "tool": "Read", "target": SLUG + " notes", "ok": True})
        live.record_replay("send", {"from": "main", "to": TID})

        def get(path):
            head, _, body = http_get(live.port, f"{path}{'&' if '?' in path else '?'}t={live.token}")
            self.assertIn("200", head, path)
            return body.decode()
        for path in ("/snap", "/history", "/replay", "/map.svg", "/map.svg?mini=1", "/"):
            self.check_clean(get(path), path)
        self.assertIn("readme.md", get("/replay"))
        self.set_hidden(False)
        self.assertIn(SLUG, get("/snap"))
        self.assertIn(FILE, get("/replay"))
        self.assertIn(TITLE, get("/map.svg"))
        self.set_hidden(True)
        self.check_clean(get("/snap"), "/snap after switch")
        self.check_clean(get("/map.svg"), "/map.svg after switch")
        self.check_clean(get("/history"), "/history after switch")

    def test_file_refresh_rewrites_on_switch(self):
        live = lean_maplive.Live(lean_map.snapshot_now, self.tmp, interval=0.2)
        out = os.path.join(self.tmp, "map.html")
        self.set_hidden(False)
        lean_maplive.register_refresh(self.tmp, out)
        live._refresh_once()
        with open(out) as fh:
            self.assertIn(SLUG, fh.read())
        self.set_hidden(True)
        live._refresh_once()
        with open(out) as fh:
            self.check_clean(fh.read(), "refreshed html")


if __name__ == "__main__":
    unittest.main()
