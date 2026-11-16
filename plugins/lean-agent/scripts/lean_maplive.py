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
import socket
import struct
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
    def __init__(self, snapshot, home, interval=INTERVAL, max_clients=MAX_CLIENTS):
        self.snapshot = snapshot
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
        s.bind(("127.0.0.1", 0))
        s.listen(16)
        s.settimeout(0.5)
        self.lsock, self.port = s, s.getsockname()[1]
        os.makedirs(self.home, exist_ok=True)
        p = live_path(self.home)
        tmp = p + f".{os.getpid()}.tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as fh:
            json.dump({"port": self.port, "token": self.token, "pid": os.getpid()}, fh)
        os.chmod(tmp, 0o600)
        os.replace(tmp, p)
        threading.Thread(target=self._accept, daemon=True).start()
        threading.Thread(target=self._loop, daemon=True).start()
        return self

    def stop(self):
        self.stopped.set()
        self.wake.set()
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
            if c and time.monotonic() - c[0] < self.interval * 0.9:
                return c[1]
        try:
            snap = self.snapshot()
        except Exception as exc:  # noqa: BLE001 - a failing snapshot must never take the loop or a request down
            self._fail(exc)
            if self.good is not None:
                return self.good
            raise
        with self.lock:
            self.cache = (time.monotonic(), snap)
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
        key = (w, h, mini)
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

    def on_request(self, op, req):
        """Called by the service socket per request; cheap and never raises."""
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
        if not hmac.compare_digest(tok.encode(), self.token.encode()):
            self._http(conn, 403, "Forbidden")
            return None
        key = hdr.get("sec-websocket-key")
        if hdr.get("upgrade", "").lower() != "websocket":
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
        return True, "live map page endpoint: up (127.0.0.1 only, sends snapshots)"
    if st == "no-snapshot":
        return None, f"live map page endpoint: accepts but sends no snapshot ({why})"
    if st == "token":
        return None, "live map page endpoint: token mismatch (page from an older service?)"
    return None, "live map page endpoint: not running (lean-agent up starts it)"


def page_url(home):
    """http://127.0.0.1:<port>/?t=<token> of the running endpoint, or None."""
    d = endpoint(home)
    return f"http://127.0.0.1:{d['port']}/?t={urllib.parse.quote(d['token'])}" if d else None


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
#app{max-width:1216px;margin:0 auto;padding:24px 32px 24px}
header{display:flex;align-items:center;justify-content:space-between;gap:16px 24px;flex-wrap:wrap}
h1{font-size:24px;line-height:30px;font-weight:700;letter-spacing:-.01em;margin:0}
#sub{color:var(--mu);margin-top:4px}
#chips{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pill{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;background:var(--card);color:var(--tx2);font-size:13px;white-space:nowrap}
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
.nd .tx{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.nd .tx span{display:block;overflow:hidden;text-overflow:ellipsis}
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
#legend span{display:inline-flex;align-items:center;gap:8px}
#panel{position:fixed;top:72px;right:16px;width:340px;max-height:calc(100vh - 96px);overflow:auto;background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:14px 16px;box-shadow:0 8px 28px rgba(0,0,0,.35);display:none;z-index:5}
#panel.open{display:block}
#panel h2{font-size:16px;margin:0 28px 8px 0;word-break:break-word}
#panel dl{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;margin:0}
#panel dt{color:var(--mu)}#panel dd{margin:0;word-break:break-word}
#panel h3{font-size:12px;color:var(--mu);margin:12px 0 4px;text-transform:uppercase;letter-spacing:.04em}
#panel ul{margin:0;padding:0 0 0 16px}
#panel .x{position:absolute;top:8px;right:8px;height:28px;padding:0 10px}
@media(max-width:700px){#app{padding:16px 12px}h1{font-size:20px}#chips{width:100%}
#panel{top:auto;bottom:0;right:0;left:0;width:auto;max-height:60vh;border-radius:12px 12px 0 0}}
"""

JS = r"""
(function(){
var SNAP=JSON.parse(document.getElementById('snap').textContent),EP=JSON.parse(document.getElementById('ep').textContent);
var KC={message:'--ok',report:'--rep',request:'--req',idle:'--idle',bad:'--bad'};
var pulses=[],P={},raf=0,ws=null,delay=1000,gotLive=false,stopped=false,fails=0,paused=false,pendingSnap=null,selId=null,rcv=Date.now(),lastChip=['',''];
var srvErr='',mode='',viol=[],codes=[],base=EP&&EP.port?'http://127.0.0.1:'+EP.port:'',tq=EP&&EP.token?'t='+encodeURIComponent(EP.token):'';
function $(i){return document.getElementById(i)}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function clip(s,n){s=String(s||'');return s.length>n?s.slice(0,n-1)+'…':s}
function dur(s){s=Math.max(0,Math.floor(s||0));return s<90?s+' s':s<5400?Math.round(s/60)+' min':Math.round(s/3600)+' h'}
function paint(){var e=$('chip'),pl=$('pill');
  if(paused){e.textContent='paused';pl.className='pill paused'}else{e.textContent=lastChip[0];pl.className='pill '+(lastChip[1]==='live'?'':lastChip[1])}}
function chip(t,c){lastChip=[t,c||''];paint()}
function why(h){$('why').innerHTML=h||''}
function reason(){var p=[];if(viol.length)p.push('blocked by the preview: '+viol.map(esc).join(', '));if(codes.length)p.push(codes.map(esc).join(', '));return p.join(' · ')}
document.addEventListener('securitypolicyviolation',function(e){
  var u=String(e.blockedURI||'').split('?')[0];viol.push((e.violatedDirective||'?')+(u?' ('+u+')':''));if(viol.length>6)viol.shift();
  if(!mode)why(reason())});
function placedSet(s){var o={};(Array.isArray(s.placed)?s.placed:[]).forEach(function(i){o[i]=1});return o}
// ---- layout (stage coordinates; the stage is scaled to the window)
function dims(wide){return wide?{W:1152,dw:208,dh:96,sw:240,sh:96,tw:208,th:80,ww:128,wh:64,hw:192,hh:72,xd:0,xs:336,xt:736,xw:1024,hy:150}
  :{W:520,dw:104,dh:80,sw:116,sh:84,tw:132,th:70,ww:100,wh:56,hw:124,hh:60,xd:0,xs:132,xt:276,xw:420,hy:130}}
function layout(s,D){
  var ns=s.nodes||[],ok=placedSet(s),byid={},p={};ns.forEach(function(n){byid[n.id]=n});
  var th=ns.filter(function(n){return n.kind==='thread'&&ok[n.id]});
  th.sort(function(a,b){return a.id.length-b.id.length||(a.id<b.id?-1:a.id>b.id?1:0)});
  var wk={};ns.forEach(function(n){if(n.kind!=='worker'||!ok[n.id])return;
    var k=(n.parent&&byid[n.parent]&&byid[n.parent].kind==='thread'&&ok[n.parent])?n.parent:'main';(wk[k]=wk[k]||[]).push(n)});
  var slots=th.map(function(t){return Math.max(D.th+16,((wk[t.id]||[]).length)*(D.wh+6))});
  var tot=slots.reduce(function(a,b){return a+b},0),H=Math.max(tot+20,560),y=(H-tot)/2,cy=H/2;
  th.forEach(function(t,i){var c=y+slots[i]/2;p[t.id]={cx:D.xt+D.tw/2,cy:c,w:D.tw,h:D.th};
    (wk[t.id]||[]).slice(0,3).forEach(function(w,j,a){p[w.id]={cx:D.xw+D.ww/2,cy:c+(j-(a.length-1)/2)*(D.wh+6),w:D.ww,h:D.wh}});y+=slots[i]});
  p.main={cx:D.xd+D.dw/2,cy:cy,w:D.dw,h:D.dh};p.service={cx:D.xs+D.sw/2,cy:cy,w:D.sw,h:D.sh};
  p.hooks={cx:D.xs+D.sw/2,cy:cy+D.hy,w:D.hw,h:D.hh};
  (wk.main||[]).slice(0,3).forEach(function(w,j){p[w.id]={cx:D.xd+D.dw/2,cy:cy+D.dh/2+20+D.wh/2+j*(D.wh+6),w:D.dw,h:D.wh}});
  return {p:p,H:H,th:th}}
function exitPt(c,dx,dy,px,py){var tx=dx?((dx>0?1:-1)*c.w/2-(px-c.cx))/dx:1e9,ty=dy?((dy>0?1:-1)*c.h/2-(py-c.cy))/dy:1e9,t=Math.max(0,Math.min(tx,ty));return[px+dx*t,py+dy*t]}
// ---- node cards
var DOT=function(f,c,r){return '<svg class="i" aria-hidden="true" width="'+r*2+'" height="'+r*2+'" viewBox="0 0 '+r*2+' '+r*2+'"><circle cx="'+r+'" cy="'+r+'" r="'+(f?r:r-1)+'" '+(f?'fill="var('+c+')"':'fill="none" stroke="var('+c+')" stroke-width="2"')+'/></svg>'};
function stline(n){var st=String(n.state||''),d=String(n.detail||'');return !d||d===st?st:d.indexOf(st)===0?d:st+' · '+d}
function cardHtml(n,c,s){
  var st=n.state,cls='',inner='';
  var live=st==='active'||st==='alive',bad=st==='undelivered'||st==='dead',dash=st==='idle'||st==='parked'||st==='orphaned';
  if(n.kind==='service'){var sv=s.service||{};cls='svc';
    inner='<svg class="i" aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--ok)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg><span class="tx"><b class="t">Service socket</b><span>service.sock · '+esc(sv.socket_ms!=null?sv.socket_ms:'–')+' ms</span><span>'+esc((sv.threads|0)+' threads · up '+dur(sv.up_s))+'</span></span>'}
  else if(n.kind==='desk'){inner=DOT(1,live||st==='active'?'--ok':'--idle',5)+'<span class="tx"><b class="t">Front desk</b><span>main · English to you</span><span>'+esc(n.detail||st)+'</span></span>'}
  else if(n.kind==='hooks'){cls='hk';inner='<svg class="i" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--req)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v6a3 3 0 0 0 6 0V3"/><path d="M12 12v9"/></svg><span class="tx"><b style="font-size:14px">Hooks</b><span>tool calls · '+esc(n.per_min!=null?n.per_min:parseInt(n.detail,10)||0)+' a min</span></span>'}
  else if(n.kind==='thread'){cls=bad?'bad':live?'live':dash?'dash':'';
    inner=DOT(live||bad||st==='active'?1:st==='done'?1:0,bad?'--bad':live?'--ok':st==='done'?'--rep':'--idle',5)+'<span class="tx"><span><b class="mono">'+esc(n.id)+'</b> '+esc(clip(n.label===n.id?'':n.label,26))+'</span><span>'+esc(stline(n))+'</span></span>'}
  else{cls='wk '+(bad?'bad':live?'live':dash?'dash':'');
    inner='<span class="tx"><span><b class="mono">'+esc(n.label)+'</b></span><span>'+esc((n.model||'worker')+' · '+dur(n.age_s))+'</span><span>'+esc(st==='done'?'done · result ready':st+(n.progress_s!=null&&live?' · '+dur(n.progress_s)+' ago':''))+'</span></span>'}
  return '<div class="nd '+cls+(selId===n.id?' sel':'')+'" tabindex="0" role="button" data-id="'+esc(n.id)+'" aria-label="'+esc(n.kind+' '+(n.label||n.id)+', '+stline(n))+'" style="left:'+(c.cx-c.w/2)+'px;top:'+(c.cy-c.h/2)+'px;width:'+c.w+'px;height:'+c.h+'px">'+inner+'</div>'}
// ---- edges
function edgeSvg(s,p,W,H){
  var o=['<svg class="edges" width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'" aria-hidden="true"><defs>'];
  Object.keys(KC).forEach(function(k){o.push('<marker id="a-'+k+'" orient="auto" markerWidth="6" markerHeight="6" refX="2" refY="2" overflow="visible"><path d="M0 0L4 2L0 4z" style="fill:var('+KC[k]+')"/></marker>')});
  o.push('</defs>');
  var groups={},list=[];
  (s.edges||[]).forEach(function(e){if(!p[e.from]||!p[e.to])return;var k=[e.from,e.to].sort().join('|');(groups[k]=groups[k]||[]).push(e);list.push(e)});
  var nIdle=list.filter(function(e){return e.kind==='idle'&&!e.bad}).length;
  Object.keys(groups).forEach(function(k){var g=groups[k];g.forEach(function(e,i){
    var a=p[e.from],b=p[e.to],dx=b.cx-a.cx,dy=b.cy-a.cy,L=Math.sqrt(dx*dx+dy*dy)||1,off=(i-(g.length-1)/2)*16,ids=[e.from,e.to].sort(),c0=p[ids[0]],c1=p[ids[1]],cx=c1.cx-c0.cx,cy=c1.cy-c0.cy,CL=Math.sqrt(cx*cx+cy*cy)||1,ox=-cy/CL*off,oy=cx/CL*off;
    var q1=exitPt(a,dx,dy,a.cx+ox,a.cy+oy),q2=exitPt(b,-dx,-dy,b.cx+ox,b.cy+oy);
    var kd=e.bad?'bad':KC[e.kind]?e.kind:'idle',idle=kd==='idle',age=(e.age_s||0),col='var('+KC[kd]+')';
    o.push('<line data-age="'+age+'" data-idle="'+(idle?1:0)+'" x1="'+q1[0].toFixed(1)+'" y1="'+q1[1].toFixed(1)+'" x2="'+q2[0].toFixed(1)+'" y2="'+q2[1].toFixed(1)+'" stroke-width="'+(idle?1.5:2)+'" stroke-linecap="round" style="stroke:'+col+'"'+(idle?' stroke-dasharray="6 6" opacity=".6"':' marker-end="url(#a-'+kd+')" opacity="'+Math.max(.3,1-.7*Math.min(age,30)/30).toFixed(2)+'"')+'/>');
    if(e.label&&(!idle||nIdle<=4))o.push('<text class="elabel" x="'+((q1[0]+q2[0])/2).toFixed(1)+'" y="'+((q1[1]+q2[1])/2-6).toFixed(1)+'" text-anchor="middle" style="fill:'+(idle?'var(--mu)':kd==='request'?'var(--reqtx)':col)+'">'+esc(clip(e.label,28))+'</text>')})});
  o.push('<g id="pl"></g></svg>');return o.join('')}
// ---- render
function render(){
  var s=SNAP,wrap=$('wrap'),cw=wrap.clientWidth||600,wide=cw>=1000,D=dims(wide),sc=Math.min(cw/D.W,wide?1:1.6);
  rcv=Date.now();chips(s);
  if(!s.service||!s.service.up||!(s.nodes||[]).length){
    wrap.style.height='120px';wrap.innerHTML='<div style="padding:40px 0;text-align:center;color:var(--mu);font-size:15px">Service not running · inbox '+(s.inbox|0)+'</div>';P={};return}
  var act=document.activeElement,keep=act&&act.getAttribute&&act.getAttribute('data-id'),L=layout(s,D),byid={};
  (s.nodes||[]).forEach(function(n){byid[n.id]=n});P=L.p;
  var h=[edgeSvg(s,L.p,D.W,L.H)];
  Object.keys(L.p).forEach(function(id){if(byid[id])h.push(cardHtml(byid[id],L.p[id],s))});
  if((s.more|0)>0)h.push('<div id="more" style="left:'+(D.xt)+'px;top:'+(L.H-18)+'px;width:'+D.tw+'px;text-align:center">+'+(s.more|0)+' more</div>');
  wrap.style.height=Math.ceil((L.H)*sc)+'px';
  wrap.innerHTML='<div id="stage" style="width:'+D.W+'px;height:'+L.H+'px;transform:scale('+sc+')">'+h.join('')+'</div>';
  if(keep){var el=wrap.querySelector('[data-id="'+keep.replace(/"/g,'')+'"]');if(el)try{el.focus({preventScroll:true})}catch(e){}}
  if(selId)fillPanel()}
function chips(s){var sv=s.service||{},w=0;(s.nodes||[]).forEach(function(n){if(n.kind==='worker'&&(n.state==='alive'||n.state==='orphaned'))w++});
  $('sub').textContent='lean-agent'+(sv.version?' '+sv.version:'')+' · service socket · updates as messages move';
  $('ms').textContent=sv.socket_ms!=null&&sv.up?' · '+sv.socket_ms+' ms':'';
  $('cpu').textContent='Service CPU '+(sv.cpu_pct!=null?Math.round(sv.cpu_pct):'–')+'%';
  $('wk').textContent=w+(w===1?' worker':' workers');
  var ib=$('inbox');ib.textContent='Inbox '+(s.inbox|0);ib.className='pill'+((s.inbox|0)>0?' warn':'')}
// ---- details panel
function fillPanel(){
  var s=SNAP,n=null;(s.nodes||[]).forEach(function(x){if(x.id===selId)n=x});
  if(!n){closePanel();return}
  var r=[],sk={id:1,kind:1,label:1,state:1,detail:1,per_min:1,placed:1};
  function row(k,v){if(v==null||v==='')return;r.push('<dt>'+esc(k)+'</dt><dd>'+esc(v)+'</dd>')}
  row('Kind',n.kind);row('Id',n.id);row('Label',n.label);row('State',n.state);row('Detail',n.detail);
  if(n.parent)row('Parent thread',n.parent);if(n.model)row('Model',n.model);
  if(n.age_s!=null&&n.kind==='worker')row('Running for',dur(n.age_s));if(n.progress_s!=null)row('Last progress',dur(n.progress_s)+' ago');
  if(n.ended_s!=null)row('Ended',dur(n.ended_s)+' ago');if(n.kind==='thread'){row('Quiet for',dur(n.idle_s));row('Mid-turn',n.mid?'yes':'no')}
  if(n.per_min!=null)row('Tool calls a min',n.per_min);
  if(n.kind==='service'){var sv=s.service||{};row('Version',sv.version);row('Process',sv.pid);row('CPU',sv.cpu_pct!=null?sv.cpu_pct+' %':'');row('Socket latency',sv.socket_ms!=null?sv.socket_ms+' ms':'');row('Threads',sv.threads);row('Up',dur(sv.up_s))}
  if(n.kind==='desk'){row('Inbox',s.inbox|0);row('Paused',s.paused?'yes':'no')}
  var el=[],now=(Date.now()-rcv)/1000;
  (s.edges||[]).forEach(function(e){if(e.from!==n.id&&e.to!==n.id)return;
    el.push('<li>'+esc((e.from===n.id?'to ':'from ')+(e.from===n.id?e.to:e.from)+' · '+e.kind+(e.label?' · '+e.label:'')+' · '+dur((e.age_s||0)+now)+' ago'+(e.bad?' · stuck':''))+'</li>')});
  var ml=[];(s.moving||[]).forEach(function(m){if(m.node===n.id)ml.push('<li>'+esc(m.text+' · '+dur((m.age_s||0)+now)+' ago')+'</li>')});
  var pn=$('panel');
  pn.innerHTML='<button type="button" class="x" id="px" aria-label="Close details">Close</button><h2>'+esc(n.label||n.id)+'</h2><dl>'+r.join('')+'</dl>'
    +'<h3>Lines</h3>'+(el.length?'<ul>'+el.join('')+'</ul>':'<div style="color:var(--mu)">none</div>')
    +(ml.length?'<h3>Recent messages</h3><ul>'+ml.join('')+'</ul>':'');
  pn.className='open';pn.setAttribute('aria-label','Details of '+(n.label||n.id));$('px').onclick=closePanel}
function openPanel(id){selId=id;fillPanel();var m=$('wrap').querySelectorAll('.nd');for(var i=0;i<m.length;i++)m[i].classList.toggle('sel',m[i].getAttribute('data-id')===id);var x=$('px');if(x)x.focus()}
function closePanel(){var id=selId;selId=null;$('panel').className='';$('panel').innerHTML='';var m=$('wrap').querySelectorAll('.nd.sel');for(var i=0;i<m.length;i++)m[i].classList.remove('sel');
  if(id){var el=$('wrap').querySelector('[data-id="'+String(id).replace(/"/g,'')+'"]');if(el)try{el.focus({preventScroll:true})}catch(e){}}}
$('wrap').addEventListener('click',function(e){var t=e.target.closest&&e.target.closest('.nd');if(t)openPanel(t.getAttribute('data-id'))});
$('wrap').addEventListener('keydown',function(e){if((e.key==='Enter'||e.key===' ')&&e.target.classList&&e.target.classList.contains('nd')){e.preventDefault();openPanel(e.target.getAttribute('data-id'))}});
document.addEventListener('keydown',function(e){if(e.key==='Escape'&&selId)closePanel()});
$('pause').addEventListener('click',function(){paused=!paused;this.textContent=paused?'Resume':'Pause';this.setAttribute('aria-label',paused?'Resume live updates':'Pause live updates');paint();
  if(!paused){pulses=[];if(pendingSnap){SNAP=pendingSnap;pendingSnap=null;render()}}});
var rt=0;window.addEventListener('resize',function(){clearTimeout(rt);rt=setTimeout(function(){if(!paused&&mode!=='img')render()},150)});
function apply(d){if(paused){pendingSnap=d;return}SNAP=d;render()}
setInterval(function(){if(paused)return;var n=(Date.now()-rcv)/1000,ls=document.querySelectorAll('#stage line[data-age]');
  for(var i=0;i<ls.length;i++){if(ls[i].getAttribute('data-idle')==='1')continue;var a=+ls[i].getAttribute('data-age')+n;ls[i].setAttribute('opacity',Math.max(.3,1-.7*Math.min(a,30)/30).toFixed(2))}},1000);
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
    else if(d.type==='event')pulse(d.from,d.to)};
  ws.onerror=function(){if(!open)codes.push('WebSocket error')};
  ws.onclose=function(ev){
    if(!open){codes.push('WebSocket closed '+(ev&&ev.code))}
    if(!gotLive)return fallback('poll');
    if(open)fails=0;else fails++;
    if(fails>=4){stopped=true;chip('service restarted - run lean-agent map --url again','bad');return}
    chip('reconnecting','re');setTimeout(connect,delay);delay=Math.min(15000,delay*2)}}
var tried={};
function fallback(next){
  if(stopped||tried[next])return;tried[next]=1;
  if(next==='poll')return pollFetch();
  if(next==='img')return pollImg();
  blocked()}
function blocked(){
  mode='none';
  var l=base&&!/^https?:/.test(location.protocol)?' <a href="'+base+'/?'+tq+'" target="_blank" rel="noopener">Open in browser</a>':'';
  if(viol.length){chip('preview blocks live updates','bad');why(reason()+l)}
  else{chip('snapshot (service not running)','bad');why((reason()||'connection refused on every transport')+l)}}
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
render();
if(EP&&EP.port){chip('connecting','re');connect()}else chip('snapshot (service not running)','bad');
})();
"""

PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>lean-agent live map</title><style>%CSS%</style></head><body><div id="app">
<header><div><h1>Live map</h1><div id="sub">lean-agent · service socket · updates as messages move</div></div>
<div id="chips"><span class="pill" id="pill"><span class="dot"></span><span id="chip">snapshot (service not running)</span><span id="ms"></span></span>
<span class="pill" id="cpu">Service CPU –%</span><span class="pill" id="wk">0 workers</span><span class="pill" id="inbox">Inbox 0</span>
<button type="button" id="pause" aria-label="Pause live updates">Pause</button></div></header>
<div id="why"></div>
<div id="wrap"></div>
<footer><div id="legend">
<span><svg aria-hidden="true" width="28" height="8" viewBox="0 0 28 8"><path d="M 0 4 L 22 4" stroke="var(--ok)" stroke-width="2" stroke-linecap="round"/><path d="M20 0 L28 4 L20 8 Z" fill="var(--ok)"/></svg>Message to an agent</span>
<span><svg aria-hidden="true" width="28" height="8" viewBox="0 0 28 8"><path d="M 6 4 L 28 4" stroke="var(--rep)" stroke-width="2" stroke-linecap="round"/><path d="M8 0 L0 4 L8 8 Z" fill="var(--rep)"/></svg>Report or result back</span>
<span><svg aria-hidden="true" width="28" height="8" viewBox="0 0 28 8"><path d="M 0 4 L 22 4" stroke="var(--req)" stroke-width="2" stroke-linecap="round"/><path d="M20 0 L28 4 L20 8 Z" fill="var(--req)"/></svg>Socket request</span>
<span><svg aria-hidden="true" width="28" height="8" viewBox="0 0 28 8"><path d="M 0 4 L 28 4" stroke="var(--idle)" stroke-width="2" stroke-dasharray="6 6"/></svg>Idle link</span>
<span><svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="var(--bad)"/></svg>Undelivered or stuck</span>
</div><span>Lines fade 30 s after the last message · click a node for details</span></footer></div>
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


def write_html(home, snap, out=None):
    """Writes the page (file 0600, default dir 0700) and returns its absolute path."""
    if out:
        p = os.path.abspath(os.path.expanduser(out))
        os.makedirs(os.path.dirname(p), exist_ok=True)
    else:
        d = os.path.join(home, "map")
        os.makedirs(d, exist_ok=True)
        os.chmod(d, 0o700)
        p = os.path.join(d, "live.html")
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
