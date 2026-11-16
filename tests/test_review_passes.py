"""Fixed reviewer passes: triggers, checklist only when triggered, per-pass output lines, stale-text class, prompt size."""
import contextlib
import io
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

from _env import clean_environ

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)


def diff(path, removed=(), added=()):
    return (f"--- a/{path}\n+++ b/{path}\n@@ -1 +1 @@\n" + "".join(f"-{l}\n" for l in removed)
            + "".join(f"+{l}\n" for l in added))


class PassesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        env = dict(clean_environ(), LEAN_AGENT_HOME=self.tmp, HOME=self.tmp)
        p = mock.patch.dict(os.environ, env, clear=True)
        p.start()
        self.addCleanup(p.stop)
        sys.modules.pop("lean_agent", None)
        import lean_agent
        import lean_passes
        self.agent, self.p = lean_agent, lean_passes

    def hit(self, path, removed=(), added=()):
        return self.p.triggered([path], diff(path, removed, added))

    def test_e2e_paths(self):
        for f in ("e2e/login.spec.ts", "web/e2e/a.ts", "x.e2e.js", "playwright.config.ts", "cypress.config.js",
                  ".github/workflows/t.yml", "azure-pipelines.yml", "Jenkinsfile", "ci/build.yml", "pipelines/a/b.yaml"):
            self.assertIn("e2e-ci", self.hit(f, added=["x"]), f)
        self.assertNotIn("e2e-ci", self.hit("src/app.py", added=["x = 1"]))

    def test_logging_by_diff_content(self):
        self.assertIn("logging", self.hit("a.py", ["logger.error('x')"], ["logger.warning('x')"]))
        self.assertIn("logging", self.hit("a.js", ["console.error(e)"], []))
        self.assertNotIn("logging", self.hit("a.py", [], ["x = 1"]))

    def test_flavours_flags(self):
        self.assertIn("flavours-flags", self.hit("app/flavors/prod.json", added=["{}"]))
        self.assertIn("flavours-flags", self.hit("a.py", added=["if feature_flags.get('x'):"]))
        self.assertNotIn("flavours-flags", self.hit("a.py", added=["x = 1"]))

    def test_stale_text_rename_and_default_flip(self):
        self.assertIn("stale-text", self.hit("a.py", ["def old_name(x):"], ["def new_name(x):"]))
        self.assertIn("stale-text", self.hit("a.py", ["def f(x, strict=False):"], ["def f(x, strict=True):"]))
        self.assertNotIn("stale-text", self.hit("a.py", [], ["def brand_new():"]))
        self.assertNotIn("stale-text", self.hit("a.py", ["x = 1"], ["x = 2"]))

    def test_checklist_only_for_triggered(self):
        text = self.agent.focus_text({"tests": [], "params": [], "state": [], "passes": ["logging"]})
        self.assertIn("alerting", text)
        self.assertNotIn("vacuously", text)
        self.assertNotIn("removal path", text)
        self.assertEqual(self.agent.focus_text({"tests": [], "params": [], "state": [], "passes": []}), "")

    def test_prompt_size_without_triggers_unchanged_and_all_measured(self):
        fc = {"tests": [], "params": [], "state": []}
        none = len(self.agent.focus_text(dict(fc, passes=[])))
        base = len(self.agent.focus_text(fc))
        everything = len(self.agent.focus_text(dict(fc, passes=list(self.p.PASSES))))
        self.assertLessEqual(abs(none - base), 0.05 * max(base, 1) + 1)
        print(f"focus text chars: no pass {none}, all passes {everything}; reviewer rule {len(self.agent.REVIEWER_RULE)}")
        self.assertGreater(everything, none)

    def report(self, passes, findings):
        out = io.StringIO()
        meta = {"mode": "ref", "ref": "b", "head": "a" * 40, "base": "main", "passes": passes}
        with contextlib.redirect_stdout(out), mock.patch.object(self.agent, "enforce_review_rules",
                                                                 lambda r, m, d=(): ("approve", findings, [], [])), \
                mock.patch.object(self.agent, "append_jsonl"), mock.patch.object(self.agent, "declined_for", lambda *a: ()):
            self.agent.report_review("slug", self.tmp, {"id": "r1"}, {"verdict": "approve", "findings": findings}, meta)
        return out.getvalue()

    def test_output_lines(self):
        f = [{"severity": "minor", "category": "stale-text", "file": "a.py", "line": 3, "issue": "comment says old name"},
             {"severity": "major", "category": "tests", "file": "e2e/a.ts", "line": 1, "issue": "vacuous", "pass": "e2e-ci"}]
        out = self.report(["e2e-ci", "logging", "stale-text"], f)
        self.assertIn("e2e-ci: checked, 1 finding\n", out)
        self.assertIn("logging: checked, no finding", out)
        self.assertIn("stale-text: checked, 1 finding", out)
        self.assertIn("passes not triggered: flavours-flags", out)
        self.assertIn("[minor/stale-text] a.py:3: comment says old name", out)
        self.assertIn("passes not triggered: " + ", ".join(self.p.PASSES), self.report([], []))


if __name__ == "__main__":
    unittest.main()
