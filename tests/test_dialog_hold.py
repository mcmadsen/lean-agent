"""An open AskUserQuestion dialog holds thread-report / message deliveries back (a notification must never become the
dialog's answer); the PostToolUse safety net tells the model when an answer was one of lean-agent's own notifications."""
import json
import os
import subprocess
import sys
import time
import unittest
import unittest.mock

from _env import clean_environ  # noqa: F401
from test_tool_boundary import Base, ROOT
import service_session as ss  # noqa: E402
import lean_sock  # noqa: E402

THREAD_ENV = {"LEAN_AGENT_SESSION_ROLE": "thread", "LEAN_AGENT_THREAD": "t3"}


class Hold(Base):
    def report(self, kind="done", text="t5 finished the work"):
        ss.queue_report("t5", kind, text, force=True)

    def test_main_dialog_open_queues_then_delivers_once_merged(self):
        self.idle()
        ss.dialog_set("main", True, now=self.clock[0])
        self.report("done", "t5 finished the work")
        self.report("question", "QUESTION q1: which one?")
        self.advance(120)
        self.assertEqual(self.host.pasted, [])  # typed path waits
        self.busy()
        self.assertIsNone(self.hook())  # tool-boundary path waits too
        self.assertEqual(len(ss.queued_reports()), 2)
        ss.dialog_set("main", False)
        self.idle()
        self.advance(60)
        self.assertEqual(len(self.host.pasted), 1)  # one merged line, in order
        self.assertIn("2 thread reports", self.host.pasted[0])
        self.assertEqual(ss.queued_reports(), [])
        self.advance(120)  # (the staged block may be typed in full once by the existing fallback: never a second summary)
        self.assertEqual(sum("thread reports (" in p for p in self.host.pasted), 1)  # once

    def test_close_releases_tool_boundary_delivery(self):
        self.busy()
        ss.dialog_set("main", True)
        self.report()
        self.assertIsNone(self.hook())
        ss.dialog_set("main", False)
        self.assertTrue(self.hook().startswith(ss.HOOK_HEADER_MAIN))

    def test_hold_expires_after_30_minutes(self):
        t0 = self.clock[0]
        ss.dialog_set("main", True, now=t0)
        self.assertTrue(ss.dialog_held("main", now=t0 + ss.DIALOG_HOLD_MAX - 1))
        self.assertFalse(ss.dialog_held("main", now=t0 + ss.DIALOG_HOLD_MAX + 1))
        self.assertEqual(ss.DIALOG_HOLD_MAX, 1800)
        self.idle()
        self.report()
        self.advance(1700)  # still held (fake clock)
        self.assertEqual(self.host.pasted, [])
        ss.dialog_set("main", True, now=t0)  # the mark is as old as the first one
        self.clock[0] = t0 + 1900
        self.idle()
        self.rep.idle_at = 0
        self.advance(60)
        self.assertEqual(len(self.host.pasted), 1)

    def test_restart_clears_the_hold(self):
        ss.dialog_set("main", True)
        ss.dialog_set("t3", True)
        ss.dialog_clear_all()
        self.assertFalse(ss.dialog_held("main"))
        self.assertFalse(ss.dialog_held("t3"))

    def test_thread_dialog_holds_spool_and_tool_boundary(self):
        ss.dialog_set("t3", True)
        ss.spool_add("t3", "decision: go with plan B")
        self.assertIsNone(self.hook(**THREAD_ENV))
        self.assertEqual(ss.spool_count("t3"), 1)
        self.assertFalse(ss.dialog_held("main"))  # other sessions are not held
        ss.dialog_set("t3", False)
        self.assertIn("plan B", self.hook(**THREAD_ENV))

    def test_spool_deliverer_skips_a_held_thread(self):
        ss.spool_add("t3", "hello")
        ran = []
        d = ss.SpoolDeliverer(run=lambda tid: ran.append(tid) or (True, ""), now=lambda: self.clock[0])
        ss.dialog_set("t3", True, now=self.clock[0])
        with unittest.mock.patch.object(ss.lean_threads, "session_refusal", return_value=""), \
                unittest.mock.patch.object(ss, "mid_turn", return_value=False), \
                unittest.mock.patch.object(ss, "alive_thread", return_value=True):
            for t in d.tick():
                t.join()
            self.assertEqual(ran, [])
            ss.dialog_set("t3", False)
            for t in d.tick():
                t.join()
        self.assertEqual(ran, ["t3"])


class HookPath(Base):
    def run_hook(self, mode, event=None, **env):
        t0 = time.time()
        r = subprocess.run([sys.executable, os.path.join(ROOT, "dialog_hook.py"), mode], input=json.dumps(event or {}),
                           capture_output=True, text=True, env={**self.env, "LEAN_AGENT_SERVICE_SESSION": "1", **env}, timeout=20)
        return r, time.time() - t0

    def test_service_down_returns_fast_and_silent(self):
        for mode in ("pre", "close"):
            r, took = self.run_hook(mode)
            self.assertEqual((r.returncode, r.stdout), (0, ""))
            self.assertLess(took, 2.0)
        t0 = time.monotonic()
        self.assertFalse(lean_sock.call_nowait("dialog", state="open"))
        self.assertLess(time.monotonic() - t0, 0.2)

    def test_inert_outside_service_session(self):
        r = subprocess.run([sys.executable, os.path.join(ROOT, "dialog_hook.py"), "post"],
                           input=json.dumps({"tool_response": "lean-agent: 2 thread reports (t1 done) [r1a2b3c]"}),
                           capture_output=True, text=True, env=self.env, timeout=20)
        self.assertEqual(r.stdout, "")

    def test_notification_shaped_answer_asks_again(self):
        line = "lean-agent: 3 thread reports (t18 done, t21 question) [r1a2b3c]"
        ev = {"tool_name": "AskUserQuestion", "tool_response": f'User has answered your questions: "Pick one"="{line}".'}
        r, _ = self.run_hook("post", ev)
        ctx = json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("not the user's choice", ctx)
        self.assertIn("Ask the question again", ctx)
        self.assertIn(line, ctx)

    def test_digest_line_and_report_id_are_notifications_too(self):
        for text in ("lean-agent thread reports [r1a2b3c]: [t5] done (details: lean-agent thread reports)", "foo [rabcdef]"):
            r, _ = self.run_hook("post", {"tool_response": {"answers": {"q": text}}})
            self.assertIn("not the user's choice", r.stdout)

    def test_real_answer_adds_nothing(self):
        ev = {"tool_response": 'User has answered your questions: "Pick one"="Approve with suggestions".'}
        r, _ = self.run_hook("post", ev)
        self.assertEqual((r.returncode, r.stdout), (0, ""))

    def test_notification_is_not_an_answer_for_waiting_items(self):
        import budget_hook
        tp = os.path.join(self.tmp, "t.jsonl")
        recs = [{"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "a1", "name": "AskUserQuestion",
                                                              "input": {"questions": [{"question": "Pick?"}]}}]}},
                {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "a1",
                                                          "content": "lean-agent: 1 thread report (t1 done) [r1a2b3c]"}]}}]
        with open(tp, "w") as fh:
            fh.write("\n".join(json.dumps(r) for r in recs))
        self.assertEqual(budget_hook.ask_answers(tp), (["Pick?"], None))


class ServiceOp(Base):
    def test_dialog_op_sets_and_clears_the_hold(self):
        import lean_agent
        deliverer = ss.SpoolDeliverer()
        h = lean_agent.sock_handlers(deliverer, None)["dialog"]
        self.assertEqual(h({"state": "open", "thread": "t3"}), {"ok": True})
        self.assertTrue(ss.dialog_held("t3"))
        h({"state": "open"})
        self.assertTrue(ss.dialog_held("main"))
        h({"state": "closed"})
        self.assertFalse(ss.dialog_held("main"))
        self.assertTrue(ss.dialog_held("t3"))


if __name__ == "__main__":
    import unittest.mock  # noqa: F401
    unittest.main()
