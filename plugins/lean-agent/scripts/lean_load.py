"""Machine load guard and lean-agent process inventory (stdlib only; cheap to import).

overloaded(): a reason string when the machine is overloaded (1-minute load above 2x the CPU cores, or very little free
memory), else None. New worker runs queue and automatic actions back off while it is. LEAN_AGENT_LOAD_GUARD=0 turns it
off; LEAN_AGENT_FAKE_LOAD="<load1>,<free_mb>" is for tests.

processes(): the lean-agent Python processes (pid, cpu %, rss MB, age, command); strays(): the ones nothing owns.
"""
import os
import re
import signal
import subprocess
import time

LOAD_FACTOR = 2.0
LOW_FREE_MB = 256
CACHE_SECS = 10
_CACHE = {"at": 0.0, "val": None}


def free_mb():
    """Memory that can be used without swapping, in MB; None when unknown."""
    try:
        with open("/proc/meminfo") as fh:
            for line in fh:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) // 1024
    except (OSError, ValueError, IndexError):
        pass
    try:  # macOS
        out = subprocess.run(["vm_stat"], capture_output=True, text=True, timeout=3).stdout
        size = int(re.search(r"page size of (\d+)", out).group(1))
        pages = sum(int(m.group(1)) for k in ("Pages free", "Pages inactive", "Pages speculative")
                    for m in [re.search(k + r":\s+(\d+)", out)] if m)
        return pages * size // (1024 * 1024)
    except (OSError, ValueError, AttributeError, subprocess.SubprocessError):
        return None


def sample():
    """{"load1", "cores", "free_mb"} now (LEAN_AGENT_FAKE_LOAD overrides load and memory)."""
    cores = os.cpu_count() or 1
    fake = os.environ.get("LEAN_AGENT_FAKE_LOAD")
    if fake:
        try:
            a, b = (fake.split(",") + ["100000"])[:2]
            return {"load1": float(a), "cores": cores, "free_mb": int(float(b))}
        except ValueError:
            pass
    try:
        load1 = os.getloadavg()[0]
    except (OSError, AttributeError):
        load1 = 0.0
    return {"load1": load1, "cores": cores, "free_mb": free_mb()}


def reason(s):
    if s["load1"] > LOAD_FACTOR * s["cores"]:
        return f"load {s['load1']:.1f} is over {LOAD_FACTOR:g}x the {s['cores']} cores"
    if s["free_mb"] is not None and s["free_mb"] < LOW_FREE_MB:
        return f"only {s['free_mb']} MB of memory free"
    return None


def overloaded(now=None):
    """Why the machine is overloaded (one short phrase), or None. Cached for CACHE_SECS."""
    if os.environ.get("LEAN_AGENT_LOAD_GUARD") == "0":
        return None
    now = time.time() if now is None else now
    if os.environ.get("LEAN_AGENT_FAKE_LOAD") is None and _CACHE["val"] is not None and now - _CACHE["at"] < CACHE_SECS:
        return _CACHE["val"][0]
    r = reason(sample())
    _CACHE.update(at=now, val=(r,))
    return r


def status_line():
    s = sample()
    r = reason(s)
    mem = f", {s['free_mb']} MB free" if s["free_mb"] is not None else ""
    base = f"machine load {s['load1']:.1f} on {s['cores']} cores{mem}"
    return base + (f": OVERLOADED ({r}); new runs queue, chases, redelivery, pollers and review-learn back off" if r else "")


# ---------------------------------------------------------------- processes

OURS_RE = re.compile(r"lean_agent\.py|lean-agent|service_session|/scripts/\w+_hook\.py|lean_poll\.py|trampoline\.py")


def _etime(text):
    """ps etime ([[dd-]hh:]mm:ss) in seconds."""
    days, _, rest = text.partition("-") if "-" in text else ("0", "", text)
    parts = [int(x) for x in rest.split(":")]
    secs = 0
    for p in parts:
        secs = secs * 60 + p
    return int(days) * 86400 + secs


def processes():
    """[{pid, ppid, cpu, rss_mb, age, cmd}] of the processes whose command line is lean-agent's (this one excluded)."""
    try:
        out = subprocess.run(["ps", "-axo", "pid=,ppid=,pcpu=,rss=,etime=,command="], capture_output=True, text=True,
                             timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    res = []
    for line in out.splitlines():
        f = line.split(None, 5)
        if len(f) < 6 or not OURS_RE.search(f[5]) or "python" not in f[5].lower() or " doctor" in f[5]:
            continue
        try:
            pid = int(f[0])
            res.append({"pid": pid, "ppid": int(f[1]), "cpu": float(f[2]), "rss_mb": int(f[3]) // 1024,
                        "age": _etime(f[4]), "cmd": f[5]})
        except ValueError:
            continue
    return [p for p in res if p["pid"] != os.getpid()]


def kind(cmd):
    if re.search(r"_hook\.py|statusline\.py", cmd):
        return "hook"
    m = re.search(r"lean_agent\.py\s+(?:--\S+\s+)*(\w+)", cmd) or re.search(r"lean-agent\s+(\w+)", cmd)
    return m.group(1) if m else "other"


def strays(procs, owned):
    """[(process, why)]: a hook running over a minute (stuck), an `up` besides the owner, a run supervisor or poll worker
    that no marker or poll record owns. `owned`: {"up": pid or None, "pids": set of pids owned by markers/polls}."""
    out = []
    ups = sorted((p for p in procs if kind(p["cmd"]) == "up"), key=lambda p: -p["age"])
    keep = owned.get("up") or (ups[0]["pid"] if ups else None)
    for p in procs:
        k = kind(p["cmd"])
        if k == "hook" and p["age"] > 60:
            out.append((p, f"hook running {p['age']}s (stuck, probably on a lock)"))
        elif k == "up" and p["pid"] != keep:
            out.append((p, f"second `up` process (the service is pid {keep})"))
        elif k in ("run", "poll") and p["age"] > 300 and p["pid"] not in owned.get("pids", ()) \
                and p["ppid"] not in owned.get("pids", ()):
            out.append((p, f"{k} process with no running marker or poll record ({p['age'] // 60}m old)"))
    return out


def kill_stray(p, sig=signal.SIGTERM):
    """Stops one stray by pid (never its group) after checking the pid still has the same command. True when signalled."""
    now = [q for q in processes() if q["pid"] == p["pid"]]
    if not now or now[0]["cmd"] != p["cmd"]:
        return False
    try:
        os.kill(p["pid"], sig)
        return True
    except OSError:
        return False
