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
        ctx = sum(int(msg["usage"].get(k) or 0) for k in
                  ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
        totals["_calls"] = totals.get("_calls", 0) + 1
        totals["_ctx"] = totals.get("_ctx", 0) + ctx
        totals.setdefault("_first_ctx", ctx)  # the main transcript is scanned first
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


def transcript_span(path):
    """(first, last) ISO UTC timestamps found in a transcript, or (None, None)."""
    first = last = None
    try:
        with open(path) as fh:
            for line in fh:
                m = re.search(r'"timestamp":\s*"([^"]+)"', line)
                if m:
                    first = first or m.group(1)
                    last = m.group(1)
    except OSError:
        pass
    return first, last


def report(arg=None, workers=None):
    """Print the session report. `workers(session_id, first_ts, last_ts)` returns
    [(model, runs, sonnet-eq)] for worker runs started from this session."""
    path = find_transcript(arg)
    if not path:
        print("lean-agent: no session transcript found", file=sys.stderr)
        return 1
    state = update(new_state(), path)
    totals = state["totals"]
    budget = int(os.environ.get("LEAN_AGENT_BUDGET") or 0)
    print(f"Session: {os.path.basename(path)[:-6]}")
    print(f"Files:   {len(state['files'])} transcript(s) incl. subagents")
    calls = totals.get("_calls", 0)
    if calls:
        print(f"Calls:   {calls} API calls · first call context {fmt(totals['_first_ctx'])} tokens "
              f"(~ the fixed context: system prompt, tools, skills, CLAUDE.md) · "
              f"average context per call {fmt(totals['_ctx'] // calls)}")
    print()
    used = units_total(state)
    print(f"{'model':<28}{'input':>12}{'cache write':>14}{'cache read':>14}{'output':>12}{'sonnet-eq':>12}")
    for model, t in sorted(state["models"].items(), key=lambda kv: -units(kv[1], kv[0])):
        print(f"{model[:27]:<28}{fmt(t['input_tokens']):>12}{fmt(t['cache_creation_input_tokens']):>14}"
              f"{fmt(t['cache_read_input_tokens']):>14}{fmt(t['output_tokens']):>12}{fmt(int(units(t, model))):>12}")
    print(f"{'TOTAL':<28}{fmt(totals['input_tokens']):>12}{fmt(totals['cache_creation_input_tokens']):>14}"
          f"{fmt(totals['cache_read_input_tokens']):>14}{fmt(totals['output_tokens']):>12}{fmt(used):>12}")
    print()
    session_id = os.path.basename(path)[:-6]
    rows = workers(session_id, *transcript_span(path)) if workers else []
    if rows:
        w_total = sum(u for _, _, u in rows)
        print(f"Workers and reviewers started from this session ({sum(n for _, n, _ in rows)} runs):")
        for model, n, u in sorted(rows, key=lambda r: -r[2]):
            print(f"  {model:<26}{n:>4} runs{fmt(int(u)):>14} sonnet-eq")
        print(f"Combined (this session + its workers): {fmt(used + int(w_total))} sonnet-eq "
              f"(orchestrator {fmt(used)}, workers {fmt(int(w_total))})")
    elif workers:
        print("Workers started from this session: none")
    print()
    if budget > 0:
        print(f"Self-set session cap (LEAN_AGENT_BUDGET, not your Claude plan): {fmt(used)} / {fmt(budget)} "
              f"sonnet-eq for this session ({used * 100 // budget}%)")
    else:
        print("No session cap set. For your plan's usage see `lean-agent limits` (and /usage in Claude Code).")
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
            st = {}
        if st.get("v") != 2:  # v2 adds per-model-family token components: rescan the last 8 days
            st = {"v": 2, "files": {}, "buckets": {}}
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
        b = buckets.setdefault(key, {"lean": 0, "all": 0, "fam": {}})
        b["all"] += u
        if is_lean:
            b["lean"] += u
        comp = b.setdefault("fam", {}).setdefault(family(msg.get("model")), [0, 0, 0, 0])
        for i, k in enumerate(FIELDS):
            v = msg["usage"].get(k) or 0
            comp[i] += int(v) if isinstance(v, (int, float)) else 0
    fstate["offset"] = offset + end + 1
    fstate["seen"] = seen[-SEEN_KEEP:]


FAMILIES = {"fable": "claude-fable-5-1", "opus": "claude-opus-5-5", "sonnet": "claude-sonnet-5-5",
            "haiku": "claude-haiku-5-5"}
DEFAULT_WEIGHTS = {"cache_read": 0.1, "output": 5.0}


def family(model):
    m = (model or "").lower()
    m = ALIASES.get(m.split("[")[0], m)
    if "fable" in m or "mythos" in m:
        return "fable"
    for f in ("opus", "sonnet", "haiku"):
        if f in m:
            return f
    return "other"


def load_limits():
    try:
        with open(limits_path()) as fh:
            d = json.load(fh)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def save_limits(d):
    os.makedirs(lean_home(), exist_ok=True)
    tmp = f"{limits_path()}.{os.getpid()}.tmp"
    with open(tmp, "w") as fh:
        json.dump(d, fh, indent=1)
    os.replace(tmp, limits_path())


def _dt(key):
    import datetime
    return datetime.datetime.strptime(key, "%Y-%m-%dT%H:%M").replace(tzinfo=datetime.timezone.utc)


def _key(dt):
    import datetime
    dt = dt.astimezone(datetime.timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:") + f"{dt.minute // BUCKET_MINUTES * BUCKET_MINUTES:02d}"


def plan_windows(buckets, now=None):
    """{"5h": (start, reset), "week": (start, reset)} aligned to the plan's reset times, or {} without a plan.

    A session window lasts 5 hours and the next one starts with the first message after a reset, as on
    Claude plans; (None, None) means no session has started since the last reset."""
    import datetime
    plan = load_limits().get("plan") or {}
    now = now or datetime.datetime.now(datetime.timezone.utc)
    out = {}
    if plan.get("session_reset"):
        reset = datetime.datetime.fromisoformat(plan["session_reset"])
        if now < reset:
            out["5h"] = (reset - datetime.timedelta(hours=5), reset)
        else:
            t, window = reset, (None, None)
            used = sorted(k for k, b in buckets.items() if b.get("all"))
            while True:
                first = next((k for k in used if k >= _key(t)), None)
                if not first:
                    break
                start = _dt(first)
                if now < start + datetime.timedelta(hours=5):
                    window = (start, start + datetime.timedelta(hours=5))
                    break
                t = start + datetime.timedelta(hours=5)
            out["5h"] = window
    if plan.get("week_reset"):
        wd, hhmm = plan["week_reset"]["weekday"], plan["week_reset"]["time"]
        local_now = now.astimezone()
        h, m = (int(x) for x in hhmm.split(":"))
        last = local_now.replace(hour=h, minute=m, second=0, microsecond=0)
        last -= datetime.timedelta(days=(last.weekday() - wd) % 7)
        if last > local_now:
            last -= datetime.timedelta(days=7)
        out["week"] = (last.astimezone(datetime.timezone.utc), (last + datetime.timedelta(days=7)).astimezone(
            datetime.timezone.utc))
    return out


def plan_units(fam_comp, weights=None):
    """Plan-weighted units of per-family raw token components [input, cache write, cache read, output]."""
    w = dict(DEFAULT_WEIGHTS, **(weights or {}))
    total = 0.0
    for fam, (inp, cw, cr, out) in fam_comp.items():
        rate = model_rate(FAMILIES.get(fam, ""))
        total += rate * (inp + 1.25 * cw + w["cache_read"] * cr + w["output"] * out)
    return total


def _features(fam_comp):
    a = b = c = 0.0
    for fam, (inp, cw, cr, out) in fam_comp.items():
        rate = model_rate(FAMILIES.get(fam, ""))
        a += rate * (inp + 1.25 * cw)
        b += rate * cr
        c += rate * out
    return a, b, c


def window_usage(buckets=None, now=None):
    """Per window: lean-agent and all usage (sonnet-eq), per-family components, start, reset, plan %.

    Windows follow the plan's reset times when `lean-agent limits plan` is set, else they roll."""
    import datetime
    buckets = scan_windows() if buckets is None else buckets
    now = now or datetime.datetime.now(datetime.timezone.utc)
    plan = plan_windows(buckets, now)
    cfg = load_limits()
    caps, weights = cfg.get("caps") or {}, cfg.get("weights") or {}
    out = {}
    for name, hours in WINDOWS:
        aligned = name in plan
        if aligned:
            start, reset = plan[name]
            keys = [] if start is None else sorted(k for k in buckets if _key(start) <= k < _key(reset))
        else:
            start = now - datetime.timedelta(hours=hours)
            keys = sorted(k for k in buckets if k >= _key(start))
            reset = None
        fam = {}
        for k in keys:
            for f, comp in (buckets[k].get("fam") or {}).items():
                acc = fam.setdefault(f, [0, 0, 0, 0])
                for i in range(4):
                    acc[i] += comp[i]
        lean = sum(buckets[k]["lean"] for k in keys)
        if aligned:
            frees = reset.astimezone() if reset else None
        else:
            first_lean = next((k for k in keys if buckets[k]["lean"]), None)
            frees = ((_dt(first_lean) + datetime.timedelta(hours=hours, minutes=BUCKET_MINUTES)).astimezone()
                     if first_lean else None)
        cap = caps.get("session" if name == "5h" else "week")
        pct = plan_units(fam, weights) * 100 / cap if cap else None
        fam_pct = {}
        if name == "week":
            for f, c in (caps.get("families") or {}).items():
                fam_pct[f] = plan_units({f: fam[f]} if f in fam else {}, weights) * 100 / c if c else None
        out[name] = {"lean": int(lean), "all": int(sum(buckets[k]["all"] for k in keys)), "frees_at": frees,
                     "start": start, "reset": reset, "aligned": aligned, "fam": fam, "plan_pct": pct,
                     "family_pct": fam_pct}
    return out


def _solve3(m, v):
    """Solve a 3x3 linear system (Cramer's rule); None if singular."""
    def det(a):
        return (a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
                + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]))
    d = det(m)
    if abs(d) < 1e-12:
        return None
    res = []
    for i in range(3):
        mi = [row[:] for row in m]
        for r in range(3):
            mi[r][i] = v[r]
        res.append(det(mi) / d)
    return res


def calibrate(pcts, now=None):
    """Record /usage percentages for the current windows and derive the plan's denominators.

    pcts: {"session": 37, "week": 12, "fable": 8, ...} (families are weekly). With 3+ session points the
    cache-read and output weights are fitted too (least squares); otherwise the defaults are kept."""
    import datetime
    cfg = load_limits()
    w = window_usage(now=now)
    points = cfg.setdefault("points", [])
    ts = (now or datetime.datetime.now(datetime.timezone.utc)).isoformat(timespec="seconds")
    for key, pct in pcts.items():
        if pct is None or pct <= 0:
            continue
        if key == "session":
            fam = w["5h"]["fam"]
        elif key == "week":
            fam = w["week"]["fam"]
        else:
            fam = {key: w["week"]["fam"][key]} if key in w["week"]["fam"] else {}
        points.append({"ts": ts, "window": key, "pct": pct, "x": list(_features(fam))})
    cfg["points"] = points[-60:]
    weights = dict(DEFAULT_WEIGHTS)
    sess = [p for p in cfg["points"] if p["window"] == "session" and any(p["x"])]
    fit_note = "default weights (calibrate 3+ times at different moments to fit them)"
    if len(sess) >= 3:
        xtx = [[sum(p["x"][i] * p["x"][j] for p in sess) for j in range(3)] for i in range(3)]
        xty = [sum(p["x"][i] * p["pct"] / 100 for p in sess) for i in range(3)]
        k = _solve3(xtx, xty)
        if k and k[0] > 0:
            cr, out = k[1] / k[0], k[2] / k[0]
            if 0 <= cr <= 1 and 0.5 <= out <= 25:
                weights = {"cache_read": round(cr, 4), "output": round(out, 3)}
                fit_note = f"fitted from {len(sess)} points: cache read {cr:.3f}x, output {out:.2f}x"
            else:
                fit_note = f"fit from {len(sess)} points out of range (cache read {cr:.2f}, output {out:.2f}); kept defaults"
    cfg["weights"] = weights
    caps = {"families": {}}
    for key in {p["window"] for p in cfg["points"]}:
        latest = [p for p in cfg["points"] if p["window"] == key and any(p["x"])][-1:]
        if not latest:
            continue
        a, b, c = latest[0]["x"]
        units_now = a + weights["cache_read"] * b + weights["output"] * c
        cap = units_now * 100 / latest[0]["pct"]
        if key in ("session", "week"):
            caps[key] = cap
        else:
            caps["families"][key] = cap
    cfg["caps"] = caps
    cfg["fit"] = fit_note
    save_limits(cfg)
    return cfg


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


def pct_budgets():
    return {k: v for k, v in (load_limits().get("pct_budgets") or {}).items() if v}


def exhausted_window(usage_by_window=None):
    """(window, used, budget, frees_at, kind) for the first used-up budget, else None.

    kind "tokens": lean-agent's own sonnet-eq budget; kind "plan": a share of the calibrated plan."""
    budgets, pbud = window_budgets(), pct_budgets()
    if not any(budgets.values()) and not pbud:
        return None
    w = usage_by_window or window_usage()
    for name, _ in WINDOWS:
        if budgets[name] and w[name]["lean"] >= budgets[name]:
            return name, w[name]["lean"], budgets[name], w[name]["frees_at"], "tokens"
        key = "session" if name == "5h" else "week"
        if pbud.get(key) and w[name]["plan_pct"] is not None and w[name]["plan_pct"] >= pbud[key]:
            return name, round(w[name]["plan_pct"]), pbud[key], w[name]["frees_at"], "plan"
    return None


def describe_exhausted(hit):
    name, used, budget, frees = hit[:4]
    label = "5-hour" if name == "5h" else "weekly"
    if len(hit) > 4 and hit[4] == "plan":
        label = "session" if name == "5h" else "weekly"
        when = f"; it resets around {frees:%a %H:%M}" if frees else ""
        return (f"lean-agent stopped at {used}% of your plan's {label} limit (you allowed agents up to {budget}%)"
                f"{when}. Raise it with `lean-agent limits --{'session' if name == '5h' else 'week'}-pct N`.")
    when = f"; it starts freeing up around {frees:%a %H:%M}" if frees else ""
    var = "LEAN_AGENT_5H_BUDGET" if name == "5h" else "LEAN_AGENT_WEEKLY_BUDGET"
    return (f"lean-agent {label} budget used up ({used:,} / {budget:,} Sonnet-equivalent tokens){when}. "
            f"Raise {var} to continue.")


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "report":
        sys.exit(report(sys.argv[2] if len(sys.argv) > 2 else None))
    print(__doc__.strip(), file=sys.stderr)
    sys.exit(2)
