"""The live map endpoint (loopback WebSocket) and `map --html`."""
import base64
import json
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

from _env import clean_environ

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)

import lean_map  # noqa: E402
import lean_maplive  # noqa: E402
import lean_sock  # noqa: E402

WAIT = 20


def snap():
    return {"v": 1, "ts": "t", "service": {"up": True}, "paused": False, "inbox": 1, "moving": [],
            "nodes": [{"id": "service", "kind": "service", "label": "S", "state": "active", "detail": "d"},
                      {"id": "main", "kind": "desk", "label": "Front desk", "state": "active", "detail": "d"},
                      {"id": "t1", "kind": "thread", "label": "T1", "state": "parked", "detail": "d"}],
            "edges": [{"from": "service", "to": "t1", "kind": "idle", "age_s": 0, "label": "idle"}]}


def connect(port, token, path=None, method="GET", upgrade=True, host="x", origin=None):
    s = socket.create_connection(("127.0.0.1", port), timeout=WAIT)
    key = base64.b64encode(os.urandom(16)).decode()
    p = path if path is not None else (f"/?t={token}" if token else "/")
    req = f"{method} {p} HTTP/1.1\r\nHost: {host}\r\n" + (f"Origin: {origin}\r\n" if origin else "") + (f"Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n" if upgrade else "") + "\r\n"
    s.sendall(req.encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        d = s.recv(4096)
        if not d:
            break
        buf += d
    head, _, rest = buf.partition(b"\r\n\r\n")
    return s, head.decode(), rest


def read_frame(s, rest=b""):
    buf = rest

    def need(n):
        nonlocal buf
        while len(buf) < n:
            d = s.recv(65536)
            if not d:
                raise EOFError
            buf += d
    need(2)
    ln = buf[1] & 0x7F
    i = 2
    if ln == 126:
        need(4)
        ln, i = int.from_bytes(buf[2:4], "big"), 4
    need(i + ln)
    return buf[0] & 0x0F, buf[i:i + ln].decode(), buf[i + ln:]


class LiveTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.calls = 0

        def fn():
            self.calls += 1
            return snap()
        self.live = lean_maplive.Live(fn, self.tmp, interval=0.2).start()
        self.addCleanup(self.live.stop)

    def test_good_token_gets_snapshot(self):
        s, head, rest = connect(self.live.port, self.live.token)
        self.addCleanup(s.close)
        self.assertIn("101", head.split("\r\n")[0])
        op, text, _ = read_frame(s, rest)
        d = json.loads(text)
        self.assertEqual((op, d["type"], d["inbox"]), (1, "snapshot", 1))

    def test_bad_requests(self):
        for tok in ("nope", ""):
            s, head, _ = connect(self.live.port, tok)
            s.close()
            self.assertIn("403", head.split("\r\n")[0])
        s, head, _ = connect(self.live.port, None, path="/")
        s.close()
        self.assertIn("403", head.split("\r\n")[0])
        s, head, _ = connect(self.live.port, self.live.token, method="POST")
        s.close()
        self.assertIn("405", head.split("\r\n")[0])
        s, head, _ = connect(self.live.port, self.live.token, upgrade=False, path=f"/nope?t={self.live.token}")
        s.close()
        self.assertIn("404", head.split("\r\n")[0])
        s, head, _ = connect(self.live.port, self.live.token, path=f"/?t={self.live.token}",)
        s.close()
        self.assertIn("101", head.split("\r\n")[0])

    def test_event_frame(self):
        s, head, rest = connect(self.live.port, self.live.token)
        self.addCleanup(s.close)
        _, _, rest = read_frame(s, rest)
        deadline = time.time() + WAIT
        got = None
        while time.time() < deadline and not got:
            self.live.on_request("send", {"thread": "t1"})
            s.settimeout(1)
            try:
                _, text, rest = read_frame(s, rest)
            except socket.timeout:
                continue
            d = json.loads(text)
            if d["type"] == "event":
                got = d
        self.assertEqual((got["from"], got["to"], got["op"]), ("main", "t1", "send"))

    def test_server_hook(self):
        srv = lean_sock.Server({"send": lambda r: {"ok": True}}, sock=os.path.join(self.tmp, "s.sock"))
        seen = []
        srv.on_request = lambda op, req: seen.append(op)
        srv.dispatch({"op": "send", "thread": "t1"})
        self.assertEqual(seen, ["send"])

    def test_idle_is_zero_work(self):
        self.live.on_request("send", {"thread": "t1"})
        time.sleep(0.6)  # nothing is asserted on time, only that nothing ran while nobody listens
        self.assertEqual(self.calls, 0)

    def test_file_mode_and_removal(self):
        p = lean_maplive.live_path(self.tmp)
        self.assertEqual(stat.S_IMODE(os.stat(p).st_mode), 0o600)
        with open(p) as fh:
            d = json.load(fh)
        self.assertEqual((d["port"], d["token"]), (self.live.port, self.live.token))
        self.assertTrue(lean_maplive.is_up(self.tmp))
        self.live.stop()
        self.assertFalse(os.path.exists(p))

    def test_client_cap(self):
        live = lean_maplive.Live(snap, self.tmp, interval=0.2, max_clients=1)
        live.start()
        self.addCleanup(live.stop)
        s1, h1, _ = connect(live.port, live.token)
        self.addCleanup(s1.close)
        deadline = time.time() + WAIT
        while not live.clients and time.time() < deadline:
            time.sleep(0.05)
        s2, h2, _ = connect(live.port, live.token)
        s2.close()
        self.assertIn("503", h2.split("\r\n")[0])


def http_get(port, path, method="GET", host="x"):
    s = socket.create_connection(("127.0.0.1", port), timeout=WAIT)
    s.sendall(f"{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n".encode())
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


class HttpRoutesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.calls = 0

        def fn():
            self.calls += 1
            return snap()
        self.live = lean_maplive.Live(fn, self.tmp, interval=0.2).start()
        self.addCleanup(self.live.stop)

    def test_token_required(self):
        for path in ("/snap", "/map.svg", "/", "/snap?t=bad", "/map.svg?t="):
            st, _, _ = http_get(self.live.port, path)
            self.assertIn("403", st, path)
        self.assertEqual(self.calls, 0)

    def test_get_only(self):
        for m in ("POST", "PUT", "DELETE", "OPTIONS"):
            st, _, _ = http_get(self.live.port, f"/snap?t={self.live.token}", method=m)
            self.assertIn("405", st)

    def test_snap_json_and_cors(self):
        st, h, body = http_get(self.live.port, f"/snap?t={self.live.token}")
        self.assertIn("200", st)
        self.assertEqual(h["access-control-allow-origin"], "*")
        self.assertIn("json", h["content-type"])
        self.assertEqual(json.loads(body)["inbox"], 1)

    def test_svg_and_cors(self):
        st, h, body = http_get(self.live.port, f"/map.svg?t={self.live.token}&n=1")
        self.assertIn("200", st)
        self.assertEqual(h["access-control-allow-origin"], "*")
        self.assertIn("svg", h["content-type"])
        self.assertTrue(body.startswith(b"<svg"))

    def test_page_without_cors(self):
        st, h, body = http_get(self.live.port, f"/?t={self.live.token}")
        self.assertIn("200", st)
        self.assertIn("text/html", h["content-type"])
        self.assertNotIn("access-control-allow-origin", h)
        self.assertIn(b"lean-agent live map", body)
        self.assertIn(self.live.token.encode(), body)

    def test_page_has_legend_and_footer(self):
        _, _, body = http_get(self.live.port, f"/?t={self.live.token}")
        text = body.decode()
        for w in ("LEAN<span>//</span>AGENT", "live map", "Active threads", "Workers alive", "Inbox · needs you", "Cost today", "Tokens saved", "Tool calls / min",
                  "Agent topology", "Live activity", "Replay timeline", "SYSTEM VISIBILITY LAYER", "privacy filter active", "Local instance · 127.0.0.1",
                  "01 / Map", "02 / Trends", "Pause", "id=\"raintg\"", "id=\"themetg\""):
            self.assertIn(w, text)
        self.assertEqual([u for u in re.findall(r"https?://[^/'\" ]*", text) if "127.0.0.1" not in u], [])

    def test_cached_and_nothing_when_idle(self):
        time.sleep(0.5)
        self.assertEqual(self.calls, 0)
        for _ in range(5):
            http_get(self.live.port, f"/snap?t={self.live.token}")
        http_get(self.live.port, f"/map.svg?t={self.live.token}")
        self.assertEqual(self.calls, 1)  # one computation serves them all inside the interval
        n = self.calls
        time.sleep(0.8)
        self.assertEqual(self.calls, n)  # polling stopped: no background work


class RobustTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.mode = "ok"
        self.calls = 0
        self.release = threading.Event()
        self.addCleanup(self.release.set)
        self.logs = []

        def fn():
            self.calls += 1
            if self.mode == "boom":
                raise RuntimeError("kaboom")
            if self.mode == "hang":
                self.release.wait(30)
            d = snap()
            d["inbox"] = self.calls
            return d
        self.fn = fn

    def start(self, interval=0.2):
        live = lean_maplive.Live(self.fn, self.tmp, interval=interval)
        live.log = lambda *a: self.logs.append(a)
        live.start()
        self.addCleanup(live.stop)
        return live

    def frames(self, live, until, limit=WAIT):
        s, head, rest = connect(live.port, live.token)
        self.addCleanup(s.close)
        got = []
        end = time.time() + limit
        while time.time() < end:
            s.settimeout(1)
            try:
                _, text, rest = read_frame(s, rest)
            except socket.timeout:
                continue
            got.append(json.loads(text))
            if until(got[-1]):
                break
        return got

    def test_first_snapshot_at_once(self):
        live = self.start(interval=60)
        t0 = time.time()
        got = self.frames(live, lambda m: m["type"] == "snapshot")
        self.assertEqual(got[-1]["type"], "snapshot")
        self.assertLess(time.time() - t0, 10)

    def test_failure_is_reported_logged_once_and_loop_survives(self):
        self.mode = "boom"
        live = self.start()
        got = self.frames(live, lambda m: m["type"] == "error")
        self.assertEqual(got[-1], {"type": "error", "text": "RuntimeError: kaboom"})
        n = self.calls
        deadline = time.time() + WAIT
        while self.calls < n + 3 and time.time() < deadline:
            time.sleep(0.05)
        self.assertGreaterEqual(self.calls, n + 3)  # the loop thread is still going
        deadline = time.time() + WAIT
        while not self.logs and time.time() < deadline:
            time.sleep(0.05)
        self.assertEqual(len(self.logs), 1)  # rate limited
        self.assertIn("kaboom", self.logs[0][2])
        self.mode = "ok"
        got = self.frames(live, lambda m: m["type"] == "snapshot")
        self.assertEqual(got[-1]["type"], "snapshot")

    def test_last_good_snapshot_kept(self):
        live = self.start()
        st, _, body = http_get(live.port, f"/snap?t={live.token}")
        good = json.loads(body)["inbox"]
        self.mode = "boom"
        time.sleep(0.5)
        st, _, body = http_get(live.port, f"/snap?t={live.token}")
        self.assertIn("200", st)
        self.assertGreaterEqual(json.loads(body)["inbox"], good)
        self.assertGreater(json.loads(body)["inbox"], 0)

    def test_http_page_embeds_current_snapshot(self):
        live = self.start(interval=0.2)
        _, _, b1 = http_get(live.port, f"/?t={live.token}")
        time.sleep(0.5)
        _, _, b2 = http_get(live.port, f"/?t={live.token}")
        m1 = re.search(rb'id="snap">(.*?)</script>', b1, re.S).group(1)
        m2 = re.search(rb'id="snap">(.*?)</script>', b2, re.S).group(1)
        self.assertNotEqual(m1, m2)  # recomputed once the cache expired

    def test_check_states(self):
        self.assertEqual(lean_maplive.check(self.tmp)[0], "down")
        live = self.start()
        self.assertEqual(lean_maplive.check(self.tmp, wait=WAIT)[0], "up")
        self.assertTrue(lean_maplive.doctor_line(self.tmp, WAIT)[1].startswith("live map page endpoint: up"))
        p = lean_maplive.live_path(self.tmp)
        with open(p) as fh:
            d = json.load(fh)
        with open(p, "w") as fh:
            json.dump(dict(d, token="old"), fh)
        self.assertEqual(lean_maplive.check(self.tmp)[0], "token")
        self.assertIn("token mismatch", lean_maplive.doctor_line(self.tmp)[1])
        live.stop()
        with open(p, "w") as fh:
            json.dump(d, fh)
        end = time.time() + WAIT
        while lean_maplive.check(self.tmp, wait=1)[0] != "down" and time.time() < end:
            time.sleep(0.2)
        self.assertEqual(lean_maplive.check(self.tmp, wait=1)[0], "down")

    def test_check_failing_snapshot(self):
        self.mode = "boom"
        self.start()
        st, why = lean_maplive.check(self.tmp, wait=WAIT)
        self.assertEqual(st, "no-snapshot")
        self.assertIn("kaboom", why)

    def test_check_hang(self):
        self.mode = "hang"
        self.start()
        st, why = lean_maplive.check(self.tmp, wait=0.8)
        self.assertEqual(st, "no-snapshot")
        self.assertIn("no frame", why)
        self.assertIn("accepts but sends no snapshot", lean_maplive.doctor_line(self.tmp, 0.5)[1])


class CostTest(unittest.TestCase):
    def test_build_is_cheap_on_a_big_home(self):
        now = time.time()
        for i in range(400):
            lean_map.record("message", "service", f"t{i % 300 + 1}", "deliver", node=f"t{i % 300 + 1}", dir="to", text="x", now=now - i)
        ctx = {"service": {}, "threads": [{"id": f"t{i}", "title": f"T{i}", "state": "idle", "idle_s": i} for i in range(1, 301)],
               "runs": [{"id": f"r-{i}", "thread": f"t{i % 300 + 1}", "age_s": i, "alive": True} for i in range(500)], "desk_idle_s": 3}
        t0 = time.perf_counter()
        s = lean_map.build(ctx)
        self.assertLess(time.perf_counter() - t0, 0.1)
        self.assertLessEqual(len(s["placed"]), 3 + 12 + 36)

    def test_service_context_is_time_boxed(self):
        import lean_threads
        import service_session as ss
        threads = {f"t{i}": {"title": f"T{i}"} for i in range(1, 301)}

        def slow_alive(tid):
            time.sleep(0.005)
            return True
        lean_map._tcache.clear()
        lean_map._rcache[:] = [0.0, []]
        self.addCleanup(lean_map._tcache.clear)
        with mock.patch.object(lean_threads, "load_ro", return_value={"threads": threads}), \
                mock.patch.object(ss, "alive_thread", slow_alive), mock.patch.object(ss, "mid_turn", return_value=False), \
                mock.patch.object(ss, "spool_pending", return_value=[]), mock.patch.object(ss, "session_transcript", return_value=None), \
                mock.patch("lean_common.running_runs", return_value=[]):
            t0 = time.perf_counter()
            c = lean_map.service_context()
            self.assertLess(time.perf_counter() - t0, 0.5)  # 300 x 5 ms probes would be 1.5 s unboxed
            self.assertEqual(len(c["threads"]), 300)
            self.assertLess(len(lean_map._tcache), 300 + 1)


def big_snap(threads=300, runs=500):
    ns = [{"id": "service", "kind": "service", "label": "S", "state": "active", "detail": "d"},
          {"id": "main", "kind": "desk", "label": "Front desk", "state": "active", "detail": "d"},
          {"id": "hooks", "kind": "hooks", "label": "Hooks", "state": "idle", "detail": "d"}]
    edges = []
    for i in range(1, threads + 1):
        ns.append({"id": f"t{i}", "kind": "thread", "label": f"Thread number {i}", "state": "active" if i % 50 == 0 else "idle",
                   "detail": "d", "idle_s": i * 7, "mid": i % 50 == 0, "closed": i % 11 == 0})
    for r in range(runs):
        st = ["alive", "done", "dead", "orphaned"][r % 4]
        ns.append({"id": f"run:r-{r}", "kind": "worker", "parent": f"t{r % threads + 1}" if r % 25 else None, "label": f"run {r}",
                   "state": st, "detail": "d", "age_s": r * 30, "ended_s": None if st in ("alive", "orphaned") else r * 30})
    sel = lean_map.select(ns)
    ok = set(sel["placed"])
    for n in ns:
        if n["kind"] == "thread" and n["id"] in ok:
            edges.append({"from": "service", "to": n["id"], "kind": "idle", "age_s": 0, "label": "idle"})
    return {"v": 1, "ts": "t", "service": {"up": True}, "paused": False, "inbox": 0, "moving": [], "nodes": ns, "edges": edges,
            "placed": sel["placed"], "more": sel["more"]}


class SelectTest(unittest.TestCase):
    def test_caps_and_rules(self):
        s = big_snap()
        sel = lean_map.select(s["nodes"])
        by = {n["id"]: n for n in s["nodes"]}
        ths = [i for i in sel["placed"] if by[i]["kind"] == "thread"]
        ws = [i for i in sel["placed"] if by[i]["kind"] == "worker"]
        self.assertLessEqual(len(ths), 12)
        self.assertFalse([i for i in ths if by[i].get("closed")])
        self.assertTrue(all(by[i]["idle_s"] is not None for i in ths))
        self.assertIn("t50", ths)  # mid-turn threads rank first
        per = {}
        for i in ws:
            per[by[i]["parent"]] = per.get(by[i]["parent"], 0) + 1
            self.assertTrue(by[i]["state"] in ("alive", "orphaned") or by[i]["ended_s"] <= 600)
        self.assertLessEqual(max(per.values()), 3)
        self.assertGreater(sel["more"], 200)
        svg = lean_map.svg(s)
        self.assertLessEqual(svg.count("<rect") - 1, len(sel["placed"]))  # minus the background
        self.assertIn("more</text>", svg)
        self.assertEqual(len(re.findall(r"<line ", svg)), len({(e["from"], e["to"]) for e in s["edges"] if e["from"] in sel["placed"] and e["to"] in sel["placed"]}))

    def test_build_edges_only_between_placed(self):
        ctx = {"service": {}, "threads": [{"id": f"t{i}", "state": "idle", "idle_s": i} for i in range(1, 80)], "runs": [], "desk_idle_s": 1}
        s = lean_map.build(ctx)
        ok = set(s["placed"])
        self.assertTrue(all(e["from"] in ok and e["to"] in ok for e in s["edges"]))
        self.assertEqual(s["more"], 79 - 12)


class UrlTest(unittest.TestCase):
    def test_page_url(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        self.assertIsNone(lean_maplive.page_url(tmp))
        live = lean_maplive.Live(snap, tmp).start()
        self.addCleanup(live.stop)
        self.assertEqual(lean_maplive.page_url(tmp), f"http://127.0.0.1:{live.port}/")

    def test_cli_url_without_service(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        env = clean_environ()
        r = subprocess.run([sys.executable, os.path.join(ROOT, "lean_agent.py"), "map", "--url"], capture_output=True, text=True,
                           env=dict(env, HOME=tmp, LEAN_AGENT_TEST="1"), timeout=60)
        self.assertEqual(r.returncode, 1)
        self.assertIn("not running", r.stdout)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


class StableUrlTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.port = free_port()
        self.live = lean_maplive.Live(snap, self.tmp, interval=0.2, port=self.port).start()
        self.addCleanup(self.live.stop)

    def test_fixed_port_and_tokenless_page(self):
        self.assertEqual(self.live.port, self.port)
        self.assertFalse(self.live.fallback)
        for host in (f"127.0.0.1:{self.port}", f"localhost:{self.port}"):
            st, h, body = http_get(self.port, "/", host=host)
            self.assertIn("200", st)
            self.assertIn(self.live.token, body.decode())
            self.assertNotIn("access-control-allow-origin", h)
        for host in ("evil.example", "evil.example:%d" % self.port, "127.0.0.1", f"127.0.0.1.evil.example:{self.port}", "x"):
            st, _, body = http_get(self.port, "/", host=host)
            self.assertIn("403", st, host)
            self.assertNotIn(self.live.token, body.decode())
        ok = f"127.0.0.1:{self.port}"
        for path in ("/snap", "/map.svg", "/nope", "/?x=1", "/?t=wrong"):
            st, _, _ = http_get(self.port, path, host=ok)
            self.assertIn("403", st, path)
        st, _, _ = http_get(self.port, f"/snap?t={self.live.token}", host=ok)
        self.assertIn("200", st)

    def test_websocket_origin(self):
        for origin, code in (("http://evil.example", "403"), ("http://127.0.0.1:1", "403"), (f"http://127.0.0.1:{self.port}", "101"),
                             (f"http://localhost:{self.port}", "101"), ("null", "101"), (None, "101")):
            s, head, _ = connect(self.port, self.live.token, host=f"127.0.0.1:{self.port}", origin=origin)
            s.close()
            self.assertIn(code, head.split("\r\n")[0], origin)
        s, head, _ = connect(self.port, "wrong", origin=f"http://127.0.0.1:{self.port}")
        s.close()
        self.assertIn("403", head.split("\r\n")[0])

    def test_busy_port_falls_back(self):
        live2 = lean_maplive.Live(snap, self.tmp + "-b", interval=0.2, port=self.port).start()
        self.addCleanup(live2.stop)
        self.addCleanup(shutil.rmtree, self.tmp + "-b", True)
        self.assertNotEqual(live2.port, self.port)
        self.assertTrue(live2.fallback)
        d = lean_maplive.endpoint(self.tmp + "-b")
        self.assertTrue(d["fallback"])
        ok, text = lean_maplive.doctor_line(self.tmp + "-b", wait=3)
        self.assertIn("busy", text)
        self.assertIn(str(live2.port), text)

    def test_env_port(self):
        p = free_port()
        with mock.patch.dict(os.environ, {"LEAN_AGENT_MAP_PORT": str(p)}):
            live = lean_maplive.Live(snap, self.tmp + "-c").start()
        self.addCleanup(live.stop)
        self.addCleanup(shutil.rmtree, self.tmp + "-c", True)
        self.assertEqual(live.port, p)

    def test_readme(self):
        with open(os.path.join(ROOT, "..", "..", "..", "README.md")) as fh:
            t = fh.read()
        for w in ("Browser pane", "Cmd+Shift+B", "map --app", "Add to Dock", "47821"):
            self.assertIn(w, t)

    def test_default_port_constant(self):
        self.assertEqual(lean_maplive.DEFAULT_PORT, 47821)
        with mock.patch.dict(os.environ, {"LEAN_AGENT_MAP_PORT": ""}):
            self.assertEqual(lean_maplive.wanted_port(), 47821)


class RefreshFileTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.inbox = 1
        self.calls = 0

        def fn():
            self.calls += 1
            d = snap()
            d["inbox"] = self.inbox
            return d
        self.fn = fn
        for k, v in (("REFRESH_EVERY", 0.1), ("HEARTBEAT", 1000.0)):
            p = mock.patch.object(lean_maplive, k, v)
            p.start()
            self.addCleanup(p.stop)
        self.out = os.path.join(self.tmp, "map", "live.html")
        os.makedirs(os.path.dirname(self.out))

    def start(self):
        live = lean_maplive.Live(self.fn, self.tmp, interval=0.05, port=free_port()).start()
        self.addCleanup(live.stop)
        return live

    def wait(self, cond, t=10):
        end = time.time() + t
        while time.time() < end:
            if cond():
                return True
            time.sleep(0.05)
        return False

    def stamp(self):
        st = os.stat(self.out)
        return (st.st_ino, st.st_mtime_ns)

    def test_registration_expiry_extension(self):
        self.assertEqual(lean_maplive.load_refresh(self.tmp), {})
        e1 = lean_maplive.register_refresh(self.tmp, self.out, 1, now=1000.0)
        self.assertEqual(e1, 1060.0)
        self.assertEqual(lean_maplive.load_refresh(self.tmp), {self.out: 1060.0})
        self.assertEqual(lean_maplive.register_refresh(self.tmp, self.out, 5, now=1030.0), 1330.0)  # asking again extends
        other = os.path.join(self.tmp, "o.html")
        lean_maplive.register_refresh(self.tmp, other, None, now=2000.0)  # drops the expired one, default 30 min
        self.assertEqual(lean_maplive.load_refresh(self.tmp), {other: 2000.0 + 30 * 60})
        self.assertEqual(stat.S_IMODE(os.stat(lean_maplive.refresh_path(self.tmp)).st_mode), 0o600)

    def test_rewrites_only_on_change_atomically_then_stops(self):
        live = self.start()
        lean_maplive.register_refresh(self.tmp, self.out, 0.03)  # ~1.8 s
        live.on_request("map", {})
        self.assertTrue(self.wait(lambda: os.path.exists(self.out)))
        self.assertIn("Inbox", open(self.out).read())
        self.assertEqual(stat.S_IMODE(os.stat(self.out).st_mode), 0o600)
        time.sleep(0.4)
        st = self.stamp()
        time.sleep(0.6)
        self.assertEqual(self.stamp(), st)  # unchanged map: no rewrite
        bad = []
        stop = threading.Event()

        def reader():
            while not stop.is_set():
                try:
                    t = open(self.out).read()
                except OSError:
                    continue
                if not t.rstrip().endswith("</html>"):
                    bad.append(len(t))
        th = threading.Thread(target=reader)
        th.start()
        self.inbox = 7
        changed = self.wait(lambda: self.stamp() != st and '"inbox": 7' in open(self.out).read(), 5)
        self.inbox = 8
        time.sleep(0.5)
        stop.set()
        th.join()
        self.assertTrue(changed)
        self.assertEqual(bad, [])
        self.assertEqual([n for n in os.listdir(os.path.dirname(self.out)) if n.endswith(".tmp")], [])
        # after expiry nothing is computed or written any more
        self.assertTrue(self.wait(lambda: not lean_maplive.load_refresh(self.tmp) or True))
        time.sleep(2.0)
        st = self.stamp()
        calls = self.calls
        self.inbox = 99
        time.sleep(1.0)
        self.assertEqual(self.stamp(), st)
        self.assertEqual(self.calls, calls)
        self.assertNotIn('"inbox": 99', open(self.out).read())
        self.assertFalse(live.clients)

    def test_asking_again_restarts_it(self):
        live = self.start()
        lean_maplive.register_refresh(self.tmp, self.out, 0.01)
        live.on_request("map", {})
        self.assertTrue(self.wait(lambda: os.path.exists(self.out)))
        time.sleep(1.2)  # expired; the loop sleeps
        self.inbox = 5
        lean_maplive.register_refresh(self.tmp, self.out, 1)
        live.on_request("map", {})
        self.assertTrue(self.wait(lambda: '"inbox": 5' in open(self.out).read(), 5))


class SocketIsolationTest(unittest.TestCase):
    def test_ping_stays_fast_while_snapshot_is_slow(self):
        import lean_sock
        tmp = tempfile.mkdtemp(prefix="ml")
        self.addCleanup(shutil.rmtree, tmp, True)
        n = {"c": 0}

        def slow():
            n["c"] += 1
            time.sleep(0.5)
            return snap()
        live = lean_maplive.Live(slow, tmp, interval=0.1, port=free_port()).start()
        self.addCleanup(live.stop)
        srv = lean_sock.Server({"map": lambda r: {"map": live.get_snap()}}, sock=os.path.join(tmp, "s.sock"), version="t")
        srv.on_request = live.on_request
        srv.start()
        self.addCleanup(srv.stop)
        sk, head, _ = connect(live.port, live.token)
        self.addCleanup(sk.close)
        self.assertIn("101", head.split("\r\n")[0])
        sock = os.path.join(tmp, "s.sock")
        slowest = 0.0
        end = time.time() + 2.5
        while time.time() < end:
            t0 = time.monotonic()
            r = lean_sock.call("ping", timeout=2, sock=sock)
            slowest = max(slowest, (time.monotonic() - t0) * 1000)
            self.assertTrue(r and r.get("ok"))
            time.sleep(0.05)
        self.assertGreaterEqual(n["c"], 2)  # the slow snapshot really was running meanwhile
        self.assertLess(slowest, 50)

    def test_map_request_does_not_set_socket_ms(self):
        lean_map.record_request("ping", 1.5)
        lean_map.record_request("map", 348.8)
        self.assertEqual(lean_map._state["ms"], 1.5)


class OpenAppTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.bin = os.path.join(self.tmp, "bin")
        os.makedirs(self.bin)
        self.log = os.path.join(self.tmp, "log")
        self.live = lean_maplive.Live(snap, os.path.join(self.tmp, "home"), port=free_port()).start()
        self.addCleanup(self.live.stop)
        self.home = os.path.join(self.tmp, "home")
        self.url = f"http://127.0.0.1:{self.live.port}/"

    def fake(self, *names):
        for n in names:
            p = os.path.join(self.bin, n)
            with open(p, "w") as fh:
                fh.write(f'#!/bin/sh\necho "{n} $*" >> "{self.log}"\n')
            os.chmod(p, 0o755)

    def run_app(self, platform, apps=()):
        d = os.path.join(self.tmp, "Apps")
        os.makedirs(d, exist_ok=True)
        for a in apps:
            os.makedirs(os.path.join(d, a + ".app"), exist_ok=True)
        ok, text = lean_maplive.open_app(self.home, platform=platform, env={"PATH": self.bin}, apps_dirs=[d])
        end = time.time() + 5
        def text():  # the fake app runs detached: the file can exist before its line lands
            try:
                return open(self.log).read()
            except OSError:
                return ""
        while time.time() < end and not text().endswith("\n"):
            time.sleep(0.05)
        lines = text().splitlines()
        if os.path.exists(self.log):
            os.unlink(self.log)
        return ok, lines

    def test_linux(self):
        self.fake("xdg-open")
        self.assertEqual(self.run_app("linux"), (True, [f"xdg-open {self.url}"]))
        self.fake("chromium", "brave-browser")
        self.assertEqual(self.run_app("linux"), (True, [f"chromium --app={self.url}"]))
        self.fake("google-chrome")
        self.assertEqual(self.run_app("linux"), (True, [f"google-chrome --app={self.url}"]))

    def test_linux_nothing(self):
        ok, text = lean_maplive.open_app(self.home, platform="linux", env={"PATH": self.bin})
        self.assertFalse(ok)
        self.assertIn(self.url, text)

    def test_macos(self):
        self.fake("open")
        self.assertEqual(self.run_app("darwin"), (True, [f"open {self.url}"]))
        self.assertEqual(self.run_app("darwin", ["Brave Browser", "Microsoft Edge"]), (True, [f"open -na Microsoft Edge --args --app={self.url}"]))
        self.assertEqual(self.run_app("darwin", ["Google Chrome", "Chromium"]), (True, [f"open -na Google Chrome --args --app={self.url}"]))

    def test_endpoint_down_starts_nothing(self):
        self.fake("open", "xdg-open", "google-chrome")
        tmp2 = os.path.join(self.tmp, "none")
        ok, text = lean_maplive.open_app(tmp2, platform="linux", env={"PATH": self.bin})
        self.assertFalse(ok)
        self.assertIn("not running", text)
        time.sleep(0.3)
        self.assertFalse(os.path.exists(self.log))

    def test_cli_app_without_service(self):
        env = clean_environ()
        r = subprocess.run([sys.executable, os.path.join(ROOT, "lean_agent.py"), "map", "--app"], capture_output=True, text=True,
                           env=dict(env, HOME=self.tmp, LEAN_AGENT_TEST="1"), timeout=60)
        self.assertEqual(r.returncode, 1)
        self.assertIn("not running", r.stdout)


class ProbeTest(unittest.TestCase):
    def test_probe_written(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        live = lean_maplive.Live(snap, tmp).start()
        self.addCleanup(live.stop)
        p = lean_maplive.write_probe(tmp)
        self.assertEqual(p, os.path.join(tmp, "map", "probe.html"))
        self.assertEqual(stat.S_IMODE(os.stat(p).st_mode), 0o600)
        with open(p) as fh:
            h = fh.read()
        self.assertEqual([u for u in re.findall(r"https?://[^/'\" ]*", h) if "127.0.0.1" not in u], [])
        for w in ("securitypolicyviolation", "isSecureContext", "WebSocket", "fetch", "img"):
            self.assertIn(w, h)
        self.assertIn(live.token, h)


NODE = shutil.which("node") or ("/opt/node22/bin/node" if os.path.exists("/opt/node22/bin/node") else None)
BROWSER_JS = r"""
const { chromium } = require('playwright');
(async () => {
  const [url, want, shot] = process.argv.slice(2);
  const b = await chromium.launch();
  const pg = await b.newPage({ viewport: { width: 700, height: 760 } });
  await pg.goto(url);
  const wants = want.split('|');
  let chip = '';
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    chip = await pg.locator('#chip').textContent().catch(() => '');
    if (wants.includes(chip)) break;
    await new Promise(r => setTimeout(r, 300));
  }
  await new Promise(r => setTimeout(r, 500));
  const rects = await pg.locator('#wrap .nd').count();
  const imgs = await pg.locator('#wrap img').count();
  const why = await pg.locator('#why').innerText().catch(() => '');
  if (shot) await pg.screenshot({ path: shot });
  console.log(JSON.stringify({ chip, rects, imgs, why }));
  await b.close();
})().catch(e => { console.log(JSON.stringify({ error: String(e).slice(0, 300) })); });
"""


def node_env():
    e = dict(os.environ)
    if not e.get("NODE_PATH") and os.path.isdir("/opt/node22/lib/node_modules"):
        e["NODE_PATH"] = "/opt/node22/lib/node_modules"
    if not e.get("PLAYWRIGHT_BROWSERS_PATH") and os.path.isdir("/opt/pw-browsers"):
        e["PLAYWRIGHT_BROWSERS_PATH"] = "/opt/pw-browsers"
    return e


def have_playwright():
    """True only when node, the playwright module and a launchable chromium all exist; never raises."""
    try:
        if not NODE or not os.path.exists(NODE):
            return False
        r = subprocess.run([NODE, "-e", "require('playwright').chromium.launch().then(b=>b.close()).catch(()=>process.exit(3))"],
                           capture_output=True, env=node_env(), timeout=120)
        return r.returncode == 0
    except Exception:
        return False


UI_JS = r"""
const { chromium } = require('playwright');
(async () => {
  const { url, shots, steps } = JSON.parse(process.argv[2]);
  const b = await chromium.launch();
  const out = {};
  const wait = async (pg, fn, arg, ms = 30000) => { try { await pg.waitForFunction(fn, arg, { timeout: ms }); return true; } catch (e) { return false; } };
  const chipIs = (t) => () => document.getElementById('chip').textContent === t;
  // desktop, dark
  let pg = await b.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
  await pg.goto(url);
  out.socket = await wait(pg, () => document.getElementById('chip').textContent === 'live socket');
  await wait(pg, () => document.querySelectorAll('.nd').length > 3);
  out.nodes = await pg.locator('.nd').count();
  out.legend = await pg.locator('footer').innerText();
  if (shots) await pg.screenshot({ path: shots + '/dark-1280.png', fullPage: true });
  // click a node
  const id = steps.node;
  await pg.locator('.nd[data-id="' + id + '"]').click();
  out.panelOpen = await pg.locator('#panel.open').count();
  out.panelText = await pg.locator('#panel').innerText();
  await pg.keyboard.press('Escape');
  out.panelClosedByEsc = (await pg.locator('#panel.open').count()) === 0;
  // keyboard: focus + Enter
  await pg.locator('.nd[data-id="' + id + '"]').focus();
  await pg.keyboard.press('Enter');
  out.panelByKey = await pg.locator('#panel.open').count();
  await pg.locator('#px').click();
  out.panelClosedByButton = (await pg.locator('#panel.open').count()) === 0;
  // pause
  const inbox = () => document.querySelector('#m-inb .m-value').innerText;
  await pg.waitForTimeout(1500);
  await pg.locator('#pause').click();
  out.pausedChip = await pg.locator('#chip').textContent();
  const before = await pg.locator('#m-inb .m-value').innerText();
  await pg.waitForTimeout(3500);
  out.heldWhilePaused = (await pg.locator('#m-inb .m-value').innerText()) === before;
  await pg.locator('#pause').click();
  out.resumed = await wait(pg, (b4) => document.querySelector('#m-inb .m-value').innerText !== b4, before);
  out.chipAfterResume = await pg.locator('#chip').textContent();
  await pg.close();
  // narrow, light
  pg = await b.newPage({ viewport: { width: 400, height: 800 }, colorScheme: 'light' });
  await pg.goto(url);
  await wait(pg, () => document.getElementById('chip').textContent === 'live socket');
  await wait(pg, () => document.querySelectorAll('.nd').length > 3);
  out.narrow = await pg.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  out.narrowBg = await pg.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  if (shots) await pg.screenshot({ path: shots + '/light-400.png', fullPage: true });
  await b.close();
  console.log(JSON.stringify(out));
})().catch(e => { console.log(JSON.stringify({ error: String(e).slice(0, 400) })); });
"""


class BrowserTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not have_playwright():
            raise unittest.SkipTest("node/playwright/browser not available")

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.js = os.path.join(self.tmp, "b.js")
        with open(self.js, "w") as fh:
            fh.write(BROWSER_JS)
        self.js_ui = os.path.join(self.tmp, "ui.js")
        with open(self.js_ui, "w") as fh:
            fh.write(UI_JS)

    def run_page(self, html, want, shot=""):
        f = os.path.join(self.tmp, "page.html")
        with open(f, "w") as fh:
            fh.write(html)
        r = subprocess.run([NODE, self.js, "file://" + f, want, shot], capture_output=True, text=True, timeout=120,
                           env=node_env())
        self.assertTrue(r.stdout.strip(), r.stderr)
        d = json.loads(r.stdout.strip().splitlines()[-1])
        self.assertNotIn("error", d)
        return d

    def live_html(self, snapshot, csp=None, fn=None, port=None):
        live = lean_maplive.Live(fn or (lambda: snapshot), self.tmp, interval=0.5).start()
        self.addCleanup(live.stop)
        ep = lean_maplive.endpoint(self.tmp)
        if port:
            ep = dict(ep, port=port)
        h = lean_maplive.build_html(snapshot, ep)
        if csp:
            h = h.replace("<head>", f'<head><meta http-equiv="Content-Security-Policy" content="{csp}">', 1)
        return h

    def test_socket(self):
        d = self.run_page(self.live_html(snap()), "live socket")
        self.assertEqual(d["chip"], "live socket")

    def test_websocket_blocked_falls_back(self):
        d = self.run_page(self.live_html(snap(), "connect-src 'none'"), "live image|preview blocks live updates")
        self.assertIn(d["chip"], ("live image", "preview blocks live updates"))
        if d["chip"] == "live image":
            self.assertEqual(d["imgs"], 1)
        self.assertIn("connect-src", d["why"])

    def test_everything_blocked(self):
        d = self.run_page(self.live_html(snap(), "connect-src 'none'; img-src 'none'"), "file refresh · 3 s")
        self.assertEqual(d["chip"], "file refresh · 3 s")
        self.assertIn("Open in browser", d["why"])

    def test_window_ui(self):
        n = [0]
        now = time.time()
        lean_map.reset()
        lean_map.VERSION = "9.9.9"
        lean_map.record("message", "main", "service", "send · t192", now=now)
        lean_map.record("message", "service", "t192", "deliver", node="t192", dir="to", text="x", now=now)
        lean_map.record_request("pending", 1.0, now=now)
        self.addCleanup(lean_map.reset)

        def fn():
            n[0] += 1
            ctx = {"service": {"pid": 1, "version": "9.9.9", "threads": 3, "up_s": 7200, "cpu_pct": 3.0, "socket_ms": 0.6}, "inbox": n[0],
                   "threads": [{"id": "t182", "title": "Parser fix", "state": "parked", "detail": "parked", "idle_s": 9000},
                               {"id": "t192", "title": "E2E checks", "state": "active", "detail": "mid-turn", "idle_s": 1, "mid": True},
                               {"id": "t196", "title": "PR review", "state": "idle", "detail": "idle 10 s", "idle_s": 10}],
                   "runs": [{"id": "r-8545", "thread": "t192", "model": "sonnet", "age_s": 700, "progress_s": 20, "alive": True}],
                   "desk_idle_s": 40}
            return lean_map.build(ctx)
        live = lean_maplive.Live(fn, self.tmp, interval=0.5).start()
        self.addCleanup(live.stop)
        shots = os.environ.get("LEAN_SHOTS") or "/tmp/claude-0/-home-user-lean-agent/ecf7a38c-d764-5e31-b359-10cc63491292/scratchpad/shots"
        arg = {"url": lean_maplive.page_url(self.tmp), "shots": shots if os.path.isdir(shots) else "", "steps": {"node": "t192"}}
        r = subprocess.run([NODE, self.js_ui, json.dumps(arg)], capture_output=True, text=True, timeout=180, env=node_env())
        self.assertTrue(r.stdout.strip(), r.stderr)
        d = json.loads(r.stdout.strip().splitlines()[-1])
        self.assertNotIn("error", d)
        self.assertTrue(d["socket"])
        self.assertGreaterEqual(d["nodes"], 5)
        for w in ("LEAN-AGENT // SYSTEM VISIBILITY LAYER", "click a card for details", "PRIVACY FILTER ACTIVE", "127.0.0.1"):
            self.assertIn(w.lower(), d["legend"].lower())
        self.assertEqual(d["panelOpen"], 1)
        self.assertIn("E2E checks", d["panelText"])
        self.assertIn("mid-turn", d["panelText"])
        self.assertTrue(d["panelClosedByEsc"])
        self.assertEqual(d["panelByKey"], 1)
        self.assertTrue(d["panelClosedByButton"])
        self.assertEqual(d["pausedChip"], "paused · view frozen")
        self.assertTrue(d["heldWhilePaused"])
        self.assertTrue(d["resumed"])
        self.assertEqual(d["chipAfterResume"], "live socket")
        self.assertLessEqual(d["narrow"][0], d["narrow"][1])  # no horizontal scroll at 400 px

    def test_no_data_when_snapshots_fail(self):
        def boom():
            raise RuntimeError("kaboom")
        d = self.run_page(self.live_html(snap(), fn=boom), "connected, no data (RuntimeError: kaboom)")
        self.assertEqual(d["chip"], "connected, no data (RuntimeError: kaboom)")

    def test_service_down_is_not_a_csp_block(self):
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        d = self.run_page(self.live_html(snap(), port=port), "snapshot · service not running|preview blocks live updates")
        self.assertEqual(d["chip"], "snapshot · service not running")

    def test_big_snapshot_draws_within_caps(self):
        shot = os.environ.get("MAP_SHOT") or ""
        s = big_snap()
        d = self.run_page(self.live_html(s), "live socket", shot)
        self.assertEqual(d["chip"], "live socket")
        # 12 threads + 3 workers each + desk + service + hooks + 3 desk workers + background-free
        self.assertLessEqual(d["rects"], 12 + 3 * 12 + 3 + 3)
        self.assertGreater(d["rects"], 5)


def rich_snap():
    """A snapshot that carries every optional activity field (built from the documented schema)."""
    now = time.time()

    def rec(tool, target, ago, ok=True, ms=120):
        return {"ts": now - ago, "tool": tool, "target": target, "ok": ok, "ms": ms}

    t1_recent = [rec("Edit", "lean_map.py", 20), rec("Bash", "git", 45, ok=False, ms=900), rec("Read", "lean_maplive.py", 90)]
    return {
        "v": 1, "ts": "t", "service": {"up": True, "version": "9.9.9", "threads": 3, "up_s": 100}, "paused": False,
        "inbox": 0, "moving": [], "more": 2,
        "totals": {"runs_today": 9, "usd_today": 3.1, "tokens_today": 1200000, "saved_today": 400000,
                   "tools_per_min": 14.0, "errors_30m": 2, "usd_yesterday": 5.0, "fail_rate_30m": 0.8, "workers_done": 2, "workers_queued": 1,
                   "projects_online": 2},
        "feed": [{"ts": now - 5, "node": "t1", "kind": "tool", "text": "Edit lean_map.py"},
                 {"ts": now - 9, "node": "t3", "kind": "message", "text": "message to t3"},
                 {"ts": now - 20, "node": "t1", "kind": "error", "text": "Bash git failed"},
                 {"ts": now - 40, "node": "w1", "kind": "run", "text": "run started"}],
        "nodes": [
            {"id": "service", "kind": "service", "label": "S", "state": "active", "detail": "d"},
            {"id": "main", "kind": "desk", "label": "Front desk", "state": "active", "detail": "talking",
             "activity": {"now": None, "top": [["Read", 3]], "recent": [rec("Read", "README.md", 60)], "files": 1,
                          "errors": 0, "mcp": [], "last_ts": now - 60}},
            {"id": "hooks", "kind": "hooks", "label": "Hooks", "state": "active", "detail": "14 a min"},
            {"id": "t1", "kind": "thread", "label": "Fix the map", "state": "active", "detail": "active · mid-turn",
             "activity": {"now": {"tool": "Edit", "target": "lean_map.py", "since_s": 3.2},
                          "top": [["Edit", 12], ["Bash", 7], ["Read", 5], ["Grep", 2], ["Glob", 1]],
                          "recent": t1_recent, "files": 4, "errors": 1, "mcp": ["github"], "last_ts": now - 20}},
            {"id": "t2", "kind": "thread", "label": "Parked one", "state": "parked", "detail": "parked 2 h"},
            {"id": "t3", "kind": "thread", "label": "Tests", "state": "active", "detail": "active",
             "activity": {"now": None, "top": [["pytest", 1]], "recent": [rec("Bash", "pytest", 30)], "files": 0,
                          "errors": 0, "mcp": [], "last_ts": now - 30}},
            {"id": "w1", "kind": "worker", "label": "w1", "state": "alive", "detail": "d", "parent": "t1", "model": "sonnet",
             "age_s": 600, "stats": {"turns": 7, "max_turns": 80, "tokens": 254349, "usd": 0.52, "context": 31000,
                                      "branch": "feature/x", "elapsed_s": 1382, "model": "sonnet"},
             "activity": {"now": {"tool": "Write", "target": "x.py", "since_s": 1.0}, "top": [["Write", 2]],
                          "recent": [rec("Write", "x.py", 10)], "files": 1, "errors": 0, "mcp": [], "last_ts": now - 10}}],
        "edges": [{"from": "service", "to": "t1", "kind": "idle", "age_s": 0, "label": "idle"},
                  {"from": "service", "to": "t2", "kind": "idle", "age_s": 0},
                  {"from": "service", "to": "t3", "kind": "idle", "age_s": 0},
                  {"from": "main", "to": "t1", "kind": "message", "age_s": 3, "label": "hello"},
                  {"from": "t1", "to": "w1", "kind": "idle", "age_s": 0},
                  {"from": "w1", "to": "t1", "kind": "report", "age_s": 5},
                  {"from": "main", "to": "service", "kind": "request", "age_s": 1}],
        "placed": ["service", "main", "hooks", "t1", "t2", "t3", "w1"]}


FEATURES_JS = r"""
const { chromium } = require('playwright');
(async () => {
  const { rich, plain, shots } = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
  const b = await chromium.launch();
  const out = { errors: [] };
  const open = async (file, vp, scheme) => {
    const pg = await b.newPage({ viewport: vp, colorScheme: scheme });
    pg.setDefaultTimeout(10000);
    pg.on('pageerror', e => out.errors.push(String(e).slice(0, 200)));
    await pg.goto('file://' + file);
    await pg.waitForSelector('.nd');
    await pg.waitForTimeout(300);
    return pg;
  };
  // 1280 dark
  let pg = await open(rich, { width: 1280, height: 800 }, 'dark');
  out.now = await pg.locator('.nd[data-id="t1"] > .now').innerText();
  out.chips = await pg.locator('.nd[data-id="t1"] > .chs .ch').allInnerTexts();
  out.errBadge = await pg.locator('.nd[data-id="t1"] > .chs .eb').count();
  out.mcp = await pg.locator('.nd[data-id="t1"] > .chs .mb').innerText();
  out.worker = await pg.locator('.nd[data-id="w1"]').innerText();
  out.bar = await pg.locator('.nd[data-id="w1"] .bar i').getAttribute('style');
  out.totals = await pg.evaluate(() => ['m-thr', 'm-wk', 'm-inb', 'm-cost', 'm-sav', 'm-tpm'].map(i => { const m = document.getElementById(i), f = m.querySelector('.m-foot'); return [m.querySelector('.m-value').innerText, f.hidden ? null : f.innerText]; }));
  out.feed = await pg.locator('#fl button').count();
  out.feedVisible = await pg.locator('#feed').isVisible();
  out.ticks = await pg.locator('#tl .tk').count();
  out.tickErr = await pg.locator('#tl .tk.er').count();
  out.wkNested = await pg.locator('.nd[data-id="t1"] .nd[data-id="w1"]').count();
  if (shots) await pg.screenshot({ path: shots + '/dark-1280.png', fullPage: true });
  // keyboard: slash focuses search, arrows move
  await pg.locator('body').click({ position: { x: 5, y: 5 } });
  await pg.keyboard.press('/');
  out.slashFocus = await pg.evaluate(() => document.activeElement.id);
  await pg.keyboard.press('Escape');
  await pg.locator('.nd[data-id="main"]').focus();
  await pg.keyboard.press('ArrowRight');
  out.arrow = await pg.evaluate(() => document.activeElement.dataset.id || '');
  // feed click selects the node
  await pg.locator('#fl button[data-node="t3"]').click();
  out.feedClick = await pg.locator('#panel h2').innerText();
  await pg.keyboard.press('Escape');
  // search
  await pg.locator('#q').fill('pytest');
  await pg.waitForTimeout(300);
  out.search = await pg.evaluate(() => [...document.querySelectorAll('.nd')].map(n => n.dataset.id));
  await pg.locator('#q').fill('');
  await pg.waitForTimeout(300);
  // hide idle + persistence
  await pg.locator('#fidle').click();
  out.hideIdle = await pg.evaluate(() => [...document.querySelectorAll('.nd')].map(n => n.dataset.id));
  await pg.reload(); await pg.waitForSelector('.nd');
  out.persisted = await pg.locator('#fidle').getAttribute('aria-pressed');
  await pg.locator('#fidle').click();
  // only errors
  await pg.locator('#ferr').click();
  out.onlyErr = await pg.evaluate(() => [...document.querySelectorAll('.nd')].map(n => n.dataset.id));
  await pg.locator('#ferr').click();
  await pg.close();
  // 1280 light with details
  pg = await open(rich, { width: 1280, height: 800 }, 'light');
  await pg.locator('.nd[data-id="t1"]').click();
  out.panel = await pg.locator('#panel').innerText();
  out.panelRows = await pg.locator('#panel #rt tbody tr').count();
  if (shots) await pg.screenshot({ path: shots + '/light-1280-details.png', fullPage: true });
  await pg.close();
  // 400 light
  pg = await open(rich, { width: 400, height: 800 }, 'light');
  out.narrow = await pg.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  out.cardTitle = await pg.locator('.nd[data-id="t1"]').getAttribute('title');
  if (shots) await pg.screenshot({ path: shots + '/light-400.png', fullPage: true });
  await pg.close();
  // a snapshot without any of the new fields
  pg = await open(plain, { width: 1280, height: 800 }, 'dark');
  out.plainNodes = await pg.locator('.nd').count();
  out.plainHidden = await pg.evaluate(() => ['m-cost', 'm-sav', 'm-tpm'].every(i => { const m = document.getElementById(i); return m.querySelector('.m-foot').hidden && m.querySelector('.m-value').innerText === '–'; }));
  await pg.locator('.nd[data-id="main"]').click();
  out.plainPanel = await pg.locator('#panel.open').count();
  await pg.close();
  await b.close();
  console.log(JSON.stringify(out));
})().catch(e => { console.log(JSON.stringify({ error: String(e).slice(0, 600) })); process.exit(0); });
"""


MATRIX_JS = r"""
const { chromium } = require('playwright');
(async () => {
  const { file, shots } = JSON.parse(process.argv[2]);
  const b = await chromium.launch();
  const out = { errors: [] };
  const open = async (opts, init) => {
    const ctx = await b.newContext(Object.assign({ viewport: { width: 1280, height: 800 } }, opts));
    const pg = await ctx.newPage();
    pg.on('pageerror', e => out.errors.push(String(e).slice(0, 200)));
    if (init) await pg.addInitScript(init);
    await pg.goto('file://' + file);
    await pg.waitForSelector('.nd');
    return [ctx, pg];
  };
  const theme = (pg) => pg.evaluate(() => document.documentElement.getAttribute('data-theme'));
  const rain = (pg) => pg.evaluate(() => document.documentElement.getAttribute('data-rain'));
  // theme: matrix by default (also for light-scheme users), the toggle persists
  let [ctx, pg] = await open({ colorScheme: 'light' });
  out.themeDefault = await theme(pg);
  out.bgMatrix = await pg.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  if (shots) await pg.screenshot({ path: shots + '/matrix-1280-light-scheme.png', fullPage: true });
  await pg.locator('#themetg').click();
  out.themeAfter = await theme(pg);
  out.bgClassic = await pg.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  out.rainClassic = await rain(pg);
  if (shots) await pg.screenshot({ path: shots + '/classic-1280-light.png', fullPage: true });
  await pg.reload(); await pg.waitForSelector('.nd');
  out.themePersist = await theme(pg);
  await pg.locator('#themetg').click();
  await pg.reload(); await pg.waitForSelector('.nd');
  out.themeBack = await theme(pg);
  await ctx.close();
  // rain: on, cheap (no long tasks), stops when hidden / toggled off / reduced motion
  [ctx, pg] = await open({ colorScheme: 'dark' }, () => {
    window.__long = [];
    try { new PerformanceObserver(l => l.getEntries().forEach(e => { if (e.startTime > 1500) window.__long.push(Math.round(e.duration)); })).observe({ entryTypes: ['longtask'] }); } catch (e) {}
    window.__frames = 0;
    const ff = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function () { window.__frames++; return ff.apply(this, arguments); };
  });
  out.rainOn = await rain(pg);
  await pg.waitForTimeout(5000);
  out.long = await pg.evaluate(() => window.__long);
  out.frames = await pg.evaluate(() => window.__frames);
  if (shots) await pg.screenshot({ path: shots + '/matrix-1280-map.png', fullPage: true });
  await pg.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  out.rainHidden = await rain(pg);
  const f0 = await pg.evaluate(() => window.__frames);
  await pg.waitForTimeout(600);
  out.hiddenFrames = (await pg.evaluate(() => window.__frames)) - f0;
  await pg.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
  out.rainVisible = await rain(pg);
  await pg.locator('#raintg').click();
  out.rainToggled = await rain(pg);
  await pg.reload(); await pg.waitForSelector('.nd');
  out.rainPersist = await rain(pg);
  await pg.locator('#raintg').click();
  out.rainBack = await rain(pg);
  await ctx.close();
  [ctx, pg] = await open({ colorScheme: 'dark', reducedMotion: 'reduce' });
  out.rainReduced = await rain(pg);
  await ctx.close();
  // 400 px: no horizontal scroll
  [ctx, pg] = await open({ colorScheme: 'dark', viewport: { width: 400, height: 800 } });
  out.narrow = await pg.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  if (shots) await pg.screenshot({ path: shots + '/matrix-400.png', fullPage: true });
  // focus ring is visible on a button
  await pg.keyboard.press('Tab');
  out.focusOutline = await pg.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  await ctx.close();
  await b.close();
  console.log(JSON.stringify(out));
})().catch(e => { console.log(JSON.stringify({ error: String(e).slice(0, 600) })); process.exit(0); });
"""


class MatrixThemeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not have_playwright():
            raise unittest.SkipTest("node/playwright/browser not available")

    def test_theme_rain_and_layout(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        page = os.path.join(tmp, "rich.html")
        with open(page, "w") as fh:
            fh.write(lean_maplive.build_html(rich_snap(), {}))
        js = os.path.join(tmp, "m.js")
        with open(js, "w") as fh:
            fh.write(MATRIX_JS)
        shots = os.environ.get("LEAN_SHOTS") or "/tmp/claude-0/-home-user-lean-agent/ecf7a38c-d764-5e31-b359-10cc63491292/scratchpad/shots5"
        arg = json.dumps({"file": page, "shots": shots if os.path.isdir(shots) else ""})
        r = subprocess.run([NODE, js, arg], capture_output=True, text=True, timeout=180, env=node_env())
        self.assertTrue(r.stdout.strip(), r.stderr)
        d = json.loads(r.stdout.strip().splitlines()[-1])
        self.assertNotIn("error", d)
        self.assertEqual(d["errors"], [])
        self.assertEqual(d["themeDefault"], "matrix")  # also for a light-scheme user
        self.assertEqual(d["themeAfter"], "classic")
        self.assertNotEqual(d["bgMatrix"], d["bgClassic"])
        self.assertEqual(d["rainClassic"], "off")
        self.assertEqual(d["themePersist"], "classic")
        self.assertEqual(d["themeBack"], "matrix")
        self.assertEqual(d["rainOn"], "on")
        self.assertEqual(d["long"], [])  # no long task (> 50 ms) once the page has settled, with the rain running
        self.assertLessEqual(d["frames"], 12 * 5 + 4)  # at most 12 frames a second
        self.assertGreater(d["frames"], 10)
        self.assertEqual(d["rainHidden"], "off")
        self.assertEqual(d["hiddenFrames"], 0)
        self.assertEqual(d["rainVisible"], "on")
        self.assertEqual(d["rainToggled"], "off")
        self.assertEqual(d["rainPersist"], "off")
        self.assertEqual(d["rainBack"], "on")
        self.assertEqual(d["rainReduced"], "off")
        self.assertLessEqual(d["narrow"][0], d["narrow"][1])
        self.assertNotEqual(d["focusOutline"], "none")



class FeaturesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not have_playwright():
            raise unittest.SkipTest("node/playwright/browser not available")

    def test_page_features(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        files = {}
        for name, sn in (("rich", rich_snap()), ("plain", snap())):
            files[name] = os.path.join(tmp, name + ".html")
            with open(files[name], "w") as fh:
                fh.write(lean_maplive.build_html(sn, None))
        shots = os.environ.get("MAP_SHOTS_DIR", "")
        if shots:
            os.makedirs(shots, exist_ok=True)
        args = os.path.join(tmp, "args.json")
        with open(args, "w") as fh:
            json.dump(dict(files, shots=shots), fh)
        js = os.path.join(tmp, "f.js")
        with open(js, "w") as fh:
            fh.write(FEATURES_JS)
        r = subprocess.run([NODE, js, args], capture_output=True, text=True, timeout=150, env=node_env())
        self.assertTrue(r.stdout.strip(), r.stderr)
        d = json.loads(r.stdout.strip().splitlines()[-1])
        self.assertNotIn("error", d)
        self.assertEqual(d["errors"], [])
        # in-progress tool, chips (at most 4), error badge, MCP badge
        self.assertRegex(d["now"], r"Edit · lean_map\.py · \d+ s")
        self.assertEqual(d["chips"], ["Edit 12", "Bash 7", "Read 5", "Grep 2"])
        self.assertEqual(d["errBadge"], 1)
        self.assertIn("github", d["mcp"])
        self.assertIn("sonnet", d["worker"])
        self.assertIn("$0.52", d["worker"])
        self.assertIn("254k", d["worker"])
        self.assertIn("feature/x", d["worker"])
        self.assertIn("width:9%", d["bar"])
        # metric cards: real totals, foots only when known
        t = d["totals"]
        self.assertEqual(t[0][0], "02 / 12")
        self.assertEqual(t[0][1], "2 projects online")
        self.assertEqual(t[1][1], "2 completed · 1 queued")
        self.assertEqual(t[2][0], "00")
        self.assertEqual(t[3], ["$3.10", "\u221238% vs yesterday"])
        self.assertEqual(t[4], ["400k", "lean-agent efficiency"])
        self.assertEqual(t[5], ["14", "0.8% failure rate"])
        # feed + timeline (3 + 1 + 1 + 1 events within 10 minutes; one failed)
        self.assertEqual(d["feed"], 4)
        self.assertTrue(d["feedVisible"])
        self.assertEqual(d["ticks"], 6)
        self.assertEqual(d["tickErr"], 1)
        # workers are sub-cards of their thread
        self.assertEqual(d["wkNested"], 1)
        # keyboard and feed
        self.assertEqual(d["slashFocus"], "q")
        self.assertNotEqual(d["arrow"], "main")
        self.assertTrue(d["arrow"])
        self.assertIn("Tests", d["feedClick"])
        # filters
        self.assertIn("t3", d["search"])
        self.assertNotIn("t1", d["search"])
        self.assertNotIn("t2", d["search"])
        self.assertNotIn("t2", d["hideIdle"])
        self.assertIn("t1", d["hideIdle"])
        self.assertEqual(d["persisted"], "true")
        self.assertIn("t1", d["onlyErr"])
        self.assertNotIn("t3", d["onlyErr"])
        # details
        self.assertEqual(d["panelRows"], 3)
        for w in ("Recent tool calls", "lean_maplive.py", "Files touched", "github", "Edit lean_map.py"):
            self.assertIn(w.lower(), d["panel"].lower())
        # narrow screen: no sideways scroll, full text in the tooltip
        self.assertLessEqual(d["narrow"][0], d["narrow"][1])
        self.assertIn("Fix the map", d["cardTitle"])
        # nothing new in the snapshot: still renders
        self.assertGreaterEqual(d["plainNodes"], 2)
        self.assertTrue(d["plainHidden"])
        self.assertEqual(d["plainPanel"], 1)


FILE_REFRESH_JS = r"""
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const { file, next, stale } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const b = await chromium.launch();
  const out = { errors: [] };
  let pg = await b.newPage({ viewport: { width: 1280, height: 800 } });
  pg.setDefaultTimeout(15000);
  pg.on('pageerror', e => out.errors.push(String(e).slice(0, 200)));
  await pg.goto('file://' + file);
  await pg.waitForFunction(() => /file refresh/.test(document.getElementById('chip').textContent));
  out.chip = await pg.locator('#chip').textContent();
  await pg.evaluate(() => { window.__m = 1; });
  await pg.locator('.nd[data-id="t1"]').click();
  await pg.locator('#q').fill('fix');
  out.hashBefore = await pg.evaluate(() => location.hash);
  fs.writeFileSync(file, fs.readFileSync(next, 'utf8'));  // the service rewrites the file
  out.step = 'reload'; await pg.waitForFunction(() => !window.__m);  // reloaded
  await pg.waitForFunction(() => document.querySelector('#m-inb .m-value').innerText === '07');
  out.inbox = await pg.locator('#m-inb .m-value').innerText();
  out.sel = await pg.locator('#panel.open h2').innerText();
  out.q = await pg.locator('#q').inputValue();
  out.hash = await pg.evaluate(() => location.hash);
  out.chip2 = await pg.locator('#chip').textContent();
  out.link = await pg.locator('#why a').count();
  await pg.close();
  pg = await b.newPage({ viewport: { width: 1280, height: 800 } });
  pg.setDefaultTimeout(15000);
  await pg.goto('file://' + file + stale);
  await pg.waitForFunction(() => /stopped/.test(document.getElementById('chip').textContent));
  out.stale = await pg.locator('#chip').textContent();
  await pg.evaluate(() => { window.__m = 1; });
  await pg.waitForTimeout(4000);
  out.noReload = await pg.evaluate(() => window.__m === 1);
  await b.close();
  console.log(JSON.stringify(out));
  process.exit(0);
})().catch(e => { console.log(JSON.stringify({ error: String(e).slice(0, 600) })); process.exit(0); });
"""


class FileRefreshBrowserTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not have_playwright():
            raise unittest.SkipTest("node/playwright/browser not available")

    def test_file_refresh_mode(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        csp = '<meta http-equiv="Content-Security-Policy" content="connect-src \'none\'; img-src \'none\'">'
        ep = {"port": free_port(), "token": "tok"}

        def page(inbox, ts):
            d = rich_snap()
            d["inbox"], d["ts"] = inbox, ts
            return lean_maplive.build_html(d, ep).replace("<head>", "<head>" + csp, 1)
        f = os.path.join(tmp, "live.html")
        n = os.path.join(tmp, "next.html")
        with open(f, "w") as fh:
            fh.write(page(0, "2026-01-01T00:00:00"))
        with open(n, "w") as fh:
            fh.write(page(7, "2026-01-01T00:00:05"))
        args = os.path.join(tmp, "a.json")
        with open(args, "w") as fh:
            json.dump({"file": f, "next": n, "stale": "#fr=1&lt=2026-01-01T00%3A00%3A05&lf=" + str(int((time.time() - 120) * 1000))}, fh)
        js = os.path.join(tmp, "r.js")
        with open(js, "w") as fh:
            fh.write(FILE_REFRESH_JS)
        r = subprocess.run([NODE, js, args], capture_output=True, text=True, timeout=150, env=node_env())
        self.assertTrue(r.stdout.strip(), r.stderr)
        d = json.loads(r.stdout.strip().splitlines()[-1])
        self.assertNotIn("error", d)
        self.assertEqual(d["errors"], [])
        self.assertEqual(d["chip"], "file refresh · 3 s")
        self.assertIn("s=t1", d["hash"])
        self.assertEqual(d["inbox"], "07")
        self.assertIn("Fix the map", d["sel"])
        self.assertEqual(d["q"], "fix")
        self.assertEqual(d["chip2"], "file refresh · 3 s")
        self.assertEqual(d["link"], 1)
        self.assertIn("file refresh stopped", d["stale"])
        self.assertTrue(d["noReload"])


class HtmlTest(unittest.TestCase):
    def test_html(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        live = lean_maplive.Live(snap, tmp).start()
        self.addCleanup(live.stop)
        p = lean_maplive.write_html(tmp, snap())
        self.assertTrue(os.path.isabs(p))
        self.assertEqual(stat.S_IMODE(os.stat(p).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(os.path.dirname(p)).st_mode), 0o700)
        with open(p) as fh:
            h = fh.read()
        self.assertIn(str(live.port), h)
        self.assertIn(live.token, h)
        self.assertIn('"Front desk"', h)
        self.assertEqual([u for u in re.findall(r"https?://[^/'\" ]*", h) if "127.0.0.1" not in u], [])
        scripts = re.findall(r"<script>(.*?)</script>", h, re.S)
        self.assertEqual(len(scripts), 1)
        node = shutil.which("node")
        if node:
            f = os.path.join(tmp, "x.js")
            open(f, "w").write(scripts[0])
            r = subprocess.run([node, "--check", f], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)

def r2_snap():
    """Round-2 snapshot: projects, per-node project, alerts (built from the documented schema)."""
    now = time.time()
    return {
        "v": 1, "ts": "t2", "service": {"up": True, "version": "9.9.9", "threads": 3, "up_s": 100}, "paused": False,
        "inbox": 0, "moving": [], "more": 0,
        "projects": [{"slug": "api", "threads": 2, "workers": 1, "usd_today": 1.2, "tokens_today": 400000, "errors_30m": 0},
                     {"slug": "web", "threads": 1, "workers": 0, "usd_today": 0.4, "tokens_today": 90000, "errors_30m": 2}],
        "alerts": [{"id": "stuck:t1", "level": "warn", "node": "t1", "kind": "stuck", "text": "t1 mid-turn with no tool activity for 12 min", "since": now - 700},
                   {"id": "service:slow", "level": "bad", "node": None, "kind": "service", "text": "service socket round trip 300 ms", "since": now - 60}],
        "nodes": [
            {"id": "service", "kind": "service", "label": "S", "state": "active", "detail": "d"},
            {"id": "main", "kind": "desk", "label": "Front desk", "state": "active", "detail": "talking"},
            {"id": "t1", "kind": "thread", "label": "Fix the api", "state": "active", "detail": "active", "project": "api"},
            {"id": "t2", "kind": "thread", "label": "Second api", "state": "parked", "detail": "parked", "project": "api"},
            {"id": "t3", "kind": "thread", "label": "Web thing", "state": "parked", "detail": "parked", "project": "web"},
            {"id": "w1", "kind": "worker", "label": "w1", "state": "alive", "detail": "d", "parent": "t1", "project": "api", "age_s": 10}],
        "edges": [{"from": "service", "to": "t1", "kind": "idle", "age_s": 0, "label": "idle"}, {"from": "service", "to": "t2", "kind": "idle", "age_s": 0, "label": "idle"},
                  {"from": "service", "to": "t3", "kind": "idle", "age_s": 0, "label": "idle"}, {"from": "main", "to": "t1", "kind": "idle", "age_s": 0, "label": "idle"}],
        "placed": ["service", "main", "t1", "t2", "t3", "w1"]}


def r2_history(home, days=14, now=None):
    if str(home).endswith("-p"):
        raise RuntimeError("no history")  # the 'older service' instance
    day0 = time.time() - 13 * 86400
    days = [{"date": time.strftime("%Y-%m-%d", time.gmtime(day0 + i * 86400)), "usd": round(0.2 * i, 2), "tokens": 1000 * i, "saved": 500 * i,
             "runs": i, "cache_read_ratio": 0.5 + i / 40, "by_model": {"sonnet": round(0.15 * i, 2), "haiku": round(0.05 * i, 2)},
             "by_project": {"api": round(0.15 * i, 2), "web": round(0.05 * i, 2)}} for i in range(14)]
    return {"days": days, "top_threads": [{"node": "t1", "title": "Fix the api", "usd": 1.1, "tokens": 300000},
                                           {"node": "t3", "title": "Web thing", "usd": 0.4, "tokens": 90000}],
            "tools_7d": [["Edit", 120], ["Bash", 90]]}


ROUND2_JS = r"""
const { chromium } = require('playwright');
(async () => {
  const { url, plain, shots, T } = JSON.parse(process.argv[2]);
  const b = await chromium.launch();
  const out = { errors: [] };
  const open = async (u, vp, scheme, wait) => {
    const pg = await b.newPage({ viewport: vp, colorScheme: scheme });
    pg.setDefaultTimeout(10000);
    pg.on('pageerror', e => out.errors.push(String(e).slice(0, 200)));
    await pg.goto(u);
    await pg.waitForSelector(wait || '.nd');
    await pg.waitForTimeout(500);
    return pg;
  };
  const txt = (pg, sel) => pg.locator(sel).allInnerTexts();
  let pg = await open(url, { width: 1280, height: 900 }, 'dark');
  out.alerts = await pg.locator('#alerts .al').count();
  out.bell = (await pg.locator('#bell').innerText()).trim();
  out.marker = await pg.locator('.nd[data-id="t1"] .am.warn').count();
  out.groups = await txt(pg, '.pg');
  out.tags = await txt(pg, '.nd .pj');
  out.chips = await txt(pg, '#projs .pc');
  if (shots) await pg.screenshot({ path: shots + '/dark-1280-alerts.png', fullPage: true });
  await pg.locator('.al[data-id="stuck:t1"] .ash').click();
  await pg.waitForTimeout(300);
  out.sel = await pg.locator('.nd.sel[data-id="t1"]').count();
  out.panel = await pg.locator('#panel.open h2').innerText();
  await pg.keyboard.press('Escape');
  // project filter
  await pg.locator('#projs .pc[data-p="web"]').click();
  await pg.waitForTimeout(300);
  out.webCards = await pg.locator('.nd[data-id^="t"]').count();
  out.groupsFiltered = await pg.locator('.pg').count();
  out.tagsFiltered = await pg.locator('.nd .pj').count();
  await pg.locator('#projs .pc[data-p=""]').click();
  await pg.waitForTimeout(300);
  out.allCards = await pg.locator('.nd[data-id^="t"]').count();
  // replay at T: an edge with a message within 30 s and a tool event within 30 s
  await pg.evaluate((v) => { const s = document.getElementById('scr'); s.value = v; s.dispatchEvent(new Event('input')); }, T);
  await pg.waitForTimeout(900);
  out.rpEdge = await pg.locator('.nd[data-id="t1"][data-flow]').count() === 1;
  out.rpTool = (await txt(pg, '.nd[data-id="t2"] .now')).join('|');
  out.rpTool1 = await pg.locator('.nd[data-id="t1"] > .now:not(.idl)').count();
  out.rpChip = await pg.locator('#tlc').textContent();
  await pg.locator('#live').click();
  await pg.waitForTimeout(500);
  out.liveEdge = (await pg.locator('.nd[data-id="t1"][data-flow]').count()) === 1;
  out.liveHidden = (await pg.locator('#live').getAttribute('aria-pressed')) === 'true';
  await pg.locator('#r60').click();
  await pg.waitForTimeout(500);
  out.min60 = await pg.locator('#scr').getAttribute('min');
  await pg.locator('#r10').click();
  // dismiss
  await pg.locator('.al[data-id="stuck:t1"] .adx').click();
  await pg.waitForTimeout(300);
  out.afterDismiss = await pg.locator('#alerts .al').count();
  out.markerAfter = await pg.locator('.nd[data-id="t1"] .am').count();
  await pg.reload(); await pg.waitForSelector('.nd'); await pg.waitForTimeout(500);
  out.afterReload = await pg.locator('#alerts .al').count();
  out.noHscroll = await pg.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  await pg.close();
  // trends, light
  pg = await open(url, { width: 1280, height: 900 }, 'light');
  await pg.locator('#vtr').click();
  await pg.waitForSelector('#c1 svg');
  await pg.waitForTimeout(300);
  out.bars = await pg.locator('#c1 rect.bc').count();
  out.saved = await pg.locator('#c1 circle.sp').count();
  out.mix = await pg.locator('#c2 rect.mc').count();
  out.cache = await pg.locator('#c3 circle.cp').count();
  out.threads = await pg.locator('#ttt tbody tr').count();
  out.tools = await pg.locator('#c4 rect.bc').count();
  out.projRows = await pg.locator('#tpj tbody tr').count();
  await pg.locator('#c1 rect.bc').nth(13).focus();
  out.tip = await pg.locator('#tip').innerText();
  out.mapHidden = await pg.locator('#main').isHidden();
  if (shots) await pg.screenshot({ path: shots + '/matrix-1280-trends.png', fullPage: true });
  await pg.close();
  // 400 px
  pg = await open(url, { width: 400, height: 800 }, 'light');
  out.noHscroll400 = await pg.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  if (shots) await pg.screenshot({ path: shots + '/matrix-400-alerts.png', fullPage: true });
  await pg.locator('#vtr').click();
  await pg.waitForSelector('#c1 svg');
  await pg.waitForTimeout(300);
  out.noHscroll400t = await pg.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  await pg.close();
  // an older service: no new fields, no /history
  pg = await open(plain, { width: 1280, height: 800 }, 'dark');
  out.plainNodes = await pg.locator('.nd').count();
  out.plainAlerts = await pg.locator('#alerts').isHidden();
  out.plainBell = await pg.locator('#bell').isHidden();
  out.plainProjs = await pg.locator('#projs').isHidden();
  await pg.locator('#vtr').click();
  await pg.waitForTimeout(800);
  out.plainTrends = await pg.locator('#trends').innerText();
  await pg.close();
  await b.close();
  console.log(JSON.stringify(out));
})().catch(e => { console.log(JSON.stringify({ error: String(e).slice(0, 600) })); process.exit(0); });
"""


class Round2Test(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not have_playwright():
            raise unittest.SkipTest("node/playwright/browser not available")

    def test_alerts_projects_trends_replay(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        p = mock.patch.object(lean_map, "history_cached", r2_history)
        p.start()
        self.addCleanup(p.stop)
        live = lean_maplive.Live(r2_snap, tmp, interval=0.2).start()
        self.addCleanup(live.stop)
        live2 = lean_maplive.Live(snap, tmp + "-p", interval=0.2).start()
        self.addCleanup(live2.stop)
        now = time.time()
        live.replay.append({"ts": now - 120, "from": "main", "to": "t1", "op": "send", "node": None, "tool": None, "target": None, "ok": True})
        live.replay.append({"ts": now - 125, "from": "t2", "to": "service", "op": "tool", "node": "t2", "tool": "Grep", "target": "lean_map.py", "ok": True})
        # the replay endpoint: oldest first, token required, only what was recorded
        shots = os.environ.get("MAP_SHOTS_DIR", "")
        if shots:
            os.makedirs(shots, exist_ok=True)
        arg = {"url": f"http://127.0.0.1:{live.port}/?t={live.token}", "plain": f"http://127.0.0.1:{live2.port}/?t={live2.token}",
               "shots": shots, "T": -115}
        js = os.path.join(tmp, "r2.js")
        with open(js, "w") as fh:
            fh.write(ROUND2_JS)
        r = subprocess.run([NODE, js, json.dumps(arg)], capture_output=True, text=True, timeout=180, env=node_env())
        self.assertTrue(r.stdout.strip(), r.stderr)
        d = json.loads(r.stdout.strip().splitlines()[-1])
        self.assertNotIn("error", d)
        self.assertEqual(d["errors"], [])
        # alerts bar, bell, node marker, "show" selects the node
        self.assertEqual(d["alerts"], 2)
        self.assertEqual(d["bell"], "2")
        self.assertEqual(d["marker"], 1)
        self.assertEqual(d["sel"], 1)
        self.assertIn("Fix the api", d["panel"])
        # projects: chips, group labels, tags; the filter limits the cards
        self.assertEqual(len(d["chips"]), 3)
        self.assertTrue(d["chips"][0].lower().startswith("all"))
        self.assertIn("api", d["chips"][1].lower())
        self.assertIn("$1.20", d["chips"][1])
        self.assertEqual([g.lower() for g in d["groups"]], ["api", "web"])
        self.assertEqual(sorted(t.lower().lstrip("/ ") for t in d["tags"]), ["api", "api", "web"])
        self.assertEqual(d["webCards"], 1)
        self.assertEqual(d["groupsFiltered"], 0)
        self.assertEqual(d["tagsFiltered"], 0)
        self.assertEqual(d["allCards"], 3)
        # replay at T
        self.assertTrue(d["rpEdge"])
        self.assertIn("Grep", d["rpTool"])
        self.assertEqual(d["rpTool1"], 0)
        self.assertIn("replay at", d["rpChip"])
        self.assertFalse(d["liveEdge"])
        self.assertTrue(d["liveHidden"])
        self.assertEqual(d["min60"], "-3600")
        # dismiss (survives a reload of the page in this session)
        self.assertEqual(d["afterDismiss"], 1)
        self.assertEqual(d["markerAfter"], 0)
        self.assertEqual(d["afterReload"], 1)
        # trends
        self.assertEqual((d["bars"], d["saved"], d["cache"]), (14, 14, 14))
        self.assertGreater(d["mix"], 14)
        self.assertEqual((d["threads"], d["tools"], d["projRows"]), (2, 2, 2))
        self.assertRegex(d["tip"], r"\d{4}-\d\d-\d\d")
        self.assertTrue(d["mapHidden"])
        # layout
        self.assertTrue(d["noHscroll"] and d["noHscroll400"] and d["noHscroll400t"])
        # an older service
        self.assertGreaterEqual(d["plainNodes"], 2)
        self.assertTrue(d["plainAlerts"] and d["plainBell"] and d["plainProjs"])
        self.assertIn("not available", d["plainTrends"])

    def test_on_request_broadcasts_and_records_once(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        live = lean_maplive.Live(snap, tmp, interval=0.2)
        got = []
        live._broadcast = got.append
        live.clients.append({"q": None})
        live.on_request("send", {"thread": "t1"})
        self.assertEqual(len(got), 1)
        self.assertEqual(json.loads(got[0])["to"], "t1")
        self.assertEqual([e["op"] for e in live.replay], ["send"])
        live.clients.clear()
        live.on_request("send", {"thread": "t2"})
        self.assertEqual(len(got), 1)
        self.assertEqual(len(live.replay), 2)


if __name__ == "__main__":
    unittest.main()
