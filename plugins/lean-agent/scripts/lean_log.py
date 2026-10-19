"""lean-agent's local logs, split by level so each is easy to read on its own:

    ~/.lean-agent/logs/error.log    errors only: failed workers, hook errors, errors found in command output
    ~/.lean-agent/logs/debug.log    every event and decision (runs, squeezes, MCP probes), errors included
    ~/.lean-agent/logs/verbose/     full output of every squeezed command, plus an errors-only copy of each

Nothing here is sent to Claude unless someone reads a file. Files rotate at 2 MB (one old copy kept);
verbose outputs are kept for 2 days. LEAN_AGENT_LOG_DIR moves the folder.
"""
import datetime
import glob
import os
import time

MAX_BYTES = 2 * 1024 * 1024
KEEP_VERBOSE_SECONDS = 2 * 24 * 3600


def log_dir(*parts):
    base = os.environ.get("LEAN_AGENT_LOG_DIR") or os.path.join(
        os.path.expanduser(os.environ.get("LEAN_AGENT_HOME") or "~/.lean-agent"), "logs")
    return os.path.join(base, *parts)


def _append(name, line):
    path = log_dir(name)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if os.path.exists(path) and os.path.getsize(path) > MAX_BYTES:
            os.replace(path, path + ".1")
        with open(path, "a", encoding="utf-8", errors="replace") as fh:
            fh.write(line)
    except OSError:
        pass  # logging must never break a run or a hook


def log(level, component, message):
    """level: "error" (error.log + debug.log) or "debug" (debug.log)."""
    ts = datetime.datetime.now().isoformat(timespec="seconds")
    text = str(message).replace("\n", "\n    ")
    line = f"{ts} {level.upper():<5} {component}: {text}\n"
    if level == "error":
        _append("error.log", line)
    _append("debug.log", line)


def verbose_path(name):
    """A new file under logs/verbose/, after removing ones older than 2 days."""
    d = log_dir("verbose")
    os.makedirs(d, exist_ok=True)
    now = time.time()
    for old in glob.glob(os.path.join(d, "*.log")):
        try:
            if now - os.path.getmtime(old) > KEEP_VERBOSE_SECONDS:
                os.remove(old)
        except OSError:
            pass
    return os.path.join(d, datetime.datetime.now().strftime("%m%d-%H%M%S-") + name)


def record_saving(kind, before, after):
    """A local note of output lean-agent shortened (chars before and after), for `lean-agent savings`."""
    import json as _json
    path = os.path.join(os.path.dirname(log_dir()), "savings.jsonl")
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a") as fh:
            fh.write(_json.dumps({"ts": datetime.datetime.now().isoformat(timespec="seconds"), "kind": kind,
                                  "before": before, "after": after}) + "\n")
    except OSError:
        pass
