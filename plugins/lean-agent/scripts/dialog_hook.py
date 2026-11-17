#!/usr/bin/env python3
"""Dialog hook of the sessions `lean-agent up` hosts (LEAN_AGENT_SERVICE_SESSION=1); no effect anywhere else.

Arguments: `pre` (PreToolUse AskUserQuestion: a dialog opens), `post` (PostToolUse AskUserQuestion: it was answered),
`close` (Stop, UserPromptSubmit, SessionStart). While a dialog is open the service holds back thread-report and message
deliveries to the session, so a notification can never become the dialog's answer. The service is told with one
fire-and-forget socket line (never waits on it); with the service down nothing happens.

`post` also checks the recorded answer: when it is one of lean-agent's own notifications (service_session.NOTIFY_RE) the
model is told it was not the user's choice and to ask again.
"""
import json
import os
import sys

ASK_AGAIN = ("That answer was an automatic lean-agent notification, not the user's choice. Ask the question again; "
             "the notification is: ")


def key_and_thread():
    tid = os.environ.get("LEAN_AGENT_THREAD") or ""
    if os.environ.get("LEAN_AGENT_SESSION_ROLE") == "thread" and tid:
        return tid, tid
    return "main", ""


def answer_text(event):
    """The answer of an AskUserQuestion PostToolUse event as one string."""
    out = event.get("tool_response")
    if out is None:
        out = event.get("tool_output")

    def flat(x):
        if isinstance(x, str):
            return x
        if isinstance(x, dict):
            return " ".join(flat(v) for v in x.values())
        if isinstance(x, list):
            return " ".join(flat(v) for v in x)
        return ""
    return flat(out).strip()


def notification_line(text):
    """The first line of `text` that is a lean-agent notification, or ''."""
    if "lean-agent" not in text and "[r" not in text:
        return ""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import service_session
    for line in text.splitlines() or [text]:
        if service_session.NOTIFY_RE.search(line):
            return line.strip()[:400]
    return ""


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if os.environ.get("LEAN_AGENT_SERVICE_SESSION") != "1":
        return 0
    mode = argv[0] if argv else "close"
    event = {}
    if mode == "post":
        try:
            event = json.load(sys.stdin)
        except ValueError:
            event = {}
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import lean_sock  # stdlib only
    _, tid = key_and_thread()
    lean_sock.call_nowait("dialog", state="open" if mode == "pre" else "closed", thread=tid)
    if mode == "post":
        try:
            line = notification_line(answer_text(event))
        except Exception:  # noqa: BLE001 - never fails the session
            line = ""
        if line:
            print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": ASK_AGAIN + line}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
