#!/usr/bin/env python3
"""PreToolUse hook: enforce lean-agent's plan-window budgets and a per-session token budget.

Window budgets (`lean-agent limits`) apply only to sessions in the lean-agent home, and
`lean-agent limits` / `lean-agent stats` stay allowed so the user can see and raise them.

Reads LEAN_AGENT_BUDGET, a self-set spend cap in Sonnet-equivalent tokens (0/unset = track only):
tokens billed this session, summed over every turn, so it grows much faster than the context window.
LEAN_AGENT_BUDGET_COUNT=new counts only new tokens (no cache re-reads). LEAN_AGENT_WARN_PCT (default 80):
past it Claude gets a one-time note to spend less (and to hand off only if the context itself is large,
LEAN_AGENT_HANDOFF_CONTEXT, default 150,000); past the cap every tool call is denied with an instruction
to summarise and stop.

In the lean-agent home (the orchestrator) a command that starts a worker (`lean-agent run`, `review`, `do`,
`tracker --discover`) must run in the background, so the session stays free for the user while it works
(LEAN_AGENT_BACKGROUND_RUNS=0 turns that off). It also keeps the context small: a Bash command that would print a
long lean-agent run file (cat, less, a big tail ...) is refused with the command to use instead
(LEAN_AGENT_READ_GUARD=0 turns that off, LEAN_AGENT_READ_LINES sets the limit, default 40), and once the
context passes LEAN_AGENT_CTX_NUDGE tokens (default 100,000; again every 50,000 more) Claude gets a note
with what compacting would save.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import usage  # noqa: E402
import push_guard  # noqa: E402


def emit(**fields):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", **fields}}))


# commands that start a worker and can run for minutes
WORKER_CMD = re.compile(r"(?:^|[;&|(]\s*|\s)lean-agent\s+(run|review|do|tracker)\b([^;&|]*)")


def foreground_worker(command):
    """The lean-agent command in `command` that would start a worker and hold the turn until it ends, or ''."""
    for m in WORKER_CMD.finditer(command):
        sub, rest = m.group(1), m.group(2)
        if sub == "review" and re.search(r"--status\b|^\s*decline\b", rest):
            continue  # instant
        if sub == "tracker" and "--discover" not in rest:
            continue
        return f"lean-agent {sub}"
    return ""


READERS = re.compile(r"(?:^|[;&|(]\s*|\s)(cat|less|more|bat|nl|tail|head|sed|awk|python3?|jq)\s")
RUN_FILE = re.compile(r"[^\s'\"]*(?:summary-\d+\.txt|details-\d+\.md|result\.json|/work/\d{4}-\d{6}-[0-9a-f]{4}/[^\s'\"]*)")


def long_run_read(command, lean_root):
    """Why a command would print a long lean-agent run file into the context, or ''."""
    if not READERS.search(command):
        return ""
    limit = int(os.environ.get("LEAN_AGENT_READ_LINES") or 40)
    m = re.search(r"\b(?:head|tail)\s+(?:-n\s*|-)(\d+)", command)
    if m and int(m.group(1)) <= limit and not re.search(r"\b(cat|less|more|bat|nl)\s", command):
        return ""  # a short slice
    for raw in RUN_FILE.findall(command):
        path = os.path.expanduser(raw.replace("$LEAN_AGENT_HOME", lean_root).replace("${LEAN_AGENT_HOME}", lean_root))
        if "/work/" not in path and not path.startswith(lean_root):
            continue
        try:
            with open(path, errors="replace") as fh:
                n = sum(1 for _ in fh)
        except OSError:
            continue
        if n > limit:
            return f"{path} has {n} lines"
    return ""


def main():
    try:
        event = json.load(sys.stdin)
    except ValueError:
        return 0
    transcript = event.get("transcript_path")
    session_id = event.get("session_id")
    if not transcript or not session_id:
        return 0

    # Plan windows: enforced only for sessions inside the lean-agent home (the orchestrator),
    # never for the user's normal sessions that also have this plugin enabled.
    cwd = os.path.realpath(event.get("cwd") or os.getcwd())
    home = os.path.realpath(usage.lean_home())
    command = str((event.get("tool_input") or {}).get("command") or "").strip()
    # lean-agent's own status and budget commands always run, so a blocked session can see and lift its limits
    checking = event.get("tool_name") == "Bash" and command.startswith(tuple(
        "lean-agent " + c for c in ("limits", "stats", "budget", "runs", "logs", "doctor")))
    in_home = cwd == home or cwd.startswith(home + os.sep)
    if in_home and not checking:
        hit = usage.exhausted_window()
        if hit:
            emit(permissionDecision="deny",
                 permissionDecisionReason=usage.describe_exhausted(hit) + " Do not call more tools: tell the user "
                 "briefly what is done and what remains, then end your turn.")
            return 0

    tool_input = event.get("tool_input") or {}
    if in_home and event.get("tool_name") == "Bash" and "push" in command:
        why = push_guard.check(command, cwd)
        if why:
            emit(permissionDecision="deny", permissionDecisionReason="lean-agent push guard: " + why)
            return 0
    if (in_home and event.get("tool_name") == "Bash" and not tool_input.get("run_in_background")
            and os.environ.get("LEAN_AGENT_BACKGROUND_RUNS") != "0"):
        which = foreground_worker(command)
        if which:
            emit(permissionDecision="deny", permissionDecisionReason=(
                f"lean-agent: start `{which}` in the background (Bash with run_in_background: true), so you stay free "
                "to answer the user while the worker runs. Tell the user in one line what you started, then end your "
                "turn; you're notified when it finishes, and its answer is short (`lean-agent runs --show <id>` "
                "prints it again)."))
            return 0

    if in_home and event.get("tool_name") == "Bash" and os.environ.get("LEAN_AGENT_READ_GUARD") != "0":
        why = long_run_read(command, usage.lean_home())
        if why:
            emit(permissionDecision="deny", permissionDecisionReason=(
                f"lean-agent: not printing a lean-agent run file into the orchestrator's context ({why}; it would "
                "be re-read on every later call). Use the run's short answer: `lean-agent runs --show <id>`; one "
                "part of its details: `lean-agent runs --show <id> --details --grep TEXT`; or have a -m haiku worker "
                "read the file and answer the question. Never paste worker output into your reply."))
            return 0

    state = usage.load_state(session_id)
    usage.update(state, transcript)

    budget, count, _ = usage.session_cap(orchestrator=in_home)
    warn_pct = int(os.environ.get("LEAN_AGENT_WARN_PCT") or 80)
    used = usage.cap_units(state, count)  # Sonnet-equivalent tokens, the unit used everywhere
    new_only = count == "new"
    counted = ("new tokens this session (cache re-reads not counted)" if new_only else
               "tokens billed this session, summed over every turn (cache re-reads count 0.1x)")
    ctx = state.get("last_ctx") or 0
    ctx_big = ctx >= int(os.environ.get("LEAN_AGENT_HANDOFF_CONTEXT") or 150000)
    ctx_note = f"The context window is a different number: ~{ctx:,} tokens now" if ctx else ""

    if budget > 0 and used >= budget and not checking:
        usage.save_state(session_id, state)
        emit(
            permissionDecision="deny",
            permissionDecisionReason=(
                f"lean-agent: the session spend cap you set is reached: {used:,} / {budget:,} sonnet-eq {counted}. "
                + (ctx_note + ". " if ctx_note else "")
                + "Do not call more tools (only `lean-agent budget` still runs). Reply with a short summary of what "
                "is done and what remains, then end your turn. The user can lift it right away, without a restart: "
                "`lean-agent budget --cap off` or `--cap <higher>` (and `--count new` to leave cache re-reads out)."
            ),
        )
        return 0

    if budget > 0 and used >= budget * warn_pct / 100 and not state.get("warned") and not checking:
        state["warned"] = True
        usage.save_state(session_id, state)
        advice = ("Spend less from here: fewer, larger steps; delegate reading to -m haiku workers; don't re-read "
                  "files or re-run commands for output you already have.")
        if ctx_big:
            advice += " The context is also large: summarise and suggest a fresh session soon."
        elif ctx_note:
            ctx_note += ", which is fine, so no hand-off is needed for it"
        emit(
            additionalContext=(
                f"lean-agent: {used * 100 // budget}% of the session spend cap you set (LEAN_AGENT_BUDGET) is used: "
                f"{used:,} / {budget:,} sonnet-eq {counted}. This is a spend total, not the context window."
                + (f" {ctx_note}." if ctx_note else "") + " " + advice
            )
        )
        return 0

    nudge_at = int(os.environ.get("LEAN_AGENT_CTX_NUDGE") or 100000)
    if in_home and not checking and nudge_at and ctx >= nudge_at and ctx >= (state.get("nudged") or 0) + 50000:
        state["nudged"] = ctx
        usage.save_state(session_id, state)
        calls = state["totals"].get("_calls") or 1
        models = state.get("models") or {}
        model = max(models, key=lambda m: usage.units(models[m], m)) if models else "sonnet"
        per100 = int(usage.units({"cache_read_input_tokens": max(0, ctx - 20000) * 100}, model))
        msg = (f"lean-agent: this session re-reads ~{ctx:,} tokens of context on every call (average "
               f"{state['totals'].get('_ctx', 0) // calls:,} per call so far). Compacting to ~20K would save about "
               f"{per100:,} sonnet-eq per 100 calls. Keep replies short, then ask the user to send /compact (lean-agent "
               "tells the summary what to keep), or run `lean-agent handoff` and go on in a fresh session.")
        if not os.environ.get("CLAUDE_CODE_AUTO_COMPACT_WINDOW"):
            msg += (" This session was started without lean-agent's early compaction (an older `lean-agent up`): "
                    "restart it once with `lean-agent up` to compact at ~70K automatically.")
        emit(additionalContext=msg)
        return 0

    usage.save_state(session_id, state)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # never break the user's session over accounting
        print(f"lean-agent budget hook error: {exc}", file=sys.stderr)
        sys.exit(0)
