#!/usr/bin/env python3
"""PreToolUse hook for workers: once lean-agent has seen the worker use ~70% of its read or turn budget it creates
the file named by LEAN_AGENT_WRAPUP_FLAG; the next tool call then carries a one-time note to commit the finished
work and write the summary now."""
import json
import os
import sys

MESSAGE = ("lean-agent: you have used about 70% of your budget (context reads or turns). Commit your finished work "
           "now and write your summary soon; keep what is left for finishing, not for new exploration.")

TIME_MESSAGE = ("lean-agent: about 80% of your time limit is gone and the run will be stopped at the limit. Commit your "
                "work now (git add, git commit) and summarise: what is done, what is left. No new exploration.")


def main():
    notes = []
    for var, message in (("LEAN_AGENT_WRAPUP_FLAG", MESSAGE), ("LEAN_AGENT_TIMEWARN_FLAG", TIME_MESSAGE)):
        flag = os.environ.get(var)
        if not flag or not os.path.exists(flag) or os.path.exists(flag + ".sent"):
            continue
        try:
            open(flag + ".sent", "w").close()
        except OSError:
            continue
        notes.append(message)
    if notes:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": " ".join(notes)}}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # never break a worker over a reminder
        sys.exit(0)
