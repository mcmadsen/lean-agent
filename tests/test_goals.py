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

    def test_near_limit_no_chase_and_says_so_once(self):
        gid = self.goal()
        out = self.watch(40, near=True)
        self.assertEqual(len(out), 1)
        self.assertIn("plan limit is near", out[0])
        self.assertEqual(self.sent, [])
        self.assertEqual(self.get(gid)["chase_count"], 0)
        self.assertEqual(self.watch(45, near=True), [])
        self.assertEqual(len(self.watch(46)), 1)  # limit gone: the chase happens

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
