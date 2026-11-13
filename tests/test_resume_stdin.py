"""0.45.62: `run --resume <id> --task-file -` reads the task from stdin before the run detaches; a run that fails
before its worker starts says why."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_orchestrator as orch  # noqa: E402

CLI = orch.CLI


class ResumeStdin(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = self.tmp.name
        self.proj = os.path.join(t, "proj")
        os.makedirs(self.proj)
        with open(os.path.join(self.proj, "CLAUDE.md"), "w") as fh:
            fh.write("# Demo\nA demo project.\n")
        fake = os.path.join(t, "claude")
        with open(fake, "w") as fh:
            fh.write(orch.FAKE_CLAUDE)
        os.chmod(fake, 0o755)
        self.log = os.path.join(t, "calls.jsonl")
        self.env = dict(orch.clean_environ(), LEAN_AGENT_HOME=os.path.join(t, "home"), LEAN_AGENT_CLAUDE=fake,
                        FAKE_LOG=self.log, HOME=t, CLAUDE_CONFIG_DIR=os.path.join(t, "cfg"),
                        LEAN_AGENT_LAUNCH_GUARD="0", LEAN_AGENT_HTTP_CHECK="0")
        os.makedirs(os.path.join(t, "cfg"))
        self.addCleanup(self.tmp.cleanup)

    def cli(self, *args, input=None, **env):
        return subprocess.run([sys.executable, CLI, *args], capture_output=True, text=True, input=input,
                              env=dict(self.env, **env), stdin=None if input is not None else subprocess.DEVNULL,
                              timeout=orch.scaled(90))

    def calls(self):
        with open(self.log) as fh:
            return [c for c in (json.loads(l) for l in fh) if "plugin" not in c]

    def first_run(self):
        p = self.cli("learn", self.proj)
        self.assertEqual(p.returncode, 0, p.stderr)
        p = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--read-only", "first task")
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        with open(os.path.join(self.env["LEAN_AGENT_HOME"], "ledger.jsonl")) as fh:
            return [json.loads(l) for l in fh][-1]["id"]

    def test_resume_reads_task_from_stdin_with_why_and_allow_send(self):
        rid = self.first_run()
        body = "line one of the task\nline two: 'quoted' $HOME `x`\n"
        p = self.cli("run", "--resume", rid, "--why", "x", "--max-usd", "3", "--allow-send", "x", "--task-file", "-",
                     input=body)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        last = self.calls()[-1]
        self.assertIn("--resume", last["argv"])
        self.assertIn("line two: 'quoted'", last["task"])

    def test_resume_with_positional_and_task_file_dash(self):
        rid = self.first_run()
        p = self.cli("run", "--resume", rid, "--max-usd", "4", "--max-turns", "80", "--allow-send", "x",
                     "--task-file", "-", input="stdin body text\n")
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("stdin body text", self.calls()[-1]["task"])

    def test_empty_stdin_task_is_a_clear_error_before_anything_starts(self):
        rid = self.first_run()
        n = len(self.calls())
        p = self.cli("run", "--resume", rid, "--task-file", "-", input="  \n")
        self.assertEqual(p.returncode, 1)
        self.assertIn("no task given", p.stderr)
        self.assertEqual(len(self.calls()), n)

    def test_failing_pre_start_step_shows_its_reason(self):
        rid = self.first_run()
        p = self.cli("run", "--resume", rid, "--task-file", "-", input="go on\n", LEAN_AGENT_CLAUDE="/nonexistent/claude")
        self.assertNotEqual(p.returncode, 0)
        out = p.stdout + p.stderr
        self.assertRegex(out, r"failed: .*\S")
        self.assertNotRegex(out.strip().splitlines()[-1], r"^run failed: exited with code \d+$")

    def test_detached_worker_that_cannot_start_says_why(self):
        root = os.path.join(os.path.dirname(os.path.abspath(CLI)))
        wd = os.path.join(self.tmp.name, "wd")
        script = (
            "import sys\n"
            f"sys.path.insert(0, {root!r})\n"
            "import lean_agent as L\n"
            "L.CLI_ENTRY.append(True)\n"
            "def boom(*a, **k): raise RuntimeError('marker write refused')\n"
            "L.own_marker = boom\n"
            "L.FAIL_CMD[:] = ['run']\n"
            f"rc = L.detach_run({wd!r}, 'r1')\n"
            "print('REASON', L.FAIL_REASON, file=sys.stderr)\n"
            "sys.exit(rc)\n")
        env = dict(self.env)
        p = subprocess.run([sys.executable, "-c", script], env=env, capture_output=True, text=True,
                           stdin=subprocess.DEVNULL, timeout=orch.scaled(60))
        self.assertEqual(p.returncode, 1, p.stdout + p.stderr)
        self.assertIn("marker write refused", p.stderr)
        self.assertIn("REASON ['the detached worker could not start", p.stderr)

    def test_resume_supervisor_is_a_fresh_interpreter_and_finishes(self):
        rid = self.first_run()
        p = self.cli("run", "--resume", rid, "--task-file", "-", input="go on\n")
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        wd = os.path.join(self.env["LEAN_AGENT_HOME"], "work", rid)
        self.assertTrue(os.path.exists(os.path.join(wd, "supervisor.rc")))
        self.assertFalse(os.path.exists(os.path.join(wd, "supervisor-start.pkl")))  # the task file is removed once read

    def test_supervisor_crashing_at_start_reports_its_stderr(self):
        for hook in ("raise", "abort"):
            rid = self.first_run() if hook == "raise" else rid
            p = self.cli("run", "--resume", rid, "--task-file", "-", input="go on\n", LEAN_AGENT_SUPERVISOR_CRASH_HOOK=hook)
            self.assertNotEqual(p.returncode, 0, p.stdout + p.stderr)
            out = p.stdout + p.stderr
            self.assertIn(f"crash hook: {hook}", out)
            self.assertNotIn("said nothing", out)
            if hook == "abort":
                self.assertIn("SIGABRT", out)
            # the next look at the runs says it too
            r = self.cli("runs", "--show", rid)
            self.assertNotIn("said nothing", r.stdout + r.stderr)


if __name__ == "__main__":
    unittest.main()
