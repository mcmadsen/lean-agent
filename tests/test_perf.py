"""CPU cost of the service loop on a big home, the snapshot write rule, and the inject hook's fast path."""
import os
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

from _env import clean_environ

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)

import lean_threads  # noqa: E402
import perf_fixture  # noqa: E402
import service_session as ss  # noqa: E402


class TickCostTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        env = mock.patch.dict(os.environ, {**clean_environ(), "LEAN_AGENT_HOME": self.tmp}, clear=True)
        env.start()
        self.addCleanup(env.stop)
        ss._TS_CACHE.clear()
        self.paths = perf_fixture.build(self.tmp)

    def test_tick_cost_under_bound(self):
        """One 2 s round of the service: 20 sessions' transcript reads plus the main scans (throttled ones counted at their rate)."""
        now = time.time()

        def round_():
            for p in self.paths:
                ss.transcript_state(p)
                ss.scan_turn(p, 0)
            ss.queued_reports()
            ss.snapshot_tick([f"t{i}" for i in range(20)], now)
        round_()
        c = time.process_time()
        for _ in range(10):
            round_()
        per = (time.process_time() - c) / 10
        # the 20/30 s scans, spread over 2 s ticks
        c = time.process_time()
        ss.repush_questions(now)
        ss.attention_items(now)
        scans = (time.process_time() - c) / 10 + (time.process_time() - c) / 15
        self.assertLess(per + scans, 0.05)

    def test_transcript_cache_follows_the_file(self):
        p = self.paths[0]
        a = ss.transcript_state(p)
        self.assertEqual(ss.transcript_state(p), a)
        with open(p, "a") as fh:
            fh.write('{"type": "assistant", "message": {"stop_reason": "end_turn", "content": [{"type": "text", "text": "hi"}]}}\n')
        self.assertTrue(ss.transcript_state(p)["ended"])
        self.assertGreater(ss.transcript_state(p)["size"], a["size"])


class SnapshotTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        env = mock.patch.dict(os.environ, {**clean_environ(), "LEAN_AGENT_HOME": self.tmp}, clear=True)
        env.start()
        self.addCleanup(env.stop)
        self.old = dict(ss._SNAP)
        ss._SNAP.update(frozen=False, keep_until=0, keep=set(), last_ids=None, last_at=0.0)
        self.addCleanup(lambda: (ss._SNAP.clear(), ss._SNAP.update(self.old)))

    def test_unchanged_not_rewritten_changed_rate_limited(self):
        with mock.patch.object(ss, "write_snapshot") as w:
            ss.snapshot_tick(["t1"], 1000)
            ss.snapshot_tick(["t1"], 1002)
            ss.snapshot_tick(["t1"], 1100)
            self.assertEqual(w.call_count, 1)
            ss.snapshot_tick(["t1", "t2"], 1020)  # changed, but written less than 30 s ago
            self.assertEqual(w.call_count, 1)
            ss.snapshot_tick(["t1", "t2"], 1031)
            self.assertEqual(w.call_count, 2)
            ss.snapshot_tick(["t1", "t2"], 1031 + ss.SNAP_REFRESH + 1)  # unchanged for long: refreshed
            self.assertEqual(w.call_count, 3)
            ss.snapshot_tick(["t9"], 1032 + ss.SNAP_REFRESH, force=True)  # the last one at stop always lands
            self.assertEqual(w.call_count, 4)


class InjectHookTest(unittest.TestCase):
    def run_hook(self, home, **env):
        e = {**clean_environ(), "LEAN_AGENT_HOME": home, **env}
        t0 = time.time()
        r = subprocess.run([sys.executable, "-X", "importtime", os.path.join(ROOT, "trampoline.py"), "inject_hook.py"],
                           input="{}", capture_output=True, text=True, env={**e, "PATH": os.environ.get("PATH", "")})
        return r, time.time() - t0

    def test_fast_path_no_heavy_import(self):
        home = tempfile.mkdtemp()
        r, took = self.run_hook(home, LEAN_AGENT_SERVICE_SESSION="1")
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout, "")
        self.assertNotIn("lean_agent", r.stderr)
        self.assertNotIn("service_session", r.stderr)
        self.assertNotIn("lean_common", r.stderr)
        self.assertLess(took, 0.03 * max(1, float(os.environ.get("LEAN_AGENT_TEST_TIMEOUT_SCALE", "1"))) + 0.1)

    def test_outside_a_service_session_does_nothing(self):
        r, _ = self.run_hook(tempfile.mkdtemp())
        self.assertEqual((r.returncode, r.stdout), (0, ""))
        self.assertNotIn("json", r.stderr)

    def test_pending_report_takes_the_slow_path(self):
        import inject_hook
        home = tempfile.mkdtemp()
        with mock.patch.dict(os.environ, {"LEAN_AGENT_HOME": home}):
            self.assertTrue(inject_hook.nothing_pending())
            with open(os.path.join(home, "thread-reports.json"), "w") as fh:
                fh.write('{"items": [{"kind": "done"}]}')
            self.assertFalse(inject_hook.nothing_pending())
            os.makedirs(os.path.join(home, "thread-inbox", "t1"))
            self.assertTrue(inject_hook.nothing_pending("t1"))
            open(os.path.join(home, "thread-inbox", "t1", "0001-ab.json"), "w").close()
            self.assertFalse(inject_hook.nothing_pending("t1"))


HEAVY = ("usage", "lean_threads", "service_session", "lean_agent", "lean_common", "push_guard", "lean_schedule")


class BudgetHookFastPathTest(unittest.TestCase):
    EVENT = '{"hook_event_name": "PreToolUse", "tool_name": "Read", "tool_input": {"file_path": "/x"}, "session_id": "s", "cwd": "/tmp", "transcript_path": "/x"}'

    def run_hook(self, event, **env):
        code = ("import sys, runpy; sys.argv = ['trampoline.py', 'budget_hook.py']; sys.path.insert(0, %r); "
                "sys.argv = ['x']; import json; from budget_gate import nothing_to_do; "
                "e = json.loads(%r); print(nothing_to_do(e)); print(sorted(m for m in sys.modules if m in %r))"
                % (ROOT, event, HEAVY))
        e = {**clean_environ(), "LEAN_AGENT_HOME": tempfile.mkdtemp(), "PATH": os.environ.get("PATH", ""), **env}
        return subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=e).stdout.split("\n")

    def test_noop_outside_lean_agent(self):
        out = self.run_hook(self.EVENT)
        self.assertEqual(out[0], "True")
        self.assertEqual(out[1], "[]")  # no heavy module imported

    def test_checks_still_apply_where_they_matter(self):
        self.assertEqual(self.run_hook(self.EVENT, LEAN_AGENT_SESSION_ROLE="thread")[0], "False")
        self.assertEqual(self.run_hook(self.EVENT, LEAN_AGENT_BUDGET="1000")[0], "False")
        self.assertEqual(self.run_hook(self.EVENT, LEAN_AGENT_SERVICE_SESSION="1")[0], "False")
        push = self.EVENT.replace('"Read"', '"Bash"').replace('{"file_path": "/x"}', '{"command": "git push"}')
        self.assertEqual(self.run_hook(push)[0], "False")

    def test_noop_through_the_trampoline_is_fast(self):
        e = {**clean_environ(), "LEAN_AGENT_HOME": tempfile.mkdtemp(), "PATH": os.environ.get("PATH", "")}
        args = [sys.executable, os.path.join(ROOT, "trampoline.py"), "budget_hook.py"]
        subprocess.run(args, input=self.EVENT, text=True, env=e, capture_output=True)  # bytecode cached
        t0 = time.time()
        for _ in range(5):
            r = subprocess.run(args, input=self.EVENT, text=True, env=e, capture_output=True)
            self.assertEqual((r.returncode, r.stdout), (0, ""))
        per = (time.time() - t0) / 5
        self.assertLess(per, 0.03 * max(1.0, float(os.environ.get("LEAN_AGENT_TEST_TIMEOUT_SCALE", "1"))) + 0.03)


class ThreadsCacheTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        env = mock.patch.dict(os.environ, {**clean_environ(), "LEAN_AGENT_HOME": self.tmp}, clear=True)
        env.start()
        self.addCleanup(env.stop)
        lean_threads.invalidate()
        perf_fixture.build(self.tmp, live=0)

    def test_unchanged_file_is_parsed_once(self):
        with mock.patch.object(lean_threads.json, "load", wraps=lean_threads.json.load) as j:
            for _ in range(5):
                lean_threads.load()
                lean_threads.load_ro()
        self.assertEqual(j.call_count, 1)

    def test_load_returns_a_private_copy(self):
        a = lean_threads.load()
        a["threads"]["t1"]["title"] = "changed"
        self.assertNotEqual(lean_threads.load()["threads"]["t1"].get("title"), "changed")

    def test_fresh_after_a_write(self):
        lean_threads.load()
        with lean_threads._locked() as data:
            data["threads"]["t1"]["title"] = "after"
        self.assertEqual(lean_threads.load()["threads"]["t1"]["title"], "after")
        self.assertEqual(lean_threads.load_ro()["threads"]["t1"]["title"], "after")

    def test_fresh_after_an_outside_write(self):
        import json
        lean_threads.load_ro()
        with open(lean_threads.path()) as fh:
            d = json.load(fh)
        d["threads"]["t2"]["title"] = "outside"
        with open(lean_threads.path(), "w") as fh:
            json.dump(d, fh)
        self.assertEqual(lean_threads.load()["threads"]["t2"]["title"], "outside")


if __name__ == "__main__":
    unittest.main()
