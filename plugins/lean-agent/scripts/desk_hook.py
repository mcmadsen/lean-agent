#!/usr/bin/env python3
"""Hook of the external front desk (desk external: a local Claude session, not one `lean-agent up` hosts).
Arguments: `start` (SessionStart), `prompt` (UserPromptSubmit), `stop` (Stop).
start: the session started in the desk folder attaches as the front desk when none is
attached (a second one is told so); the desk gets its pending reports as additionalContext.
prompt: heartbeat + pending reports as additionalContext. stop: heartbeat; with reports pending a block decision hands them to the
desk so it processes them (once per batch: claimed reports are gone, stop_hook_active ends a chain, never while a dialog is open).
Never fails the session."""
import json
import os
import sys
import time

BLOCK_GAP = 10  # seconds: no second Stop block this soon after one


def out(event, text):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}}), flush=True)


CTX_ASK = ("lean-agent: your context is high. " + "Write your checkpoint notes now: {cp} "
           "Then tell the user in one line: \"context is high: type /clear when convenient - the desk keeps its notes\". "
           "Never type /clear yourself.")


def context_ask(rec, event, service_session, now):
    """Once per crossing of desk-clear-at: block the stop so the app desk writes its checkpoint and tells the user to /clear.
    Re-armed when the context drops below the threshold. True when it asked."""
    try:
        limit = service_session.desk_clear_at()
        tp = event.get("transcript_path") or rec.get("transcript")
        ctx = service_session.transcript_state(tp)["ctx"] if limit and tp and os.path.exists(tp) else 0
        if not limit or ctx <= limit:
            if rec.get("ctx_asked"):
                rec.pop("ctx_asked", None)
                lean_desk_write(rec)
            return False
        if rec.get("ctx_asked"):
            return False
        rec["ctx_asked"] = now
        rec["stop_block_ts"] = now
        lean_desk_write(rec)
        print(json.dumps({"decision": "block", "reason": CTX_ASK.format(cp=service_session.checkpoint_prompt())}), flush=True)
        return True
    except Exception:  # noqa: BLE001
        return False


def lean_desk_write(rec):
    import lean_desk
    lean_desk._write(lean_desk.path(), rec)


def main(argv=None, now=None):
    argv = sys.argv[1:] if argv is None else argv
    mode = argv[0] if argv else "prompt"
    if os.environ.get("LEAN_AGENT_SERVICE_SESSION") == "1":
        return 0
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import lean_desk
    if not lean_desk.enabled() or os.environ.get("LEAN_AGENT_LOCAL_UP") == "1":  # (hosted sessions are never the app desk)
        return 0
    try:
        event = json.load(sys.stdin)
    except ValueError:
        return 0
    if not isinstance(event, dict) or not event.get("session_id"):
        return 0
    sid = event["session_id"]
    now = time.time() if now is None else now
    if mode == "start":
        cwd = event.get("cwd") or os.getcwd()
        in_desk_dir = os.path.realpath(cwd) in [os.path.realpath(d) for d in lean_desk.desk_dirs()]
        if not in_desk_dir:
            return 0
        src = event.get("source")
        take = lean_desk.takeover_ok(src, event.get("transcript_path"), now)
        ok, msg = lean_desk.attach(sid, event.get("transcript_path"), cwd, now, takeover=take)
        if not ok:
            out("SessionStart", "lean-agent: this session is NOT the front desk. " + msg + ".")
            return 0
        if msg == "pending":  # one owner at a time: the service still hosts main; reports go there until it has stopped
            out("SessionStart", "lean-agent: this session will become the front desk as soon as the service has stopped hosting "
                "its own main (when that is idle). Until then it is a normal session.")
            return 0
        text = "lean-agent: this session is the front desk (external mode); thread reports reach it as hidden context."
        import service_session
        service_session.dialog_set("main", False, now)  # a new session has no dialog open
        if src in ("clear", "compact"):
            try:
                import compact_hook
                text = compact_hook.brief(6000) + "\n" + text
            except Exception:  # noqa: BLE001
                pass
        pend = service_session.inject_main(now)
        out("SessionStart", text + ("\n" + pend if pend else ""))
        return 0
    # every event of the attached session refreshes its heartbeat, even an expired one: it re-attaches itself
    lean_desk.heartbeat(sid, event.get("transcript_path"), now)
    if not lean_desk.is_desk(sid, now):
        return 0  # not attached, another desk's, or still pending (the service hosts main until it has stopped)
    import service_session
    if mode == "prompt":
        service_session.dialog_set("main", False, now)  # the user typed: no dialog is open
        text = service_session.inject_main(now)
        if text:
            out("UserPromptSubmit", text)
        return 0
    if mode == "stop":
        if event.get("stop_hook_active") or service_session.dialog_held("main", now):
            return 0
        rec = lean_desk.record()
        if now - (rec.get("stop_block_ts") or 0) < BLOCK_GAP:
            return 0
        if context_ask(rec, event, service_session, now):
            return 0
        if not (os.path.exists(service_session.pending_path()) or service_session.queued_reports()):
            return 0
        text = service_session.inject_main(now)
        if text:
            rec["stop_block_ts"] = now
            lean_desk._write(lean_desk.path(), rec)
            print(json.dumps({"decision": "block", "reason": text}), flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import lean_common
        lean_common.hook_mode()
        sys.exit(main())
    except BaseException:  # noqa: BLE001
        sys.exit(0)
