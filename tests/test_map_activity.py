"""Live map activity: what agents are doing. Safe targets, rings, aggregation, worker stats, totals, privacy, speed."""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

from _env import clean_environ

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)

import lean_activity as act  # noqa: E402
import lean_map  # noqa: E402
import lean_sock  # noqa: E402
import lean_threads  # noqa: E402
import service_session as ss  # noqa: E402

SECRET = "s3cr3t-token-value"


def ctx(runs=(), threads=3, rows=(), home=""):
    ths = [{"id": f"t{i}", "title": f"Thread {i}", "state": "active", "detail": "x", "idle_s": 5} for i in range(1, threads + 1)]
    return {"service": {"pid": 1, "version": "0", "socket_ms": 0.6, "cpu_pct": 1.0, "threads": 5, "up_s": 9},
            "paused": False, "inbox": 0, "threads": ths, "desk_idle_s": 4, "runs": list(runs), "rows": list(rows), "home": home}


def pre_post(node, tool, inp, tid, t0, dur=0.5, ok=True):
    ev = {"tool_name": tool, "tool_input": inp, "tool_use_id": tid}
    act.ingest(act.hook_message(dict(ev, hook_event_name="PreToolUse"), node, now=t0), now=t0)
    act.ingest(act.hook_message(dict(ev, hook_event_name="PostToolUse" if ok else "PostToolUseFailure"), node, now=t0 + dur),
               now=t0 + dur)


class ActivityTest(unittest.TestCase):
    def setUp(self):
        lean_map.reset()
        act.reset()
        self.tmp = tempfile.mkdtemp()
        p = mock.patch.dict(os.environ, {**clean_environ(), "LEAN_AGENT_HOME": self.tmp}, clear=True)
        p.start()
        self.addCleanup(p.stop)

    # privacy ---------------------------------------------------------------------------------------------
    def test_privacy_per_tool_kind(self):
        cases = [
            ("Bash", {"command": f"/usr/local/bin/pytest -k x --token {SECRET} /home/someone/proj/tests"}, ("Bash", "pytest")),
            ("Bash", {"command": f"API_KEY={SECRET} git push origin main"}, ("Bash", "git")),
            ("Bash", {"command": ""}, ("Bash", "")),
            ("Edit", {"file_path": "/home/someone/deep/a/b/lean_map.py", "old_string": SECRET}, ("Edit", "lean_map.py")),
            ("Write", {"file_path": "/x/y/z.txt", "content": SECRET}, ("Write", "z.txt")),
            ("Read", {"file_path": "/x/y/readme.md"}, ("Read", "readme.md")),
            ("NotebookEdit", {"notebook_path": "/x/n.ipynb"}, ("NotebookEdit", "n.ipynb")),
            ("mcp__github__create_issue", {"title": SECRET}, ("MCP", "github · create_issue")),
            ("WebFetch", {"url": f"https://user:{SECRET}@Docs.Example.com:8443/a/b?q={SECRET}#x", "prompt": SECRET}, ("WebFetch", "docs.example.com")),
            ("WebSearch", {"query": SECRET}, ("WebSearch", "search")),
            ("Task", {"subagent_type": "Explore", "prompt": SECRET}, ("Task", "Explore")),
            ("Agent", {"subagent_type": "reviewer", "prompt": SECRET}, ("Agent", "reviewer")),
            ("Grep", {"pattern": SECRET, "path": "/x/y"}, ("Grep", "")),
            ("Glob", {"pattern": f"**/{SECRET}"}, ("Glob", "")),
        ]
        for tool, inp, want in cases:
            t, target, _ = act.safe(tool, inp)
            self.assertEqual((t, target), want, tool)
            self.assertNotIn(SECRET, t + target)
            self.assertNotIn("/", target.replace(" · ", ""))
        self.assertEqual(act.safe("mcp__github__x", {})[2], "github")

    def test_hook_message_is_compact(self):
        m = act.hook_message({"hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_use_id": "u1",
                              "tool_input": {"command": f"curl https://x.example/{SECRET}"}, "tool_response": {"stdout": SECRET}}, "t3")
        self.assertNotIn(SECRET, json.dumps(m))
        self.assertEqual((m["node"], m["tool"], m["target"], m["ok"]), ("t3", "Bash", "curl", True))
        self.assertIsNone(act.hook_message({"hook_event_name": "PostToolUse", "tool_name": "Bash"}, None))
        self.assertEqual(act.node_of_env({"LEAN_AGENT_SESSION_ROLE": "thread", "LEAN_AGENT_THREAD": "t9"}), "t9")
        self.assertEqual(act.node_of_env({"LEAN_AGENT_SESSION_ROLE": "main"}), "main")
        self.assertIsNone(act.node_of_env({}))

    # rings and aggregation -----------------------------------------------------------------------------
    def test_ring_bounds(self):
        now = time.time()
        for i in range(act.RING_MAX + 150):
            pre_post("t1", "Read", {"file_path": f"/a/f{i}.py"}, f"u{i}", now - 100 + i * 0.01)
        self.assertEqual(len(act.node_events("t1")), act.RING_MAX)
        for i in range(act.NODES_MAX + 20):
            pre_post(f"n{i}", "Bash", {"command": "ls"}, "u", now)
        self.assertLessEqual(len(act._rings), act.NODES_MAX)
        for i in range(act.INFLIGHT_MAX + 50):  # calls that never finish
            act.ingest({"op": "tool", "node": "t1", "phase": "pre", "id": f"x{i}", "tool": "Bash", "target": "ls"}, now=now)
        self.assertLessEqual(len(act._inflight), act.INFLIGHT_MAX)

    def test_aggregation_30_min(self):
        now = time.time()
        pre_post("t1", "Edit", {"file_path": "/p/a.py"}, "1", now - 4000)  # outside the window
        for i, (tool, inp) in enumerate([("Edit", {"file_path": "/p/a.py"}), ("Edit", {"file_path": "/q/a.py"}), ("Edit", {"file_path": "/p/b.py"}),
                                         ("Read", {"file_path": "/p/c.py"}), ("Bash", {"command": "pytest -q"}), ("Bash", {"command": "ls"}),
                                         ("mcp__github__list_prs", {}), ("mcp__github__get_pr", {}), ("mcp__slack__post", {}),
                                         ("WebSearch", {"query": "x"}), ("Grep", {"pattern": "x"})]):
            pre_post("t1", tool, inp, f"u{i}", now - 600 + i, dur=1.2, ok=(tool != "Bash" or inp["command"] != "ls"))
        act.ingest({"op": "tool", "node": "t1", "phase": "pre", "id": "run", "tool": "Edit", "target": "lean_map.py"}, now=now - 3.2)
        a = act.summarize(act.node_events("t1"), now, act.node_now("t1", now))
        self.assertEqual(a["now"]["tool"], "Edit")
        self.assertEqual(a["now"]["target"], "lean_map.py")
        self.assertAlmostEqual(a["now"]["since_s"], 3.2, delta=0.2)
        self.assertEqual(a["top"][0], ["Edit", 3])
        self.assertEqual(a["top"][1], ["MCP", 3])
        self.assertIn(["Bash", 2], a["top"])
        self.assertLessEqual(len(a["top"]), 6)
        self.assertEqual(a["files"], 3)  # a.py (twice, different dirs), b.py, c.py: distinct basenames
        self.assertEqual(a["errors"], 1)
        self.assertEqual(a["mcp"], ["github", "slack"])
        self.assertEqual(len(a["recent"]), 11)
        self.assertGreaterEqual(a["recent"][0]["ts"], a["recent"][-1]["ts"])
        self.assertEqual(a["recent"][0].keys(), {"ts", "tool", "target", "ok", "ms"})
        self.assertIsNone(act.summarize([], now, None))

    def test_recent_max(self):
        now = time.time()
        for i in range(40):
            pre_post("t1", "Bash", {"command": "ls"}, f"u{i}", now - 100 + i)
        self.assertEqual(len(act.summarize(act.node_events("t1"), now, None)["recent"]), 20)

    # worker runs -------------------------------------------------------------------------------------------
    def stream(self):
        u = {"input_tokens": 100, "cache_creation_input_tokens": 1000, "cache_read_input_tokens": 29000, "output_tokens": 200}
        return [
            {"type": "system", "subtype": "init", "model": "claude-sonnet-5-5", "session_id": "s"},
            {"type": "assistant", "session_id": "s", "message": {"id": "m1", "usage": u, "content": [
                {"type": "text", "text": SECRET},
                {"type": "tool_use", "id": "a", "name": "Edit", "input": {"file_path": "/w/deep/lean_map.py", "new_string": SECRET}},
                {"type": "tool_use", "id": "b", "name": "Bash", "input": {"command": f"/usr/bin/pytest -x {SECRET}"}}]}},
            {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "a", "content": SECRET}]}},
            {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "b", "is_error": True, "content": SECRET}]}},
            {"type": "assistant", "session_id": "s", "message": {"id": "m2", "usage": dict(u, output_tokens=300), "content": [
                {"type": "tool_use", "id": "c", "name": "mcp__github__get_pr", "input": {"n": 1}}]}},
            {"type": "assistant", "session_id": "s", "message": {"id": "m2", "usage": u, "content": []}},  # same message again
        ]

    def test_worker_stats_from_stream(self):
        wd = tempfile.mkdtemp()
        t0 = time.time() - 120
        tr = act.RunTracker(wd, "sonnet", 80, "feature/x", now=t0)
        for i, ev in enumerate(self.stream()):
            tr.feed(ev, now=t0 + i)
        tr.flush(t0 + 10, force=True)
        a, st = act.read_run(wd, time.time())
        self.assertEqual((st["turns"], st["max_turns"], st["branch"], st["model"]), (2, 80, "feature/x", "sonnet"))
        self.assertEqual(st["context"], 30100)
        self.assertEqual(st["tokens"], (30100 + 200) + (30100 + 300))
        self.assertGreater(st["usd"], 0)
        self.assertGreaterEqual(st["elapsed_s"], 10)
        self.assertEqual(a["now"]["tool"], "MCP")
        self.assertEqual(a["now"]["target"], "github · get_pr")
        self.assertEqual([(r["tool"], r["target"], r["ok"]) for r in a["recent"]], [("Bash", "pytest", False), ("Edit", "lean_map.py", True)])
        self.assertEqual((a["errors"], a["files"]), (1, 1))
        with open(os.path.join(wd, act.ACTIVITY_FILE)) as fh:
            self.assertNotIn(SECRET, fh.read())
        tr.feed({"type": "result", "total_cost_usd": 0.52, "num_turns": 7})
        self.assertEqual(act.read_run(wd)[1]["usd"], 0.52)
        self.assertEqual(act.read_run(wd)[1]["turns"], 7)

    def test_worker_events_bounded(self):
        wd = tempfile.mkdtemp()
        tr = act.RunTracker(wd, "haiku", None, None)
        for i in range(act.WORKER_EVENTS + 100):
            tr.feed({"type": "assistant", "message": {"id": f"m{i}", "usage": {}, "content": [{"type": "tool_use", "id": f"i{i}", "name": "Read", "input": {"file_path": f"/a/{i}.py"}}]}})
            tr.feed({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": f"i{i}"}]}})
        tr.flush(force=True)
        with open(os.path.join(wd, act.ACTIVITY_FILE)) as fh:
            self.assertLessEqual(len(json.load(fh)["events"]), act.WORKER_EVENTS)
        self.assertLess(os.path.getsize(os.path.join(wd, act.ACTIVITY_FILE)), 64 * 1024)

    # totals, feed ---------------------------------------------------------------------------------------------
    def ledger(self, n=3):
        day = time.strftime("%Y-%m-%d")
        rows = [{"ts": "2001-01-01T10:00:00", "id": "old", "cost_usd": 99, "usage": {"input_tokens": 9}}]
        u = {"input_tokens": 1000, "cache_creation_input_tokens": 2000, "cache_read_input_tokens": 10000, "output_tokens": 500}
        for i in range(n):
            rows.append({"ts": f"{day}T00:00:0{i}", "id": f"{i}-r", "project": "p", "model": "haiku", "status": "done" if i else "failed",
                         "turns": 5, "cost_usd": 0.5, "usage": u, "weighted": 5000})
        return rows

    def test_totals_from_ledger(self):
        with open(os.path.join(self.tmp, "ledger.jsonl"), "w") as fh:
            for r in self.ledger():
                fh.write(json.dumps(r) + "\n")
        rows = act.ledger_today(self.tmp)
        self.assertEqual(len(rows), 3)
        t = act.totals(rows, self.tmp, per_min=14.04, errors=2)
        self.assertEqual((t["runs_today"], t["usd_today"], t["tokens_today"], t["tools_per_min"], t["errors_30m"]), (3, 1.5, 15000, 14.0, 2))
        self.assertGreater(t["saved_today"], 0)
        self.assertEqual(set(t), {"runs_today", "usd_today", "tokens_today", "saved_today", "tools_per_min", "errors_30m"})
        self.assertEqual(act.totals([], self.tmp)["runs_today"], 0)

    def test_snapshot_totals_and_feed(self):
        now = time.time()
        pre_post("t1", "Edit", {"file_path": "/a/b.py"}, "1", now - 30)
        pre_post("main", "Bash", {"command": "git status"}, "2", now - 20, ok=False)
        lean_map.record("message", "service", "t1", "deliver", node="t1", dir="to", text="message delivered", now=now - 10)
        lean_map.run_ended("0101-000000-aaaa", "t1", "done", now=now - 5)
        s = lean_map.build(ctx(rows=self.ledger()[1:], home=self.tmp), now=now)
        self.assertEqual(s["totals"]["runs_today"], 3)
        self.assertEqual(s["totals"]["errors_30m"], 1)
        self.assertEqual(s["totals"]["tools_per_min"], 2.0)
        feed = s["feed"]
        self.assertLessEqual(len(feed), 30)
        self.assertEqual([f["ts"] for f in feed], sorted((f["ts"] for f in feed), reverse=True))
        kinds = {f["kind"] for f in feed}
        self.assertTrue({"tool", "message", "run", "error"} <= kinds, kinds)
        self.assertIn({"ts": feed[[f["text"] for f in feed].index("Edit b.py")]["ts"], "node": "t1", "kind": "tool", "text": "Edit b.py"}, feed)
        node = {n["id"]: n for n in s["nodes"]}
        self.assertEqual(node["t1"]["activity"]["top"], [["Edit", 1]])
        self.assertEqual(node["main"]["activity"]["errors"], 1)
        self.assertNotIn("activity", node["t2"])
        json.dumps(s)

    def test_worker_node_gets_stats(self):
        wd = tempfile.mkdtemp()
        tr = act.RunTracker(wd, "sonnet", 80, "b")
        for ev in self.stream():
            tr.feed(ev)
        tr.flush(force=True)
        run = {"id": "0116-090044-8545", "thread": "t1", "model": "sonnet", "age_s": 700, "progress_s": 2, "workdir": wd}
        s = lean_map.build(ctx(runs=[run]))
        w = next(n for n in s["nodes"] if n["kind"] == "worker")
        self.assertEqual(w["stats"]["turns"], 2)
        self.assertEqual(w["stats"]["max_turns"], 80)
        self.assertIn("activity", w)

    def test_without_activity_still_builds(self):
        with mock.patch.dict(sys.modules, {"lean_activity": None}):
            s = lean_map.build(ctx())
        self.assertEqual([n["id"] for n in s["nodes"]][:2], ["service", "main"])
        self.assertNotIn("totals", s)

    # privacy of hidden items ----------------------------------------------------------------------------------
    def test_private_items_hidden(self):
        a = lean_threads.new("open work")
        b = lean_threads.new("secret work")
        now = time.time()
        pre_post(a, "Edit", {"file_path": "/x/open.py"}, "1", now - 5)
        pre_post(b, "Edit", {"file_path": "/x/secret.py"}, "2", now - 5)
        rows = self.ledger()
        for r in rows:
            r["project"] = "hidden" if r["id"] == "0-r" else "p"
        with open(os.path.join(self.tmp, "ledger.jsonl"), "w") as fh:
            fh.write("".join(json.dumps(r) + "\n" for r in rows))
        hides = lambda item=None, **kw: kw.get("thread") == b or kw.get("project") == "hidden" or (isinstance(item, dict) and item.get("project") == "hidden")
        with mock.patch.object(ss, "alive_thread", return_value=True), mock.patch.object(ss, "mid_turn", return_value=False), \
                mock.patch.object(ss, "spool_pending", return_value=[]), mock.patch.object(ss, "_quiet_secs", return_value=1), \
                mock.patch.object(ss, "session_transcript", return_value=None), mock.patch("lean_private.hides", side_effect=hides):
            s = lean_map.build(lean_map.service_context(), now=now)
        text = json.dumps(s)
        self.assertNotIn("secret.py", text)
        self.assertIn("open.py", text)
        self.assertEqual(s["totals"]["runs_today"], 2)
        self.assertNotIn("0-r", json.dumps(s["feed"]))

    # speed ---------------------------------------------------------------------------------------------------------
    def test_snapshot_now_timing(self):
        now = time.time()
        tids = [lean_threads.new(f"thread {i}") for i in range(300)]
        for i, tid in enumerate(tids[:60] + ["main"]):
            for j in range(act.RING_MAX):
                act.ingest({"op": "tool", "node": tid, "phase": "post", "id": "", "tool": "Edit" if j % 2 else "Bash",
                            "target": f"f{j % 50}.py", "ok": j % 9 != 0}, now=now - j)
        with open(os.path.join(self.tmp, "ledger.jsonl"), "w") as fh:
            day = time.strftime("%Y-%m-%d")
            for i in range(500):
                fh.write(json.dumps({"ts": f"{day}T00:00:00" if i > 200 else "2001-01-01T00:00:00", "id": f"{i}-x", "project": "p", "model": "sonnet",
                                     "turns": 9, "cost_usd": 0.1, "usage": {"input_tokens": 5}, "weighted": 99,
                                     "result_head": "x" * 600, "claims": ["y" * 100] * 5}) + "\n")
        runs = [[f"0101-0000{i:02d}-{i:04x}", {"thread": tids[i], "started": time.time() - 60, "workdir": tempfile.mkdtemp()}] for i in range(40)]
        with mock.patch.object(ss, "alive_thread", return_value=True), mock.patch.object(ss, "mid_turn", return_value=False), \
                mock.patch.object(ss, "spool_pending", return_value=[]), mock.patch.object(ss, "_quiet_secs", return_value=1), \
                mock.patch.object(ss, "session_transcript", return_value=None), \
                mock.patch("lean_common.running_runs", return_value=runs):
            lean_map.snapshot_now()  # warms the liveness caches (they refresh over several snapshots by design)
            for _ in range(5):
                lean_map._tcache.clear()
                best = 1e9
                t0 = time.perf_counter()
                s = lean_map.snapshot_now()
                best = min(best, time.perf_counter() - t0)
            warm = []
            for _ in range(5):
                t0 = time.perf_counter()
                lean_map.snapshot_now()
                warm.append(time.perf_counter() - t0)
        self.assertIn("totals", s)
        self.assertLess(min(warm), 0.1, warm)
        self.assertLess(best, 0.25)

    # hooks ---------------------------------------------------------------------------------------------------------------
    def test_hook_with_service_down_is_fast(self):
        ev = {"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "ls"}, "tool_use_id": "u"}
        env = {**os.environ, "LEAN_AGENT_SESSION_ROLE": "thread", "LEAN_AGENT_THREAD": "t1"}
        with mock.patch.dict(os.environ, env):
            t0 = time.perf_counter()
            for _ in range(20):
                self.assertFalse(act.hook_send(ev))  # no socket: dropped
            self.assertLess((time.perf_counter() - t0) / 20, 0.05)
        # a service that never accepts (full backlog / hung): still bounded by the send timeout
        import socket
        path = os.path.join(self.tmp, "service.sock")
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(path)
        srv.listen(0)
        self.addCleanup(srv.close)
        fillers = []
        for _ in range(4):
            c = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            c.setblocking(False)
            try:
                c.connect(path)
            except OSError:
                pass
            fillers.append(c)
        self.addCleanup(lambda: [c.close() for c in fillers])
        with mock.patch.dict(os.environ, env):
            t0 = time.perf_counter()
            act.hook_send(ev)
            self.assertLess(time.perf_counter() - t0, 0.3)

    def test_trampoline_hook_path_service_down(self):
        scripts = os.path.join(ROOT, "trampoline.py")
        env = {"HOME": self.tmp, "PATH": "/usr/bin:/bin", "LEAN_AGENT_HOME": self.tmp, "LEAN_AGENT_TEST": "1",
               "LEAN_AGENT_SESSION_ROLE": "thread", "LEAN_AGENT_THREAD": "t1"}
        ev = json.dumps({"hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": {"command": "ls"}, "tool_use_id": "u"})
        for args in (["inject_hook.py"], ["inject_hook.py", "pre"], ["activity_hook.py"]):
            t0 = time.perf_counter()
            p = subprocess.run([sys.executable, scripts] + args, input=ev, env=env, capture_output=True, text=True, timeout=20)
            self.assertEqual((p.returncode, p.stdout), (0, ""), p.stderr)
            self.assertLess(time.perf_counter() - t0, 2.0)

    def test_service_end_to_end(self):
        sock = os.path.join(self.tmp, "s.sock")
        srv = lean_sock.Server({"tool": lambda r: {"ok": act.ingest(r)}}, sock=sock)
        srv.start()
        self.addCleanup(srv.stop)
        env = {"LEAN_AGENT_SESSION_ROLE": "thread", "LEAN_AGENT_THREAD": "t1"}
        with mock.patch.dict(os.environ, env), mock.patch.object(lean_sock, "path", return_value=sock):
            for ph, name in (("pre", "PreToolUse"), ("post", "PostToolUse")):
                self.assertTrue(act.hook_send({"hook_event_name": name, "tool_name": "Read", "tool_input": {"file_path": "/a/b/c.py"}, "tool_use_id": "z"}))
                time.sleep(0.15)
        evs = act.node_events("t1")
        self.assertEqual([(e["tool"], e["target"]) for e in evs], [("Read", "c.py")])


if __name__ == "__main__":
    unittest.main()
