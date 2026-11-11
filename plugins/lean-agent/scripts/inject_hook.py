#!/usr/bin/env python3
"""PostToolUse hook of the sessions `lean-agent up` hosts (LEAN_AGENT_SERVICE_SESSION=1); no effect anywhere else.

At each tool boundary it hands the session what is waiting for it as additionalContext: a thread session gets its spooled
messages and answers ("[lean-agent: new message from main]"), main gets the queued thread reports ("[lean-agent: thread
reports]"). Items are claimed atomically (rename / ledger), so the typed paths never deliver them again. Never waits on a
busy lock (the call is skipped) and never fails the session.
"""
import json
import os
import sys


def main():
    if os.environ.get("LEAN_AGENT_SERVICE_SESSION") != "1":
        return 0
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import lean_common
    import service_session
    lean_common.hook_mode()
    try:
        tid = os.environ.get("LEAN_AGENT_THREAD") or ""
        text = service_session.inject_thread(tid) if os.environ.get("LEAN_AGENT_SESSION_ROLE") == "thread" and tid \
            else service_session.inject_main()
    except Exception:  # noqa: BLE001 - LockBusy included: the items stay queued for the next call or the typed path
        return 0
    if text:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": text}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
