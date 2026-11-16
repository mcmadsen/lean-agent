"""doctor: slow-trace listing, one shared 'guide is current' check, and speed on a busy home."""
import os
import sys
import tempfile
import time
import unittest

SCRIPTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, SCRIPTS)
import lean_slow  # noqa: E402


class SlowTraceListTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.old_env = os.environ.get("LEAN_AGENT_HOME")
        os.environ["LEAN_AGENT_HOME"] = os.path.join(self.tmp.name, ".lean-agent")
        self.addCleanup(lambda: os.environ.update({"LEAN_AGENT_HOME": self.old_env}) if self.old_env
                        else os.environ.pop("LEAN_AGENT_HOME", None))
        os.makedirs(lean_slow.folder())

    def trace(self, name, age_h, size=0):
        p = os.path.join(lean_slow.folder(), name)
        with open(p, "w") as fh:
            fh.write("Thread 0x1 (most recent call first):\n  File \"x.py\", line 1 in wait\n  File \"y.py\", line 2 in run\n")
            fh.write("pad\n" * size)
        t = time.time() - age_h * 3600
        os.utime(p, (t, t))
        return p

    def test_recent_listed_with_name_and_age_older_counted(self):
        self.trace("20260101T000000-doctor-11.txt", 2)
        self.trace("20250101T000000-runs-12.txt", 72)
        self.trace("20250101T000001-runs-13.txt", 96)
        lines = lean_slow.report_lines(3)
        self.assertEqual(len(lines), 2, lines)
        self.assertIn("20260101T000000-doctor-11.txt", lines[0])
        self.assertIn("logs/slow/", lines[0])
        self.assertIn("2h 0m ago", lines[0])
        self.assertNotIn("..txt", lines[0])
        self.assertTrue(lines[1].startswith("2 older slow trace(s)"), lines)

    def test_big_trace_is_not_read_whole(self):
        self.trace("20260101T000000-doctor-11.txt", 1, size=2_000_000)
        t0 = time.time()
        self.assertEqual(len(lean_slow.newest(3, 24)), 1)
        self.assertLess(time.time() - t0, 0.5)


if __name__ == "__main__":
    unittest.main()
