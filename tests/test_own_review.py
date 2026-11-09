"""A finished review of the user's own work is an info line, not a vote question (lean_own)."""
import contextlib
import io
import json
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

ME = "dev@example.com"
OTHER = "pat@example.org"


class OwnReviewTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.home = os.path.join(self.tmp, "home")
        os.makedirs(self.home)
        env = dict(clean_environ(), LEAN_AGENT_HOME=self.home, HOME=self.tmp, GIT_CONFIG_GLOBAL=os.path.join(self.tmp, "gitconfig"),
                   GIT_CONFIG_NOSYSTEM="1")
        p = mock.patch.dict(os.environ, env, clear=True)
        p.start()
        self.addCleanup(p.stop)
        for m in ("lean_agent", "lean_own", "lean_waiting", "lean_common", "lean_pr"):
            sys.modules.pop(m, None)
        import lean_agent, lean_own, lean_waiting, lean_pr
        self.agent, self.own, self.waiting, self.pr = lean_agent, lean_own, lean_waiting, lean_pr
        self.repo = os.path.join(self.tmp, "repo")
        os.makedirs(self.repo)
        self.g("init", "-q", "-b", "main")
        self.g("config", "user.email", ME)
        self.commit("a.txt", "1", "base", OTHER)
        self.g("checkout", "-q", "-b", "feature/x")

    def g(self, *args):
        return subprocess.run(["git", "-C", self.repo, *args], capture_output=True, text=True, check=True).stdout.strip()

    def commit(self, name, text, msg, email):
        with open(os.path.join(self.repo, name), "w") as fh:
            fh.write(text)
        self.g("add", ".")
        self.g("-c", f"user.email={email}", "-c", "user.name=N", "commit", "-q", "-m", msg)

    def review(self, **meta):
        head = self.g("rev-parse", "HEAD")
        m = dict({"mode": "ref", "ref": "feature/x", "head": head, "base": "main"}, **meta)
        entry = {"id": "r1", "thread": "t1"}
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.agent.report_review("slug", self.repo, entry, {"verdict": "approve", "findings": [{"severity": "nit", "what": "x"}]}, m)
        return out.getvalue()

    def items(self, kind="review"):
        return [i for i in self.waiting.open_items() if i["kind"] == kind]

    def test_pre_push_review_has_no_waiting_item_and_an_info_line(self):
        self.commit("b.txt", "2", "other's", OTHER)
        out = self.review(for_push=True)
        self.assertEqual(self.items(), [])
        self.assertIn("review of your branch feature/x (t1): approve, 1 findings", out)

    def test_branch_with_the_users_commits_has_none(self):
        self.commit("b.txt", "2", "mine", ME)
        self.review()
        self.assertEqual(self.items(), [])

    def test_merged_base_commits_do_not_count_against_the_user(self):
        self.commit("b.txt", "2", "mine", ME)
        self.g("checkout", "-q", "main")
        self.commit("c.txt", "3", "base moves", OTHER)
        self.g("checkout", "-q", "feature/x")
        self.g("-c", "user.name=N", "merge", "-q", "--no-edit", "main")
        self.review()
        self.assertEqual(self.items(), [])

    def test_pr_authored_by_the_user_in_the_pr_cache_has_none(self):
        self.commit("b.txt", "2", "theirs", OTHER)
        self.pr.save_live([{"pr": "7", "project": self.repo, "author": "dev", "branch": "feature/x"}])
        self.review()
        self.assertEqual(self.items(), [])

    def test_someone_elses_pr_still_asks_for_a_vote(self):
        self.commit("b.txt", "2", "theirs", OTHER)
        self.pr.save_live([{"pr": "7", "project": self.repo, "author": "pat", "branch": "feature/x"}])
        self.review()
        self.assertEqual(len(self.items()), 1)

    def test_config_on_brings_the_vote_back_for_own_work(self):
        self.commit("b.txt", "2", "mine", ME)
        with open(os.path.join(self.home, "config.json"), "w") as fh:
            json.dump({"review_vote_own": "on"}, fh)
        self.review()
        self.assertEqual(len(self.items()), 1)

    def test_stale_own_item_is_closed_by_the_sweep(self):
        self.commit("b.txt", "2", "mine", ME)
        with open(os.path.join(self.home, "config.json"), "w") as fh:
            json.dump({"review_vote_own": "on"}, fh)
        self.review()
        with open(os.path.join(self.home, "projects.json"), "w") as fh:
            json.dump({"slug": {"path": self.repo}}, fh)
        os.remove(os.path.join(self.home, "config.json"))
        self.assertEqual(len(self.items()), 1)
        self.assertEqual(len(self.own.sweep()), 1)
        self.assertEqual(self.items(), [])
        with open(self.waiting.path()) as fh:
            self.assertEqual(json.load(fh)["items"][0]["answer"], "own PR: no vote")


if __name__ == "__main__":
    unittest.main()
