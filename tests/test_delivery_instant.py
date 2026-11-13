"""Front desk <-> thread delivery: idle session delivered at once, mid-turn at the next Pre/PostToolUse, the reason text of a
queued message, `thread wake` on idle / mid-turn / dead sessions, duplicate and stale automatic run reports dropped."""
import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest import mock

from _env import clean_environ

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)

import lean_agent  # noqa: E402
import lean_threads  # noqa: E402
import service_session as ss  # noqa: E402


class Base(unittest.TestCase):
    tid = "t1"

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.env = {**clean_environ(), "LEAN_AGENT_HOME": self.tmp, "LEAN_AGENT_LOG_DIR": os.path.join(self.tmp, "logs")}
        p = mock.patch.dict(os.environ, self.env, clear=True)
        p.start()
        self.addCleanup(p.stop)
        self.path = os.path.join(self.tmp, "t1.jsonl")
        open(self.path, "w").close()
        for name, val in (("session_transcript", lambda key="main": self.path), ("alive_thread", lambda t: True)):
            q = mock.patch.object(ss, name, val)
            q.start()
            self.addCleanup(q.stop)

    def add(self, stop, content):
        with open(self.path, "a") as fh:
            fh.write(json.dumps({"type": "assistant", "message": {"role": "assistant", "stop_reason": stop, "content": content}}) + "\n")

    def idle(self):
        self.add("end_turn", [{"type": "text", "text": "ok"}])

    def in_tool(self, cmd="sleep 900"):
        self.add("tool_use", [{"type": "tool_use", "id": "x", "name": "Bash", "input": {"command": cmd}}])

    def age(self, secs):
        t = time.time() - secs
        os.utime(self.path, (t, t))

    def hook(self, *args):
        out = subprocess.run([sys.executable, os.path.join(ROOT, "inject_hook.py"), *args], input="{}", capture_output=True, text=True,
                             env={**self.env, "LEAN_AGENT_SERVICE_SESSION": "1", "LEAN_AGENT_SESSION_ROLE": "thread",
                                  "LEAN_AGENT_THREAD": self.tid, "LEAN_AGENT_TRANSCRIPT_STUB": "1"}, timeout=20).stdout.strip()
        return json.loads(out)["hookSpecificOutput"] if out else None


class IdleDelivery(Base):
    def test_idle_session_is_delivered_by_the_next_tick(self):
        self.idle()
        ss.spool_add(self.tid, "hello")
        calls = []
        d = ss.SpoolDeliverer(run=lambda t: calls.append(t) or (True, ""))
        with mock.patch.object(lean_threads, "session_refusal", return_value=""):
            for th in d.tick():
                th.join(5)
        self.assertEqual(calls, [self.tid])

    def test_idle_without_end_marker_is_not_mid_turn_for_ever(self):
        self.add(None, [{"type": "text", "text": "done"}])  # no stop_reason, no turn_duration record
        self.age(1)
        self.assertTrue(ss.mid_turn(self.tid))
        self.age(60)
        self.assertFalse(ss.mid_turn(self.tid))

    def test_pending_tool_call_stays_mid_turn(self):
        self.in_tool()
        self.age(600)
        self.assertTrue(ss.mid_turn(self.tid))


class MidTurnDelivery(Base):
    def test_post_and_pre_tool_use_deliver(self):
        for args, event in (((), "PostToolUse"), (("pre",), "PreToolUse")):
            self.in_tool()
            ss.spool_add(self.tid, "later text " + event)
            out = self.hook(*args)
            self.assertEqual(out["hookEventName"], event)
            self.assertIn("later text " + event, out["additionalContext"])
            self.assertFalse(ss.spool_pending(self.tid))
            self.assertIsNone(self.hook(*args))  # once

    def test_pre_hook_is_registered(self):
        with open(os.path.join(ROOT, "..", "hooks", "hooks.json")) as fh:
            pre = json.load(fh)["hooks"]["PreToolUse"]
        self.assertTrue(any("inject_hook.py pre" in h["command"] for e in pre for h in e["hooks"]))

    def test_bare_wake_marker_does_not_stay_queued_at_a_boundary(self):
        ss.spool_add(self.tid, None)
        self.in_tool()
        self.assertIsNone(self.hook())
        self.assertFalse(ss.spool_pending(self.tid))


class Reason(Base):
    def test_reasons(self):
        ss.spool_add(self.tid, "x")
        self.idle()
        self.assertIn("idle", ss.delivery_reason(self.tid))
        self.in_tool("make build")
        self.assertIn("next tool call", ss.delivery_reason(self.tid))
        self.age(12 * 60)
        r = ss.delivery_reason(self.tid)
        self.assertIn("busy in one tool call for 12 min", r)
        self.assertIn("make build", r)
        with mock.patch.object(ss, "alive_thread", lambda t: False):
            self.assertIn("not running", ss.delivery_reason(self.tid))

    def test_now_row_shows_the_reason(self):
        ss.spool_add(self.tid, "x")
        self.in_tool("make build")
        self.age(700)
        with mock.patch.object(lean_threads, "undelivered_age", return_value=700.0):
            self.assertIn("busy in one tool call", lean_threads.undelivered_reason(self.tid))

    def test_nothing_queued_no_reason(self):
        self.assertEqual(ss.delivery_reason(self.tid), "")


class Wake(Base):
    def wake(self):
        a = types.SimpleNamespace(action="wake", args=[self.tid], json=False, prompt_file=None, prompt_text=None, resume_old=False)
        out = io.StringIO()
        with contextlib.redirect_stdout(out), \
                mock.patch.object(lean_agent, "thread_session_tid", return_value=(self.tid, {})), \
                mock.patch.object(lean_agent.service_session, "_socket_listening", return_value=True), \
                mock.patch.object(lean_agent, "queue_and_deliver", side_effect=lambda *x, **k: self.q(*x)):
            lean_agent.thread_action(a)
        return out.getvalue().strip()

    def q(self, tid, prompt, resume_old=False):
        return f"{tid}: queued"

    def test_wake_idle_says_nothing_extra_when_delivered(self):
        self.idle()
        self.assertEqual(self.wake(), "t1: queued")  # nothing left in the spool

    def test_wake_mid_turn_says_what_it_waits_on(self):
        ss.spool_add(self.tid, "x")
        self.in_tool("make build")
        self.age(300)
        out = self.wake()
        self.assertIn("t1:", out)
        self.assertIn("next tool call", out)

    def test_wake_dead_session_never_silent(self):
        ss.spool_add(self.tid, "x")
        with mock.patch.object(ss, "alive_thread", lambda t: False):
            self.assertIn("restart pending", self.wake())


class RunReports(Base):
    def queue(self, text, ts=None):
        with open(ss.reports_path(), "w") as fh:
            json.dump({"items": [{"thread": "t1", "kind": ss.RUN_AUTO_KIND, "text": t, "ts": ts or time.time(), "id": i + 1}
                                 for i, t in enumerate(text)]}, fh)

    def test_duplicate_run_lines_collapse(self):
        self.queue(["run r1: done (details: x)", "run r1: done · again (details: x)"])
        fresh, _ = ss.take_reports()
        self.assertEqual(len(fresh), 1)

    def test_stale_after_the_thread_reported(self):
        self.queue(["run r2: done (details: x)"], ts=time.time() - 100)
        with open(ss.reported_path(), "w") as fh:
            json.dump({"t1": time.time()}, fh)
        fresh, _ = ss.take_reports()
        self.assertEqual(fresh, [])

    def test_fresh_run_line_kept(self):
        self.queue(["run r3: done (details: x)"])
        fresh, _ = ss.take_reports()
        self.assertEqual(len(fresh), 1)


if __name__ == "__main__":
    unittest.main()
