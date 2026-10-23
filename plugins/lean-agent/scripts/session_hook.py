#!/usr/bin/env python3
"""SessionStart hook for the session `lean-agent up` hosts (LEAN_AGENT_SERVICE_SESSION=1); no effect anywhere else.

After a /clear it also prints the brief (`lean-agent brief`, the last checkpoint first) as additionalContext, so
the orchestrator continues from it. Records which transcript the session writes now (chat/service.json), for every source (startup, resume, clear,
compact): /clear starts a new transcript with a new id, and this is how the dashboard learns of it. The record also
keeps the chain of transcripts the session has used, oldest first (the last CHAIN_KEEP), so the dashboard can show a
thread's history across clears. Only when the
hook runs under the service claude (its pid in up.json is an ancestor, with no other claude nearer). Prints nothing else
and never fails the session.
"""
import json
import os
import subprocess
import sys
import time

BRIEF_CAP = 3000  # characters of brief added to a cleared session
CHAIN_KEEP = 20   # transcripts kept in the record's chain


def restarted_fresh(home, event):
    """True for the startup of the session `up --clear` / `service restart --clear` / the dashboard's Restart fresh
    asked for: up.json names its id as fresh_sid."""
    if event.get("source") != "startup":
        return False
    try:
        with open(os.path.join(home, "up.json")) as fh:
            return json.load(fh).get("fresh_sid") == event["session_id"]
    except (OSError, ValueError, AttributeError):
        return False


def chain_of(old, event, now, fresh):
    """The record's chain after this event: `old`'s paths with the event's transcript last (moved there when it was
    already in), with when and why each one started."""
    chain = [p for p in (old.get("chain") or []) if isinstance(p, str)]
    meta = old.get("chain_meta") if isinstance(old.get("chain_meta"), dict) else {}
    path = event.get("transcript_path")
    if isinstance(path, str) and path:
        if not (chain and chain[-1] == path and path in meta):
            meta[path] = {"ts": now, "source": event.get("source"), **({"fresh": True} if fresh else {})}
        chain = [p for p in chain if p != path] + [path]
    chain = chain[-CHAIN_KEEP:]
    return chain, {p: meta[p] for p in chain if isinstance(meta.get(p), dict)}


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


def follow_up(home, event):
    """up.json names the session a restart of `up` resumes: when this event starts a new session id (a /clear, or a
    compaction that starts a new id), it records that id and its transcript, atomically."""
    path = os.path.join(home, "up.json")
    try:
        with open(path) as fh:
            up = json.load(fh)
    except (OSError, ValueError):
        return
    if not isinstance(up, dict) or up.get("session_id") == event["session_id"]:
        return
    up["session_id"] = event["session_id"]
    if event.get("transcript_path"):
        up["transcript"] = event["transcript_path"]
    tmp = f"{path}.{os.getpid()}.tmp"
    try:
        with open(tmp, "w") as fh:
            json.dump(up, fh, indent=2)
        os.replace(tmp, path)
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


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
    try:
        with open(path) as fh:
            old = json.load(fh)
    except (OSError, ValueError):
        old = {}
    if not isinstance(old, dict):
        old = {}
    now = time.time()
    fresh = restarted_fresh(home, event)
    chain, meta = chain_of(old, event, now, fresh)
    with open(tmp, "w") as fh:
        json.dump({"session_id": event["session_id"], "transcript_path": event.get("transcript_path"),
                   "source": event.get("source"), "ts": now, "chain": chain, "chain_meta": meta}, fh)
    os.replace(tmp, path)
    if event.get("source") == "clear" or fresh:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import compact_hook
        text = compact_hook.brief(BRIEF_CAP)
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": text}}),
              flush=True)
    try:  # after the brief, so a failure here can never skip it
        follow_up(home, event)
    except Exception:
        pass


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        pass
