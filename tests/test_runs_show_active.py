"""`runs --show/--tail/--details/--last --tokens` answer fast on a big home while a run is active: many markers, a big
ledger, a big transcript, a held lock; no maintenance (settle/archive) in these read paths."""
import fcntl
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
RID = "1101-120000-ab12"
LIMIT = 5


class ActiveBigHome(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.work = os.path.join(self.tmp, "work", RID)
        run_dir = os.path.join(self.tmp, "running")
        os.makedirs(self.work)
        os.makedirs(run_dir)
        with open(os.path.join(self.work, "summary-1.txt"), "w") as fh:
            fh.write("run x done\n" + "".join(f"line {i} test finding\n" for i in range(60)))
        with open(os.path.join(self.work, "transcript.jsonl"), "w") as fh:  # big, growing output of the worker
            for i in range(40000):
                fh.write(json.dumps({"type": "assistant", "n": i, "text": "x" * 200}) + "\n")
        with open(os.path.join(self.tmp, "ledger.jsonl"), "w") as fh:
            for i in range(20000):
                fh.write(json.dumps({"id": f"0901-{i:06d}-aaaa", "ts": "2026-09-01T12:00:00", "started": "2026-09-01T12:00:00",
                                     "project": "demo", "model": "sonnet", "task": "t", "status": "done"}) + "\n")
            fh.write(json.dumps({"id": RID, "ts": "2026-11-01T12:00:00", "started": "2026-11-01T12:00:00", "project": "demo",
                                 "model": "sonnet", "task": "t", "status": "done", "workdir": self.work}) + "\n")
        for i in range(1500):  # lost-run markers: dead pid, no ledger row
            with open(os.path.join(run_dir, f"0902-{i:06d}-bbbb.json"), "w") as fh:
                json.dump({"run": f"0902-{i:06d}-bbbb", "pid": 2 ** 22 + 5 + i, "started": "2026-09-02T12:00:00",
                           "project": "demo", "task": "t"}, fh)
        with open(os.path.join(run_dir, "1101-130000-cd34.json"), "w") as fh:  # the active run: this test process
            json.dump({"run": "1101-130000-cd34", "pid": os.getpid(), "started": "2026-11-01T13:00:00", "project": "demo",
                       "task": "t"}, fh)
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("LEAN_AGENT_")}
        self.env["LEAN_AGENT_HOME"] = self.tmp
        self.locks = []
        for name in os.listdir(self.tmp):
            pass
        for name in ("collected.json.lock", "ledger.jsonl.lock", "threads.json.lock", "last-reports.json.lock"):
            fh = open(os.path.join(self.tmp, name), "a")
            fcntl.flock(fh, fcntl.LOCK_EX)
            self.locks.append(fh)
        self.addCleanup(lambda: [f.close() for f in self.locks])

    def runs(self, *args):
        t = time.time()
        p = subprocess.run([sys.executable, os.path.join(ROOT, "lean_agent.py"), "runs", *args], env=self.env,
                           capture_output=True, text=True, timeout=120)
        return p.stdout + p.stderr, time.time() - t

    def markers(self):
        return len(os.listdir(os.path.join(self.tmp, "running")))

    def test_show_tail_details_tokens_fast(self):
        before = self.markers()
        for args in (("--show", RID), ("--show", RID, "--tail", "30"), ("--show", RID, "--details", "--grep", "test"),
                     ("--last", "--tokens")):
            out, secs = self.runs(*args)
            self.assertLess(secs, LIMIT, f"{args}: {secs:.1f}s\n{out[:300]}")
            if args[0] == "--show" and "--details" not in args:
                self.assertIn("run x done" if "--tail" not in args else "line 59 test finding", out)
        self.assertEqual(self.markers(), before, "a read path settled/archived markers")
        self.assertFalse(os.path.isdir(os.path.join(self.tmp, "running", "archive")))

    def test_show_does_not_ask_the_keychain(self):
        bindir = tempfile.mkdtemp()
        fake = os.path.join(bindir, "security")
        with open(fake, "w") as fh:
            fh.write("#!/bin/sh\nsleep 30\n")
        os.chmod(fake, 0o755)
        self.env.update(PATH=bindir + os.pathsep + self.env.get("PATH", ""), LEAN_AGENT_TOKEN_BACKEND="keychain")
        out, secs = self.runs("--show", RID)
        self.assertLess(secs, LIMIT, out[:300])
        self.assertIn("run x done", out)


if __name__ == "__main__":
    unittest.main()
