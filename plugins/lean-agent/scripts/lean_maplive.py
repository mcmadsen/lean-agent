"""The live map over a loopback WebSocket: read-only, token-gated, idle = zero work (snapshots are computed only while a page
is connected, at most every INTERVAL s, pushed only when their shape changed). Plus the self-contained page (`map --html`)."""
import base64
import collections
import hashlib
import hmac
import json
import os
import queue
import secrets
import select
import shutil
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.parse

import lean_map

GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_CLIENTS = 8
INTERVAL = 2.0
QUEUE_MAX = 32
MAX_FRAME = 1 << 16
HANDSHAKE_S = 5.0
LOG_EVERY_S = 60.0
POLL_S = 10.0  # a page that polled this recently counts as watching
PING_S = 25.0
FILE = "map-live.json"
DEFAULT_PORT = 47821  # the stable, bookmarkable port (LEAN_AGENT_MAP_PORT changes it; busy -> an OS-chosen one)
REFRESH_FILE = "refresh.json"
REFRESH_EVERY = 3.0  # a registered page file is rewritten at most this often, and only when the map changed
HEARTBEAT = 20.0  # ... or when it is this old (so a quiet map is not mistaken for a stopped refresh)
REPLAY_S = 3600  # the replay ring keeps this much of what the endpoint broadcasts
REPLAY_MAX = 5000
REFRESH_MIN = 30  # default minutes a `map --html` file keeps refreshing


def wanted_port():
    try:
        p = int(os.environ.get("LEAN_AGENT_MAP_PORT") or DEFAULT_PORT)
        return p if 0 <= p < 65536 else DEFAULT_PORT
    except ValueError:
        return DEFAULT_PORT


def refresh_path(home):
    return os.path.join(home, "map", REFRESH_FILE)


def _atomic(path, text, mode=0o600):
    tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(fd, "w") as fh:
        fh.write(text)
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def load_refresh(home):
    """{absolute file path: expiry epoch} of the page files the service keeps fresh."""
    try:
        with open(refresh_path(home)) as fh:
            d = json.load(fh).get("files")
        return {str(k): float(v) for k, v in d.items()} if isinstance(d, dict) else {}
    except (OSError, ValueError, AttributeError, TypeError):
        return {}


def register_refresh(home, path, minutes=None, now=None):
    """Registers (or extends) `path` for `minutes` (default 30); returns the expiry. Expired entries are dropped."""
    now = time.time() if now is None else now
    try:
        minutes = float(REFRESH_MIN if minutes is None else minutes)
    except (TypeError, ValueError):
        minutes = float(REFRESH_MIN)
    files = {k: v for k, v in load_refresh(home).items() if v > now}
    files[os.path.abspath(path)] = now + max(0.0, minutes) * 60
    os.makedirs(os.path.dirname(refresh_path(home)), exist_ok=True)
    _atomic(refresh_path(home), json.dumps({"files": files}))
    return files[os.path.abspath(path)]


def live_path(home):
    return os.path.join(home, FILE)


def event_nodes(op, req):
    """(from, to) node ids for a socket request, or None when the caller/target is unknown."""
    tid = str(req.get("thread") or "") if isinstance(req, dict) else ""
    if op in ("send", "wake") and tid:
        return "main", tid
    if op == "pending":
        return (tid, "service") if tid else ("main", "service")
    if op in ("map", "ping"):
        return None
    return "main", "service"


def _default_log(level, component, message):
    import lean_log
    lean_log.log(level, component, message)


def _sha(snap):
    return hashlib.sha256(lean_map.signature(snap).encode()).hexdigest()


def frame(payload, op=1):
    b = payload if isinstance(payload, bytes) else payload.encode()
    n = len(b)
    head = bytes([0x80 | op]) + (bytes([n]) if n < 126 else b"\x7e" + struct.pack(">H", n) if n < 65536 else b"\x7f" + struct.pack(">Q", n))
    return head + b


def parse_frames(buf):
    """-> (list of (opcode, payload), rest). Raises ValueError on an oversized or unmasked frame."""
    out = []
    while len(buf) >= 2:
        op, ln = buf[0] & 0x0F, buf[1] & 0x7F
        masked = buf[1] & 0x80
        i = 2
        if ln == 126:
            if len(buf) < 4:
                break
            ln, i = struct.unpack(">H", buf[2:4])[0], 4
        elif ln == 127:
            if len(buf) < 10:
                break
            ln, i = struct.unpack(">Q", buf[2:10])[0], 10
        if ln > MAX_FRAME or not masked:
            raise ValueError("bad frame")
        if len(buf) < i + 4 + ln:
            break
        key = buf[i:i + 4]
        data = bytes(b ^ key[j % 4] for j, b in enumerate(buf[i + 4:i + 4 + ln]))
        out.append((op, data))
        buf = buf[i + 4 + ln:]
    return out, buf


class Live:
    def __init__(self, snapshot, home, interval=INTERVAL, max_clients=MAX_CLIENTS, port=None):
        self.snapshot = snapshot
        self.want_port = wanted_port() if port is None else port
        self.fallback = False
        self.rwake = threading.Event()
        self.rwritten = {}  # file -> (hash, monotonic of the last write)
        self.home = home
        self.interval = interval
        self.max_clients = max_clients
        self.token = secrets.token_urlsafe(24)
        self.port = None
        self.lsock = None
        self.lock = threading.Lock()
        self.clients = []
        self.last = None  # (hash, message)
        self.wake = threading.Event()
        self.cache = None  # (monotonic, snapshot)
        self.replay = collections.deque(maxlen=REPLAY_MAX)  # what on_request already produces, memory only
        self.svg_cache = {}  # (w, h, mini) -> (monotonic, svg)
        self.last_poll = float("-inf")
        self.good = None  # last snapshot that computed
        self.err = ""
        self.err_logged = None  # monotonic() can be small right after boot (fresh CI VMs): no 0.0 sentinel
        self.log = _default_log
        self.stopped = threading.Event()

    def start(self):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", self.want_port))
        except OSError:
            s.close()
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind(("127.0.0.1", 0))
            self.fallback = bool(self.want_port)
        s.listen(16)
        s.settimeout(0.5)
        self.lsock, self.port = s, s.getsockname()[1]
        os.makedirs(self.home, exist_ok=True)
        p = live_path(self.home)
        tmp = p + f".{os.getpid()}.tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as fh:
            json.dump({"port": self.port, "token": self.token, "pid": os.getpid(),
                       **({"fallback": True, "wanted": self.want_port} if self.fallback else {})}, fh)
        os.chmod(tmp, 0o600)
        os.replace(tmp, p)
        threading.Thread(target=self._accept, daemon=True).start()
        threading.Thread(target=self._loop, daemon=True).start()
        threading.Thread(target=self._refresh_loop, daemon=True).start()
        self.rwake.set()  # a registration made before the service started
        return self

    def stop(self):
        self.stopped.set()
        self.wake.set()
        self.rwake.set()
        try:
            self.lsock.close()
        except Exception:
            pass
        with self.lock:
            for c in self.clients:
                c["q"].put(None) if not c["q"].full() else None
        try:
            os.unlink(live_path(self.home))
        except OSError:
            pass

    def get_snap(self):
        """The snapshot, computed at most every `interval` s however many clients ask; only ever called on demand."""
        with self.lock:
            c = self.cache
            if c and time.monotonic() - c[0] < self.interval * 0.9 and c[2] == lean_map._hidden_now():
                return c[1]
        try:
            hid = lean_map._hidden_now()
            snap = lean_map.redact(self.snapshot())
        except Exception as exc:  # noqa: BLE001 - a failing snapshot must never take the loop or a request down
            self._fail(exc)
            if self.good is not None:
                return lean_map.redact(self.good)
            raise
        with self.lock:
            self.cache = (time.monotonic(), snap, hid)
            self.svg_cache = {}
            self.good = snap
            self.err = ""
        return snap

    def _fail(self, exc):
        text = f"{type(exc).__name__}: {exc}"[:200]
        now = time.monotonic()
        with self.lock:
            log_it = self.err_logged is None or now - self.err_logged >= LOG_EVERY_S
            if log_it:
                self.err_logged = now
        if log_it:  # log first: nobody sees the error (broadcast, or a new client's frame) before it is logged
            try:
                self.log("warn", "map", "live map snapshot failed: " + text)
            except Exception:
                pass
        with self.lock:
            self.err = text
        self._broadcast(json.dumps({"type": "error", "text": text}))

    def _first(self, c):
        """A new client gets a snapshot at once, not after the next interval."""
        if self.last:
            return
        try:
            snap = self.get_snap()
            msg = json.dumps({"type": "snapshot", **snap})
            with self.lock:
                if not self.last:
                    self.last = (_sha(snap), msg)
            c["q"].put_nowait(msg)
        except Exception:
            pass  # _fail already told every client, this one included

    def get_svg(self, w, h, mini):
        key = (w, h, mini, lean_map._hidden_now())
        snap = self.get_snap()
        with self.lock:
            c = self.svg_cache.get(key)
            if c and time.monotonic() - c[0] < self.interval:
                return c[1]
        out = lean_map.svg(snap, w, h, mini=mini)
        with self.lock:
            self.svg_cache[key] = (time.monotonic(), out)
        return out

    def watching(self):
        return bool(self.clients) or time.monotonic() - self.last_poll < POLL_S

    def _reply(self, conn, code, text, body=b"", ctype="text/plain; charset=utf-8", cors=False):
        head = [f"HTTP/1.1 {code} {text}", f"Content-Type: {ctype}", f"Content-Length: {len(body)}", "Connection: close",
                "Cache-Control: no-store", "Referrer-Policy: no-referrer", "X-Content-Type-Options: nosniff"]
        if cors:
            head.append("Access-Control-Allow-Origin: *")
        try:
            conn.sendall(("\r\n".join(head) + "\r\n\r\n").encode() + body)
        except OSError:
            pass

    def _route(self, conn, path, q):
        """Plain GET routes (token already checked): / (the page), /snap (JSON), /map.svg (the drawing)."""
        try:
            if path == "/snap":
                self.last_poll = time.monotonic()
                return self._reply(conn, 200, "OK", json.dumps(self.get_snap()).encode(), "application/json", cors=True)
            if path == "/history":
                try:
                    days = max(1, min(90, int((q.get("days") or ["14"])[0])))
                except ValueError:
                    days = 14
                body = json.dumps(lean_map.history_cached(self.home, days)).encode()
                return self._reply(conn, 200, "OK", body, "application/json", cors=True)
            if path == "/replay":
                try:
                    since = float((q.get("since") or ["0"])[0])
                except ValueError:
                    since = 0.0
                return self._reply(conn, 200, "OK", json.dumps({"events": self.replay_since(since)}).encode(), "application/json", cors=True)
            if path == "/map.svg":
                self.last_poll = time.monotonic()
                def dim(k, d):
                    try:
                        return max(100, min(2000, int((q.get(k) or [d])[0])))
                    except ValueError:
                        return d
                svg = self.get_svg(dim("w", 900), dim("h", 700), (q.get("mini") or ["0"])[0] == "1")
                return self._reply(conn, 200, "OK", svg.encode(), "image/svg+xml", cors=True)
            if path == "/":
                page = build_html(self.get_snap(), {"port": self.port, "token": self.token})
                return self._reply(conn, 200, "OK", page.encode(), "text/html; charset=utf-8")
            self._reply(conn, 404, "Not Found")
        except Exception:
            self._reply(conn, 500, "Error")

    # -- fan-out -------------------------------------------------------------------------------------------------------
    def _broadcast(self, msg):
        with self.lock:
            for c in self.clients:
                try:
                    c["q"].put_nowait(msg)
                except queue.Full:
                    pass  # a stuck page loses updates, never blocks the service

    def record_replay(self, op, req, now=None):
        """Keeps one broadcast-worthy item for /replay: socket events and finished tool calls (tool name + short safe target
        only). Never raises, computes nothing."""
        try:
            now = now or time.time()
            while self.replay and now - self.replay[0]["ts"] > REPLAY_S:
                self.replay.popleft()
            if op == "tool":
                if not isinstance(req, dict) or req.get("phase") == "pre" or not req.get("node") or not req.get("tool"):
                    return
                import lean_activity as act
                node = act._clean(req.get("node"), 40)
                self.replay.append({"ts": now, "from": node, "to": "service", "op": "tool", "node": node,
                                    "tool": act._clean(req.get("tool"), 30), "target": act._clean(req.get("target"), 70),
                                    "ok": bool(req.get("ok", True))})
                return
            ft = event_nodes(op, req)
            if ft:
                self.replay.append({"ts": now, "from": ft[0], "to": ft[1], "op": str(op), "node": None, "tool": None, "target": None, "ok": True})
        except Exception:
            pass

    def replay_since(self, since, now=None):
        now = now or time.time()
        lo = max(float(since), now - REPLAY_S)
        return lean_map.redact_events([dict(e, ts=round(e["ts"], 3)) for e in list(self.replay) if e["ts"] > lo])

    def on_request(self, op, req):
        """Called by the service socket per request; cheap and never raises."""
        if op == "map":
            self.rwake.set()  # `map --html` just registered a file: the refresher looks again
        self.record_replay(op, req)
        if not self.clients:
            return
        try:
            ft = event_nodes(op, req)
            if ft:
                self._broadcast(json.dumps({"type": "event", "from": ft[0], "to": ft[1], "op": str(op), "ts": time.time()}))
        except Exception:
            pass

    def _loop(self):
        while not self.stopped.is_set():
            if not self.clients:
                with self.lock:
                    self.last = None
                self.wake.wait()
                self.wake.clear()
                continue
            try:
                snap = self.get_snap()
                h = _sha(snap)
                if not self.last or self.last[0] != h:
                    msg = json.dumps({"type": "snapshot", **snap})
                    self.last = (h, msg)
                    self._broadcast(msg)
            except Exception as exc:  # noqa: BLE001
                try:
                    self._fail(exc)
                except Exception:
                    pass
            if self.stopped.wait(self.interval):
                break

    # -- file refresh (viewers that can only reload a file) -----------------------------------------------------------
    def _refresh_once(self, now=None):
        """Rewrites every unexpired registered file when the map changed (or the file is HEARTBEAT old). Returns how many
        files are still registered (0 = nothing to do: the loop then sleeps until the next `map --html`)."""
        now = time.time() if now is None else now
        files = {k: v for k, v in load_refresh(self.home).items() if v > now}
        if not files:
            self.rwritten = {}
            if load_refresh(self.home):
                try:
                    _atomic(refresh_path(self.home), json.dumps({"files": {}}))
                except OSError:
                    pass
            return 0
        snap = self.get_snap()
        h = _sha(snap)
        mono = time.monotonic()
        page = None
        for p in files:
            last = self.rwritten.get(p)
            if last and last[0] == h and mono - last[1] < HEARTBEAT and os.path.exists(p):
                continue
            if page is None:
                page = build_html(snap, endpoint(self.home))
            try:
                if os.path.isdir(os.path.dirname(p)):
                    _atomic(p, page)
                    self.rwritten[p] = (h, mono)
            except OSError:
                pass
        for p in [k for k in self.rwritten if k not in files]:
            self.rwritten.pop(p, None)
        return len(files)

    def _refresh_loop(self):
        while not self.stopped.is_set():
            try:
                n = self._refresh_once()
            except Exception as exc:  # noqa: BLE001 - never takes the service down
                try:
                    self._fail(exc)
                except Exception:
                    pass
                n = 1
            if n == 0:
                self.rwake.wait()
                self.rwake.clear()
            elif self.stopped.wait(REFRESH_EVERY):
                break

    # -- connections ---------------------------------------------------------------------------------------------------
    def _accept(self):
        while not self.stopped.is_set():
            try:
                conn, _ = self.lsock.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            threading.Thread(target=self._serve, args=(conn,), daemon=True).start()

    def _handshake(self, conn, box):
        conn.settimeout(HANDSHAKE_S)
        buf = b""
        while b"\r\n\r\n" not in buf and len(buf) < 8192:
            d = conn.recv(2048)
            if not d:
                return None
            buf += d
        head = buf.split(b"\r\n\r\n", 1)[0].decode("latin-1").split("\r\n")
        parts = head[0].split(" ")
        if len(parts) != 3 or parts[0] != "GET":
            self._http(conn, 405, "Method Not Allowed")
            return None
        hdr = {}
        for ln in head[1:]:
            k, _, v = ln.partition(":")
            hdr[k.strip().lower()] = v.strip()
        u = urllib.parse.urlsplit(parts[1])
        tok = (urllib.parse.parse_qs(u.query).get("t") or [""])[0]
        key = hdr.get("sec-websocket-key")
        is_ws = hdr.get("upgrade", "").lower() == "websocket"
        if not tok and not is_ws and (u.path or "/") == "/" and not u.query and hdr.get("host", "") in self.hosts():
            self._route(conn, "/", {})  # the bookmarkable page: only for the endpoint's own Host (no DNS rebinding)
            return None
        if not hmac.compare_digest(tok.encode(), self.token.encode()):
            self._http(conn, 403, "Forbidden")
            return None
        if is_ws and hdr.get("origin", "null") not in self.origins():
            self._http(conn, 403, "Forbidden")
            return None
        if not is_ws:
            self._route(conn, u.path or "/", urllib.parse.parse_qs(u.query))
            return None
        if "upgrade" not in hdr.get("connection", "").lower() or not key or hdr.get("sec-websocket-version") != "13":
            self._http(conn, 400, "Bad Request")
            return None
        with self.lock:
            if len(self.clients) >= self.max_clients:
                self._http(conn, 503, "Busy")
                return None
            box["c"] = {"q": queue.Queue(QUEUE_MAX)}
            self.clients.append(box["c"])
            if self.last:
                box["c"]["q"].put_nowait(self.last[1])
            if self.err:
                box["c"]["q"].put_nowait(json.dumps({"type": "error", "text": self.err}))
        acc = base64.b64encode(hashlib.sha1(key.encode() + GUID).digest()).decode()
        conn.sendall(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                      f"Sec-WebSocket-Accept: {acc}\r\n\r\n").encode())
        return buf.split(b"\r\n\r\n", 1)[1]

    def hosts(self):
        return (f"127.0.0.1:{self.port}", f"localhost:{self.port}")

    def origins(self):
        return ("null", f"http://127.0.0.1:{self.port}", f"http://localhost:{self.port}")

    @staticmethod
    def _http(conn, code, text):
        try:
            conn.sendall(f"HTTP/1.1 {code} {text}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".encode())
        except OSError:
            pass

    def _serve(self, conn):
        box = {}
        try:
            rest = self._handshake(conn, box)
            if rest is None:
                return
            c = box["c"]
            self.wake.set()
            self._first(c)
            conn.settimeout(5)
            buf, lastping = rest, time.monotonic()
            while not self.stopped.is_set():
                while True:
                    try:
                        m = c["q"].get_nowait()
                    except queue.Empty:
                        break
                    if m is None:
                        return
                    conn.sendall(frame(m))
                if time.monotonic() - lastping > PING_S:
                    conn.sendall(frame(b"", 9))
                    lastping = time.monotonic()
                if not buf and not select.select([conn], [], [], 0.25)[0]:
                    continue
                if not buf:
                    d = conn.recv(4096)
                    if not d:
                        return
                    buf = d
                frames, buf = parse_frames(buf)
                for op, data in frames:
                    if op == 8:
                        conn.sendall(frame(data[:2], 8))
                        return
                    if op == 9:
                        conn.sendall(frame(data, 10))
                    # text/binary from the page is ignored: read-only
        except (OSError, ValueError):
            pass
        finally:
            c = box.get("c")
            if c:
                with self.lock:
                    if c in self.clients:
                        self.clients.remove(c)
            try:
                conn.close()
            except OSError:
                pass


def endpoint(home):
    """{port, token, pid} of the running endpoint, or None."""
    try:
        with open(live_path(home)) as fh:
            d = json.load(fh)
        return d if isinstance(d.get("port"), int) and d.get("token") else None
    except (OSError, ValueError, AttributeError):
        return None


def check(home, wait=3.0):
    """Real handshake with the token from map-live.json, then wait for the first frame. -> (state, detail), state one of
    up | no-snapshot | token | down."""
    d = endpoint(home)
    if not d:
        return "down", ""
    try:
        s = socket.create_connection(("127.0.0.1", d["port"]), timeout=min(wait, 1.0))
    except OSError:
        return "down", ""
    end = time.monotonic() + wait
    try:
        key = base64.b64encode(os.urandom(16)).decode()
        s.sendall((f"GET /?t={urllib.parse.quote(d['token'])} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                   f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        buf = b""

        def more():
            left = end - time.monotonic()
            if left <= 0:
                raise socket.timeout()
            s.settimeout(left)
            b = s.recv(65536)
            if not b:
                raise EOFError()
            return b
        while b"\r\n\r\n" not in buf:
            buf += more()
        head, _, buf = buf.partition(b"\r\n\r\n")
        status = head.split(b"\r\n")[0].decode("latin-1")
        if " 403 " in status + " ":
            return "token", ""
        if " 101 " not in status + " ":
            return "no-snapshot", status.split(" ", 1)[-1] or "bad handshake"
        err = ""
        while True:  # server frames are unmasked
            while len(buf) < 2:
                buf += more()
            ln, i = buf[1] & 0x7F, 2
            if ln == 126:
                while len(buf) < 4:
                    buf += more()
                ln, i = struct.unpack(">H", buf[2:4])[0], 4
            elif ln == 127:
                while len(buf) < 10:
                    buf += more()
                ln, i = struct.unpack(">Q", buf[2:10])[0], 10
            while len(buf) < i + ln:
                buf += more()
            op, data, buf = buf[0] & 0x0F, buf[i:i + ln], buf[i + ln:]
            if op != 1:
                continue
            try:
                m = json.loads(data.decode())
            except ValueError:
                continue
            if m.get("type") == "snapshot":
                return "up", ""
            if m.get("type") == "error":
                err = str(m.get("text") or "")
                return "no-snapshot", "snapshot failed: " + err
    except socket.timeout:
        return "no-snapshot", f"no frame within {wait:g} s"
    except (OSError, EOFError):
        return "no-snapshot", "connection closed"
    finally:
        try:
            s.close()
        except OSError:
            pass


def doctor_line(home, wait=3.0):
    """(ok True/None, text) for `doctor`."""
    st, why = check(home, wait)
    if st == "up":
        d = endpoint(home) or {}
        if d.get("fallback"):
            return None, (f"live map page endpoint: up on port {d.get('port')} (the stable port {d.get('wanted')} was busy, so the URL "
                          "changed; free it or set LEAN_AGENT_MAP_PORT)")
        return True, f"live map page endpoint: up (127.0.0.1:{d.get('port')} only, sends snapshots)"
    if st == "no-snapshot":
        return None, f"live map page endpoint: accepts but sends no snapshot ({why})"
    if st == "token":
        return None, "live map page endpoint: token mismatch (page from an older service?)"
    return None, "live map page endpoint: not running (lean-agent up starts it)"


def page_url(home):
    """The stable, token-free http://127.0.0.1:<port>/ of the running endpoint, or None."""
    d = endpoint(home)
    return f"http://127.0.0.1:{d['port']}/" if d else None


def open_app(home, platform=None, env=None, apps_dirs=None, popen=None):
    """Opens the stable URL in a chromeless app window of the user's own machine and returns at once.
    -> (ok, message). Starts nothing when the endpoint is down."""
    u = page_url(home)
    if not u or not is_up(home):
        return False, "live map endpoint not running: start the service (lean-agent up), then run lean-agent map --app again"
    platform = platform or sys.platform
    env = dict(os.environ if env is None else env)
    pop = popen or (lambda cmd: subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                                   start_new_session=True, env=env))
    try:
        if platform == "darwin":
            dirs = apps_dirs if apps_dirs is not None else ["/Applications", os.path.expanduser("~/Applications")]
            for app in ("Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium"):
                if any(os.path.isdir(os.path.join(d, app + ".app")) for d in dirs):
                    pop(["open", "-na", app, "--args", "--app=" + u])
                    return True, f"opened {u} in a {app} app window"
            pop(["open", u])
            return True, f"opened {u} in the default browser"
        for b in ("google-chrome", "chromium", "microsoft-edge", "brave-browser"):
            exe = shutil.which(b, path=env.get("PATH"))
            if exe:
                pop([exe, "--app=" + u])
                return True, f"opened {u} in a {b} app window"
        exe = shutil.which("xdg-open", path=env.get("PATH"))
        if exe:
            pop([exe, u])
            return True, f"opened {u} in the default browser"
    except OSError as exc:
        return False, f"could not open a browser ({exc}); open {u} yourself"
    return False, f"no browser found to start; open {u} yourself"


def is_up(home, timeout=0.5):
    d = endpoint(home)
    if not d:
        return False
    try:
        socket.create_connection(("127.0.0.1", d["port"]), timeout=timeout).close()
        return True
    except OSError:
        return False


# -- the page ----------------------------------------------------------------------------------------------------------------
CSS = """
:root{color-scheme:dark;--bg:#0F1217;--card:#1A1F27;--bd:#2A313C;--tx:#E6E9EF;--tx2:#C9CFDA;--mu:#9AA3B2;--ok:#2EC4B6;--rep:#F2A541;--req:#7AA2F7;--idle:#5B6475;--bad:#F07167;
--svc-bg:#13252A;--svc-tx:#A7D9D3;--park-bg:#161A21;--park-bd:#3A4250;--hk-bg:#161C2A;--hk-bd:#34456B;--hk-tx:#A9B8D6;
--okbg:#13252A;--oktx:#7FE3D8;--warnbg:#2B2117;--warntx:#F7C47C;--reqtx:#A9C1FA;--line:#222832;--edge:#4A5262;--badbg:#2A1718;--badtx:#F6A7A1}
@media(prefers-color-scheme:light){:root{color-scheme:light;--bg:#F6F7F9;--card:#fff;--bd:#CBD2DC;--tx:#1B2230;--tx2:#3A4252;--mu:#667085;--ok:#1B9E92;--rep:#C9821A;--req:#4A72D8;--idle:#98A2B3;--bad:#D6453B;
--svc-bg:#E3F5F2;--svc-tx:#2D5F5A;--park-bg:#F0F2F5;--park-bd:#B8C0CC;--hk-bg:#EAF0FD;--hk-bd:#B6C6EE;--hk-tx:#3A4D78;
--okbg:#DDF3F0;--oktx:#12766C;--warnbg:#FBEBD3;--warntx:#8A5A0E;--reqtx:#2F55B8;--line:#DDE2EA;--edge:#9AA3B2;--badbg:#FCE4E1;--badtx:#9E2F27}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--tx);font:13px/1.4 Inter,system-ui,-apple-system,Segoe UI,sans-serif;overflow-x:hidden}
.mono{font-family:'JetBrains Mono',ui-monospace,Menlo,Consolas,monospace}
#app{max-width:1600px;margin:0 auto;padding:24px 32px 24px}
header{display:flex;align-items:center;justify-content:space-between;gap:16px 24px;flex-wrap:wrap}
h1{font-size:24px;line-height:30px;font-weight:700;letter-spacing:-.01em;margin:0}
#sub{color:var(--mu);margin-top:4px}
#chips{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pill{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;background:var(--card);color:var(--tx2);font-size:13px;white-space:nowrap}
.pill[hidden]{display:none}.pill.good{background:var(--okbg);color:var(--oktx)}.pill.bad{background:var(--badbg);color:var(--badtx)}
.pill.warn{background:var(--warnbg);color:var(--warntx)}
#pill{background:var(--okbg);color:var(--oktx);font-weight:500}
#pill .dot{width:8px;height:8px;border-radius:50%;background:var(--ok)}
#pill.re{background:var(--warnbg);color:var(--warntx)}#pill.re .dot{background:var(--rep)}
#pill.bad{background:var(--badbg);color:var(--badtx)}#pill.bad .dot{background:var(--bad)}
#pill.paused{background:var(--card);color:var(--mu)}#pill.paused .dot{background:var(--idle)}
button{height:36px;padding:0 14px;border-radius:8px;border:1px solid var(--bd);background:var(--card);color:var(--tx);font:inherit;font-size:13px;cursor:pointer}
button:focus-visible,.nd:focus-visible,a:focus-visible{outline:2px solid var(--req);outline-offset:2px}
#why{color:var(--mu);font-size:12px;margin-top:8px;min-height:0}#why a{color:var(--req)}
#wrap{position:relative;width:100%;margin-top:20px;overflow:hidden}
#wrap img{width:100%;height:auto;display:block}
#stage{position:absolute;left:0;top:0;transform-origin:0 0}
#stage svg.edges{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}
.nd{position:absolute;display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--card);border:1px solid var(--bd);border-radius:12px;color:var(--mu);font-size:13px;line-height:18px;cursor:pointer;overflow:hidden}
.nd b{color:var(--tx);font-weight:600}.nd .t{font-size:15px}
.nd .tx{min-width:0;flex:1;overflow:hidden;display:flex;flex-direction:column;gap:1px}.nd .tx>span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nr .nd{padding:8px 8px;gap:6px;font-size:12px;line-height:15px}.nr .nd .t{font-size:13px}.nr .nd .tx>span.sl{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.nd svg.i{flex:none}
.nd.live{border:2px solid var(--ok)}
.nd.dash{background:var(--park-bg);border:1px dashed var(--park-bd)}
.nd.bad{border:2px solid var(--bad)}
.nd.sel{box-shadow:0 0 0 3px var(--req)}
.nd.svc{background:var(--svc-bg);border:2px solid var(--ok);border-radius:14px;color:var(--svc-tx)}
.nd.hk{background:var(--hk-bg);border:1px solid var(--hk-bd);color:var(--hk-tx)}
.nd.wk{padding:8px 12px;font-size:12px;line-height:16px;border-radius:10px}
.nd.wk.live{border:2px solid var(--ok)}
.nd.wk.dash{background:var(--park-bg);border:1px dashed var(--rep)}
.elabel{font-size:12px;paint-order:stroke;stroke:var(--bg);stroke-width:4px;stroke-linejoin:round}
#more{position:absolute;color:var(--mu);font-size:12px}
footer{display:flex;align-items:center;justify-content:space-between;gap:12px 24px;margin-top:20px;padding-top:16px;border-top:1px solid var(--line);color:var(--mu);flex-wrap:wrap}
#legend{display:flex;align-items:center;gap:8px 20px;flex-wrap:wrap}
#legend .lg{display:inline-flex;align-items:center;gap:8px;height:28px;padding:0 8px;border:1px solid transparent;background:none;color:var(--mu);border-radius:6px}.lg[aria-pressed=false]{opacity:.4;text-decoration:line-through}.lg:hover{border-color:var(--bd)}
#panel{position:fixed;top:72px;right:16px;width:380px;max-height:calc(100vh - 96px);overflow:auto;background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:14px 16px;box-shadow:0 8px 28px rgba(0,0,0,.35);display:none;z-index:7}
#panel.open{display:block}
#panel h2{font-size:16px;margin:0 28px 8px 0;word-break:break-word}
#panel dl{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;margin:0}
#panel dt{color:var(--mu)}#panel dd{margin:0;word-break:break-word}
#panel h3{font-size:12px;color:var(--mu);margin:12px 0 4px;text-transform:uppercase;letter-spacing:.04em}
#panel ul{margin:0;padding:0 0 0 16px}
#panel .x{position:absolute;top:8px;right:8px;height:28px;padding:0 10px}
#bar{display:flex;align-items:center;gap:8px 10px;flex-wrap:wrap;margin-top:14px}
#q{height:36px;min-width:0;flex:1 1 200px;max-width:340px;padding:0 12px;border-radius:8px;border:1px solid var(--bd);background:var(--card);color:var(--tx);font:inherit}
#q:focus-visible{outline:2px solid var(--req);outline-offset:1px}
button.tg[aria-pressed=true],#ftog[aria-pressed=true]{background:var(--hk-bg);border-color:var(--hk-bd);color:var(--hk-tx)}
#fc{color:var(--mu);font-size:12px}
#main{display:flex;align-items:flex-start;gap:16px}#mapcol{flex:1;min-width:0}
#feed{display:none;width:300px;flex:none;position:sticky;top:12px;max-height:calc(100vh - 24px);margin-top:20px;background:var(--card);border:1px solid var(--bd);border-radius:12px;overflow:hidden;flex-direction:column}
#main.fo #feed{display:flex}
#feed .fh{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--line)}
#feed .fh button{height:28px;padding:0 10px}
#fl{list-style:none;margin:0;padding:4px 0;overflow:auto;flex:1}
#fl li{margin:0}#fl .empty{color:var(--mu);padding:12px}
.fl{display:grid;grid-template-columns:auto auto 1fr;gap:0 8px;width:100%;height:auto;text-align:left;border:0;border-left:3px solid var(--idle);border-radius:0;background:none;padding:5px 12px;font-size:12px;line-height:16px;align-items:baseline}
.fl:hover{background:var(--line)}
.fl time{color:var(--mu);font-variant-numeric:tabular-nums}.fl b{color:var(--tx);font-weight:600;max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fl em{display:none}.fl span{grid-column:1/-1;color:var(--tx2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fl.k-tool{border-left-color:var(--req)}.fl.k-message{border-left-color:var(--ok)}.fl.k-run{border-left-color:var(--rep)}.fl.k-error{border-left-color:var(--bad)}.fl.k-error span{color:var(--badtx)}
#tlw{margin-top:16px;background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:10px 12px}
#tlw h2{font-size:13px;margin:0 0 6px;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}#tlc{color:var(--mu);font-weight:400}
#tl{max-height:240px;overflow-y:auto;overflow-x:hidden}#tl svg{display:block}
#tl .gl{stroke:var(--line);stroke-width:1}#tl .ax{fill:var(--mu);font-size:10px}#tl .rl{fill:var(--tx2);font-size:11px;cursor:pointer}
#tl .tk{cursor:pointer}#tl .tk.ok{fill:var(--ok)}#tl .tk.er{fill:var(--bad)}#tl .tk:focus-visible{outline:2px solid var(--req)}#tl .tk:hover{stroke:var(--tx);stroke-width:1}
#tip{position:fixed;z-index:9;pointer-events:none;background:var(--tx);color:var(--bg);padding:4px 8px;border-radius:6px;font-size:12px;max-width:80vw;display:none}#tip.on{display:block}
.nd .now{display:flex;align-items:center;gap:6px;color:var(--oktx);font-weight:500}.nd .now>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pd{flex:none;width:7px;height:7px;border-radius:50%;background:var(--ok);animation:pd 1.2s ease-in-out infinite}
@keyframes pd{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.7)}}
.nd .chs{display:flex;gap:4px;flex-wrap:nowrap;overflow:hidden;margin-top:1px}
.ch,.eb,.mb{flex:none;font-size:11px;line-height:14px;padding:1px 6px;border-radius:999px;white-space:nowrap}
.ch{background:var(--line);color:var(--tx2)}.eb{background:var(--badbg);color:var(--badtx);font-weight:600}.mb{background:var(--hk-bg);color:var(--hk-tx);border:1px solid var(--hk-bd);overflow:hidden;text-overflow:ellipsis;flex:0 1 auto;min-width:0}
.nd .br{color:var(--mu);font-size:11px}
.nd .tb{display:flex;align-items:center;gap:6px}.nd .bar{flex:1;height:5px;border-radius:3px;background:var(--line);overflow:hidden}.nd .bar i{display:block;height:100%;background:var(--req)}.nd .tn{font-size:11px;color:var(--mu);font-variant-numeric:tabular-nums}
#panel table{width:100%;border-collapse:collapse;font-size:12px}#panel th{text-align:left;color:var(--mu);font-weight:500;padding:2px 4px}#panel td{padding:2px 4px;border-top:1px solid var(--line);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px}
#panel tr.er td{color:var(--badtx)}
#alerts{margin-top:14px;display:flex;flex-direction:column;gap:6px;max-height:210px;overflow-y:auto}#alerts[hidden]{display:none}
.al{display:flex;align-items:center;gap:6px 10px;flex-wrap:wrap;padding:6px 10px;border-radius:8px;border:1px solid var(--bd);font-size:13px}
.al.lv-warn{background:var(--warnbg);color:var(--warntx);border-color:var(--warntx)}.al.lv-bad{background:var(--badbg);color:var(--badtx);border-color:var(--bad)}
.al .ad{flex:none;width:8px;height:8px;border-radius:50%;background:currentColor}.al .at{flex:1 1 160px;min-width:0;overflow-wrap:anywhere}.al time{opacity:.8;font-size:12px;white-space:nowrap}
.al button{height:26px;padding:0 10px;font-size:12px;background:transparent;color:inherit;border-color:currentColor}
.al.nw{animation:alp 1.2s ease-out 1}@keyframes alp{0%{box-shadow:0 0 0 0 currentColor}60%{box-shadow:0 0 0 6px transparent}100%{box-shadow:none}}
#bell{height:auto;border:0;cursor:pointer;font-size:13px}#bell svg{flex:none}
.am{position:absolute;top:6px;right:6px;width:9px;height:9px;border-radius:50%;pointer-events:none}.am.warn{background:var(--rep)}.am.bad{background:var(--bad)}.am.st{position:static;display:inline-block;vertical-align:middle}
#vsw{display:inline-flex}#vsw button{border-radius:0;margin-left:-1px}#vsw button:first-child{border-radius:8px 0 0 8px;margin:0}#vsw button:last-child{border-radius:0 8px 8px 0}
#vsw button[aria-pressed=true],.rg button[aria-pressed=true],.pc[aria-pressed=true]{background:var(--hk-bg);border-color:var(--hk-bd);color:var(--hk-tx)}
#projs{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}#projs[hidden]{display:none}.pc{height:30px;padding:0 12px;border-radius:999px;font-size:12px}.pc b{font-weight:600}.pu{color:var(--mu)}
.pj{display:inline-block;font-size:10px;line-height:14px;padding:0 6px;border-radius:999px;background:var(--hk-bg);color:var(--hk-tx);border:1px solid var(--hk-bd);vertical-align:1px}
.pg{position:absolute;height:16px;font-size:11px;line-height:16px;color:var(--mu);letter-spacing:.04em;text-transform:uppercase;border-bottom:1px solid var(--line);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.rg{display:inline-flex;gap:4px;margin-left:auto}.rg button{height:24px;padding:0 8px;font-size:12px}
#scw{display:flex;align-items:center;gap:8px;padding:2px 10px 0 96px}#scr{flex:1;min-width:0;accent-color:var(--req)}#sct{font-size:12px;color:var(--mu);white-space:nowrap}#live{height:24px;padding:0 8px;font-size:12px}#live[hidden]{display:none}
#tl .rpm{stroke:var(--req);stroke-width:2}.fl.at{background:var(--line);outline:1px solid var(--req)}
#trends{display:none;margin-top:20px}body.tr #trends{display:block}body.tr #main,body.tr #bar,body.tr #projs{display:none}
.tcard{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:12px 14px;margin-bottom:16px;min-width:0}.tcard h2{font-size:13px;margin:0 0 8px;display:flex;gap:8px;justify-content:space-between;flex-wrap:wrap}.tcard h2 span,.mu{color:var(--mu);font-weight:400}
.tg2{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,380px),1fr));gap:16px}.tn0{color:var(--mu);font-size:14px}.chart{min-width:0;overflow:hidden}.chart svg{display:block;max-width:100%}
.chart .gl{stroke:var(--line);stroke-width:1}.chart .ax{fill:var(--mu);font-size:10px}.chart .rl{fill:var(--tx2);font-size:11px}
.bc{fill:var(--req)}.sl{stroke:var(--ok);stroke-width:2}.sp{fill:var(--ok)}.cl{stroke:var(--rep);stroke-width:2}.cp{fill:var(--rep)}
.chart rect:hover,.chart circle:hover,.chart rect:focus-visible,.chart circle:focus-visible{stroke:var(--tx);stroke-width:2;outline:none}
.lgd{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--tx2);margin-top:4px}.lgd i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px}
.tcard table{width:100%;border-collapse:collapse;font-size:12px}.tcard th{text-align:left;color:var(--mu);font-weight:500;padding:3px 4px}.tcard td{padding:3px 4px;border-top:1px solid var(--line)}
.lk{height:auto;padding:0 4px;border:0;background:none;color:var(--req);font-size:12px}
@media(prefers-reduced-motion:reduce){.pd{animation:none}.al.nw{animation:none}}
@media(max-width:999px){#feed{position:fixed;left:0;right:0;bottom:0;top:auto;width:auto;max-height:42vh;margin:0;border-radius:12px 12px 0 0;z-index:6;box-shadow:0 -8px 28px rgba(0,0,0,.3)}#main{display:block}}
@media(max-width:700px){#app{padding:16px 12px}h1{font-size:20px}#chips{width:100%}
#panel{top:auto;bottom:0;right:0;left:0;width:auto;max-height:60vh;border-radius:12px 12px 0 0}#q{max-width:none}}

"""
JS = r"""
(function(){
var SNAP=JSON.parse(document.getElementById('snap').textContent),EP=JSON.parse(document.getElementById('ep').textContent);
var KC={message:'--ok',report:'--rep',request:'--req',idle:'--idle',bad:'--bad'};
var pulses=[],P={},raf=0,ws=null,delay=1000,gotLive=false,stopped=false,fails=0,paused=false,pendingSnap=null,selId=null,rcv=Date.now(),lastChip=['',''],dirty=0;
var srvErr='',mode='',viol=[],codes=[],base=EP&&EP.port?'http://127.0.0.1:'+EP.port:'',tq=EP&&EP.token?'t='+encodeURIComponent(EP.token):'';
var ST={q:'',idle:0,err:0,feed:null,hide:[],proj:'',notif:0},SKEY='lean-agent-map-ui';
try{var _s=JSON.parse(localStorage.getItem(SKEY)||'{}');if(_s&&typeof _s==='object'){ST.q=String(_s.q||'').slice(0,80);ST.idle=_s.idle?1:0;ST.err=_s.err?1:0;
  ST.proj=String(_s.proj||'').slice(0,40);ST.notif=_s.notif?1:0;
  ST.feed=typeof _s.feed==='boolean'?_s.feed:null;ST.hide=Array.isArray(_s.hide)?_s.hide.filter(function(k){return KC[k]}):[]}}catch(e){}
function save(){try{localStorage.setItem(SKEY,JSON.stringify(ST))}catch(e){}}
var DKEY='lean-agent-map-dis',DIS={},SEEN={},NOTI={},ALV={},lastAl='',rng=600,RT=null,RP=[],RPK={},RPF={},view_='map',HIST=null,HISTT=0;
try{DIS=JSON.parse(sessionStorage.getItem(DKEY)||'{}')||{}}catch(e){DIS={}}
function saveDis(){try{sessionStorage.setItem(DKEY,JSON.stringify(DIS))}catch(e){}}
// state that must survive a reload of a file page (localStorage may be blocked there too) rides in location.hash
var HS={},isFile=location.protocol==='file:',sameOrigin=!!(EP&&EP.port&&String(location.port)===String(EP.port)&&/^(127\.0\.0\.1|localhost)$/.test(location.hostname));
try{String(location.hash||'').replace(/^#/,'').split('&').forEach(function(p){var i=p.indexOf('=');if(i>0)HS[p.slice(0,i)]=decodeURIComponent(p.slice(i+1))})}catch(e){}
if(HS.fr==='1'){if('q' in HS)ST.q=String(HS.q).slice(0,80);if('i' in HS)ST.idle=HS.i==='1'?1:0;if('e' in HS)ST.err=HS.e==='1'?1:0;if('f' in HS&&HS.f!=='')ST.feed=HS.f==='1';if('pj' in HS)ST.proj=String(HS.pj).slice(0,40);
  if('x' in HS)ST.hide=String(HS.x).split(',').filter(function(k){return KC[k]});if(HS.s)selId=HS.s}
function saveHash(ts,lf){var h=['fr=1','lt='+encodeURIComponent(ts),'lf='+lf,'q='+encodeURIComponent(ST.q),'i='+ST.idle,'e='+ST.err,'f='+(ST.feed===null?'':ST.feed?1:0),'x='+ST.hide.join(','),'y='+Math.round(window.pageYOffset||0),'pj='+encodeURIComponent(ST.proj)];
  if(selId)h.push('s='+encodeURIComponent(selId));try{history.replaceState(null,'','#'+h.join('&'))}catch(e){location.hash=h.join('&')}}
function $(i){return document.getElementById(i)}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function clip(s,n){s=String(s||'');return s.length>n?s.slice(0,n-1)+'…':s}
function dur(s){s=Math.max(0,Math.floor(s||0));return s<90?s+' s':s<5400?Math.round(s/60)+' min':Math.round(s/3600)+' h'}
function num(v){return typeof v==='number'&&isFinite(v)?v:null}
function fmtN(n){n=+n||0;return n>=1e6?(n/1e6).toFixed(1).replace(/\.0$/,'')+'M':n>=1e4?Math.round(n/1e3)+'k':n>=1e3?(n/1e3).toFixed(1).replace(/\.0$/,'')+'k':String(Math.round(n))}
function usd(v){return '$'+(+v||0).toFixed(2)}
function p2(n){return n<10?'0'+n:''+n}
function clock(ts){var d=new Date(ts*1000);return isNaN(d.getTime())?'':p2(d.getHours())+':'+p2(d.getMinutes())+':'+p2(d.getSeconds())}
function act(n){var a=n&&n.activity;return a&&typeof a==='object'?a:null}
function paint(){var e=$('chip'),pl=$('pill');
  if(paused){e.textContent='paused';pl.className='pill paused'}else{e.textContent=lastChip[0];pl.className='pill '+(lastChip[1]==='live'?'':lastChip[1])}}
function chip(t,c){lastChip=[t,c||''];paint()}
function why(h){$('why').innerHTML=h||''}
function reason(){var p=[];if(viol.length)p.push('blocked by the preview: '+viol.map(esc).join(', '));if(codes.length)p.push(codes.map(esc).join(', '));return p.join(' · ')}
document.addEventListener('securitypolicyviolation',function(e){
  var u=String(e.blockedURI||'').split('?')[0];viol.push((e.violatedDirective||'?')+(u?' ('+u+')':''));if(viol.length>6)viol.shift();
  if(!mode)why(reason())});
function placedSet(s){var o={};(Array.isArray(s.placed)?s.placed:[]).forEach(function(i){o[i]=1});return o}
// ---- filters
function isIdle(n){var a=act(n);if(a&&a.now&&a.now.tool)return false;return n.state==='idle'||n.state==='parked'||n.state==='orphaned'}
function hasErr(n){var a=act(n);return n.state==='undelivered'||n.state==='dead'||!!(a&&a.errors>0)}
function hay(n){var a=act(n),h=[n.id,n.label,n.kind,n.state,n.detail,n.model];
  if(a){if(a.now)h.push(a.now.tool,a.now.target);(Array.isArray(a.top)?a.top:[]).forEach(function(t){h.push(t&&t[0])});
    (Array.isArray(a.recent)?a.recent:[]).forEach(function(r){h.push(r&&r.tool,r&&r.target)});(Array.isArray(a.mcp)?a.mcp:[]).forEach(function(m){h.push(m)})}
  return h.join(' ').toLowerCase()}
function passes(n){if(ST.proj&&n.project!==ST.proj)return false;if(ST.idle&&isIdle(n))return false;if(ST.err&&!hasErr(n))return false;if(ST.q&&hay(n).indexOf(ST.q.toLowerCase())<0)return false;return true}
function view(s){
  var ns=s.nodes||[],ok=placedSet(s),byid={},keep={},all=0,kept=0;ns.forEach(function(n){byid[n.id]=n});
  var filt=!!(ST.idle||ST.err||ST.q||ST.proj);
  ns.forEach(function(n){if(!ok[n.id]||n.kind!=='worker')return;if(passes(n)){keep[n.id]=1;var pa=n.parent;if(pa&&ok[pa]&&byid[pa]&&byid[pa].kind==='thread')keep[pa]=1}});
  ns.forEach(function(n){if(!ok[n.id]||n.kind!=='thread')return;if(passes(n))keep[n.id]=1});
  var pl=(Array.isArray(s.placed)?s.placed:[]).filter(function(i){var n=byid[i];if(!n)return false;all++;var k=filt?(n.kind!=='thread'&&n.kind!=='worker'?true:!!keep[i]):true;if(k)kept++;return k});
  var o={};for(var k in s)o[k]=s[k];o.placed=pl;o._hidden=all-kept;return o}
// ---- layout (stage coordinates; the stage is scaled to the window)
function dims(wide){return wide?{W:1040,dw:216,dh:112,sw:216,sh:96,tw:232,th:100,ww:292,wh:96,hw:192,hh:72,xd:0,xs:248,xt:500,xw:748,hy:150,nr:0}
  :{W:520,dw:100,dh:112,sw:124,sh:96,tw:140,th:112,ww:124,wh:104,hw:124,hh:60,xd:0,xs:112,xt:248,xw:396,hy:140,nr:1}}
function layout(s,D){
  var ns=s.nodes||[],ok=placedSet(s),byid={},p={};ns.forEach(function(n){byid[n.id]=n});
  var th=ns.filter(function(n){return n.kind==='thread'&&ok[n.id]});
  var G=grouped(),pidx={},gx=[],gl=[];projs().forEach(function(x,i){pidx[x.slug]=i});
  th.sort(function(a,b){var d=G?((pidx[a.project]!=null?pidx[a.project]:99)-(pidx[b.project]!=null?pidx[b.project]:99)):0;return d||a.id.length-b.id.length||(a.id<b.id?-1:a.id>b.id?1:0)});
  var wk={};ns.forEach(function(n){if(n.kind!=='worker'||!ok[n.id])return;
    var k=(n.parent&&byid[n.parent]&&byid[n.parent].kind==='thread'&&ok[n.parent])?n.parent:'main';(wk[k]=wk[k]||[]).push(n)});
  var slots=th.map(function(t){return Math.max(D.th+16,Math.min(3,(wk[t.id]||[]).length)*(D.wh+6))});
  th.forEach(function(t,i){if(G&&(i===0||th[i-1].project!==t.project)){slots[i]+=18;gx[i]=18}});
  var nm=Math.min(3,(wk.main||[]).length);
  var tot=slots.reduce(function(a,b){return a+b},0),H=Math.max(tot+20,560,D.dh+40+2*nm*(D.wh+6)),y=(H-tot)/2,cy=H/2;
  th.forEach(function(t,i){var c=y+(gx[i]||0)+(slots[i]-(gx[i]||0))/2;if(gx[i])gl.push({label:t.project||'other',y:y+1});p[t.id]={cx:D.xt+D.tw/2,cy:c,w:D.tw,h:D.th};
    (wk[t.id]||[]).slice(0,3).forEach(function(w,j,a){p[w.id]={cx:D.xw+D.ww/2,cy:c+(j-(a.length-1)/2)*(D.wh+6),w:D.ww,h:D.wh}});y+=slots[i]});
  if(byid.main)p.main={cx:D.xd+D.dw/2,cy:cy,w:D.dw,h:D.dh};
  if(byid.service)p.service={cx:D.xs+D.sw/2,cy:cy,w:D.sw,h:D.sh};
  if(byid.hooks)p.hooks={cx:D.xs+D.sw/2,cy:cy+D.hy,w:D.hw,h:D.hh};
  (wk.main||[]).slice(0,3).forEach(function(w,j){p[w.id]={cx:D.xd+D.dw/2,cy:cy+D.dh/2+20+D.wh/2+j*(D.wh+6),w:D.dw,h:D.wh}});
  return {p:p,H:H,th:th,gl:gl}}
// where the ray from the point (px,py) heading (dx,dy) leaves the card rect c (the point lies inside it)
function exitPt(c,dx,dy,px,py){var tx=dx?((dx>0?1:-1)*c.w/2-(px-c.cx))/dx:1e9,ty=dy?((dy>0?1:-1)*c.h/2-(py-c.cy))/dy:1e9,t=Math.max(0,Math.min(tx,ty));return[px+dx*t,py+dy*t]}
// ---- node cards
var DOT=function(f,c,r){return '<svg class="i" aria-hidden="true" width="'+r*2+'" height="'+r*2+'" viewBox="0 0 '+r*2+' '+r*2+'"><circle cx="'+r+'" cy="'+r+'" r="'+(f?r:r-1)+'" '+(f?'fill="var('+c+')"':'fill="none" stroke="var('+c+')" stroke-width="2"')+'/></svg>'};
function stline(n){var st=String(n.state||''),d=String(n.detail||'');return !d||d===st?st:d.indexOf(st)===0?d:st+' · '+d}
function nowText(a){if(!a||!a.now||!a.now.tool)return '';var sec=Math.floor((num(a.now.since_s)||0)+(RT!=null?0:(Date.now()-rcv)/1000));return a.now.tool+(a.now.target?' · '+a.now.target:'')+' · '+Math.max(0,sec)+' s'}
function actHtml(n,nr){var a=act(n);if(!a)return '';var o=[],nt=nowText(a);
  if(nt)o.push('<span class="now"><i class="pd"></i><span>'+esc(nt)+'</span></span>');
  var c=[];(Array.isArray(a.top)?a.top:[]).slice(0,nr?2:4).forEach(function(t){if(Array.isArray(t)&&t[0]!=null)c.push('<span class="ch">'+esc(t[0]+' '+(t[1]==null?'':t[1]))+'</span>')});
  if(num(a.errors)>0)c.push('<span class="eb" title="'+esc(a.errors+' failed tool call(s) in the last 30 min')+'">'+esc(a.errors)+(nr?'':' err')+'</span>');
  if(Array.isArray(a.mcp)&&a.mcp.length)c.push('<span class="mb" title="'+esc('MCP servers: '+a.mcp.join(', '))+'">MCP '+esc(a.mcp.join(', '))+'</span>');
  if(c.length)o.push('<span class="chs">'+c.join('')+'</span>');
  return o.join('')}
function tipOf(n){var a=act(n),t=[(n.label||n.id)+' ('+n.kind+')',stline(n)],s=n.stats;
  if(a){var nt=nowText(a);if(nt)t.push('now: '+nt);if(Array.isArray(a.top)&&a.top.length)t.push('tools: '+a.top.map(function(x){return x&&x[0]+' '+x[1]}).join(', '));
    if(num(a.errors)>0)t.push(a.errors+' errors (30 min)');if(num(a.files)!=null)t.push(a.files+' files (30 min)');if(Array.isArray(a.mcp)&&a.mcp.length)t.push('MCP: '+a.mcp.join(', '))}
  if(s&&typeof s==='object'){var q=[];if(s.model)q.push(s.model);if(num(s.usd)!=null)q.push(usd(s.usd));if(num(s.tokens)!=null)q.push(fmtN(s.tokens)+' tokens');if(num(s.turns)!=null)q.push('turn '+s.turns+(s.max_turns?'/'+s.max_turns:''));if(s.branch)q.push('branch '+s.branch);t.push(q.join(' · '))}
  return t.join('\n')}
function cardHtml(n,c,s){
  var st=n.state,cls='',inner='',nr=!!c.nr;
  var live=st==='active'||st==='alive',bad=st==='undelivered'||st==='dead',dash=st==='idle'||st==='parked'||st==='orphaned';
  if(n.kind==='service'){var sv=s.service||{};cls='svc';
    inner='<svg class="i" aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--ok)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg><span class="tx"><b class="t">Service socket</b><span>service.sock · '+esc(sv.socket_ms!=null?sv.socket_ms:'–')+' ms</span><span>'+esc((sv.threads|0)+' threads · up '+dur(sv.up_s))+'</span></span>'}
  else if(n.kind==='desk'){inner=DOT(1,live||st==='active'?'--ok':'--idle',5)+'<span class="tx"><b class="t">Front desk</b><span>'+esc('main · '+(n.detail||st))+'</span>'+actHtml(n,nr)+'</span>'}
  else if(n.kind==='hooks'){cls='hk';inner='<svg class="i" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--req)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v6a3 3 0 0 0 6 0V3"/><path d="M12 12v9"/></svg><span class="tx"><b style="font-size:14px">Hooks</b><span>tool calls · '+esc(n.per_min!=null?n.per_min:parseInt(n.detail,10)||0)+' a min</span></span>'}
  else if(n.kind==='thread'){cls=bad?'bad':live?'live':dash?'dash':'';
    inner=DOT(live||bad||st==='active'?1:st==='done'?1:0,bad?'--bad':live?'--ok':st==='done'?'--rep':'--idle',5)+'<span class="tx"><span><b class="mono">'+esc(n.id)+'</b>'+(grouped()&&n.project?' <span class="pj">'+esc(n.project)+'</span>':'')+' '+esc(clip(n.label===n.id?'':n.label,nr?18:30))+'</span><span class="sl">'+esc(stline(n))+'</span>'+actHtml(n,nr)+'</span>'}
  else{cls='wk '+(bad?'bad':live?'live':dash?'dash':'');var t=n.stats&&typeof n.stats==='object'?n.stats:null,l2,bar='';
    if(t){var m=[st==='done'?'done':st];if(t.model||n.model)m.push(t.model||n.model);if(num(t.usd)!=null)m.push(usd(t.usd));if(num(t.tokens)!=null)m.push(fmtN(t.tokens)+' tok');l2=m.join(' · ');
      if(num(t.turns)!=null){var mx=num(t.max_turns),pc=mx>0?Math.max(2,Math.min(100,t.turns/mx*100)):0;
        bar='<span class="tb" title="'+esc('turn '+t.turns+(mx?' of '+mx:''))+'"><span class="bar"><i style="width:'+pc.toFixed(0)+'%"></i></span><span class="tn">'+esc(t.turns+(mx?'/'+mx:''))+'</span></span>'}}
    else l2=(n.model||'worker')+' · '+dur(n.age_s)+' · '+(st==='done'?'result ready':st+(n.progress_s!=null&&live?' · '+dur(n.progress_s)+' ago':''));
    inner='<span class="tx"><span><b class="mono">'+esc(n.label)+'</b>'+(t&&t.branch&&!nr?' <span class="br mono">'+esc(clip(t.branch,24))+'</span>':'')+'</span><span class="sl">'+esc(l2)+'</span>'+bar+actHtml(n,nr)+'</span>'}
  return '<div class="nd '+cls+(selId===n.id?' sel':'')+'" tabindex="0" role="button" data-id="'+esc(n.id)+'" title="'+esc(tipOf(n))+'" aria-label="'+esc(n.kind+' '+(n.label||n.id)+', '+stline(n))+'" style="left:'+(c.cx-c.w/2)+'px;top:'+(c.cy-c.h/2)+'px;width:'+c.w+'px;height:'+c.h+'px">'+inner+(ALV[n.id]?'<i class="am '+ALV[n.id]+'" title="'+esc(ALV[n.id]+' alert')+'"></i>':'')+'</div>'}
// ---- edges (each runs from the border of one card to the border of the other)
function edgeSvg(s,p,W,H){
  var o=['<svg class="edges" width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'" aria-hidden="true"><defs>'];
  Object.keys(KC).forEach(function(k){o.push('<marker id="a-'+k+'" orient="auto" markerWidth="6" markerHeight="6" refX="4" refY="2" overflow="visible"><path d="M0 0L4 2L0 4z" style="fill:var('+KC[k]+')"/></marker>')});
  o.push('</defs>');
  var groups={},list=[];
  (s.edges||[]).forEach(function(e){if(!p[e.from]||!p[e.to])return;var kd=e.bad?'bad':KC[e.kind]?e.kind:'idle';if(ST.hide.indexOf(kd)>=0)return;e._k=kd;var k=[e.from,e.to].sort().join('|');(groups[k]=groups[k]||[]).push(e);list.push(e)});
  var nIdle=list.filter(function(e){return e.kind==='idle'&&!e.bad}).length;
  Object.keys(groups).forEach(function(k){var g=groups[k];g.forEach(function(e,i){
    var a=p[e.from],b=p[e.to],dx=b.cx-a.cx,dy=b.cy-a.cy,off=(i-(g.length-1)/2)*16,ids=[e.from,e.to].sort(),c0=p[ids[0]],c1=p[ids[1]],cx=c1.cx-c0.cx,cy=c1.cy-c0.cy,CL=Math.sqrt(cx*cx+cy*cy)||1,ox=-cy/CL*off,oy=cx/CL*off;
    var q1=exitPt(a,dx,dy,a.cx+ox,a.cy+oy),q2=exitPt(b,-dx,-dy,b.cx+ox,b.cy+oy);
    var kd=e._k,idle=kd==='idle',age=(e.age_s||0),col='var('+KC[kd]+')';
    o.push('<line data-age="'+age+'" data-idle="'+(idle?1:0)+'" data-from="'+esc(e.from)+'" data-to="'+esc(e.to)+'" x1="'+q1[0].toFixed(1)+'" y1="'+q1[1].toFixed(1)+'" x2="'+q2[0].toFixed(1)+'" y2="'+q2[1].toFixed(1)+'" stroke-width="'+(idle?1.5:2)+'" stroke-linecap="round" style="stroke:'+col+'"'+(idle?' stroke-dasharray="6 6" opacity=".6"':' marker-end="url(#a-'+kd+')" opacity="'+Math.max(.3,1-.7*Math.min(age,30)/30).toFixed(2)+'"')+'/>');
    if(e.label&&(!idle||nIdle<=4))o.push('<text class="elabel" x="'+((q1[0]+q2[0])/2).toFixed(1)+'" y="'+((q1[1]+q2[1])/2-6).toFixed(1)+'" text-anchor="middle" style="fill:'+(idle?'var(--mu)':kd==='request'?'var(--reqtx)':col)+'">'+esc(clip(e.label,28))+'</text>')})});
  o.push('<g id="pl"></g></svg>');return o.join('')}
// ---- render (batched: snapshots only mark the page dirty, one pass runs per animation frame)
function schedule(){if(dirty)return;dirty=1;var f=function(){dirty=0;render()};if(typeof requestAnimationFrame==='function')requestAnimationFrame(f);else setTimeout(f,16)}
function render(){
  var s0=SNAP,wrap=$('wrap');rcv=Date.now();chips(s0);alertBar();projBar();feedPanel();syncUi();
  var cw=wrap.clientWidth||600,wide=cw>=700,D=dims(wide),sc=Math.min(cw/D.W,wide?1:1.6);
  if(!s0.service||!s0.service.up||!(s0.nodes||[]).length){
    wrap.style.height='120px';wrap.innerHTML='<div style="padding:40px 0;text-align:center;color:var(--mu);font-size:15px">Service not running · inbox '+(s0.inbox|0)+'</div>';P={};timeline(s0);return}
  var sv=view(s0),s=RT!=null?replayView(sv):sv,act0=document.activeElement,keep=act0&&act0.getAttribute&&act0.getAttribute('data-id'),L=layout(s,D),byid={};
  (s.nodes||[]).forEach(function(n){byid[n.id]=n});P=L.p;
  var h=[edgeSvg(s,L.p,D.W,L.H)];
  Object.keys(L.p).forEach(function(id){if(byid[id]){var c=L.p[id];c.nr=D.nr;h.push(cardHtml(byid[id],c,s))}});
  (L.gl||[]).forEach(function(g){h.push('<div class="pg" data-proj="'+esc(g.label)+'" style="left:'+D.xt+'px;top:'+g.y+'px;width:'+D.tw+'px">'+esc(g.label)+'</div>')});
  var more=(s.more|0);
  if(more>0)h.push('<div id="more" style="left:'+(D.xt)+'px;top:'+(L.H-18)+'px;width:'+D.tw+'px;text-align:center">+'+more+' more</div>');
  wrap.style.height=Math.ceil((L.H)*sc)+'px';
  wrap.innerHTML='<div id="stage" class="'+(D.nr?'nr':'')+'" style="width:'+D.W+'px;height:'+L.H+'px;transform:scale('+sc+')">'+h.join('')+'</div>';
  $('fc').textContent=s._hidden>0?s._hidden+' hidden by filters':'';
  if(keep){var el=wrap.querySelector('[data-id="'+keep.replace(/"/g,'')+'"]');if(el)try{el.focus({preventScroll:true})}catch(e){}}
  timeline(sv);
  if(selId)fillPanel()}
function chips(s){var sv=s.service||{},w=0;(s.nodes||[]).forEach(function(n){if(n.kind==='worker'&&(n.state==='alive'||n.state==='orphaned'))w++});
  $('sub').textContent='lean-agent'+(sv.version?' '+sv.version:'')+' · service socket · updates as messages move';
  $('ms').textContent=sv.socket_ms!=null&&sv.up?' · '+sv.socket_ms+' ms':'';
  $('cpu').textContent='Service CPU '+(sv.cpu_pct!=null?Math.round(sv.cpu_pct):'–')+'%';
  $('wk').textContent=w+(w===1?' worker':' workers');
  var ib=$('inbox');ib.textContent='Inbox '+(s.inbox|0);ib.className='pill'+((s.inbox|0)>0?' warn':'');
  var t=s.totals&&typeof s.totals==='object'?s.totals:{};
  function pill(id,v,txt,tip,cls){var e=$(id);if(v==null){e.hidden=true;return}e.hidden=false;e.textContent=txt;e.title=tip||'';e.className='pill'+(cls?' '+cls:'')}
  pill('runs',num(t.runs_today),num(t.runs_today)+(t.runs_today===1?' run today':' runs today'));
  pill('usd',num(t.usd_today),usd(t.usd_today)+' today',num(t.tokens_today)!=null?fmtN(t.tokens_today)+' tokens today':'');
  pill('saved',num(t.saved_today),'saved ~'+fmtN(t.saved_today)+' tokens today','Tokens lean-agent kept out of the model context today','good');
  pill('tpm',num(t.tools_per_min),(+t.tools_per_min).toFixed(t.tools_per_min>=10?0:1)+' tools/min');
  pill('errs',num(t.errors_30m)>0?t.errors_30m:null,t.errors_30m+(t.errors_30m===1?' error':' errors')+' (30 min)','Failed tool calls in the last 30 minutes','bad')}
function syncUi(){
  var q=$('q');if(q.value!==ST.q&&document.activeElement!==q)q.value=ST.q;
  [['fidle','idle'],['ferr','err']].forEach(function(x){var b=$(x[0]);b.setAttribute('aria-pressed',ST[x[1]]?'true':'false')});
  var ls=document.querySelectorAll('#legend .lg');for(var i=0;i<ls.length;i++)ls[i].setAttribute('aria-pressed',ST.hide.indexOf(ls[i].getAttribute('data-k'))>=0?'false':'true');
  var fo=feedOpen();$('main').className=fo?'fo':'';$('ftog').setAttribute('aria-pressed',fo?'true':'false');
  var n=Array.isArray(SNAP.feed)?SNAP.feed.length:0;$('ftog').textContent='Activity'+(n?' '+n:'')}
function feedOpen(){return ST.feed===null?(window.innerWidth||1280)>=1200:!!ST.feed}
// ---- activity feed
function feedPanel(){
  var f=Array.isArray(SNAP.feed)?SNAP.feed.slice(0,30):[],o=[];
  f.forEach(function(x){if(!x||typeof x!=='object')return;var k=/^(tool|message|run|error)$/.test(x.kind)?x.kind:'tool';
    o.push('<li><button type="button" class="fl k-'+k+'" data-node="'+esc(x.node)+'" data-ts="'+esc(x.ts)+'" title="'+esc(clock(x.ts)+' '+x.node+' '+x.text)+'"><time>'+esc(clock(x.ts))+'</time><b class="mono">'+esc(x.node)+'</b><em>'+k+'</em><span>'+esc(x.text)+'</span></button></li>')});
  $('fl').innerHTML=o.length?o.join(''):'<li class="empty">No tool activity yet</li>';feedAt()}
function feedAt(){if(RT==null)return;var b=$('fl').querySelectorAll('button[data-ts]'),hit=null;
  for(var i=0;i<b.length;i++){if(+b[i].getAttribute('data-ts')<=RT){hit=b[i];break}}
  if(hit){hit.classList.add('at');var fl=$('fl');fl.scrollTop+=hit.getBoundingClientRect().top-fl.getBoundingClientRect().top}}
// ---- timeline: the last 10 minutes, one row per placed node, one tick per tool event (a single SVG)
var TLW=600,tlev=[];
function rpAdd(e){if(!e||num(e.ts)==null)return;var k=(e.node||'')+'|'+e.ts+'|'+(e.tool||'')+'|'+(e.from||'')+'|'+(e.to||'')+'|'+(e.op||'');if(RPK[k])return;RPK[k]=1;
  RP.push({ts:+e.ts,from:e.from||null,to:e.to||null,op:String(e.op||''),node:e.node||null,tool:e.tool||null,target:e.target==null?null:String(e.target),ok:e.ok!==false});
  if(RP.length>5000){var o=RP.shift();delete RPK[(o.node||'')+'|'+o.ts+'|'+(o.tool||'')+'|'+(o.from||'')+'|'+(o.to||'')+'|'+(o.op||'')]}}
function rpSnap(d){(d.nodes||[]).forEach(function(n){var a=act(n);if(a&&Array.isArray(a.recent))a.recent.forEach(function(r){if(r&&num(r.ts)!=null)rpAdd({ts:r.ts,op:'tool',node:n.id,tool:r.tool,target:r.target,ok:r.ok})})})}
function canFetch(){return typeof fetch==='function'&&!!base&&!isFile&&mode!=='refresh'&&mode!=='none'&&mode!=='img'}
function fetchReplay(){if(!canFetch())return;var r=rng;RPF[r]=1;
  fetch(base+'/replay?'+tq+'&since='+Math.floor(Date.now()/1000-r),{cache:'no-store'}).then(function(x){return x.ok?x.json():{events:[]}}).then(function(d){
    (d&&Array.isArray(d.events)?d.events:[]).forEach(rpAdd);if(RT!=null)schedule();else timelineNow()}).catch(function(){RPF[r]=0})}
function timelineNow(){if(!paused)schedule()}
function replayView(s){var T=RT,ed=[],nw={},pair={};
  RP.forEach(function(e){if(e.ts>T||T-e.ts>30)return;
    if(e.node&&e.tool){if(!nw[e.node]||e.ts>nw[e.node].ts)nw[e.node]={ts:e.ts,tool:e.tool,target:e.target||''}}
    else if(e.from&&e.to){pair[[e.from,e.to].sort().join('|')]=1;ed.push({from:e.from,to:e.to,kind:/^(send|wake|deliver)$/.test(e.op)?'message':'request',label:e.op,age_s:T-e.ts})}
    });
  var o={};for(var k in s)o[k]=s[k];
  o.edges=(s.edges||[]).filter(function(e){return e.kind==='idle'&&!e.bad&&!pair[[e.from,e.to].sort().join('|')]}).concat(ed);
  o.nodes=(s.nodes||[]).map(function(n){var c={};for(var k in n)c[k]=n[k];var x=nw[n.id];
    c.activity={now:x?{tool:x.tool,target:x.target,since_s:T-x.ts}:null,top:[],errors:0,mcp:[],recent:[]};return c});
  return o}
function evOf(n){var seen={},o=[],a=act(n);
  function add(e){var k=e.tool+'|'+Math.round(e.ts/2);if(seen[k]||seen[e.tool+'|'+(Math.round(e.ts/2)-1)]||seen[e.tool+'|'+(Math.round(e.ts/2)+1)])return;seen[k]=1;o.push(e)}
  if(a&&Array.isArray(a.recent))a.recent.forEach(function(r){if(r&&num(r.ts)!=null)add(r)});
  RP.forEach(function(e){if(e.node===n.id&&e.tool)add(e)});
  return o}
function timeline(s){
  $('tlw').hidden=false;var host=$('tl'),rows=[],ids=Object.keys(P).filter(function(i){return i!=='service'&&i!=='hooks'}),byid={},mx=0,RS=rng;
  (s.nodes||[]).forEach(function(n){byid[n.id]=n});
  ids.sort(function(a,b){return (a==='main'?-1:0)-(b==='main'?-1:0)});
  ids.forEach(function(i){var n=byid[i];if(!n)return;rows.push(n);var a=act(n);if(a&&Array.isArray(a.recent))a.recent.forEach(function(r){if(r&&num(r.ts)!=null&&num(r.ts)>mx)mx=r.ts})});
  var now=Date.now()/1000;if(mx&&now-mx>RS&&!RP.length)now=mx+5;
  var W=Math.max(280,host.clientWidth||TLW),L=96,RW=W-L-10,RH=16,H=rows.length*RH+20,o=['<svg width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'" role="group" aria-label="Tool events in the last '+(RS/60)+' minutes, one row per node">'],cnt=0,step=RS/60>=30?10:2;
  for(var m=0;m<=RS/60;m+=step){var x=L+RW-m*60/RS*RW;o.push('<line x1="'+x.toFixed(1)+'" y1="14" x2="'+x.toFixed(1)+'" y2="'+H+'" class="gl"/>');
    if(m%(RS/120)===0||W>520)o.push('<text x="'+x.toFixed(1)+'" y="10" text-anchor="'+(m===0?'end':m===RS/60?'start':'middle')+'" class="ax">'+(m===0?'now':'-'+m+' min')+'</text>')}
  rows.forEach(function(n,r){var y=20+r*RH;
    o.push('<text x="'+(L-6)+'" y="'+(y+9)+'" text-anchor="end" class="rl" data-node="'+esc(n.id)+'">'+esc(clip(n.kind==='desk'?'desk':n.kind==='worker'?(n.label||n.id):n.id,12))+'<title>'+esc(n.label||n.id)+'</title></text>');
    evOf(n).slice(0,RS>600?150:20).forEach(function(e){var age=now-e.ts;if(age<0||age>RS)return;cnt++;
      var x=L+RW-age/RS*RW,tip=clock(e.ts)+' '+(n.label||n.id)+' · '+e.tool+(e.target?' · '+e.target:'')+(e.ok===false?' · failed':' · ok')+(num(e.ms)!=null?' · '+e.ms+' ms':'');
      o.push('<rect class="tk '+(e.ok===false?'er':'ok')+'" x="'+(x-1.5).toFixed(1)+'" y="'+(y+1)+'" width="3" height="11" rx="1" tabindex="0" data-node="'+esc(n.id)+'" data-tip="'+esc(tip)+'" aria-label="'+esc(tip)+'"/>')})});
  if(RT!=null&&now-RT>=0&&now-RT<=RS){var rx=L+RW-(now-RT)/RS*RW;o.push('<line class="rpm" x1="'+rx.toFixed(1)+'" y1="12" x2="'+rx.toFixed(1)+'" y2="'+H+'"/>')}
  o.push('</svg>');
  host.innerHTML=rows.length?o.join(''):'';$('tlw').hidden=!rows.length;
  $('tlc').textContent=RT!=null?'replay at '+clock(RT):cnt?cnt+' events':'no tool events in the last '+(RS/60)+' minutes';
  $('tlh').textContent='Last '+(RS/60)+' minutes';$('live').hidden=RT==null;
  $('r10').setAttribute('aria-pressed',RS===600?'true':'false');$('r60').setAttribute('aria-pressed',RS===600?'false':'true')}
function scrub(){var v=+$('scr').value;RT=v>=-1?null:Date.now()/1000+v;
  $('sct').textContent=RT==null?'live':Math.round(-v)+' s ago · '+clock(RT);
  if(!RPF[rng])fetchReplay();schedule()}
function setRange(r){if(r===rng)return;rng=r;var sc=$('scr');sc.min=-r;sc.value=0;RT=null;$('sct').textContent='live';RPF[r]=0;fetchReplay();schedule()}
$('scr').addEventListener('input',scrub);
$('live').addEventListener('click',function(){$('scr').value=0;scrub()});
$('r10').addEventListener('click',function(){setRange(600)});$('r60').addEventListener('click',function(){setRange(3600)});
function showTip(t){var tp=$('tip');if(!t){tp.className='';return}tp.textContent=t.getAttribute('data-tip');tp.className='on';
  var r=t.getBoundingClientRect(),w=tp.offsetWidth;tp.style.left=Math.max(4,Math.min(window.innerWidth-w-4,r.left+r.width/2-w/2))+'px';tp.style.top=(r.top-tp.offsetHeight-6)+'px'}
function tipT(e){var t=e.target&&e.target.closest?e.target.closest('[data-tip]'):null;showTip(t&&t.classList&&(t.classList.contains('tk')||$('trends').contains(t))?t:null)}
$('trends').addEventListener('mouseover',tipT);$('trends').addEventListener('focusin',tipT);$('trends').addEventListener('mouseout',function(){showTip(null)});$('trends').addEventListener('focusout',function(){showTip(null)});
$('tl').addEventListener('mouseover',function(e){showTip(e.target.classList&&e.target.classList.contains('tk')?e.target:null)});
$('tl').addEventListener('mouseout',function(){showTip(null)});
$('tl').addEventListener('focusin',function(e){showTip(e.target.classList&&e.target.classList.contains('tk')?e.target:null)});
$('tl').addEventListener('focusout',function(){showTip(null)});
$('tl').addEventListener('click',function(e){var t=e.target.closest&&e.target.closest('[data-node]');if(t)openPanel(t.getAttribute('data-node'))});
// ---- details panel
function fillPanel(){
  var s=SNAP,n=null;(s.nodes||[]).forEach(function(x){if(x.id===selId)n=x});
  if(!n){closePanel();return}
  var r=[],a=act(n),st=n.stats&&typeof n.stats==='object'?n.stats:null;
  function row(k,v){if(v==null||v==='')return;r.push('<dt>'+esc(k)+'</dt><dd>'+esc(v)+'</dd>')}
  row('Kind',n.kind);row('Id',n.id);row('Label',n.label);row('State',n.state);row('Detail',n.detail);
  if(n.parent)row('Parent thread',n.parent);if(n.model)row('Model',n.model);
  if(n.age_s!=null&&n.kind==='worker')row('Running for',dur(n.age_s));if(n.progress_s!=null)row('Last progress',dur(n.progress_s)+' ago');
  if(n.ended_s!=null)row('Ended',dur(n.ended_s)+' ago');if(n.kind==='thread'){row('Quiet for',dur(n.idle_s));row('Mid-turn',n.mid?'yes':'no')}
  if(n.per_min!=null)row('Tool calls a min',n.per_min);
  if(st){row('Worker model',st.model);if(num(st.turns)!=null)row('Turns',st.turns+(st.max_turns?' of '+st.max_turns:''));if(num(st.tokens)!=null)row('Tokens',fmtN(st.tokens)+' ('+st.tokens+')');
    if(num(st.usd)!=null)row('Cost',usd(st.usd));if(num(st.context)!=null)row('Context',fmtN(st.context)+' tokens');row('Branch',st.branch);if(num(st.elapsed_s)!=null)row('Elapsed',dur(st.elapsed_s))}
  if(a){if(num(a.files)!=null)row('Files touched (30 min)',a.files);if(num(a.errors)!=null)row('Failed calls (30 min)',a.errors);
    if(Array.isArray(a.mcp)&&a.mcp.length)row('MCP servers',a.mcp.join(', '));
    if(Array.isArray(a.top)&&a.top.length)row('Top tools',a.top.map(function(t){return t&&t[0]+' '+t[1]}).join(', '));
    var nt=nowText(a);if(nt)row('In progress',nt)}
  if(n.kind==='service'){var sv=s.service||{};row('Version',sv.version);row('Process',sv.pid);row('CPU',sv.cpu_pct!=null?sv.cpu_pct+' %':'');row('Socket latency',sv.socket_ms!=null?sv.socket_ms+' ms':'');row('Threads',sv.threads);row('Up',dur(sv.up_s))}
  if(n.kind==='desk'){row('Inbox',s.inbox|0);row('Paused',s.paused?'yes':'no')}
  var el=[],now=(Date.now()-rcv)/1000;
  (s.edges||[]).forEach(function(e){if(e.from!==n.id&&e.to!==n.id)return;
    el.push('<li>'+esc((e.from===n.id?'to ':'from ')+(e.from===n.id?e.to:e.from)+' · '+e.kind+(e.label?' · '+e.label:'')+' · '+dur((e.age_s||0)+now)+' ago'+(e.bad?' · stuck':''))+'</li>')});
  var ml=[];(s.moving||[]).forEach(function(m){if(m.node===n.id)ml.push('<li>'+esc(m.text+' · '+dur((m.age_s||0)+now)+' ago')+'</li>')});
  var rc=a&&Array.isArray(a.recent)?a.recent.slice(0,20):[],tb='';
  if(rc.length)tb='<h3>Recent tool calls</h3><table id="rt"><thead><tr><th>Time</th><th>Tool</th><th>Target</th><th>ms</th><th>OK</th></tr></thead><tbody>'+rc.map(function(e){
    return '<tr class="'+(e.ok===false?'er':'')+'"><td>'+esc(clock(e.ts))+'</td><td>'+esc(e.tool)+'</td><td title="'+esc(e.target)+'">'+esc(clip(e.target,22))+'</td><td>'+esc(num(e.ms)!=null?e.ms:'')+'</td><td>'+(e.ok===false?'✗ failed':'✓')+'</td></tr>'}).join('')+'</tbody></table>';
  var fl=[];(Array.isArray(s.feed)?s.feed:[]).forEach(function(x){if(x&&x.node===n.id)fl.push('<li>'+esc(clock(x.ts)+' · '+x.text)+'</li>')});
  var pn=$('panel');
  pn.innerHTML='<button type="button" class="x" id="px" aria-label="Close details">Close</button><h2>'+esc(n.label||n.id)+'</h2><dl>'+r.join('')+'</dl>'+tb
    +'<h3>Lines</h3>'+(el.length?'<ul>'+el.join('')+'</ul>':'<div style="color:var(--mu)">none</div>')
    +(ml.length?'<h3>Recent messages</h3><ul>'+ml.join('')+'</ul>':'')
    +(fl.length?'<h3>Feed</h3><ul id="pfeed">'+fl.slice(0,12).join('')+'</ul>':'');
  pn.className='open';pn.setAttribute('aria-label','Details of '+(n.label||n.id));$('px').onclick=closePanel}
function openPanel(id){selId=id;fillPanel();var m=$('wrap').querySelectorAll('.nd');for(var i=0;i<m.length;i++)m[i].classList.toggle('sel',m[i].getAttribute('data-id')===id);var x=$('px');if(x)x.focus()}
function closePanel(){var id=selId;selId=null;$('panel').className='';$('panel').innerHTML='';var m=$('wrap').querySelectorAll('.nd.sel');for(var i=0;i<m.length;i++)m[i].classList.remove('sel');
  if(id){var el=$('wrap').querySelector('[data-id="'+String(id).replace(/"/g,'')+'"]');if(el)try{el.focus({preventScroll:true})}catch(e){}}}
$('wrap').addEventListener('click',function(e){var t=e.target.closest&&e.target.closest('.nd');if(t)openPanel(t.getAttribute('data-id'))});
$('fl').addEventListener('click',function(e){var t=e.target.closest&&e.target.closest('[data-node]');if(t)openPanel(t.getAttribute('data-node'))});
// ---- keyboard: Enter/Space opens, arrows move between cards, / searches, Esc closes
function nav(from,key){
  var a=P[from];if(!a)return null;var best=null,bs=1e18;
  Object.keys(P).forEach(function(id){if(id===from)return;var b=P[id],dx=b.cx-a.cx,dy=b.cy-a.cy,al=key==='ArrowRight'?dx:key==='ArrowLeft'?-dx:key==='ArrowDown'?dy:-dy,pe=(key==='ArrowRight'||key==='ArrowLeft')?Math.abs(dy):Math.abs(dx);
    if(al<=4)return;var sc=al+pe*2.5;if(sc<bs){bs=sc;best=id}});
  return best}
$('wrap').addEventListener('keydown',function(e){var t=e.target;if(!t.classList||!t.classList.contains('nd'))return;
  if(e.key==='Enter'||e.key===' '){e.preventDefault();openPanel(t.getAttribute('data-id'));return}
  if(/^Arrow(Left|Right|Up|Down)$/.test(e.key)){e.preventDefault();var id=nav(t.getAttribute('data-id'),e.key);
    if(id){var el=$('wrap').querySelector('[data-id="'+String(id).replace(/"/g,'')+'"]');if(el)el.focus()}}});
document.addEventListener('keydown',function(e){
  var t=e.target,typing=t&&(t.tagName==='INPUT'||t.tagName==='TEXTAREA');
  if(e.key==='/'&&!typing&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();$('q').focus();$('q').select();return}
  if(e.key==='Escape'){if(selId){closePanel();return}if(typing){t.blur();return}if(feedOpen()){ST.feed=false;save();syncUi()}}});
$('q').addEventListener('input',function(){ST.q=this.value.slice(0,80);save();schedule()});
$('fidle').addEventListener('click',function(){ST.idle=ST.idle?0:1;save();render()});
$('ferr').addEventListener('click',function(){ST.err=ST.err?0:1;save();render()});
$('ftog').addEventListener('click',function(){ST.feed=!feedOpen();save();render()});
$('fx').addEventListener('click',function(){ST.feed=false;save();render()});
$('legend').addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('.lg');if(!b)return;var k=b.getAttribute('data-k'),i=ST.hide.indexOf(k);if(i>=0)ST.hide.splice(i,1);else ST.hide.push(k);save();render()});
$('pause').addEventListener('click',function(){paused=!paused;this.textContent=paused?'Resume':'Pause';this.setAttribute('aria-label',paused?'Resume live updates':'Pause live updates');paint();
  if(!paused){pulses=[];if(pendingSnap){SNAP=pendingSnap;pendingSnap=null;render()}}});
var rt=0;window.addEventListener('resize',function(){clearTimeout(rt);rt=setTimeout(function(){if(!paused&&mode!=='img')render();if(view_==='trends')drawTrends()},150)});
function apply(d){try{rpSnap(d)}catch(e){}if(paused){pendingSnap=d;return}SNAP=d;schedule()}
setInterval(function(){if(paused)return;var n=(Date.now()-rcv)/1000,ls=document.querySelectorAll('#stage line[data-age]');
  if(RT!=null)return;for(var i=0;i<ls.length;i++){if(ls[i].getAttribute('data-idle')==='1')continue;var a=+ls[i].getAttribute('data-age')+n;ls[i].setAttribute('opacity',Math.max(.3,1-.7*Math.min(a,30)/30).toFixed(2))}},1000);
// ---- moving dots
function frame(){
  var now=performance.now(),g=$('pl'),h=[];
  pulses=pulses.filter(function(p){return now-p.t0<1100});
  pulses.forEach(function(p){var a=P[p.f],b=P[p.to];if(!a||!b)return;var u=(now-p.t0)/1100;
    h.push('<circle r="5" cx="'+(a.cx+(b.cx-a.cx)*u).toFixed(1)+'" cy="'+(a.cy+(b.cy-a.cy)*u).toFixed(1)+'" style="fill:var(--req)" opacity="'+(1-u*.4).toFixed(2)+'"/>')});
  if(g)g.innerHTML=h.join('');
  raf=pulses.length?requestAnimationFrame(frame):0}
function pulse(f,t){if(paused)return;if(pulses.length>20)pulses.shift();pulses.push({f:f,to:t,t0:performance.now()});if(!raf)raf=requestAnimationFrame(frame)}
function up(m,t,c){mode=m;chip(t,c||'live');why(m==='socket'?'':reason())}
// ---- transport 1: WebSocket
function connect(){
  if(stopped||mode&&mode!=='socket')return;
  var open=false,gotSnap=false;
  try{ws=new WebSocket('ws://127.0.0.1:'+EP.port+'/?'+tq)}catch(e){codes.push('WebSocket: '+esc(e&&e.name||'error'));return fallback('poll')}
  setTimeout(function(){if(!open&&!gotLive&&!mode){codes.push('WebSocket timeout');try{ws.close()}catch(e){}fallback('poll')}},5000);
  ws.onopen=function(){open=true;gotLive=true;fails=0;delay=1000;chip('connected, waiting for data','re');
    setTimeout(function(){if(open&&!gotSnap&&ws&&ws.readyState===1){chip('connected, no data'+(srvErr?' ('+srvErr+')':''),'bad');why(srvErr?esc(srvErr):'')}},5000)};
  ws.onmessage=function(m){var d;try{d=JSON.parse(m.data)}catch(e){return}
    if(d.type==='snapshot'){apply(d);srvErr='';if(!gotSnap||mode!=='socket'){gotSnap=true;up('socket','live (socket)')}}
    else if(d.type==='error'){srvErr=String(d.text||'error').slice(0,200);
      if(!gotSnap){chip('connected, no data ('+srvErr+')','bad');why(esc(srvErr))}else why('last update failed: '+esc(srvErr))}
    else if(d.type==='event'){pulse(d.from,d.to);rpAdd(d)}};
  ws.onerror=function(){if(!open)codes.push('WebSocket error')};
  ws.onclose=function(ev){
    if(!open){codes.push('WebSocket closed '+(ev&&ev.code));checkFresh()}
    if(!gotLive)return fallback('poll');
    if(open)fails=0;else fails++;
    if(fails>=4&&!sameOrigin){stopped=true;chip('service restarted - run lean-agent map --url again','bad');return}
    chip('reconnecting','re');setTimeout(connect,delay);delay=Math.min(15000,delay*2)}}
var tried={};
function fallback(next){
  if(stopped||tried[next])return;tried[next]=1;
  if(next==='poll')return pollFetch();
  if(next==='img')return pollImg();
  blocked()}
function blocked(){
  mode='none';
  var l=base&&!/^https?:/.test(location.protocol)?' <a href="'+base+'/" target="_blank" rel="noopener">Open in browser</a>':'';
  if(isFile&&viol.length)return fileRefresh(l);
  if(viol.length){chip('preview blocks live updates','bad');why(reason()+l)}
  else{chip('snapshot (service not running)','bad');why((reason()||'connection refused on every transport')+l)}}
// ---- transport 4: the file itself (a viewer that blocks every network call can still reload a file the service rewrites)
function fileRefresh(l){
  mode='refresh';var now=Date.now(),ts=String(SNAP.ts||''),lf=HS.lt===ts&&+HS.lf?+HS.lf:now;
  if(now-lf>60000){chip('file refresh stopped - ask for the map again','bad');why('The page file stopped changing. Ask for the map again.'+(l||''));return}
  chip('live (file refresh · 3 s)','live');why((l||'').trim());
  (function wait(){setTimeout(function(){if(paused)return wait();saveHash(ts,lf);location.reload()},3000)})()}
// ---- a bookmarked page after a service restart: fetch the page again, reload once when the token changed
function checkFresh(){
  if(!sameOrigin||typeof fetch!=='function')return;
  fetch(location.pathname||'/',{cache:'no-store'}).then(function(r){return r.ok?r.text():''}).then(function(t){
    var m=/"token": ?"([^"]+)"/.exec(t||'');if(m&&EP.token&&m[1]!==EP.token)location.reload()}).catch(function(){})}
// ---- transport 2: fetch polling
function pollFetch(){
  if(typeof fetch!=='function')return fallback('img');
  var okOnce=false,bad=0;
  function tick(){
    if(stopped||mode&&mode!=='poll')return;
    fetch(base+'/snap?'+tq,{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(function(d){
      okOnce=true;bad=0;apply(d);if(mode!=='poll')up('poll','live (polling)');setTimeout(tick,2000)
    }).catch(function(e){
      if(!okOnce){codes.push('fetch failed');return fallback('img')}
      checkFresh();
      if(++bad>=5){chip('service not reachable','bad');why(reason())}else chip('reconnecting','re');
      setTimeout(tick,2000)})}
  tick()}
// ---- transport 3: image polling (the server draws it)
function pollImg(){
  var n=0,okOnce=false,bad=0;
  function tick(){
    if(stopped||mode&&mode!=='img')return;
    var im=new Image();
    im.onload=function(){okOnce=true;bad=0;im.alt='live map';
      if(!paused){var w=$('wrap');w.style.height='auto';w.innerHTML='';w.appendChild(im)}if(mode!=='img')up('img','live (image)');setTimeout(tick,2000)};
    im.onerror=function(){
      if(!okOnce){codes.push('image failed');return blocked()}
      if(++bad>=5){chip('service not reachable','bad');why(reason())}else chip('reconnecting','re');
      setTimeout(tick,2000)};
    im.src=base+'/map.svg?'+tq+'&w=900&h=700&n='+(++n)}
  tick()}
// ---- projects, alerts
function projs(){var p=SNAP.projects;return Array.isArray(p)?p.filter(function(x){return x&&x.slug}).slice(0,12):[]}
function grouped(){return !ST.proj&&projs().length>=2}
function projBar(){var ps=projs(),el=$('projs');
  if(ST.proj&&!ps.some(function(x){return x.slug===ST.proj}))ST.proj='';
  if(ps.length<2){el.hidden=true;el.innerHTML='';return}
  el.hidden=false;
  el.innerHTML='<button type="button" class="pc" data-p="" aria-pressed="'+(ST.proj===''?'true':'false')+'">All</button>'+ps.map(function(x){
    return '<button type="button" class="pc" data-p="'+esc(x.slug)+'" aria-pressed="'+(ST.proj===x.slug?'true':'false')+'" title="'+esc((x.threads|0)+' threads, '+(x.workers|0)+' workers, '+usd(x.usd_today)+' today'+(x.errors_30m>0?', '+x.errors_30m+' errors (30 min)':''))+'"><b>'+esc(x.slug)+'</b> '+(x.threads|0)+' <span class="pu">'+esc(usd(x.usd_today))+'</span>'+(x.errors_30m>0?' <i class="am bad st"></i>':'')+'</button>'}).join('')}
$('projs').addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('.pc');if(!b)return;ST.proj=b.getAttribute('data-p')||'';save();render()});
function alerts(){var a=SNAP.alerts;return Array.isArray(a)?a.filter(function(x){return x&&x.id&&x.text}).slice(0,20):[]}
function alertBar(){
  var vis=alerts().filter(function(a){return !DIS[a.id]}),now=Date.now()/1000,o=[],nb=0,el=$('alerts'),bell=$('bell');
  ALV={};
  vis.forEach(function(a){if(a.level==='bad')nb++;if(a.node&&ALV[a.node]!=='bad')ALV[a.node]=a.level==='bad'?'bad':'warn'});
  vis.forEach(function(a){var lv=a.level==='bad'?'bad':'warn';
    if(lv==='bad'&&!NOTI[a.id]){NOTI[a.id]=1;if(ST.notif&&document.hidden&&typeof Notification!=='undefined'&&Notification.permission==='granted')try{new Notification('lean-agent: '+a.text)}catch(e){}}
    o.push('<div class="al lv-'+lv+(SEEN[a.id]?'':' nw')+'" role="listitem" data-id="'+esc(a.id)+'"><i class="ad"></i><span class="at">'+esc(a.text)+'</span><time>'+esc(a.since?dur(now-a.since)+' ago':'')+'</time>'
      +(a.node?'<button type="button" class="ash" data-node="'+esc(a.node)+'" aria-label="Show '+esc(a.node)+'">show</button>':'')+'<button type="button" class="adx" data-id="'+esc(a.id)+'" aria-label="Dismiss alert">✕</button></div>')});
  var h=o.join('');vis.forEach(function(a){SEEN[a.id]=1});
  if(h!==lastAl){var ac=document.activeElement,ka=ac&&ac.closest&&ac.closest('#alerts')?(ac.className+'|'+(ac.getAttribute('data-id')||ac.getAttribute('data-node'))):'';
    lastAl=h;el.innerHTML=h;el.hidden=!h;
    if(ka){var bs=el.querySelectorAll('button');for(var i=0;i<bs.length;i++){if(bs[i].className+'|'+(bs[i].getAttribute('data-id')||bs[i].getAttribute('data-node'))===ka){try{bs[i].focus({preventScroll:true})}catch(e){}break}}}}
  bell.hidden=!vis.length;bell.className='pill'+(vis.length?(nb?' bad':' warn'):'');
  bell.innerHTML='<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg><b>'+vis.length+'</b>';
  bell.title=vis.length+(vis.length===1?' alert':' alerts')+(nb?' ('+nb+' bad)':'');bell.setAttribute('aria-label',bell.title)}
function showNode(id){var n=null;(SNAP.nodes||[]).forEach(function(x){if(x.id===id)n=x});if(!n)return;
  if(view_!=='map')setView('map');
  if(ST.proj&&n.project!==ST.proj){ST.proj='';save()}
  render();openPanel(id);var c=$('wrap').querySelector('[data-id="'+String(id).replace(/"/g,'')+'"]');if(c&&c.scrollIntoView)try{c.scrollIntoView({block:'nearest'})}catch(e){}}
$('alerts').addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('button');if(!b)return;
  if(b.className==='ash')showNode(b.getAttribute('data-node'));
  else if(b.className==='adx'){DIS[b.getAttribute('data-id')]=1;saveDis();alertBar();render()}});
$('bell').addEventListener('click',function(){var f=$('alerts').querySelector('button');if(f)f.focus();if($('alerts').scrollIntoView)try{$('alerts').scrollIntoView({block:'nearest'})}catch(e){}});
var nt=$('ntog');
if(typeof Notification==='undefined')nt.hidden=true;
else{nt.setAttribute('aria-pressed',ST.notif&&Notification.permission==='granted'?'true':'false');
  nt.addEventListener('click',function(){
    if(ST.notif){ST.notif=0;save();nt.setAttribute('aria-pressed','false');return}
    try{var r=Notification.requestPermission(function(p){fin(p)});if(r&&r.then)r.then(fin)}catch(e){}
    function fin(p){ST.notif=p==='granted'?1:0;save();nt.setAttribute('aria-pressed',ST.notif?'true':'false')}})}
// ---- trends
var PAL=['#4A72D8','#1B9E92','#C9821A','#9B6BDF','#D6453B','#98A2B3'];
function setView(v){view_=v;document.body.className=v==='trends'?'tr':'';$('vmap').setAttribute('aria-pressed',v==='map'?'true':'false');$('vtr').setAttribute('aria-pressed',v==='trends'?'true':'false');
  if(v==='trends')loadTrends();else schedule()}
$('vmap').addEventListener('click',function(){setView('map')});$('vtr').addEventListener('click',function(){setView('trends')});
function loadTrends(){var box=$('trends');
  if(!canFetch()){box.innerHTML='<div class="tcard tn0">Open in browser for trends.'+(base?' <a href="'+base+'/" target="_blank" rel="noopener">Open in browser</a>':'')+'</div>';return}
  if(HIST&&Date.now()-HISTT<60000){drawTrends();return}
  box.innerHTML='<div class="tcard tn0">Loading trends…</div>';
  fetch(base+'/history?'+tq+'&days=14',{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(function(d){HIST=d;HISTT=Date.now();if(view_==='trends')drawTrends()})
    .catch(function(e){if(view_==='trends')box.innerHTML='<div class="tcard tn0">Trends are not available from this service ('+esc(e&&e.message||'error')+'). Update the service to see them.</div>'})}
function niceMax(v){if(!(v>0))return 1;var p=Math.pow(10,Math.floor(Math.log(v)/Math.LN10)),f=v/p;return (f<=1?1:f<=2?2:f<=5?5:10)*p}
function dlab(d){return String(d||'').slice(5)}
function xlabs(days,L,pw,H,W){var n=days.length,k=W<520?4:n>10?2:1,o='';days.forEach(function(d,i){if(i%k===0||i===n-1&&k===1)o+='<text class="ax" x="'+(L+(i+.5)*pw/n).toFixed(1)+'" y="'+(H-8)+'" text-anchor="middle">'+esc(dlab(d.date))+'</text>'});return o}
function yaxis(L,R,T,ph,W,mx,fmt,right){var o='';for(var i=0;i<=4;i++){var y=T+ph-i*ph/4,v=mx*i/4;o+='<line class="gl" x1="'+L+'" x2="'+(W-R)+'" y1="'+y.toFixed(1)+'" y2="'+y.toFixed(1)+'"/><text class="ax" x="'+(right?W-R+4:L-4)+'" y="'+(y+3).toFixed(1)+'" text-anchor="'+(right?'start':'end')+'">'+esc(fmt(v))+'</text>'}return o}
function svgOpen(W,H,lab){return '<svg width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'" role="group" aria-label="'+esc(lab)+'">'}
function chartCost(days,W){var H=210,L=44,R=50,T=12,B=28,pw=W-L-R,ph=H-T-B,n=days.length,mx=niceMax(Math.max.apply(null,days.map(function(d){return +d.usd||0}))),ms=niceMax(Math.max.apply(null,days.map(function(d){return +d.saved||0}))),bw=Math.max(3,pw/n*.6);
  var o=[svgOpen(W,H,'Daily cost in dollars as bars and tokens saved as a line'),yaxis(L,R,T,ph,W,mx,function(v){return '$'+(v<10?v.toFixed(1):Math.round(v))}),yaxis(L,R,T,ph,W,ms,fmtN,1).replace(/<line[^>]*>/g,'')];
  days.forEach(function(d,i){var h=(+d.usd||0)/mx*ph,x=L+i*pw/n+(pw/n-bw)/2,tip=d.date+' · '+usd(d.usd)+' · '+fmtN(d.tokens)+' tokens · saved '+fmtN(d.saved)+' · '+(d.runs|0)+' runs';
    o.push('<rect class="bc" x="'+x.toFixed(1)+'" y="'+(T+ph-h).toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+Math.max(h,0).toFixed(1)+'" rx="2" tabindex="0" data-tip="'+esc(tip)+'" aria-label="'+esc(tip)+'"/>')});
  var pts=days.map(function(d,i){return [L+(i+.5)*pw/n,T+ph-(+d.saved||0)/ms*ph,d]});
  o.push('<polyline class="sl" fill="none" points="'+pts.map(function(p){return p[0].toFixed(1)+','+p[1].toFixed(1)}).join(' ')+'"/>');
  pts.forEach(function(p){var tip=p[2].date+' · saved '+fmtN(p[2].saved)+' tokens';o.push('<circle class="sp" cx="'+p[0].toFixed(1)+'" cy="'+p[1].toFixed(1)+'" r="3.5" tabindex="0" data-tip="'+esc(tip)+'" aria-label="'+esc(tip)+'"/>')});
  o.push(xlabs(days,L,pw,H,W),'</svg>');return o.join('')}
function chartMix(days,W){var H=210,L=44,R=10,T=12,B=28,pw=W-L-R,ph=H-T-B,n=days.length,tot={};
  days.forEach(function(d){var m=d.by_model||{};for(var k in m)tot[k]=(tot[k]||0)+(+m[k]||0)});
  var names=Object.keys(tot).sort(function(a,b){return tot[b]-tot[a]}),top=names.slice(0,5),extra=names.length>5;if(extra)top.push('other');
  var mx=niceMax(Math.max.apply(null,days.map(function(d){var s=0,m=d.by_model||{};for(var k in m)s+=+m[k]||0;return s}))),bw=Math.max(3,pw/n*.6);
  var o=[svgOpen(W,H,'Daily cost by model, stacked'),yaxis(L,R,T,ph,W,mx,function(v){return '$'+(v<10?v.toFixed(1):Math.round(v))})];
  days.forEach(function(d,i){var m=d.by_model||{},y=T+ph,x=L+i*pw/n+(pw/n-bw)/2,seg={},tip=[d.date];
    for(var k in m){var key=top.indexOf(k)>=0?k:'other';seg[key]=(seg[key]||0)+(+m[k]||0)}
    top.forEach(function(k,j){var v=seg[k]||0;if(v<=0)return;var h=v/mx*ph;y-=h;tip.push(k+' '+usd(v));
      o.push('<rect class="mc" style="fill:'+PAL[j%PAL.length]+'" x="'+x.toFixed(1)+'" y="'+y.toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+h.toFixed(1)+'" tabindex="0" data-tip="'+esc(d.date+' · '+k+' '+usd(v))+'" aria-label="'+esc(d.date+' · '+k+' '+usd(v))+'"/>')})});
  o.push(xlabs(days,L,pw,H,W),'</svg>');
  o.push('<div class="lgd">'+top.map(function(k,j){return '<span><i style="background:'+PAL[j%PAL.length]+'"></i>'+esc(k)+'</span>'}).join('')+'</div>');return o.join('')}
function chartCache(days,W){var H=170,L=44,R=14,T=12,B=28,pw=W-L-R,ph=H-T-B,n=days.length;
  var o=[svgOpen(W,H,'Cache read ratio per day'),yaxis(L,R,T,ph,W,1,function(v){return Math.round(v*100)+'%'})],pts=[];
  days.forEach(function(d,i){var r=num(d.cache_read_ratio);if(r==null)return;pts.push([L+(i+.5)*pw/n,T+ph-Math.max(0,Math.min(1,r))*ph,d,r])});
  o.push('<polyline class="cl" fill="none" points="'+pts.map(function(p){return p[0].toFixed(1)+','+p[1].toFixed(1)}).join(' ')+'"/>');
  pts.forEach(function(p){var tip=p[2].date+' · cache read '+Math.round(p[3]*100)+'%';o.push('<circle class="cp" cx="'+p[0].toFixed(1)+'" cy="'+p[1].toFixed(1)+'" r="3.5" tabindex="0" data-tip="'+esc(tip)+'" aria-label="'+esc(tip)+'"/>')});
  o.push(xlabs(days,L,pw,H,W),'</svg>');return o.join('')}
function chartTools(tools,W){var rows=tools.slice(0,10),RH=22,L=84,R=44,H=rows.length*RH+8,mx=Math.max.apply(null,rows.map(function(t){return +t[1]||0}).concat([1])),o=[svgOpen(W,H,'Top tools in the last 7 days')];
  rows.forEach(function(t,i){var y=4+i*RH,w=(+t[1]||0)/mx*(W-L-R),tip=t[0]+' · '+t[1]+' calls';
    o.push('<text class="rl" x="'+(L-6)+'" y="'+(y+13)+'" text-anchor="end">'+esc(clip(t[0],12))+'</text><rect class="bc" x="'+L+'" y="'+y+'" width="'+Math.max(w,2).toFixed(1)+'" height="16" rx="2" tabindex="0" data-tip="'+esc(tip)+'" aria-label="'+esc(tip)+'"/><text class="ax" x="'+(L+w+4).toFixed(1)+'" y="'+(y+12)+'">'+esc(fmtN(t[1]))+'</text>')});
  o.push('</svg>');return o.join('')}
function drawTrends(){var box=$('trends'),d=HIST;if(!d||view_!=='trends')return;
  var days=Array.isArray(d.days)?d.days.slice(-14):[],tt=Array.isArray(d.top_threads)?d.top_threads.slice(0,10):[],tools=Array.isArray(d.tools_7d)?d.tools_7d.slice(0,10):[];
  if(!days.length){box.innerHTML='<div class="tcard tn0">No history yet.</div>';return}
  var sum=days.reduce(function(a,x){return a+(+x.usd||0)},0),pj={},last7=days.slice(-7);
  last7.forEach(function(x){var b=x.by_project||{};for(var k in b)pj[k]=(pj[k]||0)+(+b[k]||0)});
  var today={};projs().forEach(function(x){today[x.slug]=+x.usd_today||0});if(!projs().length&&days.length){var lt=days[days.length-1].by_project||{};for(var k in lt)today[k]=+lt[k]||0}
  var pn=Object.keys(pj).concat(Object.keys(today).filter(function(k){return !(k in pj)})).sort(function(a,b){return (pj[b]||0)-(pj[a]||0)});
  box.innerHTML='<div class="tcard"><h2>Daily cost <span>'+esc(usd(sum))+' in '+days.length+' days · line = tokens saved</span></h2><div id="c1" class="chart"></div></div>'
   +'<div class="tg2"><div class="tcard"><h2>Model mix <span>cost per day</span></h2><div id="c2" class="chart"></div></div>'
   +'<div class="tcard"><h2>Cache read ratio</h2><div id="c3" class="chart"></div></div></div>'
   +'<div class="tg2"><div class="tcard"><h2>Projects</h2>'+(pn.length?'<table id="tpj"><thead><tr><th>Project</th><th>Today</th><th>7 days</th></tr></thead><tbody>'+pn.map(function(k){return '<tr><td>'+esc(k)+'</td><td>'+esc(usd(today[k]||0))+'</td><td>'+esc(usd(pj[k]||0))+'</td></tr>'}).join('')+'</tbody></table>':'<div class="mu">No project data.</div>')+'</div>'
   +'<div class="tcard"><h2>Top threads <span>7 days</span></h2>'+(tt.length?'<table id="ttt"><thead><tr><th>Thread</th><th>Cost</th><th>Tokens</th></tr></thead><tbody>'+tt.map(function(t){return '<tr><td title="'+esc(t.title)+'"><button type="button" class="lk mono" data-node="'+esc(t.node)+'">'+esc(t.node)+'</button> '+esc(clip(t.title,28))+'</td><td>'+esc(usd(t.usd))+'</td><td>'+esc(fmtN(t.tokens))+'</td></tr>'}).join('')+'</tbody></table>':'<div class="mu">No thread cost yet.</div>')+'</div></div>'
   +'<div class="tcard"><h2>Top tools <span>7 days</span></h2><div id="c4" class="chart">'+(tools.length?'':'<div class="mu">No tool calls.</div>')+'</div></div>';
  function fill(id,fn,arg){var el=$(id);if(el&&arg.length)el.innerHTML=fn(arg,Math.max(260,el.clientWidth||600))}
  fill('c1',chartCost,days);fill('c2',chartMix,days);fill('c3',chartCache,days);fill('c4',chartTools,tools)}
$('trends').addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('.lk');if(b)showNode(b.getAttribute('data-node'))});
render();
if(HS.y&&HS.fr==='1')try{window.scrollTo(0,+HS.y)}catch(e){}
if(isFile&&HS.fr==='1'){fileRefresh(base?' <a href="'+base+'/" target="_blank" rel="noopener">Open in browser</a>':'')}
else if(EP&&EP.port){chip('connecting','re');connect()}else chip('snapshot (service not running)','bad');
})();
"""



PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>lean-agent live map</title><style>%CSS%</style></head><body><div id="app">
<header><div><h1>Live map</h1><div id="sub">lean-agent · service socket · updates as messages move</div></div>
<div id="chips"><span class="pill" id="pill"><span class="dot"></span><span id="chip">snapshot (service not running)</span><span id="ms"></span></span>
<span class="pill" id="cpu">Service CPU –%</span><span class="pill" id="wk">0 workers</span><span class="pill" id="inbox">Inbox 0</span>
<span class="pill" id="runs" hidden></span><span class="pill" id="usd" hidden></span><span class="pill" id="saved" hidden></span><span class="pill" id="tpm" hidden></span><span class="pill" id="errs" hidden></span>
<button type="button" class="pill" id="bell" hidden></button>
<span id="vsw" role="group" aria-label="View"><button type="button" id="vmap" aria-pressed="true">Map</button><button type="button" id="vtr" aria-pressed="false">Trends</button></span>
<button type="button" id="pause" aria-label="Pause live updates">Pause</button></div></header>
<div id="alerts" role="list" aria-label="Alerts" hidden></div>
<div id="bar"><input id="q" type="search" placeholder="Filter by node or tool  ( / )" aria-label="Filter nodes by id, title or tool" autocomplete="off" spellcheck="false">
<button type="button" class="tg" id="fidle" aria-pressed="false">Hide idle</button><button type="button" class="tg" id="ferr" aria-pressed="false">Only errors</button>
<button type="button" id="ftog" aria-pressed="false" aria-controls="feed">Activity</button><button type="button" class="tg" id="ntog" aria-pressed="false" title="Browser notification for each new bad alert while this page is hidden">Notify</button><span id="fc" aria-live="polite"></span></div>
<div id="projs" role="group" aria-label="Project filter" hidden></div>
<div id="why"></div><div id="trends" aria-label="Trends"></div>
<div id="main"><div id="mapcol"><div id="wrap"></div>
<section id="tlw" aria-label="Timeline" hidden><h2><span id="tlh">Last 10 minutes</span> <span id="tlc"></span><span class="rg" role="group" aria-label="Range"><button type="button" id="r10" aria-pressed="true">10 min</button><button type="button" id="r60" aria-pressed="false">60 min</button></span></h2><div id="tl"></div>
<div id="scw"><input type="range" id="scr" min="-600" max="0" step="1" value="0" aria-label="Replay position: drag or use arrow keys to see the map at an earlier time"><span id="sct">live</span><button type="button" id="live" hidden>Live</button></div></section></div>
<aside id="feed" aria-label="Activity feed"><div class="fh"><b>Activity</b><button type="button" id="fx" aria-label="Hide activity feed">Hide</button></div><ul id="fl"></ul></aside></div>
<div id="tip" role="tooltip"></div>
<footer><div id="legend">
<button type="button" class="lg" data-k="message" aria-pressed="true"><svg aria-hidden="true" width="28" height="8" viewBox="0 0 28 8"><path d="M 0 4 L 22 4" stroke="var(--ok)" stroke-width="2" stroke-linecap="round"/><path d="M20 0 L28 4 L20 8 Z" fill="var(--ok)"/></svg>Message to an agent</button>
<button type="button" class="lg" data-k="report" aria-pressed="true"><svg aria-hidden="true" width="28" height="8" viewBox="0 0 28 8"><path d="M 6 4 L 28 4" stroke="var(--rep)" stroke-width="2" stroke-linecap="round"/><path d="M8 0 L0 4 L8 8 Z" fill="var(--rep)"/></svg>Report or result back</button>
<button type="button" class="lg" data-k="request" aria-pressed="true"><svg aria-hidden="true" width="28" height="8" viewBox="0 0 28 8"><path d="M 0 4 L 22 4" stroke="var(--req)" stroke-width="2" stroke-linecap="round"/><path d="M20 0 L28 4 L20 8 Z" fill="var(--req)"/></svg>Socket request</button>
<button type="button" class="lg" data-k="idle" aria-pressed="true"><svg aria-hidden="true" width="28" height="8" viewBox="0 0 28 8"><path d="M 0 4 L 28 4" stroke="var(--idle)" stroke-width="2" stroke-dasharray="6 6"/></svg>Idle link</button>
<button type="button" class="lg" data-k="bad" aria-pressed="true"><svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="var(--bad)"/></svg>Undelivered or stuck</button>
</div><span>Lines fade 30 s after the last message · click a node for details · legend items toggle lines</span></footer></div>
<aside id="panel" role="dialog" aria-label="Node details"></aside>
<script type="application/json" id="snap">%SNAP%</script>
<script type="application/json" id="ep">%EP%</script>
<script>%JS%</script></body></html>
"""


def _json_safe(o):
    return json.dumps(o).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


def build_html(snap, ep):
    ep = {"port": ep["port"], "token": ep["token"]} if ep else {}
    return PAGE.replace("%CSS%", CSS).replace("%JS%", JS).replace("%SNAP%", _json_safe(snap)).replace("%EP%", _json_safe(ep))


def html_path(home, out=None):
    if out:
        p = os.path.abspath(os.path.expanduser(out))
        os.makedirs(os.path.dirname(p), exist_ok=True)
    else:
        d = os.path.join(home, "map")
        os.makedirs(d, exist_ok=True)
        os.chmod(d, 0o700)
        p = os.path.join(d, "live.html")
    return p


def write_html(home, snap, out=None):
    """Writes the page (file 0600, default dir 0700) and returns its absolute path."""
    p = html_path(home, out)
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(build_html(snap, endpoint(home)))
    os.chmod(p, 0o600)
    return p


PROBE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>lean-agent map probe</title>
<style>body{font:13px system-ui,-apple-system,sans-serif;margin:12px;background:#fff;color:#1B2230}
@media(prefers-color-scheme:dark){body{background:#0F1217;color:#E6E9EF}}
li{margin:3px 0;font-family:ui-monospace,Menlo,monospace}.ok{color:#1B9E92}.no{color:#D6453B}</style></head><body>
<h3>lean-agent map probe</h3><p>Send one screenshot of this page if the live map still does not update.</p>
<ul id="out"><li class="no">inline JS: FAIL (this line never changed)</li></ul>
<script type="application/json" id="ep">%EP%</script>
<script>
(function(){
var EP=JSON.parse(document.getElementById('ep').textContent),out=document.getElementById('out'),viol=[];
function row(t,ok){var l=document.createElement('li');l.className=ok===true?'ok':ok===false?'no':'';l.textContent=t;out.appendChild(l);return l}
function set(l,t,ok){l.textContent=t;l.className=ok?'ok':'no'}
out.innerHTML='';
row('inline JS: ok',true);
row('origin: '+location.origin+' | isSecureContext: '+window.isSecureContext+' | protocol: '+location.protocol);
var meta=document.querySelector('meta[http-equiv]'),m=null;
var all=document.getElementsByTagName('meta');for(var i=0;i<all.length;i++){if(/content-security-policy/i.test(all[i].getAttribute('http-equiv')||''))m=all[i]}
row('meta CSP present: '+(m?'yes ('+m.getAttribute('content')+')':'no'));
var vl=row('securitypolicyviolation: none so far');
document.addEventListener('securitypolicyviolation',function(e){
  viol.push(e.violatedDirective+' '+String(e.blockedURI||'').split('?')[0]);vl.textContent='securitypolicyviolation: '+viol.join(' ; ');vl.className='no'});
if(!EP.port){row('live endpoint: not running (start the service: lean-agent up)',false);return}
var base='http://127.0.0.1:'+EP.port,tq='t='+encodeURIComponent(EP.token);
var wl=row('WebSocket: testing...');
try{var w=new WebSocket('ws://127.0.0.1:'+EP.port+'/?'+tq),done=false;
  w.onopen=function(){done=true;set(wl,'WebSocket: open ok',true);w.close()};
  w.onerror=function(){if(!done)set(wl,'WebSocket: fail (error)',false)};
  w.onclose=function(e){if(!done){done=true;set(wl,'WebSocket: fail (code '+e.code+')',false)}};
  setTimeout(function(){if(!done){done=true;set(wl,'WebSocket: fail (timeout)',false)}},5000)
}catch(e){set(wl,'WebSocket: fail ('+e.name+')',false)}
var fl=row('fetch: testing...');
try{fetch(base+'/snap?'+tq,{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(function(){set(fl,'fetch: ok',true)}).catch(function(e){set(fl,'fetch: fail ('+(e&&e.message)+')',false)})}catch(e){set(fl,'fetch: fail ('+e.name+')',false)}
var il=row('img: testing...'),im=new Image();
im.onload=function(){set(il,'img: ok',true)};im.onerror=function(){set(il,'img: fail',false)};
im.src=base+'/map.svg?'+tq+'&w=200&h=150&n=1';
})();
</script></body></html>
"""


def build_probe(ep):
    ep = {"port": ep["port"], "token": ep["token"]} if ep else {}
    return PROBE.replace("%EP%", _json_safe(ep))


def write_probe(home):
    """Writes <home>/map/probe.html (0600, dir 0700) and returns its absolute path."""
    d = os.path.join(home, "map")
    os.makedirs(d, exist_ok=True)
    os.chmod(d, 0o700)
    p = os.path.join(d, "probe.html")
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(build_probe(endpoint(home)))
    os.chmod(p, 0o600)
    return p
