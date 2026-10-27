"""Shared by the test files: the caller's settings that must not leak into a test."""
import os
import sys


def _timeout_scale():
    """Multiplier for every wait/poll deadline in the tests: 1 locally, 4 on CI and macOS (slow runners)."""
    try:
        return float(os.environ["LEAN_AGENT_TEST_TIMEOUT_SCALE"])
    except (KeyError, ValueError):
        return 4.0 if os.environ.get("GITHUB_ACTIONS") or sys.platform == "darwin" else 1.0


TIMEOUT_SCALE = _timeout_scale()


def scaled(seconds):
    """`seconds` stretched by TIMEOUT_SCALE, for a deadline the test waits on (never for a window asserting absence)."""
    return seconds * TIMEOUT_SCALE

# The Claude Code compaction settings the code reads (they move compaction_point), plus the switch that turns it off;
# tests that need them set them explicitly
# DISABLE_COMPACT is not listed: the code never reads it (only DISABLE_AUTO_COMPACT)
CLAUDE_COMPACT_KNOBS = ("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", "CLAUDE_CODE_AUTO_COMPACT_WINDOW", "DISABLE_AUTO_COMPACT")


def clean_environ(environ=None):
    """The environment minus every LEAN_AGENT_* key and Claude Code compaction knob."""
    return {k: v for k, v in (os.environ if environ is None else environ).items()
            if not k.startswith("LEAN_AGENT_") and k not in CLAUDE_COMPACT_KNOBS}
