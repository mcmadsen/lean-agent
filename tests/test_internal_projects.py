"""0.45.87: lean-agent's own helper workdirs (inside the lean home) never become projects; leftovers are cleaned up."""
import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _env  # noqa: E402,F401

SCRIPTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
SCRIPT = os.path.join(SCRIPTS, "lean_agent.py")


class Internal(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.home = os.path.join(self.tmp, "home")
        os.makedirs(os.path.join(self.home, "chaser"))
        self.work = os.path.join(self.home, "chaser")
        self.repo = os.path.join(self.tmp, "shop")
        os.makedirs(self.repo)
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("LEAN_AGENT_")}
        self.env.update(LEAN_AGENT_HOME=self.home, LEAN_AGENT_TEST="1", HOME=self.tmp)

    def cli(self, *args):
        return subprocess.run([sys.executable, SCRIPT, *args], capture_output=True, text=True, timeout=120, env=self.env)

    def reg_path(self):
        return os.path.join(self.home, "projects.json")

    def write_reg(self, **projs):
        with open(self.reg_path(), "w") as fh:
            json.dump({k: {"path": v} for k, v in projs.items()}, fh)

    def registry(self):
        try:
            with open(self.reg_path()) as fh:
                return json.load(fh)
        except OSError:
            return {}

    def in_process(self, code):
        env = dict(self.env)
        return subprocess.run([sys.executable, "-c", "import sys; sys.path.insert(0, %r)\nimport lean_agent as la\n%s"
                               % (SCRIPTS, code)], capture_output=True, text=True, timeout=120, env=env)

    def test_resolve_project_on_a_lean_home_path_does_not_register(self):
        p = self.in_process("print(la.resolve_project(%r))" % self.work)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("lean-internal", p.stdout)
        self.assertEqual(self.registry(), {})
        self.assertFalse(os.path.exists(self.reg_path()))

    def test_normal_paths_still_auto_learn(self):
        p = self.in_process("print(la.resolve_project(%r)[0])" % self.repo)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual([v["path"] for v in self.registry().values()], [self.repo])

    def test_learn_refuses_an_internal_workdir(self):
        p = self.cli("learn", self.work)
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual(self.registry(), {})

    def test_leftover_registration_without_todos_is_removed_and_archived(self):
        self.write_reg(**{"chaser-abc123": self.work, "shop": self.repo})
        os.makedirs(os.path.join(self.home, "library", "chaser-abc123"))
        with open(os.path.join(self.home, "library", "chaser-abc123", "cards.json"), "w") as fh:
            fh.write("[]")
        p = self.cli("projects")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertNotIn("chaser-abc123", p.stdout)
        self.assertEqual(list(self.registry()), ["shop"])
        arch = os.listdir(os.path.join(self.home, "archive"))
        self.assertTrue(any(a.startswith("chaser-abc123-") for a in arch), arch)

    def test_leftover_with_an_open_todo_stays_and_doctor_reports_it(self):
        self.write_reg(**{"chaser-abc123": self.work, "shop": self.repo})
        with open(os.path.join(self.home, "todo.json"), "w") as fh:
            json.dump({"items": [{"id": 1, "text": "x", "status": "open", "project": "chaser-abc123",
                                  "created": "2026-01-01T00:00:00"}], "next": 2}, fh)
        self.cli("projects")
        self.assertIn("chaser-abc123", self.registry())
        p = self.cli("doctor")
        self.assertIn("chaser-abc123 is lean-agent's internal workdir: lean-agent unlearn chaser-abc123 --move-todos <project>",
                      p.stdout)

    def test_unlearn_then_another_helper_resolution_does_not_bring_it_back(self):
        self.write_reg(**{"chaser-abc123": self.work, "shop": self.repo})
        with open(os.path.join(self.home, "todo.json"), "w") as fh:
            json.dump({"items": [{"id": 1, "text": "x", "status": "open", "project": "chaser-abc123",
                                  "created": "2026-01-01T00:00:00"}], "next": 2}, fh)
        p = self.cli("unlearn", "chaser-abc123", "--move-todos", "shop")
        self.assertEqual(p.returncode, 0, p.stderr)
        p = self.in_process("print(la.resolve_project(%r))" % self.work)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(list(self.registry()), ["shop"])


if __name__ == "__main__":
    unittest.main()
