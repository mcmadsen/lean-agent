"""0.45.72: `lean-agent compare <project>`: a clean Claude Code session against lean-agent's, with a fake claude."""
import glob
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(HERE, "..", "plugins", "lean-agent", "scripts")
CLI = os.path.join(SCRIPTS, "lean_agent.py")

FAKE = r'''#!/usr/bin/env python3
import json, os, sys
a = sys.argv[1:]
flags = ["--tools", "--strict-mcp-config", "--mcp-config", "--settings", "--disable-slash-commands", "--setting-sources",
         "--system-prompt", "--append-system-prompt-file", "--safe-mode", "--max-turns"]
if "--help" in a:
    print("\n".join("  " + f + " <x>" for f in flags if f not in os.environ.get("FAKE_MISSING", "").split(",")))
    sys.exit(0)
prompt = sys.stdin.read()
with open(os.environ["FAKE_LOG"], "a") as fh:
    fh.write(json.dumps({"args": a, "env": sorted(k for k in os.environ if k.startswith("LEAN_AGENT_")),
                         "cwd": os.getcwd()}) + "\n")
def val(f):
    return a[a.index(f) + 1] if f in a else None
n = 50000
if "--append-system-prompt-file" in a:
    n = 20000
elif "--system-prompt" in a:
    n = 2000
elif "disableAllHooks" in (val("--settings") or ""):
    n = 30000
else:
    if val("--tools") == "":
        n -= 16000
    if "--strict-mcp-config" in a:
        n -= 3000
    if "--disable-slash-commands" in a:
        n -= 9000
    if "claudeMdExcludes" in (val("--settings") or ""):
        n -= 11000
text = "OK"
if "--safe-mode" in a:
    text = json.dumps({"winner": "B", "reason": "more complete"})
elif "OK." not in prompt:
    text = "the answer is 42"
print(json.dumps({"type": "system", "subtype": "init", "model": "claude-haiku-5-5",
                  "tools": ["Bash", "Read", "mcp__tick__get", "mcp__tick__list"],
                  "mcp_servers": [{"name": "tick", "status": "connected"}], "slash_commands": ["a", "b"]}))
print(json.dumps({"type": "assistant", "message": {"usage": {"input_tokens": 10, "cache_creation_input_tokens": n - 10,
                  "cache_read_input_tokens": 0, "output_tokens": 5}}}))
print(json.dumps({"type": "result", "subtype": "success", "result": text, "num_turns": 1, "total_cost_usd": 0.01,
                  "usage": {"input_tokens": 10, "cache_creation_input_tokens": n - 10, "cache_read_input_tokens": 0,
                            "output_tokens": 5}}))
'''


class CompareBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.proj = os.path.join(self.tmp, "proj")
        os.makedirs(self.proj)
        subprocess.run(["git", "init", "-q", self.proj], check=True)
        with open(os.path.join(self.proj, "CLAUDE.md"), "w") as fh:
            fh.write("# rules\n" + "x" * 4000 + "\nSECRET-CONTENT\n")
        self.fake = os.path.join(self.tmp, "claude")
        with open(self.fake, "w") as fh:
            fh.write(FAKE)
        os.chmod(self.fake, 0o755)
        self.log = os.path.join(self.tmp, "calls.jsonl")
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("LEAN_AGENT_")}
        self.env.update(LEAN_AGENT_HOME=os.path.join(self.tmp, "home"), LEAN_AGENT_TEST="1", LEAN_AGENT_CLAUDE=self.fake,
                        FAKE_LOG=self.log, HOME=self.tmp)
        r = self.cli("learn", self.proj)
        self.assertEqual(r.returncode, 0, r.stderr)

    def cli(self, *args, **env):
        return subprocess.run([sys.executable, CLI, *args], capture_output=True, text=True, timeout=120,
                              env=dict(self.env, **env))

    def calls(self):
        return [json.loads(l) for l in open(self.log)] if os.path.exists(self.log) else []

    def report(self):
        files = glob.glob(os.path.join(self.tmp, "home", "compare", "*.json"))
        self.assertEqual(len(files), 1)
        return json.load(open(files[0])), files[0]



class Compare(CompareBase):
    def test_overhead_table_and_attribution(self):
        r = self.cli("compare", "proj", "--max-usd", "1")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        rep, _ = self.report()
        clean = rep["columns"]["clean"]
        self.assertEqual(clean["total"], 50000)
        rows = clean["rows"]
        self.assertEqual(rows["tools"], {"tokens": 16000, "how": "measured"})
        self.assertEqual(rows["mcp"]["tokens"], 3000)
        self.assertEqual(rows["skills"]["tokens"], 9000)
        self.assertEqual(rows["memory"]["tokens"], 11000)
        self.assertEqual(rows["messages"], {"tokens": 2000, "how": "measured"})
        self.assertEqual(rows["system prompt"]["tokens"], 50000 - 16000 - 3000 - 9000 - 11000 - 2000)
        self.assertEqual(rep["columns"]["worker"]["total"], 20000)
        self.assertEqual(rep["columns"]["thread session"]["total"], 30000)
        self.assertIn("front desk", rep["columns"])
        for head in ("clean", "worker", "thread session", "front desk", "Total", "Fixed overhead", "memory files", "skills"):
            self.assertIn(head, r.stdout)
        self.assertEqual(rep["saving_pct"], 60)
        self.assertIn("cost of this comparison", r.stdout)
        self.assertTrue(any("front desk start injects" in s for s in rep["suggestions"]))
        self.assertTrue(any("MCP server tick" in s for s in rep["suggestions"]))
        self.assertTrue(any("loads none" in s for s in rep["suggestions"]))

    def test_estimated_rows_when_flag_missing(self):
        r = self.cli("compare", "proj", FAKE_MISSING="--tools,--disable-slash-commands")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        rep, _ = self.report()
        rows = rep["columns"]["clean"]["rows"]
        self.assertEqual(rows["tools"]["how"], "estimated")
        self.assertEqual(rows["skills"]["how"], "estimated")
        self.assertEqual(rows["mcp"]["how"], "measured")
        self.assertIn("~", r.stdout)

    def test_clean_run_has_no_lean_agent_env(self):
        self.cli("compare", "proj")
        clean_calls = [c for c in self.calls() if c["cwd"] == os.path.realpath(self.proj) and "--add-dir" not in c["args"]]
        self.assertTrue(clean_calls)
        for c in clean_calls:
            self.assertEqual(c["env"], [], c)
        worker = [c for c in self.calls() if "--append-system-prompt-file" in c["args"]]
        self.assertTrue(worker and "--disable-slash-commands" in worker[0]["args"])

    def test_report_has_no_contents(self):
        self.cli("compare", "proj")
        _, path = self.report()
        text = open(path).read()
        self.assertNotIn("SECRET-CONTENT", text)
        self.assertIn("CLAUDE.md", text)  # names yes

    def test_history_and_optimize(self):
        self.cli("compare", "proj")
        h = self.cli("compare", "--history")
        self.assertEqual(h.returncode, 0, h.stderr)
        self.assertIn("proj", h.stdout)
        self.assertIn("overhead", h.stdout)
        self.assertIn("60%", h.stdout)
        o = self.cli("optimize", "proj")
        self.assertIn("From the latest compare", o.stdout)
        self.assertIn("front desk start injects", o.stdout)
        oj = self.cli("optimize", "proj", "--json")
        self.assertTrue(json.loads(oj.stdout)["compare"])

    def test_cap_and_yes(self):
        r = self.cli("compare", "proj", "--max-usd", "2")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("--yes", r.stderr + r.stdout)
        self.assertEqual(self.calls(), [])
        r = self.cli("compare", "proj", "--max-usd", "0.02")  # two calls at $0.01, then the cap
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("cap reached", r.stdout)
        self.assertLessEqual(len(self.calls()), 4)

    def test_unlearned_refused(self):
        other = os.path.join(self.tmp, "other")
        os.makedirs(other)
        r = self.cli("compare", other)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("not learned", r.stderr + r.stdout)
        self.assertEqual(self.calls(), [])

    def test_task_mode_with_judge(self):
        r = self.cli("compare", "proj", "--task", "where is the entry point", "--max-turns", "3")
        self.assertIn("expected cost", r.stdout)
        self.assertIn("judge:", r.stdout, r.stdout + r.stderr)
        rep, path = self.report()
        self.assertEqual(rep["mode"], "task")
        self.assertEqual(rep["task"]["judge"]["winner"], "lean-agent")
        self.assertNotIn("entry point", open(path).read())
        clean = [c for c in self.calls() if "--tools" in c["args"] and "Read,Glob,Grep" in c["args"] and "--add-dir" not in c["args"]]
        self.assertTrue(clean and clean[0]["env"] == [])
        self.assertNotIn("Bash", clean[0]["args"][clean[0]["args"].index("--tools") + 1])

    def test_shortcut_routes_to_a_front_desk_job(self):
        sys.path.insert(0, SCRIPTS)
        import lean_threads
        os.environ["LEAN_AGENT_HOME"] = os.path.join(self.tmp, "home")
        tid, line, kind = lean_threads.decide("compare proj", lean_threads.load())
        self.assertEqual(kind, "job")
        self.assertIn("lean-agent compare proj", line)


class MemoryBreakdown(CompareBase):
    """Memory sources per session kind, usage evidence and suggestions, on a fixture with nested CLAUDE.md, an @import and cards."""

    def setUp(self):
        super().setUp()
        with open(os.path.join(self.tmp, "CLAUDE.md"), "w") as fh:  # a CLAUDE.md in a parent folder
            fh.write("# parent\n" + "p" * 400 + "\n")
        os.makedirs(os.path.join(self.proj, "docs"))
        with open(os.path.join(self.proj, "docs", "arch.md"), "w") as fh:
            fh.write("# Architecture overview\n" + "a" * 6000 + "\nIMPORT-SECRET\n")
        with open(os.path.join(self.proj, "CLAUDE.md"), "a") as fh:
            fh.write("see @docs/arch.md\n")
        sys.path.insert(0, SCRIPTS)
        self.old_env = {k: os.environ.get(k) for k in ("LEAN_AGENT_HOME", "HOME", "LEAN_AGENT_TEST")}
        os.environ.update(LEAN_AGENT_HOME=os.path.join(self.tmp, "home"), HOME=self.tmp, LEAN_AGENT_TEST="1")
        import lean_agent
        self.la = lean_agent
        self.cards = [{"id": "card-a", "title": "A", "kind": "note", "text": "a" * 400, "tokens": 100, "core": True, "offered": 0, "used": 0, "unneeded": 0},
                      {"id": "card-b", "title": "B", "kind": "note", "text": "b" * 400, "tokens": 100, "core": True, "offered": 0, "used": 0, "unneeded": 0}]
        self.la.save_cards(self.slug(), self.cards)

    def tearDown(self):
        for k, v in self.old_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def slug(self):
        return next(iter(self.la.projects())) if hasattr(self, "la") else None

    def breakdown(self, kinds=("clean", "worker", "thread session", "front desk")):
        import lean_compare
        self.la.prepare_home()
        return lean_compare, lean_compare.memory_breakdown(self.la, self.slug(), self.proj, list(kinds))

    def test_sources_per_kind(self):
        _, by = self.breakdown()
        clean = {s["name"]: s for s in by["clean"]}
        self.assertIn("CLAUDE.md", clean)
        self.assertIn("docs/arch.md", clean)  # the @import
        self.assertGreater(clean["docs/arch.md"]["tokens"], 1400)
        self.assertEqual(clean["docs/arch.md"]["kind"], "import")
        self.assertTrue(any(n.endswith("CLAUDE.md") and n != "CLAUDE.md" for n in clean))  # the parent's, nested
        self.assertTrue(any(s["name"].startswith("card:") for s in by["worker"]))
        self.assertTrue(any(s["kind"] == "protocol" for s in by["worker"]))
        thread = [s["name"] for s in by["thread session"]]
        self.assertTrue(any("thread brief" in n for n in thread))
        self.assertTrue(any("thread line" in n for n in thread))
        self.assertFalse(any("front-desk.md" in n for n in thread))  # threads leave the front-desk guide out
        desk = [s["name"] for s in by["front desk"]]
        self.assertTrue(any("front-desk.md" in n for n in desk))
        self.assertTrue(any("hand-off" in n for n in desk))
        self.assertFalse(any(n == "CLAUDE.md" for n in desk))

    def test_usage_counts_from_feedback(self):
        lc, by = self.breakdown(("worker",))
        ids = [s["name"][5:] for s in by["worker"] if s["kind"] == "card"]
        self.assertTrue(ids)
        cid = ids[0]
        ledger = []
        for i in range(4):
            wd = os.path.join(self.tmp, f"run{i}")
            os.makedirs(wd)
            fb = {"used": [cid] if i < 3 else [], "unneeded": [] if i < 3 else [cid]}
            with open(os.path.join(wd, "result.json"), "w") as fh:
                fh.write(json.dumps({"result": "done\nLEAN-FEEDBACK " + json.dumps(fb)}) + "\n")
            ledger.append({"id": f"r{i}", "project": self.slug(), "cards": ids, "workdir": wd})
        with open(os.path.join(self.tmp, "home", "ledger.jsonl"), "w") as fh:
            fh.write("".join(json.dumps(r) + "\n" for r in ledger))
        mem = lc.usage_evidence(self.la, self.slug(), self.proj, by)
        card = next(e for e in mem["sources"] if e["name"] == "card:" + cid)
        self.assertEqual((card["used"], card["of"], card["unneeded"]), (3, 4, 1))
        self.assertEqual(mem["runs_examined"], 4)
        self.assertEqual(card["loaded_by"], ["worker"])

    def test_document_usage_from_transcript_tool_calls_and_unknown(self):
        lc, by = self.breakdown(("clean",))
        mem = lc.usage_evidence(self.la, self.slug(), self.proj, by)
        self.assertTrue(all(e["used"] is None and e["evidence"] == "unknown" for e in mem["sources"]))
        sid = "11111111-2222-3333-4444-555555555555"
        tp = self.la.service_session.transcript_path(self.proj, sid)
        os.makedirs(os.path.dirname(tp), exist_ok=True)
        with open(tp, "w") as fh:
            fh.write(json.dumps({"message": {"content": [{"type": "tool_use", "name": "Read",
                                                          "input": {"file_path": self.proj + "/docs/arch.md"}}]}}) + "\n")
            fh.write(json.dumps({"message": {"content": [{"type": "text", "text": "CLAUDE.md mentioned in text only"}]}}) + "\n")
        with open(os.path.join(self.tmp, "home", "ledger.jsonl"), "w") as fh:
            fh.write(json.dumps({"id": "r1", "project": self.slug(), "session_id": sid}) + "\n")
        mem = lc.usage_evidence(self.la, self.slug(), self.proj, by)
        src = {e["name"]: e for e in mem["sources"]}
        self.assertEqual((src["docs/arch.md"]["used"], src["docs/arch.md"]["of"]), (1, 1))
        self.assertEqual(src["CLAUDE.md"]["used"], 0)

    def test_suggestions_keep_and_card_candidate(self):
        import lean_compare
        mem = {"sources": [
            {"name": "CLAUDE.md", "kind": "claude-md", "tokens": 3000, "loaded_by": ["thread session"], "used": 2, "of": 5},
            {"name": "docs/arch.md", "kind": "import", "tokens": 1600, "loaded_by": ["clean", "thread session"], "used": None, "of": None},
            {"name": "small.md", "kind": "import", "tokens": 200, "loaded_by": ["thread session"], "used": None, "of": None},
            {"name": "big-worker-only.md", "kind": "import", "tokens": 5000, "loaded_by": ["worker"], "used": None, "of": None}]}
        lines = lean_compare.memory_suggestions(mem)
        self.assertEqual(len(lines), 2)
        self.assertIn("keep (rules)", lines[0])
        self.assertIn("candidate for a card", lines[1])
        self.assertIn("saves ~1.6k tokens per thread start", lines[1])
        self.assertIn("usage unknown", lines[1])

    def test_report_json_table_and_optimize(self):
        r = self.cli("compare", "proj", "--max-usd", "1")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("Memory sources at start", r.stdout)
        rep, path = self.report()
        mem = rep["memory"]
        self.assertEqual(set(mem["by_kind"]), {"clean", "worker", "thread session", "front desk"})
        self.assertIn("docs/arch.md", [s["name"] for s in mem["by_kind"]["clean"]])
        text = open(path).read()
        for secret in ("IMPORT-SECRET", "SECRET-CONTENT"):
            self.assertNotIn(secret, text)
        for e in mem["sources"]:
            self.assertEqual(set(e) - {"unneeded"}, {"name", "kind", "tokens", "loaded_by", "own", "used", "of", "evidence"})
            self.assertIsInstance(e["tokens"], int)
        o = self.cli("optimize", "proj")
        self.assertIn("From the latest compare", o.stdout)


if __name__ == "__main__":
    unittest.main()
