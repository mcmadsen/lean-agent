#!/usr/bin/env python3
"""The one interactive orchestrator session that `lean-agent up` hosts, and the way to talk to it.

`up` runs `claude` in a pseudo-terminal it owns (Host below) and serves a unix socket,
~/.lean-agent/session.sock (mode 0600), or /tmp/lean-agent-<uid>/<digest>.sock when that path is too
long for a unix socket. Other lean-agent processes import this module:

    send(text)   type a message into the session (bracketed paste + Enter) -> (ok, error)
    keys(k)      send raw keys, e.g. "esc" (interrupt), "enter", "ctrl-c", or any string -> (ok, error)
    alive()      True when the bridge answers and the session process runs
    info()       the session fields of ~/.lean-agent/up.json: session_id, transcript, pid, ...

Socket protocol: one JSON object per connection, newline-terminated; one JSON line back.
    {"text": "..."}   paste (ESC[200~ text ESC[201~), then "\\r"      -> {"ok": true}
    {"keys": "..."}   raw keys written as they are                   -> {"ok": true}
    {"ping": true}    -> {"ok": true, "alive": bool, "pid": int}
    {"tail": true}    -> {"ok": true, "text": "<last output of the session>"}
    anything wrong    -> {"ok": false, "error": "..."}
"""
import collections
import hashlib
import json
import os
import re
import signal
import socket
import stat
import subprocess
import sys
import threading
import time

PASTE_START, PASTE_END = b"\x1b[200~", b"\x1b[201~"
KEY_NAMES = {"esc": "\x1b", "escape": "\x1b", "enter": "\r", "return": "\r", "tab": "\t", "ctrl-c": "\x03",
             "ctrl-d": "\x04", "up": "\x1b[A", "down": "\x1b[B", "right": "\x1b[C", "left": "\x1b[D",
             "backspace": "\x7f"}
TAIL_BYTES = 64 * 1024
QUICK_EXIT = 20  # seconds: a session that dies sooner than this is not restarted (the service manager decides)
PARENT_SESSION_VARS = re.compile(r"^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_(SESSION_ID|ENTRYPOINT|CHILD_SESSION|REMOTE\w*|"
                                 r"MESSAGING_\w+|SSE_PORT|WORKER_EPOCH|TEE_SDK_STDOUT|SESSION_ATTENDED|"
                                 r"SESSION_ACCESS_TOKEN|CONTAINER_ID))$")


def lean_home(*parts):
    return os.path.join(os.path.abspath(os.path.expanduser(os.environ.get("LEAN_AGENT_HOME") or "~/.lean-agent")), *parts)


SOCK_MAX = 100  # AF_UNIX paths are limited to 104 bytes (macOS) / 108 (Linux)


FALLBACK_ROOT = "/tmp"


def fallback_dir():
    return os.path.join(FALLBACK_ROOT, f"lean-agent-{os.getuid()}")


def sock_path():
    """<home>/session.sock, or a short private path when that is too long for AF_UNIX."""
    path = lean_home("session.sock")
    if len(os.fsencode(path)) <= SOCK_MAX:
        return path
    d = fallback_dir()
    try:
        os.mkdir(d, 0o700)
    except FileExistsError:
        pass
    st = os.lstat(d)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) != 0o700:
        raise RuntimeError(f"{d} must be a directory owned by you with mode 0700; remove or fix it")
    digest = hashlib.sha256(os.fsencode(os.path.realpath(lean_home()))).hexdigest()[:12]
    return os.path.join(d, digest + ".sock")


def client_sock_path():
    """The socket `up` recorded in up.json, else sock_path()."""
    rec = _load(up_path()).get("socket")
    return rec if isinstance(rec, str) and rec else sock_path()


def up_path():
    return lean_home("up.json")


def supported():
    try:
        import pty  # noqa: F401
        return hasattr(socket, "AF_UNIX")
    except ImportError:
        return False


def project_slug(cwd):
    """Claude Code names a project's transcript folder after its cwd: every non-alphanumeric char becomes '-'."""
    return re.sub(r"[^A-Za-z0-9]", "-", cwd)


def transcript_path(cwd, session_id):
    cfg = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    return os.path.join(cfg, "projects", project_slug(os.path.realpath(cwd)), session_id + ".jsonl")


def _load(path):
    try:
        with open(path) as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def update_up(**fields):
    """Merge fields into up.json (written by `up`; the dashboard and hooks read it)."""
    data = _load(up_path())
    data.update(fields)
    os.makedirs(os.path.dirname(up_path()), exist_ok=True)
    tmp = up_path() + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(data, fh, indent=2)
    os.replace(tmp, up_path())


# ---------------------------------------------------------------- client

def request(msg, timeout=5):
    """Send one message to the bridge; the reply dict, or {"ok": False, "error": ...} (never raises)."""
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    except (OSError, AttributeError) as exc:
        return {"ok": False, "error": f"no session bridge ({exc})"}
    try:
        s.settimeout(timeout)
        s.connect(client_sock_path())
        s.sendall(json.dumps(msg).encode() + b"\n")
        s.shutdown(socket.SHUT_WR)
        buf = b""
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
        reply = json.loads(buf.decode("utf-8", "replace") or "null")
        return reply if isinstance(reply, dict) else {"ok": False, "error": "bad reply"}
    except (OSError, ValueError, RuntimeError) as exc:
        return {"ok": False, "error": f"no session bridge ({exc})"}
    finally:
        s.close()


def send(text):
    r = request({"text": text})
    return bool(r.get("ok")), r.get("error", "")


def keys(k):
    r = request({"keys": k})
    return bool(r.get("ok")), r.get("error", "")


def alive():
    r = request({"ping": True}, timeout=2)
    return bool(r.get("ok") and r.get("alive"))


def tail():
    return request({"tail": True}).get("text", "")


def info():
    """session_id, transcript, pid, remote_control, ... from up.json ({} when `up` never ran)."""
    up = _load(up_path())
    return {k: up[k] for k in ("session_id", "transcript", "pid", "host_pid", "remote_control", "socket",
                               "session_started") if k in up}


# ---------------------------------------------------------------- host (inside `up`)

def child_env(env):
    out = {k: v for k, v in env.items() if not PARENT_SESSION_VARS.match(k)}
    out["LEAN_AGENT_SERVICE_SESSION"] = "1"
    out.setdefault("TERM", "xterm-256color")
    return out


class Host:
    """Runs `cmd` in a pty this object owns, drains its output, restarts it when it dies, serves the socket."""

    def __init__(self, build_cmd, env, cwd, remote_control=False, on_text=None, on_stale=None):
        self.build_cmd = build_cmd  # () -> (argv, session_id): resume or start by whether the transcript exists
        self.env, self.cwd = child_env(env), cwd
        self.remote_control = remote_control
        self.on_text, self.on_stale = on_text, on_stale
        self.proc = None
        self.master = None
        self.tail = collections.deque()
        self.tail_len = 0
        self.lock = threading.Lock()   # the buffer
        self.write_lock = threading.RLock()  # one message into the pty at a time
        self.stopping = threading.Event()
        self.reason = None
        self.server = None
        self.mirror = sys.stdout.isatty() and sys.stdin.isatty()
        self.log = None

    # -- output
    def _remember(self, raw):
        with self.lock:
            self.tail.append(raw)
            self.tail_len += len(raw)
            while self.tail_len > TAIL_BYTES and len(self.tail) > 1:
                self.tail_len -= len(self.tail.popleft())

    def tail_text(self):
        with self.lock:
            return b"".join(self.tail).decode("utf-8", "replace")[-TAIL_BYTES:]

    def _pump(self, master):
        while True:
            try:
                raw = os.read(master, 8192)
            except OSError:  # the pty closes when the session exits
                break
            if not raw:
                break
            self._remember(raw)
            if self.log:
                try:
                    self.log.write(raw)
                    self.log.flush()
                except (OSError, ValueError):
                    pass
            if self.mirror:
                try:
                    sys.stdout.buffer.write(raw)
                    sys.stdout.buffer.flush()
                except (OSError, ValueError):
                    pass
            if self.on_text:
                try:
                    self.on_text(raw.decode("utf-8", "replace"), self)
                except Exception:
                    pass

    # -- input
    def write(self, data):
        if not self.alive():
            raise OSError("session not running")
        with self.write_lock:
            os.write(self.master, data)

    def paste(self, text):
        text = text.replace(PASTE_END.decode(), "")
        with self.write_lock:  # RLock: write() below takes it again
            self.write(PASTE_START + text.encode() + PASTE_END)
            time.sleep(0.15)  # let the input box take the paste before Enter
            self.write(b"\r")

    def alive(self):
        return self.proc is not None and self.proc.poll() is None and self.master is not None

    # -- socket
    def _handle(self, conn):
        try:
            conn.settimeout(5)
            buf = b""
            while b"\n" not in buf and len(buf) < (4 << 20):
                chunk = conn.recv(65536)
                if not chunk:
                    break
                buf += chunk
            try:
                msg = json.loads(buf.decode("utf-8", "replace"))
                if not isinstance(msg, dict):
                    raise ValueError
            except ValueError:
                reply = {"ok": False, "error": "expected one JSON object"}
            else:
                reply = self.dispatch(msg)
            conn.sendall(json.dumps(reply).encode() + b"\n")
        except OSError:
            pass
        finally:
            conn.close()

    def dispatch(self, msg):
        try:
            if msg.get("ping"):
                return {"ok": True, "alive": self.alive(), "pid": self.proc.pid if self.proc else None}
            if msg.get("tail"):
                return {"ok": True, "text": self.tail_text()}
            if isinstance(msg.get("text"), str):
                self.paste(msg["text"])
                return {"ok": True}
            if isinstance(msg.get("keys"), str):
                k = msg["keys"]
                self.write(KEY_NAMES.get(k.lower(), k).encode())
                return {"ok": True}
        except OSError as exc:
            return {"ok": False, "error": str(exc)}
        return {"ok": False, "error": 'expected {"text": ...}, {"keys": ...}, {"ping": true} or {"tail": true}'}

    def serve(self):
        path = sock_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if os.path.exists(path):
            if alive():
                raise RuntimeError(f"another session bridge answers on {path} (is another `lean-agent up` running?)")
            os.remove(path)
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        old = os.umask(0o177)
        try:
            srv.bind(path)
        finally:
            os.umask(old)
        os.chmod(path, 0o600)
        srv.listen(8)
        srv.settimeout(0.5)
        self.server = srv

        def loop():
            while not self.stopping.is_set():
                try:
                    conn, _ = srv.accept()
                except socket.timeout:
                    continue
                except OSError:
                    break
                threading.Thread(target=self._handle, args=(conn,), daemon=True).start()
        threading.Thread(target=loop, daemon=True).start()

    # -- the process
    def _spawn(self):
        import fcntl
        import pty
        import struct
        import termios
        argv, sid = self.build_cmd()
        master, slave = pty.openpty()
        try:
            size = fcntl.ioctl(sys.stdout.fileno(), termios.TIOCGWINSZ, b"\0" * 8) if self.mirror else None
        except OSError:
            size = None
        fcntl.ioctl(master, termios.TIOCSWINSZ, size or struct.pack("HHHH", 50, 200, 0, 0))
        try:  # before the spawn, so a fast SessionStart hook of the new session is not deleted
            os.remove(lean_home("chat", "service.json"))  # the previous session's record is stale
        except OSError:
            pass
        update_up(pid=None, session_started=time.strftime("%Y-%m-%dT%H:%M:%S"))
        try:
            proc = subprocess.Popen(argv, env=self.env, cwd=self.cwd, stdin=slave, stdout=slave, stderr=slave,
                                    start_new_session=True)
        finally:
            os.close(slave)  # only the session holds it now, so reading ends when it exits
        self.proc, self.master = proc, master
        update_up(session_id=sid, transcript=transcript_path(self.cwd, sid), pid=proc.pid, host_pid=os.getpid(),
                  remote_control=self.remote_control, socket=sock_path())
        t = threading.Thread(target=self._pump, args=(master,), daemon=True)
        t.start()
        return t

    def _forward_terminal(self):
        """When `up` runs in a terminal, the user's keys go to the session too (the screen is mirrored)."""
        import select
        while not self.stopping.is_set():
            try:
                ready, _, _ = select.select([sys.stdin.fileno()], [], [], 0.5)
                if ready:
                    data = os.read(sys.stdin.fileno(), 4096)
                    if not data:
                        break
                    if self.alive():
                        with self.write_lock:
                            os.write(self.master, data)
            except (OSError, ValueError):
                break

    def stop(self):
        """Ask the session to end (safe inside a signal handler): run() returns once it has."""
        self.stopping.set()
        proc = self.proc
        if proc and proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except OSError:
                proc.terminate()
            killer = threading.Timer(15, lambda: proc.poll() is None and proc.kill())
            killer.daemon = True
            killer.start()

    def close(self):
        if self.server:
            try:
                self.server.close()
            except OSError:
                pass
            self.server = None
            try:
                os.remove(sock_path())
            except OSError:
                pass

    def terminate_for(self, reason):
        self.reason = reason
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()

    def run(self):
        """Serve the bridge and keep the session running until stopped. Returns the exit code of a session that
        died soon after starting (a start that fails), else keeps restarting it."""
        os.makedirs(lean_home("logs"), exist_ok=True)
        logpath = lean_home("logs", "session.log")
        if os.path.exists(logpath) and os.path.getsize(logpath) > (1 << 20):
            os.replace(logpath, logpath + ".1")
        self.log = open(logpath, "ab")
        self.serve()
        restore = None
        if self.mirror:
            try:
                import termios
                import tty
                saved = termios.tcgetattr(sys.stdin.fileno())
                tty.setraw(sys.stdin.fileno())
                restore = lambda: termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, saved)  # noqa: E731
                threading.Thread(target=self._forward_terminal, daemon=True).start()
            except (ImportError, OSError):
                self.mirror = False
        stale_done = False
        try:
            while not self.stopping.is_set():
                started = time.time()
                self.reason = None
                pump = self._spawn()
                rc = self.proc.wait()
                pump.join(timeout=2)
                try:
                    os.close(self.master)
                except OSError:
                    pass
                self.master = None
                if self.stopping.is_set():
                    return 0
                if self.reason == "stale" and not stale_done:
                    stale_done = True
                    if self.on_stale:
                        self.on_stale()
                    continue
                if time.time() - started < float(os.environ.get("LEAN_AGENT_SESSION_QUICK_EXIT") or QUICK_EXIT):
                    return rc
                time.sleep(2)
            return 0
        finally:
            if restore:
                restore()
            self.close()
            if self.log:
                self.log.close()
