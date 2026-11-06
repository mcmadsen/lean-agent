"""Goals store, watchdog and final-report handling (lean_goals), with a fake clock and fake senders."""
import datetime
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

from _env import clean_environ

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)

import lean_goals  # noqa: E402
import lean_waiting  # noqa: E402

T0 = datetime.datetime(2026, 1, 5, 10, 0, 0).timestamp()
MIN = 60

FINAL = """Ready.
Ref: PR 512
Head sha: abc1234
Review: approve, no open findings
Checks: green
Left: nothing
Proposed action: push + post comments
"""


class GoalsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.env = mock.patch.dict(os.environ, {**clean_environ(), "LEAN_AGENT_HOME": self.tmp}, clear=True)
        self.env.start()
        self.sent = []
        self.asked = []
        self.info_by = {}

    def tearDown(self):
        self.env.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def send(self, tid, text):
        self.sent.append((tid, text))
        return True, ""

    def info(self, tid):
        return {"lost": [], "running": [], "question": False, "last": T0, **self.info_by.get(tid, {})}

    def goal(self, **fields):
        gid = lean_goals.ensure("PR 512", "t21")
        lean_goals._set(gid, last_activity=lean_goals._iso(T0), created=lean_goals._iso(T0), **fields)
        return gid

    def watch(self, minutes, alive=True, near=False):
        return lean_goals.watchdog(T0 + minutes * MIN, self.send, lambda tid: alive, self.info, lambda: near)

    def get(self, gid):
        return next(g for g in lean_goals._load() if g["id"] == gid)

    def test_blocked_goal_is_listed_never_chased_and_frees_when_unblocked_or_blocker_done(self):
        gid = self.goal()
        self.assertTrue(lean_goals.block(gid, "the vendor answer"))
        self.assertEqual(self.get(gid)["state"], "blocked")
        self.assertIn("blocked on: the vendor answer", lean_goals.table())
        self.watch(300)
        self.assertEqual(self.sent, [])
        self.assertTrue(lean_goals.unblock(gid))
        self.assertEqual(self.get(gid)["state"], "active")
        self.assertFalse(lean_goals.unblock(gid))
        lean_goals.block(gid, "g99")
        other = lean_goals.ensure("work item 7", "t22")
        lean_goals._set(gid, blocked_on=other)
        self.watch(1)
        self.assertEqual(self.get(gid)["state"], "blocked")
        lean_goals.done(other)
        self.watch(1)
        self.assertEqual(self.get(gid)["state"], "active")

    def test_drop_keeps_the_reason(self):
        gid = self.goal()
        lean_goals.drop(gid, "not needed any more")
        self.assertEqual((self.get(gid)["state"], self.get(gid)["next"]), ("dropped", "not needed any more"))

    # -- creation
    def test_thread_text_creates_one_goal_per_ref(self):
        a = lean_goals.note_text("please finish PR 512 and push it", "t21")
        b = lean_goals.note_text("status of #512?", "t21")
        self.assertEqual(a, b)
        self.assertEqual(lean_goals.note_text("just chatting", "t21"), "")
        self.assertEqual(len(lean_goals.open_goals()), 1)
        self.assertEqual(lean_goals.open_goals()[0]["ref"], "PR 512")

    def test_work_item_is_its_own_goal(self):
        lean_goals.note_text("PR 512", "t1")
        lean_goals.note_text("work item 512", "t2")
        self.assertEqual(len(lean_goals.open_goals()), 2)

    def test_todo_ref_and_run_task_create_goals(self):
        os.environ["LEAN_AGENT_THREAD"] = "t7"
        sys.path.insert(0, ROOT)
        import lean_agent
        a = mock.Mock(ref="PR 77")
        self.assertTrue(lean_goals.note_text(str(a.ref), "t7"))
        self.assertTrue(lean_goals.note_text("Review pull request 78 for the checkout change", "t7"))
        self.assertEqual({g["ref"] for g in lean_goals.open_goals()}, {"PR 77", "PR 78"})
        self.assertTrue(hasattr(lean_agent, "cmd_goals"))

    def test_done_drop_next_and_table(self):
        g1 = lean_goals.add("PR 1", "t1")
        g2 = lean_goals.add("PR 2", "t2")
        lean_goals.set_next(g1, "wait for CI")
        lean_goals.drop(g2)
        table = lean_goals.table()
        self.assertIn("Goal", table.splitlines()[0])
        self.assertIn("wait for CI", table)
        self.assertNotIn("PR 2", table)
        lean_goals.done(g1)
        self.assertEqual(lean_goals.table(), "")
        self.assertEqual(lean_goals.now_text(), "")

    def test_now_text_lists_goals(self):
        lean_goals.add("PR 9", "t3")
        self.assertTrue(lean_goals.now_text().startswith("Goals"))
        self.assertIn("PR 9", lean_goals.now_text())

    # -- watchdog
    def test_quiet_thread_is_nudged_once_per_period(self):
        gid = self.goal()
        self.assertEqual(self.watch(10), [])
        out = self.watch(31)
        self.assertEqual(len(out), 1)
        self.assertIn("chased t21 (PR 512): quiet", out[0])
        self.assertIn("PR 512", self.sent[0][1])
        self.assertEqual(self.get(gid)["chase_count"], 1)
        self.assertEqual(self.watch(40), [])  # same quiet period
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(len(self.watch(65)), 1)

    def test_running_worker_or_open_question_is_not_chased(self):
        self.goal()
        self.info_by["t21"] = {"running": ["r1"]}
        self.assertEqual(self.watch(120), [])
        self.info_by["t21"] = {"question": True}
        self.assertEqual(self.watch(120), [])
        self.assertEqual(self.sent, [])

    def test_activity_keeps_the_goal_quiet_clock_fresh(self):
        self.goal()
        self.info_by["t21"] = {"last": T0 + 25 * MIN}
        self.assertEqual(self.watch(40), [])

    def test_lost_worker_asks_to_resume(self):
        self.goal()
        self.info_by["t21"] = {"lost": [("0105-1000-ab12", {})]}
        out = self.watch(2)
        self.assertIn("worker lost", out[0])
        self.assertIn("asked to resume", out[0])
        self.assertIn("lean-agent run --resume 0105-1000-ab12", self.sent[0][1])
        self.assertIn("ONE consolidated final report", self.sent[0][1])

    def test_parked_session_is_woken(self):
        self.goal()
        out = self.watch(45, alive=False)
        self.assertIn("session parked", out[0])
        self.assertEqual(len(self.sent), 1)

    def test_three_chases_then_stuck_with_one_waiting_item(self):
        gid = self.goal()
        for m in (31, 62, 93):
            self.assertEqual(len(self.watch(m)), 1)
        out = self.watch(124)
        self.assertIn("stuck after 3 chases", out[0])
        self.assertEqual(self.get(gid)["state"], "stuck")
        self.assertEqual(len(self.sent), 3)
        items = lean_waiting.open_items()
        self.assertEqual(len(items), 1)
        self.assertIn("t21 / PR 512 is stuck after 3 chases: what next?", items[0]["summary"])
        self.assertTrue(items[0]["options"])
        self.assertEqual(self.watch(300), [])  # stuck goals are not chased again

    # -- the cheap chase (pre-checks, one batched helper decision, limit pacing)
    def decide(self, answers=None, cost=0.002):
        def fn(ctxs):
            self.asked.append([c["id"] for c in ctxs])
            out = {c["id"]: dict((answers or {}).get(c["id"]) or {"action": "chase", "message": "Status of PR 512?", "why": "quiet"}) for c in ctxs}
            out["_cost"] = cost
            return out
        return fn

    def cheap(self, minutes, decide, near=False, alive=True, paused=False):
        return lean_goals.watchdog(T0 + minutes * MIN, self.send, lambda t: alive, self.info, lambda: near, decide=decide,
                                   is_paused=lambda now: paused)

    def second_goal(self):
        gid = lean_goals.ensure("PR 600", "t22")
        lean_goals._set(gid, last_activity=lean_goals._iso(T0), created=lean_goals._iso(T0))
        return gid

    def test_finished_or_replaced_run_is_not_lost(self):
        self.goal()
        self.asked = []
        self.info_by["t21"] = {"lost": [("0105-0900-aa11", {"started": "2026-01-05T09:00:00"})],
                               "runs": [{"id": "0105-0950-bb22", "started": "2026-01-05T09:50:00", "task": "finish PR 512"}]}
        self.assertEqual(self.cheap(2, self.decide()), [])
        self.assertEqual((self.sent, self.asked), ([], []))  # a newer run of the same goal: no chase, no helper call
        self.info_by["t21"]["runs"][0]["task"] = "review PR 999"  # a run for another goal is no replacement
        self.assertEqual(len(self.cheap(3, self.decide({"g1": {"action": "chase"}}))), 1)
        self.assertIn("lean-agent run --resume 0105-0900-aa11", self.sent[0][1])

    def test_waiting_item_closed_thread_and_running_are_not_quiet(self):
        self.goal()
        self.asked = []
        for st in ({"waiting": True}, {"closed": True}, {"running": ["r1"]}):
            self.info_by["t21"] = st
            self.assertEqual(self.cheap(300, self.decide()), [])
        self.assertEqual(self.asked, [])

    def test_superseded_reply_is_remembered_and_never_chased_again(self):
        gid = self.goal()
        self.asked = []
        lost = [("0105-0900-aa11", {"started": "2026-01-05T09:00:00"})]
        self.info_by["t21"] = {"lost": lost}
        self.assertEqual(len(self.cheap(2, self.decide({"g1": {"action": "chase"}}))), 1)
        lean_goals.acknowledge("t21", "Ignoring 0105-0900-aa11: superseded by the restart")
        skip = self.decide({"g1": {"action": "skip", "why": "thread said superseded"}})
        self.assertEqual(self.cheap(80, skip), [])
        self.assertEqual(self.cheap(200, skip), [])
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.asked[-1], ["g1"])  # only a quiet check remains; the run itself is not a lost worker
        self.assertIn("0105-0900-aa11", lean_goals.memory()["runs"])
        self.assertEqual(self.get(gid)["state"], "active")

    def test_any_reply_to_a_chase_acknowledges_the_chased_run(self):
        self.goal()
        self.info_by["t21"] = {"lost": [("0105-0900-aa11", {"started": "2026-01-05T09:00:00"})]}
        self.assertEqual(len(self.cheap(2, None)), 1)
        lean_goals.acknowledge("t21", "restarted it, working")
        self.info_by["t21"]["last"] = T0 + 110 * MIN  # the reply is activity
        self.assertEqual(lean_goals.memory()["runs"]["0105-0900-aa11"]["why"], "chase answered")
        self.assertEqual(self.cheap(120, None), [])

    def test_abandoned_or_merged_reply_closes_the_goal(self):
        gid = self.goal()
        self.assertEqual(lean_goals.acknowledge("t21", "PR 512 was abandoned, the branch is closed"), [gid])
        self.assertEqual(self.get(gid)["state"], "dropped")
        self.assertIn(gid, lean_goals.memory()["goals"])
        g2 = lean_goals.ensure("PR 700", "t30")
        self.assertEqual(lean_goals.acknowledge("t30", "PR 700 merged"), [g2])
        self.assertEqual(self.get(g2)["state"], "done")
        g3 = lean_goals.ensure("PR 701", "t31")
        self.assertEqual(lean_goals.acknowledge("t31", "tests finished for the other task, PR 999 is merged"), [])
        self.assertEqual(self.get(g3)["state"], "active")

    def test_helper_drop_and_done_decisions_close_the_goal(self):
        a, b = self.goal(), self.second_goal()
        self.asked = []
        out = self.cheap(40, self.decide({a: {"action": "drop-goal", "why": "PR closed"}, b: {"action": "done-goal", "why": "merged"}}))
        self.assertEqual(len(out), 1)
        self.assertIn("dropped goal", out[0])
        self.assertEqual((self.get(a)["state"], self.get(b)["state"]), ("dropped", "done"))
        self.assertEqual(self.sent, [])
        self.assertEqual(self.cheap(300, self.decide()), [])

    def test_pause_means_nothing_at_all(self):
        self.goal()
        self.asked = []
        self.info_by["t21"] = {"lost": [("0105-0900-aa11", {"started": "2026-01-05T09:00:00"})]}
        self.assertEqual(self.cheap(300, self.decide(), paused=True), [])
        self.assertEqual((self.sent, self.asked), ([], []))
        lean_goals.pause(T0 + 60 * MIN)
        self.assertTrue(lean_goals.paused(T0 + 30 * MIN))
        self.assertFalse(lean_goals.paused(T0 + 61 * MIN))
        self.assertEqual(lean_goals.watchdog(T0 + 40 * MIN, self.send, lambda t: True, self.info, lambda: False), [])
        lean_goals.pause()
        self.assertTrue(lean_goals.paused(T0 + 9999 * MIN))
        self.assertTrue(lean_goals.resume())
        self.assertFalse(lean_goals.paused())
        self.assertEqual(lean_goals.parse_until("2h", T0), T0 + 7200)

    def test_near_limit_check_runs_quiet_nudge_waits_lost_worker_wakes(self):
        quiet, lost = self.goal(), self.second_goal()
        self.asked = []
        self.info_by["t22"] = {"lost": [("0105-0900-aa11", {"started": "2026-01-05T09:00:00"})]}
        out = self.cheap(40, self.decide(), near=True)
        self.assertEqual(self.asked, [[quiet, lost]])  # the cheap check still ran
        self.assertEqual([t for t, _ in self.sent], ["t22"])  # only the lost worker woke its thread
        self.assertEqual(len(out), 1)
        self.assertEqual(self.get(quiet)["last_decision"], "defer")
        self.assertEqual(self.cheap(45, self.decide(), near=True), [])
        self.assertEqual(len(self.sent), 1)
        out = self.cheap(50, self.decide(), near=False)  # the window allows it: the deferred nudge goes, no new helper call
        self.assertEqual(len(out), 1)
        self.assertEqual(self.asked, [[quiet, lost]])
        self.assertEqual([t for t, _ in self.sent], ["t22", "t21"])
        self.assertEqual(self.sent[1][1], "Status of PR 512?")

    def test_one_batched_call_and_one_decision_per_quiet_period(self):
        a, b = self.goal(), self.second_goal()
        self.asked = []
        out = self.cheap(40, self.decide({a: {"action": "skip", "why": "superseded"}, b: {"action": "skip", "why": "nothing pending"}}, cost=0.004))
        self.assertEqual((out, self.asked, self.sent), ([], [[a, b]], []))
        self.assertEqual(self.cheap(50, self.decide()), [])  # same quiet period: no new decision
        self.assertEqual(self.asked, [[a, b]])
        self.assertEqual(self.get(a)["last_decision"], "skip")
        rows = lean_goals.chase_log()
        self.assertEqual(len(rows), 2)
        self.assertAlmostEqual(sum(r["cost"] for r in rows), 0.004)
        self.assertEqual(sum(1 for r in rows if r.get("call")), 1)
        text = lean_goals.log_text()
        self.assertIn("skip", text)
        self.assertIn("superseded", text)
        self.assertIn("skip: superseded", lean_goals.table(T0 + 50 * MIN, detail=True))
        self.assertEqual(len(self.cheap(80, self.decide())), 2)  # the next quiet period decides again

    def test_per_hour_cap_defers_quiet_goals_but_not_lost_workers(self):
        os.environ["LEAN_AGENT_CHASER_PER_HOUR"] = "1"
        a = self.goal()
        self.asked = []
        self.cheap(40, self.decide({a: {"action": "skip", "why": "x"}}))
        self.assertEqual(len(self.asked), 1)
        b = self.second_goal()
        self.cheap(45, self.decide())
        self.assertEqual(len(self.asked), 1)  # cap reached
        self.assertEqual(self.sent, [])
        self.assertEqual(self.get(b)["last_decision"], "defer")
        self.info_by["t22"] = {"lost": [("0105-0900-aa11", {"started": "2026-01-05T09:00:00"})]}
        self.assertEqual(len(self.cheap(46, self.decide())), 1)  # a lost worker still wakes
        self.assertEqual(len(self.asked), 1)
        self.cheap(120, self.decide({b: {"action": "skip", "why": "y"}}))  # an hour later the helper may run again
        self.assertEqual(len(self.asked), 2)

    def test_waiting_user_and_done_goals_are_not_chased(self):
        self.goal(state="waiting-user")
        self.assertEqual(self.watch(300), [])

    def test_failed_send_is_not_counted(self):
        gid = self.goal()
        out = lean_goals.watchdog(T0 + 40 * MIN, lambda t, x: (False, "no session"), lambda t: True, self.info, lambda: False)
        self.assertIn("failed", out[0])
        self.assertEqual(self.get(gid)["chase_count"], 0)

    def test_report_resets_the_chase_count(self):
        gid = self.goal(chase_count=2)
        lean_goals.touch("t21", reset=True)
        self.assertEqual(self.get(gid)["chase_count"], 0)

    # -- final report
    def test_final_report_makes_one_push_question(self):
        wid = lean_goals.final_report("t21", FINAL)
        g = lean_goals.open_goals()[0]
        self.assertEqual(g["state"], "waiting-user")
        item = lean_waiting.open_items()[0]
        self.assertEqual((item["id"], item["kind"], item["ref"]), (wid, "push", "PR 512"))
        self.assertEqual(item["options"], ["Push", "Push and post", "Post only", "Hold"])
        self.assertIn("push + post comments", item["summary"])

    def test_second_final_report_replaces_the_open_question(self):
        w1 = lean_goals.final_report("t21", FINAL)
        w2 = lean_goals.final_report("t21", FINAL.replace("abc1234", "def5678").replace("push + post comments", "hold"))
        self.assertEqual(w1, w2)
        items = lean_waiting.open_items()
        self.assertEqual(len(items), 1)
        self.assertIn("def5678", items[0]["summary"])
        self.assertEqual(len(lean_goals.open_goals()), 1)

    def test_other_text_is_not_a_final_report(self):
        self.assertIsNone(lean_goals.parse_final("Ref: PR 5\nall fine"))
        self.assertEqual(lean_goals.final_report("t1", "done, nothing to push"), "")
        self.assertEqual(lean_waiting.open_items(), [])

    def test_answering_the_push_question_then_reporting_pushed_finishes_the_goal(self):
        wid = lean_goals.final_report("t21", FINAL)
        lean_waiting.done(wid, "Push")
        self.assertEqual(lean_goals.open_goals()[0]["state"], "active")
        lean_goals.finished("t21", "Pushed abc1234 and posted the comments.")
        self.assertEqual(lean_goals.open_goals(), [])

    def test_quiet_setting(self):
        self.assertEqual(lean_goals.quiet_minutes(), 30)
        with mock.patch.dict(os.environ, {"LEAN_AGENT_GOAL_QUIET": "2h"}):
            self.assertEqual(lean_goals.quiet_minutes(), 120)
        with open(os.path.join(self.tmp, "config.json"), "w") as fh:
            json.dump({"goal_quiet": "10m"}, fh)
        self.assertEqual(lean_goals.quiet_minutes(), 10)


if __name__ == "__main__":
    unittest.main()
