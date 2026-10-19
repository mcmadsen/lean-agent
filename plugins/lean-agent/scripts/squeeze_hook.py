#!/usr/bin/env python3
"""PostToolUse hook for Bash: shrink noisy command output before Claude sees it.

Large outputs (builds, test runs, installs, logs) lose their noise first (progress,
downloads, build steps, passing tests, deprecation notices), then are cut to what
matters: whole error blocks and stack traces (first and last first, repeats counted),
the closing summary, the start, and one copy of each warning. The full output and an
errors-only copy are saved under ~/.lean-agent/logs/verbose/ and their paths go at the
top, so Claude can grep or Read them when the summary isn't enough.

Env:
    LEAN_AGENT_SQUEEZE=0          disable
    LEAN_AGENT_SQUEEZE_OVER=6000  only squeeze outputs longer than this (chars)
    LEAN_AGENT_SQUEEZE_TO=4000    target size after squeezing (chars)
Put LEAN_RAW=1 anywhere in a command to bypass it for that command. Reads (cat, sed -n, head,
grep/rg, git show/grep/diff/log/blame) are never squeezed: their output is what was asked for.
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lean_log  # noqa: E402

ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
ERROR = re.compile(
    r"\b(errors?|fail(ed|ure|ures|s)?|exception|traceback|panic(ked)?|fatal|segmentation fault|assert(ion)?(error)?|"
    r"denied|not found|cannot|can't|unable to|undefined|unresolved|refused|timed? ?out|abort(ed)?)\b|ERR!|✗|✘|×|^E\s",
    re.IGNORECASE)
NOT_ERROR = re.compile(r"\b(0|no) (errors?|fail(ed|ures?)?)\b|\b(errors?|fail(ed|ures?)?)\s*[:=]\s*0\b|"
                       r"\berror[-_ ]?(handling|handler|prone|boundary|codes?)\b", re.IGNORECASE)
WARN = re.compile(r"\bwarn(ing)?s?\b|\bdeprecat", re.IGNORECASE)
# Lines that are almost never what the agent needs; dropped before anything is cut (unless error-like).
NOISE = [
    ("progress", re.compile(r"^\s*[\[(]?\s*\d{1,3}(\.\d+)?\s?%|^[\s|/\\=#>.·•\-]{3,}$|^[⠁-⣿]+\s|\b\d+/\d+ \[[=>. ]+\]")),
    ("download", re.compile(
        r"^\s*(Downloading|Downloaded|Fetching|Fetched|Resolving|Resolved|Collecting|Using cached|Requirement already "
        r"satisfied|Unpacking|Extracting|Pulling fs layer|Waiting|Verifying Checksum|Download complete|Pull complete|"
        r"Already exists|Progress|Receiving objects|Resolving deltas|Updating files|remote: (Counting|Compressing|"
        r"Enumerating|Total)|added \d+ packages|Get:\d+|Hit:\d+|Ign:\d+)\b", re.IGNORECASE)),
    ("build step", re.compile(
        r"^\s*(Compiling|Checking|Fresh|Installing|Linking|Restored|Restoring|Determining projects|Copying|Generating|"
        r"Processing|Transforming|transforming|Writing|Bundling|Preparing|> Task :\S+( UP-TO-DATE| NO-SOURCE| FROM-CACHE)?$|"
        r"\[INFO\] (Download|Building|---|Copying|Compiling|Installing))")),
    ("passing test", re.compile(
        r"^\s*(PASS|ok|✓|√|✔)\s|\bPASSED\b|^\s*test \S+ \.\.\. ok$|^\s*\S+\.(py|ts|js)::\S+ PASSED|^\s*[.]+\s*\[\s*\d+%\]$")),
    ("deprecation notice", re.compile(r"npm (WARN|warn) deprecated|DeprecationWarning:|is deprecated")),
]
HEAD, TAIL, CONTEXT_BEFORE, CONTEXT_AFTER, MAX_BLOCK = 8, 25, 2, 2, 40
RUN_LINE_RE = re.compile(r"(?m)^run \d{4}-\d{6}-[0-9a-f]{4} · ")  # the first line of a lean-agent run summary
STACK = re.compile(r"^\s+\S|^\s*(at |File \"|Caused by|\.\.\. \d+ more|\^|-->|\|)")
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


def is_error(line):
    return bool(ERROR.search(line)) and not NOT_ERROR.search(line)


def signature(line):
    """The same message with numbers, paths and ids blanked, to spot repeats."""
    line = re.sub(r"(/|[A-Za-z]:\\)[^\s:'\"()]+", "<path>", line)
    line = re.sub(r"0x[0-9a-fA-F]+|\b[0-9a-f]{7,}\b|\d+", "#", line)
    return line.strip()[:160]


def drop_noise(lines):
    """(kept lines, {category: dropped count}); error-like lines are always kept, and of warnings that only
    differ in numbers or paths the first is kept with a count."""
    kept, dropped, warn_at = [], {}, {}
    for line in lines:
        if not is_error(line):
            cat = next((c for c, rx in NOISE if rx.search(line)), None)
            if cat:
                dropped[cat] = dropped.get(cat, 0) + 1
                continue
            if WARN.search(line):
                sig = signature(line)
                if sig in warn_at:
                    warn_at[sig][1] += 1
                    dropped["repeated warning"] = dropped.get("repeated warning", 0) + 1
                    continue
                warn_at[sig] = [len(kept), 0]
        kept.append(line)
    for i, n in warn_at.values():
        if n:
            kept[i] += f"  [similar warning {n}x more]"
    return kept, dropped


def error_blocks(lines):
    """[(start, end, signature)] around each error line, extended over a following stack trace."""
    blocks, i = [], 0
    while i < len(lines):
        if is_error(lines[i]):
            start, end = max(0, i - CONTEXT_BEFORE), i + 1
            while end < len(lines) and end - i < MAX_BLOCK and (STACK.match(lines[end]) or is_error(lines[end])):
                end += 1
            end = min(len(lines), max(end, i + 1 + CONTEXT_AFTER))
            blocks.append((start, end, signature(lines[i])))
            i = end
        else:
            i += 1
    return blocks


def squeeze(text, target, stats=None):
    """Shrink `text` to about `target` chars, spending the room on what matters: errors (whole stack traces,
    the first and the last ones before the middle), the closing summary, then the start, then one copy of each
    kind of warning. Noise (progress, downloads, passing tests) goes first. Never cuts through an error block."""
    stats = {} if stats is None else stats
    lines = clean_lines(text)
    if len("\n".join(lines)) <= target:
        return "\n".join(lines)
    lines, dropped = drop_noise(lines)
    stats["noise"] = dropped
    joined = "\n".join(lines)
    if len(joined) <= target:
        return _note(dropped) + joined
    keep, used = set(), 0

    def take(idx, partial=False):
        nonlocal used
        new = [i for i in idx if i not in keep]
        cost = sum(len(lines[i]) + 1 for i in new)
        if used + cost > target and not partial:
            return False
        for i in new:
            if used + len(lines[i]) + 1 > target:
                return bool(i != new[0])
            keep.add(i)
            used += len(lines[i]) + 1
        return True

    blocks = error_blocks(lines)
    seen, unique, repeats = set(), [], {}
    for b in blocks:
        if b[2] in seen:
            repeats[b[2]] = repeats.get(b[2], 0) + 1
        else:
            seen.add(b[2])
            unique.append(b)
    order = []
    lo, hi = 0, len(unique) - 1
    while lo <= hi:  # first, last, second, second-to-last, ...
        order.append(unique[lo])
        if hi != lo:
            order.append(unique[hi])
        lo, hi = lo + 1, hi - 1
    stats.update(errors=len(blocks), unique_errors=len(unique))
    if order:
        take(range(order[0][0], order[0][1]), partial=True)  # the first error, as much as fits
    take(range(max(0, len(lines) - TAIL), len(lines)), partial=True)  # the summary at the end
    for b in order[1:]:
        take(range(b[0], b[1]))
    take(range(min(HEAD, len(lines))))
    warn_seen = set()
    for i, line in enumerate(lines):
        if not is_error(line) and WARN.search(line):
            sig = signature(line)
            if sig not in warn_seen:
                warn_seen.add(sig)
                take([i])
    stats["warnings"] = len(warn_seen)
    out, prev = [], -1
    for i in sorted(keep):
        if i != prev + 1:
            out.append(f"… [{i - prev - 1} lines omitted] …")
        line = lines[i]
        sig = signature(line) if is_error(line) else None
        if sig in repeats:
            line += f"  [same error {repeats.pop(sig)}x more]"
        out.append(line)
        prev = i
    if prev != len(lines) - 1:
        out.append(f"… [{len(lines) - 1 - prev} lines omitted] …")
    return _note(dropped) + "\n".join(out)


def _note(dropped):
    if not dropped:
        return ""
    return "[dropped noise: " + ", ".join(f"{n:,} {c} lines" for c, n in sorted(dropped.items(), key=lambda x: -x[1])) + "]\n"


def save_full(event, stdout, stderr):
    name = re.sub(r"[^A-Za-z0-9_-]", "_", event.get("tool_use_id") or str(int(time.time() * 1000)))
    path = lean_log.verbose_path(name + ".log")
    with open(path, "w", encoding="utf-8", errors="replace") as fh:
        fh.write(stdout)
        if stderr:
            fh.write("\n----- stderr -----\n")
            fh.write(stderr)
    return path


def save_errors(path, stdout, stderr):
    """An errors-and-warnings-only copy (with line numbers in the full file); None if there are none."""
    rows = []
    full = stdout + ("\n----- stderr -----\n" + stderr if stderr else "")
    for n, line in enumerate(ANSI.sub("", full).split("\n"), 1):
        line = line.rsplit("\r", 1)[-1]
        if is_error(line) or WARN.search(line):
            rows.append(f"{n}: {line[:500]}")
    if not rows:
        return None, 0
    err_path = path[:-4] + ".errors.log"
    with open(err_path, "w", encoding="utf-8", errors="replace") as fh:
        fh.write("\n".join(rows) + "\n")
    return err_path, sum(1 for r in rows if is_error(r.split(": ", 1)[1]))


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
    # Never squeeze explicit opt-outs, lean-agent's own commands, or reads of saved logs.
    if ("LEAN_RAW" in command or "lean-agent" in command or "lean_agent" in command or "lean-sq" in command
            or is_read_command(command)):
        return 0
    stdout = resp.get("stdout") if isinstance(resp.get("stdout"), str) else ""
    stderr = resp.get("stderr") if isinstance(resp.get("stderr"), str) else ""
    over = int(os.environ.get("LEAN_AGENT_SQUEEZE_OVER") or 6000)
    target = int(os.environ.get("LEAN_AGENT_SQUEEZE_TO") or 4000)
    original = len(stdout) + len(stderr)
    if original <= over:
        return 0

    # A lean-agent run summary (however it got here: a pipe, a log file): the worker's answer is never cut;
    # only what comes before the first run line may be squeezed.
    m = RUN_LINE_RE.search(stdout)
    if m:
        head, keep = stdout[:m.start()], stdout[m.start():]
        if len(head) <= over:
            return 0
        stdout = head
    else:
        keep = ""
    path = save_full(event, stdout + keep, stderr)
    err_path, n_errors = save_errors(path, stdout, stderr)
    share = len(stdout) / original
    st_out, st_err = {}, {}
    new_out = squeeze(stdout, max(1000, int(target * share)), st_out) if stdout else ""
    new_err = squeeze(stderr, max(1000, int(target * (1 - share))), st_err) if stderr else ""
    header = (
        f"[lean-agent: output squeezed {original:,} -> {len(new_out) + len(new_err):,} chars. "
        f"Full output: {path}"
        + (f" · errors and warnings only ({n_errors} error lines): {err_path}" if err_path else "")
        + " (grep it or Read with offset/limit if you need more)]\n"
    )
    noise = {}
    for st in (st_out, st_err):
        for k, v in (st.get("noise") or {}).items():
            noise[k] = noise.get(k, 0) + v
    lean_log.record_saving("squeeze", original, len(new_out) + len(new_err))
    lean_log.log("debug", "squeeze", f"`{command[:200]}` {original:,} -> {len(new_out) + len(new_err):,} chars; "
                 f"noise dropped {noise or 'none'}; full {path}")
    if n_errors:
        first = next((l for l in open(err_path, encoding="utf-8").read().splitlines()
                      if is_error(l.split(": ", 1)[-1])), "")
        lean_log.log("error", "command", f"`{command[:200]}`: {n_errors} error lines, first {first[:300]!r}; "
                     f"errors {err_path}; full {path}")
    updated = dict(resp)
    updated["stdout"] = header + new_out + (("\n" + keep) if keep else "")
    updated["stderr"] = new_err
    print(json.dumps({
        "hookSpecificOutput": {"hookEventName": "PostToolUse", "updatedToolOutput": updated}
    }))
    return 0


def run_wrapped(argv):
    """`lean-sq <command...>`: run a (not long-running) command and print its output squeezed the same way,
    with the full output and an errors-only copy saved. Exits with the command's exit code."""
    import subprocess
    if argv and argv[0] == "--":
        argv = argv[1:]
    if not argv:
        print("usage: lean-sq <command> [args...]   (or: lean-sq 'cmd | other')", file=sys.stderr)
        return 2
    command = argv[0] if len(argv) == 1 else " ".join(__import__("shlex").quote(a) for a in argv)
    p = subprocess.run(command, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    text = p.stdout.decode("utf-8", errors="replace")
    over = int(os.environ.get("LEAN_AGENT_SQUEEZE_OVER") or 6000)
    target = int(os.environ.get("LEAN_AGENT_SQUEEZE_TO") or 4000)
    if len(text) <= over or os.environ.get("LEAN_AGENT_SQUEEZE") == "0":
        sys.stdout.write(text)
    else:
        path = save_full({"tool_use_id": "sq"}, text, "")
        err_path, n_errors = save_errors(path, text, "")
        stats = {}
        out = squeeze(text, target, stats)
        print(f"[lean-sq: output squeezed {len(text):,} -> {len(out):,} chars. Full output: {path}"
              + (f" · errors and warnings only ({n_errors} error lines): {err_path}" if err_path else "") + "]")
        print(out)
        lean_log.record_saving("lean-sq", len(text), len(out))
        lean_log.log("debug", "lean-sq", f"`{command[:200]}` exit {p.returncode}, {len(text):,} -> {len(out):,} "
                     f"chars; noise dropped {stats.get('noise') or 'none'}; full {path}")
    if p.returncode:
        print(f"[exit code {p.returncode}]")
        lean_log.log("error", "lean-sq", f"`{command[:200]}` exited {p.returncode}")
    return p.returncode


if __name__ == "__main__":
    if sys.argv[1:2] == ["run"]:
        sys.exit(run_wrapped(sys.argv[2:]))
    try:
        sys.exit(main())
    except Exception as exc:  # fall back to the untouched output
        print(f"lean-agent squeeze hook error: {exc}", file=sys.stderr)
        try:
            lean_log.log("error", "squeeze hook", repr(exc))
        except Exception:
            pass
        sys.exit(0)
