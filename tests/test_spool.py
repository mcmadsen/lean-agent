"""Thread messages are spooled and delivered by the service: callers never wait for a session (fake clock / fake services)."""
import argparse
import contextlib
import io
import os
import socket
import sys
import tempfile
import threading
import types
import time
import unittest
from unittest import mock

from _env import clean_environ, scaled

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)

import lean_agent  # noqa: E402
import lean_goals  # noqa: E402
import lean_threads  # noqa: E402
import service_session as ss  # noqa: E402


class SpoolTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.env = mock.patch.dict(os.environ, {**clean_environ(), "LEAN_AGENT_HOME": self.tmp, "LEAN_AGENT_SEND_WAIT": "1.5"}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.tid = lean_threads.new("work")
        lean_threads.set_session(self.tid, session_id="11111111-1111-1111-1111-111111111111", session_on=True)
        self.socks = []

    def hung_service(self):
        """A bridge socket that accepts connections and never answers."""
        path = ss.sock_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(path)
        srv.listen(8)
        self.socks.append(srv)
        self.addCleanup(srv.close)
        conns = []

        def accept():
            while True:
                try:
                    conns.append(srv.accept()[0])
                except OSError:
                    return
        threading.Thread(target=accept, daemon=True).start()

    def send(self, text="status check?"):
        ns = lean_agent.build_parser().parse_args(["thread", "send", self.tid, text])
        out = io.StringIO()
        t0 = time.time()
        with contextlib.redirect_stdout(out):
            rc = lean_agent.cmd_thread(ns)
        return rc, out.getvalue().strip(), time.time() - t0

    def test_send_to_a_service_that_never_answers_returns_within_the_cap_and_queues(self):
        self.hung_service()
        rc, line, took = self.send()
        self.assertEqual(rc, 0)
        self.assertLess(took, scaled(8))
        self.assertIn(f"{self.tid}: queued: delivery pending (waking", line)
        files = os.listdir(ss.spool_dir(self.tid))  # queued, or claimed by the delivery still waiting in this process
        self.assertEqual(len([f for f in files if f.endswith((".json", ".sending"))]), 1)

    def test_a_claim_of_a_dead_deliverer_goes_back_to_the_queue(self):
        name = ss.spool_add(self.tid, "x")
        ss.spool_claim(self.tid, name)
        dead = os.fork() if hasattr(os, "fork") else None
        if dead == 0:
            os._exit(0)
        os.waitpid(dead, 0)
        path = os.path.join(ss.spool_dir(self.tid), name[:-5] + ".sending")
        with open(path, "w") as fh:
            fh.write('{"text": "x", "claimed_by": %d}' % dead)
        os.utime(path, (time.time() - 60, time.time() - 60))
        ss.spool_reclaim_stale(self.tid)
        self.assertEqual(ss.spool_pending(self.tid), [name])

    def test_queued_message_is_delivered_once_and_in_order_by_the_service(self):
        for text in ("first", "second", "third"):
            ss.spool_add(self.tid, text)
        got = []

        def deliver(tid):
            r = lean_agent.deliver_spool(tid, 0)
            return r[0] == "ok", r[1]
        with mock.patch.object(ss, "alive", return_value=True), mock.patch.object(lean_agent, "auto_fresh_reason", return_value=""), \
                mock.patch.object(ss, "send", side_effect=lambda text, key="main": got.append(text) or (True, "")):
            d = ss.SpoolDeliverer(run=deliver)
            for t in d.tick():
                t.join(scaled(10))
            d.tick()  # nothing left: no second delivery
        self.assertEqual(got, ["first", "second", "third"])
        self.assertEqual(ss.spool_pending(self.tid), [])

    def test_failed_delivery_stays_queued_and_is_retried_later(self):
        ss.spool_add(self.tid, "again")
        clock = [1000.0]
        calls = []
        d = ss.SpoolDeliverer(run=lambda tid: calls.append(tid) or (len(calls) > 1, "boom"), now=lambda: clock[0])
        for t in d.tick():
            t.join(scaled(5))
        self.assertEqual(len(calls), 1)
        for t in d.tick():  # inside the retry gap
            t.join(scaled(5))
        self.assertEqual(len(calls), 1)
        clock[0] += ss.SPOOL_RETRY + 1
        for t in d.tick():
            t.join(scaled(5))
        self.assertEqual(len(calls), 2)

    def test_a_claimed_message_is_taken_once(self):
        name = ss.spool_add(self.tid, "x")
        self.assertEqual(ss.spool_claim(self.tid, name)["text"], "x")
        self.assertIsNone(ss.spool_claim(self.tid, name))
        ss.spool_release(self.tid, name)
        self.assertEqual(ss.spool_pending(self.tid), [name])

    def test_goal_watchdog_send_does_not_block(self):
        self.hung_service()
        t0 = time.time()
        ok, _ = ss.goal_send(self.tid, "status?")
        self.assertTrue(ok)
        self.assertLess(time.time() - t0, 1)
        self.assertEqual(len(ss.spool_pending(self.tid)), 1)

    def slow_chaser(self, sleep, out, timeout=60, clock=time.time):
        code = ("import sys,time,json; time.sleep(%s); print(json.dumps(%r))" % (sleep, out))
        return ss.Chaser(timeout=timeout, clock=clock, argv=[sys.executable, "-c", code + "#"])

    def test_chaser_never_blocks_the_tick_and_its_result_is_applied_later(self):
        gid = lean_goals.ensure("PR 512", self.tid)
        old = lean_goals._iso(time.time() - 7200)
        lean_goals._set(gid, last_activity=old, created=old)
        info = lambda t: {"lost": [], "running": [], "question": False, "last": 0}
        chaser = self.slow_chaser(1.0, {"decisions": {gid: {"action": "chase", "message": "Status of PR 512?", "why": "quiet"}}, "_cost": 0.003})
        sent = []
        tick = lambda: lean_goals.watchdog(time.time(), lambda t, x: (sent.append(x) or (True, "")), lambda t: True, info, lambda: False,
                                           decide=chaser.decide, is_paused=lambda n: False)
        t0 = time.time()
        self.assertEqual(tick(), [])  # starts the helper and returns at once
        self.assertLess(time.time() - t0, 0.7)
        first = chaser.job["proc"]
        self.assertEqual(tick(), [])  # still running: no second helper, nothing decided
        self.assertIs(chaser.job["proc"], first)
        self.assertEqual(sent, [])
        first.wait(10)
        out = tick()  # a later tick applies the result
        self.assertEqual(len(out), 1)
        self.assertEqual(sent, ["Status of PR 512?"])
        self.assertIsNone(chaser.job)
        self.assertAlmostEqual(lean_goals.chase_log()[0]["cost"], 0.003)

    def test_chaser_timeout_kills_it_and_means_no_decision(self):
        now = [1000.0]
        chaser = self.slow_chaser(30, {"decisions": {}}, timeout=60, clock=lambda: now[0])
        ctx = [{"id": "g1"}]
        self.assertIsNone(chaser.decide(ctx))
        proc = chaser.job["proc"]
        now[0] += 30
        self.assertIsNone(chaser.decide(ctx))
        now[0] += 31
        self.assertEqual(chaser.decide(ctx), {})
        self.assertIsNotNone(proc.poll())  # killed
        self.assertIsNone(chaser.job)

    def test_timed_out_chaser_lost_worker_gets_the_plain_chase_quiet_is_skipped(self):
        a, b = lean_goals.ensure("PR 1", self.tid), lean_goals.ensure("PR 2", self.tid)
        old = lean_goals._iso(time.time() - 7200)
        for g in (a, b):
            lean_goals._set(g, last_activity=old, created=old)
        lost = [("0105-0900-aa11", {"started": "2026-01-05T09:00:00"})]
        info = lambda t: {"lost": lost, "running": [], "question": False, "last": 0}
        sent = []
        out = lean_goals.watchdog(time.time(), lambda t, x: (sent.append(x) or (True, "")), lambda t: True, info, lambda: False,
                                  decide=lambda ctxs: {}, is_paused=lambda n: False)
        self.assertEqual(len(out), 2)  # both are lost-kind here: plain chase
        info = lambda t: {"lost": [], "running": [], "question": False, "last": 0}
        lean_goals._set(a, chased_at="", last_decision="", decided_at="", chase_count=0)
        sent.clear()
        out = lean_goals.watchdog(time.time(), lambda t, x: (sent.append(x) or (True, "")), lambda t: True, info, lambda: False,
                                  decide=lambda ctxs: {}, is_paused=lambda n: False)
        self.assertEqual((out, sent), ([], []))

    def test_no_service_is_still_an_error(self):
        ns = lean_agent.build_parser().parse_args(["thread", "send", self.tid, "hi"])
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            lean_agent.cmd_thread(ns)
        self.assertEqual(ss.spool_pending(self.tid), [])


class FirstDeliveryTest(unittest.TestCase):
    """The first message of a thread is confirmed or retried: never lost, never delivered twice, never reported as started early."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.env = mock.patch.dict(os.environ, {**clean_environ(), "LEAN_AGENT_HOME": self.tmp, "LEAN_AGENT_SEND_WAIT": "1.5"}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.tid = lean_threads.new("work", "do the job")
        lean_threads.set_session(self.tid, session_id="11111111-1111-1111-1111-111111111111", session_on=True)
        self.rid = lean_threads.load()["threads"][self.tid]["requests"][0]["id"]
        self.got = []
        self.send = mock.patch.object(ss, "send", side_effect=lambda text, key="main": self.got.append(text) or (True, ""))
        self.alive = mock.patch.object(ss, "alive", return_value=True)
        self.fresh = mock.patch.object(lean_agent, "auto_fresh_reason", return_value="")
        for p in (self.send, self.alive, self.fresh):
            p.start()
            self.addCleanup(p.stop)

    def host(self, alive=True):
        h = mock.Mock(key=self.tid, stopping=threading.Event(), tail_len=0)
        h.alive.return_value = alive
        return h

    def test_first_message_sent_before_ready_is_retried_and_delivered_once(self):
        h = self.host()
        sessions = ss.Sessions(lambda tid: h)
        with mock.patch.object(ss, "wait_ready", return_value=False):
            sessions._first(h, "brief\n" + lean_threads.BRIEF_END + "\n\ndo the job", True)
        h.paste.assert_not_called()  # not typed into a box that is not up
        self.assertEqual(len(ss.spool_pending(self.tid)), 1)
        self.assertEqual(lean_agent.deliver_spool(self.tid, 0)[0], "ok")
        self.assertEqual(lean_agent.deliver_spool(self.tid, 0)[0], "ok")
        self.assertEqual(self.got, ["do the job"])

    def test_start_lock_busy_is_retried_not_dropped(self):
        ss.spool_add(self.tid, "later", rid=None)
        with mock.patch.object(lean_agent, "deliver_one", side_effect=lean_agent.lean_common.LockBusy("busy")):
            kind, _ = lean_agent.deliver_spool(self.tid, 0)
        self.assertEqual(kind, "deferred")
        self.assertEqual(len(ss.spool_pending(self.tid)), 1)
        self.assertEqual(lean_agent.deliver_spool(self.tid, 0)[0], "ok")
        self.assertEqual(self.got, ["later"])

    def test_parking_to_make_room_then_start_delivers_without_the_lock_held(self):
        lean_threads.set_session(self.tid, session_on=None)
        victim = {"thread": "t9", "title": "old", "idle": 7200}
        calls = {"room": 0, "park": 0, "start": 0}
        held = []

        def room(tid, defer_park=False):
            calls["room"] += 1
            if calls["room"] == 1:
                raise lean_agent.NeedPark(victim, "parking t9", 1, tid)

        def park(*a):
            calls["park"] += 1
            held.append(not lean_agent.thread_start_lock_try(0))  # the lock is free while a session is parked
            lean_agent.release_start_lock()

        def start(tid, t, prompt=None, msg=None):
            calls["start"] += 1
            return "name"
        with mock.patch.object(ss, "alive", return_value=False), mock.patch.object(lean_agent, "make_room_for_thread_session", room), \
                mock.patch.object(lean_agent, "park_to_make_room", park), mock.patch.object(lean_agent, "start_thread_session", start), \
                mock.patch.object(lean_agent, "prepare_thread_session", return_value=(True, "", {})), \
                mock.patch.object(lean_agent, "fresh_message", return_value=("m", 1)), \
                mock.patch.object(lean_agent, "confirm_first_message", return_value=True):
            line = lean_agent.deliver_one(self.tid, "do the job", new=True)
        self.assertEqual(calls, {"room": 2, "park": 1, "start": 1})
        self.assertEqual(held, [False])
        self.assertIn("started", line)

    def test_caller_says_queued_when_the_first_message_is_not_confirmed(self):
        ss.spool_add(self.tid, "do the job", new=True, rid=self.rid)
        with mock.patch.object(ss, "alive", return_value=False), mock.patch.object(lean_agent, "make_room_for_thread_session"), \
                mock.patch.object(lean_agent, "start_thread_session", return_value="name"), \
                mock.patch.object(lean_agent, "confirm_first_message", return_value=False):
            kind, line = lean_agent.deliver_spool(self.tid, 0)
        self.assertEqual(kind, "ok")
        self.assertIn("queued: delivery pending (first message not yet in the session)", line)
        self.assertNotIn("started", line)

    def reporter(self, now):
        return types.SimpleNamespace(now=lambda: now[0], log=lambda *a, **k: None)

    def test_no_turn_after_three_minutes_redelivers_once_with_one_main_line(self):
        t0 = time.time()
        now = [t0]
        rep = self.reporter(now)
        ss.Reporter.unstarted_tick(rep)
        self.assertEqual(ss.spool_pending(self.tid), [])
        now[0] = t0 + 200
        ss.Reporter.unstarted_tick(rep)
        self.assertEqual(len(ss.spool_pending(self.tid)), 1)
        now[0] = t0 + 500
        ss.Reporter.unstarted_tick(rep)  # once per request
        self.assertEqual(len(ss.spool_pending(self.tid)), 1)
        lines = [i["text"] for i in ss.queued_reports()]
        self.assertEqual(lines, [f"{self.tid}: request was not started, redelivered"])

    def test_no_double_delivery_once_the_request_started(self):
        ss.spool_add(self.tid, "do the job", rid=self.rid)
        lean_threads.pin(self.tid, "brief\n" + lean_threads.BRIEF_END + "\n\ndo the job")  # the session's turn started
        self.assertEqual(lean_agent.deliver_spool(self.tid, 0)[0], "ok")
        self.assertEqual(self.got, [])
        self.assertEqual(ss.spool_pending(self.tid), [])
        now = [time.time() + 600]
        ss.Reporter.unstarted_tick(self.reporter(now))
        self.assertEqual(ss.spool_pending(self.tid), [])
        self.assertEqual(ss.queued_reports(), [])

    def test_deliverer_backs_off_from_twenty_seconds_to_two_minutes(self):
        self.assertEqual(ss.spool_backoff(1), 20)
        self.assertGreater(ss.spool_backoff(3), ss.spool_backoff(2))
        self.assertEqual(ss.spool_backoff(30), 120)

    def test_status_shows_not_started_and_retrying(self):
        t = lean_threads.load()["threads"][self.tid]
        t["requests"][0]["ts"] = lean_threads.datetime.datetime.fromtimestamp(time.time() - 300).isoformat(timespec="seconds")
        self.assertIn("not started (5m), retrying", "\n".join(lean_threads.session_lines(self.tid, t)))

if __name__ == "__main__":
    unittest.main()


class FirstMessageTest(SpoolTest):
    def test_first_message_is_the_request_at_creation_and_marked_delivered_by_the_session(self):
        tid = lean_threads.new("review", "Please review the change")
        t = lean_threads.load()["threads"][tid]
        self.assertEqual([r["text"] for r in t["requests"]], ["Please review the change"])
        self.assertTrue(t["requests"][0]["undelivered"])
        self.assertIn("Please review the change", lean_threads.show_text(tid, all_=True))
        brief = "brief\n" + lean_threads.BRIEF_END + "\n\nPlease  review the change"
        lean_threads.pin(tid, brief)  # the session received it: no second request, flag cleared
        t = lean_threads.load()["threads"][tid]
        self.assertEqual(len(t["requests"]), 1)
        self.assertNotIn("undelivered", t["requests"][0])
        self.assertTrue(t["requests"][0]["delivered_ts"])

    def test_lost_first_paste_leaves_a_recorded_request_that_the_goal_check_redelivers_and_the_table_flags(self):
        # the host's first paste fails (logged only) and the spool entry is already done: before the fix thread show had
        # no request at all and nothing knew the message was missing
        tid = lean_threads.new("review", "Please review the change")
        t = lean_threads.load()["threads"][tid]
        created = lean_threads._epoch(t["created"])
        now = created + 12 * 60
        info = lean_goals.thread_info(tid)
        self.assertTrue(info["unstarted"]["undelivered"])
        self.assertIn("not started (12m)", lean_threads.short_text(now=now))
        lean_goals.ensure("PR 1", tid)
        sent = []
        lean_goals.watchdog(now, lambda t_, x: (sent.append(x) or (True, "")), lambda x: True,
                            lambda x: dict(lean_goals.thread_info(x), last=created), lambda: False)
        self.assertEqual(sent, ["Please review the change"])

    def test_started_thread_is_not_flagged(self):
        tid = lean_threads.new("review", "Please review the change")
        t = lean_threads.load()["threads"][tid]
        now = lean_threads._epoch(t["created"]) + 12 * 60
        lean_threads.pin(tid, "Please review the change")
        self.assertNotIn("not started", lean_threads.short_text(now=lean_threads._epoch(t["created"]) + 5))


class SpoolSurvivesReplacementTest(SpoolTest):
    def test_queued_while_replacing_is_delivered_once_to_the_new_session(self):
        sent = []
        ss.mark_replacing(self.tid)
        with mock.patch.object(ss, "alive", return_value=True), \
                mock.patch.object(ss, "send", side_effect=lambda text, key="main": (sent.append(text) or (True, ""))):
            ss.spool_add(self.tid, "first")
            ss.spool_add(self.tid, "second")
            self.assertEqual(lean_agent.deliver_spool(self.tid)[0], "deferred")
            self.assertEqual(sent, [])
            self.assertEqual(ss.spool_count(self.tid), 2)
            self.assertIn("2 messages queued for delivery", lean_threads.show_text(self.tid))
            ss.clear_replacing(self.tid)  # the new session has its brief
            self.assertEqual(lean_agent.deliver_spool(self.tid)[0], "ok")
            self.assertEqual(lean_agent.deliver_spool(self.tid)[0], "ok")
        self.assertEqual(sent, ["first", "second"])
        self.assertEqual(ss.spool_count(self.tid), 0)
        self.assertNotIn("queued for delivery", lean_threads.show_text(self.tid))

    def test_send_during_replacement_stays_queued_not_failed(self):
        ss.mark_replacing(self.tid)
        with mock.patch.object(ss, "alive", return_value=True):
            rc, out, _ = self.send("hello")
        self.assertEqual(rc, 0)
        self.assertIn("queued", out)
        self.assertEqual(ss.spool_count(self.tid), 1)

    def test_stale_marker_does_not_block_for_good(self):
        ss.mark_replacing(self.tid)
        old = time.time() - ss.REPLACING_TTL - 5
        os.utime(ss._replacing_path(self.tid), (old, old))
        self.assertFalse(ss.is_replacing(self.tid))
