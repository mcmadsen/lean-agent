"""A message queued for a busy thread survives a session swap: held after a tool-boundary injection until the session
finishes a turn, released when it dies/is replaced, counted by the attention nudge; `thread report -` reads stdin."""
import os
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

from _env import clean_environ

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)

import service_session as ss  # noqa: E402
import lean_threads  # noqa: E402


class FreshDelivery(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        env = {**clean_environ(), "LEAN_AGENT_HOME": self.tmp, "LEAN_AGENT_LOG_DIR": os.path.join(self.tmp, "logs")}
        p = mock.patch.dict(os.environ, env, clear=True)
        p.start()
        self.addCleanup(p.stop)

    def ledger_has(self, name):
        return ("spool:t1:" + name) in ss._load(ss.ledger_path())

    def test_inject_holds_then_swap_releases_and_delivers_once(self):
        name = ss.spool_add("t1", "do the thing")
        text = ss.inject_thread("t1")
        self.assertIn("do the thing", text)
        self.assertEqual(lean_threads.queued_messages("t1"), 1)  # still held, not lost
        self.assertTrue(self.ledger_has(name))
        ss.mark_replacing("t1")  # swap: the old session dies before confirming
        self.assertEqual(ss.spool_release_injected("t1"), 1)
        self.assertEqual(ss.spool_pending("t1"), [name])
        self.assertFalse(self.ledger_has(name))  # ledger only records confirmed delivery
        self.assertIsNone(ss.inject_thread("t1"))  # held back while replacing
        ss.clear_replacing("t1")
        self.assertIn("do the thing", ss.inject_thread("t1"))  # the fresh session's first boundary
        self.assertIsNone(ss.inject_thread("t1"))
        ss.spool_confirm_injected("t1")
        self.assertEqual(lean_threads.queued_messages("t1"), 0)

    def test_idle_session_confirms_dead_session_releases(self):
        ss.spool_add("t1", "m1")
        ss.inject_thread("t1")
        d = ss.SpoolDeliverer(run=lambda tid: (True, ""))
        with mock.patch.object(ss, "alive_thread", return_value=True), mock.patch.object(ss, "mid_turn", return_value=True):
            d.settle_injected()
        self.assertEqual(lean_threads.queued_messages("t1"), 1)  # mid-turn: not yet confirmed
        with mock.patch.object(ss, "alive_thread", return_value=False):
            d.settle_injected()
        self.assertEqual(len(ss.spool_pending("t1")), 1)  # session died: queued again
        ss.inject_thread("t1")
        with mock.patch.object(ss, "alive_thread", return_value=True), mock.patch.object(ss, "mid_turn", return_value=False):
            d.settle_injected()
        self.assertEqual(lean_threads.queued_messages("t1"), 0)  # turn ended: confirmed

    def test_checkpoint_does_not_swallow(self):
        ss.spool_add("t1", "queued")
        ss.mark_replacing("t1")  # the checkpoint request is typed
        self.assertIsNone(ss.inject_thread("t1"))
        self.assertEqual(len(ss.spool_pending("t1")), 1)

    def test_nudge_counts_held_message(self):
        name = ss.spool_add("t1", "x")
        ss.inject_thread("t1")
        lean_threads.new_thread = getattr(lean_threads, "new_thread", None)
        age = lean_threads.undelivered_age("t1", time.time() + 400)
        self.assertGreaterEqual(age, 399)
        self.assertEqual(lean_threads.queued_messages("t1"), 1)
        self.assertTrue(name)


class ReportStdin(unittest.TestCase):
    def run_report(self, args, stdin):
        env = {**clean_environ(), "LEAN_AGENT_HOME": tempfile.mkdtemp(), "LEAN_AGENT_THREAD": "t1", "LEAN_AGENT_SESSION_ROLE": "thread"}
        return subprocess.run([sys.executable, os.path.join(ROOT, "lean_agent.py"), "thread", "report", *args], input=stdin,
                              capture_output=True, text=True, env=env, timeout=30)

    def test_dash_and_empty_refused(self):
        for args, stdin in ((["-"], ""), (["-"], "  \n"), ([""], "")):
            r = self.run_report(args, stdin)
            self.assertNotEqual(r.returncode, 0, (args, r.stdout, r.stderr))
            self.assertIn("usage", r.stdout + r.stderr)
            self.assertNotIn("queued", r.stdout)


if __name__ == "__main__":
    unittest.main()
