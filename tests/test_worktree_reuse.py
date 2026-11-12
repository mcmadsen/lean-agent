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
        self.h = os.path.join(self.tmp, "home")
        self.running = []
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

    def test_reuse_clean_idle_for_new_branch(self):
        a = self.ensure("feat-a")
        b = self.ensure("feat-b")
        self.assertTrue(b["reused"])
        self.assertEqual(a["path"], b["path"])
        self.assertEqual(b["branch"], "feat-b")

    def test_no_reuse_dirty_or_busy(self):
        a = self.ensure("feat-a")
        open(os.path.join(a["path"], "x"), "w").write("x")
        self.assertFalse(self.ensure("feat-b")["reused"])
        os.remove(os.path.join(a["path"], "x"))
        c = self.ensure("feat-c")
        self.assertTrue(c["reused"])  # clean again: feat-a's or feat-b's worktree
        self.running = [("r1", {"path": a["path"]}), ("r2", {"path": c["path"]})]
        busy_paths = {a["path"], c["path"]}
        d = self.ensure("feat-d")
        self.assertNotIn(d["path"], busy_paths)

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
        b = self.ensure("feat-b")  # takes feat-a's worktree
        self.assertEqual(a["path"], b["path"])
        open(os.path.join(b["path"], "x"), "w").write("x")  # dirty
        removed, dirty, _ = agent.worktrees_cleanup(3)
        self.assertEqual((len(removed), len(dirty)), (0, 1))
        self.assertTrue(os.path.isdir(b["path"]))
        os.remove(os.path.join(b["path"], "x"))
        self.running = [("r", {"path": b["path"]})]
        self.assertEqual(agent.worktrees_cleanup(3)[0], [])
        self.running = []
        removed, dirty, _ = agent.worktrees_cleanup(3)
        self.assertEqual(len(removed), 1)
        self.assertFalse(os.path.isdir(b["path"]))

    def test_doctor_numbers(self):
        self.ensure("feat-a")
        lines = []
        agent.doctor_worktrees(lambda ok, msg, fix=None: lines.append(msg), False)
        self.assertTrue(any("1 lean-agent worktrees" in l and "1 cleanable" in l for l in lines), lines)
        self.assertTrue(any(".metadata_never_index" in l for l in lines))


if __name__ == "__main__":
    unittest.main()
