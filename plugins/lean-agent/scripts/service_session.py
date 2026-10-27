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
import glob
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
import uuid

import lean_common
import lean_log
import usage

PASTE_START, PASTE_END = b"\x1b[200~", b"\x1b[201~"
KEY_NAMES = {"esc": "\x1b", "escape": "\x1b", "enter": "\r", "return": "\r", "tab": "\t", "ctrl-c": "\x03",
             "ctrl-d": "\x04", "up": "\x1b[A", "down": "\x1b[B", "right": "\x1b[C", "left": "\x1b[D",
             "backspace": "\x7f"}
TAIL_BYTES = 64 * 1024
ANSI_TAIL_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
SOCKET_WAIT = 15  # seconds a starting bridge waits for the previous `up` of the same home to let go of the socket
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


def sock_path(key="main"):
    """<home>/session.sock (a thread session: session-tN.sock), or a short private path when that is too long for AF_UNIX."""
    path = lean_home("session.sock" if key == "main" else f"session-{key}.sock")
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
    return os.path.join(d, digest + ("" if key == "main" else "-" + key) + ".sock")


def client_sock_path(key="main"):
    """The socket `up` recorded in up.json, else sock_path()."""
    up = _load(up_path())
    rec = up.get("socket") if key == "main" else (up.get("sessions") or {}).get(key, {}).get("socket")
    return rec if isinstance(rec, str) and rec else sock_path(key)


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


def service_record(key="main"):
    """The SessionStart hook's record for a hosted session."""
    return lean_home("chat", "service.json" if key == "main" else f"service-{key}.json")


def drop_stale_record(cwd, sid, key="main"):
    """A new conversation makes the old service.json and its chain stale: removed before the spawn, so a fast
    SessionStart hook of the new session is not deleted. A restart after a /clear, before the new transcript exists,
    keeps it: it goes only when no transcript of its chain exists at all (`up --fresh` removes it itself).
    The same holds when `up` starts a brand-new session id without --fresh (e.g. `up --clear`, or an up.json that
    was lost): the record stays as long as any transcript of its chain exists, so the record of earlier clears stays."""
    if os.path.exists(transcript_path(cwd, sid)):
        return
    rec = _load(service_record(key))
    chain = rec.get("chain") if isinstance(rec.get("chain"), list) else []
    known = [p for p in [rec.get("transcript_path"), *chain] if isinstance(p, str) and p]
    if any(os.path.exists(p) for p in known):
        return
    try:
        os.remove(service_record(key))
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


def go_fresh(restart_host=False, wait=None, now=time.time, sleep=time.sleep):
    """Restart with a clean context: ask a live session to checkpoint (waiting up to `wait` seconds, default
    CLEAR_WAIT, for 'checkpointed'), then point up.json at a new session id; `up` starts that one next, and the
    SessionStart hook gives it the brief. With `restart_host` the running `up` also ends the old session now and
    starts the new one itself. Returns the new session id."""
    checkpointed = None
    if alive():
        path = _load(lean_home("chat", "service.json")).get("transcript_path") or info().get("transcript") or ""
        offset = transcript_state(path)["size"]
        sent, _ = send(checkpoint_prompt())
        limit = now() + (_knob("LEAN_AGENT_CLEAR_WAIT", CLEAR_WAIT) if wait is None else wait)
        checkpointed = False
        while sent and now() < limit and not checkpointed:
            st = transcript_state(path, offset)
            checkpointed = st["ended"] and "checkpointed" in st["text"].lower()
            if not checkpointed:
                sleep(0.5)
    sid = str(uuid.uuid4())
    update_up(session_id=sid, transcript=transcript_path(lean_home("home"), sid), fresh_sid=sid)
    if restart_host and alive():
        request({"restart": True})
    return sid, checkpointed


def checkpoint_session(key="main", wait=None, now=time.time, sleep=time.sleep):
    """Have a live session save its soft state: sends the checkpoint prompt and waits (up to `wait` seconds, default
    CLEAR_WAIT) for its 'checkpointed' reply. None when the prompt could not be sent."""
    path = _load(service_record(key)).get("transcript_path") or info(key).get("transcript") or ""
    offset = transcript_state(path)["size"]
    sent, _ = send(checkpoint_prompt(), key)
    if not sent:
        return None
    limit = now() + (_knob("LEAN_AGENT_CLEAR_WAIT", CLEAR_WAIT) if wait is None else wait)
    while now() < limit:
        st = transcript_state(path, offset)
        if st["ended"] and "checkpointed" in st["text"].lower():
            return True
        sleep(0.5)
    return False


def update_up(**fields):
    """Merge fields into up.json (written by `up`; the hooks read it)."""
    os.makedirs(os.path.dirname(up_path()), exist_ok=True)
    with lean_common.file_lock(up_path()):
        data = _load(up_path())
        data.update(fields)
        lean_common.write_json_atomic(up_path(), data)


def update_session(key, **fields):
    """Merge fields into one hosted session's record: the main session keeps its fields at the top of up.json (the
    hooks and older clients read them there) and in sessions.main; a thread session lives in sessions.tN only."""
    if key == "main":
        update_up(**fields)
    os.makedirs(os.path.dirname(up_path()), exist_ok=True)
    with lean_common.file_lock(up_path()):
        data = _load(up_path())
        sessions = data.get("sessions") if isinstance(data.get("sessions"), dict) else {}
        rec = dict(sessions.get(key) or {})
        rec.update(fields)
        sessions[key] = rec
        data["sessions"] = sessions
        lean_common.write_json_atomic(up_path(), data)


def session_rec(key="main"):
    """One hosted session's record from up.json ({} when it never ran)."""
    up = _load(up_path())
    if key == "main":
        return up
    rec = (up.get("sessions") or {}).get(key)
    return rec if isinstance(rec, dict) else {}


def drop_session(key):
    """Remove a thread session's host record from up.json (the host is gone or was stopped)."""
    if key == "main" or not os.path.exists(up_path()):
        return
    with lean_common.file_lock(up_path()):
        data = _load(up_path())
        sessions = data.get("sessions")
        if isinstance(sessions, dict) and key in sessions:
            del sessions[key]
            lean_common.write_json_atomic(up_path(), data)


def request_clear(key="main"):
    """`lean-agent clear [--thread tN]`: ask the `up` host to checkpoint and /clear at the end of the current turn.
    False when that session is not up."""
    if not alive(key):
        return False
    update_session(key, clear_requested=time.time(), clear_status=None)
    return True


# ---------------------------------------------------------------- client

def request(msg, timeout=5, key="main"):
    """Send one message to the bridge; the reply dict, or {"ok": False, "error": ...} (never raises)."""
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    except (OSError, AttributeError) as exc:
        return {"ok": False, "error": f"no session bridge ({exc})"}
    try:
        s.settimeout(timeout)
        s.connect(client_sock_path(key))
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


def send(text, key="main"):
    r = request({"text": text}, key=key)
    return bool(r.get("ok")), r.get("error", "")


def keys(k, key="main"):
    r = request({"keys": k}, key=key)
    return bool(r.get("ok")), r.get("error", "")


def alive(key="main"):
    r = request({"ping": True}, timeout=2, key=key)
    return bool(r.get("ok") and r.get("alive"))


def tail(key="main"):
    return request({"tail": True}, key=key).get("text", "")


def info(key="main"):
    """session_id, transcript, pid, remote_control, ... from up.json ({} when `up` never ran)."""
    up = session_rec(key)
    return {k: up[k] for k in ("session_id", "transcript", "pid", "host_pid", "remote_control", "socket",
                               "session_started") if k in up}


# ---------------------------------------------------------------- auto clear (inside `up`)

CLEAR_AT = 0          # tokens of context after a finished turn above which the session is cleared: "auto" = just before compaction; 0 = off (default: only `lean-agent clear` clears)
CLEAR_MARGIN = 8000    # "auto" clears this far below the compaction point
CLEAR_HARD = 3000      # within this of the compaction point the clear no longer waits for running workers
CLEAR_PROMPT = "Checkpoint now: run lean-agent checkpoint with your soft state, then reply 'checkpointed'"
CLEAR_PENDING = "clear requested: waiting for the turn to end"
CLEAR_WAIT = 120       # seconds to wait for the checkpoint before clearing anyway
CLEAR_GAP = 600        # seconds between two clears
CLEAR_IDLE = 30        # seconds since the user last typed
TAIL_READ = 512 * 1024  # how much of the transcript's end is read


def compact_at(env=None):
    """Tokens at which Claude Code compacts the session: from its environment (`up` sets it when compaction is
    overridden), else the configured overrides, else Claude Code's own default."""
    ambient = env is None
    env = os.environ if ambient else env
    try:
        window = int(env.get("CLAUDE_CODE_AUTO_COMPACT_WINDOW") or 0) or None
        pct = float(env.get("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE") or 0) or None
    except ValueError:
        window = pct = None
    if ambient and not window and not pct:
        window, pct = lean_common.compact_overrides()
    return lean_common.compaction_point(window, pct)


def up_compact_at():
    """The compaction point `up` recorded at its start (up.json), else computed from this process's environment."""
    point = _load(up_path()).get("compact_at")
    return point if isinstance(point, int) and point > 0 else compact_at()


def clear_setting():
    """What is set: LEAN_AGENT_CLEAR_AT, else `lean-agent config clear-at`, else off (0); "auto" or a number of tokens opt in."""
    for raw in (os.environ.get("LEAN_AGENT_CLEAR_AT"), _load(lean_home("config.json")).get("clear_at")):
        raw = str(raw).strip().lower() if raw is not None else ""
        if raw in ("auto", "off") or raw.isdigit():
            return "auto" if raw == "auto" else 0 if raw == "off" else int(raw)
    return CLEAR_AT


def clear_at(env=None):
    """The threshold in tokens (0 = off): a number as set, or for "auto" the compaction point less CLEAR_MARGIN."""
    setting = clear_setting()
    point = compact_at(env) if env is not None else up_compact_at()  # outside `up`: the point `up` recorded
    return max(0, point - CLEAR_MARGIN) if setting == "auto" else setting


def checkpoint_prompt():
    """CLEAR_PROMPT, plus the ids of the runs alive (they go on through the clear; the new session collects them)."""
    runs = running_runs()
    if not runs:
        return CLEAR_PROMPT
    return CLEAR_PROMPT.replace("with your soft state", f"with your soft state and the running runs {', '.join(runs[:6])} "
                                "(they go on after the clear)", 1)


FRESH_AFTER = {"idle": 1800, "context": 50}  # thread-fresh-after defaults: idle seconds, % of the compaction point


def fresh_after():
    """(idle seconds, context percent) a big idle thread session must reach before `thread send` starts it fresh,
    or None when off: LEAN_AGENT_THREAD_FRESH_AFTER, else `lean-agent config thread-fresh-after idle=30m,context=50%|off`."""
    raw = os.environ.get("LEAN_AGENT_THREAD_FRESH_AFTER") or _load(lean_home("config.json")).get("thread_fresh_after")
    try:
        return parse_fresh_after(raw)
    except ValueError:
        return parse_fresh_after(None)


def parse_fresh_after(raw):
    raw = str(raw if raw is not None else "").strip().lower()
    out = dict(FRESH_AFTER)
    if raw in ("off", "no", "0"):
        return None
    if raw == "default":
        raw = ""
    for part in filter(None, (p.strip() for p in raw.replace(" ", ",").split(","))):
        k, _, v = part.partition("=")
        try:
            if k == "idle":
                out["idle"] = lean_common.parse_duration(v)
            elif k == "context":
                out["context"] = float(v.rstrip("%"))
            else:
                raise ValueError(k)
        except ValueError:
            raise ValueError(f"thread-fresh-after takes idle=30m,context=50% or off, not {raw!r}")
    return out["idle"], out["context"]


def session_context(tid):
    """Tokens in the last usage record of the thread session's transcript (0 when unknown)."""
    path = (info(tid) or {}).get("transcript")
    return transcript_state(path)["ctx"] if path else 0


def running_runs():
    """Ids of the lean-agent runs alive now."""
    return sorted(rid for rid, _ in lean_common.running_runs(lean_home()))


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


class AutoClear:
    """Keeps the orchestrator's context small: after a finished turn that left the context above `clear_at()`, asks
    the session for a checkpoint, then types /clear (after its 'checkpointed' reply, or CLEAR_WAIT seconds). Never
    within CLEAR_IDLE seconds of the user typing, within CLEAR_GAP of the last one,
    or while a lean-agent run is alive (runs are detached and survive a clear, but the new session would only meet
    them in the brief) unless the context is within CLEAR_HARD of compaction."""

    def __init__(self, host, now=time.time):
        self.host, self.now = host, now
        self.key = getattr(host, "key", "main")
        self.started = None   # when the last checkpoint prompt went out
        self.waiting = None   # (transcript offset, when) once the prompt is out
        self.held = None      # why a due clear waits (running workers)
        self.manual = False   # the clear in progress was asked for with `lean-agent clear`

    def record(self):
        """The hook's record of the transcript this session writes now (chat/service.json, thread: service-tN.json)."""
        return _load(service_record(self.key))

    def transcript(self):
        return self.record().get("transcript_path") or info(self.key).get("transcript") or ""

    def session_id(self):
        return self.record().get("session_id") or info(self.key).get("session_id")

    def up(self):
        return session_rec(self.key)

    def update(self, **fields):
        update_session(self.key, **fields)

    def log(self, msg, level="debug"):
        lean_log.log(level, "auto-clear", msg)

    def last_gap_start(self):
        """When the last clear (or checkpoint request) happened: the record survives a restart of `up`."""
        return max(self.started or 0, last_clear(self.record()) or 0)

    def hold(self, why):
        """Why the clear waits (shown by doctor and `service status`), or None; logged when it changes."""
        if why != self.held:
            self.held = why
            if why:
                self.log(f"holding the clear: {why}")
            self.update(clear_hold=why)

    def blocked(self, st):
        idle = _knob("LEAN_AGENT_CLEAR_IDLE", CLEAR_IDLE)
        now = self.now()
        return (now - self.host.last_input < idle
                or (st["user_ts"] and now - st["user_ts"] < idle and not self.waiting))

    def tick(self):
        """One look at the session; at most one action."""
        if not self.host.alive():
            self.waiting = None
            self.hold(None)
            return
        now = self.now()
        path = self.transcript()
        if self.waiting:
            offset, since = self.waiting
            st = transcript_state(path, offset)
            if self.manual:
                self.hold(CLEAR_PENDING)
            if not self.manual and now - self.host.last_input < _knob("LEAN_AGENT_CLEAR_IDLE", CLEAR_IDLE):
                return
            answered = st["ended"] and "checkpointed" in st["text"].lower()
            timed_out = now - since >= _knob("LEAN_AGENT_CLEAR_WAIT", CLEAR_WAIT)
            if timed_out and not answered and not st["ended"]:
                # a turn is still running: /clear would land in it. A manual clear keeps waiting for the turn to
                # end; an automatic one gives up and asks again at a turn end
                if not self.manual:
                    self.waiting = self.started = None
                    self.log("no reply in time and a turn is running: giving up this round")
                return
            if answered or timed_out:
                self.waiting = None
                self.hold(None)
                self.log(f"/clear sent ({'checkpointed' if answered else 'no reply in time'})")
                self.host.paste("/clear")
            return
        if self.up().get("clear_requested"):
            # asked for by the user: ignores the threshold, the gap, the idle time and live runs (they are detached
            # and survive); waits for a turn end however long it takes
            st = transcript_state(path)
            if not st["ended"]:
                self.hold(CLEAR_PENDING)
                asked = self.up().get("clear_requested")
                if not os.path.exists(path) and isinstance(asked, (int, float)) \
                        and now - asked >= _knob("LEAN_AGENT_CLEAR_WAIT", CLEAR_WAIT):
                    self.update(clear_requested=None, clear_status="clear not done: the transcript was not found")
                    self.hold(None)
                    self.log("clear not done: the transcript was not found")
                return
            self.update(clear_requested=None, clear_status=None)
            self.hold(CLEAR_PENDING)
            self.manual = True
            self.started = now
            self.waiting = (st["size"], now)
            self.log("clear requested with `lean-agent clear`: asking for a checkpoint")
            self.host.paste(checkpoint_prompt())
            return
        self.manual = False
        limit = clear_at(getattr(self.host, "env", None))
        if not limit or now - self.last_gap_start() < _knob("LEAN_AGENT_CLEAR_GAP", CLEAR_GAP):
            self.hold(None)
            return
        st = transcript_state(path)
        if not st["ended"] or st["ctx"] <= limit or self.blocked(st):
            self.hold(None)
            return
        runs = running_runs()
        if runs and st["ctx"] < compact_at(getattr(self.host, "env", None)) - CLEAR_HARD:
            self.hold(f"{len(runs)} run(s) alive ({', '.join(runs[:3])}{', ...' if len(runs) > 3 else ''}): the clear "
                      f"waits for them (or for {compact_at(getattr(self.host, 'env', None)) - CLEAR_HARD:,} tokens)")
            return
        self.hold(None)
        self.started = now
        self.waiting = (st["size"], now)
        self.log(f"context {st['ctx']:,} tokens is above {limit:,}: asking for a checkpoint")
        self.host.paste(checkpoint_prompt())

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

    def __init__(self, build_cmd, env, cwd, remote_control=False, on_text=None, on_stale=None, key="main", on_message=None):
        self.build_cmd = build_cmd  # () -> (argv, session_id): resume or start by whether the transcript exists
        self.env, self.cwd = child_env(env), cwd
        self.remote_control = remote_control
        self.key = key  # "main", or the thread id of a thread session
        self.on_message = on_message  # (msg) -> reply or None: session management requests (the main host's bridge)
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
        self.mirror = key == "main" and sys.stdout.isatty() and sys.stdin.isatty()
        self.log = None
        self.name = None
        self.thread = None     # the thread running run() (thread sessions)
        self.last_output = 0.0
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
            self.last_output = time.time()
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
            if self.on_message and msg.get("sessions_op"):
                return self.on_message(msg)
            if msg.get("ping"):
                return {"ok": True, "alive": self.alive(), "pid": self.proc.pid if self.proc else None}
            if msg.get("tail"):
                return {"ok": True, "text": self.tail_text()}
            if msg.get("restart"):  # end the session; run() starts the one up.json names now
                self.terminate_for("restart")
                return {"ok": True}
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

    def claim_socket(self, path, wait=None):
        """Free `path` for this bridge. A holder that is the previous `up` of this home still shutting down (it answers,
        or its socket file is still there) is waited for up to `wait` seconds; a socket nobody answers on is stale and
        removed. Only a bridge that keeps answering after that is refused."""
        wait = _knob("LEAN_AGENT_SOCKET_WAIT", SOCKET_WAIT) if wait is None else wait
        end = time.time() + wait
        while os.path.exists(path):
            if not request({"ping": True}, timeout=2, key=self.key).get("ok"):  # a bridge that is closing down still answers
                try:
                    os.remove(path)  # stale: nobody listens
                except OSError:
                    pass
                break
            if time.time() >= end:
                pid = session_rec(self.key).get("host_pid")
                raise RuntimeError(f"another session bridge answers on {path}"
                                   + (f" (pid {pid})" if pid else "") + f" and did not stop within {wait:g} s "
                                   "(is another `lean-agent up` running for this home?)")
            time.sleep(0.2)

    def serve(self):
        path = sock_path(self.key)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.claim_socket(path)
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        old = os.umask(0o177)
        try:
            srv.bind(path)
        finally:
            os.umask(old)
        os.chmod(path, 0o600)
        self.sock_ino = os.stat(path).st_ino
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
        drop_stale_record(self.cwd, sid, self.key)
        update_session(self.key, pid=None, session_started=time.strftime("%Y-%m-%dT%H:%M:%S"), clear_requested=None,
                       clear_hold=None)
        try:
            proc = subprocess.Popen(argv, env=self.env, cwd=self.cwd, stdin=slave, stdout=slave, stderr=slave,
                                    start_new_session=True)
        finally:
            os.close(slave)  # only the session holds it now, so reading ends when it exits
        self.proc, self.master = proc, master
        update_session(self.key, session_id=sid, transcript=transcript_path(self.cwd, sid), pid=proc.pid,
                       host_pid=os.getpid(), remote_control=self.remote_control, socket=sock_path(self.key),
                       **({"name": self.name} if self.name else {}))
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
            if not lean_common.signal_group(proc.pid, signal.SIGTERM):
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
                path = sock_path(self.key)
                if os.stat(path).st_ino == getattr(self, "sock_ino", None):  # not the socket of a newer `up` that took over
                    os.remove(path)
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
        logpath = lean_home("logs", "session.log" if self.key == "main" else f"session-{self.key}.log")
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
                if self.reason == "restart":
                    continue
                if self.reason == "stale" and not stale_done:
                    stale_done = True
                    if self.on_stale:
                        self.on_stale()
                    continue
                if time.time() - started < float(os.environ.get("LEAN_AGENT_SESSION_QUICK_EXIT") or QUICK_EXIT):
                    print(f"lean-agent: the {'main' if self.key == 'main' else self.key} session exited with {rc} "
                          f"{time.time() - started:.1f} s after it started; not restarting it (see {logpath}). Its last output:\n"
                          + "\n".join(ANSI_TAIL_RE.sub("", self.tail_text()).replace("\r", "").splitlines()[-8:]),
                          file=sys.stderr, flush=True)
                    return rc
                time.sleep(_knob("LEAN_AGENT_RESTART_DELAY", 2))
            return 0
        finally:
            if restore:
                restore()
            self.close()
            if self.log:
                self.log.close()


# ---------------------------------------------------------------- thread sessions (inside `up`)

MAX_THREAD_SESSIONS = 8
READY_QUIET = 1.5   # seconds without output from a new session before its first message is typed
READY_WAIT = 40     # ... and the longest wait for that
NAME_MAX = 40


def thread_session_name(tid, title):
    """The Remote Control name of a thread session: `lean-agent · tN <title>`, cut to NAME_MAX characters."""
    name = f"lean-agent \u00b7 {tid} {' '.join(str(title or '').split())}".strip()
    return name if len(name) <= NAME_MAX else name[:NAME_MAX - 1].rstrip() + "\u2026"


def max_thread_sessions():
    try:
        n = int(_load(lean_home("config.json")).get("max_thread_sessions"))
        return n if n > 0 else MAX_THREAD_SESSIONS
    except (TypeError, ValueError):
        return MAX_THREAD_SESSIONS


def wait_ready(host, quiet=None, limit=None):
    """Until the new session has printed something and then been quiet for `quiet` seconds (its input box is up)."""
    quiet = _knob("LEAN_AGENT_READY_QUIET", READY_QUIET) if quiet is None else quiet
    limit = _knob("LEAN_AGENT_READY_WAIT", READY_WAIT) if limit is None else limit
    end = time.time() + limit
    last, since = -1, time.time()
    while time.time() < end and not host.stopping.is_set():
        n = host.tail_len if host.alive() else 0
        if n != last:
            last, since = n, time.time()
        elif n and time.time() - since >= quiet:
            return True
        time.sleep(0.1)
    return False


class Sessions:
    """The thread sessions `up` hosts next to the main one: one Host (own pty, socket, up.json record, transcript
    tracking, AutoClear) per thread, started and stopped through the main bridge (`sessions_op` messages)."""

    def __init__(self, make_host):
        self.make_host = make_host  # (tid) -> Host for that thread's session
        self.hosts = {}
        self.lock = threading.RLock()

    def running(self, tid):
        h = self.hosts.get(tid)
        return bool(h and h.thread.is_alive() and not h.stopping.is_set())

    def start(self, tid, prompt=None):
        with self.lock:
            if self.running(tid):
                host = self.hosts[tid]
                fresh = False
            else:
                host = self.hosts[tid] = self.make_host(tid)
                update_session(tid, host_pid=os.getpid(), host_started=time.time())
                host.thread = threading.Thread(target=self._run, args=(tid, host), daemon=True)
                host.thread.start()
                threading.Thread(target=AutoClear(host).run, daemon=True).start()
                fresh = True
        if prompt:
            threading.Thread(target=self._first, args=(host, prompt, fresh), daemon=True).start()
        return host

    def _first(self, host, prompt, fresh):
        if fresh:
            wait_ready(host)
        try:
            host.last_input = time.time()
            host.paste(prompt)
        except OSError as exc:
            lean_log.log("error", "sessions", f"first message to {host.key} not delivered: {exc}")

    def _run(self, tid, host):
        try:
            host.run()
        except Exception as exc:  # one thread's session never takes `up` down
            lean_log.log("error", "sessions", f"{tid}: {exc}")
        finally:
            update_session(tid, pid=None, host_pid=None)

    def stop(self, tid, wait=None):
        host = self.hosts.get(tid)
        if not host:
            return False
        host.stop()
        host.thread.join(timeout=_knob("LEAN_AGENT_STOP_WAIT", 20) if wait is None else wait)
        update_session(tid, pid=None, host_pid=None)
        return True

    def stop_all(self, wait=0):
        """Ask every thread session to end; with `wait`, until each has (its socket is removed by then)."""
        hosts = list(self.hosts.values())
        for host in hosts:
            host.stop()
        for host in hosts:
            if wait and host.thread:
                host.thread.join(timeout=wait)

    def listing(self):
        """The hosts the service supervises; state is "running" while the process is up, else "starting" (a host that is
        coming up or being restarted)."""
        out = []
        for tid, host in sorted(self.hosts.items(), key=lambda kv: int(kv[0][1:]) if kv[0][1:].isdigit() else 0):
            if self.running(tid):
                up = host.alive()
                rec = session_rec(tid)
                out.append({"thread": tid, "name": rec.get("name"), "pid": host.proc.pid if up else None,
                            "state": "running" if up else "starting",
                            "idle": round(time.time() - max(host.last_output, host.last_input))})
        return out

    def dispatch(self, msg):
        op, tid = msg.get("sessions_op"), msg.get("thread")
        try:
            if op == "list":
                return {"ok": True, "sessions": self.listing()}
            if op == "start":
                host = self.start(tid, msg.get("prompt"))
                return {"ok": True, "name": session_rec(tid).get("name") or host.name}
            if op == "stop":
                return {"ok": self.stop(tid)}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}
        return {"ok": False, "error": "unknown sessions_op"}


def sessions_request(op, timeout=60, **fields):
    """Ask the `up` host (through the main bridge) to list, start or stop thread sessions."""
    return request({"sessions_op": op, **fields}, timeout=timeout)
