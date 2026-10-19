#!/usr/bin/env python3
"""Smoke tests for the lean-agent hooks. Run: python3 tests/test_hooks.py"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")


def run_hook(script, event, **env):
    full_env = dict(os.environ, **env)
    p = subprocess.run(
        [sys.executable, os.path.join(ROOT, script)],
        input=json.dumps(event), capture_output=True, text=True, env=full_env, check=True,
    )
    return json.loads(p.stdout) if p.stdout.strip() else None


def assistant_line(mid, inp, cw, cr, out, model="claude-test"):
    return json.dumps({"type": "assistant", "message": {"id": mid, "model": model, "usage": {
        "input_tokens": inp, "cache_creation_input_tokens": cw,
        "cache_read_input_tokens": cr, "output_tokens": out}}}) + "\n"


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = {"CLAUDE_PLUGIN_DATA": os.path.join(self.tmp.name, "data")}

    def tearDown(self):
        self.tmp.cleanup()


class SqueezeTest(Base):
    def event(self, stdout, stderr="", command="npm test"):
        return {"tool_name": "Bash", "tool_use_id": "toolu_x", "tool_input": {"command": command},
                "tool_response": {"stdout": stdout, "stderr": stderr, "interrupted": False, "isImage": False}}

    def test_small_output_untouched(self):
        self.assertIsNone(run_hook("squeeze_hook.py", self.event("ok\n"), **self.env))

    def test_large_output_squeezed_keeps_errors(self):
        lines = [f"PASS test_{i}" for i in range(3000)]
        lines[1500] = "FAIL test_1500: AssertionError: expected 1 got 2"
        out = run_hook("squeeze_hook.py", self.event("\n".join(lines)), **self.env)
        upd = out["hookSpecificOutput"]["updatedToolOutput"]
        self.assertIn("AssertionError", upd["stdout"])
        self.assertIn("PASS test_2999", upd["stdout"])
        self.assertLess(len(upd["stdout"]), 6000)
        self.assertFalse(upd["interrupted"])
        path = upd["stdout"].split("Full output: ")[1].split(" ")[0]
        with open(path) as fh:
            self.assertEqual(fh.read().count("PASS"), 2999)

    def test_repeats_collapsed(self):
        out = run_hook("squeeze_hook.py", self.event("downloading...\n" * 5000 + "done"), **self.env)
        self.assertIn("[repeated 5000x]", out["hookSpecificOutput"]["updatedToolOutput"]["stdout"])

    def test_reads_are_never_squeezed(self):
        big = "line\n" * 5000
        for cmd in ("cat src/app.py", "cd /repo && sed -n '1,400p' a.py", "git -C /repo show origin/develop:a.py",
                    "git grep -n foo", "FOO=1 rg -n bar src | head -300"):
            self.assertIsNone(run_hook("squeeze_hook.py", self.event(big, command=cmd), **self.env), cmd)
        self.assertIsNotNone(run_hook("squeeze_hook.py", self.event(big, command="npm test"), **self.env))
        self.assertIsNotNone(run_hook("squeeze_hook.py", self.event(big, command="git push"), **self.env))

    def test_opt_out(self):
        big = "x\n" * 10000
        self.assertIsNone(run_hook("squeeze_hook.py", self.event(big, command="LEAN_RAW=1 cat f"), **self.env))
        self.assertIsNone(run_hook("squeeze_hook.py", self.event(big), LEAN_AGENT_SQUEEZE="0", **self.env))


class BudgetTest(Base):
    def setUp(self):
        super().setUp()
        self.transcript = os.path.join(self.tmp.name, "s1.jsonl")
        sub = os.path.join(self.tmp.name, "s1", "subagents")
        os.makedirs(sub)
        with open(self.transcript, "w") as fh:
            # Same message id twice (one line per content block) must count once.
            fh.write(assistant_line("m1", 100, 1000, 10000, 200))
            fh.write(assistant_line("m1", 100, 1000, 10000, 200))
            fh.write(json.dumps({"type": "user", "message": {"content": "hi"}}) + "\n")
        with open(os.path.join(sub, "agent-a.jsonl"), "w") as fh:
            fh.write(assistant_line("m2", 50, 0, 0, 10, model="claude-small"))
        # weighted: 100 + 1250 + 1000 + 1000 = 3350 ; subagent: 50 + 50 = 100 -> 3450
        self.ev = {"session_id": "s1", "transcript_path": self.transcript, "tool_name": "Read"}

    def test_no_budget_tracks_only(self):
        self.assertIsNone(run_hook("budget_hook.py", self.ev, **self.env))

    def test_warn_once_then_deny(self):
        out = run_hook("budget_hook.py", self.ev, LEAN_AGENT_BUDGET="4000", **self.env)
        self.assertIn("86%", out["hookSpecificOutput"]["additionalContext"])
        self.assertIsNone(run_hook("budget_hook.py", self.ev, LEAN_AGENT_BUDGET="4000", **self.env))
        with open(self.transcript, "a") as fh:
            fh.write(assistant_line("m3", 1000, 0, 0, 0))
        out = run_hook("budget_hook.py", self.ev, LEAN_AGENT_BUDGET="4000", **self.env)
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertIn("4,450", out["hookSpecificOutput"]["permissionDecisionReason"])

    def test_report(self):
        p = subprocess.run([sys.executable, os.path.join(ROOT, "usage.py"), "report", self.transcript],
                           capture_output=True, text=True, env=dict(os.environ, **self.env), check=True)
        self.assertIn("3,450", p.stdout)
        self.assertIn("Calls:   2 API calls · first call context 11,100 tokens", p.stdout)
        self.assertIn("claude-small", p.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
