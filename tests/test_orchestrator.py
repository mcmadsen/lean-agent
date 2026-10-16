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
    task = sys.stdin.read()
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
                      "result": "Did the thing.\\nLEAN-FEEDBACK " + fb,
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
            return [json.loads(l) for l in fh]

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
        self.assertIn("testing", out.splitlines()[0])

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
        self.assertEqual(first["argv"][first["argv"].index("--tools") + 1], "Read,Glob,Grep")
        self.assertEqual(second["argv"][second["argv"].index("--resume") + 1], "sess-1")
        self.assertEqual(second["argv"][second["argv"].index("--tools") + 1], "Read,Glob,Grep")

    def test_optimize_promotes_core(self):
        self.cli("learn", self.proj)
        fb = json.dumps({"status": "done", "used": ["testing"], "unneeded": ["style"], "missing": ""})
        for _ in range(3):
            self.cli("run", "-p", "proj", "-m", "sonnet", "--why", "x", "--cards", "testing,style", "t",
                     FAKE_FEEDBACK=fb)
        out = self.cli("optimize", "proj", "--apply").stdout
        self.assertIn("core    testing", out)
        self.assertIn("archive style", out)
        self.cli("run", "-p", "proj", "-m", "sonnet", "--why", "x", "t2", FAKE_FEEDBACK=fb)
        self.assertIn("sqlite fixture", self.calls()[-1]["append"])  # core card sent without --cards

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

    def test_daily_budget_blocks(self):
        self.cli("learn", self.proj)
        self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "t")
        p = self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "t", check=False,
                     LEAN_AGENT_DAILY_BUDGET="1000")
        self.assertEqual(p.returncode, 3)
        self.assertIn("daily budget", p.stderr)

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

    def test_optimize_suggests_mcp_narrowing(self):
        self.cli("learn", self.proj)
        for _ in range(3):
            self.cli("run", "-p", "proj", "-m", "haiku", "--why", "x", "--mcp", "tickets", "t",
                     FAKE_MCP_CALL="mcp__tickets__get_ticket")
        out = self.cli("optimize", "proj").stdout
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

    def test_home_template(self):
        h = self.cli("home").stdout.strip()
        with open(os.path.join(h, "CLAUDE.md")) as fh:
            self.assertIn("lean-agent orchestrator", fh.read())
        self.assertTrue(os.path.exists(os.path.join(h, ".claude", "settings.json")))


if __name__ == "__main__":
    unittest.main(verbosity=2)
