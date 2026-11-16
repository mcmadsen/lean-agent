import os
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "plugins", "lean-agent", "scripts", "lean_agent.py")


def run(*args):
    return subprocess.run([sys.executable, SCRIPT, *args], capture_output=True, text=True, timeout=60)


class CliErrorTest(unittest.TestCase):
    def test_run_unknown_flag_shows_run_usage_and_hint(self):
        r = run("run", "proj", "-m", "haiku", "--why", "x", "--read-onlyy", "--", "task")
        self.assertEqual(r.returncode, 2)
        self.assertIn("usage: lean-agent run", r.stderr)
        self.assertIn("lean-agent run: unknown option --read-onlyy (did you mean --read-only?)", r.stderr)
        self.assertNotIn("{up,", r.stderr)

    def test_run_unknown_flag_without_a_close_match(self):
        r = run("run", "proj", "--background-ok", "--", "task")
        self.assertEqual(r.returncode, 2)
        self.assertIn("lean-agent run: unknown option --background-ok\n", r.stderr)

    def test_thread_report_unknown_flag(self):
        r = run("thread", "report", "--thread", "t1")
        self.assertEqual(r.returncode, 2)
        self.assertIn("usage: lean-agent thread", r.stderr)
        self.assertIn("lean-agent thread: unknown option --thread", r.stderr)

    def test_unknown_subcommand_hint(self):
        r = run("rnu", "proj")
        self.assertEqual(r.returncode, 2)
        self.assertIn("usage: lean-agent ", r.stderr)
        self.assertIn("lean-agent: unknown command rnu (did you mean run?)", r.stderr)


if __name__ == "__main__":
    unittest.main()
