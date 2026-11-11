"""0.45.51: only a push needs an approving review (the gate runs it on the tip); overrides need the user's approval."""
import json
import os
import re
import subprocess
import sys
import unittest

PLUGIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent")
sys.path.insert(0, os.path.join(PLUGIN, "scripts"))

import lean_goals  # noqa: E402
import push_guard  # noqa: E402


class OverrideNeedsApproval(unittest.TestCase):
    def test_agent_override_is_denied_by_the_hook(self):
        cmd = 'lean-agent worktree push proj feature --override-guard "urgent"'
        self.assertIn("recorded approval", push_guard.override_without_approval(cmd))
        p = subprocess.run([sys.executable, os.path.join(PLUGIN, "scripts", "push_guard.py")], capture_output=True, text=True,
                           input=json.dumps({"tool_name": "Bash", "tool_input": {"command": cmd}, "cwd": "/"}))
        self.assertEqual(json.loads(p.stdout)["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_user_approved_override_passes_the_hook(self):
        cmd = 'lean-agent worktree push proj feature --override-guard "urgent" --allow-send "user said push it"'
        self.assertEqual(push_guard.override_without_approval(cmd), "")
        self.assertEqual(push_guard.override_without_approval("lean-agent worktree push proj feature"), "")


class NothingElseDemandsAReview(unittest.TestCase):
    def read(self, *parts):
        with open(os.path.join(PLUGIN, *parts), encoding="utf-8") as fh:
            return fh.read()

    def test_wrapup_hook_and_nudges_ask_for_no_review(self):
        self.assertNotRegex(self.read("scripts", "wrapup_hook.py"), r"lean-agent review")
        self.assertNotIn("review verdict,", lean_goals.nudge_message("t1"))

    def test_rules_say_review_only_before_a_push(self):
        for name in ("guide.md", "front-desk.md"):
            self.assertRegex(self.read("templates", name), r"[Rr]eview only right before a push")
        self.assertNotRegex(self.read("templates", "repo-block.md"), r"No pull request without")
        self.assertLess(len(self.read("templates", "front-desk.md")), 6000)


if __name__ == "__main__":
    unittest.main()
