#!/usr/bin/env python3
"""Tests for the lean-agent CLI using a fake `claude` binary. Run: python3 tests/test_orchestrator.py"""
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest

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
    if sys.argv[1:2] == ["plugin"]:
        with open(os.environ["FAKE_LOG"], "a") as fh:
            fh.write(json.dumps({"plugin": sys.argv[1:]}) + "\\n")
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
                             "append": open(append).read(), "mcp": mcp,
                             "automem": os.environ.get("CLAUDE_CODE_DISABLE_AUTO_MEMORY"),
                             "bash_out": os.environ.get("BASH_MAX_OUTPUT_LENGTH"),
                             "addclaudemd": os.environ.get("CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD")}) + "\\n")
    import time
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
        self.env = dict(os.environ, LEAN_AGENT_HOME=os.path.join(t, "home"), LEAN_AGENT_CLAUDE=fake,
                        FAKE_LOG=self.log, CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD="1",
                        HOME=t, CLAUDE_CONFIG_DIR=os.path.join(t, "cfg"), LEAN_AGENT_LAUNCH_GUARD="0",
                        LEAN_AGENT_HTTP_CHECK="0", LEAN_AGENT_DASHBOARD="0")
        os.makedirs(os.path.join(t, "cfg"))
        fake_mcp = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "fake_mcp.py")
        self.mcp_cfg = {"type": "stdio", "command": sys.executable, "args": [fake_mcp], "env": {"TOKEN": "s3cret"}}
        with open(os.path.join(t, "cfg", ".claude.json"), "w") as fh:
            json.dump({"mcpServers": {"tickets": self.mcp_cfg},
                       "projects": {self.proj: {"mcpServers": {"localdb": {"type": "http", "url": "http://localhost:1"}}}}}, fh)
        with open(os.path.join(self.proj, ".mcp.json"), "w") as fh:
            json.dump({"mcpServers": {"docs": {"type": "http", "url": "https://example.invalid/mcp"}}}, fh)

    def tearDown(self):
        self.tmp.cleanup()

    def cli(self, *args, check=True, **env):
        p = subprocess.run([sys.executable, CLI, *args], capture_output=True, text=True,
                           env=dict(self.env, **env), stdin=subprocess.DEVNULL)
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
        out = self.cli("optimize", "proj", "--accept", ",".join(ids), **env).stdout
        self.assertIn("saved card recipe-widget-value-now-vs-same", out)
        self.assertIn("saved preset plugin:obs:mcp:dashboards", out)
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
            self.assertEqual(fh.read(), "--model sonnet remote-control --name la --debug --debug-file /tmp/rc.log")

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
        self.assertIn("worker registration failed", p.stderr)  # claude's own output still shows
        self.assertIn("the previous Remote Control session is gone", p.stdout)
        self.assertIn("Connected", p.stdout)

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
        out = self.cli("up", LEAN_AGENT_CLAUDE=fake).stdout
        self.assertIn("MCP servers off for the orchestrator itself (workers still get them with --mcp): tickets", out)
        home = self.cli("home").stdout.strip()
        with open(os.path.join(self.env["CLAUDE_CONFIG_DIR"], ".claude.json")) as fh:
            data = json.load(fh)
        self.assertEqual(data["projects"][home]["disabledMcpServers"], ["tickets"])
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
        env = dict(FAKE_PROBE_TOOLS=json.dumps(["Bash", "Read", "Monitor", "NotebookEdit2", "mcp__x__y"]),
                   FAKE_PROBE_AGENTS=json.dumps(["reviewer", "planner"]))
        out = self.cli("context", **env).stdout
        self.assertIn("Start-up context: ~8,000 tokens", out)
        self.assertIn("never called in these sessions: Monitor, NotebookEdit2", out)  # Read is always kept
        self.assertIn("extra.md (~", out)
        self.assertIn("2 agents load here (reviewer, planner)", out)
        self.assertRegex(out, r"~\s*[\d,]+  output    Bash: lean-agent run -p shop -m haiku x")
        self.assertIn("brief mode is off in this session", out)
        out = self.cli("context", "--apply", "--keep", "Monitor", **env).stdout
        self.assertIn("denied 1 tool(s), excluded 1 file(s)", out)
        with open(os.path.join(home, ".claude", "settings.json")) as fh:
            data = json.load(fh)
        self.assertIn("NotebookEdit2", data["permissions"]["deny"])
        self.assertNotIn("Monitor", data["permissions"]["deny"])
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
        self.cli("service", "uninstall", **env)
        self.assertFalse(os.path.exists(plist))
        env = dict(LEAN_AGENT_SERVICE_PLATFORM="linux", LEAN_AGENT_SYSTEMCTL=fake)
        self.cli("service", "install", **env)
        unit = os.path.join(self.tmp.name, ".config", "systemd", "user", "lean-agent.service")
        self.assertIn("Restart=always", open(unit).read())
        self.assertIn("--user enable --now lean-agent.service", open(log).read())

    def test_dashboard_and_status_line(self):
        import socket
        import urllib.request
        import urllib.error
        self.cli("learn", self.proj, "--name", "proj")
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "check the services")
        self.cli("todo", "add", "Fix the export timeout", "-p", "proj", "--prio", "high")
        self.cli("schedule", "add", "weekdays 08:45", "week")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        url = self.cli("dashboard", "--url", "--port", str(port)).stdout.split()[0]
        self.assertTrue(url.startswith(f"http://127.0.0.1:{port}/?t="))
        p = subprocess.Popen([sys.executable, CLI, "dashboard"], env=self.env, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True)
        try:
            for _ in range(50):
                try:
                    page = urllib.request.urlopen(url, timeout=2).read().decode()
                    break
                except OSError:
                    import time as _t
                    _t.sleep(0.1)
            self.assertIn("<title>lean-agent</title>", page)
            token = url.split("t=")[1]
            st = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/api/state?t={token}").read())
            self.assertEqual(st["runs"][0]["status"], "done")
            self.assertEqual(st["todo"][0]["text"], "Fix the export timeout")
            self.assertEqual(st["schedule"][0]["cmd"], "week")
            text = urllib.request.urlopen(f"http://127.0.0.1:{port}/run/{st['runs'][0]['id']}?t={token}").read().decode()
            self.assertIn("Did the thing.", text)
            with self.assertRaises(urllib.error.HTTPError) as e:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/api/state?t=wrong")
            self.assertEqual(e.exception.code, 403)
            self.assertIn("already running", self.cli("dashboard").stdout)
        finally:
            p.terminate()
            p.wait()
        home = self.cli("home").stdout.strip()
        with open(os.path.join(home, ".claude", "settings.json")) as fh:
            line = json.load(fh)["statusLine"]
        self.assertIn("statusline.py", line["command"])
        out = subprocess.run([sys.executable, os.path.join(os.path.dirname(CLI), "statusline.py")],
                             input=json.dumps({"session_id": "x"}), capture_output=True, text=True,
                             env=dict(self.env, CLAUDE_CODE_AUTO_COMPACT_WINDOW="100000",
                                      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE="70")).stdout
        self.assertIn("1 todo", out)
        self.assertIn("next job", out)
        self.assertIn(f"dashboard :{port}", out)

    def test_up_explains_a_folder_served_elsewhere(self):
        fake = os.path.join(self.tmp.name, "claude-busy")
        with open(fake, "w") as fh:
            fh.write(f"#!{sys.executable}\nimport sys\nprint('Error: This folder is already served by a terminal "
                     "`claude remote-control` on this device. Stop it first.')\nsys.exit(1)\n")
        os.chmod(fake, 0o755)
        p = self.cli("up", LEAN_AGENT_CLAUDE=fake, check=False)
        self.assertIn("often the Claude desktop app", p.stdout)

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
        env = dict(self.env, PATH=self.lean_path())
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
        self.cli("home", LEAN_AGENT_ORCHESTRATOR_TRIM="0")
        with open(os.path.join(h, ".claude", "settings.json")) as fh:
            d = json.load(fh)
        self.assertIn("Bash(lean-agent:*)", d["permissions"]["allow"])
        self.assertNotIn("deny", d["permissions"])
        self.assertNotIn("disableBundledSkills", d)
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
        self.assertIn("new commits since", p.stdout)
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
        out = self.cli("review", "proj", "--head", "feature", "--base", "main", FAKE_REVIEW=approve).stdout
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
        env = dict(self.env, FAKE_FINISH_AT=str(time.time() + 1.0))
        cmd = [sys.executable, CLI, "run", "proj", "-m", "haiku", "--why", "x", "--worktree", "feature", "--", "t"]
        self.cli("run", "proj", "-m", "haiku", "--why", "x", "--worktree", "feature", "--", "create it first")
        procs = [subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                  stdin=subprocess.DEVNULL) for _ in range(2)]
        outs = [p.communicate() for p in procs]
        self.assertEqual([p.returncode for p in procs], [0, 0])
        self.assertTrue(any("waiting for another worker" in err for _, err in outs))

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
