#!/usr/bin/env python3
"""PermissionRequest hook for workers started with --allow-edit: Claude Code refuses Edit/Write on the repo's
.claude/ files and CLAUDE.md even with allow rules, but it asks hooks first. This one answers allow only for a file
inside the run's worktree that matches an allowed glob; otherwise it prints nothing and the normal refusal stands.

argv[1]: JSON file {"root": <worktree>, "globs": [<worktree-relative glob>...], "log": <approval log file>}."""
import json
import os
import re
import sys
import time

TOOLS = ("Edit", "Write", "MultiEdit", "NotebookEdit")
PROTECTED = (".claude/settings*.json", ".claude/hooks/**", ".git", ".git/**")


def glob_regex(glob):
    out, i = "", 0
    while i < len(glob):
        if glob.startswith("**/", i):
            out += "(?:.*/)?"
            i += 3
        elif glob.startswith("**", i):
            out += ".*"
            i += 2
        elif glob[i] == "*":
            out += "[^/]*"
            i += 1
        elif glob[i] == "?":
            out += "[^/]"
            i += 1
        else:
            out += re.escape(glob[i])
            i += 1
    return re.compile(out + r"\Z")


def has_magic(glob):
    return any(c in glob for c in "*?")


def decide(event, cfg):
    """The worktree-relative path to allow, or None."""
    if event.get("tool_name") not in TOOLS:
        return None
    ti = event.get("tool_input") or {}
    path = ti.get("file_path") or ti.get("notebook_path")
    if not path or not isinstance(path, str):
        return None
    root = os.path.realpath(cfg["root"])
    if not os.path.isabs(path):
        path = os.path.join(event.get("cwd") or root, path)
    real = os.path.realpath(path)
    if real in [os.path.realpath(o) for o in cfg.get("outside") or [] if isinstance(o, str)]:
        return real  # an explicit file outside the worktree the run was given
    try:
        if os.path.commonpath([root, real]) != root or real == root:
            return None
    except ValueError:
        return None
    rel = os.path.relpath(real, root).replace(os.sep, "/")
    globs = [g for g in cfg.get("globs") or [] if isinstance(g, str)]
    if not any(glob_regex(g).match(rel) for g in globs):
        return None
    if any(glob_regex(p).match(rel) for p in PROTECTED) and rel not in [g for g in globs if not has_magic(g)]:
        return None
    return rel


def main():
    try:
        event = json.loads(sys.stdin.read())
        with open(sys.argv[1]) as fh:
            cfg = json.load(fh)
        rel = decide(event, cfg)
    except Exception:
        return 0
    if rel is None:
        return 0
    try:
        with open(cfg["log"], "a") as fh:
            fh.write(json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%S"), "tool": event["tool_name"], "path": rel}) + "\n")
    except OSError:
        pass
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow"}}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
