"""0.45.68: private filtering reads the ledger once (not once per row): `runs`, `runs --last` and `now` stay fast with a
big ledger, filtering stays correct in both private modes, and it refreshes when the files change."""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)

import lean_private  # noqa: E402

THREADS = 300
ROWS = 30000


class Fast(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("LEAN_AGENT_")}
        self.env["LEAN_AGENT_HOME"] = self.tmp
        self.env["LEAN_AGENT_TEST"] = "1"
        self.old = os.environ.get("LEAN_AGENT_HOME")
        os.environ["LEAN_AGENT_HOME"] = self.tmp
        self.addCleanup(self.restore)
        self.write("projects.json", {"pub": {"path": self.tmp}, "sec": {"path": self.tmp, "private": True}})
        self.write("threads.json", {"threads": {f"t{i}": {"created": "2026-01-01T00:00:00"} for i in range(THREADS)},
                                    "aliases": {}, "overrides": {}})
        with open(os.path.join(self.tmp, "ledger.jsonl"), "w") as fh:
            for i in range(ROWS):
                t = i % THREADS
                proj = "sec" if t % 3 == 0 else "pub"  # threads t0, t3, ... are private
                fh.write(json.dumps({"id": f"0101-{i:06d}-abcd", "ts": "2026-01-01T00:00:00", "started": "2026-01-01T00:00:00",
                                     "project": proj, "model": "sonnet", "task": "t", "status": "done", "thread": f"t{t}"}) + "\n")

    def restore(self):
        if self.old is None:
            os.environ.pop("LEAN_AGENT_HOME", None)
        else:
            os.environ["LEAN_AGENT_HOME"] = self.old

    def write(self, name, data):
        with open(os.path.join(self.tmp, name), "w") as fh:
            json.dump(data, fh)

    def cli(self, *args):
        t = time.time()
        p = subprocess.run([sys.executable, os.path.join(ROOT, "lean_agent.py"), *args], env=self.env, capture_output=True, text=True, timeout=120)
        return p.stdout, time.time() - t

    def test_fast_and_correct_in_both_modes(self):
        for mode in ("on", "off"):
            self.write("config.json", {"private": "off"} if mode == "off" else {})
            for args in (("runs",), ("runs", "--last"), ("now",)):
                out, secs = self.cli(*args)
                self.assertLess(secs, 2, f"private {mode}: {args} took {secs:.1f}s")
        self.write("config.json", {"private": "off"})
        out, _ = self.cli("runs")  # rows 29990 (public) and 29991 (private) are among the last ten
        self.assertIn("0101-029990-abcd", out)
        self.assertNotIn("0101-029991-abcd", out)
        self.write("config.json", {})
        out, _ = self.cli("runs")
        self.assertIn("0101-029991-abcd", out)
        self.assertIn("0101-029990-abcd", out)
        with open(os.path.join(self.tmp, "ledger.jsonl"), "a") as fh:  # a new private run shows up as hidden at once
            fh.write(json.dumps({"id": "0102-000001-abcd", "ts": "2026-01-02T00:00:00", "started": "2026-01-02T00:00:00", "project": "sec",
                                 "model": "sonnet", "task": "t", "status": "done", "thread": "t1"}) + "\n")
        self.write("config.json", {"private": "off"})
        out, _ = self.cli("runs")
        self.assertNotIn("0102-000001-abcd", out)

    def test_in_process_filter_is_correct_and_refreshes(self):
        self.write("config.json", {"private": "off"})
        self.assertTrue(lean_private.hides({"id": "x", "thread": "t0"}))
        self.assertFalse(lean_private.hides({"id": "x", "thread": "t1"}))
        t = time.time()
        for i in range(ROWS):
            lean_private.hides({"id": "x", "thread": f"t{i % THREADS}"})
        self.assertLess(time.time() - t, 2)
        with open(os.path.join(self.tmp, "ledger.jsonl"), "a") as fh:  # t1 gains a run in a private project only
            fh.write(json.dumps({"id": "0102-000001-abcd", "project": "sec", "thread": "tnew", "status": "done"}) + "\n")
        self.assertTrue(lean_private.hides({"thread": "tnew"}))
        self.write("projects.json", {"pub": {"path": self.tmp}, "sec": {"path": self.tmp}})  # no longer private
        self.assertFalse(lean_private.hides({"thread": "t0"}))
        self.write("projects.json", {"pub": {"path": self.tmp, "private": True}, "sec": {"path": self.tmp, "private": True}})
        self.assertTrue(lean_private.hides({"thread": "t1"}))
        self.write("config.json", {})
        self.assertFalse(lean_private.hides({"thread": "t1"}))


if __name__ == "__main__":
    unittest.main()
