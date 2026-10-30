#!/usr/bin/env python3
"""Tests for `lean-agent feedback`. Run: python3 tests/test_feedback.py"""
import datetime
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from _env import clean_environ

PLUGIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent")
SCRIPTS = os.path.join(PLUGIN, "scripts")
CLI = os.path.join(SCRIPTS, "lean_agent.py")
sys.path.insert(0, SCRIPTS)
import lean_feedback  # noqa: E402


class FeedbackTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = os.path.join(self.tmp.name, "home")
        self.env = dict(clean_environ(), LEAN_AGENT_HOME=self.home)
        patcher = mock.patch.dict(os.environ, self.env, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def cli(self, *args, **env):
        return subprocess.run([sys.executable, CLI, *args], capture_output=True, text=True, stdin=subprocess.DEVNULL,
                              env=dict(self.env, **env))

    def items(self):
        with open(os.path.join(self.home, "feedback", "feedback.jsonl")) as fh:
            return [json.loads(l) for l in fh]

    def test_add_dedupes_and_counts(self):
        out = self.cli("feedback", "add", "run hangs after the second retry", "--kind", "bug", "--severity", "high",
                       "--repro", "lean-agent run p -- x", LEAN_AGENT_CALLER_THREAD="t3")
        self.assertEqual(out.stdout.strip(), "feedback f1 added", out.stderr)
        self.assertEqual(self.cli("feedback", "add", "run hangs after the second retry!", "--kind", "bug").stdout.strip(),
                         "feedback f1: +1")
        self.assertEqual(self.cli("feedback", "add", "run hangs after the second retry", "--kind", "idea").stdout.strip(),
                         "feedback f2 added")
        it = self.items()
        self.assertEqual((it[0]["count"], it[0]["thread"], it[0]["status"], it[0]["severity"]), (2, "t3", "open", "high"))
        self.assertEqual((it[1]["thread"], it[1]["version"]), ("main", lean_feedback.lean_common.plugin_version()))
        self.cli("feedback", "add", "run hangs after the second retry", "--kind", "bug")
        self.assertEqual(self.items()[0]["count"], 3)
        with mock.patch.object(lean_feedback.lean_common, "plugin_version", return_value="9.9"):
            self.assertEqual(lean_feedback.add("run hangs after the second retry", "bug")[1], True)

    def test_crash_is_captured_without_secrets(self):
        lean_feedback.record_crash(["run", "p", "TOKEN=hunter2", "sk-abcdefghijklmnop1234"], ValueError("boom\nsecond"))
        lean_feedback.record_crash(["run", "p", "TOKEN=hunter2", "sk-abcdefghijklmnop1234"], ValueError("boom\nsecond"))
        (it,) = self.items()
        self.assertEqual((it["kind"], it["count"]), ("bug", 2))
        self.assertIn("ValueError: boom second", it["text"])
        blob = json.dumps(it)
        for secret in ("hunter2", "sk-abcdefghijklmnop1234"):
            self.assertNotIn(secret, blob)
        self.assertIn("lean-agent run p", it["repro"])

    def test_list_filters_done_and_rm(self):
        lean_feedback.add("alpha broke", "bug")
        lean_feedback.add("beta is confusing", "friction")
        lean_feedback.add("gamma flag wanted", "idea")
        self.cli("feedback", "done", "f2")
        out = self.cli("feedback", "list").stdout
        self.assertTrue(out.splitlines()[0].startswith("id | kind"))
        self.assertEqual(len(out.splitlines()), 4)
        self.assertNotIn("beta", self.cli("feedback", "list", "--open").stdout)
        only = self.cli("feedback", "list", "--kind", "idea").stdout
        self.assertIn("gamma", only)
        self.assertNotIn("alpha", only)
        self.assertNotIn("alpha", self.cli("feedback", "list", "--since", "2999-01-01").stdout)
        self.assertIn("alpha", self.cli("feedback", "list", "--since", "2000-01-01").stdout)
        self.cli("feedback", "rm", "f1")
        self.assertEqual([i["id"] for i in self.items()], ["f2", "f3"])
        self.assertNotEqual(self.cli("feedback", "rm", "f9").returncode, 0)

    def test_export_layout_marks_and_suffix(self):
        lean_feedback.add("minor wording", "friction", "low")
        lean_feedback.add("crash in thread new", "bug", "normal", "lean-agent thread new")
        lean_feedback.add("data loss in sync", "bug", "high", "lean-agent sync")
        lean_feedback.add("nice output", "praise")
        out = self.cli("feedback", "export").stdout.strip()
        today = datetime.date.today().isoformat()
        path = os.path.join(self.home, "feedback", f"feedback-{today}.md")
        self.assertEqual(out, f"feedback: {path} (4 items)")
        with open(path) as fh:
            md = fh.read()
        self.assertTrue(md.startswith("# Feedback for lean-agent"))
        self.assertIn("Version: ", md.split("## ")[0])
        self.assertIn(today, md.split("## ")[0])
        self.assertLess(md.index("## Bugs"), md.index("## Friction"))
        self.assertLess(md.index("data loss"), md.index("crash in thread"))
        self.assertIn("```\nlean-agent sync\n```", md)
        self.assertTrue(all(i["status"] == "exported" and i["exported"] == os.path.basename(path) for i in self.items()))
        self.assertEqual(self.cli("feedback", "export").stdout.strip(), "feedback: %s (0 items)" % path.replace(".md", "-2.md"))
        self.assertTrue(self.cli("feedback", "export", "--all").stdout.strip().endswith("-3.md (4 items)"))
        custom = os.path.join(self.tmp.name, "x.md")
        self.assertIn(custom, self.cli("feedback", "export", "--all", "--out", custom).stdout)

    def test_now_line_and_offer_once_a_day(self):
        self.assertNotIn("feedback:", self.cli("now").stdout)
        for text in ("squeeze hides an error line", "thread new wants a title flag", "limits table is too wide",
                     "review asks twice for the same file"):
            lean_feedback.add(text, "friction")
        out = self.cli("now").stdout
        self.assertIn("feedback: 4 open (0 high)", out)
        self.assertNotIn("AskUserQuestion", out)
        self.assertEqual(lean_feedback.offer_due(), 0)
        lean_feedback.add("a crash that stops everything", "bug", "high")
        out = self.cli("now").stdout
        self.assertIn("feedback: 5 open (1 high)", out)
        self.assertIn("AskUserQuestion", out)
        again = self.cli("now").stdout
        self.assertIn("feedback: 5 open (1 high)", again)
        self.assertNotIn("AskUserQuestion", again)
        tomorrow = datetime.date.today() + datetime.timedelta(days=1)
        self.assertEqual(lean_feedback.offer_due(tomorrow), 5)

    def test_hook_allows_it_for_main_and_a_thread(self):
        import budget_hook
        event = lambda cmd: {"tool_name": "Bash", "tool_input": {"command": cmd}}
        for role, extra in (("main", {}), ("thread", {"LEAN_AGENT_CALLER_THREAD": "t1"})):
            with mock.patch.dict(os.environ, dict(extra, LEAN_AGENT_SESSION_ROLE=role)):
                for act in ("add 'x'", "list", "export", "done f1", "rm f1"):
                    cmd = f"lean-agent feedback {act}"
                    self.assertEqual(budget_hook.strict_denial(event(cmd), "/h", "/h"), "", cmd)
                    if role == "main":
                        self.assertEqual(budget_hook.front_desk_denial(event(cmd)), "", cmd)

    def test_guides_contain_the_rules(self):
        with open(os.path.join(PLUGIN, "templates", "guide.md"), encoding="utf-8") as fh:
            guide = fh.read()
        with open(os.path.join(PLUGIN, "templates", "front-desk.md"), encoding="utf-8") as fh:
            desk = fh.read()
        self.assertIn("lean-agent feedback add", guide)
        self.assertIn("concrete repro", guide)
        self.assertIn("don't record problems of the project", guide)
        self.assertIn("lean-agent feedback export", desk)
        self.assertIn("Your call: export N feedback items for lean-agent?", desk)
        self.assertIn("at most once a day", desk)


if __name__ == "__main__":
    unittest.main()
