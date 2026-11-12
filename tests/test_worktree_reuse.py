"""0.45.56: Spotlight marker, worktree reuse, setup once, cleanup, doctor numbers (temp repos)."""
import contextlib
import io
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)

import lean_agent as agent  # noqa: E402


def sh(cwd, *args):
    return subprocess.run(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", *args],
                          capture_output=True, text=True, check=True).stdout.strip()


class Reuse(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.repo = os.path.join(self.tmp, "repo")
        os.makedirs(self.repo)
        sh(self.repo, "init", "-q", "-b", "main")
        open(os.path.join(self.repo, "a.txt"), "w").write("a")
        sh(self.repo, "add", ".")
        sh(self.repo, "commit", "-qm", "init")
        self.remote = os.path.join(self.tmp, "remote.git")
        subprocess.run(["git", "init", "-q", "--bare", self.remote], check=True)
        sh(self.repo, "remote", "add", "origin", self.remote)
        sh(self.repo, "push", "-q", "origin", "main")
        self.h = os.path.join(self.tmp, "home")
        self.running = []
        self.later = __import__("datetime").datetime.now() + __import__("datetime").timedelta(days=2, hours=1)
        self.projs = {"proj": {"path": self.repo, "base": "main"}}
        for p in (mock.patch.object(agent, "home", lambda *parts: os.path.join(self.h, *parts)),
                  mock.patch.object(agent, "projects", lambda: self.projs),
                  mock.patch.object(agent, "live_runs", lambda: self.running)):
            p.start()
            self.addCleanup(p.stop)

    def ensure(self, ref, **kw):
        with contextlib.redirect_stdout(io.StringIO()):
            return agent.ensure_worktree("proj", self.repo, ref, base="main", typed=False, **kw)

    def test_marker_created(self):
        self.ensure("feat-a")
        self.assertTrue(os.path.exists(os.path.join(self.h, "worktrees", ".metadata_never_index")))

    def test_new_branch_never_takes_over_another_branchs_worktree(self):
        a = self.ensure("feat-a")
        b = self.ensure("feat-b")
        self.assertFalse(b["reused"])
        self.assertNotEqual(a["path"], b["path"])
        self.assertEqual(a["branch"], "feat-a")
        self.assertEqual(sh(a["path"], "symbolic-ref", "--short", "HEAD"), "feat-a")

    def test_setup_once_and_on_manifest_change(self):
        self.projs["proj"]["worktree_setup"] = "true"
        with mock.patch.object(agent, "run_worktree_setup", wraps=agent.run_worktree_setup) as m, \
                contextlib.redirect_stdout(io.StringIO()):
            a = self.ensure("feat-a")
            self.ensure("feat-a")
            self.assertEqual(m.call_count, 1)
            open(os.path.join(a["path"], "package-lock.json"), "w").write("{}")
            self.ensure("feat-a")
            self.assertEqual(m.call_count, 2)

    def test_cleanup_only_clean_finished(self):
        a = self.ensure("feat-a")  # merged into main (no new commits): cleanable
        self.running = []
        b = a
        open(os.path.join(b["path"], "x"), "w").write("x")  # dirty
        removed, dirty, _ = agent.worktrees_cleanup(3, now=self.later)
        self.assertEqual((len(removed), len(dirty)), (0, 1))
        self.assertTrue(os.path.isdir(b["path"]))
        os.remove(os.path.join(b["path"], "x"))
        self.running = [("r", {"path": b["path"]})]
        self.assertEqual(agent.worktrees_cleanup(3, now=self.later)[0], [])
        self.running = []
        self.assertEqual(agent.worktrees_cleanup(3)[0], [])  # pushed/merged but not idle for 2 days yet
        removed, dirty, _ = agent.worktrees_cleanup(3, now=self.later)
        self.assertEqual(len(removed), 1)
        self.assertFalse(os.path.isdir(b["path"]))

    def test_doctor_numbers(self):
        self.ensure("feat-a")
        lines = []
        with mock.patch.object(agent.datetime, "datetime", wraps=agent.datetime.datetime) as dt:
            dt.now.return_value = self.later
            agent.doctor_worktrees(lambda ok, msg, fix=None: lines.append(msg), False)
        self.assertTrue(any("1 lean-agent worktrees" in l and "1 cleanable" in l for l in lines), lines)
        self.assertTrue(any(".metadata_never_index" in l for l in lines))

    def test_unused_worktree_is_not_removed_at_run_end(self):
        self.assertFalse(hasattr(agent, "remove_unused_worktree"))
        wt = self.ensure("feat-a")
        self.assertTrue(os.path.isdir(wt["path"]))
        self.assertIn("feat-a", agent.worktree_index().get("proj", {}))

    def test_retry_reuses_no_numbered_duplicate(self):
        a = self.ensure("feat-a")
        b = self.ensure("feat-a")
        self.assertTrue(b["reused"])
        self.assertEqual(a["path"], b["path"])
        self.assertEqual(os.listdir(os.path.join(self.h, "worktrees", "proj")).count("feat-a-2"), 0)

    def test_unpushed_never_removed_and_duplicates(self):
        a = self.ensure("feat-a")
        sh(a["path"], "commit", "-q", "--allow-empty", "-m", "work")  # unpushed, clean
        self.assertEqual(agent.worktrees_cleanup(3, now=self.later)[0], [])
        self.assertTrue(os.path.isdir(a["path"]))

    def test_prune_drops_missing_paths(self):
        a = self.ensure("feat-a")
        import shutil
        shutil.rmtree(a["path"])
        with contextlib.redirect_stdout(io.StringIO()):
            agent.cmd_worktrees(__import__("argparse").Namespace(project=None, prune=True))
        self.assertNotIn("feat-a", agent.worktree_index().get("proj", {}))

    def test_doctor_warns_over_30(self):
        fake = [("proj", f"w{i}", {"path": self.repo, "repo": self.repo}) for i in range(31)]
        lines = []
        with mock.patch.object(agent, "lean_worktrees", lambda *a: fake), mock.patch.object(agent, "dir_size", lambda p: 1), \
                mock.patch.object(agent, "worktree_cleanup_state", lambda *a, **k: "keep"):
            agent.doctor_worktrees(lambda ok, msg, fix=None: lines.append((ok, msg, fix)), False)
        self.assertTrue(any(ok is None and "31" in m and "--cleanup" in f for ok, m, f in lines), lines)

    def test_unpushed_commits_are_kept_whatever_the_age(self):
        a = self.ensure("feat-a")
        sh(a["path"], "commit", "-q", "--allow-empty", "-m", "local")
        far = self.later + __import__("datetime").timedelta(days=400)
        removed, dirty, kept = agent.worktrees_cleanup(3, now=far)
        self.assertEqual(removed, [])
        self.assertTrue(os.path.isdir(a["path"]))
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            agent.cmd_worktrees(__import__("argparse").Namespace(project=None, cleanup=True, older="1d"))
        self.assertTrue(os.path.isdir(a["path"]))

    def test_detached_with_local_commit_is_kept(self):
        a = self.ensure("feat-a")
        sh(a["path"], "checkout", "-q", "--detach")
        sh(a["path"], "commit", "-q", "--allow-empty", "-m", "local")
        self.assertEqual(agent.worktrees_cleanup(3, now=self.later)[0], [])
        self.assertTrue(agent.has_unpushed(a["path"]))

    def test_closed_thread_unpushed_is_kept(self):
        a = self.ensure("feat-a")
        sh(a["path"], "commit", "-q", "--allow-empty", "-m", "local")
        row = {"project": "proj", "worktree": a["name"], "thread": "t1"}
        with mock.patch.object(agent, "ledger", lambda: [row]), \
                mock.patch.object(agent, "thread_session_tid", lambda tag: ("t1", {"closed": True})):
            agent.cleanup_closed_thread_worktrees()
        self.assertTrue(os.path.isdir(a["path"]))

    def test_duplicates_with_unpushed_commits_are_kept(self):
        a = self.ensure("feat-a")
        sh(a["path"], "commit", "-q", "--allow-empty", "-m", "local")
        idx = agent.worktree_index()
        old = dict(idx["proj"][a["name"]])
        dup = os.path.join(self.h, "worktrees", "proj", "feat-a-2")
        sh(self.repo, "worktree", "add", "-q", "--detach", dup, "main")
        sh(dup, "commit", "-q", "--allow-empty", "-m", "dup local")
        old.update(path=dup, last_used="2020-01-01T00:00:00")
        idx["proj"]["feat-a-2"] = old
        agent.save_json(os.path.join(self.h, "worktrees.json"), idx)
        self.assertEqual(agent.worktrees_cleanup(3, now=self.later)[0], [])
        self.assertTrue(os.path.isdir(dup))


if __name__ == "__main__":
    unittest.main()
