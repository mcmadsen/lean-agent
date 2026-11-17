"""One user message is one question entry; banners show each answer once on one line; strict mode allows safe
compound commands; the automatic run-done line carries the outcome."""
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import _env  # noqa: E402,F401

sys.path.insert(0, os.path.join(HERE, "..", "plugins", "lean-agent", "scripts"))

MSG = "Why is https://example.test/a/b?x=1&y=2 slow? And can you also check the second page?"


class MyqSplit(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._old = os.environ.get("LEAN_AGENT_HOME")
        os.environ["LEAN_AGENT_HOME"] = self.tmp
        import lean_myq
        self.m = lean_myq

    def tearDown(self):
        if self._old is None:
            os.environ.pop("LEAN_AGENT_HOME", None)
        else:
            os.environ["LEAN_AGENT_HOME"] = self._old

    def test_one_message_one_entry(self):
        self.assertEqual(self.m.split_questions(MSG), [MSG])

    def test_url_question_mark_is_not_a_question(self):
        self.assertFalse(self.m.is_question("see https://example.test/a?x=1&y=2 now"))
        self.assertFalse(self.m.is_question("run `a?b` now"))
        self.assertTrue(self.m.is_question("is https://example.test/a?x=1 up?"))

    def test_banner_one_truncated_line_per_answer(self):
        e = self.m.add(MSG, "t5", now=1000.0)
        long = "word " * 100
        with self.m.lean_common.file_lock(self.m.path()):
            items = self.m._load()
            self.m._answer(items, items[0], long, "ref", 1001.0)
            self.m._save(items)
        b = self.m.block()
        lines = [l for l in b.splitlines() if l.startswith(self.m.qn(e))]
        self.assertEqual(len(lines), 1)
        self.assertLessEqual(len(lines[0].split(": ", 1)[1].split(" · ack")[0]), 120)
        self.assertIn("…", lines[0])
        self.assertEqual(len(self.m.unread_text(False).splitlines()), 2)

    def test_old_split_entries_show_once(self):
        for i, q in enumerate(["Why is it slow?", "Can you check?", "Is it up?"]):
            self.m.add(q, "t5", now=1000.0 + i / 100)
        with self.m.lean_common.file_lock(self.m.path()):
            items = self.m._load()
            for x in items:
                self.m._answer(items, x, "same answer", "ref", 1010.0)
            self.m._save(items)
        self.assertEqual(len(self.m.unread()), 1)
        self.assertEqual(len(self.m.select()), 1)
        self.m.ack(["q1"])
        self.assertEqual([x for x in self.m._load() if x.get("answer_read") is False], [])


class StrictCompound(unittest.TestCase):
    def setUp(self):
        import budget_hook
        self.ok = budget_hook.lean_agent_only

    def test_allowed(self):
        self.assertTrue(self.ok("lean-agent a; echo ----; lean-agent b"))
        self.assertTrue(self.ok("lean-agent a && echo done"))

    def test_blocked(self):
        self.assertFalse(self.ok("lean-agent a; rm x"))
        self.assertFalse(self.ok("echo $(rm x)"))
        self.assertFalse(self.ok("echo `id`"))
        self.assertFalse(self.ok("echo $HOME"))
        self.assertFalse(self.ok("echo hi | sh"))
        self.assertFalse(self.ok("echo hi > f"))


class RunDone(unittest.TestCase):
    def test_outcome_in_line(self):
        import service_session
        r = {"id": "r1", "thread": "t1", "status": "done", "workdir": "/nonexistent",
             "result_head": "Fixed the parser bug in two places. More detail follows.\nsecond line"}
        text = service_session.run_auto_text(r)
        self.assertIn("run r1: done", text)
        self.assertIn("Fixed the parser bug in two places.", text)
        self.assertNotIn("second line", text)
        r["result_head"] = "x" * 300
        self.assertLessEqual(len(service_session.run_outcome(r)), 120)


if __name__ == "__main__":
    unittest.main()
