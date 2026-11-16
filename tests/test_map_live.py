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
        s, head, _ = connect(self.live.port, self.live.token, upgrade=False)
        s.close()
        self.assertIn("400", head.split("\r\n")[0])

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
        self.assertEqual(re.findall(r"https?://", h), [])
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
