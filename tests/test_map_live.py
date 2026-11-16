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


def connect(port, token, path=None, method="GET", upgrade=True):
    s = socket.create_connection(("127.0.0.1", port), timeout=WAIT)
    key = base64.b64encode(os.urandom(16)).decode()
    p = path if path is not None else (f"/?t={token}" if token else "/")
    req = f"{method} {p} HTTP/1.1\r\nHost: x\r\n" + (f"Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n" if upgrade else "") + "\r\n"
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


def http_get(port, path, method="GET"):
    s = socket.create_connection(("127.0.0.1", port), timeout=WAIT)
    s.sendall(f"{method} {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n".encode())
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
    chip = await pg.locator('#chip').innerText().catch(() => '');
    if (wants.includes(chip)) break;
    await new Promise(r => setTimeout(r, 300));
  }
  await new Promise(r => setTimeout(r, 500));
  const rects = await pg.locator('#map svg rect').count();
  const imgs = await pg.locator('#map img').count();
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
        d = self.run_page(self.live_html(snap()), "live (socket)")
        self.assertEqual(d["chip"], "live (socket)")

    def test_websocket_blocked_falls_back(self):
        d = self.run_page(self.live_html(snap(), "connect-src 'none'"), "live (image)|preview blocks live updates")
        self.assertIn(d["chip"], ("live (image)", "preview blocks live updates"))
        if d["chip"] == "live (image)":
            self.assertEqual(d["imgs"], 1)
        self.assertIn("connect-src", d["why"])

    def test_everything_blocked(self):
        d = self.run_page(self.live_html(snap(), "connect-src 'none'; img-src 'none'"), "preview blocks live updates")
        self.assertEqual(d["chip"], "preview blocks live updates")
        self.assertIn("Open in browser", d["why"])

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
        d = self.run_page(self.live_html(snap(), port=port), "snapshot (service not running)|preview blocks live updates")
        self.assertEqual(d["chip"], "snapshot (service not running)")

    def test_big_snapshot_draws_within_caps(self):
        shot = os.environ.get("MAP_SHOT") or ""
        s = big_snap()
        d = self.run_page(self.live_html(s), "live (socket)", shot)
        self.assertEqual(d["chip"], "live (socket)")
        # 12 threads + 3 workers each + desk + service + hooks + 3 desk workers + background-free
        self.assertLessEqual(d["rects"], 12 + 3 * 12 + 3 + 3)
        self.assertGreater(d["rects"], 5)


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


if __name__ == "__main__":
    unittest.main()
