"""Startup cleanup and the per-tick scans on a big home (150 threads x 30 requests): one write, fast, off the host loop."""
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

from _env import clean_environ

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)

import lean_threads  # noqa: E402
import service_session as ss  # noqa: E402


class StartupPerfTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        env = mock.patch.dict(os.environ, {**clean_environ(), "LEAN_AGENT_HOME": self.tmp}, clear=True)
        env.start()
        self.addCleanup(env.stop)
        old = lean_threads.datetime.datetime.fromtimestamp(time.time() - 7200).isoformat(timespec="seconds")
        threads = {}
        for i in range(1, 151):
            tid = f"t{i}"
            threads[tid] = {"id": tid, "name": f"n{i}", "closed": old if i % 4 else None,
                            "report": {"kind": "done", "text": "ok", "ts": lean_threads.now_iso()},
                            "requests": [{"id": f"r{j}", "text": f"req {j}", "ts": old} for j in range(30)]}
            if i % 4:
                d = os.path.join(self.tmp, "thread-inbox", tid)
                os.makedirs(d)
                with open(os.path.join(d, "0001-ab.json"), "w") as fh:
                    json.dump({"text": "queued", "rid": "r29"}, fh)
        os.makedirs(self.tmp, exist_ok=True)
        with open(lean_threads.path(), "w") as fh:
            json.dump({"threads": threads, "aliases": {}, "overrides": {}}, fh)

    def test_cleanup_one_write_and_fast(self):
        writes = []
        orig = os.replace
        with mock.patch("os.replace", side_effect=lambda a, b: (writes.append(b), orig(a, b))[1]):
            t0 = time.time()
            lines = ss.startup_cleanup()
            took = time.time() - t0
        self.assertLess(took, 5)
        self.assertEqual(sum(1 for w in writes if w == lean_threads.path()), 1)
        data = lean_threads.load()["threads"]
        self.assertTrue(all(r.get("handled_ts") for t in data.values() for r in t["requests"]))
        self.assertEqual(ss.spool_count("t1"), 0)
        self.assertTrue(any("startup cleanup:" in l for l in lines))

    def test_marker_prevents_second_cleanup(self):
        ss.startup_cleanup()
        self.assertEqual(ss.startup_cleanup(), [])

    def test_background_does_not_block_and_main_tick_fast(self):
        gate = threading.Event()
        calls = []
        with mock.patch.object(ss, "startup_cleanup", side_effect=lambda *a, **k: (gate.wait(5), calls.append(1))):
            t0 = time.time()
            th = ss.startup_cleanup_background(None, None)
            self.assertLess(time.time() - t0, 0.5)
            self.assertTrue(th.daemon)
            gate.set()
            th.join(3)
        self.assertEqual(calls, [1])

    def test_scans_fast(self):
        t0 = time.time()
        ss.attention_items(time.time())
        ss.repush_questions()
        self.assertLess(time.time() - t0, 5)

    def test_failure_is_logged_not_raised(self):
        logs = []
        with mock.patch.object(lean_threads, "load", side_effect=RuntimeError("boom")):
            ss.startup_cleanup(lambda m, lvl="info": logs.append(m))
        self.assertTrue(any("failed" in m for m in logs))


if __name__ == "__main__":
    unittest.main()
