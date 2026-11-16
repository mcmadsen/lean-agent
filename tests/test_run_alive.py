"""A live run is never reported ended/lost: linger guard matches its own ledger row only, ps trouble is not death,
a live worker keeps a run running, pid reuse is not alive, the run timeout really stops the worker tree."""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)
import lean_agent as L  # noqa: E402
import lean_common as C  # noqa: E402


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        p = mock.patch.dict(os.environ, {"LEAN_AGENT_HOME": self.tmp})
        p.start()
        self.addCleanup(p.stop)
        os.makedirs(os.path.join(self.tmp, "running"))
        self.procs = []
        self.addCleanup(lambda: [(q.kill(), q.wait()) for q in self.procs])

    def sleeper(self):
        q = subprocess.Popen(["sleep", "300"])
        self.procs.append(q)
        return q

    def marker(self, rid, pid, **extra):
        wd = os.path.join(self.tmp, "work", rid)
        os.makedirs(wd, exist_ok=True)
        with open(os.path.join(self.tmp, "running", rid + ".json"), "w") as fh:
            json.dump({"run": rid, "pid": pid, "started": "2026-01-01T00:00:00", "task": "t", "workdir": wd, **extra}, fh)
        return wd

    def ledger_line(self, row):
        with open(os.path.join(self.tmp, "ledger.jsonl"), "a") as fh:
            fh.write(json.dumps(row) + "\n")


class LingerGuard(Base):
    RID = "2026-010101-abcd"

    def test_mention_in_another_rows_task_is_not_a_row_of_the_run(self):
        self.ledger_line({"id": "2026-010102-ffff", "status": "done", "task": f"check run {self.RID} please"})
        self.assertFalse(L.run_recorded(self.RID))
        self.ledger_line({"id": self.RID, "status": "done"})
        self.assertTrue(L.run_recorded(self.RID))

    def test_guard_does_not_end_a_live_supervisor_on_a_mention(self):
        self.ledger_line({"id": "2026-010102-ffff", "status": "done", "task": f"look at {self.RID}"})
        exits = []
        with mock.patch.dict(L.RUN_CTX, {"id": self.RID}):
            import threading
            t = threading.Thread(target=L.supervisor_linger_guard, kwargs=dict(poll=0.05, linger=0.1, exit=exits.append),
                                 daemon=True)
            t.start()
            time.sleep(0.6)
        self.assertEqual(exits, [])


class Alive(Base):
    def test_ps_failure_is_not_death(self):
        q = self.sleeper()
        with mock.patch("builtins.open", side_effect=OSError), \
                mock.patch.object(L.subprocess, "run", side_effect=OSError("fork failed")):
            self.assertTrue(L.supervisor_alive(q.pid))
        res = mock.Mock(returncode=1, stdout="")
        with mock.patch("builtins.open", side_effect=OSError), mock.patch.object(L.subprocess, "run", return_value=res):
            self.assertTrue(L.supervisor_alive(q.pid))

    def test_dead_supervisor_live_worker_is_running_orphaned(self):
        worker = self.sleeper()
        dead = subprocess.Popen(["true"])
        dead.wait()
        wd = self.marker("r1", dead.pid)
        self.assertEqual(C.running_runs(self.tmp), [])
        C.write_claude_pid(wd, worker.pid)
        live = C.running_runs(self.tmp)
        self.assertEqual([r for r, _ in live], ["r1"])
        self.assertTrue(live[0][1]["orphaned"])
        self.assertTrue(live[0][1]["last_progress"] >= 0)
        self.assertEqual(C.lost_runs(self.tmp), [])

    def test_pid_reuse_is_not_alive(self):
        other = self.sleeper()
        dead = subprocess.Popen(["true"])
        dead.wait()
        wd = self.marker("r2", dead.pid)
        with open(os.path.join(wd, "claude.pid"), "w") as fh:
            json.dump({"pid": other.pid, "start": "p1"}, fh)  # recorded for a process that is gone; the pid is someone else's
        self.assertIsNone(C.claude_alive(wd))
        self.assertEqual(C.running_runs(self.tmp), [])
        self.assertEqual([r for r, _ in C.lost_runs(self.tmp)], ["r2"])
        self.marker("r3", other.pid, pid_start="p1")
        self.assertNotIn("r3", [r for r, _ in C.running_runs(self.tmp)])


class Parent(Base):
    def run_parent(self, supervisor_code):
        wd = os.path.join(self.tmp, "wd")
        script = (
            "import sys, os, time, subprocess\n"
            f"sys.path.insert(0, {ROOT!r})\n"
            "import lean_agent as L, lean_common as C\n"
            "L.CLI_ENTRY.append(True)\n"
            f"r = L.detach_run({wd!r}, 'r1')\n"
            "if r is None:\n" + "".join("    " + l + "\n" for l in supervisor_code.splitlines()) +
            "sys.exit(r)\n")
        env = {k: v for k, v in os.environ.items() if k != "LEAN_AGENT_NO_DETACH"}
        return subprocess.run([sys.executable, "-c", script], env=env, capture_output=True, text=True, timeout=60), wd

    def test_supervisor_gone_worker_alive_is_not_failed(self):
        code = ("w = subprocess.Popen(['sleep', '5'], start_new_session=True)\n"
                f"C.write_claude_pid({os.path.join(self.tmp, 'wd')!r}, w.pid)\nos._exit(0)")
        r, _ = self.run_parent(code)
        self.assertEqual(r.returncode, 124, r.stderr)
        self.assertIn("still running", r.stderr)
        self.assertIn("not failed", r.stderr)
        self.assertNotIn("said nothing", r.stderr)
        subprocess.run(["pkill", "-f", "sleep 5"])

    def test_alive_but_silent_supervisor_is_waited_for(self):
        code = "time.sleep(3)\nopen(os.path.join(os.path.dirname(%r), 'x'), 'w').close()\nL.SUPERVISOR_RC and open(L.SUPERVISOR_RC[0], 'w').write('0')\nos._exit(0)" % os.path.join(self.tmp, "wd")
        r, _ = self.run_parent(code)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(os.path.exists(os.path.join(self.tmp, "x")))

    def test_parent_term_says_still_running(self):
        wd = os.path.join(self.tmp, "wd")
        script = (
            "import sys, os, time\n"
            f"sys.path.insert(0, {ROOT!r})\n"
            "import lean_agent as L\nL.CLI_ENTRY.append(True)\n"
            f"r = L.detach_run({wd!r}, 'r1')\n"
            "if r is None:\n    time.sleep(12)\n    os._exit(0)\n"
            "sys.exit(r)\n")
        p = subprocess.Popen([sys.executable, "-c", script], env={k: v for k, v in os.environ.items() if k != "LEAN_AGENT_NO_DETACH"},
                             stderr=subprocess.PIPE, text=True)
        time.sleep(4)
        p.terminate()
        _, err = p.communicate(timeout=30)
        self.assertEqual(p.returncode, 124, err)
        self.assertIn("still running", err)
        self.assertNotIn("run failed", err)


class Timeout(Base):
    def test_timeout_stops_worker_and_children(self):
        proc = subprocess.Popen(["sh", "-c", "sleep 300 & wait"])
        self.procs.append(proc)
        time.sleep(0.5)
        kids = L.descendants(proc.pid)
        self.assertTrue(kids)
        L.stop_tree(proc, grace=1)
        proc.wait(timeout=10)
        time.sleep(0.3)
        for k in kids:
            self.assertFalse(L.supervisor_alive(k))

    def test_stream_worker_timeout_reports_and_kills(self):
        wd = os.path.join(self.tmp, "w")
        os.makedirs(wd)
        _, err, reads = L.stream_worker(["sh", "-c", "sleep 300 & wait"], "", wd, dict(os.environ, LEAN_AGENT_KILL_GRACE="1"),
                                        1.5, 0, None)
        self.assertTrue(reads["timed_out"])
        self.assertIn("timed out after", err)
        self.assertIsNone(C.claude_alive(wd))


if __name__ == "__main__":
    unittest.main()
