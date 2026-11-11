"""0.45.47: a worktree registry entry without "path" never crashes the readers."""
import argparse
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)

import lean_agent as agent  # noqa: E402


class NoPath(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.good = os.path.join(self.tmp, "good")
        os.makedirs(self.good)
        self.reg = os.path.join(self.tmp, "worktrees.json")
        with open(self.reg, "w") as fh:
            json.dump({"proj": {"good": {"path": self.good, "ref": "good", "branch": None, "last_used": "2026-01-01T00:00:00"},
                                "bad": {"created": "2026-01-01T00:00:00", "setup": "running", "ref": "bad", "branch": "bad"}}}, fh)
        self.p = mock.patch.object(agent, "home", lambda *parts: self.reg if parts == ("worktrees.json",) else os.path.join(self.tmp, *parts))
        self.p.start()
        self.addCleanup(self.p.stop)
        self.pp = mock.patch.object(agent, "projects", lambda: {})
        self.pp.start()
        self.addCleanup(self.pp.stop)

    def run_cmd(self, **kw):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            agent.cmd_worktrees(argparse.Namespace(project=None, **kw))
        return out.getvalue()

    def test_lists_all_without_crash(self):
        out = self.run_cmd()
        self.assertIn(self.good, out)
        self.assertIn("no path recorded", out)

    def test_prune_drops_it(self):
        self.run_cmd(prune=True)
        self.assertEqual(list(json.load(open(self.reg))["proj"]), ["good"])

    def test_setup_mark_records_path(self):
        path = os.path.join(self.tmp, "new")
        os.makedirs(path)
        os.makedirs(os.path.join(self.tmp, "worktrees", "proj"))
        with mock.patch.object(agent.subprocess, "run", return_value=mock.Mock(returncode=0)):
            agent.run_worktree_setup("proj", "fresh", path, "true")
        self.assertEqual(json.load(open(self.reg))["proj"]["fresh"]["path"], os.path.realpath(path))


if __name__ == "__main__":
    unittest.main()
