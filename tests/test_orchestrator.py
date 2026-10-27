#!/usr/bin/env python3
"""Tests for the lean-agent CLI using a fake `claude` binary. Run: python3 tests/test_orchestrator.py"""
import argparse
import contextlib
import datetime
import glob
import io
import json
from unittest import mock
import shutil
import os
import subprocess
import re
import signal
import sys
import tempfile
import textwrap
import threading
import time
import types
import unittest
import uuid
from unittest import mock

from _env import clean_environ

# A review that did the reuse pass for the symbols the test repo's change adds.
REUSE_CHECKED = {"searches": [{"for": "total", "found": "nothing"}],
                 "reuse": [{"symbol": s, "candidates": [], "verdict": "justified-new"}
                           for s in ("api/totals.py", "web/page.txt", "total")]}
CLI = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts", "lean_agent.py")

FAKE_CLAUDE = textwrap.dedent("""\
    #!/usr/bin/env python3
    import json, os, sys
    if sys.argv[1:3] == ["mcp", "list"]:
        print(os.environ.get("FAKE_MCP_LIST", ""))
        sys.exit(0)
    if sys.argv[1:3] == ["mcp", "get"]:
        print(os.environ.get("FAKE_MCP_GET", ""))
        sys.exit(0)
    if sys.argv[1:2] == ["--version"]:
        print(os.environ.get("FAKE_VERSION", "1.0.0"))
        sys.exit(0)
    if sys.argv[1:2] == ["plugin"]:
        with open(os.environ["FAKE_LOG"], "a") as fh:
            fh.write(json.dumps({"plugin": sys.argv[1:]}) + "\\n")
        sys.exit(0)
    if os.environ.get("LEAN_AGENT_SERVICE_SESSION"):  # the interactive session `up` hosts: ends at once
        sys.exit(0)
    task = sys.stdin.read()
    if "--append-system-prompt-file" not in sys.argv and task.startswith("Rewrite this context card"):
        print(json.dumps({"type": "result", "result": os.environ.get("FAKE_SHORT", "## Testing\\nRun pytest -q in api/.")}))
        sys.exit(0)
    if "stream-json" in sys.argv and "--append-system-prompt-file" not in sys.argv:  # a session probe, not a worker
        chrome = "--chrome" in sys.argv and os.environ.get("FAKE_CHROME") == ("strict" if "--strict-mcp-config" in sys.argv else "loose") 
        tools = ["Read"] + (["mcp__claude-in-chrome__navigate", "mcp__claude-in-chrome__find",
                             "mcp__claude-in-chrome__form_input", "mcp__claude-in-chrome__gif_creator"] if chrome else [])
        servers = [{"name": "claude-in-chrome", "status": "connected"}] if chrome else []
        extra = 0
        if "--mcp-config" in sys.argv:  # an http server probe: FAKE_HTTP_TOOLS={"<server>": [tools]}
            cfg = json.load(open(sys.argv[sys.argv.index("--mcp-config") + 1]))["mcpServers"]
            for name, c in cfg.items():
                ok = os.environ.get("FAKE_HTTP_URL", "") in c.get("url", "") and (
                    "type" in c or not os.environ.get("FAKE_HTTP_NEED_TYPE"))
                servers.append({"name": name, "status": "connected" if ok else "needs-auth"})
                if ok:
                    names = json.loads(os.environ.get("FAKE_HTTP_TOOLS") or "{}").get(name, [])
                    pre = "mcp__" + "".join(ch if ch.isalnum() or ch in "_-" else "_" for ch in name) + "__"
                    tools += [pre + t for t in names]
                    extra += 400 * len(names)
        if os.environ.get("FAKE_PROBE_TOOLS"):
            tools = json.loads(os.environ["FAKE_PROBE_TOOLS"])
        if os.environ.get("FAKE_PROBE_SERVERS"):
            servers = json.loads(os.environ["FAKE_PROBE_SERVERS"])
        if not os.environ.get("FAKE_PROBE_NOINIT"):
            print(json.dumps({"type": "system", "subtype": "init", "tools": tools, "mcp_servers": servers,
                              "agents": json.loads(os.environ.get("FAKE_PROBE_AGENTS") or "[]")}))
        if os.environ.get("FAKE_PLAN"):  # what Claude reports about the plan, as in real stream-json output
            print(json.dumps({"type": "rate_limit_event", "rate_limit_info": json.loads(os.environ["FAKE_PLAN"])}))
        print(json.dumps({"type": "result", "usage": {"input_tokens": 8000 + (3000 if chrome else 0) + extra}}))
        sys.exit(0)
    log = os.environ["FAKE_LOG"]
    append = sys.argv[sys.argv.index("--append-system-prompt-file") + 1]
    mcp = None
    if "--mcp-config" in sys.argv:
        mp = sys.argv[sys.argv.index("--mcp-config") + 1]
        mcp = {"servers": json.load(open(mp))["mcpServers"], "mode": oct(os.stat(mp).st_mode & 0o777), "path": mp}
    if os.environ.get("FAKE_MCP_CALL"):
        import datetime, re
        cfg = os.environ["CLAUDE_CONFIG_DIR"]
        d = os.path.join(cfg, "projects", re.sub(r"[^A-Za-z0-9]", "-", os.getcwd()))
        os.makedirs(d, exist_ok=True)
        ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        with open(os.path.join(d, "sess-1.jsonl"), "a") as fh:
            for i, name in enumerate(os.environ["FAKE_MCP_CALL"].split(",")):  # several calls, in order
                fh.write(json.dumps({"type": "assistant", "timestamp": ts, "message": {"content": [
                    {"type": "tool_use", "id": "tu-%d-%d" % (os.getpid(), i), "name": name, "input": {}}]}}) + "\\n")
    with open(log, "a") as fh:
        fh.write(json.dumps({"argv": sys.argv[1:], "cwd": os.getcwd(), "task": task,
                             "append": open(append).read(), "mcp": mcp, "thread": os.environ.get("LEAN_AGENT_THREAD"),
                             "automem": os.environ.get("CLAUDE_CODE_DISABLE_AUTO_MEMORY"),
                             "bash_out": os.environ.get("BASH_MAX_OUTPUT_LENGTH"),
                             "service": os.environ.get("LEAN_AGENT_SERVICE_SESSION"),
                             "addclaudemd": os.environ.get("CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD")}) + "\\n")
    import time
    if os.environ.get("FAKE_RELEASE_FILE"):  # hold until the test says go
        end = time.time() + 30
        while not os.path.exists(os.environ["FAKE_RELEASE_FILE"]) and time.time() < end:
            time.sleep(0.05)
    if os.environ.get("FAKE_FINISH_AT"):  # make parallel fake workers finish together
        time.sleep(max(0.0, float(os.environ["FAKE_FINISH_AT"]) - time.time()))
    fb = os.environ.get("FAKE_FEEDBACK", '{"status": "done", "used": [], "unneeded": [], "missing": ""}')
    model = sys.argv[sys.argv.index("--model") + 1] if "--model" in sys.argv else ""
    if os.environ.get("FAKE_FAIL_MODEL") and os.environ["FAKE_FAIL_MODEL"] in model:
        fb = '{"status": "failed", "used": [], "unneeded": []}'
    if os.environ.get("FAKE_TURNS"):  # stream assistant turns, each re-reading FAKE_TURN_CTX tokens
        print(json.dumps({"type": "system", "subtype": "init", "session_id": "sess-1"}), flush=True)
        for i in range(int(os.environ["FAKE_TURNS"])):
            print(json.dumps({"type": "assistant", "session_id": "sess-1", "message": {"id": "msg-%d" % i, "usage": {
                "input_tokens": 10, "cache_read_input_tokens": int(os.environ.get("FAKE_TURN_CTX", "1000"))}}}),
                flush=True)
            time.sleep(float(os.environ.get("FAKE_TURN_SLEEP", "0")))
    if os.environ.get("FAKE_SELF_KILL"):  # killed from outside, like the OOM killer
        import signal
        os.kill(os.getpid(), signal.SIGKILL)
    if os.environ.get("FAKE_HANG"):
        time.sleep(60)
    second = "search-only second opinion" in open(append).read()
    rv = os.environ.get("FAKE_REUSE") if second else os.environ.get("FAKE_REVIEW")
    if os.environ.get("FAKE_PLAN"):
        print(json.dumps({"type": "rate_limit_event", "rate_limit_info": json.loads(os.environ["FAKE_PLAN"])}))
    print(json.dumps({"type": "result", "subtype": os.environ.get("FAKE_SUBTYPE", "success"), "is_error": False,
                      "num_turns": 3, "session_id": "sess-1", "total_cost_usd": 0.05,
                      "result": os.environ.get("FAKE_ANSWER", "Did the thing.") + "\\n" + (("LEAN-REVIEW " + rv + "\\n") if rv else "") + "LEAN-FEEDBACK " + fb,
                      "usage": {"input_tokens": 100, "cache_creation_input_tokens": 800,
                                "cache_read_input_tokens": 5000, "output_tokens": 300}}))
""")


PLAYWRIGHT_DIR = os.environ.get("LEAN_AGENT_PLAYWRIGHT_DIR")  # opt-in knob: read before setUp clears LEAN_AGENT_*


def _load_json(p):
    with open(p) as fh:
        return json.load(fh)


def service_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


class CliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = self.tmp.name
        self.proj = os.path.join(t, "proj")
        os.makedirs(os.path.join(self.proj, ".claude", "skills", "deploy"))
        os.makedirs(os.path.join(self.proj, "web"))
        with open(os.path.join(self.proj, "CLAUDE.md"), "w") as fh:
            fh.write("# Acme\nMonorepo for Acme.\n\n## Testing\nRun pytest -q in api/. Never hit the real database; "
                     "use the sqlite fixture in tests/conftest.py. Integration tests need DOCKER=1.\n\n"
                     "## Style\nUse black and ruff. Type hints everywhere. Prefer dataclasses over dicts "
                     "for structured values passed between modules.\n")
        with open(os.path.join(self.proj, "web", "CLAUDE.md"), "w") as fh:
            fh.write("## Frontend build\nUse pnpm, never npm. Run pnpm build in web/ before committing UI "
                     "changes; Storybook lives in web/stories and must keep building.\n")
        with open(os.path.join(self.proj, ".claude", "skills", "deploy", "SKILL.md"), "w") as fh:
            fh.write("---\nname: deploy\ndescription: Deploy the api to staging\n---\nRun make deploy-staging.\n")
        fake = os.path.join(t, "claude")
        with open(fake, "w") as fh:
            fh.write(FAKE_CLAUDE)
        os.chmod(fake, 0o755)
        self.log = os.path.join(t, "calls.jsonl")
        clean = clean_environ()  # the caller's settings stay out
        patcher = mock.patch.dict(os.environ, clean, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.env = dict(clean, LEAN_AGENT_HOME=os.path.join(t, "home"), LEAN_AGENT_CLAUDE=fake,
                        FAKE_LOG=self.log, CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD="1",
                        HOME=t, CLAUDE_CONFIG_DIR=os.path.join(t, "cfg"), LEAN_AGENT_LAUNCH_GUARD="0",
                        LEAN_AGENT_HTTP_CHECK="0")
        os.makedirs(os.path.join(t, "cfg"))
        fake_mcp = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "fake_mcp.py")
        self.mcp_cfg = {"type": "stdio", "command": sys.executable, "args": [fake_mcp], "env": {"TOKEN": "s3cret"}}
        with open(os.path.join(t, "cfg", ".claude.json"), "w") as fh:
            json.dump({"mcpServers": {"tickets": self.mcp_cfg},
                       "projects": {self.proj: {"mcpServers": {"localdb": {"type": "http", "url": "http://localhost:1"}}}}}, fh)
        with open(os.path.join(self.proj, ".mcp.json"), "w") as fh:
            json.dump({"mcpServers": {"docs": {"type": "http", "url": "https://example.invalid/mcp"}}}, fh)

    def tearDown(self):
        for up in getattr(self, "ups", []):  # stop any `up` first: it writes into the folder that is removed next
            if up.poll() is None:
                up.terminate()  # lets it stop its session too
                try:
                    up.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    up.kill()
            up.communicate()
        self.stop_detached_runs()  # a run that outlives its test keeps writing into the folder removed next
        self.tmp.cleanup()

    def stop_detached_runs(self):
        pids = []
        for f in glob.glob(os.path.join(self.env["LEAN_AGENT_HOME"], "running", "*.json")):
            try:
                pid = json.load(open(f)).get("pid")
            except (OSError, ValueError):
                continue
            if isinstance(pid, int) and pid > 1 and pid != os.getpid() and service_alive(pid) \
                    and os.getpgid(pid) != os.getpgrp():  # never the test process itself or its group
                pids.append(pid)
        for pid in pids:
            try:
                if os.getpgid(pid) == pid:
                    os.killpg(pid, signal.SIGKILL)  # the run's own group: its supervisor and the claude under it
                else:
                    os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
        end = time.time() + 10
        while time.time() < end and any(self.running_process(pid) for pid in pids):
            time.sleep(0.05)

    @staticmethod
    def running_process(pid):
        try:
            with open(f"/proc/{pid}/stat") as fh:
                return fh.read().rsplit(")", 1)[1].split()[0] != "Z"  # a zombie nobody reaped is gone
        except (OSError, IndexError):
            return False

    def cli(self, *args, check=True, input=None, **env):
        p = subprocess.run([sys.executable, CLI, *args], capture_output=True, text=True, input=input,
                           env=dict(self.env, **env), stdin=None if input is not None else subprocess.DEVNULL)
        if check and p.returncode != 0:
            raise AssertionError(f"exit {p.returncode}\n{p.stdout}\n{p.stderr}")
        return p

    def calls(self):
        with open(self.log) as fh:
            return [c for c in (json.loads(l) for l in fh) if "plugin" not in c]

    def ledger(self):
        with open(os.path.join(self.env["LEAN_AGENT_HOME"], "ledger.jsonl")) as fh:
            return [json.loads(l) for l in fh]

    def plugin_calls(self):
        with open(self.log) as fh:
            return [c["plugin"] for c in (json.loads(l) for l in fh) if "plugin" in c]

    def test_learn_and_cards(self):
        out = self.cli("learn", self.proj).stdout
        self.assertIn("cards", out)
        cards = self.cli("cards", "proj").stdout
        for cid in ("testing", "style", "web-frontend-build", "skill-deploy"):
            self.assertIn(cid, cards)

    def test_learn_monorepo_layout(self):
        def write(rel, text):
            path = os.path.join(self.proj, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as fh:
                fh.write(text)
        body = "Some real guidance that is long enough to stand on its own as a card.\n"
        # Claude's own agent worktrees and submodules must be ignored.
        write(".claude/worktrees/agent-abc/CLAUDE.md", "## Testing\n" + body)
        write(".claude/worktrees/agent-abc/.git", "gitdir: elsewhere\n")
        write("vendored/.git", "gitdir: elsewhere\n")
        write("vendored/CLAUDE.md", "## Vendored\n" + body)
        write("services/.claude/CLAUDE.md", "# Platform\n" + body + "\n## Rules\n" + body)
        write("services/ios-app/.claude/CLAUDE.md", "## Rules\n" + body)
        write("services/admin-portal/App/CLAUDE.md", "## Rules\n" + body)
        write("services/billing-portal/App/CLAUDE.md", "## Rules\n" + body)
        write("qa/CLAUDE.md", "# QA Suite\n\n## Quick Start\n" + body + "\n## Architecture\n" + body)
        write("qa/apps/login-app/qa/CLAUDE.md", "# CLAUDE.md\n" + body + "\n## Architecture\n" + body)
        write("services/billing-portal/App/notes/CLAUDE.md",
              "## Production has a strict Content-Security-Policy that blocks inline scripts\n" + body)
        self.cli("learn", self.proj, "--name", "mono")
        out = self.cli("cards", "mono").stdout
        self.assertNotIn("worktrees", out)
        self.assertNotIn("vendored", out)
        for cid in ("services", "services-rules", "ios-app-rules", "admin-portal-app-rules",
                    "billing-portal-app-rules", "qa-quick-start", "qa-architecture",
                    "login-app-qa", "login-app-qa-architecture",
                    "notes-production-has-a-strict"):
            self.assertRegex(out, rf"\n {cid}\s")
        self.assertNotIn("qa-suite", out)  # bare H1 stub merged into the next section
        self.assertIn("2 cards", self.cli("cards", "mono", "/app: rules").stdout)

    def test_suggest_matches_task(self):
        self.cli("learn", self.proj)
        out = self.cli("suggest", "proj", "fix the failing pytest database fixture").stdout
        match_lines = [l for l in out.splitlines() if l.startswith("match")]
        self.assertTrue(match_lines and "testing" in match_lines[0], out)

    def test_cards_auto_is_selective(self):
        self.cli("learn", self.proj)
        for i in range(12):
            self.cli("card", "add", "proj", f"filler-{i}", "--title", f"filler {i}", "--text", "Nothing here.")
        for i in range(6):
            self.cli("card", "add", "proj", f"invoice-{i}", "--title", f"invoice notes {i}", "--text", "Short note.")
        self.cli("card", "add", "proj", "loose", "--title", "unrelated", "--text", "refund and invoice")
        out = self.cli("suggest", "proj", "fix the invoice refund").stdout
        matches = [l for l in out.splitlines() if l.startswith("match")]
        self.assertEqual(len(matches), 4, out)
        self.assertNotIn("loose", out)  # two body words aren't enough for auto
        out = self.cli("suggest", "proj", "fix the invoice refund", "--max-cards", "2").stdout
        self.assertEqual(len([l for l in out.splitlines() if l.startswith("match")]), 2)
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--cards", "auto", "fix the invoice refund")
        self.assertEqual(self.calls()[-1]["append"].count("invoice notes"), 4)

    def test_logs_split_by_level(self):
        self.cli("learn", self.proj)
        self.assertIn("No error log yet", self.cli("logs").stdout)
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "look up the fixture")
        self.cli("run", "-p", "nope", "-m", "haiku", "--why", "x", "t", check=False)
        debug = self.cli("logs", "debug").stdout
        self.assertIn("DEBUG run: ", debug)
        self.assertIn("look up the fixture", debug)
        err = self.cli("logs").stdout
        self.assertIn("ERROR cli: ", err)
        self.assertNotIn("look up the fixture", err)
        self.assertIn("No saved command outputs", self.cli("logs", "verbose").stdout)

    def test_runs_last_and_show_last_on_an_empty_ledger(self):
        for flags in (("--last",), ("--show", "last"), ("--show",)):
            r = self.cli("runs", *flags, check=False)
            self.assertNotEqual(r.returncode, 0, flags)
            self.assertIn("no runs yet", r.stdout + r.stderr, flags)

    def test_runs_show_prints_summary_again(self):
        self.cli("learn", self.proj)
        out = self.cli("run", "-p", "proj", "-m", "sonnet", "--why", "x", "t").stdout
        again = self.cli("runs", "--last", "--tokens").stdout
        self.assertTrue(again.startswith("run "), again)
        self.assertIn("  tokens: input", again)
        self.assertIn("context per turn", again)
        self.assertNotIn("Did the thing", again)
        full = self.cli("runs", "--show").stdout
        self.assertEqual(full, out[out.index("run "):])
        rid = out.split("run ")[1].split()[0]
        self.assertIn(rid, self.cli("runs", "--show", rid).stdout)

    def test_savings_estimate(self):
        self.cli("learn", self.proj)
        out = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "t").stdout
        # fake run: 3 turns, ~1,966 context/turn vs an assumed 30,000: (30000-1966.7)*(1.25+0.2)*0.05 = 2,032
        self.assertIn("saved ~", out)
        self.assertIn("vs a normal session's ~30,000/turn (assumed)", out)
        self.cli("run", "-p", "proj", "-m", "sonnet", "--why", "x", "t")
        sq = os.path.join(self.env["LEAN_AGENT_HOME"], "savings.jsonl")
        with open(sq, "w") as fh:
            fh.write(json.dumps({"ts": "2999-01-01T00:00:00", "kind": "squeeze", "before": 40000, "after": 4000}) + "\n")
        out = self.cli("savings").stdout
        self.assertIn("worker context", out)
        self.assertRegex(out, r"output squeezing\s+9,000  \(1 long outputs")
        self.assertIn("(assumed; measure: lean-agent savings --measure)", out)
        self.assertIn("without lean-agent ~", out)
        out = self.cli("savings", "--measure", "-p", "proj").stdout  # the fake reports 8,000 tokens
        self.assertRegex(out, r"proj-\w+: a normal Claude Code turn carries ~8,000 tokens of context")
        self.assertIn("(measured)", out)

    def test_attribution_asked_once_and_enforced(self):
        self.cli("learn", self.proj)
        p = self.cli("attribution", check=False)
        self.assertEqual(p.returncode, 2)
        self.assertIn("Ask the user once", p.stdout)
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "t")
        argv = self.calls()[-1]["argv"]
        self.assertNotIn("attribution", json.loads(argv[argv.index("--settings") + 1]))  # not set: Claude Code's defaults
        self.assertIn("attribution: off", self.cli("attribution", "off").stdout)
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "t")
        call = self.calls()[-1]
        argv = call["argv"]
        self.assertEqual(json.loads(argv[argv.index("--settings") + 1])["attribution"],
                         {"commit": "", "pr": "", "sessionUrl": False})
        self.assertIn("Never add \"Co-Authored-By: Claude", call["append"])
        home = self.cli("home").stdout.strip()
        with open(os.path.join(home, ".claude", "settings.json")) as fh:
            self.assertEqual(json.load(fh)["attribution"], {"commit": "", "pr": "", "sessionUrl": False})
        self.cli("attribution", "on")
        with open(os.path.join(home, ".claude", "settings.json")) as fh:
            self.assertNotIn("attribution", json.load(fh))
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "t")
        argv = self.calls()[-1]["argv"]
        self.assertNotIn("attribution", json.loads(argv[argv.index("--settings") + 1]))

    def test_strict_setting_stored_and_shown_by_doctor(self):
        self.cli("learn", self.proj)
        self.assertIn("strict: on", self.cli("config", "strict").stdout)  # on by default
        self.assertIn("strict orchestrator: on", self.cli("doctor", check=False).stdout)
        self.assertIn("strict: off", self.cli("config", "strict", "off").stdout)
        self.assertIn("strict orchestrator: off", self.cli("doctor", check=False).stdout)
        with open(os.path.join(self.env["LEAN_AGENT_HOME"], "config.json")) as fh:
            self.assertEqual(json.load(fh)["strict"], "off")
        self.assertIn("strict: on", self.cli("config", "strict", "on").stdout)

    def test_publish_and_the_artifacts_switch_are_gone_and_old_keys_are_ignored(self):
        self.cli("learn", self.proj)
        p = self.cli("publish", "T", "--task-file", "-", input="x", check=False)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("invalid choice", p.stderr)
        self.assertNotEqual(self.cli("config", "artifacts", "off", check=False).returncode, 0)
        home_dir = self.env["LEAN_AGENT_HOME"]
        with open(os.path.join(home_dir, "config.json"), "w") as fh:
            json.dump({"artifacts": "direct"}, fh)  # an old key: ignored, the Artifact tools stay denied
        self.cli("handoff", "--note", "artifact: https://example.invalid/a1 Old plan", "--kind", "fyi")
        self.assertIn("artifact: https://example.invalid/a1 Old plan", self.cli("handoff").stdout)
        self.cli("thread", "show", "t1", check=False)
        home = self.cli("home").stdout.strip()
        deny = json.load(open(os.path.join(home, ".claude", "settings.json")))["permissions"]["deny"]
        for tool in ("Artifact", "ArtifactComments", "ArtifactData"):
            self.assertIn(tool, deny)
        out = self.cli("doctor", check=False).stdout
        self.assertNotIn("publish:", out)
        self.assertNotIn("artifacts:", out)
        self.assertIn("lean-agent handover", self.cli("guide").stdout)

    def handover_dir(self):
        return os.path.join(self.env["LEAN_AGENT_HOME"], "proj", "handovers")

    def write_rules(self):
        d = os.path.join(self.proj, ".claude", "rules")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "csharp.md"), "w") as fh:
            fh.write('---\ndescription: C# conventions\npaths:\n  - "**/*.cs"\n  - "**/appsettings*.json"\n---\n'
                     "# C# conventions\nUse file-scoped namespaces.\n")
        with open(os.path.join(d, "general.md"), "w") as fh:
            fh.write("# General\nKeep commits small.\n")

    def rule_cards(self):
        cards = json.load(open(os.path.join(self.env["LEAN_AGENT_HOME"], "library", "proj", "cards.json")))
        return {c["id"]: c for c in cards if c["kind"] == "rule"}

    def test_learn_imports_rule_cards_with_globs_and_drops_removed_ones(self):
        self.write_rules()
        self.cli("learn", self.proj, "--name", "proj")
        rules = self.rule_cards()
        self.assertEqual(set(rules), {"rule-csharp", "rule-general"})
        self.assertEqual(rules["rule-csharp"]["globs"], ["**/*.cs", "**/appsettings*.json"])
        self.assertEqual(rules["rule-csharp"]["description"], "C# conventions")
        self.assertNotIn("globs", rules["rule-general"])
        self.assertNotIn("paths:", rules["rule-csharp"]["text"])
        os.remove(os.path.join(self.proj, ".claude", "rules", "csharp.md"))
        self.cli("learn", self.proj, "--name", "proj")
        self.assertEqual(set(self.rule_cards()), {"rule-general"})

    def test_rule_cards_are_picked_by_task_paths_files_and_changed_files(self):
        self.write_rules()
        self.cli("learn", self.proj, "--name", "proj")

        def sent(*extra, task="tidy up"):
            self.cli("run", "proj", "-m", "haiku", "--why", "x", "--cards", "auto", *extra, "--", task)
            return self.ledger()[-1]["cards"]
        self.assertNotIn("rule-csharp", sent())
        self.assertIn("rule-general", sent())  # no paths: always a candidate
        self.assertIn("rule-csharp", sent(task="fix src/Orders/Order.cs"))
        self.assertIn("rule-csharp", sent(task="edit appsettings.Production.json"))
        self.assertIn("rule-csharp", sent("--files", "x/y/Foo.cs"))
        self.assertNotIn("rule-csharp", sent("--files", "x/y/foo.py"))
        g = self.git_project()
        g("checkout", "-q", "main")
        open(os.path.join(self.proj, "New.cs"), "w").write("class New {}")  # untracked, changed
        self.assertIn("rule-csharp", sent())

    def test_doctor_prints_project_rules_for_a_project_registered_via_symlink(self):
        link = os.path.join(self.tmp.name, "link")
        os.symlink(self.proj, link)
        self.cli("learn", link, "--name", "proj")
        self.assertIn("project rules: off", self.cli("doctor", self.proj, check=False).stdout)
        self.assertIn("project rules: off", self.cli("doctor", link, check=False).stdout)
        self.cli("config", "project-rules", "on", "-p", "proj")
        self.assertIn("project rules: on for proj", self.cli("doctor", self.proj, check=False).stdout)

    def run_in(self, cwd, *args, **env):
        return subprocess.run([sys.executable, CLI, *args], capture_output=True, text=True, cwd=cwd,
                              env=dict(self.env, **env), stdin=subprocess.DEVNULL)

    def test_doctor_from_a_project_subdirectory_finds_the_project(self):
        self.cli("learn", self.proj, "--name", "proj")
        p = self.run_in(os.path.join(self.proj, "web"), "doctor")
        self.assertNotIn("Traceback", p.stderr)
        self.assertIn("project rules: off for proj", p.stdout)
        self.assertNotIn("isn't a learned project", p.stdout)

    def test_doctor_outside_any_project_prints_no_project_lines(self):
        self.cli("learn", self.proj, "--name", "proj")
        outside = os.path.join(self.tmp.name, "elsewhere")
        os.makedirs(outside)
        p = self.run_in(outside, "doctor")
        self.assertNotIn("Traceback", p.stderr)
        self.assertNotIn("project rules:", p.stdout)
        self.assertNotIn("lean-agent rules load here", p.stdout)
        self.assertIn("isn't a learned project", p.stdout)

    def test_relearning_through_a_symlink_keeps_the_stored_path(self):
        link = os.path.join(self.tmp.name, "alias")
        os.symlink(self.proj, link)
        self.cli("learn", self.proj, "--name", "proj")
        self.cli("learn", link)
        with open(os.path.join(self.env["LEAN_AGENT_HOME"], "projects.json")) as fh:
            projs = json.load(fh)
        self.assertEqual({k: v["path"] for k, v in projs.items()}, {"proj": self.proj})

    def test_project_rules_on_runs_natively_and_skips_rule_cards(self):
        self.write_rules()
        self.cli("learn", self.proj, "--name", "proj")
        self.assertIn("project-rules for proj: off", self.cli("config", "project-rules", "-p", "proj").stdout)
        self.assertIn("project rules: off", self.cli("doctor", self.proj, check=False).stdout)
        self.assertIn("project-rules for proj: on", self.cli("config", "project-rules", "on", "-p", "proj").stdout)
        doctor = self.cli("doctor", self.proj, check=False).stdout
        self.assertIn("project rules: on for proj", doctor)
        self.assertIn("settings.json", doctor)
        self.cli("run", "proj", "-m", "haiku", "--why", "x", "--cards", "auto", "--", "fix src/Order.cs")
        call = self.calls()[-1]
        argv = call["argv"]
        self.assertNotIn("--safe-mode", argv)
        self.assertEqual(argv[argv.index("--setting-sources") + 1], "project")
        for flag in ("--disable-slash-commands", "--tools", "--permission-mode"):
            self.assertIn(flag, argv)
        self.assertEqual(os.path.realpath(call["cwd"]), os.path.realpath(self.proj))
        self.assertEqual(call["automem"], "1")
        self.assertFalse([c for c in self.ledger()[-1]["cards"] if c.startswith("rule-")])
        self.assertNotIn("Keep commits small", call["append"])
        self.assertNotIn("Monorepo for Acme", call["append"])  # the root CLAUDE.md loads natively
        self.cli("run", "--resume", self.ledger()[-1]["id"], "more")
        self.assertEqual(self.calls()[-1]["argv"][self.calls()[-1]["argv"].index("--setting-sources") + 1], "project")
        # a role run keeps the isolation
        self.cli("handover", "Plan", "-p", "proj", "--task-file", "-", input="x", FAKE_ANSWER="## A")
        self.assertIn("--safe-mode", self.calls()[-1]["argv"])
        self.cli("config", "project-rules", "off", "-p", "proj")
        self.cli("run", "proj", "-m", "haiku", "--why", "x", "--cards", "auto", "--", "fix src/Order.cs")
        self.assertIn("--safe-mode", self.calls()[-1]["argv"])

    def test_handover_writes_a_markdown_file_with_header_from_a_read_only_worker(self):
        self.cli("learn", self.proj, "--name", "proj")
        out = self.cli("handover", "Weekly plan", "-p", "proj", "--task-file", "-", input="open questions",
                       FAKE_ANSWER="## Open\n- one").stdout
        path = os.path.join(self.handover_dir(), "weekly-plan.md")
        self.assertEqual(out.strip(), f"handover: {path}")
        lines = open(path).read().split("\n")
        self.assertEqual(lines[0], "# Weekly plan")
        self.assertRegex(lines[2], r"^_\d{4}-\d\d-\d\d(?: \u00b7 thread t\d+)?_$")
        self.assertIn("## Open", lines)
        call = self.calls()[-1]
        self.assertIn("--safe-mode", call["argv"])
        self.assertEqual(call["argv"][call["argv"].index("--tools") + 1], "Read,Glob,Grep")
        self.assertIn("open questions", call["task"])
        self.assertEqual(self.ledger()[-1]["role"], "composer")
        self.assertTrue(self.ledger()[-1]["read_only"])

    def test_handover_as_is_saves_the_text_and_the_same_title_keeps_the_previous_file(self):
        self.cli("learn", self.proj, "--name", "proj")
        self.cli("handover", "Plan", "-p", "proj", "--as-is", "--task-file", "-", input="first text", FAKE_ANSWER="unused")
        self.assertFalse(os.path.exists(self.log) and self.calls())  # no worker
        path = os.path.join(self.handover_dir(), "plan.md")
        self.assertIn("first text", open(path).read())
        self.cli("handover", "Plan", "-p", "proj", "--as-is", "--task-file", "-", input="second text")
        self.assertIn("second text", open(path).read())
        self.assertNotIn("first text", open(path).read())
        self.assertIn("first text", open(os.path.join(self.handover_dir(), "plan.prev.md")).read())
        self.cli("handover", "Plan", "-p", "proj", "--as-is", "--task-file", "-", input="third text")
        self.assertIn("second text", open(os.path.join(self.handover_dir(), "plan.prev.md")).read())

    def test_handover_with_an_empty_reply_is_an_error_and_writes_no_file(self):
        self.cli("learn", self.proj, "--name", "proj")
        p = self.cli("handover", "Empty", "-p", "proj", "--task-file", "-", input="x", check=False, FAKE_ANSWER="")
        self.assertNotEqual(p.returncode, 0)
        self.assertFalse(os.path.exists(os.path.join(self.handover_dir(), "empty.md")))

    def test_handover_list_shows_newest_first_with_title_and_date(self):
        self.cli("learn", self.proj, "--name", "proj")
        self.cli("handover", "Older one", "-p", "proj", "--as-is", "--task-file", "-", input="a")
        old = os.path.join(self.handover_dir(), "older-one.md")
        os.utime(old, (1, 1))
        self.cli("handover", "Newer one", "-p", "proj", "--as-is", "--task-file", "-", input="b")
        self.cli("handover", "Newer one", "-p", "proj", "--as-is", "--task-file", "-", input="c")  # leaves a .prev.md
        lines = self.cli("handover", "--list", "-p", "proj").stdout.strip().split("\n")
        self.assertEqual(len(lines), 2)
        self.assertIn("newer-one.md  Newer one", lines[0])
        self.assertIn("older-one.md  Older one", lines[1])
        self.assertRegex(lines[0], r"\d{4}-\d\d-\d\d$")
        self.assertEqual(len(self.cli("handover", "--list").stdout.strip().split("\n")), 2)

    def test_handover_is_tagged_with_the_thread_and_listed_by_thread_show(self):
        self.cli("learn", self.proj, "--name", "proj")
        self.threads_home().route("Write the handover", "s1")  # t1
        out = self.cli("handover", "Tagged", "-p", "proj", "--as-is", "--thread", "t1", "--task-file", "-", input="x").stdout
        path = out.split("handover: ", 1)[1].strip()
        self.assertIn("thread t1_", open(path).read().split("\n")[2])
        self.assertIn(f"handover {path}", self.cli("thread", "show", "t1").stdout)
        self.cli("handover", "Untagged", "-p", "proj", "--as-is", "--thread", "none", "--task-file", "-", input="x")
        self.assertNotIn("thread", open(os.path.join(self.handover_dir(), "untagged.md")).read().split("\n")[2])
        self.cli("handover", "Worker", "-p", "proj", "--thread", "t1", "--task-file", "-", input="x", FAKE_ANSWER="body")
        self.assertEqual(self.ledger()[-1]["thread"], "t1")

    def registry(self):
        return _load_json(os.path.join(self.env["LEAN_AGENT_HOME"], "handovers.json"))

    def test_handover_same_path_replaces_its_record(self):
        self.cli("learn", self.proj, "--name", "proj")
        self.cli("handover", "Plan", "-p", "proj", "--as-is", "--thread", "none", "--task-file", "-", input="a")
        self.cli("handover", "plan!", "-p", "proj", "--as-is", "--thread", "t4", "--task-file", "-", input="b")
        recs = self.registry()
        self.assertEqual(len(recs), 1)
        self.assertEqual((recs[0]["title"], recs[0]["thread"]), ("plan!", "t4"))
        self.assertTrue(recs[0]["path"].endswith("plan.md"))

    def test_handover_same_title_in_two_projects_gives_two_files_both_listed(self):
        other = os.path.join(os.path.dirname(self.proj), "other")
        os.makedirs(other)
        self.cli("learn", self.proj, "--name", "proj")
        self.cli("learn", other, "--name", "other")
        for slug in ("proj", "other"):
            self.cli("handover", "Plan", "-p", slug, "--as-is", "--task-file", "-", input=slug)
        paths = [os.path.join(self.env["LEAN_AGENT_HOME"], slug, "handovers", "plan.md") for slug in ("proj", "other")]
        self.assertTrue(all(os.path.exists(f) for f in paths))
        listed = self.cli("handover", "--list").stdout
        self.assertTrue(all(f in listed for f in paths))
        self.assertEqual(len(self.registry()), 2)

    def test_handover_without_a_title_or_text_is_an_error(self):
        self.cli("learn", self.proj, "--name", "proj")
        p = self.cli("handover", "-p", "proj", check=False)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("needs a title", p.stderr)
        p = self.cli("handover", "Empty", "-p", "proj", "--as-is", "--task-file", "-", input="  \n", check=False)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("say what the handover is about", p.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.handover_dir(), "empty.md")))

    def test_handover_list_on_an_empty_home_says_so(self):
        self.assertEqual(self.cli("handover", "--list").stdout.strip(), "No handovers yet.")

    def test_thread_move_retags_handover_records(self):
        self.cli("learn", self.proj, "--name", "proj")
        self.threads_home().route("Publish the report via docs", "s1")  # t1
        self.threads_home().route("Fix the export timeout in billing", "s1")  # t2, the current one
        self.cli("handover", "Early", "-p", "proj", "--as-is", "--thread", "t2", "--task-file", "-", input="x")
        reg_path = os.path.join(self.env["LEAN_AGENT_HOME"], "handovers.json")
        recs = self.registry()
        recs[0]["ts"] = (datetime.datetime.now() - datetime.timedelta(hours=1)).isoformat(timespec="seconds")
        with open(reg_path, "w") as fh:
            json.dump(recs, fh)  # made before the moved request
        self.cli("handover", "Plan", "-p", "proj", "--as-is", "--thread", "t2", "--task-file", "-", input="x")
        self.cli("handover", "Elsewhere", "-p", "proj", "--as-is", "--thread", "t4", "--task-file", "-", input="x")
        self.cli("thread", "move", "t1")
        self.assertEqual({r["title"]: r["thread"] for r in self.registry()},
                         {"Early": "t2", "Plan": "t1", "Elsewhere": "t4"})

    def test_remember_runs_a_librarian_and_prints_what_it_filed(self):
        self.cli("learn", self.proj)
        out = self.cli("remember", "Never merge on Fridays.", FAKE_ANSWER="Filed.\nREMEMBERED feedback no-friday-merges").stdout
        self.assertEqual(out.strip(), "REMEMBERED feedback no-friday-merges")
        call = self.calls()[-1]
        argv = call["argv"]
        self.assertIn("Never merge on Fridays.", call["task"])
        self.assertEqual(argv[argv.index("--model") + 1], "sonnet")
        tools = argv[argv.index("--tools") + 1].split(",")
        self.assertNotIn("Write", tools)
        self.assertNotIn("Edit", tools)
        allowed = argv[argv.index("--allowedTools") + 1]
        lean = os.path.join(os.path.dirname(CLI), "..", "bin", "lean-agent")
        for sub in ("memory", "card", "cards", "todo", "handoff"):
            self.assertIn(f"Bash({os.path.realpath(lean)} {sub}:*)", allowed)
        self.assertNotIn("rm:", allowed)
        # filed before: the librarian reports it unchanged (no duplicate), --task-file - and --project work
        out = self.cli("remember", "--task-file", "-", "--project", "proj", input="Never merge on Fridays.",
                       FAKE_ANSWER="UNCHANGED feedback no-friday-merges").stdout
        self.assertEqual(out.strip(), "UNCHANGED feedback no-friday-merges")
        p = self.cli("remember", "Deploy on Fridays", check=False, FAKE_ANSWER="CONFLICT memory no-friday-merges: never merge on Fridays")
        self.assertEqual(p.returncode, 1)
        self.assertIn("CONFLICT memory no-friday-merges", p.stdout)
        p = self.cli("remember", "x", check=False, FAKE_ANSWER="I could not decide.")
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("didn't report what it filed", p.stderr)
        self.assertNotEqual(self.cli("remember", check=False).returncode, 0)

    def test_advise_runs_a_read_only_advisor_stores_and_caps_the_advice(self):
        self.cli("learn", self.proj)
        adv = os.path.join(self.env["LEAN_AGENT_HOME"], "advice")
        block = "ADVICE\n" + "\n".join(f"line {i}" for i in range(1, 21))  # 21 lines: the command keeps 15
        out = self.cli("advise", "Fix the export retry loop", "--thread", "#7", FAKE_ANSWER="Here.\n" + block).stdout
        lines = out.strip().splitlines()
        self.assertEqual((len(lines), lines[0], lines[-1]), (15, "Understood as: (not stated)", "line 13"))
        self.assertEqual(lines[1], "ADVICE")
        call = self.calls()[-1]
        argv = call["argv"]
        self.assertIn("Fix the export retry loop", call["task"])
        self.assertIn("Last runs of this project", call["task"])
        self.assertEqual(argv[argv.index("--model") + 1], "haiku")
        self.assertNotIn("Write", argv[argv.index("--tools") + 1].split(","))
        allowed = argv[argv.index("--allowedTools") + 1]
        lean = os.path.realpath(os.path.join(os.path.dirname(CLI), "..", "bin", "lean-agent"))
        for sub in ("memory list", "todo list", "brief"):
            self.assertIn(f"Bash({lean} {sub}:*)", allowed)
        self.assertNotIn(f"Bash({lean} cards:*)", allowed)  # the card titles are in the task
        self.assertNotIn("handoff", allowed)
        files = sorted(glob.glob(os.path.join(adv, "*.json")))
        self.assertEqual(len(files), 1)
        with open(files[0]) as fh:
            kept = json.load(fh)
        self.assertEqual((kept["thread"], kept["text"]), ("7", out.strip()))
        self.assertTrue(kept["project"].startswith("proj"))
        self.assertEqual(self.cli("advise", "--task-file", "-", input="again", FAKE_ANSWER="ADVICE\nsuggested: answer from state").stdout.strip(),
                         "Understood as: (not stated)\nADVICE\nsuggested: answer from state")
        with open(sorted(glob.glob(os.path.join(adv, "*.json")))[-1]) as fh:
            self.assertEqual(json.load(fh)["thread"], "main")
        p = self.cli("advise", "x", check=False, FAKE_ANSWER="No idea.")
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("ADVICE block", p.stderr)
        self.assertNotEqual(self.cli("advise", check=False).returncode, 0)
        for i in range(55):  # the last 50 are kept
            self.cli("advise", f"r{i}", FAKE_ANSWER="ADVICE\nknown: none")
        self.assertEqual(len(glob.glob(os.path.join(adv, "*.json"))), 50)

    def test_advise_gets_the_recent_requests_and_card_titles_and_echoes_how_it_understood(self):
        self.cli("learn", self.proj)
        self.cli("card", "add", "proj", "export-notes", "--title", "Export retry notes", "--text", "Short note.")
        with open(os.path.join(self.env["LEAN_AGENT_HOME"], "threads.json"), "w") as fh:
            json.dump({"threads": {"t9": {"title": "export", "requests": [
                {"id": f"r{i}", "ts": "2026-01-01T00:00:00", "text": f"request number {i} " + "x" * 400} for i in range(8)]}},
                "aliases": {}, "overrides": {}}, fh)
        out = self.cli("advise", "create the work item and the PR", "--thread", "t9",
                       FAKE_ANSWER="ADVICE\nunderstood: open a work item and a PR\nambiguous: for the export | for the import\n"
                                   "ask the user first: no\nsuggested: answer from state").stdout
        lines = out.splitlines()
        self.assertEqual(lines[0], "Understood as: open a work item and a PR")
        self.assertEqual(lines[1], "Ambiguous: for the export | for the import")
        self.assertIn("ask the user first: yes: which reading?", out)  # an ambiguous request is never "no"
        self.assertNotIn("ask the user first: no", out)
        task = self.calls()[-1]["task"]
        self.assertIn("export-notes: Export retry notes", task)
        self.assertIn("request number 7", task)
        self.assertIn("request number 3", task)
        self.assertNotIn("request number 2", task)  # the last five only
        self.assertNotIn("x" * 250, task)           # trimmed
        append = self.calls()[-1]["append"]
        self.assertIn("user already asked: proceed", append)
        self.assertIn("never run", append)
        self.assertNotIn("cards|", append)

    def test_run_todo_new_makes_the_queue_item_from_why(self):
        self.cli("learn", self.proj)
        out = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "Export: cap the retry loop", "--todo", "new", "t").stdout
        self.assertIn("todo #1: Export: cap the retry loop", out)
        listed = self.cli("todo", "list").stdout
        self.assertIn("#1 [doing] Export: cap the retry loop", listed)

    def test_run_todo_new_makes_one_item_for_all_escalation_attempts(self):
        self.cli("learn", self.proj)
        out = self.cli("run", "-p", "proj", "--escalate", "haiku,sonnet", "--why", "Export: cap the retry loop",
                       "--todo", "new", "t", FAKE_FAIL_MODEL="haiku").stdout
        self.assertEqual(out.count("todo #"), 1)
        self.assertEqual([r["model"] for r in self.ledger()], ["haiku", "sonnet"])
        self.assertEqual([r["todo"] for r in self.ledger()], [1, 1])
        self.assertEqual(self.cli("todo", "list").stdout.count("Export: cap the retry loop"), 1)

    def todo_count(self, text):
        return self.cli("todo", "list", "--all").stdout.count(text)

    def test_todo_new_makes_one_item_for_review_do_decide_gaps_and_the_re_review(self):
        g = self.git_project()
        self.cli("learn", self.proj, "--name", "proj")
        bad = json.dumps(dict(REUSE_CHECKED, verdict="changes-requested", checks=[], findings=[
            {"severity": "major", "file": "api/totals.py", "line": 3, "issue": "rounding drops cents"}]))
        approve = json.dumps(dict(REUSE_CHECKED, verdict="approve", findings=[], checks=[]))
        self.cli("review", "proj", "--head", "feature", "--base", "main", "--todo", "new", check=False, FAKE_REVIEW=bad)
        self.assertEqual(self.todo_count("pre-PR review"), 1)
        g("checkout", "-q", "feature")
        with open(os.path.join(self.proj, "api", "totals.py"), "a") as fh:
            fh.write("# fix\n")
        g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "fix")
        g("checkout", "-q", "main")
        self.cli("review", "proj", "--head", "feature", "--base", "main", "--todo", "new", check=False, FAKE_REVIEW=approve)
        self.assertEqual(self.todo_count("pre-PR review"), 1)
        self.assertEqual(self.todo_count("re-review after fixes"), 0)
        self.assertEqual({r["todo"] for r in self.ledger() if r.get("role") == "reviewer"}, {1})
        gaps = [{"what": "Retry the upload once", "file": "api/totals.py", "line": 3, "blocks_goal": False, "scoped_out": ""}]
        with_gaps = json.dumps(dict(REUSE_CHECKED, verdict="approve", findings=[], checks=[], gaps=gaps))
        g("checkout", "-q", "feature")
        with open(os.path.join(self.proj, "api", "totals.py"), "a") as fh:
            fh.write("# more\n")
        g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "more")
        g("checkout", "-q", "main")
        self.cli("review", "proj", "--head", "feature", "--base", "main", "--full-review", check=False, FAKE_REVIEW=with_gaps)
        fb = '{"status": "done", "used": [], "unneeded": [], "missing": ""}\nLEAN-GAPS ' + json.dumps({"decisions": [
            {"gap": "g1", "action": "decline", "why": "later"}]})
        self.cli("review", "proj", "--head", "feature", "--base", "main", "--decide-gaps", "--todo", "new", check=False,
                 FAKE_FEEDBACK=fb)
        self.assertEqual(self.todo_count("decide the known gaps"), 1)
        self.assertEqual(self.ledger()[-1]["todo"], 2)
        self.cli("recipe", "add", "proj", "item-states", "-m", "sonnet", "--why", "state check", "--read-only",
                 "--task", "Say which state each item should be in.")
        self.cli("do", "proj", "item-states", "--todo", "new")
        self.assertEqual(self.todo_count("recipe item-states"), 1)

    def test_an_explicit_todo_wins_on_a_re_review(self):
        g = self.git_project()
        self.cli("learn", self.proj, "--name", "proj")
        bad = json.dumps(dict(REUSE_CHECKED, verdict="changes-requested", checks=[], findings=[
            {"severity": "major", "file": "api/totals.py", "line": 3, "issue": "rounding drops cents"}]))
        approve = json.dumps(dict(REUSE_CHECKED, verdict="approve", findings=[], checks=[]))
        self.cli("review", "proj", "--head", "feature", "--base", "main", "--todo", "new", check=False, FAKE_REVIEW=bad)
        self.cli("todo", "add", "Another item")
        g("checkout", "-q", "feature")
        with open(os.path.join(self.proj, "api", "totals.py"), "a") as fh:
            fh.write("# fix\n")
        g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "fix")
        g("checkout", "-q", "main")
        self.cli("review", "proj", "--head", "feature", "--base", "main", "--todo", "2", check=False, FAKE_REVIEW=approve)
        self.assertEqual([r["todo"] for r in self.ledger() if r.get("role") == "reviewer"], [1, 2])

    def test_a_re_review_without_todo_inherits_the_earlier_item(self):
        g = self.git_project()
        self.cli("learn", self.proj, "--name", "proj")
        bad = json.dumps(dict(REUSE_CHECKED, verdict="changes-requested", checks=[], findings=[
            {"severity": "major", "file": "api/totals.py", "line": 3, "issue": "rounding drops cents"}]))
        approve = json.dumps(dict(REUSE_CHECKED, verdict="approve", findings=[], checks=[]))
        self.cli("review", "proj", "--head", "feature", "--base", "main", "--todo", "new", check=False, FAKE_REVIEW=bad)
        g("checkout", "-q", "feature")
        with open(os.path.join(self.proj, "api", "totals.py"), "a") as fh:
            fh.write("# fix\n")
        g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "fix")
        g("checkout", "-q", "main")
        self.cli("review", "proj", "--head", "feature", "--base", "main", check=False, FAKE_REVIEW=approve)
        self.assertEqual([r["todo"] for r in self.ledger() if r.get("role") == "reviewer"], [1, 1])
        self.assertEqual(self.todo_count("re-review after fixes"), 0)

    def test_a_refused_launch_leaves_no_todo(self):
        self.cli("learn", self.proj)
        p = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--todo", "new", "--allow-cmd", "x",
                     "t", check=False)  # --allow-cmd without --read-only: refused
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual(self.todo_count("#1"), 0)

    def test_a_refused_todo_new_launch_leaves_no_item_and_advise_handover_have_their_own_run(self):
        self.cli("learn", self.proj)
        p = self.cli("run", "-p", "proj", "-m", "haiku", "--todo", "new", "t", check=False)  # no --why: refused
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual(self.todo_count("#1"), 0)
        self.cli("advise", "Fix the export retry loop", FAKE_ANSWER="Here.\nADVICE\nline 1")
        self.cli("handover", "Weekly plan", "--task-file", "-", input="plan text", FAKE_ANSWER="body")
        self.assertEqual([r.get("role") for r in self.ledger()], ["advisor", "composer"])
        self.assertEqual(self.todo_count("#1"), 0)

    def test_resume_last_skips_reviewer_runs_and_says_when_only_role_runs_exist(self):
        g = self.git_project()
        self.cli("learn", self.proj, "--name", "proj")
        approve = json.dumps(dict(REUSE_CHECKED, verdict="approve", findings=[], checks=[]))
        self.cli("review", "proj", "--head", "feature", "--base", "main", check=False, FAKE_REVIEW=approve)
        p = self.cli("run", "--resume", "last", "x", check=False)
        self.assertIn("no ordinary runs yet", p.stderr)
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--read-only", "look")
        self.cli("review", "proj", "--head", "feature", "--base", "main", "--full-review", check=False, FAKE_REVIEW=approve)
        self.cli("run", "--resume", "last", "and then y")
        ordinary = [r for r in self.ledger() if not r.get("role")][0]
        self.assertEqual(self.calls()[-1]["argv"][self.calls()[-1]["argv"].index("--resume") + 1], ordinary["session_id"])

    def test_role_runs_are_not_resumable_and_never_leave_their_commands_in_the_record(self):
        self.cli("learn", self.proj)
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--read-only", "look at it")
        self.cli("remember", "Never merge on Fridays.", FAKE_ANSWER="REMEMBERED feedback no-friday-merges")
        ordinary, librarian = self.ledger()
        self.assertEqual(librarian["role"], "librarian")
        self.assertEqual(librarian["allow_cmd"], [])
        p = self.cli("run", "--resume", librarian["id"], "and now write", check=False)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("can't be resumed", p.stderr)
        self.cli("run", "--resume", "last", "and then y")  # the ordinary run, not the librarian run after it
        argv = self.calls()[-1]["argv"]
        self.assertEqual(argv[argv.index("--resume") + 1], ordinary["session_id"])
        resumed = self.ledger()[-1]
        self.assertEqual((resumed["resumed"], resumed["allow_cmd"]), (True, []))
        for sub in ("memory", "card", "todo", "handoff"):
            self.assertNotIn(f" {sub}:*", argv[argv.index("--allowedTools") + 1])

    def test_role_commands_use_their_own_run_not_the_latest_one_of_the_role(self):
        self.cli("learn", self.proj)
        sys.path.insert(0, os.path.dirname(CLI))
        import lean_agent as L
        wd = self.tmp.name

        def worker(n, answer):
            d = os.path.join(wd, f"w{n}")
            os.makedirs(d)
            with open(os.path.join(d, "result.json"), "w") as fh:
                fh.write(json.dumps({"result": answer}) + "\n")
            return {"id": f"r{n}", "role": "librarian", "project": "proj", "workdir": d, "status": "done"}

        def interleaved(ns):  # another call's librarian run is written after this call's own
            own, other = worker(1, "REMEMBERED memory mine"), worker(2, "REMEMBERED memory theirs")
            with open(os.path.join(wd, "ledger.jsonl"), "w") as fh:
                fh.write(json.dumps(own) + "\n" + json.dumps(other) + "\n")
            L.LAST_RUN[:] = [own]
            return 0
        open(os.path.join(wd, "ledger.jsonl"), "w").close()
        a = argparse.Namespace(text=["x"], task_file=None, project="proj")
        out = io.StringIO()
        with mock.patch.dict(os.environ, {"LEAN_AGENT_HOME": self.env["LEAN_AGENT_HOME"]}), \
                mock.patch.object(L, "cmd_run", interleaved), \
                mock.patch.object(L, "ledger", lambda: [json.loads(l) for l in open(os.path.join(wd, "ledger.jsonl"))]), \
                contextlib.redirect_stdout(out):
            L.cmd_remember(a)
        self.assertEqual(out.getvalue().strip(), "REMEMBERED memory mine")

    def test_guide_has_the_strict_orchestrator_rules(self):
        with open(os.path.join(os.path.dirname(CLI), "..", "templates", "guide.md")) as fh:
            guide = fh.read()
        flat = " ".join(guide.split())
        for text in ("The orchestrator only orchestrates", "Every user request becomes a worker task",
                     "You never read project files, run project commands", "`lean-agent remember", "`#` memory message", "list/run MCP servers",
                     "--cards auto", "lean-agent review <project> --decide-gaps", "show the user only its summary",
                     "AskUserQuestion, one question per gap", "blocked-run triage", "delegate the decision",
                     'A NEW user request: first `lean-agent advise "<request>"', "deviate only with one line saying why",
                     "unless the user's own request already answers it"):
            self.assertIn(text, flat)

    def test_duplicate_launch_guard_ref_and_extra_cost(self):
        self.cli("learn", self.proj)
        on = dict(LEAN_AGENT_LAUNCH_GUARD="1")
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "count the specs", **on)
        p = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "count the specs", check=False, **on)
        self.assertEqual(p.returncode, 2)
        self.assertIn("the same task finished moments ago", p.stderr)
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--again", "count the specs", **on)
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "count the tests", **on)  # a different task
        # a read-only worker on a branch that isn't checked out
        subprocess.run(["git", "-C", self.proj, "init", "-q", "-b", "main"], check=True)
        subprocess.run(["git", "-C", self.proj, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q",
                        "--allow-empty", "-m", "x"], check=True)
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--read-only", "--ref", "main", "list files")
        self.assertIn("the project's working tree is NOT on it", self.calls()[-1]["append"])
        self.assertIn("show ", self.calls()[-1]["append"])
        out = self.cli("run", "-p", "proj", "-m", "opus", "--why", "x", "hard one").stdout
        self.assertIn("opus costs ~", out)
        self.assertNotIn("saved ~-", out)

    def test_change_focus_on_the_replay_fixture(self):
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures"))
        import review_case
        root = review_case.build(os.path.join(self.tmp.name, "case"))
        sys.path.insert(0, os.path.dirname(CLI))
        import lean_agent as L
        mb = L.git(root, "merge-base", "main", "fix-races")
        fc = L.change_focus(root, [mb, L.git(root, "rev-parse", "fix-races")])
        self.assertEqual(len(fc["tests"]), 4)
        self.assertIn("test/runner.spec.js: 'shares a running check for a scope inside the running scope' "
                      "(renamed or removed)", fc["tests"])
        self.assertEqual(fc["params"], ["capturedAtMs = Date.now() (src/checks/runner.js:41)"])
        self.assertEqual([x.split(" ")[0] for x in fc["state"]], ["queuedScope", "hintShown"])  # `running` existed
        self.assertEqual(fc["renamed"], [])  # the four flips changed what the title says: not pure renames
        # a pure rename (title tweak, same body) needs no coverage entry
        g = lambda *x: subprocess.run(["git", "-C", root, "-c", "user.name=t", "-c", "user.email=t@t", *x],
                                      check=True, capture_output=True)
        g("checkout", "-qb", "rename", "main")
        spec = os.path.join(root, "test", "runner.spec.js")
        with open(spec) as fh:
            text = fh.read()
        with open(spec, "w") as fh:
            fh.write(text.replace("shares an unscoped trigger with a running unscoped check",
                                  "shares an unscoped trigger with the running unscoped check"))
        g("commit", "-qam", "rename a test")
        g("checkout", "-q", "main")
        fr = L.change_focus(root, [L.git(root, "rev-parse", "main"), L.git(root, "rev-parse", "rename")])
        self.assertEqual(fr["tests"], [])
        self.assertEqual(len(fr["renamed"]), 1)
        self.cli("learn", root, "--name", "case")
        out = self.cli("review", "case", "--head", "fix-races", "--base", "main", "--second-opinion", "off",
                       check=False, FAKE_REVIEW=json.dumps({"verdict": "approve", "findings": [], "checks": [],
                                                            "searches": [{"for": "x", "found": "nothing"}],
                                                            "reuse": [{"symbol": n, "verdict": "justified-new"}
                                                                      for n in ("merge", "shareable", "isSent", "takePending")]})).stdout
        self.assertIn("4 edited tests, 1 defaults, 2 module state", out)
        self.assertIn("coverage not checked for 4 of 4 edited tests", out)
        self.assertNotIn("REVIEW: APPROVE", out)
        self.assertIn("reviewer: sonnet, effort high (expected ~$", out)
        self.assertIn("high-risk change (touches", out)
        append = self.calls()[-1]["append"]
        self.assertIn("capturedAtMs = Date.now()", append)
        self.assertIn("4. Tests. For every test the change edits", append)
        # an independent comparison run sees no earlier findings or decisions
        prev = json.dumps({"verdict": "changes-requested", "checks": [], "findings": [
            {"severity": "major", "category": "correctness", "file": "src/checks/runner.js", "line": 25,
             "issue": "uses the request scope"}], "searches": [{"for": "x", "found": "y"}],
            "reuse": [{"symbol": n, "verdict": "justified-new"} for n in ("merge", "shareable", "isSent", "takePending")]})
        self.cli("review", "case", "--head", "fix-races", "--base", "main", "--second-opinion", "off", check=False,
                 FAKE_REVIEW=prev)
        self.cli("review", "decline", "case", "1", "--head", "fix-races", "--why", "not a bug")
        out = self.cli("review", "case", "--head", "fix-races", "--base", "main", "--independent", check=False,
                       FAKE_REVIEW=prev).stdout
        self.assertIn("review: independent", out)
        task = self.calls()[-1]["task"]
        self.assertNotIn("An earlier review", task)
        self.assertNotIn("declined:", task)
        self.assertNotIn("left out", out)  # no decline filtering either
        self.assertIn("1. [major/correctness]", out)
        # two independent passes merged: a finding seen by both is marked, the strictest verdict is kept
        out = self.cli("review", "case", "--head", "fix-races", "--base", "main", "--independent", "--runs", "2",
                       check=False, FAKE_REVIEW=prev).stdout
        self.assertIn("review: 2 independent passes, merged", out)
        self.assertIn("review pass 1: 1 findings", out)
        self.assertIn("uses the request scope [2/2 passes]", out)
        self.assertIn("cost: this review $0.10", out)
        self.assertIn("or --runs 2 (two independent passes", out)
        # estimates learn from their misses: opus was estimated from Sonnet, then fable gets the correction
        self.cli("review", "case", "--head", "fix-races", "--base", "main", "--independent", "--reviewer-model", "opus",
                 check=False, FAKE_REVIEW=prev)
        out = self.cli("review", "case", "--head", "fix-races", "--base", "main", "--independent",
                       "--reviewer-model", "fable", check=False, FAKE_REVIEW=prev).stdout
        self.assertRegex(out, r"reviewer: fable, effort high \(expected ~\$[\d.]+, estimated from Sonnet reviews and "
                              r"the price ratio, corrected x[\d.]+ from \d+ earlier estimate")

    def test_expensive_run_asks_first(self):
        import time as _t
        self.cli("learn", self.proj)
        plan = json.dumps({"status": "allowed", "unifiedWindows": {
            "five_hour": {"utilization": 0.63, "resetsAt": int(_t.time()) + 3600}}})
        p = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "t", FAKE_PLAN=plan)
        self.assertIn("run ", p.stderr)
        self.assertIn(" started · haiku · proj", p.stderr)
        p = self.cli("run", "-p", "proj", "-m", "opus", "--why", "x", "deep review", check=False)
        self.assertEqual(p.returncode, 2)
        self.assertIn("opus run, expected ~", p.stderr)
        self.assertIn("(session window now 63%)", p.stderr)
        self.assertIn("ask the user, then add --yes", p.stderr)
        self.cli("run", "-p", "proj", "-m", "opus", "--why", "x", "--yes", "deep review")
        self.assertIn("Plan (from Claude", self.cli("budget", check=False).stdout)
        self.assertIn("No runs in progress", self.cli("runs", "--running").stdout)

    def test_card_shorten_checks_what_is_kept(self):
        self.cli("learn", self.proj)
        out = self.cli("card", "shorten", "proj", "testing", check=False).stdout
        self.assertIn("lost (not in the shorter text):", out)
        self.assertIn("DOCKER", out)
        p = self.cli("card", "shorten", "proj", "testing", "--save", check=False)
        self.assertIn("not saved", p.stderr)
        good = "## Testing\nRun pytest -q in api/; use the sqlite fixture in tests/conftest.py, never the real db. DOCKER=1 for integration."
        out = self.cli("card", "shorten", "proj", "testing", "--save", FAKE_SHORT=good).stdout
        self.assertIn("saved card testing", out)
        self.assertIn("never the real db", self.cli("card", "show", "proj", "testing").stdout)
        out = self.cli("card", "shorten", "proj", "testing", FAKE_SHORT=good[:-3]).stdout  # barely shorter
        self.assertIn("not worth it", out)

    def test_recipes_and_text_len(self):
        self.cli("learn", self.proj)
        with open(os.path.join(self.proj, ".mcp.json"), "w") as fh:
            json.dump({"mcpServers": {"tracker": {"command": "true"}}}, fh)
        out = self.cli("recipe", "add", "proj", "item-states", "-m", "sonnet", "--why", "state check", "--read-only",
                       "--mcp", "tracker", "--task", "For the items assigned to {who}, say which state each should be in.",
                       "--evidence", "a 'fixed in commit' link on the item", "--evidence", "a PR linked to the item",
                       "--apply-task", "Move the items for {who} to the states the check said.").stdout
        self.assertIn("saved recipe item-states for proj", out)
        self.assertRegex(out, r"lean-agent do proj-\w+ item-states who=\.\.\. \[--apply\]")
        self.assertIn("item-states", self.cli("recipes").stdout)
        p = self.cli("do", "proj", "item-states", check=False)
        self.assertIn("needs who=...", p.stderr)
        self.cli("do", "proj", "item-states", "who=me")
        call = self.calls()[-1]
        self.assertIn("For the items assigned to me, say which state", call["task"])
        self.assertIn("1. a 'fixed in commit' link on the item", call["task"])
        self.assertEqual(call["argv"][call["argv"].index("--model") + 1], "sonnet")
        self.assertIn("default", call["argv"])  # read-only permission mode
        self.cli("do", "proj", "item-states", "who=me", "--apply")
        call = self.calls()[-1]
        self.assertIn("Nothing is approved yet", call["task"])
        self.assertIn("acceptEdits", call["argv"])  # the apply step may change things (after approval)
        self.cli("do", "proj", "item-states", "who=me", "--apply", "--allow-send", "move the 3 listed items")
        self.assertIn("The user approved: move the 3 listed items", self.calls()[-1]["task"])
        self.assertIn("The check (run ", self.calls()[-1]["task"])  # the apply step reuses the check's answer
        self.assertIn("Did the thing.", self.calls()[-1]["task"])
        self.cli("do", "proj", "item-states", "who=me", "--apply", "--fresh")
        self.assertNotIn("The check (run ", self.calls()[-1]["task"])
        # a complete recipe: every item listed, or the run fails
        self.cli("recipe", "add", "proj", "all-items", "-m", "haiku", "--why", "x", "--read-only", "--complete",
                 "--fields", "id,title,state", "--task", "List the state of each open item.")
        p = self.cli("do", "proj", "all-items", check=False)
        self.assertEqual(p.returncode, 1)
        self.assertIn("INCOMPLETE: the worker didn't report", p.stdout)
        self.assertIn("just these fields: id,title,state", self.calls()[-1]["task"])
        fb = '{"status": "done", "used": [], "unneeded": [], "missing": ""}'
        p = self.cli("do", "proj", "all-items", "--again", check=False,
                     FAKE_FEEDBACK=fb + '\nLEAN-ITEMS {"total": 24, "listed": 20, "missing": ["7", "9"]}')
        self.assertIn("INCOMPLETE: 20 of 24 items listed; missing: 7, 9", p.stdout)
        p = self.cli("do", "proj", "all-items", "--again", FAKE_FEEDBACK=fb + '\nLEAN-ITEMS {"total": 24, "listed": 24}')
        self.assertIn("complete: all 24 items covered", p.stdout)
        self.cli("tracker", "proj", "--note", "PR descriptions are limited to 4000 characters")
        f = os.path.join(self.tmp.name, "desc.md")
        with open(f, "w") as fh:
            fh.write("x" * 4200)
        out = self.cli("text-len", f, "-p", "proj").stdout
        self.assertIn("4,200 characters", out)
        self.assertIn("over the 4,000-character limit", out)

    def test_tracker_conflicts_pair_by_type(self):
        sys.path.insert(0, os.path.dirname(CLI))
        import lean_agent as L
        conf = {"notes": ["User Story states: New, Active, Completed, Closed (no Removed)", "Bugs go through review"],
                "discovered": {"states": {"Bug": {"states": ["New", "Doing", "In Review", "Shipped", "Closed"],
                                                  "source": "items"},
                                          "User Story": {"states": ["Proposed", "Active", "Scheduled", "Completed", "Closed"],
                                                         "source": "both"}}}}
        found = L.note_conflicts(conf)
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0][0], 1)
        self.assertTrue(found[0][2].startswith("User Story states"), found)

    def test_optimize_skip_protect_unarchive(self):
        self.cli("learn", self.proj)
        sys.path.insert(0, os.path.dirname(CLI))
        import lean_agent as L
        os.environ["LEAN_AGENT_HOME"] = self.env["LEAN_AGENT_HOME"]
        try:
            slug = [x for x in L.projects()][0]
            cards = L.load_cards(slug)
            for c in cards:
                c.update(offered=6, used=0, unneeded=6, core=False, core_types=[])
            L.save_cards(slug, cards)
        finally:
            os.environ.pop("LEAN_AGENT_HOME", None)
        out = self.cli("optimize", "proj").stdout
        self.assertIn("archive style", out)
        self.assertIn("archive testing", out)
        self.assertIn("protected: optimize won't archive", self.cli("card", "protect", "proj", "testing").stdout)
        out = self.cli("optimize", "proj", "--apply", "--skip", "style").stdout
        self.assertIn("(protected cards are not listed: archive testing", out)
        self.assertIn("Skipped: style.", out)
        listing = self.cli("cards", "proj").stdout
        self.assertIn(" style ", listing)  # not archived
        self.assertIn(" testing ", listing)
        out = self.cli("optimize", "proj", "--apply").stdout
        self.assertIn("applied: archive style  (undo: lean-agent card unarchive", out)
        self.assertNotIn(" style ", self.cli("cards", "proj").stdout)
        self.assertIn("unarchive style: ok", self.cli("card", "unarchive", "proj", "style").stdout)
        self.assertIn(" style ", self.cli("cards", "proj").stdout)
        self.cli("optimize", "proj", "--apply")
        out = self.cli("card", "core", "proj", "style").stdout  # core on an archived card unarchives it
        self.assertIn("unarchived it", out)
        self.assertIn("*style ", self.cli("cards", "proj").stdout)  # core and live

    def _archivable(self):
        self.cli("learn", self.proj)
        sys.path.insert(0, os.path.dirname(CLI))
        import lean_agent as L
        os.environ["LEAN_AGENT_HOME"] = self.env["LEAN_AGENT_HOME"]
        try:
            slug = [x for x in L.projects()][0]
            cards = L.load_cards(slug)
            for c in cards:
                c.update(offered=6, used=0, unneeded=6, core=False, core_types=[])
            L.save_cards(slug, cards)
        finally:
            os.environ.pop("LEAN_AGENT_HOME", None)

    def test_optimize_json_and_apply_by_id(self):
        self._archivable()
        res = json.loads(self.cli("optimize", "proj", "--json").stdout)
        self.assertTrue(res["project"].startswith("proj"))
        sug = {x["id"]: x for x in res["suggestions"]}
        self.assertIn("archive:style", sug)
        self.assertEqual(sorted(sug["archive:style"]), ["card", "id", "kind", "meta", "offered", "reason", "used"])
        self.assertEqual((sug["archive:style"]["used"], sug["archive:style"]["offered"], sug["archive:style"]["meta"]),
                         (0, 6, "used in 0 of 6 runs"))
        self.assertEqual((sug["archive:style"]["kind"], sug["archive:style"]["card"]), ("archive", "style"))
        self.assertIn("unneeded", sug["archive:style"]["reason"])
        self.assertIsInstance(res["drafts"], list)
        # --apply <ids> applies only those
        out = self.cli("optimize", "proj", "--apply", "archive:style,archive:nope").stdout
        self.assertIn("applied: archive style", out)
        self.assertIn("no open suggestion archive:nope", out)
        listing = self.cli("cards", "proj").stdout
        self.assertNotIn(" style ", listing)
        self.assertIn(" testing ", listing)
        left = json.loads(self.cli("optimize", "proj", "--json").stdout)
        self.assertNotIn("archive:style", [x["id"] for x in left["suggestions"]])
        self.assertIn("archive:testing", [x["id"] for x in left["suggestions"]])
        # rejecting a suggestion hides it for good
        self.cli("optimize", "proj", "--reject", "archive:testing")
        left = json.loads(self.cli("optimize", "proj", "--json").stdout)
        self.assertNotIn("archive:testing", [x["id"] for x in left["suggestions"]])
        self.assertIn(" testing ", self.cli("cards", "proj").stdout)

    def test_optimize_rejected_card_suggestion_stays_hidden_and_unreject_brings_it_back(self):
        self._archivable()
        ids = lambda *args: [x["id"] for x in json.loads(self.cli("optimize", "proj", "--json", *args).stdout)["suggestions"]]
        self.assertIn("archive:testing", ids())
        out = self.cli("optimize", "proj", "--reject", "archive:testing").stdout
        self.assertIn("rejected archive:testing: won't be proposed again", out)
        for _ in range(2):  # later runs, with or without --json, leave it out
            self.assertNotIn("archive:testing", ids())
            self.assertNotIn("archive testing", self.cli("optimize", "proj").stdout)
        self.assertNotIn("archive:testing", ids("--min-runs", "1"))
        # --unreject proposes it again; what was never rejected is said so
        out = self.cli("optimize", "proj", "--unreject", "archive:testing,archive:style").stdout
        self.assertIn("unrejected archive:testing", out)
        self.assertIn("archive:style was not rejected", out)
        self.assertIn("archive:testing", ids())
        self.assertIn("archive testing", self.cli("optimize", "proj").stdout)
        # with --json the result is still only JSON
        res = json.loads(self.cli("optimize", "proj", "--unreject", "archive:testing", "--json").stdout)
        self.assertIn("archive:testing", [x["id"] for x in res["suggestions"]])

    def test_run_requires_model_and_why(self):
        self.cli("learn", self.proj)
        p = self.cli("run", "-p", "proj", "do it", check=False)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("choose a model", p.stderr)
        p = self.cli("run", "-p", "proj", "-m", "sonnet", "do it", check=False)
        self.assertIn("--why", p.stderr)

    def test_run_isolated_worker_and_learning(self):
        self.cli("learn", self.proj)
        fb = json.dumps({"status": "done", "used": ["testing"], "unneeded": ["style"],
                         "missing": "where the sqlite fixture lives"})
        out = self.cli("run", "-p", "proj", "-m", "sonnet", "--why", "code change", "--cards", "testing,style",
                       "fix the test", FAKE_FEEDBACK=fb).stdout
        self.assertIn("sonnet · done · 3 turns", out)
        self.assertIn("Did the thing.", out)
        self.assertNotIn("LEAN-FEEDBACK", out)

        call = self.calls()[0]
        argv = call["argv"]
        for flag in ("--safe-mode", "--disable-slash-commands", "--add-dir"):
            self.assertIn(flag, argv)
        self.assertEqual(argv[argv.index("--model") + 1], "sonnet")
        self.assertEqual(argv[argv.index("--add-dir") + 1], self.proj)
        self.assertNotEqual(os.path.realpath(call["cwd"]), os.path.realpath(self.proj))
        self.assertIsNone(call["addclaudemd"])
        self.assertRegex(call["task"], r"^Today is \w+day \d{4}-\d\d-\d\d, \d\d:\d\d .*\(UTC[+-]\d\d:\d\d\)\.\n\nfix the test$")
        self.assertIn("sqlite fixture", call["append"])      # testing card sent
        self.assertNotIn("pnpm", call["append"])             # web card not sent

        cards = self.cli("cards", "proj").stdout
        self.assertRegex(cards, r"testing\s+claude-md\s+\d+\s+1/1")
        self.assertRegex(cards, r"style\s+claude-md\s+\d+\s+0/1")
        stats = self.cli("stats").stdout
        self.assertIn("sonnet", stats)
        # weighted = 100 + 1000 + 500 + 1500
        self.assertIn("3,100", stats)
        opt = self.cli("optimize", "proj", "--min-runs", "1").stdout
        self.assertIn("where the sqlite fixture lives", opt)

    def test_read_only_and_resume(self):
        self.cli("learn", self.proj)
        out = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "search", "--read-only", "find x").stdout
        run_id = out.split()[1]
        self.cli("run", "--resume", run_id, "now also y")
        first, second = self.calls()
        for call in (first, second):
            argv = call["argv"]
            self.assertEqual(argv[argv.index("--tools") + 1], "Read,Glob,Grep,Bash")
            allowed = argv[argv.index("--allowedTools") + 1].split(",")
            self.assertIn(f"Bash(git -C {self.proj} show:*)", allowed)
            self.assertNotIn("Bash", allowed)  # only the read-only git patterns
            self.assertEqual(argv[argv.index("--permission-mode") + 1], "default")
            self.assertIn(f"git -C {self.proj}", call["append"])
        self.assertEqual(second["argv"][second["argv"].index("--resume") + 1], "sess-1")

    def test_task_file_dash_reads_stdin_and_resume_last(self):
        self.cli("learn", self.proj)
        env = dict(self.env)
        p = subprocess.run([sys.executable, CLI, "run", "-p", "proj", "-m", "haiku", "--why", "stdin task", "--read-only",
                            "--task-file", "-"], input="find the stdin marker\n", capture_output=True, text=True, env=env)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("find the stdin marker", self.calls()[-1]["task"])
        self.cli("run", "--resume", "last", "and then y")
        self.assertEqual(self.calls()[-1]["argv"][self.calls()[-1]["argv"].index("--resume") + 1], "sess-1")
        self.assertEqual(self.cli("run", "--resume", "nope", "x", check=False).returncode, 1)

    def test_optimize_promotes_core_per_task_type(self):
        self.cli("learn", self.proj)
        fb = json.dumps({"status": "done", "used": ["testing"], "unneeded": ["style"], "missing": ""})
        for _ in range(4):
            self.cli("run", "-p", "proj", "-m", "sonnet", "--why", "x", "--cards", "testing,style", "fix bug",
                     FAKE_FEEDBACK=fb)
        self.assertNotIn("core    testing", self.cli("optimize", "proj").stdout)  # 4 < 5 runs
        self.cli("run", "-p", "proj", "-m", "sonnet", "--why", "x", "--cards", "testing,style", "fix bug",
                 FAKE_FEEDBACK=fb)
        out = self.cli("optimize", "proj", "--apply").stdout
        self.assertIn("core    testing", out)
        self.assertIn("for change tasks", out)
        self.assertIn("archive style", out)
        self.cli("run", "-p", "proj", "-m", "sonnet", "--why", "x", "implement the next step", FAKE_FEEDBACK=fb)
        self.assertIn("sqlite fixture", self.calls()[-1]["append"])  # core for change tasks
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--read-only", "which file has the fixture",
                 FAKE_FEEDBACK=fb)
        self.assertNotIn("sqlite fixture", self.calls()[-1]["append"])  # but not for read tasks

    def test_suggest_relevance_cost_model_and_split(self):
        self.cli("learn", self.proj)
        big = "Detailed VS Code extension maintenance guide. " * 300
        self.cli("card", "add", "proj", "vscode-extension", "--title", "skill vscode-extension", "--text",
                 big + " Also mentions a reply message and the team.")
        out = self.cli("suggest", "proj", "post a reply message in Teams to the team").stdout
        self.assertIn("task type: browser", out)
        self.assertNotIn("vscode-extension", out.split("No relevant")[0] if "No relevant" in out else out)
        out = self.cli("suggest", "proj", "quantum entanglement of teapots").stdout
        self.assertIn("No relevant cards", out)
        self.assertIn("Run without --cards", out)
        out = self.cli("suggest", "proj", "fix the failing pytest database fixture").stdout
        self.assertIn("total ~", out)
        self.assertIn("recommended: -m sonnet", out)
        out = self.cli("suggest", "proj", "investigate the fixture setup and decide whether to replace it").stdout
        self.assertIn("split: 1) -m haiku --read-only gathers", out)
        for _ in range(3):
            self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "fix the fixture")
        self.assertIn("recommended: -m haiku", self.cli("suggest", "proj", "fix the fixture name").stdout)

    def test_parallel_runs_keep_all_stats(self):
        self.cli("learn", self.proj)
        fb = json.dumps({"status": "done", "used": ["testing"], "unneeded": [], "missing": ""})
        env = dict(self.env, FAKE_FEEDBACK=fb, FAKE_FINISH_AT=str(time.time() + 1.5))
        procs = [subprocess.Popen([sys.executable, CLI, "run", "-p", "proj", "-m", "haiku", "--why", "x",
                                   "--cards", "testing", f"task {i}"], env=env, stdin=subprocess.DEVNULL,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) for i in range(16)]
        self.assertEqual([p.wait() for p in procs], [0] * 16)
        self.assertRegex(self.cli("cards", "proj").stdout, r"testing\s+claude-md\s+\d+\s+16/16")
        self.assertIn("haiku             16", self.cli("stats").stdout)

    def write_usage(self, project_dir, hours_ago, model, input_tokens, mid):
        import datetime as dt, re as _re
        d = os.path.join(self.env["CLAUDE_CONFIG_DIR"], "projects", project_dir)
        os.makedirs(d, exist_ok=True)
        ts = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=hours_ago)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        with open(os.path.join(d, "s.jsonl"), "a") as fh:
            fh.write(json.dumps({"type": "assistant", "timestamp": ts, "message": {"id": mid, "model": model,
                     "usage": {"input_tokens": input_tokens, "output_tokens": 0}}}) + "\n")

    def lean_project_dir(self, suffix):
        import re as _re
        return _re.sub(r"[^A-Za-z0-9]", "-", os.path.realpath(self.env["LEAN_AGENT_HOME"])) + suffix

    def test_window_budgets(self):
        self.cli("learn", self.proj)
        os.makedirs(self.env["LEAN_AGENT_HOME"], exist_ok=True)
        work = self.lean_project_dir("-work-0101-000000-abcd")
        self.write_usage(work, 1, "claude-fable-5-1", 10000, "a")     # 5x -> 50,000 now
        self.write_usage(work, 7, "claude-haiku-5-5", 100000, "b")    # 0.05x -> 5,000, outside 5h
        self.write_usage(work, 3 * 24, "claude-sonnet-5-5", 20000, "c")  # 1x -> 20,000, this week
        self.write_usage("-Users-me-other-project", 1, "claude-opus-5-5", 10000, "d")  # not lean: 20,000
        out = self.cli("limits").stdout
        self.assertIn("Last 5 hours: lean-agent 50,000 | all Claude Code here 70,000", out)
        self.assertIn("Last 7 days : lean-agent 75,000 | all Claude Code here 95,000", out)
        self.assertIn("by model: fable 50,000, sonnet 20,000, opus 20,000, haiku 5,000", out)
        self.cli("limits", "--5h", "40000", "--week", "1000000")
        self.assertIn("50,000 of 40,000 (125%), frees up from", self.cli("limits").stdout)
        p = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "t", check=False)
        self.assertEqual(p.returncode, 3)
        self.assertIn("5-hour budget used up", p.stderr)
        self.cli("limits", "--5h", "0", "--week", "60000")
        p = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "t", check=False)
        self.assertIn("weekly budget used up", p.stderr)
        self.cli("limits", "--off")
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "t")

    def test_plan_windows_and_calibration(self):
        import datetime as dt
        os.makedirs(self.env["LEAN_AGENT_HOME"], exist_ok=True)
        work = self.lean_project_dir("-work-0101-000000-abcd")
        self.write_usage(work, 1, "claude-sonnet-5-5", 30000, "a")       # this session
        self.write_usage(work, 6, "claude-sonnet-5-5", 99000, "b")       # previous session
        self.write_usage("-Users-me-other", 2, "claude-fable-5-1", 2000, "c")  # 5x -> 10,000, not lean
        out = self.cli("limits").stdout
        self.assertIn("Windows roll", out)
        reset = (dt.datetime.now() + dt.timedelta(hours=3)).strftime("%H:%M")
        out = self.cli("limits", "plan", "--session-resets", reset, "--week-resets", "Sat 12:00").stdout
        self.assertRegex(out, r"Session \(\w{3} \d\d:\d\d to \w{3} \d\d:\d\d\): lean-agent 30,000 \| all Claude Code here 40,000")
        out = self.cli("limits", "calibrate", "session=20", "week=10", "fable=4").stdout
        self.assertIn("default weights", out)
        self.assertIn("plan ≈ 20%", out)
        self.assertIn("fable 10,000 (≈ 4% of its own limit)", out)
        self.cli("limits", "--session-pct", "15")
        p = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "t", check=False)
        self.assertEqual(p.returncode, 3)
        self.assertIn("20% of your plan's session limit (you allowed agents up to 15%)", p.stderr)
        self.cli("limits", "--session-pct", "50")
        self.assertIn("can't read 'bogus=3'", self.cli("limits", "calibrate", "bogus=3", check=False).stderr)
        # a reset in the past: the next session starts with the first message after it
        lim = os.path.join(self.env["LEAN_AGENT_HOME"], "limits.json")
        with open(lim) as fh:
            d = json.load(fh)
        d["plan"]["session_reset"] = (dt.datetime.now().astimezone() - dt.timedelta(hours=1, minutes=30)).isoformat()
        with open(lim, "w") as fh:
            json.dump(d, fh)
        self.assertIn("lean-agent 30,000", self.cli("limits").stdout)
        d["plan"]["session_reset"] = (dt.datetime.now().astimezone() - dt.timedelta(minutes=30)).isoformat()
        with open(lim, "w") as fh:
            json.dump(d, fh)
        self.assertIn("no session since the last reset", self.cli("limits").stdout)

    def test_calibration_fits_weights(self):
        sys.path.insert(0, os.path.dirname(CLI))
        import usage
        os.environ["LEAN_AGENT_HOME"] = self.env["LEAN_AGENT_HOME"]
        try:
            # true weights: cache read 0.05, output 8; cap 1,000,000 plan units
            pts = []
            for a, b, c in ((100000, 2000000, 5000), (50000, 4000000, 20000), (200000, 500000, 1000), (80000, 3000000, 9000)):
                pts.append({"ts": "x", "window": "session", "pct": (a + 0.05 * b + 8 * c) / 10000, "x": [a, b, c]})
            os.makedirs(self.env["LEAN_AGENT_HOME"], exist_ok=True)
            usage.save_limits({"points": pts})
            cfg = usage.calibrate({})
            self.assertAlmostEqual(cfg["weights"]["cache_read"], 0.05, places=3)
            self.assertAlmostEqual(cfg["weights"]["output"], 8, places=2)
            self.assertAlmostEqual(cfg["caps"]["session"], 1000000, delta=10)
        finally:
            os.environ.pop("LEAN_AGENT_HOME", None)

    def test_real_plan_usage_from_claude(self):
        import time as _t
        self.cli("learn", self.proj)
        self.assertIn("Plan (from Claude): not seen yet", self.cli("limits").stdout)
        soon, later = int(_t.time()) + 3600, int(_t.time()) + 4 * 86400
        plan = json.dumps({"status": "allowed", "unifiedWindows": {
            "five_hour": {"utilization": 0.37, "resetsAt": soon}, "seven_day": {"utilization": 0.12, "resetsAt": later},
            "seven_day_opus": {"utilization": 0.08, "resetsAt": later}}})
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "t", FAKE_PLAN=plan)
        out = self.cli("limits").stdout
        self.assertRegex(out, r"Plan \(from Claude, 0 min ago\): session 37% \(resets \w{3} \d\d:\d\d\) · week 12%")
        self.assertIn("opus week 8%", out)
        self.assertIn("| plan 37%", out)
        self.assertIn("come from Claude itself", out)
        self.cli("limits", "--session-pct", "30")
        p = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "t", check=False)
        self.assertEqual(p.returncode, 3)
        self.assertIn("37% of your plan's session limit", p.stderr)
        self.cli("limits", "--session-pct", "0")
        plan2 = json.dumps({"status": "allowed", "unifiedWindows": {"five_hour": {"utilization": 0.05, "resetsAt": soon}}})
        self.assertIn("session 5%", self.cli("limits", "--refresh", FAKE_PLAN=plan2).stdout)

    def test_window_hook_only_in_lean_home(self):
        home = self.cli("home").stdout.strip()
        self.write_usage(self.lean_project_dir("-home"), 1, "claude-sonnet-5-5", 50000, "a")
        self.cli("limits", "--5h", "10000")
        hook = os.path.join(os.path.dirname(CLI), "budget_hook.py")
        transcript = os.path.join(self.tmp.name, "t.jsonl")
        open(transcript, "w").close()

        def call(cwd, command="ls"):
            ev = {"session_id": "s", "transcript_path": transcript, "cwd": cwd, "tool_name": "Bash",
                  "tool_input": {"command": command}}
            p = subprocess.run([sys.executable, hook], input=json.dumps(ev), capture_output=True, text=True,
                               env=self.env)
            return json.loads(p.stdout)["hookSpecificOutput"]["permissionDecision"] if p.stdout.strip() else None
        self.assertEqual(call(home), "deny")
        self.assertIsNone(call(self.proj))                      # normal sessions are never blocked
        self.assertIsNone(call(home, "lean-agent limits --5h 0"))  # the user can still raise it

    def test_max_budget_status(self):
        self.cli("learn", self.proj)
        p = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "t", check=False,
                     FAKE_SUBTYPE="error_max_budget_usd")
        self.assertIn("stopped:max_budget_usd", p.stdout)
        self.assertEqual(p.returncode, 1)

    def test_a_failed_run_ends_with_its_reason_and_runs_show_tail_keeps_it(self):
        self.cli("learn", self.proj)
        p = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "t", check=False, FAKE_SUBTYPE="error_max_turns")
        last = p.stdout.strip().splitlines()[-1]
        rid = p.stdout.split("run ")[1].split()[0]
        self.assertEqual(last, f"run {rid} failed: hit its turn limit (--max-turns)")
        p = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "t", check=False, FAKE_SUBTYPE="error_max_budget_usd")
        self.assertIn("failed: hit its budget (--max-usd)", p.stdout.strip().splitlines()[-1])
        p = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "t", check=False, FAKE_SELF_KILL="1")
        self.assertRegex(p.stdout.strip().splitlines()[-1], r"^run \S+ failed: .+")
        ok = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "t").stdout
        self.assertNotIn(" failed: ", ok)
        tail = self.cli("runs", "--show", rid, "--tail", "3").stdout.splitlines()
        self.assertEqual(len(tail), 3)
        self.assertEqual(tail[-1], last)
        self.assertGreater(len(self.cli("runs", "--show", rid, "--tail").stdout.splitlines()), 3)

    def test_logs_list_the_newest_entries_first_with_a_default_of_ten_and_filter_by_run(self):
        log_dir = os.path.join(self.env["LEAN_AGENT_HOME"], "logs")
        os.makedirs(log_dir, exist_ok=True)
        with open(os.path.join(log_dir, "error.log"), "w") as fh:
            for i in range(15):
                fh.write(f"2026-01-01 00:00:{i:02d} ERROR run: r{i % 3} entry {i}\n    detail {i}\n")
        out = self.cli("logs").stdout
        entries = [l for l in out.splitlines() if "ERROR run" in l]
        self.assertEqual(len(entries), 10)
        self.assertIn("entry 14", entries[0])
        self.assertIn("entry 5", entries[-1])
        self.assertIn("(10 of 15 entries, newest first", out)
        out = self.cli("logs", "--run", "r1", "-n", "2").stdout
        entries = [l for l in out.splitlines() if "ERROR run" in l]
        self.assertEqual([e.split("entry ")[1] for e in entries], ["13", "10"])
        self.assertIn("(2 of 5 entries", out)

    def test_trust_write_config(self):
        cfg_dir = os.path.join(self.tmp.name, "cfg")
        with open(os.path.join(cfg_dir, ".claude.json"), "w") as fh:
            json.dump({"projects": {"/other": {"hasTrustDialogAccepted": True}}, "keep": 1}, fh)
        out = self.cli("trust", "--write-config", CLAUDE_CONFIG_DIR=cfg_dir).stdout
        self.assertIn("Marked", out)
        with open(os.path.join(cfg_dir, ".claude.json")) as fh:
            data = json.load(fh)
        home = self.cli("home").stdout.strip()
        self.assertTrue(data["projects"][home]["hasTrustDialogAccepted"])
        self.assertEqual(data["keep"], 1)
        self.assertTrue(data["projects"]["/other"]["hasTrustDialogAccepted"])
        self.assertIn("already trusted", self.cli("trust", CLAUDE_CONFIG_DIR=cfg_dir).stdout)

    def test_mcp_list_and_tools(self):
        self.cli("learn", self.proj)
        out = self.cli("mcp", "list", "-p", "proj", "--probe").stdout
        self.assertRegex(out, r"tickets\s+stdio\s+user\s+2\s")
        self.assertRegex(out, r"docs\s+http\s+project\s+\?")
        self.assertRegex(out, r"localdb\s+http\s+local")
        tools = self.cli("mcp", "tools", "tickets").stdout
        self.assertIn("search_tickets", tools.splitlines()[0])  # biggest first
        self.assertIn("get_ticket", tools)

    def test_run_with_mcp_tool_subset(self):
        self.cli("learn", self.proj)
        out = self.cli("run", "-p", "proj", "-m", "sonnet", "--why", "needs ticket", "--mcp", "tickets:get_ticket",
                       "read ticket T-1", FAKE_MCP_CALL="mcp__tickets__get_ticket").stdout
        self.assertIn("mcp: mcp__tickets__get_ticket x1", out)
        call = self.calls()[-1]
        argv = call["argv"]
        self.assertNotIn("--safe-mode", argv)
        self.assertEqual(argv[argv.index("--setting-sources") + 1], "")
        self.assertIn("--strict-mcp-config", argv)
        self.assertEqual(argv[argv.index("--disallowedTools") + 1], "mcp__tickets__search_tickets")
        self.assertIn("mcp__tickets__get_ticket", argv[argv.index("--allowedTools") + 1].split(","))
        self.assertEqual(call["mcp"]["servers"], {"tickets": self.mcp_cfg})
        self.assertEqual(call["mcp"]["mode"], "0o600")
        self.assertFalse(os.path.exists(call["mcp"]["path"]))  # removed after the run
        with open(os.path.join(self.env["LEAN_AGENT_HOME"], "ledger.jsonl")) as fh:
            self.assertNotIn("s3cret", fh.read())

    def test_run_mcp_whole_server_and_errors(self):
        self.cli("learn", self.proj)
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--mcp", "tickets", "t")
        argv = self.calls()[-1]["argv"]
        self.assertIn("mcp__tickets", argv[argv.index("--allowedTools") + 1].split(","))
        self.assertNotIn("--disallowedTools", argv)
        p = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--mcp", "nope", "t", check=False)
        self.assertIn("unknown MCP server", p.stderr)
        p = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--mcp", "tickets:missing_tool", "t", check=False)
        self.assertIn("has no tool", p.stderr)
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "t")
        self.assertIn("--safe-mode", self.calls()[-1]["argv"])  # no MCP -> safe mode as before

    def test_plugin_mcp_servers(self):
        cfg = self.env["CLAUDE_CONFIG_DIR"]
        root = os.path.join(cfg, "plugins", "cache", "mkt", "dd", "1.0.0")
        os.makedirs(os.path.join(root, ".claude-plugin"))
        with open(os.path.join(root, ".claude-plugin", "plugin.json"), "w") as fh:
            json.dump({"name": "dd", "userConfig": {"site": {"type": "string", "default": "example.com"}}}, fh)
        with open(os.path.join(root, ".mcp.json"), "w") as fh:
            json.dump({"mcpServers": {"mcp": {"type": "http", "url": "https://mcp.${user_config.site}/v1/mcp?v=1",
                                              "headers": {"X-Root": "${CLAUDE_PLUGIN_ROOT}"}}}}, fh)
        with open(os.path.join(cfg, "plugins", "installed_plugins.json"), "w") as fh:
            json.dump({"version": 2, "plugins": {"dd@mkt": [{"scope": "user", "installPath": root}]}}, fh)
        settings = {"enabledPlugins": {"dd@mkt": True}, "pluginConfigs": {"dd@mkt": {"options": {"site": "example.eu"}}}}
        with open(os.path.join(cfg, "settings.json"), "w") as fh:
            json.dump(settings, fh)
        tools = json.dumps({"plugin:dd:mcp": ["search_logs", "get_monitor", "create_monitor", "query_metrics"]})
        env = dict(FAKE_HTTP_URL="mcp.example.eu/v1/mcp", FAKE_HTTP_TOOLS=tools)
        out = self.cli("mcp", "list", **env).stdout
        self.assertIn("plugin:dd:mcp", out)
        self.assertIn("--mcp dd:...", out)
        out = self.cli("mcp", "tools", "dd", **env).stdout
        self.assertIn("search_logs", out)
        self.assertIn("1,600 tok  total for 4 tools", out)
        self.assertIn("read  3 tools ~1,200 tok  automatic: the get/list/search tools\n    get_monitor, query_metrics, search_logs", self.cli("mcp", "preset", "dd", **env).stdout)
        self.cli("learn", self.proj)
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--mcp", "dd:read", "check logs", **env)
        call = self.calls()[-1]
        server = call["mcp"]["servers"]["plugin:dd:mcp"]  # same name and config: Claude Code's stored login applies
        self.assertEqual(server, {"type": "http", "url": "https://mcp.example.eu/v1/mcp?v=1", "headers": {"X-Root": root}})
        argv = call["argv"]
        self.assertIn("mcp__plugin_dd_mcp__create_monitor", argv[argv.index("--disallowedTools") + 1])
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--mcp", "plugin:dd:mcp:search_logs", "t", **env)
        self.assertIn("mcp__plugin_dd_mcp__search_logs", " ".join(self.calls()[-1]["argv"]))
        doc = self.cli("doctor", check=False, **env).stdout
        self.assertIn("plugin MCP server plugin:dd:mcp: usable by workers (4 tools; --mcp dd:<preset|tools>)", doc)
        settings["pluginConfigs"]["dd@mkt"]["options"]["site"] = "example.org"  # login doesn't match: needs-auth
        with open(os.path.join(cfg, "settings.json"), "w") as fh:
            json.dump(settings, fh)
        doc = self.cli("doctor", check=False, **env).stdout
        self.assertIn("plugin MCP server plugin:dd:mcp: needs-auth as a worker", doc)
        listed = "plugin:dd:mcp: https://mcp.example.eu/v1/mcp?v=1 (HTTP) - ✓ Connected"
        doc = self.cli("doctor", check=False, FAKE_MCP_LIST=listed, **env).stdout
        self.assertIn("Claude Code connects to https://mcp.example.eu/v1/mcp?v=1 but lean-agent built "
                      "https://mcp.example.org/v1/mcp?v=1", doc)
        doc = self.cli("doctor", check=False, FAKE_MCP_LIST=listed.replace("✓ Connected", "! Needs authentication"),
                       **env).stdout
        self.assertIn("needs-auth in Claude Code itself", doc)
        self.assertIn("/mcp, pick it, Authenticate", doc)
        settings["enabledPlugins"]["dd@mkt"] = False
        with open(os.path.join(cfg, "settings.json"), "w") as fh:
            json.dump(settings, fh)
        self.assertNotIn("plugin:dd", self.cli("mcp", "list", **env).stdout)

    def test_synced_plugin_mcp_server(self):
        """The layout of a plugin synced from claude.ai, with ${VAR:-default} and the settings `env` block."""
        cfg = self.env["CLAUDE_CONFIG_DIR"]
        bucket = os.path.join(cfg, "plugins", "synced", "abc_def")
        root = os.path.join(bucket, "1111-2222")
        os.makedirs(os.path.join(root, ".claude-plugin"))
        with open(os.path.join(bucket, "manifest.json"), "w") as fh:
            json.dump({"plugins": [{"name": "1111-2222", "marketplaceName": "dir"}]}, fh)
        with open(os.path.join(root, ".claude-plugin", "plugin.json"), "w") as fh:
            json.dump({"name": "obs", "mcpServers": "./.obs_mcp.json"}, fh)
        with open(os.path.join(root, ".obs_mcp.json"), "w") as fh:
            json.dump({"mcpServers": {"mcp": {"type": "http", "url": "https://${OBS_DOMAIN:-not-setup}/v1/mcp",
                                              "headers": {"API_KEY": "${OBS_KEY:-}", "T": "${OBS_TOKEN}"}}}}, fh)
        with open(os.path.join(cfg, "settings.json"), "w") as fh:
            json.dump({"env": {"OBS_DOMAIN": "mcp.example.eu"}}, fh)
        sys.path.insert(0, os.path.dirname(CLI))
        import lean_mcp
        old = os.environ.get("CLAUDE_CONFIG_DIR")
        os.environ["CLAUDE_CONFIG_DIR"] = cfg
        try:
            found = lean_mcp.plugin_servers()
        finally:
            os.environ.pop("CLAUDE_CONFIG_DIR") if old is None else os.environ.update(CLAUDE_CONFIG_DIR=old)
        srv = found["plugin:obs:mcp"]
        self.assertEqual(srv["config"]["url"], "https://mcp.example.eu/v1/mcp")
        self.assertEqual(srv["config"]["headers"]["API_KEY"], "")
        self.assertEqual(srv["missing_options"], ["env:OBS_TOKEN"])
        doc = self.cli("doctor", check=False).stdout
        self.assertIn("uses ${OBS_TOKEN} and lean-agent can't see that variable", doc)
        with open(os.path.join(cfg, "settings.json"), "w") as fh:
            json.dump({"enabledPlugins": {"obs@synced": False}}, fh)  # Claude Code's id for a synced plugin
        self.assertNotIn("plugin:obs", self.cli("mcp", "list").stdout)

    def test_optimize_drafts_cards_and_presets(self):
        cfg = self.env["CLAUDE_CONFIG_DIR"]
        root = os.path.join(cfg, "plugins", "cache", "mkt", "obs", "1")
        os.makedirs(os.path.join(root, ".claude-plugin"))
        with open(os.path.join(root, ".claude-plugin", "plugin.json"), "w") as fh:
            json.dump({"name": "obs"}, fh)
        with open(os.path.join(root, ".mcp.json"), "w") as fh:
            json.dump({"mcpServers": {"mcp": {"type": "http", "url": "https://mcp.example.eu/v1"}}}, fh)
        with open(os.path.join(cfg, "plugins", "installed_plugins.json"), "w") as fh:
            json.dump({"version": 2, "plugins": {"obs@mkt": [{"installPath": root}]}}, fh)
        with open(os.path.join(cfg, "settings.json"), "w") as fh:
            json.dump({"enabledPlugins": {"obs@mkt": True}}, fh)
        names = ["search_obs_dashboards", "get_obs_dashboard", "get_obs_metric", "search_obs_metrics",
                 "get_obs_metric_context"] + [f"search_obs_thing{i}" for i in range(15)]
        env = dict(FAKE_HTTP_URL="mcp.example.eu", FAKE_HTTP_TOOLS=json.dumps({"plugin:obs:mcp": names}))
        self.cli("learn", self.proj)
        p = "mcp__plugin_obs_mcp__"
        calls = ",".join(p + t for t in ["search_obs_dashboards", "get_obs_dashboard"] + ["get_obs_metric"] * 6)
        out = self.cli("run", "-p", "proj", "-m", "sonnet", "--why", "x", "--mcp", "obs:read",
                       "widget value now vs same time on earlier Mondays", FAKE_MCP_CALL=calls, **env).stdout
        self.assertIn("(20 offered, 3 used)", out)
        self.assertIn("mcp: plugin:obs:mcp offered 20 tools", out)
        self.assertIn("next time --mcp plugin:obs:mcp:search_obs_dashboards,get_obs_dashboard,get_obs_metric", out)
        out = self.cli("optimize", "proj", **env).stdout
        self.assertIn("new card  draft-card-", out)
        self.assertIn("How to: widget value now vs same time on earlier Mondays", out)
        self.assertIn("3. get_obs_metric (x6)", out)
        self.assertIn("preset    draft-preset-", out)
        self.assertIn("--mcp plugin:obs:mcp:dashboards = search_obs_dashboards,get_obs_dashboard,get_obs_metric", out)
        ids = [l.split()[1] if l.startswith("preset") else l.split()[2] for l in out.splitlines()
               if l.startswith(("new card", "preset    "))]
        res = json.loads(self.cli("optimize", "proj", "--json", **env).stdout)
        self.assertEqual(sorted(d["id"] for d in res["drafts"]), sorted(ids))
        self.assertEqual(sorted(res["drafts"][0]), ["id", "kind", "name", "summary", "title"])
        preset_id = next(d["id"] for d in res["drafts"] if d["kind"] == "preset")
        out = self.cli("optimize", "proj", "--accept", preset_id, **env).stdout
        self.assertIn("saved preset plugin:obs:mcp:dashboards", out)
        left = json.loads(self.cli("optimize", "proj", "--json", **env).stdout)
        self.assertEqual([d["kind"] for d in left["drafts"]], ["card"])  # the accepted one is gone
        out = self.cli("optimize", "proj", "--accept", ",".join(i for i in ids if i != preset_id), **env).stdout
        self.assertIn("saved card recipe-widget-value-now-vs-same", out)
        self.assertNotIn("Drafts from what workers did", self.cli("optimize", "proj", **env).stdout)
        self.assertIn("plugin:obs:mcp:dashboards", self.cli("mcp", "preset", "obs", **env).stdout)
        out = self.cli("run", "-p", "proj", "-m", "sonnet", "--why", "x", "--mcp", "obs:read", "another widget check",
                       FAKE_MCP_CALL=p + "get_obs_metric", **env).stdout
        self.assertIn("preset plugin:obs:mcp:dashboards covers it", out)
        # task-specific text is generalised; read-only work never gets a write tool; names never collide
        for task, calls_, ro in (("Goal: compare PR 5512 metric for run 99123 at /Users/me/x/y", "get_obs_metric,search_obs_metrics", True),
                                 ("Goal: tag dashboards on ticket AB#771", "search_obs_dashboards,create_obs_dashboard", False),
                                 ("Goal: tag dashboards on ticket AB#772", "search_obs_dashboards,create_obs_dashboard", False)):
            args = ["run", "-p", "proj", "-m", "sonnet", "--why", "x", "--mcp", "obs"] + (["--read-only"] if ro else []) + [task]
            self.cli(*args, FAKE_MCP_CALL=",".join(p + t for t in calls_.split(",")), **env)
        out = self.cli("optimize", "proj", **env).stdout
        self.assertNotIn("5512", out)
        self.assertNotIn("99123", out)
        self.assertNotIn("AB#77", out)
        self.assertNotIn("Goal:", out)
        self.assertNotIn("/Users/me", out)
        presets = [l for l in out.splitlines() if l.startswith("preset")]
        names = [l.split("--mcp ")[1].split(" =")[0] for l in presets]
        self.assertEqual(len(names), len(set(names)), out)
        for l in presets:
            if "read-only" in l:
                self.assertNotIn("create_obs_dashboard", l)
        self.assertTrue(any("-write = " in l and "includes write tools: create_obs_dashboard" in l for l in presets), out)
        self.assertIn("Cards: nothing to promote", out)
        rej = self.cli("optimize", "proj", "--reject", "x", **env).stdout
        self.assertNotIn("Cards: nothing", rej)
        self.assertIn("rejected x (no open draft has that id now", rej)
        # an existing preset with the same tools is never re-drafted; one with fewer gets an "extend" draft
        store = {"plugin:obs:mcp": {"metrics": ["get_obs_metric", "search_obs_metrics"],
                                    "dash": ["search_obs_dashboards"]}}
        with open(os.path.join(self.env["LEAN_AGENT_HOME"], "mcp-presets.json"), "w") as fh:
            json.dump(store, fh)
        out = self.cli("optimize", "proj", **env).stdout
        self.assertNotIn("= get_obs_metric,search_obs_metrics ", out)
        self.assertNotIn("extend existing preset dash with create_obs_dashboard", out)  # read-only stays read-only
        self.assertIn("new preset dash-write: create_obs_dashboard; write tools: create_obs_dashboard", out)
        self.assertEqual(out.count("-> --mcp plugin:obs:mcp:dash-write ="), 1)  # one proposal per preset
        names = [l.split("--mcp ")[1].split(" =")[0] for l in out.splitlines() if l.startswith("preset")]
        tools = [l.split(" = ")[1].split("  (")[0] for l in out.splitlines() if l.startswith("preset")]
        self.assertEqual(len(tools), len(set(tools)), out)  # never two drafts with the same tool set
        # context gaps a card already covers are hidden; others can be acknowledged
        miss = os.path.join(self.env["LEAN_AGENT_HOME"], "library", [d for d in os.listdir(
            os.path.join(self.env["LEAN_AGENT_HOME"], "library")) if d.startswith("proj")][0], "missing.jsonl")
        with open(miss, "a") as fh:
            fh.write(json.dumps({"run": "r1", "missing": "widget value comparison on earlier Mondays"}) + "\n")
            fh.write(json.dumps({"run": "r2", "missing": "the description limit of the tracker is 4000 characters"}) + "\n")
        out = self.cli("optimize", "proj", **env).stdout
        self.assertNotIn("[r1]", out)  # the accepted recipe card covers it
        self.assertIn("[r2] the description limit", out)
        self.assertIn("gap(s) hidden: a card or tracker note already covers them", out)
        out = self.cli("optimize", "proj", "--ack", "r2", **env).stdout
        self.assertIn("acknowledged gap from run r2", out)
        self.assertNotIn("[r2]", out)
        # a big MCP result saved to a file: workers are pointed at lean-json, and read-only workers may run it
        self.assertIn("bin/lean-json <file>", self.calls()[-1]["append"] if self.calls()[-1].get("mcp") else
                      [c for c in self.calls() if c.get("mcp")][-1]["append"])
        ro_call = [c for c in self.calls() if "--permission-mode" in c["argv"] and
                   c["argv"][c["argv"].index("--permission-mode") + 1] == "default"][-1]
        self.assertIn("bin/lean-json:*)", " ".join(ro_call["argv"]))

    def test_lean_json_compacts_big_results(self):
        f = os.path.join(self.tmp.name, "big.json")
        inner = {"value": [{"id": 1, "status": "active", "_links": {"self": {"href": "https://x"}},
                            "comments": [{"author": {"displayName": "A", "imageUrl": "u", "url": "v"},
                                          "content": "duplicates the counter", "commentType": "text"}]},
                           {"id": 2, "comments": [{"author": {"displayName": "Build"}, "content": "status",
                                                   "commentType": "system"}]}]}
        with open(f, "w") as fh:
            json.dump({"content": [{"type": "text", "text": json.dumps(inner)}]}, fh)
        tool = os.path.join(os.path.dirname(CLI), "..", "bin", "lean-json")
        out = subprocess.run([tool, f, "--exclude", '"commentType":"system"'], capture_output=True, text=True).stdout
        self.assertEqual(out.strip(), '{"id":1,"status":"active","comments":[{"author":"A","content":"duplicates the counter","commentType":"text"}]}')
        out = subprocess.run([tool, f, "--fields", "id,comments.content"], capture_output=True, text=True).stdout
        self.assertIn('{"id":2,"comments.content":["status"]}', out)

    def test_installed_and_synced_copies_of_a_plugin(self):
        cfg = self.env["CLAUDE_CONFIG_DIR"]

        def plugin(root, url):
            os.makedirs(os.path.join(root, ".claude-plugin"), exist_ok=True)
            with open(os.path.join(root, ".claude-plugin", "plugin.json"), "w") as fh:
                json.dump({"name": "obs"}, fh)
            with open(os.path.join(root, ".mcp.json"), "w") as fh:
                json.dump({"mcpServers": {"mcp": {"type": "http", "url": url}}}, fh)
        installed = os.path.join(cfg, "plugins", "cache", "mkt", "obs", "2")
        plugin(installed, "https://mcp.example.eu/v2")
        with open(os.path.join(cfg, "plugins", "installed_plugins.json"), "w") as fh:
            json.dump({"version": 2, "plugins": {"obs@mkt": [{"installPath": installed}]}}, fh)
        with open(os.path.join(cfg, "settings.json"), "w") as fh:
            json.dump({"enabledPlugins": {"obs@mkt": True}}, fh)
        bucket = os.path.join(cfg, "plugins", "synced", "b1")
        plugin(os.path.join(bucket, "uuid-1"), "https://mcp.example.eu/v1")
        with open(os.path.join(bucket, "manifest.json"), "w") as fh:
            json.dump({"plugins": [{"name": "uuid-1", "marketplaceName": "dir"}]}, fh)
        env = dict(FAKE_HTTP_URL="mcp.example.eu", FAKE_HTTP_TOOLS=json.dumps({"plugin:obs:mcp": ["get_x"]}))
        self.cli("learn", self.proj)
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--mcp", "obs", "t", **env)
        self.assertEqual(self.calls()[-1]["mcp"]["servers"]["plugin:obs:mcp"]["url"], "https://mcp.example.eu/v2")
        # Claude Code turns out to use the synced copy: after doctor has seen that, workers use it too
        listed = "plugin:obs:mcp: https://mcp.example.eu/v1 (HTTP) - ✓ Connected"
        doc = self.cli("doctor", check=False, FAKE_MCP_LIST=listed, **env).stdout
        self.assertIn("plugin MCP server plugin:obs:mcp: usable by workers", doc)
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--mcp", "obs", "t", **env)
        self.assertEqual(self.calls()[-1]["mcp"]["servers"]["plugin:obs:mcp"]["url"], "https://mcp.example.eu/v1")

    def test_plugin_copy_with_setup_placeholder_is_not_used(self):
        cfg = self.env["CLAUDE_CONFIG_DIR"]

        def plugin(root, default):
            os.makedirs(os.path.join(root, ".claude-plugin"), exist_ok=True)
            with open(os.path.join(root, ".claude-plugin", "plugin.json"), "w") as fh:
                json.dump({"name": "obs", "mcpServers": "./.obs_mcp.json"}, fh)
            with open(os.path.join(root, ".obs_mcp.json"), "w") as fh:
                json.dump({"mcpServers": {"mcp": {"type": "http", "url": "https://${OBS_DOMAIN:-%s}/v1/mcp" % default,
                                                  "headers": {"X-Toolsets": "${OBS_TOOLSETS:-}"}}}}, fh)
        installed = os.path.join(cfg, "plugins", "cache", "mkt", "obs", "7")
        plugin(installed, "mcp.example.eu")  # set up: works in Claude Code
        with open(os.path.join(cfg, "plugins", "installed_plugins.json"), "w") as fh:
            json.dump({"version": 2, "plugins": {"obs@mkt": [{"installPath": installed}]}}, fh)
        with open(os.path.join(cfg, "settings.json"), "w") as fh:
            json.dump({"enabledPlugins": {"obs@mkt": True}}, fh)
        bucket = os.path.join(cfg, "plugins", "synced", "b1")
        plugin(os.path.join(bucket, "uuid-1"), "not-setup")  # the synced duplicate, never set up
        with open(os.path.join(bucket, "manifest.json"), "w") as fh:
            json.dump({"plugins": [{"name": "uuid-1", "marketplaceName": "dir"}]}, fh)
        env = dict(FAKE_HTTP_URL="mcp.example.eu", FAKE_HTTP_TOOLS=json.dumps({"plugin:obs:mcp": ["get_x"]}),
                   FAKE_MCP_LIST="plugin:obs:mcp: https://not-setup/v1/mcp (HTTP) - ✗ Failed to connect")
        self.cli("learn", self.proj)
        doc = self.cli("doctor", check=False, **env).stdout  # Claude Code's own list shows the broken copy
        self.assertIn("plugin MCP server plugin:obs:mcp: usable by workers", doc)
        self.assertIn("(uses the installed copy; an unused synced copy isn't set up, which is fine)", doc)
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--mcp", "obs", "t", **env)
        self.assertEqual(self.calls()[-1]["mcp"]["servers"]["plugin:obs:mcp"]["url"], "https://mcp.example.eu/v1/mcp")
        self.assertIn("another copy isn't set up", self.cli("mcp", "list", **env).stdout)
        # the orchestrator home switches off both copies: the installed id and the synced one ("<name>@synced")
        self.cli("home")
        home = self.cli("home").stdout.strip()
        with open(os.path.join(home, ".claude", "settings.json")) as fh:
            switches = json.load(fh)["enabledPlugins"]
        self.assertEqual((switches.get("obs@mkt"), switches.get("obs@synced")), (False, False))
        # only the broken copy: doctor names the cause; a value from `mcp env` fills ${VAR:-default}
        os.remove(os.path.join(cfg, "plugins", "installed_plugins.json"))
        doc = self.cli("doctor", check=False, **env).stdout
        self.assertIn("URL host 'not-setup' is a placeholder: this plugin copy isn't set up", doc)
        self.assertIn("run the plugin's setup once in Claude Code", doc)
        self.assertIn("set", self.cli("mcp", "env", "OBS_DOMAIN", "mcp.example.eu").stdout)
        self.assertIn("OBS_DOMAIN: used by plugin:obs:mcp", self.cli("mcp", "env", "OBS_DOMAIN", "mcp.example.eu").stdout)
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--mcp", "obs", "--again", "t", **env)
        self.assertEqual(self.calls()[-1]["mcp"]["servers"]["plugin:obs:mcp"]["url"], "https://mcp.example.eu/v1/mcp")
        self.assertIn("OBS_DOMAIN: removed", self.cli("mcp", "env", "OBS_DOMAIN", "--rm").stdout)
        self.cli("mcp", "env", "OBS_DOMAIN", "--command", "echo mcp.example.eu")
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--mcp", "obs", "--again", "t", **env)
        self.assertEqual(self.calls()[-1]["mcp"]["servers"]["plugin:obs:mcp"]["url"], "https://mcp.example.eu/v1/mcp")
        self.assertIn("OBS_DOMAIN: removed", self.cli("mcp", "env", "OBS_DOMAIN", "--rm").stdout)
        self.assertIn("OBS_DOMAIN: not set", self.cli("mcp", "env", "OBS_DOMAIN", "--rm").stdout)

    def test_ignored_mcp_servers(self):
        cfg = self.env["CLAUDE_CONFIG_DIR"]
        root = os.path.join(cfg, "plugins", "cache", "mkt", "gh", "1")
        os.makedirs(os.path.join(root, ".claude-plugin"))
        with open(os.path.join(root, ".claude-plugin", "plugin.json"), "w") as fh:
            json.dump({"name": "gh"}, fh)
        with open(os.path.join(root, ".mcp.json"), "w") as fh:
            json.dump({"mcpServers": {"gh": {"type": "http", "url": "https://api.example.com/mcp",
                                             "headers": {"Authorization": "Bearer ${GH_PAT}"}}}}, fh)
        with open(os.path.join(cfg, "plugins", "installed_plugins.json"), "w") as fh:
            json.dump({"version": 2, "plugins": {"gh@mkt": [{"installPath": root}]}}, fh)
        with open(os.path.join(cfg, "settings.json"), "w") as fh:
            json.dump({"enabledPlugins": {"gh@mkt": True}}, fh)
        self.assertIn("✗ plugin MCP server plugin:gh:gh", self.cli("doctor", check=False).stdout)
        out = self.cli("mcp", "ignore", "gh").stdout  # the alias works too
        self.assertIn("plugin:gh:gh: ignored", out)
        doc = self.cli("doctor", check=False).stdout
        self.assertNotIn("✗ plugin MCP server plugin:gh:gh", doc)
        self.assertIn("plugin MCP server plugin:gh:gh: ignored (not used", doc)
        self.assertIn("ignored", self.cli("mcp", "list").stdout)
        self.cli("learn", self.proj)  # still there when asked for explicitly
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--mcp", "gh", "t", check=False)
        self.assertIn("plugin:gh:gh", self.calls()[-1]["mcp"]["servers"])
        self.assertIn("checked again", self.cli("mcp", "ignore", "--rm", "plugin:gh:gh").stdout)
        self.assertIn("✗ plugin MCP server plugin:gh:gh", self.cli("doctor", check=False).stdout)
        self.assertIn("ignored (not used", self.cli("doctor", "--ignore", "gh", check=False).stdout)

    def test_config_problems_name_the_cause(self):
        sys.path.insert(0, os.path.dirname(CLI))
        import lean_mcp
        self.assertEqual(lean_mcp.config_problems({"url": "https://api.example.com/mcp",
                                                   "headers": {"Authorization": "Bearer "}}),
                         ["header Authorization has no token (its variable is empty)"])
        self.assertIn("line break", lean_mcp.config_problems({"url": "https://a.example.com",
                                                              "headers": {"Authorization": "Bearer abc\n"}})[0])
        self.assertEqual(lean_mcp.config_problems({"url": "http://localhost:8080/mcp"}), [])

    def test_plugin_env_from_command_and_alignment_with_claude(self):
        cfg = self.env["CLAUDE_CONFIG_DIR"]
        roots = {}
        for name, server in (("gh", {"type": "http", "url": "https://api.example.com/mcp",
                                     "headers": {"Authorization": "Bearer ${GH_PAT}"}}),
                             ("fig", {"url": "https://mcp.example.org/mcp"})):  # no type: Claude Code says http
            root = os.path.join(cfg, "plugins", "cache", "mkt", name, "1")
            os.makedirs(os.path.join(root, ".claude-plugin"))
            with open(os.path.join(root, ".claude-plugin", "plugin.json"), "w") as fh:
                json.dump({"name": name}, fh)
            with open(os.path.join(root, ".mcp.json"), "w") as fh:
                json.dump({"mcpServers": {name: server}}, fh)
            roots[name] = root
        with open(os.path.join(cfg, "plugins", "installed_plugins.json"), "w") as fh:
            json.dump({"version": 2, "plugins": {f"{n}@mkt": [{"installPath": r}] for n, r in roots.items()}}, fh)
        with open(os.path.join(cfg, "settings.json"), "w") as fh:
            json.dump({"enabledPlugins": {"gh@mkt": True, "fig@mkt": True}}, fh)
        tools = {"plugin:gh:gh": ["get_issue"], "plugin:fig:fig": ["get_design"]}
        env = dict(FAKE_HTTP_URL="example", FAKE_HTTP_NEED_TYPE="1", FAKE_HTTP_TOOLS=json.dumps(tools),
                   FAKE_MCP_LIST="plugin:gh:gh: https://api.example.com/mcp (HTTP) - ✓ Connected\n"
                                 "plugin:fig:fig: https://mcp.example.org/mcp (HTTP) - ✓ Connected",
                   FAKE_MCP_GET="plugin:fig:fig:\n  Scope: Dynamic config\n  Type: http\n  URL: https://mcp.example.org/mcp")
        doc = self.cli("doctor", check=False, **env).stdout
        self.assertIn("uses ${GH_PAT} and lean-agent can't see that variable", doc)
        self.assertIn("lean-agent mcp env GH_PAT --command", doc)
        self.assertIn("plugin:fig:fig: usable by workers after matching Claude Code's type", doc)
        out = self.cli("mcp", "env", "GH_PAT", "--command", "printf tok-%s secret-123", **env).stdout
        self.assertIn("the command works", out)
        self.assertIn("usable by workers", self.cli("doctor", check=False, **env).stdout.split("plugin:gh:gh")[1])
        self.cli("learn", self.proj)
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--mcp", "gh", "--mcp", "fig", "t", **env)
        servers = self.calls()[-1]["mcp"]["servers"]
        self.assertEqual(servers["plugin:gh:gh"]["headers"]["Authorization"], "Bearer tok-secret-123")
        self.assertEqual(servers["plugin:fig:fig"]["type"], "http")
        for dirpath, _, files in os.walk(self.env["LEAN_AGENT_HOME"]):  # the token is never written to disk
            for f in files:
                with open(os.path.join(dirpath, f), errors="replace") as fh:
                    self.assertNotIn("tok-secret-123", fh.read(), os.path.join(dirpath, f))
        # a header difference is reported, not copied (header values can be secrets)
        os.remove(os.path.join(self.env["LEAN_AGENT_HOME"], "mcp-overrides.json"))
        env["FAKE_MCP_GET"] += "\n  Headers:\n    X-Org: 42"
        doc = self.cli("doctor", check=False, **env).stdout
        self.assertIn("lean-agent's copy differs from Claude Code's in type, header X-Org", doc)

    def test_optimize_suggests_mcp_narrowing(self):
        self.cli("learn", self.proj)
        for _ in range(3):
            self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--mcp", "tickets", "t",
                     FAKE_MCP_CALL="mcp__tickets__get_ticket")
        out = self.cli("optimize", "proj", "--min-runs", "3").stdout
        self.assertIn("--mcp tickets:get_ticket", out)

    def make_auto_memory(self):
        mem = os.path.join(self.tmp.name, "shared-memory")
        os.makedirs(mem)
        with open(os.path.join(self.env["CLAUDE_CONFIG_DIR"], "settings.json"), "w") as fh:
            json.dump({"autoMemoryDirectory": mem}, fh)
        with open(os.path.join(mem, "feedback_small_prs.md"), "w") as fh:
            fh.write("---\nname: small PRs\ndescription: Prefers small focused PRs\ntype: feedback\n---\n"
                     "Keep pull requests small and focused; split refactors from behaviour changes.\n")
        with open(os.path.join(mem, "reference_tracker.md"), "w") as fh:
            fh.write("---\ntype: reference\n---\nBugs are tracked in the Linear project PAY; dashboards in Grafana.\n")
        with open(os.path.join(mem, "notes.md"), "w") as fh:  # no frontmatter, described by the index
            fh.write("The billing migration is frozen until the audit ends.\n")
        with open(os.path.join(mem, "MEMORY.md"), "w") as fh:
            fh.write("- [Small PRs](feedback_small_prs.md) - prefers small PRs\n- [Freeze](notes.md) - billing freeze\n")
        return mem

    def test_memory_import_and_cards(self):
        mem = self.make_auto_memory()
        self.cli("learn", self.proj)
        self.assertIn(mem, self.cli("memory", "where").stdout)
        out = self.cli("memory", "import").stdout
        self.assertIn("Imported 3 memories", out)
        self.assertIn("autoMemoryEnabled", out)
        self.assertIn("0 duplicates", out)
        self.assertIn("Imported 0 memories (3 duplicates", self.cli("memory", "import").stdout)
        listing = self.cli("memory", "list").stdout
        self.assertIn("mem-feedback-small-prs ", listing)
        self.assertIn("mem-reference-tracker ", listing)
        self.assertIn("billing freeze", listing)
        cards = self.cli("cards", "proj", "memory").stdout
        self.assertIn("3 cards", cards)
        # broad preferences are offered even without keyword overlap
        self.assertIn("small", self.cli("suggest", "proj", "rename a variable").stdout)
        with open(os.path.join(mem, "feedback_small_prs.md")) as fh:  # originals untouched
            self.assertIn("type: feedback", fh.read())

    def test_memory_add_rm_and_scope(self):
        self.cli("learn", self.proj)
        self.cli("memory", "add", "Always run the linter before committing", "--type", "feedback")
        self.cli("memory", "add", "The api deploys on Tuesdays only", "-p", "proj")
        self.assertIn("already remembered", self.cli("memory", "add", "always run the linter  before committing").stdout)
        other = os.path.join(self.tmp.name, "other")
        os.makedirs(other)
        self.cli("learn", other, "--name", "other")
        self.assertIn("linter", self.cli("cards", "other").stdout)
        self.assertNotIn("Tuesdays", self.cli("cards", "other").stdout)  # project-scoped
        self.assertIn("Tuesdays", self.cli("cards", "proj").stdout)
        name = [l.split()[0] for l in self.cli("memory", "list").stdout.splitlines() if "linter" in l][0]
        self.cli("memory", "rm", name)
        self.assertNotIn("linter", self.cli("cards", "proj").stdout)

    def test_worker_remember_and_no_auto_memory(self):
        self.cli("learn", self.proj)
        fb = json.dumps({"status": "done", "used": [], "unneeded": [], "missing": "",
                         "remember": [{"type": "feedback", "text": "User wants tests named after the bug id."},
                                      {"type": "project", "text": "Payments sandbox key lives in 1Password vault Dev."}]})
        out = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "t", FAKE_FEEDBACK=fb).stdout
        self.assertIn("remembered:", out)
        self.assertEqual(self.calls()[-1]["automem"], "1")
        mems = self.cli("memory", "list").stdout
        self.assertIn("bug id", mems)
        self.assertIn("[proj-", [l for l in mems.splitlines() if "sandbox" in l][0])
        self.assertIn("remember", self.calls()[-1]["append"])  # protocol tells workers how

    def test_learn_agents_md_and_local(self):
        os.makedirs(os.path.join(self.proj, "tools"))
        with open(os.path.join(self.proj, "tools", "AGENTS.md"), "w") as fh:
            fh.write("## Tooling\nTools are written in Go; run go vet before pushing anything here.\n")
        with open(os.path.join(self.proj, "AGENTS.md"), "w") as fh:  # ignored: root has CLAUDE.md
            fh.write("## Ignored\nThis root AGENTS.md is shadowed by CLAUDE.md in Claude Code.\n")
        with open(os.path.join(self.proj, "CLAUDE.local.md"), "w") as fh:
            fh.write("## My sandbox\nMy local database runs on port 5544 with user dev.\n")
        self.cli("learn", self.proj)
        out = self.cli("cards", "proj").stdout
        self.assertIn("tools-tooling", out)
        self.assertIn("my-sandbox", out)
        self.assertNotIn("Ignored", out)

    def test_up_pins_orchestrator_model(self):
        # `up` execs claude; the fake records argv, so the model pin and flags can be checked
        p = self.cli("up", "--model", "sonnet", "--local", check=False)
        home = self.cli("home").stdout.strip()
        with open(os.path.join(home, ".claude", "settings.json")) as fh:
            data = json.load(fh)
        self.assertEqual(data["model"], "sonnet")
        self.assertIn("Bash(lean-agent:*)", data["permissions"]["allow"])
        self.cli("up", "--model", "default", "--local", check=False)
        with open(os.path.join(home, ".claude", "settings.json")) as fh:
            self.assertNotIn("model", json.load(fh))
        fake_log = os.path.join(self.tmp.name, "up-argv.txt")
        with open(self.env["LEAN_AGENT_CLAUDE"]) as fh:
            body = fh.read()
        argv_dumper = os.path.join(self.tmp.name, "claude-argv")
        with open(argv_dumper, "w") as fh:
            fh.write(f"#!{sys.executable}\nimport sys\nopen({fake_log!r}, 'w').write(' '.join(sys.argv[1:]))\n")
        os.chmod(argv_dumper, 0o755)
        self.cli("up", "--name", "la", "--", "--debug", "--debug-file", "/tmp/rc.log",
                 check=False, LEAN_AGENT_CLAUDE=argv_dumper)
        with open(fake_log) as fh:
            self.assertRegex(fh.read(), r"^--model sonnet --remote-control la --session-id [0-9a-f-]{36} "
                                        r"--debug --debug-file /tmp/rc.log$")

    def test_up_fresh_removes_bridge_pointer(self):
        import re as _re
        home = self.cli("home").stdout.strip()
        d = os.path.join(self.env["CLAUDE_CONFIG_DIR"], "projects", _re.sub(r"[^A-Za-z0-9]", "-", home))
        os.makedirs(d, exist_ok=True)
        pointer = os.path.join(d, "bridge-pointer.json")
        with open(pointer, "w") as fh:
            fh.write("{}")
        self.cli("up", check=False)
        self.assertTrue(os.path.exists(pointer))  # kept by default so normal resume works
        out = self.cli("up", "--fresh", check=False).stdout
        self.assertFalse(os.path.exists(pointer))
        self.assertIn("starting a new Remote Control session", out)

    def test_up_recovers_from_a_deleted_remote_session(self):
        import re as _re
        home = self.cli("home").stdout.strip()
        d = os.path.join(self.env["CLAUDE_CONFIG_DIR"], "projects", _re.sub(r"[^A-Za-z0-9]", "-", home))
        os.makedirs(d, exist_ok=True)
        pointer = os.path.join(d, "bridge-pointer.json")
        with open(pointer, "w") as fh:
            json.dump({"sessionId": "cse_gone", "environmentId": "env_kept", "source": "standalone", "pid": 4242,
                       "activeSessionIds": ["cse_gone"]}, fh)
        starts = os.path.join(self.tmp.name, "starts.txt")
        fake = os.path.join(self.tmp.name, "claude-rc")
        with open(fake, "w") as fh:  # like remote-control: the old session answers 404 and it keeps running
            fh.write(f"#!{sys.executable}\nimport os, sys, time\nopen({starts!r}, 'a').write('x')\n"
                     f"import json\nif os.path.exists({pointer!r}) and json.load(open({pointer!r})).get('sessionId'):\n"
                     "    sys.stderr.write('[11:26:01] Error: CCR v2 worker registration failed for session cse_gone: "
                     "Request failed with status code 404\\n'); sys.stderr.flush(); time.sleep(30)\n"
                     "print('Connected')\n")
        os.chmod(fake, 0o755)
        p = self.cli("up", LEAN_AGENT_CLAUDE=fake)
        self.assertEqual(open(starts).read(), "xx")
        with open(pointer) as fh:  # the old session forgotten, its environment kept (else: "already served")
            self.assertEqual(json.load(fh), {"sessionId": "", "environmentId": "env_kept", "source": "standalone"})
        # the same error on stdout, with the colour codes a terminal UI adds
        with open(pointer, "w") as fh:
            json.dump({"sessionId": "cse_gone2", "environmentId": "env_kept"}, fh)
        with open(fake) as fh:
            body = fh.read().replace("sys.stderr.write('[11:26:01] Error:",
                                     "sys.stdout.write('\\x1b[31m[11:26:01] Error:\\x1b[39m").replace(
                                     "404\\n'); sys.stderr.flush()", "404\\n'); sys.stdout.flush()")
        self.assertIn("sys.stdout.write", body)
        with open(fake, "w") as fh:
            fh.write(body)
        p2 = self.cli("up", LEAN_AGENT_CLAUDE=fake)
        self.assertEqual(open(starts).read(), "xxxx")
        self.assertIn("the previous Remote Control session is gone", p2.stdout)
        with open(pointer) as fh:
            self.assertEqual(json.load(fh)["sessionId"], "")
        with open(os.path.join(self.env["LEAN_AGENT_HOME"], "logs", "session.log")) as fh:  # claude's own output
            logged = fh.read()
        self.assertIn("worker registration failed", logged)
        self.assertIn("the previous Remote Control session is gone", p.stdout)
        self.assertIn("Connected", logged)

    def test_up_lists_context_usage(self):
        import re as _re
        fake = os.path.join(self.tmp.name, "claude-ok")
        with open(fake, "w") as fh:
            fh.write(f"#!{sys.executable}\nprint('Connected')\n")
        os.chmod(fake, 0o755)
        out = self.cli("up", LEAN_AGENT_CLAUDE=fake).stdout
        self.assertRegex(out, r"context: the guide \(CLAUDE\.md\) is ~[\d,]+ tokens; the start-up context is measured")
        home = self.cli("home").stdout.strip()
        d = os.path.join(self.env["CLAUDE_CONFIG_DIR"], "projects", _re.sub(r"[^A-Za-z0-9]", "-", home))
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "s1.jsonl"), "w") as fh:
            for i, cr in enumerate((14000, 30000, 52000)):
                fh.write(json.dumps({"type": "assistant", "message": {"id": f"m{i}", "model": "claude-sonnet",
                         "usage": {"input_tokens": 10, "cache_read_input_tokens": cr}}}) + "\n")
        out = self.cli("up", LEAN_AGENT_CLAUDE=fake).stdout
        self.assertIn("started at ~14,010 (system prompt, tools, guide), 3 calls, ~32,010 per call on average, "
                      "~52,010 at the end, peak ~52,010", out)

    def test_orchestrator_loads_only_its_guide(self):
        cfg = self.env["CLAUDE_CONFIG_DIR"]
        os.makedirs(os.path.join(cfg, "rules", "team"))
        with open(os.path.join(cfg, "rules", "team", "style.md"), "w") as fh:
            fh.write("Personal coding rules. " * 200)
        with open(os.path.join(self.tmp.name, "CLAUDE.md"), "w") as fh:  # ~/CLAUDE.md
            fh.write("Spawn subagents. " * 200)
        home = self.cli("home").stdout.strip()
        guide = open(os.path.join(home, "CLAUDE.md")).read()
        self.assertNotIn("usage: lean-agent", guide)  # the CLI reference isn't re-read on every call
        self.assertIn("lean-agent guide --cli", guide)
        self.assertIn("lean-agent run", self.cli("guide", "--cli").stdout)
        doc = self.cli("doctor", home, check=False).stdout
        self.assertRegex(doc, r"✓ orchestrator loads ~[\d,]+ tokens of instructions on every call: CLAUDE.md ~[\d,]+\n")
        os.makedirs(os.path.join(home, ".claude", "rules"))
        with open(os.path.join(home, ".claude", "rules", "extra.md"), "w") as fh:
            fh.write("extra " * 100)
        doc = self.cli("doctor", home, check=False).stdout
        self.assertIn("! orchestrator loads", doc)
        self.assertIn("extra.md ~", doc)
        fake = os.path.join(self.tmp.name, "claude-ok")
        with open(fake, "w") as fh:
            fh.write(f"#!{sys.executable}\nprint('Connected')\n")
        os.chmod(fake, 0o755)
        self.assertIn("context: also loaded on every call:", self.cli("up", LEAN_AGENT_CLAUDE=fake).stdout)

    def test_up_switches_mcp_servers_off_for_the_home(self):
        fake = os.path.join(self.tmp.name, "claude-ok")
        with open(fake, "w") as fh:
            fh.write(f"#!{sys.executable}\nprint('Connected')\n")
        os.chmod(fake, 0o755)
        home = self.cli("home").stdout.strip()
        with open(os.path.join(home, ".mcp.json"), "w") as fh:  # a project server declared where the orchestrator runs
            json.dump({"mcpServers": {"homedb": {"type": "http", "url": "http://localhost:2"}}}, fh)
        out = self.cli("up", LEAN_AGENT_CLAUDE=fake).stdout
        self.assertIn("MCP servers off for the orchestrator itself (workers still get them with --mcp): tickets, homedb", out)
        with open(os.path.join(self.env["CLAUDE_CONFIG_DIR"], ".claude.json")) as fh:
            data = json.load(fh)
        self.assertEqual(data["projects"][home]["disabledMcpServers"], ["tickets"])
        self.assertEqual(data["projects"][home]["disabledMcpjsonServers"], ["homedb"])
        self.assertEqual(data["projects"][home]["enabledMcpjsonServers"], [])
        with open(os.path.join(home, ".claude", "settings.json")) as fh:
            self.assertIs(json.load(fh)["enableAllProjectMcpServers"], False)
        self.assertIn("tickets", data["mcpServers"])  # the user's own config is untouched
        self.assertNotIn("MCP servers off", self.cli("up", LEAN_AGENT_CLAUDE=fake).stdout)  # once
        self.cli("learn", self.proj)
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--mcp", "tickets", "t")
        self.assertIn("tickets", self.calls()[-1]["mcp"]["servers"])

    def test_context_flags_and_removes_unused(self):
        import re as _re
        home = self.cli("home").stdout.strip()
        d = os.path.join(self.env["CLAUDE_CONFIG_DIR"], "projects", _re.sub(r"[^A-Za-z0-9]", "-", home))
        os.makedirs(d)
        big = "| row | value |\n" * 2000
        lines = [
            {"type": "user", "message": {"content": "Check the services and report"}},
            {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t1", "name": "Bash",
                                                            "input": {"command": "lean-agent run -p shop -m haiku x"}}]}},
            {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": big}]}},
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "All good."}]}},
        ]
        with open(os.path.join(d, "s1.jsonl"), "w") as fh:
            fh.write("".join(json.dumps(x) + "\n" for x in lines))
        with open(os.path.join(home, ".claude", "rules.md"), "w") as fh:
            fh.write("x")
        os.makedirs(os.path.join(home, ".claude", "rules"))
        with open(os.path.join(home, ".claude", "rules", "extra.md"), "w") as fh:
            fh.write("extra rule " * 100)
        env = dict(FAKE_PROBE_TOOLS=json.dumps(["Bash", "Read", "KeepTool", "NotebookEdit2", "mcp__x__y"]),
                   FAKE_PROBE_AGENTS=json.dumps(["reviewer", "planner"]))
        out = self.cli("context", **env).stdout
        self.assertIn("Start-up context: ~8,000 tokens", out)
        self.assertIn("never called in these sessions: KeepTool, NotebookEdit2", out)  # Read is always kept
        self.assertIn("extra.md (~", out)
        self.assertIn("2 agents load here (reviewer, planner)", out)
        self.assertRegex(out, r"~\s*[\d,]+  output    Bash: lean-agent run -p shop -m haiku x")
        self.assertIn("brief mode is off in this session", out)
        out = self.cli("context", "--apply", "--keep", "KeepTool", **env).stdout
        self.assertIn("denied 1 tool(s), excluded 1 file(s)", out)
        with open(os.path.join(home, ".claude", "settings.json")) as fh:
            data = json.load(fh)
        self.assertIn("NotebookEdit2", data["permissions"]["deny"])
        self.assertNotIn("KeepTool", data["permissions"]["deny"])
        self.assertTrue(any(x.endswith("extra.md") for x in data["claudeMdExcludes"]))
        self.cli("home")  # kept when the home is refreshed (sync)
        with open(os.path.join(home, ".claude", "settings.json")) as fh:
            self.assertIn("NotebookEdit2", json.load(fh)["permissions"]["deny"])
        self.cli("context", "--undo")
        with open(os.path.join(home, ".claude", "settings.json")) as fh:
            self.assertNotIn("NotebookEdit2", json.load(fh)["permissions"]["deny"])

    def test_todo_queue(self):
        self.cli("learn", self.proj, "--name", "proj")
        self.assertIn("added #1 [open] Fix the export timeout  (proj, PR 512)",
                      self.cli("todo", "add", "Fix the export timeout", "-p", "proj", "--ref", "PR 512").stdout)
        self.cli("todo", "add", "Reply to the release thread", "--prio", "high")
        self.cli("todo", "add", "Tidy the docs", "--prio", "low")
        self.assertTrue(self.cli("todo", "next").stdout.startswith("#2 [open] high Reply to the release thread"))
        self.cli("todo", "start", "1")
        self.assertTrue(self.cli("todo", "next").stdout.startswith("#1 [doing]"))  # what's in progress first
        self.cli("todo", "done", "1", "fixed in the worker run")
        out = self.cli("todo").stdout
        self.assertNotIn("#1", out)
        self.assertIn("(1 done in the last 7 days", out)
        self.assertIn("#1 [done]", self.cli("todo", "list", "--all").stdout)
        hand = self.cli("handoff").stdout
        self.assertIn("Work queue (2 open", hand)
        self.assertIn("#2 Reply to the release thread", hand)
        self.cli("todo", "rm", "3")
        self.assertNotIn("Tidy", self.cli("todo").stdout)
        self.assertIn("Todos: 1 done, 1 open", self.cli("week").stdout)

    def test_home_settings_carry_the_status_line_unless_the_user_set_one(self):
        home = self.cli("home").stdout.strip()
        settings = os.path.join(home, ".claude", "settings.json")
        with open(settings) as fh:
            line = json.load(fh)["statusLine"]
        self.assertEqual(line["type"], "command")
        self.assertTrue(line["command"].endswith("trampoline.py\" statusline.py"), line)
        mine = {"type": "command", "command": "echo mine"}
        with open(settings, "w") as fh:
            json.dump({"statusLine": mine}, fh)
        self.cli("home")
        with open(settings) as fh:
            self.assertEqual(json.load(fh)["statusLine"], mine)  # a status line you set yourself stays

    def test_statusline_prints_the_todo_count_and_the_next_job(self):
        h = self.env["LEAN_AGENT_HOME"]
        os.makedirs(h, exist_ok=True)
        with open(os.path.join(h, "todo.json"), "w") as fh:
            json.dump({"next": 4, "items": [{"id": 1, "status": "open"}, {"id": 2, "status": "doing"},
                                            {"id": 3, "status": "done"}]}, fh)
        self.cli("schedule", "add", "daily 09:00", "stats")
        p = subprocess.run([sys.executable, os.path.join(os.path.dirname(CLI), "statusline.py")], input="{}",
                           capture_output=True, text=True, env=self.env)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertTrue(p.stdout.startswith("lean-agent · "), p.stdout)
        self.assertIn("2 todo", p.stdout)
        self.assertRegex(p.stdout, r"next job (Mon|Tue|Wed|Thu|Fri|Sat|Sun) 09:00")

    def test_schedule(self):
        self.cli("learn", self.proj, "--name", "proj")
        out = self.cli("schedule", "add", "weekdays 08:45", "stats").stdout
        self.assertIn("scheduled #1: weekdays 08:45: lean-agent stats (next ", out)
        self.assertIn("bad", self.cli("schedule", "add", "sometimes", "stats", check=False).stderr + "bad")
        self.assertIn("not 'up'", self.cli("schedule", "add", "daily 09:00", "up", check=False).stderr)
        self.cli("schedule", "add", "every 30m", "week")
        path = os.path.join(self.env["LEAN_AGENT_HOME"], "schedule.json")
        with open(path) as fh:
            jobs = json.load(fh)
        jobs[1]["created"] = "2020-01-01T00:00:00"  # long due
        with open(path, "w") as fh:
            json.dump(jobs, fh)
        self.cli("schedule", "run-due")
        out = self.cli("schedule").stdout
        self.assertIn("ran #2", out)
        self.assertIn("lean-agent, the last 7 days", out)
        self.cli("schedule", "run-due")  # not due again yet
        with open(os.path.join(self.env["LEAN_AGENT_HOME"], "scheduled.jsonl")) as fh:
            self.assertEqual(len(fh.readlines()), 1)
        self.assertIn("Scheduled jobs that ran:", self.cli("handoff").stdout)
        self.cli("schedule", "pause", "2")
        self.assertIn("(paused", self.cli("schedule").stdout)
        self.cli("schedule", "rm", "2")
        out = self.cli("schedule", "defaults").stdout
        self.assertIn("lean-agent sync --check", out)
        self.assertIn("lean-agent optimize proj", out)
        self.assertIn("lean-agent week", out)
        self.assertNotIn("scheduled #", self.cli("schedule", "defaults").stdout)  # once

    def test_scheduled_jobs_are_untagged_unless_the_entry_names_a_thread(self):
        self.cli("learn", self.proj, "--name", "proj")
        lt = self.threads_home()
        lt.route("Fix the export timeout in billing", "s1")  # the orchestrator's current thread: t1
        self.cli("schedule", "add", "every 30m", "run", "-p", "proj", "look at it", "--model", "haiku", "--why", "t")
        path = os.path.join(self.env["LEAN_AGENT_HOME"], "schedule.json")
        with open(path) as fh:
            jobs = json.load(fh)
        jobs[0]["created"] = "2020-01-01T00:00:00"
        with open(path, "w") as fh:
            json.dump(jobs, fh)
        self.cli("schedule", "run-due")
        self.assertEqual(self.calls()[-1]["thread"], "none")
        self.assertIsNone(self.ledger()[-1]["thread"])
        jobs[0].update(thread="t1", last=None)
        with open(path, "w") as fh:
            json.dump(jobs, fh)
        self.cli("schedule", "run-due")
        self.assertEqual(self.calls()[-1]["thread"], "t1")
        self.assertEqual(self.ledger()[-1]["thread"], "t1")

    def test_schedule_due_times(self):
        sys.path.insert(0, os.path.dirname(CLI))
        import lean_schedule as S
        import datetime as dt
        job = {"id": 1, "when": "weekdays 08:45", "args": ["week"], "created": "2026-10-01T00:00:00"}
        wed = dt.datetime(2026, 10, 21, 9, 0)  # a Wednesday
        self.assertTrue(S.is_due(job, wed))
        self.assertFalse(S.is_due(dict(job, last="2026-10-21T08:46:00"), wed))
        self.assertFalse(S.is_due(job, dt.datetime(2026, 10, 21, 16, 0)))  # missed by > 6 h: wait for the next one
        self.assertFalse(S.is_due(job, dt.datetime(2026, 10, 24, 9, 0)))  # Saturday
        self.assertEqual(S.next_run(job, dt.datetime(2026, 10, 23, 9, 0)), dt.datetime(2026, 10, 26, 8, 45))
        self.assertEqual(S.parse_when("mon,wed 10:00"), {"days": [0, 2], "at": "10:00"})
        with self.assertRaises(ValueError):
            S.parse_when("every 5m")

    def test_pace_and_week(self):
        import time as _t
        path = os.path.join(self.env["LEAN_AGENT_HOME"], "plan-usage.json")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as fh:  # 3.5 days left of the week, 80% used: ahead of pace
            import datetime as _dt
            json.dump({"at": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
                       "windows": {"seven_day": {"pct": 80.0, "resets_at": _t.time() + 3.5 * 86400}}}, fh)
        self.assertIn("week: 80% of your plan used, 50% of the week gone: 30 points ahead of pace",
                      self.cli("limits").stdout)
        self.cli("learn", self.proj, "--name", "proj")
        self.assertIn("ahead of pace for the week, so prefer haiku", self.cli("suggest", "proj", "refactor the api").stdout)

    def test_service_is_optional_and_installs(self):
        fake = os.path.join(self.tmp.name, "ctl")
        log = os.path.join(self.tmp.name, "ctl.log")
        with open(fake, "w") as fh:
            fh.write(f"#!/bin/sh\necho \"$@\" >> {log}\n")
        os.chmod(fake, 0o755)
        env = dict(LEAN_AGENT_SERVICE_PLATFORM="mac", LEAN_AGENT_LAUNCHCTL=fake)
        self.assertIn("isn't installed (it's optional)", self.cli("service", "status", **env).stdout)
        out = self.cli("service", "install", **env).stdout
        plist = os.path.join(self.tmp.name, "Library", "LaunchAgents", "com.lean-agent.up.plist")
        self.assertTrue(os.path.exists(plist))
        import plistlib
        with open(plist, "rb") as fh:
            data = plistlib.load(fh)
        self.assertEqual(data["ProgramArguments"][-3:], ["up", "--name", "lean-agent"])
        self.assertTrue(data["KeepAlive"])
        self.assertIn("bootstrap", open(log).read())
        self.cli("service", "restart", **env)
        self.assertIn("kickstart -k", open(log).read())
        hang = os.path.join(self.tmp.name, "ctl-hang")  # launchd still waiting for the old process
        with open(hang, "w") as fh:
            fh.write(f"#!/bin/sh\necho \"$@\" >> {log}\ncase \"$*\" in *kickstart*-k*) sleep 30;; esac\n")
        os.chmod(hang, 0o755)
        import time as _t
        t0 = _t.time()
        out = self.cli("service", "restart", LEAN_AGENT_SERVICE_PLATFORM="mac", LEAN_AGENT_LAUNCHCTL=hang,
                       LEAN_AGENT_SERVICE_TIMEOUT="2").stdout
        self.assertLess(_t.time() - t0, 20)
        self.assertIn("restarting (the orchestrator session shuts down first", out)
        after = open(log).read().split("kickstart -k")[-1]
        self.assertIn("bootout", after)  # fell back to unloading and loading it again
        self.assertIn("bootstrap", after)
        self.cli("service", "uninstall", **env)
        self.assertFalse(os.path.exists(plist))
        env = dict(LEAN_AGENT_SERVICE_PLATFORM="linux", LEAN_AGENT_SYSTEMCTL=fake)
        self.cli("service", "install", **env)
        unit = os.path.join(self.tmp.name, ".config", "systemd", "user", "lean-agent.service")
        self.assertIn("Restart=always", open(unit).read())
        self.assertIn("--user enable --now lean-agent.service", open(log).read())

    def test_worker_killed_outside_is_not_a_timeout_and_keeps_its_session(self):
        self.cli("learn", self.proj, "--name", "proj")
        p = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "look around", check=False,
                     FAKE_TURNS="2", FAKE_SELF_KILL="1")
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("killed by signal 9 (outside lean-agent, e.g. out of memory)", p.stdout)
        self.assertNotIn("timed out", p.stdout)
        entry = self.ledger()[-1]
        self.assertEqual(entry["status"], "error")
        self.assertEqual(entry["session_id"], "sess-1")  # from the init event: the run has no result event
        p = self.cli("run", "--resume", entry["id"], "carry on", check=False)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("--resume", " ".join(self.calls()[-1]["argv"]))
        self.assertIn("sess-1", self.calls()[-1]["argv"])

    def test_worker_that_runs_out_of_time_says_so(self):
        self.cli("learn", self.proj, "--name", "proj")
        p = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "look around", check=False,
                     FAKE_TURNS="1", FAKE_HANG="1", LEAN_AGENT_RUN_TIMEOUT="2")
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("timed out after 2 s", p.stdout)
        self.assertNotIn("killed by signal", p.stdout)
        self.assertEqual(self.ledger()[-1]["session_id"], "sess-1")

    def test_running_record_gets_the_session_id_at_once(self):
        self.cli("learn", self.proj, "--name", "proj")
        p = subprocess.Popen([sys.executable, CLI, "run", "-p", "proj", "-m", "haiku", "--why", "x", "look around"],
                             env=dict(self.env, FAKE_TURNS="3", FAKE_TURN_SLEEP="0.7"),
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            import time as _t
            seen = None
            for _ in range(100):
                for f in glob.glob(os.path.join(self.env["LEAN_AGENT_HOME"], "running", "*.json")):
                    try:
                        seen = json.load(open(f)).get("session_id") or seen
                    except ValueError:
                        pass
                if seen:
                    break
                _t.sleep(0.1)
            self.assertEqual(seen, "sess-1")
        finally:
            p.communicate(timeout=60)

    def _fe_fixture(self):
        root = os.path.join(self.tmp.name, "shop-web")
        files = {
            "package.json": '{"dependencies": {"react": "18", "react-router-dom": "6"}}',
            "tsconfig.json": '{\n // paths\n "compilerOptions": {"baseUrl": ".", "paths": {"@/*": ["src/*"]},},\n}',
            "src/main.tsx": "import { createRoot } from 'react-dom/client';\nimport App from './App';\n",
            "src/App.tsx": ("import { Routes, Route } from 'react-router-dom';\nimport Settings from '@/pages/Settings';\n"
                            "import Billing from './pages/Billing';\nexport default function App() {\n  return <Routes>\n"
                            "    <Route path=\"/settings\" element={<Settings />} />\n"
                            "    <Route path=\"/billing\" element={<Billing />} />\n  </Routes>;\n}\n"),
            "src/pages/Settings.tsx": ("import { Button } from '@/components/Button';\nimport { api } from '@/legacy/api';\n"
                                       "import './settings.css';\nexport default function Settings() { return <Button />; }\n"),
            "src/pages/Billing.tsx": ("import { Button } from '../components/Button';\nimport { api } from '../legacy/api';\n"
                                      "export default function Billing() { return <Button />; }\n"),
            "src/pages/settings.css": "@import '../styles/tokens.css';\n",
            "src/styles/tokens.css": ":root{}\n",
            "src/components/Button.tsx": "export function Button() { return null; }\n",
            "src/components/Button.test.tsx": "import { Button } from './Button';\n",
            "src/legacy/api.ts": "export const api = {};\n",
            "src/utils/old.ts": "export const unusedHelper = 1;\n",
            "types.sh": ("echo \"src/legacy/api.ts(1,14): error TS7006: Parameter 'u' implicitly has an 'any' type.\"\n"
                         "[ -f NEWERR ] && echo \"src/pages/Billing.tsx(9,1): error TS2322: Type 'string' is not "
                         "assignable to type 'number'.\"\nexit 2\n"),
        }
        for rel, text in files.items():
            os.makedirs(os.path.dirname(os.path.join(root, rel)), exist_ok=True)
            with open(os.path.join(root, rel), "w") as fh:
                fh.write(text)
        g = lambda *a: subprocess.run(["git", "-C", root, *a], capture_output=True, text=True, check=True)
        g("init", "-q")
        g("add", "-A")
        g("-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qm", "init")
        self.cli("learn", root, "--name", "shop")
        return root

    def test_front_end_tools(self):
        root = self._fe_fixture()
        out = self.cli("map", "shop").stdout
        self.assertIn("10 files (1 tests)", out)  # json/sh files aren't source; tests are counted apart
        self.assertIn("2 routes", out)
        who = self.cli("map", "shop", "--who-uses", "Button").stdout
        self.assertIn("used by 3 files (1 tests)", who)  # through the @/ alias and a relative import
        self.assertIn("src/pages/Settings.tsx  [Button]", who)
        self.assertIn("src/pages/settings.css", self.cli("map", "shop", "--deps", "src/pages/Settings.tsx").stdout)
        routes = self.cli("map", "shop", "--route").stdout
        self.assertIn("/settings  src/pages/Settings.tsx", routes)
        self.assertNotIn("\n/Settings ", "\n" + routes)  # a pages/ folder is file routing only in Next/Nuxt
        self.assertIn("src/utils/old.ts", self.cli("map", "shop", "--unused").stdout)
        os.makedirs(os.path.join(root, "builds-x"))
        with open(os.path.join(root, "builds-x", "bundle.js"), "w") as fh:
            fh.write("var a = 1;\n" * 500)
        os.makedirs(os.path.join(root, "out-ignored"))
        with open(os.path.join(root, "out-ignored", "gen.js"), "w") as fh:
            fh.write("var b;\n")
        with open(os.path.join(root, ".gitignore"), "w") as fh:
            fh.write("out-ignored/\n")
        self.assertIn("11 files", self.cli("map", "shop").stdout)  # builds-x counts, the ignored folder doesn't
        self.assertIn("10 files", self.cli("map", "shop", "--exclude", "builds*/").stdout)
        self.cli("map", "shop", "--no-exclude")
        import shutil as _sh
        _sh.rmtree(os.path.join(root, "builds-x"))
        with open(os.path.join(root, "src", "routes.tsx"), "w") as fh:
            fh.write("import { createBrowserRouter } from 'react-router-dom';\nimport Billing from './pages/Billing';\n"
                     "export const router = createBrowserRouter([{ path: '/', children: [\n"
                     "  { path: 'invoices', element: <Billing /> }, { path: ROUTES.x }, { path: '*' }]}]);\n")
        rts = self.cli("map", "shop", "--route").stdout
        self.assertIn("/invoices  src/pages/Billing.tsx", rts)
        self.assertIn("1 more route paths are constants", rts)
        os.remove(os.path.join(root, "src", "routes.tsx"))
        os.remove(os.path.join(root, ".gitignore"))
        self.assertEqual(self.cli("map", "shop", "--who-uses", "nothing-like-this", check=False).returncode, 1)
        # count: how much legacy is left, with history
        self.cli("count", "shop", "add", "legacy-api", r"from ['\"](@/|\.\./)legacy/api", "--glob", "*.ts,*.tsx")
        self.assertIn("legacy-api: 2 in 2 files", self.cli("count", "shop").stdout)
        with open(os.path.join(root, "src/pages/Billing.tsx"), "w") as fh:
            fh.write("import { api } from '../services/api';\n")
        c = self.cli("count", "shop", "legacy-api", "--files").stdout
        self.assertIn("legacy-api: 1 in 1 file (was 2 on", c)
        self.assertIn("-50%", c)
        self.assertIn("src/pages/Settings.tsx", c)
        # check: only errors that weren't there before
        self.cli("check", "shop", "add", "types", "sh types.sh")
        self.assertIn("types: baseline recorded: 1 error, exit 2", self.cli("check", "shop", "baseline").stdout)
        self.assertIn("types: ok · 0 new, 0 fixed", self.cli("check", "shop").stdout)
        open(os.path.join(root, "NEWERR"), "w").close()
        r = self.cli("check", "shop", check=False)
        self.assertEqual(r.returncode, 1)
        self.assertIn("1 new", r.stdout)
        self.assertIn("src/pages/Billing.tsx:9: Type 'string' is not assignable to type 'number'. [TS2322]", r.stdout)
        os.remove(os.path.join(root, "NEWERR"))
        # codemod: a dry run changes nothing and says what would change
        cmd = "sed -i.bak 's/legacy\\/api/services\\/api/' src/pages/Settings.tsx && rm src/pages/Settings.tsx.bak"
        before = open(os.path.join(root, "src/pages/Settings.tsx")).read()
        dry = self.cli("codemod", "shop", cmd).stdout
        self.assertIn("dry run", dry)
        self.assertIn("1 file changed, 0 new, 0 deleted (+1 -1)", dry)
        self.assertIn("+import { api } from '@/services/api';", dry)
        self.assertEqual(open(os.path.join(root, "src/pages/Settings.tsx")).read(), before)
        self.assertEqual(subprocess.run(["git", "-C", root, "worktree", "list"], capture_output=True, text=True)
                         .stdout.count("\n"), 1)  # the throwaway copy is gone
        applied = self.cli("codemod", "shop", cmd, "--apply").stdout
        self.assertIn("applied", applied)
        self.assertIn("services/api", open(os.path.join(root, "src/pages/Settings.tsx")).read())
        with open(os.path.join(root, "src/new.ts"), "w") as fh:  # not committed yet: a codemod's change still counts
            fh.write("import { api } from '@/legacy/api';\n")
        self.assertIn("1 file changed, 0 new, 0 deleted (+1 -1)", self.cli(
            "codemod", "shop", "sed -i.bak 's/legacy/services/' src/new.ts && rm src/new.ts.bak").stdout)
        os.remove(os.path.join(root, "src/new.ts"))
        # slices and the epic they become
        subprocess.run(["git", "-C", root, "checkout", "-q", "--", "."], check=True)
        plan = self.cli("slices", "shop").stdout
        self.assertIn("S1. shared src/components", plan)
        self.assertIn("/billing:", plan)
        self.assertIn("created 4 items in epic fe2", self.cli("slices", "shop", "--create", "--epic", "fe2").stdout)
        ep = self.cli("todo", "epic", "fe2", "--count", "legacy-api").stdout
        self.assertIn("fe2: 0/4 done, 2 ready, 2 waiting on others; counters: legacy-api", ep)
        self.assertIn("shared src/", self.cli("todo", "next", "--epic", "fe2").stdout)
        self.cli("todo", "done", "1", "ok")
        self.cli("todo", "done", "2", "ok")
        self.assertIn("2/4 done, 2 ready, 0 waiting", self.cli("todo", "epic", "fe2").stdout)
        self.assertEqual(self.cli("todo", "add", "x", "--after", "99", check=False).returncode, 1)
        sys.path.insert(0, os.path.dirname(CLI))
        old = os.environ.get("LEAN_AGENT_HOME")
        os.environ["LEAN_AGENT_HOME"] = self.env["LEAN_AGENT_HOME"]
        try:
            import lean_agent as L
            note = L.code_tools_note(root)
        finally:
            os.environ.pop("LEAN_AGENT_HOME") if old is None else os.environ.update(LEAN_AGENT_HOME=old)
        for tool in ("map shop --who-uses", "check shop", "count shop", "codemod shop"):
            self.assertIn(tool, note)  # workers are told about the tools set up for the project
        self.assertNotIn("parity shop", note)

    def test_parity_compares_screenshots(self):
        sys.path.insert(0, os.path.dirname(CLI))
        import fe_tools
        t = self.tmp.name
        white = [bytes([255] * 30) for _ in range(10)]
        top = [bytes([0] * 30) if y < 2 else bytes([255] * 30) for y in range(10)]
        fe_tools.png_write(os.path.join(t, "a.png"), 10, 10, white)
        fe_tools.png_write(os.path.join(t, "b.png"), 10, 10, top)
        self.assertEqual(fe_tools.png_read(os.path.join(t, "a.png"))[:3], (10, 10, 3))
        self.assertEqual(fe_tools.png_diff(os.path.join(t, "a.png"), os.path.join(t, "a.png"))[0], 0.0)
        share, span, why = fe_tools.png_diff(os.path.join(t, "a.png"), os.path.join(t, "b.png"))
        self.assertEqual((share, span, why), (0.2, (0.0, 0.2), None))
        self.assertEqual(fe_tools._area(span), "rows 0-20% (top)")

    def test_parity_in_a_browser(self):
        if not (PLAYWRIGHT_DIR and shutil.which("node")):
            self.skipTest("the browser part needs Playwright (local runs set LEAN_AGENT_PLAYWRIGHT_DIR)")
        t = self.tmp.name
        pw = {"LEAN_AGENT_PLAYWRIGHT_DIR": PLAYWRIGHT_DIR}
        import http.server
        import threading
        site = os.path.join(t, "site")
        os.makedirs(os.path.join(site, "settings"))
        page = lambda color, text: f'<body style="margin:0"><div style="height:200px;background:{color}"></div>{text}</body>'
        with open(os.path.join(site, "index.html"), "w") as fh:
            fh.write(page("#fff", "Home"))
        with open(os.path.join(site, "settings", "index.html"), "w") as fh:
            fh.write(page("#36c", "Save"))
        handler = lambda *a, **k: http.server.SimpleHTTPRequestHandler(*a, directory=site, **k)
        handler.log_message = lambda *a: None
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        root = self._fe_fixture()
        try:
            url = f"http://127.0.0.1:{server.server_address[1]}"
            self.cli("parity", "shop", "set", "--url", url, "--routes", "/,/settings/", **pw)
            self.assertIn("2 routes recorded", self.cli("parity", "shop", "baseline", **pw).stdout)
            self.assertIn("2/2 routes unchanged", self.cli("parity", "shop", **pw).stdout)
            with open(os.path.join(site, "settings", "index.html"), "w") as fh:
                fh.write(page("#c33", "Save changes<script>console.error('boom')</script>"))
            r = self.cli("parity", "shop", check=False, **pw)
            self.assertEqual(r.returncode, 1)
            self.assertIn("1/2 routes unchanged", r.stdout)
            self.assertIn("(top)", r.stdout)
            self.assertIn("+Save changes", r.stdout)
            self.assertIn("1 new console error: boom", r.stdout)
        finally:
            server.shutdown()

    def test_up_explains_a_folder_served_elsewhere(self):
        fake = os.path.join(self.tmp.name, "claude-busy")
        with open(fake, "w") as fh:
            fh.write(f"#!{sys.executable}\nimport sys\nprint('Error: This folder is already served by a terminal "
                     "`claude remote-control` on this device. Stop it first.')\nsys.exit(1)\n")
        os.chmod(fake, 0o755)
        p = self.cli("up", LEAN_AGENT_CLAUDE=fake, check=False)
        self.assertIn("often the Claude desktop app", p.stdout)

    def start_up(self, *args):
        """`lean-agent up` with the fake interactive claude; returns (process, session log path) once the
        session answers on the bridge."""
        sys.path.insert(0, os.path.join(os.path.dirname(CLI)))
        import service_session
        fake = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "fake_interactive_claude.py")
        log = os.path.join(self.tmp.name, "session-calls.jsonl")
        before = len(self.read_jsonl(log))
        env = dict(self.env, LEAN_AGENT_CLAUDE=fake, FAKE_SESSION_LOG=log, CLAUDECODE="1")
        p = subprocess.Popen([sys.executable, CLI, "up", *args], env=env, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: (p.poll() is None and p.kill(), p.communicate()))
        self.ups = getattr(self, "ups", []) + [p]
        old = os.environ.get("LEAN_AGENT_HOME")
        os.environ["LEAN_AGENT_HOME"] = self.env["LEAN_AGENT_HOME"]
        self.addCleanup(lambda: os.environ.__setitem__("LEAN_AGENT_HOME", old) if old else
                        os.environ.pop("LEAN_AGENT_HOME", None))
        self.wait_for(lambda: p.poll() is not None or (len(self.read_jsonl(log)) > before and service_session.alive()),
                      "the session to answer on the bridge", secs=30)
        self.assertIsNone(p.poll(), "up exited")
        self.assertTrue(service_session.alive())
        return p, log, service_session

    def wait_for(self, cond, what, secs=10):
        import time as _t
        end = _t.time() + secs
        while _t.time() < end:
            if cond():
                return
            _t.sleep(0.05)
        self.fail("timed out waiting for " + what)

    def read_text(self, path):
        try:
            with open(path) as fh:
                return fh.read()
        except (OSError, TypeError):
            return ""

    def read_jsonl(self, path):
        try:
            with open(path) as fh:
                return [json.loads(l) for l in fh if l.strip()]
        except OSError:
            return []

    def with_home(self, home):
        sys.path.insert(0, os.path.join(os.path.dirname(CLI)))
        import service_session
        old = os.environ.get("LEAN_AGENT_HOME")
        os.environ["LEAN_AGENT_HOME"] = home
        def restore():
            os.environ.pop("LEAN_AGENT_HOME", None) if old is None else os.environ.__setitem__("LEAN_AGENT_HOME", old)
        self.addCleanup(restore)
        return service_session

    def test_client_sock_path_prefers_the_socket_up_recorded(self):
        ss = self.with_home(self.tmp.name)
        with open(os.path.join(self.tmp.name, "up.json"), "w") as fh:
            json.dump({"socket": "/tmp/recorded.sock"}, fh)
        self.assertEqual(ss.client_sock_path(), "/tmp/recorded.sock")

    def test_request_returns_not_ok_when_the_tmp_socket_dir_is_bad(self):
        home = os.path.join(self.tmp.name, *["long-directory-name-for-the-socket"] * 3, "home")
        ss = self.with_home(home)
        root = os.path.join(self.tmp.name, "fallback")
        os.makedirs(root)
        open(os.path.join(root, f"lean-agent-{os.getuid()}"), "w").close()  # not a directory
        with mock.patch.object(ss, "FALLBACK_ROOT", root):
            r = ss.request({"ping": True})
        self.assertFalse(r["ok"])
        self.assertIn("error", r)

    def test_sock_path_falls_back_only_above_100_bytes(self):
        ss = self.with_home("/x")
        fb = os.path.join(self.tmp.name, "fb")
        for n, short in ((100, True), (101, False)):
            home = "/x" + "a" * (n - len("/x/session.sock"))
            os.environ["LEAN_AGENT_HOME"] = home
            self.assertEqual(len(os.path.join(home, "session.sock")), n)
            with mock.patch.object(ss, "fallback_dir", return_value=fb):
                got = ss.sock_path()
            if short:
                self.assertEqual(got, os.path.join(home, "session.sock"))
            else:
                self.assertEqual(os.path.dirname(got), fb)
                self.assertTrue(got.endswith(".sock"))

    def test_up_hosts_the_session_when_the_home_path_is_too_long_for_a_socket(self):
        home = os.path.join(self.tmp.name, *["long-directory-name-for-the-socket"] * 3, "home")
        os.makedirs(home)
        self.env["LEAN_AGENT_HOME"] = home
        p, log, ss = self.start_up("--name", "la")
        sock = ss.info()["socket"]
        self.assertGreater(len(os.path.join(home, "session.sock")), 104)
        self.assertLessEqual(len(sock), 100)
        self.assertEqual(os.path.dirname(sock), f"/tmp/lean-agent-{os.getuid()}")
        self.assertEqual(ss.sock_path(), sock)
        self.assertTrue(ss.alive())
        self.assertEqual(ss.send("hi"), (True, ""))
        p.terminate()
        p.wait(timeout=20)
        self.assertFalse(os.path.exists(sock))

    def test_up_hosts_one_interactive_session_and_the_socket_types_into_it(self):
        import stat
        p, log, ss = self.start_up("--name", "la", "--model", "sonnet")
        [call] = self.read_jsonl(log)
        sid = call["argv"][call["argv"].index("--session-id") + 1]
        self.assertEqual(call["argv"][:5], ["--model", "sonnet", "--remote-control", "la", "--session-id"])
        self.assertEqual(call["service"], "1")        # the permission hook only acts in this session
        self.assertIsNone(call["leaked"])              # the parent session's variables don't reach it
        info = ss.info()
        self.assertEqual((info["session_id"], info["pid"], info["remote_control"]), (sid, call["pid"], True))
        home = self.cli("home").stdout.strip()
        slug = "".join(c if c.isalnum() else "-" for c in os.path.realpath(home))
        transcript = os.path.join(self.env["CLAUDE_CONFIG_DIR"], "projects", slug, sid + ".jsonl")
        self.assertEqual(info["transcript"], transcript)
        self.assertEqual(stat.S_IMODE(os.stat(ss.sock_path()).st_mode), 0o600)
        self.assertEqual(os.path.realpath(call["cwd"]), os.path.realpath(home))
        # the pty is drained into a log, and the bridge can show its tail
        self.wait_for(lambda: "fake claude ready" in ss.tail(), "the session's output")
        # a message arrives as a paste followed by Enter; multi-line text stays one message
        self.assertEqual(ss.send("About #3 \"x\": hello\nsecond line"), (True, ""))
        self.wait_for(lambda: len(self.read_jsonl(transcript)) >= 2, "the transcript")
        user, asst = self.read_jsonl(transcript)
        self.assertEqual(user["message"]["content"], "About #3 \"x\": hello\nsecond line")
        self.assertEqual(asst["message"]["content"][0]["text"], "echo: About #3 \"x\": hello\nsecond line")
        # keys: Escape interrupts
        self.assertEqual(ss.keys("esc"), (True, ""))
        self.wait_for(lambda: "interrupted" in json.dumps(self.read_jsonl(transcript)[2:]), "the interrupt")
        # bad requests are refused, not fatal
        self.assertFalse(ss.request({"nope": 1})["ok"])
        self.assertTrue(ss.alive())
        # stopping `up` stops the session and removes the socket
        p.terminate()
        p.wait(timeout=20)
        self.assertFalse(os.path.exists(ss.sock_path()))
        self.assertFalse(ss.alive())
        self.assertEqual(ss.send("x")[0], False)
        # a restart of `up` continues the same conversation
        p2, log2, ss = self.start_up("--name", "la")
        self.assertEqual(self.read_jsonl(log)[-1]["argv"][-2:], ["--resume", sid])
        self.assertEqual(ss.info()["session_id"], sid)
        p2.terminate()
        p2.wait(timeout=20)
        # --fresh starts a new conversation
        p3, _, ss = self.start_up("--fresh")
        self.assertIn("--session-id", self.read_jsonl(log)[-1]["argv"])
        self.assertNotEqual(ss.info()["session_id"], sid)

    def _follow_home(self):
        home = tempfile.mkdtemp()
        proj = os.path.join(home, "proj")
        os.makedirs(proj)
        os.makedirs(os.path.join(home, "chat"))
        tr = os.path.join(proj, "s1.jsonl")
        open(tr, "w").close()
        with open(os.path.join(home, "up.json"), "w") as fh:
            json.dump({"transcript": tr, "session_id": "s1", "session_started": "2020-01-01T00:00:00"}, fh)
        return home, proj, tr

    @staticmethod
    def _user_file(path, text, ts=None):
        rec = {"type": "user", "message": {"role": "user", "content": text}}
        if ts is not None:
            rec["timestamp"] = datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).isoformat().replace("+00:00", "Z")
        with open(path, "w") as fh:
            fh.write(json.dumps(rec) + "\n")

    def _hook_record(self, home, sid, transcript, source="clear"):
        with open(os.path.join(home, "chat", "service.json"), "w") as fh:
            json.dump({"session_id": sid, "transcript_path": transcript, "source": source, "ts": time.time()}, fh)

    def test_up_deletes_the_previous_sessions_service_record(self):
        chat = os.path.join(self.env["LEAN_AGENT_HOME"], "chat")
        os.makedirs(chat, exist_ok=True)
        rec = os.path.join(chat, "service.json")
        with open(rec, "w") as fh:
            json.dump({"session_id": "old", "transcript_path": "/x", "ts": time.time()}, fh)
        p, log, ss = self.start_up("--name", "la")
        self.assertFalse(os.path.exists(rec))

    def test_up_restart_keeps_the_record_until_no_transcript_of_its_chain_exists(self):
        ds, home, proj, tr, up = self._follow_env()
        import service_session
        rec = os.path.join(home, "chat", "service.json")
        missing = os.path.join(proj, "s2.jsonl")  # after a /clear, before the new transcript is written
        with open(rec, "w") as fh:
            json.dump({"session_id": "s2", "transcript_path": missing, "chain": [tr, missing]}, fh)
        with mock.patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": os.path.join(home, "cfg")}):
            service_session.drop_stale_record(proj, "s2")
            self.assertTrue(os.path.exists(rec))  # s1.jsonl of the chain exists
            os.remove(tr)
            service_session.drop_stale_record(proj, "s2")
            self.assertFalse(os.path.exists(rec))

    def _follow_env(self):
        sys.path.insert(0, os.path.dirname(CLI))
        home, proj, tr = self._follow_home()
        old = os.environ.get("LEAN_AGENT_HOME")
        os.environ["LEAN_AGENT_HOME"] = home
        def restore():
            if old is None:
                os.environ.pop("LEAN_AGENT_HOME", None)
            else:
                os.environ["LEAN_AGENT_HOME"] = old
        self.addCleanup(restore)
        return None, home, proj, tr, _load_json(os.path.join(home, "up.json"))


    def test_compaction_point_buffer(self):
        sys.path.insert(0, os.path.dirname(CLI))
        import lean_common
        old = os.environ.get("LEAN_AGENT_COMPACT_BUFFER")
        try:
            os.environ.pop("LEAN_AGENT_COMPACT_BUFFER", None)
            self.assertEqual(lean_common.compaction_point(100000, 70), 67000)
            os.environ["LEAN_AGENT_COMPACT_BUFFER"] = "50000"
            self.assertEqual(lean_common.compaction_point(100000, 70), 50000)
            os.environ["LEAN_AGENT_COMPACT_BUFFER"] = "lots"
            self.assertEqual(lean_common.compaction_point(100000, 70), 67000)
        finally:
            if old is None:
                os.environ.pop("LEAN_AGENT_COMPACT_BUFFER", None)
            else:
                os.environ["LEAN_AGENT_COMPACT_BUFFER"] = old

    def test_commands_record_the_current_thread(self):
        self.cli("learn", self.proj, "--name", "proj")
        lt = self.threads_home()
        tid, _, _ = lt.route("Fix the export timeout in billing", "s1")
        self.assertEqual(tid, "t1")
        self.cli("run", "-p", "proj", "look at it", "--model", "haiku", "--why", "t")
        self.assertEqual(self.ledger()[-1]["thread"], "t1")
        self.assertEqual(self.calls()[-1]["thread"], "t1")  # the worker's environment
        self.cli("run", "-p", "proj", "look again", "--model", "haiku", "--why", "t", "--thread", "none")
        self.assertIsNone(self.ledger()[-1]["thread"])
        self.assertEqual(self.calls()[-1]["thread"], "none")
        self.cli("run", "-p", "proj", "and again", "--model", "haiku", "--why", "t", "--thread", "#9")
        self.assertEqual(self.ledger()[-1]["thread"], "#9")
        self.cli("remember", "Never merge on Fridays.", FAKE_ANSWER="REMEMBERED feedback x")
        self.assertEqual(self.ledger()[-1]["thread"], "t1")
        self.cli("todo", "add", "Fix it", "--thread", "t1")
        self.cli("todo", "add", "Other", "--thread", "none")
        with open(os.path.join(self.env["LEAN_AGENT_HOME"], "todo.json")) as fh:
            items = json.load(fh)["items"]
        self.assertEqual([t.get("thread") for t in items], ["t1", None])
        self.cli("checkpoint", "state one")
        self.cli("handoff", "--note", "a note", "--kind", "fyi")
        with open(os.path.join(self.env["LEAN_AGENT_HOME"], "handoff-notes.json")) as fh:
            notes = json.load(fh)
        self.assertEqual([n.get("thread") for n in notes], ["t1", "t1"])
        # a worker's nested command inherits the thread from its environment
        self.cli("todo", "add", "Nested", LEAN_AGENT_THREAD="t5")
        with open(os.path.join(self.env["LEAN_AGENT_HOME"], "todo.json")) as fh:
            self.assertEqual(json.load(fh)["items"][-1]["thread"], "t5")
        self.assertNotEqual(self.cli("todo", "add", "x", "--thread", "bogus", check=False).returncode, 0)

    def threads_home(self):
        sys.path.insert(0, os.path.dirname(CLI))
        import lean_threads
        patch = mock.patch.dict(os.environ, {"LEAN_AGENT_HOME": self.env["LEAN_AGENT_HOME"]})
        patch.start()
        self.addCleanup(patch.stop)
        return lean_threads

    def test_pin_dedupes_a_handed_over_request_only_against_the_target_thread(self):
        self.cli("learn", self.proj, "--name", "proj")
        lt = self.threads_home()
        lt.route("Publish the report via docs", "s1")  # t1
        lt.route("Fix the export timeout in billing", "s1")  # t2
        self.assertTrue(lt.pin("t1", "Check the nightly run"))
        self.assertTrue(lt.pin("t2", "Check the nightly run"))  # same words, other thread: still t2's request
        self.assertTrue(lt.pin("t2", "Check the nightly run"))  # already stored for t2: not twice
        reqs = {t: [r["text"] for r in lt.load()["threads"][t].get("requests") or []] for t in ("t1", "t2")}
        self.assertEqual(reqs["t1"].count("Check the nightly run"), 1)
        self.assertEqual(reqs["t2"].count("Check the nightly run"), 1)

    def test_now_and_doctor_show_each_threads_session(self):
        self.cli("learn", self.proj, "--name", "proj")
        lt = self.threads_home()
        lt.route("Publish the report via docs", "s1")  # t1
        lt.route("Fix the export timeout in billing", "s1")  # t2
        lt.route("Profile the parser startup", "s1")  # t3
        lt.set_session("t1", session_id="11111111-1111-1111-1111-111111111111", session_on=True)
        lt.set_session("t2", session_id="22222222-2222-2222-2222-222222222222")  # closed: has a session id, not hosted
        up = os.path.join(self.env["LEAN_AGENT_HOME"], "up.json")
        with open(up, "w") as fh:
            json.dump({"sessions": {"t1": {"pid": os.getpid(), "name": "lean-agent \u00b7 t1 Publish report"}}}, fh)
        out = self.cli("now").stdout
        self.assertRegex(out, r'(?m)^  session: running \u2014 Remote Control "lean-agent \u00b7 t1 Publish report"$')
        self.assertRegex(out, r"(?m)^  session: closed$")
        self.assertEqual(out.count("session:"), 2)  # t3 never had a session
        doc = self.cli("doctor", check=False).stdout
        self.assertIn('thread t1 session: running (Remote Control "lean-agent \u00b7 t1 Publish report")', doc)
        self.assertIn("thread t2 session: closed", doc)
        self.assertNotIn("thread t3 session", doc)

    def test_now_and_thread_show_list_the_work_of_a_topic(self):
        self.cli("learn", self.proj, "--name", "proj")
        lt = self.threads_home()
        lt.route("Publish the report via docs", "s1")
        lt.route("Fix the export timeout in billing", "s1")
        self.cli("run", "-p", "proj", "look at the export", "--model", "haiku", "--why", "t")
        self.cli("todo", "add", "Fix export", "--thread", "t1")
        self.cli("todo", "add", "Fix billing", "--thread", "t2")
        self.cli("handoff", "--note", "export is slow on big files", "--kind", "fyi")
        with open(os.path.join(self.env["LEAN_AGENT_HOME"], "pushes.jsonl"), "a") as fh:
            fh.write(json.dumps({"ts": lt.now_iso(), "thread": "t2", "project": "proj", "branch": "fix-export",
                                 "to": "origin/main", "sha": "abcdef123456", "ok": True}) + "\n")
        out = self.cli("now").stdout
        self.assertLessEqual(len(out.splitlines()), 30)
        lines = [l for l in out.splitlines() if not l.startswith("  ")]  # the thread rows, not their detail lines
        self.assertTrue(lines[1].startswith("t2 "), out)  # latest activity first
        self.assertIn("1 todo open", lines[1])
        self.assertIn("push: proj fix-export", lines[1])
        self.assertIn("t1 ", lines[2])
        shown = self.cli("thread", "show", "t2").stdout
        kinds = [l[17:].split()[0] for l in shown.splitlines()[1:]]
        self.assertEqual(kinds, ["request", "run", "todo", "note", "push"])
        self.assertIn('t2 "Fix export timeout billing"', shown)
        self.assertIn("haiku", shown)
        self.assertNotIn("Publish the report", shown)
        # close hides it from now; reopen brings it back; show still works
        self.assertIn("t1 closed", self.cli("thread", "close", "t1").stdout)
        self.assertNotIn("t1 ", self.cli("now").stdout.split("\n", 1)[1])
        self.assertIn("[closed]", self.cli("thread", "show", "t1").stdout)
        self.cli("thread", "reopen", "t1")
        self.assertIn("t1 ", self.cli("now").stdout)
        self.assertNotEqual(self.cli("thread", "show", "t99", check=False).returncode, 0)

    def test_now_closes_idle_threads_after_a_week_and_never_deletes(self):
        lt = self.threads_home()
        lt.route("Old topic about the parser", "s1")
        lt.route("Fresh topic about deployments pipeline", "s1")
        reg = lt.path()
        with open(reg) as fh:
            data = json.load(fh)
        old = (datetime.datetime.now() - datetime.timedelta(days=9)).isoformat(timespec="seconds")
        data["threads"]["t1"]["last_message"] = old
        data["threads"]["t1"]["requests"][0]["ts"] = old
        with open(reg, "w") as fh:
            json.dump(data, fh)
        out = self.cli("now").stdout
        self.assertIn("Closed as idle (> 7 days): t1", out)
        self.assertNotIn("parser", out.split("Closed as idle")[0])
        with open(reg) as fh:
            self.assertIn("auto_closed", fh.read())
        self.assertIn("parser", self.cli("thread", "show", "t1").stdout)
        self.cli("thread", "reopen", "t1")
        self.assertNotIn("Closed as idle", self.cli("now").stdout)
        # the knob: env (or thread_idle_days in config.json); t2 is a day old, t1 was just reopened
        data = lt.load()
        data["threads"]["t2"]["last_message"] = data["threads"]["t2"]["requests"][0]["ts"] = (
            datetime.datetime.now() - datetime.timedelta(days=1)).isoformat(timespec="seconds")
        with open(reg, "w") as fh:
            json.dump(data, fh)
        out = self.cli("now", LEAN_AGENT_THREAD_IDLE_DAYS="0.5").stdout
        self.assertIn("Closed as idle (> 0.5 days): t2", out)
        self.assertNotIn("Closed as idle (> 0.5 days): t1", out)
        self.cli("thread", "reopen", "t2")
        with open(os.path.join(self.env["LEAN_AGENT_HOME"], "config.json"), "w") as fh:
            json.dump({"thread_idle_days": 0}, fh)  # not a positive number: the default
        self.assertNotIn("Closed as idle", self.cli("now").stdout)

    def test_thread_registry_new_merge_unmerge_move_and_expiry(self):
        lt = self.threads_home()
        self.assertEqual((lt.new("Pricing page"), lt.new("Billing")), ("t1", "t2"))
        self.assertEqual(lt.new("Third"), "t3")
        lt.merge("t2", "t1")
        self.assertEqual(lt.resolve("t2"), "t1")
        with open(lt.path()) as fh:
            self.assertEqual(json.load(fh)["aliases"], {"t2": "t1"})  # kept in the registry file
        self.assertEqual(sorted(t["id"] for t in lt.threads()), ["optimize", "t1", "t3"])  # t2 shows under t1
        for src, dst in (("t1", "t2"), ("t1", "t1")):  # a cycle, itself
            with self.assertRaises(ValueError):
                lt.merge(src, dst)
        lt.merge("t3", "t2")  # chains follow to the end
        self.assertEqual(lt.resolve("t3"), "t1")
        with self.assertRaises(ValueError):
            lt.merge("t1", "t3")
        with self.assertRaises(ValueError):
            lt.merge("t1", "t9")  # no such thread
        lt.unmerge("t2")
        self.assertEqual(lt.resolve("t2"), "t2")
        lt.merge("#10", "t1")  # task threads take part too
        # expiry is a filter: 7 days after the todo is done, 7 days without a message for a free thread
        day = 86400
        stamp = lambda ago: datetime.datetime.fromtimestamp(time.time() - ago * day).isoformat(timespec="seconds")
        data = lt.load()
        data["threads"]["t1"]["last_message"] = stamp(8)
        data["threads"].update({f"#{n}": {"id": f"#{n}", "title": f"task {n}", "created": stamp(30), "last_message": stamp(20),
                                          "kind": "task"} for n in (1, 2, 3)})
        with open(lt.path(), "w") as fh:
            json.dump(data, fh)
        with open(os.path.join(os.environ["LEAN_AGENT_HOME"], "todo.json"), "w") as fh:
            json.dump({"next": 4, "items": [{"id": 1, "status": "done", "done_at": stamp(8)},
                                            {"id": 2, "status": "done", "done_at": stamp(2)}, {"id": 3, "status": "doing"}]}, fh)
        shown = [t["id"] for t in lt.threads()]
        self.assertNotIn("t1", shown)
        self.assertNotIn("#1", shown)
        self.assertTrue({"t2", "#2", "#3", "optimize"} <= set(shown), shown)
        self.assertIn("t1", [t["id"] for t in lt.threads(include_expired=True)])  # nothing was deleted

    def test_a_done_task_with_a_fresh_request_stays_open(self):
        lt = self.threads_home()
        lt.new("anchor")  # creates the registry
        day = 86400
        stamp = lambda ago: datetime.datetime.fromtimestamp(time.time() - ago * day).isoformat(timespec="seconds")
        data = lt.load()
        data["threads"].update({f"#{n}": {"id": f"#{n}", "title": f"task {n}", "created": stamp(30), "last_message": stamp(fresh),
                                          "kind": "task"} for n, fresh in ((1, 0), (2, 20))})
        with open(lt.path(), "w") as fh:
            json.dump(data, fh)
        with open(os.path.join(os.environ["LEAN_AGENT_HOME"], "todo.json"), "w") as fh:
            json.dump({"next": 4, "items": [{"id": 1, "status": "done", "done_at": stamp(10)},
                                            {"id": 2, "status": "done"}]}, fh)  # #2: no done_at, so its last activity counts
        shown = [t["id"] for t in lt.threads()]
        self.assertIn("#1", shown)
        self.assertNotIn("#2", shown)
        out = self.cli("now").stdout
        self.assertIn("Closed as idle (> 7 days): #2", out)
        self.assertIn("#1 ", out.split("Closed as idle")[0])  # still open after `now`

    def test_thread_cli(self):
        self.assertEqual(self.cli("thread", "new", "Pricing page").stdout.strip(), "t1")
        self.assertEqual(self.cli("thread", "new", "Billing").stdout.strip(), "t2")
        self.assertEqual(self.cli("thread", "merge", "t2", "T1").stdout.strip(), "t2 -> t1")  # prints the normalized id
        self.assertEqual(self.cli("thread", "merge", "t1", "t2", check=False).returncode, 1)
        self.assertEqual(self.cli("thread", "merge", "t1", "t1", check=False).returncode, 1)
        self.cli("thread", "new", "Four")
        self.cli("thread", "merge", "t3", "#4")
        listed = json.loads(self.cli("thread", "list", "--json").stdout)
        self.assertEqual(sorted((t["id"], t["kind"]) for t in listed if t["id"] != "optimize"), [("#4", "task"), ("t1", "free")])
        self.assertIn("t1", self.cli("thread", "list").stdout)
        self.cli("thread", "unmerge", "t2")
        self.assertIn("t2", self.cli("thread", "list").stdout)
        self.assertEqual(self.cli("thread", "unmerge", "t2", check=False).returncode, 1)

    def test_an_explicit_thread_id_reopens_a_closed_thread(self):
        lt = self.threads_home()
        lt.route("Old topic about the parser", "s1")
        lt.route("Something else entirely about deployments", "s1")
        self.cli("thread", "close", "t1")
        tid, how, _ = lt.route("back to t1 please", "s1")
        self.assertEqual((tid, how), ("t1", "explicit"))
        self.assertNotIn("closed", lt.load()["threads"]["t1"])
        self.assertIn("t1 ", self.cli("now").stdout)
        lt.set_closed("t1", True)
        with lt._locked() as data:
            data["threads"]["t1"]["auto_closed"] = True
        lt.route("t1 again", "s1")
        self.assertNotIn("auto_closed", lt.load()["threads"]["t1"])

    def test_thread_move_rehomes_the_latest_request_and_the_work_since(self):
        self.cli("learn", self.proj, "--name", "proj")
        lt = self.threads_home()
        lt.route("Publish the report via docs", "s1")
        lt.route("Fix the export timeout in billing", "s1")  # t2
        old = (datetime.datetime.now() - datetime.timedelta(hours=1)).isoformat(timespec="seconds")
        self.cli("run", "-p", "proj", "before the request", "--model", "haiku", "--why", "t", "--thread", "t2")
        led = os.path.join(self.env["LEAN_AGENT_HOME"], "ledger.jsonl")
        with open(led) as fh:
            rows = [json.loads(l) for l in fh]
        rows[-1]["ts"] = old  # a run from before the request stays
        with open(led, "w") as fh:
            fh.write("".join(json.dumps(r) + "\n" for r in rows))
        data = lt.load()
        data["threads"]["t2"]["requests"][-1]["ts"] = (datetime.datetime.now() - datetime.timedelta(seconds=30)).isoformat(timespec="seconds")
        data["threads"]["t1"]["closed"] = "2026-01-01T00:00:00"
        with open(lt.path(), "w") as fh:
            json.dump(data, fh)
        self.cli("run", "-p", "proj", "after the request", "--model", "haiku", "--why", "t")  # current thread t2
        self.cli("todo", "add", "Fix export", "--thread", "t2")
        self.cli("handoff", "--note", "slow on big files", "--kind", "fyi")
        with open(led) as fh:
            before = fh.read()
        self.assertIn("moved from t2 to t1", self.cli("thread", "move", "t1").stdout)
        with open(led) as fh:
            self.assertEqual(fh.read(), before)  # append-only logs are untouched
        self.assertEqual(lt.current(), "t1")
        reg = lt.load()
        self.assertNotIn("closed", reg["threads"]["t1"])  # it was reopened
        self.assertEqual(len(reg["threads"]["t1"]["requests"]), 2)
        self.assertEqual(len(reg["threads"]["t2"]["requests"]), 0)
        with open(os.path.join(self.env["LEAN_AGENT_HOME"], "todo.json")) as fh:
            self.assertEqual(json.load(fh)["items"][0]["thread"], "t1")
        shown = self.cli("thread", "show", "t1").stdout
        runs = lambda out: [l for l in out.splitlines() if " run " in l]
        self.assertEqual(len(runs(shown)), 1)  # the one after the request
        self.assertEqual(len(runs(self.cli("thread", "show", "t2").stdout)), 1)  # the one before stays
        self.assertIn("slow on big files", shown)
        self.assertIn("\nt1 ", self.cli("now").stdout)  # both rows; their order within one second is a tie
        self.cli("run", "-p", "proj", "later", "--model", "haiku", "--why", "t")
        self.assertEqual(self.ledger()[-1]["thread"], "t1")  # the current thread follows
        self.assertEqual(self.cli("thread", "move", "t1", check=False).returncode, 1)  # already there

    def test_thread_move_errors_alias_targets_and_review_and_push_overrides(self):
        lt = self.threads_home()
        r = self.cli("thread", "move", "t1", check=False)  # nothing was ever routed
        self.assertEqual(r.returncode, 1)
        self.assertIn("no current thread", r.stdout + r.stderr)
        lt.route("Publish the report via docs", "s1")  # t1
        lt.route("Fix the export timeout in billing", "s1")  # t2
        lt.new("Elsewhere")  # t3
        r = self.cli("thread", "move", "t9", check=False)
        self.assertEqual(r.returncode, 1)
        self.assertEqual(lt.current(), "t2")  # nothing changed
        self.assertEqual(len(lt.load()["threads"]["t2"]["requests"]), 1)
        lt.merge("t3", "t1")  # t3 shows under t1
        h = self.env["LEAN_AGENT_HOME"]
        ts = (datetime.datetime.now() + datetime.timedelta(seconds=5)).isoformat(timespec="seconds")
        os.makedirs(os.path.join(h, "reviews"), exist_ok=True)
        with open(os.path.join(h, "reviews", "proj.jsonl"), "w") as fh:
            fh.write(json.dumps({"run": "r77", "ts": ts, "thread": "t2", "verdict": "ok", "findings": []}) + "\n")
        with open(os.path.join(h, "pushes.jsonl"), "w") as fh:
            fh.write(json.dumps({"ts": ts, "project": "proj", "branch": "feat-x", "to": "main", "sha": "abcdef1234", "thread": "t2"}) + "\n")
        self.assertIn("moved from t2 to t1", self.cli("thread", "move", "t3").stdout)  # the alias goes to its target
        self.assertEqual(lt.current(), "t1")
        shown = self.cli("thread", "show", "t1").stdout
        self.assertIn("r77 proj ok", shown)
        self.assertIn("proj feat-x -> main abcdef12", shown)
        old = self.cli("thread", "show", "t2").stdout
        self.assertNotIn("r77", old)
        self.assertNotIn("feat-x", old)

    def test_thread_move_is_scoped_to_one_session_and_to_a_recent_request(self):
        lt = self.threads_home()
        lt.route("Publish the report via docs", "s1")  # t1
        lt.route("Fix the export timeout in billing", "s2")  # t2
        out = self.cli("thread", "move", "t1", LEAN_AGENT_SESSION="s2").stdout
        self.assertIn("moved from t2 to t1", out)  # s2's request, though s1's came first
        self.assertEqual(len(lt.load()["threads"]["t1"]["requests"]), 2)
        stale = (datetime.datetime.now() - datetime.timedelta(hours=25)).isoformat(timespec="seconds")
        with open(lt.state_path()) as fh:
            st = json.load(fh)
        for rec in list(st["sessions"].values()) + [st["latest"]]:
            rec["ts"] = stale
        with open(lt.state_path(), "w") as fh:
            json.dump(st, fh)
        r = self.cli("thread", "move", "t2", check=False)
        self.assertEqual(r.returncode, 1)
        self.assertIn("nothing recent to move", r.stdout + r.stderr)

    def write_ledger(self, *recs):
        with open(os.path.join(self.env["LEAN_AGENT_HOME"], "ledger.jsonl"), "a") as fh:
            for r in recs:
                fh.write(json.dumps(r) + "\n")

    def iso(self, ago):
        return (datetime.datetime.now() - datetime.timedelta(seconds=ago)).isoformat(timespec="seconds")

    def test_notification_attaches_to_its_runs_thread_and_creates_nothing(self):
        lt = self.threads_home()
        h = self.env["LEAN_AGENT_HOME"]
        lt.route("Publish the report via docs", "s1")  # t1
        lt.route("Fix the export timeout in billing", "s1")  # t2, the current thread
        self.write_ledger({"id": "0101-100000-aaaa", "ts": self.iso(60), "thread": "t1", "model": "haiku", "status": "ok",
                           "task": "Draft the quarterly report outline for the docs site"},
                          {"id": "0101-100100-bbbb", "ts": self.iso(50), "thread": "t2", "model": "haiku", "status": "ok",
                           "task": "Profile the billing export"})
        out_file = os.path.join(h, "bg.output")
        with open(out_file, "w") as fh:
            fh.write("run 0101-100000-aaaa started \xb7 haiku \xb7 proj\nresult...\n")
        before = json.dumps(lt.load(), sort_keys=True)
        cur = lt.current("s1")
        note = lambda body: f"<task-notification>\n<task-id>bx1</task-id>\n{body}\n</task-notification>"
        # 1. the run id inside the notification's output file
        line = lt.notification_line(note(f"<output-file>{out_file}</output-file>\n<summary>Background command completed (exit code 0)</summary>"))
        self.assertTrue(line.startswith('Thread t1 "Publish report via docs"'), line)
        self.assertNotIn("guess", line)
        # 2. a run id in the text
        self.assertTrue(lt.notification_line(note("run 0101-100100-bbbb finished")).startswith("Thread t2 "))
        # 3. the task's command text
        cmd = 'Background command "lean-agent run -p proj -- Draft the quarterly report outline for the docs site" completed'
        self.assertTrue(lt.notification_line(note(f"<summary>{cmd}</summary>")).startswith("Thread t1 "))
        # no run found: silent, on the current thread
        self.assertEqual(lt.notification_line(note("<summary>Background command \"sleep 5\" completed</summary>")), "")
        self.assertEqual(lt.notification_line(note("<output-file>/nonexistent/x.output</output-file>")), "")
        self.assertEqual(json.dumps(lt.load(), sort_keys=True), before)  # no thread, no request
        self.assertEqual(lt.current("s1"), cur)
        # a moved run follows the override; a merged thread its target
        lt.merge("t1", "t2")
        self.assertTrue(lt.notification_line(note(f"<output-file>{out_file}</output-file>")).startswith("Thread t2 "))
        self.assertTrue(lt.is_notification(note("x")))
        self.assertTrue(lt.is_notification('Background command "x" completed (exit code 0)'))
        self.assertTrue(lt.is_notification("<system-reminder>hook said</system-reminder>"))
        self.assertFalse(lt.is_notification("please fix the completed export"))
        self.assertFalse(lt.is_notification("why does the task-id column stay empty in the export?"))
        self.assertFalse(lt.is_notification('see the line Background command "x" completed in the log'))

    def test_hint_only_when_the_guess_is_uncertain(self):
        lt = self.threads_home()
        self.assertFalse(lt._uncertain([(0.9, "t1"), (0.3, "t2")], "t1", "t2"))  # a clear winner
        self.assertTrue(lt._uncertain([(0.9, "t1"), (0.85, "t2")], "t1", "t2"))  # too close to the second
        self.assertTrue(lt._uncertain([(0.45, "t1")], "t1", None))  # near the threshold
        self.assertFalse(lt._uncertain([(0.45, "t1")], "t1", "t1"))  # the current thread continues
        t0 = datetime.datetime.now().timestamp() - 5000
        lt.route("Publish the quarterly report via docs", "s1", t0)  # t1
        lt.route("Fix the export timeout in billing", "s1", t0 + 10)  # t2
        lt.route("Profile billing report generation", "s1", t0 + 20)  # t3 or a guess: two shared topics
        self.assertEqual(len(lt.load()["threads"]), 3)
        # the same words in two threads, the current one (t3) not the best: uncertain, with the request id and the move command
        tid, how, line = lt.route("export billing report docs", "s1", t0 + 30)
        self.assertEqual(how, "guessed")
        self.assertRegex(line, r'^Thread t\d "[^"]+" \(r\d+, guessed \u2014 wrong\? lean-agent thread move r\d+ tN\)$')
        rid = lt.load()["threads"][tid]["requests"][-1]["id"]
        self.assertIn(f"({rid}, guessed", line)
        self.assertIn(f"thread move {rid} tN", line)
        # a clear winner: no hint
        tid, how, line = lt.route("the quarterly report needs a chart in the docs", "s1", t0 + 40)
        self.assertEqual((tid, how), ("t1", "guessed"))
        self.assertEqual(line, 'Thread t1 "Publish quarterly report via docs"')
        # the current thread continues: no hint either
        tid, how, line = lt.route("the quarterly report chart docs again", "s1", t0 + 50)
        self.assertEqual((tid, how, line), ("t1", "guessed", 'Thread t1 "Publish quarterly report via docs"'))
        ids = [r["id"] for t in lt.load()["threads"].values() for r in t["requests"]]
        self.assertEqual(len(ids), len(set(ids)))  # unique per home

    def test_thread_move_by_request_id_moves_the_work_until_the_next_request(self):
        lt = self.threads_home()
        t0 = datetime.datetime.now().timestamp() - 3000
        lt.route("Publish the report via docs", "s1", t0)  # t1 r1
        lt.route("Fix the export timeout in billing", "s1", t0 + 100)  # t2 r2
        lt.route("Publish the report docs chart", "s1", t0 + 200)  # t1 r3
        lt.route("Write the report docs summary", "s1", t0 + 400)  # t1 r4
        iso = lambda off: datetime.datetime.fromtimestamp(t0 + off).isoformat(timespec="seconds")
        self.write_ledger({"id": "0101-100000-aaaa", "ts": iso(250), "thread": "t1", "model": "haiku", "status": "ok", "task": "after r3"},
                          {"id": "0101-100001-bbbb", "ts": iso(450), "thread": "t1", "model": "haiku", "status": "ok", "task": "after r4"},
                          {"id": "0101-100002-cccc", "ts": iso(50), "thread": "t1", "model": "haiku", "status": "ok", "task": "after r1"})
        self.assertEqual([r["id"] for r in lt.load()["threads"]["t1"]["requests"]], ["r1", "r3", "r4"])
        out = self.cli("thread", "move", "r3", "t2").stdout
        self.assertIn("r3 moved from t1 to t2", out)
        reg = lt.load()["threads"]
        self.assertEqual([r["id"] for r in reg["t1"]["requests"]], ["r1", "r4"])
        self.assertEqual([r["id"] for r in reg["t2"]["requests"]], ["r2", "r3"])
        self.assertEqual(lt.current(), "t1")  # r4 is still the latest request
        shown2 = self.cli("thread", "show", "t2").stdout
        self.assertIn("after r3", shown2)  # started after r3, before r4
        self.assertNotIn("after r4", shown2)
        shown1 = self.cli("thread", "show", "t1").stdout
        self.assertIn("after r4", shown1)
        self.assertIn("after r1", shown1)
        self.assertNotIn("after r3", shown1)
        # a thread as the source: its latest request; the old one-argument form still works
        self.assertIn("moved from t1 to t2", self.cli("thread", "move", "t1", "t2").stdout)  # r4
        self.assertEqual(lt.current(), "t2")  # it was the latest request
        self.assertIn("after r4", self.cli("thread", "show", "t2").stdout)
        self.assertIn("latest request moved from t2 to t1", self.cli("thread", "move", "t1").stdout)
        bad = self.cli("thread", "move", "r99", "t1", check=False)
        self.assertEqual(bad.returncode, 1)
        self.assertIn("no request r99", bad.stdout + bad.stderr)
        self.assertEqual(self.cli("thread", "move", "r1", "t1", check=False).returncode, 1)  # already there

    def test_a_resumed_run_keeps_its_thread_and_a_new_run_follows_the_current_one(self):
        self.cli("learn", self.proj, "--name", "proj")
        lt = self.threads_home()
        lt.route("Publish the report via docs", "s1")  # t1
        self.cli("run", "-p", "proj", "first", "--model", "haiku", "--why", "t")
        first = self.ledger()[-1]
        self.assertEqual(first["thread"], "t1")
        lt.route("Fix the export timeout in billing", "s1")  # t2 is current now
        self.cli("run", "-p", "proj", "second", "--model", "haiku", "--why", "t")
        self.assertEqual(self.ledger()[-1]["thread"], "t2")
        self.cli("run", "--resume", first["id"], "and then more", "--why", "t")
        self.assertEqual(self.ledger()[-1]["thread"], "t1")
        self.assertEqual(self.calls()[-1]["thread"], "t1")  # its nested commands too
        self.assertEqual(lt.current("s1"), "t2")  # a run never changes the current thread
        self.cli("run", "--resume", first["id"], "explicit", "--thread", "t2", "--why", "t")
        self.assertEqual(self.ledger()[-1]["thread"], "t2")

    def test_now_shows_the_parallel_work_of_each_thread_in_few_lines(self):
        lt = self.threads_home()
        h = self.env["LEAN_AGENT_HOME"]
        lt.route("Publish the report via docs", "s1")  # t1
        lt.route("Fix the export timeout in billing", "s1")  # t2
        self.write_ledger({"id": "0101-100000-aaaa", "ts": self.iso(300), "thread": "t1", "model": "sonnet", "status": "ok",
                           "task": "Draft the outline", "result_head": "outline done"})
        with open(os.path.join(h, "collected.json"), "w") as fh:
            json.dump({"_cutoff": self.iso(3600)}, fh)
        os.makedirs(os.path.join(h, "running"), exist_ok=True)
        with open(os.path.join(h, "running", "0101-100050-bbbb.json"), "w") as fh:
            json.dump({"pid": os.getpid(), "run": "0101-100050-bbbb", "started": self.iso(125), "model": "opus",
                       "task": "Fix the export timeout\nwith a retry", "thread": "t2"}, fh)
        os.makedirs(os.path.join(h, "reviews"), exist_ok=True)
        with open(os.path.join(h, "reviews", "proj.jsonl"), "w") as fh:
            fh.write(json.dumps({"run": "0101-100000-aaaa", "ts": self.iso(200), "thread": "t1", "verdict": "changes-requested",
                                 "findings": [{}, {}]}) + "\n")
        self.cli("todo", "add", "Chart for the report", "--thread", "t1")
        out = self.cli("now").stdout
        lines = out.splitlines()
        self.assertLessEqual(len(lines), 30)
        t1 = lines.index(next(l for l in lines if l.startswith("t1 ")))
        t2 = lines.index(next(l for l in lines if l.startswith("t2 ")))
        det = lambda i, j: "\n".join(lines[i + 1:j])
        d2 = det(t2, len(lines)) if t2 > t1 else det(t2, t1)
        d1 = det(t1, t2) if t1 < t2 else det(t1, len(lines))
        self.assertRegex(d2, r"  running 0101-100050-bbbb opus 2m\d\ds: Fix the export timeout with a retry")
        self.assertRegex(d1, r"  done, not collected 0101-100000-aaaa sonnet ok: Draft the outline")
        self.assertIn("  review open 0101-100000-aaaa proj: changes-requested 2 findings", d1)
        self.assertIn("  next todo #", d1)
        self.assertNotIn("not collected", d2)
        # many threads still fit the budget, and the brief carries it
        for i in range(40):
            lt.new(f"Topic number {i}")
        self.assertLessEqual(len(self.cli("now").stdout.splitlines()), 30)

    def test_thread_move_uses_the_up_json_session_and_falls_back_for_an_unknown_one(self):
        lt = self.threads_home()
        lt.route("Publish the report via docs", "s1")  # t1
        lt.route("Fix the export timeout in billing", "s2")  # t2
        up = os.path.join(self.env["LEAN_AGENT_HOME"], "up.json")
        env = {k: v for k, v in self.env.items() if k != "LEAN_AGENT_SESSION"}
        self.env.clear()
        self.env.update(env)
        with open(up, "w") as fh:
            json.dump({"session_id": "s1"}, fh)
        r = self.cli("thread", "move", "t2")  # s1's request, though s2's is the latest
        self.assertIn("moved from t1 to t2", r.stdout)
        with open(up, "w") as fh:
            json.dump({"session_id": "nope"}, fh)
        r = self.cli("thread", "move", "t1")  # unknown session: the latest request of any session
        self.assertIn("moved from t2 to t1", r.stdout)

    def test_thread_move_needs_exactly_one_argument(self):
        for args in ((), ("t1", "t2", "t3")):
            r = self.cli("thread", "move", *args, check=False)
            self.assertEqual(r.returncode, 1)
            self.assertIn("usage: lean-agent thread move [rN|tM] tN", r.stdout + r.stderr)

    def test_thread_expiry_counts_merged_threads_last_message(self):
        lt = self.threads_home()
        lt.new("A")
        lt.new("B")
        lt.merge("t2", "t1")
        stamp = lambda ago: datetime.datetime.fromtimestamp(time.time() - ago * 86400).isoformat(timespec="seconds")
        data = lt.load()
        data["threads"]["t1"]["last_message"] = stamp(20)
        data["threads"]["t2"]["last_message"] = stamp(1)
        with open(lt.path(), "w") as fh:
            json.dump(data, fh)
        self.assertIn("t1", [t["id"] for t in lt.threads()])  # t2's recent message keeps its target alive
        data["threads"]["t2"]["last_message"] = stamp(20)
        with open(lt.path(), "w") as fh:
            json.dump(data, fh)
        self.assertNotIn("t1", [t["id"] for t in lt.threads()])

    def test_up_restarts_a_session_that_dies_but_not_one_that_fails_at_once(self):
        import signal as _sig
        self.env["LEAN_AGENT_SESSION_QUICK_EXIT"] = "0"  # every death counts as "ran for a while"
        p, log, ss = self.start_up()
        pid = ss.info()["pid"]
        os.kill(pid, _sig.SIGKILL)
        self.wait_for(lambda: len(self.read_jsonl(log)) == 2 and ss.alive(), "the restart", secs=20)
        self.assertNotEqual(ss.info()["pid"], pid)
        self.assertEqual(self.read_jsonl(log)[1]["argv"][-2:], ["--session-id", self.read_jsonl(log)[0]["argv"][-1]])
        p.terminate()
        p.wait(timeout=20)
        # a start that dies at once ends `up` (the service manager decides what to do)
        self.env["LEAN_AGENT_SESSION_QUICK_EXIT"] = "20"
        p, log, ss = self.start_up()
        os.kill(ss.info()["pid"], _sig.SIGKILL)
        p.wait(timeout=30)
        self.assertEqual(len(self.read_jsonl(log)), 3)

    def read_json(self, path):
        with open(path) as fh:
            return json.load(fh)

    def thread_calls(self, log):
        return {c["thread"]: c for c in self.read_jsonl(log) if c.get("thread")}

    def test_every_thread_is_its_own_hosted_session(self):
        p, log, ss = self.start_up("--name", "la")
        prompt = os.path.join(self.tmp.name, "p.txt")
        with open(prompt, "w") as fh:
            fh.write("first job")
        out = self.cli("thread", "new", "Fix the parser please", "--prompt-file", prompt).stdout
        self.assertIn('thread t1 started: Remote Control "lean-agent \u00b7 t1 Fix the parser please"', out)
        self.cli("thread", "new", "A very long title that has to be cut so the name stays short")
        self.wait_for(lambda: len(self.thread_calls(log)) == 2 and ss.alive("t1") and ss.alive("t2"), "both thread sessions")
        calls = self.thread_calls(log)
        main = self.read_jsonl(log)[0]
        self.assertIsNone(main["thread"])
        self.assertEqual(main["role"], "main")
        for tid, c in calls.items():
            self.assertEqual(c["role"], "thread")
            self.assertEqual(c["service"], "1")
            name = c["argv"][c["argv"].index("--remote-control") + 1]
            self.assertTrue(name.startswith(f"lean-agent \u00b7 {tid} "))
            self.assertLessEqual(len(name), 40)
        self.assertEqual(calls["t1"]["argv"][calls["t1"]["argv"].index("--remote-control") + 1], "lean-agent \u00b7 t1 Fix the parser please")
        sid1 = calls["t1"]["argv"][-1]
        self.assertNotEqual(sid1, main["argv"][-1])
        # up.json: main plus a record per thread, each with its own socket and pid
        up = self.read_json(os.path.join(self.env["LEAN_AGENT_HOME"], "up.json"))
        self.assertEqual(sorted(up["sessions"]), ["main", "t1", "t2"])
        self.assertEqual(up["sessions"]["t1"]["session_id"], sid1)
        self.assertEqual(len({r["socket"] for r in up["sessions"].values()}), 3)
        # the first message arrives (brief + prompt) in t1 only
        tr1 = ss.info("t1")["transcript"]
        self.wait_for(lambda: len(self.read_jsonl(tr1)) >= 2, "the first message")
        first = self.read_jsonl(tr1)[0]["message"]["content"]
        self.assertTrue(first.startswith('Thread t1 "Fix the parser please"'), first)
        self.assertTrue(first.endswith("first job"))
        self.assertEqual(self.read_jsonl(ss.info("t2")["transcript"]), [])
        # send reaches the right pty
        msg = os.path.join(self.tmp.name, "m.txt")
        with open(msg, "w") as fh:
            fh.write("only for two")
        self.cli("thread", "send", "t2", "--prompt-file", msg)
        tr2 = ss.info("t2")["transcript"]
        self.wait_for(lambda: len(self.read_jsonl(tr2)) >= 2, "the message in t2")
        self.assertEqual(self.read_jsonl(tr2)[0]["message"]["content"], "only for two")
        self.assertNotIn("only for two", json.dumps(self.read_jsonl(tr1)))
        listing = self.cli("thread", "sessions").stdout
        self.assertIn("t1", listing)
        self.assertIn("t2", listing)
        # manual clear of one thread's session moves only its record and registry session id
        self.cli("clear", "--thread", "t1")
        self.wait_for(lambda: self.read_jsonl(log)[-1].get("clear_hook") is not None or any(
            "clear_hook" in c for c in self.read_jsonl(log)), "the clear", secs=30)
        self.wait_for(lambda: ss.info("t1")["session_id"] != sid1, "t1 on its new session id", secs=30)
        self.assertEqual(ss.info("main")["session_id"], main["argv"][-1])
        reg = self.read_json(os.path.join(self.env["LEAN_AGENT_HOME"], "threads.json"))["threads"]
        self.assertEqual(reg["t1"]["session_id"], ss.info("t1")["session_id"])
        self.assertEqual(reg["t2"]["session_id"], calls["t2"]["argv"][-1])
        p.terminate()
        p.wait(timeout=30)

    def test_closing_and_opening_a_thread_resumes_the_same_session_and_restart_resumes_all(self):
        p, log, ss = self.start_up()
        for title in ("one", "two"):
            self.cli("thread", "new", title)
        self.wait_for(lambda: len(self.thread_calls(log)) == 2 and ss.alive("t1") and ss.alive("t2"), "both sessions")
        sids = {t: c["argv"][-1] for t, c in self.thread_calls(log).items()}
        n = len(self.read_jsonl(log))
        out = self.cli("thread", "close", "t1").stdout
        self.assertIn("t1: session stopped", out)
        self.assertFalse(ss.alive("t1"))
        self.assertTrue(ss.alive("t2"))
        self.assertNotIn("t1", self.cli("thread", "sessions").stdout)
        reg = self.read_json(os.path.join(self.env["LEAN_AGENT_HOME"], "threads.json"))["threads"]
        self.assertEqual((reg["t1"]["session_id"], bool(reg["t1"].get("closed")), reg["t1"].get("session_on")), (sids["t1"], True, None))
        self.assertIn("resumed", self.cli("thread", "open", "t1").stdout)
        self.wait_for(lambda: len(self.read_jsonl(log)) == n + 1 and ss.alive("t1"), "t1 again")
        call = self.read_jsonl(log)[-1]
        self.assertEqual((call["thread"], call["argv"][-2:]), ("t1", ["--resume", sids["t1"]]))
        # restarting the service resumes every open thread session (and the main one); a session with a transcript by --resume
        self.assertTrue(ss.send("hello two", "t2")[0])
        self.wait_for(lambda: os.path.exists(ss.info("t2")["transcript"]), "t2's transcript")
        p.terminate()
        p.wait(timeout=30)
        p2, log2, ss = self.start_up()
        self.wait_for(lambda: ss.alive("t1") and ss.alive("t2"), "the thread sessions after a restart")
        self.wait_for(lambda: sum(1 for c in self.read_jsonl(log) if c.get("thread") == "t2") == 2, "t2 started again")
        again = self.thread_calls(log)
        self.assertEqual({t: c["argv"][-2:] for t, c in again.items()}, {t: ["--resume", sids[t]] for t in sids})
        p2.terminate()
        p2.wait(timeout=30)

    def test_thread_new_rolls_back_when_the_session_does_not_start(self):
        sys.path.insert(0, os.path.dirname(CLI))
        import lean_agent as L
        import lean_threads
        import service_session
        args = argparse.Namespace(action="new", args=["export retries"], prompt_file=None, json=False, all=False)
        with mock.patch.dict(os.environ, self.env), mock.patch.object(service_session, "alive", side_effect=lambda key="main": key == "main"), \
                mock.patch.object(service_session, "sessions_request", return_value={"ok": False, "error": "boom"}), \
                contextlib.redirect_stderr(io.StringIO()) as err:
            with self.assertRaises(SystemExit):
                L.cmd_thread(args)
            self.assertIn("boom", err.getvalue())
            self.assertEqual(lean_threads.load()["threads"], {})  # no thread left, none marked as hosted
            self.assertEqual(lean_threads.session_threads(), [])

    def test_thread_new_keeps_the_thread_when_the_start_times_out_but_the_session_runs(self):
        sys.path.insert(0, os.path.dirname(CLI))
        import lean_agent as L
        import lean_threads
        import service_session
        args = argparse.Namespace(action="new", args=["export retries"], prompt_file=None, json=False, all=False)
        with mock.patch.dict(os.environ, self.env), mock.patch.object(service_session, "alive", return_value=True), \
                mock.patch.object(service_session, "sessions_request", return_value={"ok": False, "error": "timed out"}), \
                contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(L.cmd_thread(args), 0)
            self.assertIn("thread t1 started", out.getvalue())
            self.assertTrue(lean_threads.load()["threads"]["t1"].get("session_on"))
            self.assertEqual(lean_threads.session_threads(), ["t1"])

    def test_discard_only_removes_a_thread_without_requests(self):
        self.cli("learn", self.proj, "--name", "proj")
        lt = self.threads_home()
        lt.route("Publish the report via docs", "s1")  # t1, with its first request
        empty = lt.new("brand new")
        lt.discard("t1")
        lt.discard(empty)
        self.assertEqual(list(lt.load()["threads"]), ["t1"])

    def test_failed_thread_send_leaves_session_on_unset(self):
        self.cli("learn", self.proj, "--name", "proj")
        lt = self.threads_home()
        lt.route("Publish the report via docs", "s1")  # t1
        sys.path.insert(0, os.path.dirname(CLI))
        import lean_agent as L
        import service_session
        args = argparse.Namespace(action="send", args=["t1"], prompt_file=None, json=False, all=False)
        with mock.patch.dict(os.environ, self.env), mock.patch.object(L, "thread_prompt", return_value="go on"), \
                mock.patch.object(service_session, "alive", side_effect=lambda key="main": key == "main"), \
                mock.patch.object(service_session, "sessions_request", return_value={"ok": False, "error": "boom"}), \
                contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                L.cmd_thread(args)
        self.assertIsNone(lt.load()["threads"]["t1"].get("session_on"))

    def start_thread_with_lost_reply(self, delay, grace):
        """start_thread_session against a real `up` whose start reply is lost (as on a timeout); returns (result, stops)."""
        import lean_agent as L
        import service_session
        lt = self.threads_home()
        tid = lt.new("slow")
        real, real_alive, stops, t0 = service_session.sessions_request, service_session.alive, [], time.time()

        def alive(key="main"):  # the thread's host answers only `delay` seconds after the start request
            return real_alive(key) and (key == "main" or time.time() - t0 >= delay)

        def lost(op, **kw):
            if op == "stop":
                stops.append(kw["thread"])
            r = real(op, **kw)
            return {"ok": False, "error": "timed out"} if op == "start" else r
        with mock.patch.dict(os.environ, dict(self.env, FAKE_START_DELAY=str(delay))), \
                mock.patch.object(service_session, "sessions_request", side_effect=lost), \
                mock.patch.object(service_session, "alive", side_effect=alive), \
                mock.patch.object(L, "START_GRACE", grace):
            try:
                return tid, L.start_thread_session(tid, lt.load()["threads"][tid]), stops, lt
            except RuntimeError as exc:
                return tid, exc, stops, lt

    def test_thread_start_waits_for_a_slow_host_after_a_lost_reply(self):
        sys.path.insert(0, os.path.dirname(CLI))
        p, log, ss = self.start_up()
        tid, res, stops, lt = self.start_thread_with_lost_reply(delay=2, grace=20)
        self.assertNotIsInstance(res, Exception)
        self.assertEqual(stops, [])
        self.assertTrue(lt.load()["threads"][tid].get("session_on"))
        ss.sessions_request("stop", thread=tid)
        p.terminate()
        p.wait(timeout=30)

    def test_thread_start_that_never_comes_up_is_rolled_back_and_stopped(self):
        sys.path.insert(0, os.path.dirname(CLI))
        p, log, ss = self.start_up()
        tid, res, stops, lt = self.start_thread_with_lost_reply(delay=30, grace=1)
        self.assertIsInstance(res, RuntimeError)
        self.assertEqual(stops, [tid])
        self.assertIsNone(lt.load()["threads"][tid].get("session_on"))
        self.assertFalse(ss.alive(tid))
        p.terminate()
        p.wait(timeout=30)

    def test_thread_new_refuses_above_max_thread_sessions(self):
        p, log, ss = self.start_up()
        self.cli("config", "max-thread-sessions", "1")
        # a host record the service just wrote (host_pid of a live process) counts whether or not that host answers yet
        ss.update_session("t9", host_pid=os.getpid(), host_started=time.time(), pid=None)
        self.assertFalse(ss.alive("t9"))
        marker = os.path.join(self.env["LEAN_AGENT_HOME"], "running", "k9.json")  # a live run tagged with it: not closable
        os.makedirs(os.path.dirname(marker), exist_ok=True)
        with open(marker, "w") as fh:
            json.dump({"pid": os.getpid(), "run": "0101-000009-aaaa", "started": "2026-01-01T00:00:00", "task": "t",
                       "model": "haiku", "project": "proj", "thread": "t9"}, fh)
        r = self.cli("thread", "new", "second", check=False)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("max-thread-sessions 1", r.stderr + r.stdout)
        self.assertFalse(os.path.exists(os.path.join(self.env["LEAN_AGENT_HOME"], "threads.json")) and
                         self.read_json(os.path.join(self.env["LEAN_AGENT_HOME"], "threads.json"))["threads"])
        os.remove(marker)
        ss.update_session("t9", host_pid=None)  # the host stopped
        self.assertIn("t1 started", self.cli("thread", "new", "first").stdout)
        r = self.cli("thread", "new", "third")  # at the cap the idle t1 makes room
        self.assertIn('closed t1 "first"', r.stdout)
        self.assertIn("t2 started", r.stdout)
        self.cli("thread", "close", "t2")
        self.assertIn("t3 started", self.cli("thread", "new", "fourth").stdout)
        p.terminate()
        p.wait(timeout=30)

    def test_wrapper_non_push_git_spawns_no_extra_git(self):
        sys.path.insert(0, os.path.dirname(CLI))
        import push_guard
        calls, execs = [], []
        old = (push_guard._git, os.execv)
        old_env = os.environ.pop("LEAN_AGENT_PUSH_GUARD_OVERRIDE", None)
        push_guard._git = lambda *a, **k: calls.append(a)
        os.execv = lambda real, argv: execs.append(argv)
        try:
            push_guard.git_wrapper("/bin/git", ["status", "-s"])
            self.assertEqual(calls, [])
            self.assertEqual(len(execs), 1)
            self.assertNotIn("LEAN_AGENT_PUSH_GUARD_OVERRIDE", os.environ)
        finally:
            push_guard._git, os.execv = old
            if old_env is not None:
                os.environ["LEAN_AGENT_PUSH_GUARD_OVERRIDE"] = old_env

    def test_chrome_check_and_run(self):
        self.cli("learn", self.proj)
        p = self.cli("run", "-p", "proj", "-m", "sonnet", "--why", "x", "--chrome", "--", "draft it", check=False)
        self.assertIn("chrome check", p.stderr)  # refuses until verified
        out = self.cli("chrome", "check", FAKE_CHROME="strict").stdout
        self.assertIn("Workers can use Claude in Chrome (strict isolation): 4 tools, ~3,000 tokens", out)
        self.assertRegex(self.cli("mcp", "list").stdout, r"claude-in-chrome\s+chrome\s+builtin\s+4\s+3,000")
        self.cli("run", "-p", "proj", "-m", "sonnet", "--why", "x", "--chrome", "navigate,find", "--", "draft a reply")
        argv = self.calls()[-1]["argv"]
        self.assertIn("--chrome", argv)
        self.assertIn("--strict-mcp-config", argv)
        self.assertNotIn("--safe-mode", argv)
        self.assertEqual(argv[argv.index("--disallowedTools") + 1],
                         "mcp__claude-in-chrome__form_input,mcp__claude-in-chrome__gif_creator")
        self.assertIn("mcp__claude-in-chrome__navigate", argv[argv.index("--allowedTools") + 1])
        self.assertIn("new tab", self.calls()[-1]["append"])
        # --mcp alias
        self.cli("run", "-p", "proj", "-m", "sonnet", "--why", "x", "--mcp", "claude-in-chrome", "t")
        argv = self.calls()[-1]["argv"]
        self.assertIn("--chrome", argv)
        self.assertIn("mcp__claude-in-chrome", argv[argv.index("--allowedTools") + 1].split(","))
        # loose profile keeps the user's configured MCP servers out
        self.assertIn("loose", self.cli("chrome", "check", FAKE_CHROME="loose").stdout)
        self.cli("run", "-p", "proj", "-m", "sonnet", "--why", "x", "--chrome", "--", "t")
        argv = self.calls()[-1]["argv"]
        self.assertNotIn("--strict-mcp-config", argv)
        self.assertIn("mcp__tickets", argv[argv.index("--disallowedTools") + 1].split(","))
        p = self.cli("chrome", "check", check=False)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("isn't available", p.stdout)

    def test_draft_send_split_and_needs_input(self):
        self.cli("learn", self.proj)
        fb = json.dumps({"status": "awaiting-confirmation", "used": [], "unneeded": [], "missing": ""})
        out = self.cli("run", "-p", "proj", "-m", "sonnet", "--why", "x", "reply to Alex", FAKE_FEEDBACK=fb)
        self.assertIn("NOT done", out.stdout)
        self.assertEqual(out.returncode, 0)
        first = self.calls()[-1]
        self.assertIn("awaiting-confirmation", first["append"])
        self.assertIn("do NOT do anything that leaves this machine", first["append"])
        run_id = out.stdout.split()[1]
        self.cli("run", "--resume", run_id, "--allow-send", "the drafted reply to Alex in Teams", "Send it now")
        self.assertIn("explicitly approved this outward action: the drafted reply to Alex in Teams",
                      self.calls()[-1]["append"])
        fb = json.dumps({"status": "needs-input", "used": [], "unneeded": [], "missing": ""})
        out = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "message Sam", FAKE_FEEDBACK=fb).stdout
        self.assertIn("needs an answer", out)

    def test_run_project_positional_and_late_task_words(self):
        self.cli("learn", self.proj)
        self.cli("run", "proj", "-m", "haiku", "--why", "x", "find", "things")
        self.assertTrue(self.calls()[-1]["task"].endswith("\n\nfind things"))
        self.cli("run", "-m", "haiku", "--why", "x", "-p", "proj", "first", "--read-only", "second")
        self.assertTrue(self.calls()[-1]["task"].endswith("\n\nfirst second"))

    def test_teams_recipe_is_seeded_once(self):
        self.cli("learn", self.proj)
        self.cli("home")
        mems = self.cli("memory", "list").stdout
        self.assertIn("mem-recipe-teams-message", mems)
        self.assertIn("mem-recipe-teams-message", self.cli("suggest", "proj", "write a reply in Teams to Alex").stdout)
        self.cli("memory", "rm", "recipe_teams_message")
        self.cli("home")
        self.assertNotIn("teams", self.cli("memory", "list").stdout)  # deleted recipes stay deleted

    def lean_path(self):
        bindir = os.path.join(self.tmp.name, "bin")
        os.makedirs(bindir, exist_ok=True)
        link = os.path.join(bindir, "lean-agent")
        if not os.path.exists(link):
            os.symlink(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bin", "lean-agent"), link)
        return bindir + os.pathsep + os.environ.get("PATH", "")

    def sh_blocks(self, text):
        import re as _re
        return _re.findall(r"```sh\n(.*?)```", text, _re.S)

    def test_every_guide_and_block_example_runs_verbatim(self):
        shop = os.path.join(self.tmp.name, "shop")
        os.makedirs(os.path.join(shop, "tests"))
        with open(os.path.join(shop, "CLAUDE.md"), "w") as fh:
            fh.write("# Shop\nA shop.\n\n## Testing\nRun pytest -q. Checkout tests live in tests/test_checkout.py.\n")
        self.cli("learn", shop, "--name", "shop")
        env = dict(self.env, PATH=self.lean_path(), FAKE_ANSWER="REMEMBERED memory example")  # the librarian's report
        guide = self.cli("guide", "shop").stdout
        block = read = open(os.path.join(shop, "CLAUDE.local.md")).read()
        blocks = self.sh_blocks(guide) + self.sh_blocks(block)
        self.assertGreaterEqual(len(blocks), 4)
        for code in blocks:
            p = subprocess.run(["bash", "-e", "-c", code], capture_output=True, text=True, env=env,
                               cwd=self.tmp.name, stdin=subprocess.DEVNULL)
            self.assertEqual(p.returncode, 0, f"example failed:\n{code}\n--- stdout\n{p.stdout}\n--- stderr\n{p.stderr}")
        self.assertIn("lean-agent run [--project PROJECT]", self.cli("guide", "--cli").stdout)  # generated reference
        self.assertNotIn("{{", guide + block)

    def test_repo_block_is_idempotent_and_keeps_hand_written_text(self):
        subprocess.run(["git", "init", "-q", self.proj], check=True)
        local = os.path.join(self.proj, "CLAUDE.local.md")
        with open(local, "w") as fh:
            fh.write("# My notes\nMy sandbox runs on port 5544.\n")
        self.cli("learn", self.proj, "--name", "proj")
        first = open(local).read()
        self.assertIn("My sandbox runs on port 5544.", first)
        self.assertEqual(first.count("<!-- lean-agent:begin"), 1)
        self.assertIn("Never use the built-in Agent (Task) tool", first)
        self.cli("learn", self.proj, "--name", "proj")
        self.cli("rules", "proj")
        self.assertEqual(open(local).read(), first)  # idempotent
        with open(os.path.join(self.proj, ".git", "info", "exclude")) as fh:
            self.assertIn("/CLAUDE.local.md", fh.read())
        self.assertNotIn("how-to-work", self.cli("cards", "proj").stdout)  # the block isn't indexed as a card
        self.cli("rules", "proj", "--off")
        self.assertEqual(open(local).read().strip(), "# My notes\nMy sandbox runs on port 5544.")
        self.cli("learn", self.proj, "--name", "proj")  # stays off until `rules proj`
        self.assertNotIn("lean-agent:begin", open(local).read())

    def test_repo_block_uses_rules_dir_when_repo_relies_on_agents_md(self):
        other = os.path.join(self.tmp.name, "agents-repo")
        os.makedirs(other)
        with open(os.path.join(other, "AGENTS.md"), "w") as fh:
            fh.write("## Build\nRun make; always run make test before pushing changes.\n")
        self.cli("learn", other, "--name", "ag")
        self.assertFalse(os.path.exists(os.path.join(other, "CLAUDE.local.md")))
        self.assertIn("lean-agent:begin", open(os.path.join(other, ".claude", "rules", "lean-agent.md")).read())

    def test_doctor_green_then_red_then_fixed(self):
        self.cli("learn", self.proj, "--name", "proj")
        self.cli("trust", "--write-config")
        env = {"PATH": self.lean_path()}
        out = self.cli("doctor", self.proj, **env).stdout
        self.assertIn("doctor: all good", out)
        self.assertIn("lean-agent rules load here", out)
        # red: block missing
        local = os.path.join(self.proj, "CLAUDE.local.md")
        os.remove(local)
        p = self.cli("doctor", self.proj, check=False, **env)
        self.assertEqual(p.returncode, 1)
        self.assertIn("✗ lean-agent rules load here", p.stdout)
        # red: a global file contradicts
        with open(os.path.join(self.tmp.name, "CLAUDE.md"), "w") as fh:  # ~/CLAUDE.md (HOME is an ancestor)
            fh.write("# Me\nSpawn up to 4 subagents and use Workflow for big jobs.\n")
        p = self.cli("doctor", self.proj, check=False, **env)
        self.assertIn("contradicts lean-agent", p.stdout)
        out = self.cli("doctor", self.proj, "--fix", **env).stdout
        self.assertIn("added a note that lean-agent rules take precedence", out)
        self.assertIn("doctor: all good", self.cli("doctor", self.proj, **env).stdout)
        self.assertIn("lean-agent:precedence", open(os.path.join(self.tmp.name, "CLAUDE.md")).read())

    def test_memory_and_card_edits_persist(self):
        self.cli("learn", self.proj, "--name", "proj")
        self.cli("memory", "add", "Prefer small PRs.", "--type", "feedback", "--name", "feedback_small-prs")
        listing = self.cli("memory", "list").stdout
        self.assertIn("mem-feedback-small-prs ", listing)  # no feedback_feedback_ prefix
        self.cli("card", "core", "proj", "mem-feedback-small-prs")
        self.cli("card", "add", "proj", "mem-feedback-small-prs", "--text", "Prefer small, focused PRs.")
        self.cli("memory", "add", "Unrelated new memory to force a re-sync.", "--type", "project")
        cards = self.cli("cards", "proj", "small").stdout
        self.assertIn("*mem-feedback-small-prs", cards)  # still core
        self.assertIn("Prefer small, focused PRs.", self.cli("card", "show", "proj", "mem-feedback-small-prs").stdout)
        self.cli("memory", "edit", "small-prs", "Prefer small PRs; split refactors out.")
        self.assertIn("split refactors", self.cli("card", "show", "proj", "mem-feedback-small-prs").stdout)
        # hand edits to learned cards survive re-learning
        self.cli("card", "add", "proj", "testing", "--text", "Run pytest -q in api/.")
        with open(os.path.join(self.proj, "CLAUDE.md"), "a") as fh:
            fh.write("\n## Later\nA later section with enough words to be its own card here.\n")
        out = self.cli("learn", self.proj, "--name", "proj").stdout
        self.assertEqual(self.cli("card", "show", "proj", "testing").stdout.strip().splitlines()[-1], "Run pytest -q in api/.")
        # --cards none
        self.cli("run", "proj", "-m", "haiku", "--why", "x", "--cards", "none", "t")

    def test_home_guide_replaces_old_template_but_not_hand_written(self):
        h = os.path.join(self.env["LEAN_AGENT_HOME"], "home")
        os.makedirs(h)
        with open(os.path.join(h, "CLAUDE.md"), "w") as fh:
            fh.write("<!-- lean-agent orchestrator template v5 (edit freely) -->\nold\n")
        self.cli("home")
        self.assertTrue(open(os.path.join(h, "CLAUDE.md")).read().startswith("<!-- lean-agent guide "))
        with open(os.path.join(h, "CLAUDE.md"), "w") as fh:
            fh.write("my own orchestrator notes\n")
        self.cli("home")
        self.assertEqual(open(os.path.join(h, "CLAUDE.md")).read(), "my own orchestrator notes\n")

    def test_orchestrator_home_settings_trim_context(self):
        with open(os.path.join(self.env["CLAUDE_CONFIG_DIR"], "settings.json"), "w") as fh:
            json.dump({"enabledPlugins": {"figma@market": True, "lean-agent@lean-agent": True}}, fh)
        h = self.cli("home").stdout.strip()
        with open(os.path.join(h, ".claude", "settings.json")) as fh:
            d = json.load(fh)
        deny = d["permissions"]["deny"]
        for tool in ("Agent", "Task", "Workflow", "Edit", "Write", "WebFetch", "mcp__tickets"):
            self.assertIn(tool, deny)
        for tool in ("Bash", "Read"):
            self.assertNotIn(tool, deny)
        self.assertIn("Bash(lean-agent:*)", d["permissions"]["allow"])
        self.assertTrue(d["disableBundledSkills"] and d["disableClaudeAiConnectors"])
        self.assertEqual(d["enabledPlugins"], {"figma@market": False})
        self.assertIn(os.path.join(self.env["CLAUDE_CONFIG_DIR"], "CLAUDE.md"), d["claudeMdExcludes"])
        self.assertIn(os.path.join(self.tmp.name, "CLAUDE.md"), d["claudeMdExcludes"])  # ~/CLAUDE.md
        with open(os.path.join(h, ".claude", "settings.local.json")) as fh:
            self.assertFalse(json.load(fh)["syncClaudeAiSkills"])
        self.cli("up", "--model", "sonnet", "--local", check=False)
        with open(os.path.join(h, ".claude", "settings.json")) as fh:
            d = json.load(fh)
        self.assertEqual(d["model"], "sonnet")  # other keys survive
        self.assertIn("Workflow", d["permissions"]["deny"])
        for tool in ("ListMcpResourcesTool", "ReadMcpResourceTool"):
            self.assertIn(tool, d["permissions"]["deny"])
        self.assertIs(d["enableAllProjectMcpServers"], False)  # no .mcp.json server connects in the home
        self.assertIs(d["autoMemoryEnabled"], False)
        self.cli("home", LEAN_AGENT_ORCHESTRATOR_TRIM="0")
        with open(os.path.join(h, ".claude", "settings.json")) as fh:
            d = json.load(fh)
        self.assertIn("Bash(lean-agent:*)", d["permissions"]["allow"])
        self.assertNotIn("deny", d["permissions"])
        self.assertNotIn("disableBundledSkills", d)
        self.assertNotIn("enableAllProjectMcpServers", d)
        self.assertEqual(d["model"], "sonnet")

    def test_run_reports_breakdown_overhead_and_budget(self):
        self.cli("learn", self.proj)
        self.cli("limits", "--5h", "4000")
        out = self.cli("run", "-p", "proj", "-m", "sonnet", "--why", "x", "--cards", "testing", "t").stdout
        self.assertIn("3 turns", out)
        self.assertIn("3,100 sonnet-eq tok · $0.05", out)
        self.assertIn("tokens: input 100 · cache write 800 · cache read 5,000 · output 300", out)
        self.assertIn("context per turn ~1,966: lean-agent protocol + cards ~", out)
        self.assertIn("budget left: session", out)
        self.write_usage(self.lean_project_dir("-work-0101-000000-abcd"), 0.2, "claude-sonnet-5-5", 3500, "z")
        out = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "t").stdout
        self.assertIn("155 sonnet-eq tok", out)  # haiku counts 0.05x
        self.assertIn("budget left: session 13% (low", out)
        self.assertIn("low: prefer -m haiku", out)
        stats = self.cli("stats").stdout
        self.assertIn("sonnet-eq", stats)

    def test_mcp_presets_and_cost_line(self):
        self.cli("learn", self.proj)
        self.cli("mcp", "tools", "tickets")  # probe and cache tool costs
        out = self.cli("mcp", "preset", "tickets").stdout
        self.assertIn("tickets:read  2 tools", out)  # get_ticket + search_tickets
        self.cli("mcp", "preset", "tickets", "lookup", "get_ticket")
        self.assertIn("tickets:lookup  1 tools", self.cli("mcp", "preset", "tickets").stdout)
        out = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--mcp", "tickets:lookup", "t").stdout
        self.assertRegex(out.splitlines()[0], r"^mcp: tickets 1/2 tools ~\d+ tok per turn \(whole server ~[\d,]+\)")
        argv = self.calls()[-1]["argv"]
        self.assertEqual(argv[argv.index("--disallowedTools") + 1], "mcp__tickets__search_tickets")
        out = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--mcp", "tickets", "t").stdout
        self.assertIn("mcp: tickets 2/2 tools", out)
        p = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--mcp", "tickets:nope", "t", check=False)
        self.assertIn("presets: lookup, read", p.stderr)
        self.cli("mcp", "preset", "tickets", "lookup", "--rm")
        self.assertNotIn("lookup", self.cli("mcp", "preset", "tickets").stdout)

    def git_project(self):
        def g(*args):
            subprocess.run(["git", "-C", self.proj, *args], check=True, capture_output=True)
        g("init", "-q", "-b", "main")
        g("-c", "user.name=t", "-c", "user.email=t@t", "add", "-A")
        g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base")
        g("checkout", "-qb", "feature")
        os.makedirs(os.path.join(self.proj, "api"), exist_ok=True)
        with open(os.path.join(self.proj, "api", "totals.py"), "w") as fh:
            fh.write("def total(xs):\n    return sum(xs) * 1.1\n")
        g("add", "-A")
        g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "feature")
        with open(os.path.join(self.proj, "web", "page.txt"), "w") as fh:
            fh.write("uncommitted\n")
        return g

    def test_review_gate(self):
        self.git_project()
        self.cli("learn", self.proj, "--name", "proj")
        review = json.dumps(dict(REUSE_CHECKED, verdict="changes-requested", findings=[
            {"severity": "minor", "file": "web/page.txt", "line": 1, "issue": "placeholder text"},
            {"severity": "blocker", "file": "api/totals.py", "line": 2, "issue": "float money math",
             "suggestion": "use integer cents"}],
            checks=[{"what": "run pytest -q", "why": "no test covers total()"}]))
        p = self.cli("review", "proj", check=False, FAKE_REVIEW=review)
        self.assertEqual(p.returncode, 2)
        out = p.stdout
        self.assertIn("REVIEW: CHANGES-REQUESTED · 2 findings · 1 checks", out)
        self.assertLess(out.index("[blocker] api/totals.py:2"), out.index("[minor] web/page.txt:1"))
        self.assertIn("[check] run pytest -q", out)
        self.assertIn("lean-agent review proj --resume", out)
        call = self.calls()[-1]
        argv = call["argv"]
        self.assertEqual(argv[argv.index("--model") + 1], "sonnet")
        self.assertEqual(argv[argv.index("--effort") + 1], "high")
        self.assertEqual(argv[argv.index("--tools") + 1], "Read,Glob,Grep,Bash")
        self.assertNotIn("Edit", argv[argv.index("--allowedTools") + 1])
        self.assertIn("Role: you are the reviewer", call["append"])
        self.assertIn("including uncommitted changes", call["append"])
        self.assertIn("api/totals.py", call["task"])
        self.assertEqual(self.cli("review", "proj", "--status", check=False).returncode, 1)
        approve = json.dumps(dict(REUSE_CHECKED, verdict="approve", findings=[], checks=[]))
        p = self.cli("review", "proj", "--resume", "--same-session", check=False, FAKE_REVIEW=approve)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("Re-review the current diff", self.calls()[-1]["task"])
        self.assertIn("--resume", self.calls()[-1]["argv"])
        self.assertIn("Role: you are the reviewer", self.calls()[-1]["append"])  # same role on resume
        self.assertEqual(self.cli("review", "proj", "--status").returncode, 0)
        with open(os.path.join(self.proj, "api", "totals.py"), "a") as fh:
            fh.write("# later edit\n")
        p = self.cli("review", "proj", "--status", check=False)
        self.assertEqual(p.returncode, 1)
        self.assertIn("stale", p.stdout)

    def test_bounded_answer_and_details(self):
        self.cli("learn", self.proj, "--name", "proj")
        long = "Checked 3 services: 2 healthy, 1 degraded.\n" + "\n".join(f"row {i}" for i in range(60))
        p = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "lookup", "--answer-lines", "10", "check services",
                     FAKE_ANSWER="Checked 3 services: 2 healthy, 1 degraded.\nsvc-c is degraded since 09:10.\n"
                                 "=== DETAILS ===\n| svc | state |\n" + "\n".join(f"| svc-{i} | ok |" for i in range(40)))
        call = self.calls()[-1]
        self.assertIn("at most 10 lines", call["append"])
        self.assertIn("=== DETAILS ===", call["append"])
        self.assertIn("svc-c is degraded since 09:10.", p.stdout)
        self.assertNotIn("| svc-3 | ok |", p.stdout)
        self.assertRegex(p.stdout, r"details: 41 more lines in \S+details-1\.md")
        rid = self.ledger()[-1]["id"]
        det = self.cli("runs", "--show", rid, "--details", "--grep", "svc-3 ").stdout
        self.assertEqual(det.strip(), "| svc-3 | ok |")
        # a worker that ignores the contract: the answer is cut at N lines, nothing is lost
        p = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "lookup", "--answer-lines", "10", "--again",
                     "list rows", FAKE_ANSWER=long)
        self.assertIn("row 8", p.stdout)
        self.assertNotIn("row 30", p.stdout)
        self.assertIn("the answer ran past 10 lines", p.stdout)
        self.assertIn("row 30", self.cli("runs", "--show", "--details").stdout)
        # the orchestrator's default (LEAN_AGENT_ANSWER_LINES) and --answer-lines 0 for the whole answer
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--again", "list rows", LEAN_AGENT_ANSWER_LINES="25")
        self.assertIn("at most 25 lines", self.calls()[-1]["append"])
        p = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--again", "--answer-lines", "0", "list rows",
                     LEAN_AGENT_ANSWER_LINES="25", FAKE_ANSWER=long, BASH_MAX_OUTPUT_LENGTH="20000")
        self.assertNotIn("=== DETAILS ===", self.calls()[-1]["append"])
        self.assertIn("row 59", p.stdout)
        self.assertEqual(self.calls()[-1]["bash_out"], "8000")  # not the orchestrator's 20000

    def test_worker_env_lacks_the_service_session_variable(self):
        self.cli("learn", self.proj, "--name", "proj")
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--again", "list rows", LEAN_AGENT_SERVICE_SESSION="1")
        self.assertIsNone(self.calls()[-1]["service"])  # the session hooks must not act in a worker

    def test_cli_strips_the_service_session_variable_for_its_children(self):
        sys.path.insert(0, os.path.dirname(CLI))
        import lean_agent
        os.environ["LEAN_AGENT_SERVICE_SESSION"] = "1"
        try:
            lean_agent.main(["--help"])
        except SystemExit:
            pass
        finally:
            leaked = os.environ.pop("LEAN_AGENT_SERVICE_SESSION", None)
        self.assertIsNone(leaked)

    def test_brief_mode(self):
        self.cli("learn", self.proj, "--name", "proj")
        for i in range(30):
            self.cli("card", "add", "proj", f"note-{i:02d}", "--title", f"Note {i}", "--text", f"Fact number {i}.")
        full = self.cli("cards", "proj").stdout
        brief = self.cli("cards", "proj", LEAN_AGENT_BRIEF="1").stdout
        self.assertLess(len(brief.splitlines()), len(full.splitlines()))
        self.assertIn("[brief: 20 of", brief)
        self.assertIn("lean-agent output cards --grep TEXT", brief)
        self.assertEqual(self.cli("cards", "proj", "--full", LEAN_AGENT_BRIEF="1").stdout, full)
        self.assertIn("note-29", self.cli("output", "cards", "--grep", "note-29").stdout)
        self.assertIn("[brief:", self.cli("cards", "proj", "--brief").stdout)
        p = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "look", LEAN_AGENT_BRIEF="1")
        self.assertNotIn("  tokens: input", p.stdout)
        self.assertIn("  tokens: input", self.cli("runs", "--show").stdout)  # kept for runs --show

    def test_compact_run_output(self):
        self.cli("learn", self.proj, "--name", "proj")
        long = "\n".join(f"line {i:03d} of a long worker answer" for i in range(120)) + "\nQuestion: which region should it use?\n"
        args = ("run", "-p", "proj", "-m", "haiku", "--why", "x", "look")
        p = self.cli(*args, LEAN_AGENT_BRIEF="1", FAKE_ANSWER=long)
        rid = self.ledger()[-1]["id"]
        self.assertIn("line 000", p.stdout)
        self.assertNotIn("line 119", p.stdout)
        self.assertIn("Question: which region should it use?", p.stdout)  # kept in full
        self.assertIn(f"… full report: lean-agent runs --show {rid}", p.stdout)
        self.assertLess(len(p.stdout), 2400)
        self.assertNotIn("  tokens: input", p.stdout)
        self.assertNotIn("budget left", p.stdout)
        self.assertIn("line 119", self.cli("runs", "--show", rid).stdout)  # the ledger copy is whole
        self.assertIn("  tokens: input", self.cli(*args, "--verbose", LEAN_AGENT_BRIEF="1", FAKE_ANSWER=long).stdout)
        full = self.cli(*args, "--full", LEAN_AGENT_BRIEF="1", FAKE_ANSWER=long).stdout
        self.assertIn("line 119", full)
        self.assertNotIn("full report:", full)
        short = self.cli(*args, LEAN_AGENT_BRIEF="1", FAKE_ANSWER="Short answer.").stdout
        self.assertIn("Short answer.", short)
        self.assertNotIn("full report:", short)

    def test_brief_after_a_clear_lists_the_open_threads(self):
        self.assertNotIn("Open threads", self.cli("brief").stdout)
        lt = self.threads_home()
        for i in range(8):
            lt.route(f"Topic{i} alpha{i} beta{i} gamma{i}", "s1")
        lt.route("Parked item about unrelated zebra", "s1")
        self.cli("thread", "close", "t9")
        self.cli("todo", "add", "Ship topic seven", "--thread", "t8")
        out = self.cli("brief").stdout
        self.assertIn("  next todo #", out)  # the parallel work is in the brief too
        self.assertIn("Open threads (8), latest first:", out)
        self.assertIn("t8 ", out)
        self.assertNotIn("zebra", out)
        self.assertLessEqual(len(out.split("Full list")[0].splitlines()), 16)
        self.assertIn("lean-agent thread show tN", out)

    def test_checkpoint_and_brief(self):
        self.assertEqual(self.cli("brief").stdout.count("Checkpoint of"), 0)
        self.cli("checkpoint", "promised the user a status at noon [thread:billing]")
        self.cli("handoff", "--note", "an open item")
        out = self.cli("brief").stdout
        self.assertTrue(out.startswith("Checkpoint of "), out)
        self.assertIn("promised the user a status at noon [thread:billing]", out.split("lean-agent hand-off")[0])
        self.assertNotIn("promised the user", out.split("lean-agent hand-off")[1])  # not repeated as an open item
        self.assertIn("an open item", out)
        for i in range(4):
            self.cli("checkpoint", f"state {i}")
        p = subprocess.run([sys.executable, CLI, "checkpoint", "--file", "-"], input="from stdin\nsecond line\n",
                           capture_output=True, text=True, env=self.env, check=True)
        self.assertIn("2 lines", p.stdout)
        with open(os.path.join(self.env["LEAN_AGENT_HOME"], "handoff-notes.json")) as fh:
            notes = json.load(fh)
        cps = [n for n in notes if n.get("kind") == "checkpoint"]
        self.assertEqual([n["text"] for n in cps], ["state 2", "state 3", "from stdin\nsecond line"])
        self.assertEqual(len(notes), 4)  # the open item stays
        out = self.cli("brief").stdout
        self.assertTrue(out.startswith("Checkpoint of "))
        self.assertIn("from stdin\nsecond line", out)
        self.assertNotIn("state 2", out)
        self.assertEqual(self.cli("checkpoint", check=False).returncode, 1)

    def test_default_orchestrator_env_has_no_compaction_overrides(self):
        env = json.loads(self.cli("env", "--json").stdout)["env"]
        self.assertNotIn("CLAUDE_CODE_AUTO_COMPACT_WINDOW", env)
        self.assertNotIn("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", env)
        self.assertNotIn("DISABLE_AUTO_COMPACT", env)

    def test_config_compact_restores_the_overrides(self):
        out = self.cli("config", "compact-window", "100000").stdout
        self.assertIn("service restart", out)
        self.assertIn("compaction: ~67,000 (compact-window 100000, pct default; set by config)", out)
        out = self.cli("config", "compact-pct", "70").stdout
        self.assertIn("compaction: ~67,000 (compact-window 100000, pct 70; set by config)", out)
        env = json.loads(self.cli("env", "--json").stdout)["env"]
        self.assertEqual((env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"], env["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"]), ("100000", "70"))
        self.assertIn("compaction: ~67,000", self.cli("doctor", check=False).stdout)
        env = json.loads(self.cli("env", "--json", LEAN_AGENT_COMPACT_WINDOW="200000").stdout)["env"]
        self.assertEqual(env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"], "200000")
        self.cli("config", "compact-window", "default")
        out = self.cli("config", "compact-pct", "default").stdout
        self.assertIn("compaction: Claude Code default (~167k for a 200k window)", out)
        self.assertNotIn("CLAUDE_CODE_AUTO_COMPACT_WINDOW", json.loads(self.cli("env", "--json").stdout)["env"])
        self.assertEqual(self.cli("config", "compact-window", "soon", check=False).returncode, 1)
        self.assertIn("100000", self.cli("config", "compact-window", "100000").stdout)  # the minimum itself is accepted
        self.cli("config", "compact-window", "default")
        small = self.cli("config", "compact-window", "50000", check=False)
        self.assertEqual(small.returncode, 1)
        self.assertIn("100000 or more", small.stderr)

    def test_compact_pct_limits_are_10_to_95(self):
        for ok in ("10", "95"):
            self.assertEqual(self.cli("config", "compact-pct", ok, check=False).returncode, 0, ok)
        for bad in ("9", "96"):
            r = self.cli("config", "compact-pct", bad, check=False)
            self.assertEqual(r.returncode, 1, bad)
            self.assertIn("10-95", r.stderr + r.stdout)

    def test_compact_window_zero_and_negative_are_refused(self):
        for bad in ("0", "-1", "-100000"):
            self.assertEqual(self.cli("config", "compact-window", bad, check=False).returncode, 1, bad)

    def test_a_non_dict_config_json_does_not_crash_doctor(self):
        os.makedirs(self.env["LEAN_AGENT_HOME"], exist_ok=True)
        with open(os.path.join(self.env["LEAN_AGENT_HOME"], "config.json"), "w") as fh:
            json.dump(["not", "a", "dict"], fh)
        r = self.cli("doctor", check=False)
        self.assertNotIn("Traceback", r.stderr + r.stdout)
        self.assertIn("compaction: Claude Code default", r.stdout)

    def test_env_compact_window_zero_is_ignored_with_a_warning(self):
        # documented behaviour: 0 is not "default" and not 100000 or more, so it is reported and Claude Code's default applies
        out = self.cli("doctor", check=False, LEAN_AGENT_COMPACT_WINDOW="0").stdout
        self.assertIn("LEAN_AGENT_COMPACT_WINDOW '0' is not 100000 or more", out)
        env = json.loads(self.cli("env", "--json", LEAN_AGENT_COMPACT_WINDOW="0").stdout)["env"]
        self.assertNotIn("CLAUDE_CODE_AUTO_COMPACT_WINDOW", env)

    def test_invalid_compact_settings_are_ignored_with_a_doctor_warning(self):
        os.makedirs(self.env["LEAN_AGENT_HOME"], exist_ok=True)
        with open(os.path.join(self.env["LEAN_AGENT_HOME"], "config.json"), "w") as fh:
            json.dump({"compact_window": 50000, "compact_pct": 99}, fh)
        env = json.loads(self.cli("env", "--json").stdout)["env"]
        self.assertNotIn("CLAUDE_CODE_AUTO_COMPACT_WINDOW", env)
        self.assertNotIn("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", env)
        out = self.cli("doctor", check=False).stdout
        self.assertIn("compaction setting ignored: compact-window '50000' is not 100000 or more", out)
        self.assertIn("compact-pct '99' is not 10-95", out)
        self.assertIn("compaction: Claude Code default", out)
        out = self.cli("doctor", check=False, LEAN_AGENT_COMPACT_WINDOW="soon").stdout
        self.assertIn("LEAN_AGENT_COMPACT_WINDOW 'soon' is not 100000 or more", out)
        env = json.loads(self.cli("env", "--json", LEAN_AGENT_COMPACT_WINDOW="120000").stdout)["env"]
        self.assertEqual(env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"], "120000")
        self.assertIn("100000 or more", self.cli("config", "--help").stdout.replace("\n", " "))

    def test_compaction_point_default_and_overrides(self):
        sys.path.insert(0, os.path.dirname(CLI))
        import lean_common
        old = os.environ.pop("LEAN_AGENT_COMPACT_BUFFER", None)
        self.addCleanup(lambda: old is None or os.environ.__setitem__("LEAN_AGENT_COMPACT_BUFFER", old))
        self.assertEqual(lean_common.compaction_point(), 167000)
        self.assertEqual(lean_common.compaction_point(model="sonnet[1m]"), 967000)
        self.assertEqual(lean_common.compaction_point(None, 50), 100000)
        self.assertEqual(lean_common.compaction_point(100000, 70), 67000)
        self.assertEqual(lean_common.compaction_label(), "Claude Code default (~167k for a 200k window)")
        self.assertEqual(lean_common.compaction_label(model="opus[1m]"), "Claude Code default (~967k for a 1M window)")
        self.assertEqual(lean_common.compaction_label(100000, 70), "~67,000 (compact-window 100000, pct 70; set by config)")
        self.assertEqual(lean_common.compaction_label(100000, 70, source=False), "~67,000 (compact-window 100000, pct 70)")

    def test_doctor_and_service_status_show_the_compaction(self):
        self.assertIn("compaction: Claude Code default (~167k for a 200k window)", self.cli("doctor", check=False).stdout)

    def test_config_clear_at(self):
        out = self.cli("config", "clear-at").stdout
        self.assertIn("auto clear: off (clear with `lean-agent clear`)", out)
        self.assertIn("compacts at ~167,000", out)
        self.assertIn("auto = 52,000", self.cli("config", "clear-at", CLAUDE_CODE_AUTO_COMPACT_WINDOW="100000",
                                                 CLAUDE_AUTOCOMPACT_PCT_OVERRIDE="60", LEAN_AGENT_CLEAR_AT="auto").stdout)
        self.assertIn("auto = 159,000", self.cli("config", "clear-at", "auto").stdout)
        self.assertIn("auto = 159,000", self.cli("doctor", check=False).stdout)
        self.assertIn("55,000", self.cli("config", "clear-at", "55000").stdout)
        self.assertIn("55,000", self.cli("config", "clear-at").stdout)
        self.assertIn("auto clear: off", self.cli("config", "clear-at", "off").stdout)
        self.assertIn("auto clear: off", self.cli("config", "clear-at", "0").stdout)
        self.assertIn("12,000", self.cli("config", "clear-at", LEAN_AGENT_CLEAR_AT="12000").stdout)
        self.assertEqual(self.cli("config", "clear-at", "x", check=False).returncode, 1)

    def test_clear_at_reads_the_compaction_point_up_recorded(self):
        os.makedirs(self.env["LEAN_AGENT_HOME"], exist_ok=True)
        with open(os.path.join(self.env["LEAN_AGENT_HOME"], "up.json"), "w") as fh:
            json.dump({"compact_at": 80000}, fh)
        out = self.cli("config", "clear-at", LEAN_AGENT_CLEAR_AT="auto").stdout
        self.assertIn("auto = 72,000 tokens", out)
        self.assertIn("compacts at ~80,000", out)

    def auto_clear_up(self, ctx, **env):
        """`up` with the fake session whose turns leave `ctx` tokens of context; fast clocks for the auto clear."""
        self.env.update(dict(FAKE_CTX=str(ctx), LEAN_AGENT_CLEAR_POLL="0.1", LEAN_AGENT_CLEAR_IDLE="0",
                             LEAN_AGENT_CLEAR_AT="40000"), **env)
        return self.start_up("--name", "la")

    def clears(self, log):
        return [r for r in self.read_jsonl(log) if "clear_hook" in r]

    def test_up_auto_clears_after_a_checkpoint(self):
        p, log, ss = self.auto_clear_up(50000)
        ss.send("hello")
        self.wait_for(lambda: self.clears(log), "the clear")
        [clear] = self.clears(log)
        hook = json.loads(clear["clear_hook"])["hookSpecificOutput"]
        self.assertEqual(hook["hookEventName"], "SessionStart")
        self.assertIn("lean-agent hand-off", hook["additionalContext"])
        home = self.env["LEAN_AGENT_HOME"]
        slug = "".join(c if c.isalnum() else "-" for c in os.path.realpath(self.cli("home").stdout.strip()))
        first = [f for f in os.listdir(os.path.join(self.env["CLAUDE_CONFIG_DIR"], "projects", slug)) if f != clear["sid"] + ".jsonl"]
        records = self.read_jsonl(os.path.join(self.env["CLAUDE_CONFIG_DIR"], "projects", slug, first[0]))
        texts = [r["message"]["content"] if isinstance(r["message"]["content"], str) else r["message"]["content"][0].get("text")
                 for r in records if r.get("message")]
        self.assertEqual(texts[-2:], ["Checkpoint now: run lean-agent checkpoint with your soft state, then reply "
                                      "'checkpointed'", "checkpointed"])
        with open(os.path.join(home, "logs", "debug.log"), "rb") as fh:
            self.assertIn(b"DEBUG auto-clear: /clear sent (checkpointed)", fh.read())
        # a second long turn straight after: not cleared again within 10 minutes
        ss.send("again")
        self.wait_for(lambda: "echo: again" in json.dumps(self.read_jsonl(os.path.join(
            self.env["CLAUDE_CONFIG_DIR"], "projects", slug, clear["sid"] + ".jsonl"))), "the second turn")
        import time as _t
        _t.sleep(1.0)
        self.assertEqual(len(self.clears(log)), 1)

    def test_up_auto_clear_waits_for_the_checkpoint_up_to_a_limit(self):
        p, log, ss = self.auto_clear_up(50000, FAKE_NO_CHECKPOINT="1", LEAN_AGENT_CLEAR_WAIT="1.5")
        ss.send("hello")
        self.wait_for(lambda: self.clears(log), "the clear after the wait", secs=20)
        with open(os.path.join(self.env["LEAN_AGENT_HOME"], "logs", "debug.log"), "rb") as fh:
            self.assertIn(b"no reply in time", fh.read())

    def no_clear_for(self, ctx, at):
        import time as _t
        p, log, ss = self.auto_clear_up(ctx, LEAN_AGENT_CLEAR_AT=at)
        ss.send("hello")
        self.wait_for(lambda: "echo: hello" in json.dumps(self.read_jsonl(log)) or ss.tail().count("ready"), "the turn")
        _t.sleep(1.5)
        self.assertEqual(self.clears(log), [])
        said = "".join(open(os.path.join(d, f)).read() for d, _, fs in os.walk(self.env["CLAUDE_CONFIG_DIR"])
                       for f in fs if f.endswith(".jsonl"))
        self.assertIn("echo: hello", said)
        self.assertNotIn("Checkpoint now", said)

    def test_up_auto_clear_not_below_the_threshold(self):
        self.no_clear_for(30000, "40000")

    def test_up_auto_clear_off_at_zero(self):
        self.no_clear_for(90000, "0")

    def cleared_up(self, **env):
        """`up` with the fake session, after one auto clear; returns (process, log, bridge, new session id)."""
        p, log, ss = self.auto_clear_up(50000, **env)
        ss.send("hello")
        self.wait_for(lambda: self.clears(log), "the clear")
        sid = self.clears(log)[0]["sid"]
        self.wait_for(lambda: ss.info().get("session_id") == sid, "up.json to follow the clear")
        self.assertTrue(ss.info()["transcript"].endswith(sid + ".jsonl"))
        return p, log, ss, sid

    def service_record(self):
        return _load_json(os.path.join(self.env["LEAN_AGENT_HOME"], "chat", "service.json"))

    def test_up_restart_after_an_auto_clear_resumes_the_post_clear_session(self):
        p, log, ss, sid = self.cleared_up()
        first = self.service_record()["chain"][0]
        p.terminate()
        p.wait(timeout=30)
        p2, log2, ss = self.start_up("--name", "la")
        self.wait_for(lambda: "argv" in self.read_jsonl(log)[-1], "the restarted session's start", secs=30)
        self.assertEqual(self.read_jsonl(log)[-1]["argv"][-2:], ["--resume", sid])
        self.wait_for(lambda: ss.info().get("session_id") == sid, "up.json to name the resumed session", secs=30)
        # the transcript chain survives the restart
        self.wait_for(lambda: (self.service_record().get("chain") or [""])[-1].endswith(sid + ".jsonl"), "the chain", secs=30)
        chain = self.service_record()["chain"]
        self.assertEqual(chain[0], first)
        self.assertEqual(len(self.clears(log)), 1)
        # and the persisted gap stops a second clear right after the restart
        ss.send("again")
        self.wait_for(lambda: "echo: again" in json.dumps(self.read_jsonl(os.path.join(
            self.env["CLAUDE_CONFIG_DIR"], "projects", "".join(c if c.isalnum() else "-" for c in os.path.realpath(
                self.cli("home").stdout.strip())), sid + ".jsonl"))), "the turn after the restart", secs=30)
        time.sleep(1.0)  # a window for a second clear to show up; the 0.1s poll runs many times in it
        self.assertEqual(len(self.clears(log)), 1)
        self.assertNotIn("Checkpoint now", json.dumps(self.read_jsonl(log)[2:]))

    def test_up_respawn_after_an_auto_clear_resumes_the_post_clear_session(self):
        p, log, ss, sid = self.cleared_up(LEAN_AGENT_SESSION_QUICK_EXIT="0")
        n = len(self.read_jsonl(log))
        os.kill(ss.info()["pid"], signal.SIGKILL)  # the session dies; up starts it again in the same process
        self.wait_for(lambda: any("argv" in r for r in self.read_jsonl(log)[n:]), "the respawn", secs=30)
        argv = [r for r in self.read_jsonl(log)[n:] if "argv" in r][0]["argv"]
        self.assertEqual(argv[-2:], ["--resume", sid])

    def start_hooks(self, log):
        return [r for r in self.read_jsonl(log) if "start_hook" in r]

    def test_restart_clear_starts_a_new_session_with_the_brief_and_keeps_the_chain(self):
        self.cli("handoff", "--note", "carry on with the plan")
        p, log, ss = self.auto_clear_up(0, FAKE_START_HOOK="1")
        self.wait_for(lambda: self.start_hooks(log), "the start-up hook")
        sid = ss.info()["session_id"]
        ss.send("hello")
        first = self.service_record()["chain"][0]
        fake = os.path.join(self.tmp.name, "systemctl")
        with open(fake, "w") as fh:
            fh.write("#!/bin/sh\nexit 0\n")
        os.chmod(fake, 0o755)
        env = dict(LEAN_AGENT_SERVICE_PLATFORM="linux", LEAN_AGENT_SYSTEMCTL=fake, LEAN_AGENT_CLEAR_WAIT="20")
        self.cli("service", "install", **env)
        out = self.cli("service", "restart", "--clear", **env).stdout
        self.assertIn("(checkpointed)", out)
        new = ss.info()["session_id"]
        self.assertNotIn(new, (sid, ""))
        self.assertEqual(_load_json(os.path.join(self.env["LEAN_AGENT_HOME"], "up.json"))["fresh_sid"], new)
        p.terminate()
        p.wait(timeout=20)
        p2, log2, ss = self.start_up("--name", "la")  # the service starts `up` again
        argv = [r for r in self.read_jsonl(log) if "argv" in r][-1]["argv"]
        self.assertEqual(argv[-2:], ["--session-id", new])
        self.wait_for(lambda: [h for h in self.start_hooks(log) if h["sid"] == new], "the new session's start-up hook")
        [hook] = [h for h in self.start_hooks(log) if h["sid"] == new]
        text = json.loads(hook["start_hook"])["hookSpecificOutput"]["additionalContext"]
        self.assertIn("carry on with the plan", text)
        rec = self.service_record()
        self.assertEqual(rec["chain"][0], first)  # thread history stays
        self.assertTrue(rec["chain"][-1].endswith(new + ".jsonl"))
        self.assertTrue(rec["chain_meta"][rec["chain"][-1]]["fresh"])
        self.assertEqual(rec["source"], "startup")
        self.assertEqual(ss.info()["session_id"], new)

    def test_restart_fresh_from_the_running_up_replaces_the_session(self):
        p, log, ss = self.auto_clear_up(0, FAKE_START_HOOK="1", LEAN_AGENT_CLEAR_WAIT="30")
        self.wait_for(lambda: self.start_hooks(log), "the start-up hook", secs=30)
        ss.send("hello")
        old = ss.info()["session_id"]
        self.wait_for(lambda: "echo: hello" in self.read_text(ss.info().get("transcript")), "the first turn", secs=30)
        n = len(self.read_jsonl(log))
        sid, checkpointed = ss.go_fresh(restart_host=True, wait=30)
        self.assertTrue(checkpointed)
        self.wait_for(lambda: any("argv" in r for r in self.read_jsonl(log)[n:]), "the new session", secs=30)
        argv = [r for r in self.read_jsonl(log)[n:] if "argv" in r][0]["argv"]
        self.assertEqual(argv[-2:], ["--session-id", sid])
        self.assertNotEqual(sid, old)
        self.wait_for(lambda: self.service_record().get("session_id") == sid, "the hook's record", secs=30)
        self.wait_for(lambda: len(self.service_record().get("chain") or []) == 2, "the chain of two", secs=30)
        self.wait_for(lambda: ss.alive(), "the bridge", secs=30)

    def test_drop_stale_record_cases(self):
        ds, home, proj, tr, up = self._follow_env()
        import service_session
        rec = os.path.join(home, "chat", "service.json")
        with mock.patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": os.path.join(home, "cfg")}):
            service_session.drop_stale_record(proj, "s9")  # no service.json: nothing to do, no error
            self.assertFalse(os.path.exists(rec))
            gone = os.path.join(proj, "s2.jsonl")
            with open(rec, "w") as fh:
                json.dump({"session_id": "s2", "transcript_path": gone, "chain": [gone]}, fh)
            own = service_session.transcript_path(proj, "s1")
            os.makedirs(os.path.dirname(own))
            open(own, "w").close()
            service_session.drop_stale_record(proj, "s1")  # the sid's own transcript exists: returns early
            self.assertTrue(os.path.exists(rec))  # although nothing in the record's chain exists
            os.remove(own)
            with open(rec, "w") as fh:
                json.dump({"session_id": "s1", "transcript_path": tr, "chain": [tr]}, fh)
            new = str(uuid.uuid4())  # a new uuid without --fresh: the chain still has a transcript, so it stays
            service_session.drop_stale_record(proj, new)
            self.assertTrue(os.path.exists(rec))
            os.remove(tr)
            service_session.drop_stale_record(proj, new)
            self.assertFalse(os.path.exists(rec))

    def test_up_fresh_resets_the_chain(self):
        p, log, ss, sid = self.cleared_up()
        self.assertTrue(self.service_record()["chain"])
        p.terminate()
        p.wait(timeout=20)
        p2, _, ss = self.start_up("--name", "la", "--fresh")
        self.assertIn("--session-id", self.read_jsonl(log)[-1]["argv"])
        self.assertNotEqual(ss.info()["session_id"], sid)
        self.assertFalse(os.path.exists(os.path.join(self.env["LEAN_AGENT_HOME"], "chat", "service.json")))

    class FakeHost:
        def __init__(self):
            self.last_input, self.pasted, self.stopping = 0, [], threading.Event()

        def alive(self):
            return True

        def paste(self, text):
            self.pasted.append(text)

    def auto_clear_unit(self):
        """An AutoClear on a stand-in host, a transcript this test writes and a clock it sets."""
        sys.path.insert(0, os.path.dirname(CLI))
        import service_session
        home = tempfile.mkdtemp()
        os.makedirs(os.path.join(home, "chat"))
        old = {k: os.environ.get(k) for k in ("LEAN_AGENT_HOME", "LEAN_AGENT_CLEAR_AT", "LEAN_AGENT_CLEAR_GAP",
                                              "LEAN_AGENT_CLEAR_IDLE", "LEAN_AGENT_LOG_DIR", "LEAN_AGENT_COMPACT_WINDOW",
                                              "LEAN_AGENT_COMPACT_PCT")}
        os.environ.update(LEAN_AGENT_HOME=home, LEAN_AGENT_CLEAR_AT="40000", LEAN_AGENT_LOG_DIR=os.path.join(home, "logs"),
                          LEAN_AGENT_COMPACT_WINDOW="100000", LEAN_AGENT_COMPACT_PCT="70")  # compaction at 67,000
        for k in ("LEAN_AGENT_CLEAR_GAP", "LEAN_AGENT_CLEAR_IDLE"):
            os.environ.pop(k, None)
        self.addCleanup(lambda: [os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)
                                 for k, v in old.items()])
        tr = os.path.join(home, "s1.jsonl")
        with open(os.path.join(home, "chat", "service.json"), "w") as fh:
            json.dump({"session_id": "s1", "transcript_path": tr, "source": "startup", "ts": 1}, fh)
        clock = [1_000_000.0]
        host = self.FakeHost()
        ac = service_session.AutoClear(host, now=lambda: clock[0])

        def turn(text, ctx=50000):
            with open(tr, "a") as fh:
                fh.write(json.dumps({"type": "assistant", "message": {"role": "assistant", "id": os.urandom(4).hex(),
                         "content": [{"type": "text", "text": text}], "stop_reason": "end_turn",
                         "usage": {"input_tokens": 1, "cache_read_input_tokens": ctx}}}) + "\n")
        return ac, host, clock, turn, home

    def test_auto_clear_waits_for_typing_to_stop_and_keeps_ten_minutes_between_clears(self):
        ac, host, clock, turn, home = self.auto_clear_unit()
        turn("done")
        host.last_input = clock[0] - 5  # the user typed 5 s ago: leave the session alone
        ac.tick()
        self.assertEqual(host.pasted, [])
        clock[0] += 60
        ac.tick()
        self.assertEqual(len(host.pasted), 1)
        self.assertIn("Checkpoint now", host.pasted[0])
        turn("checkpointed")
        ac.tick()
        self.assertEqual(host.pasted[-1], "/clear")
        # the hook records the clear; a long turn in the new session does not clear again for 10 minutes
        with open(os.path.join(home, "chat", "service.json"), "w") as fh:
            json.dump({"session_id": "s2", "transcript_path": os.path.join(home, "s1.jsonl"), "source": "clear",
                       "ts": clock[0]}, fh)
        turn("another long turn")
        clock[0] += 10
        ac2 = type(ac)(host, now=lambda: clock[0])  # a restart of up sees the same gap
        ac2.tick()
        self.assertEqual(len(host.pasted), 2)
        for step in (20, 270, 299):  # 30 s, 300 s, 599 s after the clear
            clock[0] += step
            ac.tick()
            self.assertEqual(len(host.pasted), 2, step)
        clock[0] += 2
        ac.tick()
        self.assertEqual(len(host.pasted), 3)

    def test_auto_clear_gives_up_a_round_while_the_turn_still_runs(self):
        ac, host, clock, turn, home = self.auto_clear_unit()
        turn("done")
        ac.tick()
        self.assertIn("Checkpoint now", host.pasted[0])
        with open(os.path.join(home, "s1.jsonl"), "a") as fh:  # the checkpoint turn is still running a tool
            fh.write(json.dumps({"type": "assistant", "message": {"role": "assistant", "id": "t1", "content": [
                {"type": "tool_use", "id": "x", "name": "Bash", "input": {}}], "stop_reason": "tool_use"}}) + "\n")
        clock[0] += 500
        ac.tick()
        self.assertEqual(len(host.pasted), 1)  # no /clear in the middle of the turn
        self.assertIsNone(ac.waiting)
        turn("done again")  # at the next turn end it asks again
        ac.tick()
        self.assertEqual(len(host.pasted), 2)
        self.assertIn("Checkpoint now", host.pasted[1])

    def running_markers(self):
        out = []
        for f in glob.glob(os.path.join(self.env["LEAN_AGENT_HOME"], "running", "*.json")):
            try:
                out.append(json.load(open(f)))
            except ValueError:
                pass
        return out

    def start_run(self, turns="4", sleep="0.7", **env):
        """A foreground `run` in its own process group (so a test can kill that group), once its marker exists."""
        self.cli("learn", self.proj, "--name", "proj")
        p = subprocess.Popen([sys.executable, CLI, "run", "-p", "proj", "-m", "haiku", "--why", "x", "look around"],
                             env=dict(self.env, FAKE_TURNS=turns, FAKE_TURN_SLEEP=sleep, **env),
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                             start_new_session=True)
        self.addCleanup(lambda: p.poll() is None and p.kill())
        self.wait_for(lambda: self.running_markers(), "the run's marker")
        self.addCleanup(lambda: [os.kill(m["pid"], signal.SIGKILL) for m in self.running_markers()
                                 if m.get("pid") and service_alive(m["pid"])])
        return p

    def test_a_run_survives_its_foreground_being_killed_and_is_recorded(self):
        p = self.start_run()
        [m] = self.running_markers()
        self.assertTrue(m["detached"])
        self.assertNotEqual(m["pid"], p.pid)
        os.killpg(p.pid, signal.SIGTERM)
        p.wait(timeout=20)
        self.assertTrue(service_alive(m["pid"]))
        self.wait_for(lambda: not self.running_markers(), "the run to finish", 60)
        last = self.ledger()[-1]
        self.assertEqual((last["id"], last["status"]), (m["run"], "done"))

    def test_run_prints_what_it_printed_before_with_a_detached_worker(self):
        self.cli("learn", self.proj, "--name", "proj")
        p = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "look around")
        self.assertRegex(p.stdout, r"run \S+ · haiku · done")
        self.assertIn(f"run {self.ledger()[-1]['id']} started", p.stderr)
        self.assertEqual(self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "again", check=False,
                                  FAKE_FAIL_MODEL="haiku").returncode, 1)
        self.assertEqual(self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "inline", LEAN_AGENT_NO_DETACH="1"
                                  ).returncode, 0)

    def test_a_missing_claude_binary_leaves_no_todo_new_item(self):
        self.cli("learn", self.proj)
        p = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--todo", "new", "t", check=False,
                     LEAN_AGENT_CLAUDE="no-such-claude-binary")
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual(self.todo_count("#1"), 0)

    def test_new_todo_saves_todo_json_once(self):
        sys.path.insert(0, os.path.dirname(CLI))
        import lean_agent as L
        with mock.patch.dict(os.environ, {"LEAN_AGENT_HOME": self.env["LEAN_AGENT_HOME"]}), \
                mock.patch.object(L, "save_json", wraps=L.save_json) as sv, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(L.new_todo("proj", "Export: cap the retry loop"), 1)
        self.assertEqual(sv.call_count, 1)

    def test_todo_none_is_honoured_on_a_re_review(self):
        g = self.git_project()
        self.cli("learn", self.proj, "--name", "proj")
        bad = json.dumps(dict(REUSE_CHECKED, verdict="changes-requested", checks=[], findings=[
            {"severity": "major", "file": "api/totals.py", "line": 3, "issue": "rounding drops cents"}]))
        approve = json.dumps(dict(REUSE_CHECKED, verdict="approve", findings=[], checks=[]))
        self.cli("review", "proj", "--head", "feature", "--base", "main", "--todo", "new", check=False, FAKE_REVIEW=bad)
        g("checkout", "-q", "feature")
        with open(os.path.join(self.proj, "api", "totals.py"), "a") as fh:
            fh.write("# fix\n")
        g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "fix")
        g("checkout", "-q", "main")
        self.cli("review", "proj", "--head", "feature", "--base", "main", "--todo", "none", check=False, FAKE_REVIEW=approve)
        self.assertEqual([r.get("todo") for r in self.ledger() if r.get("role") == "reviewer"], [1, None])

    def test_advise_uses_the_latest_review_of_the_threads_branch(self):
        self.cli("learn", self.proj, "--name", "proj")
        rdir = os.path.join(self.env["LEAN_AGENT_HOME"], "reviews")
        os.makedirs(rdir)

        def rec(ref, thread, verdict):
            return json.dumps({"ts": "2999-01-01T00:00:00", "run": "r", "thread": thread, "verdict": verdict, "head": ref,
                               "ref": ref, "findings": [], "checks": []})
        with open(os.path.join(rdir, "proj.jsonl"), "w") as fh:
            fh.write(rec("mine", "#7", "approve") + "\n" + rec("other", "#8", "changes-requested") + "\n")
        self.cli("advise", "x", "--thread", "#7", FAKE_ANSWER="ADVICE\nline")
        self.assertIn("Latest review: approve of mine", self.calls()[-1]["task"])
        self.cli("advise", "x", "--thread", "#9", FAKE_ANSWER="ADVICE\nline")
        self.assertIn("Latest review: changes-requested of other", self.calls()[-1]["task"])

    def test_in_process_run_does_not_fork(self):
        sys.path.insert(0, os.path.dirname(CLI))
        import lean_agent as L
        with mock.patch.object(L, "CLI_ENTRY", []), mock.patch.dict(os.environ, {}, clear=False), \
                mock.patch.object(os, "fork") as fork:
            os.environ.pop("LEAN_AGENT_NO_DETACH", None)
            self.assertIsNone(L.detach_run(os.path.join(self.tmp.name, "wd"), "r1"))
        fork.assert_not_called()

    def test_forked_supervisor_never_returns_into_the_caller(self):
        sys.path.insert(0, os.path.dirname(CLI))
        import lean_agent as L

        class Exited(BaseException):
            pass
        for boom in (RuntimeError("x"), SystemExit(3), None):
            with mock.patch.object(L, "CLI_ENTRY", [True]), mock.patch.object(L, "SUPERVISOR", [True]), \
                    mock.patch.object(L, "_cmd_run", side_effect=boom, return_value=0), \
                    mock.patch.object(os, "_exit", side_effect=Exited) as ex:
                with self.assertRaises(Exited), contextlib.redirect_stderr(io.StringIO()):
                    L.cmd_run(types.SimpleNamespace())
            ex.assert_called_once()
        with mock.patch.object(L, "CLI_ENTRY", [True]), mock.patch.object(L, "SUPERVISOR", []), \
                mock.patch.object(os, "fork", return_value=0), mock.patch.object(os, "setsid", side_effect=OSError), \
                mock.patch.object(os, "_exit", side_effect=Exited) as ex:
            with self.assertRaises(Exited):
                L.detach_run(os.path.join(self.tmp.name, "wd"), "r1")
        ex.assert_called_once_with(1)

    def test_a_second_ctrl_c_while_the_supervisor_is_signalled_is_deferred_and_exits_130(self):
        sys.path.insert(0, os.path.dirname(CLI))
        import lean_agent as L
        sent = []

        def fake_signal_group(pid, sig, wait=0):
            sent.append(sig)
            os.kill(os.getpid(), signal.SIGINT)  # the second Ctrl-C lands while the first is being passed on
            time.sleep(0.05)
            return True

        def fake_waitpid(pid, flags):
            if not sent:
                os.kill(os.getpid(), signal.SIGINT)  # the first Ctrl-C, once the relay loop runs
            return (pid, 0) if len(sent) >= 2 else (0, 0)
        old = signal.getsignal(signal.SIGINT)
        with mock.patch.object(L, "CLI_ENTRY", [True]), mock.patch.object(L, "SUPERVISOR", []), \
                mock.patch.dict(os.environ, {"LEAN_AGENT_NO_DETACH": ""}), \
                mock.patch.object(os, "fork", return_value=4242), mock.patch.object(os, "waitpid", fake_waitpid), \
                mock.patch.object(L, "signal_group", fake_signal_group), mock.patch.object(L, "ledger", return_value=[]):
            rc = None
            try:
                rc = L.detach_run(os.path.join(self.tmp.name, "wd"), "r1")
            except KeyboardInterrupt:
                self.fail("Ctrl-C escaped detach_run")
        self.assertEqual(rc, 130)
        self.assertEqual(sent, [signal.SIGINT, signal.SIGINT])
        self.assertIs(signal.getsignal(signal.SIGINT), old)

    def test_no_detach_run_removes_its_running_marker_when_the_tee_closes(self):
        self.cli("learn", self.proj, "--name", "proj")
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "inline", LEAN_AGENT_NO_DETACH="1")
        self.assertEqual(self.running_markers(), [])

    def test_two_processes_marking_runs_collected_keep_both_ids(self):
        home = self.env["LEAN_AGENT_HOME"]
        code = ("import sys; sys.path.insert(0, %r); import lean_common; "
                "[lean_common.mark_collected_ids(%r, [f'{sys.argv[1]}{i}']) for i in range(30)]"
                % (os.path.dirname(CLI), home))
        procs = [subprocess.Popen([sys.executable, "-c", code, tag]) for tag in ("a", "b")]
        for p in procs:
            self.assertEqual(p.wait(timeout=60), 0)
        done = json.load(open(os.path.join(home, "collected.json")))
        for tag in ("a", "b"):
            for i in range(30):
                self.assertIn(f"{tag}{i}", done)

    def test_ctrl_c_in_the_foreground_still_stops_the_run(self):
        p = self.start_run(turns="20", sleep="1")
        [m] = self.running_markers()
        p.send_signal(signal.SIGINT)
        p.wait(timeout=40)
        self.assertNotEqual(p.returncode, 0)
        self.wait_for(lambda: not service_alive(m["pid"]), "the run to stop", 40)

    def test_runs_stop_ends_the_run_marks_it_stopped_and_lists_its_changes(self):
        g = self.git_project()
        g("add", "-A")
        g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "page")
        p = self.start_run(turns="3", sleep="30")
        [m] = self.running_markers()
        self.assertTrue(m["start_head"])
        self.assertTrue(os.path.isdir(m["path"]))
        with open(os.path.join(m["path"], "api", "totals.py"), "a") as fh:
            fh.write("# half done\n")
        out = self.cli("runs", "--stop", "last", LEAN_AGENT_STOP_WAIT="3").stdout
        p.communicate(timeout=30)
        self.assertIn(f"run {m['run']} stopped", out)
        self.assertIn("api/totals.py", out)
        self.assertIn(f"lean-agent run --resume {m['run']}", out)
        self.assertIn("reset --hard " + m["start_head"][:12], out)
        self.assertEqual(self.running_markers(), [])  # never left as running
        row = next(r for r in self.ledger() if r["id"] == m["run"])
        self.assertEqual(row["status"], "stopped")
        for k, v in m["fixed"].items():  # the same fields as a finished run's row
            if k not in ("why", "session_id"):
                self.assertEqual(row[k], v, k)
        for k in ("read_only", "tools", "chrome", "native_rules", "answer_lines", "cards", "thread", "type"):
            self.assertIn(k, row)
        self.assertIn("No runs in progress.", self.cli("runs", "--running").stdout)
        self.assertIn("already ended: stopped", self.cli("runs", "--stop", m["run"], check=False).stderr)

    def test_cap_counts_only_live_sessions_and_close_frees_a_slot(self):
        p, log, ss = self.start_up()
        self.cli("config", "max-thread-sessions", "1")
        dead = subprocess.Popen(["true"])
        dead.wait()
        lt = self.threads_home()
        tid = lt.new("stale")
        lt.set_session(tid, session_on=True)  # flagged, with a record whose host died long ago
        ss.update_session(tid, host_pid=dead.pid, host_started=time.time() - 3600)
        out = self.cli("thread", "sessions").stdout
        self.assertNotIn(tid, out)
        self.assertTrue(lt.load()["threads"][tid].get("session_on"))  # still meant to be open: only the host record is pruned
        self.assertNotIn(tid, ss.session_rec("main").get("sessions") or {})
        self.assertIn("started", self.cli("thread", "new", "first").stdout)
        self.assertRegex(self.cli("thread", "sessions").stdout, r"t2\b")
        self.cli("thread", "close", "t2")  # a closed session frees its slot at once, flag and record gone
        self.assertNotIn("t2", self.cli("thread", "sessions").stdout)
        self.assertIsNone(lt.load()["threads"]["t2"].get("session_on"))
        self.assertNotIn("t2", ss.session_rec("main").get("sessions") or {})
        self.cli("thread", "close", "t2")  # idempotent
        self.assertIn("started", self.cli("thread", "new", "second").stdout)
        p.terminate()
        p.wait(timeout=30)

    def test_record_without_a_host_pid_is_not_pending(self):
        p, log, ss = self.start_up()
        self.cli("config", "max-thread-sessions", "1")
        ss.update_session("t9", host_pid=None, host_started=time.time(), pid=None)
        self.assertNotIn("t9", self.cli("thread", "sessions").stdout)
        self.assertIn("t1 started", self.cli("thread", "new", "first").stdout)
        p.terminate()
        p.wait(timeout=30)

    def test_service_restart_resumes_open_sessions_with_stale_host_records_and_counts_them_once(self):
        p, log, ss = self.start_up()
        self.cli("config", "max-thread-sessions", "2")
        lt = self.threads_home()
        self.assertIn("t1 started", self.cli("thread", "new", "first").stdout)
        p.terminate()
        p.wait(timeout=30)
        dead = subprocess.Popen(["true"])
        dead.wait()
        ss.update_session("t1", host_pid=dead.pid, host_started=time.time() - 3600)  # stale record left by a crash
        lt.set_session("t1", session_on=True)
        self.cli("thread", "sessions", check=False)  # pruning the dead record keeps the intent
        self.assertTrue(lt.load()["threads"]["t1"].get("session_on"))
        p2, log2, ss2 = self.start_up()
        self.wait_for(lambda: len(re.findall(r"^t1\b", self.cli("thread", "sessions", check=False).stdout, re.M)) == 1,
                      "t1 resumed once")
        self.assertTrue(lt.load()["threads"]["t1"].get("session_on"))
        self.cli("thread", "close", "t1")
        self.assertIsNone(lt.load()["threads"]["t1"].get("session_on"))
        self.assertNotIn("t1", ss2.session_rec("main").get("sessions") or {})
        p2.terminate()
        p2.wait(timeout=30)

    def test_at_the_cap_the_longest_idle_session_without_a_run_is_closed(self):
        p, log, ss = self.start_up()
        self.cli("config", "max-thread-sessions", "2")
        lt = self.threads_home()
        self.cli("thread", "new", "alpha topic")
        self.wait_for(lambda: re.search(r"^t1\b.*idle [1-9]\d*s", self.cli("thread", "sessions").stdout, re.M),
                      "alpha to be idle longer than beta will be")
        self.cli("thread", "new", "beta topic")
        out = self.cli("thread", "new", "gamma topic").stdout
        self.assertRegex(out, r'closed t1 "alpha topic" \(idle \d+[mhd]\) to make room \u2014 reopen with lean-agent thread open t1')
        self.assertIn("t3 started", out)
        self.assertIsNone(lt.load()["threads"]["t1"].get("session_on"))
        self.assertTrue(lt.load()["threads"]["t1"].get("closed"))
        # every counted session busy: refuse and list them
        home = self.env["LEAN_AGENT_HOME"]
        os.makedirs(os.path.join(home, "running"), exist_ok=True)
        sleeper = subprocess.Popen(["sleep", "60"])
        self.addCleanup(sleeper.kill)
        for i, tid in enumerate(("t2", "t3")):
            with open(os.path.join(home, "running", f"k{i}.json"), "w") as fh:
                json.dump({"pid": sleeper.pid, "run": f"0101-00000{i}-aaaa", "started": "2026-01-01T00:00:00", "task": "t",
                           "model": "haiku", "project": "proj", "thread": tid}, fh)
        r = self.cli("thread", "new", "delta topic", check=False)
        self.assertNotEqual(r.returncode, 0)
        err = r.stderr + r.stdout
        self.assertRegex(err, r't2 "beta topic" idle \d+[mhd], 1 running')
        self.assertRegex(err, r't3 "gamma topic" idle \d+[mhd], 1 running')
        p.terminate()
        p.wait(timeout=30)

    def lost_run_marker(self, rid="0101-000000-aaaa"):
        home = self.env["LEAN_AGENT_HOME"]
        os.makedirs(os.path.join(home, "running"), exist_ok=True)
        dead = subprocess.Popen(["true"])
        dead.wait()
        with open(os.path.join(home, "running", f"{rid}.json"), "w") as fh:
            json.dump({"pid": dead.pid, "run": rid, "started": "2026-01-01T00:00:00", "task": "t", "model": "haiku",
                       "project": "proj"}, fh)

    def test_runs_running_hides_lost_runs_and_lost_lists_and_clears_them(self):
        self.lost_run_marker("0101-000000-aaaa")
        self.lost_run_marker("0101-000001-bbbb")
        out = self.cli("runs", "--running").stdout
        self.assertIn("2 lost runs \u2014 lean-agent runs --lost", out)
        self.assertNotIn("0101-000000-aaaa", out)
        lost = self.cli("runs", "--lost").stdout
        self.assertIn("0101-000000-aaaa", lost)
        self.assertIn("0101-000001-bbbb", lost)
        self.assertIn("2 lost runs marked", self.cli("runs", "--lost", "--clear").stdout)
        self.assertIn("No runs in progress.", self.cli("runs", "--running").stdout)
        self.assertIn("No lost runs.", self.cli("runs", "--lost").stdout)
        r = self.cli("runs", "--clear", check=False)
        self.assertEqual(r.returncode, 2)
        self.assertIn("--clear goes with --lost", r.stderr)
        stopped = self.cli("runs", "--stop", "0101-000000-aaaa", check=False)  # acknowledged, still stoppable by id
        self.assertNotIn("no running run", stopped.stderr)

    def test_routing_by_id_beats_topic_words(self):
        lt = self.threads_home()
        t0 = datetime.datetime.now().timestamp() - 5000
        lt.route("Investigate PR 4711 login failures", "s1", t0)  # t1
        lt.route("Status dashboard design review notes", "s1", t0 + 10)  # t2
        lt.route("Prepare release notes and changelog", "s1", t0 + 20)  # t3
        self.assertEqual(lt.route("4711 status", "s1", t0 + 30)[0], "t1")
        self.assertEqual(lt.advise("4711 status", "s1", t0 + 31)[0], "t1")
        self.assertEqual(lt.route("PR 4711 needs a status dashboard review", "s1", t0 + 40)[0], "t1")
        self.assertEqual(lt.route("create the release PR", "s1", t0 + 50)[0], "t3")
        # several threads mention the id: the most recent mention wins
        lt.route("Also PR 4711 again", "s1", t0 + 60)  # t1 (4711)
        lt.route("Dashboard colours", "s1", t0 + 70)
        lt.pin("t2", "Dashboard PR 4711 follow-up", "s1", t0 + 80)
        self.assertEqual(lt.route("what about 4711", "s1", t0 + 90)[0], "t2")

    def test_bare_numbers_are_ordinary_words_without_an_id_reference_in_history(self):
        lt = self.threads_home()
        t0 = datetime.datetime.now().timestamp() - 5000
        lt.route("Investigate PR 4711 login failures", "s1", t0)  # t1
        lt.route("Check the proxy listening on port 8080", "s1", t0 + 10)  # t2, 8080 is just a port
        self.assertEqual(lt.id_thread("port 8080 is busy", lt.load()), None)
        self.assertEqual(lt.id_thread("4711 status", lt.load()), "t1")

    def test_explicit_hash_number_creates_the_task_thread(self):
        lt = self.threads_home()
        t0 = datetime.datetime.now().timestamp() - 5000
        for n in ("4711", "12"):
            tid, how, _ = lt.route(f"Start on #{n} please", "s1", t0)
            self.assertEqual((tid, how), (f"#{n}", "explicit"))
            self.assertIn(f"#{n}", lt.load()["threads"])

    def test_prompt_ids(self):
        lt = self.threads_home()
        self.assertEqual(lt.prompt_refs("fix #4711 and PR 4712 and AB#4713"), ({"4711", "4712", "4713"}, set()))
        self.assertEqual(lt.prompt_refs("port 8080 returns 502"), (set(), {"8080", "502"}))
        self.assertEqual(lt.prompt_refs("on feature/4711-login")[0], {"feature/4711-login"})
        self.assertEqual(lt.prompt_ids("port 80 on feature/x-1"), {"feature/x-1"})
        self.assertEqual(lt.prompt_ids("#4711 and 4711"), {"4711"})

    def test_history_id_reference_pattern(self):
        lt = self.threads_home()
        hit = lambda n, text: bool(lt._bare_ref_pat(n).search(text))
        for text in ("fixed #256", "PR 256 merged", "AB#256", "ABC-256 done", "on feature/256-login", "bugfix/ABC-256"):
            self.assertTrue(hit("256", text), text)
        for text in ("case 256 closed", "bug 256", "issue 256", "uses sha-256", "SHA256", "date 2026-10-256", "port 256"):
            self.assertFalse(hit("256", text), text)

    def test_routing_by_branch_name(self):
        lt = self.threads_home()
        t0 = datetime.datetime.now().timestamp() - 5000
        lt.route("Work on feature/login-redesign today", "s1", t0)  # t1
        lt.route("Dashboard colours", "s1", t0 + 10)  # t2
        self.assertEqual(lt.id_thread("rebase feature/login-redesign please", lt.load()), "t1")

    def test_a_run_whose_supervisor_died_is_lost_and_stop_closes_it(self):
        home = self.env["LEAN_AGENT_HOME"]
        os.makedirs(os.path.join(home, "running"), exist_ok=True)
        dead = subprocess.Popen(["true"])
        dead.wait()
        with open(os.path.join(home, "running", "k1.json"), "w") as fh:
            json.dump({"pid": dead.pid, "run": "0101-000000-aaaa", "started": "2026-01-01T00:00:00", "task": "t",
                       "model": "haiku", "project": "proj", "workdir": os.path.join(home, "work", "0101-000000-aaaa"),
                       "fixed": {"read_only": True, "tools": "Read,Grep", "cards": ["c1"], "answer_lines": 7, "thread": "th"}}, fh)
        self.assertRegex(self.cli("runs").stdout, r"0101-000000-aaaa\s+lost")
        self.assertIn("lost", self.cli("runs", "--running").stdout)
        out = self.cli("runs", "--stop", "0101-000000-aaaa").stdout
        self.assertIn("stopped", out)
        self.assertNotRegex(self.cli("runs").stdout, r"aaaa\s+lost")
        self.assertRegex(self.cli("runs").stdout, r"aaaa\s+stopped")
        row = next(r for r in self.ledger() if r["id"] == "0101-000000-aaaa")
        self.assertTrue(row["status"].startswith("stopped"), row["status"])
        self.assertFalse(os.path.exists(os.path.join(home, "running", "k1.json")))
        self.assertEqual((row["read_only"], row["tools"], row["cards"], row["answer_lines"], row["thread"]),
                         (True, "Read,Grep", ["c1"], 7, "th"))

    def test_stop_last_picks_the_newest_live_run_never_a_lost_one(self):
        home = self.env["LEAN_AGENT_HOME"]
        os.makedirs(os.path.join(home, "running"), exist_ok=True)
        dead = subprocess.Popen(["true"])
        dead.wait()
        with open(os.path.join(home, "running", "k9.json"), "w") as fh:
            json.dump({"pid": dead.pid, "run": "0101-000000-bbbb", "started": "2099-01-01T00:00:00", "task": "t",
                       "model": "haiku", "project": "proj"}, fh)
        r = self.cli("runs", "--stop", "last", check=False)  # only a lost run exists: nothing live to stop
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("no run in progress", r.stderr)
        self.assertIn("0101-000000-bbbb", r.stderr)
        p = self.start_run(turns="3", sleep="30")
        live = []
        self.wait_for(lambda: live.__setitem__(slice(None), [m for m in self.running_markers() if m["run"] != "0101-000000-bbbb"]) or live,
                      "the live run's marker")
        out = self.cli("runs", "--stop", "last", LEAN_AGENT_STOP_WAIT="3").stdout
        p.communicate(timeout=30)
        self.assertIn(f"run {live[0]['run']} stopped", out)
        self.assertFalse([x for x in self.ledger() if x["id"] == "0101-000000-bbbb"])

    def test_runs_wait_prints_each_result_and_the_exit_code(self):
        p = self.start_run(turns="3", sleep="0.7")
        [m] = self.running_markers()
        w = self.cli("runs", "--wait", "all", LEAN_AGENT_WAIT_POLL="0.2")
        self.assertRegex(w.stdout, rf"run {m['run']} · haiku · done")
        self.assertIn("resume: lean-agent run --resume", w.stdout)
        out, _ = p.communicate(timeout=30)
        self.assertEqual(w.stdout.strip(), out[out.index("run " + m["run"] + " ·"):].strip())
        again = self.cli("runs", "--wait", m["run"])  # already finished: printed at once
        self.assertEqual(again.stdout, w.stdout)
        self.assertIn("Nothing to collect.", self.cli("runs", "--wait", "all").stdout)
        self.assertEqual(self.cli("runs", "--wait", "nope", check=False).returncode, 1)

    def test_runs_wait_all_collects_a_run_that_finished_without_a_foreground_once(self):
        p = self.start_run(turns="3", sleep="0.5")
        [m] = self.running_markers()
        os.killpg(p.pid, signal.SIGTERM)
        p.wait(timeout=20)
        self.wait_for(lambda: not self.running_markers(), "the run to finish", 60)
        brief = self.cli("brief").stdout
        self.assertIn(f"Finished, not collected: {m['run']}", brief)
        w = self.cli("runs", "--wait", "all", LEAN_AGENT_WAIT_POLL="0.2")
        self.assertRegex(w.stdout, rf"run {m['run']} · haiku · done")
        again = self.cli("runs", "--wait", "all")
        self.assertEqual(again.stdout.strip(), "Nothing to collect.")
        self.assertNotIn("not collected", self.cli("brief").stdout)

    def test_stopping_up_kills_the_hosted_claude_but_not_a_detached_run(self):
        # KillMode=process / AbandonProcessGroup: the service signals only `up`'s own pid
        p, log, ss = self.start_up("--name", "la")
        claude = ss.info()["pid"]
        self.assertTrue(service_alive(claude))
        run = self.start_run(turns="20", sleep="1")
        [m] = self.running_markers()
        os.kill(p.pid, signal.SIGTERM)
        p.wait(timeout=40)
        self.wait_for(lambda: not service_alive(claude), "the hosted claude to stop", 20)
        self.assertTrue(service_alive(m["pid"]))
        self.assertEqual([x["run"] for x in self.running_markers()], [m["run"]])

    def test_runs_wait_exits_nonzero_for_a_failed_run_and_on_timeout(self):
        p = self.start_run(turns="3", sleep="0.5", FAKE_FAIL_MODEL="haiku")
        w = self.cli("runs", "--wait", "last", check=False, LEAN_AGENT_WAIT_POLL="0.2")
        self.assertEqual(w.returncode, 1)
        self.assertIn("failed", w.stdout)
        p.communicate(timeout=30)

    def write_ledger(self, *entries):
        home = self.env["LEAN_AGENT_HOME"]
        os.makedirs(home, exist_ok=True)
        with open(os.path.join(home, "ledger.jsonl"), "a") as fh:
            for e in entries:
                fh.write(json.dumps(dict({"project": "proj", "model": "haiku", "status": "done"}, **e)) + "\n")

    def test_runs_wait_last_skips_a_running_role_run(self):
        home = self.env["LEAN_AGENT_HOME"]
        os.makedirs(os.path.join(home, "running"))
        for rid, role, started in (("ord1", None, "2026-01-01T00:00:01"), ("rev1", "reviewer", "2026-01-01T00:00:02")):
            with open(os.path.join(home, "running", rid + ".json"), "w") as fh:
                json.dump({"pid": os.getpid(), "run": rid, "role": role, "started": started, "model": "haiku",
                           "project": "proj", "task": "t"}, fh)
        t = self.cli("runs", "--wait", "last", "--timeout", "1", check=False, LEAN_AGENT_WAIT_POLL="0.2")
        self.assertEqual(t.returncode, 124)
        self.assertIn("still running: ord1", t.stdout)
        self.assertNotIn("rev1", t.stdout)

    def test_runs_wait_retries_while_the_summary_file_is_written(self):
        home = self.env["LEAN_AGENT_HOME"]
        wd = os.path.join(home, "work", "r9")
        os.makedirs(wd)
        self.write_ledger({"id": "r9", "ts": "2999-01-01T00:00:00", "workdir": wd})

        def late():
            time.sleep(0.6)
            with open(os.path.join(wd, "summary-1.txt"), "w") as fh:
                fh.write("run r9 · the late summary\n")
        th = threading.Thread(target=late)
        th.start()
        w = self.cli("runs", "--wait", "r9", LEAN_AGENT_WAIT_POLL="0.2")
        th.join()
        self.assertIn("the late summary", w.stdout)

    def test_signal_group_only_reaches_a_group_it_could_have_created(self):
        sys.path.insert(0, os.path.dirname(CLI))
        import lean_common
        own = os.getpgrp()
        with mock.patch.object(os, "killpg") as kp:
            for bad in (0, 1, -1, -5, None, "x", os.getpid(), own):
                self.assertFalse(lean_common.signal_group(bad, signal.SIGKILL), bad)
            kp.assert_not_called()
        child = subprocess.Popen(["sleep", "30"])  # shares our group: not a group of its own
        shared = subprocess.Popen(["sleep", "30"], start_new_session=True)
        try:
            with mock.patch.object(os, "killpg") as kp:
                self.assertFalse(lean_common.signal_group(child.pid, signal.SIGKILL))
                kp.assert_not_called()
                self.assertTrue(lean_common.signal_group(shared.pid, signal.SIGTERM))
                kp.assert_called_once_with(shared.pid, signal.SIGTERM)
        finally:
            child.kill()
            shared.kill()
            child.wait()
            shared.wait()
        self.assertFalse(lean_common.pid_alive(0))

    def test_signal_group_is_false_when_getpgid_finds_no_process(self):
        sys.path.insert(0, os.path.dirname(CLI))
        import lean_common
        with mock.patch.object(os, "getpgid", side_effect=ProcessLookupError), mock.patch.object(os, "killpg") as kp:
            self.assertFalse(lean_common.signal_group(os.getpid() + 12345, signal.SIGTERM))
            self.assertFalse(lean_common.signal_group(os.getpid() + 12345, signal.SIGTERM, wait=0.2))
        kp.assert_not_called()

    def test_signal_group_waits_for_a_fresh_child_to_become_its_group_leader(self):
        sys.path.insert(0, os.path.dirname(CLI))
        import lean_common
        ready = os.path.join(self.tmp.name, "child-started")
        go = os.path.join(self.tmp.name, "child-go")
        child = subprocess.Popen([sys.executable, "-c", (
            "import os, sys, time\n"
            "open(sys.argv[1], 'w').close()\n"  # written before setsid: the child is up but still in our group
            "while not os.path.exists(sys.argv[2]): time.sleep(0.01)\n"
            "os.setsid(); time.sleep(30)"), ready, go])
        try:
            deadline = time.time() + 10
            while not os.path.exists(ready) and time.time() < deadline:
                time.sleep(0.01)
            self.assertTrue(os.path.exists(ready))
            self.assertFalse(lean_common.signal_group(child.pid, signal.SIGTERM))  # not its own group yet
            open(go, "w").close()
            self.assertTrue(lean_common.signal_group(child.pid, signal.SIGTERM, wait=5))
            self.assertEqual(child.wait(timeout=10), -signal.SIGTERM)
        finally:
            child.kill()
            child.wait()

    def test_host_stop_terminates_directly_when_signal_group_refuses(self):
        sys.path.insert(0, os.path.dirname(CLI))
        import service_session
        host = object.__new__(service_session.Host)
        host.stopping = threading.Event()
        host.proc = mock.Mock(pid=4242)
        host.proc.poll.return_value = None
        with mock.patch.object(service_session.lean_common, "signal_group", return_value=False) as sg, \
                mock.patch.object(threading, "Timer") as timer:
            host.stop()
        sg.assert_called_once_with(4242, signal.SIGTERM)
        host.proc.terminate.assert_called_once_with()
        self.assertTrue(host.stopping.is_set())
        timer.return_value.start.assert_called_once_with()

    def test_a_tee_that_fails_to_close_still_ends_the_supervisor_with_os_exit(self):
        sys.path.insert(0, os.path.dirname(CLI))
        import lean_agent as L

        class Exited(BaseException):
            pass

        class BadTee(L.Tee):
            def __init__(self):
                pass

            def close(self):
                raise OSError("disk full")

            def flush(self):
                pass
        old = sys.stdout
        sys.stdout = BadTee()
        try:
            with mock.patch.object(L, "SUPERVISOR", [True]), mock.patch.object(L, "_cmd_run", return_value=0), \
                    mock.patch.object(os, "_exit", side_effect=Exited) as ex:
                with self.assertRaises(Exited):
                    L.cmd_run(types.SimpleNamespace())
        finally:
            sys.stdout = old
        ex.assert_called_once_with(0)

    def test_runs_show_marks_the_run_collected(self):
        home = self.env["LEAN_AGENT_HOME"]
        wd = os.path.join(home, "work", "r8")
        os.makedirs(wd)
        with open(os.path.join(wd, "summary-1.txt"), "w") as fh:
            fh.write("run r8 · shown\n")
        self.write_ledger({"id": "r8", "ts": "2999-01-01T00:00:00", "workdir": wd})
        self.assertEqual(self.cli("runs", "--wait", "all").stdout.count("shown"), 1)  # waiting collects it once
        self.write_ledger({"id": "r7", "ts": "2999-01-01T00:00:01", "workdir": wd})
        self.cli("runs", "--show", "r7")
        self.assertIn("Nothing to collect.", self.cli("runs", "--wait", "all").stdout)
        self.assertIn("r7", json.load(open(os.path.join(home, "collected.json"))))

    def test_a_ledger_older_than_collected_json_has_nothing_to_collect(self):
        sys.path.insert(0, os.path.dirname(CLI))
        import lean_common
        home = self.env["LEAN_AGENT_HOME"]
        self.write_ledger({"id": "old1", "ts": "2020-01-01T00:00:00"}, {"id": "old2", "ts": "2020-01-02T00:00:00"},
                          {"id": "old2", "ts": "2020-01-03T00:00:00"})
        self.assertEqual(lean_common.uncollected_ids(home), [])
        self.assertTrue(os.path.exists(os.path.join(home, "collected.json")))
        self.assertEqual(json.load(open(os.path.join(home, "collected.json"))).keys(), {"_cutoff"})  # no old ids written
        self.assertIn("Nothing to collect.", self.cli("runs", "--wait", "all").stdout)
        self.write_ledger({"id": "new1", "ts": "2999-01-01T00:00:00"}, {"id": "new1", "ts": "2999-01-02T00:00:00"})
        self.assertEqual(lean_common.uncollected_ids(home), ["new1"])  # a resumed run counts once
        lean_common.mark_collected_ids(home, ["new1"])
        self.assertEqual(lean_common.uncollected_ids(home), [])

    def test_runs_wait_times_out_with_a_nonzero_exit(self):
        p = self.start_run(turns="8", sleep="1")
        [m] = self.running_markers()
        t = self.cli("runs", "--wait", "all", "--timeout", "1", check=False, LEAN_AGENT_WAIT_POLL="0.2")
        self.assertEqual(t.returncode, 124)
        self.assertIn(f"timeout: still running: {m['run']}", t.stdout)

    def test_brief_lists_running_runs_and_how_to_collect_them(self):
        os.makedirs(os.path.join(self.env["LEAN_AGENT_HOME"], "running"))
        with open(os.path.join(self.env["LEAN_AGENT_HOME"], "running", "r1.json"), "w") as fh:
            json.dump({"pid": os.getpid(), "run": "r1", "model": "haiku", "project": "proj", "task": "t"}, fh)
        line = next(l for l in self.cli("brief").stdout.splitlines() if l.startswith("Running now:"))
        self.assertIn("r1 haiku proj: t", line)
        self.assertTrue(line.endswith("collect with `lean-agent runs --wait all`"), line)

    def test_service_restart_keeps_detached_runs_but_refuses_legacy_ones(self):
        fake = os.path.join(self.tmp.name, "systemctl")
        with open(fake, "w") as fh:
            fh.write("#!/bin/sh\nexit 0\n")
        os.chmod(fake, 0o755)
        env = dict(LEAN_AGENT_SERVICE_PLATFORM="linux", LEAN_AGENT_SYSTEMCTL=fake)
        self.cli("service", "install", **env)
        with open(os.path.join(self.tmp.name, ".config", "systemd", "user", "lean-agent.service")) as fh:
            self.assertIn("KillMode=process", fh.read())
        p = self.start_run(turns="6", sleep="0.7")
        [m] = self.running_markers()
        self.assertEqual(self.cli("service", "restart", **env).returncode, 0)
        self.assertTrue(service_alive(m["pid"]))
        legacy = os.path.join(self.env["LEAN_AGENT_HOME"], "running", "old.json")
        with open(legacy, "w") as fh:
            json.dump({"pid": os.getpid(), "run": "old"}, fh)
        r = self.cli("service", "restart", check=False, **env)
        self.assertEqual(r.returncode, 1)
        self.assertIn("not detached", r.stderr)
        self.assertEqual(self.cli("service", "restart", "--yes", **env).returncode, 0)
        os.remove(legacy)
        p.communicate(timeout=60)

    def test_auto_clear_holds_while_a_run_is_alive_until_compaction_is_near(self):
        ac, host, clock, turn, home = self.auto_clear_unit()
        os.environ["LEAN_AGENT_CLEAR_AT"] = "auto"  # 59,000 of the default 67,000
        os.makedirs(os.path.join(home, "running"))
        marker = os.path.join(home, "running", "r1.json")
        with open(marker, "w") as fh:
            json.dump({"pid": os.getpid(), "run": "r1"}, fh)
        turn("done", ctx=50000)  # below auto: nothing
        ac.tick()
        self.assertEqual(host.pasted, [])
        turn("done", ctx=60000)  # due, but a run is alive
        ac.tick()
        self.assertEqual(host.pasted, [])
        self.assertIn("1 run(s) alive (r1)", json.load(open(os.path.join(home, "up.json")))["clear_hold"])
        turn("done", ctx=64500)  # within 3,000 of compaction: clear anyway, with the checkpoint step
        ac.tick()
        self.assertIn("Checkpoint now", host.pasted[0])
        self.assertIn("r1", host.pasted[0])
        os.remove(marker)

    def alive_runs(self, home, n):
        os.makedirs(os.path.join(home, "running"), exist_ok=True)
        for i in range(1, n + 1):
            with open(os.path.join(home, "running", f"r{i}.json"), "w") as fh:
                json.dump({"pid": os.getpid(), "run": f"r{i}", "started": f"2026-10-23T10:00:0{i}"}, fh)

    def test_auto_clear_names_three_of_many_runs_in_the_hold_and_six_in_the_checkpoint(self):
        ac, host, clock, turn, home = self.auto_clear_unit()
        os.environ["LEAN_AGENT_CLEAR_AT"] = "auto"
        self.alive_runs(home, 7)
        turn("done", ctx=60000)
        ac.tick()
        self.assertEqual(host.pasted, [])
        hold = json.load(open(os.path.join(home, "up.json")))["clear_hold"]
        self.assertIn("7 run(s) alive (r1, r2, r3, ...)", hold)
        turn("done", ctx=64500)
        ac.tick()
        self.assertIn("r1, r2, r3, r4, r5, r6", host.pasted[0])
        self.assertNotIn("r7", host.pasted[0])

    def test_auto_clear_goes_ahead_exactly_3000_below_compaction_despite_runs(self):
        ac, host, clock, turn, home = self.auto_clear_unit()
        os.environ["LEAN_AGENT_CLEAR_AT"] = "auto"
        self.alive_runs(home, 1)
        turn("done", ctx=63998)  # the turn adds 1 input token: 63,999 in all
        ac.tick()
        self.assertEqual(host.pasted, [])
        turn("done", ctx=63999)  # 64,000 in all: exactly CLEAR_HARD below compaction
        ac.tick()
        self.assertEqual(len(host.pasted), 1)

    def test_auto_clear_hold_is_cleared_when_the_clear_is_turned_off(self):
        ac, host, clock, turn, home = self.auto_clear_unit()
        os.environ["LEAN_AGENT_CLEAR_AT"] = "auto"
        self.alive_runs(home, 1)
        turn("done", ctx=60000)
        ac.tick()
        self.assertIn("alive", json.load(open(os.path.join(home, "up.json")))["clear_hold"])
        os.environ["LEAN_AGENT_CLEAR_AT"] = "0"
        ac.tick()
        with open(os.path.join(home, "up.json")) as fh:
            self.assertIsNone(json.load(fh)["clear_hold"])
        self.assertEqual(host.pasted, [])

    def test_auto_clear_at_auto_means_just_before_compaction(self):
        for value in ("auto", "AUTO"):
            with self.subTest(value=value):
                ac, host, clock, turn, home = self.auto_clear_unit()
                os.environ["LEAN_AGENT_CLEAR_AT"] = value
                turn("done", ctx=58000)  # auto = 67,000 - 8,000 = 59,000
                ac.tick()
                self.assertEqual(host.pasted, [])
                turn("done", ctx=60000)
                ac.tick()
                self.assertEqual(len(host.pasted), 1)

    def test_auto_clear_is_off_by_default_at_any_context_size(self):
        for value in (None, "off", "0", "lots", "-5", "1e5"):
            with self.subTest(value=value):
                ac, host, clock, turn, home = self.auto_clear_unit()
                os.environ.pop("LEAN_AGENT_CLEAR_AT")
                if value is not None:
                    os.environ["LEAN_AGENT_CLEAR_AT"] = value
                for ctx in (60000, 66000, 500000):
                    turn("done", ctx=ctx)
                    clock[0] += 3600
                    ac.tick()
                self.assertEqual(host.pasted, [])

    def queue_clear(self, home):
        import service_session
        with open(os.path.join(home, "up.json"), "w") as fh:
            json.dump({}, fh)
        with mock.patch.object(service_session, "alive", return_value=True):
            self.assertTrue(service_session.request_clear())

    def test_clear_request_clears_at_turn_end_ignoring_threshold_cooldown_and_live_runs(self):
        ac, host, clock, turn, home = self.auto_clear_unit()
        os.environ.pop("LEAN_AGENT_CLEAR_AT")  # off
        self.alive_runs(home, 2)
        host.last_input = clock[0] - 1  # the user just typed
        with open(os.path.join(home, "chat", "service.json"), "w") as fh:  # a clear 10 s ago: inside the cooldown
            json.dump({"session_id": "s1", "transcript_path": os.path.join(home, "s1.jsonl"), "source": "clear",
                       "ts": clock[0] - 10}, fh)
        self.queue_clear(home)
        with open(os.path.join(home, "s1.jsonl"), "a") as fh:  # the turn is still running (a tool call)
            fh.write(json.dumps({"type": "assistant", "message": {"role": "assistant", "id": "t", "stop_reason": "tool_use",
                     "content": [{"type": "tool_use", "id": "x", "name": "Bash", "input": {}}],
                     "usage": {"input_tokens": 1, "cache_read_input_tokens": 5000}}}) + "\n")
        ac.tick()
        self.assertEqual(host.pasted, [])
        turn("done", ctx=5000)  # the turn ends, far below any threshold
        ac.tick()
        self.assertEqual(len(host.pasted), 1)
        self.assertIn("Checkpoint now", host.pasted[0])
        self.assertIsNone(json.load(open(os.path.join(home, "up.json"))).get("clear_requested"))
        turn("checkpointed", ctx=5000)
        ac.tick()
        self.assertEqual(host.pasted[-1], "/clear")
        ac.tick()
        self.assertEqual(len(host.pasted), 2)  # once

    def test_a_clear_request_with_a_missing_transcript_gives_up_with_a_status(self):
        ac, host, clock, turn, home = self.auto_clear_unit()
        os.environ.pop("LEAN_AGENT_CLEAR_AT")
        # the transcript s1.jsonl is never written: nothing ever "ends"
        self.queue_clear(home)
        up = lambda: json.load(open(os.path.join(home, "up.json")))
        asked = up()["clear_requested"]
        clock[0] = asked  # the request is stamped with the wall clock; run this test on it
        ac.tick()
        self.assertEqual(host.pasted, [])
        self.assertEqual(up()["clear_requested"], asked)
        clock[0] = asked + 121  # past the wait: reported and dropped
        ac.tick()
        self.assertIsNone(up().get("clear_requested"))
        self.assertRegex(up()["clear_status"], r"^clear not done: the transcript was not found")
        ac.tick()
        self.assertEqual(host.pasted, [])

    def test_a_clear_request_waits_for_a_long_turn_however_long_then_clears(self):
        ac, host, clock, turn, home = self.auto_clear_unit()
        os.environ.pop("LEAN_AGENT_CLEAR_AT")
        self.queue_clear(home)
        asked = json.load(open(os.path.join(home, "up.json")))["clear_requested"]
        clock[0] = asked
        with open(os.path.join(home, "s1.jsonl"), "a") as fh:  # a turn mid tool call
            fh.write(json.dumps({"type": "assistant", "message": {"role": "assistant", "id": "t", "stop_reason": "tool_use",
                     "content": [{"type": "tool_use", "id": "x", "name": "Bash", "input": {}}],
                     "usage": {"input_tokens": 1, "cache_read_input_tokens": 5000}}}) + "\n")
        for _ in range(5):
            clock[0] += 3600
            ac.tick()
        self.assertEqual(host.pasted, [])
        up = json.load(open(os.path.join(home, "up.json")))
        self.assertTrue(up.get("clear_requested"))
        self.assertIsNone(up.get("clear_status"))
        turn("done", ctx=5000)
        ac.tick()
        self.assertIn("Checkpoint now", host.pasted[0])
        turn("checkpointed", ctx=5000)
        ac.tick()
        self.assertEqual(host.pasted[-1], "/clear")

    def test_a_clear_request_still_clears_when_a_turn_starts_after_the_checkpoint_prompt(self):
        ac, host, clock, turn, home = self.auto_clear_unit()
        os.environ.pop("LEAN_AGENT_CLEAR_AT")
        turn("done", ctx=5000)
        self.queue_clear(home)
        ac.tick()
        self.assertIn("Checkpoint now", host.pasted[0])
        with open(os.path.join(home, "s1.jsonl"), "a") as fh:  # the checkpoint turn never ends
            fh.write(json.dumps({"type": "assistant", "message": {"role": "assistant", "id": "t", "stop_reason": "tool_use",
                     "content": [{"type": "tool_use", "id": "x", "name": "Bash", "input": {}}],
                     "usage": {"input_tokens": 1, "cache_read_input_tokens": 5000}}}) + "\n")
        ac.tick()
        self.assertEqual(len(host.pasted), 1)
        clock[0] += 121
        ac.tick()
        self.assertEqual(len(host.pasted), 1)  # the turn still runs: no /clear into it
        with open(os.path.join(home, "up.json")) as fh:
            self.assertEqual(json.load(fh)["clear_hold"], "clear requested: waiting for the turn to end")
        sys.path.insert(0, os.path.dirname(CLI))
        import lean_agent
        with mock.patch.dict(os.environ, {"LEAN_AGENT_HOME": home}):
            self.assertIn("clear held: clear requested: waiting for the turn to end", lean_agent.clear_at_text())
        turn("done", ctx=5000)
        ac.tick()
        self.assertEqual(host.pasted[-1], "/clear")
        with open(os.path.join(home, "up.json")) as fh:
            self.assertIsNone(json.load(fh)["clear_hold"])

    def test_host_start_drops_a_stale_clear_request(self):
        import service_session
        home = tempfile.mkdtemp()
        os.environ["LEAN_AGENT_HOME"] = home
        self.addCleanup(os.environ.pop, "LEAN_AGENT_HOME", None)
        with open(os.path.join(home, "up.json"), "w") as fh:
            json.dump({"clear_requested": 5.0}, fh)
        host = service_session.Host(lambda: (["true"], "sid-1"), dict(os.environ), home)
        self.addCleanup(host.stop)
        host._spawn()
        self.addCleanup(host.proc.wait)
        self.addCleanup(os.close, host.master)
        with open(os.path.join(home, "up.json")) as fh:
            self.assertIsNone(json.load(fh)["clear_requested"])

    def test_clear_command_queues_and_without_a_service_session_fails(self):
        r = self.cli("clear", check=False)
        self.assertEqual(r.returncode, 1)
        self.assertIn("no service session", r.stderr)

    def test_up_clear_command_makes_the_host_clear_a_small_context(self):
        p, log, ss = self.auto_clear_up(5000, LEAN_AGENT_CLEAR_AT="off")
        ss.send("hello")
        self.wait_for(lambda: "echo: hello" in json.dumps(self.read_jsonl(log)) or ss.tail().count("ready"), "the turn")
        out = self.cli("clear").stdout
        self.assertIn("clear queued: runs at the end of this turn", out)
        self.assertIn("lean-agent runs --wait all", out)
        self.wait_for(lambda: self.clears(log), "the clear")

    def test_auto_clear_goes_ahead_when_the_runs_are_gone(self):
        ac, host, clock, turn, home = self.auto_clear_unit()
        os.environ["LEAN_AGENT_CLEAR_AT"] = "auto"
        os.makedirs(os.path.join(home, "running"))
        marker = os.path.join(home, "running", "r1.json")
        with open(marker, "w") as fh:
            json.dump({"pid": os.getpid(), "run": "r1"}, fh)
        turn("done", ctx=60000)
        ac.tick()
        self.assertEqual(host.pasted, [])
        os.remove(marker)
        ac.tick()
        self.assertEqual(len(host.pasted), 1)
        self.assertIsNone(json.load(open(os.path.join(home, "up.json")))["clear_hold"])

    def test_brief_run_keeps_the_low_budget_warning(self):
        self.cli("learn", self.proj)
        self.cli("limits", "--5h", "4000")
        self.write_usage(self.lean_project_dir("-work-0101-000000-abcd"), 0.2, "claude-sonnet-5-5", 3500, "z")
        out = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "t", LEAN_AGENT_BRIEF="1").stdout
        self.assertIn("low: prefer -m haiku", out)
        self.assertNotIn("tokens: input", out)  # the rest of the detail stays out of brief mode

    def test_brief_run_without_a_low_budget_has_no_budget_line(self):
        self.cli("learn", self.proj)
        self.cli("limits", "--5h", "400000")
        out = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "t", LEAN_AGENT_BRIEF="1").stdout
        self.assertNotIn("budget left", out)

    def test_brief_review(self):
        self.git_project()
        self.cli("learn", self.proj, "--name", "proj")
        review = json.dumps(dict(REUSE_CHECKED, verdict="changes-requested", findings=[
            {"severity": "blocker", "file": "api/totals.py", "line": 2, "issue": "float money math " + "x" * 200,
             "suggestion": "use integer cents"}], checks=[]))
        p = self.cli("review", "proj", check=False, FAKE_REVIEW=review, FAKE_ANSWER="Long reviewer prose here.",
                     LEAN_AGENT_BRIEF="1")
        self.assertIn("REVIEW: CHANGES-REQUESTED · 1 findings", p.stdout)
        self.assertIn("1. [blocker] api/totals.py:2: float money math", p.stdout)
        self.assertIn("...", p.stdout)
        self.assertNotIn("fix: use integer cents", p.stdout)
        self.assertNotIn("Long reviewer prose", p.stdout)
        self.assertIn("full review (reuse table, coverage, fixes): lean-agent runs --show", p.stdout)
        shown = self.cli("runs", "--show").stdout
        self.assertIn("fix: use integer cents", shown)
        self.assertIn("Long reviewer prose", shown)

    def test_run_stopped_after_too_many_context_reads(self):
        self.cli("learn", self.proj, "--name", "proj")
        p = self.cli("run", "-p", "proj", "-m", "sonnet", "--why", "investigate", "--max-reads", "250000",
                     "investigate the flaky test", check=False, FAKE_TURNS="20", FAKE_TURN_CTX="90000",
                     FAKE_TURN_SLEEP="0.05")
        self.assertEqual(p.returncode, 1)
        r = self.ledger()[-1]
        self.assertEqual(r["status"], "stopped:max_context_reads")
        self.assertEqual(r["turns"], 3)
        self.assertEqual(r["session_id"], "sess-1")
        self.assertIn("STOPPED by lean-agent: the worker re-read 270,030 tokens", p.stdout)
        self.assertIn(f"lean-agent run --resume {r['id']} --max-reads 500000", p.stdout)
        p = self.cli("run", "-p", "proj", "-m", "sonnet", "--why", "x", "--again", "investigate the flaky test",
                     FAKE_TURNS="5", FAKE_TURN_CTX="1000")
        self.assertEqual(self.ledger()[-1]["status"], "done")

    def test_escalate_and_similar_history(self):
        self.cli("learn", self.proj, "--name", "proj")
        p = self.cli("run", "-p", "proj", "--escalate", "haiku,sonnet", "--why", "try cheap first",
                     "fix the totals rounding", FAKE_FAIL_MODEL="haiku")
        self.assertIn("escalating: haiku run", p.stdout)
        self.assertEqual([r["model"] for r in self.ledger()], ["haiku", "sonnet"])
        self.assertEqual([r["status"] for r in self.ledger()], ["failed", "done"])
        self.cli("run", "-p", "proj", "--escalate", "haiku,sonnet", "--why", "x", "--again", "fix the totals rounding")
        self.assertEqual(self.ledger()[-1]["model"], "haiku")  # no escalation when haiku is done
        for _ in range(3):
            self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--again", "post the release notes reply")
        out = self.cli("suggest", "proj", "post the release notes reply now").stdout
        self.assertIn("similar tasks ran on haiku: 3/3 done", out)
        self.assertIn("similar tasks before: haiku 3/3 done", out)
        out = self.cli("suggest", "proj", "refactor the payment module").stdout
        self.assertIn("--escalate haiku,sonnet", out)
        top = self.cli("stats", "--top", "2").stdout
        self.assertIn("Biggest 2 runs:", top)
        self.assertRegex(top, r"ctx/turn\s+\w+")

    def test_auto_cards_skip_core_cards_marked_unneeded(self):
        self.cli("learn", self.proj, "--name", "proj")
        sys.path.insert(0, os.path.dirname(CLI))
        import lean_agent as L
        os.environ["LEAN_AGENT_HOME"] = self.env["LEAN_AGENT_HOME"]
        try:
            cards = L.load_cards("proj")
            for c in cards:
                if c["id"] == "testing":
                    c["core"] = True
                    c["by_type"] = {"change": {"offered": 4, "used": 0, "unneeded": 4}}
            L.save_cards("proj", cards)
        finally:
            os.environ.pop("LEAN_AGENT_HOME", None)
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--cards", "auto", "change the totals")
        self.assertNotIn("[testing]", self.calls()[-1]["append"])
        self.cli("card", "protect", "proj", "testing")
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--cards", "auto", "--again", "change the totals")
        self.assertIn("[testing]", self.calls()[-1]["append"])

    def test_handoff_command(self):
        self.cli("learn", self.proj, "--name", "proj")
        self.cli("memory", "add", "Never merge on Fridays.", "--type", "feedback")
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "reply on PR 512")
        self.assertEqual(self.cli("handoff", "--note", "Ask the user whether to merge PR 512").stdout.strip(),
                         "note 1 added; 1 open")
        self.assertEqual(self.cli("handoff", "--note", "Second item").stdout.strip(), "note 2 added; 2 open")
        out = self.cli("handoff").stdout
        self.assertIn("1. Ask the user whether to merge PR 512", out)
        self.assertIn("Never merge on Fridays.", out)
        self.assertIn("Items and branches touched: PR 512", out)
        self.assertIn(": Did the thing.", out)  # the run's result, not its task text
        self.assertTrue(os.path.exists(os.path.join(self.env["LEAN_AGENT_HOME"], "handoff.md")))
        self.cli("handoff", "--done", "all")
        self.assertNotIn("Open items", self.cli("handoff").stdout)

    def test_handoff_rules_deduped_and_ranked(self):
        self.cli("learn", self.proj, "--name", "proj")
        self.cli("memory", "add", "A passive build is defined by two independent things: the flag and the env.",
                 "--type", "feedback", "--name", "passive-build")
        self.cli("memory", "add", "A passive build is defined by TWO independent things: the flag and the env!",
                 "--type", "feedback", "--name", "passive-build-2")
        for i in range(6):
            self.cli("memory", "add", f"Old unrelated rule number {i} about widgets{i}.", "--type", "feedback",
                     "--name", f"old-{i}")
        self.cli("memory", "add", "Keep pull requests as draft until the user approves them.", "--type", "feedback",
                 "--name", "draft-prs")
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "sync memory")  # makes the mem-* cards
        self.cli("card", "protect", "proj", "mem-feedback-draft-prs")
        out = self.cli("handoff").stdout
        rules = out.split("Standing rules (memory):")[1].split("Recent runs:")[0]
        self.assertEqual(rules.count("passive build"), 1)
        self.assertTrue(rules.strip().splitlines()[0].strip().startswith("- Keep pull requests as draft"))
        self.assertLessEqual(len([l for l in rules.splitlines() if l.strip().startswith("- ")]), 10)

    def test_version_and_small_messages(self):
        out = self.cli("--version").stdout
        self.assertRegex(out, r"^lean-agent \d+\.\d+\.\d+")
        p = self.cli("output", "optimize", check=False)
        self.assertIn("brief mode is off in this session", p.stderr)
        self.cli("learn", self.proj, "--name", "proj")
        p = self.cli("run", "-p", "proj", "--escalate", "haiku,sonnet", "--why", "x", "look up totals")
        self.assertIn("escalate: haiku -> sonnet (the next model only if a run fails)", p.stdout)

    def test_review_decide_gaps_by_a_worker(self):
        self.git_project()
        self.cli("learn", self.proj, "--name", "proj")
        gaps = [{"what": "Other browser: not done yet", "file": "docs/DISTRIBUTION.md", "line": 5, "blocks_goal": False,
                 "scoped_out": "ask the user"},
                {"what": "Policy URL is a placeholder", "file": "docs/DISTRIBUTION.md", "line": 7, "blocks_goal": False,
                 "scoped_out": ""},
                {"what": "Retry the upload once", "file": "api/totals.py", "line": 3, "blocks_goal": False, "scoped_out": ""},
                {"what": "Which store listing name to use", "file": "docs/DISTRIBUTION.md", "line": 9,
                 "blocks_goal": False, "scoped_out": "ask the user"}]
        approve = json.dumps(dict(REUSE_CHECKED, verdict="approve", findings=[], checks=[], gaps=gaps))
        self.assertEqual(self.cli("review", "proj", check=False, FAKE_REVIEW=approve).returncode, 2)
        decisions = {"decisions": [
            {"gap": "g1", "action": "decline", "why": "out of scope: the other browser is a separate task"},
            {"gap": "g2", "action": "decline", "why": "the hosting card says the URL is set at release"},
            {"gap": "g3", "action": "fix", "task": "Retry the upload once in api/totals.py"},
            {"gap": "g4", "action": "ask", "question": "Which name should the store listing use?",
             "options": ["Shop", "Shop Assistant", "Shop for Chrome"]}]}
        fb = '{"status": "done", "used": [], "unneeded": [], "missing": ""}\nLEAN-GAPS ' + json.dumps(decisions)
        p = self.cli("review", "proj", "--decide-gaps", check=False, FAKE_FEEDBACK=fb)
        call = self.calls()[-1]
        self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
        self.assertIn("sonnet", call["argv"][call["argv"].index("--model") + 1])
        self.assertIn("g1 docs/DISTRIBUTION.md:5: Other browser: not done yet", call["append"])
        self.assertIn("g4 docs/DISTRIBUTION.md:9: Which store listing name", call["append"])
        self.assertIn("2 declined", p.stdout)
        self.assertIn("1 fix tasks, 1 need you", p.stdout)
        self.assertIn("fix g3: Retry the upload once in api/totals.py", p.stdout)
        self.assertIn("needs you g4: Which name should the store listing use?", p.stdout)
        self.assertIn("3) Shop for Chrome", p.stdout)
        self.assertNotIn("g1:", p.stdout.split("needs you")[1])
        st = self.cli("review", "proj", "--status", check=False).stdout
        self.assertIn("2 known gap(s) not acknowledged", st)  # g1 and g2 were recorded as declined
        self.assertNotIn("Other browser", st)
        with open(os.path.join(self.env["LEAN_AGENT_HOME"], "reviews", "proj.declined.jsonl")) as fh:
            why = [json.loads(l)["why"] for l in fh]
        self.assertEqual(why, ["out of scope: the other browser is a separate task",
                               "the hosting card says the URL is set at release"])
        # nothing left to ask: exit 0
        rest = {"decisions": [{"gap": "g3", "action": "decline", "why": "not worth it"},
                              {"gap": "g4", "action": "decline", "why": "the user picked Shop"}]}
        fb = '{"status": "done", "used": [], "unneeded": [], "missing": ""}\nLEAN-GAPS ' + json.dumps(rest)
        p = self.cli("review", "proj", "--decide-gaps", check=False, FAKE_FEEDBACK=fb)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("2 declined", p.stdout)
        self.assertIn("0 fix tasks, 0 need you", p.stdout)
        self.assertEqual(self.cli("review", "proj", "--status").returncode, 0)
        p = self.cli("review", "proj", "--decide-gaps", check=False)
        self.assertIn("no open known gaps", p.stdout)
        self.assertEqual(p.returncode, 0)

    def test_review_decide_gaps_edge_cases(self):
        self.git_project()
        self.cli("learn", self.proj, "--name", "proj")
        gaps = [{"what": "A thing", "file": "a.py", "line": 1, "blocks_goal": False, "scoped_out": ""},
                {"what": "B thing", "file": "b.py", "line": 2, "blocks_goal": False, "scoped_out": ""},
                {"what": "C thing", "file": "c.py", "line": 3, "blocks_goal": False, "scoped_out": ""}]
        approve = json.dumps(dict(REUSE_CHECKED, verdict="approve", findings=[], checks=[], gaps=gaps))
        self.assertEqual(self.cli("review", "proj", check=False, FAKE_REVIEW=approve).returncode, 2)
        head = "\nLEAN-GAPS "
        ok = '{"status": "done", "used": [], "unneeded": [], "missing": ""}'
        # empty and invalid LEAN-GAPS: exit 1 with the run to look at, nothing applied
        for fb in (ok + head + '{"decisions": []}', ok + head + "not json", ok):
            p = self.cli("review", "proj", "--decide-gaps", check=False, FAKE_FEEDBACK=fb)
            self.assertEqual(p.returncode, 1, p.stdout + p.stderr)
            self.assertIn("the worker gave no gap decisions", p.stdout)
            self.assertIn("lean-agent runs --show ", p.stdout)
        self.assertFalse(os.path.exists(os.path.join(self.env["LEAN_AGENT_HOME"], "reviews", "proj.declined.jsonl")))
        # a decline without a reason, a gap the worker omitted, and a question with fewer than 2 options all need the user
        decisions = {"decisions": [{"gap": "g1", "action": "decline", "why": "  "},
                                   {"gap": "g3", "action": "ask", "question": "Keep C?", "options": ["only one"]}]}
        p = self.cli("review", "proj", "--decide-gaps", check=False, FAKE_FEEDBACK=ok + head + json.dumps(decisions))
        self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
        self.assertIn("0 declined, 0 fix tasks, 3 need you", p.stdout)
        self.assertIn("needs you g1: a.py: A thing - what should happen?", p.stdout)
        self.assertIn("needs you g2: b.py: B thing - what should happen?", p.stdout)
        self.assertIn("needs you g3: Keep C?", p.stdout)
        self.assertEqual(p.stdout.count("1) Out of scope: decline it"), 3)
        self.assertEqual(p.stdout.count("2) Fix it in this change"), 3)
        self.assertNotIn("only one", p.stdout)
        # --head picks the review of that branch
        p = self.cli("review", "proj", "--decide-gaps", "--head", "nowhere", check=False)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("no review of nowhere yet", p.stderr)
        p = self.cli("review", "proj", "--decide-gaps", "--head", "feature", check=False, FAKE_FEEDBACK=ok + head + '{"decisions": []}')
        self.assertNotIn("no review of", p.stderr)
        self.assertIn("the worker gave no gap decisions", p.stdout)
        sys.path.insert(0, os.path.dirname(CLI))
        import lean_agent as L
        os.environ["LEAN_AGENT_HOME"] = self.env["LEAN_AGENT_HOME"]
        try:
            self.assertEqual(L.latest_review("proj", self.proj, None)["verdict"], "approve")
            self.assertIsNone(L.latest_review("proj", self.proj, "nowhere"))
            self.assertEqual(L.latest_review("proj", self.proj, "feature")["verdict"], "approve")
        finally:
            del os.environ["LEAN_AGENT_HOME"]

    def test_review_catches_self_declared_gaps(self):
        self.git_project()
        self.cli("learn", self.proj, "--name", "proj")
        os.makedirs(os.path.join(self.proj, "docs"), exist_ok=True)
        with open(os.path.join(self.proj, "docs", "DISTRIBUTION.md"), "w") as fh:
            fh.write("# Passive install\n\nChrome: done.\n\nOther browser: not done yet, so it cannot be shipped today.\n"
                     "Not yet wired: the package is not built or published by the release pipeline.\n"
                     "Until one is, the policy above installs nothing. Policy URL: https://<your-host>/ext.xpi\n")
        with open(os.path.join(self.proj, "api", "totals.py"), "a") as fh:
            fh.write("def passive_policy():\n    return {'mode': 'passive'}\n")
        checked = dict(REUSE_CHECKED, reuse=REUSE_CHECKED["reuse"] + [
            {"symbol": s_, "candidates": [], "verdict": "justified-new", "why": "nothing like it in the repository yet"}
            for s_ in ("docs/DISTRIBUTION.md", "passive_policy")])
        approve = json.dumps(dict(checked, verdict="approve", findings=[], checks=[]))
        p = self.cli("review", "proj", "--goal", "Passive build for both browsers", check=False, FAKE_REVIEW=approve)
        call = next(c for c in self.calls() if "0. Completeness" in c["append"])
        self.assertIn("Self-declared gaps", call["append"])
        self.assertIn("docs/DISTRIBUTION.md:5: Other browser: not done yet", call["append"])
        self.assertIn("docs/DISTRIBUTION.md:7: Until one is, the policy above installs nothing.", call["append"])
        self.assertIn("The change's stated goal (task, work item or PR title): Passive build for both browsers", call["task"])
        self.assertEqual(p.returncode, 2, p.stdout)
        self.assertIn("known gaps: ", p.stdout)
        self.assertIn("[not checked by the reviewer]", p.stdout)
        self.assertIn("Approved, but with", p.stdout)
        self.assertRegex(p.stdout.rstrip().splitlines()[-1], r"^approved: \d+ known gap\(s\) wait for your decision \(exit 2 until")
        st = self.cli("review", "proj", "--status", check=False)
        self.assertEqual(st.returncode, 2)
        self.assertIn("known gap(s) not acknowledged", st.stdout)
        self.cli("review", "decline", "proj", "--all-gaps", "--why", "out of scope: hosting is a separate task")
        self.assertEqual(self.cli("review", "proj", "--status").returncode, 0)
        # a new tip: a helper named after placeholders, a reworded gap and a nit don't bring the decided gaps back
        with open(os.path.join(self.proj, "api", "totals.py"), "a") as fh:
            fh.write("def fill_placeholders(t):\n    # replaces the placeholder in the template\n    return t\n")
        checked["reuse"].append({"symbol": "fill_placeholders", "candidates": [], "verdict": "justified-new",
                                 "why": "nothing fills templates in the repository yet"})
        reworded = json.dumps(dict(checked, verdict="approve", checks=[],
                                   findings=[{"severity": "nit", "category": "tests", "file": "api/totals.py", "line": 7,
                                              "issue": "no spec covers the literal replacement"}],
                                   gaps=[{"what": "the other browser: not done yet, it cannot be shipped today",
                                          "file": "docs/DISTRIBUTION.md", "line": 5, "blocks_goal": False,
                                          "scoped_out": "ask the user"},
                                         {"what": "no spec covers the literal replacement", "file": "api/totals.py",
                                          "line": 7, "blocks_goal": False, "scoped_out": ""}]))
        p = self.cli("review", "proj", check=False, FAKE_REVIEW=reworded)
        self.assertNotIn("known gaps:", p.stdout)
        self.assertIn("1. [nit/tests]", p.stdout)  # still a finding, not a gap
        self.assertEqual(self.cli("review", "proj", "--status").returncode, 0)
        # a gap the reviewer says keeps the goal from working, not scoped out: a major finding
        with open(os.path.join(self.proj, "docs", "DISTRIBUTION.md"), "a") as fh:
            fh.write("The update URL is a placeholder for now.\n")
        blocking = json.dumps(dict(checked, verdict="approve", findings=[], checks=[],
                                   goal="passive build for both browsers",
                                   gaps=[{"what": "the second browser's package is never hosted", "file": "docs/DISTRIBUTION.md",
                                          "line": 9, "blocks_goal": True, "scoped_out": ""}]))
        p = self.cli("review", "proj", check=False, FAKE_REVIEW=blocking)
        self.assertEqual(p.returncode, 2)
        self.assertIn("[major/completeness] docs/DISTRIBUTION.md:9: the change doesn't deliver: the second browser's package", p.stdout)
        self.assertIn("NOT approved", p.stdout)

    def test_feedback_v021_small_things(self):
        self.cli("learn", self.proj, "--name", "proj")
        # read-only workers and CLIs
        p = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--read-only", "--again",
                     "read the failed run with az pipelines runs show --id 7")
        self.assertIn("names `az`", p.stderr)
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--read-only", "--again",
                 "--allow-cmd", "az pipelines runs show", "read the failed run 7")
        call = self.calls()[-1]
        argv = call["argv"]
        self.assertIn("Bash(az pipelines runs show:*)", argv[argv.index("--allowedTools") + 1])
        self.assertIn("`az pipelines runs show ...`", call["append"])
        p = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--read-only", "--again",
                     "--allow-cmd", "az pipelines runs delete", "x", check=False)
        self.assertIn("delete changes something", p.stderr)
        # grep-log on a CI log saved as JSON
        log = os.path.join(self.tmp.name, "log.json")
        with open(log, "w") as fh:
            json.dump({"count": 4, "value": ["##[section]Starting", "PASS a.spec.ts", "FAIL infra.spec.ts",
                                             "ENOENT: no such file, open 'infrastructure/main.bicep'"]}, fh)
        out = self.cli("grep-log", log, "-C", "0").stdout
        self.assertIn("3> FAIL infra.spec.ts", out)
        self.assertIn("ENOENT", out)
        self.assertNotIn("PASS a.spec.ts", out)
        # schedule ... --help prints help and adds nothing
        self.assertIn("usage: lean-agent schedule", self.cli("schedule", "defaults", "--help").stdout)
        self.assertIn("No scheduled jobs", self.cli("schedule").stdout)

    def test_review_ci_sparse_checkout_parity(self):
        g = self.git_project()
        os.makedirs(os.path.join(self.proj, "infrastructure"))
        with open(os.path.join(self.proj, "infrastructure", "main.bicep"), "w") as fh:
            fh.write("param x string\n")
        with open(os.path.join(self.proj, "azure-pipelines.yml"), "w") as fh:
            fh.write("steps:\n- checkout: self\n  sparseCheckoutDirectories: api web\n")
        g("add", "-A")
        g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "pipeline")
        os.makedirs(os.path.join(self.proj, "api", "tests"))
        with open(os.path.join(self.proj, "api", "tests", "test_infra.py"), "w") as fh:
            fh.write("def test_bicep():\n    assert open('../infrastructure/main.bicep').read()\n"
                     "def test_api():\n    assert open('api/totals.py')\n")
        g("add", "-A")
        g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "infra test")
        self.cli("learn", self.proj, "--name", "proj")
        approve = json.dumps(dict(REUSE_CHECKED, verdict="approve", findings=[], checks=[]))
        p = self.cli("review", "proj", "--head", "feature", "--base", "main", check=False, FAKE_REVIEW=approve)
        call = next(c for c in self.calls() if "0. Completeness" in c["append"])
        self.assertIn("CI parity", call["append"])
        self.assertIn("reads `../infrastructure/main.bicep`, outside the sparse checkout of azure-pipelines.yml (api web)",
                      call["append"])
        self.assertNotIn("`api/totals.py`", call["append"])
        self.assertIn("[check] CI parity: api/tests/test_infra.py", p.stdout)

    def test_review_resume_follows_the_branch(self):
        g = self.git_project()
        g("add", "-A")
        g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "page")
        g("checkout", "-q", "main")
        self.cli("learn", self.proj, "--name", "proj")
        approve = json.dumps(dict(REUSE_CHECKED, verdict="approve", findings=[], checks=[]))
        self.cli("review", "proj", "--head", "feature", "--base", "main", check=False, FAKE_REVIEW=approve)
        g("checkout", "-q", "feature")  # a worker commits a fix on the PR branch
        with open(os.path.join(self.proj, "api", "fix.py"), "w") as fh:
            fh.write("X = 1\n")
        g("add", "-A")
        g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "fix")
        new = subprocess.run(["git", "-C", self.proj, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        g("checkout", "-q", "main")
        for head in ("feature", new):  # the branch, or the new commit itself
            p = self.cli("review", "proj", "--resume", "--head", head, check=False, FAKE_REVIEW=approve)
            self.assertNotIn("no earlier review", p.stderr)
            self.assertIn(f"@ {new[:12]}", p.stdout)
        self.assertEqual(self.cli("review", "proj", "--help").returncode, 0)

    def test_feedback_v028(self):
        # doc write: documents go to document folders only
        target = os.path.join(self.tmp.name, "Downloads", "notes.md")
        os.makedirs(os.path.dirname(target))
        r = self.cli("doc", "write", target, "--text", "# Notes\nline two")
        self.assertIn("wrote 2 lines", r.stdout)
        self.assertEqual(open(target).read(), "# Notes\nline two\n")
        bad = self.cli("doc", "write", "/usr/lean-agent-test.md", "--text", "x", check=False)
        self.assertEqual(bad.returncode, 1)
        self.assertIn("only writes under", bad.stderr)

    def test_review_fix_loop_is_incremental(self):
        g = self.git_project()
        g("add", "-A")
        g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "page")
        g("checkout", "-q", "main")
        self.cli("learn", self.proj, "--name", "proj")
        model = lambda c: c["argv"][c["argv"].index("--model") + 1]
        sha = lambda: subprocess.run(["git", "-C", self.proj, "rev-parse", "feature"], capture_output=True,
                                     text=True).stdout.strip()

        def commit(rel, text, amend=False):
            g("checkout", "-q", "feature")
            os.makedirs(os.path.dirname(os.path.join(self.proj, rel)), exist_ok=True)
            with open(os.path.join(self.proj, rel), "a") as fh:
                fh.write(text)
            g("add", "-A")
            g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", *(["--amend", "--no-edit"] if amend else ["-m", "fix"]))
            g("checkout", "-q", "main")
        minor = json.dumps(dict(REUSE_CHECKED, verdict="approve", checks=[], findings=[
            {"severity": "minor", "category": "style", "file": "api/totals.py", "line": 1, "issue": "rename total_sum"}]))
        approve = json.dumps(dict(REUSE_CHECKED, verdict="approve", findings=[], checks=[]))
        # 1. the whole change, once (opus, as the user chose)
        self.cli("review", "proj", "--head", "feature", "--base", "main", "--reviewer-model", "opus", check=False,
                 FAKE_REVIEW=minor)
        first = sha()
        self.assertIn("declined 1.", self.cli("review", "decline", "proj", "1", "--head", first, "--why", "left on purpose").stdout)
        # 2. a fix worker commits elsewhere: review by commit sha finds the branch and reviews only the delta, on sonnet
        commit("CLAUDE.md", "One more rule.\n")
        out = self.cli("review", "proj", "--head", sha(), check=False, FAKE_REVIEW=minor).stdout
        self.assertIn("reviewing only what changed since", out)
        delta = [c for c in self.calls() if "Re-review after fixes" in c["task"]][-1]
        self.assertEqual(model(delta), "sonnet")
        self.assertIn("declined: [style] api/totals.py: rename total_sum", delta["task"])
        self.assertIn("left out 1 finding(s) declined earlier", out)  # the decision followed the branch
        self.assertEqual(self.cli("review", "proj", "--status", "--head", "feature").returncode, 0)
        # 3. an amend: the old tip is gone from the history but in the branch's reflog
        commit("CLAUDE.md", "And another.\n", amend=True)
        self.assertIn("reviewing only what changed since", self.cli("review", "proj", "--head", "feature", check=False,
                                                                     FAKE_REVIEW=approve).stdout)
        # 4. a large delta gets a full review; --for-push refuses while a fix worker runs on the branch
        commit("api/big.py", "x = 1\n" * 900)
        st = self.cli("review", "proj", "--status", "--head", "feature", check=False).stdout
        self.assertIn("lines changed since", st)
        out = self.cli("review", "proj", "--head", "feature", "--base", "main", check=False, FAKE_REVIEW=approve).stdout
        self.assertIn("a full review", out)
        os.makedirs(os.path.join(self.env["LEAN_AGENT_HOME"], "running"), exist_ok=True)
        json.dump({"pid": os.getpid(), "run": "fix1", "project": "proj", "branch": "feature", "role": None},
                  open(os.path.join(self.env["LEAN_AGENT_HOME"], "running", "fix1.json"), "w"))
        r = self.cli("review", "proj", "--head", "feature", "--for-push", check=False, FAKE_REVIEW=approve)
        self.assertEqual(r.returncode, 3)
        self.assertIn("still running on feature (fix1): review once, after all of them", r.stderr)

    def test_review_a_ref_without_checkout(self):
        g = self.git_project()
        g("add", "-A")
        g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "page")
        g("checkout", "-q", "main")  # the user works on main; the PR branch isn't checked out
        self.cli("learn", self.proj, "--name", "proj")
        approve = json.dumps(dict(REUSE_CHECKED, verdict="approve", findings=[], checks=[]))
        p = self.cli("review", "proj", "--head", "feature", "--base", "main", check=False, FAKE_REVIEW=approve)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        call = self.calls()[-1]
        self.assertIn("NOT checked out", call["append"])
        self.assertIn("git -C " + self.proj + " show ", call["append"])
        self.assertIn("commits on feature", call["append"])
        self.assertIn("api/totals.py", call["task"])
        self.assertIn("web/page.txt", call["task"])
        self.assertEqual(subprocess.run(["git", "-C", self.proj, "rev-parse", "--abbrev-ref", "HEAD"],
                                        capture_output=True, text=True).stdout.strip(), "main")  # untouched
        self.assertEqual(self.cli("review", "proj", "--status", "--head", "feature").returncode, 0)
        p = self.cli("review", "proj", "--status", check=False)  # the working tree (main) wasn't reviewed
        self.assertEqual(p.returncode, 1)
        self.assertIn("--status --head feature", p.stdout)
        g("checkout", "-q", "feature")
        with open(os.path.join(self.proj, "api", "totals.py"), "a") as fh:
            fh.write("# fix\n")
        g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "fix")
        g("checkout", "-q", "main")
        p = self.cli("review", "proj", "--status", "--head", "feature", check=False)
        self.assertEqual(p.returncode, 1)
        self.assertIn("feature was reviewed at", p.stdout)  # points at the cheap way: a delta review
        self.assertIn("lines changed since. Review just that: lean-agent review proj --head feature", p.stdout)
        out = self.cli("review", "proj", "--resume", "--head", "feature", FAKE_REVIEW=approve).stdout
        self.assertIn("re-review of feature @ ", out)
        self.assertIn("recorded for feature @ ", out)
        self.assertIn("fresh re-review of what changed since", out)
        call = self.calls()[-1]
        self.assertNotIn("--resume", call["argv"])  # a fresh, small context instead of the whole old session
        self.assertIn("since the last review", call["append"])
        self.assertIn("Re-review after fixes", call["task"])
        self.assertEqual(self.cli("review", "proj", "--status", "--head", "feature").returncode, 0)
        p = self.cli("review", "proj", "--resume", "--head", "other", check=False)
        self.assertIn("no earlier review of other", p.stderr)

        def commit_fix(text):
            g("checkout", "-q", "feature")
            with open(os.path.join(self.proj, "api", "totals.py"), "a") as fh:
                fh.write(text)
            g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "fix")
            g("checkout", "-q", "main")
        # resuming the reviewer with plain `run --resume` also records the review for the branch's new tip
        commit_fix("# fix 2\n")
        reviewer = [r for r in self.ledger() if r.get("role") == "reviewer"][-1]["id"]
        self.cli("run", "--resume", reviewer, "re-check", FAKE_REVIEW=approve)
        self.assertEqual(self.cli("review", "proj", "--status", "--head", "feature").returncode, 0)
        # a fresh review of the same branch gets the earlier findings
        commit_fix("# fix 3\n")
        bad = json.dumps(dict(REUSE_CHECKED, verdict="changes-requested", checks=[], findings=[
            {"severity": "major", "file": "api/totals.py", "line": 3, "issue": "rounding drops cents"}]))
        self.cli("review", "proj", "--head", "feature", "--base", "main", check=False, FAKE_REVIEW=bad)
        commit_fix("# fix 4\n")
        out = self.cli("review", "proj", "--head", "feature", "--base", "main", "--full-review", FAKE_REVIEW=approve).stdout
        self.assertIn("passing 1 earlier findings", out)
        self.assertIn("[major] api/totals.py:3 rounding drops cents", self.calls()[-1]["task"])

    def test_review_reuse_pass(self):
        def g(*args):
            subprocess.run(["git", "-C", self.proj, "-c", "user.name=t", "-c", "user.email=t@t", *args],
                           check=True, capture_output=True)

        def write(rel, text):
            os.makedirs(os.path.dirname(os.path.join(self.proj, rel)), exist_ok=True)
            with open(os.path.join(self.proj, rel), "w") as fh:
                fh.write(text)
        write("src/init/surfaces.ts", "let n = 0\nexport function registerSurface() { n++ }\n"
                                      "export const useSurfaceCount = () => n\n")
        g("init", "-q", "-b", "main")
        g("add", "-A")
        g("commit", "-qm", "base")
        g("checkout", "-qb", "feature")
        write("src/dialogs/overlayStore.ts", "let count = 0\nexport function createOverlayStore() { count++ }\n"
                                             "export const useOverlayOpen = () => count > 0\n")
        write("src/dialogs/overlayStore.test.ts", "export function helperInTest() {}\n")
        g("add", "-A")
        g("commit", "-qm", "store")
        g("checkout", "-q", "main")
        self.cli("learn", self.proj, "--name", "proj")
        reuse = json.dumps({"verdict": "needs-checks", "searches": [{"for": "counter", "found": "src/init/surfaces.ts:2"}],
                            "reuse": [{"symbol": "createOverlayStore", "candidates": ["src/init/surfaces.ts:2 registerSurface"],
                                       "verdict": "duplicate", "why": "same ref counter"}],
                            "siblings": [{"checked": "other dialogs", "needs_fix": True}], "findings": [], "checks": []})
        main_review = json.dumps({"verdict": "approve", "searches": [{"for": "createOverlayStore", "found": "nothing"}],
                                  "reuse": [{"symbol": "createOverlayStore", "candidates": ["src/init/surfaces.ts:2"],
                                             "verdict": "duplicate"}],
                                  "findings": [{"severity": "major", "category": "duplication", "file": "src/dialogs/overlayStore.ts",
                                                "line": 2, "issue": "near-copy of registerSurface"},
                                               {"severity": "nit", "category": "tests", "file": "x.test.ts", "line": 1,
                                                "issue": "test name"}], "checks": []})
        p = self.cli("review", "proj", "--head", "feature", "--base", "main", "--second-opinion", "on", check=False,
                     FAKE_REUSE=reuse, FAKE_REVIEW=main_review)
        out = p.stdout
        self.assertEqual(p.returncode, 2, out)
        self.assertIn("1 new files, 2 new symbols for the reuse pass", out)  # test files don't count
        calls = self.calls()
        second = next(c for c in calls if "search-only second opinion" in c["append"])
        main = next(c for c in calls if "Reuse and duplication. For every new file" in c["append"])
        follow = calls[-1]  # sent back once, same session, to finish the reuse pass
        self.assertIn("Your review isn't complete", follow["task"])
        self.assertIn("useOverlayOpen", follow["task"])
        self.assertIn("--resume", follow["argv"])
        self.assertIn("sending the reviewer back once", out)
        self.assertEqual(second["argv"][second["argv"].index("--model") + 1], "haiku")
        self.assertIn("Reuse and duplication. For every new file", main["append"])
        self.assertIn("- createOverlayStore (src/dialogs/overlayStore.ts)", main["append"])
        self.assertIn("- useOverlayOpen (src/dialogs/overlayStore.ts)", main["append"])
        self.assertNotIn("helperInTest", main["append"])
        self.assertIn("src/init/surfaces.ts:2 registerSurface (suggests duplicate", main["task"])
        self.assertIn("sibling that may share the problem: other dialogs", main["task"])
        self.assertIn("REVIEW: CHANGES-REQUESTED", out)
        self.assertIn("reuse not checked for", out)
        self.assertIn("changed the verdict from approve to changes-requested", out)
        self.assertIn("createOverlayStore -> src/init/surfaces.ts:2 -> duplicate", out)
        self.assertLess(out.index("[major/duplication]"), out.index("[nit/tests]"))
        self.assertNotEqual(self.cli("review", "proj", "--status", "--head", "feature", check=False).returncode, 0)
        self.assertIn("reuse: 2 of 3 new symbols checked · 1 searches", out)
        self.assertEqual(out.count("duplicates existing code"), 0)  # the reviewer's own finding covers it
        # a finding discussed and declined isn't raised again for this branch
        scope = json.dumps(dict(json.loads(main_review), findings=[
            {"severity": "major", "category": "scope", "file": "src/dialogs/overlayStore.ts", "line": 1,
             "issue": "only the warning dialog is handled; other dialogs share the cause"}],
            reuse=[{"symbol": s, "candidates": ["src/init/surfaces.ts:2"], "verdict": "wraps-existing"}
                   for s in ("createOverlayStore", "useOverlayOpen", "src/dialogs/overlayStore.ts")]))
        out = self.cli("review", "proj", "--head", "feature", "--base", "main", "--second-opinion", "off", check=False,
                       FAKE_REVIEW=scope).stdout
        self.assertIn("1. [major/scope] src/dialogs/overlayStore.ts:1", out)
        self.assertNotIn("duplicates existing code", out)  # wraps-existing is reuse done right
        self.assertIn("declined 1. [major/scope]", self.cli("review", "decline", "proj", "1", "--head", "feature",
                                                             "--why", "other dialogs: separate ticket").stdout)
        out = self.cli("review", "proj", "--head", "feature", "--base", "main", "--second-opinion", "on", check=False,
                       FAKE_REUSE=reuse, FAKE_REVIEW=scope).stdout
        self.assertIn("left out 1 finding(s) declined earlier", out)
        self.assertIn("REVIEW: APPROVE", out)
        calls = self.calls()
        self.assertIn("declined: [scope] src/dialogs/overlayStore.ts", calls[-1]["task"])
        self.assertIn("other dialogs: separate ticket", calls[-2]["append"])  # the second opinion knows too
        # justified-new is not accepted when the second opinion found existing code for it
        weak = json.dumps(dict(json.loads(main_review), findings=[], reuse=[
            {"symbol": "createOverlayStore", "candidates": [], "verdict": "justified-new", "why": "different"},
            {"symbol": "useOverlayOpen", "candidates": [], "verdict": "justified-new", "why": "n/a"}]))
        out = self.cli("review", "proj", "--head", "feature", "--base", "main", "--second-opinion", "on", check=False,
                       FAKE_REUSE=reuse, FAKE_REVIEW=weak).stdout
        self.assertIn("justified-new verdict(s) not accepted", out)
        self.assertIn("createOverlayStore: the second opinion says duplicate src/init/surfaces.ts:2", out)
        self.assertNotIn("REVIEW: APPROVE", out)
        # after fixes, --resume runs the passes again on what changed
        g("checkout", "-q", "feature")
        write("src/dialogs/overlayStore.ts", "export function deferOverlay() {}\n")
        g("commit", "-qam", "fix")
        g("checkout", "-q", "main")
        self.cli("review", "proj", "--resume", "--head", "feature", check=False, FAKE_REVIEW=main_review)
        rr = next(c for c in reversed(self.calls()) if "Re-review after fixes" in c["task"])
        self.assertIn("The earlier review's open items", rr["task"])
        self.assertIn("declined: [scope] src/dialogs/overlayStore.ts", rr["task"])
        self.assertIn("the code it points at changed since", rr["task"])  # the fix rewrote that line
        self.assertIn("deferOverlay (src/dialogs/overlayStore.ts)", rr["append"])
        self.assertIn("deferOverlay", self.calls()[-1]["task"])  # then sent back once for its reuse entry

    def test_review_learn_builds_checklist_cards(self):
        self.git_project()
        self.cli("learn", self.proj, "--name", "proj")
        out = self.cli("review", "learn", "proj", "--text", "Before adding overlay state, check the shared surface counter",
                       "--helper", "registerSurface | src/init/surfaces.ts | ref-counted shown-surface counter").stdout
        self.assertIn("2 lesson(s) added", out)
        self.assertIn("Nothing new", self.cli("review", "learn", "proj", "--text",
                                              "Before adding overlay state, check the shared surface counter").stdout)
        approve = json.dumps(dict(REUSE_CHECKED, verdict="approve", findings=[], checks=[]))
        self.cli("review", "proj", "--second-opinion", "off", FAKE_REVIEW=approve)
        append = self.calls()[-1]["append"]
        self.assertIn("Review checklist (lessons from human reviews)", append)
        self.assertIn("check the shared surface counter", append)
        self.assertIn("registerSurface (src/init/surfaces.ts): ref-counted shown-surface counter", append)
        # from a PR's threads, through the tracker's MCP server
        with open(os.path.join(self.proj, ".mcp.json"), "w") as fh:
            json.dump({"mcpServers": {"tracker": {"command": "true"}}}, fh)
        os.makedirs(os.path.join(self.proj, "src", "hooks"))
        with open(os.path.join(self.proj, "src", "hooks", "overlay.ts"), "w") as fh:
            fh.write("export function useOverlayDeferral() {}\n")
        lesson = json.dumps({
            "checklist": ["Fixes for one dialog type: check the sibling dialogs too",
                          "Before adding overlay state check the shared surface counter",  # near-duplicate
                          "useThing lives somewhere (exact file not confirmed)"],
            "helpers": [{"name": "useOverlayDeferral", "where": "src/hooks/overlay.ts", "what": "hides and restores"},
                        {"name": "ghostHelper", "where": "content/utils/ghost.ts", "what": "not in the code"}],
            "replace": [{"old": "Before adding overlay state, check the shared surface counter",
                         "new": "Before adding overlay or counter state, check the shared surface counter"}],
            "declined": [{"file": "src/frame.ts", "category": "scope", "issue": "iframe case not handled",
                          "why": "left out on purpose; noted in the PR"}]})
        fb = "\nLEAN-CHECKLIST " + lesson
        subprocess.run(["git", "-C", self.proj, "remote", "add", "origin",
                        "https://acme@dev.azure.com/acme/Shop/_git/web-app"], check=True)
        p = self.cli("review", "learn", "proj", "42", "--mcp", "tracker", check=False,
                     FAKE_FEEDBACK='{"status": "done", "used": [], "unneeded": [], "missing": ""}' + fb)
        append = self.calls()[-1]["append"]
        self.assertIn("pull request 42", append)
        self.assertIn("host Azure DevOps, org acme, project Shop, repo web-app", append)
        self.assertIn("never use lean-agent's project name `proj` as a tracker project", append)
        self.assertIn("review-checklist: - Fixes for one dialog type", p.stdout + p.stderr)
        out = p.stdout
        helpers = self.cli("card", "show", "proj", "shared-helpers").stdout
        self.assertIn("useOverlayDeferral (src/hooks/overlay.ts)", helpers)
        self.assertNotIn("ghostHelper", helpers)
        self.assertIn("left out helper ghostHelper: content/utils/ghost.ts isn't in the code", out)
        checklist = self.cli("card", "show", "proj", "review-checklist").stdout
        self.assertNotIn("not confirmed", checklist)
        self.assertIn("Before adding overlay or counter state", checklist)  # corrected, not duplicated
        self.assertEqual(checklist.count("shared surface counter"), 1)
        self.assertIn("declined (from the PR): src/frame.ts: iframe case not handled", out)
        self.assertIn("The project's review cards already say this", self.calls()[-1]["append"])
        # helpers that live only on another branch (e.g. a release branch), written with partial paths
        g = lambda *a_: subprocess.run(["git", "-C", self.proj, "-c", "user.name=t", "-c", "user.email=t@t", *a_],
                                       check=True, capture_output=True)
        g("checkout", "-qb", "release")
        os.makedirs(os.path.join(self.proj, "pkg", "src", "common", "detection"), exist_ok=True)
        with open(os.path.join(self.proj, "pkg", "src", "common", "detection", "visible.ts"), "w") as fh:
            fh.write("export function hasRenderedBox() {}\n")
        g("add", "pkg")
        g("commit", "-qm", "release helper")
        g("checkout", "-q", "main")
        self.cli("review", "learn", "proj", "--helper", "hasRenderedBox | `src/common/detection/visible.ts:12` | box check",
                 "--helper", "subscribeShown | somewhere/else.ts | a counter")
        os.makedirs(os.path.join(self.proj, "pkg"), exist_ok=True)
        with open(os.path.join(self.proj, "pkg", "notes.ts"), "w") as fh:
            fh.write("export const subscribeShown = 1\n")  # the symbol exists, the path given is wrong
        g("add", "pkg/notes.ts")
        g("commit", "-qm", "notes")
        out = self.cli("review", "learn", "proj", "--verify", "--head", "release").stdout
        self.assertIn("checking against: release, HEAD", out)
        self.assertNotIn("hasRenderedBox", out)  # found on release via the partial path
        self.assertNotIn("subscribeShown", out)  # found by its symbol
        self.assertIn("would remove from shared-helpers: - registerSurface (src/init/surfaces.ts)", out)
        self.assertIn("because path src/init/surfaces.ts and symbol registerSurface not found on release, HEAD", out)
        self.assertIn("registerSurface", self.cli("card", "show", "proj", "shared-helpers").stdout)  # dry run
        out = self.cli("review", "learn", "proj", "--verify", "--apply", "--head", "release").stdout
        self.assertIn("removed from shared-helpers: - registerSurface", out)
        helpers = self.cli("card", "show", "proj", "shared-helpers").stdout
        self.assertNotIn("registerSurface", helpers)
        self.assertIn("useOverlayDeferral", helpers)
        self.assertIn("hasRenderedBox", helpers)
        # when the remote doesn't name the tracker project: set it once, every MCP worker gets it
        self.assertIn("tracker", self.cli("review", "learn", "proj", "--tracker", "project=Storefront").stdout)
        p = self.cli("review", "learn", "proj", "43", "--mcp", "tracker", check=False,
                     FAKE_FEEDBACK='{"status": "needs-input", "used": [], "unneeded": [], "missing": ""}')
        self.assertIn("project Storefront", self.calls()[-1]["append"])
        self.assertEqual(p.returncode, 2)
        self.assertIn("couldn't find PR 43", p.stdout)
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--mcp", "tracker", "list open work items")
        self.assertIn("project Storefront, repo web-app", self.calls()[-1]["append"])
        # the tracker: who the user is and the project's rules, learned once and given to every MCP worker
        with open(os.path.join(self.env["CLAUDE_CONFIG_DIR"], ".claude.json"), "w") as fh:
            json.dump({"oauthAccount": {"emailAddress": "pat@home.example"}}, fh)
        found = json.dumps({"me": {"id": "1a2b-3c", "name": "Pat", "email": "pat@work.example"},
                            "states": {"Bug": {"states": ["New", "Active", "In Review", "Done"], "source": "both"}},
                            "rules": [{"rule": "voting needs the user as a reviewer", "status": "verified",
                                       "how": "vote tool takes a reviewer id"},
                                      {"rule": "work items can be deleted", "status": "unknown"}]})
        fb = '{"status": "done", "used": [], "unneeded": [], "missing": ""}\nLEAN-TRACKER '
        out = self.cli("tracker", "proj", "--discover", "--mcp", "tracker", FAKE_FEEDBACK=fb + found).stdout
        self.assertIn("me_id 1a2b-3c, me_name Pat", out)
        self.assertIn("- Bug states: New, Active, In Review, Done (from both)", out)
        self.assertIn("- work items can be deleted: unknown", out)
        self.assertIn("warning: the tracker knows you as pat@work.example, but Claude is signed in as pat@home.example", out)
        self.assertIn("tracker: the tracker knows you as", self.cli("doctor", check=False).stdout)
        self.assertIn("email mismatch acknowledged", self.cli("tracker", "proj", "--ack-email").stdout)
        self.assertNotIn("the tracker knows you as", self.cli("tracker", "proj").stdout)
        self.assertNotIn("the tracker knows you as", self.cli("doctor", check=False).stdout)
        again = json.dumps({"me": {"id": "1a2b-3c", "name": "Pat"}, "states": {"Bug": {"states": ["New", "Done"]}}})
        out = self.cli("tracker", "proj", "--discover", "--mcp", "tracker", FAKE_FEEDBACK=fb + again).stdout
        self.assertIn("- Bug states: New, Done", out)
        self.assertNotIn("In Review", out)  # replaced, not appended
        self.cli("tracker", "proj", "--note", "Voting on a PR needs the reviewer id")
        self.cli("tracker", "proj", "--note", "a wrong note")
        self.cli("tracker", "proj", "--note", "another wrong note")
        self.cli("tracker", "proj", "--note", "Bug states are New, Active and Done only")
        out = self.cli("tracker", "proj").stdout
        self.assertIn("warning: note 4 may contradict what discovery found: \"Bug states: New, Done", out)

        out = self.cli("tracker", "proj", "--supersede", "4").stdout
        self.assertIn("note 4 superseded", out)
        self.assertIn("4. Bug states are New, Active and Done only  (superseded)", out)
        self.assertNotIn("may contradict", out)
        out = self.cli("tracker", "proj", "--rm-note", "2", "--rm-note", "3").stdout
        self.assertIn("removed note 3: another wrong note", out)
        self.assertIn("removed note 2: a wrong note", out)
        self.assertIn("1. Voting on a PR needs the reviewer id", out)
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--mcp", "tracker", "approve the PR")
        append = self.calls()[-1]["append"]
        self.assertIn("You act as Pat (identity id 1a2b-3c)", append)
        self.assertIn("- Voting on a PR needs the reviewer id", append)
        self.assertIn("- Bug states: New, Done", append)
        # thread ids learned from are remembered per PR
        lesson2 = json.dumps({"checklist": ["Check logout cleanup for every scheduler"], "threads_read": [7, 9]})
        self.cli("review", "learn", "proj", "44", "--mcp", "tracker", check=False,
                 FAKE_FEEDBACK='{"status": "done", "used": [], "unneeded": [], "missing": ""}\nLEAN-CHECKLIST ' + lesson2)
        self.cli("review", "learn", "proj", "44", "--mcp", "tracker", check=False,
                 FAKE_FEEDBACK='{"status": "done", "used": [], "unneeded": [], "missing": ""}\nLEAN-CHECKLIST ' + lesson2)
        self.assertIn("Threads already learned from: 7, 9", self.calls()[-1]["append"])

    def test_review_noise_rules_and_convergence(self):
        def g(*args):
            subprocess.run(["git", "-C", self.proj, "-c", "user.name=t", "-c", "user.email=t@t", *args],
                           check=True, capture_output=True)

        def write(rel, text):
            os.makedirs(os.path.dirname(os.path.join(self.proj, rel)), exist_ok=True)
            with open(os.path.join(self.proj, rel), "w") as fh:
                fh.write(text)
        write("src/sync/index.ts", "export function onLogout() {\n  gen++\n}\n" + "// filler\n" * 80)
        write("src/util/timers.ts", "export function clearTimer(t) { clearTimeout(t) }\n")
        g("init", "-q", "-b", "main")
        g("add", "-A")
        g("commit", "-qm", "base")
        g("checkout", "-qb", "fix")
        write("src/sync/index.ts", "export function onLogout(reason) {\n  gen++\n  scope = null\n}\n"
              + "// filler\n" * 78 + "export function resetScheduler() { clearTimer(t) }\n")
        g("commit", "-qam", "fix races")
        g("checkout", "-q", "main")
        self.cli("learn", self.proj, "--name", "proj")
        rv = {"verdict": "changes-requested", "searches": [{"for": "resetScheduler", "found": "src/util/timers.ts:1"}],
              "reuse": [{"symbol": "resetScheduler", "candidates": ["src/util/timers.ts:1 clearTimer"],
                         "verdict": "duplicate"},
                        {"symbol": "onLogout", "candidates": ["src/sync/index.ts:3 scope reset"], "verdict": "duplicate"}],
              "findings": [{"severity": "major", "category": "duplication", "file": "src/sync/index.ts", "line": 3,
                            "issue": "scope reset duplicates src/sync/index.ts:3", "suggestion": "extend it"},
                           {"severity": "major", "category": "duplication", "file": "src/ui/label.ts", "line": 1,
                            "issue": "label built like three other components", "suggestion": "optional follow-up"},
                           {"severity": "major", "category": "scope", "file": "src/sync/index.ts", "line": 3,
                            "issue": "queuedScope may survive logout; I did not confirm it is cleared"}],
              "checks": []}
        out = self.cli("review", "proj", "--head", "fix", "--base", "main", "--second-opinion", "off", check=False,
                       FAKE_REVIEW=json.dumps(rv)).stdout
        self.assertIn("1 new symbols for the reuse pass", out)  # onLogout was edited, not added
        self.assertIn("dropped a duplication finding that points at the change's own lines", out)
        self.assertIn("lowered a finding the reviewer calls optional/follow-up/pre-existing to minor", out)
        self.assertIn("turned an unverified major into a check", out)
        self.assertIn("[check] unverified -> delegate a read-only check: src/sync/index.ts: queuedScope", out)
        self.assertIn("1. [major/duplication] resetScheduler", out)  # copies code outside the change
        self.assertIn("cost: this review $0.05 (3,100 sonnet-eq) · fix so far $0.05 over 1 review run(s)", out)
        # decline the auto-raised one; it must not come back on --resume, and can't flip the verdict
        self.cli("review", "decline", "proj", "1", "--head", "fix", "--why", "false positive: it calls clearTimer")
        resumed = dict(rv, verdict="changes-requested", findings=[])
        out = self.cli("review", "proj", "--resume", "--head", "fix", check=False, FAKE_REVIEW=json.dumps(resumed)).stdout
        self.assertNotIn("[major/duplication]", out)
        self.assertIn("left out 1 finding(s) declined earlier", out)
        self.assertIn("REVIEW: APPROVE", out)
        self.assertIn("declined earlier: resetScheduler", out)
        self.assertIn("over 2 review run(s)", out)
        # a change that only edits existing code has no new symbols
        g("checkout", "-qb", "edit", "main")
        write("src/util/timers.ts", "export function clearTimer(t) { if (t) clearTimeout(t) }\n")
        g("commit", "-qam", "edit")
        g("checkout", "-q", "main")
        out = self.cli("review", "proj", "--head", "edit", "--base", "main", check=False,
                       FAKE_REVIEW=json.dumps({"verdict": "approve", "findings": [], "checks": [],
                                               "reuse": [{"symbol": "clearTimer", "verdict": "wraps-existing"}]})).stdout
        self.assertIn("0 new files, 0 new symbols", out)
        self.assertIn("reuse: no new symbols (the change edits existing code)", out)
        self.assertIn("REVIEW: APPROVE", out)

    def test_shared_worktree_for_workers(self):
        g = self.git_project()
        g("add", "-A")
        g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "page")
        g("checkout", "-q", "main")
        self.cli("learn", self.proj, "--name", "proj")
        out = self.cli("run", "proj", "-m", "haiku", "--why", "x", "--worktree", "feature", "--", "run the tests").stdout
        self.assertIn("worktree: feature at", out)
        self.assertIn("(created, on branch feature, HEAD ", out)
        wt = os.path.join(self.env["LEAN_AGENT_HOME"], "worktrees", "proj", "feature")
        self.assertTrue(os.path.isfile(os.path.join(wt, "api", "totals.py")))  # the branch's files
        call = self.calls()[-1]
        argv = call["argv"]
        self.assertEqual(argv[argv.index("--add-dir") + 1], wt)
        self.assertIn("shared with other", call["append"])
        self.assertIn("commits you make land on that branch", call["append"])
        self.assertEqual(subprocess.run(["git", "-C", self.proj, "rev-parse", "--abbrev-ref", "HEAD"],
                                        capture_output=True, text=True).stdout.strip(), "main")  # untouched
        os.makedirs(os.path.join(wt, "node_modules"))  # deps a worker installed
        out = self.cli("run", "proj", "-m", "haiku", "--why", "x", "--read-only", "--worktree", "feature",
                       "--", "list test files").stdout
        self.assertIn("(reused, on branch feature, HEAD ", out)
        self.assertTrue(os.path.isdir(os.path.join(wt, "node_modules")))  # persisted for the next worker
        run_id = out.split("run ")[1].split()[0]
        self.cli("run", "--resume", run_id, "and the fixtures")
        self.assertEqual(self.calls()[-1]["argv"][self.calls()[-1]["argv"].index("--add-dir") + 1], wt)
        # the branch checked out in the user's repo can't be attached again: detached worktree
        out = self.cli("run", "proj", "-m", "haiku", "--why", "x", "--worktree", "main", "--", "t").stdout
        self.assertIn("(created, detached, HEAD ", out)
        self.assertIn("detached checkout", self.calls()[-1]["append"])
        listing = self.cli("worktrees", "proj").stdout
        self.assertIn("feature", listing)
        self.assertIn("branch feature", listing)
        with open(os.path.join(wt, "api", "totals.py"), "a") as fh:
            fh.write("# wip\n")
        p = self.cli("worktree", "rm", "proj", "feature", check=False)
        self.assertIn("uncommitted changes", p.stderr)
        self.cli("worktree", "rm", "proj", "feature", "--force")
        self.assertFalse(os.path.exists(wt))
        self.assertNotIn("branch feature", self.cli("worktrees", "proj").stdout)

    def test_pr_branch_worktree_setup_and_push(self):
        g = self.git_project()
        g("add", "-A")
        g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "page")
        origin = os.path.join(self.tmp.name, "origin.git")
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", origin], check=True)
        g("remote", "add", "origin", origin)
        g("push", "-q", "origin", "main", "feature")
        g("checkout", "-q", "main")
        g("branch", "-qD", "feature")  # the PR branch exists only on the remote
        self.cli("learn", self.proj, "--name", "proj")
        self.assertIn("new worktrees run: touch built.txt",
                      self.cli("worktree", "setup", "proj", "--run", "touch built.txt").stdout)
        self.cli("learn", self.proj, "--name", "proj")  # re-learning keeps the setup command
        out = self.cli("run", "proj", "-m", "haiku", "--why", "x", "--worktree", "origin/feature", "--", "fix").stdout
        self.assertIn("on branch feature", out)
        self.assertIn("worktree setup: done", out)
        wt = os.path.join(self.env["LEAN_AGENT_HOME"], "worktrees", "proj", "origin-feature")
        self.assertTrue(os.path.exists(os.path.join(wt, "built.txt")))
        out = self.cli("run", "proj", "-m", "haiku", "--why", "x", "--worktree", "origin/feature", "--", "t").stdout
        self.assertNotIn("worktree setup", out)  # once per worktree
        self.assertIn("Never push", self.calls()[-1]["append"])
        with open(os.path.join(wt, "api", "totals.py"), "a") as fh:
            fh.write("# fixed\n")
        subprocess.run(["git", "-C", wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "fix"],
                       check=True)
        p = self.cli("worktree", "push", "proj", "origin/feature", check=False)
        self.assertEqual(p.returncode, 2)
        self.assertIn("no approving review", p.stderr)
        approve = json.dumps(dict(REUSE_CHECKED, verdict="approve", findings=[], checks=[]))
        self.cli("review", "proj", "--head", "feature", "--base", "main", FAKE_REVIEW=approve)
        self.cli("attribution", "off")
        subprocess.run(["git", "-C", wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--amend", "-m",
                        "fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>"], check=True)
        self.cli("review", "proj", "--head", "feature", "--base", "main", FAKE_REVIEW=approve)
        p = self.cli("worktree", "push", "proj", "origin/feature", check=False)
        self.assertIn("credit Claude, but attribution is off", p.stderr)
        subprocess.run(["git", "-C", wt, "push", "-q", "origin", "HEAD:refs/heads/published"], check=True)
        p = self.cli("worktree", "push", "proj", "origin/feature", check=False)  # published elsewhere, but it is what this push sends
        self.assertIn("credit Claude", p.stderr)
        subprocess.run(["git", "-C", wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--amend", "-m",
                        "fix"], check=True)
        self.cli("review", "proj", "--head", "feature", "--base", "main", FAKE_REVIEW=approve)
        p = self.cli("worktree", "push", "proj", "origin/feature", check=False)
        self.assertEqual(p.returncode, 2)
        self.assertIn("ACTION NEEDED", p.stdout)
        self.assertIn("fix", p.stdout)
        remote = lambda: subprocess.run(["git", "-C", origin, "rev-parse", "feature"], capture_output=True,
                                        text=True).stdout.strip()
        before = remote()
        self.assertIn("pushed feature", self.cli("worktree", "push", "proj", "origin/feature",
                                                 "--allow-send", "push the fix").stdout)
        local = subprocess.run(["git", "-C", wt, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        self.assertNotEqual(before, local)
        self.assertEqual(remote(), local)
        self.assertIn("nothing to push", self.cli("worktree", "push", "proj", "origin/feature").stdout)

    def test_branch_names_follow_the_project_rules(self):
        g = self.git_project()
        g("add", "-A")
        g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "page")
        g("branch", "-m", "feature", "feat-old")  # git_project's plain "feature" branch would block feature/...
        self.cli("learn", self.proj, "--name", "proj")
        bn = lambda *a, **k: self.cli("branch-name", "-p", "proj", *a, **k)
        self.assertEqual(bn("Add export", "--task", "ABC-7").stdout.strip(), "feature/ABC-7-add-export")
        self.assertEqual(bn("Add export").stdout.strip(), "feature/add-export")  # no id: the '-' goes too
        self.assertEqual(bn("Login times out", "--type", "bugfix", "--task", "123").stdout.strip(),
                         "bugfix/123-login-times-out")
        self.assertEqual(bn("Release 2.1", "--version", "2.1").stdout.strip(), "release/release-2.1")
        self.assertEqual(bn("Release 3.0").stdout.strip(), "release/release-3.0")  # version from the title
        self.assertEqual(bn("Release v2.1.3").stdout.strip(), "release/release-2.1.3")
        for title in ("Release notes page", "Release 7 things", "Releases 2.0", "Update release process"):
            self.assertTrue(bn(title).stdout.startswith("feature/"), title)  # no version after "release": a feature
        self.assertEqual(bn("Release 2.0-rc1").stdout.strip(), "release/release-2.0-rc1")
        self.assertTrue(bn("Backport fix to release/2.0").stdout.startswith("bugfix/"))
        self.assertTrue(bn("Cut release/2.0 from main").stdout.startswith("feature/"))
        self.assertTrue(bn("Cut release/2.0 from main", "--type", "release", "--version", "2.0").stdout.startswith("release/"))
        self.assertIn("--version X", bn("Release 7", "--type", "release", check=False).stderr)  # no bare integer
        p = bn("Release notes", "--type", "release", check=False)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("--version X", p.stderr)
        # inference
        for title, kind in (("Fix login timeout", "bugfix"), ("Hotfix for payments", "bugfix"), ("Crash: a bug in x", "bugfix"),
                            ("Regression in search", "bugfix"), ("Defect in cart", "bugfix"), ("Prefix handling", "feature"),
                            ("Add dark mode", "feature")):
            self.assertTrue(bn(title).stdout.startswith(kind + "/"), title)
        # slug rules: unicode, punctuation, length
        self.assertEqual(bn("Café: déjà vu!! (naïve) ✓").stdout.strip(), "feature/cafe-deja-vu-naive")
        self.assertEqual(bn("日本語").stdout.strip(), "feature/work")
        long = bn("word " * 30).stdout.strip()
        self.assertLessEqual(len(long.split("/", 1)[1]), 40)
        self.assertFalse(long.endswith("-"))
        # custom rules per project, and back
        out = self.cli("config", "branch-rules", "-p", "proj", "feature=feat/{name}", "bugfix=fix/{task-id}/{name}").stdout
        self.assertIn("feature=feat/{name}", out)
        self.assertEqual(bn("Add x").stdout.strip(), "feat/add-x")
        self.assertEqual(bn("Fix y", "--task", "9").stdout.strip(), "fix/9/fix-y")
        self.assertEqual(bn("Release 1.0").stdout.strip(), "release/release-1.0")
        p = self.cli("config", "branch-rules", "-p", "proj", "feature=a b/{name}", check=False)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("feature=feature/{task-id}-{name}", self.cli("config", "branch-rules", "-p", "proj", "default").stdout)
        self.assertIn("branch rules for proj: feature=feature/{task-id}-{name}", self.cli("doctor", self.proj, check=False).stdout)
        # collisions get -2, -3
        g("branch", "feature/add-x")
        self.assertEqual(bn("Add x").stdout.strip(), "feature/add-x-2")
        g("branch", "feature/add-x-2")
        self.assertEqual(bn("Add x").stdout.strip(), "feature/add-x-3")
        g("branch", "bugfix")  # a plain "bugfix" branch: bugfix/... can't exist beside it
        self.assertIn("a branch named 'bugfix' exists", bn("Fix z", check=False).stderr)

    def test_run_worktree_auto_names_the_branch_from_todo_task_or_release_title(self):
        g = self.git_project()
        g("add", "-A")
        g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "page")
        g("branch", "-m", "feature", "feat-old")  # a plain "feature" branch would block feature/...
        g("checkout", "-q", "main")
        self.cli("learn", self.proj, "--name", "proj")
        self.cli("todo", "add", "Login timeout", "-p", "proj", "--ref", "PR 512")
        out = self.cli("run", "proj", "-m", "haiku", "--why", "Fix login timeout", "--worktree", "auto", "--todo", "1",
                       "--worktree-base", "main", "--", "t").stdout
        self.assertIn("branch: feature/512-login-timeout", out)  # the todo's title, not --why
        out = self.cli("run", "proj", "-m", "haiku", "--why", "Ignored why", "--worktree", "auto",
                       "--worktree-base", "main", "--", "Fix the export crash\nmore detail").stdout
        self.assertIn("branch: bugfix/fix-the-export-crash", out)  # no todo: the task's first line
        out = self.cli("run", "proj", "-m", "haiku", "--why", "x", "--worktree", "auto",
                       "--worktree-base", "main", "--", "Release 4.2").stdout
        self.assertIn("branch: release/release-4.2", out)
        self.assertIn("guarded", out)  # created locally; pushing stays blocked
        self.assertIn("pushing it stays blocked", out)
        p = self.cli("run", "proj", "-m", "haiku", "--why", "x", "--branch-type", "release",
                     "--worktree", "auto", "--worktree-base", "main", "--", "Release notes", check=False)
        self.assertIn("--version X", p.stderr)
        out = self.cli("run", "proj", "-m", "haiku", "--why", "Add thing", "--worktree", "my-own-name",
                       "--worktree-base", "main", "--", "t").stdout
        self.assertIn("worktree: created my-own-name", out)  # explicit names are taken as they are


    def test_auto_branch_next_to_a_similar_branch_skips_the_typo_check(self):
        g = self.git_project()
        g("add", "-A")
        g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "page")
        g("checkout", "-q", "main")
        g("branch", "-m", "feature", "feat-old")
        g("branch", "feature/add-thing")  # one edit from the generated feature/add-thing-2
        self.cli("learn", self.proj, "--name", "proj")
        out = self.cli("run", "proj", "-m", "haiku", "--why", "Add thing", "--worktree", "auto",
                       "--worktree-base", "main", "--", "Add thing").stdout
        self.assertIn("branch: feature/add-thing-2", out)
        self.assertIn("worktree: created feature/add-thing-2", out)

    def test_worktree_auto_is_for_write_workers_only(self):
        g = self.git_project()
        g("add", "-A")
        g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "page")
        g("checkout", "-q", "main")
        self.cli("learn", self.proj, "--name", "proj")
        out = self.cli("run", "proj", "-m", "haiku", "--why", "Look at x", "--read-only", "--worktree", "auto",
                       "--worktree-base", "main", "--", "look").stdout
        self.assertIn("this read-only worker gets none", out)
        self.assertNotIn("worktree: created", out)
        branches = subprocess.run(["git", "-C", self.proj, "branch", "--list"], capture_output=True, text=True).stdout
        self.assertNotIn("look-at-x", branches)

    def test_branch_rule_only_when_the_worker_may_make_a_branch_itself(self):
        g = self.git_project()
        g("add", "-A")
        g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "page")
        g("branch", "-m", "feature", "feat-old")
        g("checkout", "-q", "main")
        self.cli("learn", self.proj, "--name", "proj")
        rule = "New branches follow the project's branch rules"
        self.cli("run", "proj", "-m", "haiku", "--why", "x", "--", "write something")
        self.assertIn(rule, self.calls()[-1]["append"])
        self.cli("run", "proj", "-m", "haiku", "--why", "x", "--read-only", "--", "look")
        self.assertNotIn(rule, self.calls()[-1]["append"])
        self.cli("run", "proj", "-m", "haiku", "--why", "x", "--worktree", "auto", "--worktree-base", "main", "--",
                 "Add a thing")
        self.assertNotIn(rule, self.calls()[-1]["append"])  # the branch already exists
        self.cli("run", "proj", "-m", "haiku", "--why", "x", "--read-only", "--worktree", "auto", "--", "look")
        self.assertNotIn(rule, self.calls()[-1]["append"])

    def test_branch_name_inputs_and_call_sites_agree(self):
        g = self.git_project()
        g("add", "-A")
        g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "page")
        g("branch", "-m", "feature", "feat-old")
        g("checkout", "-q", "main")
        self.cli("learn", self.proj, "--name", "proj")
        bn = lambda *a, **k: self.cli("branch-name", "-p", "proj", *a, **k)
        self.assertEqual(bn("Release notes", "--type", "release", "--version", "3.1").stdout.strip(),
                         "release/release-3.1")
        p = bn("Add x", "--task", "a b/c", check=False)  # an invalid --task is a clear error, not a mangled name
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("invalid task id 'a b/c'", p.stderr)
        # a todo without a tracker ref: its number is the task id
        self.cli("todo", "add", "Export totals", "-p", "proj")
        run = lambda *a: self.cli("run", "proj", "-m", "haiku", "--why", "x", "--worktree", "auto", *a, "--", "Export totals").stdout
        self.assertIn("branch: feature/1-export-totals", run("--todo", "1", "--worktree-base", "main"))
        self.assertIn("branch: release/release-5.0", run("--branch-type", "release", "--branch-version", "5.0",
                                                         "--worktree-base", "main"))
        # run --worktree auto and branch-name make the same name
        self.assertEqual(bn("Export totals").stdout.strip(), "feature/export-totals")
        self.assertIn("branch: feature/export-totals", run("--worktree-base", "main"))
        # without --worktree-base: the project's default base (here main) is used
        out = self.cli("run", "proj", "-m", "haiku", "--why", "x", "--worktree", "auto", "--", "Other thing").stdout
        self.assertIn("branch: feature/other-thing", out)
        self.assertIn("worktree: created feature/other-thing from main", out)

    def test_worktree_creates_missing_branch_from_a_base(self):
        g = self.git_project()
        g("add", "-A")
        g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "page")
        g("checkout", "-q", "main")
        g("branch", "develop", "feature")
        self.cli("learn", self.proj, "--name", "proj")
        out = self.cli("run", "proj", "-m", "haiku", "--why", "x", "--worktree", "brand-new",
                       "--worktree-base", "develop", "--", "t").stdout
        self.assertIn("worktree: created brand-new from develop", out)
        wt = os.path.join(self.env["LEAN_AGENT_HOME"], "worktrees", "proj", "brand-new")
        self.assertTrue(os.path.isfile(os.path.join(wt, "api", "totals.py")))  # develop's files, not main's
        self.assertEqual(subprocess.run(["git", "-C", wt, "rev-parse", "--abbrev-ref", "HEAD"], capture_output=True,
                                        text=True).stdout.strip(), "brand-new")
        self.assertIn("base develop", self.cli("worktree", "base", "proj", "develop").stdout)
        out = self.cli("run", "proj", "-m", "haiku", "--why", "x", "--worktree", "other-new", "--", "t").stdout
        self.assertIn("worktree: created other-new from develop", out)  # the configured base
        p = self.cli("run", "proj", "-m", "haiku", "--why", "x", "--worktree", "third", "--worktree-base", "nope",
                     "--", "t", check=False)
        self.assertIn("'nope' is unknown", p.stderr)

    def test_worktree_refuses_a_branch_name_one_typo_from_an_existing_branch(self):
        g = self.git_project()
        g("add", "-A")
        g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "page")
        g("checkout", "-q", "main")
        g("branch", "develop", "feature")
        self.cli("learn", self.proj, "--name", "proj")
        p = self.cli("run", "proj", "-m", "haiku", "--why", "x", "--worktree", "develop2", "--", "t", check=False)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("did you mean develop? add --worktree-base <ref> to create develop2", p.stderr)
        self.assertFalse(subprocess.run(["git", "-C", self.proj, "rev-parse", "--verify", "-q", "develop2"],
                                        capture_output=True).returncode == 0)
        out = self.cli("run", "proj", "-m", "haiku", "--why", "x", "--worktree", "develop2",
                       "--worktree-base", "develop", "--", "t").stdout
        self.assertIn("worktree: created develop2 from develop", out)

    def test_push_credit_check_looks_only_at_the_pushed_commits(self):
        g = self.git_project()
        ident = ["-c", "user.name=t", "-c", "user.email=t@t"]
        g("add", "-A")
        g(*ident, "commit", "-qm", "page")
        g("checkout", "-q", "main")
        origin = os.path.join(self.tmp.name, "origin.git")
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", origin], check=True)
        g("remote", "add", "origin", origin)
        g("push", "-q", "origin", "main")
        g("checkout", "-qb", "develop")  # the project's base: local only, with many flagged commits
        for i in range(5):
            g(*ident, "commit", "-q", "--allow-empty", "-m", f"base {i}\n\nCo-Authored-By: Claude <noreply@anthropic.com>")
        self.cli("learn", self.proj, "--name", "proj")
        self.cli("worktree", "base", "proj", "develop")
        self.cli("attribution", "off")
        self.cli("run", "proj", "-m", "haiku", "--why", "x", "--worktree", "topic", "--", "t")
        wt = os.path.join(self.env["LEAN_AGENT_HOME"], "worktrees", "proj", "topic")
        wg = lambda *a: subprocess.run(["git", "-C", wt, *ident, *a], check=True, capture_output=True, text=True)
        def change(msg):
            with open(os.path.join(wt, "web", "n.txt"), "a") as fh:
                fh.write(msg + "\n")
            wg("add", "-A")
            wg("commit", "-q", "-m", msg)
        change("clean change")
        p = self.cli("worktree", "push", "proj", "topic", check=False)  # past the credit check, stopped by the review
        self.assertNotIn("credit Claude", p.stderr)
        self.assertIn("no approving review", p.stderr)
        change("flagged\n\nCo-Authored-By: Claude <noreply@anthropic.com>")
        flagged = wg("rev-parse", "HEAD").stdout.strip()[:12]
        p = self.cli("worktree", "push", "proj", "topic", check=False)
        self.assertIn("credit Claude", p.stderr)
        self.assertIn(flagged, p.stderr)
        self.assertEqual(len(re.findall(r"[0-9a-f]{12}", p.stderr.split("credit Claude")[0])), 1)

    def test_detached_worktree_keeps_commits_and_clean_merge_keeps_approval(self):
        g = self.git_project()
        g("add", "-A")
        g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "page")
        origin = os.path.join(self.tmp.name, "origin.git")
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", origin], check=True)
        g("remote", "add", "origin", origin)
        g("push", "-q", "origin", "main", "feature")
        g("checkout", "-q", "main")
        with open(os.path.join(self.proj, "NOTES.md"), "w") as fh:
            fh.write("base change\n")
        g("add", "NOTES.md")
        g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base change")
        g("push", "-q", "origin", "main")
        g("checkout", "-q", "feature")  # the local branch is checked out here: the worktree has to be detached
        self.cli("learn", self.proj, "--name", "proj")
        approve = json.dumps(dict(REUSE_CHECKED, verdict="approve", findings=[], checks=[]))
        self.cli("review", "proj", "--head", "origin/feature", "--base", "main", FAKE_REVIEW=approve)
        out = self.cli("run", "proj", "-m", "haiku", "--why", "x", "--worktree", "origin/feature", "--", "merge").stdout
        self.assertIn(", detached, HEAD ", out)
        wt = os.path.join(self.env["LEAN_AGENT_HOME"], "worktrees", "proj", "origin-feature")
        tip = subprocess.run(["git", "-C", wt, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        subprocess.run(["git", "-C", wt, "-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-edit",
                        "origin/main"], check=True)  # what the worker did
        merge = subprocess.run(["git", "-C", wt, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        p = self.cli("run", "proj", "-m", "haiku", "--why", "x", "--worktree", "origin/feature", "--again", "--", "check")
        self.assertIn(f"has commits that aren't on origin/feature (HEAD {merge[:10]}); keeping them", p.stderr)
        self.assertIn(f"HEAD {merge[:10]}", p.stdout)
        head = lambda: subprocess.run(["git", "-C", wt, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        self.assertEqual(head(), merge)
        # pushing the detached merge: the clean base merge keeps the feature tip's approval
        out = self.cli("worktree", "push", "proj", "origin/feature", check=False).stdout
        self.assertIn("approval carried over from", out)
        self.assertIn("clean merge of", out)
        self.assertIn("push feature @ " + merge[:12] + " to origin/feature", out)
        # --reset-worktree throws it away on purpose
        out = self.cli("run", "proj", "-m", "haiku", "--why", "x", "--worktree", "origin/feature", "--reset-worktree",
                       "--again", "--", "start over").stdout
        self.assertIn(f"HEAD moved from {merge[:10]} to {tip[:10]}", out)
        self.assertEqual(head(), tip)

    def test_mcp_spec_with_repeated_server(self):
        sys.path.insert(0, os.path.dirname(CLI))
        import lean_mcp
        self.assertEqual(lean_mcp.parse_specs(["tickets:prs,tickets:states"]),
                         [("tickets", ["prs", "states"])])

    def test_wrapper_lets_local_pushes_through(self):
        g = self.git_project()
        g("add", "-A")
        g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "page")
        origin = os.path.join(self.tmp.name, "local-origin.git")
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", origin], check=True)
        g("remote", "add", "origin", origin)
        g("remote", "add", "web", "https://example.invalid/x.git")
        sys.path.insert(0, os.path.dirname(CLI))
        import push_guard
        old = os.environ.get("LEAN_AGENT_HOME")
        os.environ["LEAN_AGENT_HOME"] = self.env["LEAN_AGENT_HOME"]
        try:
            env = push_guard.git_env(dict(os.environ))
        finally:
            if old is None:
                os.environ.pop("LEAN_AGENT_HOME", None)
            else:
                os.environ["LEAN_AGENT_HOME"] = old
        run = lambda *a: subprocess.run(["git", "-C", self.proj, *a], capture_output=True, text=True, env=env)
        for dest in ("origin", origin, "file://" + origin):
            p = run("push", "-q", dest, "main")  # main is guarded, but a local repository is not checked
            self.assertEqual(p.returncode, 0, p.stderr)
        p = run("push", "web", "main")
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("lean-agent push guard", p.stderr)

    def test_pre_push_hook_never_hangs_in_a_worker_env(self):
        import fcntl
        import time
        g = self.git_project()
        g("add", "-A")
        g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "page")
        origin = os.path.join(self.tmp.name, "hang-origin.git")
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", origin], check=True)
        g("remote", "add", "origin", origin)
        sys.path.insert(0, os.path.dirname(CLI))
        import push_guard
        # a worker's env: git already points at the hooks folder of the lean-agent home that started it
        outer = os.path.join(self.tmp.name, "outer-home")
        os.makedirs(outer)
        base = dict(os.environ, LEAN_AGENT_HOME=outer)
        worker = push_guard.git_env(base)
        env = push_guard.git_env(dict(worker, LEAN_AGENT_HOME=self.env["LEAN_AGENT_HOME"]))
        env.pop("LEAN_AGENT_PUSH_GUARD_OVERRIDE", None)
        # ... while this run holds its locks
        held = []
        for path in (os.path.join(self.env["LEAN_AGENT_HOME"], "library", "proj", ".lock"),
                     os.path.join(self.env["LEAN_AGENT_HOME"], "worktrees", "proj", ".main.lock")):
            os.makedirs(os.path.dirname(path), exist_ok=True)
            fh = open(path, "w")
            fcntl.flock(fh, fcntl.LOCK_EX)
            held.append(fh)
        self.addCleanup(lambda: [fh.close() for fh in held])
        for dest in (origin, "file://" + origin):
            start = time.time()
            p = subprocess.run(["git", "-C", self.proj, "push", "-q", dest, "main"], capture_output=True, text=True,
                               env=env, timeout=60, stdin=subprocess.DEVNULL)
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertLess(time.time() - start, 30)
        # git never closes the hook's stdin: the hook gives up with a message instead of waiting for ever
        hook = os.path.join(os.path.dirname(CLI), "push_guard.py")
        start = time.time()
        proc = subprocess.Popen([sys.executable, hook, "git-hook", "pre-push", "origin", "https://example.invalid/x.git"],
                                stdin=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=self.proj,
                                env=dict(env, LEAN_AGENT_HOOK_WAIT="1"))
        try:
            self.assertEqual(proc.wait(timeout=20), 1)  # stdin stays open
            err = proc.stderr.read()
        finally:
            proc.kill()
            proc.wait()
            proc.stdin.close()
            proc.stderr.close()
        self.assertIn("gave up", err)
        self.assertLess(time.time() - start, 20)
        # a hooks path that leads back to lean-agent's own hook folder cannot start hooks for ever
        p = subprocess.run([sys.executable, hook, "git-hook", "pre-push", "origin", "https://example.invalid/x.git"],
                           input="refs/heads/f 1 refs/heads/main 2\n", capture_output=True, text=True, cwd=self.proj,
                           env=env, timeout=60)
        self.assertEqual(p.returncode, 1)
        self.assertIn("lean-agent push guard", p.stderr)
        p = subprocess.run([sys.executable, hook, "git-hook", "pre-push", "origin", "https://example.invalid/x.git"],
                           input="refs/heads/f 1 refs/heads/main 2\n", capture_output=True, text=True, cwd=self.proj,
                           env=dict(env, LEAN_AGENT_HOOK_DEPTH="3"), timeout=60)
        self.assertEqual(p.returncode, 1)
        self.assertIn("gave up", p.stderr)

    def test_push_guards(self):
        g = self.git_project()
        g("add", "-A")
        g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "page")
        origin = os.path.join(self.tmp.name, "origin.git")
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", origin], check=True)
        g("remote", "add", "origin", origin)
        g("branch", "-q", "release/r-1")
        g("push", "-q", "origin", "main", "release/r-1")
        g("checkout", "-q", "main")
        self.cli("learn", self.proj, "--name", "proj")
        self.assertIn("proj: never pushes to release/*, develop, main, master (defaults)", self.cli("guard", "list").stdout)
        self.assertIn("proj: never pushes to release/*, develop, main, master", self.cli("doctor", check=False).stdout)
        # a local bugfix branch whose upstream is the release branch: the destination counts, not the name
        self.cli("run", "proj", "-m", "haiku", "--why", "x", "--worktree", "origin/release/r-1", "--", "fix")
        wt = os.path.join(self.env["LEAN_AGENT_HOME"], "worktrees", "proj", "origin-release-r-1")
        subprocess.run(["git", "-C", wt, "checkout", "-q", "-b", "bugfix/b-1", "--track", "origin/release/r-1"], check=True)
        subprocess.run(["git", "-C", wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty",
                        "-m", "fix"], check=True)
        approve = json.dumps(dict(REUSE_CHECKED, verdict="approve", findings=[], checks=[]))
        self.cli("review", "proj", "--head", "bugfix/b-1", "--base", "main", FAKE_REVIEW=approve)
        p = self.cli("worktree", "push", "proj", "origin/release/r-1", "--allow-send", "push it", check=False)
        self.assertEqual(p.returncode, 3)
        self.assertIn("would be pushed to origin/release/r-1, which matches the push guard 'release/*'", p.stderr)
        remote = lambda b: subprocess.run(["git", "-C", origin, "rev-parse", b], capture_output=True, text=True).stdout
        before = remote("release/r-1")
        # workers' git refuses it too (pre-push hook), and so does the orchestrator's Bash hook
        sys.path.insert(0, os.path.dirname(CLI))
        import push_guard
        old = os.environ.get("LEAN_AGENT_HOME")
        os.environ["LEAN_AGENT_HOME"] = self.env["LEAN_AGENT_HOME"]
        os.environ["LEAN_AGENT_PUSH_GUARD_LOCAL"] = "1"  # origin is a local path here, which is not checked otherwise
        self.addCleanup(os.environ.pop, "LEAN_AGENT_PUSH_GUARD_LOCAL", None)
        try:
            env = push_guard.git_env(dict(os.environ))
            p = subprocess.run(["git", "-C", wt, "push", "origin", "HEAD:release/r-1"], capture_output=True, text=True,
                               env=env)
            self.assertNotEqual(p.returncode, 0)
            self.assertRegex(p.stderr, r"lean-agent push guard: .*release/r-1")  # the guarded git, or else the hook
            self.assertIn("would update release/r-1", push_guard.check(f"cd {wt} && git push --force", "/"))
            self.assertIn("would update main", push_guard.check(f"git -C {wt} push origin +HEAD:refs/heads/main", "/"))
            self.assertIn("--all/--mirror", push_guard.check(f"git -C {wt} push --mirror origin", "/"))
            self.assertEqual(push_guard.check(f"git -C {wt} push origin HEAD:bugfix/b-1", "/"), "")
            self.assertEqual(remote("release/r-1"), before)
            # --no-verify skips git's hooks, but not the guarded `git` first on the PATH
            p = subprocess.run(["git", "-C", wt, "push", "--no-verify", "origin", "HEAD:release/r-1"],
                               capture_output=True, text=True, env=env)
            self.assertNotEqual(p.returncode, 0)
            self.assertIn("lean-agent push guard", p.stderr)
            p = subprocess.run(f"cd {wt} && git push -q --no-verify origin HEAD:refs/heads/bugfix/b-1", shell=True,
                               capture_output=True, text=True, env=env)
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertEqual(remote("release/r-1"), before)
            # a second worker's uncommitted work: named, and --only-commits pushes what is committed
            with open(os.path.join(wt, "api", "totals.py"), "a") as fh:
                fh.write("# wip\n")
            p = self.cli("worktree", "push", "proj", "origin/release/r-1", "--allow-send", "x", check=False)
            self.assertIn("uncommitted changes in api/totals.py", p.stderr)
            self.assertIn("--only-commits", p.stderr)
            self.cli("guard", "add", "proj", "require-pr", "develop")
            # per-project list: rm and add; an explicit, logged override
            self.cli("guard", "rm", "proj", "push-deny", "master")
            self.assertIn("never pushes to release/*, develop, main: they change only through pull requests\n",
                          self.cli("guard", "list", "proj").stdout)
            self.cli("guard", "add", "proj", "push-deny", "hotfix/*")
            self.assertIn("hotfix/*", self.cli("guard", "list", "proj").stdout)
            self.cli("learn", self.proj, "--name", "proj")  # re-learning (sync) keeps them
            self.assertIn("hotfix/*", self.cli("guard", "list", "proj").stdout)
            out = self.cli("worktree", "push", "proj", "origin/release/r-1", "--allow-send", "push it", "--only-commits",
                           "--override-guard", "user asked for exactly this").stdout
            self.assertIn("uncommitted change(s) stay in the worktree", out)
            self.assertIn("overridden: user asked for exactly this", out)
            self.assertNotEqual(remote("release/r-1"), before)
            with open(os.path.join(self.env["LEAN_AGENT_HOME"], "pushes.jsonl")) as fh:
                self.assertEqual(json.loads(fh.readlines()[-1])["guard_override"], "user asked for exactly this")
        finally:
            os.environ.pop("LEAN_AGENT_HOME") if old is None else os.environ.update(LEAN_AGENT_HOME=old)
        argv = self.calls()[-1]["argv"]
        self.assertIn("push_guard.py", argv[argv.index("--settings") + 1])

    def test_worktree_writers_take_turns(self):
        self.git_project()
        self.cli("learn", self.proj, "--name", "proj")
        release = os.path.join(self.tmp.name, "release")
        env = dict(self.env, FAKE_RELEASE_FILE=release)
        cmd = [sys.executable, CLI, "run", "proj", "-m", "haiku", "--why", "x", "--worktree", "feature", "--", "t"]
        self.cli("run", "proj", "-m", "haiku", "--why", "x", "--worktree", "feature", "--", "create it first")
        errs = [os.path.join(self.tmp.name, f"err{i}") for i in range(2)]
        procs = []
        for e in errs:
            with open(e, "w") as fh:
                procs.append(subprocess.Popen(cmd, env=env, stdout=subprocess.DEVNULL, stderr=fh, text=True,
                                              stdin=subprocess.DEVNULL))

        def waited():
            for e in errs:
                with open(e) as fh:
                    if "waiting for another worker" in fh.read():
                        return True
            return False
        end = time.time() + 30
        while not waited() and time.time() < end and all(p.poll() is None for p in procs):
            time.sleep(0.05)
        saw_wait = waited()
        with open(release, "w"):
            pass
        for p in procs:
            p.wait(timeout=60)
        self.assertEqual([p.returncode for p in procs], [0, 0])
        self.assertTrue(saw_wait)

    def test_review_needs_changes_and_base(self):
        g = self.git_project()
        self.cli("learn", self.proj, "--name", "proj")
        g("checkout", "-q", "-f", "main")
        g("clean", "-qfd")
        p = self.cli("review", "proj", check=False)
        self.assertIn("nothing to review", p.stderr)

    def make_clone(self):
        """A throwaway lean-agent git clone with its own bare origin; returns (clone, other clone, git)."""
        import shutil
        src = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
        origin = os.path.join(self.tmp.name, "origin.git")
        clone = os.path.join(self.tmp.name, "clone")
        shutil.copytree(src, clone, ignore=shutil.ignore_patterns(".git", "__pycache__"))

        def g(cwd, *args):
            subprocess.run(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", *args], check=True,
                           capture_output=True)
        g(clone, "init", "-q", "-b", "main")
        g(clone, "add", "-A")
        g(clone, "commit", "-qm", "v1")
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", origin], check=True)
        g(clone, "remote", "add", "origin", origin)
        g(clone, "push", "-q", "-u", "origin", "main")
        other = os.path.join(self.tmp.name, "other-clone")
        subprocess.run(["git", "clone", "-q", origin, other], check=True)
        return clone, other, g

    def test_old_plugin_copies_forward_to_the_clone(self):
        clone, _, _ = self.make_clone()
        cfg = self.env["CLAUDE_CONFIG_DIR"]
        old = os.path.join(cfg, "plugins", "cache", "lean-agent", "lean-agent", "0.2.0", "scripts")
        os.makedirs(old)
        with open(os.path.join(old, "budget_hook.py"), "w") as fh:  # an old hook: denies everything
            fh.write("import json\nprint(json.dumps({'hookSpecificOutput': {'hookEventName': 'PreToolUse', "
                     "'permissionDecision': 'deny', 'permissionDecisionReason': 'old cap'}}))\n")
        lean = [sys.executable, os.path.join(clone, "plugins", "lean-agent", "scripts", "lean_agent.py")]
        env = dict(self.env)
        doc = subprocess.run(lean + ["doctor"], capture_output=True, text=True, env=env).stdout
        self.assertIn("1 hook script(s) in older cached plugin copies run outdated code", doc)
        os.makedirs(self.env["LEAN_AGENT_HOME"], exist_ok=True)
        with open(os.path.join(self.env["LEAN_AGENT_HOME"], "source"), "w") as fh:
            fh.write(clone)
        doc = subprocess.run(lean + ["doctor", "--fix"], capture_output=True, text=True, env=env).stdout
        self.assertIn("forwarded 1 old hook script(s) to the clone", doc)
        transcript = os.path.join(self.tmp.name, "t.jsonl")
        open(transcript, "w").close()
        ev = {"session_id": "s", "transcript_path": transcript, "cwd": self.tmp.name, "tool_name": "Bash",
              "tool_input": {"command": "ls"}}
        p = subprocess.run([sys.executable, os.path.join(old, "budget_hook.py")], input=json.dumps(ev),
                           capture_output=True, text=True, env=env)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertNotIn("old cap", p.stdout)  # the clone's hook ran instead

    def test_sync_pulls_updates_plugin_and_refreshes(self):
        clone, other, g = self.make_clone()
        cli = os.path.join(clone, "bin", "lean-agent")
        env = dict(self.env)

        def run(*args):
            p = subprocess.run([cli, *args], capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL)
            self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
            return p.stdout
        run("learn", self.proj, "--name", "proj")
        run("home")
        with open(os.path.join(self.env["LEAN_AGENT_HOME"], "source")) as fh:
            self.assertEqual(fh.read().strip(), clone)  # the plugin's hooks/CLI now follow the clone
        guide = os.path.join(other, "plugins", "lean-agent", "templates", "guide.md")
        with open(guide, "a") as fh:
            fh.write("\nSYNC-MARKER: new rule from upstream.\n")
        g(other, "commit", "-qam", "new guide rule")
        g(other, "push", "-q")
        out = run("sync")
        self.assertIn("pulled 1 commit(s)", out)
        self.assertIn("new guide rule", out)
        self.assertIn("orchestrator guide: changed", out)
        self.assertIn("re-learned: proj", out)
        self.assertIn("no need to restart `lean-agent up`", out)
        with open(os.path.join(self.env["LEAN_AGENT_HOME"], "home", "CLAUDE.md")) as fh:
            self.assertIn("SYNC-MARKER", fh.read())
        self.assertIn(["plugin", "update", "lean-agent@lean-agent"], self.plugin_calls())
        out = run("sync")
        self.assertIn("already up to date", out)
        self.assertIn("Nothing changed for running sessions.", out)
        # local changes: no pull
        with open(os.path.join(clone, "README.md"), "a") as fh:
            fh.write("local edit\n")
        self.assertIn("has local changes; not pulling", run("sync", "--no-learn"))

    def test_trampoline_runs_the_clone(self):
        clone, _, _ = self.make_clone()
        with open(os.path.join(clone, "plugins", "lean-agent", "scripts", "squeeze_hook.py"), "w") as fh:
            fh.write("import sys\nprint('FROM-CLONE', sys.argv[1:], sys.stdin.read())\n")
        os.makedirs(self.env["LEAN_AGENT_HOME"], exist_ok=True)
        with open(os.path.join(self.env["LEAN_AGENT_HOME"], "source"), "w") as fh:
            fh.write(clone + "\n")
        tramp = os.path.join(os.path.dirname(CLI), "trampoline.py")
        p = subprocess.run([sys.executable, tramp, "squeeze_hook.py", "x"], input="stdin-data",
                           capture_output=True, text=True, env=self.env)
        self.assertIn("FROM-CLONE ['x'] stdin-data", p.stdout)
        os.remove(os.path.join(self.env["LEAN_AGENT_HOME"], "source"))  # no clone: use the plugin's own copy
        p = subprocess.run([sys.executable, tramp, "squeeze_hook.py"], input="{}", capture_output=True, text=True,
                           env=self.env)
        self.assertNotIn("FROM-CLONE", p.stdout)
        self.assertEqual(p.returncode, 0)

    def test_optimize_demotes_unused_global_core(self):
        self.cli("learn", self.proj)
        self.cli("card", "core", "proj", "style")
        fb = json.dumps({"status": "done", "used": [], "unneeded": [], "missing": ""})
        for _ in range(5):
            self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "fix it", FAKE_FEEDBACK=fb)
        out = self.cli("optimize", "proj", "--apply").stdout
        self.assertIn("core for every task but used in only 0/5", out)
        self.assertNotIn("*style", self.cli("cards", "proj").stdout)

    def test_budget_includes_workers_and_labels_cap(self):
        self.cli("learn", self.proj)
        self.write_usage("-orch-home", 0.5, "claude-sonnet-5-5", 10000, "o1")
        transcript = os.path.join(self.env["CLAUDE_CONFIG_DIR"], "projects", "-orch-home", "s.jsonl")
        os.rename(transcript, os.path.join(os.path.dirname(transcript), "orch-1.jsonl"))
        transcript = os.path.join(os.path.dirname(transcript), "orch-1.jsonl")
        self.cli("run", "proj", "-m", "haiku", "--why", "x", "t", CLAUDE_CODE_SESSION_ID="orch-1")
        self.cli("run", "proj", "-m", "sonnet", "--why", "x", "t", CLAUDE_CODE_SESSION_ID="orch-1")
        self.cli("run", "proj", "-m", "sonnet", "--why", "x", "t", CLAUDE_CODE_SESSION_ID="someone-else")
        out = self.cli("budget", transcript).stdout
        self.assertIn("Workers and reviewers started from this session (2 runs):", out)
        self.assertIn("Combined (this session + its workers): 13,255 sonnet-eq", out)  # 10,000 + 3,100 + 155
        self.assertIn("No session cap set", out)
        self.assertNotIn("%", out.split("Workers")[0])
        out = self.cli("budget", transcript, LEAN_AGENT_BUDGET="40000").stdout
        self.assertIn("Self-set session spend cap (LEAN_AGENT_BUDGET, not your Claude plan and not the context window): 10,000 / 40,000 sonnet-eq billed over all turns", out)

    def test_home_template(self):
        h = self.cli("home").stdout.strip()
        with open(os.path.join(h, "CLAUDE.md")) as fh:
            self.assertIn("lean-agent orchestrator", fh.read())
        self.assertTrue(os.path.exists(os.path.join(h, ".claude", "settings.json")))


class RuleGlobTest(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, os.path.dirname(CLI))
        import lean_common
        import lean_agent
        self.common, self.agent = lean_common, lean_agent

    def test_task_id_of_reads_hash_ticket_key_and_prefixed_refs(self):
        t = self.agent.task_id_of
        self.assertEqual(t("#7"), "7")
        self.assertEqual(t("ABC-12"), "ABC-12")
        self.assertEqual(t("AB#4711"), "4711")
        self.assertEqual(t("PR 512"), "512")
        self.assertIsNone(t("no id"))
        self.assertIsNone(t(None))

    def test_glob_match_keeps_leading_dots_and_strips_only_dot_slash(self):
        m = self.common.glob_match
        self.assertTrue(m(".claude/rules/*.md", ".claude/rules/x.md"))
        self.assertTrue(m(".claude/rules/*.md", "./.claude/rules/x.md"))
        self.assertTrue(m(".claude/rules/*.md", "././.claude/rules/x.md"))
        self.assertFalse(m("claude/rules/*.md", ".claude/rules/x.md"))
        self.assertFalse(m("a/*.md", "../a/x.md"))
        self.assertTrue(m("**/appsettings*.json", "src/Web/appsettings.Development.json"))
        self.assertTrue(m("**/appsettings*.json", "appsettings.json"))
        self.assertTrue(m("src/**/*.cs", "src/a/b.cs"))
        self.assertFalse(m("src/*.cs", "src/a/b.cs"))
        self.assertTrue(m("*.{ts,tsx}", "web/x.tsx"))

    def test_an_always_included_claude_md_already_sent_still_suppresses_the_intro(self):
        def card(i, kind, source, **kw):
            return dict({"id": i, "kind": kind, "source": source, "tokens": 5}, **kw)
        cards = [card("intro", "claude-md", "CLAUDE.md"), card("sec", "claude-md", "CLAUDE.md"), card("r", "rule", ".claude/rules/r.md")]
        got = self.agent.rule_cards_for(cards, "", [], [], 100, {"intro"})
        self.assertEqual([c["id"] for c in got], ["r"])
        got = self.agent.rule_cards_for(cards, "", [], [], 100, set())
        self.assertEqual([c["id"] for c in got], ["intro", "r"])


if __name__ == "__main__":
    import gha_runner
    gha_runner.main(__file__)
