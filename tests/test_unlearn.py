"""0.45.83: `lean-agent unlearn <project>` unregisters a project: the repo is never touched, its lean-agent data is
archived, and open todos / open threads / live runs / worktrees are handled or block with the flag to proceed."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _env  # noqa: E402,F401

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts", "lean_agent.py")
GIT = ["git", "-c", "user.name=t", "-c", "user.email=t@example.com"]


class Unlearn(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.home = os.path.join(self.tmp, "home")
        os.makedirs(self.home)
        self.repo = os.path.join(self.tmp, "shop")
        os.makedirs(self.repo)
        subprocess.run(GIT + ["init", "-q", self.repo], check=True)
        with open(os.path.join(self.repo, "CLAUDE.md"), "w") as fh:
            fh.write("# Shop\n\nRun the tests with make test.\n")
        subprocess.run(GIT + ["-C", self.repo, "add", "."], check=True)
        subprocess.run(GIT + ["-C", self.repo, "commit", "-q", "-m", "init"], check=True)
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("LEAN_AGENT_")}
        self.env.update(LEAN_AGENT_HOME=self.home, LEAN_AGENT_TEST="1", HOME=self.tmp)
        self.slug = self.learn("shop")

    def run_cli(self, *args):
        return subprocess.run([sys.executable, SCRIPT, *args], capture_output=True, text=True, timeout=120, env=self.env)

    def learn(self, name):
        p = self.run_cli("learn", self.repo, "--name", name)
        self.assertEqual(p.returncode, 0, p.stderr)
        return name

    def registry(self):
        with open(os.path.join(self.home, "projects.json")) as fh:
            return json.load(fh)

    def todos(self):
        with open(os.path.join(self.home, "todo.json")) as fh:
            return json.load(fh)["items"]

    def add_todo(self, project):
        p = self.run_cli("todo", "add", "Fix the export", "-p", project)
        self.assertEqual(p.returncode, 0, p.stderr)

    def thread(self, project="shop"):
        os.makedirs(self.home, exist_ok=True)
        with open(os.path.join(self.home, "threads.json"), "w") as fh:
            json.dump({"threads": {"abc": {"id": "abc", "title": "Export work", "project": project,
                                           "created": "2026-01-01T00:00:00", "last_message": "2026-01-01T00:00:00"}},
                       "aliases": {}, "overrides": {}}, fh)

    def archives(self):
        d = os.path.join(self.home, "archive")
        return sorted(os.listdir(d)) if os.path.isdir(d) else []

    def test_removes_registry_entry_and_keeps_repo(self):
        before = sorted(os.listdir(self.repo))
        p = self.run_cli("unlearn", "shop")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertNotIn("shop", self.registry())
        self.assertEqual(sorted(os.listdir(self.repo)), before)
        self.assertTrue(os.path.isfile(os.path.join(self.repo, "CLAUDE.md")))

    def test_data_archived(self):
        self.assertTrue(os.path.isdir(os.path.join(self.home, "library", "shop")))
        p = self.run_cli("unlearn", "shop")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.home, "library", "shop")))
        arch = self.archives()
        self.assertEqual(len(arch), 1)
        self.assertTrue(arch[0].startswith("shop-"))
        self.assertTrue(os.path.isfile(os.path.join(self.home, "archive", arch[0], "library", "shop", "cards.json")))
        self.assertIn(arch[0], p.stdout)

    def test_open_todo_blocks(self):
        self.add_todo("shop")
        p = self.run_cli("unlearn", "shop")
        self.assertEqual(p.returncode, 1)
        self.assertIn("--move-todos", p.stderr)
        self.assertIn("--close-todos", p.stderr)
        self.assertIn("Fix the export", p.stderr)
        self.assertIn("shop", self.registry())

    def test_move_todos(self):
        self.add_todo("shop")
        other = os.path.join(self.tmp, "other")
        os.makedirs(other)
        subprocess.run(GIT + ["init", "-q", other], check=True)
        p = self.run_cli("learn", other, "--name", "other", "--no-rules")
        self.assertEqual(p.returncode, 0, p.stderr)
        p = self.run_cli("unlearn", "shop", "--move-todos", "other")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(self.todos()[0]["project"], "other")
        self.assertEqual(self.todos()[0]["status"], "open")

    def test_close_todos(self):
        self.add_todo("shop")
        p = self.run_cli("unlearn", "shop", "--close-todos")
        self.assertEqual(p.returncode, 0, p.stderr)
        t = self.todos()[0]
        self.assertEqual(t["status"], "done")
        self.assertIn("project unlearned", t["notes"])

    def test_open_thread_blocks_and_force_keeps_it(self):
        self.thread()
        p = self.run_cli("unlearn", "shop")
        self.assertEqual(p.returncode, 1)
        self.assertIn("--force", p.stderr)
        self.assertIn("abc", p.stderr)
        self.assertIn("shop", self.registry())
        p = self.run_cli("unlearn", "shop", "--force")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertNotIn("shop", self.registry())
        with open(os.path.join(self.home, "threads.json")) as fh:
            self.assertEqual(json.load(fh)["threads"]["abc"]["project"], "shop (unlearned)")
        for cmd in (["thread", "list"], ["now"], ["projects"]):
            q = self.run_cli(*cmd)
            self.assertEqual(q.returncode, 0, (cmd, q.stderr))
            self.assertNotIn("Traceback", q.stderr)

    def test_live_run_blocks(self):
        os.makedirs(os.path.join(self.home, "running"))
        with open(os.path.join(self.home, "running", "r1.json"), "w") as fh:
            json.dump({"run": "0101-000000-abcd", "project": "shop", "pid": os.getpid(), "task": "work",
                       "started": "2026-01-01T00:00:00"}, fh)
        p = self.run_cli("unlearn", "shop", "--force")
        self.assertEqual(p.returncode, 1)
        self.assertIn("0101-000000-abcd", p.stderr)
        self.assertIn("shop", self.registry())

    def make_worktree(self):
        wt = os.path.join(self.home, "worktrees", "shop", "feat")
        os.makedirs(os.path.dirname(wt))
        subprocess.run(GIT + ["-C", self.repo, "worktree", "add", "-q", "-b", "feat", wt], check=True)
        with open(os.path.join(self.home, "worktrees.json"), "w") as fh:
            json.dump({"shop": {"feat": {"path": wt, "repo": self.repo}}}, fh)
        return wt

    def test_worktrees_listed_then_left(self):
        wt = self.make_worktree()
        p = self.run_cli("unlearn", "shop")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn(wt, p.stdout)
        self.assertTrue(os.path.isdir(wt))
        self.assertTrue(os.path.isdir(self.repo))

    def test_remove_worktrees(self):
        wt = self.make_worktree()
        p = self.run_cli("unlearn", "shop", "--remove-worktrees")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertFalse(os.path.exists(wt))
        self.assertTrue(os.path.isfile(os.path.join(self.repo, "CLAUDE.md")))
        self.assertNotIn("shop", self.registry())

    def test_dry_run_changes_nothing(self):
        self.add_todo("shop")
        p = self.run_cli("unlearn", "shop", "--close-todos", "--dry-run")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("would", p.stdout)
        self.assertIn("shop", self.registry())
        self.assertEqual(self.todos()[0]["status"], "open")
        self.assertEqual(self.archives(), [])
        self.assertTrue(os.path.isdir(os.path.join(self.home, "library", "shop")))

    def test_relearn_after_unlearn(self):
        self.assertEqual(self.run_cli("unlearn", "shop").returncode, 0)
        p = self.run_cli("learn", self.repo, "--name", "shop")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("shop", self.registry())
        self.assertTrue(os.path.isfile(os.path.join(self.home, "library", "shop", "cards.json")))

    def test_unknown_project(self):
        p = self.run_cli("unlearn", "nope")
        self.assertEqual(p.returncode, 1)
        self.assertIn("unknown project", p.stderr)
        self.assertNotIn("Traceback", p.stderr)
        self.assertIn("shop", self.registry())


if __name__ == "__main__":
    unittest.main()
