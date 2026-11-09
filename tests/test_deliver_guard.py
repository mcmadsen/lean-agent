"""A spooled message is delivered at the thread's next idle moment; stuck items nudge main once (fake clock / fake sessions)."""
import os
import sys
import tempfile
import time
import unittest
from unittest import mock

from _env import clean_environ

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)

import lean_agent  # noqa: E402
import lean_threads  # noqa: E402
import service_session as ss  # noqa: E402


class DeliverGuardTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        env = mock.patch.dict(os.environ, {**clean_environ(), "LEAN_AGENT_HOME": self.tmp}, clear=True)
        env.start()
        self.addCleanup(env.stop)
        self.tid = lean_threads.new("work")
        lean_threads.set_session(self.tid, session_id="11111111-1111-1111-1111-111111111111", session_on=True)
        self.sent = []
        self.mid = [True]
        for target, rv in (("alive", True), ("alive_thread", True)):
            p = mock.patch.object(ss, target, return_value=rv)
            p.start()
            self.addCleanup(p.stop)
        p = mock.patch.object(ss, "mid_turn", side_effect=lambda k="main": self.mid[0])
        p.start()
        self.addCleanup(p.stop)
        p = mock.patch.object(ss, "send", side_effect=lambda text, key="main": (self.sent.append(text) or True, ""))
        p.start()
        self.addCleanup(p.stop)
        p = mock.patch.object(lean_agent, "auto_fresh_reason", return_value="")
        p.start()
        self.addCleanup(p.stop)

    def age_spool(self, secs):
        d = ss.spool_dir(self.tid)
        for n in os.listdir(d):
            if n[:20].isdigit():
                new = f"{int((time.time() - secs) * 1e9):020d}" + n[20:]
                os.rename(os.path.join(d, n), os.path.join(d, new))

    def test_send_mid_turn_waits_then_delivers_once_at_turn_end(self):
        ss.spool_add(self.tid, "answer")
        self.assertEqual(lean_agent.deliver_spool(self.tid)[0], "deferred")
        self.assertEqual(self.sent, [])
        self.assertIn("thread busy, delivers at its next turn end", lean_agent.queued_line(self.tid))
        self.assertEqual(ss.SpoolDeliverer(run=lambda t: (_ for _ in ()).throw(AssertionError("busy"))).tick(), [])
        self.mid[0] = False  # turn ended
        ran = []
        d = ss.SpoolDeliverer(run=lambda t: (ran.append(t), (lean_agent.deliver_spool(t)[0] == "ok", ""))[1])
        for th in d.tick():
            th.join(5)
        self.assertEqual(ran, [self.tid])
        self.assertEqual(self.sent, ["answer"])
        self.assertEqual(ss.spool_count(self.tid), 0)
        self.assertEqual(lean_agent.deliver_spool(self.tid)[0], "ok")
        self.assertEqual(self.sent, ["answer"])  # never a second copy

    def test_send_during_fresh_swap_goes_to_the_new_session(self):
        self.mid[0] = False
        ss.mark_replacing(self.tid)
        ss.spool_add(self.tid, "hello")
        self.assertEqual(lean_agent.deliver_spool(self.tid)[0], "deferred")
        self.assertEqual(self.sent, [])
        ss.clear_replacing(self.tid)  # new session has its brief
        self.assertEqual(lean_agent.deliver_spool(self.tid)[0], "ok")
        self.assertEqual(self.sent, ["hello"])

    def test_park_and_cap_refuse_while_a_message_is_spooled(self):
        ss.spool_add(self.tid, "pending")
        with mock.patch.object(lean_agent, "close_thread_session") as close:
            with self.assertRaises(RuntimeError):
                lean_agent.park_thread_session(self.tid, by="idle")
            close.assert_not_called()
        s = {"thread": self.tid, "idle": 99999}
        self.assertIn("a message is queued for delivery", lean_agent.close_blockers(s, {}, set(), None, True))
        self.assertEqual(lean_agent.idle_stop_threads.__name__, "idle_stop_threads")

    def test_queued_after_turn_end_delivered_within_20_seconds(self):
        self.mid[0] = False
        ss.spool_add(self.tid, "late")
        clock = [1000.0]
        results = [(False, "boom"), (True, "")]
        d = ss.SpoolDeliverer(run=lambda t: results.pop(0), now=lambda: clock[0])
        for th in d.tick():
            th.join(5)
        clock[0] += ss.SPOOL_RETRY_MAX + 0.5  # the retry never backs off beyond 20 s
        started = d.tick()
        self.assertEqual(len(started), 1)
        for th in started:
            th.join(5)
        self.assertEqual(results, [])

    def test_status_shows_undelivered_after_a_minute(self):
        ss.spool_add(self.tid, "x")
        self.assertEqual(lean_threads.undelivered_label(self.tid), "")
        self.age_spool(185)
        self.assertEqual(lean_threads.undelivered_label(self.tid), "undelivered message (3m)")
        self.assertIn("undelivered message (3m)", lean_threads.show_text(self.tid))
        table = lean_threads.short_text()
        self.assertIn("undelivered message (3m)", table)

    def test_nudge_lists_items_once_and_repeats_after_15_minutes(self):
        ss.spool_add(self.tid, "x")
        self.age_spool(400)
        t2 = lean_threads.new("other")
        qid = lean_threads.ask(t2, "which one?", "a|b")
        now = time.time() + 400
        lines = ss.nudge_main(now)
        text = "\n".join(lines)
        self.assertIn(f"lean-agent thread wake {self.tid}", text)
        self.assertIn(f'lean-agent thread answer {t2} {qid} "<answer>"', text)
        self.assertEqual(len(lines), 2)
        queued = [i for i in ss.queued_reports() if i.get("tag") == "nudge"]
        self.assertEqual(len(queued), 1)  # one compact message
        self.assertEqual(ss.nudge_main(now + 300), [])  # not again within 15 min
        self.assertEqual(len(ss.nudge_main(now + 901)), 2)
        self.assertEqual(ss.nudge_main(now + 2000, skip={t2, self.tid}).__len__(), 1)  # the pushed question is left out

    def test_young_items_are_not_nudged(self):
        ss.spool_add(self.tid, "x")
        self.age_spool(100)
        self.assertEqual(ss.nudge_main(time.time()), [])


if __name__ == "__main__":
    unittest.main()
