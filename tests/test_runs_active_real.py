"""A REAL `lean-agent run` (fake claude) stays active while its worktree churns and its hooks fire; the runs commands
(list, --last, --show --tail, --stop) answer fast, directly and through the PreToolUse hook path; --stop ends the run
inside 6 s; a slow command leaves a trace in <home>/logs/slow, a fast one does not."""
import glob
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest

import _env  # noqa: F401
from test_orchestrator import FAKE_CLAUDE

SCRIPTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
CLI = os.path.join(SCRIPTS, "lean_agent.py")
TRAMP = os.path.join(SCRIPTS, "trampoline.py")
LIMIT = 5
ACTIVE_SECS = float(os.environ.get("LEAN_RUNS_REAL_SECS", "40"))


class ActiveRealRun(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        t = self.tmp
        self.proj = os.path.join(t, "proj")
        os.makedirs(self.proj)
        git = ["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-C", self.proj]
        subprocess.run(["git", "init", "-q", self.proj], check=True)
        with open(os.path.join(self.proj, "README.md"), "w") as fh:
            fh.write("# demo\n")
        subprocess.run(git + ["add", "-A"], check=True)
        subprocess.run(git + ["commit", "-qm", "init"], check=True)
        fake = os.path.join(t, "claude")
        with open(fake, "w") as fh:
            fh.write(FAKE_CLAUDE)
        os.chmod(fake, 0o755)
        os.makedirs(os.path.join(t, "cfg"))
        self.home = os.path.join(t, "home")
        self.env = dict(_env.clean_environ(), LEAN_AGENT_HOME=self.home, LEAN_AGENT_CLAUDE=fake, HOME=t,
                        FAKE_LOG=os.path.join(t, "calls.jsonl"), CLAUDE_CONFIG_DIR=os.path.join(t, "cfg"),
                        LEAN_AGENT_LAUNCH_GUARD="0", LEAN_AGENT_HTTP_CHECK="0")
        self.cli("learn", self.proj, "--name", "proj")
        self.stop_churn = threading.Event()
        self.addCleanup(self.cleanup)

    def cleanup(self):
        self.stop_churn.set()
        for f in glob.glob(os.path.join(self.home, "running", "*.json")):
            try:
                pid = json.load(open(f)).get("pid")
                if isinstance(pid, int) and pid > 1 and pid != os.getpid() and os.getpgid(pid) == pid:
                    os.killpg(pid, signal.SIGKILL)
            except (OSError, ValueError):
                pass

    def cli(self, *args, **env):
        t = time.time()
        p = subprocess.run([sys.executable, CLI, *args], capture_output=True, text=True, stdin=subprocess.DEVNULL,
                           env=dict(self.env, **env), timeout=120)
        return p, time.time() - t

    def start_run(self):
        env = dict(self.env, FAKE_TURNS=str(int(ACTIVE_SECS)), FAKE_TURN_SLEEP="1")
        p = subprocess.Popen([sys.executable, CLI, "run", "-p", "proj", "-m", "haiku", "--why", "x", "look around"],
                             env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             start_new_session=True)
        self.addCleanup(lambda: p.poll() is None and p.kill())
        end = time.time() + 30
        while time.time() < end:
            for f in glob.glob(os.path.join(self.home, "running", "*.json")):
                try:
                    m = json.load(open(f))
                except (OSError, ValueError):
                    continue
                if m.get("pid") and not m.get("early") and not m.get("state"):
                    return m
            time.sleep(0.1)
        self.fail("the run never became active: " + repr(p.poll()))

    def churn(self, m):
        """The worker's side: many files written in its worktree, hooks firing against the same lean home."""
        d = m.get("path") or self.proj
        payload = json.dumps({"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "ls"},
                              "session_id": "s", "cwd": d})

        def loop():
            n = 0
            while not self.stop_churn.is_set():
                for i in range(50):
                    with open(os.path.join(d, f"churn-{n % 400}-{i}.txt"), "w") as fh:
                        fh.write("x" * 1000)
                n += 1
                subprocess.run([sys.executable, TRAMP, "budget_hook.py"], input=payload, text=True, env=self.env,
                               capture_output=True, cwd=d)
        threading.Thread(target=loop, daemon=True).start()

    def hook_call(self, cmd):
        """The PreToolUse hook as Claude Code feeds it a Bash tool call, then the command itself."""
        payload = json.dumps({"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": cmd},
                              "session_id": "s", "cwd": self.proj})
        t = time.time()
        p = subprocess.run([sys.executable, TRAMP, "budget_hook.py"], input=payload, text=True, env=self.env,
                           capture_output=True, timeout=60)
        return p, time.time() - t

    def test_runs_commands_fast_and_stop_under_six_seconds(self):
        m = self.start_run()
        rid = m["run"]
        self.churn(m)
        time.sleep(2)
        for args in (("runs",), ("runs", "--last"), ("runs", "--show", rid, "--tail", "3"), ("runs", "--running")):
            p, secs = self.cli(*args)
            self.assertLess(secs, LIMIT, f"{args}: {secs:.1f}s\n{p.stdout[:300]}{p.stderr[:300]}")
            _, hsecs = self.hook_call("lean-agent " + " ".join(args))
            self.assertLess(hsecs, LIMIT, f"hook {args}: {hsecs:.1f}s")
        self.assertEqual(glob.glob(os.path.join(self.home, "logs", "slow", "*")), [], "a fast command left a slow trace")
        p, secs = self.cli("runs", "--stop", rid)
        self.assertLess(secs, 6, f"--stop took {secs:.1f}s\n{p.stdout[:400]}{p.stderr[:300]}")
        self.assertIn(f"stopped {rid}", p.stdout)
        self.assertFalse(self.alive(m["pid"]))

    @staticmethod
    def alive(pid):
        try:
            os.kill(pid, 0)
            with open(f"/proc/{pid}/stat") as fh:
                return fh.read().split(") ")[-1][0] != "Z"
        except OSError:
            return False

    def test_slow_command_leaves_a_trace(self):
        env = dict(LEAN_AGENT_SLOW_AFTER="0.5", LEAN_AGENT_TEST_SLEEP="2")
        p, _ = self.cli("runs", "--last", **env)
        files = glob.glob(os.path.join(self.home, "logs", "slow", "*-runs-*.txt"))
        self.assertEqual(len(files), 1, p.stderr)
        text = open(files[0]).read()
        self.assertIn("Thread", text)
        self.assertIn("in _main", text)
        self.assertIn("phase imports", text)
        out, _ = self.cli("doctor", **dict(env, LEAN_AGENT_TEST_SLEEP="0"))
        self.assertIn("slow trace", out.stdout + out.stderr)

    def test_stop_in_another_home_refuses_fast(self):
        p, secs = self.cli("runs", "--stop", "1101-120000-ab12")
        self.assertLess(secs, LIMIT)
        self.assertNotEqual(p.returncode, 0)


if __name__ == "__main__":
    unittest.main()
