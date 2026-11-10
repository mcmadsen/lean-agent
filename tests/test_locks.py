"""Lock holders, the internal `thread deliver`, and markers of dead runs that have no ledger row."""
import fcntl
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

from _env import clean_environ, scaled

SCRIPTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, SCRIPTS)
import lean_common  # noqa: E402
import budget_hook  # noqa: E402

AGENT = os.path.join(SCRIPTS, "lean_agent.py")


def sleeper():
    return subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])


def dead_pid():
    p = subprocess.Popen([sys.executable, "-c", "pass"])
    p.wait()
    return p.pid


class LockTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "thread-start")

    def hold(self, pid, age=0):
        """A lock file that names `pid` and is held by this process."""
        fh = open(self.path + ".lock", "w")
        fh.write(f"{pid}\n")
        fh.flush()
        fcntl.flock(fh, fcntl.LOCK_EX)
        if age:
            os.utime(self.path + ".lock", (time.time() - age, time.time() - age))
        self.addCleanup(fh.close)
        return fh

    def test_dead_holder_is_taken_over(self):
        self.hold(dead_pid())  # the flock stays held (an inheriting child), the named pid is gone
        t0 = time.time()
        with lean_common.file_lock(self.path, timeout=scaled(5)):
            pass
        self.assertLess(time.time() - t0, scaled(3))

    def test_long_held_lock_fails_cleanly_with_command(self):
        p = sleeper()
        self.addCleanup(p.kill)
        self.hold(p.pid, age=17 * 60)
        with self.assertRaises(lean_common.LockBusy) as cm:
            with lean_common.file_lock(self.path, timeout=0.3):
                pass
        text = str(cm.exception)
        self.assertIn(f"pid {p.pid}", text)
        self.assertIn("held it 17m", text)
        self.assertIn("lean-agent doctor", text)
        self.assertIn("time.sleep", text)  # the holder's command line

    def test_cli_lock_timeout_is_not_a_crash(self):
        home = os.path.join(self.tmp.name, "home")
        os.makedirs(home)
        p = sleeper()
        self.addCleanup(p.kill)
        fh = open(os.path.join(home, "thread-start.lock"), "w")
        fh.write(f"{p.pid}\n")
        fh.flush()
        fcntl.flock(fh, fcntl.LOCK_EX)
        self.addCleanup(fh.close)
        env = dict(clean_environ(), LEAN_AGENT_HOME=home, LEAN_AGENT_LOCK_TIMEOUT="1")
        # the unit-level guarantee: LockBusy is a TimeoutError with one line; the handler turns it into exit 1
        with mock.patch.dict(os.environ, env):
            with self.assertRaises(lean_common.LockBusy) as cm:
                with lean_common.file_lock(os.path.join(home, "thread-start"), timeout=0.3):
                    pass
        self.assertEqual(len(str(cm.exception).splitlines()), 1)
        self.assertIsInstance(cm.exception, TimeoutError)

    def test_doctor_lists_long_held_and_fix_clears_dead(self):
        import lean_agent
        p = sleeper()
        self.addCleanup(p.kill)
        self.hold(p.pid, age=5 * 60)
        lines = []
        lean_agent.doctor_locks(lambda ok, msg, fix=None: lines.append((ok, msg)), False, self.tmp.name)
        self.assertTrue(any(f"pid {p.pid}" in m and "5m" in m for _, m in lines), lines)
        # a dead holder is cleared by --fix
        os.remove(self.path + ".lock")
        self.hold(dead_pid(), age=1)
        lines.clear()
        lean_agent.doctor_locks(lambda ok, msg, fix=None: lines.append((ok, msg)), False, self.tmp.name)
        self.assertTrue(lines and lines[0][0] is False, lines)
        lines.clear()
        lean_agent.doctor_locks(lambda ok, msg, fix=None: lines.append((ok, msg)), True, self.tmp.name)
        self.assertIn("cleared", lines[0][1])
        self.assertFalse(os.path.exists(self.path + ".lock"))


class DeliverTest(unittest.TestCase):
    def event(self, cmd):
        return {"tool_name": "Bash", "tool_input": {"command": cmd}}

    def test_refused_in_main_and_thread_sessions(self):
        for role in ("main", "thread"):
            with mock.patch.dict(os.environ, {"LEAN_AGENT_SESSION_ROLE": role}):
                why = budget_hook.front_desk_denial(self.event("lean-agent thread deliver t12"))
                self.assertIn("the service delivers; use thread send", why)
        with mock.patch.dict(os.environ, {"LEAN_AGENT_SESSION_ROLE": "thread"}):
            self.assertEqual(budget_hook.front_desk_denial(self.event("lean-agent thread send t12 hi")), "")

    def test_hidden_from_help(self):
        out = subprocess.run([sys.executable, AGENT, "thread", "-h"], capture_output=True, text=True,
                             env=clean_environ()).stdout
        self.assertNotRegex(out, r"\bdeliver\b")  # the hidden subcommand; "delivered"/"delivery" in other help is fine

    def test_by_hand_never_waits_long(self):
        import lean_agent
        started = []

        def slow(tid, lock_wait=0, resume_old=False):
            started.append(tid)
            time.sleep(5)
            return "ok", "late"
        with mock.patch.object(lean_agent, "deliver_spool", slow), \
                mock.patch.object(lean_agent, "thread_session_tid", lambda t: (t, {})), \
                mock.patch.object(lean_agent, "queued_line", lambda t: f"{t}: queued"), \
                mock.patch.object(lean_agent, "DELIVER_BY_HAND_WAIT", 0.3):
            t0 = time.time()
            self.assertEqual(lean_agent.deliver_by_hand("t1"), "t1: queued")
        self.assertLess(time.time() - t0, scaled(3))
        self.assertEqual(started, ["t1"])


class StartLockTest(unittest.TestCase):
    def test_slow_host_start_is_capped_while_lock_held(self):
        import lean_agent
        import service_session
        calls = []

        def slow_request(op, timeout=60, **kw):
            calls.append((op, timeout))
            return {"ok": False, "error": "timed out"}
        with mock.patch.object(service_session, "sessions_request", slow_request), \
                mock.patch.object(service_session, "alive", lambda *a, **k: False), \
                mock.patch.object(lean_agent, "START_GRACE", 0), \
                mock.patch.object(lean_threads_mod(), "set_session", lambda *a, **k: None):
            with self.assertRaises(RuntimeError):
                lean_agent.start_thread_session("t1", {"session_id": "s"}, None, "m")
        self.assertEqual(calls[0], ("start", lean_agent.START_REQUEST_WAIT))
        self.assertEqual(calls[1], ("stop", lean_agent.STOP_REQUEST_WAIT))
        self.assertLessEqual(lean_agent.START_REQUEST_WAIT + lean_agent.STOP_REQUEST_WAIT, 60)
        self.assertLess(lean_agent.THREAD_START_LOCK_WAIT, 300)


def lean_threads_mod():
    import lean_threads
    return lean_threads


class OrphanMarkerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env = mock.patch.dict(os.environ, dict(clean_environ(), LEAN_AGENT_HOME=self.tmp.name))
        self.env.start()
        self.addCleanup(self.env.stop)
        os.makedirs(os.path.join(self.tmp.name, "running"))

    def marker(self, rid, started, **kw):
        m = {"run": rid, "pid": dead_pid(), "started": started, "task": "check the widget " + rid, "model": "haiku",
             "thread": "t5", **kw}
        with open(os.path.join(self.tmp.name, "running", rid + ".json"), "w") as fh:
            json.dump(m, fh)
        return m

    def ledger_rows(self):
        try:
            return [json.loads(x) for x in open(os.path.join(self.tmp.name, "ledger.jsonl"))]
        except OSError:
            return []

    def test_lone_marker_gets_a_record_row_and_clear_removes_it(self):
        import lean_goals
        import lean_agent
        self.marker("0101-0000-aa11", "2026-01-01T10:00:00")
        lean_goals.settle_orphan_markers({"threads": {"t5": {}}, "aliases": {}, "overrides": {}})
        rows = self.ledger_rows()
        self.assertEqual([r["status"] for r in rows], ["lost (no record)"])
        self.assertIn("check the widget", rows[0]["task"])
        self.assertEqual([r for r, _ in lean_common.lost_runs(self.tmp.name)], ["0101-0000-aa11"])
        self.assertIn("nothing to resume", lean_goals.lost_message("r", "ref", True))
        lean_goals.settle_orphan_markers({"threads": {"t5": {}}, "aliases": {}, "overrides": {}})  # again: no second row
        self.assertEqual(len(self.ledger_rows()), 1)
        for rid, m in lean_common.lost_runs(self.tmp.name):
            self.assertTrue(m.get("no_record"))
            os.remove(os.path.join(self.tmp.name, "running", rid + ".json"))
        self.assertEqual(lean_common.lost_runs(self.tmp.name), [])

    def test_marker_with_newer_run_is_dropped_silently(self):
        import lean_goals
        self.marker("0101-0000-aa11", "2026-01-01T10:00:00")
        self.marker("0101-0000-bb22", "2026-01-01T11:00:00", pid=os.getpid())  # a live newer run of the thread
        lean_goals.settle_orphan_markers({"threads": {"t5": {}}, "aliases": {}, "overrides": {}})
        self.assertEqual(self.ledger_rows(), [])
        self.assertFalse(os.path.exists(os.path.join(self.tmp.name, "running", "0101-0000-aa11.json")))

    def test_marker_before_final_report_is_dropped(self):
        import lean_goals
        self.marker("0101-0000-aa11", "2026-01-01T10:00:00")
        with open(os.path.join(self.tmp.name, "last-reports.json"), "w") as fh:
            json.dump({"t5": {"kind": "done", "text": "x", "ts": time.time()}}, fh)
        lean_goals.settle_orphan_markers({"threads": {"t5": {}}, "aliases": {}, "overrides": {}})
        self.assertEqual(self.ledger_rows(), [])
        self.assertEqual(lean_common.lost_runs(self.tmp.name), [])


if __name__ == "__main__":
    unittest.main()


class HookLockTest(unittest.TestCase):
    """Hooks never wait long for a lock, and long waits/holds are logged with the lock's name."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        p = mock.patch.dict(os.environ, {**clean_environ(), "LEAN_AGENT_HOME": self.tmp.name}, clear=True)
        p.start()
        self.addCleanup(p.stop)
        self.addCleanup(lambda: lean_common.HOOK.update(on=False))
        lean_common._SKIPPED.clear()

    def test_a_hook_gives_up_on_a_busy_lock_within_the_hook_wait(self):
        path = os.path.join(self.tmp.name, "goals.json")
        with lean_common.file_lock(path):
            code = ("import sys; sys.path.insert(0, %r)\nimport lean_common, time\nlean_common.hook_mode()\n"
                    "t = time.time()\ntry:\n    with lean_common.file_lock(%r): pass\n"
                    "except lean_common.LockBusy: print('busy %%.2f' %% (time.time() - t))\n" % (SCRIPTS, path))
            out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=scaled(15),
                                 env=dict(clean_environ(), LEAN_AGENT_HOME=self.tmp.name))
        self.assertTrue(out.stdout.startswith("busy"), out.stdout + out.stderr)
        self.assertLess(float(out.stdout.split()[1]), scaled(2.0))
        rows = lean_common.recent_long_holds()
        self.assertTrue(any(r["lock"] == "goals.json" and r["kind"] == "skipped" for r in rows))

    def test_the_wait_notice_shows_the_real_age_of_the_hold(self):
        path = os.path.join(self.tmp.name, "goals.json.lock")
        with open(path, "w") as fh:
            fh.write(f"{os.getpid()}\n")
        old = time.time() - 130
        os.utime(path, (old, old))
        notes = []
        holder = open(path, "a")
        fcntl.flock(holder, fcntl.LOCK_EX)
        self.addCleanup(holder.close)
        with mock.patch.object(lean_common, "WAIT_NOTICE", [notes.append]):
            with open(path, "a") as fh:
                with self.assertRaises(lean_common.LockBusy):
                    lean_common.flock_waiting(fh, fcntl.LOCK_EX, "goals.json", path, timeout=0.2)
        self.assertTrue(any("for 2m1" in n or "for 2m2" in n for n in notes), notes)
        self.assertFalse(any("(0s)" in n for n in notes), notes)

    def test_a_long_hold_is_logged_with_the_lock_name_and_holder(self):
        path = os.path.join(self.tmp.name, "goals.json")
        with mock.patch.object(lean_common, "LONG_HOLD", 0.05):
            with lean_common.file_lock(path):
                time.sleep(0.2)
        rows = lean_common.recent_long_holds()
        self.assertEqual(rows[-1]["lock"], "goals.json")
        self.assertEqual(rows[-1]["kind"], "held")
        self.assertEqual(rows[-1]["pid"], str(os.getpid()))
        self.assertTrue(rows[-1]["cmd"])

    def test_a_long_wait_is_logged_with_the_holder(self):
        path = os.path.join(self.tmp.name, "waiting.json")
        holder = sleeper()
        self.addCleanup(holder.kill)
        fh = open(path + ".lock", "w")
        fcntl.flock(fh, fcntl.LOCK_EX)
        fh.write(f"{holder.pid}\n")
        fh.flush()
        self.addCleanup(fh.close)
        with mock.patch.object(lean_common, "LONG_HOLD", 0.1):
            with self.assertRaises(lean_common.LockBusy):
                with lean_common.file_lock(path, timeout=0.4):
                    pass
        row = [r for r in lean_common.recent_long_holds() if r["kind"] == "waiting"][-1]
        self.assertEqual((row["lock"], row["pid"]), ("waiting.json", str(holder.pid)))
