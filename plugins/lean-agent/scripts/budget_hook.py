#!/usr/bin/env python3
"""PreToolUse hook: enforce a per-session token budget.

Reads LEAN_AGENT_BUDGET (weighted tokens, 0/unset = track only) and
LEAN_AGENT_WARN_PCT (default 80). Past the warning threshold Claude gets a
one-time nudge to wrap up; past the budget every tool call is denied with an
instruction to summarise and stop.
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

    state = usage.load_state(session_id)
    usage.update(state, transcript)

    budget = int(os.environ.get("LEAN_AGENT_BUDGET") or 0)
    warn_pct = int(os.environ.get("LEAN_AGENT_WARN_PCT") or 80)
    used = usage.weighted(state["totals"])

    if budget > 0 and used >= budget:
        usage.save_state(session_id, state)
        emit(
            permissionDecision="deny",
            permissionDecisionReason=(
                f"lean-agent: session token budget reached ({used:,} / {budget:,} weighted tokens). "
                "Do not call more tools. Reply with a short summary of what is done, what remains, "
                "and how to resume, then end your turn. The user can raise LEAN_AGENT_BUDGET to continue."
            ),
        )
        return 0

    if budget > 0 and used >= budget * warn_pct / 100 and not state.get("warned"):
        state["warned"] = True
        usage.save_state(session_id, state)
        emit(
            additionalContext=(
                f"lean-agent: {used * 100 // budget}% of this session's token budget is used "
                f"({used:,} / {budget:,}). Finish the current step with as few tool calls as possible, "
                "avoid re-reading files, and prepare to hand off."
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
