"""Stuck-session detection: nudge, then restart, with a fake clock and a fake host."""
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

from _env import clean_environ

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)

import service_session as ss  # noqa: E402

MIN = 60


class FakeHost:
    def __init__(self, key):
        self.key = key
        self.events = []

    def write(self, data):
        self.events.append(("write", data))

    def paste(self, text):
        self.events.append(("paste", text))

    def terminate_for(self, reason):
        self.events.append(("terminate", reason))


class StuckTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        env = mock.patch.dict(os.environ, {**clean_environ(), "LEAN_AGENT_HOME": self.tmp}, clear=True)
        env.start()
        self.addCleanup(env.stop)
        self.now = [100000.0]
        self.path = os.path.join(self.tmp, "t.jsonl")
        self.write_record({"type": "user", "message": {"role": "user", "content": "are you there?"}, "timestamp": "2026-01-01T00:00:00Z"})
        self.t0 = self.now[0]

    def write_record(self, rec):
        with open(self.path, "a") as fh:
            fh.write(json.dumps(rec) + "\n")

    def watch(self, key="t1", workers=()):
        host = FakeHost(key)
        return host, ss.StuckWatch(host, now=lambda: self.now[0], sleep=lambda s: None, workers=lambda k: list(workers))

    def tick(self, w, **kw):
        st = ss.transcript_state(self.path)
        return w.tick(self.path, st, mtime=self.t0, **kw)

    def test_quiet_turn_is_nudged_then_restarted_and_logged(self):
        host, w = self.watch("t21")
        self.now[0] = self.t0 + 5 * MIN
        self.assertIsNone(self.tick(w))
        self.now[0] = self.t0 + 12 * MIN
        self.assertEqual(self.tick(w), "nudge")
        self.assertEqual(host.events[0], ("write", b"\x1b"))
        self.assertEqual(host.events[1][0], "paste")
        self.assertIn("stalled", host.events[1][1])
        self.assertEqual(ss.session_rec("t21")["stuck"], "nudged after 12m stall")
        self.now[0] += 5 * MIN
        self.assertIsNone(self.tick(w))  # one more limit must pass first
        self.now[0] += 6 * MIN
        self.assertEqual(self.tick(w), "restart")
        self.assertEqual(host.events[-1], ("terminate", "stalled"))
        self.assertIn("restarted after", ss.session_rec("t21")["stuck"])
        self.assertTrue(any("t21: restarted" in i["text"] for i in ss.queued_reports()))
        with open(os.path.join(self.tmp, "logs", os.listdir(os.path.join(self.tmp, "logs"))[0])) as fh:
            self.assertIn("t21: nudged after 12m stall", fh.read())

    def test_progress_after_the_nudge_ends_the_stall(self):
        host, w = self.watch()
        self.now[0] = self.t0 + 11 * MIN
        self.assertEqual(self.tick(w), "nudge")
        self.write_record({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "back"}],
                                                            "stop_reason": "end_turn"}})
        self.now[0] += 30 * MIN
        self.assertIsNone(self.tick(w))
        self.assertEqual(w.stage, 0)

    def test_workers_a_prompt_or_a_long_tool_are_not_a_stall(self):
        host, w = self.watch(workers=["r1"])
        self.now[0] = self.t0 + 60 * MIN
        self.assertIsNone(self.tick(w))
        host, w = self.watch()
        self.assertIsNone(self.tick(w, prompting=True))
        self.write_record({"type": "assistant", "message": {"role": "assistant", "content": [
            {"type": "tool_use", "id": "x1", "name": "Bash", "input": {"command": "lean-agent runs --wait r9"}}]}})
        self.assertIsNone(self.tick(w))
        self.assertEqual(host.events, [])

    def test_a_finished_turn_is_never_stuck(self):
        self.write_record({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "hi"}],
                                                            "stop_reason": "end_turn"}})
        host, w = self.watch()
        self.now[0] = self.t0 + 99 * MIN
        self.assertIsNone(self.tick(w))

    def test_main_user_message_without_a_reply_is_nudged_with_the_main_text(self):
        host, w = self.watch("main")
        self.now[0] = self.t0 + 11 * MIN
        self.assertEqual(self.tick(w), "nudge")
        self.assertIn("user's last message", host.events[1][1])

    def test_the_limit_is_configurable_and_can_be_off(self):
        with mock.patch.dict(os.environ, {"LEAN_AGENT_SESSION_STUCK": "2"}):
            host, w = self.watch()
            self.now[0] = self.t0 + 3 * MIN
            self.assertEqual(self.tick(w), "nudge")
        with mock.patch.dict(os.environ, {"LEAN_AGENT_SESSION_STUCK": "off"}):
            host, w = self.watch()
            self.now[0] = self.t0 + 300 * MIN
            self.assertIsNone(self.tick(w))

    def test_main_reports_queued_too_long_are_redelivered(self):
        host = FakeHost("main")
        rep = ss.Reporter.__new__(ss.Reporter)
        ss.queue_report("t3", "done", "finished")
        items = ss.queued_reports()
        self.assertEqual(len(items), 1)
        rep.now = lambda: items[0]["ts"] + 11 * MIN
        rep.redelivered, rep.delivered = 0.0, (1, 2)
        rep.log = lambda *a, **k: None
        rep.goals_tick = lambda: None
        with mock.patch.object(ss, "run_fallback"):
            with open(ss.pending_path(), "w") as fh:
                fh.write("x")
            host.alive = lambda: False  # main_tick stops right after the redelivery reset
            rep.host = host
            rep.main_tick()
        self.assertIsNone(rep.delivered)
        self.assertFalse(os.path.exists(ss.pending_path()))


if __name__ == "__main__":
    unittest.main()
