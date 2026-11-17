"""An interim report (progress kind, or done while the thread still has a live run) does not answer a question."""
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import _env  # noqa: E402,F401

sys.path.insert(0, os.path.join(HERE, "..", "plugins", "lean-agent", "scripts"))

REPORT = "Started a read-only check. No finding yet. Plan: a, b."


class MyqProgress(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._old = os.environ.get("LEAN_AGENT_HOME")
        os.environ["LEAN_AGENT_HOME"] = self.tmp
        import lean_common
        import lean_myq
        self.c, self.m = lean_common, lean_myq
        self._rr = lean_common.running_runs
        self.live = []
        lean_common.running_runs = lambda home: [(f"r{i}", {"thread": t, "role": None}) for i, t in enumerate(self.live)]

    def tearDown(self):
        self.c.running_runs = self._rr
        if self._old is None:
            os.environ.pop("LEAN_AGENT_HOME", None)
        else:
            os.environ["LEAN_AGENT_HOME"] = self._old

    def ask(self):
        return self.m.add("is the thing slow?", "t5", now=1000.0)

    def only(self):
        return self.m.select()[0]

    def test_done_with_live_run_stays_open(self):
        self.ask()
        self.live = ["t5"]
        self.m.thread_report("t5", "done", REPORT, now=1001.0)
        x = self.only()
        self.assertEqual(x["status"], "open")
        self.assertEqual(x["note"], "t5 working: Started a read-only check.")
        self.assertTrue(x["progress_ts"])
        self.assertEqual(self.m.unread(), [])
        self.assertEqual(self.m.reminder(now=99999.0), "")

    def test_progress_kind_without_run(self):
        self.ask()
        self.m.thread_report("t5", "progress", REPORT, now=1001.0)
        self.assertEqual(self.only()["status"], "open")
        self.assertEqual(self.m.unread(), [])

    def test_other_threads_run_does_not_count(self):
        self.ask()
        self.live = ["t9"]
        self.m.thread_report("t5", "done", "Answer: no.", now=1001.0)
        self.assertEqual(self.only()["status"], "answered")

    def test_done_without_live_run_answers(self):
        self.ask()
        self.m.thread_report("t5", "done", "Answer: no.", now=1001.0)
        self.assertEqual(self.only()["status"], "answered")
        self.assertEqual(len(self.m.unread()), 1)

    def test_later_done_answers(self):
        self.ask()
        self.live = ["t5"]
        self.m.thread_report("t5", "done", REPORT, now=1001.0)
        self.live = []
        self.m.thread_report("t5", "done", "Finding: it is slow.", now=1100.0)
        x = self.only()
        self.assertEqual((x["status"], x.get("note"), x.get("progress_ts")), ("answered", None, None))
        self.assertEqual(len(self.m.unread()), 1)

    def test_live_check_off_answers(self):
        self.ask()
        self.live = ["t5"]
        self.m.thread_report("t5", "done", "Run finished.", now=1001.0, live_check=False)
        self.assertEqual(self.only()["status"], "answered")

    def test_header_block_table_show_in_progress(self):
        self.ask()
        self.m.thread_report("t5", "progress", REPORT, now=1001.0)
        self.assertIn("1 in progress (q1)", self.m.header())
        self.assertNotIn("unread", self.m.header())
        self.assertIn("in progress", self.m.block())
        self.assertNotIn("ack q1", self.m.block())
        self.assertIn("| in progress |", self.m.table(now=1100.0))

    def test_stale_nudge_still_works(self):
        self.ask()
        self.m.thread_report("t5", "progress", REPORT, now=1001.0)
        x = self.m.stale("t5", now=1000.0 + 3600, nudgeable=True)
        self.assertEqual(x["id"], "u1")


if __name__ == "__main__":
    unittest.main()
