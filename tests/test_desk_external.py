"""External front desk (desk external): the service hosts no main session; the desk attaches through its hooks (one at a time,
30-minute heartbeat); reports reach it as additionalContext (SessionStart, UserPromptSubmit) and a once-per-batch Stop block;
main resolves to the attached session; the pane's service-state check uses the CLI's socket path."""
import contextlib
import io
import json
import os
import sys
import tempfile
import time
import unittest
from unittest import mock

from _env import clean_environ

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)

import desk_hook  # noqa: E402
import lean_desk  # noqa: E402
import lean_map  # noqa: E402
import lean_sock  # noqa: E402
import service_session as ss  # noqa: E402


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        env = {**clean_environ(), "LEAN_AGENT_HOME": self.tmp, "LEAN_AGENT_LOG_DIR": os.path.join(self.tmp, "logs")}
        p = mock.patch.dict(os.environ, env, clear=True)
        p.start()
        self.addCleanup(p.stop)
        self.now = time.time()
        lean_desk.set_mode("auto")  # these tests exercise the app desk; hosted is the shipped default (Mode tests it)

    def external(self):
        lean_desk.set_mode("external")

    def hook(self, mode, sid="s1", now=None, **event):
        """Run desk_hook.main as Claude Code does; (additionalContext, decision-reason) printed."""
        stdin = io.StringIO(json.dumps({"session_id": sid, "cwd": lean_desk.desk_dir(), **event}))
        buf = io.StringIO()
        with mock.patch.object(sys, "stdin", stdin), contextlib.redirect_stdout(buf):
            desk_hook.main([mode], now=now or self.now)
        out = buf.getvalue().strip()
        if not out:
            return None, None
        data = json.loads(out)
        return data.get("hookSpecificOutput", {}).get("additionalContext"), data.get("reason") if data.get("decision") == "block" else None

    def report(self, text="t5 finished the work"):
        ss.queue_report("t5", "done", text, force=True)


class Mode(Base):
    def test_default_auto_and_switch(self):
        os.remove(lean_desk.lean_home("config.json"))  # no saved mode: the shipped default
        self.assertEqual(lean_desk.mode(), "hosted")  # auto is opt-in until it is proven in the field
        lean_desk.set_mode("auto")
        self.assertEqual(lean_desk.mode(), "auto")
        self.assertIsNone(lean_desk.attached())
        self.external()
        self.assertEqual(lean_desk.mode(), "external")
        self.assertTrue(lean_desk.notify_on())
        lean_desk.set_notify(False)
        self.assertFalse(lean_desk.notify_on())

    def test_hooks_are_inert_when_hosted(self):
        lean_desk.set_mode("hosted")
        self.assertEqual(self.hook("start"), (None, None))
        self.assertIsNone(lean_desk.record().get("session_id"))

    def test_external_does_not_start_a_main_host(self):
        import lean_agent as la
        self.external()
        started = []
        with mock.patch.object(ss, "Host", side_effect=lambda *a, **k: started.append(a) or mock.Mock()), \
                mock.patch.object(ss.ExternalHost, "run", return_value=0), \
                mock.patch.object(ss, "Sessions", return_value=mock.Mock()), \
                mock.patch.object(ss, "plan_restore", return_value=([], 0)), \
                mock.patch.object(ss, "begin_grace"), mock.patch.object(ss, "start_reporter") as rep, \
                mock.patch.object(ss, "AutoClear") as clear, mock.patch.object(ss, "SpoolDeliverer"), \
                mock.patch.object(la.lean_sock, "Helper"), mock.patch.object(la.lean_sock, "Server"), \
                mock.patch("threading.Thread.start"), mock.patch.object(la, "print_still_running"):
            la.host_session(["claude"], [], {}, self.tmp, "lean-agent")
        self.assertEqual(started, [])
        self.assertIsInstance(rep.call_args[0][0], ss.SwitchHost)
        self.assertTrue(rep.call_args[0][0].external)

    def test_hosted_still_starts_the_main_host(self):
        import lean_agent as la
        lean_desk.set_mode("hosted")
        host = mock.Mock()
        host.run.return_value = 0
        with mock.patch.object(ss, "Host", return_value=host) as h, \
                mock.patch.object(ss, "Sessions", return_value=mock.Mock()), \
                mock.patch.object(ss, "plan_restore", return_value=([], 0)), \
                mock.patch.object(ss, "begin_grace"), mock.patch.object(ss, "start_reporter"), \
                mock.patch.object(ss, "AutoClear"), mock.patch.object(ss, "SpoolDeliverer"), \
                mock.patch.object(la.lean_sock, "Helper"), mock.patch.object(la.lean_sock, "Server"), \
                mock.patch("threading.Thread.start"), mock.patch.object(la, "print_still_running"):
            la.host_session(["claude"], [], {}, self.tmp, "lean-agent")
        self.assertEqual(h.call_args[1]["key"] if "key" in h.call_args[1] else "main", "main")
        host.run.assert_called()


class Attach(Base):
    def test_attach_detach_status_one_desk(self):
        self.external()
        self.assertIn("no app session attached", lean_desk.status_line(self.now))
        self.assertEqual(lean_desk.attach("s1", "/t/s1.jsonl", "/c", self.now), (True, "attached"))
        self.assertIn("app session attached", lean_desk.status_line(self.now + 120))
        ok, msg = lean_desk.attach("s2", None, None, self.now + 5)
        self.assertFalse(ok)
        self.assertIn("already the front desk", msg)
        self.assertEqual(lean_desk.record()["session_id"], "s1")
        self.assertTrue(lean_desk.attach("s1", None, None, self.now + 9)[0])  # the same session again is fine
        self.assertTrue(lean_desk.detach())
        self.assertFalse(lean_desk.detach())
        self.assertTrue(lean_desk.attach("s2", None, None, self.now + 10)[0])

    def test_heartbeat_expiry_counts_as_detached(self):
        self.external()
        lean_desk.attach("s1", None, None, self.now)
        self.assertTrue(lean_desk.attached(self.now + 29 * 60))
        self.assertTrue(lean_desk.heartbeat("s1", None, self.now + 29 * 60))
        self.assertTrue(lean_desk.attached(self.now + 58 * 60))  # the heartbeat moved it on
        self.assertIsNone(lean_desk.attached(self.now + 29 * 60 + 31 * 60))
        self.assertIn("detached", lean_desk.status_line(self.now + 90 * 60))
        self.assertTrue(lean_desk.attach("s2", None, None, self.now + 90 * 60)[0])  # a dead desk is replaced

    def test_start_in_desk_folder_attaches_first_session_only(self):
        self.external()
        ctx, _ = self.hook("start", "s1")
        self.assertIn("this session is the front desk", ctx)
        self.assertEqual(lean_desk.record()["session_id"], "s1")
        ctx, _ = self.hook("start", "s2")
        self.assertIn("NOT the front desk", ctx)
        self.assertEqual(lean_desk.record()["session_id"], "s1")

    def test_start_elsewhere_does_not_attach(self):
        self.external()
        stdin = io.StringIO(json.dumps({"session_id": "s9", "cwd": tempfile.mkdtemp()}))
        with mock.patch.object(sys, "stdin", stdin), contextlib.redirect_stdout(io.StringIO()):
            desk_hook.main(["start"], now=self.now)
        self.assertIsNone(lean_desk.record().get("session_id"))


class Delivery(Base):
    def setUp(self):
        super().setUp()
        self.external()
        self.hook("start", "s1")

    def test_prompt_and_start_carry_pending_reports(self):
        self.report("alpha done")
        ctx, _ = self.hook("prompt", "s1")
        self.assertIn("alpha done", ctx)
        self.assertEqual(ss.queued_reports(), [])
        self.assertEqual(self.hook("prompt", "s1"), (None, None))  # once
        self.report("beta done")
        ctx, _ = self.hook("start", "s1", source="resume")
        self.assertIn("beta done", ctx)

    def test_other_sessions_get_nothing(self):
        self.report()
        self.assertEqual(self.hook("prompt", "s2"), (None, None))
        self.assertEqual(self.hook("stop", "s2"), (None, None))
        self.assertEqual(len(ss.queued_reports()), 1)

    def test_stop_blocks_once_per_batch_and_never_loops(self):
        self.assertEqual(self.hook("stop", "s1"), (None, None))  # nothing pending
        self.report("gamma done")
        _, reason = self.hook("stop", "s1")
        self.assertIn("gamma done", reason)
        self.assertEqual(self.hook("stop", "s1", stop_hook_active=True), (None, None))
        self.assertEqual(self.hook("stop", "s1"), (None, None))  # the batch was handed over
        self.report("delta done")  # a new batch right after: held by the gap, then handed over
        self.assertEqual(self.hook("stop", "s1", now=self.now + 1), (None, None))
        self.assertIn("delta done", self.hook("stop", "s1", now=self.now + 60)[1])

    def test_stop_hook_active_never_blocks(self):
        self.report()
        self.assertEqual(self.hook("stop", "s1", stop_hook_active=True), (None, None))
        self.assertEqual(len(ss.queued_reports()), 1)

    def test_no_delivery_while_a_dialog_is_open(self):
        self.report()
        ss.dialog_set("main", True, now=self.now)
        self.assertEqual(self.hook("stop", "s1"), (None, None))
        self.assertIsNone(ss.inject_main(self.now))
        self.assertEqual(len(ss.queued_reports()), 1)
        ss.dialog_set("main", False)
        self.assertIn("t5 finished", self.hook("stop", "s1", now=self.now + 30)[1])

    def test_reporter_does_not_type_and_notifies_once(self):
        host = ss.ExternalHost()
        clock = [self.now]
        rep = ss.Reporter(host, now=lambda: clock[0])
        self.report()
        with mock.patch.object(lean_desk, "notify") as note, mock.patch.object(host, "paste") as paste:
            for _ in range(8):
                clock[0] += 10
                rep.external_tick()
        paste.assert_not_called()
        self.assertEqual(note.call_count, 1)
        self.assertEqual(len(ss.queued_reports()), 1)  # still waiting: shown in the inbox
        self.assertTrue(ss.alive("main"))
        self.assertFalse(ss.send("hi")[0])


class Resolution(Base):
    def test_main_resolves_to_the_attached_session(self):
        self.external()
        self.assertFalse(ss.alive("main"))
        lean_desk.attach("s1", "/t/s1.jsonl", "/c", time.time())
        self.assertEqual(ss.info("main")["session_id"], "s1")
        self.assertEqual(ss.session_transcript("main"), "/t/s1.jsonl")
        self.assertTrue(ss.alive("main"))
        lean_desk.detach()
        self.assertFalse(ss.alive("main"))

    def test_map_shows_the_desk(self):
        self.external()
        lean_desk.attach("s1", None, None, time.time())
        d = lean_map.desk_info()
        self.assertEqual((d["mode"], d["attached"]), ("external", True))
        self.assertIn("app session attached", d["line"])
        snap = lean_map.build({"service": {"desk": d}, "threads": [], "runs": [], "inbox": 0, "desk_idle_s": 3})
        node = next(n for n in snap["nodes"] if n["id"] == "main")
        self.assertIn("app session, attached", node["detail"])

    def test_pane_state_uses_the_cli_socket_path(self):
        down = lean_map.down_snapshot()
        self.assertFalse(down["service"]["up"])
        self.assertEqual(down["service"]["socket"], lean_sock.path())


class Isolation(Base):
    """Strict mode and the orchestrator rules apply to the real front desk only."""

    def deny(self, event, **env):
        import budget_hook
        import budget_gate
        event = {"hook_event_name": "PreToolUse", "cwd": self.tmp, "session_id": "sx", **event}
        with mock.patch.dict(os.environ, env), mock.patch.object(budget_hook, "usage") as u:
            u.lean_home.return_value = self.tmp
            desk = budget_gate.is_front_desk(event)
            return budget_hook.strict_denial(event, self.tmp, self.tmp) if desk else "", desk

    def setUp(self):
        super().setUp()
        self.external()  # never hosts: an attached session is the confirmed desk at once

    BASH = {"tool_name": "Bash", "tool_input": {"command": "ls -la"}}
    MCP = {"tool_name": "mcp__other__thing", "tool_input": {}}

    def test_a_non_desk_session_in_the_lean_home_stays_unrestricted_even_after_lean_agent_commands(self):
        for cmd in ("lean-agent runs", "lean-agent run x", "ls -la", "git push"):
            why, desk = self.deny({"tool_name": "Bash", "tool_input": {"command": cmd}})
            self.assertEqual((why, desk), ("", False), cmd)
        self.assertEqual(self.deny(self.MCP), ("", False))

    def test_the_attached_desk_and_the_hosted_main_are_restricted(self):
        lean_desk.attach("sx", None, self.tmp, time.time())
        why, desk = self.deny(self.BASH)
        self.assertTrue(desk)
        self.assertIn("strict mode", why)
        self.assertIn("strict mode", self.deny(self.MCP)[0])
        why, desk = self.deny(self.BASH, LEAN_AGENT_SERVICE_SESSION="1")
        self.assertTrue(desk)
        lean_desk.detach()
        self.assertEqual(self.deny(self.BASH), ("", False))  # a detached desk is a normal session again

    def test_the_apps_own_session_tools_are_allowed_for_the_desk_only(self):
        import budget_hook
        lean_desk.attach("sx", None, self.tmp, time.time())
        for name in ("mcp__ccd_session__mark_chapter", "mcp__Claude_Preview__preview_start"):
            self.assertEqual(self.deny({"tool_name": name, "tool_input": {}})[0], "", name)
        self.assertIn("strict mode", self.deny({"tool_name": "mcp__ccd_sessionx__a", "tool_input": {}})[0])
        self.assertTrue(all(p.startswith("mcp__") for p in budget_hook.DESK_APP_TOOL_PREFIXES))
        self.assertIn("strict mode", self.deny({"tool_name": "mcp__github__create_issue", "tool_input": {}})[0])

    def test_status_says_whether_this_session_is_the_desk(self):
        import lean_agent as la
        with mock.patch.dict(os.environ, {"CLAUDE_CODE_SESSION_ID": "12345678-1234-1234-1234-123456789abc"}):
            self.assertEqual(la.this_session_role(), ("a normal session (not the desk)", False))
            self.assertIn("does not apply", la.this_session_line())
            lean_desk.attach("12345678-1234-1234-1234-123456789abc", None, None, time.time())
            self.assertEqual(la.this_session_role()[0], "the front desk (the attached app session)")
            self.assertIn("strict mode applies", la.this_session_line())
        with mock.patch.dict(os.environ, {"LEAN_AGENT_SERVICE_SESSION": "1"}):
            self.assertIn("hosted by the service", la.this_session_role()[0])


class Auto(Base):
    """desk auto: attach on SessionStart in the lean home; the hosted main stands aside when idle; it comes back when the desk goes."""

    def switch(self, make=None):
        made = []
        sh = ss.SwitchHost(lambda: made.append(1) or mock.Mock(last_input=0, run=mock.Mock(return_value=0)), now=lambda: self.clock[0])
        sh.cur = mock.Mock(last_input=0)  # a running hosted main
        sh.made = made
        return sh

    def setUp(self):
        super().setUp()
        self.clock = [self.now]

    def test_auto_is_the_default_and_attaches_on_start_in_the_lean_home(self):
        lean_desk.set_mode("auto")
        self.assertEqual(lean_desk.mode(), "auto")
        ctx, _ = self.hook("start", "s1")  # in the desk folder (<home>/home)
        self.assertEqual(lean_desk.record()["session_id"], "s1")
        self.assertTrue(lean_desk.record()["pending"])  # the service still hosts main
        self.assertIn("will become the front desk", ctx)
        stdin = io.StringIO(json.dumps({"session_id": "s2", "cwd": self.tmp}))  # the lean home root: not the desk folder
        with mock.patch.object(sys, "stdin", stdin), contextlib.redirect_stdout(io.StringIO()):
            desk_hook.main(["start"], now=self.now)
        self.assertEqual(lean_desk.record()["session_id"], "s1")

    def test_hosted_main_is_stopped_only_when_idle(self):
        sh = self.switch()
        lean_desk.attach("s1", None, None, self.clock[0])
        with mock.patch.object(ss, "mid_turn", return_value=True), mock.patch.object(ss, "checkpoint_session") as cp:
            self.assertIsNone(sh.tick(self.clock[0]))  # a turn is running
            sh.cur.last_input = self.clock[0] - 5
            with mock.patch.object(ss, "mid_turn", return_value=False):
                self.assertIsNone(sh.tick(self.clock[0]))  # typed 5 s ago
            sh.cur.last_input = self.clock[0] - 120
            cp.assert_not_called()
            with mock.patch.object(ss, "mid_turn", return_value=False):
                self.assertEqual(sh.tick(self.clock[0]), "app")
            cp.assert_called_once()
        sh.cur.stop.assert_called_once()

    def test_heartbeat_loss_resumes_the_hosted_main_and_gaps_hold(self):
        sh = ss.SwitchHost(lambda: mock.Mock(), now=lambda: self.clock[0])
        sh.cur = ss.ExternalHost()
        sh.cur.stop = mock.Mock()
        lean_desk.attach("s1", None, None, self.clock[0])
        lean_desk.set_active("app", "test", self.clock[0])
        sh.last_switch = self.clock[0]
        self.clock[0] += 31 * 60  # heartbeat gone, 31 min since the switch
        self.assertEqual(sh.wanted(self.clock[0]), "hosted")
        self.assertEqual(sh.tick(self.clock[0]), "hosted")
        sh.cur.stop.assert_called_once()

    def test_no_switch_within_ten_minutes(self):
        sh = ss.SwitchHost(lambda: mock.Mock(), now=lambda: self.clock[0])
        sh.cur = ss.ExternalHost()
        sh.cur.stop = mock.Mock()
        lean_desk.attach("s1", None, None, self.clock[0] - 40 * 60)  # heartbeat gone
        sh.switches = 1  # a later switch (the first one after a start ignores the gap)
        sh.last_switch = self.clock[0] - 300
        self.assertIsNone(sh.tick(self.clock[0]))
        sh.cur.stop.assert_not_called()
        sh.last_switch = self.clock[0] - 601
        self.assertEqual(sh.tick(self.clock[0]), "hosted")

    def test_first_switch_after_start_ignores_the_gap(self):
        sh = self.switch()
        lean_desk.attach("s1", None, None, self.clock[0])
        sh.last_switch = self.clock[0] - 5  # service just started
        sh.cur.last_input = self.clock[0] - 120
        with mock.patch.object(ss, "mid_turn", return_value=False), mock.patch.object(ss, "checkpoint_session"):
            self.assertEqual(sh.tick(self.clock[0]), "app")

    def test_later_switch_keeps_the_gap_unless_the_hosted_main_is_fresh(self):
        sh = self.switch()
        sh.switches = 1
        lean_desk.attach("s1", None, None, self.clock[0])
        sh.last_switch = self.clock[0] - 5
        sh.cur.last_input = self.clock[0] - 120  # a user typed into it earlier
        with mock.patch.object(ss, "mid_turn", return_value=False), mock.patch.object(ss, "checkpoint_session"):
            self.assertIsNone(sh.tick(self.clock[0]))
            sh.cur.last_input = 0  # never had a user turn since it started: fresh and idle
            self.assertEqual(sh.tick(self.clock[0]), "app")

    def test_pinned_modes(self):
        lean_desk.set_mode("hosted")
        sh = self.switch()
        lean_desk.attach("s1", None, None, self.clock[0])
        self.assertEqual(sh.wanted(self.clock[0]), "hosted")
        lean_desk.set_mode("external")
        self.assertEqual(sh.wanted(self.clock[0] + 99 * 60), "app")  # never hosts

    def test_switch_is_recorded_for_status(self):
        lean_desk.set_active("app", "an app session attached", self.now)
        self.assertEqual(lean_desk.state()["active"], "app")
        lean_desk.attach("s1", None, None, self.now)
        self.assertEqual(lean_desk.summary(self.now)["label"], "desk: app session")
        self.assertIn("app session", lean_desk.status_line(self.now))


class Folder(Base):
    def test_settings_refresh_is_idempotent_and_touches_only_lean_agent_keys(self):
        import lean_agent as la
        h = la.home("home")
        path = os.path.join(h, ".claude", "settings.json")
        os.makedirs(os.path.dirname(path))
        with open(path, "w") as fh:
            json.dump({"theme": "dark", "env": {"MINE": "1"}, "permissions": {"allow": ["Read"]}}, fh)
        glob_settings = os.path.join(os.path.expanduser("~"), ".claude", "settings.json")
        self.assertTrue(la.refresh_desk_folder(h))
        with open(path) as fh:
            first = json.load(fh)
        self.assertEqual((first["theme"], first["env"]["MINE"], first["permissions"]), ("dark", "1", {"allow": ["Read"]}))
        self.assertEqual(first["env"]["LEAN_AGENT_BRIEF"], "1")
        self.assertNotIn("LEAN_AGENT_SESSION_ROLE", first["env"])  # hosted thread sessions read this file too
        self.assertNotIn("LEAN_AGENT_DESK_SESSION", first["env"])
        la.prepare_home()  # the orchestrator permissions and the lean-agent allow survive prepare_home + refresh
        la.refresh_desk_folder(h)
        with open(path) as fh:
            kept = json.load(fh)
        self.assertIn("Bash(lean-agent:*)", kept["permissions"]["allow"])
        self.assertIn("Read", kept["permissions"]["allow"])
        self.assertTrue(kept["permissions"].get("deny"))
        self.assertEqual(kept["env"]["LEAN_AGENT_BRIEF"], "1")
        self.assertFalse(la.refresh_desk_folder(h))  # unchanged: nothing written
        self.assertFalse(os.path.exists(glob_settings))  # the user's global settings are never touched
        for leftover in ("CLAUDE.md", ".claude"):  # nothing in the lean home root: workers under it would load it
            self.assertFalse(os.path.exists(os.path.join(la.home(), leftover)), leftover)


class Ownership(Base):
    """One owner at a time: the app session is the desk only after the service stopped hosting main."""

    def test_pending_desk_gets_nothing_until_the_switch_then_only_the_app_gets_reports(self):
        self.assertEqual(lean_desk.mode(), "auto")
        lean_desk.set_active("hosted", "start", self.now)
        self.hook("start", "s1")
        self.assertTrue(lean_desk.is_pending("s1", self.now))
        self.assertFalse(lean_desk.is_desk("s1", self.now))
        self.report("while hosted")
        self.assertEqual(self.hook("prompt", "s1"), (None, None))  # the app session gets nothing
        self.assertEqual(self.hook("stop", "s1"), (None, None))
        self.assertEqual(len(ss.queued_reports()), 1)  # still queued for the hosted main
        import budget_gate
        self.assertFalse(budget_gate.is_front_desk({"session_id": "s1"}))  # no strict mode while pending
        # the hosted Reporter types into the hosted main while it is the owner
        host = mock.Mock(external=False)
        self.assertFalse(host.external)
        lean_desk.set_active("app", "an app session attached", self.now + 5)  # the service stopped hosting main
        self.assertTrue(lean_desk.is_desk("s1", self.now + 5))
        ctx, _ = self.hook("prompt", "s1", now=self.now + 6)
        self.assertIn("while hosted", ctx)
        self.assertTrue(budget_gate.is_front_desk({"session_id": "s1"}))
        rep = ss.Reporter(ss.ExternalHost(), now=lambda: self.now + 7)
        self.report("after")
        with mock.patch.object(ss.ExternalHost, "paste") as paste:
            rep.external_tick()
        paste.assert_not_called()  # the service types nothing once the app owns the desk

    def test_switchhost_confirms_the_app_desk_only_after_stopping_main(self):
        order = []
        sh = ss.SwitchHost(lambda: mock.Mock(), now=lambda: self.now)
        hosted = mock.Mock(last_input=0)
        hosted.stop.side_effect = lambda: order.append("stopped")
        hosted.run.side_effect = lambda: order.append("ran") or 0
        sh.cur = hosted
        lean_desk.attach("s1", None, None, self.now)  # auto: pending
        self.assertTrue(lean_desk.is_pending("s1", self.now))
        with mock.patch.object(ss, "mid_turn", return_value=False), mock.patch.object(ss, "checkpoint_session", return_value=True):
            self.assertEqual(sh.tick(self.now), "app")
        self.assertEqual(order, ["stopped"])
        self.assertTrue(lean_desk.is_pending("s1", self.now))  # confirmed only by run(), after the hosted run returned
        with mock.patch.object(ss.ExternalHost, "run", return_value=0):
            sh.switching = True
            sh.cur = hosted
            sh.last_switch = self.now
            sh.next_kind, sh.next_why = "app", "test"
            sh.make_hosted = lambda: hosted
            hosted.run.side_effect = lambda: 0
            sh.run()
        self.assertTrue(lean_desk.is_desk("s1", self.now))

    def test_a_checkpoint_that_times_out_keeps_the_hosted_main(self):
        sh = ss.SwitchHost(lambda: mock.Mock(), now=lambda: self.now)
        sh.cur = mock.Mock(last_input=0)
        lean_desk.attach("s1", None, None, self.now)
        with mock.patch.object(ss, "mid_turn", return_value=False), mock.patch.object(ss, "checkpoint_session", return_value=False):
            self.assertIsNone(sh.tick(self.now))
            sh.cur.stop.assert_not_called()
            self.assertIsNone(sh.tick(self.now + 30))  # not retried at once
        with mock.patch.object(ss, "mid_turn", return_value=False), mock.patch.object(ss, "checkpoint_session", return_value=True):
            self.assertEqual(sh.tick(self.now + 200), "app")


class Reattach(Base):
    def test_an_expired_desk_reattaches_on_its_next_hook_event(self):
        self.external()
        self.hook("start", "s1")
        late = self.now + 40 * 60
        self.assertIsNone(lean_desk.attached(late))
        self.assertEqual(self.hook("prompt", "s1", now=late), (None, None))  # refreshed; nothing pending
        self.assertTrue(lean_desk.is_desk("s1", late + 1))

    def test_an_expired_desk_does_not_displace_a_new_one(self):
        self.external()
        self.hook("start", "s1")
        late = self.now + 40 * 60
        self.hook("start", "s2", now=late)  # the first desk's heartbeat is gone: s2 takes over
        self.assertEqual(self.hook("prompt", "s1", now=late + 5), (None, None))
        self.assertEqual(lean_desk.record()["session_id"], "s2")

    def test_desk_attach_works_in_auto_mode(self):
        import lean_agent as la
        sid = "12345678-1234-1234-1234-123456789abc"
        with mock.patch.dict(os.environ, {"CLAUDE_CODE_SESSION_ID": sid}), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(lean_desk.mode(), "auto")
            la.cmd_desk(mock.Mock(action="attach"))
        self.assertEqual(lean_desk.record()["session_id"], sid)
        self.assertTrue(lean_desk.record()["pending"])
        with mock.patch.dict(os.environ, {"CLAUDE_CODE_SESSION_ID": "87654321-1234-1234-1234-123456789abc"}):
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                la.cmd_desk(mock.Mock(action="attach"))  # one desk only


class Boot(Base):
    """Service start in auto mode: wait for the app desk when it was the last owner; a shortcut to the desk folder."""

    def run_host(self, wait, last_owner):
        if last_owner:
            lean_desk.set_active(last_owner, "earlier", self.now - 3600)
        self.clock = [self.now]
        cfg = lean_desk.config()
        cfg["desk_boot_wait_s"] = wait
        lean_desk._write(lean_desk.lean_home("config.json"), cfg)
        made = []
        host = mock.Mock(last_input=0, run=mock.Mock(return_value=0))
        sh = ss.SwitchHost(lambda: made.append(1) or host, now=lambda: self.clock[0])
        sh.WATCH = 0.01
        real_wait = sh.stopping.wait

        def tick(_t=None):  # the clock jumps 30 s per poll
            self.clock[0] += 30
            if sh.stopping.is_set() or self.clock[0] > self.now + 400:
                sh.stopping.set()
            return real_wait(0)
        sh.stopping = mock.Mock(wait=tick, is_set=real_wait.__self__.is_set, set=real_wait.__self__.set)
        return sh, made

    def test_app_last_owner_and_it_attaches_in_time_no_hosted_main(self):
        sh, made = self.run_host(180, "app")
        orig = sh.stopping.wait
        n = [0]

        def attach_later(t=None):
            n[0] += 1
            if n[0] == 2:
                lean_desk.attach("s1", None, None, self.clock[0])
            return orig(t)
        sh.stopping.wait = attach_later
        with mock.patch.object(ss.SwitchHost, "watch", lambda self: None):
            with mock.patch.object(ss.ExternalHost, "run", lambda self: 0):
                sh.run()
        self.assertEqual(made, [])
        self.assertEqual(lean_desk.state()["active"], "app")
        self.assertFalse(lean_desk.record()["pending"])

    def test_app_last_owner_and_no_attach_hosts_after_the_timeout(self):
        sh, made = self.run_host(180, "app")
        with mock.patch.object(ss.SwitchHost, "watch", lambda self: None):
            sh.run()
        self.assertEqual(made, [1])
        self.assertEqual(lean_desk.state()["active"], "hosted")
        self.assertGreaterEqual(self.clock[0], self.now + 180)

    def test_hosted_or_unknown_last_owner_hosts_at_once(self):
        for owner in ("hosted", None):
            sh, made = self.run_host(180, owner)
            with mock.patch.object(ss.SwitchHost, "watch", lambda self: None):
                sh.run()
            self.assertEqual(made, [1])
            self.assertEqual(self.clock[0], self.now)  # no waiting

    def test_shortcut_is_created_idempotently_and_never_overwrites(self):
        home = os.path.join(self.tmp, "userhome")
        os.makedirs(home)
        with mock.patch.dict(os.environ, {"HOME": home}):
            os.makedirs(lean_desk.desk_dir(), exist_ok=True)
            link = lean_desk.shortcut_path()
            self.assertTrue(lean_desk.ensure_shortcut())
            self.assertTrue(lean_desk.ensure_shortcut())
            self.assertEqual(os.readlink(link), lean_desk.desk_dir())
            os.remove(link)
            open(link, "w").write("mine")  # a real file
            self.assertFalse(lean_desk.ensure_shortcut())
            self.assertEqual(open(link).read(), "mine")
            os.remove(link)
            os.makedirs(link)  # a real folder
            self.assertFalse(lean_desk.ensure_shortcut())
            self.assertTrue(os.path.isdir(link) and not os.path.islink(link))
            os.rmdir(link)
            os.symlink(home, link)  # a foreign symlink
            self.assertFalse(lean_desk.ensure_shortcut())
            self.assertEqual(os.readlink(link), home)
            os.remove(link)
            lean_desk._write(lean_desk.lean_home("config.json"), {"desk_shortcut": "off"})
            self.assertFalse(lean_desk.ensure_shortcut())
            self.assertFalse(os.path.lexists(link))

    def test_shortcut_cwd_attaches_the_same_as_the_real_path(self):
        home = os.path.join(self.tmp, "userhome")
        os.makedirs(home)
        with mock.patch.dict(os.environ, {"HOME": home}):
            os.makedirs(lean_desk.desk_dir(), exist_ok=True)
            lean_desk.ensure_shortcut()
            self.hook("start", "s1", cwd=lean_desk.shortcut_path())
        self.assertEqual(lean_desk.record()["session_id"], "s1")

    def test_resumed_and_compacted_sessions_attach_like_a_new_one(self):
        for src in ("resume", "compact", "startup"):
            lean_desk.detach()
            ctx, _ = self.hook("start", "s1", source=src)
            self.assertEqual(lean_desk.record()["session_id"], "s1", src)
            self.assertIn("front desk", ctx)


class Handover(Base):
    """A pending app desk must get the desk: refusals escalate, deliveries stop, typed input is the user's only, bounded waits."""

    def setUp(self):
        super().setUp()
        self.clock = [self.now]
        self.sh = ss.SwitchHost(lambda: mock.Mock(), now=lambda: self.clock[0])
        self.sh.cur = mock.Mock(last_input=0, last_user_input=0)
        lean_desk.attach("s1", None, None, self.clock[0])

    def tick(self, mid_turn=False):
        with mock.patch.object(ss, "mid_turn", return_value=mid_turn):
            return self.sh.tick(self.clock[0])

    def test_checkpoint_refusal_is_retried_then_escalates_and_the_switch_completes(self):
        sh = self.sh
        with mock.patch.object(ss, "checkpoint_session", return_value=False) as cp:
            self.assertIsNone(self.tick())
            self.assertIn("checkpoint refused", lean_desk.wait_reason(self.clock[0]))
            self.assertIsNone(self.tick())  # retry not due yet
            self.assertEqual(cp.call_count, 1)
            self.clock[0] += 121
            self.assertIsNone(self.tick())
            self.assertEqual(cp.call_count, 2)
            self.clock[0] += 121
            self.assertEqual(self.tick(), "app")  # stopped without a checkpoint
            self.assertEqual(cp.call_count, 2)
        sh.cur.stop.assert_called_once()
        self.assertEqual(lean_desk.wait_reason(self.clock[0]), "")

    def test_checkpoint_exception_counts_as_a_refusal_with_its_reason(self):
        with mock.patch.object(ss, "checkpoint_session", side_effect=OSError("socket closed")):
            self.assertIsNone(self.tick())
        self.assertIn("socket closed", lean_desk.wait_reason(self.clock[0]))

    def test_deliveries_while_pending_stay_queued_for_the_app_desk(self):
        os.makedirs(os.path.join(self.tmp, "chat"), exist_ok=True)
        tr = os.path.join(self.tmp, "main.jsonl")
        with open(os.path.join(self.tmp, "chat", "service.json"), "w") as fh:
            json.dump({"session_id": "m1", "transcript_path": tr, "ts": 1}, fh)
        with open(tr, "w") as fh:
            fh.write(json.dumps({"type": "assistant", "message": {"role": "assistant", "stop_reason": "end_turn",
                                                                  "content": [{"type": "text", "text": "ok"}]}}) + "\n")

        class H:
            key, last_input, last_output, external = "main", 0, 0.0, False
            stopping = __import__("threading").Event()
            pasted = []

            def alive(self):
                return True

            def paste(self, text):
                self.pasted.append(text)

            def tail_text(self):
                return ""
        h = H()
        rep = ss.Reporter(h, now=lambda: self.clock[0])
        self.report()
        for _ in range(8):  # the app desk is pending: nothing is typed into the hosted main
            self.clock[0] += 10
            rep.main_tick()
        self.assertEqual(h.pasted, [])
        self.assertEqual(len(ss.queued_reports()), 1)
        lean_desk.detach()  # no app desk pending: delivered as always
        for _ in range(8):
            self.clock[0] += 10
            rep.main_tick()
        self.assertTrue(h.pasted)

    def test_service_typed_input_does_not_reset_idle(self):
        sh = self.sh
        sh.cur.last_input = self.clock[0] - 5  # the checkpoint prompt the service typed
        sh.cur.last_user_input = self.clock[0] - 300
        with mock.patch.object(ss, "checkpoint_session", return_value=True):
            self.assertEqual(self.tick(), "app")

    def test_bridge_text_marked_svc_leaves_user_input_alone(self):
        h = ss.Host(lambda: (["x"], "i"), {}, self.tmp)
        h.paste = lambda text: None
        h.dispatch({"text": "checkpoint", "svc": True})
        self.assertGreater(h.last_input, 0)
        self.assertEqual(h.last_user_input, 0)
        h.dispatch({"text": "hello"})
        self.assertGreater(h.last_user_input, 0)

    def test_max_pending_forces_the_switch_when_not_mid_turn(self):
        sh = self.sh
        sh.switches = 1
        sh.last_switch = 0
        sh.cur.last_user_input = self.clock[0] - 5  # typed recently
        with mock.patch.object(ss, "checkpoint_session", return_value=True):
            self.assertIsNone(self.tick())
            self.assertEqual(lean_desk.wait_reason(self.clock[0]), "user typed 5s ago")
            self.clock[0] += 301
            lean_desk.heartbeat("s1", None, self.clock[0])
            sh.cur.last_user_input = self.clock[0] - 5
            self.assertIsNone(self.tick(mid_turn=True))  # still never in the middle of a turn
            self.assertEqual(self.tick(), "app")

    def test_stale_mid_turn_is_ignored_after_ten_minutes(self):
        sh = self.sh
        tr = os.path.join(self.tmp, "t.jsonl")
        open(tr, "w").write("{}\n")
        with mock.patch.object(ss, "session_transcript", return_value=tr), \
                mock.patch.object(ss, "checkpoint_session", return_value=True):
            os.utime(tr, (self.clock[0] - 60, self.clock[0] - 60))
            self.assertIsNone(self.tick(mid_turn=True))
            self.assertEqual(lean_desk.wait_reason(self.clock[0]), "hosted main mid-turn")
            os.utime(tr, (self.clock[0] - 601, self.clock[0] - 601))
            self.assertEqual(self.tick(mid_turn=True), "app")

    def test_status_shows_why_the_switch_waits_and_the_gap(self):
        sh = self.sh
        sh.cur.last_user_input = self.clock[0] - 20
        self.tick()
        line = lean_desk.status_line(self.clock[0])
        self.assertIn("pending", line)
        self.assertIn("user typed 20s ago", line)
        sh.switches = 1
        sh.last_switch = self.clock[0] - 5
        sh.cur.last_user_input = self.clock[0] - 500
        self.tick()
        self.assertIn("anti-flap gap until", lean_desk.status_line(self.clock[0]))


class Surface(Base):
    """Whoever holds the host (AutoClear, Reporter, the bridge, the map) must never meet a missing attribute across a switch."""

    HOST_SURFACE = ("alive", "paste", "stop", "stopping", "proc", "cwd", "env", "last_input", "last_user_input", "last_output",
                    "tail_text", "tail_len", "write", "created_at", "key", "name", "terminate_for", "dispatch", "external")

    def test_switch_host_always_has_a_host_and_answers_alive(self):
        sh = ss.SwitchHost(lambda: mock.Mock())
        self.assertIsNotNone(sh.cur)
        self.assertFalse(sh.alive())  # before the first host is up: an answer, not AttributeError('alive')
        for name in self.HOST_SURFACE:
            getattr(sh, name)
        self.assertIsNone(sh.tick())  # the placeholder is never "switched"

    def test_external_host_has_the_full_host_surface(self):
        eh = ss.ExternalHost()
        for name in self.HOST_SURFACE:
            self.assertTrue(hasattr(eh, name), name)
        self.assertEqual(eh.dispatch({"ping": True})["ok"], True)
        self.assertFalse(eh.dispatch({"text": "x"})["ok"])
        with self.assertRaises(RuntimeError):
            eh.write(b"x")

    def test_external_host_run_blocks_until_stopped(self):
        eh = ss.ExternalHost()
        done = []
        t = __import__("threading").Thread(target=lambda: done.append(eh.run()), daemon=True)
        t.start()
        time.sleep(0.3)
        self.assertEqual(done, [])  # no busy return
        eh.stop()
        t.join(2)
        self.assertEqual(done, [0])

    def test_autoclear_survives_a_switch_host_without_a_running_main(self):
        sh = ss.SwitchHost(lambda: mock.Mock())
        ss.AutoClear(sh).tick()  # used to raise AttributeError: alive

    def test_session_and_ping_requests_reach_the_bridge_while_the_app_is_the_desk(self):
        lean_desk.set_mode("external")
        with mock.patch.object(ss.socket, "socket") as sock:
            sock.return_value.recv.side_effect = [b'{"ok": true}\n', b"", b'{"ok": true}\n', b""]
            self.assertTrue(ss.sessions_request("list")["ok"])
            self.assertTrue(ss.request({"ping": True})["ok"])
        r = ss.request({"text": "x"})  # typing into the desk is still refused: its hooks deliver
        self.assertFalse(r["ok"])
        self.assertIn("front desk is external", r["error"])


if __name__ == "__main__":
    unittest.main()