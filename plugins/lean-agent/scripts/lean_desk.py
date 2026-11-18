"""External front desk: the front desk is a normal local Claude session the user started (Claude desktop app), not a
session `lean-agent up` hosts. Stdlib only (hooks import it).

desk.json records the attached session {session_id, transcript, cwd, attached_ts, heartbeat}; the desk's hooks refresh
the heartbeat. An attached desk whose heartbeat is older than STALE_SECS counts as detached (reports wait in the inbox).
Mode (config.json "desk": auto|hosted|external, default auto; env LEAN_AGENT_DESK overrides: auto attaches an app session
started in the lean home and hosts a Remote Control main otherwise, hosted never attaches, external never hosts) and the notify switch
("desk_notify", default on in external mode) live in config.json.
"""
import os
import subprocess
import sys
import time

import lean_common

STALE_SECS = 30 * 60
MODES = ("auto", "hosted", "external")
SWITCH_GAP = 10 * 60  # seconds between two switches of the active desk in auto mode (no flapping)
MAX_PENDING = 300  # seconds an app desk may wait pending before the switch ignores recent typed input
BOOT_WAIT = 180  # seconds a restarted service waits for the app desk (when it was the last owner) before hosting its own main
SHORTCUT_NAME = "lean-agent-desk"


lean_home = lean_common.lean_home


def desk_dir():
    """The folder the desk session is started in: the hosted desk's own folder, where the front desk CLAUDE.md lives."""
    return lean_home("home")


def desk_dirs():
    return [desk_dir()]


def shortcut_path():
    return os.path.join(os.path.expanduser("~"), SHORTCUT_NAME)


def shortcut_on():
    v = config().get("desk_shortcut")
    return v != "off" and sys.platform != "win32"


def ensure_shortcut():
    """~/lean-agent-desk -> the desk folder, idempotent. Created only when the path does not exist; an existing symlink
    to the desk folder is left alone; anything else (file, folder, foreign symlink) is never touched. True when it exists as ours."""
    if not shortcut_on():
        return False
    link, target = shortcut_path(), desk_dir()
    try:
        if os.path.lexists(link):
            return os.path.islink(link) and os.readlink(link) == target
        os.symlink(target, link)
        return True
    except OSError:
        return False


def max_pending_s():
    v = config().get("desk_max_pending_s")
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0 else MAX_PENDING


def boot_wait_s():
    v = config().get("desk_boot_wait_s")
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0 else BOOT_WAIT


def _read(path):
    data = lean_common.read_json(path, {})
    return data if isinstance(data, dict) else {}


def _write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    lean_common.write_json_atomic(path, data)


def config():
    return _read(lean_home("config.json"))


def mode():
    m = os.environ.get("LEAN_AGENT_DESK") or config().get("desk") or "hosted"  # auto is opt-in until the switch is proven in the field
    return m if m in MODES else "hosted"


def enabled():
    """An app session may attach as the desk (mode auto or external)."""
    return mode() != "hosted"


def state_path():
    return lean_home("desk-mode.json")


def state():
    return _read(state_path())


def update_state(fn):
    """Locked read-modify-write of desk-mode.json (the hooks and the service both write it); fn(dict) edits it in place."""
    with lean_common.file_lock(state_path()):
        st = state()
        fn(st)
        _write(state_path(), st)


def update_record(session_id, **changes):
    """Locked update of desk.json when it is still `session_id`'s record (a None value removes the key). True when written."""
    with lean_common.file_lock(path()):
        rec = record()
        if rec.get("session_id") != session_id:
            return False
        for k, v in changes.items():
            if v is None:
                rec.pop(k, None)
            else:
                rec[k] = v
        _write(path(), rec)
    return True


def active(now=None):
    """Who is the desk right now: "app" (an attached local session) or "hosted" (the service's Remote Control main)."""
    m = mode()
    if m == "hosted":
        return "hosted"
    if m == "external":
        return "app"
    return "app" if state().get("active") == "app" and attached(now) else "hosted"


def external():
    """The attached app session is the active desk (the service types nothing into a main)."""
    return active() == "app"


def open_at_start():
    """Config desk_open_at_start on|off; default on in auto mode, off otherwise."""
    v = config().get("desk_open_at_start")
    if v in ("on", "off"):
        return v == "on"
    return mode() == "auto"


def claude_bin():
    """The claude binary (LEAN_AGENT_CLAUDE_BIN, else PATH), or None. Tests point this at a fake."""
    import shutil
    return os.environ.get("LEAN_AGENT_CLAUDE_BIN") or shutil.which("claude")


def open_argv(binary="claude"):
    """The claude command that reopens the app desk session: --resume <last id>, else --continue."""
    sid = record().get("session_id") or state().get("last_sid")
    return [binary, "--desktop"] + (["--resume", sid] if sid else ["--continue"])


OPEN_ENV_KEEP = ("HOME", "USER", "LOGNAME", "SHELL", "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM", "DISPLAY",
                 "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME")


def open_env():
    """What a user-started session would have: no LEAN_AGENT_*/CLAUDE_CODE_* of the service."""
    return {k: v for k, v in os.environ.items() if k in OPEN_ENV_KEEP}


def open_desk(now=None, popen=subprocess.Popen):
    """Reopen the app desk in the Claude Desktop app, detached; never blocks. (ok, message); the attempt is recorded in the state
    file for doctor. Linux has no Desktop app: said so, not an error."""
    import threading
    now = time.time() if now is None else now
    binary = claude_bin()
    argv = open_argv(binary or "claude")
    if sys.platform not in ("darwin", "win32") and not os.environ.get("LEAN_AGENT_TEST_DESKTOP"):
        ok, msg = True, "no Claude Desktop app on this platform: open the desk session by hand"
    elif not binary:
        ok, msg = False, "claude is not on PATH: cannot reopen the app desk"
    else:
        try:
            with open(os.path.join(lean_home(), "desk-open.log"), "ab") as logf:
                proc = popen(argv, cwd=desk_dir(), env=open_env(), stdin=subprocess.DEVNULL, stdout=logf,
                             stderr=subprocess.STDOUT, start_new_session=True)
            if hasattr(proc, "wait"):
                threading.Thread(target=proc.wait, daemon=True).start()  # reaped when it exits
            ok, msg = True, "opened: " + " ".join(argv)
        except OSError as exc:
            ok, msg = False, f"could not run claude: {exc}"
    update_state(lambda st: st.__setitem__("open", {"ts": now, "ok": ok, "msg": msg}))
    return ok, msg


def open_line(now=None):
    o = state().get("open")
    if not o:
        return ""
    return f"last desk open attempt {age(o.get('ts'), now)} ago: {o.get('msg')}"


def set_active(which, why, now=None):
    """Record a switch of the active desk (the service does it): state file with the last switches, for status/doctor/map."""
    now = time.time() if now is None else now
    def edit(st):
        log = list(st.get("log") or [])[-19:]
        log.append({"ts": now, "to": which, "why": why})
        keep = {k: st[k] for k in ("open", "last_sid") if st.get(k)}
        st.clear()
        st.update({"active": which, "since": now, "why": why, "log": log}, **keep)
    update_state(edit)
    set_pending(which != "app")  # the app session owns the desk only while the service hosts no main


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
    if not enabled():
        return None
    rec = record()
    now = time.time() if now is None else now
    if not rec.get("session_id"):
        return None
    beat = rec.get("heartbeat")
    if not isinstance(beat, (int, float)) or now - beat > STALE_SECS or now < beat - 60:
        return None
    return rec


HANDOVER_SECS = 60


def handover_valid(rec, now):
    """The record carries a live handover token of its own session (its SessionEnd said clear/compact moments ago)."""
    return bool(rec.get("handover_from") and rec.get("handover_from") == rec.get("session_id")
                and now <= (rec.get("handover_until") or 0))


def handover_out(session_id, now=None):
    """SessionEnd(clear|compact) of the current desk session: a short token lets the session that starts next in the desk
    folder continue as the desk. Compact keeps the id: then there is nothing to hand over."""
    now = time.time() if now is None else now
    return update_record(session_id, handover_from=session_id, handover_until=now + HANDOVER_SECS)


def takeover_ok(source, transcript, session_id=None, now=None):
    """How a SessionStart of `source` in the desk folder may take the desk record from the attached session: "token"
    (clear/compact right after the desk session's own SessionEnd), "resume" (the same transcript), else None. A same-id
    start (compact keeps the id) needs no takeover."""
    now = time.time() if now is None else now
    cur = record()
    if not cur.get("session_id") or cur.get("session_id") == session_id:
        return None
    if source in ("clear", "compact"):
        return "token" if handover_valid(cur, now) else None
    if source == "resume" and transcript and transcript == cur.get("transcript"):
        return "resume"
    return None


def _remember_sid(session_id):
    update_state(lambda st: st.__setitem__("last_sid", session_id))


def attach(session_id, transcript=None, cwd=None, now=None, takeover=False):
    """(True, message) when this session is now the desk record; (False, why) when another live desk holds it. In mode auto the
    desk is *pending* until the service has stopped hosting its own main (SwitchHost.confirm): only then is it the desk."""
    now = time.time() if now is None else now
    with lean_common.file_lock(path()):
        cur = attached(now)
        if takeover == "token" and cur and cur.get("session_id") != session_id and not handover_valid(cur, now):
            takeover = False
        if takeover and cur and cur.get("session_id") != session_id:
            # the same app session continues under a new id: it keeps the desk record (never a second owner)
            old = cur["session_id"]
            rec = dict(cur, session_id=session_id, transcript=transcript or "", heartbeat=now)
            for k in ("ctx_asked", "handover_from", "handover_until"):
                rec.pop(k, None)  # the token is consumed; the new id is asked about context afresh
            _write(path(), rec)
            _remember_sid(session_id)
            update_state(lambda st: st.__setitem__("log", (list(st.get("log") or [])[-19:] + [
                {"ts": now, "to": st.get("active"), "why": f"desk session {old[:8]} continues as {session_id[:8]}"}])))
            return True, "pending" if rec.get("pending") else "attached"
        if cur and cur.get("session_id") != session_id:
            return False, (f"another session is already the front desk (attached {age(cur.get('attached_ts'), now)} ago); "
                           "run `lean-agent desk detach` there or here first")
        same = cur and cur.get("session_id") == session_id
        confirmed = mode() == "external" or bool(same and not cur.get("pending")) or \
            (state().get("active") == "app" and not same)
        rec = {"session_id": session_id, "transcript": transcript or (cur or {}).get("transcript") or "",
               "cwd": cwd or (cur or {}).get("cwd") or "", "attached_ts": (cur or {}).get("attached_ts") or now,
               "heartbeat": now, "pending": not confirmed}
        if not confirmed:
            rec["pending_since"] = (cur or {}).get("pending_since") or now if same and cur.get("pending") else now
        _write(path(), rec)
        _remember_sid(session_id)
    return True, "attached" if confirmed else "pending"


def heartbeat(session_id, transcript=None, now=None):
    """Refresh the heartbeat of the desk record named `session_id` (even an expired one: the next hook event of the same
    session re-attaches it, unless another desk took over meanwhile). True when it was this session's record."""
    now = time.time() if now is None else now
    if record().get("session_id") != session_id or not enabled():
        return False  # not this session's record: no lock is taken (non-desk sessions pay nothing)
    with lean_common.file_lock(path()):
        rec = record()
        if rec.get("session_id") != session_id:
            return False
        beat = rec.get("heartbeat")
        if rec.get("pending") and not (isinstance(beat, (int, float)) and now - beat <= STALE_SECS):
            rec["pending_since"] = now  # an expired record that revives starts waiting afresh (the max-pending clock)
        rec["heartbeat"] = now
        if transcript:
            rec["transcript"] = transcript
        _write(path(), rec)
    return True


def set_pending(pending):
    """The service confirms (False) or releases (True) the app session as the desk: one owner at a time."""
    with lean_common.file_lock(path()):
        rec = record()
        if rec.get("session_id") and rec.get("pending") != pending:
            rec["pending"] = pending
            if pending:
                rec["pending_since"] = time.time()
            else:
                rec.pop("pending_since", None)
            _write(path(), rec)


def pending_age(now=None):
    """Seconds the attached app desk has been pending (waiting for the hosted main to stop), or None when none is pending."""
    now = time.time() if now is None else now
    cur = attached(now)
    if not (cur and cur.get("pending")):
        return None
    return max(0.0, now - (cur.get("pending_since") or cur.get("attached_ts") or now))


def set_wait(kind, ts=None, msg=""):
    """The service records why a pending switch waits (kind None clears it); written only when it changes."""
    st = state()
    new = {"k": kind, "t": ts, "msg": msg} if kind else None
    if (st.get("wait") or None) == new:
        return
    if new:
        st["wait"] = new
    else:
        st.pop("wait", None)
    _write(state_path(), st)


def wait_reason(now=None):
    """One line: why the pending switch waits right now (from the service's record), or ''."""
    w = state().get("wait") or {}
    k, t = w.get("k"), w.get("t")
    now = time.time() if now is None else now
    hhmm = lambda ts: time.strftime("%H:%M", time.localtime(ts)) if isinstance(ts, (int, float)) else "?"  # noqa: E731
    if k == "mid_turn":
        return "hosted main mid-turn"
    if k == "dialog":
        return "a dialog is open on the hosted main"
    if k == "typed":
        return f"user typed {age(t, now)} ago"
    if k == "refused":
        return f"checkpoint refused: {w.get('msg') or '?'}, retry at {hhmm(t)}"
    if k == "gap":
        return f"anti-flap gap until {hhmm(t)}"
    return ""


def is_pending(session_id, now=None):
    cur = attached(now)
    return bool(cur and cur.get("session_id") == session_id and cur.get("pending"))


def detach():
    had = bool(record().get("session_id"))
    try:
        os.remove(path())
    except OSError:
        pass
    return had


def is_desk(session_id, now=None):
    """This session is the confirmed desk: attached, fresh, and the service no longer hosts a main."""
    cur = attached(now)
    return bool(cur and session_id and cur.get("session_id") == session_id and not cur.get("pending"))


def age(ts, now=None):
    if not isinstance(ts, (int, float)):
        return "?"
    s = max(0, int((time.time() if now is None else now) - ts))
    return f"{s}s" if s < 90 else f"{s // 60}m" if s < 5400 else f"{s // 3600}h"


def summary(now=None):
    """The desk state for the pane, status and doctor: {mode, attached, age, session_id, heartbeat_age}."""
    now = time.time() if now is None else now
    m = mode()
    act = active(now)
    out = {"mode": m, "attached": False, "active": act,
           "label": "desk: app session" if act == "app" else "desk: hosted (Remote Control)"}
    if m == "hosted":
        return out
    rec = record()
    cur = attached(now)
    out["attached"] = bool(cur)
    out["pending"] = bool(cur and cur.get("pending"))
    st = state()
    if st.get("since"):
        out["since"] = age(st["since"], now)
        out["why"] = st.get("why") or ""
    if rec.get("session_id"):
        out["session_id"] = rec["session_id"]
        out["age"] = age(rec.get("attached_ts"), now)
        out["heartbeat_age"] = age(rec.get("heartbeat"), now)
        out["stale"] = cur is None
        if cur and not cur.get("pending"):
            try:
                import service_session
                tp = rec.get("transcript")
                out["ctx"] = service_session.transcript_state(tp)["ctx"] if tp and os.path.exists(tp) else 0
                out["clear_at"] = service_session.desk_clear_at()
            except Exception:  # noqa: BLE001
                pass
    return out


def status_line(now=None):
    s = summary(now)
    tag = f" ({s['mode']})"
    if s["mode"] == "hosted":
        return "desk: hosted (Remote Control) (pinned: config desk hosted)"
    act = s["label"] + tag + (f", since {s['since']} ago" if s.get("since") else "")
    if s.get("pending") and s["attached"]:
        why = wait_reason(now)
        return act + f", app session {s['session_id'][:8]} waits for the hosted main to stop (pending)" + (f": {why}" if why else "")
    if s["attached"]:
        ctx = ""
        if s.get("ctx"):
            ctx = f", context {s['ctx']:,} tokens" + (f" (clear point {s['clear_at']:,})" if s.get("clear_at") else " (no clear point)")
        return act + f", app session attached {s['age']} ago, last seen {s['heartbeat_age']} ago (session {s['session_id'][:8]}){ctx}"
    if s.get("session_id"):
        return act + f", app session detached (last seen {s['heartbeat_age']} ago)"
    return act + f", no app session attached; open a local session in {lean_home()}"


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
