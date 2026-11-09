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
import datetime
import glob
import hashlib
import json
import os
import re
import signal
import socket
import stat
import subprocess
import tempfile
import sys
import threading
import time
import uuid

import lean_auth
import lean_common
import lean_goals
import lean_log
import lean_own
import lean_waiting
import usage

PASTE_START, PASTE_END = b"\x1b[200~", b"\x1b[201~"
KEY_NAMES = {"esc": "\x1b", "escape": "\x1b", "enter": "\r", "return": "\r", "tab": "\t", "ctrl-c": "\x03",
             "ctrl-d": "\x04", "up": "\x1b[A", "down": "\x1b[B", "right": "\x1b[C", "left": "\x1b[D",
             "backspace": "\x7f"}
TAIL_BYTES = 64 * 1024
ANSI_TAIL_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
STOP_WAIT = 20  # seconds `Sessions.stop` waits for a session's thread to end
RESTART_DELAY = 2  # seconds before a session that exited is started again
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
    home = os.path.realpath(lean_home())  # one spelling for every process (macOS: /var -> /private/var)
    path = os.path.join(home, "session.sock" if key == "main" else f"session-{key}.sock")
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
    digest = hashlib.sha256(os.fsencode(home)).hexdigest()[:12]
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


REPLACE_WINDOW = 900  # seconds between a replacement and the new session's start in which finished runs still get reported
RESTART_MAX_AGE = 6 * 3600  # seconds: an older restart note is not told to a session


def _restarts_path():
    return lean_home("restarts.json")


def note_restart(key, why, ts=None):
    """Record why session `key` is being replaced (or restarted): the next brief for it opens with one line saying so."""
    ts = time.time() if ts is None else ts
    try:
        with lean_common.file_lock(_restarts_path()):
            data = _load(_restarts_path())
            data[key] = {"ts": ts, "why": why}
            lean_common.write_json_atomic(_restarts_path(), data)
    except OSError:
        pass
    try:
        update_session(key, replaced_at=ts)  # runs that finish from here on are the new session's to report
    except Exception:  # noqa: BLE001
        pass


def restart_line(key, take=True):
    """`Restarted 12:12: <why>` for the last replacement of session `key` (and forgets it when `take`), else ''."""
    try:
        with lean_common.file_lock(_restarts_path()):
            data = _load(_restarts_path())
            e = data.get(key)
            if take and e:
                data.pop(key, None)
                lean_common.write_json_atomic(_restarts_path(), data)
    except OSError:
        return ""
    if not e or time.time() - float(e.get("ts") or 0) > RESTART_MAX_AGE:
        return ""
    return f"Restarted {time.strftime('%H:%M', time.localtime(float(e['ts'])))}: {e.get('why')}"


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
    note_restart("main", "cleared on request (checkpoint kept)" if checkpointed else "cleared on request (no checkpoint reply in time)")
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
    now = time.time()
    update_session(key, clear_requested=now, clear_status=None, clear_pending_since=now)
    return True


def clear_pending(key="main"):
    """Epoch seconds since a clear of session `key` has been queued or under way (None when none is). Past
    CLEAR_HOLD_MAX it no longer counts, so a stuck clear never keeps reports away for good."""
    rec = session_rec(key)
    since = rec.get("clear_pending_since") or (rec.get("clear_requested") if _num(rec.get("clear_requested")) else None)
    if _num(since) and time.time() - since < _knob("LEAN_AGENT_CLEAR_HOLD_MAX", CLEAR_HOLD_MAX):
        return since
    return None


def clear_state(key="main"):
    """One line for `clear --status` and the context table: "cleared HH:MM", or "clear pending since HH:MM: <reason>",
    or the last outcome ('' when nothing was ever asked)."""
    rec = session_rec(key)
    since = clear_pending(key)
    if since:
        why = rec.get("clear_hold") or rec.get("clear_status") or CLEAR_PENDING
        return f"clear pending since {time.strftime('%H:%M', time.localtime(since))}: {why}"
    if _num(rec.get("cleared_at")):
        return f"cleared {time.strftime('%H:%M', time.localtime(rec['cleared_at']))}"
    return rec.get("clear_status") or ""


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


def _socket_listening(path, timeout=2):
    """False only when nobody can be connected to at `path` (refused, gone or reset): a stale socket file. A connect
    that succeeds or times out means a live, possibly busy bridge."""
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        s.settimeout(timeout)
        s.connect(path)
        return True
    except (ConnectionRefusedError, FileNotFoundError, ConnectionResetError):
        return False
    except OSError:
        return True
    finally:
        s.close()


def send(text, key="main"):
    r = request({"text": text}, key=key)
    return bool(r.get("ok")), r.get("error", "")


def keys(k, key="main"):
    r = request({"keys": k}, key=key)
    return bool(r.get("ok")), r.get("error", "")


def alive(key="main"):
    """Whether session `key` is up. A busy bridge (the ping times out, e.g. while it starts a thread session) is up:
    only a socket nobody can connect to (gone, refused) means down. A failed ping is tried once more."""
    for attempt in range(2):
        r = request({"ping": True}, timeout=2, key=key)
        if r.get("ok"):
            return bool(r.get("alive"))
        err = str(r.get("error") or "")
        if "timed out" in err:
            return _socket_listening(client_sock_path(key))
        if "No such file" in err or "refused" in err.lower():
            return False
        time.sleep(0.3)
    return False


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
CLEAR_HOLD_MAX = 900   # seconds a queued clear keeps thread reports back
CLEAR_VERIFY = 30      # seconds a typed /clear has to show a new session before the session is replaced instead
FRESH_MARK = 2.0       # main-fresh-at default: times the compaction point
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


def clear_explicit():
    """True when a general clear-at (even `off`/0) is set: the front desk's own threshold then does not apply."""
    for raw in (os.environ.get("LEAN_AGENT_CLEAR_AT"), _load(lean_home("config.json")).get("clear_at")):
        raw = str(raw).strip().lower() if raw is not None else ""
        if raw in ("auto", "off") or raw.isdigit():
            return True
    return False


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


DESK_CLEAR_AT = 100000  # the front desk's own threshold (checkpoint, then clear) when `clear-at` is not set; thread sessions keep theirs


def desk_clear_at():
    """Tokens above which the front desk (main) is checkpointed and cleared after a finished turn when no general
    clear-at is set: LEAN_AGENT_DESK_CLEAR_AT, else `lean-agent config desk-clear-at N|off`, else DESK_CLEAR_AT (0 = off)."""
    for raw in (os.environ.get("LEAN_AGENT_DESK_CLEAR_AT"), _load(lean_home("config.json")).get("desk_clear_at")):
        raw = str(raw).strip().lower() if raw is not None else ""
        if raw == "off":
            return 0
        if raw.isdigit():
            return int(raw)
    return DESK_CLEAR_AT


def checkpoint_prompt():
    """CLEAR_PROMPT, plus the ids of the runs alive (they go on through the clear; the new session collects them)."""
    runs = running_runs()
    if not runs:
        return CLEAR_PROMPT
    return CLEAR_PROMPT.replace("with your soft state", f"with your soft state and the running runs {', '.join(runs[:6])} "
                                "(they go on after the clear)", 1)


FRESH_AFTER = {"idle": 1800, "context": (120000, 50.0)}  # thread-fresh-after defaults: idle seconds, context tokens | % of the compaction point (the lower)


def fresh_after():
    """(idle seconds, context limits) a big idle thread session must reach before `thread send` starts it fresh,
    or None when off: LEAN_AGENT_THREAD_FRESH_AFTER, else `lean-agent config thread-fresh-after idle=30m,context=120k|50%|off`.
    The context limits are (absolute tokens or None, percent of the compaction point or None); the lower one applies."""
    raw = os.environ.get("LEAN_AGENT_THREAD_FRESH_AFTER") or _load(lean_home("config.json")).get("thread_fresh_after")
    try:
        return parse_fresh_after(raw)
    except ValueError:
        return parse_fresh_after(None)


def _parse_context_limit(text):
    """(tokens, percent) of one `context=` value such as 120k, 50% or 120k|50% (the lower applies)."""
    tokens = pct = None
    for part in text.split("|"):
        part = part.strip()
        if part.endswith("%"):
            pct = float(part[:-1])
        else:
            m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*([km]?)", part)
            if not m:
                raise ValueError(part)
            tokens = float(m.group(1)) * {"": 1, "k": 1000, "m": 1000000}[m.group(2)]
        if (pct is not None and pct <= 0) or (tokens is not None and tokens <= 0):
            raise ValueError(part)
    return int(tokens) if tokens is not None else None, pct


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
                out["context"] = _parse_context_limit(v)
            else:
                raise ValueError(k)
        except ValueError:
            raise ValueError(f"thread-fresh-after takes idle=30m,context=120k|50% or off, not {raw!r}")
    return out["idle"], out["context"]


def fresh_context_threshold(limits, point):
    """Tokens of context at which a session is big enough to continue fresh: the lower of the absolute limit and the
    percentage of the compaction point `point` (0 when neither can be computed)."""
    tokens, pct = limits
    found = ([tokens] if tokens else []) + ([point * pct / 100] if pct and point else [])
    return min(found) if found else 0


def fresh_text(fa):
    """`idle=30m,context=120k|50%` for the parsed thread-fresh-after, or off."""
    if not fa:
        return "off"
    tokens, pct = fa[1]
    ctx = "|".join(([f"{tokens / 1000:g}k"] if tokens else []) + ([f"{pct:g}%"] if pct else []))
    return f"idle={fa[0] / 60:g}m,context={ctx}"


def parse_main_fresh_at(raw):
    """("x", multiple of the compaction point) | ("n", tokens) | None (off) for 2x, 800k, 800000, off or default."""
    raw = str(raw if raw is not None else "").strip().lower()
    if raw in ("", "default"):
        return ("x", FRESH_MARK)
    if raw in ("off", "no", "0"):
        return None
    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*(x|k|m)?", raw)
    if not m or float(m.group(1)) <= 0:
        raise ValueError(f"main-fresh-at takes 2x (times the compaction point), a number of tokens like 800k, off or default, not {raw!r}")
    if m.group(2) == "x":
        return ("x", float(m.group(1)))
    return ("n", int(float(m.group(1)) * {None: 1, "k": 1000, "m": 1000000}[m.group(2)]))


def main_fresh_at(point=None):
    """Tokens of context above which main (and a thread session) is replaced by a fresh session at its next turn end
    (0 = off): LEAN_AGENT_MAIN_FRESH_AT, else `lean-agent config main-fresh-at`, default 2x the compaction point."""
    raw = os.environ.get("LEAN_AGENT_MAIN_FRESH_AT") or _load(lean_home("config.json")).get("main_fresh_at")
    try:
        parsed = parse_main_fresh_at(raw)
    except ValueError:
        parsed = parse_main_fresh_at(None)
    if not parsed:
        return 0
    return int(parsed[1] * (point or up_compact_at())) if parsed[0] == "x" else parsed[1]


def session_context(tid):
    """Tokens in the last usage record of the thread session's transcript (0 when unknown)."""
    path = session_transcript(tid)
    return transcript_state(path)["ctx"] if path and os.path.exists(path) else 0


def running_runs():
    """Ids of the lean-agent runs alive now."""
    return sorted(rid for rid, _ in lean_common.running_runs(lean_home()))


def _knob(name, default):
    try:
        return float(os.environ.get(name) or default)
    except ValueError:
        return default


def _session_wait(name, value, default):
    """`value` as given, except that the default is replaced by the LEAN_AGENT_SESSION_<name> override when set."""
    return _knob("LEAN_AGENT_SESSION_" + name, default) if value == default else value


def session_transcript(key="main"):
    """The transcript file of session `key` (up.json, else its service record), or None."""
    return info(key).get("transcript") or _load(service_record(key)).get("transcript_path")


def mid_turn(key="main"):
    """True when session `key` has a transcript whose last message is not the assistant's final one."""
    path = session_transcript(key)
    return bool(path and os.path.exists(path) and os.path.getsize(path) and not transcript_state(path)["ended"])


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
        msg = last.get("message") if isinstance(last.get("message"), dict) else {}
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
        self.verify = None    # (session id, transcript, when, context) of a typed /clear that must show a new session
        self.reason = None    # why the clear in progress was started, when not the user
        self.limit = None     # the context limit the automatic clear in progress passed

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

    log_tag = "auto-clear"

    def log(self, msg, level="debug"):
        lean_log.log(level, self.log_tag, msg)

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

    def clear_now(self, because="checkpointed"):
        """The checkpoint is saved (or was not answered in time): do the clear. By default the session is replaced by a
        fresh one; LEAN_AGENT_CLEAR_MODE=slash types /clear instead and `verify_clear` checks it took."""
        self.waiting = None
        if os.environ.get("LEAN_AGENT_CLEAR_MODE", "replace") == "slash":
            st = transcript_state(self.transcript())
            self.verify = (self.session_id(), self.transcript(), self.now(), st["ctx"])
            self.log(f"/clear sent ({because})")
            self.host.paste("/clear")
            return
        self.log(f"replacing the session ({because})")
        self.replace()

    def replace(self, how="replaced"):
        """Checkpoint done: point the session at a new id (the brief starts it) and restart its host. Main takes the
        brief from the SessionStart hook; a thread session is sent its brief once the new session is up."""
        old_sid, st = self.session_id(), transcript_state(self.transcript())
        sid = str(uuid.uuid4())
        if self.key == "main":
            update_up(session_id=sid, transcript=transcript_path(self.host.cwd, sid), fresh_sid=sid)
        else:
            import lean_threads
            hist = list((lean_threads.load()["threads"].get(self.key) or {}).get("session_history") or [])
            lean_threads.set_session(self.key, session_id=sid, session_history=(hist + [old_sid] if old_sid else hist)[-20:])
        old_proc = self.host.proc
        self.finish(old_sid, sid, st["ctx"], how)
        self.host.terminate_for("restart")
        if self.key != "main":
            threading.Thread(target=self.brief_new_session, args=(old_proc,), daemon=True).start()

    def finish(self, old_sid, new_sid, ctx, how):
        now = self.now()
        why = f" ({self.reason})" if self.reason else ""
        manual, reason = self.manual, self.reason
        self.waiting = self.verify = self.started = None
        self.manual, self.reason = False, None
        if self.key == "main" or how.startswith("cleared"):
            clear_replacing(self.key)  # a replaced thread session keeps the hold until its brief is in (brief_new_session)
        self.hold(None)
        self.update(clear_requested=None, clear_pending_since=None, cleared_at=now, clear_hold=None,
                    clear_status=f"{self.key} was {ctx // 1000}k, {how} as session {str(new_sid)[:8]} at "
                                 f"{time.strftime('%H:%M', time.localtime(now))}{why}")
        if reason:
            cause = reason
        elif manual:
            cause = "cleared on request"
        else:
            cause = f"context {ctx // 1000}k passed the {(self.limit or 0) // 1000}k clear point" if self.limit else f"context {ctx // 1000}k, clear point passed"
        if how.startswith("cleared"):
            cause += " (typed /clear)"
        note_restart(self.key, cause + " (checkpoint kept)")
        self.log(f"{self.key} cleared: {old_sid} ({ctx:,} tokens) -> {new_sid}, {how}{why}", "info")

    def brief_new_session(self, old_proc):
        """A replaced thread session starts from its brief: sent once the new process is up and quiet."""
        try:
            self._brief_new_session(old_proc)
        finally:
            clear_replacing(self.key)  # queued messages now go to the new session, after its brief

    def _brief_new_session(self, old_proc):
        end = time.time() + 30
        while time.time() < end and (self.host.proc is old_proc or not self.host.alive()):
            time.sleep(0.2)
        try:
            import compact_hook
            import lean_threads
            if not wait_ready(self.host):
                self.log("the fresh session was not ready for its brief", "warn")
            self.host.last_input = time.time()
            self.host.paste(compact_hook.fresh_brief(self.key) + "\n" + lean_threads.BRIEF_END
                            + "\n\n(No message yet: wait for the user.)")
        except Exception as exc:  # noqa: BLE001 - the session works without the brief
            self.log(f"brief for the fresh {self.key} session not delivered: {exc}", "error")

    def verify_clear(self, now):
        """A typed /clear counts once the hook's record shows a new session id or transcript; without it within
        CLEAR_VERIFY seconds the session is replaced instead. True while still checking."""
        old_sid, old_path, since, ctx = self.verify
        if self.session_id() != old_sid or self.transcript() != old_path:
            self.finish(old_sid, self.session_id(), ctx, "cleared with /clear")
            return True
        if now - since >= _knob("LEAN_AGENT_CLEAR_VERIFY", CLEAR_VERIFY):
            self.log("/clear was not acted on: replacing the session instead", "warn")
            self.verify = None
            self.replace("replaced, /clear did not take")
        return True

    def safety_net(self, st):
        """A session whose context passed main-fresh-at (default 2x the compaction point) is replaced at this turn end:
        the checkpoint, then a fresh session; reports wait meanwhile. True when it started one."""
        mark = main_fresh_at(compact_at(getattr(self.host, "env", None)) if getattr(self.host, "env", None) else None)
        if not mark or not st["ended"] or st["ctx"] <= mark:
            return False
        self.reason = f"context {st['ctx'] // 1000}k passed main-fresh-at {mark // 1000}k"
        now = self.now()
        self.update(clear_requested=now, clear_pending_since=now, clear_status=None)
        print(f"lean-agent: {self.key} context {st['ctx']:,} passed {mark:,}: continuing in a fresh session after a checkpoint",
              file=sys.stderr, flush=True)
        self.log(self.reason, "warn")
        return True

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
        if self.verify:
            self.verify_clear(now)
            return
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
                    clear_replacing(self.key)
                    self.log("no reply in time and a turn is running: giving up this round")
                return
            if answered or timed_out:
                self.hold(None)
                self.clear_now("checkpointed" if answered else "no reply in time")
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
                    self.update(clear_requested=None, clear_pending_since=None,
                                clear_status="clear not done: the transcript was not found")
                    self.hold(None)
                    self.log("clear not done: the transcript was not found")
                return
            self.update(clear_requested=None, clear_status=None, clear_pending_since=self.up().get("clear_pending_since") or now)
            self.hold(CLEAR_PENDING)
            self.manual = True
            self.started = now
            self.waiting = (st["size"], now)
            self.log("clear requested with `lean-agent clear`: asking for a checkpoint")
            mark_replacing(self.key)
            self.host.paste(checkpoint_prompt())
            return
        self.manual = False
        if self.safety_net(transcript_state(path)):
            return
        limit = clear_at(getattr(self.host, "env", None))
        if not limit and self.key == "main" and not clear_explicit():
            limit = desk_clear_at()
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
        self.update(clear_pending_since=now)
        self.limit = limit
        self.log(f"context {st['ctx']:,} tokens is above {limit:,}: asking for a checkpoint")
        mark_replacing(self.key)
        self.host.paste(checkpoint_prompt())

    def run(self):
        poll = _knob("LEAN_AGENT_CLEAR_POLL", 2)
        while not self.host.stopping.is_set():
            try:
                self.tick()
            except Exception as exc:  # never take the session down
                self.log(f"error: {exc}", "error")
            self.host.stopping.wait(poll)


# ---------------------------------------------------------------- thread reports

REPORT_BATCH = 60      # seconds: reports queued within this window reach the main session in one message
REPORT_CHARS = 1200    # a report's text reaches main whole up to this; longer is cut at a sentence or line end
REPORT_MAX_AGE = 24 * 3600  # seconds: an older queued report is dropped, not delivered
REPORT_MODES = ("on", "questions-only", "off")
REPORT_RUN_RE = re.compile(r"\blean-agent\s+(?:run|review|handover|push)\b")
ASK_RE = re.compile(r"\blean-agent\s+thread\s+ask\b")
REPORT_CMD_RE = re.compile(r"\blean-agent\s+thread\s+report\b")
AUTO_REPORT_MIN = 120  # characters: a turn-ending text this long with no report queued is queued as a done report
PROMPT_RE = re.compile(r"Esc to cancel|Do you want to (?:proceed|make|create|allow)|❯\s*1\.\s*Yes")


ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]")
OPTION_RE = re.compile(r"^\s*[❯>]?\s*(\d)\.\s+(\S.*?)\s*$")
PERMISSION_CMD_CHARS = 200
PERMISSION_OPTIONS = ["Approve once", "Approve always (this command prefix)", "Deny"]


def parse_permission_prompt(screen):
    """The permission prompt on a session's terminal screen, or None: {"tool": header ("Bash command", "Edit file"),
    "command": the command or file path (capped), "options": [(number, label)]}. Only the last prompt counts."""
    text = ANSI_RE.sub("", str(screen or "")).replace("\r\n", "\n").replace("\r", "\n")
    at = max(text.rfind("Do you want to"), text.rfind("Would you like to"))
    if at < 0:
        return None
    lines = [l for l in text[at:].splitlines()[1:] if l.strip()]
    options = [m.groups() for m in map(OPTION_RE.match, lines[:10]) if m]
    if not options:
        return None
    after = [l for l in lines[len(options):] if l.strip() and not re.search(r"Esc to cancel|Tab to|ctrl\+", l, re.I)]
    if after:  # output after the options: the prompt was answered, the session moved on
        return None
    body = [l.strip(" │╭╮╰╯─") for l in text[:at].splitlines()[-14:]]
    body = [l for l in body if l]
    # the header is the line ending in command/file/tool use/request; what follows it is the command
    head = next((i for i in range(len(body) - 1, -1, -1) if re.search(r"(command|file|tool use|request|search|fetch)\s*$", body[i], re.I) and len(body[i]) < 60), None)
    tool = body[head] if head is not None else "tool"
    command = (body[head + 1] if head is not None and head + 1 < len(body) else body[-1]) if body else ""
    return {"tool": tool, "command": _short(command, PERMISSION_CMD_CHARS), "options": options}


PERMISSION_CHOICES = {"approve": ("approve", "yes", "y", "once", "approve once", "allow"),
                      "always": ("always", "approve always", "yes always", "allow always"),
                      "deny": ("deny", "no", "n", "reject")}


def permission_choice(text):
    t = " ".join(str(text or "").lower().replace("(", " ").split())
    for name, words in PERMISSION_CHOICES.items():
        if t in words or t.split(" ")[0] == name:
            return name
    return None


def permission_key(prompt, choice):
    """The number key of the option for `choice`: approve = the first, always = the option offering not to ask again (else
    the first), deny = the last (No)."""
    opts = prompt["options"]
    if choice == "deny":
        return opts[-1][0]
    if choice == "always":
        for num, label in opts:
            if re.search(r"don'?t ask again|always allow|allow all", label, re.I):
                return num
    return opts[0][0]


def answer_permission(key, choice):
    """Press the option for `choice` (approve | always | deny) in session `key`'s open permission prompt.
    Returns (pressed label or None, message)."""
    prompt = parse_permission_prompt(tail(key))
    if not prompt:
        return None, "the prompt is no longer open"
    num = permission_key(prompt, choice)
    ok, err = keys(num, key)
    if not ok:
        return None, "could not press the option: " + (err or "no session")
    label = next((l for n, l in prompt["options"] if n == num), num)
    return label, f"pressed {num}. {label}"


def reports_mode():
    """on (default), questions-only or off: LEAN_AGENT_THREAD_REPORTS, else `lean-agent config thread-reports`."""
    raw = (os.environ.get("LEAN_AGENT_THREAD_REPORTS") or _load(lean_home("config.json")).get("thread_reports") or "on")
    raw = str(raw).strip().lower()
    return raw if raw in REPORT_MODES else "on"


GOAL_TICK = 180  # seconds between goal watchdog passes


def alive_thread(tid):
    try:
        return bool(alive(tid))
    except Exception:
        return False


# ---------------------------------------------------------------- message spool
# `thread send/new/answer/wake` and the goals watchdog never wait for a session: they write the message into the spool
# (one file per message, name = time + random) and the service delivers it in order (waking the session when it is
# idle, parked or ended). A deliverer claims a message by renaming its file, so a message is delivered once.

SEND_WAIT = 10  # seconds a caller waits for a delivery before leaving the message to the service; LEAN_AGENT_SEND_WAIT overrides
SPOOL_RETRY = 5  # seconds before the service retries a delivery that failed


def send_wait():
    try:
        v = float(os.environ.get("LEAN_AGENT_SEND_WAIT") or _load(lean_home("config.json")).get("send_wait") or SEND_WAIT)
    except (TypeError, ValueError):
        v = SEND_WAIT
    return v if v > 0 else SEND_WAIT


def spool_dir(tid):
    return lean_home("thread-inbox", tid)


def spool_add(tid, text=None, new=False):
    """Queue `text` for thread `tid` (None: only wake it). Returns the spool file name."""
    d = spool_dir(tid)
    os.makedirs(d, exist_ok=True)
    name = f"{time.time_ns():020d}-{uuid.uuid4().hex[:8]}.json"
    tmp = os.path.join(d, name + ".tmp")
    with open(tmp, "w") as fh:
        json.dump({"text": text, "ts": time.time(), "new": new}, fh)
    os.replace(tmp, os.path.join(d, name))
    return name


REPLACING_TTL = 600  # seconds a replacement marker holds delivery at most (a crashed replacement never blocks for good)


def _replacing_path(tid):
    return os.path.join(spool_dir(tid), ".replacing")


def mark_replacing(tid):
    """The thread session is being checkpointed/replaced: the spool holds its messages until the new session has its brief."""
    if tid == "main":
        return
    try:
        os.makedirs(spool_dir(tid), exist_ok=True)
        with open(_replacing_path(tid), "w") as fh:
            fh.write(str(time.time()))
    except OSError:
        pass


def clear_replacing(tid):
    try:
        os.remove(_replacing_path(tid))
    except OSError:
        pass


def is_replacing(tid):
    try:
        return time.time() - os.path.getmtime(_replacing_path(tid)) < REPLACING_TTL
    except OSError:
        return False


def spool_count(tid):
    """Messages of thread `tid` queued for delivery (waiting or being delivered)."""
    try:
        return sum(1 for n in os.listdir(spool_dir(tid)) if n.endswith((".json", ".sending")))
    except OSError:
        return 0


def spool_pending(tid):
    try:
        return sorted(n for n in os.listdir(spool_dir(tid)) if n.endswith(".json"))
    except OSError:
        return []


def spool_threads():
    try:
        return sorted(t for t in os.listdir(lean_home("thread-inbox")) if spool_pending(t))
    except OSError:
        return []


def spool_claim(tid, name):
    """The message in spool file `name`, claimed (the file is renamed, so no other deliverer gets it); None if taken."""
    src = os.path.join(spool_dir(tid), name)
    dst = src[:-5] + ".sending"
    try:
        os.rename(src, dst)
    except OSError:
        return None
    msg = _load(dst)
    try:
        with open(dst, "w") as fh:
            json.dump(dict(msg, claimed_by=os.getpid()), fh)
    except OSError:
        pass
    return msg


def spool_done(tid, name):
    try:
        os.remove(os.path.join(spool_dir(tid), name[:-5] + ".sending"))
    except OSError:
        pass


def spool_withdraw(tid, name):
    """Remove an unclaimed message from the spool; False when a deliverer has it (or it was delivered)."""
    try:
        os.remove(os.path.join(spool_dir(tid), name))
        return True
    except OSError:
        return False


def spool_release(tid, name):
    """A claimed message that could not be delivered goes back (same place in the order)."""
    try:
        os.rename(os.path.join(spool_dir(tid), name[:-5] + ".sending"), os.path.join(spool_dir(tid), name))
    except OSError:
        pass


def _pid_alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, TypeError, ValueError):
        return False


def spool_reclaim_stale(tid, dead_age=5, age=300):
    """A claim left by a deliverer that died (or hangs for `age` seconds) goes back to the queue."""
    d = spool_dir(tid)
    try:
        names = os.listdir(d)
    except OSError:
        return
    for n in names:
        if not n.endswith(".sending"):
            continue
        path = os.path.join(d, n)
        try:
            old = time.time() - os.path.getmtime(path)
            if old > age or (old > dead_age and not _pid_alive(_load(path).get("claimed_by"))):
                os.rename(path, os.path.join(d, n[:-8] + ".json"))
        except OSError:
            pass


class SpoolDeliverer:
    """Service side: delivers spooled messages by running `lean-agent thread deliver tN` (the blocking start/resume path)
    in a background thread per thread, so a slow session never stalls a tick."""

    def __init__(self, run=None, now=time.time):
        self.run = run or self._subprocess
        self.now = now
        self.busy = {}
        self.failed = {}
        self.lock = threading.Lock()

    @staticmethod
    def _subprocess(tid):
        exe = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lean_agent.py")
        r = subprocess.run([sys.executable, exe, "thread", "deliver", tid], capture_output=True, text=True, timeout=180,
                           env={**os.environ, "LEAN_AGENT_SERVICE_DELIVER": "1"})
        if r.returncode == 0 and "session slot" in r.stdout:
            return True, "slot"
        return r.returncode == 0, (r.stderr or r.stdout).strip()[-200:]

    def tick(self):
        started = []
        try:
            lean_own.sweep()  # review items about the user's own PRs need no vote
        except Exception:
            pass
        for tid in spool_threads():
            spool_reclaim_stale(tid)
            with self.lock:
                if self.busy.get(tid) or self.now() - self.failed.get(tid, 0) < SPOOL_RETRY:
                    continue
                self.busy[tid] = True
            t = threading.Thread(target=self._deliver, args=(tid,), daemon=True)
            t.start()
            started.append(t)
        return started

    def _deliver(self, tid):
        try:
            ok, err = self.run(tid)
        except Exception as exc:
            ok, err = False, str(exc)
        with self.lock:
            self.busy[tid] = False
            if ok and err == "slot":  # waiting for a session slot: look again after SPOOL_RETRY seconds
                self.failed[tid] = self.now()
            elif ok:
                self.failed.pop(tid, None)
            else:
                self.failed[tid] = self.now()
        if not ok:
            lean_log.log("warn", "spool", f"{tid}: delivery failed, will retry: {err}")

    def loop(self, stop, interval=1.0):
        while not stop.is_set():
            try:
                self.tick()
            except Exception as exc:
                lean_log.log("error", "spool", str(exc))
            stop.wait(interval)


def goal_send(tid, text):
    """Message a thread like `lean-agent thread send`, without waiting: queued for the service to deliver."""
    try:
        spool_add(tid, text)
        return True, "queued"
    except OSError as exc:
        return False, str(exc)


class Chaser:
    """The haiku chase check (`lean-agent chase-decide`, role chaser) in the background: `decide` never waits. The first call
    starts one subprocess (at most one in flight) and returns None; later calls return None while it runs, then its
    decisions {goal id: {...}, "_cost": usd}. Past `timeout` seconds it is killed and the answer is {} (no decision)."""

    def __init__(self, timeout=90, clock=time.time, argv=None):
        self.timeout, self.clock, self.argv = timeout, clock, argv
        self.job = None

    def _start(self, contexts):
        fd, inp = tempfile.mkstemp(suffix=".json", dir=lean_home())
        with os.fdopen(fd, "w") as fh:
            json.dump(contexts, fh)
        out = inp + ".out"
        exe = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lean_agent.py")
        argv = (self.argv or [sys.executable, exe, "chase-decide"]) + [inp]
        with open(out, "w") as fh:
            proc = subprocess.Popen(argv, stdout=fh, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
        self.job = {"proc": proc, "in": inp, "out": out, "started": self.clock(), "ids": {c["id"] for c in contexts}}

    def _finish(self):
        job, self.job = self.job, None
        got = {}
        try:
            with open(job["out"]) as fh:
                data = json.loads(fh.read().strip().splitlines()[-1])
            got = dict(data.get("decisions") or {})
            got["_cost"] = data.get("_cost") or 0
        except (OSError, ValueError, IndexError):
            pass
        for p in (job["in"], job["out"]):
            try:
                os.remove(p)
            except OSError:
                pass
        return got, job["ids"]

    def decide(self, contexts):
        want = {c["id"] for c in contexts}
        if self.job is None:
            self._start(contexts)
            return None
        if self.job["proc"].poll() is None:
            if self.clock() - self.job["started"] < self.timeout:
                return None
            self.job["proc"].kill()
            self.job["proc"].wait()
            got, _ = self._finish()
            return {}  # timed out: no decision
        got, ids = self._finish()
        if not want <= ids:  # the goals changed meanwhile: ask again for these
            self._start(contexts)
            return None
        return got


def reports_path():
    return lean_home("thread-reports.json")


def report_auth_failure(source, is_structured=False):
    """The one visible line (to the front desk) and the waiting item when sign-in fails; only the first call acts.
    Free text is a hint: `claude auth status` must confirm it first."""
    if lean_auth.mark_broken(source, is_structured):
        queue_report("main", "chase", lean_auth.fix_line())
        return True
    return False


def report_key(tid, kind, text):
    """Identity of a report's content: the same text of the same thread is the same report, whatever path it came by."""
    return hashlib.sha1(f"{tid}|{kind}|{' '.join(str(text or '').split())}".encode("utf-8", "replace")).hexdigest()[:16]


def report_seq(item):
    """A queued report's sequence number (its id; older items without one use their time)."""
    try:
        return int(item.get("id") or float(item.get("ts") or 0) * 1000)
    except (TypeError, ValueError):
        return 0


def relayed_path():
    return lean_home("reports-relayed.json")


def relayed_seq(tid):
    """The id of the last report of thread `tid` that was delivered to main (0 if none)."""
    try:
        return int((_load(relayed_path()).get(tid) or {}).get("id") or 0)
    except (TypeError, ValueError, AttributeError):
        return 0


def relayed_keys(tid):
    keys = (_load(relayed_path()).get(tid) or {}).get("keys")
    return keys if isinstance(keys, list) else []


def mark_relayed(items):
    """Remember per thread the last report id (and recent contents) delivered to main; written when the digest is
    delivered, so an older or already relayed report is never sent again."""
    os.makedirs(lean_home(), exist_ok=True)
    with lean_common.file_lock(relayed_path()):
        data = _load(relayed_path())
        for i in items:
            t = i.get("thread")
            if not t:
                continue
            rec = data.get(t) if isinstance(data.get(t), dict) else {}
            keys = [k for k in rec.get("keys") or [] if isinstance(k, str)]
            keys = (keys + [report_key(t, i.get("kind"), i.get("text"))])[-20:]
            data[t] = {"id": max(int(rec.get("id") or 0), report_seq(i)), "keys": keys, "ts": time.time()}
        lean_common.write_json_atomic(relayed_path(), data)


def queue_report(tid, kind, text, tag="", force=False, waiting=True):
    """Queue one thread report (kind: done | blocked | needs-you | question) for the main session; the mode filters it,
    except an explicit question (`thread ask`) or an explicit report (`thread report`, force), which always go through.
    `tag` marks where it came from (explicit | auto)."""
    mode = reports_mode()
    if not force and kind not in ("question", "job-failed", "chase") and (mode == "off" or (mode == "questions-only" and kind != "needs-you")):
        return False
    os.makedirs(lean_home(), exist_ok=True)
    if kind in ("done", "needs-you", "blocked", "question"):
        try:  # the user's open questions to this thread: answered by its report (a counter-question keeps them open)
            import lean_myq
            lean_myq.thread_report(tid, kind, text)
        except Exception:
            pass
    if kind != "chase":
        try:  # a report is activity on the thread's goals (and answers a chase)
            lean_goals.touch(tid, reset=kind in ("done", "needs-you", "question"))
            lean_goals.acknowledge(tid, text)  # superseded/ignored/abandoned/merged: remembered, never chased again
        except Exception:
            pass
    with lean_common.file_lock(reports_path()):
        data = _load(reports_path())
        items = data.get("items") if isinstance(data.get("items"), list) else []
        key = report_key(tid, kind, text)
        if any(report_key(i.get("thread"), i.get("kind"), i.get("text")) == key for i in items) or key in relayed_keys(tid):
            return False  # the same report arriving by a second path (reporter, fallback, wake-up, redelivery): once
        seq = max([report_seq(i) for i in items] + [relayed_seq(tid), int(time.time() * 1000) - 1]) + 1
        items.append(dict({"thread": tid, "kind": kind, "text": text, "ts": time.time(), "id": seq}, **({"tag": tag} if tag else {})))
        lean_common.write_json_atomic(reports_path(), {"items": items[-50:]})
    if waiting and kind in ("question", "needs-you"):
        try:  # waiting on the user is recorded by lean-agent, not left to the front desk's memory
            m = re.match(r"QUESTION (q\d+): (.*?)(?: \[options: (.*)\])?$", str(text))
            opts = [o.strip() for o in m.group(3).split("|")] if m and m.group(3) else None
            lean_waiting.add(m.group(2) if m else text, "question", (opts or []) + ["Other"] if opts else None, tid,
                            qid=m.group(1) if m else "")
        except Exception:
            pass
    if kind != RUN_AUTO_KIND:
        with lean_common.file_lock(reported_path()):
            seen = _load(reported_path())
            seen[tid] = time.time()
            lean_common.write_json_atomic(reported_path(), seen)
    return True


def repush_questions(now=None, after=None):
    """Thread questions still open `after` seconds (REPUSH_AFTER) after they were recorded and never shown to the user
    (waiting item not asked, not answered) go to main once more; each only once. Returns the thread ids re-pushed."""
    import lean_threads
    now = time.time() if now is None else now
    after = REPUSH_AFTER if after is None else after
    done = []
    for w in lean_waiting.open_items():
        tid, qid = w.get("thread"), w.get("qid")
        if w.get("kind") != "question" or not tid or not qid or w.get("asked_at") or w.get("repushed"):
            continue
        try:
            age_s = now - datetime.datetime.fromisoformat(str(w.get("created"))).timestamp()
        except ValueError:
            continue
        if age_s < after:
            continue
        t = lean_threads.load()["threads"].get(tid) or {}
        q = next((q for q in lean_threads.open_questions(t) if q.get("id") == qid), None)
        if q is None:
            continue
        lean_waiting.mark_repushed(w["id"])
        queue_report(tid, "question", f"QUESTION {qid} (still unanswered, pushed again): {q['text']}", tag="repush", waiting=False)
        done.append(tid)
    return done


def reported_path():
    return lean_home("thread-reported.json")


def reported_at(tid):
    """When thread `tid` last queued a report for main (epoch), else 0."""
    try:
        return float(_load(reported_path()).get(tid) or 0)
    except (TypeError, ValueError):
        return 0.0


RUN_AUTO_KIND = "run done"   # the report lean-agent queues itself when a thread's finished run went unreported
RUN_REPORT_FALLBACK = 120    # seconds a finished run's thread has to report to main before lean-agent does; LEAN_AGENT_RUN_REPORT_FALLBACK overrides
RUN_WATCH_DAYS = 2           # ledger rows older than this are never followed up
FINISHED = ("done", "failed", "stopped")


def runs_state_path():
    return lean_home("run-followups.json")


def finished_thread_runs(now=None):
    """Ledger rows of finished runs tagged to a thread, newest 50, each with `fin` (epoch of the row)."""
    now = time.time() if now is None else now
    rows = []
    try:
        with open(lean_home("ledger.jsonl"), errors="replace") as fh:
            lines = fh.readlines()[-400:]
    except OSError:
        return rows
    for line in lines:
        try:
            r = json.loads(line)
        except ValueError:
            continue
        tag = str(r.get("thread") or "").strip().lstrip("#").lower()
        tag = "t" + tag if tag.isdigit() else tag
        if r.get("role") in lean_common.INTERNAL_ROLES:
            continue
        if not tag or r.get("status") not in FINISHED or not r.get("id"):
            continue
        try:
            fin = datetime.datetime.fromisoformat(str(r.get("ts"))).timestamp()
        except ValueError:
            continue
        if now - fin <= RUN_WATCH_DAYS * 86400:
            rows.append(dict(r, thread=tag, fin=fin))
    return rows[-50:]


def run_state_update(rid, **fields):
    with lean_common.file_lock(runs_state_path()):
        data = _load(runs_state_path())
        data.setdefault(rid, {}).update(fields)
        init = data.pop("_init", None)
        keep = dict(sorted(data.items(), key=lambda kv: kv[1].get("seen") or 0)[-200:])
        if init:
            keep["_init"] = init
        lean_common.write_json_atomic(runs_state_path(), keep)


def run_result_sentence(r):
    """The first sentence of a finished run's saved result, else ''."""
    files = sorted(glob.glob(os.path.join(r.get("workdir") or "", "summary-*.txt")),
                   key=lambda f: int(re.sub(r"\D", "", os.path.basename(f)) or 0))
    if not files:
        return ""
    try:
        with open(files[-1], errors="replace") as fh:
            lines = [l.strip() for l in fh.read().splitlines()]
    except OSError:
        return ""
    body = " ".join(l for l in lines if l and not l.startswith("run "))
    m = re.match(r"(.+?[.!?])(?:\s|$)", body)
    return _short(m.group(1) if m else body, 200)


def run_auto_text(r):
    sentence = run_result_sentence(r)
    return f"run {r['id']}: {r.get('status')}" + (f" \u00b7 {sentence}" if sentence else "") + \
        f" (details: lean-agent runs --show {r['id']})"


def run_fallback(now=None):
    """Queue the automatic report for each finished thread run whose thread did not report to main within
    LEAN_AGENT_RUN_REPORT_FALLBACK seconds of the run finishing (or has no live session). Once per run."""
    now = time.time() if now is None else now
    wait = _knob("LEAN_AGENT_RUN_REPORT_FALLBACK", RUN_REPORT_FALLBACK)
    state = _load(runs_state_path())
    if not isinstance(state.get("_init"), dict):  # first look: runs that ended long before are history, not follow-ups
        run_state_update("_init", seen=now)
        state = _load(runs_state_path())
    start = (state.get("_init") or {}).get("seen") or now
    for r in finished_thread_runs(now):
        rid = r["id"]
        if r["fin"] < start - wait:
            continue
        st = state.get(rid) or {}
        if st.get("reported"):
            continue
        if not st:  # first sight: a run that ended before the service saw the ledger gets the full window from now
            run_state_update(rid, seen=now)
            st = {"seen": now}
        if reported_at(r["thread"]) >= r["fin"]:
            run_state_update(rid, reported="thread")
            continue
        if now - (r["fin"] if r["fin"] >= start else max(r["fin"], st.get("seen") or 0)) < wait:
            continue
        run_state_update(rid, reported="auto")
        queue_report(r["thread"], RUN_AUTO_KIND, run_auto_text(r))


def queued_reports():
    items = _load(reports_path()).get("items")
    return items if isinstance(items, list) else []


def _internal_run_text(text):
    """True when a report is the automatic line of a run that was a helper's (chaser, advisor, ...), whatever its tag."""
    m = re.match(r"run (\S+?)(?::| )", str(text or ""))
    if not m:
        return False
    try:
        with open(lean_home("ledger.jsonl"), errors="replace") as fh:
            lines = fh.readlines()[-400:]
    except OSError:
        return False
    for line in reversed(lines):
        if m.group(1) in line:
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get("id") == m.group(1):
                return r.get("role") in lean_common.INTERNAL_ROLES
    return False


def take_reports(now=None):
    """(items, dropped): the queued reports to deliver, none removed yet (see drop_reports). Reports older than
    REPORT_MAX_AGE are discarded here and counted in `dropped`; helper-run reports, reports not newer than the
    thread's last relayed one and duplicates are discarded silently."""
    now = time.time() if now is None else now
    with lean_common.file_lock(reports_path()):
        items = queued_reports()
        aged = [i for i in items if now - (i.get("ts") or now) <= REPORT_MAX_AGE]
        fresh, seen = [], set()
        for i in aged:
            t = i.get("thread")
            k = report_key(t, i.get("kind"), i.get("text"))
            if k in seen or k in relayed_keys(t) or (report_seq(i) <= relayed_seq(t) and i.get("kind") != "chase") \
                    or (i.get("kind") in ("done", "blocked") and _internal_run_text(i.get("text"))):
                continue
            seen.add(k)
            fresh.append(i)
        if len(fresh) != len(items):
            lean_common.write_json_atomic(reports_path(), {"items": fresh})
    return fresh, len(items) - len(aged)


def drop_reports(taken):
    """Remove the reports that were delivered (reports queued meanwhile stay)."""
    with lean_common.file_lock(reports_path()):
        left = [i for i in queued_reports() if i not in taken]
        lean_common.write_json_atomic(reports_path(), {"items": left})


ASK_LINE = ("NEEDS THE USER ({tids}): ask each question NOW with AskUserQuestion (its options), then run the answer with "
            "`{cmd}`. Do not answer for the user; never leave it waiting.")
REPUSH_AFTER = 120  # seconds a thread question may stay unanswered before it is pushed to main once more
REPORT_LABELS = {"needs-you": "QUESTION: ", "blocked": "STUCK: ", "job-failed": "FAILED: ", "chase": "CHASED: "}


def reports_message(items, dropped=0):
    lines = [f"[{i['thread']} {i['kind']}] {REPORT_LABELS.get(i['kind'], '')}{i['text']}" for i in items]
    if dropped:
        lines.append(f"({dropped} older report(s) dropped: over {REPORT_MAX_AGE // 3600} h old)")
    asking = sorted({i["thread"] for i in items if i["kind"] in ("question", "needs-you")})
    if asking:
        lines.append(ASK_LINE.format(cmd=f'lean-agent thread answer {asking[0]} qN "<answer>"', tids=", ".join(asking)))
    tids = list(dict.fromkeys(i["thread"] for i in items if i["kind"] not in ("job-failed", "chase")))
    if not tids:
        return "\n".join(["<thread-reports>"] + lines + ["</thread-reports>"])
    more = f" (or {', '.join(tids[1:])})" if len(tids) > 1 else ""
    return "\n".join(["<thread-reports>"] + lines + [
        f"Check before relaying: lean-agent thread show {tids[0]}{more}; cut, unclear or open question: run it, then ask the thread",
        f"details: lean-agent thread show {tids[0]}{more}", "</thread-reports>"])


DIGEST_CHARS = 300      # a plain report's digest in the hidden context (a question keeps up to DIGEST_Q_CHARS)
DIGEST_Q_CHARS = 600
DIGEST_TURN_CHARS = 2000


def sentence_cut(text, n):
    """`text` on one line, at most `n` chars: cut after the last whole sentence that fits (the first sentence is kept);
    if the first sentence alone is too long, cut at a word and add an ellipsis."""
    text = " ".join(str(text or "").replace("`", "").replace("*", "").split())
    if len(text) <= n:
        return text
    ends = [m.end() for m in re.finditer(r"[.!?](?=\s|$)", text[:n + 1])]
    ends = [e for e in ends if e <= n]
    if ends:
        return text[:ends[-1]].rstrip()
    cut = text[:n - 1]
    if text[n - 1:n].strip():
        cut = cut.rsplit(" ", 1)[0] if " " in cut else cut
    return cut.rstrip(" ,;:") + "\u2026"


def reports_digest(items, dropped=0, rid=""):
    """The hidden context for a batch of reports: one line per thread (its newest report, a question if it has one),
    newest thread first, each cut at a sentence end, 2k in all; threads that do not fit are named in a `+N more` line.
    The full text stays in the log: `lean-agent thread reports tN [rId]`."""
    latest = {}
    for pos, i in enumerate(items):  # queue order is age: a later item is newer
        t = i["thread"]
        ask = i["kind"] in ("question", "needs-you")
        cur = latest.get(t)
        if cur is None or (ask and not cur[2]) or (ask == cur[2] and pos > cur[0]):
            latest[t] = (pos, i, ask)
    order = sorted(latest.items(), key=lambda kv: -max(pos for pos, i in enumerate(items) if i["thread"] == kv[0]))
    lines, used, shown = [], 0, []
    for n, (t, (_, i, ask)) in enumerate(order):
        line = f"[{t} {i['kind']}] {REPORT_LABELS.get(i['kind'], '')}" + sentence_cut(i["text"], DIGEST_Q_CHARS if ask else DIGEST_CHARS)
        if used + len(line) > DIGEST_TURN_CHARS and lines:
            rest = [x for x, _ in order[n:]]
            lines.append(f"(+{len(rest)} more: {' '.join(rest)} \u2192 lean-agent thread reports)")
            break
        lines.append(line)
        used += len(line)
        shown.append(t)
    if dropped:
        lines.append(f"({dropped} older report(s) dropped: over {REPORT_MAX_AGE // 3600} h old)")
    asking = sorted({i["thread"] for i in items if i["kind"] in ("question", "needs-you")})
    if asking:
        lines.append(ASK_LINE.format(cmd=f'lean-agent thread answer {asking[0]} qN "<answer>"', tids=", ".join(asking)))
    tids = [t for t, _ in order if latest[t][1]["kind"] not in ("job-failed", "chase")]
    if tids:
        lines.append(f"Relay these digests, do not paste reports. Full text only when needed: lean-agent thread reports {tids[0]}"
                     + (f" r{rid}" if rid else ""))
    return "\n".join(["<thread-reports>"] + lines + ["</thread-reports>"])


SUMMARY_RE = re.compile(r"^lean-agent: \d+ thread reports? \(.*\) \[r([0-9a-f]{6})\]$")
PENDING_FALLBACK = 60  # seconds: the one wait after a paste; a paste that began no turn (the prompt hook never took the staged block) is retried then, typed in full
REPORT_LOG_KEPT = 10


def pending_path():
    return lean_home("reports-pending.json")


def reports_log_path():
    return lean_home("reports-log.json")


def summary_line(items, rid):
    """The one visible line for a batch of reports: `lean-agent: 2 thread reports (t18 done, t21 question) [r1a2b3c]`."""
    tags = list(dict.fromkeys(f"{i['thread']} {'question' if i['kind'] in ('question', 'needs-you') else i['kind']}" for i in items))
    return f"lean-agent: {len(items)} thread report{'s' if len(items) != 1 else ''} ({', '.join(tags)}) [r{rid}]"


def stage_block(rid, line, block, now=None, full=None):
    """Queue the block (the digest) on disk for the main session's prompt hook; the full text (default: the block)
    goes to the log for `thread reports` and to the threads' stored reports."""
    os.makedirs(lean_home(), exist_ok=True)
    full = block if full is None else full
    lean_common.write_json_atomic(pending_path(), {"id": rid, "line": line, "block": block, "full": full, "ts": time.time() if now is None else now})
    log_block(full, rid)


def log_block(block, rid=""):
    with lean_common.file_lock(reports_log_path()):
        items = _load(reports_log_path()).get("items")
        items = (items if isinstance(items, list) else []) + [{"ts": time.time(), "block": block, "id": rid}]
        lean_common.write_json_atomic(reports_log_path(), {"items": items[-REPORT_LOG_KEPT:]})


def logged_blocks():
    items = _load(reports_log_path()).get("items")
    return items if isinstance(items, list) else []


def take_pending(line, with_full=False):
    """The staged block (digest) for a summary `line` typed into main (once: the file is removed), else None;
    with `with_full` a (digest, full text) pair."""
    m = SUMMARY_RE.match(str(line or "").strip())
    if not m:
        return None
    with lean_common.file_lock(pending_path()):
        data = _load(pending_path())
        if data.get("id") != m.group(1) or not data.get("block"):
            return None
        try:
            os.remove(pending_path())
        except OSError:
            return None
    return (data["block"], data.get("full") or data["block"]) if with_full else data["block"]


def _short(text, n=REPORT_CHARS, tid=None):
    """`text` on one line, whole up to `n` chars; longer is cut at the last sentence end (else word end) before `n`."""
    text = " ".join(str(text or "").replace("`", "").replace("*", "").split())
    if len(text) <= n:
        return text
    cut = text[:n]
    ends = [m.end() for m in re.finditer(r"[.!?](?=\s)", cut)]
    cut = cut[:ends[-1]] if ends and ends[-1] > n // 3 else cut.rsplit(" ", 1)[0]
    return cut.rstrip() + (f" (cut \u2014 full report: lean-agent thread show {tid})" if tid else " \u2026")


def last_reports_path():
    return lean_home("last-reports.json")


def save_last_report(tid, kind, text):
    """Keep a thread's latest full report text (the queue holds the cut one) for `lean-agent thread show`."""
    os.makedirs(lean_home(), exist_ok=True)
    with lean_common.file_lock(last_reports_path()):
        data = _load(last_reports_path())
        data[tid] = {"kind": kind, "text": str(text or ""), "ts": time.time()}
        lean_common.write_json_atomic(last_reports_path(), data)


def turns_path():
    return lean_home("thread-turns.json")


def note_turn(tid, reported, kind="", auto=False):
    """Record that thread `tid`'s turn ended now, and whether a report was queued for it (`thread reports tN` shows it)."""
    os.makedirs(lean_home(), exist_ok=True)
    with lean_common.file_lock(turns_path()):
        data = _load(turns_path())
        data[tid] = {"ts": time.time(), "reported": bool(reported), "kind": kind, "auto": bool(auto)}
        lean_common.write_json_atomic(turns_path(), data)


def turn_status(tid):
    """One line: when thread `tid`'s last turn ended and whether it produced a report."""
    rec = _load(turns_path()).get(tid)
    if not rec:
        return f"{tid}: no turn end seen by the service yet"
    ago = max(0, int(time.time() - float(rec.get("ts") or 0)))
    age = f"{ago // 3600}h" if ago >= 3600 else f"{ago // 60}m" if ago >= 60 else f"{ago}s"
    if rec.get("reported"):
        return f"{tid}: last turn ended {age} ago; report queued ({rec.get('kind') or 'done'}{', automatic' if rec.get('auto') else ''})"
    return f"{tid}: last turn ended {age} ago; no report produced for it (ask the thread to `lean-agent thread report`)"


def _question(text):
    """The last line of `text` ending in a question mark (the question the user is asked), else ''."""
    qs = [l.strip() for l in str(text or "").splitlines() if l.strip().endswith("?")]
    return qs[-1] if qs else ""


UNVERIFIED_MARK = "UNVERIFIED against the user's claim"


def scan_turn(path, offset):
    """What the transcript at `path` shows from byte `offset` on: {"runs": a lean-agent run/review/handover/push command
    was issued, "err": the last lean-agent tool result was an error, "result": its first line, "ask": the open
    AskUserQuestion's question (else None), "size": file size}."""
    out = {"runs": False, "err": False, "result": "", "ask": None, "asked": False, "reported": False, "size": offset,
           "unverified": False}
    try:
        with open(path, "rb") as fh:
            fh.seek(offset)
            data = fh.read()
    except OSError:
        return out
    out["size"] = offset + len(data)
    ids = set()
    for raw in data.split(b"\n"):
        try:
            rec = json.loads(raw)
        except ValueError:
            continue
        msg = rec.get("message") if isinstance(rec, dict) and isinstance(rec.get("message"), dict) else {}
        body = msg.get("content")
        for c in body if isinstance(body, list) else []:
            if not isinstance(c, dict):
                continue
            if c.get("type") == "tool_use":
                inp = c.get("input") if isinstance(c.get("input"), dict) else {}
                if c.get("name") == "AskUserQuestion":
                    qs = inp.get("questions")
                    first = qs[0] if isinstance(qs, list) and qs and isinstance(qs[0], dict) else {}
                    out["ask"] = first.get("question") or "a question"
                elif c.get("name") == "Bash" and ASK_RE.search(str(inp.get("command") or "")):
                    out["asked"] = True  # `thread ask` already put the question in front of main
                elif c.get("name") == "Bash" and REPORT_CMD_RE.search(str(inp.get("command") or "")):
                    out["reported"] = True  # `thread report` already queued this turn's report
                elif c.get("name") == "Bash" and REPORT_RUN_RE.search(str(inp.get("command") or "")):
                    out["runs"] = True
                    ids.add(c.get("id"))
            elif c.get("type") == "tool_result":
                out["ask"] = None
                res = c.get("content")
                if isinstance(res, list):
                    res = " ".join(str(x.get("text") or "") for x in res if isinstance(x, dict))
                if c.get("tool_use_id") in ids and UNVERIFIED_MARK in str(res or ""):
                    out["unverified"] = True  # a run's claim check failed: the turn is not "done"
                if c.get("tool_use_id") in ids:
                    out["err"] = bool(c.get("is_error"))
                    out["result"] = next((l.strip() for l in str(res or "").splitlines() if l.strip()), "")
    return out


def main_fresh_pending(reporter):
    """True when main's last finished turn left it above main-fresh-at: the safety net replaces it first."""
    mark = main_fresh_at()
    if not mark:
        return False
    st = transcript_state(reporter.transcript())
    return bool(st["ended"] and st["ctx"] > mark)


SESSION_STUCK = 10  # minutes without transcript progress in a running turn before the service steps in; config session-stuck / LEAN_AGENT_SESSION_STUCK
LONG_TOOL_RE = re.compile(r"--wait\b|\bruns\s+wait\b|\bsleep\s+\d|\bwatch\b")  # a tool call that is legitimately long
NUDGE_MAIN = ("Your last turn stalled. Continue: answer the user's last message and relay any pending thread reports "
              "(always end with visible text).")
NUDGE_THREAD = "Your last turn stalled; continue where you left off and finish with a short status line."


def stuck_limit():
    """Seconds of stall before an intervention (0: off)."""
    raw = os.environ.get("LEAN_AGENT_SESSION_STUCK") or _load(lean_home("config.json")).get("session_stuck")
    if str(raw).lower() in ("off", "0"):
        return 0
    try:
        m = float(raw) if raw not in (None, "", "default") else SESSION_STUCK
    except ValueError:
        m = SESSION_STUCK
    return (m if m > 0 else SESSION_STUCK) * 60


def pending_long_tool(path):
    """True when the transcript ends in a tool call (still without its result) that is legitimately long."""
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            fh.seek(max(0, fh.tell() - 65536))
            data = fh.read()
    except OSError:
        return False
    open_calls = {}
    for raw in data.split(b"\n"):
        try:
            rec = json.loads(raw)
        except ValueError:
            continue
        msg = rec.get("message") if isinstance(rec, dict) and isinstance(rec.get("message"), dict) else {}
        body = msg.get("content")
        for c in body if isinstance(body, list) else []:
            if not isinstance(c, dict):
                continue
            if c.get("type") == "tool_use":
                inp = c.get("input") if isinstance(c.get("input"), dict) else {}
                open_calls[c.get("id")] = str(inp.get("command") or "") if c.get("name") == "Bash" else ""
            elif c.get("type") == "tool_result":
                open_calls.pop(c.get("tool_use_id"), None)
    return any(LONG_TOOL_RE.search(cmd) for cmd in open_calls.values())


def session_workers(key):
    """Run ids of the workers a session started that are running now (main: any run)."""
    if key == "main":
        return running_runs()
    try:
        import lean_threads
        return lean_threads.running_by_thread(lean_threads.load()).get(key, [])
    except Exception:  # noqa: BLE001
        return []


class StuckWatch:
    """Per session: a turn with no transcript progress for `stuck_limit()` (no worker of its own running, no legitimately
    long tool call, no permission prompt) is interrupted and nudged; still stuck one limit later, the session is
    restarted (resumed). Every intervention is logged, queued to the front desk as one visible line and noted in the
    session record (`thread sessions`)."""

    def __init__(self, host, now=time.time, sleep=time.sleep, workers=None, long_tool=None):
        self.host, self.now, self.sleep = host, now, sleep
        self.workers = workers or session_workers
        self.long_tool = long_tool or pending_long_tool
        self.stage = 0
        self.since = 0.0
        self.mark = None

    def note(self, text):
        key = self.host.key
        update_session(key, stuck=text, stuck_at=self.now())
        lean_log.log("warn", "stuck", f"{key}: {text}")

    def tick(self, path, st, prompting=False, mtime=None):
        """Returns "nudge" / "restart" when it stepped in, else None."""
        limit = stuck_limit()
        now = self.now()
        if not limit or not path or lean_auth.is_broken():  # signed out: nudges and restarts would all fail
            return None
        if st["ended"]:
            self.stage, self.mark = 0, None
            return None
        if self.stage and st["size"] != self.mark:  # the session moved again after our intervention
            self.stage, self.mark = 0, None
        if prompting or self.long_tool(path) or self.workers(self.host.key):
            return None  # waiting for the user, or legitimately busy
        if mtime is None:
            try:
                mtime = os.path.getmtime(path)
            except OSError:
                return None
        idle = now - max(mtime, self.since if self.stage else 0)
        if idle < limit:
            return None
        key = self.host.key
        mins = round(idle / 60)
        if self.stage == 0:
            try:
                self.host.write(b"\x1b")  # Escape interrupts the stalled turn
                self.sleep(1.5)
                self.host.paste(NUDGE_MAIN if key == "main" else NUDGE_THREAD)
            except (OSError, ValueError) as exc:
                lean_log.log("warn", "stuck", f"{key}: nudge failed: {exc}")
            self.stage, self.since, self.mark = 1, now, st["size"]
            self.note(f"nudged after {mins}m stall")
            return "nudge"
        note_restart(key, f"restarted after a {round((now - self.since + limit) / 60)}m stall")
        self.host.terminate_for("stalled")
        self.stage, self.mark = 0, None
        text = f"restarted after {round((now - self.since + limit) / 60)}m stall"
        self.note(text)
        queue_report("main" if key == "main" else key, "chase", f"{key}: {text}")
        return "restart"


class Reporter(AutoClear):
    """A thread session's Host: at each turn end builds a report (done | blocked | needs-you) when the turn ran lean-agent
    work or asks the user something, and queues it; also reports a pending question or permission prompt. The main
    session's Host: types the queued reports into the session at its turn end (never mid-turn, never during a prompt)."""

    log_tag = "reports"

    def __init__(self, host, now=time.time):
        super().__init__(host, now)
        self.born = now()
        self.seen = None       # byte offset of the transcript already reported on
        self.path = None
        self.alerted = None    # the pending question or prompt already reported
        self.delivered = None  # (transcript size, when) of the last message typed into the main session
        self.woken = False     # a finished run's wake-up turn was typed in and its report is due
        self.waked = None      # run ids already woken for (None: not yet read at start)
        self.stuck = StuckWatch(host, now)
        self.redelivered = 0.0

    def prompting(self):
        return bool(PROMPT_RE.search(self.host.tail_text()[-1500:]))

    def permission_text(self):
        """The report line for the permission prompt on screen; the prompt is recorded as an open question (kind
        permission) with a waiting item, so `thread answer tN qN approve|always|deny` can press its option."""
        prompt = parse_permission_prompt(self.host.tail_text())
        if not prompt:
            return "waits for your permission: " + _short(_question(self.host.tail_text()[-600:]) or "a tool needs approval", 110)
        tid = self.key
        what = f"{prompt['tool']}: {prompt['command']}" if prompt["command"] else prompt["tool"]
        try:
            import lean_threads
            qid = lean_threads.ask(tid, "permission: " + what, "|".join(PERMISSION_OPTIONS), kind="permission")
            lean_waiting.add("permission: " + what, "permission", PERMISSION_OPTIONS, tid, qid=qid)
        except Exception as exc:  # noqa: BLE001 - the report must still go out
            qid = ""
            self.log(f"{tid}: could not record the permission question: {exc}", "error")
        return f"{qid} waits for your permission: {what} " + (f"-> thread answer {tid} {qid} approve|always|deny" if qid else "")

    def close_permission(self):
        """The prompt is gone (answered in the terminal, or the turn moved on): close its question and waiting item."""
        try:
            import lean_threads
            t = lean_threads.load()["threads"].get(self.key) or {}
            for q in lean_threads.open_questions(t):
                if q.get("kind") == "permission":
                    lean_threads.answer(self.key, q["id"], "the prompt is no longer open")
                    lean_waiting.close_for(self.key, {q["id"]}, "the prompt is no longer open")
        except Exception:  # noqa: BLE001
            pass

    def thread_tick(self):
        path = self.transcript()
        if not path or reports_mode() == "off":
            return
        st = transcript_state(path)
        if path != self.path or self.seen is None:
            fresh = bool(st["user_ts"]) and st["user_ts"] >= self.born - 5
            self.seen = 0 if fresh or self.path else st["size"]
            self.path = path
        scan = scan_turn(path, self.seen)
        tid = self.key
        if st["ended"] and not self.prompting():
            self.wake_for_runs(st)
        if not st["ended"]:
            ask = scan["ask"]
            if ask or (self.prompting() and self.host.alive()):
                what = "asks: " + _short(ask) if ask else self.permission_text()
                if self.alerted != what:
                    self.alerted = what
                    queue_report(tid, "needs-you", what, waiting=bool(ask) or " waits for your permission: " not in what)
            else:
                self.alerted = None
                self.close_permission()
            return
        self.close_permission()
        self.alerted = None
        if scan["size"] <= self.seen:
            return
        self.seen = scan["size"]
        text = st["text"]
        ask = _question(text)
        if scan["asked"]:
            note_turn(tid, True, "question")
            return
        if scan["unverified"]:  # wins over an explicit "done": a user claim the worker never checked is not settled
            self.woken = False
            note = "a user claim is UNVERIFIED by the worker: " + (text or scan["result"])
            save_last_report(tid, "needs-you", note)
            queue_report(tid, "needs-you", _short(note, tid=tid))
            note_turn(tid, True, "needs-you")
            return
        if scan["reported"]:  # the explicit report is the channel; it also did the goal bookkeeping
            note_turn(tid, True, "done")
            return
        try:  # a consolidated final report: the goal waits on the user with one push question
            lean_goals.final_report(tid, text)
            lean_goals.finished(tid, text)
        except Exception as exc:  # noqa: BLE001 - goals must not stop the report
            self.log(f"goal update for {tid} failed: {exc}", "error")
        if ask:
            save_last_report(tid, "needs-you", text)
            queue_report(tid, "needs-you", _short(ask, tid=tid))
            note_turn(tid, True, "needs-you")
        elif scan["err"]:
            save_last_report(tid, "blocked", text or scan["result"])
            queue_report(tid, "blocked", _short(text or scan["result"], tid=tid))
            note_turn(tid, True, "blocked")
        elif scan["runs"] or self.woken:
            self.woken = False
            save_last_report(tid, "done", text or scan["result"])
            queue_report(tid, "done", _short(text or scan["result"], tid=tid))
            note_turn(tid, True, "done")
        elif len(str(text or "").strip()) >= AUTO_REPORT_MIN:  # safety net: a final message nobody reported
            save_last_report(tid, "done", text)
            queued = queue_report(tid, "done", _short(text, tid=tid), tag="auto")
            note_turn(tid, queued, "done", auto=True)
            self.log(f"{tid}: turn ended with a final message and no report: " + ("queued it as a done report" if queued else "report mode filtered it"))
        else:
            note_turn(tid, False)

    def wake_for_runs(self, st):
        """A run tagged to this thread finished: type a short turn into the idle session so it reports to main."""
        mine = [r for r in finished_thread_runs(self.now()) if r["thread"] == self.key]
        if self.waked is None:  # runs that ended before this session started are not its to report ...
            cut = self.born
            replaced = session_rec(self.key).get("replaced_at")
            if isinstance(replaced, (int, float)) and 0 <= self.born - replaced <= REPLACE_WINDOW:
                cut = replaced  # ... except those that finished while the session was being replaced
            self.waked = {r["id"] for r in mine if r["fin"] < cut}
        todo = [r for r in mine if r["id"] not in self.waked and not (_load(runs_state_path()).get(r["id"]) or {}).get("reported")]
        if not todo or not self.host.alive() or self.now() - self.host.last_input < _knob("LEAN_AGENT_REPORT_IDLE", 3):
            return
        r = todo[0]
        task = " ".join(str(r.get("task") or "").split())[:80]
        try:
            self.host.paste(f"run {r['id']} ({task}) finished: {r.get('status')}. Report the result to main now with what the user needs.")
        except Exception as exc:  # noqa: BLE001 - retried on a later tick
            self.log(f"typing the wake-up for run {r['id']} failed: {exc}")
            return
        self.waked.add(r["id"])
        self.woken = True
        self.log(f"run {r['id']} finished: woke the thread session")

    def fallback_pending(self):
        """A staged block the prompt hook never took (hook not active): type it in full, as before."""
        data = _load(pending_path())
        if not data.get("block") or self.now() - (data.get("ts") or 0) < PENDING_FALLBACK:
            return
        st = transcript_state(self.transcript())
        if not st["ended"] or self.prompting():
            return
        try:
            self.host.paste(data["block"])
        except Exception as exc:  # noqa: BLE001 - stays staged, retried on a later tick
            self.log(f"typing the staged thread reports failed, kept: {exc}")
            return
        try:
            os.remove(pending_path())
        except OSError:
            pass
        self.log("staged thread reports not taken by the prompt hook: typed in full")

    def goals_tick(self):
        """The goals watchdog, every GOAL_TICK seconds: chase quiet or lost threads, tell the front desk."""
        now = self.now()
        if now - getattr(self, "goals_at", 0) < _knob("LEAN_AGENT_GOAL_TICK", GOAL_TICK):
            return
        self.goals_at = now
        if not hasattr(self, "chaser"):
            self.chaser = Chaser()
        lines = lean_goals.watchdog(now, goal_send, lambda tid: alive_thread(tid), log=self.log, decide=self.chaser.decide)
        for line in lines:
            queue_report(re.search(r"\b(t\d+)\b", line).group(1) if re.search(r"\b(t\d+)\b", line) else "main", "chase", line)

    def idle_stop_tick(self):
        """Every IDLE_STOP_TICK seconds: stop the thread sessions idle for session-idle-stop (checkpointed, thread stays open)."""
        now = self.now()
        if not idle_stop_limit() or now - getattr(self, "idle_stop_at", 0) < _knob("LEAN_AGENT_IDLE_STOP_TICK", IDLE_STOP_TICK):
            return
        self.idle_stop_at = now
        exe = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lean_agent.py")
        r = subprocess.run([sys.executable, exe, "thread", "idle-stop"], capture_output=True, text=True, timeout=300)
        if r.returncode:
            self.log(f"idle-stop failed: {(r.stderr or r.stdout).strip()[-200:]}", "error")

    def main_tick(self):
        try:
            if lean_auth.recheck(self.now()):
                self.log("sign-in works again: chases and restarts resumed")
                queue_report("main", "chase", "Claude Code sign-in works again; chases resumed.")
        except Exception as exc:  # noqa: BLE001
            self.log(f"auth check failed: {exc}", "error")
        if not lean_auth.is_broken():  # signed out: chasing and starting follow-ups would all fail
            try:
                self.goals_tick()
            except Exception as exc:  # noqa: BLE001 - the report queue must keep going
                self.log(f"goals watchdog failed: {exc}", "error")
            try:
                self.idle_stop_tick()
            except Exception as exc:  # noqa: BLE001
                self.log(f"idle-stop failed: {exc}", "error")
            try:
                run_fallback(self.now())
            except Exception as exc:  # noqa: BLE001 - the report queue must keep going
                self.log(f"run follow-up failed: {exc}", "error")
        items = queued_reports()
        limit = stuck_limit()
        if items and limit and self.now() - min(i.get("ts") or self.now() for i in items) > limit \
                and self.now() - self.redelivered > limit:
            self.redelivered = self.now()  # queued for a whole limit and still not typed in: try again from scratch
            self.delivered = None
            try:
                os.remove(pending_path())
            except OSError:
                pass
            self.log(f"{len(items)} queued report(s) undelivered for {round(limit / 60)}m: redelivering", "warn")
            lean_log.log("warn", "stuck", f"main: {len(items)} queued report(s) undelivered for {round(limit / 60)}m, redelivering")
        try:
            repush_questions(self.now())
        except Exception as exc:  # noqa: BLE001 - the report queue must keep going
            self.log(f"question re-push failed: {exc}", "error")
        items = queued_reports()
        if os.path.exists(pending_path()):
            return self.fallback_pending()
        if not items or not self.host.alive():
            return
        if clear_pending("main") or main_fresh_pending(self):
            return  # a queued clear goes first: the reports reach the fresh session after it
        now = self.now()
        if not any(i["kind"] in ("question", "needs-you") for i in items) \
                and now - min(i.get("ts") or now for i in items) < _knob("LEAN_AGENT_REPORT_BATCH", REPORT_BATCH):
            return  # (a question that needs the user is never held for the batch window)
        quiet = now - getattr(self.host, "last_output", 0)
        if self.record().get("session_id") != info("main").get("session_id") and quiet < 10:
            return  # a replaced session whose start the hook has not recorded yet
        path = self.transcript()
        st = transcript_state(path)
        new_session = not (path and os.path.exists(path) and os.path.getsize(path))  # a fresh session has no turn yet
        if new_session:
            st["ended"] = quiet > _knob("LEAN_AGENT_READY_QUIET", READY_QUIET)
        if not st["ended"] or self.prompting() or now - self.host.last_input < _knob("LEAN_AGENT_REPORT_IDLE", 3):
            return
        if self.delivered and self.delivered[0] == st["size"] and now - self.delivered[1] < PENDING_FALLBACK:
            return  # the last message has not started a turn yet
        items, dropped = take_reports(now)
        if items:
            self.delivered = (st["size"], now)
            full = reports_message(items, dropped)
            rid = f"{int(now * 1000) & 0xffffff:06x}"
            line = summary_line(items, rid)
            try:
                stage_block(rid, line, reports_digest(items, dropped, rid), now, full)
                self.host.paste(line)
            except Exception as exc:  # noqa: BLE001 - the reports stay queued and go out on a later tick
                self.log(f"typing {len(items)} thread report(s) failed, kept queued: {exc}")
                self.delivered = None
                try:
                    os.remove(pending_path())
                except OSError:
                    pass
                return
            mark_relayed(items)
            drop_reports(items)
            self.log(f"{len(items)} thread report(s) typed into the main session" + (f" ({dropped} stale dropped)" if dropped else ""))
        elif dropped:
            self.log(f"{dropped} stale thread report(s) dropped")

    def stuck_tick(self):
        path = self.transcript()
        if path and os.path.exists(path):
            self.stuck.tick(path, transcript_state(path), self.prompting())

    def tick(self):
        if self.key == "main":
            self.main_tick()
        else:
            self.thread_tick()
        try:
            self.stuck_tick()
        except Exception as exc:  # noqa: BLE001 - watching never stops the reporter
            self.log(f"stall check failed: {exc}", "error")


# ---------------------------------------------------------------- host (inside `up`)

def child_env(env):
    out = {k: v for k, v in env.items() if not PARENT_SESSION_VARS.match(k)}
    out["LEAN_AGENT_SERVICE_SESSION"] = "1"
    lean_auth.apply_env(out)  # the stored long-lived sign-in, read now (a new `lean-agent login` reaches new spawns)
    out.setdefault("TERM", "xterm-256color")
    return out


class Host:
    """Runs `cmd` in a pty this object owns, drains its output, restarts it when it dies, serves the socket."""

    def __init__(self, build_cmd, env, cwd, remote_control=False, on_text=None, on_stale=None, key="main", on_message=None):
        self.build_cmd = build_cmd  # () -> (argv, session_id): resume or start by whether the transcript exists
        self.env, self.cwd = child_env(env), cwd
        self._auth_tail = ""
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

    def _auth_scan(self, raw):
        """A sign-in failure line in the session's terminal output: one visible line, chases paused (lean_auth)."""
        try:
            text = self._auth_tail + raw.decode("utf-8", "replace")
            self._auth_tail = text[-200:]
            if lean_auth.detect(text):
                self._auth_tail = ""
                now = time.time()
                if now - getattr(self, "_auth_hint_at", 0) > 60 and not lean_auth.is_broken():
                    self._auth_hint_at = now  # a quoted phrase is only a hint: confirm off the pump thread
                    threading.Thread(target=report_auth_failure, args=(f"session {self.key}",), daemon=True).start()
        except Exception:  # noqa: BLE001 - watching never stops the pump
            pass

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
            self._auth_scan(raw)
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

    def claim_socket(self, path, wait=SOCKET_WAIT):
        """Free `path` for this bridge. A holder that is the previous `up` of this home still shutting down (it answers,
        or its socket file is still there) is waited for up to `wait` seconds; a socket nobody answers on is stale and
        removed. Only a bridge that keeps answering after that is refused."""
        wait = _session_wait("SOCKET_WAIT", wait, SOCKET_WAIT)
        end = time.time() + wait
        while os.path.exists(path):
            if not _socket_listening(path):  # a bridge that is closing down or slow to answer still accepts
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
        sdir = os.path.dirname(path)
        # The process umask is shared by every hosted session's thread and is never changed here: the socket is bound
        # inside a private (0700) directory with the normal umask, then narrowed to 0600.
        try:
            os.makedirs(sdir, mode=0o700, exist_ok=True)
            os.chmod(sdir, 0o700)
        except OSError as exc:
            raise RuntimeError(f"cannot make {sdir} private (mode 0700) for the session socket: {exc}") from exc
        self.claim_socket(path)
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(path)
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
        lean_auth.apply_env(self.env)  # read at each spawn: a restart after `lean-agent login` signs in
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
                                    start_new_session=True, **lean_common.popen_umask())
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
                time.sleep(_session_wait("RESTART_DELAY", RESTART_DELAY, RESTART_DELAY))
            return 0
        finally:
            if restore:
                restore()
            self.close()
            if self.log:
                self.log.close()


# ---------------------------------------------------------------- thread sessions (inside `up`)

MAX_THREAD_SESSIONS = 20
SESSION_IDLE_STOP = 3 * 3600  # seconds a thread session may sit idle before the service stops it (the thread stays open)
IDLE_STOP_TICK = 300  # seconds between idle-stop passes
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


def idle_stop_limit():
    """Seconds of idleness after which the service stops a thread session (0: off): LEAN_AGENT_SESSION_IDLE_STOP, else
    `lean-agent config session-idle-stop`, else 3h."""
    raw = os.environ.get("LEAN_AGENT_SESSION_IDLE_STOP") or _load(lean_home("config.json")).get("session_idle_stop")
    raw = str(raw if raw is not None else "").strip().lower()
    if raw in ("off", "0", "none"):
        return 0
    if raw in ("", "default"):
        return SESSION_IDLE_STOP
    try:
        v = lean_common.parse_duration(raw)
    except ValueError:
        return SESSION_IDLE_STOP
    return v if v > 0 else SESSION_IDLE_STOP


def wait_ready(host, quiet=None, limit=READY_WAIT):
    """Until the new session has printed something and then been quiet for `quiet` seconds (its input box is up)."""
    quiet = _knob("LEAN_AGENT_READY_QUIET", READY_QUIET) if quiet is None else quiet
    limit = _session_wait("READY_WAIT", limit, READY_WAIT)
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
                threading.Thread(target=Reporter(host).run, daemon=True).start()
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

    def stop(self, tid, wait=STOP_WAIT):
        host = self.hosts.get(tid)
        if not host:
            return False
        host.stop()
        host.thread.join(timeout=_session_wait("STOP_WAIT", wait, STOP_WAIT))
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
