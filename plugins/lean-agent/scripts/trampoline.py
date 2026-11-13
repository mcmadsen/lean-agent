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
    if script == "inject_hook.py" and os.environ.get("LEAN_AGENT_SERVICE_SESSION") != "1":
        return  # the inject hook acts in the sessions `lean-agent up` hosts only: no second interpreter anywhere else
    target_dir = clone_scripts() or here
    target = os.path.join(target_dir, script)
    if not os.path.isfile(target):
        target = os.path.join(here, script)
    if script == "lean_agent.py" and sys.argv[2:3] in (["now"], ["runs"]) and not os.environ.get("LEAN_AGENT_NO_SOCKET"):
        try:  # the service answers from memory: lean_agent.py (18k lines) is not even compiled; None: the files, below
            sys.path.insert(0, os.path.dirname(target))
            import lean_sock
            rc = lean_sock.cli(sys.argv[2:])
            if rc is not None:
                sys.stdout.flush()
                os._exit(rc)
        except (ImportError, OSError):
            pass
    if script.endswith("_hook.py"):  # runs in this interpreter: the hot hooks pay for one process start, not two
        sys.argv = [target] + sys.argv[2:]
        sys.path.insert(0, os.path.dirname(target))
        try:  # slow-hook trace (4 s): a stuck hook leaves its stacks in <home>/logs/slow
            import lean_slow
            lean_slow.arm("hook", script[:-3] + (("-" + sys.argv[1]) if len(sys.argv) > 1 else ""))
            lean_slow.phase("startup")
            import atexit
            atexit.register(lean_slow.disarm)
        except Exception:  # noqa: BLE001
            pass
        if script == "budget_hook.py":  # the no-op gate first: most calls end here, before the hook is even compiled
            import io
            data = sys.stdin.read()
            try:
                import json
                from budget_gate import nothing_to_do
                if nothing_to_do(json.loads(data)):
                    return
            except Exception:  # noqa: BLE001 - doubtful: the hook decides
                pass
            sys.stdin = io.StringIO(data)
        with open(target, "rb") as fh:
            code = compile(fh.read(), target, "exec")
        exec(code, {"__name__": "__main__", "__file__": target})
        return
    os.execv(sys.executable, [sys.executable, target] + sys.argv[2:])


if __name__ == "__main__":
    main()
