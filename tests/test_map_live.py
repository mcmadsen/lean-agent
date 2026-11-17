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

    def test_page_has_legend_and_footer(self):
        _, _, body = http_get(self.live.port, f"/?t={self.live.token}")
        text = body.decode()
        for w in ("Live map", "Message to an agent", "Report or result back", "Socket request", "Idle link", "Undelivered or stuck",
                  "Lines fade 30 s after the last message · click a node for details", "Pause", "updates as messages move"):
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
        self.assertEqual(lean_maplive.page_url(tmp), f"http://127.0.0.1:{live.port}/?t={live.token}")

    def test_cli_url_without_service(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        env = clean_environ()
        r = subprocess.run([sys.executable, os.path.join(ROOT, "lean_agent.py"), "map", "--url"], capture_output=True, text=True,
                           env=dict(env, HOME=tmp, LEAN_AGENT_TEST="1"), timeout=60)
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
    chip = await pg.locator('#chip').innerText().catch(() => '');
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
  const chipIs = (t) => () => document.getElementById('chip').innerText === t;
  // desktop, dark
  let pg = await b.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
  await pg.goto(url);
  out.socket = await wait(pg, () => document.getElementById('chip').innerText === 'live (socket)');
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
  const inbox = () => document.getElementById('inbox').innerText;
  await pg.waitForTimeout(1500);
  await pg.locator('#pause').click();
  out.pausedChip = await pg.locator('#chip').innerText();
  const before = await pg.locator('#inbox').innerText();
  await pg.waitForTimeout(3500);
  out.heldWhilePaused = (await pg.locator('#inbox').innerText()) === before;
  await pg.locator('#pause').click();
  out.resumed = await wait(pg, (b4) => document.getElementById('inbox').innerText !== b4, before);
  out.chipAfterResume = await pg.locator('#chip').innerText();
  await pg.close();
  // narrow, light
  pg = await b.newPage({ viewport: { width: 400, height: 800 }, colorScheme: 'light' });
  await pg.goto(url);
  await wait(pg, () => document.getElementById('chip').innerText === 'live (socket)');
  await wait(pg, () => document.querySelectorAll('.nd').length > 3);
  out.narrow = await pg.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  out.narrowBg = await pg.evaluate(() => getComputedStyle(document.body).backgroundColor);
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
        self.assertGreaterEqual(d["nodes"], 6)
        for w in ("Message to an agent", "Undelivered or stuck", "click a node for details"):
            self.assertIn(w, d["legend"])
        self.assertEqual(d["panelOpen"], 1)
        self.assertIn("E2E checks", d["panelText"])
        self.assertIn("mid-turn", d["panelText"])
        self.assertTrue(d["panelClosedByEsc"])
        self.assertEqual(d["panelByKey"], 1)
        self.assertTrue(d["panelClosedByButton"])
        self.assertEqual(d["pausedChip"], "paused")
        self.assertTrue(d["heldWhilePaused"])
        self.assertTrue(d["resumed"])
        self.assertEqual(d["chipAfterResume"], "live (socket)")
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
                   "tools_per_min": 14.0, "errors_30m": 2},
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
  const edgeCheck = (pg) => pg.evaluate(() => {
    const cards = {}; document.querySelectorAll('.nd').forEach(n => { const s = n.style;
      cards[n.dataset.id] = { l: parseFloat(s.left), t: parseFloat(s.top), r: parseFloat(s.left) + parseFloat(s.width), b: parseFloat(s.top) + parseFloat(s.height) }; });
    const on = (c, x, y) => { const e = 0.6; const inx = x >= c.l - e && x <= c.r + e, iny = y >= c.t - e && y <= c.b + e;
      return inx && iny && (Math.abs(x - c.l) < e || Math.abs(x - c.r) < e || Math.abs(y - c.t) < e || Math.abs(y - c.b) < e); };
    let n = 0, bad = 0;
    document.querySelectorAll('#stage line[data-from]').forEach(l => { n++;
      const a = cards[l.dataset.from], z = cards[l.dataset.to];
      if (!a || !z || !on(a, +l.getAttribute('x1'), +l.getAttribute('y1')) || !on(z, +l.getAttribute('x2'), +l.getAttribute('y2'))) bad++; });
    return { n, bad };
  });
  // 1280 dark
  let pg = await open(rich, { width: 1280, height: 800 }, 'dark');
  out.now = await pg.locator('.nd[data-id="t1"] .now').innerText();
  out.chips = await pg.locator('.nd[data-id="t1"] .ch').allInnerTexts();
  out.errBadge = await pg.locator('.nd[data-id="t1"] .eb').count();
  out.mcp = await pg.locator('.nd[data-id="t1"] .mb').innerText();
  out.worker = await pg.locator('.nd[data-id="w1"]').innerText();
  out.bar = await pg.locator('.nd[data-id="w1"] .bar i').getAttribute('style');
  out.totals = await pg.evaluate(() => ['runs', 'usd', 'saved', 'tpm', 'errs'].map(i => document.getElementById(i).innerText));
  out.feed = await pg.locator('#fl button').count();
  out.feedVisible = await pg.locator('#feed').isVisible();
  out.ticks = await pg.locator('#tl .tk').count();
  out.tickErr = await pg.locator('#tl .tk.er').count();
  out.edges1280 = await edgeCheck(pg);
  out.wkRow = await pg.evaluate(() => { const t = document.querySelector('.nd[data-id="t1"]').style, w = document.querySelector('.nd[data-id="w1"]').style;
    return [parseFloat(t.top) + parseFloat(t.height) / 2, parseFloat(w.top) + parseFloat(w.height) / 2, parseFloat(t.left) + parseFloat(t.width), parseFloat(w.left)]; });
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
  // legend toggle hides lines of that kind
  const before = await pg.locator('#stage line[data-idle="1"]').count();
  await pg.locator('.lg[data-k="idle"]').click();
  out.idleLines = [before, await pg.locator('#stage line[data-idle="1"]').count()];
  await pg.locator('.lg[data-k="idle"]').click();
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
  out.edges400 = await edgeCheck(pg);
  out.cardTitle = await pg.locator('.nd[data-id="t1"]').getAttribute('title');
  if (shots) await pg.screenshot({ path: shots + '/light-400.png', fullPage: true });
  await pg.close();
  // a snapshot without any of the new fields
  pg = await open(plain, { width: 1280, height: 800 }, 'dark');
  out.plainNodes = await pg.locator('.nd').count();
  out.plainHidden = await pg.evaluate(() => ['runs', 'usd', 'saved', 'tpm'].every(i => document.getElementById(i).hidden));
  await pg.locator('.nd[data-id="main"]').click();
  out.plainPanel = await pg.locator('#panel.open').count();
  await pg.close();
  await b.close();
  console.log(JSON.stringify(out));
})().catch(e => { console.log(JSON.stringify({ error: String(e).slice(0, 600) })); process.exit(0); });
"""


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
        # header totals
        self.assertEqual(d["totals"][0], "9 runs today")
        self.assertEqual(d["totals"][1], "$3.10 today")
        self.assertIn("saved ~400k tokens today", d["totals"][2])
        self.assertEqual(d["totals"][3], "14 tools/min")
        self.assertIn("2 errors", d["totals"][4])
        # feed + timeline (3 + 1 + 1 + 1 events within 10 minutes; one failed)
        self.assertEqual(d["feed"], 4)
        self.assertTrue(d["feedVisible"])
        self.assertEqual(d["ticks"], 6)
        self.assertEqual(d["tickErr"], 1)
        # workers sit right beside their thread, on the same row
        ty, wy, tr, wl = d["wkRow"]
        self.assertAlmostEqual(ty, wy, delta=1)
        self.assertLess(wl - tr, 60)
        self.assertGreaterEqual(wl, tr)
        # every edge ends on a card border, at both sizes
        for k in ("edges1280", "edges400"):
            self.assertGreater(d[k]["n"], 4)
            self.assertEqual(d[k]["bad"], 0, k)
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
        self.assertGreater(d["idleLines"][0], 0)
        self.assertEqual(d["idleLines"][1], 0)
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
