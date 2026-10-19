#!/usr/bin/env python3
"""Run a lean-agent script from the user's git clone when one is registered.

Claude Code runs plugins from a cached copy, so after a `git pull` in the clone the
hooks and the in-session `lean-agent` command would keep running old code until the
plugin is updated. `lean-agent install`, `up` and `sync` record the clone in
~/.lean-agent/source; this trampoline hands over to the clone's copy of the script
(same name, same arguments and stdin), and falls back to the cached copy.

Usage: trampoline.py <script.py> [args...]
"""
import os
import sys

here = os.path.dirname(os.path.abspath(__file__))


def clone_scripts():
    home = os.path.expanduser(os.environ.get("LEAN_AGENT_HOME") or "~/.lean-agent")
    try:
        with open(os.path.join(home, "source")) as fh:
            root = fh.read().strip()
    except OSError:
        return None
    path = os.path.join(root, "plugins", "lean-agent", "scripts")
    return path if os.path.isdir(path) else None


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__.strip())
    script = os.path.basename(sys.argv[1])
    target_dir = clone_scripts() or here
    target = os.path.join(target_dir, script)
    if not os.path.isfile(target):
        target = os.path.join(here, script)
    os.execv(sys.executable, [sys.executable, target] + sys.argv[2:])


if __name__ == "__main__":
    main()
