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

import lean_log
import usage

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


def drop_stale_record(cwd, sid):
    """A new conversation makes the old service.json and its chain stale: removed before the spawn, so a fast
    SessionStart hook of the new session is not deleted. A restart after a /clear, before the new transcript exists,
    keeps it: it goes only when no transcript of its chain exists at all (`up --fresh` removes it itself)."""
    if os.path.exists(transcript_path(cwd, sid)):
        return
    rec = _load(lean_home("chat", "service.json"))
    chain = rec.get("chain") if isinstance(rec.get("chain"), list) else []
    known = [p for p in [rec.get("transcript_path"), *chain] if isinstance(p, str) and p]
    if any(os.path.exists(p) for p in known):
        return
    try:
        os.remove(lean_home("chat", "service.json"))
    except OSError:
        pass


def _load(path):
    try:
        with open(path) as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def chain_meta(rec):
    """The when-and-why of each transcript in the hook's record `rec` (chat/service.json), the current one included."""
    meta = dict(rec["chain_meta"]) if isinstance(rec.get("chain_meta"), dict) else {}
    if rec.get("transcript_path") and rec["transcript_path"] not in meta:
        meta[rec["transcript_path"]] = {"source": rec.get("source"), "ts": rec.get("ts")}
    return meta


def last_clear(rec):
    """When the session of the record `rec` was last cleared (epoch seconds, None when it never was)."""
    times = [m["ts"] for m in chain_meta(rec).values() if isinstance(m, dict) and m.get("source") == "clear"
             and _num(m.get("ts"))]
    return max(times) if times else None


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


# ---------------------------------------------------------------- auto clear (inside `up`)

CLEAR_AT = 40000       # tokens of context after a finished turn above which the session is cleared (0 = off)
CLEAR_PROMPT = "Checkpoint now: run lean-agent checkpoint with your soft state, then reply 'checkpointed'"
CLEAR_WAIT = 120       # seconds to wait for the checkpoint before clearing anyway
CLEAR_GAP = 600        # seconds between two clears
CLEAR_IDLE = 30        # seconds since the user last typed
TAIL_READ = 512 * 1024  # how much of the transcript's end is read


def clear_at():
    """The threshold: LEAN_AGENT_CLEAR_AT, else `lean-agent config clear-at N`, else 40000."""
    raw = os.environ.get("LEAN_AGENT_CLEAR_AT")
    if raw is None or not raw.strip().isdigit():
        raw = _load(lean_home("config.json")).get("clear_at")
    try:
        return max(0, int(raw))
    except (TypeError, ValueError):
        return CLEAR_AT


def _knob(name, default):
    try:
        return float(os.environ.get(name) or default)
    except ValueError:
        return default


def transcript_state(path, offset=0):
    """What the transcript at `path` (read from byte `offset`, else its last 512 KB) shows now:
    {"ended": the last message is the assistant's final one (no tool running), "ctx": tokens in the last usage
    record, "text": that final message's text, "user_ts": epoch of the last user record, "size": file size}."""
    state = {"ended": False, "ctx": 0, "text": "", "user_ts": 0.0, "size": 0}
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            state["size"] = size = fh.tell()
            start = offset if offset else max(0, size - TAIL_READ)
            fh.seek(start)
            data = fh.read()
    except OSError:
        return state
    lines = data.split(b"\n")
    if start and not offset:
        lines = lines[1:]  # the first line is probably cut
    last = None
    for raw in lines:
        try:
            rec = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(rec, dict):
            continue
        msg = rec.get("message") if isinstance(rec.get("message"), dict) else {}
        kind = rec.get("type")
        if kind == "assistant":
            u = msg.get("usage") if isinstance(msg.get("usage"), dict) else {}
            ctx = usage.context_tokens(u)
            if ctx:
                state["ctx"] = ctx
            last = rec
        elif kind == "user" and not rec.get("isMeta"):
            last = rec
            body = msg.get("content")
            if not isinstance(body, str) and not any(isinstance(c, dict) and c.get("type") == "text" for c in body or []):
                continue  # a tool result is not someone typing
            try:
                import datetime
                state["user_ts"] = datetime.datetime.fromisoformat(
                    str(rec.get("timestamp")).replace("Z", "+00:00")).timestamp()
            except ValueError:
                pass
        elif kind == "system" and rec.get("subtype") == "turn_duration" and last and last.get("type") == "assistant":
            last = dict(last, _ended=True)
    if last and last.get("type") == "assistant":
        msg = last.get("message") or {}
        content = msg.get("content") if isinstance(msg.get("content"), list) else []
        tools = any(isinstance(c, dict) and c.get("type") == "tool_use" for c in content)
        state["ended"] = not tools and (msg.get("stop_reason") == "end_turn" or bool(last.get("_ended")))
        state["text"] = "\n".join(c.get("text") or "" for c in content if isinstance(c, dict) and c.get("type") == "text")
    return state


def permission_pending(session_id):
    """True while a permission prompt (or AskUserQuestion) of this session waits for an answer."""
    d = lean_home("chat", "perm")
    try:
        names = os.listdir(d)
    except OSError:
        return False
    for n in names:
        if not n.endswith(".json") or n.endswith((".answer.json", ".moved.json")):
            continue
        base = os.path.join(d, n[:-5])
        if os.path.exists(base + ".answer.json") or os.path.exists(base + ".moved.json"):
            continue
        req = _load(base + ".json")
        try:
            fresh = time.time() - os.path.getmtime(base + ".json") < _knob("LEAN_AGENT_DASH_PERMISSION_WAIT", 300) + 60
        except OSError:
            continue
        if fresh and (not req.get("session_id") or not session_id or req["session_id"] == session_id):
            return True
    return False


class AutoClear:
    """Keeps the orchestrator's context small: after a finished turn that left the context above `clear_at()`, asks
    the session for a checkpoint, then types /clear (after its 'checkpointed' reply, or CLEAR_WAIT seconds). Never
    while a permission prompt waits, within CLEAR_IDLE seconds of the user typing, or within CLEAR_GAP of the last one."""

    def __init__(self, host, now=time.time):
        self.host, self.now = host, now
        self.started = None   # when the last checkpoint prompt went out
        self.waiting = None   # (transcript offset, when) once the prompt is out

    def transcript(self):
        rec = _load(lean_home("chat", "service.json"))
        return rec.get("transcript_path") or info().get("transcript") or ""

    def session_id(self):
        return _load(lean_home("chat", "service.json")).get("session_id") or info().get("session_id")

    def log(self, msg, level="debug"):
        lean_log.log(level, "auto-clear", msg)

    def last_gap_start(self):
        """When the last clear (or checkpoint request) happened: the record survives a restart of `up`."""
        return max(self.started or 0, last_clear(_load(lean_home("chat", "service.json"))) or 0)

    def blocked(self, st):
        idle = _knob("LEAN_AGENT_CLEAR_IDLE", CLEAR_IDLE)
        now = self.now()
        return (permission_pending(self.session_id()) or now - self.host.last_input < idle
                or (st["user_ts"] and now - st["user_ts"] < idle and not self.waiting))

    def tick(self):
        """One look at the session; at most one action."""
        if not self.host.alive():
            self.waiting = None
            return
        now = self.now()
        path = self.transcript()
        if self.waiting:
            offset, since = self.waiting
            st = transcript_state(path, offset)
            if permission_pending(self.session_id()) or now - self.host.last_input < _knob("LEAN_AGENT_CLEAR_IDLE", CLEAR_IDLE):
                return
            answered = st["ended"] and "checkpointed" in st["text"].lower()
            timed_out = now - since >= _knob("LEAN_AGENT_CLEAR_WAIT", CLEAR_WAIT)
            if timed_out and not answered and not st["ended"]:
                self.waiting = self.started = None  # a turn is still running: /clear would land in it; ask again at a turn end
                self.log("no reply in time and a turn is running: giving up this round")
                return
            if answered or timed_out:
                self.waiting = None
                self.log(f"/clear sent ({'checkpointed' if answered else 'no reply in time'})")
                self.host.paste("/clear")
            return
        limit = clear_at()
        if not limit or now - self.last_gap_start() < _knob("LEAN_AGENT_CLEAR_GAP", CLEAR_GAP):
            return
        st = transcript_state(path)
        if not st["ended"] or st["ctx"] <= limit or self.blocked(st):
            return
        self.started = now
        self.waiting = (st["size"], now)
        self.log(f"context {st['ctx']:,} tokens is above {limit:,}: asking for a checkpoint")
        self.host.paste(CLEAR_PROMPT)

    def run(self):
        poll = _knob("LEAN_AGENT_CLEAR_POLL", 2)
        while not self.host.stopping.is_set():
            try:
                self.tick()
            except Exception as exc:  # never take the session down
                self.log(f"error: {exc}", "error")
            self.host.stopping.wait(poll)


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
        self.last_input = 0.0  # when someone last typed into the session (the terminal, or a message sent to the bridge)

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
                self.last_input = time.time()
                self.paste(msg["text"])
                return {"ok": True}
            if isinstance(msg.get("keys"), str):
                self.last_input = time.time()
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
        drop_stale_record(self.cwd, sid)
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
                    self.last_input = time.time()
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
