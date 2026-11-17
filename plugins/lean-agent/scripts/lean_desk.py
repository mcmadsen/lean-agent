"""External front desk: the front desk is a normal local Claude session the user started (Claude desktop app), not a
session `lean-agent up` hosts. Stdlib only (hooks import it).

desk.json records the attached session {session_id, transcript, cwd, attached_ts, heartbeat}; the desk's hooks refresh
the heartbeat. An attached desk whose heartbeat is older than STALE_SECS counts as detached (reports wait in the inbox).
Mode (config.json "desk": external|hosted, default hosted; env LEAN_AGENT_DESK overrides) and the notify switch
("desk_notify", default on in external mode) live in config.json.
"""
import json
import os
import subprocess
import sys
import tempfile
import time

STALE_SECS = 30 * 60
MODES = ("hosted", "external")


def lean_home(*parts):
    return os.path.join(os.path.abspath(os.path.expanduser(os.environ.get("LEAN_AGENT_HOME") or "~/.lean-agent")), *parts)


def desk_dir():
    """The folder the desk session is started in (where the front desk CLAUDE.md and settings live)."""
    return lean_home("home")


def _read(path):
    try:
        with open(path) as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-desk-")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(data, fh, indent=2)
        os.replace(tmp, path)
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


def config():
    return _read(lean_home("config.json"))


def mode():
    m = os.environ.get("LEAN_AGENT_DESK") or config().get("desk") or "hosted"
    return m if m in MODES else "hosted"


def external():
    return mode() == "external"


def set_mode(m):
    cfg = config()
    cfg["desk"] = m
    _write(lean_home("config.json"), cfg)


def notify_on():
    v = config().get("desk_notify")
    return (v != "off") if v in ("on", "off") else external()


def set_notify(on):
    cfg = config()
    cfg["desk_notify"] = "on" if on else "off"
    _write(lean_home("config.json"), cfg)


def path():
    return lean_home("desk.json")


def record():
    return _read(path())


def attached(now=None):
    """The attached desk's record while its heartbeat is fresh and the mode is external, else None."""
    if not external():
        return None
    rec = record()
    now = time.time() if now is None else now
    if not rec.get("session_id"):
        return None
    beat = rec.get("heartbeat")
    if not isinstance(beat, (int, float)) or now - beat > STALE_SECS or now < beat - 60:
        return None
    return rec


def attach(session_id, transcript=None, cwd=None, now=None):
    """(True, message) when this session is now the front desk; (False, why) when another live desk holds it."""
    now = time.time() if now is None else now
    cur = attached(now)
    if cur and cur.get("session_id") != session_id:
        return False, (f"another session is already the front desk (attached {age(cur.get('attached_ts'), now)} ago); "
                       "run `lean-agent desk detach` there or here first")
    rec = {"session_id": session_id, "transcript": transcript or (cur or {}).get("transcript") or "",
           "cwd": cwd or (cur or {}).get("cwd") or "", "attached_ts": (cur or {}).get("attached_ts") or now, "heartbeat": now}
    _write(path(), rec)
    return True, "attached"


def heartbeat(session_id, transcript=None, now=None):
    """Refresh the desk's heartbeat (and follow a /clear: a new id from the same desk is handled by attach in SessionStart)."""
    now = time.time() if now is None else now
    rec = record()
    if rec.get("session_id") != session_id:
        return False
    rec["heartbeat"] = now
    if transcript:
        rec["transcript"] = transcript
    _write(path(), rec)
    return True


def detach():
    had = bool(record().get("session_id"))
    try:
        os.remove(path())
    except OSError:
        pass
    return had


def is_desk(session_id, now=None):
    cur = attached(now)
    return bool(cur and session_id and cur.get("session_id") == session_id)


def age(ts, now=None):
    if not isinstance(ts, (int, float)):
        return "?"
    s = max(0, int((time.time() if now is None else now) - ts))
    return f"{s}s" if s < 90 else f"{s // 60}m" if s < 5400 else f"{s // 3600}h"


def summary(now=None):
    """The desk state for the pane, status and doctor: {mode, attached, age, session_id, heartbeat_age}."""
    now = time.time() if now is None else now
    m = mode()
    out = {"mode": m, "attached": False}
    if m != "external":
        return out
    rec = record()
    cur = attached(now)
    out["attached"] = bool(cur)
    if rec.get("session_id"):
        out["session_id"] = rec["session_id"]
        out["age"] = age(rec.get("attached_ts"), now)
        out["heartbeat_age"] = age(rec.get("heartbeat"), now)
        out["stale"] = cur is None
    return out


def status_line(now=None):
    s = summary(now)
    if s["mode"] != "external":
        return "desk: hosted (the service hosts the front desk session)"
    if s["attached"]:
        return f"desk: external, attached {s['age']} ago, last seen {s['heartbeat_age']} ago (session {s['session_id'][:8]})"
    if s.get("session_id"):
        return (f"desk: external, detached (last seen {s['heartbeat_age']} ago); reports wait in the inbox until a session "
                f"started in {desk_dir()} attaches")
    return f"desk: external, no desk attached; start a Claude session in {desk_dir()} (or run `lean-agent desk attach` there)"


def notify(text, now=None):
    """A local macOS notification (osascript), once per call; never raises, never leaves the machine."""
    if sys.platform != "darwin" or not notify_on() or os.environ.get("LEAN_AGENT_TEST"):
        return False
    try:
        safe = "".join(c for c in text if c not in '"\\')[:200]
        subprocess.run(["osascript", "-e", f'display notification "{safe}" with title "lean-agent"'],
                       capture_output=True, timeout=5)
        return True
    except Exception:  # noqa: BLE001
        return False
