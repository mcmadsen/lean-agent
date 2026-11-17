#!/usr/bin/env python3
"""PostToolUseFailure hook: tells the live map a tool call of a hosted session (front desk / thread) failed. Fire-and-forget to
the service socket (30 ms at most, dropped when it is down); only a tool name and a short safe target are sent. Never
fails the session, never prints."""
import json
import os
import sys


def main():
    if not os.environ.get("LEAN_AGENT_SESSION_ROLE"):
        return 0
    try:
        event = json.loads(sys.stdin.read())
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import lean_activity
        lean_activity.hook_send(event)
    except Exception:  # noqa: BLE001
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
