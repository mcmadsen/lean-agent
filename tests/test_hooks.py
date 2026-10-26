#!/usr/bin/env python3
"""Smoke tests for the lean-agent hooks. Run: python3 tests/test_hooks.py"""
import contextlib
import io
import json
import os
import subprocess
import threading
import sys
import tempfile
import unittest
from unittest import mock

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")


def base_env(**extra):
    """The caller's environment minus every LEAN_AGENT_* key, plus what a test asks for."""
    return dict({k: v for k, v in os.environ.items() if not k.startswith("LEAN_AGENT_")}, **extra)


def run_hook(script, event, **env):
    full_env = base_env(**env)
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
        patcher = mock.patch.dict(os.environ, base_env(), clear=True)  # the caller's LEAN_AGENT_* stay out
        patcher.start()
        self.addCleanup(patcher.stop)
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
        p = subprocess.run([sq, sys.executable, script], capture_output=True, text=True, env=base_env(**self.env))
        self.assertEqual(p.returncode, 3)
        self.assertIn("ValueError: bad config", p.stdout)
        self.assertIn('File "app.py", line 3', p.stdout)
        self.assertIn("3,000 download lines", p.stdout)
        self.assertIn("[exit code 3]", p.stdout)
        self.assertLess(len(p.stdout), 2000)
        p = subprocess.run([sq, "echo small"], capture_output=True, text=True, env=base_env(**self.env))
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
                           text=True, input=json.dumps({"cwd": self.tmp.name}), env=base_env(**self.env))
        self.assertEqual(p.stdout, "")  # the user's other sessions compact as usual
        p = subprocess.run([sys.executable, os.path.join(ROOT, "compact_hook.py"), "pre"], capture_output=True,
                           text=True, input=json.dumps({"cwd": home}), env=base_env(**self.env))
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
                           text=True, input=json.dumps({"cwd": home, "source": "compact"}), env=base_env(**self.env))
        ctx = json.loads(p.stdout)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("- 1020-1 done haiku shop: list the checkout tests", ctx)
        self.assertIn("shop feature-x @ abc123def4 changes-requested (1 blocking)", ctx)


class SessionHookTest(Base):
    def record(self):
        with open(os.path.join(self.env["LEAN_AGENT_HOME"], "chat", "service.json")) as fh:
            return json.load(fh)

    def up(self, pid):
        os.makedirs(self.env["LEAN_AGENT_HOME"], exist_ok=True)
        with open(os.path.join(self.env["LEAN_AGENT_HOME"], "up.json"), "w") as fh:
            json.dump({"pid": pid}, fh)  # the hook's parent is this test process

    def run_injected(self, chain, pid=500, event=None, claudes=None, wait=3.0, up=True):
        """Run session_hook.main() in-process with a fake pid chain {pid: parent} and fake commands: pids in
        `claudes` (default: just `pid`) run claude, the rest run sh."""
        sys.path.insert(0, ROOT)
        import session_hook
        if up:
            self.up(pid)
        claudes = {pid} if claudes is None else set(claudes)
        cmd = lambda p: ["/usr/bin/claude", "--x"] if p in claudes else ["sh", "-c", "x"]
        real_stdin, sys.stdin = sys.stdin, io.StringIO(json.dumps(event or {"session_id": "s1"}))
        try:
            with mock.patch.dict(os.environ, base_env(LEAN_AGENT_SERVICE_SESSION="1",
                                                      LEAN_AGENT_HOME=self.env["LEAN_AGENT_HOME"]), clear=True):
                session_hook.main(ppid=lambda p: chain.get(p, 0), cmd=cmd, wait=wait)
        finally:
            sys.stdin = real_stdin

    def test_records_when_the_service_claude_is_an_ancestor(self):
        me = os.getpid()
        self.run_injected({me: 900, 900: 500, 500: 1})  # hook <- sh <- claude(500)
        self.assertEqual(self.record()["session_id"], "s1")

    def test_the_brief_is_printed_even_when_follow_up_raises(self):
        sys.path.insert(0, ROOT)
        import session_hook
        me = os.getpid()
        out = io.StringIO()
        with mock.patch.object(session_hook, "follow_up", side_effect=RuntimeError("boom")), \
                mock.patch("sys.stdout", out):
            self.run_injected({me: 900, 900: 500, 500: 1},
                              event={"session_id": "c9", "transcript_path": "/x/c9.jsonl", "source": "clear"})
        self.assertEqual(json.loads(out.getvalue())["hookSpecificOutput"]["hookEventName"], "SessionStart")
        self.assertEqual(self.record()["session_id"], "c9")

    def test_keeps_a_chain_of_the_transcripts_in_order_and_the_last_20(self):
        me = os.getpid()
        for n in range(23):
            self.run_injected({me: 900, 900: 500, 500: 1}, event={"session_id": f"s{n}", "transcript_path": f"/t/s{n}.jsonl",
                                                                  "source": "clear" if n else "startup"})
        self.run_injected({me: 900, 900: 500, 500: 1}, event={"session_id": "s22", "transcript_path": "/t/s22.jsonl", "source": "resume"})
        rec = self.record()
        self.assertEqual(rec["chain"], [f"/t/s{n}.jsonl" for n in range(3, 23)])
        self.assertEqual(rec["chain_meta"]["/t/s22.jsonl"]["source"], "clear")  # the same transcript again: not a new entry
        self.assertEqual(set(rec["chain_meta"]), set(rec["chain"]))

    def test_a_new_session_id_moves_up_json_on_and_the_same_one_leaves_it(self):
        me = os.getpid()
        chain = {me: 900, 900: 500, 500: 1}
        up_path = os.path.join(self.env["LEAN_AGENT_HOME"], "up.json")
        self.up(500)
        with open(up_path, "w") as fh:
            json.dump({"pid": 500, "session_id": "s1", "transcript": "/t/s1.jsonl", "name": "la"}, fh)
        self.run_injected(chain, event={"session_id": "s1", "transcript_path": "/t/s1.jsonl", "source": "resume"}, up=False)
        with open(up_path) as fh:
            self.assertEqual(json.load(fh)["session_id"], "s1")
        self.run_injected(chain, event={"session_id": "s2", "transcript_path": "/t/s2.jsonl", "source": "clear"}, up=False)
        with open(up_path) as fh:
            up = json.load(fh)
        self.assertEqual((up["session_id"], up["transcript"], up["pid"], up["name"]), ("s2", "/t/s2.jsonl", 500, "la"))
        self.run_injected(chain, event={"session_id": "s3", "transcript_path": "/t/s3.jsonl", "source": "compact"}, up=False)
        with open(up_path) as fh:
            self.assertEqual(json.load(fh)["session_id"], "s3")

    def test_up_json_is_left_alone_when_the_hook_is_not_under_the_service_claude(self):
        me = os.getpid()
        self.up(500)
        up_path = os.path.join(self.env["LEAN_AGENT_HOME"], "up.json")
        with open(up_path, "w") as fh:
            json.dump({"pid": 500, "session_id": "s1"}, fh)
        self.run_injected({me: 900, 900: 700, 700: 500, 500: 1}, claudes={700, 500}, up=False, wait=0.2,
                          event={"session_id": "other", "source": "clear"})  # a claude nearer than the service one
        with open(up_path) as fh:
            self.assertEqual(json.load(fh)["session_id"], "s1")

    def no_record(self):
        self.assertFalse(os.path.exists(os.path.join(self.env["LEAN_AGENT_HOME"], "chat", "service.json")))

    def test_up_json_without_a_pid_records_nothing(self):
        me = os.getpid()
        os.makedirs(self.env["LEAN_AGENT_HOME"], exist_ok=True)
        with open(os.path.join(self.env["LEAN_AGENT_HOME"], "up.json"), "w") as fh:
            json.dump({"session_id": "x"}, fh)
        self.run_injected({me: 900, 900: 500, 500: 1}, wait=0.2, up=False)
        self.no_record()

    def test_a_pid_that_appears_late_is_recorded(self):
        me = os.getpid()
        os.makedirs(self.env["LEAN_AGENT_HOME"], exist_ok=True)
        threading.Timer(0.3, self.up, args=(500,)).start()
        self.run_injected({me: 900, 900: 500, 500: 1}, wait=5.0, up=False)
        self.assertEqual(self.record()["session_id"], "s1")

    def test_a_claude_nested_under_the_service_claude_is_ignored(self):
        me = os.getpid()
        # hook <- nested claude(700) <- Bash <- service claude(500): the nearest claude is not the service one
        self.run_injected({me: 700, 700: 600, 600: 500, 500: 1}, claudes={500, 700})
        self.no_record()

    def test_the_nearest_claude_decides(self):
        me = os.getpid()
        self.run_injected({me: 900, 900: 500, 500: 400, 400: 1}, claudes={500, 400})  # an outer claude is not nearer
        self.assertEqual(self.record()["session_id"], "s1")
        os.remove(os.path.join(self.env["LEAN_AGENT_HOME"], "chat", "service.json"))
        self.run_injected({me: 900, 900: 800, 800: 400, 400: 1}, claudes={500, 400})  # nearest claude is 400, not 500
        self.no_record()
        chain = {me: 1}
        prev = me
        for p in range(901, 909):  # service claude is the 9th hop: too far
            chain[prev] = p
            prev = p
        chain[prev] = 500
        self.run_injected(chain)
        self.no_record()

    def test_the_service_pid_on_the_8th_hop_is_accepted(self):
        me = os.getpid()
        chain = {me: 901}
        for p in range(901, 907):
            chain[p] = p + 1
        chain[907] = 500  # 8th ancestor
        self.run_injected(chain)
        self.assertEqual(self.record()["session_id"], "s1")

    def test_a_service_pid_that_is_not_claude_like_is_accepted(self):
        me = os.getpid()
        self.run_injected({me: 900, 900: 500, 500: 1}, claudes=set())
        self.assertEqual(self.record()["session_id"], "s1")

    def test_a_nested_claude_before_the_service_pid_is_rejected(self):
        me = os.getpid()
        self.run_injected({me: 700, 700: 600, 600: 500, 500: 1}, claudes={700})
        self.no_record()

    def test_is_claude_matches_the_node_cli_by_path_segment(self):
        import session_hook
        self.assertTrue(session_hook.is_claude(["node", "/x/node_modules/@anthropic-ai/claude-code/cli.js"]))
        self.assertTrue(session_hook.is_claude(["node", "/x/claude-code/cli.js", "--flag"]))
        self.assertFalse(session_hook.is_claude(["node", "/home/claude-code-notes/server.js"]))
        self.assertFalse(session_hook.is_claude(["node", "/x/claude-code/other.js"]))
        self.assertFalse(session_hook.is_claude(["node", "/x/not-claude-code/cli.js"]))
        pid = os.getpid()
        real = session_hook.argv_of(pid)
        self.assertIsInstance(real, list)
        self.assertTrue(real)

    def test_ignores_a_session_that_is_not_the_service_claude(self):
        me = os.getpid()
        self.run_injected({me: 900, 900: 800, 800: 700, 700: 600, 600: 550, 550: 1}, claudes=set())  # the service pid is not an ancestor
        self.run_injected({me: 900, 900: 800, 800: 1})  # another claude's tree
        self.assertFalse(os.path.exists(os.path.join(self.env["LEAN_AGENT_HOME"], "chat", "service.json")))

    def hook_under_claude(self, event, **env):
        """Run the hook as a child of a process whose executable is named claude, and that is the pid in up.json."""
        home = self.env["LEAN_AGENT_HOME"]
        os.makedirs(home, exist_ok=True)
        fake = os.path.join(home, "claude")
        with open(fake, "w") as fh:
            fh.write("#!%s\nimport json, os, subprocess, sys\n"
                     "json.dump(dict({'pid': os.getpid()}, **({'fresh_sid': os.environ['FAKE_FRESH_SID']} if os.environ.get('FAKE_FRESH_SID') else {})), open(os.path.join(os.environ['LEAN_AGENT_HOME'], 'up.json'), 'w'))\n"
                     "p = subprocess.run([sys.executable, sys.argv[1]], input=sys.argv[2], text=True, capture_output=True)\n"
                     "sys.stdout.write(p.stdout)\n" % sys.executable)
        os.chmod(fake, 0o755)
        p = subprocess.run([fake, os.path.join(ROOT, "session_hook.py"), json.dumps(event)], capture_output=True,
                           text=True, env=base_env(**self.env, **env), check=True)
        return json.loads(p.stdout) if p.stdout.strip() else None

    def test_clear_adds_the_brief_with_the_checkpoint_first(self):
        home = self.env["LEAN_AGENT_HOME"]
        os.makedirs(home, exist_ok=True)
        with open(os.path.join(home, "handoff-notes.json"), "w") as fh:
            json.dump([{"ts": "2026-10-23T09:00:00", "text": "promised the user a summary by noon [thread:billing]",
                        "kind": "checkpoint"}, {"ts": "2026-10-23T09:01:00", "text": "an open item"}], fh)
        event = {"session_id": "c1", "transcript_path": "/x/c1.jsonl", "source": "clear"}
        out = self.hook_under_claude(event, LEAN_AGENT_SERVICE_SESSION="1")["hookSpecificOutput"]
        text = out["additionalContext"]
        self.assertEqual(out["hookEventName"], "SessionStart")
        self.assertTrue(text.startswith("Checkpoint of 2026-10-23 09:00"))
        self.assertIn("promised the user a summary by noon [thread:billing]", text)
        self.assertIn("an open item", text)
        self.assertLessEqual(len(text), 3100)
        for source in ("startup", "resume"):
            event = {"session_id": "c2", "transcript_path": "/x/c2.jsonl", "source": source}
            self.assertIsNone(self.hook_under_claude(event, LEAN_AGENT_SERVICE_SESSION="1"))
        with open(os.path.join(home, "handoff-notes.json"), "w") as fh:
            json.dump([{"ts": "2026-10-23T09:00:00", "text": "x" * 6000, "kind": "checkpoint"}], fh)
        text = self.hook_under_claude(event | {"source": "clear"}, LEAN_AGENT_SERVICE_SESSION="1")[
            "hookSpecificOutput"]["additionalContext"]
        self.assertLessEqual(len(text), 3100)

    def test_startup_of_a_restart_fresh_session_gets_the_brief_and_is_marked(self):
        home = self.env["LEAN_AGENT_HOME"]
        os.makedirs(home, exist_ok=True)
        with open(os.path.join(home, "handoff-notes.json"), "w") as fh:
            json.dump([{"ts": "2026-10-23T09:00:00", "text": "an open item"}], fh)
        event = {"session_id": "f1", "transcript_path": "/x/f1.jsonl", "source": "startup"}
        env = dict(LEAN_AGENT_SERVICE_SESSION="1", FAKE_FRESH_SID="f1")
        out = self.hook_under_claude(event, **env)["hookSpecificOutput"]
        self.assertIn("an open item", out["additionalContext"])
        with open(os.path.join(home, "chat", "service.json")) as fh:
            rec = json.load(fh)
        self.assertTrue(rec["chain_meta"]["/x/f1.jsonl"]["fresh"])
        # a resume of that session later, or another session's startup, is not a fresh restart
        self.assertIsNone(self.hook_under_claude(event | {"source": "resume"}, **env))
        self.assertIsNone(self.hook_under_claude(event | {"session_id": "f2"}, **env))

    def test_capped_brief_keeps_the_checkpoint_and_the_handoff_notes(self):
        sys.path.insert(0, ROOT)
        import compact_hook
        home = self.env["LEAN_AGENT_HOME"]
        os.makedirs(home, exist_ok=True)
        long_cp = "\n".join(f"soft state line {i:03d} " + "x" * 40 for i in range(200))
        with open(os.path.join(home, "handoff-notes.json"), "w") as fh:
            json.dump([{"ts": "2026-10-23T09:00:00", "text": long_cp, "kind": "checkpoint"},
                       {"ts": "2026-10-23T09:01:00", "text": "keep this open item in the hand-off"}], fh)
        with mock.patch.dict(os.environ, base_env(LEAN_AGENT_HOME=home), clear=True):
            text = compact_hook.brief(3000)
        self.assertLessEqual(len(text), 3000)
        self.assertIn("soft state line 000", text)
        self.assertNotIn("soft state line 199", text)
        self.assertIn("keep this open item in the hand-off", text)
        self.assertTrue(text.endswith("… (more: lean-agent brief)"))
        cp_part = text.split("\n\n")[0]
        self.assertLessEqual(len(cp_part), 2200)
        self.assertRegex(cp_part.splitlines()[-1], r"^soft state line \d{3} x{40}$")  # cut at a line boundary
        self.assertEqual(compact_hook.brief(), compact_hook.brief(None))
        self.assertNotIn("more: lean-agent brief", compact_hook.brief())

    def test_writes_service_json_only_in_the_service_session(self):
        for source in ("startup", "resume", "clear", "compact"):
            event = {"session_id": "s-" + source, "transcript_path": "/x/s-%s.jsonl" % source, "source": source}
            self.assertIsNone(self.hook_under_claude(event, LEAN_AGENT_SERVICE_SESSION="0"))
            self.assertFalse(os.path.exists(os.path.join(self.env["LEAN_AGENT_HOME"], "chat", "service.json")))
            out = self.hook_under_claude(event, LEAN_AGENT_SERVICE_SESSION="1")
            if source == "clear":  # only a clear adds the brief
                self.assertEqual(out["hookSpecificOutput"]["hookEventName"], "SessionStart")
            else:
                self.assertIsNone(out)
            rec = self.record()
            self.assertEqual((rec["session_id"], rec["transcript_path"], rec["source"]),
                             ("s-" + source, "/x/s-%s.jsonl" % source, source))
            self.assertIsInstance(rec["ts"], float)
            os.remove(os.path.join(self.env["LEAN_AGENT_HOME"], "chat", "service.json"))
        env = base_env(**self.env)
        env.pop("LEAN_AGENT_SERVICE_SESSION", None)
        subprocess.run([sys.executable, os.path.join(ROOT, "session_hook.py")], input=json.dumps({"session_id": "x"}),
                       text=True, env=env, check=True)
        self.assertFalse(os.path.exists(os.path.join(self.env["LEAN_AGENT_HOME"], "chat", "service.json")))

    def test_never_fails_the_session(self):
        self.up(os.getpid())
        env = base_env(LEAN_AGENT_SERVICE_SESSION="1", **self.env)
        for bad in ("", "not json", "[1]", "{}"):
            p = subprocess.run([sys.executable, os.path.join(ROOT, "session_hook.py")], input=bad, text=True,
                               capture_output=True, env=env)
            self.assertEqual((p.returncode, p.stdout, p.stderr), (0, "", ""))
        self.assertFalse(os.path.exists(os.path.join(self.env["LEAN_AGENT_HOME"], "chat", "service.json")))
        os.makedirs(self.env["LEAN_AGENT_HOME"], exist_ok=True)  # an unwritable chat dir
        open(os.path.join(self.env["LEAN_AGENT_HOME"], "chat"), "w").close()
        p = subprocess.run([sys.executable, os.path.join(ROOT, "session_hook.py")], input=json.dumps({"session_id": "x"}),
                           text=True, capture_output=True, env=env)
        self.assertEqual((p.returncode, p.stdout, p.stderr), (0, "", ""))


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
        self.set_strict("off")  # the older tests run other commands in the home; the strict tests turn it on

    def set_strict(self, value):
        home = self.env["LEAN_AGENT_HOME"]
        os.makedirs(home, exist_ok=True)
        with open(os.path.join(home, "config.json"), "w") as fh:
            json.dump({"strict": value}, fh)

    def test_strict_orchestrator_allows_only_lean_agent_commands_and_own_files(self):
        home = self.env["LEAN_AGENT_HOME"]
        self.set_strict("on")
        plugin = os.path.realpath(os.path.join(ROOT, ".."))
        ev = lambda tool, cwd=home, **inp: dict(self.ev, cwd=cwd, tool_name=tool, tool_input=inp)
        bash = lambda cmd, cwd=home, **env: run_hook("budget_hook.py", ev("Bash", cwd, command=cmd, run_in_background=True),
                                                     LEAN_AGENT_TODO_REMINDER="0", **dict(self.env, **env))
        read = lambda path, cwd=home, tool="Read", **env: run_hook(
            "budget_hook.py", ev(tool, cwd, **{"file_path" if tool == "Read" else "path": path}), **dict(self.env, **env))
        denied = lambda out: out and out["hookSpecificOutput"]["permissionDecision"] == "deny"
        for cmd in ("npm test", "git status", "cat src/app.py", "lean-agent runs; rm -rf x", "lean-agent runs $(cat x)",
                    "ls | lean-agent runs", "cat x; lean-agent runs", "lean-agent runs | cat x", "lean-agent runs & rm x",
                    "lean-agent runs | grep -r x /srv", "lean-agent runs | head /srv/f", "lean-agent runs | grep -c x /srv/f",
                    "lean-agent runs > /tmp/x", "lean-agent runs 2>/tmp/x", "lean-agent runs < /etc/passwd",
                    "lean-agent runs <(cat f)", "lean-agent runs >(cat)", "lean-agent run p --why \"unbalanced",
                    "lean-agent runs | grep --include=x y", "lean-agent runs | tail -f x", "lean-agent runs | cat",
                    "lean-agent runs | grep -e x /srv/f", "lean-agent runs | grep --rec x",
                    "lean-agent runs <<EOF; rm x\nbody\nEOF",
                    "lean-agent runs | grep -r x", "lean-agent runs | grep -m 5 x /srv/f", "lean-agent runs | grep -f x y",
                    "lean-agent runs | tail -n +x", "lean-agent runs | head -n +5", "lean-agent runs | wc -L"):
            out = bash(cmd)
            self.assertTrue(denied(out), cmd)
            self.assertIn("Delegate it: lean-agent run <project> --cards auto -m <model> --why",
                          out["hookSpecificOutput"]["permissionDecisionReason"])
            self.assertIn("--read-only", out["hookSpecificOutput"]["permissionDecisionReason"])
        for cmd in ("lean-agent runs", "lean-agent runs --show 3", "lean-agent runs --wait all", "lean-agent runs --wait last --timeout 90",
                    "cd /tmp && lean-agent review shop --status",
                    plugin + "/bin/lean-agent stats", "lean-agent run shop --cards auto -m haiku --why x -- 'look'",
                    "lean-agent run p -- \"x\" 2>&1", "lean-agent runs >/dev/null 2>&1", "lean-agent todo list 2>&1 | head",
                    "lean-agent runs 2>/dev/null", "lean-agent runs >&2", "lean-agent runs &>/dev/null", "/opt/x/lean-agent runs",
                    "lean-agent runs 2>&1 | grep -i x | tail -3", "lean-agent run p --why \"a; b\" -- \"x | y\"",
                    "lean-agent run p -- 'a & b > c'", "lean-agent runs | grep -c x", "lean-agent runs | head -n 5",
                    "lean-agent runs | wc -l", "lean-agent runs 2>&1", "lean-agent runs | grep -ic word",
                    "lean-agent runs &&\nlean-agent todo list", "lean-agent runs;\nlean-agent todo list",
                    "lean-agent run p -- \"t\" <<'EOF' 2>&1\nbody\nEOF",
                    "lean-agent runs | head -n 5>/dev/null",
                    "lean-agent runs | grep -nw foo", "lean-agent runs | grep -m 5 -A2 -B 3 foo", "lean-agent runs | grep -oxH x",
                    "lean-agent runs | tail -n +5", "lean-agent runs | tail -20", "lean-agent runs | tail -c 100",
                    "lean-agent runs | head -c 10", "lean-agent runs | wc -w", "lean-agent runs | wc -m"):
            self.assertIsNone(bash(cmd), cmd)
        out = read("/srv/shop/src/app.py")
        self.assertTrue(denied(out))
        self.assertIn("Delegate it:", out["hookSpecificOutput"]["permissionDecisionReason"])
        self.assertTrue(denied(read("/srv/shop", tool="Grep")))
        self.assertTrue(denied(run_hook("budget_hook.py", ev("Glob", pattern="/srv/shop/**/*.py"), **self.env)))
        self.assertIsNone(run_hook("budget_hook.py", ev("Glob", pattern=home + "/docs/*.md"), **self.env))
        self.assertIsNone(run_hook("budget_hook.py", ev("Glob", pattern="**/*.py"), **self.env))
        self.assertTrue(denied(run_hook("budget_hook.py", ev("Glob", pattern="../../x/**"), **self.env)))
        self.assertIsNone(run_hook("budget_hook.py", ev("Glob", pattern="docs/../docs/*.md"), **self.env))
        for path in (os.path.join(home, "work", "1020-101010-abcd", "summary-1.txt"), os.path.join(home, "docs", "a.md"),
                     os.path.join(plugin, "templates", "guide.md")):
            self.assertIsNone(read(path), path)
        self.assertIsNone(run_hook("budget_hook.py", ev("AskUserQuestion", questions=[]), **self.env))
        self.assertIsNone(run_hook("budget_hook.py", ev("Artifact", content="x"), **self.env))
        # the service session counts as the orchestrator too
        self.assertTrue(denied(bash("npm test", cwd=self.tmp.name, LEAN_AGENT_SERVICE_SESSION="1")))
        # workers are unaffected: their folder is outside the home (or is a run folder in it), and has no service marker
        self.assertIsNone(bash("npm test", cwd=self.tmp.name))
        self.assertIsNone(read("/srv/shop/src/app.py", cwd=self.tmp.name))
        run_dir = os.path.join(home, "work", "1020-101010-abcd")
        os.makedirs(run_dir)
        self.assertIsNone(bash("npm test", cwd=run_dir))
        self.assertIsNone(read("/srv/shop/src/app.py", cwd=run_dir))
        # strict off: today's behaviour
        self.set_strict("off")
        self.assertIsNone(bash("npm test"))
        self.assertIsNone(read("/srv/shop/src/app.py"))


    def test_strict_orchestrator_denies_lean_agent_subcommands_that_change_a_repo_or_tracker(self):
        home = self.env["LEAN_AGENT_HOME"]
        self.set_strict("on")
        ev = lambda cwd, cmd: dict(self.ev, cwd=cwd, tool_name="Bash", tool_input={"command": cmd, "run_in_background": True})
        bash = lambda cmd, cwd=home: run_hook("budget_hook.py", ev(cwd, cmd), LEAN_AGENT_TODO_REMINDER="0", **self.env)
        denied = lambda out: out and out["hookSpecificOutput"]["permissionDecision"] == "deny"
        changing = ("lean-agent worktree push proj feat --allow-send 'push feat'", "lean-agent worktree reset proj feat",
                    "lean-agent worktree setup proj feat --run 'npm ci'", "lean-agent worktree rm proj feat",
                    "lean-agent worktree --force rm proj feat", "lean-agent rules proj", "lean-agent rules proj --off",
                    "lean-agent codemod proj 'npx jscodeshift src' --apply", "cd /srv && lean-agent worktree push p b",
                    "lean-agent runs && FOO=1 lean-agent worktree push p b", "timeout 60 lean-agent worktree push p b",
                    "/x/plugins/lean-agent/bin/lean-agent worktree push p b")
        for cmd in changing:
            out = bash(cmd)
            self.assertTrue(denied(out), cmd)
            reason = out["hookSpecificOutput"]["permissionDecisionReason"]
            self.assertIn("never changes a repo, branch, remote or tracker", reason)
            self.assertIn("lean-agent run <project> --cards auto", reason)
        bookkeeping = ("lean-agent todo list", "lean-agent handoff --note 'x' --kind fyi", "lean-agent handoff --note 'q?' --kind decision", "lean-agent thread list",
                       "lean-agent now", "lean-agent thread show t1 --all", "lean-agent thread close t1", "lean-agent thread reopen t1",
                       "lean-agent thread move t2", "lean-agent checkpoint 'x' --thread t1", "lean-agent review proj --head b --thread none",
                       "lean-agent handoff --note 'x' --kind fyi --thread t1",
                       "lean-agent checkpoint 'x'", "lean-agent brief", "lean-agent runs --last", "lean-agent review proj --head b",
                       "lean-agent handover 'T' --task-file - <<'EOF'\ntext\nEOF", "lean-agent handover --list", "lean-agent sync", "lean-agent doctor",
                       "lean-agent config strict on", "lean-agent card proj show x", "lean-agent optimize proj",
                       "lean-agent codemod proj 'npx jscodeshift src'", "lean-agent worktrees", "lean-agent guard list",
                       "lean-agent run proj --cards auto -m sonnet --why x -- 'worktree push the branch'",
                       "lean-agent run proj --worktree feat --reset-worktree -m sonnet --why x -- 'fix'")
        for cmd in bookkeeping:
            self.assertFalse(denied(bash(cmd)), cmd)
        # a worker (its run folder, or any folder outside the home) may use them all
        for cmd in changing:
            self.assertFalse(denied(bash(cmd, os.path.join(home, "work", "run1"))), cmd)
            self.assertFalse(denied(bash(cmd, self.tmp.name if hasattr(self, "tmp") else "/tmp")), cmd)
        self.set_strict("off")
        self.assertFalse(denied(bash(changing[0])))

    def test_strict_orchestrator_denies_writing_knowledge_and_mcp_but_a_worker_may(self):
        home = self.env["LEAN_AGENT_HOME"]
        self.set_strict("on")
        ev = lambda cwd, tool, inp: dict(self.ev, cwd=cwd, tool_name=tool, tool_input=inp)
        call = lambda tool, inp, cwd=home: run_hook("budget_hook.py", ev(cwd, tool, inp), LEAN_AGENT_TODO_REMINDER="0", **self.env)
        bash = lambda cmd, cwd=home: call("Bash", {"command": cmd, "run_in_background": True}, cwd)
        denied = lambda out: out and out["hookSpecificOutput"]["permissionDecision"] == "deny"
        reason = lambda out: out["hookSpecificOutput"]["permissionDecisionReason"]
        keep = ("lean-agent memory add 'x' --type feedback", "lean-agent memory edit n 'y'", "lean-agent memory rm n",
                "lean-agent memory import", "lean-agent memory -p proj add 'x'", "lean-agent card proj add c --text x",
                "lean-agent card proj rm c", "lean-agent card proj core c", "lean-agent card proj protect c",
                "lean-agent card proj shorten c --save", "lean-agent card proj unarchive c", "lean-agent recipe add p r --task x",
                "lean-agent recipe rm p r", "lean-agent doc write ~/Documents/a.md --text x",
                "lean-agent doc write ~/Downloads/x.md <<'EOF'\nbody\nEOF", "lean-agent doc list", "lean-agent todo add 'x' -p proj",
                "lean-agent todo note 3 'x'", "lean-agent todo rm 3", "lean-agent todo edit 3 'y'", "lean-agent todo reopen 3",
                "lean-agent todo epic e", "lean-agent handoff --note 'remember x'", "lean-agent handoff --note 'x' --kind reminder",
                "lean-agent schedule add 'daily 09:00' do p r",
                "lean-agent schedule rm 2", "lean-agent guard add p push-deny 'x/*'", "lean-agent count proj add n 'x'",
                "lean-agent config strict off")
        for cmd in keep:
            out = bash(cmd)
            self.assertTrue(denied(out), cmd)
            self.assertIn("never writes memory, cards, rules, presets, todos or notes itself", reason(out))
            self.assertIn("lean-agent remember", reason(out))
        for cmd in ("lean-agent tracker proj org=acme", "lean-agent tracker proj --note 'x'"):
            self.assertIn("never changes a repo, branch, remote or tracker", reason(bash(cmd)))
        mcp = ("lean-agent mcp list", "lean-agent mcp tools tickets", "lean-agent mcp preset tickets", "lean-agent mcp env X",
               "lean-agent mcp list --probe -p proj", "lean-agent chrome check")
        for cmd in mcp:
            out = bash(cmd)
            self.assertTrue(denied(out), cmd)
            self.assertIn("neither lists nor runs MCP servers", reason(out))
        for tool in ("mcp__tickets__list", "mcp__plugin_x_y__z", "ListMcpResourcesTool", "ReadMcpResourceTool"):
            out = call(tool, {})
            self.assertTrue(denied(out), tool)
            self.assertIn("no MCP tool", reason(out))
        allowed = ("lean-agent memory list -p proj", "lean-agent memory where", "lean-agent cards proj", "lean-agent card proj show c",
                   "lean-agent todo list", "lean-agent todo next", "lean-agent todo start 3", "lean-agent todo done 3 'merged as PR 5'",
                   "lean-agent handoff", "lean-agent handoff --done 2", "lean-agent handoff --note 'x' --kind fyi",
                   "lean-agent handoff --note=x --kind=checkpoint", "lean-agent thread new 'T'", "lean-agent checkpoint 'x'",
                   "lean-agent clear", "lean-agent remember 'Never merge on Fridays'", "lean-agent advise 'Fix the export retry' --thread t2",
                   "lean-agent advise --task-file - <<'EOF'\nx\nEOF", "lean-agent remember --task-file - <<'EOF'\nx\nEOF",
                   "lean-agent run proj --cards auto -m haiku --why x --todo new -- 'look'", "lean-agent tracker proj",
                   "lean-agent tracker proj --discover --mcp tickets", "lean-agent chrome status", "lean-agent schedule list",
                   "lean-agent guard list", "lean-agent count proj", "lean-agent config strict on", "lean-agent runs")
        for cmd in allowed:
            self.assertFalse(denied(bash(cmd)), cmd)
        # a worker (its run folder, or a folder outside the home) may use all of them
        for cmd in keep + mcp + ("lean-agent tracker proj org=acme",):
            self.assertFalse(denied(bash(cmd, os.path.join(home, "work", "run1"))), cmd)
            self.assertFalse(denied(bash(cmd, self.tmp.name)), cmd)
        for tool in ("mcp__tickets__list", "ListMcpResourcesTool", "ReadMcpResourceTool"):
            self.assertFalse(denied(call(tool, {}, os.path.join(home, "work", "run1"))), tool)
            self.assertFalse(denied(call(tool, {}, self.tmp.name)), tool)
        self.set_strict("off")
        self.assertFalse(denied(bash(keep[0])))
        self.assertFalse(denied(call("mcp__tickets__list", {})))

    def test_prompt_hook_redirects_hash_memory_messages_in_the_orchestrator(self):
        home = self.env["LEAN_AGENT_HOME"]
        self.set_strict("on")
        prompt = lambda text, cwd=home: run_hook("budget_hook.py", {"hook_event_name": "UserPromptSubmit", "cwd": cwd,
                                                                     "session_id": "s1", "prompt": text}, **self.env)
        out = prompt("# always answer in Danish")
        self.assertIn("lean-agent remember", out["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(prompt("/memory")["decision"], "block")
        self.assertEqual(prompt("/init")["decision"], "block")
        ctx = lambda text, **kw: ((prompt(text, **kw) or {}).get("hookSpecificOutput") or {}).get("additionalContext", "")
        self.assertNotIn("lean-agent remember", ctx("# Plan\n- one\n- two"))  # a markdown heading, not a memory message
        self.assertNotIn("lean-agent remember", ctx("#12 is failing"))  # a thread number
        self.assertNotIn("lean-agent remember", ctx("#bug in the export"))  # a tag
        self.assertIsNone(prompt("# always answer in Danish", self.tmp.name))  # a normal session
        self.assertIsNone(prompt("/memory", os.path.join(home, "work", "run1")))  # a worker
        self.set_strict("off")
        self.assertNotIn("lean-agent remember", ctx("# always answer in Danish"))  # still threaded, not redirected

    def test_prompt_hook_notification_never_creates_a_thread(self):
        home = self.env["LEAN_AGENT_HOME"]
        prompt = lambda text: run_hook("budget_hook.py", {
            "hook_event_name": "UserPromptSubmit", "cwd": home, "session_id": "s1", "prompt": text}, **self.env)
        ctx = lambda text: ((prompt(text) or {}).get("hookSpecificOutput") or {}).get("additionalContext", "")
        self.assertTrue(ctx("Publish the quarterly report through the docs worker").startswith("New thread t1"))
        self.assertTrue(ctx("Fix the export retry loop in the billing service").startswith("New thread t2"))
        with open(os.path.join(home, "ledger.jsonl"), "w") as fh:
            fh.write(json.dumps({"id": "0101-100000-aaaa", "ts": "2026-01-01T10:00:00", "thread": "t1", "task": "x"}) + "\n")
        out = os.path.join(home, "bg.output")
        with open(out, "w") as fh:
            fh.write("run 0101-100000-aaaa started\n")
        note = f"<task-notification><task-id>b1</task-id><output-file>{out}</output-file><summary>Background command completed</summary></task-notification>"
        self.assertTrue(ctx(note).startswith('Thread t1 "Publish'), ctx(note))
        self.assertNotIn("guess", ctx(note))
        self.assertEqual(ctx('<task-notification><task-id>b2</task-id><summary>Background command "sleep 1" completed</summary></task-notification>'), "")
        sys.path.insert(0, ROOT)
        with mock.patch.dict(os.environ, base_env(LEAN_AGENT_HOME=home), clear=True):
            import lean_threads
            reg = lean_threads.load()["threads"]
            self.assertEqual(sorted(reg), ["t1", "t2"])
            self.assertEqual([len(t["requests"]) for t in reg.values()], [1, 1])  # no request stored
            self.assertEqual(lean_threads.current("s1"), "t2")

    def test_prompt_hook_threads_every_request(self):
        home = self.env["LEAN_AGENT_HOME"]
        prompt = lambda text, cwd=home, sid="s1": run_hook("budget_hook.py", {
            "hook_event_name": "UserPromptSubmit", "cwd": cwd, "session_id": sid, "prompt": text}, **self.env)
        ctx = lambda text, **kw: ((prompt(text, **kw) or {}).get("hookSpecificOutput") or {}).get("additionalContext", "")
        first = ctx("Publish the quarterly report through the docs worker")
        self.assertTrue(first.startswith('New thread t1 "Publish quarterly report'), first)
        second = ctx("Fix the export retry loop in the billing service")
        self.assertTrue(second.startswith("New thread t2"), second)
        again = ctx("the quarterly report needs a chart in the docs")
        self.assertTrue(again.startswith('Thread t1 "Publish'), again)
        self.assertNotIn("guessed", again)  # a confident match carries no hint
        self.assertEqual(again, 'Thread t1 "Publish quarterly report through docs worker"')
        self.assertTrue(ctx("what about t2 now?").startswith('Thread t2 "Fix export'))  # explicit wins over words
        self.assertTrue(ctx("#7 is failing").startswith('Thread #7'))
        self.assertTrue(ctx("yes please").startswith("Thread #7"))  # no content words: the last topic
        self.assertEqual(ctx("/clear"), "")  # a slash command is not a request
        self.assertEqual(prompt("hello there", self.tmp.name), None)  # a normal session is left alone
        sys.path.insert(0, ROOT)
        with mock.patch.dict(os.environ, base_env(LEAN_AGENT_HOME=home), clear=True):
            import lean_threads
            t1 = lean_threads.load()["threads"]["t1"]
            self.assertEqual(len(t1["requests"]), 2)
            self.assertEqual(lean_threads.current("s1"), "#7")
            self.assertEqual(lean_threads.resolve_tag(), "#7")
            self.assertEqual(lean_threads.resolve_tag("none"), None)
            self.assertEqual(lean_threads.resolve_tag("T2"), "t2")
            # closed threads are ignored by matching
            with lean_threads._locked() as data:
                data["threads"]["t1"]["closed"] = "2026-01-01T00:00:00"
            self.assertEqual(lean_threads.score_threads("quarterly report chart docs"), [])
            # naming a closed thread brings it back; an exception in routing never breaks the prompt
            self.assertTrue(ctx("the quarterly report is t1 again").startswith('Thread t1 "Publish'))
            self.assertNotIn("closed", lean_threads.load()["threads"]["t1"])
            with open(lean_threads.path()) as fh:
                good = fh.read()
            with open(lean_threads.path(), "w") as fh:
                json.dump({"threads": {"t1": 5}}, fh)  # a registry that makes route() raise
            self.assertEqual(ctx("another request entirely"), "")
            with open(lean_threads.path(), "w") as fh:
                fh.write(good)

    def test_thread_registry_moves_out_of_the_chat_dir(self):
        home = self.env["LEAN_AGENT_HOME"]
        os.makedirs(os.path.join(home, "chat"))
        old = os.path.join(home, "chat", "threads.json")
        with open(old, "w") as fh:
            json.dump({"threads": {"t4": {"id": "t4", "title": "Old topic", "kind": "free", "created": "2026-01-01T00:00:00",
                                          "last_message": "2026-01-01T00:00:00"}}, "aliases": {}}, fh)
        sys.path.insert(0, ROOT)
        with mock.patch.dict(os.environ, base_env(LEAN_AGENT_HOME=home), clear=True):
            import lean_threads
            self.assertIn("t4", lean_threads.load()["threads"])
            self.assertTrue(os.path.exists(os.path.join(home, "threads.json")), os.listdir(home))
            self.assertFalse(os.path.exists(old), os.listdir(home))
            self.assertEqual(lean_threads.new("Next"), "t5")

    def test_strict_denies_review_learn_text_and_abbreviated_flags_do_not_exist(self):
        sys.path.insert(0, ROOT)
        import budget_hook
        for cmd in ('lean-agent review learn shop --text "check the counter"', 'lean-agent review-learn shop --text=x',
                    'lean-agent review learn shop --helper "a | b | c"'):
            self.assertEqual(budget_hook.restricted_command(cmd)[0], "keep", cmd)
        for cmd in ("lean-agent review learn shop 12 --mcp tickets", "lean-agent review decline shop 1 --why x"):
            self.assertEqual(budget_hook.restricted_command(cmd)[0], "", cmd)
        import lean_agent
        ap = lean_agent.build_parser()
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            ap.parse_args(["tracker", "shop", "--not", "x"])  # not an abbreviation of --note
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            ap.parse_args(["codemod", "--appl"])

    def test_strict_check_command_substitution_and_heredocs(self):
        sys.path.insert(0, ROOT)
        import budget_hook
        ok = budget_hook.lean_agent_only
        for cmd in ("lean-agent run p -- \"$(cat <<'EOF'\nx\nEOF\n)\"", "lean-agent run p -- \"$(cat <<\"EOF\"\nx\nEOF\n)\"",
                    "lean-agent run p -- \"$(cat <<EOF\nx\nEOF\n)\"", "lean-agent run p -- $(cat <<'EOF'\nx\nEOF\n)",
                    "lean-agent run p -- \"$(cat <<-'EOF'\nx\nEOF\n)\"",
                    "lean-agent run p -- \"$(cat <<\\EOF\nx\nEOF\n)\"", "lean-agent run p -- \"$(sh <<'EOF'\nx\nEOF\n)\"",
                    "lean-agent run p -- \"$(cat <<'EOF'\nx\nEOF\nrm -rf ~\n)\"",
                    "lean-agent runs `date`", "lean-agent run p -- \"`date`\"", "lean-agent run p -- \"a $(date)\"",
                    "lean-agent run --resume \"$(lean-agent runs --last)\" -- x", "lean-agent runs $((1+1))",
                    "lean-agent run p -- \"t <<'EOF'\n$(rm x)\nEOF\n\"", "lean-agent run p <<'EOF'\nx\n",
                    "lean-agent run p <<EOF\n$(rm x)\nEOF", "lean-agent run p <<EOF\n`rm x`\nEOF",
                    "lean-agent run p <<'EOF'\nx\nEOF2\n", "lean-agent run p <<'EOF'\nx\n EOF\n",
                    "lean-agent run p <<'EOF'\nx\nEOF\n$(rm x)", "lean-agent run p <<-'EOF'\nx\n  EOF\n",
                    "lean-agent run p <<'EOF' $(rm x)\nx\nEOF", "lean-agent run p <<<x",
                    "lean-agent run p -- '$(cat <<\"EOF\"'; rm -rf ~", "lean-agent runs # <<EOF\nrm x\nEOF",
                    "lean-agent runs # '\\''\nrm x\n#'\\''", "lean-agent runs # note", "lean-agent runs;#c"):
            self.assertFalse(ok(cmd), cmd)
        for cmd in ("lean-agent run p -m sonnet --task-file - <<'EOF'\nGoal: x\n$(rm y) `z`\nEOF",
                    "lean-agent run p --task-file - <<EOF\nGoal: x\nEOF", "lean-agent run p --task-file - <<\"EOF\"\n$(x)\nEOF\n",
                    "lean-agent run p --task-file - <<-'EOF'\n\tbody $(x)\n\tEOF\n",
                    "lean-agent run p --task-file - <<-EOF\n\tbody\nEOF", "lean-agent run p -- 'a $(b) `c`'",
                    "lean-agent run p -- \"a \\$(b) \\`c\"", "lean-agent run p --task-file - <<'EOF' 2>&1\nx\nEOF",
                    "lean-agent run p --task-file - <<'EOF' && lean-agent runs\nx\nEOF\n",
                    "lean-agent run p --task-file - <<'A'\nx\nA\nlean-agent runs",
                    "lean-agent run p -- 'a # b'", "lean-agent run p -- \"a # b\"", "lean-agent run p -- about#3",
                    "lean-agent run p -- http://x/y#frag", "lean-agent run p --task-file - <<'EOF'\n# heading\nEOF"):
            self.assertTrue(ok(cmd), cmd)
        self.assertFalse(ok("lean-agent run p <<'EOF'\nx\nEOF\nrm x"))

    def test_commands_run_unparseable_command_reads_first_line_only(self):
        sys.path.insert(0, ROOT)
        import budget_hook
        cmd = "lean-agent run p <<'EOF'\nlean-agent run q -- x\n$(boom)\nrm x"  # no closing line
        self.set_strict("on")
        with mock.patch.dict(os.environ, {"LEAN_AGENT_HOME": self.env["LEAN_AGENT_HOME"]}):
            self.assertEqual(budget_hook.commands_run(cmd), [])
            self.set_strict("off")
            self.assertEqual(budget_hook.commands_run(cmd), [["lean-agent", "run", "p"]])
            self.assertEqual(budget_hook.commands_run("lean-agent runs `x`\nrm y"), [["lean-agent", "runs"]])

    def test_guide_examples_pass_the_strict_check(self):
        import re
        sys.path.insert(0, ROOT)
        import budget_hook
        templates = os.path.join(ROOT, "..", "templates")
        with open(os.path.join(templates, "guide.md"), encoding="utf-8") as fh:
            guide = fh.read().replace("{{P}}", "shop")
        with open(os.path.join(templates, "repo-block.md"), encoding="utf-8") as fh:
            block = fh.read().replace("{{P}}", "shop")
        examples = []
        for m in re.finditer(r"^```(\w*)\n(.*?)^```", guide, re.S | re.M):
            if m.group(1) == "sh":
                examples.append(m.group(2))
            elif m.group(1) == "text":
                examples += [l for l in m.group(2).splitlines() if l.startswith("lean-agent ")]
        bash_event = lambda cmd: {"tool_name": "Bash", "tool_input": {"command": cmd}}
        skipped = []
        for doc in (guide, block):
            text = re.sub(r"^```.*?^```", "", doc, flags=re.S | re.M)
            for m in re.finditer(r"`(lean-agent [^`]+)`", text):
                span = " ".join(m.group(1).split())  # a span may wrap over lines
                if re.search(r"worker:\s*$", text[:m.start()]):  # the explicit marker: meant for a worker, not the orchestrator
                    skipped.append(span)
                else:
                    examples.append(span)
        self.assertGreater(len(examples), 20)
        self.assertTrue(any("<<'EOF'" in e and "--task-file -" in e for e in examples))
        self.assertTrue(any("worktree" in e and e.startswith("lean-agent run") for e in examples))
        self.assertGreaterEqual(len(skipped), 3)
        for ex in examples:
            ex = re.sub(r"<[A-Za-z][\w -]*>", "x", ex)  # <placeholders>
            opened = re.search(r"<<-?(['\"]?)(\w+)\1$", ex)  # a heredoc whose body the prose gives separately
            ex += f"\nbody\n{opened.group(2)}" if opened else ""
            ex = re.sub(r"(?<=\w)\|(?=\w)", "/", ex.replace("...", "x"))  # on|off: alternatives
            self.assertTrue(budget_hook.lean_agent_only(ex), ex)
            self.assertEqual(budget_hook.strict_denial(bash_event(ex), "/home", "/home"), "", ex)  # strict mode allows it
        for ex in skipped:  # the marker is only for what strict mode really denies
            self.assertTrue(budget_hook.strict_denial(bash_event(re.sub(r"\|\w+", "", ex)), "/home", "/home"), ex)

    def surface_commands(self):
        """(allowed, denied): the `lean-agent` commands section 2 of docs/orchestrator-surface.md lists, as word lists."""
        import itertools
        import re
        path = os.path.join(ROOT, "..", "..", "..", "docs", "orchestrator-surface.md")
        with open(path, encoding="utf-8") as fh:
            section = fh.read().split("## 2.")[1].split("\n## 3.")[0]
        allowed, denied = [], []
        for line in section.splitlines():
            cols = [c.strip() for c in re.split(r"(?<!\\)\|", line)[1:-1]]
            if len(cols) != 3 or cols[1] in ("Class", "---"):
                continue
            status = denied if "**denied**" in cols[2] else allowed if cols[2].startswith("allowed") else None
            self.assertIsNotNone(status, line)
            base = ""
            for span in re.findall(r"`([^`]+)`", cols[0].replace("\\|", "\x00")):
                span = re.sub(r"\[[^\]]*\]", "", span).replace("\u2026", "x")
                span = re.sub(r"<[^>]*>", "x", span)
                if span.startswith("-"):  # a flag of the previous command in the row
                    span = f"{base} {span}"
                else:
                    base = " ".join(itertools.takewhile(lambda w: not w.startswith("-"), span.split()))
                words = [w.split("\x00") for w in span.split()]
                for combo in itertools.product(*words):
                    status.append(["lean-agent", *combo])
        return allowed, denied

    def test_orchestrator_surface_doc_matches_the_strict_hook(self):
        sys.path.insert(0, ROOT)
        import budget_hook
        allowed, denied = self.surface_commands()
        self.assertGreater(len(allowed), 60)
        self.assertGreater(len(denied), 40)
        event = lambda words: {"tool_name": "Bash", "tool_input": {"command": " ".join(words)}}
        for words in allowed:
            self.assertEqual(budget_hook.strict_denial(event(words), "/home", "/home"), "", " ".join(words))
        for words in denied:
            self.assertTrue(budget_hook.strict_denial(event(words), "/home", "/home"), " ".join(words))
        # and the other way: everything the hook lists as denied is in the doc as denied
        listed = {(n, a) for n, acts in budget_hook.CHANGING_ACTIONS.items() for a in acts}
        listed |= {(n, "") for n in budget_hook.CHANGING_ALWAYS | budget_hook.KEEP_ALWAYS | budget_hook.MCP_ALWAYS}
        listed |= {(n, f) for n, flags in budget_hook.CHANGING_FLAGS.items() for f in flags}
        listed |= {(n, a) for n, (_, acts) in budget_hook.KEEP_ACTIONS.items() for a in acts}
        listed |= {(n, a) for n, (_, acts) in budget_hook.MCP_ACTIONS.items() for a in acts}
        listed |= {("config", "strict off")}
        for name, what in sorted(listed):
            self.assertTrue(any(w[1] == name and (not what or all(x in w[2:] for x in what.split())) for w in denied),
                            f"{name} {what} is denied by the hook but not listed as denied in the doc")

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
                    "cat > /tmp/t.md <<EOF\nx\nEOF\nlean-agent run -p shop --task-file /tmp/t.md -m haiku --why x",
                    "LEAN_AGENT_X=1 timeout 600 lean-agent do shop weekly-report",
                    "lean-agent do shop weekly-report", "lean-agent tracker shop --discover --mcp tickets"):
            out = run_hook("budget_hook.py", ev(cmd), **self.env)
            self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "deny", cmd)
            self.assertIn("run_in_background: true", out["hookSpecificOutput"]["permissionDecisionReason"])
            self.assertIsNone(run_hook("budget_hook.py", ev(cmd, bg=True), LEAN_AGENT_TODO_REMINDER="0", **self.env))
        for cmd in ("lean-agent review shop --status", "lean-agent review decline shop 1 --why x",
                    "lean-agent runs --show", "lean-agent tracker shop", "lean-agent stats",
                    "cat > /tmp/task.md <<'EOF'\nThen run lean-agent review shop --resume\nEOF",
                    'echo "next: lean-agent run -p shop"', "git commit -m 'lean-agent do shop x'"):
            self.assertIsNone(run_hook("budget_hook.py", ev(cmd), **self.env), cmd)
        self.assertIsNone(run_hook("budget_hook.py", ev("lean-agent run -p shop -m haiku x", cwd=self.tmp.name), **self.env))
        self.assertIsNone(run_hook("budget_hook.py", ev("lean-agent run -p shop -m haiku x"),
                                   LEAN_AGENT_BACKGROUND_RUNS="0", LEAN_AGENT_TODO_REMINDER="0", **self.env))

    def test_workers_name_their_work_queue_item(self):
        home = self.env["LEAN_AGENT_HOME"]
        os.makedirs(home, exist_ok=True)
        with open(os.path.join(home, "todo.json"), "w") as fh:
            json.dump({"next": 3, "items": [{"id": 1, "text": "Fix the export", "status": "open"},
                                            {"id": 2, "text": "Old thing", "status": "done"}]}, fh)
        ev = lambda cmd: dict(self.ev, cwd=home, tool_name="Bash", tool_input={"command": cmd, "run_in_background": True})
        for cmd in ('lean-agent run -p shop -m haiku --why x "fix it"', "lean-agent review shop --ref feature/x",
                    "lean-agent do shop weekly-report"):
            out = run_hook("budget_hook.py", ev(cmd), **self.env)["hookSpecificOutput"]
            self.assertEqual(out["permissionDecision"], "deny", cmd)
            self.assertIn("--todo N", out["permissionDecisionReason"])
            self.assertIn("#1 Fix the export", out["permissionDecisionReason"])
            self.assertNotIn("Old thing", out["permissionDecisionReason"])
        for cmd in ('lean-agent run -p shop --todo 1 -m haiku --why x "fix it"', "lean-agent review shop --todo=#1",
                    "lean-agent run -p shop --todo none -m haiku --why x look", "lean-agent run --resume 0101-x more",
                    "lean-agent review shop --status", "lean-agent review shop --decide-gaps", "lean-agent todo add x"):
            self.assertIsNone(run_hook("budget_hook.py", ev(cmd), **self.env), cmd)

    def test_check_before_auto_compaction(self):
        home = self.env["LEAN_AGENT_HOME"]
        os.makedirs(home, exist_ok=True)
        with open(self.transcript, "a") as fh:
            fh.write(assistant_line("near", 10, 0, 56000, 50))
        env = dict(self.env, LEAN_AGENT_CTX_NUDGE="", CLAUDE_CODE_AUTO_COMPACT_WINDOW="100000",
                   CLAUDE_AUTOCOMPACT_PCT_OVERRIDE="70")
        out = run_hook("budget_hook.py", dict(self.ev, cwd=home), **env)
        note = out["hookSpecificOutput"]["additionalContext"]
        self.assertIn("Claude Code compacts at ~67,000", note)
        self.assertIn("lean-agent context --no-probe", note)
        self.assertIn("lean-agent handoff --note", note)
        self.assertIsNone(run_hook("budget_hook.py", dict(self.ev, cwd=home), **env))  # once

    def test_rotation_hint_after_two_compactions(self):
        home = self.env["LEAN_AGENT_HOME"]
        os.makedirs(home, exist_ok=True)
        ev = {"session_id": "s5", "cwd": home, "source": "compact"}
        run = lambda: json.loads(subprocess.run([sys.executable, os.path.join(ROOT, "compact_hook.py"), "post"],
                                                input=json.dumps(ev), capture_output=True, text=True,
                                                env=base_env(**self.env), check=True).stdout)
        self.assertNotIn("compacted more than once", run()["hookSpecificOutput"]["additionalContext"])
        self.assertIn("suggest the user starts a fresh conversation (/clear)",
                      run()["hookSpecificOutput"]["additionalContext"])

    def test_scheduled_results_reach_the_session(self):
        home = self.env["LEAN_AGENT_HOME"]
        os.makedirs(home, exist_ok=True)
        ev = dict(self.ev, cwd=home)
        self.assertIsNone(run_hook("budget_hook.py", ev, **self.env))  # the session starts: nothing new
        with open(os.path.join(home, "scheduled.jsonl"), "a") as fh:
            fh.write(json.dumps({"ts": "2999-01-01T00:00:00", "id": 3, "args": ["do", "shop", "morning"], "rc": 0,
                                 "output": "/x/3.txt", "first": "run 1021 · haiku · done"}) + "\n")
        note = run_hook("budget_hook.py", ev, **self.env)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("#3 `lean-agent do shop morning` exit 0", note)
        self.assertIsNone(run_hook("budget_hook.py", ev, **self.env))  # once

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
                           capture_output=True, text=True, env=base_env(**self.env), check=True)
        note = json.loads(p.stdout)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("1. Ask the user whether to merge PR 512", note)
        self.assertIn("1020-101010-abcd done haiku shop", note)
        self.assertIn("[details: /x/details-1.md]", note)
        self.assertIn("Items and branches touched: PR 512, SHOP-77", note)
        p = subprocess.run([sys.executable, os.path.join(ROOT, "compact_hook.py"), "post"],
                           input=json.dumps(dict(start, source="resume")), capture_output=True, text=True,
                           env=base_env(**self.env), check=True)
        self.assertEqual(p.stdout.strip(), "")  # a resumed session still has its context

    def test_report_shows_context_trend_and_compaction_saving(self):
        with open(self.transcript, "w") as fh:
            for i in range(12):
                fh.write(assistant_line(f"t{i}", 10, 0, 20000 * (i + 1), 10))
        p = subprocess.run([sys.executable, os.path.join(ROOT, "usage.py"), "report", self.transcript],
                           capture_output=True, text=True, env=base_env(**self.env), check=True)
        self.assertIn("Context per call, by quarter of the session: 40,010 -> 100,010 -> 160,010 -> 220,010", p.stdout)
        self.assertIn("Re-reading context above ~67K cost this session", p.stdout)

    def test_report(self):
        p = subprocess.run([sys.executable, os.path.join(ROOT, "usage.py"), "report", self.transcript],
                           capture_output=True, text=True, env=base_env(**self.env), check=True)
        self.assertIn("3,450", p.stdout)
        self.assertIn("Calls:   2 API calls · first call context 11,100 tokens", p.stdout)
        self.assertIn("claude-small", p.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
