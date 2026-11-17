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
    def test_default_hosted_and_switch(self):
        self.assertEqual(lean_desk.mode(), "hosted")
        self.assertIsNone(lean_desk.attached())
        self.external()
        self.assertEqual(lean_desk.mode(), "external")
        self.assertTrue(lean_desk.notify_on())
        lean_desk.set_notify(False)
        self.assertFalse(lean_desk.notify_on())

    def test_hooks_are_inert_when_hosted(self):
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
        self.assertIsInstance(rep.call_args[0][0], ss.ExternalHost)
        clear.assert_not_called()

    def test_hosted_still_starts_the_main_host(self):
        import lean_agent as la
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
        self.assertIn("no desk attached", lean_desk.status_line(self.now))
        self.assertEqual(lean_desk.attach("s1", "/t/s1.jsonl", "/c", self.now), (True, "attached"))
        self.assertIn("external, attached", lean_desk.status_line(self.now + 120))
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
        self.assertIn("external, attached", d["line"])
        snap = lean_map.build({"service": {"desk": d}, "threads": [], "runs": [], "inbox": 0, "desk_idle_s": 3})
        node = next(n for n in snap["nodes"] if n["id"] == "main")
        self.assertIn("external, attached", node["detail"])

    def test_pane_state_uses_the_cli_socket_path(self):
        down = lean_map.down_snapshot()
        self.assertFalse(down["service"]["up"])
        self.assertEqual(down["service"]["socket"], lean_sock.path())

    def test_socket_falls_back_to_the_default_home(self):
        base = tempfile.mkdtemp()
        default = os.path.join(base, ".lean-agent")
        os.makedirs(default)
        sock = os.path.join(os.path.realpath(default), "service.sock")
        open(sock, "w").close()
        import pwd
        with mock.patch.object(pwd, "getpwuid", return_value=mock.Mock(pw_dir=base)):
            self.assertEqual(lean_sock.path(), sock)  # a session without the service's LEAN_AGENT_HOME still finds it
        own = os.path.join(os.path.realpath(self.tmp), "service.sock")
        open(own, "w").close()
        with mock.patch.object(pwd, "getpwuid", return_value=mock.Mock(pw_dir=base)):
            self.assertEqual(lean_sock.path(), own)  # the resolved home always wins


if __name__ == "__main__":
    unittest.main()
