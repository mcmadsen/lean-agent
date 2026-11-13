"""0.45.56: a detached supervisor is a grandchild: killing the caller's whole process tree does not stop the run."""
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)
import lean_agent as L  # noqa: E402


def children(pid):
    r = subprocess.run(["pgrep", "-P", str(pid)], capture_output=True, text=True)
    return [int(x) for x in r.stdout.split()]


def tree(pid):
    out = []
    for c in children(pid):
        out += [c] + tree(c)
    return out


class Detach(unittest.TestCase):
    def test_supervisor_survives_tree_kill(self):
        tmp = tempfile.mkdtemp()
        wd = os.path.join(tmp, "wd")
        script = (
            "import sys, os, time\n"
            f"sys.path.insert(0, {ROOT!r})\n"
            "import lean_agent as L\n"
            "L.CLI_ENTRY.append(True)\n"
            f"os.environ['LEAN_AGENT_HOME']={tmp!r}\n"
            f"r = L.detach_run({wd!r}, 'r1')\n"
            "if r is None:\n"
            f"    open(os.path.join({tmp!r}, 'pid'), 'w').write(str(os.getpid()))\n"
            "    time.sleep(2)\n"
            f"    open(os.path.join({tmp!r}, 'done'), 'w').write('ok')\n"
            "    os._exit(0)\n"
            "sys.exit(r)\n")
        env = dict(os.environ)
        env.pop("LEAN_AGENT_NO_DETACH", None)
        caller = subprocess.Popen([sys.executable, "-c", script], env=env, stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
        deadline = time.time() + 20
        while not os.path.exists(os.path.join(tmp, "pid")) and time.time() < deadline:
            time.sleep(0.1)
        sup = int(open(os.path.join(tmp, "pid")).read())
        self.addCleanup(lambda: os.path.exists(os.path.join(tmp, "done")) or os.kill(sup, signal.SIGKILL))
        self.assertNotIn(sup, tree(caller.pid))  # reparented: not in the caller's tree
        for pid in tree(caller.pid) + [caller.pid]:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
        caller.wait()
        deadline = time.time() + 15
        while not os.path.exists(os.path.join(tmp, "done")) and time.time() < deadline:
            time.sleep(0.1)
        self.assertTrue(os.path.exists(os.path.join(tmp, "done")))

    def test_spawned_supervisor_has_own_session_and_env(self):
        """detach_run(spawn=...) starts a fresh interpreter in its own session, with the fork-safety variable set."""
        tmp = tempfile.mkdtemp()
        wd = os.path.join(tmp, "wd")
        os.makedirs(wd)
        paths = [os.path.join(wd, f"supervisor.{n}") for n in ("out", "err")]
        os.environ.pop("OBJC_DISABLE_INITIALIZE_FORK_SAFETY", None)
        pid = L.spawn_supervisor(wd, "r1", paths, {"args": None, "task": "t", "workdir": wd})
        self.assertTrue(pid)
        self.addCleanup(lambda: os.kill(pid, signal.SIGKILL) if L.pid_alive(pid) else None)
        self.assertEqual(os.getsid(pid), pid)  # a session of its own
        self.assertNotEqual(os.getsid(pid), os.getsid(0))


if __name__ == "__main__":
    unittest.main()
