#!/usr/bin/env python3
"""PreToolUse hook (Bash) for --read-only workers. Claude Code's own allow rules do not cover everything a diagnosis
needs (`git -C <dir> reflog`, `cd <dir> && git log -g`, `find` without -delete, a pipe into `head`), so this hook
decides: it splits the command on && || ; | and newlines and answers `allow` only when EVERY segment is a read-only
command (read-only git inside the project, a read-only built-in, `cd`, or an --allow-cmd prefix). Anything else is
denied with a message that names the segment, and logged so `lean-agent runs --show` can list it.

argv[1]: JSON file {"project": <dir>, "allow_cmd": [<prefix>...], "log": <refused-commands log file>}."""
import json
import os
import re
import shlex
import sys

GIT_PLAIN = {"show", "log", "grep", "diff", "blame", "status", "ls-files", "ls-tree", "rev-parse", "describe",
             "show-ref", "for-each-ref", "rev-list", "merge-base", "fetch", "shortlog", "whatchanged", "count-objects",
             "name-rev", "diff-tree", "diff-files", "diff-index", "cherry", "range-diff", "ls-remote", "show-branch"}
SIMPLE = {"stat", "ls", "wc", "head", "tail", "grep", "rg", "cat", "du", "file", "realpath", "readlink", "which",
          "pwd", "basename", "dirname", "uniq", "cut", "tr", "nl", "tac", "sort", "echo", "true", "test", "[", "date"}
FIND_BAD = {"-exec", "-execdir", "-delete", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"}
SORT_BAD = {"-o", "--output"}
BRANCH_OK = {"--list", "-l", "-a", "-r", "-v", "-vv", "--all", "--remotes", "--show-current", "--contains",
             "--no-contains", "--merged", "--no-merged", "--format", "--sort", "--points-at", "-i", "--column"}
REDIRECT_OK = {"2>&1", "2>/dev/null", ">/dev/null", "1>/dev/null", "&>/dev/null"}
OUT_FLAGS = ("--output", "--output=", "-o")  # git diff/log write a file with --output


def split_segments(cmd):
    """The command split on && || ; | and newlines outside quotes, or None when it has a substitution."""
    segs, cur, quote, i = [], "", None, 0
    while i < len(cmd):
        c = cmd[i]
        if quote:
            cur += c
            if c == quote:
                quote = None
            elif c == "\\" and quote == '"' and i + 1 < len(cmd):
                i += 1
                cur += cmd[i]
            elif c == "`" or (c == "$" and cmd[i + 1:i + 2] == "(" and quote == '"'):
                return None
        elif c in "'\"":
            quote = c
            cur += c
        elif c == "`" or (c == "$" and cmd[i + 1:i + 2] == "(") or c in "<" and cmd[i + 1:i + 2] == "(":
            return None
        elif c == "\\" and i + 1 < len(cmd):
            cur += c + cmd[i + 1]
            i += 1
        elif c in ";\n" or c == "|" or (c == "&" and cmd[i + 1:i + 2] != ">" and cmd[i - 1:i] != ">"):
            segs.append(cur)
            cur = ""
            i += 2 if cmd[i + 1:i + 2] == c and c in "&|" else 1
            continue
        else:
            cur += c
        i += 1
    segs.append(cur)
    return [s.strip() for s in segs if s.strip()]


def inside(path, root):
    path, root = os.path.realpath(path), os.path.realpath(root)
    return path == root or path.startswith(root.rstrip("/") + "/")


def git_ok(args, cwd, project):
    """None when this git command is read-only and inside the project, else the reason."""
    while args and args[0].startswith("-"):
        if args[0] == "-C" and len(args) > 2:
            target = args[1] if os.path.isabs(args[1]) else os.path.join(cwd, args[1])
            if not inside(target, project):
                return f"git -C {args[1]} is outside the project"
            cwd = target
            args = args[2:]
        elif args[0] in ("--no-pager", "-P", "--no-optional-locks"):
            args = args[1:]
        else:
            return f"git option {args[0]} is not allowed"
    if not args:
        return "no git subcommand"
    if not inside(cwd, project):
        return "git must run inside the project (use git -C <project> ...)"
    sub, rest = args[0], args[1:]
    if any(a == "--output" or a.startswith("--output=") for a in rest) and sub in ("diff", "log", "show"):
        return "git --output writes a file"
    if any(a in ("--ext-diff", "--textconv") for a in rest) and sub == "grep":
        return "not allowed"
    if sub in GIT_PLAIN:
        return None
    if sub == "reflog":
        return "reflog expire/delete changes the repository" if rest and rest[0] in ("expire", "delete") else None
    if sub == "cat-file":
        return None if rest and rest[0] in ("-p", "-t", "-s", "-e", "--batch-check", "--batch") else "only cat-file -p/-t/-s/-e"
    if sub == "branch":
        flags = [a for a in rest if a.startswith("-")]
        if not rest or (flags and all(f.split("=")[0] in BRANCH_OK for f in flags)):
            return None
        return "only branch --list/-a/-r/-v"
    if sub == "tag":
        return None if rest and rest[0] in ("--list", "-l", "-n") or rest == [] else "only tag --list"
    if sub == "remote":
        return None if rest in ([], ["-v"], ["--verbose"]) else "only remote -v"
    if sub == "stash":
        return None if rest[:1] in (["list"], ["show"]) else "only stash list/show"
    if sub == "config":
        return None if rest[:1] in (["--get"], ["--list"], ["-l"], ["--get-all"]) else "only config --get/--list"
    if sub == "worktree":
        return None if rest[:1] == ["list"] else "only worktree list"
    return f"git {sub} is not read-only"


def unquoted(seg):
    """The segment with quoted text and escaped characters blanked out: <, >, |, ;, & inside quotes are data."""
    out, quote, i = "", None, 0
    while i < len(seg):
        c = seg[i]
        if quote:
            if c == "\\" and quote == '"':
                i += 1
            elif c == quote:
                quote = None
            out += "x"
        elif c in "'\"":
            quote = c
            out += "x"
        elif c == "\\":
            i += 1
            out += "x"
        else:
            out += c
        i += 1
    return out


RUN_ID = re.compile(r"\d{4}-\d{6}-[0-9a-f]{4}")


def lean_agent_ok(args):
    """`lean-agent runs --show <id> [--details]` and `lean-agent output <file>` only: both print, nothing else."""
    if len(args) in (3, 4) and args[:2] == ["runs", "--show"] and RUN_ID.fullmatch(args[2]) \
            and (len(args) == 3 or args[3] == "--details"):
        return None
    if len(args) == 2 and args[0] == "output" and not args[1].startswith("-"):
        return None
    return "only `lean-agent runs --show <id> [--details]` and `lean-agent output <file>` are read-only"


def segment_ok(seg, cfg, state):
    """None when the segment may run, else the reason."""
    try:
        toks = shlex.split(seg)
    except ValueError:
        return "unbalanced quotes"
    bare = unquoted(seg).split()
    if any(re.search(r"[<>]", t) and t not in REDIRECT_OK for t in bare):
        return "redirects can write files"
    toks = [t for t in toks if t not in REDIRECT_OK]
    if not toks:
        return None
    if re.match(r"\w+=", toks[0]):
        return "environment prefixes are not allowed"
    for prefix in cfg.get("allow_cmd", []):
        p = prefix.split()
        if toks[:len(p)] == p:
            return None
    head = toks[0]
    if head == "cd":
        target = toks[1] if len(toks) > 1 else cfg["project"]
        state["cwd"] = target if os.path.isabs(target) else os.path.join(state["cwd"], target)
        return None
    if head == "git":
        return git_ok(toks[1:], state["cwd"], cfg["project"])
    if head == "find":
        bad = [t for t in toks if t in FIND_BAD]
        return f"find {bad[0]} can change files" if bad else None
    if head.endswith("/lean-json") or head == "lean-json":
        return None
    if os.path.basename(head) == "lean-agent":
        return lean_agent_ok(toks[1:])
    if head in SIMPLE:
        if head == "sort" and any(t in SORT_BAD or t.startswith("--output=") for t in toks):
            return "sort -o writes a file"
        if head == "rg" and any(t == "--pre" or t.startswith("--pre=") for t in toks):
            return "rg --pre runs a program"
        return None
    return "not allowed for a read-only worker"


def decide(event, cfg):
    """(decision, reason, segment) for a Bash event: decision is "allow" or "deny"."""
    if event.get("tool_name") != "Bash":
        return None, "", ""
    cmd = (event.get("tool_input") or {}).get("command") or ""
    segs = split_segments(cmd)
    if segs is None:
        return "deny", "command substitution is not allowed", cmd
    state = {"cwd": event.get("cwd") or cfg["project"]}
    for seg in segs:
        why = segment_ok(seg, cfg, state)
        if why:
            return "deny", why, seg
    return "allow", "", cmd


def main():
    event = json.load(sys.stdin)
    with open(sys.argv[1]) as fh:
        cfg = json.load(fh)
    decision, why, seg = decide(event, cfg)
    if not decision:
        return 0
    if decision == "allow":
        out = {"hookEventName": "PreToolUse", "permissionDecision": "allow",
               "permissionDecisionReason": "read-only command (lean-agent)"}
    else:
        msg = (f"not allowed for a read-only worker: {seg} ({why}). The orchestrator can add --allow-cmd '<command prefix>'; "
               "read-only git, find (without -exec/-delete), ls, stat, cat, head, tail, wc, grep, rg, du, file, realpath, "
               "readlink, which and pipes between them are allowed.")
        out = {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": msg}
        try:
            with open(cfg["log"], "a") as fh:
                fh.write(json.dumps({"command": seg}) + "\n")
        except OSError:
            pass
    print(json.dumps({"hookSpecificOutput": out}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # a broken hook must not break the worker: Claude Code's own rules then decide
        sys.exit(0)
