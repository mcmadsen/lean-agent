"""review learn: own robot-marked comments are not learned from, --todo/--thread, lesson ids and batches."""
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

from _env import clean_environ

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)


def comment(body, author="pat"):
    return {"author": {"displayName": author}, "content": body}


class OwnCommentTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        env = dict(clean_environ(), LEAN_AGENT_HOME=os.path.join(self.tmp, "home"), HOME=self.tmp)
        p = mock.patch.dict(os.environ, env, clear=True)
        p.start()
        self.addCleanup(p.stop)
        sys.modules.pop("lean_agent", None)
        import lean_agent
        self.agent = lean_agent

    def test_robot_prefix_is_own_whoever_the_author(self):
        for body in (":robot: 🐛 [bug] x is null", "  \n🤖 ⛏️ [nitpick] rename", "🤖 note"):
            self.assertTrue(self.agent.comment_is_bot(comment(body, "Pat Smith")), body)

    def test_human_comment_is_human(self):
        self.assertFalse(self.agent.comment_is_bot(comment("Please rename this")))
        self.assertFalse(self.agent.comment_is_bot(comment("I disagree with the :robot: comment above")))
        self.assertFalse(self.agent.comment_is_bot(comment("agreed 🤖 said it too", "Lee")))

    def test_identity_with_marker_inside_first_400_chars(self):
        with mock.patch.dict(os.environ, {"LEAN_AGENT_POST_AS": "pat smith"}):
            self.assertTrue(self.agent.comment_is_bot(comment("Heads up\n:robot: finding", "Pat Smith")))
            self.assertFalse(self.agent.comment_is_bot(comment("Heads up\n:robot: finding", "Lee")))
            self.assertFalse(self.agent.comment_is_bot(comment("plain words", "Pat Smith")))

    def test_human_reply_under_own_comment_is_kept(self):
        t = {"comments": [comment(":robot: 🐛 [bug] x"), comment("Good catch, fixed", "Lee")]}
        kept, dropped = self.agent.human_threads([t])
        self.assertEqual(dropped, 0)
        self.assertEqual([c["content"] for c in kept[0]["comments"]], ["Good catch, fixed"])
        kept, dropped = self.agent.human_threads([{"comments": [comment("🤖 ⛏️ [nitpick] y")]}])
        self.assertEqual((kept, dropped), ([], 1))


class LessonRegistryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.home = os.path.join(self.tmp, "home")
        env = dict(clean_environ(), LEAN_AGENT_HOME=self.home, HOME=self.tmp)
        p = mock.patch.dict(os.environ, env, clear=True)
        p.start()
        self.addCleanup(p.stop)
        sys.modules.pop("lean_agent", None)
        import lean_agent
        self.agent = lean_agent
        a = self.agent
        self.cards = [{"id": "review-checklist", "kind": "note", "title": "t", "text": "- one\n- two", "tokens": 3}]
        self.saved = None
        p1 = mock.patch.object(a, "load_cards", lambda slug: self.cards)
        p2 = mock.patch.object(a, "save_cards", lambda slug, cards: setattr(self, "cards", cards))
        p3 = mock.patch.object(a, "review_lines", lambda cards: [(c["id"], l) for c in cards for l in c["text"].splitlines() if l.startswith("- ")])
        for p_ in (p1, p2, p3):
            p_.start()
            self.addCleanup(p_.stop)

    def test_existing_lines_migrate_as_legacy_with_stable_ids(self):
        reg = self.agent.sync_lessons("proj")
        self.assertEqual([(e["id"], e["batch"]) for e in reg], [(1, "legacy"), (2, "legacy")])
        self.cards[0]["text"] += "\n- three"
        reg = self.agent.sync_lessons("proj", "run-9")
        self.assertEqual([(e["id"], e["batch"]) for e in reg][-1], (3, "run-9"))
        with open(os.path.join(self.home, "proj", "review-learned.json")) as fh:
            d = json.load(fh)
        self.assertEqual(len(d["_lessons"]), 3)
        self.assertEqual(self.agent.review_learned("proj"), {})  # the registry is not a PR entry

    def test_per_pr_update_keeps_the_registry(self):
        self.agent.sync_lessons("proj")
        self.agent.update_review_learned("proj", 5, head="x")
        self.assertEqual(len(self.agent.sync_lessons("proj")), 2)
        self.assertEqual(self.agent.review_learned("proj"), {"5": {"head": "x"}})

    def test_rm_and_rm_batch(self):
        self.agent.sync_lessons("proj")
        self.cards[0]["text"] += "\n- three\n- four"
        self.agent.sync_lessons("proj", "run-9")
        self.assertEqual(self.agent.remove_review_line("proj", "1")[1], "- one")
        self.assertEqual(self.agent.remove_batch("proj", "run-9"), 2)
        self.assertEqual(self.cards[0]["text"], "- two")
        self.assertEqual(self.agent.remove_batch("proj", "run-9"), 0)
        self.assertEqual([e["id"] for e in self.agent.sync_lessons("proj")], [2])

    def test_removed_line_put_back_keeps_its_id(self):
        self.agent.sync_lessons("proj")
        self.agent.remove_review_line("proj", "1")
        self.agent.undo_review_learn("proj")
        self.assertEqual([e["id"] for e in self.agent.sync_lessons("proj")], [1, 2])


if __name__ == "__main__":
    unittest.main()
