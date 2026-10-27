"""Small helpers shared by lean_agent and the hooks (stdlib only, so any of them can import it)."""
import contextlib
import datetime
import glob
import json
import os
import re
import time
import uuid

try:
    import fcntl
except ImportError:  # Windows
    fcntl = None

PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STANDARD_WINDOW = 200000  # a model's context window unless it is a 1M one
LONG_WINDOW = 1000000


def thread_key(tid):
    """The chat key of a thread id: `#12` -> `12`, `t3` stays."""
    tid = str(tid or "")
    return tid[1:] if tid.startswith("#") else tid


def compact_buffer():
    """Claude Code's fixed autocompact buffer (LEAN_AGENT_COMPACT_BUFFER, default 33,000)."""
    try:
        return int(os.environ.get("LEAN_AGENT_COMPACT_BUFFER") or 33000)
    except ValueError:
        return 33000


def configured_model():
    """The orchestrator's model: ANTHROPIC_MODEL, else the `model` pinned in its home's settings ("" if neither)."""
    return os.environ.get("ANTHROPIC_MODEL") or read_json(lean_home("home", ".claude", "settings.json"), {}).get("model") or ""


def model_window(model=None):
    """The context window of `model` (default: the configured one): 1M for [1m]/1M models, else 200K."""
    model = str(model or configured_model()).lower()
    return LONG_WINDOW if "[1m]" in model or "-1m" in model or model.endswith("1m") else STANDARD_WINDOW


def compaction_point(window=None, pct=None, model=None):
    """Tokens at which Claude Code compacts: the percentage of the window, but never past the window minus its
    fixed autocompact buffer. No window and no percentage = Claude Code's own default: the model's window less the buffer."""
    # Claude Code's /context panel shows a 33k autocompact buffer on a 100k window, i.e. compaction at ~67k
    # (the percentage alone would say 70k).
    full = window or model_window(model)
    return int(min(full * (pct or 100) / 100, full - compact_buffer()))


COMPACT_WINDOW_MIN = 100000  # the smallest CLAUDE_CODE_AUTO_COMPACT_WINDOW Claude Code accepts
COMPACT_PCT_RANGE = (10, 95)


def compact_overrides(env=None, problems=None):
    """(window, pct) the orchestrator is told to compact by, each None when Claude Code's default applies:
    LEAN_AGENT_COMPACT_WINDOW / LEAN_AGENT_COMPACT_PCT, else `lean-agent config compact-window|compact-pct`.
    "default" (or nothing) means no override. A value `config` would refuse is ignored (Claude Code's default applies)
    and described in `problems` when given."""
    env = os.environ if env is None else env
    cfg = read_json(lean_home("config.json"), {})
    cfg = cfg if isinstance(cfg, dict) else {}
    limits = {"compact_window": (COMPACT_WINDOW_MIN, None), "compact_pct": COMPACT_PCT_RANGE}
    out = []
    for name, key in (("LEAN_AGENT_COMPACT_WINDOW", "compact_window"), ("LEAN_AGENT_COMPACT_PCT", "compact_pct")):
        raw = str(env.get(name) or cfg.get(key) or "default").strip().lower()
        try:
            n = int(float(raw))
        except (ValueError, OverflowError):
            n = 0
        lo, hi = limits[key]
        if raw != "default" and not (n >= lo and (hi is None or n <= hi)):
            if problems is not None:
                problems.append(f"{name if env.get(name) else key.replace('_', '-')} {raw!r} is not "
                                + (f"{lo} or more" if hi is None else f"{lo}-{hi}") + "; Claude Code's default applies")
            n = 0
        out.append(n if n > 0 else None)
    return tuple(out)


def compaction_label(window=None, pct=None, model=None, source=True):
    """`compaction: ...` text for doctor and service status; source=False leaves out where the setting comes from."""
    if not window and not pct:
        w = model_window(model)
        size = f"{w // 1000000}M" if w >= 1000000 else f"{w // 1000}k"
        return f"Claude Code default (~{compaction_point(model=model) // 1000}k for a {size} window)"
    return (f"~{compaction_point(window, pct, model):,} (compact-window {window or 'default'}, "
            f"pct {pct or 'default'}{'; set by config' if source else ''})")


def lean_home(*parts):
    """~/.lean-agent (or $LEAN_AGENT_HOME), absolute, with `parts` joined on."""
    return os.path.join(os.path.abspath(os.path.expanduser(os.environ.get("LEAN_AGENT_HOME") or "~/.lean-agent")), *parts)


def read_json(path, default):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


@contextlib.contextmanager
def file_lock(path):
    """Exclusive advisory lock on `path` + '.lock' (read-modify-write of a shared json file)."""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path + ".lock", "a") as lock:
        if fcntl:
            fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield
        finally:
            if fcntl:
                fcntl.flock(lock, fcntl.LOCK_UN)


def write_json_atomic(path, data):
    tmp = f"{path}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp"
    with open(tmp, "w") as fh:
        json.dump(data, fh, indent=1)
    os.replace(tmp, path)


COLLECTED_CUTOFF = "_cutoff"  # collected.json key: runs recorded before it count as collected (legacy ledger)


DURATION_UNITS = {"s": 1, "m": 60, "": 60, "h": 3600, "d": 86400}


def parse_duration(text):
    """Seconds in a duration such as 90m, 2h, 1d or 45s (a bare number is minutes); ValueError otherwise."""
    m = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*([smhd]?)\s*", str(text or ""))
    if not m:
        raise ValueError(f"not a duration: {text!r} (use e.g. 90m, 2h, 1d)")
    return float(m.group(1)) * DURATION_UNITS[m.group(2)]


def now_iso():
    return datetime.datetime.now().isoformat(timespec="seconds")


def stem(w):
    """A crude stem for matching words (task types, thread routing): drops ing/ies/es/ed/s, keeping 4+ letters."""
    for suffix in ("ing", "ies", "es", "ed", "s"):
        if w.endswith(suffix) and len(w) - len(suffix) >= 4:
            return w[: -len(suffix)] + ("y" if suffix == "ies" else "")
    return w


def seed_collected(lean_home):
    """The collected.json of this home: created on first use with a cutoff (now), so ledger entries from before it
    (a ledger older than collected.json) count as collected without writing all their ids."""
    path = os.path.join(lean_home, "collected.json")
    done = read_json(path, None)
    if not isinstance(done, dict):
        try:
            with file_lock(path):
                done = read_json(path, None)
                if not isinstance(done, dict):
                    done = {COLLECTED_CUTOFF: now_iso()}
                    write_json_atomic(path, done)
        except OSError:  # unwritable home: an in-memory cutoff of now
            done = {COLLECTED_CUTOFF: now_iso()}
    return done


def mark_collected_ids(lean_home, run_ids):
    """Record in collected.json that these runs' results were shown to someone."""
    ids = [r for r in run_ids if r]
    if not ids:
        return
    seed_collected(lean_home)
    path = os.path.join(lean_home, "collected.json")
    try:
        with file_lock(path):
            done = read_json(path, {})
            done.update({r: now_iso() for r in ids})
            write_json_atomic(path, done)
    except OSError:
        pass


def uncollected_ids(lean_home, live_ids=()):
    """Ids of the finished ordinary (non-role) runs in the ledger whose result was never printed to anyone
    (not in collected.json, recorded after its cutoff), oldest first. The first call without a collected.json seeds
    the cutoff, so a ledger from before this existed isn't reported as waiting. A resumed run counts once, by its
    latest ledger entry."""
    done = seed_collected(lean_home)
    cutoff = done.get(COLLECTED_CUTOFF) or ""
    latest = {}
    try:
        with open(os.path.join(lean_home, "ledger.jsonl")) as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if isinstance(r, dict) and r.get("id") and not r.get("role"):
                    latest.pop(r["id"], None)  # keeps the order of the latest entries
                    latest[r["id"]] = r
    except OSError:
        pass
    return [i for i, r in latest.items() if i not in done and i not in live_ids and (r.get("ts") or "") >= cutoff]


def running_runs(lean_home):
    """[(run id, marker)] of the runs in progress, oldest first: running/*.json whose process is alive."""
    out = []
    for f in glob.glob(os.path.join(lean_home, "running", "*.json")):
        try:
            with open(f) as fh:
                m = json.load(fh)
        except (OSError, ValueError):
            continue
        if isinstance(m, dict) and m.get("pid") and pid_alive(m["pid"]):
            out.append((m.get("run") or os.path.basename(f)[:-5], m))
    return sorted(out, key=lambda x: (x[1].get("started") or "", x[0]))


def lost_runs(lean_home, acknowledged=False):
    """[(run id, marker)] of runs whose supervisor died without recording a result: a running/*.json whose process is
    gone and whose run is not in the ledger (and that `runs --lost --clear` has not acknowledged, unless acknowledged=True)."""
    done = set()
    try:
        with open(os.path.join(lean_home, "ledger.jsonl")) as fh:
            for line in fh:
                try:
                    done.add(json.loads(line).get("id"))
                except (ValueError, AttributeError):
                    continue
    except OSError:
        pass
    out = []
    for f in glob.glob(os.path.join(lean_home, "running", "*.json")):
        try:
            with open(f) as fh:
                m = json.load(fh)
        except (OSError, ValueError):
            continue
        rid = isinstance(m, dict) and (m.get("run") or os.path.basename(f)[:-5])
        if rid and not (m.get("pid") and pid_alive(m["pid"])) and rid not in done and (acknowledged or not m.get("lost_ack")):
            out.append((rid, m))
    return sorted(out, key=lambda x: (x[1].get("started") or "", x[0]))


def signal_group(pid, sig, wait=0):
    """killpg(pid, sig) for a process group lean-agent started itself (a child it spawned with its own session).
    Refuses pid <= 1, its own pid and its own process group, so a stale or unset pid can never reach the caller's
    session, init, or (as kill(-1) / killpg(0) do) every process it may signal. With wait > 0 it gives a child that was
    just forked up to that many seconds to call setsid; it never signals a group the child is not the leader of.
    Returns True when sent."""
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 1 or pid == os.getpid() or pid == os.getpgrp():
        return False
    deadline = time.time() + wait
    try:
        while os.getpgid(pid) != pid:  # not the leader of a group of its own: not one we created (yet)
            if time.time() >= deadline:
                return False
            time.sleep(0.01)
        os.killpg(pid, sig)
        return True
    except OSError:
        return False


def pid_alive(pid):
    try:
        if int(pid) <= 1:
            return False
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError, TypeError):
        return False


def plugin_version():
    try:
        with open(os.path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json")) as fh:
            return json.load(fh).get("version") or "?"
    except (OSError, ValueError, AttributeError):
        return "?"


def glob_match(pattern, path):
    """Path glob: ** crosses folders, * and ? stay in one, {a,b} alternates; a pattern without / matches any folder.
    Shared by the rules (`paths:`) and anything else that needs `**` globs: fnmatch alone lets `*` cross folders and has
    neither `**` nor {a,b}, so "src/*.cs" would match "src/a/b.cs"."""
    while path.startswith("./"):  # only a leading "./"; ".claude/..." and "../" keep their dots
        path = path[2:]
    if "/" not in pattern:
        pattern = "**/" + pattern
    out, i = "", 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out, i = out + "(?:.*/)?", i + 3
        elif pattern.startswith("**", i):
            out, i = out + ".*", i + 2
        elif pattern[i] == "*":
            out, i = out + "[^/]*", i + 1
        elif pattern[i] == "?":
            out, i = out + "[^/]", i + 1
        elif pattern[i] == "{":
            j = pattern.find("}", i)
            if j < 0:
                out, i = out + re.escape("{"), i + 1
            else:
                out, i = out + "(?:" + "|".join(re.escape(x) for x in pattern[i + 1:j].split(",")) + ")", j + 1
        else:
            out, i = out + re.escape(pattern[i]), i + 1
    return re.fullmatch(out, path) is not None
