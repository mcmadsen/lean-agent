#!/usr/bin/env python3
"""Push guards: branches lean-agent never pushes to (`lean-agent guard`), for every project.

The patterns are globs matched against the remote branch a push would update (the destination, not the local
branch name). A project without its own list gets DEFAULT_PUSH_DENY. Used three ways:
  - `lean-agent worktree push` refuses a guarded destination;
  - as a PreToolUse hook for workers (passed with --settings), it refuses a `git push` to one;
  - the orchestrator's budget hook calls check() for its own Bash commands.
No --allow-send text gets past it; only `lean-agent worktree push --override-guard "<why>"`, which is logged.
"""
import fnmatch
import json
import os
import re
import shlex
import subprocess
import sys

DEFAULT_PUSH_DENY = ["release/*", "develop", "main", "master"]


def lean_home():
    return os.path.abspath(os.path.expanduser(os.environ.get("LEAN_AGENT_HOME") or "~/.lean-agent"))


def _projects():
    try:
        with open(os.path.join(lean_home(), "projects.json")) as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def project_patterns(slug):
    """The push-deny globs for a project: its own list if it has one (even an empty one), else the defaults."""
    guards = (_projects().get(slug) or {}).get("guards") or {}
    return list(guards["push-deny"]) if "push-deny" in guards else list(DEFAULT_PUSH_DENY)


def patterns_for(path):
    """The push-deny globs for the repository at `path`: its project's (a lean-agent worktree counts as its
    project), else the defaults."""
    real = os.path.realpath(path or ".")
    for slug, v in _projects().items():
        p = os.path.realpath(v.get("path") or "")
        wt = os.path.join(os.path.realpath(lean_home()), "worktrees", slug)
        if p and (real == p or real.startswith(p + os.sep) or real == wt or real.startswith(wt + os.sep)):
            return project_patterns(slug)
    return list(DEFAULT_PUSH_DENY)


def guarded(branch, patterns):
    """The pattern that guards `branch` (a remote branch name, refs/heads/ optional), or None."""
    b = re.sub(r"^refs/heads/", "", branch or "")
    return next((p for p in patterns if fnmatch.fnmatchcase(b, p)), None)


def _git(cwd, *args):
    try:
        p = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True, timeout=10)
        return p.stdout.strip() if p.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def push_destinations(args, cwd):
    """(remote branches a `git push <args>` run in `cwd` would update, or None for "all of them")."""
    flags, rest = [], []
    skip_next = False
    for x in args:
        if skip_next:
            skip_next = False
            continue
        if x in ("-o", "--push-option", "--repo", "--receive-pack", "--exec"):
            skip_next = True
        elif x.startswith("-"):
            flags.append(x)
        else:
            rest.append(x)
    if any(f in ("--all", "--mirror", "--branches") for f in flags):
        return None
    refspecs = rest[1:]  # the first word is the remote
    if not refspecs:
        if "--tags" in flags:
            return []
        upstream = _git(cwd, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
        if upstream and "/" in upstream:
            return [upstream.split("/", 1)[1]]
        branch = _git(cwd, "symbolic-ref", "--quiet", "--short", "HEAD")
        return [branch] if branch else []
    out = []
    for spec in refspecs:
        spec = spec.lstrip("+")
        if spec.startswith("refs/tags/"):
            continue
        dst = spec.split(":", 1)[1] if ":" in spec else spec  # ":branch" deletes branch: still guarded
        if dst in ("HEAD", "@"):  # `git push origin HEAD`: the branch with the current branch's name
            dst = _git(cwd, "symbolic-ref", "--quiet", "--short", "HEAD") or "HEAD"
        if dst:
            out.append(re.sub(r"^refs/heads/", "", dst))
    return out


def check(command, cwd, patterns=None):
    """Why `command` (a shell line) must not run: a `git push` that would update a guarded branch; '' if fine."""
    cwd = cwd or os.getcwd()
    for segment in re.split(r"&&|\|\||;|\|", command):
        try:
            words = shlex.split(segment)
        except ValueError:
            words = segment.split()
        while words and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", words[0]):
            words = words[1:]  # VAR=value git push ...
        if len(words) >= 2 and words[0] == "cd":
            cwd = os.path.join(cwd, os.path.expanduser(words[1]))
            continue
        if not words or os.path.basename(words[0]) != "git":
            continue
        i, here = 1, cwd
        while i < len(words) and words[i].startswith("-"):
            if words[i] == "-C" and i + 1 < len(words):
                here = os.path.join(here, os.path.expanduser(words[i + 1]))
                i += 2
            elif words[i] in ("-c", "--git-dir", "--work-tree") and i + 1 < len(words):
                i += 2
            else:
                i += 1
        if i >= len(words) or words[i] != "push":
            continue
        pats = patterns if patterns is not None else patterns_for(here)
        if not pats:
            continue
        dests = push_destinations(words[i + 1:], here)
        if dests is None:
            return ("`git push --all/--mirror` would update every branch, including guarded ones "
                    f"({', '.join(pats)}). Push only your own branch.")
        for d in dests:
            hit = guarded(d, pats)
            if hit:
                return (f"`{' '.join(words[:i + 1])} ...` would update {d}, which lean-agent never pushes to "
                        f"(guard {hit!r}: lean-agent guard list). Push your own branch and open a pull request.")
    return ""


# Git-level guard: workers (and the orchestrator) get core.hooksPath pointing at lean-agent's hooks folder through
# GIT_CONFIG_* variables. Its pre-push refuses guarded destinations (git passes the exact remote refs); every other
# hook, and pre-push after the check, runs the repository's own hook, so project hooks keep working.
CLIENT_HOOKS = ("applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit",
                "prepare-commit-msg", "commit-msg", "post-commit", "pre-rebase", "post-checkout", "post-merge",
                "post-rewrite", "pre-auto-gc", "push-to-checkout", "sendemail-validate", "pre-push")
HOOK_MARK = "lean-agent push guard hook"


def hooks_dir():
    return os.path.join(lean_home(), "git-hooks")


def ensure_hooks():
    """Write the hooks folder (idempotent); returns its path."""
    d = hooks_dir()
    os.makedirs(d, exist_ok=True)
    me = os.path.abspath(__file__)
    for name in CLIENT_HOOKS:
        path = os.path.join(d, name)
        body = (f"#!/bin/sh\n# {HOOK_MARK}\nexec {shlex.quote(sys.executable)} {shlex.quote(me)} "
                f"git-hook {name} \"$@\"\n")
        try:
            with open(path) as fh:
                if fh.read() == body:
                    continue
        except OSError:
            pass
        with open(path, "w") as fh:
            fh.write(body)
        os.chmod(path, 0o755)
    return d


def git_env(env):
    """`env` plus the GIT_CONFIG_* entries that make git use lean-agent's hooks folder."""
    env = dict(env)
    n = int(env.get("GIT_CONFIG_COUNT") or 0)
    for i in range(n):
        if env.get(f"GIT_CONFIG_KEY_{i}") == "core.hooksPath" and env.get(f"GIT_CONFIG_VALUE_{i}") == hooks_dir():
            return env  # already there
    env["GIT_CONFIG_COUNT"] = str(n + 1)
    env[f"GIT_CONFIG_KEY_{n}"] = "core.hooksPath"
    env[f"GIT_CONFIG_VALUE_{n}"] = ensure_hooks()
    env["LEAN_AGENT_GIT_CONFIG_INDEX"] = str(n)
    return env


def _own_hooks_env():
    """The environment without lean-agent's core.hooksPath entry, so git reports the repository's own setting."""
    env = dict(os.environ)
    i = env.pop("LEAN_AGENT_GIT_CONFIG_INDEX", None)
    if i is not None:
        env.pop(f"GIT_CONFIG_KEY_{i}", None)
        env.pop(f"GIT_CONFIG_VALUE_{i}", None)
        n = int(env.get("GIT_CONFIG_COUNT") or 0)
        if n and int(i) == n - 1:
            env["GIT_CONFIG_COUNT"] = str(n - 1)
        else:  # not the last entry: keep the count, point ours at a harmless key
            env[f"GIT_CONFIG_KEY_{i}"] = "lean-agent.unused"
            env[f"GIT_CONFIG_VALUE_{i}"] = ""
    return env


def run_own_hook(name, args, stdin_data=None):
    """Run the repository's own `name` hook, if it has one; its exit code (0 if none)."""
    env = _own_hooks_env()

    def git_out(*a):
        p = subprocess.run(["git", *a], capture_output=True, text=True, env=env)
        return p.stdout.strip() if p.returncode == 0 else ""
    d = git_out("config", "--get", "core.hooksPath")
    if d:
        d = os.path.expanduser(d)
        if not os.path.isabs(d):
            d = os.path.join(git_out("rev-parse", "--show-toplevel") or os.getcwd(), d)
    else:
        d = os.path.join(git_out("rev-parse", "--git-common-dir") or ".git", "hooks")
    hook = os.path.join(d, name)
    if os.path.realpath(d) == os.path.realpath(hooks_dir()) or not os.access(hook, os.X_OK):
        return 0
    return subprocess.run([hook, *args], input=stdin_data, text=True, env=env).returncode


def git_hook(name, args):
    """lean-agent's hooks folder: pre-push checks the guards; then the repository's own hook runs."""
    if name != "pre-push":
        return run_own_hook(name, args)  # stdin passes straight through
    refs = sys.stdin.read()  # "<local ref> <local sha> <remote ref> <remote sha>" per ref git would update
    if os.environ.get("LEAN_AGENT_PUSH_GUARD_OVERRIDE") != "1":
        top = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip()
        pats = patterns_for(top or os.getcwd())
        for line in refs.splitlines():
            parts = line.split()
            hit = guarded(parts[2], pats) if len(parts) == 4 and parts[2].startswith("refs/heads/") else None
            if hit:
                sys.stderr.write(f"lean-agent push guard: refusing to update {parts[2][11:]} on "
                                 f"{args[0] if args else 'the remote'} (guard {hit!r}: lean-agent guard list). "
                                 "Push your own branch and open a pull request.\n")
                return 1
    return run_own_hook(name, args, refs)


def main():
    """PreToolUse hook for workers: refuse a Bash `git push` to a guarded branch."""
    if len(sys.argv) > 2 and sys.argv[1] == "git-hook":
        return git_hook(sys.argv[2], sys.argv[3:])
    try:
        event = json.load(sys.stdin)
    except ValueError:
        return 0
    if event.get("tool_name") != "Bash":
        return 0
    command = str((event.get("tool_input") or {}).get("command") or "")
    if "push" not in command:
        return 0
    why = check(command, event.get("cwd") or os.getcwd())
    if why:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                                 "permissionDecisionReason": "lean-agent push guard: " + why}}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # never break a worker over the guard itself (but a push isn't let through)
        print(f"lean-agent push guard error: {exc}", file=sys.stderr)
        sys.exit(1 if sys.argv[1:3] == ["git-hook", "pre-push"] else 0)
