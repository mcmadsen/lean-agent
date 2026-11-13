"""Tool-boundary delivery (PostToolUse inject hook): thread messages and main's reports as additionalContext, once, never also
typed; answered questions are not re-pushed; thread reports --mine/--tail/--undelivered; thread report --prompt-file -."""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

from _env import clean_environ

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)

import service_session as ss  # noqa: E402
import lean_threads  # noqa: E402
import lean_waiting  # noqa: E402
from test_report_delivery import Host  # noqa: E402


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.env = {**clean_environ(), "LEAN_AGENT_HOME": self.tmp, "LEAN_AGENT_LOG_DIR": os.path.join(self.tmp, "logs")}
        p = mock.patch.dict(os.environ, self.env, clear=True)
        p.start()
        self.addCleanup(p.stop)
        os.makedirs(os.path.join(self.tmp, "chat"))
        self.path = os.path.join(self.tmp, "main.jsonl")
        with open(os.path.join(self.tmp, "chat", "service.json"), "w") as fh:
            json.dump({"session_id": "s1", "transcript_path": self.path, "ts": 1}, fh)
        self.clock = [time.time()]
        self.host = Host()
        self.rep = ss.Reporter(self.host, now=lambda: self.clock[0])

    def add(self, stop, content):
        with open(self.path, "a") as fh:
            fh.write(json.dumps({"type": "assistant", "message": {"role": "assistant", "stop_reason": stop, "content": content}}) + "\n")

    def idle(self):
        self.add("end_turn", [{"type": "text", "text": "ok"}])

    def busy(self):
        self.add("tool_use", [{"type": "tool_use", "id": "x", "name": "Bash", "input": {}}])

    def advance(self, sec, step=10, busy=False):
        for _ in range(int(sec // step)):
            self.clock[0] += step
            if busy:
                self.busy()
            self.rep.main_tick()

    def hook(self, **env):
        """Run inject_hook.py as Claude Code does; returns the additionalContext or None."""
        out = subprocess.run([sys.executable, os.path.join(ROOT, "inject_hook.py")], input="{}", capture_output=True, text=True,
                             env={**self.env, "LEAN_AGENT_SERVICE_SESSION": "1", **env}, timeout=20).stdout.strip()
        return json.loads(out)["hookSpecificOutput"]["additionalContext"] if out else None


class ThreadInjection(Base):
    def test_mid_turn_thread_gets_message_once_via_context_never_typed(self):
        ss.spool_add("t3", "decision: go with plan B")
        env = {"LEAN_AGENT_SESSION_ROLE": "thread", "LEAN_AGENT_THREAD": "t3"}
        ctx = self.hook(**env)
        self.assertTrue(ctx.startswith(ss.HOOK_HEADER_THREAD))
        self.assertIn("decision: go with plan B", ctx)
        self.assertEqual(ss.spool_count("t3"), 0)  # nothing left for the spool deliverer to type
        self.assertIsNone(self.hook(**env))
        self.assertEqual(ss.SpoolDeliverer(run=lambda t: (_ for _ in ()).throw(AssertionError("typed"))).tick(), [])

    def test_hook_is_inert_outside_the_service_session(self):
        ss.spool_add("t3", "x")
        out = subprocess.run([sys.executable, os.path.join(ROOT, "inject_hook.py")], input="{}", capture_output=True, text=True,
                             env={**self.env, "LEAN_AGENT_SESSION_ROLE": "thread", "LEAN_AGENT_THREAD": "t3"}).stdout
        self.assertEqual(out.strip(), "")
        self.assertEqual(ss.spool_count("t3"), 1)

    def test_claimed_by_deliverer_is_not_injected(self):
        name = ss.spool_add("t3", "x")
        ss.spool_claim("t3", name)
        self.assertIsNone(ss.inject_thread("t3"))


class MainInjection(Base):
    def report(self, kind="done", text="t5 finished the work"):
        ss.queue_report("t5", kind, text, force=True)

    def test_main_mid_turn_gets_reports_at_tool_boundary_and_never_typed(self):
        self.busy()
        self.report("question", "QUESTION q1: which one?")
        ctx = self.hook()
        self.assertTrue(ctx.startswith(ss.HOOK_HEADER_MAIN))
        self.assertIn("t5", ctx)
        self.assertEqual([r["how"] for _, r in ss.report_states("t5")], ["delivered (tool boundary)"])
        self.assertIsNone(self.hook())
        self.advance(300, busy=True)
        self.idle()
        self.advance(120)
        self.assertEqual(self.host.pasted, [])

    def test_idle_main_is_typed(self):
        self.idle()
        self.report("blocked")
        self.advance(60)
        self.assertEqual(len(self.host.pasted), 1)

    def test_digest_relayed_once_hook_then_typed_fallback(self):
        self.idle()
        self.report("blocked")
        self.advance(60)  # typed line + staged block
        self.assertEqual(len(self.host.pasted), 1)
        self.assertIn("t5", self.hook())  # a tool call takes the staged block first
        self.advance(200)
        self.assertEqual(len(self.host.pasted), 1)  # the 60 s fallback does not type it again
        self.assertIsNone(self.hook())

    def test_digest_relayed_once_typed_fallback_then_hook(self):
        self.idle()
        self.report("blocked")
        self.advance(40)
        self.advance(80)  # the prompt hook never took it: typed in full by the fallback
        n = len(self.host.pasted)
        self.assertGreaterEqual(n, 1)
        self.assertIsNone(self.hook())
        self.advance(100)
        self.assertEqual(len(self.host.pasted), n)

    def test_ledger_claims_an_id_once(self):
        self.assertEqual(ss.ledger_claim(["a", "b"]), ["a", "b"])
        self.assertEqual(ss.ledger_claim(["b", "c"]), ["c"])

    def test_delivered_report_is_not_taken_again(self):
        self.report("done", "all done")
        i = ss.queued_reports()[0]
        ss.ledger_claim([ss.item_key(i)])
        self.assertEqual(ss.take_reports(time.time())[0], [])


class AnsweredQuestions(Base):
    def setUp(self):
        super().setUp()
        self.tid = lean_threads.new("T")
        self.qid = lean_threads.ask(self.tid, "which db?")
        lean_waiting.add("which db?", "question", None, self.tid, qid=self.qid)
        self.wid = lean_waiting.open_items()[0]["id"]

    def pushed(self):
        return ss.repush_questions(time.time() + 10_000, after=1)

    def test_open_question_is_pushed(self):
        self.assertEqual(self.pushed(), [self.tid])

    def test_done_waiting_item_is_not_recreated_nor_pushed(self):
        lean_waiting.done(self.wid, "postgres")  # answered through the waiting list; the thread record still shows it open
        ss.ensure_question_items()
        self.assertEqual(lean_waiting.open_items(), [])
        self.assertEqual(self.pushed(), [])
        self.assertFalse([k for k, _ in ss.attention_items(time.time() + 10_000, after=1) if k.startswith("question:")])

    def test_thread_answer_is_not_pushed(self):
        lean_threads.answer(self.tid, self.qid, "postgres")
        self.assertEqual(self.pushed(), [])
        ss.ensure_question_items()
        self.assertEqual(lean_waiting.open_items()[0]["id"], self.wid)  # nothing new


class ReportsCli(Base):
    def cli(self, *args, stdin=None):
        env = {**self.env, "LEAN_AGENT_SESSION_ROLE": "thread", "LEAN_AGENT_THREAD": "t1", "LEAN_AGENT_CALLER_THREAD": "t1"}
        return subprocess.run([sys.executable, os.path.join(ROOT, "lean_agent.py"), "thread", *args], input=stdin,
                              capture_output=True, text=True, env=env, timeout=60)

    def seed(self, n=8):
        lean_threads.new("T")
        for k in range(1, n + 1):
            ss.report_state("t1", k, kind="done", text=f"report number {k}")
            if k <= n - 1:
                ss.report_state("t1", k, state="delivered", how="typed")

    def test_mine_defaults_to_last_five_plus_undelivered(self):
        self.seed(8)
        ss.report_state("t1", 2, state="queued")  # an old one still undelivered
        out = self.cli("reports", "--mine").stdout
        for k in (2, 4, 5, 6, 7, 8):
            self.assertIn(f"report number {k}\n", out + "\n")
        self.assertNotIn("report number 1\n", out + "\n")
        self.assertNotIn("report number 3\n", out + "\n")

    def test_tail_and_undelivered(self):
        self.seed(8)
        out = self.cli("reports", "--mine", "--tail", "2").stdout
        self.assertEqual(out.count("t1 r"), 2)
        out = self.cli("reports", "--mine", "--undelivered").stdout
        self.assertIn("report number 8", out)
        self.assertNotIn("report number 7", out)

    def test_report_prompt_file_stdin(self):
        lean_threads.new("T")
        r = self.cli("report", "--prompt-file", "-", stdin="finished: all green\n")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("queued", r.stdout)
        r = self.cli("report", "-F", "-", stdin="second one")
        self.assertEqual(r.returncode, 0, r.stderr)


if __name__ == "__main__":
    unittest.main()
