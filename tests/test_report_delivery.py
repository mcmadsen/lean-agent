"""Thread report delivery to main: idle, busy, chatty, fresh, staged-but-untaken; FINAL not held; Reporter supervised."""
import json
import os
import sys
import tempfile
import threading
import unittest
from unittest import mock

from _env import clean_environ

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)

import service_session as ss  # noqa: E402

MIN = 60


class Host:
    key = "main"

    def __init__(self):
        self.last_input, self.last_output, self.pasted = 0, 0.0, []
        self.stopping = threading.Event()
        self.up = True

    def alive(self):
        return self.up

    def paste(self, text):
        self.pasted.append(text)

    def tail_text(self):
        return ""


class DeliveryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        env = mock.patch.dict(os.environ, {**clean_environ(), "LEAN_AGENT_HOME": self.tmp,
                                           "LEAN_AGENT_LOG_DIR": os.path.join(self.tmp, "logs")}, clear=True)
        env.start()
        self.addCleanup(env.stop)
        os.makedirs(os.path.join(self.tmp, "chat"))
        self.path = os.path.join(self.tmp, "main.jsonl")
        with open(os.path.join(self.tmp, "chat", "service.json"), "w") as fh:
            json.dump({"session_id": "s1", "transcript_path": self.path, "ts": 1}, fh)
        self.clock = [__import__("time").time()]
        self.host = Host()
        self.rep = ss.Reporter(self.host, now=lambda: self.clock[0])
        self.idle()

    def add(self, rec):
        with open(self.path, "a") as fh:
            fh.write(json.dumps(rec) + "\n")

    def idle(self):
        self.add({"type": "assistant", "message": {"role": "assistant", "stop_reason": "end_turn",
                                                   "content": [{"type": "text", "text": "ok"}]}})

    def busy(self):
        self.add({"type": "assistant", "message": {"role": "assistant", "stop_reason": "tool_use",
                                                   "content": [{"type": "tool_use", "id": "x", "name": "Bash", "input": {}}]}})

    def advance(self, sec, step=10, busy=False):
        for _ in range(int(sec // step)):
            self.clock[0] += step
            if busy:
                self.busy()
            self.rep.main_tick()

    def report(self, kind="done", text="thread t5 finished the work"):
        ss.queue_report("t5", kind, text, force=True)

    def states(self):
        return [r["state"] for _, r in ss.report_states("t5")]

    def test_idle_main_gets_report_within_a_minute(self):
        self.report("blocked")
        self.advance(60)
        self.assertEqual(self.states(), ["delivered"])
        self.assertEqual(len(self.host.pasted), 1)

    def test_busy_main_gets_a_typed_line_after_three_minutes(self):
        self.busy()
        self.report()
        self.advance(150, busy=True)
        self.assertEqual(self.states(), ["queued"])
        self.assertIn("main busy", ss.wait_reason(ss.report_states("t5")[0][1], self.clock[0]))
        self.advance(60, busy=True)
        self.assertEqual(self.states(), ["delivered"])
        self.assertTrue(self.host.pasted[0].startswith("lean-agent: 1 thread report"))

    def test_user_chatting_turn_after_turn(self):
        self.report("done")
        for _ in range(12):  # a turn every 20 s: idle only between, never for long
            self.host.last_input = self.clock[0]  # the user types, main works, never idle for long
            self.busy()
            self.advance(20, busy=True)
        self.advance(100, busy=True)
        self.assertEqual(self.states(), ["delivered"])

    def test_fresh_main_without_transcript(self):
        os.remove(self.path)
        self.report("question", "QUESTION q1: which one?")
        self.advance(40)
        self.assertEqual(self.states(), ["delivered"])

    def test_staged_untaken_block_does_not_block_later_reports(self):
        self.report("chase", "t5: first")
        self.advance(80)
        self.assertEqual(len(self.host.pasted), 1)
        self.busy()
        self.report("done", "FINAL results are in")
        self.advance(10, busy=True)
        self.assertEqual(self.states(), ["delivered", "delivered"])  # joined the staged block, not held
        pend = json.load(open(ss.pending_path()))
        self.assertIn("FINAL results", pend["block"])
        self.assertIn("staged for hook", ss.wait_reason(ss.report_states("t5")[-1][1], self.clock[0]))
        self.advance(200, busy=True)  # nobody took it: typed as one line after the busy limit
        self.assertFalse(os.path.exists(ss.pending_path()))
        self.assertNotIn("\n", self.host.pasted[-1])
        self.assertIn("FINAL results", self.host.pasted[-1])

    def test_block_taken_by_hook_then_later_report(self):
        self.report("done", "first result")
        self.advance(10)
        line = self.host.pasted[0]
        self.assertIsNotNone(ss.take_pending(line))
        self.add({"type": "user", "message": {"role": "user", "content": line}, "timestamp": "2026-01-01T00:00:00Z"})
        self.idle()
        self.report("done", "FINAL second result")
        self.advance(10)
        self.assertEqual(self.states(), ["delivered", "delivered"])
        self.assertEqual(len(self.host.pasted), 2)

    def test_final_not_held_for_batch_window(self):
        self.report("done", "FINAL")
        self.advance(10)
        self.assertEqual(len(self.host.pasted), 1)

    def test_attention_nudge_lists_reports_queued_over_five_minutes(self):
        self.report("done")
        now = ss.queued_reports()[0]["ts"]
        ss.report_wait("main busy 6m", now)
        self.assertEqual(ss.attention_items(now + 4 * MIN), [])
        lines = [l for _, l in ss.attention_items(now + 6 * MIN)]
        self.assertTrue(any("report queued 6m" in l for l in lines))


class SupervisorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        env = mock.patch.dict(os.environ, {**clean_environ(), "LEAN_AGENT_HOME": self.tmp,
                                           "LEAN_AGENT_LOG_DIR": os.path.join(self.tmp, "logs")}, clear=True)
        env.start()
        self.addCleanup(env.stop)

    def test_restart_after_a_dead_thread_and_after_a_stall(self):
        host, clock, made = Host(), [100.0], []

        class Dies:
            def __init__(self, h):
                made.append(self)
                self.tick_at = clock[0]
                self.retired = False

            def run(self):
                raise SystemExit("boom")

        sup = ss.ReporterSupervisor(host, make=Dies, now=lambda: clock[0])
        sup.spawn()
        sup.thread.join()
        self.assertEqual(sup.check(), "its thread died")
        self.assertEqual(len(made), 2)
        self.assertTrue(made[0].retired)
        stop = threading.Event()

        class Quiet(Dies):
            def run(self):
                stop.wait(5)

        sup.make = Quiet
        sup.spawn()
        clock[0] += 30
        self.assertIsNone(sup.check())
        clock[0] += 40
        self.assertIn("no tick for 70s", sup.check())
        stop.set()
        log = "".join(open(os.path.join(self.tmp, "logs", f)).read() for f in os.listdir(os.path.join(self.tmp, "logs")))
        self.assertIn("reporter restarted (its thread died)", log)

    def test_tick_exception_is_logged_and_loop_continues(self):
        host = Host()
        rep = ss.Reporter(host)
        calls = []

        def tick():
            calls.append(1)
            if len(calls) == 1:
                raise RuntimeError("bad tick")
            host.stopping.set()

        rep.tick = tick
        with mock.patch.dict(os.environ, {"LEAN_AGENT_CLEAR_POLL": "0"}):
            rep.run()
        self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()
