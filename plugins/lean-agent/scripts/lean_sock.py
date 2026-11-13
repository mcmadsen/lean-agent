"""The service's local socket (<lean home>/service.sock): one JSON object per line in, one JSON line out.

Client side (`call`) is stdlib only and cheap to import (hooks use it): 0.3 s connect timeout, 2 s read timeout, any problem
returns None so the caller falls back to the file-based path. Server side (`Server`) runs in a thread inside `lean-agent up`;
every request is answered within 2 s and never blocks the service loop (a handler that is too slow gets an error reply).
"""
import hashlib
import json
import os
import signal
import socket
import socketserver
import stat
import struct
import sys
import threading
import time

CONNECT_TIMEOUT = 0.3
READ_TIMEOUT = 2.0
REQUEST_TIMEOUT = 2.0
MAX_LINE = 4 << 20
SOCK_MAX = 100  # AF_UNIX paths: 104 bytes (macOS) / 108 (Linux)
_logged = []


def home():
    return os.path.realpath(os.path.abspath(os.path.expanduser(os.environ.get("LEAN_AGENT_HOME") or "~/.lean-agent")))


def path():
    p = os.path.join(home(), "service.sock")
    if len(os.fsencode(p)) <= SOCK_MAX:
        return p
    return os.path.join("/tmp", f"lean-agent-{os.getuid()}", hashlib.sha256(os.fsencode(home())).hexdigest()[:12] + "-service.sock")


def _debug(why):
    if not _logged:
        _logged.append(why)
        if os.environ.get("LEAN_AGENT_DEBUG"):
            print(f"lean-agent: socket unavailable ({why}), using files", file=sys.stderr)


def call(op, timeout=READ_TIMEOUT, sock=None, **fields):
    """The reply dict ({"ok": true, ...}) or None when the socket does not answer (absent, stale, hung, refused). A reply
    with ok false is returned as is (the service answered: the caller decides)."""
    p = sock or path()
    if not sock and os.environ.get("LEAN_AGENT_NO_SOCKET"):
        return None
    s = None
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(CONNECT_TIMEOUT)
        s.connect(p)
        deadline = time.monotonic() + timeout
        s.settimeout(timeout)
        s.sendall(json.dumps({"op": op, **fields}).encode() + b"\n")
        buf = b""
        while b"\n" not in buf:
            left = deadline - time.monotonic()
            if left <= 0:
                raise socket.timeout("read timeout")
            s.settimeout(left)
            chunk = s.recv(65536)
            if not chunk:
                raise ConnectionError("closed")
            buf += chunk
            if len(buf) > MAX_LINE:
                raise ValueError("reply too long")
        reply = json.loads(buf.split(b"\n", 1)[0])
        return reply if isinstance(reply, dict) else None
    except (OSError, ValueError) as exc:
        _debug(type(exc).__name__)
        return None
    finally:
        if s is not None:
            try:
                s.close()
            except OSError:
                pass


CLI_OPS = ("now", "runs")
CLI_NOT = ("--lost", "--wait", "--clear", "--project", "-p")
CLI_ENV = ("LEAN_AGENT_SESSION_ROLE", "LEAN_AGENT_THREAD", "LEAN_AGENT_BRIEF", "LEAN_AGENT_CALLER_THREAD", "LEAN_AGENT_LOCK_TIMEOUT")


def cli_ok(argv):
    """True when `argv` (a `now` / `runs` command) may be answered by the service: read paths and --stop only."""
    return bool(argv) and argv[0] in CLI_OPS and not any(x in CLI_NOT or x.startswith("--project=") for x in argv[1:])


def cli(argv):
    """`now` / `runs` through the service: the exit code after printing its output, or None (run the file-based code)."""
    if not cli_ok(argv):
        return None
    env = {k: os.environ[k] for k in CLI_ENV if k in os.environ and k != "LEAN_AGENT_CALLER_THREAD"}
    r = call(argv[0], args=argv[1:], env=env)
    if not r or not r.get("ok") or "rc" not in r:
        return None
    sys.stdout.write(r.get("out") or "")
    if r.get("err"):
        sys.stderr.write(r["err"])
    try:
        sys.stdout.flush()
    except OSError:
        pass
    return r["rc"]


def state(timeout=1.0):
    """('listening', seconds) | ('stale', 0) | ('missing', 0): for `doctor`."""
    p = path()
    if not os.path.exists(p):
        return "missing", 0.0
    t0 = time.monotonic()
    r = call("ping", timeout=timeout)
    if r and r.get("ok"):
        return "listening", time.monotonic() - t0
    return "stale", 0.0


# ------------------------------------------------------------------ server

class Helper:
    """ONE persistent child process that runs the CLI commands the socket serves (`lean_agent.py __sockcli__`): it imports
    lean_agent once and handles one JSON request line at a time, so env/globals/stdout are its own and never the service's.
    A hung or dead helper is killed (its process group) and started again by the next request."""

    START_GRACE = 15.0  # a helper still importing after this long is killed too

    def __init__(self, script, timeout=REQUEST_TIMEOUT - 0.15):
        self.script, self.timeout = script, timeout
        self.lock = threading.Lock()
        self.proc = None
        self.ready = False
        self.buf = b""
        self.started = 0.0
        self.mtime = None

    def _mtime(self):
        try:
            return os.stat(self.script).st_mtime_ns
        except OSError:
            return None

    def _kill(self):
        p, self.proc, self.ready, self.buf = self.proc, None, False, b""
        if p is None:
            return
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except (OSError, ProcessLookupError):
            try:
                p.kill()
            except OSError:
                pass
        try:
            p.stdin.close()
            p.stdout.close()
            p.wait(timeout=1)
        except Exception:
            pass

    def _spawn(self):
        import subprocess
        self.mtime = self._mtime()
        self.proc = subprocess.Popen([sys.executable, self.script, "__sockcli__"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, start_new_session=True, cwd=home())
        self.ready, self.buf, self.started = False, b"", time.monotonic()

    def _line(self, deadline):
        import select
        while b"\n" not in self.buf:
            left = deadline - time.monotonic()
            if left <= 0:
                return None
            if not select.select([self.proc.stdout], [], [], left)[0]:
                return None
            chunk = os.read(self.proc.stdout.fileno(), 1 << 20)
            if not chunk:
                raise EOFError("helper ended")
            self.buf += chunk
        line, self.buf = self.buf.split(b"\n", 1)
        return line

    def warm(self):
        """Start the helper now (the service does, so the first request does not wait for the import)."""
        if self.lock.acquire(timeout=0.5):
            try:
                if self.proc is None or self.proc.poll() is not None:
                    self._kill()
                    self._spawn()
            finally:
                self.lock.release()

    def request(self, argv, env):
        """(rc, out, err); raises RuntimeError when the helper does not answer in time (it is killed unless it is still starting)."""
        deadline = time.monotonic() + self.timeout
        if not self.lock.acquire(timeout=self.timeout):
            raise RuntimeError("helper busy")
        try:
            if self.proc is not None and (self.proc.poll() is not None or self._mtime() != self.mtime):
                self._kill()  # died, or the script changed (sync): a fresh one
            if self.proc is None:
                self._spawn()
            try:
                if not self.ready:
                    line = self._line(deadline)
                    if line is None:
                        if time.monotonic() - self.started > self.START_GRACE:
                            self._kill()
                        raise RuntimeError("helper starting")
                    self.ready = True
                self.proc.stdin.write(json.dumps({"argv": argv, "env": env}).encode() + b"\n")
                self.proc.stdin.flush()
                line = self._line(deadline)
                if line is None:
                    self._kill()
                    raise RuntimeError("helper timeout")
                r = json.loads(line)
                return r["rc"], r["out"], r["err"]
            except (OSError, EOFError, ValueError, KeyError) as exc:
                self._kill()
                raise RuntimeError(f"helper failed: {exc}")
        finally:
            self.lock.release()

    def stop(self):
        with self.lock:
            self._kill()


def peer_uid(conn):
    """The connecting process's uid, or None when the OS gives no way to ask."""
    try:
        if hasattr(socket, "SO_PEERCRED"):
            _pid, uid, _gid = struct.unpack("3i", conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))
            return uid
        if sys.platform == "darwin":
            LOCAL_PEERCRED = 0x001  # <sys/un.h>; struct xucred { u_int cr_version; uid_t cr_uid; ... }
            data = conn.getsockopt(0, LOCAL_PEERCRED, 76)
            return struct.unpack("2I", data[:8])[1]
    except (OSError, AttributeError, ValueError, struct.error):
        return None
    return None


class _Handler(socketserver.StreamRequestHandler):
    def handle(self):
        srv = self.server.owner
        conn = self.request
        conn.settimeout(REQUEST_TIMEOUT)
        uid = peer_uid(conn)
        if uid is not None and uid != os.getuid():
            return self._reply({"ok": False, "error": "wrong user"})
        try:
            line = self.rfile.readline(MAX_LINE + 1)
            if not line.strip():
                return
            req = json.loads(line)
            if not isinstance(req, dict):
                raise ValueError("not an object")
        except (OSError, ValueError) as exc:
            return self._reply({"ok": False, "error": f"bad request: {exc}"})
        self._reply(srv.dispatch(req))

    def _reply(self, obj):
        try:
            self.wfile.write(json.dumps(obj).encode() + b"\n")
            self.wfile.flush()
        except OSError:
            pass


class _Srv(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    request_queue_size = 32


class Server:
    def __init__(self, handlers, sock=None, version="", on_stop=None):
        self.on_stop = on_stop
        self.handlers = dict(handlers)
        self.path = sock or path()
        self.version = version
        self.started = time.time()
        self.srv = None
        self.thread = None

    def dispatch(self, req):
        op = req.get("op")
        if op == "ping":
            return {"ok": True, "version": self.version, "pid": os.getpid(), "uptime": round(time.time() - self.started, 1)}
        fn = self.handlers.get(op)
        if not fn:
            return {"ok": False, "error": f"unknown op {op!r}"}
        box = {}

        def work():
            try:
                box["r"] = fn(req)
            except BaseException as exc:  # noqa: BLE001 - never leaks into the service
                box["r"] = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

        th = threading.Thread(target=work, daemon=True)
        th.start()
        th.join(REQUEST_TIMEOUT - 0.1)
        if th.is_alive():
            return {"ok": False, "error": "timeout"}
        r = box.get("r")
        if not isinstance(r, dict):
            return {"ok": False, "error": "bad reply"}
        r.setdefault("ok", True)
        return r

    def start(self):
        d = os.path.dirname(self.path)
        os.makedirs(d, exist_ok=True)
        try:
            os.chmod(d, 0o700)
        except OSError:
            pass
        if os.path.exists(self.path) or os.path.islink(self.path):
            if call("ping", timeout=0.5, sock=self.path):
                raise RuntimeError(f"another service answers on {self.path}")
            os.unlink(self.path)  # stale
        old = os.umask(0o177)
        try:
            self.srv = _Srv(self.path, _Handler)
        finally:
            os.umask(old)
        os.chmod(self.path, 0o600)
        self.srv.owner = self
        self.thread = threading.Thread(target=self.srv.serve_forever, kwargs={"poll_interval": 0.2}, daemon=True)
        self.thread.start()
        return self

    def stop(self):
        if self.on_stop:
            try:
                self.on_stop()
            except Exception:
                pass
        if self.srv:
            try:
                self.srv.shutdown()
                self.srv.server_close()
            except Exception:
                pass
            self.srv = None
        try:
            if stat.S_ISSOCK(os.lstat(self.path).st_mode):
                os.unlink(self.path)
        except OSError:
            pass
