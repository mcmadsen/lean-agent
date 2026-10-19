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
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import usage  # noqa: E402


def emit(**fields):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", **fields}}))


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
    checking = event.get("tool_name") == "Bash" and command.startswith(("lean-agent limits", "lean-agent stats"))
    if (cwd == home or cwd.startswith(home + os.sep)) and not checking:
        hit = usage.exhausted_window()
        if hit:
            emit(permissionDecision="deny",
                 permissionDecisionReason=usage.describe_exhausted(hit) + " Do not call more tools: tell the user "
                 "briefly what is done and what remains, then end your turn.")
            return 0

    state = usage.load_state(session_id)
    usage.update(state, transcript)

    budget = int(os.environ.get("LEAN_AGENT_BUDGET") or 0)
    warn_pct = int(os.environ.get("LEAN_AGENT_WARN_PCT") or 80)
    used = usage.cap_units(state)  # Sonnet-equivalent tokens, the unit used everywhere
    new_only = (os.environ.get("LEAN_AGENT_BUDGET_COUNT") or "").lower() == "new"
    counted = ("new tokens this session (cache re-reads not counted)" if new_only else
               "tokens billed this session, summed over every turn (cache re-reads count 0.1x)")
    ctx = state.get("last_ctx") or 0
    ctx_big = ctx >= int(os.environ.get("LEAN_AGENT_HANDOFF_CONTEXT") or 150000)
    ctx_note = f"The context window is a different number: ~{ctx:,} tokens now" if ctx else ""

    if budget > 0 and used >= budget:
        usage.save_state(session_id, state)
        emit(
            permissionDecision="deny",
            permissionDecisionReason=(
                f"lean-agent: the session spend cap you set is reached: {used:,} / {budget:,} sonnet-eq {counted}. "
                + (ctx_note + ". " if ctx_note else "")
                + "Do not call more tools. Reply with a short summary of what is done, what remains, and how to "
                "resume, then end your turn. The user can raise LEAN_AGENT_BUDGET to continue."
            ),
        )
        return 0

    if budget > 0 and used >= budget * warn_pct / 100 and not state.get("warned"):
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

    usage.save_state(session_id, state)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # never break the user's session over accounting
        print(f"lean-agent budget hook error: {exc}", file=sys.stderr)
        sys.exit(0)
