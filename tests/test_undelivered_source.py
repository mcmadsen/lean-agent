"""One source of truth for "undelivered": the nudge counts what `thread discard` clears; stale flags are cleaned up."""
import os
import sys
import tempfile
import time
import unittest
from unittest import mock

from _env import clean_environ

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)

import lean_threads  # noqa: E402
import service_session as ss  # noqa: E402


class UndeliveredSourceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        env = mock.patch.dict(os.environ, {**clean_environ(), "LEAN_AGENT_HOME": self.tmp}, clear=True)
        env.start()
        self.addCleanup(env.stop)
        self.tid = lean_threads.new("work")
        self.now = time.time()
        self.old = self.now - 7200

    def flag_request(self, ts=None):
        with lean_threads._locked() as data:
            data["threads"][self.tid]["requests"] = [{"id": "r1", "ts": lean_threads.now_iso() if ts is None else
                                                      time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(ts)), "text": "do it", "undelivered": True}]

    def spool(self, suffix, rid=None):
        d = os.path.join(self.tmp, "thread-inbox", self.tid)
        os.makedirs(d, exist_ok=True)
        name = f"{int((self.now - 1800) * 1e9):020d}-abc123{suffix}"
        lean_common = lean_threads.lean_common
        lean_common.write_json_atomic(os.path.join(d, name), {"text": "hello", "rid": rid})
        return os.path.join(d, name)

    def flags(self):
        return [r for r in lean_threads.load()["threads"][self.tid]["requests"] if r.get("undelivered")]

    def test_stale_flag_without_file_cleaned_and_not_nudged(self):
        self.flag_request(self.old)
        self.assertEqual(lean_threads.clear_stale_undelivered(self.now), [(self.tid, "r1")])
        self.assertEqual(self.flags(), [])
        self.assertFalse([i for i in ss.attention_items(self.now, 60) if self.tid in i[0]])

    def test_recent_flag_kept_and_backed_flag_kept(self):
        self.flag_request(self.now - 60)
        self.assertEqual(lean_threads.clear_stale_undelivered(self.now), [])
        self.flag_request(self.old)
        self.spool(".json", "r1")
        self.assertEqual(lean_threads.clear_stale_undelivered(self.now), [])

    def test_discard_clears_flag_without_file(self):
        self.flag_request(self.old)
        res = lean_threads.discard_all(self.tid)
        self.assertEqual(res["flags"], ["r1"])
        self.assertEqual(self.flags(), [])

    def test_discard_clears_held_injected_and_sending(self):
        paths = [self.spool(".injected"), ]
        self.assertTrue(lean_threads.undelivered_age(self.tid, self.now) > 0)
        res = lean_threads.discard_all(self.tid)
        self.assertEqual([k for _, _, k in res["files"]], ["injected"])
        self.assertFalse(os.path.exists(paths[0]))
        self.assertEqual(lean_threads.undelivered_age(self.tid, self.now), 0)
        p = self.spool(".sending")
        lean_threads.discard_spool(self.tid)
        self.assertFalse(os.path.exists(p))

    def test_nudge_and_discard_agree(self):
        for suf in (".json", ".sending", ".injected"):
            p = self.spool(suf)
            self.assertEqual([t for t, _ in lean_threads.undelivered_threads(self.now, 60)], [self.tid], suf)
            self.assertTrue([i for i in ss.attention_items(self.now, 60) if i[0] == f"undelivered:{self.tid}"], suf)
            lean_threads.discard_all(self.tid)
            self.assertFalse(os.path.exists(p))
            self.assertEqual(lean_threads.undelivered_threads(self.now, 60), [], suf)
            self.assertFalse([i for i in ss.attention_items(self.now, 60) if i[0] == f"undelivered:{self.tid}"], suf)

    def test_replied_request_is_not_unstarted(self):
        self.flag_request(self.old)
        with lean_threads._locked() as data:
            data["threads"][self.tid]["report"] = {"text": "done", "ts": lean_threads.now_iso()}
        t = lean_threads.load()["threads"][self.tid]
        self.assertIsNone(lean_threads.unstarted_request(t, [], self.now))


if __name__ == "__main__":
    unittest.main()
