"""Live map round 2: alerts (rules, thresholds, config, stable ids), projects, /history, /replay, timings."""
import json
import os
import shutil
import socket
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
import lean_maplive  # noqa: E402

NOW = 1_800_000_000.0  # fixed clock


def ctx(threads=(), runs=(), rows=(), svc=None, home=""):
    return {"service": dict({"pid": 1, "version": "0", "socket_ms": 1.0, "cpu_pct": 1.0, "threads": 3, "up_s": 9}, **(svc or {})),
            "paused": False, "inbox": 0, "threads": list(threads), "runs": list(runs), "rows": list(rows), "desk_idle_s": 4, "home": home}


def th(i, **kw):
    return dict({"id": f"t{i}", "title": f"Thread {i}", "state": "idle", "detail": "x", "idle_s": 5, "mid": False}, **kw)


def tool(node, ts, ok=True, name="Bash"):
    act.ingest({"node": node, "tool": name, "target": "git", "phase": "post", "ok": ok, "id": f"{node}{ts}"}, now=ts)


def kinds(snap):
    return {a["id"]: a for a in snap["alerts"]}


def http_get(port, path):
    s = socket.create_connection(("127.0.0.1", port), timeout=20)
    s.sendall(f"GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n".encode())
    buf = b""
    while True:
        d = s.recv(65536)
        if not d:
            break
        buf += d
    s.close()
    head, _, body = buf.partition(b"\r\n\r\n")
    lines = head.decode().split("\r\n")
    return lines[0], {k.lower(): v for k, v in (ln.split(": ", 1) for ln in lines[1:])}, body


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        p = mock.patch.dict(os.environ, {**clean_environ(), "LEAN_AGENT_HOME": self.tmp}, clear=True)
        p.start()
        self.addCleanup(p.stop)
        lean_map.reset()
        act.reset()

    def cfg(self, **m):
        with open(os.path.join(self.tmp, "config.json"), "w") as fh:
            json.dump({"map": m}, fh)
        lean_map._cfgc["sig"] = None


class AlertRulesTest(Base):
    def test_stuck_fires_and_clears(self):
        tool("t1", NOW - 10 * 60)
        mid = [th(1, mid=True, state="active")]
        self.assertEqual(lean_map.build(ctx(mid), now=NOW)["alerts"], [])  # exactly 10 min: not over
        a = kinds(lean_map.build(ctx(mid), now=NOW + 1))
        self.assertEqual(a["stuck:t1"]["level"], "warn")
        self.assertEqual(a["stuck:t1"]["kind"], "stuck")
        self.assertEqual(a["stuck:t1"]["node"], "t1")
        self.assertEqual(a["stuck:t1"]["since"], int(NOW - 600))
        self.assertIn("t1 mid-turn with no tool activity", a["stuck:t1"]["text"])
        self.assertEqual(kinds(lean_map.build(ctx(mid), now=NOW - 600 + 30 * 60 + 1))["stuck:t1"]["level"], "bad")
        self.assertEqual(kinds(lean_map.build(ctx(mid), now=NOW - 600 + 30 * 60 - 1))["stuck:t1"]["level"], "warn")
        tool("t1", NOW + 100)  # activity: clears
        self.assertEqual(lean_map.build(ctx(mid), now=NOW + 101)["alerts"], [])
        self.assertEqual(lean_map.build(ctx([th(1)]), now=NOW + 5000)["alerts"], [])  # not mid-turn

    def test_stuck_without_ring_uses_quiet_time(self):
        a = kinds(lean_map.build(ctx([th(2, mid=True, idle_s=700)]), now=NOW))
        self.assertEqual(a["stuck:t2"]["level"], "warn")
        self.assertEqual(lean_map.build(ctx([th(2, mid=True, idle_s=100)]), now=NOW)["alerts"], [])

    def test_no_progress(self):
        def run(p, **kw):
            return [dict({"id": "2026-1-ab12", "thread": "t1", "model": "sonnet", "age_s": 5000, "progress_s": p}, **kw)]
        self.assertEqual(lean_map.build(ctx([th(1)], run(600)), now=NOW)["alerts"], [])
        a = kinds(lean_map.build(ctx([th(1)], run(601)), now=NOW))
        self.assertEqual(a["no_progress:run:2026-1-ab12"]["level"], "warn")
        self.assertEqual(a["no_progress:run:2026-1-ab12"]["node"], "run:2026-1-ab12")
        self.assertEqual(kinds(lean_map.build(ctx([th(1)], run(1801)), now=NOW))["no_progress:run:2026-1-ab12"]["level"], "bad")
        self.assertEqual(lean_map.build(ctx([th(1)], run(1801, orphaned=True)), now=NOW)["alerts"], [])
        self.assertEqual(lean_map.build(ctx([th(1)], run(5)), now=NOW)["alerts"], [])  # progress again: cleared

    def test_undelivered(self):
        u = [th(3, state="undelivered", undelivered=True)]
        self.assertEqual(lean_map.build(ctx(u), now=NOW)["alerts"], [])
        self.assertEqual(lean_map.build(ctx(u), now=NOW + 120)["alerts"], [])
        a = kinds(lean_map.build(ctx(u), now=NOW + 121))
        self.assertEqual(a["undelivered:t3"]["level"], "bad")
        self.assertEqual(a["undelivered:t3"]["since"], int(NOW))
        lean_map.build(ctx([th(3)]), now=NOW + 130)  # delivered: clears and the clock restarts
        self.assertEqual(lean_map.build(ctx(u), now=NOW + 140)["alerts"], [])

    def test_errors(self):
        for i in range(4):
            tool("t1", NOW - 100 - i, ok=False)
        self.assertEqual(lean_map.build(ctx([th(1)]), now=NOW)["alerts"], [])
        tool("t1", NOW - 50, ok=False)
        a = kinds(lean_map.build(ctx([th(1)]), now=NOW))
        self.assertEqual(a["errors:t1"]["level"], "warn")
        self.assertEqual(lean_map.build(ctx([th(1)]), now=NOW + 600)["alerts"], [])  # all older than 10 min

    def test_budget(self):
        rows = [{"ts": "x", "cost_usd": 4.0, "usage": {}, "model": "sonnet", "project": "api"}]
        self.assertEqual(lean_map.build(ctx(rows=rows), now=NOW)["alerts"], [])  # no budget set
        self.cfg(daily_budget_usd=5)
        rows[0]["cost_usd"] = 3.99
        self.assertEqual(lean_map.build(ctx(rows=rows), now=NOW)["alerts"], [])
        rows[0]["cost_usd"] = 4.0
        a = kinds(lean_map.build(ctx(rows=rows), now=NOW))
        self.assertEqual((a["budget"]["level"], a["budget"]["node"]), ("warn", None))
        rows[0]["cost_usd"] = 5.0
        self.assertEqual(kinds(lean_map.build(ctx(rows=rows), now=NOW))["budget"]["level"], "bad")

    def test_service(self):
        slow = {"socket_ms": 250.0}
        self.assertEqual(lean_map.build(ctx(svc=slow), now=NOW)["alerts"], [])
        self.assertEqual(lean_map.build(ctx(svc=slow), now=NOW + 59)["alerts"], [])
        a = kinds(lean_map.build(ctx(svc=slow), now=NOW + 60))
        self.assertEqual((a["service"]["level"], a["service"]["since"]), ("warn", int(NOW)))
        self.assertEqual(lean_map.build(ctx(svc={"socket_ms": 200.0}), now=NOW + 70)["alerts"], [])  # at the threshold: clear
        lean_map.build(ctx(svc={"cpu_pct": 81.0}), now=NOW + 100)
        self.assertEqual(kinds(lean_map.build(ctx(svc={"cpu_pct": 81.0}), now=NOW + 160))["service"]["kind"], "service")
        lean_map.build(ctx(), now=NOW + 161)
        self.assertEqual(lean_map.build(ctx(svc={"cpu_pct": 81.0}), now=NOW + 170)["alerts"], [])  # the 1 min restarts

    def test_config_overrides(self):
        tool("t1", NOW - 120)
        mid = [th(1, mid=True)]
        self.assertEqual(lean_map.build(ctx(mid), now=NOW)["alerts"], [])
        self.cfg(stuck_warn_min=1, stuck_bad_min=1.5)
        self.assertEqual(kinds(lean_map.build(ctx(mid), now=NOW))["stuck:t1"]["level"], "bad")
        self.cfg(stuck_warn_min=1, stuck_bad_min=5, bogus=3)
        self.assertEqual(kinds(lean_map.build(ctx(mid), now=NOW))["stuck:t1"]["level"], "warn")
        self.assertNotIn("bogus", lean_map.map_config())
        self.assertEqual(lean_map.map_config()["errors_n"], 5)

    def test_stable_ids_order_and_cap(self):
        for i in range(1, 31):
            tool(f"t{i}", NOW - 700 - i)
        mid = [th(i, mid=True) for i in range(1, 31)]
        s1, s2 = lean_map.build(ctx(mid), now=NOW), lean_map.build(ctx(mid), now=NOW + 5)
        self.assertEqual([a["id"] for a in s1["alerts"]], [a["id"] for a in s2["alerts"]])
        self.assertEqual(len(s1["alerts"]), 20)
        self.assertEqual(s1["alerts"][0]["id"], "stuck:t1")  # newest (largest since) first
        self.assertEqual([a["since"] for a in s1["alerts"]], sorted((a["since"] for a in s1["alerts"]), reverse=True))

    def test_hidden_private_stays_out(self):
        # the service context leaves hidden threads/runs out, so nothing of them can alert
        tool("t9", NOW - 3000)
        self.assertEqual(lean_map.build(ctx([th(1)]), now=NOW)["alerts"], [])

    def test_projects(self):
        rows = [{"cost_usd": 1.0, "usage": {}, "project": "api", "weighted": 100},
                {"cost_usd": 2.5, "usage": {}, "project": "web", "weighted": 300},
                {"cost_usd": 0.5, "usage": {}, "project": "api", "weighted": 50}]
        runs = [{"id": "2026-1-aa", "thread": "t1", "progress_s": 1, "project": "api"}]
        s = lean_map.build(ctx([th(1, project="api"), th(2, project="api"), th(3)], runs, rows), now=NOW)
        self.assertEqual([p["slug"] for p in s["projects"]], ["web", "api"])
        api = s["projects"][1]
        self.assertEqual((api["threads"], api["workers"], api["usd_today"], api["tokens_today"], api["errors_30m"]), (2, 1, 1.5, 150, 0))
        self.assertEqual(set(api), {"slug", "threads", "workers", "usd_today", "tokens_today", "errors_30m"})
        self.assertEqual({n["id"]: n.get("project") for n in s["nodes"] if n["kind"] in ("thread", "worker")},
                         {"t1": "api", "t2": "api", "t3": None, "run:2026-1-aa": "api"} | {})
        many = [{"cost_usd": float(i), "usage": {}, "project": f"p{i}"} for i in range(20)]
        self.assertEqual(len(lean_map.build(ctx(rows=many), now=NOW)["projects"]), 12)


def ledger(home, rows):
    with open(os.path.join(home, "ledger.jsonl"), "w") as fh:
        for r in sorted(rows, key=lambda r: r["ts"]):  # the ledger is append-ordered
            fh.write(json.dumps(r) + "\n")


def day(n_ago, now=NOW):
    return time.strftime("%Y-%m-%d", time.localtime(lean_map._ts_day0(now) - n_ago * 86400 + 43200))


def row(n_ago, usd, model="sonnet", project="api", thread="t1", tokens=1000, now=NOW, **kw):
    return dict({"ts": day(n_ago, now) + "T10:00:00", "cost_usd": usd, "model": model, "project": project, "thread": thread,
                 "weighted": tokens, "turns": 1, "usage": {"input_tokens": 100, "cache_read_input_tokens": 300}, "id": "r"}, **kw)


class HistoryTest(Base):
    def test_shape_zero_days_and_sums(self):
        ledger(self.tmp, [row(0, 1.0), row(0, 0.5, model="haiku", project="web"), row(3, 2.0, thread="t2"),
                          row(40, 9.0)])  # older than the window
        h = lean_map.history(self.tmp, 14, now=NOW)
        self.assertEqual(len(h["days"]), 14)
        self.assertEqual([d["date"] for d in h["days"]], sorted(d["date"] for d in h["days"]))
        self.assertEqual(h["days"][-1]["date"], day(0))
        t = h["days"][-1]
        self.assertEqual((t["usd"], t["runs"], t["tokens"]), (1.5, 2, 2000))
        self.assertEqual(t["by_model"], {"sonnet": 1.0, "haiku": 0.5})
        self.assertEqual(t["by_project"], {"api": 1.0, "web": 0.5})
        self.assertAlmostEqual(sum(t["by_model"].values()), t["usd"])
        self.assertAlmostEqual(sum(t["by_project"].values()), t["usd"])
        self.assertEqual(t["cache_read_ratio"], 0.75)
        self.assertEqual(set(t), {"date", "usd", "tokens", "saved", "runs", "cache_read_ratio", "by_model", "by_project"})
        empty = h["days"][-2]
        self.assertEqual((empty["usd"], empty["tokens"], empty["runs"], empty["by_model"], empty["by_project"], empty["cache_read_ratio"]),
                         (0, 0, 0, {}, {}, 0))
        self.assertEqual(sum(d["usd"] for d in h["days"]), 3.5)
        self.assertEqual([x["node"] for x in h["top_threads"]], ["t2", "t1"])
        self.assertEqual(h["top_threads"][1]["usd"], 1.5)
        self.assertEqual(set(h["top_threads"][0]), {"node", "title", "usd", "tokens"})
        self.assertEqual(h["tools_7d"], [])
        self.assertEqual(len(lean_map.history(self.tmp, 3, now=NOW)["days"]), 3)

    def test_top_threads_last_7_days_and_tools(self):
        ledger(self.tmp, [row(8, 5.0, thread="t7"), row(2, 1.0, thread="t8")] + [row(1, 0.1 * i, thread=f"t{20 + i}") for i in range(1, 15)])
        h = lean_map.history(self.tmp, 14, now=NOW)
        self.assertNotIn("t7", [x["node"] for x in h["top_threads"]])
        self.assertEqual(len(h["top_threads"]), 10)
        for i in range(3):
            tool("t1", NOW - 5 - i, name="Edit")
        tool("t1", NOW - 1, name="Bash")
        self.assertEqual(lean_map.history(self.tmp, 14, now=NOW)["tools_7d"], [["Edit", 3], ["Bash", 1]])

    def test_private_hidden(self):
        ledger(self.tmp, [row(0, 1.0), row(0, 7.0, project="secret")])
        with mock.patch("lean_private.hides", lambda item=None, **kw: (item or {}).get("project") == "secret" or kw.get("project") == "secret"):
            h = lean_map.history(self.tmp, 2, now=NOW)
        self.assertEqual(h["days"][-1]["usd"], 1.0)
        self.assertNotIn("secret", json.dumps(h))

    def test_cache(self):
        ledger(self.tmp, [row(0, 1.0, now=time.time())])
        a = lean_map.history_cached(self.tmp, 14)
        ledger(self.tmp, [row(0, 5.0, now=time.time())])
        self.assertIs(lean_map.history_cached(self.tmp, 14), a)
        self.assertIsNot(lean_map.history_cached(self.tmp, 7), a)
        lean_map._hcache.clear()
        self.assertEqual(lean_map.history_cached(self.tmp, 14)["days"][-1]["usd"], 5.0)

    def test_speed_10k(self):
        ledger(self.tmp, [row(i % 14, 0.1, now=NOW, thread=f"t{i % 50}") for i in range(10000)])
        t0 = time.perf_counter()
        lean_map.history(self.tmp, 14, now=NOW)
        self.assertLess(time.perf_counter() - t0, 0.3)


class LiveRoutesTest(Base):
    def setUp(self):
        super().setUp()
        ledger(self.tmp, [row(0, 1.0, now=time.time())])
        self.live = lean_maplive.Live(lambda: {"v": 1, "nodes": [], "edges": []}, self.tmp, interval=0.2).start()
        self.addCleanup(self.live.stop)

    def get(self, path, token=True):
        return http_get(self.live.port, path + (f"{'&' if '?' in path else '?'}t={self.live.token}" if token else ""))

    def test_history_route(self):
        self.assertTrue(self.get("/history?days=14", token=False)[0].endswith("403 Forbidden"))
        self.assertTrue(http_get(self.live.port, "/history?t=nope")[0].endswith("403 Forbidden"))
        st, hd, body = self.get("/history?days=5")
        self.assertTrue(st.endswith("200 OK"))
        self.assertEqual(hd["access-control-allow-origin"], "*")
        d = json.loads(body)
        self.assertEqual(len(d["days"]), 5)
        self.assertEqual(d["days"][-1]["usd"], 1.0)
        self.assertEqual(len(json.loads(self.get("/history")[2])["days"]), 14)
        self.assertEqual(len(json.loads(self.get("/history?days=junk")[2])["days"]), 14)

    def test_history_zero_work_unless_requested(self):
        with mock.patch.object(lean_map, "history", side_effect=AssertionError("computed")):
            self.get("/snap")
            self.live.on_request("send", {"thread": "t1"})
        self.assertEqual(lean_map._hcache, {})

    def test_replay_bounds_and_since(self):
        lv = self.live
        for i in range(6000):
            lv.record_replay("send", {"thread": "t1"}, now=NOW + i * 0.1)
        self.assertEqual(len(lv.replay), 5000)
        lv.replay.clear()
        t0 = time.time()
        lv.record_replay("send", {"thread": "t1"}, now=t0 - 4000)  # older than 60 min: dropped by the next record
        lv.record_replay("tool", {"node": "t1", "tool": "Bash", "target": "git", "phase": "post", "ok": False,
                                  "command": "rm -rf / secret"}, now=t0 - 30)
        lv.record_replay("tool", {"node": "t1", "tool": "Bash", "phase": "pre"}, now=t0 - 20)  # pre phase: not kept
        lv.record_replay("pending", {"thread": "t2"}, now=t0 - 10)
        lv.record_replay("ping", {}, now=t0 - 5)  # unknown nodes: not kept
        evs = json.loads(self.get("/replay")[2])["events"]
        self.assertEqual([e["op"] for e in evs], ["tool", "pending"])
        self.assertEqual(set(evs[0]), {"ts", "from", "to", "op", "node", "tool", "target", "ok"})
        self.assertEqual((evs[0]["tool"], evs[0]["target"], evs[0]["ok"], evs[0]["node"]), ("Bash", "git", False, "t1"))
        self.assertEqual((evs[1]["from"], evs[1]["to"]), ("t2", "service"))
        self.assertNotIn("secret", json.dumps(evs))
        since = t0 - 20
        self.assertEqual([e["op"] for e in json.loads(self.get(f"/replay?since={since}")[2])["events"]], ["pending"])
        self.assertEqual(json.loads(self.get("/replay?since=junk")[2])["events"][0]["op"], "tool")
        self.assertTrue(http_get(self.live.port, "/replay")[0].endswith("403 Forbidden"))

    def test_replay_records_without_clients_and_no_snapshot(self):
        calls = []
        self.live.snapshot = lambda: calls.append(1) or {}
        self.assertFalse(self.live.clients)
        self.live.on_request("wake", {"thread": "t4"})
        self.assertEqual(calls, [])
        self.assertEqual(len(self.live.replay), 1)


class TimingTest(Base):
    def test_busy_snapshot_under_100ms(self):
        for i in range(1, 301):
            for k in range(30):
                tool(f"t{i}", NOW - k * 7, ok=k % 6 != 0)
        threads = [th(i, mid=i % 5 == 0, project=f"p{i % 8}") for i in range(1, 301)]
        runs = [{"id": f"2026-1-{i:04x}", "thread": f"t{i % 300 + 1}", "progress_s": i, "age_s": 100, "project": f"p{i % 8}"} for i in range(500)]
        rows = [{"cost_usd": 0.1, "usage": {"input_tokens": 10}, "project": f"p{i % 8}", "model": "sonnet"} for i in range(500)]
        c = ctx(threads, runs, rows)
        lean_map.build(c, now=NOW)
        t0 = time.perf_counter()
        for _ in range(5):
            s = lean_map.build(c, now=NOW)
        self.assertLess((time.perf_counter() - t0) / 5, 0.1)
        self.assertTrue(s["alerts"] and s["projects"])


if __name__ == "__main__":
    unittest.main()
