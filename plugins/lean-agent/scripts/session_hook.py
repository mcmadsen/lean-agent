#!/usr/bin/env python3
"""SessionStart hook for the session `lean-agent up` hosts (LEAN_AGENT_SERVICE_SESSION=1); no effect anywhere else.

Records which transcript the session writes now (chat/service.json), for every source (startup, resume, clear,
compact): /clear starts a new transcript with a new id, and this is how the dashboard learns of it. Only when the
hook runs under the service claude (its pid in up.json is an ancestor, with no other claude nearer). Prints nothing
and never fails the session.
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


def argv_of(pid):
    """The command line of `pid` as a list ([] when unknown)."""
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as fh:
            return [a.decode(errors="replace") for a in fh.read().split(b"\0") if a]
    except OSError:
        pass
    try:
        out = subprocess.run(["ps", "-o", "args=", "-p", str(pid)], capture_output=True, text=True, timeout=5).stdout
        return out.split()
    except (OSError, subprocess.SubprocessError):
        return []


def is_claude(argv):
    """True for a claude process: its executable's basename is claude, or it is an interpreter running the claude CLI
    (node .../claude, node .../claude-code/cli.js)."""
    if not argv:
        return False
    if os.path.basename(argv[0]) == "claude":
        return True
    if len(argv) < 2:
        return False
    if os.path.basename(argv[1]) == "claude":
        return True
    parts = argv[1].replace("\\", "/").split("/")
    return parts[-1] == "cli.js" and "claude-code" in parts[:-1]


def owned(home, ppid=parent_pid, cmd=argv_of, wait=3.0):
    """True when the service claude pid in up.json is among the first 8 ancestors of this process, whatever its command
    (a custom name or a wrapper still works), with no other claude nearer: a claude started from the service claude's
    Bash tool does not count. `up` writes the pid just after the spawn, so a hook that is faster than that waits
    briefly for it."""
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
    for _ in range(8):
        cur = ppid(cur)
        if cur <= 1:
            return False
        if cur == pid:
            return True
        if is_claude(cmd(cur)):
            return False
    return False


def main(ppid=parent_pid, cmd=argv_of, wait=3.0):
    if os.environ.get("LEAN_AGENT_SERVICE_SESSION") != "1":
        return
    event = json.load(sys.stdin)
    if not isinstance(event, dict) or not event.get("session_id"):
        return
    home = os.path.abspath(os.path.expanduser(os.environ.get("LEAN_AGENT_HOME") or "~/.lean-agent"))
    if not owned(home, ppid, cmd, wait):
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
