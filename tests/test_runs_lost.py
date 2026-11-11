"""0.45.54: lost runs stay showable/resumable, `runs` lists one row per id with one-line tasks, strict hook parsing."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)

import budget_hook  # noqa: E402
import lean_agent as agent  # noqa: E402

RID = "1101-120000-ab12"
OTHER = "1101-130000-ab99"


class Home(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.tmp, "running"))
        self.work = os.path.join(self.tmp, "work", RID)
        os.makedirs(self.work)
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("LEAN_AGENT_")}
        self.env["LEAN_AGENT_HOME"] = self.tmp

    def marker(self, rid=RID, **kw):
        m = {"run": rid, "pid": 2 ** 22 + 7, "started": "2026-11-01T12:00:00", "model": "sonnet", "project": "demo",
             "task": "first line\nsecond line", "workdir": self.work, "role": None}
        m.update(kw)
        with open(os.path.join(self.tmp, "running", rid + ".json"), "w") as fh:
            json.dump(m, fh)

    def ledger(self, *rows):
        with open(os.path.join(self.tmp, "ledger.jsonl"), "a") as fh:
            for r in rows:
                fh.write(json.dumps(r) + "\n")

    def cli(self, *args):
        return subprocess.run([sys.executable, os.path.join(ROOT, "lean_agent.py"), *args], env=self.env,
                              capture_output=True, text=True, timeout=60, cwd=self.tmp)


class LostRuns(Home):
    def test_show_by_full_id_and_prefix(self):
        self.marker(session_id="sess-1")
        with open(os.path.join(self.work, "summary-1.txt"), "w") as fh:
            fh.write("partial result so far\n")
        with open(os.path.join(self.work, "progress.jsonl"), "w") as fh:
            fh.write(json.dumps({"ts": "2026-11-01T12:01:02", "turn": 3, "ctx": 900, "steps": "edited a.py"}) + "\n")
        for target in (RID, RID[:9]):
            out = self.cli("runs", "--show", target)
            self.assertEqual(out.returncode, 0, out.stderr)
            self.assertIn("lost", out.stdout)
            self.assertIn("partial result so far", out.stdout)
            self.assertIn("turn 3", out.stdout)
            self.assertIn(f"lean-agent run --resume {RID}", out.stdout)

    def test_show_without_session_offers_from_run(self):
        self.marker()
        out = self.cli("runs", "--show", RID[:8])
        self.assertIn(f"--from-run {RID}", out.stdout)
        self.assertIn("can't be resumed", out.stdout)

    def test_find_run_merges_the_thin_ledger_row_with_the_marker(self):
        self.marker(session_id="sess-1")
        self.ledger({"id": RID, "status": "lost (no record)", "model": "?", "project": "demo", "task": "x", "ts": "t"})
        with mock.patch.dict(os.environ, self.env, clear=True):
            r = agent.find_run(RID[:10])
        self.assertTrue(r["lost"])
        self.assertEqual((r["session_id"], r["workdir"]), ("sess-1", self.work))

    def test_resume_checks(self):
        self.marker(session_id="sess-1")
        self.marker(OTHER, workdir=os.path.join(self.tmp, "work", OTHER))
        with mock.patch.dict(os.environ, self.env, clear=True):
            self.assertEqual(agent.find_run(RID)["session_id"], "sess-1")
            self.assertIn("--from-run " + OTHER, agent.lost_no_session(agent.find_run(OTHER)))
            self.assertIsNone(agent.find_run("9999"))

    def test_ambiguous_prefix_is_named(self):
        self.marker()
        self.marker(OTHER)
        out = self.cli("runs", "--show", "1101-1")
        self.assertNotEqual(out.returncode, 0)
        self.assertIn("ambiguous", out.stderr + out.stdout)


class ListRows(Home):
    def row(self, rid, status, task="t"):
        return {"id": rid, "status": status, "model": "sonnet", "project": "demo", "task": task, "ts": "t"}

    def test_one_row_per_id_newest_state_wins(self):
        self.ledger(*[self.row(OTHER, "failed") for _ in range(9)], self.row(OTHER, "done"))
        self.ledger(self.row(RID, "lost (no record)"))
        self.marker()
        out = self.cli("runs").stdout.splitlines()
        self.assertEqual([l for l in out if l.startswith(OTHER)].__len__(), 1)
        self.assertIn("done", [l for l in out if l.startswith(OTHER)][0])
        self.assertEqual(len([l for l in out if l.startswith(RID)]), 1)
        self.assertIn(" lost ", [l for l in out if l.startswith(RID)][0])

    def test_multiline_task_is_one_truncated_line(self):
        self.ledger(self.row(OTHER, "done", "line one\nline two " + "word " * 40))
        out = self.cli("runs").stdout.splitlines()
        rows = [l for l in out if l.startswith(OTHER)]
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0].endswith("…"))
        self.assertEqual(len(out), 1)
        self.assertEqual(agent.one_line("a\n  b", 10), "a b")


class StrictParsing(unittest.TestCase):
    CASES = [
        "lean-agent run --resume ab12 --why 'x' --max-usd 3 --thread t1 -- \"Carry on. It's done (mostly); don't stop.\n"
        "- first (item)\n- second: it's fine & (more)\n- third\"",
        "lean-agent run --resume ab12 --why 'x' -- \"(\"",
        "lean-agent run --resume ab12 -- \"<<\"",
        "lean-agent run --resume ab12 -- 'it'\"'\"'s \"q\" (x)\n- y'",
        "lean-agent run --resume ab12 --thread t1 --task-file - <<'EOF'\n- it's (a) task\nEOF",
    ]

    def denial(self, cmd):
        with mock.patch.dict(os.environ, {"LEAN_AGENT_SESSION_ROLE": "thread", "LEAN_AGENT_THREAD": "t1"}):
            return budget_hook.strict_denial({"tool_name": "Bash", "tool_input": {"command": cmd}}, "/h", "/h")

    def test_long_quoted_commands_are_lean_agent_commands(self):
        for cmd in self.CASES:
            self.assertTrue(budget_hook.lean_agent_only(cmd), cmd)
            self.assertNotIn("orchestrator runs only", self.denial(cmd))

    def test_unparsable_quoting_says_so(self):
        for cmd in ('lean-agent run --resume ab -- "a `b` c"', 'lean-agent run --resume ab -- "a $(b)"',
                    'lean-agent run --resume ab -- "unterminated'):
            msg = self.denial(cmd)
            self.assertIn("could not parse the quoting of this command; pass long text with --task-file - and a heredoc", msg)
            self.assertNotIn("orchestrator runs only", msg)

    def test_other_commands_keep_the_old_message(self):
        self.assertIn("orchestrator runs only", self.denial("ls -la"))


if __name__ == "__main__":
    unittest.main()
