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

CLI = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts", "lean_agent.py")

FAKE_CLAUDE = textwrap.dedent("""\
    #!/usr/bin/env python3
    import json, os, sys
    if sys.argv[1:2] == ["plugin"]:
        with open(os.environ["FAKE_LOG"], "a") as fh:
            fh.write(json.dumps({"plugin": sys.argv[1:]}) + "\\n")
        sys.exit(0)
    task = sys.stdin.read()
    if "stream-json" in sys.argv:  # session probe used by `lean-agent chrome check`
        chrome = "--chrome" in sys.argv and os.environ.get("FAKE_CHROME") == ("strict" if "--strict-mcp-config" in sys.argv else "loose") 
        tools = ["Read"] + (["mcp__claude-in-chrome__navigate", "mcp__claude-in-chrome__find",
                             "mcp__claude-in-chrome__form_input", "mcp__claude-in-chrome__gif_creator"] if chrome else [])
        servers = [{"name": "claude-in-chrome", "status": "connected"}] if chrome else []
        extra = 0
        if "--mcp-config" in sys.argv:  # an http server probe: FAKE_HTTP_TOOLS={"<server>": [tools]}
            cfg = json.load(open(sys.argv[sys.argv.index("--mcp-config") + 1]))["mcpServers"]
            for name, c in cfg.items():
                ok = os.environ.get("FAKE_HTTP_URL", "") in c.get("url", "")
                servers.append({"name": name, "status": "connected" if ok else "needs-auth"})
                if ok:
                    names = json.loads(os.environ.get("FAKE_HTTP_TOOLS") or "{}").get(name, [])
                    pre = "mcp__" + "".join(ch if ch.isalnum() or ch in "_-" else "_" for ch in name) + "__"
                    tools += [pre + t for t in names]
                    extra += 400 * len(names)
        print(json.dumps({"type": "system", "subtype": "init", "tools": tools, "mcp_servers": servers}))
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
            fh.write(json.dumps({"type": "assistant", "timestamp": ts, "message": {"content": [
                {"type": "tool_use", "id": "tu-" + str(os.getpid()), "name": os.environ["FAKE_MCP_CALL"], "input": {}}]}}) + "\\n")
    with open(log, "a") as fh:
        fh.write(json.dumps({"argv": sys.argv[1:], "cwd": os.getcwd(), "task": task,
                             "append": open(append).read(), "mcp": mcp,
                             "automem": os.environ.get("CLAUDE_CODE_DISABLE_AUTO_MEMORY"),
                             "addclaudemd": os.environ.get("CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD")}) + "\\n")
    import time
    if os.environ.get("FAKE_FINISH_AT"):  # make parallel fake workers finish together
        time.sleep(max(0.0, float(os.environ["FAKE_FINISH_AT"]) - time.time()))
    fb = os.environ.get("FAKE_FEEDBACK", '{"status": "done", "used": [], "unneeded": [], "missing": ""}')
    print(json.dumps({"type": "result", "subtype": os.environ.get("FAKE_SUBTYPE", "success"), "is_error": False,
                      "num_turns": 3, "session_id": "sess-1", "total_cost_usd": 0.05,
                      "result": "Did the thing.\\n" + (("LEAN-REVIEW " + os.environ["FAKE_REVIEW"] + "\\n")
                                                         if os.environ.get("FAKE_REVIEW") else "") + "LEAN-FEEDBACK " + fb,
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
                        HOME=t, CLAUDE_CONFIG_DIR=os.path.join(t, "cfg"))
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
        self.assertEqual(call["task"], "fix the test")
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
        self.assertIn("Plan % unknown", out)
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
        self.assertIn("read (automatic)  3 tools ~1,200 tok  get_monitor, query_metrics, search_logs", self.cli("mcp", "preset", "dd", **env).stdout)
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
        self.assertIn("plugin MCP server plugin:dd:mcp: needs-auth when connected as a worker", doc)
        settings["enabledPlugins"]["dd@mkt"] = False
        with open(os.path.join(cfg, "settings.json"), "w") as fh:
            json.dump(settings, fh)
        self.assertNotIn("plugin:dd", self.cli("mcp", "list", **env).stdout)

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
        self.assertEqual(self.calls()[-1]["task"], "find things")
        self.cli("run", "-m", "haiku", "--why", "x", "-p", "proj", "first", "--read-only", "second")
        self.assertEqual(self.calls()[-1]["task"], "first second")

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
        self.assertIn("lean-agent run [--project PROJECT]", guide)  # generated reference
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
        self.assertIn("tickets:read (automatic)  2 tools", out)  # get_ticket + search_tickets
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
        review = json.dumps({"verdict": "changes-requested", "findings": [
            {"severity": "minor", "file": "web/page.txt", "line": 1, "issue": "placeholder text"},
            {"severity": "blocker", "file": "api/totals.py", "line": 2, "issue": "float money math",
             "suggestion": "use integer cents"}],
            "checks": [{"what": "run pytest -q", "why": "no test covers total()"}]})
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
        approve = json.dumps({"verdict": "approve", "findings": [], "checks": []})
        p = self.cli("review", "proj", "--resume", check=False, FAKE_REVIEW=approve)
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

    def test_review_a_ref_without_checkout(self):
        g = self.git_project()
        g("add", "-A")
        g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "page")
        g("checkout", "-q", "main")  # the user works on main; the PR branch isn't checked out
        self.cli("learn", self.proj, "--name", "proj")
        approve = json.dumps({"verdict": "approve", "findings": [], "checks": []})
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
        self.assertIn("feature is now at", self.calls()[-1]["task"])
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
        bad = json.dumps({"verdict": "changes-requested", "checks": [], "findings": [
            {"severity": "major", "file": "api/totals.py", "line": 3, "issue": "rounding drops cents"}]})
        self.cli("review", "proj", "--head", "feature", "--base", "main", check=False, FAKE_REVIEW=bad)
        commit_fix("# fix 4\n")
        out = self.cli("review", "proj", "--head", "feature", "--base", "main", FAKE_REVIEW=approve).stdout
        self.assertIn("passing 1 earlier findings", out)
        self.assertIn("[major] api/totals.py:3 rounding drops cents", self.calls()[-1]["task"])

    def test_shared_worktree_for_workers(self):
        g = self.git_project()
        g("add", "-A")
        g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "page")
        g("checkout", "-q", "main")
        self.cli("learn", self.proj, "--name", "proj")
        out = self.cli("run", "proj", "-m", "haiku", "--why", "x", "--worktree", "feature", "--", "run the tests").stdout
        self.assertIn("worktree: feature at", out)
        self.assertIn("(created, on branch feature)", out)
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
        self.assertIn("(reused, on branch feature)", out)
        self.assertTrue(os.path.isdir(os.path.join(wt, "node_modules")))  # persisted for the next worker
        run_id = out.split("run ")[1].split()[0]
        self.cli("run", "--resume", run_id, "and the fixtures")
        self.assertEqual(self.calls()[-1]["argv"][self.calls()[-1]["argv"].index("--add-dir") + 1], wt)
        # the branch checked out in the user's repo can't be attached again: detached worktree
        out = self.cli("run", "proj", "-m", "haiku", "--why", "x", "--worktree", "main", "--", "t").stdout
        self.assertIn("(created, detached)", out)
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
        approve = json.dumps({"verdict": "approve", "findings": [], "checks": []})
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
        self.assertIn("Self-set session cap (LEAN_AGENT_BUDGET, not your Claude plan): 10,000 / 40,000", out)

    def test_home_template(self):
        h = self.cli("home").stdout.strip()
        with open(os.path.join(h, "CLAUDE.md")) as fh:
            self.assertIn("lean-agent orchestrator", fh.read())
        self.assertTrue(os.path.exists(os.path.join(h, ".claude", "settings.json")))


if __name__ == "__main__":
    unittest.main(verbosity=2)
