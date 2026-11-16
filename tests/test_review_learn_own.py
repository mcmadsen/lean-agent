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


class OwnerCommentTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        env = dict(clean_environ(), LEAN_AGENT_HOME=os.path.join(self.tmp, "home"), HOME=self.tmp)
        p = mock.patch.dict(os.environ, env, clear=True)
        p.start()
        self.addCleanup(p.stop)
        for m in ("lean_agent", "lean_pr"):
            sys.modules.pop(m, None)
        import lean_agent
        self.agent = lean_agent

    def kept(self, comments, me):
        out, dropped = self.agent.learnable_threads([{"comments": comments}], me)
        return [c["content"] for t in out for c in t["comments"]], dropped

    def test_owner_comment_excluded_marker_or_not(self):
        got, _ = self.kept([comment("plain note", "Pat Smith"), comment(":robot: 🐛 [bug] x", "Pat Smith"),
                            comment("other view", "Lee")], "pat smith")
        self.assertEqual(got, ["other view"])

    def test_owner_matched_by_login_and_id(self):
        c = {"author": {"login": "pat-s", "id": "u-1"}, "content": "x"}
        self.assertEqual(self.agent.learnable_threads([{"comments": [c]}], "pat-s"), ([], 1))
        c = {"author": {"id": "u-1"}, "content": "x"}
        self.assertEqual(self.agent.learnable_threads([{"comments": [c]}], "u-1"), ([], 1))

    def test_other_users_robot_comment_and_bot_accounts_are_included(self):
        got, dropped = self.kept([comment(":robot: 🐛 [bug] y", "Lee"), comment("🤖 ⛏️ [nitpick] z", "Sam"),
                                  {"author": {"displayName": "review-bot", "isBot": True}, "content": "bot finding"},
                                  comment("CI passed", "Build Service")], "pat smith")
        self.assertEqual(len(got), 4)
        self.assertEqual(dropped, 0)

    def test_replies_judged_by_their_own_author(self):
        t = {"comments": [comment("first", "Pat Smith"), comment("Good catch, fixed", "Lee"), comment("thanks", "Pat Smith")]}
        kept, dropped = self.agent.learnable_threads([t], "pat smith")
        self.assertEqual([c["content"] for c in kept[0]["comments"]], ["Good catch, fixed"])
        self.assertEqual(self.agent.learnable_threads([{"comments": [comment("a", "Pat Smith")]}], "pat smith"), ([], 1))

    def test_unknown_owner_falls_back_to_the_marker(self):
        got, _ = self.kept([comment(":robot: 🐛 [bug] x", "Lee"), comment("  🤖 ⛏️ [nitpick] y", "Sam"),
                            comment("see the :robot: remark above", "Kim"), comment("LEAN-REVIEW verdict", "Lee")], "")
        self.assertEqual(got, ["see the :robot: remark above"])

    def test_owner_identity_from_the_cached_pr_query_else_env_else_empty(self):
        self.assertEqual(self.agent.owner_identity("proj"), "")
        self.agent.lean_pr.save_query("own", "proj", [], me="pat-s")
        self.assertEqual(self.agent.owner_identity("proj"), "pat-s")
        with mock.patch.dict(os.environ, {"LEAN_AGENT_POST_AS": "someone"}):
            self.assertEqual(self.agent.owner_identity("proj"), "someone")


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
