"""The load guard queues new runs, the finished supervisor exits, doctor lists and flags lean-agent processes."""
import contextlib
import io
import os
import sys
import tempfile
import time
import types
import unittest
from unittest import mock

from _env import clean_environ

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)

import lean_agent  # noqa: E402
import lean_load  # noqa: E402


class LoadGuardTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        env = mock.patch.dict(os.environ, {**clean_environ(), "LEAN_AGENT_HOME": self.tmp}, clear=True)
        env.start()
        self.addCleanup(env.stop)

    def test_overload_reasons(self):
        with mock.patch.dict(os.environ, {"LEAN_AGENT_FAKE_LOAD": "999,100000"}):
            self.assertIn("load 999", lean_load.overloaded())
            self.assertIn("OVERLOADED", lean_load.status_line())
        with mock.patch.dict(os.environ, {"LEAN_AGENT_FAKE_LOAD": "0.1,50"}):
            self.assertIn("50 MB", lean_load.overloaded())
        with mock.patch.dict(os.environ, {"LEAN_AGENT_FAKE_LOAD": "0.1,9000"}):
            self.assertIsNone(lean_load.overloaded())
        with mock.patch.dict(os.environ, {"LEAN_AGENT_FAKE_LOAD": "999,1", "LEAN_AGENT_LOAD_GUARD": "0"}):
            self.assertIsNone(lean_load.overloaded())

    def test_new_run_queues_with_one_notice(self):
        err = io.StringIO()
        a = types.SimpleNamespace(role=None)
        sleeps = []

        def sleep(secs):  # the machine eases after two waits
            sleeps.append(secs)
            if len(sleeps) == 2:
                os.environ["LEAN_AGENT_FAKE_LOAD"] = "0.1,9000"
        with mock.patch.dict(os.environ, {"LEAN_AGENT_FAKE_LOAD": "999,100000"}), mock.patch("time.sleep", sleep), \
                contextlib.redirect_stderr(err), mock.patch.object(lean_agent, "set_run_state") as st:
            lean_agent.wait_for_slot(a)
        out = err.getvalue()
        self.assertEqual(out.count("queued: machine overloaded"), 1)
        self.assertIn("starting", out)
        self.assertEqual(st.call_args_list[0][0][0], "queued")
        self.assertEqual(len(sleeps), 2)

    def test_queue_ends_at_the_cap(self):
        err = io.StringIO()
        with mock.patch.dict(os.environ, {"LEAN_AGENT_FAKE_LOAD": "999,100000", "LEAN_AGENT_LOAD_MAX_WAIT": "0"}), \
                contextlib.redirect_stderr(err), mock.patch.object(lean_agent, "set_run_state"):
            lean_agent.wait_for_slot(types.SimpleNamespace(role=None))  # cap 0: not held at all
        self.assertNotIn("queued", err.getvalue())

    def test_no_queue_when_load_is_fine(self):
        err = io.StringIO()
        with mock.patch.dict(os.environ, {"LEAN_AGENT_FAKE_LOAD": "0.1,9000"}), contextlib.redirect_stderr(err):
            lean_agent.wait_for_slot(types.SimpleNamespace(role=None))
        self.assertEqual(err.getvalue(), "")

    def test_review_learn_auto_backs_off(self):
        with mock.patch.dict(os.environ, {"LEAN_AGENT_FAKE_LOAD": "999,100000", "LEAN_AGENT_REVIEW_LEARN_AUTO": "1"}):
            self.assertFalse(lean_agent.review_learn_auto_on())
        with mock.patch.dict(os.environ, {"LEAN_AGENT_FAKE_LOAD": "0.1,9000", "LEAN_AGENT_REVIEW_LEARN_AUTO": "1"}):
            self.assertTrue(lean_agent.review_learn_auto_on())


class SupervisorExitTest(unittest.TestCase):
    def test_finished_supervisor_exits(self):
        class Done(Exception):
            pass

        def bye(code):
            raise Done()
        with mock.patch.dict(lean_agent.RUN_CTX, {"id": "r1"}), mock.patch.object(lean_agent, "run_recorded", return_value=True), \
                mock.patch("time.sleep", lambda s: None):
            with self.assertRaises(Done):
                lean_agent.supervisor_linger_guard(poll=0, linger=0, exit=bye)

    def test_unrecorded_run_is_left_alone(self):
        calls = []
        n = [0]

        def sleep(s):
            n[0] += 1
            if n[0] > 3:
                raise KeyboardInterrupt
        with mock.patch.dict(lean_agent.RUN_CTX, {"id": "r1"}), mock.patch.object(lean_agent, "run_recorded", return_value=False), \
                mock.patch("time.sleep", sleep):
            with self.assertRaises(KeyboardInterrupt):
                lean_agent.supervisor_linger_guard(poll=0, linger=0, exit=calls.append)
        self.assertEqual(calls, [])


class DoctorProcessesTest(unittest.TestCase):
    def proc(self, pid, cmd, age=10, ppid=1, cpu=1.0):
        return {"pid": pid, "ppid": ppid, "cpu": cpu, "rss_mb": 50, "age": age, "cmd": cmd}

    def test_strays_listed_and_fixed(self):
        procs = [self.proc(10, "python3 /h/x/lean_agent.py up", age=9000, cpu=80),
                 self.proc(11, "python3 /h/x/lean_agent.py up", age=100),
                 self.proc(12, "python3 /h/x/scripts/inject_hook.py", age=500),
                 self.proc(13, "python3 /h/x/lean_agent.py run -m haiku x", age=900),
                 self.proc(14, "python3 /h/x/lean_agent.py run -m haiku y", age=900),
                 self.proc(15, "python3 /other/lean_agent.py up", age=100),
                 self.proc(16, "python3 /other/scripts/inject_hook.py", age=500)]
        owned = {"up": 10, "pids": {14}}
        lines, killed = [], []
        doctor = lambda ok, msg, fix=None: lines.append((ok, msg))  # noqa: E731
        with mock.patch.dict(os.environ, {"LEAN_AGENT_FAKE_LOAD": "0.1,9000"}), \
                mock.patch.object(lean_agent, "home", return_value="/h"), \
                mock.patch.object(lean_agent.lean_load, "kill_stray", side_effect=AssertionError("real kill")):
            lean_agent.doctor_processes(doctor, False, procs, owned)
            self.assertTrue(any("7 lean-agent processes" in m for _, m in lines))
            self.assertEqual(sorted(int(m.split()[2]) for ok, m in lines if m.startswith("stray")), [11, 12])
            self.assertEqual([int(m.split()[2]) for ok, m in lines if m.startswith("possible stray")], [13])
            lines.clear()
            lean_agent.doctor_processes(doctor, True, procs, owned, kill=lambda p: killed.append(p["pid"]) or True)
        self.assertEqual(sorted(killed), [11, 12])  # never the run (13), never another home's up/hook (15, 16)
        self.assertTrue(any(m.startswith("possible stray 13") for _, m in lines))

    def test_kill_stray_refuses_under_test_guard(self):
        p = self.proc(os.getpid() + 1, "python3 /h/x/lean_agent.py up")
        with mock.patch.dict(os.environ, {"LEAN_AGENT_TEST": "1"}), \
                mock.patch.object(lean_load, "processes", return_value=[p]), mock.patch("os.kill") as k:
            self.assertFalse(lean_load.kill_stray(p))
        k.assert_not_called()
        self.assertEqual(os.environ.get("LEAN_AGENT_TEST"), "1")


if __name__ == "__main__":
    unittest.main()
