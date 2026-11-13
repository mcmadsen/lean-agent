"""`service restart|start --clear` / `up --clear`: only main runs afterwards; threads are closed (closed_by=clear), their
messages held, nothing chases them, and `thread reopen` brings one back (fake services, no real sessions)."""
import argparse
import contextlib
import io
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from _env import clean_environ

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)

import compact_hook  # noqa: E402
import lean_agent  # noqa: E402
import lean_common  # noqa: E402
import lean_goals  # noqa: E402
import lean_threads  # noqa: E402
import service_session as ss  # noqa: E402


class ServiceClearTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        env = mock.patch.dict(os.environ, {**clean_environ(), "LEAN_AGENT_HOME": self.tmp}, clear=True)
        env.start()
        self.addCleanup(env.stop)
        self.addCleanup(lambda: ss._RESTORE.update(ids=set(), at=None))
        ss._RESTORE.update(ids=set(), at=None)
        self.t1, self.t2 = lean_threads.new("one"), lean_threads.new("two")
        for t in (self.t1, self.t2):
            lean_threads.set_session(t, session_id="11111111-1111-1111-1111-11111111111" + t[1:], session_on=True)
        ss.spool_add(self.t1, "queued before the clear")

    def clear(self):
        with contextlib.redirect_stdout(io.StringIO()):
            lean_agent.clear_all_threads()

    def thread(self, tid):
        return lean_threads.load()["threads"][tid]

    def test_marker_is_consumed_once(self):
        self.assertIsNone(ss.consume_clear_marker())
        ss.write_clear_marker(fresh_done=True)
        self.assertEqual(ss.consume_clear_marker()["fresh_done"], True)
        self.assertIsNone(ss.consume_clear_marker())

    def test_threads_closed_by_clear_keep_their_session_and_are_not_started(self):
        self.clear()
        for t in (self.t1, self.t2):
            rec = self.thread(t)
            self.assertTrue(rec["closed"])
            self.assertEqual(rec["closed_by"], "clear")
            self.assertTrue(rec["session_id"])  # --resume-old still has its transcript
        self.assertEqual(ss.plan_restore()[0], [])
        started = []
        d = ss.SpoolDeliverer(run=lambda tid: started.append(tid) or (True, ""))
        self.assertEqual(d.tick(), [])
        self.assertEqual(started, [])
        self.assertEqual(lean_threads.cleared_ids(), {self.t1, self.t2})

    def test_held_messages_are_not_delivered_and_come_back_on_reopen(self):
        self.clear()
        self.assertEqual(lean_threads.queued_messages(self.t1), 0)
        held = os.listdir(os.path.join(self.tmp, "thread-inbox", self.t1, "held"))
        self.assertEqual(len(held), 1)
        self.assertEqual(ss.spool_threads(), [])
        lean_threads.set_closed(self.t1, False)  # thread reopen t1
        self.assertEqual(lean_threads.queued_messages(self.t1), 1)
        self.assertNotIn("closed_by", self.thread(self.t1))
        self.assertFalse(self.thread(self.t1).get("closed"))
        self.assertTrue(self.thread(self.t2)["closed"])  # the other one stays closed

    def test_a_finishing_run_neither_reopens_nor_pushes_to_main(self):
        self.clear()
        self.assertFalse(ss.queue_report(self.t1, "done", "run r1 done: finished", force=True))
        self.assertEqual(ss.queued_reports(), [])
        self.assertEqual([r["state"] for _, r in ss.report_states(self.t1)], ["held"])  # stored for the thread
        self.assertTrue(self.thread(self.t1)["closed"])
        self.assertEqual([i for i in ss.attention_items(10 ** 10, 0, ()) if self.t1 in i[0]], [])
        self.assertEqual(lean_threads.undelivered_threads(min_secs=0), [])

    def test_reports_queued_before_the_clear_are_held(self):
        ss.queue_report(self.t2, "done", "finished before", force=True)
        self.assertEqual(len(ss.queued_reports()), 1)
        self.clear()
        self.assertEqual(ss.queued_reports(), [])

    def test_goal_chasing_is_paused_and_a_goal_command_lifts_it(self):
        gid = lean_goals.add("PR 5", self.t1)
        self.clear()
        self.assertTrue(lean_goals.paused())
        self.assertTrue(lean_goals.clear_paused_since())
        sent = []
        out = lean_goals.watchdog(10 ** 10, lambda tid, text: sent.append(tid) or (True, ""), lambda tid: True)
        self.assertEqual((out, sent), ([], []))
        self.assertEqual(lean_goals._load()[0]["state"], "active")  # not dropped
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            lean_agent.cmd_goals(argparse.Namespace(args=[], chase_log=False, all=False, until=None, why=None))
        self.assertIn("chasing paused since --clear", buf.getvalue())
        with contextlib.redirect_stdout(io.StringIO()):
            lean_agent.cmd_goal(argparse.Namespace(args=["next", gid, "wait for CI"], why=None))
        self.assertFalse(lean_goals.paused())

    def test_a_thread_reopen_lifts_the_goal_pause_and_a_user_pause_stays(self):
        self.clear()
        lean_threads.set_closed(self.t2, False)
        self.assertFalse(lean_goals.paused())
        lean_goals.pause()  # the user's own pause is not the clear pause
        lean_goals.lift_clear_pause()
        self.assertTrue(lean_goals.paused())

    def test_main_brief_has_the_line_once(self):
        self.clear()
        text = compact_hook.brief()
        self.assertIn("Restarted with --clear: all threads closed and not chased; reopen one with o<N> when the user asks.", text)
        self.assertNotIn("Restarted with --clear", compact_hook.brief())

    def test_front_desk_cannot_run_service_restart_clear(self):
        for argv in (["service", "restart", "--clear"], ["service", "start", "--clear"], ["up", "--clear"]):
            self.assertTrue(lean_common.service_self_harm(argv), argv)
        env = {**os.environ, "LEAN_AGENT_SESSION_ROLE": "main"}
        r = subprocess.run([sys.executable, os.path.join(ROOT, "lean_agent.py"), "service", "restart", "--clear"],
                           capture_output=True, text=True, env=env, timeout=60)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("ask the user to run", r.stdout + r.stderr)
        self.assertFalse(os.path.exists(ss.clear_marker_path()))

    def service_cli(self, *args):
        fake = os.path.join(self.tmp, "systemctl")
        with open(fake, "w") as fh:
            fh.write("#!/bin/sh\nexit 0\n")
        os.chmod(fake, 0o755)
        env = {**os.environ, "HOME": self.tmp, "LEAN_AGENT_SERVICE_PLATFORM": "linux", "LEAN_AGENT_SYSTEMCTL": fake,
               "LEAN_AGENT_CLEAR_WAIT": "0"}
        return subprocess.run([sys.executable, os.path.join(ROOT, "lean_agent.py"), "service", *args],
                              capture_output=True, text=True, env=env, timeout=120)

    def test_clear_all_restart_keeps_threads_and_plain_clear_writes_the_marker(self):
        calls = []
        with mock.patch.object(lean_agent.service_session, "mid_turn", return_value=False), \
                mock.patch.object(lean_agent, "service_file", return_value=__file__), \
                mock.patch.object(lean_agent.subprocess, "run", side_effect=lambda argv, **kw: calls.append(argv)):
            self.assertEqual(lean_agent.restart_when_idle(wait=10, sleep=lambda s: None), "service restart --keep-threads")
        self.assertIn("--keep-threads", calls[0])
        self.assertNotIn("--clear", calls[0])
        self.assertFalse(os.path.exists(ss.clear_marker_path()))
        self.service_cli("install")
        r = self.service_cli("restart", "--keep-threads", "--yes")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertFalse(os.path.exists(ss.clear_marker_path()))
        self.assertNotIn("thread(s) are closed", r.stdout)
        r = self.service_cli("restart", "--clear", "--yes")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertTrue(os.path.exists(ss.clear_marker_path()))
        self.assertIn(self.t1, r.stdout)

    def test_keep_threads_is_hidden_from_help(self):
        self.assertNotIn("keep-threads", self.service_cli("--help").stdout)


if __name__ == "__main__":
    unittest.main()
