#!/usr/bin/env python3
"""PostToolUse hook for Bash: shrink noisy command output before Claude sees it.

Large outputs (builds, test runs, installs, logs) are reduced to the head, the
tail, and every line that looks like an error, with repeated lines collapsed.
The full output is saved to a file and its path is put at the top, so Claude
can still grep or Read it when the summary isn't enough.

Env:
    LEAN_AGENT_SQUEEZE=0          disable
    LEAN_AGENT_SQUEEZE_OVER=6000  only squeeze outputs longer than this (chars)
    LEAN_AGENT_SQUEEZE_TO=4000    target size after squeezing (chars)
Put LEAN_RAW=1 anywhere in a command to bypass it for that command. Reads (cat, sed -n, head,
grep/rg, git show/grep/diff/log/blame) are never squeezed: their output is what was asked for.
"""
import glob
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import usage  # noqa: E402

ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
ERRORISH = re.compile(
    r"error|fail|exception|traceback|panic|fatal|assert|denied|not found|"
    r"cannot|unable to|segmentation|undefined|ERR!|✗|✘|×",
    re.IGNORECASE,
)
HEAD, TAIL, CONTEXT, MAX_HITS = 15, 40, 2, 80
# Commands whose output is content the agent asked for (files, search hits, diffs): never squeezed.
READ_COMMANDS = {"cat", "head", "tail", "sed", "nl", "less", "more", "bat", "grep", "egrep", "fgrep", "rg", "ag",
                 "ack", "jq", "yq", "awk", "diff", "xxd", "od"}
READ_GIT = {"show", "grep", "diff", "log", "blame", "cat-file"}


def is_read_command(command):
    """True when the command's main step reads content (cat, sed -n, git show, rg, ...)."""
    segment = re.split(r"&&|;|\|\|", command)[-1].split("|")[0].strip()
    words = [w for w in segment.split() if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", w)]
    if not words:
        return False
    prog = os.path.basename(words[0])
    if prog == "git":
        rest = words[1:]
        while rest and rest[0].startswith("-"):  # git -C <dir> / -c key=val
            rest = rest[2:] if rest[0] in ("-C", "-c") else rest[1:]
        return bool(rest) and rest[0] in READ_GIT
    return prog in READ_COMMANDS
KEEP_LOGS_SECONDS = 2 * 24 * 3600


def clean_lines(text):
    text = ANSI.sub("", text)
    lines = []
    for line in text.split("\n"):
        line = line.rsplit("\r", 1)[-1]  # progress bars: keep the final redraw
        if lines and line == lines[-1][0]:
            lines[-1][1] += 1
        else:
            lines.append([line, 1])
    return [l if n == 1 else f"{l}  [repeated {n}x]" for l, n in lines]


def squeeze(text, target):
    lines = clean_lines(text)
    joined = "\n".join(lines)
    if len(joined) <= target:
        return joined
    keep = set(range(min(HEAD, len(lines))))
    keep |= set(range(max(0, len(lines) - TAIL), len(lines)))
    hits = [i for i, l in enumerate(lines) if ERRORISH.search(l)][:MAX_HITS]
    for i in hits:
        keep |= set(range(max(0, i - CONTEXT), min(len(lines), i + CONTEXT + 1)))
    out, prev = [], -1
    for i in sorted(keep):
        if i != prev + 1:
            out.append(f"… [{i - prev - 1} lines omitted] …")
        out.append(lines[i])
        prev = i
    if prev != len(lines) - 1:
        out.append(f"… [{len(lines) - 1 - prev} lines omitted] …")
    result = "\n".join(out)
    if len(result) > target:  # still too big: keep both ends, tail-heavy
        head = int(target * 0.3)
        tail = target - head
        result = result[:head] + "\n… [truncated] …\n" + result[-tail:]
    return result


def save_full(event, stdout, stderr):
    d = os.path.join(usage.data_dir(), "outputs")
    os.makedirs(d, exist_ok=True)
    now = time.time()
    for old in glob.glob(os.path.join(d, "*.log")):
        try:
            if now - os.path.getmtime(old) > KEEP_LOGS_SECONDS:
                os.remove(old)
        except OSError:
            pass
    name = re.sub(r"[^A-Za-z0-9_-]", "_", event.get("tool_use_id") or str(int(now * 1000)))
    path = os.path.join(d, name + ".log")
    with open(path, "w", encoding="utf-8", errors="replace") as fh:
        fh.write(stdout)
        if stderr:
            fh.write("\n----- stderr -----\n")
            fh.write(stderr)
    return path


def main():
    if os.environ.get("LEAN_AGENT_SQUEEZE") == "0":
        return 0
    try:
        event = json.load(sys.stdin)
    except ValueError:
        return 0
    resp = event.get("tool_response")
    if not isinstance(resp, dict):
        return 0
    command = (event.get("tool_input") or {}).get("command") or ""
    # Never squeeze explicit opt-outs or reads of our own saved logs.
    if "LEAN_RAW" in command or "lean-agent" in command or is_read_command(command):
        return 0
    stdout = resp.get("stdout") if isinstance(resp.get("stdout"), str) else ""
    stderr = resp.get("stderr") if isinstance(resp.get("stderr"), str) else ""
    over = int(os.environ.get("LEAN_AGENT_SQUEEZE_OVER") or 6000)
    target = int(os.environ.get("LEAN_AGENT_SQUEEZE_TO") or 4000)
    original = len(stdout) + len(stderr)
    if original <= over:
        return 0

    path = save_full(event, stdout, stderr)
    share = len(stdout) / original
    new_out = squeeze(stdout, max(1000, int(target * share))) if stdout else ""
    new_err = squeeze(stderr, max(1000, int(target * (1 - share)))) if stderr else ""
    header = (
        f"[lean-agent: output squeezed {original:,} -> {len(new_out) + len(new_err):,} chars. "
        f"Full output: {path} (grep it or Read with offset/limit if you need more)]\n"
    )
    updated = dict(resp)
    updated["stdout"] = header + new_out
    updated["stderr"] = new_err
    print(json.dumps({
        "hookSpecificOutput": {"hookEventName": "PostToolUse", "updatedToolOutput": updated}
    }))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # fall back to the untouched output
        print(f"lean-agent squeeze hook error: {exc}", file=sys.stderr)
        sys.exit(0)
