"""Recurring lean-agent work (`lean-agent schedule`): when each job is due, and running the due ones.

A job is a lean-agent command (`do <project> <recipe>`, `run ...`, `review ...`, `week`), never arbitrary shell, so
workers keep their rules: outward actions stop at awaiting-confirmation. Due jobs run from `lean-agent up` (a timer
while it runs), from the orchestrator's hook when no `up` timer is running, or from the optional service. Results
go to ~/.lean-agent/scheduled/ and scheduled.jsonl; the next conversation is told about new ones.

When:  "hourly" | "every 30m" | "every 2h" | "daily 09:00" | "weekdays 08:45" | "mon,wed 10:00" | "fri 16:00"
"""
import datetime
import json
import os
import re
import subprocess
import sys

DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
NOT_SCHEDULABLE = {"up", "service", "schedule", "install", "trust", "home"}
HERE = os.path.dirname(os.path.abspath(__file__))


def lean_home(*parts):
    return os.path.join(os.path.abspath(os.path.expanduser(os.environ.get("LEAN_AGENT_HOME") or "~/.lean-agent")), *parts)


def _load(path, default):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def _save(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w") as fh:
        json.dump(data, fh, indent=1)
    os.replace(tmp, path)


def jobs():
    return _load(lean_home("schedule.json"), [])


def save_jobs(items):
    _save(lean_home("schedule.json"), items)


def parse_when(text):
    """{"every": minutes} or {"days": [0-6], "at": "HH:MM"}; raises ValueError with a hint."""
    t = " ".join(str(text).lower().split())
    if t == "hourly":
        return {"every": 60}
    m = re.fullmatch(r"every (\d+)\s*(m|min|minutes?|h|hours?)", t)
    if m:
        n = int(m.group(1)) * (60 if m.group(2).startswith("h") else 1)
        if n < 15:
            raise ValueError("at most every 15 minutes")
        return {"every": n}
    m = re.fullmatch(r"(daily|weekdays|weekends|[a-z,]+) (\d{1,2}):(\d{2})", t)
    if m:
        which, hh, mm = m.group(1), int(m.group(2)), int(m.group(3))
        if hh > 23 or mm > 59:
            raise ValueError(f"no such time {hh}:{mm:02d}")
        if which == "daily":
            days = list(range(7))
        elif which == "weekdays":
            days = list(range(5))
        elif which == "weekends":
            days = [5, 6]
        else:
            names = which.split(",")
            bad = [d for d in names if d[:3] not in DAYS]
            if bad:
                raise ValueError(f"unknown day(s) {', '.join(bad)} (mon..sun)")
            days = sorted({DAYS.index(d[:3]) for d in names})
        return {"days": days, "at": f"{hh:02d}:{mm:02d}"}
    raise ValueError('use "hourly", "every 30m", "every 2h", "daily 09:00", "weekdays 08:45" or "mon,wed 10:00"')


def last_slot(when, now):
    """The latest time at or before `now` the job should have run (for day/time jobs); None for interval jobs."""
    if "every" in when:
        return None
    hh, mm = map(int, when["at"].split(":"))
    for back in range(8):
        day = now - datetime.timedelta(days=back)
        slot = day.replace(hour=hh, minute=mm, second=0, microsecond=0)
        if day.weekday() in when["days"] and slot <= now:
            return slot
    return None


def is_due(job, now=None):
    now = now or datetime.datetime.now()
    if not job.get("enabled", True):
        return False
    when = parse_when(job["when"])
    last = datetime.datetime.fromisoformat(job["last"]) if job.get("last") else None
    created = datetime.datetime.fromisoformat(job["created"])
    if "every" in when:
        return (now - (last or created)).total_seconds() >= when["every"] * 60
    slot = last_slot(when, now)
    if not slot or slot < created:
        return False
    if (now - slot).total_seconds() > 6 * 3600:
        return False  # missed by more than 6 hours (asleep, off): wait for the next slot instead of running late
    return last is None or last < slot


def next_run(job, now=None):
    now = now or datetime.datetime.now()
    when = parse_when(job["when"])
    if "every" in when:
        last = datetime.datetime.fromisoformat(job.get("last") or job["created"])
        return max(now, last + datetime.timedelta(minutes=when["every"]))
    hh, mm = map(int, when["at"].split(":"))
    for ahead in range(8):
        day = now + datetime.timedelta(days=ahead)
        slot = day.replace(hour=hh, minute=mm, second=0, microsecond=0)
        if day.weekday() in when["days"] and slot > now:
            return slot
    return None


def any_due():
    try:
        return any(is_due(j) for j in jobs())
    except (ValueError, KeyError, TypeError):
        return False


def run_due(log=print):
    """Run every due job once (one runner at a time); returns the result records."""
    try:
        import fcntl
    except ImportError:
        fcntl = None
    os.makedirs(lean_home("scheduled"), exist_ok=True)
    lock = open(lean_home("scheduled", ".lock"), "w")
    if fcntl:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return []  # another runner is at it
    done = []
    for job in jobs():
        try:
            due = is_due(job)
        except (ValueError, KeyError, TypeError):
            continue
        if not due:
            continue
        items = jobs()  # mark it started first, so a slow job isn't started twice
        for j in items:
            if j["id"] == job["id"]:
                j["last"] = datetime.datetime.now().isoformat(timespec="seconds")
        save_jobs(items)
        stamp = datetime.datetime.now().strftime("%m%d-%H%M")
        out_path = lean_home("scheduled", f"{job['id']}-{stamp}.txt")
        cmd = [sys.executable, os.path.join(HERE, "lean_agent.py"), *job["args"]]
        env = dict(os.environ, LEAN_AGENT_LAUNCH_GUARD="0", LEAN_AGENT_SCHEDULED=str(job["id"]))
        try:
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=3600, env=env,
                               stdin=subprocess.DEVNULL)
            rc, text = p.returncode, p.stdout + (("\n" + p.stderr) if p.stderr.strip() else "")
        except subprocess.TimeoutExpired:
            rc, text = 124, "timed out after an hour"
        with open(out_path, "w") as fh:
            fh.write(text)
        first = next((l.strip() for l in text.splitlines() if l.strip()), "")
        rec = {"ts": datetime.datetime.now().isoformat(timespec="seconds"), "id": job["id"], "args": job["args"],
               "rc": rc, "output": out_path, "first": first[:200]}
        with open(lean_home("scheduled.jsonl"), "a") as fh:
            fh.write(json.dumps(rec) + "\n")
        log(f"scheduled job {job['id']} ({' '.join(job['args'])}): exit {rc}, output {out_path}")
        done.append(rec)
    return done


def results_since(ts):
    out = []
    try:
        with open(lean_home("scheduled.jsonl")) as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if r.get("ts", "") > ts:
                    out.append(r)
    except OSError:
        pass
    return out


def spawn_runner():
    """Start `lean-agent schedule run-due` in the background, detached (from a hook: never wait)."""
    try:
        subprocess.Popen([sys.executable, os.path.join(HERE, "lean_agent.py"), "schedule", "run-due"],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)
    except OSError:
        pass


def timer_alive():
    """Whether a `lean-agent up` timer is running (it writes a heartbeat every few minutes)."""
    try:
        age = datetime.datetime.now().timestamp() - os.path.getmtime(lean_home("scheduled", ".timer"))
        return age < 15 * 60
    except OSError:
        return False
