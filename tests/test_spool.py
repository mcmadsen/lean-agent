"""Thread messages are spooled and delivered by the service: callers never wait for a session (fake clock / fake services)."""
import argparse
import contextlib
import io
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

from _env import clean_environ, scaled

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)

import lean_agent  # noqa: E402
import lean_goals  # noqa: E402
import lean_threads  # noqa: E402
import service_session as ss  # noqa: E402


class SpoolTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.env = mock.patch.dict(os.environ, {**clean_environ(), "LEAN_AGENT_HOME": self.tmp, "LEAN_AGENT_SEND_WAIT": "1.5"}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.tid = lean_threads.new("work")
        lean_threads.set_session(self.tid, session_id="11111111-1111-1111-1111-111111111111", session_on=True)
        self.socks = []

    def hung_service(self):
        """A bridge socket that accepts connections and never answers."""
        path = ss.sock_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(path)
        srv.listen(8)
        self.socks.append(srv)
        self.addCleanup(srv.close)
        conns = []

        def accept():
            while True:
                try:
                    conns.append(srv.accept()[0])
                except OSError:
                    return
        threading.Thread(target=accept, daemon=True).start()

    def send(self, text="status check?"):
        ns = lean_agent.build_parser().parse_args(["thread", "send", self.tid, text])
        out = io.StringIO()
        t0 = time.time()
        with contextlib.redirect_stdout(out):
            rc = lean_agent.cmd_thread(ns)
        return rc, out.getvalue().strip(), time.time() - t0

    def test_send_to_a_service_that_never_answers_returns_within_the_cap_and_queues(self):
        self.hung_service()
        rc, line, took = self.send()
        self.assertEqual(rc, 0)
        self.assertLess(took, scaled(8))
        self.assertIn(f"{self.tid}: queued, waking", line)
        files = os.listdir(ss.spool_dir(self.tid))  # queued, or claimed by the delivery still waiting in this process
        self.assertEqual(len([f for f in files if f.endswith((".json", ".sending"))]), 1)

    def test_a_claim_of_a_dead_deliverer_goes_back_to_the_queue(self):
        name = ss.spool_add(self.tid, "x")
        ss.spool_claim(self.tid, name)
        dead = os.fork() if hasattr(os, "fork") else None
        if dead == 0:
            os._exit(0)
        os.waitpid(dead, 0)
        path = os.path.join(ss.spool_dir(self.tid), name[:-5] + ".sending")
        with open(path, "w") as fh:
            fh.write('{"text": "x", "claimed_by": %d}' % dead)
        os.utime(path, (time.time() - 60, time.time() - 60))
        ss.spool_reclaim_stale(self.tid)
        self.assertEqual(ss.spool_pending(self.tid), [name])

    def test_queued_message_is_delivered_once_and_in_order_by_the_service(self):
        for text in ("first", "second", "third"):
            ss.spool_add(self.tid, text)
        got = []

        def deliver(tid):
            r = lean_agent.deliver_spool(tid, 0)
            return r[0] == "ok", r[1]
        with mock.patch.object(ss, "alive", return_value=True), mock.patch.object(lean_agent, "auto_fresh_reason", return_value=""), \
                mock.patch.object(ss, "send", side_effect=lambda text, key="main": got.append(text) or (True, "")):
            d = ss.SpoolDeliverer(run=deliver)
            for t in d.tick():
                t.join(scaled(10))
            d.tick()  # nothing left: no second delivery
        self.assertEqual(got, ["first", "second", "third"])
        self.assertEqual(ss.spool_pending(self.tid), [])

    def test_failed_delivery_stays_queued_and_is_retried_later(self):
        ss.spool_add(self.tid, "again")
        clock = [1000.0]
        calls = []
        d = ss.SpoolDeliverer(run=lambda tid: calls.append(tid) or (len(calls) > 1, "boom"), now=lambda: clock[0])
        for t in d.tick():
            t.join(scaled(5))
        self.assertEqual(len(calls), 1)
        for t in d.tick():  # inside the retry gap
            t.join(scaled(5))
        self.assertEqual(len(calls), 1)
        clock[0] += ss.SPOOL_RETRY + 1
        for t in d.tick():
            t.join(scaled(5))
        self.assertEqual(len(calls), 2)

    def test_a_claimed_message_is_taken_once(self):
        name = ss.spool_add(self.tid, "x")
        self.assertEqual(ss.spool_claim(self.tid, name)["text"], "x")
        self.assertIsNone(ss.spool_claim(self.tid, name))
        ss.spool_release(self.tid, name)
        self.assertEqual(ss.spool_pending(self.tid), [name])

    def test_goal_watchdog_send_does_not_block(self):
        self.hung_service()
        t0 = time.time()
        ok, _ = ss.goal_send(self.tid, "status?")
        self.assertTrue(ok)
        self.assertLess(time.time() - t0, 1)
        self.assertEqual(len(ss.spool_pending(self.tid)), 1)

    def test_no_service_is_still_an_error(self):
        ns = lean_agent.build_parser().parse_args(["thread", "send", self.tid, "hi"])
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            lean_agent.cmd_thread(ns)
        self.assertEqual(ss.spool_pending(self.tid), [])


if __name__ == "__main__":
    unittest.main()
