"""Sessions only run for open, valid, known threads, always under a lean-agent name; orphans are stopped."""
import os
import sys
import tempfile
import threading
import unittest
from unittest import mock

from _env import clean_environ

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)

import lean_threads  # noqa: E402
import service_session as ss  # noqa: E402
import session_hook  # noqa: E402
import budget_hook  # noqa: E402


class FakeHost:
    def __init__(self, tid, name):
        self.key, self.name = tid, name
        self.stopping = threading.Event()
        self.thread = None
        self.last_output = self.last_input = 0

    def stop(self):
        self.stopping.set()
        self.thread.stop_now = True

    def alive(self):
        return not self.stopping.is_set()

    def run(self):
        while not self.stopping.wait(0.02):
            pass


class OrphanTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        env = mock.patch.dict(os.environ, {**clean_environ(), "LEAN_AGENT_HOME": self.tmp}, clear=True)
        env.start()
        self.addCleanup(env.stop)
        self.tid = lean_threads.new("work")
        lean_threads.set_session(self.tid, session_on=True)
        self.sessions = ss.Sessions(lambda tid: FakeHost(tid, ss.thread_session_name(tid, "work")))
        self.addCleanup(self.sessions.stop_all, 1)

    def test_closed_thread_is_not_started(self):
        lean_threads.set_closed(self.tid, True)
        with self.assertRaises(RuntimeError):
            self.sessions.start(self.tid)
        self.assertEqual(self.sessions.hosts, {})
        self.assertEqual(lean_threads.session_threads(), [])

    def test_zero_id_and_unknown_never_get_a_session(self):
        for bad in ("#0", "t0", "0", "", "#999", "garbage"):
            with self.assertRaises(RuntimeError):
                self.sessions.start(bad)
        self.assertEqual(self.sessions.hosts, {})

    def test_no_session_without_a_lean_agent_name(self):
        s = ss.Sessions(lambda tid: FakeHost(tid, ""))
        with self.assertRaises(RuntimeError):
            s.start(self.tid)
        self.assertEqual(s.hosts, {})

    def test_open_thread_starts(self):
        host = self.sessions.start(self.tid)
        self.assertTrue(host.name.startswith("lean-agent · "))

    def test_close_clears_session_on_and_close_zero_too(self):
        lean_threads.set_closed(self.tid, True)
        self.assertFalse(lean_threads.load()["threads"][self.tid].get("session_on"))
        with lean_threads._locked() as data:
            data["threads"]["#0"] = {"id": "#0", "title": "x", "created": lean_threads.now_iso(), "last_message": None,
                                     "kind": "task", "session_on": True}
        self.assertEqual(lean_threads.close_zero_threads(), ["#0"])
        self.assertFalse(lean_threads.load()["threads"]["#0"].get("session_on"))

    def test_sweep_stops_closed_and_unknown_sessions(self):
        self.sessions.start(self.tid)
        self.assertTrue(self.sessions.running(self.tid))
        self.assertEqual(self.sessions.sweep(), [])
        lean_threads.set_closed(self.tid, True)
        with mock.patch.object(ss.lean_log, "log") as log:
            self.assertEqual(self.sessions.sweep(), [self.tid])
        self.assertFalse(self.sessions.running(self.tid))
        self.assertTrue(any("stopped orphan session" in str(c) for c in log.call_args_list))
        # an unknown key left in up.json by an older version
        ss.update_session("#77", host_pid=None, pid=4242)
        self.assertEqual(self.sessions.sweep(), ["#77"])

    def test_orphan_identity_text_and_denial(self):
        out = []
        env = {"LEAN_AGENT_SESSION_ROLE": "thread", "LEAN_AGENT_THREAD": "#0", "LEAN_AGENT_SERVICE_SESSION": "1"}
        with mock.patch.dict(os.environ, env), mock.patch("sys.stdin", __import__("io").StringIO('{"session_id": "s"}')), \
                mock.patch("builtins.print", side_effect=lambda *a, **k: out.append(a[0])):
            session_hook.main()
        self.assertIn("NOT the front desk", out[0])
        self.assertIn("orphan", out[0])
        with mock.patch.dict(os.environ, env):
            self.assertTrue(budget_hook.orphan_denial("lean-agent advise"))
            self.assertTrue(budget_hook.orphan_denial("cd x && lean-agent run foo"))
            self.assertFalse(budget_hook.orphan_denial("ls"))
        with mock.patch.dict(os.environ, {**env, "LEAN_AGENT_THREAD": self.tid}):
            self.assertFalse(budget_hook.orphan_denial("lean-agent thread show"))


if __name__ == "__main__":
    unittest.main()
