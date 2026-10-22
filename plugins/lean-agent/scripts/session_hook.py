#!/usr/bin/env python3
"""SessionStart hook for the session `lean-agent up` hosts (LEAN_AGENT_SERVICE_SESSION=1); no effect anywhere else.

Records which transcript the session writes now (chat/service.json), for every source (startup, resume, clear,
compact): /clear starts a new transcript with a new id, and this is how the dashboard learns of it. Prints nothing
and never fails the session.
"""
import json
import os
import sys
import time


def main():
    if os.environ.get("LEAN_AGENT_SERVICE_SESSION") != "1":
        return
    event = json.load(sys.stdin)
    if not isinstance(event, dict) or not event.get("session_id"):
        return
    home = os.path.abspath(os.path.expanduser(os.environ.get("LEAN_AGENT_HOME") or "~/.lean-agent"))
    path = os.path.join(home, "chat", "service.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w") as fh:
        json.dump({"session_id": event["session_id"], "transcript_path": event.get("transcript_path"),
                   "source": event.get("source"), "ts": time.time()}, fh)
    os.replace(tmp, path)


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        pass
