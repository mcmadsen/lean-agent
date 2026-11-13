"""The service socket: server lifecycle, every op, delivery without a tick, one-time pending, fallback to files."""
import contextlib
import io
import json
import os
import socket
import stat
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

from _env import clean_environ

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)

import lean_agent  # noqa: E402
import lean_sock  # noqa: E402
import lean_threads  # noqa: E402
import service_session as ss  # noqa: E402


class SocketTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.env = mock.patch.dict(os.environ, {**clean_environ(), "LEAN_AGENT_HOME": self.tmp}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.tid = lean_threads.new("work")
        lean_threads.set_session(self.tid, session_id="11111111-1111-1111-1111-111111111111", session_on=True)
        self.delivered = []
        self.dl = ss.SpoolDeliverer(run=self.fake_run)
        # the in-process delivery (starts sessions) is not under test here: a stand-in that leaves it to the deliverer
        p = mock.patch.object(lean_agent, "deliver_with_cap", side_effect=lambda tid, own=None, new=False, resume=False, wait=None:
                              (time.sleep(0.05), f"{tid}: queued")[1])
        p.start()
        self.addCleanup(p.stop)
        self.stop = threading.Event()
        self.server = None

    def fake_run(self, tid):
        for n in ss.spool_pending(tid):
            if ss.spool_claim(tid, n) is not None:
                self.delivered.append((tid, n))
                ss.spool_done(tid, n)
        return True, ""

    def start(self, loop=False):
        self.server = lean_sock.Server(lean_agent.sock_handlers(self.dl), version="9.9").start()
        self.addCleanup(self.server.stop)
        if loop:
            threading.Thread(target=self.dl.loop, args=(self.stop, 30), daemon=True).start()
            self.addCleanup(self.stop.set)
        return self.server

    def test_start_stop_and_stale(self):
        p = lean_sock.path()
        open(p, "w").close()  # a stale leftover
        srv = self.start()
        self.assertTrue(stat.S_ISSOCK(os.stat(p).st_mode))
        self.assertEqual(stat.S_IMODE(os.stat(p).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(os.path.dirname(p)).st_mode), 0o700)
        r = lean_sock.call("ping")
        self.assertTrue(r["ok"] and r["version"] == "9.9" and r["pid"] == os.getpid())
        srv.stop()
        self.assertFalse(os.path.exists(p))
        self.assertIsNone(lean_sock.call("ping"))
        self.assertEqual(lean_sock.state()[0], "missing")
        s = socket.socket(socket.AF_UNIX)
        s.bind(p)
        s.close()  # a socket file nobody listens on
        self.assertEqual(lean_sock.state()[0], "stale")
        self.start()
        self.assertEqual(lean_sock.state()[0], "listening")

    def test_bad_requests(self):
        self.start()
        self.assertFalse(lean_sock.call("nope")["ok"])
        s = socket.socket(socket.AF_UNIX)
        s.connect(lean_sock.path())
        s.sendall(b"not json\n")
        self.assertFalse(json.loads(s.makefile().readline())["ok"])
        s.close()

    def test_send_delivers_without_a_tick(self):
        self.start(loop=True)
        t0 = time.monotonic()
        r = lean_sock.call("send", thread=self.tid, text="hello")
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["state"], "queued", r)  # queued after the stand-in's cap ...
        self.assertLess(time.monotonic() - t0, 1.5)
        deadline = time.monotonic() + 3
        while not self.delivered and time.monotonic() < deadline:  # ... and the kick delivers it, the loop's interval is 30 s
            time.sleep(0.01)
        self.assertEqual(len(self.delivered), 1)
        self.assertEqual(ss.spool_pending(self.tid), [])

    def test_wake_and_unknown_thread(self):
        self.start(loop=True)
        r = lean_sock.call("wake", thread=self.tid)
        self.assertTrue(r["ok"] and r["line"], r)
        self.assertFalse(lean_sock.call("send", thread="t999", text="x")["ok"])

    def test_pending_takes_once_two_hooks(self):
        self.start()
        ss.spool_add(self.tid, "one message")
        got = []

        def hook():
            r = lean_sock.call("pending", thread=self.tid, session_id="s")
            got.append(r.get("text"))

        ths = [threading.Thread(target=hook) for _ in range(4)]
        [t.start() for t in ths]
        [t.join() for t in ths]
        texts = [g for g in got if g]
        self.assertEqual(len(texts), 1, got)
        self.assertIn("one message", texts[0])

    def run_cli(self, argv, sock):
        out, err = io.StringIO(), io.StringIO()
        env = {"LEAN_AGENT_NO_SOCKET": "1"} if not sock else {}
        with mock.patch.dict(os.environ, env), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                rc = lean_agent.main(argv)
            except SystemExit as exc:
                rc = exc.code
        return rc, out.getvalue(), err.getvalue()

    def test_identical_output_socket_vs_files(self):
        self.start()
        for argv in (["now"], ["now", "--short"], ["runs"], ["runs", "--running"], ["runs", "--last"], ["runs", "--show", "nope"],
                     ["runs", "--show"], ["runs", "--stop", "nope"]):
            files = self.run_cli(argv, sock=False)
            sock = self.run_cli(argv, sock=True)
            self.assertEqual(files, sock, argv)
        # and the socket really answered
        r = lean_sock.call("runs", args=["--running"])
        self.assertTrue(r["ok"] and "rc" in r)
        self.assertTrue(lean_sock.call("show", id="nope", tail=3)["ok"])
        self.assertTrue(lean_sock.call("stop", run="nope")["ok"])
        self.assertTrue(lean_sock.call("now")["ok"])

    def test_hung_server_costs_less_than_three_seconds(self):
        p = lean_sock.path()
        srv = socket.socket(socket.AF_UNIX)
        srv.bind(p)
        srv.listen(8)
        self.addCleanup(srv.close)
        t0 = time.monotonic()
        self.assertIsNone(lean_sock.call("ping"))
        out = self.run_cli(["runs", "--running"], sock=True)
        self.assertLess(time.monotonic() - t0, 4.5)  # two hung attempts at 2 s each at most
        self.assertEqual(out[0], 0)
        t0 = time.monotonic()
        self.assertIsNone(lean_sock.call("ping"))
        self.assertLess(time.monotonic() - t0, 3)

    def test_absent_socket_falls_back_silently(self):
        r = self.run_cli(["runs", "--running"], sock=True)
        self.assertEqual(r[0], 0)
        self.assertNotIn("socket", r[2])

    def test_trampoline_uses_the_socket_with_identical_output(self):
        import subprocess
        self.start()
        tr = os.path.join(ROOT, "trampoline.py")

        def run(extra):
            t0 = time.monotonic()
            r = subprocess.run([sys.executable, tr, "lean_agent.py", "runs", "--running"], capture_output=True, text=True,
                               env={**os.environ, **extra})
            return (r.returncode, r.stdout, r.stderr), time.monotonic() - t0

        files, _ = run({"LEAN_AGENT_NO_SOCKET": "1"})
        sock, secs = run({})
        self.assertEqual(files, sock)
        self.assertLess(secs, 0.3)  # lean_agent.py is not even compiled when the service answers

    def test_hook_round_trip_is_fast(self):
        self.start()
        lean_sock.call("ping")
        t0 = time.monotonic()
        for _ in range(20):
            lean_sock.call("pending", thread=self.tid)
        per = (time.monotonic() - t0) / 20
        self.assertLess(per, 0.05, per)


if __name__ == "__main__":
    unittest.main()
