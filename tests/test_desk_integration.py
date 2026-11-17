"""End to end: a real `lean-agent up` (auto desk mode) with a fake `claude`; an app desk attaches, the hosted main stands aside and
later comes back. Through both switches the service socket must keep answering (ping, session ops, `thread` commands), nothing may
log an ERROR and the service must not spin (CPU time). With the desk pinned to hosted nothing switches."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

from _env import clean_environ

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)

import lean_desk  # noqa: E402
import service_session as ss  # noqa: E402

OBSERVE = 20  # seconds each phase is watched
TICKS = os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100


def cpu_seconds(pid):
    """utime + stime of one process (Linux /proc), or None."""
    try:
        with open(f"/proc/{pid}/stat") as fh:
            parts = fh.read().rsplit(")", 1)[1].split()
        return (int(parts[11]) + int(parts[12])) / TICKS
    except (OSError, IndexError, ValueError):
        return None


@unittest.skipUnless(os.path.isdir("/proc/self"), "needs /proc")
class Base(unittest.TestCase):
    pin = None  # LEAN_AGENT_DESK for the service and the test

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.home = os.path.join(self.tmp, "lean")
        os.makedirs(self.home)
        fake = os.path.join(self.tmp, "claude")
        with open(fake, "w") as fh:
            fh.write("#!/bin/sh\nexec sleep 3600\n")  # a session that stays up and says nothing
        os.chmod(fake, 0o755)
        self.env = {**clean_environ(), "HOME": self.tmp, "LEAN_AGENT_HOME": self.home, "LEAN_AGENT_TEST": "1",
                    "LEAN_AGENT_CLAUDE": fake, "LEAN_AGENT_DESK_RETRY": "1", "LEAN_AGENT_CLOSE_CHECKPOINT_WAIT": "1",
                    "LEAN_AGENT_DESK_GAP": "1", "LEAN_AGENT_DESK_STOP_GRACE": "3", "PATH": "/usr/bin:/bin"}
        if self.pin:
            self.env["LEAN_AGENT_DESK"] = self.pin
        p = mock.patch.dict(os.environ, self.env, clear=True)
        p.start()
        self.addCleanup(p.stop)
        self.log = open(os.path.join(self.tmp, "up.out"), "wb")
        self.up = subprocess.Popen([sys.executable, os.path.join(ROOT, "lean_agent.py"), "up", "--name", "t"], env=self.env,
                                   stdin=subprocess.DEVNULL, stdout=self.log, stderr=subprocess.STDOUT, start_new_session=True)
        self.addCleanup(self.stop_up)
        self.beat_stop = threading.Event()
        self.addCleanup(self.beat_stop.set)

    def stop_up(self):
        try:
            os.killpg(self.up.pid, 15)
            self.up.wait(timeout=30)
        except (OSError, subprocess.TimeoutExpired):
            try:
                os.killpg(self.up.pid, 9)
            except OSError:
                pass
        self.log.close()

    def until(self, what, cond, timeout=60):
        end = time.time() + timeout
        while time.time() < end:
            if self.up.poll() is not None:
                self.fail(f"`up` exited ({self.up.returncode}) while waiting for {what}:\n{self.up_output()}")
            try:
                if cond():
                    return
            except Exception:  # noqa: BLE001
                pass
            time.sleep(0.3)
        self.fail(f"timed out waiting for {what}; desk: {lean_desk.status_line()}\n{self.up_output()}")

    def up_output(self):
        with open(os.path.join(self.tmp, "up.out"), errors="replace") as fh:
            return fh.read()[-3000:]

    def cli(self, *argv):
        r = subprocess.run([sys.executable, os.path.join(ROOT, "lean_agent.py"), *argv], env=self.env, capture_output=True,
                           text=True, timeout=60, stdin=subprocess.DEVNULL)
        return r.returncode, r.stdout + r.stderr

    def heartbeat(self):
        def beat():
            while not self.beat_stop.wait(2):
                lean_desk.heartbeat("fake-desk", None)
        self.beat_stop.clear()
        threading.Thread(target=beat, daemon=True).start()

    def errors(self):
        out = []
        for d in (os.path.join(self.home, "logs"),):
            for name in os.listdir(d) if os.path.isdir(d) else []:
                if name.endswith(".log") and name != "session.log":
                    with open(os.path.join(d, name), errors="replace") as fh:
                        out += [ln for ln in fh if " ERROR " in ln]
        return out

    def checks(self, expect_alive, label):
        """Watch OBSERVE seconds: the socket answers, session ops and `thread` commands work, no ERROR, no busy loop."""
        cpu0 = cpu_seconds(self.up.pid)
        end = time.time() + OBSERVE
        first = True
        while time.time() < end:
            r = ss.request({"ping": True}, timeout=3)
            self.assertTrue(r.get("ok"), f"{label}: ping failed: {r}")
            self.assertEqual(r.get("alive"), expect_alive, f"{label}: {r}")
            r = ss.sessions_request("list", timeout=5)
            self.assertTrue(r.get("ok"), f"{label}: sessions list failed: {r}")
            self.assertTrue(ss.alive("main") is expect_alive, label)
            if first:
                first = False
                for argv in (("thread", "sessions"), ("thread", "new", "one", "hello"), ("thread", "list")):
                    rc, text = self.cli(*argv)
                    self.assertEqual(rc, 0, f"{label}: {argv}: {text}")
                    self.assertNotIn("no service session is up", text, f"{label}: {argv}")
                    self.assertNotIn("no session bridge", text, f"{label}: {argv}")
                rc, text = self.cli("thread", "send", "t1", "more")
                self.assertNotIn("no service session is up", text, label)
                self.assertNotIn("no session bridge", text, label)
            time.sleep(2)
        self.assertEqual(self.errors(), [], label)
        cpu1 = cpu_seconds(self.up.pid)
        self.assertLess(cpu1 - cpu0, 1.0, f"{label}: the service burned {cpu1 - cpu0:.2f}s of CPU in {OBSERVE}s (busy loop?)")
        self.assertIsNone(self.up.poll(), f"{label}: `up` died")


class AutoSwitch(Base):
    pin = "auto"  # opt-in mode (the default is hosted)

    def test_switch_to_the_app_desk_and_back_keeps_the_service_up(self):
        self.until("the hosted main", lambda: ss.request({"ping": True}).get("alive") is True)
        self.checks(True, "hosted")
        ok, msg = lean_desk.attach("fake-desk", None, lean_desk.desk_dir())
        self.assertTrue(ok, msg)
        self.heartbeat()
        self.until("the switch to the app desk", lambda: lean_desk.state().get("active") == "app", 90)
        self.until("the app desk confirmed", lambda: lean_desk.is_desk("fake-desk"))
        self.checks(True, "app desk")
        # the heartbeat expires: the hosted main comes back
        self.beat_stop.set()
        time.sleep(2.5)
        rec = lean_desk.record()
        rec["heartbeat"] = time.time() - 3600
        lean_desk._write(lean_desk.path(), rec)
        self.until("the switch back to the hosted main", lambda: lean_desk.state().get("active") == "hosted"
                   and ss.request({"ping": True}).get("alive") is True, 90)
        self.checks(True, "hosted again")


class Pinned(Base):
    pin = "hosted"

    def test_pinned_hosted_never_switches(self):
        self.until("the hosted main", lambda: ss.request({"ping": True}).get("alive") is True)
        self.assertEqual(lean_desk.mode(), "hosted")
        lean_desk.attach("fake-desk", None, lean_desk.desk_dir())  # an app session cannot attach in hosted mode
        self.assertEqual(lean_desk.active(), "hosted")
        self.checks(True, "pinned hosted")
        self.assertEqual(lean_desk.state().get("active"), None)


if __name__ == "__main__":
    unittest.main()
