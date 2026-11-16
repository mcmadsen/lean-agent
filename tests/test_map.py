"""The live map: snapshot shape, edge ageing, private mode, service down, SVG, --watch, the bounded ring, socket speed."""
import io
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import xml.dom.minidom
from unittest import mock

from _env import clean_environ

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)

import lean_map  # noqa: E402
import lean_sock  # noqa: E402
import lean_threads  # noqa: E402
import service_session as ss  # noqa: E402


def ctx(n=3, runs=True):
    ths = [{"id": f"t{i}", "title": f"Thread {i}", "state": "active" if i == 1 else "parked", "detail": "x", "idle_s": 10800} for i in range(1, n + 1)]
    return {"service": {"pid": 1, "version": "0", "socket_ms": 0.6, "cpu_pct": 1.0, "threads": 5, "up_s": 9},
            "paused": False, "inbox": 2, "threads": ths, "desk_idle_s": 40,
            "runs": [{"id": "0116-090044-8545", "thread": "t1", "model": "sonnet", "age_s": 700, "progress_s": 20}] if runs else []}


class MapTest(unittest.TestCase):
    def setUp(self):
        lean_map.reset()
        self.tmp = tempfile.mkdtemp()
        p = mock.patch.dict(os.environ, {**clean_environ(), "LEAN_AGENT_HOME": self.tmp}, clear=True)
        p.start()
        self.addCleanup(p.stop)

    def test_shape(self):
        now = time.time()
        lean_map.record("message", "main", "service", "send · t1", now=now - 0.4)
        lean_map.record("message", "service", "t1", "deliver", node="t1", dir="to", text="message delivered", now=now - 0.4)
        lean_map.record("report", "t2", "service", "report", node="t2", dir="from", text="report to you", now=now - 10)
        lean_map.record_request("pending", 1.0, now=now - 1)
        s = lean_map.build(ctx(), now=now)
        self.assertEqual(s["v"], 1)
        self.assertTrue(s["service"]["up"])
        ids = {n["id"] for n in s["nodes"]}
        self.assertTrue({"service", "main", "hooks", "t1", "run:0116-090044-8545"} <= ids)
        w = [n for n in s["nodes"] if n["kind"] == "worker"][0]
        self.assertEqual((w["parent"], w["label"], w["state"]), ("t1", "run 8545", "alive"))
        kinds = {(e["from"], e["to"], e["kind"]) for e in s["edges"]}
        self.assertIn(("main", "service", "message"), kinds)
        self.assertIn(("service", "t1", "message"), kinds)
        self.assertIn(("hooks", "service", "request"), kinds)
        self.assertEqual(s["moving"][0]["text"], "message delivered")
        self.assertLessEqual(len(s["moving"]), 8)
        self.assertEqual(s["inbox"], 2)
        json.dumps(s)

    def test_edges_age_to_idle(self):
        now = time.time()
        lean_map.record("message", "service", "t2", "deliver", now=now - 31)
        s = lean_map.build(ctx(), now=now)
        e2 = [e for e in s["edges"] if e["to"] == "t2"]
        self.assertEqual([e["kind"] for e in e2], ["idle"])
        self.assertEqual({e["to"] for e in s["edges"] if e["kind"] == "idle"} & {"t1", "t2", "t3"}, {"t1", "t2", "t3"})

    def test_undelivered_is_red(self):
        c = ctx()
        c["threads"][1].update(state="undelivered", undelivered=True, detail="session ended")
        s = lean_map.build(c)
        self.assertTrue([e for e in s["edges"] if e.get("bad")])
        self.assertIn(lean_map.COLORS["bad"], lean_map.svg(s))

    def test_service_down(self):
        with mock.patch.object(lean_sock, "call", return_value=None):
            s = lean_map.fetch()
        self.assertEqual((s["service"], s["nodes"], s["edges"], s["moving"]), ({"up": False}, [], [], []))
        self.assertIn("not running", lean_map.svg(s))
        xml.dom.minidom.parseString(lean_map.svg(s))

    def test_private_hides(self):
        a = lean_threads.new("open work")
        b = lean_threads.new("secret work")
        with mock.patch.object(ss, "alive_thread", return_value=True), mock.patch.object(ss, "mid_turn", return_value=False), \
                mock.patch.object(ss, "spool_pending", return_value=[]), mock.patch.object(ss, "_quiet_secs", return_value=1), \
                mock.patch.object(ss, "session_transcript", return_value=None), \
                mock.patch("lean_private.hides", side_effect=lambda item=None, **kw: kw.get("thread") == b):
            c = lean_map.service_context()
        ids = [t["id"] for t in c["threads"]]
        self.assertIn(a, ids)
        self.assertNotIn(b, ids)

    def test_svg(self):
        now = time.time()
        for k, f, t in (("message", "main", "service"), ("report", "t2", "service"), ("request", "hooks", "service")):
            lean_map.record(k, f, t, "x", now=now)
        c = ctx(15)
        s = lean_map.build(c, now=now)
        for kw in ({}, {"mini": True}, {"width": 800, "height": 500}):
            doc = lean_map.svg(s, **kw)
            xml.dom.minidom.parseString(doc)
            self.assertNotIn("<script", doc)
            self.assertNotIn("http://", doc.replace("http://www.w3.org/2000/svg", ""))
            self.assertLess(len(doc.encode()), 128 * 1024)
        doc = lean_map.svg(s)
        self.assertIn("+3 more", doc)
        for col in ("#2EC4B6", "#F2A541", "#7AA2F7", "#5B6475"):
            self.assertIn(col, doc)
        self.assertEqual(lean_map.svg(s), lean_map.svg(s))

    def test_watch_emits_on_change_only(self):
        snaps = [lean_map.build(ctx(), now=time.time())]
        calls = {"n": 0}

        def fetcher():
            calls["n"] += 1
            if calls["n"] == 4:
                snaps[0] = lean_map.build(ctx(4))
            return snaps[0]
        out = io.StringIO()
        lean_map.watch(out, fetcher=fetcher, interval=0, stop=lambda: calls["n"] >= 6)
        self.assertEqual(len(out.getvalue().splitlines()), 2)

    def test_ring_bounded_no_files(self):
        before = set(os.listdir(self.tmp))
        for i in range(lean_map.RING_MAX * 3):
            lean_map.record("message", "main", "service", "x")
            lean_map.record_request("pending", 0.5)
        self.assertLessEqual(lean_map.ring_size(), lean_map.RING_MAX)
        self.assertEqual(set(os.listdir(self.tmp)), before)
        old = time.time() - 1000
        lean_map.record("report", "t1", "service", "old", now=old)
        self.assertFalse([e for e in lean_map.events() if e["label"] == "old"])

    def test_socket_map_fast(self):
        t = lean_threads.new("work")
        sock = os.path.join(self.tmp, "s.sock")
        srv = lean_sock.Server({"map": lambda r: {"map": lean_map.snapshot_now()}}, sock=sock)
        srv.observer = lean_map.record_request
        srv.start()
        self.addCleanup(srv.stop)
        t0 = time.monotonic()
        r = lean_sock.call("map", sock=sock, timeout=2)
        self.assertLess(time.monotonic() - t0, 0.3)
        self.assertEqual(r["map"]["v"], 1)
        self.assertTrue(r["map"]["service"]["up"])
        self.assertIn(t, [n["id"] for n in r["map"]["nodes"]])

    def test_serve_needs_token(self):
        import urllib.request
        import urllib.error
        out = io.StringIO()
        srv, url = lean_map.serve(open_browser=False, out=out, once=True)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        with mock.patch.object(lean_map, "fetch", return_value=lean_map.down_snapshot()):
            self.assertIn(b"<svg", urllib.request.urlopen(url.replace("/?", "/svg?")).read())
            with self.assertRaises(urllib.error.HTTPError):
                urllib.request.urlopen(url.split("?")[0])

    def test_run_end_and_start_edges(self):
        now = time.time()
        lean_map.run_started("0116-1-aaaa", "t1", "sonnet", now=now - 5)
        lean_map.run_ended("0116-2-bbbb", "t2", "failed", now=now - 2)
        lean_map.run_ended("0116-3-cccc", "t1", "done", now=now - 1)
        s = lean_map.build(ctx(runs=False), now=now)
        k = {(e["from"], e["to"], e["kind"], e["label"]) for e in s["edges"]}
        self.assertIn(("t1", "run:0116-1-aaaa", "message", "task"), k)
        self.assertIn(("run:0116-2-bbbb", "t2", "report", "result"), k)
        st = {n["id"]: n["state"] for n in s["nodes"]}
        self.assertEqual((st["run:0116-2-bbbb"], st["run:0116-3-cccc"], st["run:0116-1-aaaa"]), ("dead", "done", "alive"))
        self.assertEqual(s["moving"][0]["text"], "result ready")
        lean_map.run_started("0116-1-aaaa", "t1")  # once per run
        self.assertEqual(len([e for e in lean_map.events() if e["label"] == "task"]), 1)

    def test_service_records_run_end_once(self):
        fin = time.time() - 5
        run = {"id": "0116-9-dddd", "thread": "t1", "status": "done", "fin": fin, "task": "x"}
        with mock.patch.object(ss, "finished_thread_runs", return_value=[run]), mock.patch.object(ss, "queue_report"):
            ss.run_fallback()
            ss.run_fallback()
        ev = [e for e in lean_map.events() if e["label"] == "result"]
        self.assertEqual(len(ev), 1)
        self.assertEqual((ev[0]["from"], ev[0]["to"]), ("run:0116-9-dddd", "t1"))

    def _open(self, extra=None):
        import subprocess
        env = {**os.environ, "LEAN_AGENT_NO_BROWSER": "1", "LEAN_AGENT_NO_SOCKET": "1", **(extra or {})}
        t0 = time.monotonic()
        r = subprocess.run([sys.executable, os.path.join(ROOT, "lean_agent.py"), "map", "--open"], env=env, capture_output=True,
                           text=True, timeout=20)
        return r, time.monotonic() - t0

    def _pid(self, sf):
        with open(sf) as fh:
            return json.load(fh)["pid"]

    def _stop(self):
        try:
            with open(os.path.join(self.tmp, "map-open.json")) as fh:
                os.kill(json.load(fh)["pid"], 15)
        except Exception:
            pass

    def test_open_detached_reuse_token_and_idle_exit(self):
        import urllib.request
        import urllib.error
        r, dt = self._open({"LEAN_AGENT_MAP_IDLE": "3"})
        self.addCleanup(self._stop)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertLess(dt, 6.0 if os.environ.get("CI") else 2.0)  # returns once the server answers
        url = r.stdout.strip().splitlines()[-1]
        self.assertTrue(url.startswith("http://127.0.0.1:"))
        sf = os.path.join(self.tmp, "map-open.json")
        self.assertEqual(os.stat(sf).st_mode & 0o777, 0o600)
        pid = self._pid(sf)
        self.assertIn(b"<svg", urllib.request.urlopen(url.replace("/?", "/svg?"), timeout=3).read())
        with self.assertRaises(urllib.error.HTTPError):
            urllib.request.urlopen(url.split("?")[0] + "?token=wrong", timeout=3)
        r2, _ = self._open({"LEAN_AGENT_MAP_IDLE": "3"})
        self.assertEqual(r2.stdout.strip().splitlines()[-1], url)
        self.assertEqual(self._pid(sf), pid)
        end = time.time() + 12
        while time.time() < end and os.path.exists(sf):
            time.sleep(0.2)
        self.assertFalse(os.path.exists(sf), "the server did not exit when idle")


if __name__ == "__main__":
    unittest.main()
