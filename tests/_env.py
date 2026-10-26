"""Shared by the test files: the caller's settings that must not leak into a test."""
import os

# The Claude Code compaction settings the code reads (they move compaction_point), plus the switch that turns it off;
# tests that need them set them explicitly
CLAUDE_COMPACT_KNOBS = ("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", "CLAUDE_CODE_AUTO_COMPACT_WINDOW", "DISABLE_AUTO_COMPACT")


def clean_environ(environ=None):
    """The environment minus every LEAN_AGENT_* key and Claude Code compaction knob."""
    return {k: v for k, v in (os.environ if environ is None else environ).items()
            if not k.startswith("LEAN_AGENT_") and k not in CLAUDE_COMPACT_KNOBS}
