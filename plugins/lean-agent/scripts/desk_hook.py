#!/usr/bin/env python3
"""Hook of the external front desk (desk external: a local Claude session, not one `lean-agent up` hosts).
Arguments: `start` (SessionStart), `prompt` (UserPromptSubmit), `stop` (Stop).
start: the session started in the desk folder (or with LEAN_AGENT_DESK_SESSION=1) attaches as the front desk when none is
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


def main(argv=None, now=None):
    argv = sys.argv[1:] if argv is None else argv
    mode = argv[0] if argv else "prompt"
    if os.environ.get("LEAN_AGENT_SERVICE_SESSION") == "1":
        return 0
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import lean_desk
    if not lean_desk.external():
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
        in_desk_dir = os.path.realpath(cwd) == os.path.realpath(lean_desk.desk_dir())
        if not (in_desk_dir or os.environ.get("LEAN_AGENT_DESK_SESSION") == "1"):
            return 0
        ok, msg = lean_desk.attach(sid, event.get("transcript_path"), cwd, now)
        if not ok:
            out("SessionStart", "lean-agent: this session is NOT the front desk. " + msg + ".")
            return 0
        text = "lean-agent: this session is the front desk (external mode); thread reports reach it as hidden context."
        import service_session
        service_session.dialog_set("main", False, now)  # a new session has no dialog open
        if event.get("source") == "clear":
            try:
                import compact_hook
                text = compact_hook.brief(6000) + "\n" + text
            except Exception:  # noqa: BLE001
                pass
        pend = service_session.inject_main(now)
        out("SessionStart", text + ("\n" + pend if pend else ""))
        return 0
    if not lean_desk.is_desk(sid, now):
        return 0
    lean_desk.heartbeat(sid, event.get("transcript_path"), now)
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
