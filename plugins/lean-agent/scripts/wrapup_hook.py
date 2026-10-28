#!/usr/bin/env python3
"""PreToolUse hook for workers: once lean-agent has seen the worker use ~70% of its read or turn budget it creates
the file named by LEAN_AGENT_WRAPUP_FLAG; the next tool call then carries a one-time note to commit the finished
work and write the summary now."""
import json
import os
import sys

MESSAGE = ("lean-agent: you have used about 70% of your budget (context reads or turns). Commit your finished work "
           "now and write your summary soon; keep what is left for finishing, not for new exploration.")


def main():
    flag = os.environ.get("LEAN_AGENT_WRAPUP_FLAG")
    if not flag or not os.path.exists(flag) or os.path.exists(flag + ".sent"):
        return 0
    try:
        open(flag + ".sent", "w").close()
    except OSError:
        return 0
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": MESSAGE}}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # never break a worker over a reminder
        sys.exit(0)
