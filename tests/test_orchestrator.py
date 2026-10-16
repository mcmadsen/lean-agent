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
    with open(log, "a") as fh:
        fh.write(json.dumps({"argv": sys.argv[1:], "cwd": os.getcwd(), "task": task,
                             "append": open(append).read(),
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
                        FAKE_LOG=self.log, CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD="1")

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

    def test_home_template(self):
        h = self.cli("home").stdout.strip()
        with open(os.path.join(h, "CLAUDE.md")) as fh:
            self.assertIn("lean-agent orchestrator", fh.read())
        self.assertTrue(os.path.exists(os.path.join(h, ".claude", "settings.json")))


if __name__ == "__main__":
    unittest.main(verbosity=2)
