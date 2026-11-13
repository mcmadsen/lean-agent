#!/usr/bin/env python3
"""PostToolUse hook (and, with the argument `pre`, PreToolUse hook) of the sessions `lean-agent up` hosts (LEAN_AGENT_SERVICE_SESSION=1); no effect anywhere else.

At each tool boundary it hands the session what is waiting for it as additionalContext: a thread session gets its spooled
messages and answers ("[lean-agent: new message from main]"), main gets the queued thread reports ("[lean-agent: thread
reports]"). Items are claimed atomically (rename / ledger), so the typed paths never deliver them again. Never waits on a
busy lock (the call is skipped) and never fails the session.
"""
import os
import sys


def _home(*parts):
    return os.path.join(os.path.abspath(os.path.expanduser(os.environ.get("LEAN_AGENT_HOME") or "~/.lean-agent")), *parts)


def _has(path, needle=None):
    """The file exists and (with `needle`) contains it; never raises."""
    try:
        if needle is None:
            return os.path.exists(path)
        with open(path, "rb") as fh:
            return needle in fh.read()
    except OSError:
        return False


def nothing_pending(tid=""):
    """Fast path, stdlib only (a few stats): True when nothing can be waiting for this session. Anything doubtful is False
    and the full check runs."""
    if tid:
        try:
            return not os.listdir(_home("thread-inbox", tid))  # no spooled message, no .injected record, no .replacing mark
        except FileNotFoundError:
            return True
        except OSError:
            return False
    return not (_has(_home("reports-pending.json")) or _has(_home("thread-reports.json"), b'"kind"')
                or _has(_home("my-questions.json"), b'"answer_read": false'))


def main():
    if os.environ.get("LEAN_AGENT_SERVICE_SESSION") != "1":
        return 0
    tid = os.environ.get("LEAN_AGENT_THREAD") or ""
    if nothing_pending(tid if os.environ.get("LEAN_AGENT_SESSION_ROLE") == "thread" and tid else ""):
        return 0
    import json
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
        event = "PreToolUse" if "pre" in sys.argv[1:] else "PostToolUse"
        print(json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
