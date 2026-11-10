"""A session of the service must not restart the service; a restart loop starts main fresh and holds its request back."""
import contextlib
import io
import os
import sys
import tempfile
import time
import unittest
from unittest import mock

from _env import clean_environ

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)

import budget_hook  # noqa: E402
import lean_agent  # noqa: E402
import lean_threads  # noqa: E402
import service_session as ss  # noqa: E402


class Base(unittest.TestCase):
    role = "main"

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        env = mock.patch.dict(os.environ, {**clean_environ(), "LEAN_AGENT_HOME": self.tmp, "LEAN_AGENT_SESSION_ROLE": self.role,
                                           "LEAN_AGENT_SERVICE_PLATFORM": "mac", "LEAN_AGENT_LAUNCHCTL": "true"}, clear=True)
        env.start()
        self.addCleanup(env.stop)

    def run_cli(self, *argv):
        err, out = io.StringIO(), io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(out):
            try:
                rc = lean_agent.main(list(argv))
            except SystemExit as e:
                rc = e.code
        return rc, out.getvalue() + err.getvalue()


class SelfHarmTest(Base):
    def test_command_refused_for_main(self):
        for argv in (["service", "restart"], ["service", "stop"], ["up"], ["sync"], ["clear", "--all", "--restart"]):
            rc, text = self.run_cli(*argv)
            self.assertEqual(rc, 2, argv)
            self.assertIn("this session runs inside the lean-agent service; ask the user to run `lean-agent", text)
            self.assertIn("in a terminal", text)

    def test_status_allowed(self):
        rc, text = self.run_cli("service", "status")
        self.assertNotIn("runs inside the lean-agent service", text)

    def test_hook_refuses(self):
        for role in ("main", "thread"):
            with mock.patch.dict(os.environ, {"LEAN_AGENT_SESSION_ROLE": role}):
                why = budget_hook.front_desk_denial({"tool_name": "Bash", "tool_input": {"command": "lean-agent service restart --yes"}})
                self.assertIn("ask the user to run `lean-agent service restart`", why)
                self.assertEqual(budget_hook.front_desk_denial({"tool_name": "Bash", "tool_input": {"command": "lean-agent service status"}}), "")
                self.assertEqual(budget_hook.front_desk_denial({"tool_name": "Bash", "tool_input": {"command": "lean-agent service logs"}}), "")

    def test_terminal_not_refused(self):
        with mock.patch.dict(os.environ, {"LEAN_AGENT_SESSION_ROLE": ""}):
            self.assertFalse(lean_agent.lean_common.inside_service())


class LoopGuardTest(Base):
    def test_loop_after_four_starts(self):
        now = time.time()
        res = [ss.record_start(now + i * 60) for i in range(4)]
        self.assertEqual([r[1] for r in res], [False, False, False, True])

    def test_single_restart_unaffected(self):
        ss.record_start(time.time() - 3600)
        ss.record_start(time.time() - 3000)
        ss.record_start(time.time() - 2000)
        self.assertEqual(ss.record_start(time.time()), (1, False))

    def test_hold_back_keeps_request_and_spool(self):
        ss.spool_add("main", "do the restart")
        with open(ss.pending_path(), "w") as fh:
            fh.write("x")
        held = ss.hold_back_main()
        self.assertEqual(len(held), 2)
        self.assertFalse(os.path.exists(ss.pending_path()))
        self.assertTrue(os.path.exists(ss.pending_path() + ".held"))
        self.assertEqual(ss.spool_pending("main"), [])
        self.assertEqual(len(os.listdir(ss.spool_dir("main") + ".held")), 1)

    def test_redelivered_once(self):
        tid = lean_threads.new("work", "do it")
        with lean_threads._locked() as data:
            data["threads"][tid]["requests"][0]["undelivered"] = True
        rid = lean_threads.load()["threads"][tid]["requests"][0]["id"]
        self.assertTrue(lean_threads.mark_redelivered(tid, rid))
        self.assertFalse(lean_threads.mark_redelivered(tid, rid))


if __name__ == "__main__":
    unittest.main()
