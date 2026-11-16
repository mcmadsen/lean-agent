"""0.45.71: `lean-agent runs --alive <id>...|last`: a one-line liveness answer from markers, pids and the run folder."""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)

import lean_common  # noqa: E402
import lean_threads  # noqa: E402


class Alive(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("LEAN_AGENT_")}
        self.env.update(LEAN_AGENT_HOME=self.tmp, LEAN_AGENT_TEST="1")
        os.makedirs(os.path.join(self.tmp, "running"))
        self.procs = []
        self.addCleanup(self.reap)

    def reap(self):
        for p in self.procs:
            p.kill()
            p.wait()

    def sleeper(self):
        p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        self.procs.append(p)
        return p.pid

    def dead_pid(self):
        p = subprocess.Popen([sys.executable, "-c", "pass"])
        p.wait()
        return p.pid

    def run_dir(self, rid, result=False, worker=None, start=None):
        wd = os.path.join(self.tmp, "work", rid)
        os.makedirs(wd)
        with open(os.path.join(wd, "progress.jsonl"), "w") as fh:
            fh.write("{}\n")
        if result:
            with open(os.path.join(wd, "result.json"), "w") as fh:
                fh.write(json.dumps({"is_error": False}) + "\n")
        if worker:
            with open(os.path.join(wd, "claude.pid"), "w") as fh:
                json.dump({"pid": worker, "start": start if start is not None else lean_common.proc_start(worker)}, fh)
        return wd

    def marker(self, rid, pid, wd, start=None):
        with open(os.path.join(self.tmp, "running", rid + ".json"), "w") as fh:
            json.dump({"run": rid, "pid": pid, "pid_start": start if start is not None else lean_common.proc_start(pid), "workdir": wd}, fh)

    def alive(self, *ids):
        t = time.time()
        p = subprocess.run([sys.executable, os.path.join(ROOT, "lean_agent.py"), "runs", "--alive", *ids],
                           env=self.env, capture_output=True, text=True, timeout=60)
        self.assertLess(time.time() - t, 5)
        return p.returncode, p.stdout

    def test_alive(self):
        sup, wk = self.sleeper(), self.sleeper()
        self.marker("0101-000001-aaaa", sup, self.run_dir("0101-000001-aaaa", worker=wk))
        rc, out = self.alive("0101-000001-aaaa")
        self.assertEqual(rc, 0)
        self.assertIn(f"0101-000001-aaaa  alive  supervisor pid {sup}", out)
        self.assertIn(f"worker pid {wk}", out)
        self.assertIn("last progress", out)
        self.assertEqual(len(out.strip().splitlines()), 1)

    def test_orphaned(self):
        wk = self.sleeper()
        self.marker("0101-000002-aaaa", self.dead_pid(), self.run_dir("0101-000002-aaaa", worker=wk))
        rc, out = self.alive("0101-000002-aaaa")
        self.assertEqual(rc, 0)
        self.assertIn(f"orphaned  supervisor gone, worker pid {wk} alive", out)

    def test_ended_with_result(self):
        self.run_dir("0101-000003-aaaa", result=True)
        rc, out = self.alive("0101-000003-aaaa")
        self.assertEqual(rc, 1)
        self.assertIn("ended  done", out)
        self.assertIn("(result recorded)", out)

    def test_dead(self):
        self.marker("0101-000004-aaaa", self.dead_pid(), self.run_dir("0101-000004-aaaa"))
        rc, out = self.alive("0101-000004-aaaa")
        self.assertEqual(rc, 1)
        self.assertIn("dead  no live pid, no result, last progress", out)

    def test_unknown_id_and_exit_codes(self):
        sup = self.sleeper()
        self.marker("0101-000005-aaaa", sup, self.run_dir("0101-000005-aaaa"))
        self.run_dir("0101-000006-aaaa", result=True)
        rc, out = self.alive("9999-999999-ffff")
        self.assertEqual((rc, "unknown" in out), (2, True))
        self.assertEqual(self.alive("0101-000005-aaaa", "0101-000006-aaaa")[0], 1)
        rc, out = self.alive("0101-000005-aaaa", "9999-999999-ffff")
        self.assertEqual(rc, 2)
        self.assertEqual(len(out.strip().splitlines()), 2)
        rc, out = self.alive("last")
        self.assertEqual(rc, 0)
        self.assertIn("0101-000005-aaaa", out)

    def test_pid_reuse_is_not_alive(self):
        sup, wk = self.sleeper(), self.sleeper()
        wd = self.run_dir("0101-000007-aaaa", worker=wk, start="p1")  # recorded start differs: another process holds the pid
        self.marker("0101-000007-aaaa", sup, wd, start="p1")
        rc, out = self.alive("0101-000007-aaaa")
        self.assertEqual(rc, 1)
        self.assertIn("dead", out)

    def test_shortcut_route(self):
        data = {"threads": {}, "aliases": {}}
        for text in ("alive 0101-000007-aaaa", "alive0101-000007-aaaa", "alive last"):
            tid, line, kind = lean_threads.decide(text, data)
            self.assertEqual((tid, kind), (None, "job"))
            self.assertIn("lean-agent runs --alive " + text.split()[-1].replace("alive", ""), line)
        self.assertIn("runs --running", lean_threads.decide("alive21", data)[1])


if __name__ == "__main__":
    unittest.main()
