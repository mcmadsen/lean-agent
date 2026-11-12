"""0.45.56: `runs --show/--last` never wait on a lock or an unbounded read; a short summary that points back also prints the previous one."""
import fcntl
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)

import lean_agent as agent  # noqa: E402

RID = "1101-120000-ab12"


class Home(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.work = os.path.join(self.tmp, "work", RID)
        os.makedirs(self.work)
        os.makedirs(os.path.join(self.tmp, "running"))
        row = {"id": RID, "ts": "2026-11-01T12:00:00", "started": "2026-11-01T12:00:00", "project": "demo", "model": "sonnet",
               "task": "t", "status": "done", "workdir": self.work}
        with open(os.path.join(self.tmp, "ledger.jsonl"), "w") as fh:
            fh.write(json.dumps(row) + "\n")
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("LEAN_AGENT_")}
        self.env["LEAN_AGENT_HOME"] = self.tmp

    def show(self, *args):
        t = time.time()
        p = subprocess.run([sys.executable, os.path.join(ROOT, "lean_agent.py"), "runs", *args], env=self.env,
                           capture_output=True, text=True, timeout=60)
        return p.stdout, time.time() - t

    def summaries(self, first, second):
        for n, t in ((1, first), (2, second)):
            with open(os.path.join(self.work, f"summary-{n}.txt"), "w") as fh:
                fh.write(t)


class Fast(Home):
    def test_show_with_stuck_collected_lock(self):
        self.summaries("run x done\nfindings A and B " * 20, "run x done\n")
        lock = open(os.path.join(self.tmp, "collected.json.lock"), "a")
        fcntl.flock(lock, fcntl.LOCK_EX)  # held by a live process (this one)
        try:
            out, secs = self.show("--show", RID)
        finally:
            lock.close()
        self.assertIn("run x done", out)
        self.assertLess(secs, 20)

    def test_progress_tail_from_end(self):
        wd = self.work
        with open(os.path.join(wd, "progress.jsonl"), "w") as fh:
            for i in range(60000):
                fh.write(json.dumps({"ts": "2026-11-01T12:00:00", "turn": i, "ctx": 1, "steps": "x" * 80}) + "\n")
        got = agent.tail_lines(os.path.join(wd, "progress.jsonl"), 5)
        self.assertEqual([json.loads(l)["turn"] for l in got], [59995, 59996, 59997, 59998, 59999])

    def test_git_timeout(self):
        t = time.time()
        agent.git(self.tmp, "log", "-n", "1", timeout=5)
        self.assertLess(time.time() - t, 5)


class PreviousSummary(Home):
    def test_short_back_reference_prints_previous(self):
        self.summaries("run x done\nthe real findings: alpha, beta\n", "run x done\nsee my previous message\n")
        out, _ = self.show("--show", RID)
        self.assertIn("the real findings: alpha, beta", out)

    def test_short_without_reference_does_not(self):
        self.summaries("run x done\nthe real findings: alpha, beta\n", "run x done\nall fine\n")
        out, _ = self.show("--show", RID)
        self.assertNotIn("alpha", out)

    def test_long_summary_does_not(self):
        self.summaries("run x done\nthe real findings: alpha\n", "run x done\nsee my previous message\n" + "detail " * 60)
        out, _ = self.show("--show", RID)
        self.assertNotIn("alpha", out)


class WorkerRule(unittest.TestCase):
    def test_prompt_demands_self_contained_final_reply(self):
        src = open(os.path.join(ROOT, "lean_agent.py")).read()
        self.assertIn("must be self-contained", src)
        self.assertIn("never refer to an earlier message", src)


if __name__ == "__main__":
    unittest.main()
