"""Delta re-reviews check side effects the old code had (merge-base), and the prompt asks the deferred-action questions."""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from _env import clean_environ

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)


class DeltaEffectsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        home = os.path.join(self.tmp, "home")
        os.makedirs(home)
        env = dict(clean_environ(), LEAN_AGENT_HOME=home, HOME=self.tmp, GIT_CONFIG_GLOBAL=os.path.join(self.tmp, "gc"),
                   GIT_CONFIG_NOSYSTEM="1")
        p = mock.patch.dict(os.environ, env, clear=True)
        p.start()
        self.addCleanup(p.stop)
        sys.modules.pop("lean_agent", None)
        import lean_agent
        self.agent = lean_agent
        self.repo = os.path.join(self.tmp, "repo")
        os.makedirs(self.repo)
        self.g("init", "-q", "-b", "develop")
        self.write("store.py", "def restore(x):\n    load(x)\n    recompute_flags(x)\n    return x\n")
        self.commit("base")
        self.base = self.g("rev-parse", "HEAD")
        self.g("checkout", "-q", "-b", "feature/y")
        self.write("store.py", "def restore(x):\n    load(x)\n    return x\n")
        self.commit("defer the recompute")
        self.head = self.g("rev-parse", "HEAD")

    def g(self, *args):
        return subprocess.run(["git", "-C", self.repo, *args], capture_output=True, text=True, check=True).stdout.strip()

    def write(self, name, text):
        with open(os.path.join(self.repo, name), "w") as fh:
            fh.write(text)

    def commit(self, msg):
        self.g("add", ".")
        self.g("-c", "user.email=a@example.com", "-c", "user.name=N", "commit", "-q", "-m", msg)

    def test_merge_base_diff_shows_removed_recompute(self):
        out = self.agent.delta_effects_text(self.repo, self.base, self.head, ["store.py"], "develop")
        self.assertIn("-    recompute_flags(x)", out)
        self.assertIn("no longer performs", out)

    def test_diff_is_bounded(self):
        self.assertLessEqual(len(self.agent.merge_base_effects_diff(self.repo, self.base, self.head, ["store.py"], 40)), 120)
        self.assertEqual(self.agent.merge_base_effects_diff(self.repo, None, self.head, ["store.py"]), "")

    def test_prompt_has_deferred_action_questions(self):
        r = self.agent.REVIEWER_RULE
        self.assertIn("who never triggers", r)
        self.assertIn("stale until then", r)
        self.assertIn("removed_effects", r)

    def review(self, **extra):
        rv = dict({"verdict": "approve", "searches": [{"for": "x", "found": "nothing"}]}, **extra)
        meta = {"resume": True, "since_hunks": {}, "head": self.head, "ref": "feature/y", "mode": "ref"}
        return self.agent.enforce_review_rules(rv, meta, ()), rv

    def test_removed_effect_becomes_major(self):
        (verdict, findings, _c, _n), _ = self.review(removed_effects=[
            {"where": "store.py:2", "effect": "recompute_flags on restore", "still_done": False, "intended": False}])
        self.assertEqual(verdict, "changes-requested")
        self.assertTrue(any(f["severity"] == "major" and "removed side effect" in f["issue"] for f in findings))

    def test_intended_or_kept_effect_is_fine(self):
        (verdict, findings, _c, _n), _ = self.review(removed_effects=[
            {"where": "store.py:2", "effect": "a", "still_done": False, "intended": True},
            {"where": "store.py:3", "effect": "b", "still_done": True}])
        self.assertFalse([f for f in findings if "removed side effect" in f["issue"]])

    def test_doubt_escalates_to_full_review(self):
        _res, rv = self.review(side_effect_doubt=True)
        self.assertTrue(rv["_escalate_full"])
        _res, rv = self.review()
        self.assertFalse(rv["_escalate_full"])

    def test_escalate_to_full_reads_the_recorded_review(self):
        slug = "p"
        rec = {"head": self.head, "delta": True, "escalate_full": True, "after": {"run": "r1"}}
        self.agent.append_jsonl(self.agent.reviews_path(slug), rec)
        self.assertTrue(self.agent.escalate_to_full(slug, self.head, "r1"))
        self.assertFalse(self.agent.escalate_to_full(slug, self.head, "r2"))


if __name__ == "__main__":
    unittest.main()
