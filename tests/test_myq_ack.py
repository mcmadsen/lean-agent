"""0.45.55: answers to the user's own questions are unread until acknowledged."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import _env  # noqa: E402

SCRIPTS = os.path.join(HERE, "..", "plugins", "lean-agent", "scripts")
AGENT = os.path.join(SCRIPTS, "lean_agent.py")
sys.path.insert(0, SCRIPTS)


class MyqAck(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.env = {**_env.clean_environ(), "LEAN_AGENT_HOME": self.tmp, "HOME": self.tmp}
        self._old = os.environ.get("LEAN_AGENT_HOME")
        os.environ["LEAN_AGENT_HOME"] = self.tmp
        import lean_myq
        self.m = lean_myq

    def tearDown(self):
        if self._old is None:
            os.environ.pop("LEAN_AGENT_HOME", None)
        else:
            os.environ["LEAN_AGENT_HOME"] = self._old

    def answered(self, n=1, now=1000.0):
        for i in range(n):
            self.m.add(f"why thing {i}?", "t5", now=now)
        self.m.thread_report("t5", "done", "Because of reason.\nMore.", now=now + 1)

    def cli(self, *a):
        return subprocess.run([sys.executable, AGENT, "q", *a], env=self.env, capture_output=True, text=True).stdout

    def test_unread_block_and_header(self):
        self.answered(2)
        self.assertEqual([self.m.qn(x) for x in self.m.unread()], ["q1", "q2"])
        b = self.m.block()
        self.assertIn("ANSWERS FOR YOU", b)
        self.assertIn("ack q1 when read", b)
        self.assertEqual(self.m.header(), "2 unread answers (q1, q2)")

    def test_block_caps_at_five(self):
        self.answered(7)
        self.assertIn("+2 more: q unread", self.m.block())

    def test_ack_one_several_all(self):
        self.answered(4)
        self.assertEqual(len(self.m.ack(["q1"])), 1)
        self.assertEqual(len(self.m.ack(["2", "q3"])), 2)
        self.assertEqual(self.m.header(), "1 unread answer (q4)")
        self.assertEqual(len(self.m.ack()), 1)
        self.assertEqual(self.m.block(), "")

    def test_old_answers_are_read(self):
        with open(self.m.path(), "w") as fh:
            json.dump({"items": [{"id": "u1", "ts": 1, "text": "q", "target": "t5", "status": "answered", "answer": "a", "answered_ts": 2}]}, fh)
        self.assertEqual(self.m.unread(), [])

    def test_cli_unread_and_default(self):
        self.answered(1)
        self.m.add("how else?", "t6", now=2000.0)
        self.assertIn("Because of reason.\nMore.", self.cli("unread"))
        out = self.cli()
        self.assertLess(out.index("1 unread answer"), out.index("| # |"))
        self.assertIn("acknowledged q1", self.cli("ack", "q1"))
        self.assertIn("No unread", self.cli("unread"))

    def test_reminder_once_at_ten_minutes(self):
        self.answered(1)
        self.assertEqual(self.m.reminder(now=1001 + 599), "")
        self.assertIn("q1", self.m.reminder(now=1001 + 600))
        self.assertEqual(self.m.reminder(now=1001 + 5000), "")

    def test_shortcut_routes(self):
        import lean_threads
        self.assertTrue(lean_threads.ACK_RE.match("ack q35"))
        self.assertTrue(lean_threads.ACK_RE.match("ack 34 35"))
        self.assertTrue(lean_threads.ACK_RE.match("ack"))
        self.assertFalse(lean_threads.ACK_RE.match("ack the PR please"))
        self.assertTrue(lean_threads.MYQ_RE.match("q unread"))

    def test_question_linked_to_new_thread_then_answered_unread(self):
        import budget_hook
        os.environ["LEAN_AGENT_SESSION_ROLE"] = "main"
        self.addCleanup(os.environ.pop, "LEAN_AGENT_SESSION_ROLE", None)
        budget_hook.capture_question("Should we migrate the billing tables to postgres?", "s1")
        q = self.m.select()
        self.assertEqual([(x["target"], x["status"]) for x in q], [("main", "open")])
        self.m.retarget("t9", "Investigate: should we migrate the billing tables to postgres?")
        x = self.m.select()[0]
        self.assertEqual((x["target"], x["thread"]), ("t9", "t9"))
        self.m.thread_report("t9", "done", "Yes, migrate.", now=x["ts"] + 5)
        self.assertEqual([self.m.qn(y) for y in self.m.unread()], ["q1"])
        self.assertIn("Yes, migrate.", self.m.block())

    def test_question_answered_by_main_is_read(self):
        import budget_hook
        budget_hook.capture_question("What does the cache do? And why is it slow?", "s1")
        self.assertEqual(len(self.m.select()), 2)
        self.m.main_reply("It caches; slow due to disk.")
        self.assertEqual({x["status"] for x in self.m.select()}, {"answered"})
        self.assertEqual(self.m.unread(), [])
        self.assertEqual(self.m.block(), "")

    def test_statement_is_not_recorded(self):
        import budget_hook
        budget_hook.capture_question("Please fix the login bug and push it.", "s1")
        budget_hook.capture_question("/status", "s1")
        self.assertEqual(self.m.select(), [])


if __name__ == "__main__":
    unittest.main()
