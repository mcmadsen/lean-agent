"""0.45.53: the global private switch: `private off` hides private projects and their items and stops their
sessions; `private on` shows them again and restarts exactly what off stopped."""
import json
import os
import sys
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import test_private  # noqa: E402

sys.path.insert(0, test_private.SCRIPTS)


class SwitchCase(test_private.PrivateCase):
    def setUp(self):
        super().setUp()
        import lean_agent
        import lean_threads
        import service_session
        self.la, self.lt, self.ss = lean_agent, lean_threads, service_session
        self.sec = self.lt.new("vault audit work")      # private (its runs are in vault)
        self.pub = self.lt.new("open feature work")
        for tid, proj in ((self.sec, "vault"), (self.pub, "open")):
            with open(os.path.join(self.home, "ledger.jsonl"), "a") as fh:
                fh.write(json.dumps({"id": f"2026-01-01-0000{tid[1:]}-aaaa", "project": proj, "thread": tid,
                                     "role": "worker", "task": "t"}) + "\n")
            self.lt.set_session(tid, session_on=True, session_id=f"sid-{tid}")

    def off(self):
        live = [{"thread": self.sec, "name": "n", "pid": 1, "idle": 0}, {"thread": self.pub, "name": "n", "pid": 2, "idle": 0}]
        self.stopped = []

        def park(tid, by=None, keep_spool=False):
            self.stopped.append((tid, by))
            self.lt.set_session(tid, session_on=None, parked="now", parked_by=by)
        with mock.patch.object(self.la, "open_thread_sessions", return_value=live), \
                mock.patch.object(self.la, "park_thread_session", side_effect=park):
            self.la.private_off()

    def on(self, alive=True):
        started = []
        with mock.patch.object(self.ss, "alive", return_value=alive), \
                mock.patch.object(self.la, "start_thread_session", side_effect=lambda tid, t, **k: started.append(tid)):
            self.la.private_on()
        return started


class Hiding(SwitchCase):
    def test_off_hides_private_items_everywhere_and_on_restores(self):
        import lean_goals
        import lean_waiting
        lean_goals.add("PR 7", self.sec)
        lean_goals.add("PR 8", self.pub)
        lean_waiting.add("sign off vault thing", "question", None, self.sec, "")
        lean_waiting.add("open thing", "question", None, self.pub, "")
        self.assertIn("vault", self.cli("projects").stdout)
        self.assertIn("private mode: off", self.cli("private", "off").stdout)
        for cmd in (("projects",), ("now",), ("now", "--short"), ("goals",), ("waiting",), ("runs",)):
            with self.subTest(cmd=cmd):
                out = self.cli(*cmd).stdout
                self.assertNotIn("vault", out)
                self.assertNotIn(self.sec + " ", out + " ")
        self.assertIn("open", self.cli("projects").stdout)
        self.assertIn("private projects hidden", self.cli("now", "--short").stdout)
        self.assertIn("PR 8", self.cli("goals").stdout)
        self.assertIn("open thing", self.cli("waiting").stdout)
        self.assertIn("hidden: private", self.cli("thread", "show", self.sec).stdout + self.cli("now", "--show", self.sec).stdout)
        self.assertIn("private mode: off", self.cli("private", "status").stdout)
        self.assertIn("private projects hidden", self.cli("doctor", self.other, cwd=self.other).stdout)
        self.cli("private", "on")
        self.assertIn("vault", self.cli("projects").stdout)
        self.assertIn("PR 7", self.cli("goals").stdout)
        self.assertIn("sign off vault thing", self.cli("waiting").stdout)

    def test_off_hides_digest_and_nudges(self):
        self.ss.queue_report(self.sec, "needs-you", "secret question", force=True)
        self.ss.queue_report(self.pub, "done", "open done", force=True)
        self.cli("private", "off")
        items, _ = self.ss.take_reports()
        self.assertEqual([i["thread"] for i in items], [self.pub])
        self.ss.drop_reports(items)
        self.assertTrue(all(self.sec != x[0].split(":")[1] for x in self.ss.attention_items(time.time() + 9999) if ":" in x[0]))
        self.cli("private", "on")
        items, _ = self.ss.take_reports()
        self.assertEqual([i["thread"] for i in items], [self.sec])  # held, not dropped, delivered on `on`

    def test_non_private_items_unaffected(self):
        self.cli("private", "off")
        self.assertIn("open feature work", self.cli("now", "--short").stdout)
        self.assertIn(self.pub, self.lt.session_threads())


class Sessions(SwitchCase):
    def test_off_stops_private_sessions_and_records_them_and_on_restarts_only_those(self):
        self.lt.set_session(self.sec, session_on=True)
        self.off()
        self.assertEqual(self.stopped, [(self.sec, "private")])
        self.assertEqual(self.lt.load()["threads"][self.sec]["parked_by"], "private")
        self.assertEqual(self.lt.load()["threads"][self.sec]["parked_note"], "stopped by private off")
        self.assertEqual(self.pub in self.lt.load()["threads"], True)
        self.assertEqual(self.ss.restorable(self.sec, self.lt.load()), False)
        self.assertEqual(self.on(), [self.sec])
        self.assertIsNone(self.lt.load()["threads"][self.sec].get("parked_by"))
        self.assertEqual(self.la.lean_private.read_stopped(), [])

    def test_on_skips_a_thread_closed_meanwhile_and_one_off_did_not_stop(self):
        self.off()
        self.lt.load()
        with self.lt._locked() as data:
            data["threads"][self.sec]["closed"] = time.time()
        self.assertEqual(self.on(), [])

    def test_snapshot_drops_private_sessions(self):
        self.ss.write_snapshot([self.sec, self.pub])
        self.off()
        self.assertEqual(self.ss.read_snapshot()["threads"], [self.pub])


class Refusals(SwitchCase):
    MSG = "private projects are hidden: lean-agent private on"

    def test_run_and_thread_send_refused(self):
        self.cli("private", "off")
        p = self.cli("run", "-p", "vault", "do it") if False else self.cli("run", "--project", "vault", "do it")
        self.assertNotEqual(p.returncode, 0)
        self.assertIn(self.MSG, p.stdout + p.stderr)
        for act in ("send", "open"):
            p = self.cli("thread", act, self.sec, "hello") if act == "send" else self.cli("thread", act, self.sec)
            self.assertNotEqual(p.returncode, 0)
            self.assertIn(self.MSG, p.stdout + p.stderr)

    def test_routing_never_picks_a_private_thread(self):
        self.cli("private", "off")
        data = self.lt.load()
        tid, line, kind = self.lt.decide("continue the vault audit work please", data)
        self.assertIsNone(tid)
        self.assertIn(self.MSG, line)
        tid, line, kind = self.lt.decide(f"about {self.sec} please", data)
        self.assertIsNone(tid)
        self.assertIn(self.MSG, line)
        tid, line, kind = self.lt.decide("audit work on the open feature", data)
        self.assertNotEqual(tid, self.sec)

    def test_front_desk_shortcut(self):
        for word in ("on", "off"):
            tid, line, kind = self.lt.decide(f"private {word}", self.lt.load())
            self.assertEqual((tid, kind), (None, "job"))
            self.assertIn(f"lean-agent private {word}", line)


if __name__ == "__main__":
    unittest.main()
