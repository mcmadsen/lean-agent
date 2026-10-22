#!/usr/bin/env python3
"""PermissionRequest hook: let the dashboard answer the service session's permission prompts and questions.

Acts only in the session `lean-agent up` hosts (LEAN_AGENT_SERVICE_SESSION=1 and that session's id) and only while a
dashboard tab polled in the last 20 s. The request goes to the dashboard as a file in ~/.lean-agent/chat/perm/; the
hook waits up to LEAN_AGENT_DASH_PERMISSION_WAIT seconds (default 300) for the page's Allow / Always / Deny / option
answer and returns it as the decision (AskUserQuestion: allow with the answers added to its input). No dashboard, no
answer or anything unexpected: no output, so Claude Code shows its normal prompt in the app or terminal.
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dash_service as ds  # noqa: E402


def decide(event, wait):
    d = ds.perm_dir()
    rid = "p" + str(int(time.time() * 1000)) + "-" + str(os.getpid())
    req_path, ans_path = os.path.join(d, rid + ".json"), os.path.join(d, rid + ".answer.json")
    ds.write_json(req_path, {"tool_name": event.get("tool_name"), "tool_input": event.get("tool_input"),
                             "permission_suggestions": event.get("permission_suggestions"),
                             "session_id": event.get("session_id"), "pid": os.getpid(), "ts": time.time(), "wait": wait})
    moved = False
    try:
        end = time.time() + wait
        while time.time() < end:
            if os.path.exists(ans_path):
                with open(ans_path) as fh:
                    return json.load(fh)
            if not ds.dashboard_fresh(ds.FRESH_SECS * 3):  # the tab went away: let the app ask
                moved = True
                return None
            time.sleep(0.25)
        moved = True  # nobody answered in time: the app asks now
        return None
    finally:
        if moved:  # tells the dashboard the prompt moved to the app (it deletes this marker)
            ds.write_json(os.path.join(d, rid + ".moved.json"), {"ts": time.time()})
        for p in (req_path, ans_path):
            try:
                os.remove(p)
            except OSError:
                pass


def main():
    if os.environ.get("LEAN_AGENT_SERVICE_SESSION") != "1" or not ds.dashboard_fresh():
        return 0
    try:
        event = json.load(sys.stdin)
    except ValueError:
        return 0
    if event.get("session_id") not in ds.service_session_ids():
        return 0  # a worker that inherited the variable, or another session
    try:
        wait = float(os.environ.get("LEAN_AGENT_DASH_PERMISSION_WAIT") or 300)
    except ValueError:
        wait = 300.0
    try:
        ans = decide(event, wait)
    except (OSError, ValueError):
        return 0
    if not ans:
        return 0
    if ans.get("allow"):
        decision = {"behavior": "allow"}
        inp = dict(event.get("tool_input") or {})
        if ans.get("answers"):
            inp["answers"] = ans["answers"]
        if ans.get("answers") or ans.get("updatedInput"):
            decision["updatedInput"] = inp
        if ans.get("always") and ds.suggestion_rules(event.get("permission_suggestions")):
            decision["updatedPermissions"] = event["permission_suggestions"]
    else:
        decision = {"behavior": "deny", "message": ans.get("message") or "The user declined this in the dashboard."}
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": decision}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
