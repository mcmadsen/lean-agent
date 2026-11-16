"""Locks are held only around local bookkeeping: .auto-branch (no fetch / worktree setup under it), thread-start (no
start request or delivery under it), and a hook's threads.json update is parked, not dropped, when the lock is busy."""
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

from _env import scaled

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)

import lean_agent as agent  # noqa: E402
import lean_common  # noqa: E402
import lean_threads  # noqa: E402


def sh(cwd, *args):
    return subprocess.run(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", *args],
                          capture_output=True, text=True, check=True).stdout.strip()


def free(path):
    """True when `path`'s lock can be taken at once by this process."""
    try:
        with lean_common.file_lock(path, timeout=0.2):
            return True
    except lean_common.LockBusy:
        return False


class AutoBranch(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.repo = os.path.join(self.tmp, "repo")
        os.makedirs(self.repo)
        sh(self.repo, "init", "-q", "-b", "main")
        open(os.path.join(self.repo, "a.txt"), "w").write("a")
        sh(self.repo, "add", ".")
        sh(self.repo, "commit", "-qm", "init")
        remote = os.path.join(self.tmp, "remote.git")
        subprocess.run(["git", "init", "-q", "--bare", remote], check=True)
        sh(self.repo, "remote", "add", "origin", remote)
        sh(self.repo, "push", "-q", "origin", "main")
        self.h = os.path.join(self.tmp, "home")
        for p in (mock.patch.object(agent, "home", lambda *parts: os.path.join(self.h, *parts)),
                  mock.patch.object(agent, "projects", lambda: {"proj": {"path": self.repo, "base": "main"}})):
            p.start()
            self.addCleanup(p.stop)

    def test_the_lock_is_free_while_fetch_is_slow(self):
        real_git = agent.git
        seen = {"fetching": threading.Event(), "free": None}
        lock = os.path.join(self.h, "worktrees", "proj", ".auto-branch")

        def slow_git(repo, *args, **kw):
            if args[:1] == ("fetch",):
                seen["fetching"].set()
                seen["free"] = free(lock)  # another process could take the lock while the network is busy
                time.sleep(0.3)
            return real_git(repo, *args, **kw)

        a = mock.Mock(worktree="auto", worktree_base=None, todo=None, branch_name=None, branch_type=None,
                      branch_version=None)
        with mock.patch.object(agent, "git", slow_git):
            agent.reserve_auto_branch(a, "proj", self.repo, "add a thing")
        self.assertTrue(seen["fetching"].is_set())
        self.assertTrue(seen["free"])
        self.assertTrue(a.worktree)
        self.assertIn(a.worktree, sh(self.repo, "branch", "--format=%(refname:short)").split())  # reserved
        self.assertTrue(free(lock))

    def test_two_runs_get_different_names(self):
        names = []
        for _ in range(2):
            a = mock.Mock(worktree="auto", worktree_base=None, todo=None, branch_name=None, branch_type=None,
                          branch_version=None)
            agent.reserve_auto_branch(a, "proj", self.repo, "add a thing")
            names.append(a.worktree)
        self.assertEqual(len(set(names)), 2)

    def test_the_worktree_is_made_for_the_reserved_branch(self):
        a = mock.Mock(worktree="auto", worktree_base=None, todo=None, branch_name=None, branch_type=None,
                      branch_version=None)
        agent.reserve_auto_branch(a, "proj", self.repo, "add a thing")
        with mock.patch.object(agent, "live_runs", lambda: []):
            wt = agent.ensure_worktree("proj", self.repo, a.worktree, typed=False)
        self.assertEqual(wt["branch"], a.worktree)


class ThreadStart(unittest.TestCase):
    def test_the_start_lock_is_free_during_the_start_request(self):
        tmp = tempfile.mkdtemp()
        start_lock = os.path.join(tmp, "thread-start")
        seen = {}

        def start(tid, t, prompt, resume_old, force=False):
            seen["start_free"] = free(start_lock)
            seen["counted"] = tid in agent.starting_threads()
            return "name", "line"

        with mock.patch.object(agent, "home", lambda *p: os.path.join(tmp, *p)), \
                mock.patch.object(agent, "thread_session_tid", lambda t: (t, {})), \
                mock.patch.object(agent.lean_threads, "orphan_reason", lambda t: ""), \
                mock.patch.object(agent.service_session, "is_replacing", lambda t: False), \
                mock.patch.object(agent.service_session, "alive", lambda t=None: False), \
                mock.patch.object(agent, "make_room_for_thread_session", lambda *a, **k: None), \
                mock.patch.object(agent, "start_closed_thread", start), \
                mock.patch.object(agent, "confirm_first_message", lambda *a: True):
            agent.deliver_one("t1", "hello")
        self.assertTrue(seen["start_free"])
        self.assertTrue(seen["counted"])  # the slot is reserved for the cap while the lock is free
        self.assertEqual(agent.starting_threads(), set())  # and released afterwards

    def test_a_send_to_a_live_session_runs_outside_the_start_lock(self):
        tmp = tempfile.mkdtemp()
        seen = {}
        calls = iter([False, True])  # not alive at the first check, alive under the lock

        def send(prompt, tid):
            seen["free"] = free(os.path.join(tmp, "thread-start"))
            return True, ""

        with mock.patch.object(agent, "home", lambda *p: os.path.join(tmp, *p)), \
                mock.patch.object(agent, "thread_session_tid", lambda t: (t, {})), \
                mock.patch.object(agent.lean_threads, "orphan_reason", lambda t: ""), \
                mock.patch.object(agent.service_session, "is_replacing", lambda t: False), \
                mock.patch.object(agent.service_session, "alive", lambda t=None: next(calls)), \
                mock.patch.object(agent.service_session, "send", send):
            agent.deliver_one("t1", "hello")
        self.assertTrue(seen["free"])


class HookParking(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.env = mock.patch.dict(os.environ, {"LEAN_AGENT_HOME": self.tmp})
        self.env.start()
        self.addCleanup(self.env.stop)
        lean_threads.invalidate()
        self.addCleanup(lean_threads.invalidate)
        self.tid = lean_threads.new("work")

    def test_a_busy_lock_parks_the_update_and_the_next_holder_folds_it(self):
        lean_common.HOOK["on"] = True
        self.addCleanup(lean_common.HOOK.update, on=False)
        with mock.patch.object(lean_threads, "HOOK_THREADS_WAIT", 0.1), \
                lean_common.file_lock(lean_threads.path()):  # another process holds threads.json
            lean_threads.set_session(self.tid, session_id="abc")  # no LockBusy, nothing dropped
        self.assertTrue(os.path.exists(lean_threads.path() + ".pending"))
        self.assertNotEqual(lean_threads.load()["threads"][self.tid].get("session_id"), "abc")
        lean_common.HOOK["on"] = False
        lean_threads.set_session(self.tid, session_on=True)  # the next writer folds the parked update in
        t = lean_threads.load()["threads"][self.tid]
        self.assertEqual(t.get("session_id"), "abc")
        self.assertTrue(t.get("session_on"))
        self.assertFalse(os.path.exists(lean_threads.path() + ".pending"))
        self.assertFalse(os.path.exists(lean_threads.path() + ".pending.folding"))

    def test_a_short_busy_spell_is_waited_out(self):
        lean_common.HOOK["on"] = True
        self.addCleanup(lean_common.HOOK.update, on=False)
        holder = lean_common.file_lock(lean_threads.path())
        holder.__enter__()
        threading.Timer(0.3, lambda: holder.__exit__(None, None, None)).start()
        lean_threads.set_session(self.tid, session_id="xyz")
        self.assertEqual(lean_threads.load()["threads"][self.tid].get("session_id"), "xyz")
        self.assertFalse(os.path.exists(lean_threads.path() + ".pending"))


if __name__ == "__main__":
    unittest.main()
