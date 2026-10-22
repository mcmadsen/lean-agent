#!/usr/bin/env python3
"""SessionStart hook for the session `lean-agent up` hosts (LEAN_AGENT_SERVICE_SESSION=1); no effect anywhere else.

Records which transcript the session writes now (chat/service.json), for every source (startup, resume, clear,
compact): /clear starts a new transcript with a new id, and this is how the dashboard learns of it. Only when the
hook runs under the service claude (its pid in up.json is one of the hook's ancestors). Prints nothing and never
fails the session.
"""
import json
import os
import subprocess
import sys
import time


def parent_pid(pid):
    """The parent of `pid` (0 when unknown): /proc on Linux, `ps` elsewhere."""
    try:
        with open(f"/proc/{pid}/stat") as fh:
            return int(fh.read().rsplit(")", 1)[1].split()[1])
    except (OSError, ValueError, IndexError):
        pass
    try:
        out = subprocess.run(["ps", "-o", "ppid=", "-p", str(pid)], capture_output=True, text=True, timeout=5).stdout
        return int(out.strip())
    except (OSError, ValueError, subprocess.SubprocessError):
        return 0


def owned(home, ppid=parent_pid, wait=3.0):
    """True when one of this process's ancestors (up to 4) is the service claude pid in up.json. `up` writes the pid
    just after the spawn, so a hook that is faster than that waits briefly for it."""
    deadline = time.time() + wait
    while True:
        try:
            with open(os.path.join(home, "up.json")) as fh:
                pid = json.load(fh).get("pid")
        except (OSError, ValueError, AttributeError):
            pid = None
        if isinstance(pid, int) and pid > 0:
            break
        if time.time() >= deadline:
            return False
        time.sleep(0.05)
    cur = os.getpid()
    for _ in range(4):
        cur = ppid(cur)
        if cur <= 1:
            return False
        if cur == pid:
            return True
    return False


def main(ppid=parent_pid):
    if os.environ.get("LEAN_AGENT_SERVICE_SESSION") != "1":
        return
    event = json.load(sys.stdin)
    if not isinstance(event, dict) or not event.get("session_id"):
        return
    home = os.path.abspath(os.path.expanduser(os.environ.get("LEAN_AGENT_HOME") or "~/.lean-agent"))
    if not owned(home, ppid):
        return
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
