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
    used = weighted(totals)
    print(f"Session: {os.path.basename(path)[:-6]}")
    print(f"Files:   {len(state['files'])} transcript(s) incl. subagents")
    print()
    print(f"{'model':<28}{'input':>12}{'cache write':>14}{'cache read':>14}{'output':>12}{'weighted':>12}")
    for model, t in sorted(state["models"].items(), key=lambda kv: -weighted(kv[1])):
        print(f"{model[:27]:<28}{fmt(t['input_tokens']):>12}{fmt(t['cache_creation_input_tokens']):>14}"
              f"{fmt(t['cache_read_input_tokens']):>14}{fmt(t['output_tokens']):>12}{fmt(weighted(t)):>12}")
    print(f"{'TOTAL':<28}{fmt(totals['input_tokens']):>12}{fmt(totals['cache_creation_input_tokens']):>14}"
          f"{fmt(totals['cache_read_input_tokens']):>14}{fmt(totals['output_tokens']):>12}{fmt(used):>12}")
    print()
    if budget > 0:
        print(f"Budget:  {fmt(used)} / {fmt(budget)} weighted tokens ({used * 100 // budget}%)")
    else:
        print("Budget:  none set (export LEAN_AGENT_BUDGET=<weighted tokens> to enforce one)")
    print("Weighted = input + 1.25*cache_write + 0.1*cache_read + 5*output (input-token equivalents)")
    return 0


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "report":
        sys.exit(report(sys.argv[2] if len(sys.argv) > 2 else None))
    print(__doc__.strip(), file=sys.stderr)
    sys.exit(2)
