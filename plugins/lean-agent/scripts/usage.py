#!/usr/bin/env python3
"""Token accounting for Claude Code session transcripts.

Claude Code's transcript JSONL format is internal and can change between
releases, so everything here is defensive: unknown lines are skipped and
missing fields count as zero.

Usage:
    usage.py report [SESSION_ID | path/to/session.jsonl]
"""
import glob
import json
import os
import re
import sys

FIELDS = (
    "input_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "output_tokens",
)

# Relative cost of each token kind, in input-token equivalents. These follow
# the usual Anthropic API price ratios (cache write 1.25x, cache read 0.1x,
# output 5x input) so one budget number works across models.
WEIGHTS = {
    "input_tokens": 1.0,
    "cache_creation_input_tokens": 1.25,
    "cache_read_input_tokens": 0.1,
    "output_tokens": 5.0,
}

SEEN_KEEP = 200


def data_dir():
    base = os.environ.get("CLAUDE_PLUGIN_DATA") or os.path.join(
        os.path.expanduser("~"), ".cache", "lean-agent"
    )
    os.makedirs(base, exist_ok=True)
    return base


def empty_totals():
    return {k: 0 for k in FIELDS}


def weighted(totals):
    return int(sum(totals.get(k, 0) * w for k, w in WEIGHTS.items()))


def transcript_files(transcript_path):
    """The main transcript plus any subagent transcripts next to it."""
    files = [transcript_path]
    base = transcript_path[:-6] if transcript_path.endswith(".jsonl") else transcript_path
    files += sorted(glob.glob(os.path.join(base, "subagents", "*.jsonl")))
    return [f for f in files if os.path.isfile(f)]


def scan(path, fstate, totals, models):
    """Add usage from lines appended to `path` since the last scan.

    fstate holds {"offset": int, "seen": [message ids]} and is updated in place.
    The same API message is written as several lines (one per content block),
    each carrying the full usage, so lines are de-duplicated by message id.
    """
    offset = fstate.get("offset", 0)
    try:
        if os.path.getsize(path) < offset:  # file was rewritten
            offset = 0
        with open(path, "rb") as fh:
            fh.seek(offset)
            data = fh.read()
    except OSError:
        return
    end = data.rfind(b"\n")
    if end < 0:
        return
    seen = fstate.get("seen", [])
    seen_set = set(seen)
    for raw in data[:end].split(b"\n"):
        try:
            entry = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(entry, dict) or entry.get("type") != "assistant":
            continue
        msg = entry.get("message")
        if not isinstance(msg, dict) or not isinstance(msg.get("usage"), dict):
            continue
        mid = msg.get("id") or entry.get("uuid")
        if mid in seen_set:
            continue
        seen_set.add(mid)
        seen.append(mid)
        model = msg.get("model") or "unknown"
        mt = models.setdefault(model, empty_totals())
        for k in FIELDS:
            v = msg["usage"].get(k) or 0
            if isinstance(v, (int, float)):
                totals[k] = totals.get(k, 0) + int(v)
                mt[k] = mt.get(k, 0) + int(v)
    fstate["offset"] = offset + end + 1
    fstate["seen"] = seen[-SEEN_KEEP:]


def new_state():
    return {"files": {}, "totals": empty_totals(), "models": {}}


def update(state, transcript_path):
    for path in transcript_files(transcript_path):
        fstate = state["files"].setdefault(path, {})
        scan(path, fstate, state["totals"], state["models"])
    return state


def state_path(session_id):
    safe = re.sub(r"[^A-Za-z0-9_-]", "_", session_id or "unknown")
    d = os.path.join(data_dir(), "budget")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, safe + ".json")


def load_state(session_id):
    try:
        with open(state_path(session_id)) as fh:
            state = json.load(fh)
        if isinstance(state, dict) and "totals" in state:
            return state
    except (OSError, ValueError):
        pass
    return new_state()


def save_state(session_id, state):
    path = state_path(session_id)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w") as fh:
        json.dump(state, fh)
    os.replace(tmp, path)


def units_total(state):
    """Sonnet-equivalent tokens across all models in a scan state (the one unit lean-agent reports)."""
    return int(sum(units(t, m) for m, t in state.get("models", {}).items()))


def projects_dir():
    cfg = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
    return os.path.join(cfg, "projects")


def find_transcript(arg=None):
    if arg and os.path.isfile(arg):
        return arg
    session_id = arg or os.environ.get("CLAUDE_CODE_SESSION_ID")
    if session_id:
        hits = glob.glob(os.path.join(projects_dir(), "*", session_id + ".jsonl"))
        if hits:
            return hits[0]
        if arg:
            return None
    # Fall back to the most recently written transcript for this directory.
    project = re.sub(r"[^A-Za-z0-9]", "-", os.getcwd())
    hits = glob.glob(os.path.join(projects_dir(), project, "*.jsonl"))
    return max(hits, key=os.path.getmtime) if hits else None


def fmt(n):
    return f"{n:,}"


def report(arg=None):
    path = find_transcript(arg)
    if not path:
        print("lean-agent: no session transcript found", file=sys.stderr)
        return 1
    state = update(new_state(), path)
    totals = state["totals"]
    budget = int(os.environ.get("LEAN_AGENT_BUDGET") or 0)
    print(f"Session: {os.path.basename(path)[:-6]}")
    print(f"Files:   {len(state['files'])} transcript(s) incl. subagents")
    print()
    used = units_total(state)
    print(f"{'model':<28}{'input':>12}{'cache write':>14}{'cache read':>14}{'output':>12}{'sonnet-eq':>12}")
    for model, t in sorted(state["models"].items(), key=lambda kv: -units(kv[1], kv[0])):
        print(f"{model[:27]:<28}{fmt(t['input_tokens']):>12}{fmt(t['cache_creation_input_tokens']):>14}"
              f"{fmt(t['cache_read_input_tokens']):>14}{fmt(t['output_tokens']):>12}{fmt(int(units(t, model))):>12}")
    print(f"{'TOTAL':<28}{fmt(totals['input_tokens']):>12}{fmt(totals['cache_creation_input_tokens']):>14}"
          f"{fmt(totals['cache_read_input_tokens']):>14}{fmt(totals['output_tokens']):>12}{fmt(used):>12}")
    print()
    if budget > 0:
        print(f"Session budget: {fmt(used)} / {fmt(budget)} sonnet-eq tokens ({used * 100 // budget}%)")
    else:
        print("Session budget: none (LEAN_AGENT_BUDGET, in sonnet-eq tokens)")
    print("sonnet-eq = (input + 1.25*cache write + 0.1*cache read + 5*output) x model price relative to Sonnet")
    return 0


# ---------------------------------------------------------------- plan windows

# Input price per 1M tokens, used to weigh models against each other. Plan limits
# are not published per model; API price ratios are the best available proxy.
PRICE_PER_MTOK = (
    ("claude-fable", 10.0), ("claude-mythos", 10.0),
    ("claude-opus-5-5", 4.0), ("claude-opus", 5.0),
    ("claude-sonnet-4", 3.0), ("claude-sonnet", 2.0),
    ("claude-haiku-5", 0.10), ("claude-haiku", 1.0),
)
SONNET_PRICE = 2.0
WINDOWS = (("5h", 5), ("week", 7 * 24))
KEEP_HOURS = 8 * 24
BUCKET_MINUTES = 10


ALIASES = {"fable": "claude-fable-5-1", "opus": "claude-opus-5-5", "sonnet": "claude-sonnet-5-5",
           "haiku": "claude-haiku-5-5"}


def model_rate(model):
    """How much one token of `model` counts, relative to Sonnet 5.5."""
    m = (model or "").lower()
    m = ALIASES.get(m.split("[")[0], m)
    for prefix, price in PRICE_PER_MTOK:
        if m.startswith(prefix):
            return price / SONNET_PRICE
    return 1.0


def units(usage_dict, model):
    """Sonnet-equivalent tokens: weighted tokens scaled by the model's price."""
    return weighted(usage_dict) * model_rate(model)


def lean_home():
    return os.path.abspath(os.path.expanduser(os.environ.get("LEAN_AGENT_HOME") or "~/.lean-agent"))


def _munge(path):
    return re.sub(r"[^A-Za-z0-9]", "-", path)


def _bucket(ts):
    """'2026-10-16T09:47:12.345Z' -> '2026-10-16T09:40' (UTC, 10-minute buckets)."""
    m = re.match(r"(\d{4}-\d\d-\d\dT\d\d):(\d\d)", ts or "")
    if not m:
        return None
    return f"{m.group(1)}:{int(m.group(2)) // BUCKET_MINUTES * BUCKET_MINUTES:02d}"


def _utc_key(seconds_ago):
    import datetime
    t = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=seconds_ago)
    return t.strftime("%Y-%m-%dT%H:%M")


def scan_windows():
    """Incrementally read every local transcript changed in the last 8 days into 10-minute buckets.

    Returns {bucket: {"lean": units, "all": units}}. "lean" is usage from sessions that ran
    inside the lean-agent home (orchestrator and workers).
    """
    import time
    try:
        import fcntl
    except ImportError:
        fcntl = None
    home = lean_home()
    os.makedirs(home, exist_ok=True)
    path = os.path.join(home, "windows.json")
    prefixes = tuple({_munge(home), _munge(os.path.realpath(home))})
    with open(path + ".lock", "w") as lock:
        if fcntl:
            fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            with open(path) as fh:
                st = json.load(fh)
        except (OSError, ValueError):
            st = {"files": {}, "buckets": {}}
        cutoff = time.time() - KEEP_HOURS * 3600
        pattern = [os.path.join(projects_dir(), "*", "*.jsonl"),
                   os.path.join(projects_dir(), "*", "*", "subagents", "*.jsonl")]
        live = set()
        for f in (p for g in pattern for p in glob.glob(g)):
            try:
                if os.path.getmtime(f) < cutoff:
                    continue
            except OSError:
                continue
            live.add(f)
            project = os.path.relpath(f, projects_dir()).split(os.sep)[0]
            is_lean = project.startswith(prefixes)
            fstate = st["files"].setdefault(f, {})
            _scan_into(f, fstate, st["buckets"], is_lean)
        st["files"] = {f: v for f, v in st["files"].items() if f in live}
        oldest = _utc_key(KEEP_HOURS * 3600)
        st["buckets"] = {k: v for k, v in st["buckets"].items() if k >= oldest}
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w") as fh:
            json.dump(st, fh)
        os.replace(tmp, path)
        if fcntl:
            fcntl.flock(lock, fcntl.LOCK_UN)
    return st["buckets"]


def _scan_into(path, fstate, buckets, is_lean):
    offset = fstate.get("offset", 0)
    try:
        if os.path.getsize(path) < offset:
            offset = 0
        with open(path, "rb") as fh:
            fh.seek(offset)
            data = fh.read()
    except OSError:
        return
    end = data.rfind(b"\n")
    if end < 0:
        return
    seen = fstate.get("seen", [])
    seen_set = set(seen)
    for raw in data[:end].split(b"\n"):
        try:
            entry = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(entry, dict) or entry.get("type") != "assistant":
            continue
        msg = entry.get("message")
        if not isinstance(msg, dict) or not isinstance(msg.get("usage"), dict):
            continue
        mid = msg.get("id") or entry.get("uuid")
        key = _bucket(entry.get("timestamp"))
        if mid in seen_set or not key:
            continue
        seen_set.add(mid)
        seen.append(mid)
        u = units(msg["usage"], msg.get("model"))
        b = buckets.setdefault(key, {"lean": 0, "all": 0})
        b["all"] += u
        if is_lean:
            b["lean"] += u
    fstate["offset"] = offset + end + 1
    fstate["seen"] = seen[-SEEN_KEEP:]


def window_usage(buckets=None):
    """{"5h": {"lean", "all", "frees_at"}, "week": {...}} in Sonnet-equivalent tokens."""
    import datetime
    buckets = scan_windows() if buckets is None else buckets
    out = {}
    for name, hours in WINDOWS:
        start = _utc_key(hours * 3600)
        keys = sorted(k for k in buckets if k >= start)
        lean = sum(buckets[k]["lean"] for k in keys)
        first_lean = next((k for k in keys if buckets[k]["lean"]), None)
        frees = None
        if first_lean:
            t = datetime.datetime.strptime(first_lean, "%Y-%m-%dT%H:%M").replace(tzinfo=datetime.timezone.utc)
            frees = (t + datetime.timedelta(hours=hours, minutes=BUCKET_MINUTES)).astimezone()
        out[name] = {"lean": int(lean), "all": int(sum(buckets[k]["all"] for k in keys)), "frees_at": frees}
    return out


def limits_path():
    return os.path.join(lean_home(), "limits.json")


def window_budgets():
    """Budgets per window from env (LEAN_AGENT_5H_BUDGET / LEAN_AGENT_WEEKLY_BUDGET) or `lean-agent limits`."""
    try:
        with open(limits_path()) as fh:
            saved = json.load(fh)
    except (OSError, ValueError):
        saved = {}

    def num(env, key):
        try:
            return int(float(os.environ.get(env) or saved.get(key) or 0))
        except (TypeError, ValueError):
            return 0
    return {"5h": num("LEAN_AGENT_5H_BUDGET", "5h"), "week": num("LEAN_AGENT_WEEKLY_BUDGET", "week")}


def exhausted_window(usage_by_window=None):
    """(window name, used, budget, frees_at) for the first window whose budget is used up, else None."""
    budgets = window_budgets()
    if not any(budgets.values()):
        return None
    w = usage_by_window or window_usage()
    for name, _ in WINDOWS:
        if budgets[name] and w[name]["lean"] >= budgets[name]:
            return name, w[name]["lean"], budgets[name], w[name]["frees_at"]
    return None


def describe_exhausted(hit):
    name, used, budget, frees = hit
    label = "5-hour" if name == "5h" else "weekly"
    when = f"; it starts freeing up around {frees:%a %H:%M}" if frees else ""
    var = "LEAN_AGENT_5H_BUDGET" if name == "5h" else "LEAN_AGENT_WEEKLY_BUDGET"
    return (f"lean-agent {label} budget used up ({used:,} / {budget:,} Sonnet-equivalent tokens){when}. "
            f"Raise {var} to continue.")


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "report":
        sys.exit(report(sys.argv[2] if len(sys.argv) > 2 else None))
    print(__doc__.strip(), file=sys.stderr)
    sys.exit(2)
