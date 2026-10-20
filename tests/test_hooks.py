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
        self.env = {"CLAUDE_PLUGIN_DATA": os.path.join(self.tmp.name, "data"),
                    "LEAN_AGENT_HOME": os.path.join(self.tmp.name, "home"), "LEAN_AGENT_CTX_NUDGE": "0"}

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
        self.assertIn("[dropped noise: 2,999 passing test lines]", upd["stdout"])
        self.assertLess(len(upd["stdout"]), 6000)
        self.assertFalse(upd["interrupted"])
        path = upd["stdout"].split("Full output: ")[1].split(" ")[0]
        with open(path) as fh:
            self.assertEqual(fh.read().count("PASS"), 2999)

    def test_real_error_survives_a_flood_of_warnings(self):
        lines = ["Downloading package %d" % i for i in range(2000)]
        lines += ["src/mod%d.ts:%d warning: unused variable 'x%d' (no-unused)" % (i % 7, i, i) for i in range(1500)]
        lines += ["error TS2322: Type 'string' is not assignable to type 'number'.",
                  "  at src/checkout/total.ts:42:7", "  at src/checkout/index.ts:10:3"]
        lines += ["compiled with %d warnings" % 1500, "Found 1 error. Exit code 2"]
        out = run_hook("squeeze_hook.py", self.event("\n".join(lines)), **self.env)
        txt = out["hookSpecificOutput"]["updatedToolOutput"]["stdout"]
        self.assertIn("TS2322", txt)
        self.assertIn("at src/checkout/total.ts:42:7", txt)  # the stack trace stays with its error
        self.assertIn("Found 1 error", txt)
        self.assertIn("2,000 download lines", txt)
        self.assertLess(txt.count("unused variable"), 5)  # one copy per kind of warning
        err = txt.split("errors and warnings only (")[1].split(": ", 1)[1].split(" ")[0]
        with open(err) as fh:
            self.assertIn("TS2322", fh.read())
        logs = os.path.join(self.env["LEAN_AGENT_HOME"], "logs")
        with open(os.path.join(logs, "error.log")) as fh:
            self.assertIn("TS2322", fh.read())
        with open(os.path.join(logs, "debug.log")) as fh:
            self.assertIn("squeeze", fh.read())

    def test_first_and_last_errors_kept_repeats_counted(self):
        body = ["step %d done" % i for i in range(4000)]
        body[100] = "ERROR: connection refused to db (attempt 1)"
        for i in range(200, 3000, 50):
            body[i] = "ERROR: connection refused to db (attempt %d)" % i
        body[3900] = "FATAL: migration 0042 failed: column missing"
        txt = run_hook("squeeze_hook.py", self.event("\n".join(body)), **self.env)[
            "hookSpecificOutput"]["updatedToolOutput"]["stdout"]
        self.assertIn("migration 0042 failed", txt)
        self.assertIn("(attempt 1)", txt)
        self.assertIn("[same error", txt)

    def test_lean_sq_wrapper(self):
        script = os.path.join(self.tmp.name, "build.py")
        with open(script, "w") as fh:
            fh.write("import sys\nfor i in range(3000): print('Downloading dep %d' % i)\n"
                     "print('Traceback (most recent call last):')\nprint('  File \"app.py\", line 3')\n"
                     "print('ValueError: bad config')\nsys.exit(3)\n")
        sq = os.path.join(ROOT, "..", "bin", "lean-sq")
        p = subprocess.run([sq, sys.executable, script], capture_output=True, text=True, env=dict(os.environ, **self.env))
        self.assertEqual(p.returncode, 3)
        self.assertIn("ValueError: bad config", p.stdout)
        self.assertIn('File "app.py", line 3', p.stdout)
        self.assertIn("3,000 download lines", p.stdout)
        self.assertIn("[exit code 3]", p.stdout)
        self.assertLess(len(p.stdout), 2000)
        p = subprocess.run([sq, "echo small"], capture_output=True, text=True, env=dict(os.environ, **self.env))
        self.assertEqual((p.returncode, p.stdout), (0, "small\n"))

    def test_worker_answer_never_squeezed(self):
        log = "\n".join("Downloading dep %d" % i for i in range(3000))
        answer = "run 1019-140000-abcd · sonnet · done · 5 turns\n" + "\n".join(
            f"claim {i}: verdict {'true' if i % 2 else 'false'} because of reason number {i}" for i in range(150))
        out = run_hook("squeeze_hook.py", self.event(log + "\n" + answer, command="bash run-checks.sh"), **self.env)
        txt = out["hookSpecificOutput"]["updatedToolOutput"]["stdout"]
        self.assertIn("claim 77: verdict true", txt)
        self.assertTrue(txt.endswith(answer))
        self.assertIsNone(run_hook("squeeze_hook.py", self.event(answer * 3, command="python3 x/lean_agent.py run"),
                                   **self.env))

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


class CompactTest(Base):
    def test_only_in_lean_home(self):
        home = self.env["LEAN_AGENT_HOME"]
        os.makedirs(home, exist_ok=True)
        p = subprocess.run([sys.executable, os.path.join(ROOT, "compact_hook.py"), "pre"], capture_output=True,
                           text=True, input=json.dumps({"cwd": self.tmp.name}), env=dict(os.environ, **self.env))
        self.assertEqual(p.stdout, "")  # the user's other sessions compact as usual
        p = subprocess.run([sys.executable, os.path.join(ROOT, "compact_hook.py"), "pre"], capture_output=True,
                           text=True, input=json.dumps({"cwd": home}), env=dict(os.environ, **self.env))
        self.assertIn("every approval the user gave for an outward action", p.stdout)

    def test_digest_after_compaction(self):
        home = self.env["LEAN_AGENT_HOME"]
        os.makedirs(os.path.join(home, "reviews"), exist_ok=True)
        with open(os.path.join(home, "ledger.jsonl"), "w") as fh:
            fh.write(json.dumps({"id": "1020-1", "status": "done", "model": "haiku", "project": "shop",
                                 "task": "list the checkout tests"}) + "\n")
        with open(os.path.join(home, "reviews", "shop.jsonl"), "w") as fh:
            fh.write(json.dumps({"ref": "feature-x", "head": "abc123def456", "verdict": "changes-requested",
                                 "findings": [{"severity": "major"}]}) + "\n")
        p = subprocess.run([sys.executable, os.path.join(ROOT, "compact_hook.py"), "post"], capture_output=True,
                           text=True, input=json.dumps({"cwd": home, "source": "compact"}), env=dict(os.environ, **self.env))
        ctx = json.loads(p.stdout)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("- 1020-1 done haiku shop: list the checkout tests", ctx)
        self.assertIn("shop feature-x @ abc123def4 changes-requested (1 blocking)", ctx)


class McpTrimTest(Base):
    def event(self, payload):
        return {"tool_name": "mcp__tracker__get_items", "tool_response": [{"type": "text", "text": json.dumps(payload)}]}

    def test_trims_big_results_and_keeps_fields(self):
        items = [{"id": i, "title": f"T{i}", "state": "Active", "_links": {"self": {"href": "https://x"}},
                  "assignedTo": {"displayName": "Pat", "imageUrl": "u"}, "description": "x" * 300} for i in range(30)]
        out = run_hook("mcp_trim_hook.py", self.event({"count": 30, "value": items}),
                       LEAN_AGENT_MCP_FIELDS="title,state", **self.env)
        blocks = out["hookSpecificOutput"]["updatedToolOutput"]
        self.assertIn("[lean-agent: trimmed", blocks[0]["text"])
        data = json.loads(blocks[1]["text"])
        self.assertEqual(data["count"], 30)
        self.assertEqual(data["value"][3], {"title": "T3", "state": "Active", "id": 3})
        out = run_hook("mcp_trim_hook.py", self.event({"value": items}), **self.env)  # no fields: noise only
        data = json.loads(out["hookSpecificOutput"]["updatedToolOutput"][1]["text"])
        self.assertNotIn("_links", data["value"][0])
        self.assertEqual(data["value"][0]["assignedTo"], "Pat")
        self.assertIsNone(run_hook("mcp_trim_hook.py", self.event({"value": items[:1]}), **self.env))  # small
        self.assertIsNone(run_hook("mcp_trim_hook.py", dict(self.event({"value": items}), tool_name="Bash"), **self.env))


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
        note = out["hookSpecificOutput"]["additionalContext"]
        self.assertIn("86%", note)
        self.assertIn("spend cap", note)
        self.assertIn("not the context window", note)
        self.assertIn("~11,100 tokens now, which is fine, so no hand-off is needed", note)
        self.assertNotIn("prepare to hand off", note)
        self.assertIsNone(run_hook("budget_hook.py", self.ev, LEAN_AGENT_BUDGET="4000", **self.env))
        with open(self.transcript, "a") as fh:
            fh.write(assistant_line("m3", 1000, 0, 0, 0))
        out = run_hook("budget_hook.py", self.ev, LEAN_AGENT_BUDGET="4000", **self.env)
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertIn("4,450", out["hookSpecificOutput"]["permissionDecisionReason"])

    def test_cap_can_count_only_new_tokens(self):
        # billed 3,450 (cache read 10,000 counts 1,000); new tokens only: 2,450
        out = run_hook("budget_hook.py", self.ev, LEAN_AGENT_BUDGET="3000", LEAN_AGENT_BUDGET_COUNT="new", **self.env)
        self.assertIn("81%", out["hookSpecificOutput"]["additionalContext"])
        self.assertIn("cache re-reads not counted", out["hookSpecificOutput"]["additionalContext"])

    def test_large_context_suggests_fresh_session(self):
        out = run_hook("budget_hook.py", self.ev, LEAN_AGENT_BUDGET="4000", LEAN_AGENT_HANDOFF_CONTEXT="10000",
                       **self.env)
        self.assertIn("suggest a fresh session", out["hookSpecificOutput"]["additionalContext"])

    def test_cap_lifted_live_and_legacy_default_ignored(self):
        with open(self.transcript, "a") as fh:  # 1,003,450 billed: over the old built-in 1,000,000 default
            fh.write(assistant_line("m9", 1000000, 0, 0, 0))
        self.assertIsNone(run_hook("budget_hook.py", self.ev, LEAN_AGENT_BUDGET="1000000", **self.env))
        out = run_hook("budget_hook.py", self.ev, LEAN_AGENT_BUDGET="1000000", LEAN_AGENT_BUDGET_SET="1", **self.env)
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertIn("lean-agent budget --cap off", out["hookSpecificOutput"]["permissionDecisionReason"])
        home = self.env["LEAN_AGENT_HOME"]
        ev = dict(self.ev, cwd=home, tool_name="Bash", tool_input={"command": "lean-agent budget --cap off"})
        os.makedirs(home, exist_ok=True)
        self.assertIsNone(run_hook("budget_hook.py", ev, LEAN_AGENT_BUDGET="5000", LEAN_AGENT_BUDGET_SET="1", **self.env))
        with open(os.path.join(home, "session-cap.json"), "w") as fh:
            json.dump({"cap": 0}, fh)
        ev["tool_input"] = {"command": "npm test"}
        self.assertIsNone(run_hook("budget_hook.py", ev, LEAN_AGENT_BUDGET="5000", LEAN_AGENT_BUDGET_SET="1", **self.env))
        # outside the lean-agent home the saved setting doesn't apply (the user's own sessions)
        out = run_hook("budget_hook.py", dict(ev, cwd=self.tmp.name), LEAN_AGENT_BUDGET="5000",
                       LEAN_AGENT_BUDGET_SET="1", **self.env)
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_context_nudge_in_lean_home(self):
        home = self.env["LEAN_AGENT_HOME"]
        os.makedirs(home, exist_ok=True)
        with open(self.transcript, "a") as fh:
            fh.write(assistant_line("big1", 10, 0, 140000, 50))
        ev = dict(self.ev, cwd=home)
        env = dict(self.env, LEAN_AGENT_CTX_NUDGE="100000")
        out = run_hook("budget_hook.py", ev, **env)
        note = out["hookSpecificOutput"]["additionalContext"]
        self.assertIn("re-reads ~140,010 tokens of context on every call", note)
        self.assertIn("per 100 calls", note)
        self.assertIn("/compact", note)
        self.assertIn("restart it once with `lean-agent up`", note)  # no early-compaction env in this session
        self.assertIsNone(run_hook("budget_hook.py", ev, **env))  # once per 50K more
        self.assertIsNone(run_hook("budget_hook.py", dict(self.ev, session_id="s2", cwd=self.tmp.name), **env))
        out = run_hook("budget_hook.py", dict(ev, session_id="s3"), CLAUDE_CODE_AUTO_COMPACT_WINDOW="100000", **env)
        self.assertNotIn("restart it once", out["hookSpecificOutput"]["additionalContext"])

    def test_workers_start_in_the_background_in_lean_home(self):
        home = self.env["LEAN_AGENT_HOME"]
        os.makedirs(home, exist_ok=True)
        ev = lambda cmd, bg=False, cwd=home: dict(self.ev, cwd=cwd, tool_name="Bash",
                                                  tool_input={"command": cmd, "run_in_background": bg})
        for cmd in ('lean-agent run -p shop -m haiku --why x "look"', "cd /tmp && lean-agent review shop --resume",
                    "lean-agent do shop weekly-report", "lean-agent tracker shop --discover --mcp tickets"):
            out = run_hook("budget_hook.py", ev(cmd), **self.env)
            self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "deny", cmd)
            self.assertIn("run_in_background: true", out["hookSpecificOutput"]["permissionDecisionReason"])
            self.assertIsNone(run_hook("budget_hook.py", ev(cmd, bg=True), **self.env))
        for cmd in ("lean-agent review shop --status", "lean-agent review decline shop 1 --why x",
                    "lean-agent runs --show", "lean-agent tracker shop", "lean-agent stats"):
            self.assertIsNone(run_hook("budget_hook.py", ev(cmd), **self.env), cmd)
        self.assertIsNone(run_hook("budget_hook.py", ev("lean-agent run -p shop -m haiku x", cwd=self.tmp.name), **self.env))
        self.assertIsNone(run_hook("budget_hook.py", ev("lean-agent run -p shop -m haiku x"),
                                   LEAN_AGENT_BACKGROUND_RUNS="0", **self.env))

    def test_long_run_file_reads_refused_in_lean_home(self):
        home = self.env["LEAN_AGENT_HOME"]
        run = os.path.join(home, "work", "1020-101010-abcd")
        os.makedirs(run)
        with open(os.path.join(run, "summary-1.txt"), "w") as fh:
            fh.write("line\n" * 120)
        with open(os.path.join(run, "details-1.md"), "w") as fh:
            fh.write("short\n")
        ev = lambda cmd, cwd=home: dict(self.ev, cwd=cwd, tool_name="Bash", tool_input={"command": cmd})
        out = run_hook("budget_hook.py", ev(f"cat {run}/summary-1.txt"), **self.env)
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertIn("runs --show <id> --details --grep", out["hookSpecificOutput"]["permissionDecisionReason"])
        self.assertIn("120 lines", out["hookSpecificOutput"]["permissionDecisionReason"])
        self.assertEqual(run_hook("budget_hook.py", ev(f"tail -n 200 {run}/summary-1.txt"), **self.env)
                         ["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertIsNone(run_hook("budget_hook.py", ev(f"tail -n 20 {run}/summary-1.txt"), **self.env))
        self.assertIsNone(run_hook("budget_hook.py", ev(f"cat {run}/details-1.md"), **self.env))  # short
        self.assertIsNone(run_hook("budget_hook.py", ev(f"grep -n error {run}/summary-1.txt"), **self.env))
        self.assertIsNone(run_hook("budget_hook.py", ev(f"cat {run}/summary-1.txt", cwd=self.tmp.name), **self.env))
        self.assertIsNone(run_hook("budget_hook.py", ev(f"cat {run}/summary-1.txt"), LEAN_AGENT_READ_GUARD="0",
                                   **self.env))

    def test_handoff_on_new_session_and_compaction(self):
        home = self.env["LEAN_AGENT_HOME"]
        os.makedirs(home, exist_ok=True)
        start = {"session_id": "s9", "cwd": home, "source": "startup"}
        self.assertIsNone(run_hook("compact_hook.py", start, **self.env))  # nothing recent: no note
        import datetime
        now = datetime.datetime.now().isoformat(timespec="seconds")
        with open(os.path.join(home, "ledger.jsonl"), "w") as fh:
            fh.write(json.dumps({"id": "1020-101010-abcd", "ts": now, "status": "done", "model": "haiku",
                                 "project": "shop", "task": "Post the reply on PR 512 and move SHOP-77 to done",
                                 "details": "/x/details-1.md"}) + "\n")
        with open(os.path.join(home, "handoff-notes.json"), "w") as fh:
            json.dump([{"text": "Ask the user whether to merge PR 512"}], fh)
        p = subprocess.run([sys.executable, os.path.join(ROOT, "compact_hook.py"), "post"], input=json.dumps(start),
                           capture_output=True, text=True, env=dict(os.environ, **self.env), check=True)
        note = json.loads(p.stdout)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("1. Ask the user whether to merge PR 512", note)
        self.assertIn("1020-101010-abcd done haiku shop", note)
        self.assertIn("[details: /x/details-1.md]", note)
        self.assertIn("Items and branches touched: PR 512, SHOP-77", note)
        p = subprocess.run([sys.executable, os.path.join(ROOT, "compact_hook.py"), "post"],
                           input=json.dumps(dict(start, source="resume")), capture_output=True, text=True,
                           env=dict(os.environ, **self.env), check=True)
        self.assertEqual(p.stdout.strip(), "")  # a resumed session still has its context

    def test_report_shows_context_trend_and_compaction_saving(self):
        with open(self.transcript, "w") as fh:
            for i in range(12):
                fh.write(assistant_line(f"t{i}", 10, 0, 20000 * (i + 1), 10))
        p = subprocess.run([sys.executable, os.path.join(ROOT, "usage.py"), "report", self.transcript],
                           capture_output=True, text=True, env=dict(os.environ, **self.env), check=True)
        self.assertIn("Context per call, by quarter of the session: 40,010 -> 100,010 -> 160,010 -> 220,010", p.stdout)
        self.assertIn("Re-reading context above ~70K cost this session", p.stdout)

    def test_report(self):
        p = subprocess.run([sys.executable, os.path.join(ROOT, "usage.py"), "report", self.transcript],
                           capture_output=True, text=True, env=dict(os.environ, **self.env), check=True)
        self.assertIn("3,450", p.stdout)
        self.assertIn("Calls:   2 API calls · first call context 11,100 tokens", p.stdout)
        self.assertIn("claude-small", p.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
