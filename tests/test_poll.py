"""`lean-agent poll`: the model-free waiter."""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

from _env import clean_environ, scaled

CLI = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts", "lean_agent.py")


class PollTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = os.path.join(self.tmp.name, "home")
        self.env = dict(clean_environ(), LEAN_AGENT_HOME=self.home)

    def cli(self, *args, env=None):
        p = subprocess.run([sys.executable, CLI, *args], capture_output=True, text=True, env=env or self.env, cwd=self.tmp.name)
        return p.returncode, p.stdout + p.stderr

    def start(self, *args, env=None):
        rc, out = self.cli("poll", *args, env=env)
        self.assertEqual(rc, 0, out)
        return out.split()[1]

    def rec(self, pid):
        with open(os.path.join(self.home, "polls", pid + ".json")) as fh:
            return json.load(fh)

    def wait(self, pid):
        end = time.time() + scaled(15)
        while time.time() < end:
            r = self.rec(pid)
            if r["status"] != "running":
                return r
            time.sleep(0.1)
        self.fail("poll still running")

    def reports(self):
        try:
            with open(os.path.join(self.home, "thread-reports.json")) as fh:
                return json.load(fh)["items"]
        except OSError:
            return []

    def counter_cmd(self, body):
        script = os.path.join(self.tmp.name, "c.py")
        with open(script, "w") as fh:
            fh.write("import os,sys\nf=%r\nn=int(open(f).read()) if os.path.exists(f) else 0\nopen(f,'w').write(str(n+1))\n%s\n"
                     % (os.path.join(self.tmp.name, "n"), body))
        return [sys.executable, script]

    def test_until_match_reports_once(self):
        pid = self.start("--every", "0.2s", "--until", "READY", "--name", "build", "--", *self.counter_cmd("print('READY' if n>=2 else 'wait')"))
        r = self.wait(pid)
        self.assertEqual(r["status"], "done")
        self.assertEqual(r["result"], "READY")
        items = self.reports()
        self.assertEqual(len(items), 1)
        self.assertIn("poll build: done after", items[0]["text"])
        self.assertIn(os.path.join(self.home, "polls", pid + ".out"), items[0]["text"])
        with open(os.path.join(self.home, "polls", pid + ".out")) as fh:
            self.assertIn("READY", fh.read())

    def test_fail_regex(self):
        pid = self.start("--every", "0.2s", "--until", "OK", "--fail", "BROKEN", "--", *self.counter_cmd("print('BROKEN' if n>=1 else 'wait')"))
        r = self.wait(pid)
        self.assertEqual(r["status"], "failed")
        self.assertEqual(r["result"], "BROKEN")
        self.assertIn(": failed after", self.reports()[0]["text"])

    def test_timeout(self):
        pid = self.start("--every", "0.2s", "--timeout", "1s", "--until", "NEVER", "--", *self.counter_cmd("print('wait')"))
        r = self.wait(pid)
        self.assertEqual(r["status"], "timeout")
        self.assertIn(": timeout after", self.reports()[0]["text"])

    def test_consecutive_errors(self):
        pid = self.start("--every", "0.2s", "--until", "OK", "--errors", "2", "--", *self.counter_cmd("print('oops'); sys.exit(3)"))
        r = self.wait(pid)
        self.assertEqual(r["status"], "failed")
        self.assertIn("exit 3 2 times in a row", r["result"])
        self.assertEqual(r["runs"], 2)

    def test_read_only_context_refuses_other_commands(self):
        cfg = os.path.join(self.tmp.name, "ro.json")
        with open(cfg, "w") as fh:
            json.dump({"project": self.tmp.name, "allow_cmd": ["az pipelines"], "log": os.path.join(self.tmp.name, "log")}, fh)
        env = dict(self.env, LEAN_AGENT_RO_CFG=cfg)
        rc, out = self.cli("poll", "--", "rm", "-rf", "x", env=env)
        self.assertEqual(rc, 2)
        self.assertIn("refused", out)
        rc, out = self.cli("poll", "--shell", "--", "ls | wc", env=env)
        self.assertEqual(rc, 2)
        rc, out = self.cli("poll", "--", "ls", "|", "wc", env=env)
        self.assertEqual(rc, 2)
        rc, out = self.cli("poll", "--", "az", "pipelines", "show", env=env)  # allowed prefix: starts (az may not exist; the poll then fails by itself)
        self.assertEqual(rc, 0, out)
        self.cli("poll", "--stop", out.split()[1], env=env)
        rc, out = self.cli("poll", "--", "ls", "|", "wc")  # main: metacharacters need --shell too
        self.assertEqual(rc, 2)

    def test_thread_allow_cmd_refused_and_config_poll_allow(self):
        env = dict(self.env, LEAN_AGENT_THREAD="t1")
        rc, out = self.cli("poll", "--allow-cmd", "echo", "--", "echo", "hi", env=env)
        self.assertEqual(rc, 2)
        self.assertIn("config poll-allow", out)
        rc, out = self.cli("poll", "--", "mytool", "status", env=env)
        self.assertEqual(rc, 2)
        rc, out = self.cli("config", "poll-allow", "mytool status")
        self.assertEqual(rc, 0, out)
        self.assertIn("mytool status", out)
        rc, out = self.cli("poll", "--every", "0.2s", "--", "mytool", "status", env=env)
        self.assertEqual(rc, 0, out)
        self.cli("poll", "--stop", out.split()[1], env=env)
        rc, out = self.cli("poll", "--", "mytool", "other", env=env)
        self.assertEqual(rc, 2)
        self.cli("config", "poll-allow", "clear")
        rc, out = self.cli("poll", "--", "mytool", "status", env=env)
        self.assertEqual(rc, 2)

    def test_cloud_cli_reads_are_read_only(self):
        sys.path.insert(0, os.path.join(os.path.dirname(CLI)))
        import readonly_hook
        cfg = {"project": self.tmp.name, "allow_cmd": []}
        def ok(cmd):
            return readonly_hook.decide({"tool_name": "Bash", "tool_input": {"command": cmd}}, cfg)[0] == "allow"
        for cmd in ("az pipelines build show --id 12 --output json", "az pipelines runs show --id 3", "az pipelines build list --top 5",
                    "az pipelines runs list", "gh run view 123", "gh run view 123 --log", "gh pr checks 4", "gh pr view 4", "gh run list"):
            self.assertTrue(ok(cmd), cmd)
        for cmd in ("az pipelines run --name x", "az pipelines build queue --definition-id 1", "gh run rerun 123", "gh run cancel 1",
                    "gh pr merge 4", "gh run view 1 --web", "az pipelines variable-group delete --id 1", "gh api -X POST /x"):
            self.assertFalse(ok(cmd), cmd)

    def test_list_show_stop_and_detached_record(self):
        pid = self.start("--every", "0.2s", "--until", "NEVER", "--name", "slow", "--", *self.counter_cmd("print('wait')"))
        rc, out = self.cli("poll", "--list")
        self.assertIn(pid, out)
        self.assertIn("running", out)
        end = time.time() + scaled(10)
        while time.time() < end and not self.rec(pid).get("pid"):
            time.sleep(0.1)
        pid_os = self.rec(pid)["pid"]
        self.assertNotEqual(pid_os, os.getpid())  # its own process, not the caller's
        self.assertEqual(os.getsid(pid_os), pid_os)  # own session: survives the calling session
        rc, out = self.cli("poll", "--show", pid)
        self.assertIn("slow", out)
        self.assertIn(f"{pid}.out", out)
        rc, out = self.cli("poll", "--stop", pid)
        self.assertIn("stopped", out)
        self.assertEqual(self.rec(pid)["status"], "stopped")
        self.assertEqual(self.reports(), [])


if __name__ == "__main__":
    unittest.main()
