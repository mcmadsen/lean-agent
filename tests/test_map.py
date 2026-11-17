"""The live map: snapshot shape, edge ageing, private mode, service down, SVG, --watch, the bounded ring, socket speed."""
import io
import json
import os
import sys
import tempfile
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
        self.assertEqual((s["service"]["up"], s["nodes"], s["edges"], s["moving"]), (False, [], [], []))  # (+ the socket looked at, the desk)
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
        self.assertIn("more</text>", doc)
        self.assertEqual(lean_map.svg(s), lean_map.svg(s))

    def test_svg_radial(self):
        c = ctx(4)
        c["threads"][1].update(state="undelivered", undelivered=True)
        c["threads"][2].update(state="waiting")
        s = lean_map.build(c)
        s["plan"] = {"windows": [{"name": "five_hour", "label": "5h", "pct": 42.0, "resets_at": int(time.time()) + 3600}]}
        doc = lean_map.svg(s, 380, 220, mini=True)
        dom = xml.dom.minidom.parseString(doc)
        self.assertEqual(doc.count('class="agent '), 4)
        self.assertEqual(doc.count('class="root"'), 1)
        self.assertIn("5h 42%", doc)
        self.assertIn("inbox 2", doc)
        for st in ("working", "attention", "failed", "idle"):
            self.assertIn(f'class="agent {st}"', doc)
            self.assertIn(lean_map.MX[st], doc)
        self.assertEqual(doc.count('class="session"'), 1)
        root = [g for g in dom.getElementsByTagName("g") if g.getAttribute("class") == "root"][0]
        circ = root.getElementsByTagName("circle")[0]
        self.assertEqual((float(circ.getAttribute("cx")), float(circ.getAttribute("cy")) > 100), (190.0, True))
        self.assertLess(len(doc.encode()), 8 * 1024)
        self.assertIn("<svg", lean_map.svg(s, 1200, 700))

    def test_svg_redaction_holds(self):
        c = ctx(2)
        c["threads"][0]["title"] = "SECRETPROJECT"
        s = lean_map.build(c)
        with mock.patch.object(lean_map, "redact", side_effect=lambda x: dict(x, nodes=[n for n in x["nodes"] if n["id"] != "t1"], placed=[i for i in x["placed"] if i != "t1"])):
            doc = lean_map.svg(s, 380, 220, mini=True)
        self.assertNotIn("SECRETPROJECT", doc)
        self.assertNotIn("S</text>", doc.replace("Service", ""))

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


class PaneCheckTest(unittest.TestCase):
    def test_pane_check_output(self):
        import subprocess
        tmp = tempfile.mkdtemp()
        env = {"HOME": tmp, "LEAN_AGENT_HOME": tmp, "PATH": "/usr/bin:/bin", "LEAN_AGENT_TEST": "1"}
        r = subprocess.run([sys.executable, os.path.join(ROOT, "lean_agent.py"), "map", "--pane-check"], env=env,
                           capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        lines = r.stdout.strip().splitlines()
        self.assertEqual([l.split(":")[0] for l in lines], ["binary", "service up", "json ok", "svg ok"])
        self.assertIn("service up: no", r.stdout)
        self.assertRegex(r.stdout, r"json ok: yes \(\d+ bytes\)")
        self.assertRegex(r.stdout, r"svg ok: yes \(\d+ bytes\)")


if __name__ == "__main__":
    unittest.main()
