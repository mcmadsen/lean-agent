"""Slow-command traces: a command or hook that is still running after N seconds dumps every thread's stack into
<lean home>/logs/slow/<utc-ts>-<name>-<pid>.txt (faulthandler, so it works while the main thread is stuck in a syscall
or a lock). The file is opened up front and removed on a normal, fast exit. Per-phase timings are appended when the
process ends. `lean-agent doctor` and `feedback` list the newest traces. Stdlib only and cheap: one open file and one
watchdog thread (C level) per process."""
import datetime
import faulthandler
import os
import re
import sys
import time

KEEP = 50
CLI_AFTER = 8.0
HOOK_AFTER = 4.0
T0 = time.time()
STATE = {}


def folder():
    return os.path.join(os.path.abspath(os.path.expanduser(os.environ.get("LEAN_AGENT_HOME") or "~/.lean-agent")),
                        "logs", "slow")


def after_secs(default):
    try:
        return float(os.environ.get("LEAN_AGENT_SLOW_AFTER") or default)
    except ValueError:
        return default


def arm(kind, name, default=None):
    """Start the watchdog for this process (kind: 'cli' or 'hook'); never raises."""
    try:
        after = after_secs(default if default is not None else (HOOK_AFTER if kind == "hook" else CLI_AFTER))
        if after <= 0 or STATE.get("fh"):
            return
        d = folder()
        os.makedirs(d, exist_ok=True)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S")
        label = re.sub(r"[^A-Za-z0-9_.-]", "-", str(name))[:40] or kind
        path = os.path.join(d, f"{stamp}-{label}-{os.getpid()}.txt")
        fh = open(path, "w")
        STATE.update(fh=fh, path=path, after=after, kind=kind, name=str(name), start=time.time(), phases=[])
        faulthandler.dump_traceback_later(after, repeat=False, file=fh)
    except Exception:  # noqa: BLE001 - diagnostics must never break a command
        STATE.clear()


def phase(label):
    """Note that `label` just finished (seconds since the process started)."""
    if STATE.get("fh"):
        STATE["phases"].append((label, time.time() - STATE["start"]))


def disarm():
    """Normal exit: cancel the dump; keep the file (with the phase timings) only when it fired."""
    fh = STATE.pop("fh", None)
    if not fh:
        return
    try:
        faulthandler.cancel_dump_traceback_later()
        phase("end")
        path, phases, after = STATE["path"], STATE["phases"], STATE["after"]
        fired = os.path.getsize(path) > 0
        if fired:
            last = 0.0
            fh.write(f"\n{STATE['kind']} {STATE['name']} pid {os.getpid()} total {phases[-1][1]:.2f}s (dump after {after:g}s)\n")
            for label, t in phases:
                fh.write(f"phase {label}: {t - last:.2f}s (at {t:.2f}s)\n")
                last = t
        fh.close()
        if fired:
            prune()
        else:
            os.unlink(path)
    except Exception:  # noqa: BLE001
        pass
    STATE.clear()


def prune(keep=KEEP):
    files = sorted(os.listdir(folder()))
    for f in files[:-keep] if len(files) > keep else []:
        try:
            os.unlink(os.path.join(folder(), f))
        except OSError:
            pass
    for f in files[-keep:]:  # an empty trace older than a minute is a process that died before it could clean up
        p = os.path.join(folder(), f)
        try:
            if os.path.getsize(p) == 0 and time.time() - os.path.getmtime(p) > 60:
                os.unlink(p)
        except OSError:
            pass


def newest(n=3):
    """[(path, [first lines of the deepest frame])] of the newest traces, newest first."""
    out = []
    try:
        files = sorted(f for f in os.listdir(folder()) if f.endswith(".txt"))[::-1]
    except OSError:
        return out
    for f in files:
        p = os.path.join(folder(), f)
        try:
            with open(p, errors="replace") as fh:
                lines = fh.read().splitlines()
        except OSError:
            continue
        if not lines:
            continue
        deep = next((i for i, l in enumerate(lines) if l.startswith("Current thread") or l.startswith("Thread")), None)
        frame = lines[deep + 1:deep + 3] if deep is not None else lines[:2]
        out.append((p, [l.strip() for l in frame]))
        if len(out) >= n:
            break
    return out


def report_lines(n=3):
    return [f"slow trace {p}: " + " | ".join(frame) for p, frame in newest(n)]
