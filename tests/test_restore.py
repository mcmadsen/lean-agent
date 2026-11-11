"""After a service start only the sessions that were live come back; the restore grace blocks automatic starts."""
import os
import sys
import tempfile
import time
import unittest
from unittest import mock

from _env import clean_environ

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)

import lean_threads  # noqa: E402
import service_session as ss  # noqa: E402


class RestoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        env = mock.patch.dict(os.environ, {**clean_environ(), "LEAN_AGENT_HOME": self.tmp}, clear=True)
        env.start()
        self.addCleanup(env.stop)
        self.addCleanup(lambda: ss._RESTORE.update(ids=set(), at=None))
        ss._RESTORE.update(ids=set(), at=None)
        ss._SNAP.update(frozen=False, keep_until=0, keep=set())
        self.t = [lean_threads.new(f"w{i}") for i in range(5)]
        for t in self.t:
            lean_threads.set_session(t, session_on=True)

    def test_snapshot_restores_only_live(self):
        ss.write_snapshot(self.t[:2])
        ids, ts = ss.plan_restore()
        self.assertEqual(set(ids), set(self.t[:2]))
        self.assertTrue(ts)

    def test_parked_closed_stopped_never_restored(self):
        lean_threads.set_session(self.t[1], parked="x", parked_by="user-stop")
        lean_threads.set_session(self.t[2], parked="x", parked_by="idle")
        lean_threads.set_closed(self.t[3], True)
        ss.write_snapshot(self.t[:4])
        ids, _ = ss.plan_restore()
        self.assertEqual(ids, [self.t[0]])

    def test_cap(self):
        ss.write_snapshot(self.t)
        self.assertEqual(len(ss.plan_restore(cap=2)[0]), 2)

    def test_no_snapshot_only_recently_live(self):
        act = {self.t[0]: time.time() - 60, self.t[1]: time.time() - 7200}
        ids, ts = ss.plan_restore(activity=act)
        self.assertEqual(ids, [self.t[0]])
        self.assertIsNone(ts)

    def test_grace_blocks_spool_and_delivers_later(self):
        ran = []
        d = ss.SpoolDeliverer(run=lambda tid: (ran.append(tid) or (True, "")))
        ss.spool_add(self.t[0], "hi")
        ss.spool_add(self.t[1], "hi")
        ss.begin_grace([self.t[0]])
        with mock.patch.object(ss, "alive_thread", return_value=False), mock.patch.object(ss, "mid_turn", return_value=False):
            for th in d.tick():
                th.join()
            self.assertEqual(ran, [self.t[0]])
            ss._RESTORE["at"] = time.time() - ss.RESTORE_GRACE - 1
            for th in d.tick():
                th.join()
        self.assertIn(self.t[1], ran)

    def test_goal_send_never_wakes_parked_or_closed(self):
        lean_threads.set_session(self.t[0], parked="x", parked_by="user-stop")
        lean_threads.set_closed(self.t[1], True)
        with mock.patch.object(ss, "alive_thread", return_value=False):
            self.assertFalse(ss.goal_send(self.t[0], "x")[0])
            self.assertFalse(ss.goal_send(self.t[1], "x")[0])
            self.assertTrue(ss.goal_send(self.t[2], "x")[0])
        self.assertFalse(ss.spool_pending(self.t[0]) or ss.spool_pending(self.t[1]))

    def test_closed_never_in_spool_delivery(self):
        lean_threads.set_closed(self.t[1], True)
        ss.spool_add(self.t[1], "hi")
        ran = []
        d = ss.SpoolDeliverer(run=lambda tid: (ran.append(tid) or (True, "")))
        with mock.patch.object(ss, "alive_thread", return_value=False):
            d.tick()
        self.assertEqual(ran, [])


if __name__ == "__main__":
    unittest.main()
