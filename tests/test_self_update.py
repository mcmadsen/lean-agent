"""`lean-agent update`: sync + a detached restart when main is idle, with loop guards; the refusals for the front desk stay."""
import contextlib
import io
import json
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
import service_session as ss  # noqa: E402


class Base(unittest.TestCase):
    role = "main"

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        env = mock.patch.dict(os.environ, {**clean_environ(), "LEAN_AGENT_HOME": self.tmp, "LEAN_AGENT_SESSION_ROLE": self.role,
                                           "LEAN_AGENT_SERVICE_PLATFORM": "mac", "LEAN_AGENT_LAUNCHCTL": "true"}, clear=True)
        env.start()
        self.addCleanup(env.stop)

    def p(self, name):
        return os.path.join(self.tmp, name)

    def jwrite(self, name, data):
        with open(self.p(name), "w") as fh:
            json.dump(data, fh)

    def jread(self, name):
        with open(self.p(name)) as fh:
            return json.load(fh)

    def service(self, version="1.0.0", age=3600):
        self.jwrite("up.json", {"pid": os.getpid(), "version": version, "started_ts": time.time() - age})

    def update(self, new="1.1.0", sync_rc=0, *argv):
        out = io.StringIO()
        popen = mock.MagicMock()
        popen.return_value.pid = 4242
        with mock.patch.object(lean_agent, "plugin_version", return_value=new), \
                mock.patch.object(lean_agent.subprocess, "run", return_value=mock.Mock(returncode=sync_rc)) as run, \
                mock.patch.object(lean_agent.subprocess, "Popen", popen), contextlib.redirect_stdout(out):
            rc = lean_agent.cmd_update(mock.Mock(helper=False, no_pull=False, no_learn=True))
        return rc, out.getvalue(), popen, run


class UpdateTest(Base):
    def test_up_to_date(self):
        self.service("1.0.0")
        rc, text, popen, _ = self.update("1.0.0")
        self.assertEqual(rc, 0)
        self.assertIn("lean-agent is up to date (1.0.0)", text)
        popen.assert_not_called()

    def test_newer_writes_marker_and_starts_helper_at_once(self):
        self.service("1.0.0")
        rc, text, popen, run = self.update("1.1.0")
        self.assertEqual(rc, 0)
        self.assertIn("updated files to 1.1.0; the service restarts when this turn ends", text)
        self.assertIn("End your turn now.", text)
        m = self.jread("self-update.json")
        self.assertEqual((m["from"], m["to"], m["requested_by"]), ("1.0.0", "1.1.0", "main"))
        args, kw = popen.call_args
        self.assertEqual(args[0][-2:], ["update", "--helper"])
        self.assertTrue(kw["start_new_session"])
        self.assertEqual(run.call_args[1]["env"]["LEAN_AGENT_VIA_UPDATE"], "1")

    def test_second_call_while_waiting_does_not_start_another_helper(self):
        self.service("1.0.0")
        self.update("1.1.0")
        m = self.jread("self-update.json")
        m["helper_pid"] = os.getpid()
        self.jwrite("self-update.json", m)
        rc, text, popen, _ = self.update("1.1.0")
        self.assertIn("already scheduled", text)
        popen.assert_not_called()

    def test_terminal_without_service(self):
        rc, text, popen, _ = self.update("1.1.0")
        self.assertEqual(rc, 0)
        self.assertIn("lean-agent service start", text)
        popen.assert_not_called()

    def test_sync_failure_stops(self):
        self.service("1.0.0")
        rc, text, popen, _ = self.update("1.1.0", sync_rc=3)
        self.assertEqual(rc, 3)
        popen.assert_not_called()


class GuardTest(Base):
    def refused(self, why_part):
        rc, text, popen, _ = self.update("1.1.0")
        self.assertEqual(rc, 1, text)
        self.assertIn(why_part, text)
        self.assertIn("files updated to 1.1.0", text)
        popen.assert_not_called()

    def test_same_version_twice(self):
        self.service("1.0.0")
        self.jwrite("self-update-history.json", [{"to": "1.1.0", "ts": time.time() - 7200}])
        self.refused("already self-restarted for 1.1.0")

    def test_service_younger_than_10_minutes(self):
        self.service("1.0.0", age=120)
        self.refused("started 2 min ago")

    def test_recent_self_restart(self):
        self.service("1.0.0")
        self.jwrite("self-update-history.json", [{"to": "1.0.5", "ts": time.time() - 120}])
        self.refused("self-restart happened 2 min ago")

    def test_restart_loop(self):
        self.service("1.0.0")
        for _ in range(ss.LOOP_STARTS):
            ss.record_start()
        self.refused("restart loop")

    def test_loop_block_until_terminal_start(self):
        self.service("1.0.0")
        lean_agent.self_update_block("loop")
        self.refused("restart loop")
        lean_agent.self_update_started(False)  # a start that is not the helper's lifts the block
        rc, text, popen, _ = self.update("1.1.0")
        self.assertEqual(rc, 0)
        popen.assert_called_once()

    def test_unknown_running_version(self):
        self.jwrite("up.json", {"pid": os.getpid(), "started_ts": time.time() - 3600})
        self.refused("not recorded")


class HelperTest(Base):
    def setUp(self):
        super().setUp()
        self.jwrite("self-update.json", {"from": "1.0.0", "to": "1.1.0", "ts": time.time(), "requested_by": "main", "status": "waiting"})

    def run_helper(self, mids, wait=900):
        clock = [0.0]
        it = iter(mids)
        with mock.patch.object(ss, "mid_turn", side_effect=lambda k="main": next(it, False)), \
                mock.patch.object(lean_agent.subprocess, "run") as run, \
                mock.patch.object(lean_agent, "service_file", return_value=__file__), \
                mock.patch.object(lean_agent, "env_num", return_value=wait), \
                mock.patch.object(lean_agent.time, "time", side_effect=lambda: clock[0]), \
                mock.patch.object(lean_agent.time, "sleep", side_effect=lambda s: clock.__setitem__(0, clock[0] + 1)):
            lean_agent.self_update_helper()
        return run

    def test_waits_for_idle_then_restarts_once_keeping_threads(self):
        run = self.run_helper([True, True, True, False, False])
        run.assert_called_once()
        cmd = run.call_args[0][0]
        self.assertEqual(cmd[-4:], ["service", "restart", "--keep-threads", "--yes"])
        self.assertNotIn("--clear", cmd)
        self.assertEqual(self.jread("self-update.json")["status"], "restarting")
        self.assertEqual(self.jread("self-update-history.json")[0]["to"], "1.1.0")

    def test_gives_up_when_never_idle(self):
        run = self.run_helper([True] * 5000, wait=20)
        run.assert_not_called()
        m = self.jread("self-update.json")
        self.assertEqual(m["status"], "gave_up")
        self.assertFalse(os.path.exists(self.p("self-update-history.json")))
        self.assertIn("not applied", lean_agent.self_update_note())
        self.assertEqual(lean_agent.self_update_note(), "")  # shown once


class BriefTest(Base):
    def test_line_shown_once_after_restart(self):
        self.jwrite("self-update.json", {"from": "1.0.0", "to": "1.1.0", "status": "restarting"})
        lean_agent.self_update_started(False)
        self.assertEqual(self.jread("self-update.json")["status"], "done")
        line = ss.restart_line("main")
        self.assertEqual(line, "Updated lean-agent 1.0.0 -> 1.1.0 and restarted at your request; done, do not run update again.")
        self.assertEqual(ss.restart_line("main"), "")
        self.service("1.1.0")
        rc, text, popen, _ = UpdateTest.update(self, "1.1.0")
        self.assertIn("up to date (1.1.0)", text)


class RefusalTest(Base):
    def run_cli(self, *argv):
        err = io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
            try:
                rc = lean_agent.main(list(argv))
            except SystemExit as e:
                rc = e.code
        return rc, err.getvalue()

    def test_cli_refuses_restart_clear_up_sync(self):
        for argv in (["service", "restart"], ["service", "restart", "--clear"], ["service", "stop"], ["service", "start"], ["up"], ["sync"]):
            rc, text = self.run_cli(*argv)
            self.assertEqual(rc, 2, argv)
            self.assertIn("runs inside the lean-agent service", text)

    def test_hook_refuses_but_allows_update(self):
        def deny(cmd):
            return budget_hook.front_desk_denial({"tool_name": "Bash", "tool_input": {"command": cmd}})
        for cmd in ("lean-agent service restart", "lean-agent service restart --clear", "lean-agent up", "lean-agent sync"):
            self.assertIn("runs inside the lean-agent service", deny(cmd), cmd)
        self.assertEqual(deny("lean-agent update"), "")

    def test_update_is_not_refused_by_the_cli(self):
        with mock.patch.object(lean_agent, "cmd_update", return_value=0) as m:
            rc, _ = self.run_cli("update")
        self.assertEqual(rc, 0)


if __name__ == "__main__":
    unittest.main()
