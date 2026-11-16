"""CPU budget: a waiting `run` parent and an idle service must not busy-wait or leak threads (0.45.67 burned 70-88% CPU)."""
import os
import resource
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

from _env import clean_environ

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "plugins", "lean-agent", "scripts")
CLI = os.path.join(ROOT, "lean_agent.py")
sys.path.insert(0, ROOT)
CI = bool(os.environ.get("GITHUB_ACTIONS") or os.environ.get("CI"))
SLACK = 3.0 if CI else 1.0
HAS_PROC = os.path.isdir("/proc/self/task")
HZ = os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100


def proc_cpu(pid):
    """utime+stime of a live process in seconds (Linux /proc)."""
    with open(f"/proc/{pid}/stat") as fh:
        f = fh.read().rsplit(")", 1)[1].split()
    return (int(f[11]) + int(f[12])) / HZ


def threads_of(pid):
    with open(f"/proc/{pid}/status") as fh:
        for line in fh:
            if line.startswith("Threads:"):
                return int(line.split()[1])


class WaitingParent(unittest.TestCase):
    def parent_cpu(self, spawn):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        wd = os.path.join(tmp, "wd")
        if spawn:  # the fresh-interpreter path, with a supervisor that only sleeps
            hook = ("def fake(workdir, run_id, paths, state):\n"
                    "    p = subprocess.Popen(['sleep', '10'], start_new_session=True)\n"
                    "    KEEP.append(p)\n    return p.pid\n"
                    "KEEP = []\nL.spawn_supervisor = fake\n")
            call = f"L.detach_run({wd!r}, 'r1', spawn={{'args': None, 'task': 't', 'workdir': {wd!r}}})"
        else:
            hook, call = "", f"L.detach_run({wd!r}, 'r1')"
        script = (
            "import sys, os, time, subprocess\n"
            f"sys.path.insert(0, {ROOT!r})\n"
            "import lean_agent as L\n"
            "L.CLI_ENTRY.append(True)\n" + hook +
            f"r = {call}\n"
            "if r is None:\n"
            "    time.sleep(10)\n"
            "    L.SUPERVISOR_RC and open(L.SUPERVISOR_RC[0], 'w').write('0')\n"
            "    os._exit(0)\n"
            "sys.exit(r if r != 124 else 0)\n")
        env = dict(clean_environ(), LEAN_AGENT_HOME=tmp)
        env.pop("LEAN_AGENT_NO_DETACH", None)
        before = resource.getrusage(resource.RUSAGE_CHILDREN)
        t0 = time.time()
        subprocess.run([sys.executable, "-c", script], env=env, stdin=subprocess.DEVNULL, capture_output=True, timeout=90)
        wall = time.time() - t0
        after = resource.getrusage(resource.RUSAGE_CHILDREN)
        cpu = (after.ru_utime - before.ru_utime) + (after.ru_stime - before.ru_stime)
        self.assertGreater(wall, 8)
        return cpu

    def test_fork_path_waiting_parent(self):
        cpu = self.parent_cpu(False)
        print(f"fork-path parent CPU over ~10 s: {cpu:.2f} s")
        self.assertLess(cpu, 0.5 * SLACK)

    def test_spawn_path_waiting_parent(self):
        cpu = self.parent_cpu(True)
        print(f"spawn-path parent CPU over ~10 s: {cpu:.2f} s")
        self.assertLess(cpu, 0.5 * SLACK)


@unittest.skipUnless(HAS_PROC, "needs /proc")
class IdleService(unittest.TestCase):
    def setUp(self):
        import lean_threads
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        cfg = os.path.join(self.tmp, "cfg")
        os.makedirs(cfg)
        home = os.path.join(self.tmp, "home")
        self.env = dict(clean_environ(), LEAN_AGENT_HOME=home, HOME=self.tmp, CLAUDE_CONFIG_DIR=cfg,
                        LEAN_AGENT_CLAUDE=os.path.join(HERE, "fixtures", "fake_interactive_claude.py"),
                        FAKE_SESSION_LOG=os.path.join(self.tmp, "calls.jsonl"), CLAUDECODE="1",
                        LEAN_AGENT_LAUNCH_GUARD="0", LEAN_AGENT_HTTP_CHECK="0")
        old = dict(os.environ)
        os.environ.update(self.env)
        try:
            for i in range(3):
                tid = lean_threads.new(f"idle{i}")
                lean_threads.set_session(tid, session_id=f"1111111{i}-1111-1111-1111-111111111111", session_on=True,
                                         session_on_at=time.time())
        finally:
            os.environ.clear()
            os.environ.update(old)
        self.p = subprocess.Popen([sys.executable, CLI, "up"], env=self.env, stdin=subprocess.DEVNULL,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=self.tmp)
        self.addCleanup(self.stop)
        import lean_sock
        self.sock = lean_sock
        os.environ["LEAN_AGENT_HOME"] = home
        self.addCleanup(os.environ.pop, "LEAN_AGENT_HOME", None)
        end = time.time() + 60 * (2 if CI else 1)
        while time.time() < end and self.sock.state(1.0)[0] != "listening":
            time.sleep(0.2)
        self.assertEqual(self.sock.state(1.0)[0], "listening")
        time.sleep(8)  # warm-up: sessions start, the helper warms

    def stop(self):
        if self.p.poll() is None:
            self.p.terminate()
            try:
                self.p.wait(timeout=30)
            except subprocess.TimeoutExpired:
                self.p.kill()
                self.p.wait()

    def test_idle_service_cpu_and_threads(self):
        n0 = threads_of(self.p.pid)
        c0, t0 = proc_cpu(self.p.pid), time.time()
        time.sleep(10)
        busy = (proc_cpu(self.p.pid) - c0) / (time.time() - t0)
        print(f"idle service: {busy * 100:.1f}% of one core, {n0} threads")
        self.assertLess(busy, 0.10 * SLACK)
        self.assertLess(threads_of(self.p.pid), 40)

    def test_socket_requests_do_not_grow_threads(self):
        self.sock.call("ping")
        time.sleep(1)
        before = threads_of(self.p.pid)
        for i in range(50):
            self.sock.call("ping")
            if i % 10 == 0:
                self.sock.call("threads") if False else None
        time.sleep(2)
        after = threads_of(self.p.pid)
        print(f"threads before/after 50 requests: {before}/{after}")
        self.assertLessEqual(after, before + 2)


if __name__ == "__main__":
    unittest.main()
