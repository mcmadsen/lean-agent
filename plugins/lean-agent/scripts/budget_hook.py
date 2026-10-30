#!/usr/bin/env python3
"""PreToolUse hook: enforce lean-agent's plan-window budgets and a per-session token budget.

Window budgets (`lean-agent limits`) apply only to sessions in the lean-agent home, and
`lean-agent limits` / `lean-agent stats` stay allowed so the user can see and raise them.

Reads LEAN_AGENT_BUDGET, a self-set spend cap in Sonnet-equivalent tokens (0/unset = track only):
tokens billed this session, summed over every turn, so it grows much faster than the context window.
LEAN_AGENT_BUDGET_COUNT=new counts only new tokens (no cache re-reads). LEAN_AGENT_WARN_PCT (default 80):
past it Claude gets a one-time note to spend less (and to hand off only if the context itself is large,
LEAN_AGENT_HANDOFF_CONTEXT, default 150,000); past the cap every tool call is denied with an instruction
to summarise and stop.

Strict orchestrator (`lean-agent config strict on|off`, default on): in the orchestrator (the lean-agent home or the
service session) Bash may run only lean-agent commands and Read/Grep/Glob only lean-agent's own files; the denial names
the worker command to use instead. Workers are never affected.

In the lean-agent home (the orchestrator) a command that starts a worker (`lean-agent run`, `review`, `do`,
`tracker --discover`) must run in the background, so the session stays free for the user while it works
(LEAN_AGENT_BACKGROUND_RUNS=0 turns that off). It also keeps the context small: a Bash command that would print a
long lean-agent run file (cat, less, a big tail ...) is refused with the command to use instead
(LEAN_AGENT_READ_GUARD=0 turns that off, LEAN_AGENT_READ_LINES sets the limit, default 40), and once the
context reaches 80% of the session's compaction point (or LEAN_AGENT_CTX_NUDGE tokens; 100,000 when the point
isn't known; again every 50,000 more) Claude gets a note: check what fills the context and save open items
before Claude Code compacts.
"""
import datetime
import json
import os
import re
import sys

MEMORY_MESSAGE_RE = r"^#[ \t]+\S"  # '# keep this', not '#12 is failing' or '#tag'
COMMAND_PROMPT_RE = r"^/(memory|init)(\s|$)"


def in_home_or_service(cwd, home):
    """Is this the orchestrator (cwd in the lean-agent home) or the service session?"""
    return cwd == home or cwd.startswith(home + os.sep) or os.environ.get("LEAN_AGENT_SERVICE_SESSION") == "1"


def prompt_needs_hook(event):
    """Could the UserPromptSubmit hook act on this prompt here? Only in the orchestrator home or the service session
    (every prompt there is put in a thread), never in a worker's run folder."""
    prompt = str(event.get("prompt") or "").strip()
    if not prompt:
        return False
    cwd = os.path.realpath(event.get("cwd") or os.getcwd())
    # computed inline: the hook must stay cheap, and importing usage here would defeat that
    home = os.path.realpath(os.path.abspath(os.path.expanduser(os.environ.get("LEAN_AGENT_HOME") or "~/.lean-agent")))
    return in_home_or_service(cwd, home) and not cwd.startswith(os.path.join(home, "work") + os.sep)


STDIN = None
if __name__ == "__main__":  # a prompt in any other session leaves here, before the heavy imports below
    STDIN = sys.stdin.read()
    if '"UserPromptSubmit"' in STDIN:
        try:
            if not prompt_needs_hook(json.loads(STDIN)):
                sys.exit(0)
        except ValueError:
            sys.exit(0)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import usage  # noqa: E402
import push_guard  # noqa: E402
import lean_common  # noqa: E402
import lean_schedule  # noqa: E402
import lean_threads  # noqa: E402
import service_session  # noqa: E402


def compaction_point():
    """Where Claude Code compacts this session: from its environment (`lean-agent up` sets it when compaction is
    overridden), else its own default for the model's window."""
    try:
        window = int(os.environ.get("CLAUDE_CODE_AUTO_COMPACT_WINDOW") or 0) or None
        pct = float(os.environ.get("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE") or 0) or None
    except ValueError:
        return 0
    if pct is not None and not (0 < pct <= 100):
        return 0
    return lean_common.compaction_point(window, pct)


def emit(**fields):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", **fields}}))


HEREDOC_OPEN = re.compile(r"<<(-?)[ \t]*(?:'(\w+)'|\"(\w+)\"|(\w+))")


def split_heredocs(command):
    """`command` with each heredoc body and its delimiter line cut out and `<<DATA` left at the redirect, or None
    when it holds a command substitution (`$(` or a backtick) outside a heredoc body and outside single quotes,
    an unquoted `#` that starts a word (a comment), or a heredoc this can't read (odd delimiter, no closing line).
    A body ends at the first line that is exactly the delimiter (after leading tabs for <<-). The body of a quoted delimiter is data; an unquoted one expands
    `$(` and backticks, so those are refused there too."""
    out, pending, quote, i, n = [], [], None, 0, len(command)
    while i < n:
        c = command[i]
        if quote == "'":
            quote = None if c == "'" else quote
        elif c == "\\":
            out.append(command[i:i + 2])
            i += 2
            continue
        elif c == "`" or command.startswith("$(", i):
            return None
        elif c == "#" and quote is None and (i == 0 or command[i - 1] in " \t\n;&|()<>"):
            return None  # a shell comment
        elif quote == '"':
            quote = None if c == '"' else quote
        elif c in "'\"":
            quote = c
        elif command.startswith("<<", i):
            m = HEREDOC_OPEN.match(command, i)
            if not m:
                return None
            pending.append((m.group(1) == "-", m.group(2) or m.group(3) or m.group(4), bool(m.group(4))))
            out.append("<<DATA")
            i = m.end()
            continue
        elif c == "\n" and pending:
            out.append(c)
            i += 1
            for dash, delim, expands in pending:
                while True:
                    if i >= n:
                        return None
                    end = command.find("\n", i)
                    end = n if end < 0 else end
                    line = command[i:end]
                    i = min(end + 1, n)
                    if (line.lstrip("\t") if dash else line) == delim:
                        break
                    if expands and ("`" in line or "$(" in line):
                        return None
            pending = []
            continue
        out.append(c)
        i += 1
    return None if pending else "".join(out)


def commands_run(command):
    """The word lists of the commands a shell line runs: heredoc bodies and quoted text are data, not
    commands; `cd x &&`, VAR=value, nohup, timeout N and env in front are skipped."""
    import shlex
    text = split_heredocs(command)
    if text is None:  # unparseable: heredoc bodies could pass as commands, so read the first line only
        if strict_on(usage.lean_home()):
            return []
        text = command.split("\n", 1)[0]
        if "<<" in text or "`" in text or "$(" in text:
            text = re.split(r"<<|`|\$\(", text, maxsplit=1)[0]
    out = []
    for segment in re.split(r"&&|\|\||;|\||\n|&", text):
        try:
            words = shlex.split(segment)
        except ValueError:
            words = segment.split()
        while words and (re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", words[0]) or words[0] in ("nohup", "env", "exec")):
            words = words[1:]
        if words[:1] == ["timeout"] and len(words) > 2:
            words = words[2:]
        if words:
            out.append(words)
    return out


def foreground_worker(command):
    """The lean-agent command in `command` that would start a worker and hold the turn until it ends, or ''."""
    for words in commands_run(command):
        if os.path.basename(words[0]) != "lean-agent" or len(words) < 2:
            continue
        sub, rest = words[1], words[2:]
        if sub not in ("run", "review", "do", "tracker") or {"-h", "--help"} & set(rest):
            continue  # help text starts nothing
        if sub == "review" and (rest[:1] == ["decline"] or {"--status", "--costs"} & set(rest)):
            continue  # instant
        if sub == "tracker" and "--discover" not in rest:
            continue
        return f"lean-agent {sub}"
    return ""


def unlinked_worker(command):
    """The lean-agent command in `command` that starts a worker without `--todo N` (so the board can't show it), or ''."""
    for words in commands_run(command):
        if os.path.basename(words[0]) != "lean-agent" or len(words) < 2 or words[1] not in ("run", "review", "do"):
            continue
        rest = words[2:]
        if words[1] == "review" and (rest[:1] == ["decline"] or {"--status", "--decide-gaps", "--costs"} & set(rest)):
            continue  # decisions about a review, not work for the board
        if {"-h", "--help"} & set(rest):
            continue
        if "--resume" in rest or any(w == "--todo" or w.startswith("--todo=") for w in rest):
            continue  # a resumed run keeps its item
        return f"lean-agent {words[1]}"
    return ""


def todo_reminder(which):
    """What to tell the orchestrator when it starts a worker that no work-queue item names."""
    try:
        with open(os.path.join(usage.lean_home(), "todo.json")) as fh:
            items = [t for t in json.load(fh).get("items") or [] if t.get("status") != "done"]
    except (OSError, ValueError, AttributeError):
        items = []
    items.sort(key=lambda t: (t.get("status") != "doing", t.get("id", 0)))
    listed = "; ".join(f"#{t.get('id')} {str(t.get('text', ''))[:50]}" for t in items[:6])
    return (f"lean-agent: this `{which}` isn't linked to a work-queue item, so the user's board won't show it. If it "
            "is work for the user, start it with `--todo N`"
            + (f" (open: {listed})" if listed else "")
            + ", or `--todo new` (the item is made from --why). A quick lookup that isn't queue work: add `--todo none`.")


READERS = re.compile(r"(?:^|[;&|(]\s*|\s)(cat|less|more|bat|nl|tail|head|sed|awk|python3?|jq)\s")
RUN_FILE = re.compile(r"[^\s'\"]*(?:summary-\d+\.txt|details-\d+\.md|result\.json|/work/\d{4}-\d{6}-[0-9a-f]{4}/[^\s'\"]*)")


def long_run_read(command, lean_root):
    """Why a command would print a long lean-agent run file into the context, or ''."""
    if not READERS.search(command):
        return ""
    limit = int(os.environ.get("LEAN_AGENT_READ_LINES") or 40)
    m = re.search(r"\b(?:head|tail)\s+(?:-n\s*|-)(\d+)", command)
    if m and int(m.group(1)) <= limit and not re.search(r"\b(cat|less|more|bat|nl)\s", command):
        return ""  # a short slice
    for raw in RUN_FILE.findall(command):
        path = os.path.expanduser(raw.replace("$LEAN_AGENT_HOME", lean_root).replace("${LEAN_AGENT_HOME}", lean_root))
        if "/work/" not in path and not path.startswith(lean_root):
            continue
        try:
            with open(path, errors="replace") as fh:
                n = sum(1 for _ in fh)
        except OSError:
            continue
        if n > limit:
            return f"{path} has {n} lines"
    return ""


PLUGIN_ROOT = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
DELEGATE = ("Delegate it: lean-agent run <project> --cards auto -m <model> --why '…' -- '<task>' "
            "(--read-only for lookups).")


def strict_on(lean_root):
    try:
        with open(os.path.join(lean_root, "config.json")) as fh:
            return json.load(fh).get("strict", "on") != "off"
    except (OSError, ValueError, AttributeError):
        return True


BREAKS = {";", "&&", "||", "&"}
REDIRECT_OK = {(">&", "1"), (">&", "2"), (">", "/dev/null"), ("&>", "/dev/null"), ("<<", "DATA")}


def pipe_stage_ok(words):
    """A pipe stage after a lean-agent command, allowlisted, reading stdin only: head -n N, -N, -c N; tail also
    -n +N; wc with -l -w -c -m; grep with -nwolciv EFxhHq, -m/-A/-B/-C N and exactly one pattern, no files."""
    cmd, args = words[0], words[1:]
    if cmd in ("head", "tail"):
        num = r"\+?\d+" if cmd == "tail" else r"\d+"
        return (not args or len(args) == 1 and re.fullmatch(rf"-\d+|-[nc]{num}", args[0]) is not None
                or len(args) == 2 and args[0] in ("-n", "-c") and re.fullmatch(num, args[1]) is not None)
    if cmd == "wc":
        return all(re.fullmatch(r"-[lwcm]+", a) for a in args)
    if cmd == "grep":
        while args:
            if re.fullmatch(r"-[nwolcivEFxhHq]+|-[mABC]\d+", args[0]):
                args = args[1:]
            elif args[0] in ("-m", "-A", "-B", "-C") and len(args) > 1 and args[1].isdigit():
                args = args[2:]
            else:
                break
        return len(args) == 1 and not args[0].startswith("-")
    return False


def split_stages(command):
    """(stages, glued) of a shell command, or None when it can't be parsed or redirects/substitutes in a way strict
    mode refuses: stages are word lists, None marks a break between commands (see lean_agent_only)."""
    # Strict mode is a guardrail that keeps a cooperating orchestrator from doing project work itself. It errs on the
    # side of denying unusual shell; it is not a sandbox against a hostile model. That is also why it denies comments,
    # command substitution and unknown pipe stages outright rather than parsing them.
    import shlex
    command = split_heredocs(command)
    if command is None:
        return None
    lex = shlex.shlex(command, posix=True, punctuation_chars=";&|<>()\n")
    lex.whitespace_split, lex.whitespace, lex.commenters = True, " \t\r", ""
    try:
        tokens = list(lex)
    except ValueError:
        return None
    glued = []
    stages, words, i = [], [], 0  # stages: word lists; None marks a break between commands
    while i < len(tokens):
        tok = tokens[i]
        i += 1
        if re.fullmatch(r"[;&|<>()\n]+", tok):
            core = tok.strip("\n")
            if core == "|":
                stages.append(words)
                words = []
            elif core == "" or core in BREAKS:
                stages.append(words)
                stages.append(None)
                words = []
            elif re.search(r"[<>]", tok) and "(" not in tok and ")" not in tok:
                if tok != "<<" and words and re.fullmatch(r"\d", words[-1]):
                    fd = words.pop()  # the fd number of 2>/dev/null
                    glued.append((len(stages), fd))  # or the last argument of `head -n 5>/dev/null`
                if (tok, tokens[i] if i < len(tokens) else None) not in REDIRECT_OK:
                    return None
                i += 1
            else:
                return None
        else:
            words.append(tok)
    stages.append(words)
    return stages, glued


def lean_agent_only(command):
    """True when every command in `command` is a lean-agent command (any first word with basename `lean-agent`,
    or the plugin's bin path); `cd` is fine. Quoted text is data, and an unparsable command is refused. Only
    2>&1, >&2, >/dev/null, 2>/dev/null and &>/dev/null redirect; &&, ||, ;, a lone & and newlines separate
    commands; a pipe may only feed head, tail, grep or wc reading stdin (a few read-only options, one grep pattern,
    no files). A heredoc (`<<'X'`, `<<X`, `<<-X`) on a command is allowed: its body is data, up to the first line
    that is exactly X. A command substitution (`$(` or a backtick) anywhere else, outside single quotes, is refused."""
    split = split_stages(command)
    if split is None:
        return False
    stages, glued = split
    bin_dir = os.path.join(PLUGIN_ROOT, "bin") + os.sep
    first = True
    for n, words in enumerate(stages):
        if words is None:
            first = True
            continue
        while words and (re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", words[0]) or words[0] in ("nohup", "env", "exec")):
            words = words[1:]
        if words[:1] == ["timeout"] and len(words) > 2:
            words = words[2:]
        if not words:
            continue
        if not first:
            if not (pipe_stage_ok(words) or any(pipe_stage_ok(words + [fd]) for at, fd in glued if at == n)):
                return False
        elif not (words[0] == "cd" or os.path.basename(words[0]) == "lean-agent"
                  or os.path.realpath(os.path.expanduser(words[0])).startswith(bin_dir)):
            return False
        first = False
    return True


# The lean-agent subcommands the strict orchestrator may not run. docs/orchestrator-surface.md lists every one with
# its class; workers are not affected (they start with `lean-agent run <p> --cards auto ... -- "<task>"`).
#   "change"  changes a project repo, branch, remote or tracker: worktree rm|setup|push|reset|attach (reset: kept in case it
#             becomes a subcommand), rules (writes or with --off removes lean-agent's block in the repo's rules file),
#             codemod --apply (runs on the checkout itself; without --apply: a throwaway copy), tracker with a value,
#             --note, --rm-note, --supersede or --ack-email (--discover alone starts a worker). PR and tracker writes
#             have no subcommand: a worker does them with the tracker's MCP server (`run --mcp`) or `worktree push`.
#   "keep"    writes knowledge or settings the user asked for: memory add|edit|rm|import, card (everything but show),
#             recipe, doc, schedule add|rm|defaults, guard add|rm, count add|rm, todo add|note|rm|edit|epic|reopen,
#             handoff --note unless --kind checkpoint|fyi|decision, review learn --text|--helper, config strict off. Where one subcommand serves both the
#             orchestrator's bookkeeping and the user's content (todo add, handoff --note), it is denied; the
#             orchestrator links a run with `--todo new` and keeps its own state with checkpoint / handoff --kind fyi.
#   "mcp"     lists or runs MCP servers or presets: the whole `mcp` subcommand, `chrome check`.
# Bookkeeping stays allowed: todo list|next|start|done, handoff (read, --done, --kind checkpoint|fyi|decision), thread
# (also new|send|open|close [tN ...|--all|--idle DUR]|sessions [--context]: they start, message and stop the thread's own session, never project work),
# checkpoint, clear [--thread tN] and clear --all [--restart] [--force] (queue a /clear, or a restart, for the end of the turn), brief, runs (also `runs --wait`, which blocks until runs finish, and `runs --stop`, which only ends lean-agent's own runs), review (it starts its own worker), handover (writes only under LEAN_AGENT_HOME), sync, doctor, optimize and the like.
CHANGING_ACTIONS = {"worktree": {"rm", "setup", "push", "reset", "base", "attach"}}
CHANGING_ALWAYS = {"rules"}
CHANGING_FLAGS = {"codemod": {"--apply"}, "tracker": {"--note", "--rm-note", "--supersede", "--ack-email"}}
KEEP_ACTIONS = {
    "memory": ({"where", "import", "list", "add", "edit", "rm"}, {"import", "add", "edit", "rm"}),
    "card": ({"show", "add", "rm", "core", "shorten", "unarchive", "protect"}, {"add", "rm", "core", "shorten",
                                                                               "unarchive", "protect"}),
    "todo": ({"add", "list", "next", "start", "done", "note", "rm", "reopen", "edit", "epic"},
             {"add", "note", "rm", "edit", "epic", "reopen"}),
    "schedule": ({"list", "add", "rm", "run", "pause", "resume", "defaults", "run-due"}, {"add", "rm", "defaults"}),
    "guard": ({"list", "add", "rm"}, {"add", "rm"}),
}
KEEP_ALWAYS = {"recipe", "doc"}
MCP_ALWAYS = {"mcp"}
MCP_ACTIONS = {"chrome": ({"check", "status"}, {"check"})}
KEEP_NOTE_KINDS = ("checkpoint", "fyi", "decision")
MCP_RESOURCE_TOOLS = ("ListMcpResources", "ListMcpResourcesTool", "ReadMcpResource", "ReadMcpResourceTool",
                      "ReadMcpResourceDir", "ReadMcpResourceDirTool")
DELEGATE_CHANGE = ("A worker makes the change and reads the project's cards: lean-agent run <project> --cards auto "
                   "-m <model> --why '…' -- '<push/PR/tracker task>' (a push also needs the user's approval and a "
                   "review: see the guide).")
DELEGATE_KEEP = ("Keep it with a worker: lean-agent remember \"<what to keep>\" [--project <p>] (memory, card, todo, "
                 "feedback rule or note, filed once), or lean-agent run <project> --cards auto -m <model> --why '…' -- "
                 "'<task>'.")
DELEGATE_KEEP_MAIN = ("Keep it with lean-agent remember \"<what to keep>\" [--project <p>] (filed once as memory, card, todo, "
                      "feedback rule or note), or hand it to a thread: lean-agent thread send tN --prompt-file - "
                      "(or thread new \"title\").")
DELEGATE_MCP = ("MCP servers are for workers: lean-agent run <project> --read-only --cards auto -m haiku --why '…' "
                "[--mcp <server>:<tools>] [--allow-cmd 'lean-agent mcp'] -- '<which servers / what tool X returns>'.")


# Tools that would keep track outside lean-agent: refused with the lean-agent command that does it. Matched by
# exact name or prefix (Task* except TaskOutput, which reads lean-agent's own background output).
TRACK_TODO = ("lean-agent keeps the todos: `lean-agent todo list|next|start|done` (a new one: `lean-agent remember "
              "\"<todo>\"`, or `run --todo new`); what we are doing: `lean-agent now`.")
TRACK_STOP = "Stop a run with `lean-agent runs --stop <id>`; see runs with `lean-agent runs`."
TRACK_SCHEDULE = "lean-agent keeps the schedules: `lean-agent schedule list|run|pause|resume`; new ones via `lean-agent remember`."
TRACK_RUN = ("Start a worker with `lean-agent run <project> --cards auto -m <model> --why '…' -- '<task>'` and follow "
             "it with `lean-agent runs --show <id> --tail`.")
TRACK_WORKER = "A worker does that: lean-agent run <project> --read-only --cards auto -m haiku --why '…' -- '<task>'."
TRACK_REDIRECT = {
    "TodoWrite": TRACK_TODO, "TaskCreate": TRACK_TODO, "TaskUpdate": TRACK_TODO, "TaskList": TRACK_TODO,
    "TaskGet": TRACK_TODO, "TaskStop": TRACK_STOP, "KillShell": TRACK_STOP, "CronCreate": TRACK_SCHEDULE,
    "CronDelete": TRACK_SCHEDULE, "CronList": TRACK_SCHEDULE, "ScheduleWakeup": TRACK_SCHEDULE,
    "Agent": TRACK_RUN, "Task": TRACK_RUN, "Workflow": TRACK_RUN, "SendMessage": TRACK_RUN,
    "Monitor": "Wait for runs with `lean-agent runs --wait <id|all>`; read one with `lean-agent runs --show <id> --tail`.",
    "EnterPlanMode": "Plans are a worker's task or a thread: `lean-agent thread show tN`, `lean-agent advise \"<request>\"`.",
    "ExitPlanMode": "Plans are a worker's task or a thread: `lean-agent thread show tN`, `lean-agent advise \"<request>\"`.",
    "PushNotification": "The user is reached by your reply (AskUserQuestion for a question); lean-agent tracks the rest: `lean-agent now`.",
    "NotebookEdit": TRACK_WORKER, "NotebookRead": TRACK_WORKER, "WebFetch": TRACK_WORKER, "WebSearch": TRACK_WORKER,
}
TRACK_PREFIX = {"Task": TRACK_TODO, "Cron": TRACK_SCHEDULE}


def tracking_redirect(tool):
    """The lean-agent alternative to a tool that keeps track outside lean-agent, or ''."""
    if tool in TRACK_REDIRECT:
        return TRACK_REDIRECT[tool]
    if tool == "TaskOutput":
        return ""
    return next((m for pre, m in TRACK_PREFIX.items() if tool and tool.startswith(pre)), "")


def flag_value(words, flag):
    """The value of `--flag X` or `--flag=X` among `words`, or None."""
    for i, w in enumerate(words):
        if w == flag:
            return words[i + 1] if i + 1 < len(words) else ""
        if w.startswith(flag + "="):
            return w[len(flag) + 1:]
    return None


def first_action(args, names):
    return next((w for w in args[1:] if w in names), "")


def restricted_command(command):
    """(kind, `subcommand`) of a `lean-agent <subcommand>` in `command` the strict orchestrator may not run (see
    CHANGING_* and KEEP_*; kind is change, keep or mcp), or ('', '')."""
    split = split_stages(command)
    if split is None:
        return "", ""
    first = True
    for words in split[0]:
        if words is None:
            first = True
            continue
        while words and (re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", words[0]) or words[0] in ("nohup", "env", "exec")):
            words = words[1:]
        if words[:1] == ["timeout"] and len(words) > 2:
            words = words[2:]
        if first and words and os.path.basename(words[0]) == "lean-agent":
            args = [w for w in words[1:] if not w.startswith("-")]
            name = args[0] if args else ""
            flags = set(words[1:])
            if name in CHANGING_ALWAYS:
                return "change", name
            if name in CHANGING_ACTIONS and len(args) > 1 and args[1] in CHANGING_ACTIONS[name]:
                return "change", f"{name} {args[1]}"
            if CHANGING_FLAGS.get(name, set()) & flags:
                return "change", f"{name} {' '.join(sorted(CHANGING_FLAGS[name] & flags))}"
            if name == "tracker" and any("=" in w for w in args[2:]):
                return "change", "tracker KEY=VALUE"
            if name in KEEP_ALWAYS:
                return "keep", name
            if name in KEEP_ACTIONS:
                action = first_action(args, KEEP_ACTIONS[name][0])
                if action in KEEP_ACTIONS[name][1]:
                    return "keep", f"{name} {action}"
            if name == "count" and any(w in ("add", "rm") for w in args[2:3]):
                return "keep", f"count {args[2]}"
            if name == "handoff" and (flag_value(words, "--note") is not None
                                      and flag_value(words, "--kind") not in KEEP_NOTE_KINDS):
                return "keep", "handoff --note"
            if name == "review-learn" or (name == "review" and args[1:2] == ["learn"]):
                given = [f for f in ("--text", "--helper") if flag_value(words, f) is not None]
                if given:  # text the orchestrator supplies is knowledge, like `memory add`
                    return "keep", f"review learn {given[0]}"
            if name == "config" and args[1:2] == ["strict"] and "off" in args[2:3]:
                return "keep", "config strict off"
            if name in MCP_ALWAYS:
                return "mcp", name
            if name in MCP_ACTIONS and first_action(args, MCP_ACTIONS[name][0]) in MCP_ACTIONS[name][1]:
                return "mcp", f"{name} {first_action(args, MCP_ACTIONS[name][0])}"
        first = False
    return "", ""


# The main session is the front desk: it lists the threads and hands work over, it does none. These lean-agent
# subcommands are refused there (a thread session runs them); docs/orchestrator-surface.md section 5 lists both sides.
FRONT_DESK_WORK = {"run", "review", "review-learn", "review-decline", "do", "handover", "learn", "tracker", "optimize",
                   "sync", "codemod", "rules", "publish", "push"}
FRONT_DESK_ACTIONS = {"worktree": {"push"}}
FRONT_DESK_HINT = ("main is the front desk: hand it to a thread — lean-agent thread send tN --prompt-file - "
                   "(or thread new \"title\")")


def front_desk_denial(event):
    """Why the main session (LEAN_AGENT_SESSION_ROLE=main) may not run this call, or ''. Only work commands are refused."""
    if os.environ.get("LEAN_AGENT_SESSION_ROLE") != "main" or event.get("tool_name") != "Bash":
        return ""
    for words in commands_run(str((event.get("tool_input") or {}).get("command") or "")):
        if os.path.basename(words[0]) != "lean-agent":
            continue
        args = [w for w in words[1:] if not w.startswith("-")]
        name = args[0] if args else ""
        if {"-h", "--help"} & set(words[1:]):
            continue
        if name in FRONT_DESK_WORK or (len(args) > 1 and args[1] in FRONT_DESK_ACTIONS.get(name, ())):
            return f"`lean-agent {' '.join(args[:2]) if name in FRONT_DESK_ACTIONS else name}`: " + FRONT_DESK_HINT
    return ""


def own_path(path, cwd, lean_root):
    """Is `path` lean-agent's own (its home, which holds the docs folder and run files, or the plugin)?"""
    full = os.path.realpath(os.path.join(cwd, os.path.expanduser(path)))
    return any(full == r or full.startswith(r + os.sep) for r in (os.path.realpath(lean_root), PLUGIN_ROOT))


def strict_denial(event, cwd, lean_root):
    """Why the strict orchestrator may not make this call, or ''. In the main session the way out is the hand-over."""
    tool, tool_input = event.get("tool_name"), event.get("tool_input") or {}
    main = os.environ.get("LEAN_AGENT_SESSION_ROLE") == "main"

    def hint(text):  # the main session hands work to a thread; only a thread session starts workers
        return FRONT_DESK_HINT + "." if main else text
    redirect = tracking_redirect(tool)
    if main and redirect in (TRACK_RUN, TRACK_WORKER):
        redirect = FRONT_DESK_HINT + "."
    if redirect:
        return f"strict mode: the orchestrator keeps track only with lean-agent, not with {tool[:40]}. " + redirect
    if tool == "Bash":
        command = str(tool_input.get("command") or "")
        if not lean_agent_only(command):
            return f"strict mode: the orchestrator runs only lean-agent commands, not `{command.strip()[:60]}`. " + hint(DELEGATE)
        kind, what = restricted_command(command)
        if kind == "change":
            return (f"strict mode: the orchestrator never changes a repo, branch, remote or tracker itself "
                    f"(`lean-agent {what}`). " + hint(DELEGATE_CHANGE))
        if kind == "keep":
            return (f"strict mode: the orchestrator never writes memory, cards, rules, presets, todos or notes "
                    f"itself (`lean-agent {what}`). " + (DELEGATE_KEEP_MAIN if main else DELEGATE_KEEP))
        if kind == "mcp":
            return f"strict mode: the orchestrator neither lists nor runs MCP servers (`lean-agent {what}`). " + hint(DELEGATE_MCP)
    elif tool and (tool.startswith("mcp__") or tool in MCP_RESOURCE_TOOLS):
        return f"strict mode: the orchestrator uses no MCP tool ({tool[:60]}). " + hint(DELEGATE_MCP)
    elif tool in ("Read", "Grep", "Glob"):
        path = tool_input.get("file_path") if tool == "Read" else tool_input.get("path")
        pattern = str(tool_input.get("pattern") or "")
        if not path and tool == "Glob" and (os.path.isabs(os.path.expanduser(pattern)) or ".." in pattern.split("/")):
            path = pattern
        if path and not own_path(str(path), cwd, lean_root):
            return f"strict mode: the orchestrator doesn't read project files ({str(path)[:80]}). " + hint(DELEGATE)
    return ""


MEMORY_REDIRECT = ("lean-agent: this is a request to keep something (a '#' memory message). Don't save it yourself: "
                   "start `lean-agent remember \"<the text without the #>\"` in the background (add --project <p> if it is "
                   "about one project) and tell the user in one line what you started.")


def prompt_hook(event):
    """UserPromptSubmit in the orchestrator. Main session: the prompt is matched against the open threads (no model call) and
    one context line says what to do (hand it to its thread session, start a new one, or answer a status question with `now`);
    a background-task notification is silent. Thread session: the prompt is pinned to its thread, no line. In the
    strict orchestrator a one-line '#' memory message is also redirected to `lean-agent remember`, and /memory and /init
    (Claude Code's own memory editors) are refused."""
    prompt = str(event.get("prompt") or "").strip()
    strict = strict_on(usage.lean_home())
    if strict and re.match(COMMAND_PROMPT_RE, prompt):
        print(json.dumps({"decision": "block", "reason": "lean-agent: the orchestrator's memory lives in lean-agent, not in "
                          "Claude Code's memory files. Say what to keep and a worker files it (`lean-agent remember`)."}))
        return
    lines = []
    pinned = lean_threads.pinned_thread()
    if not prompt.startswith("/"):  # slash commands are not requests
        try:
            if pinned:  # a thread session: everything belongs to its thread, nothing is guessed or announced
                if not lean_threads.is_notification(prompt):
                    lean_threads.pin(pinned, prompt, event.get("session_id"))
            elif service_session.SUMMARY_RE.match(prompt.strip()):  # the one-line summary of staged thread reports: the full block rides along as hidden context
                block = service_session.take_pending(prompt)
                if block:
                    lean_threads.store_reports(block)
                    lines.append(block)
            elif lean_threads.is_reports(prompt):  # thread reports: stored on the threads they name, nothing guessed or announced
                lean_threads.store_reports(prompt)
            elif lean_threads.is_notification(prompt):  # a background-task notification: never a new request or thread; attaches to its run's thread silently
                lean_threads.notification_line(prompt)
            else:  # the main session is the front desk: one line saying what to do with the request
                lines.append(lean_threads.advise(prompt, event.get("session_id"))[1])
        except Exception:  # never break the prompt
            pass
        lines = [l for l in lines if l]
    if strict and re.match(MEMORY_MESSAGE_RE, prompt) and "\n" not in prompt and len(prompt) < 500:
        lines.append(MEMORY_REDIRECT)
    if lines:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "\n".join(lines)}}))


ASKING_RE = re.compile(r"\b(should I|do you want|would you like|let me know|waiting (?:for|on) you|your call|which (?:one|option) )", re.I)
STOP_REASON = "Ask this with AskUserQuestion so it can't be missed."


def turn_of(path):
    """(last assistant text, AskUserQuestion was called) for the turn at the end of the transcript at `path`."""
    text, asked = "", False
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
    except OSError:
        return text, asked
    for line in raw.split(b"\n"):
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        msg = rec.get("message") if isinstance(rec, dict) and isinstance(rec.get("message"), dict) else {}
        body = msg.get("content")
        if rec.get("type") == "user":
            if isinstance(body, str) or any(isinstance(c, dict) and c.get("type") == "text" for c in body or []):
                text, asked = "", False  # a new turn starts with the user's own message
        elif rec.get("type") == "assistant":
            parts = []
            for c in body if isinstance(body, list) else []:
                if isinstance(c, dict) and c.get("type") == "tool_use" and c.get("name") == "AskUserQuestion":
                    asked = True
                elif isinstance(c, dict) and c.get("type") == "text":
                    parts.append(str(c.get("text") or ""))
            if parts:
                text = "\n".join(parts)
    return text, asked


def asks_user(text):
    paras = [p.strip() for p in re.split(r"\n\s*\n", str(text or "")) if p.strip()]
    if not paras:
        return False
    return paras[-1].endswith("?") or bool(ASKING_RE.search(paras[-1]))


def stop_hook(event):
    """Stop in the main session: a turn that ends asking the user something in prose, without AskUserQuestion, is sent
    back once (stop_hook_active ends the loop). Thread sessions ask with `thread ask` and are left alone."""
    if event.get("stop_hook_active") or os.environ.get("LEAN_AGENT_SESSION_ROLE") == "thread":
        return
    text, asked = turn_of(event.get("transcript_path") or "")
    if not asked and asks_user(text):
        print(json.dumps({"decision": "block", "reason": STOP_REASON}))


def main():
    try:
        event = json.loads(STDIN) if STDIN is not None else json.load(sys.stdin)
    except ValueError:
        return 0
    if event.get("hook_event_name") == "UserPromptSubmit":
        cwd = os.path.realpath(event.get("cwd") or os.getcwd())
        home = os.path.realpath(usage.lean_home())
        if in_home_or_service(cwd, home) and not cwd.startswith(os.path.join(home, "work") + os.sep):
            prompt_hook(event)
        return 0
    if event.get("hook_event_name") == "Stop":
        cwd = os.path.realpath(event.get("cwd") or os.getcwd())
        home = os.path.realpath(usage.lean_home())
        if in_home_or_service(cwd, home) and not cwd.startswith(os.path.join(home, "work") + os.sep):
            stop_hook(event)
        return 0
    transcript = event.get("transcript_path")
    session_id = event.get("session_id")
    if not transcript or not session_id:
        return 0

    # Plan windows: enforced only for sessions inside the lean-agent home (the orchestrator),
    # never for the user's normal sessions that also have this plugin enabled.
    cwd = os.path.realpath(event.get("cwd") or os.getcwd())
    home = os.path.realpath(usage.lean_home())
    command = str((event.get("tool_input") or {}).get("command") or "").strip()
    # lean-agent's own status and budget commands always run, so a blocked session can see and lift its limits
    checking = event.get("tool_name") == "Bash" and command.startswith(tuple(
        "lean-agent " + c for c in ("limits", "stats", "budget", "runs", "logs", "doctor")))
    in_home = cwd == home or cwd.startswith(home + os.sep)
    if in_home and not checking:
        hit = usage.exhausted_window()
        if hit:
            emit(permissionDecision="deny",
                 permissionDecisionReason=usage.describe_exhausted(hit) + " Do not call more tools: tell the user "
                 "briefly what is done and what remains, then end your turn.")
            return 0

    if event.get("tool_name") == "AskUserQuestion" and os.environ.get("LEAN_AGENT_SESSION_ROLE") == "thread":
        emit(permissionDecision="deny", permissionDecisionReason=(
            "lean-agent: a thread session never asks the user directly. Use `lean-agent thread ask \"<question>\" "
            "[--options \"a|b|c\"]` so main gets the question, then end your turn: main's answer arrives as your next turn."))
        return 0
    tool_input = event.get("tool_input") or {}
    worker_dir = cwd.startswith(os.path.join(home, "work") + os.sep)  # a worker's run folder is never the orchestrator
    if (in_home or os.environ.get("LEAN_AGENT_SERVICE_SESSION") == "1") and not worker_dir:
        why = front_desk_denial(event)
        if why:
            emit(permissionDecision="deny", permissionDecisionReason="lean-agent: " + why)
            return 0
    if ((in_home or os.environ.get("LEAN_AGENT_SERVICE_SESSION") == "1") and not worker_dir
            and strict_on(usage.lean_home())):
        why = strict_denial(event, cwd, usage.lean_home())
        if why:
            emit(permissionDecision="deny", permissionDecisionReason="lean-agent: " + why)
            return 0
    if in_home and event.get("tool_name") == "Bash" and "push" in command:
        why = push_guard.check(command, cwd)
        if why:
            emit(permissionDecision="deny", permissionDecisionReason="lean-agent push guard: " + why)
            return 0
    if (in_home and event.get("tool_name") == "Bash" and not tool_input.get("run_in_background")
            and os.environ.get("LEAN_AGENT_BACKGROUND_RUNS") != "0"):
        which = foreground_worker(command)
        if which:
            emit(permissionDecision="deny", permissionDecisionReason=(
                f"lean-agent: start `{which}` in the background (Bash with run_in_background: true), so you stay free "
                "to answer the user while the worker runs. Tell the user in one line what you started, then end your "
                "turn; you're notified when it finishes, and its answer is short (`lean-agent runs --show <id>` "
                "prints it again)."))
            return 0

    if in_home and event.get("tool_name") == "Bash" and os.environ.get("LEAN_AGENT_TODO_REMINDER") != "0":
        which = unlinked_worker(command)
        if which:
            emit(permissionDecision="deny", permissionDecisionReason=todo_reminder(which))
            return 0

    if in_home and event.get("tool_name") == "Bash" and os.environ.get("LEAN_AGENT_READ_GUARD") != "0":
        why = long_run_read(command, usage.lean_home())
        if why:
            emit(permissionDecision="deny", permissionDecisionReason=(
                f"lean-agent: not printing a lean-agent run file into the orchestrator's context ({why}; it would "
                "be re-read on every later call). Use the run's short answer: `lean-agent runs --show <id>`; one "
                "part of its details: `lean-agent runs --show <id> --details --grep TEXT`; or have a -m haiku worker "
                "read the file and answer the question. Never paste worker output into your reply."))
            return 0

    state = usage.load_state(session_id)
    usage.update(state, transcript)

    budget, count, _ = usage.session_cap(orchestrator=in_home)
    warn_pct = int(os.environ.get("LEAN_AGENT_WARN_PCT") or 80)
    used = usage.cap_units(state, count)  # Sonnet-equivalent tokens, the unit used everywhere
    new_only = count == "new"
    counted = ("new tokens this session (cache re-reads not counted)" if new_only else
               "tokens billed this session, summed over every turn (cache re-reads count 0.1x)")
    ctx = state.get("last_ctx") or 0
    ctx_big = ctx >= int(os.environ.get("LEAN_AGENT_HANDOFF_CONTEXT") or 150000)
    ctx_note = f"The context window is a different number: ~{ctx:,} tokens now" if ctx else ""

    if budget > 0 and used >= budget and not checking:
        usage.save_state(session_id, state)
        emit(
            permissionDecision="deny",
            permissionDecisionReason=(
                f"lean-agent: the session spend cap you set is reached: {used:,} / {budget:,} sonnet-eq {counted}. "
                + (ctx_note + ". " if ctx_note else "")
                + "Do not call more tools (only `lean-agent budget` still runs). Reply with a short summary of what "
                "is done and what remains, then end your turn. The user can lift it right away, without a restart: "
                "`lean-agent budget --cap off` or `--cap <higher>` (and `--count new` to leave cache re-reads out)."
            ),
        )
        return 0

    if budget > 0 and used >= budget * warn_pct / 100 and not state.get("warned") and not checking:
        state["warned"] = True
        usage.save_state(session_id, state)
        advice = ("Spend less from here: fewer, larger steps; delegate reading to -m haiku workers; don't re-read "
                  "files or re-run commands for output you already have.")
        if ctx_big:
            advice += " The context is also large: summarise and suggest a fresh session soon."
        elif ctx_note:
            ctx_note += ", which is fine, so no hand-off is needed for it"
        emit(
            additionalContext=(
                f"lean-agent: {used * 100 // budget}% of the session spend cap you set (LEAN_AGENT_BUDGET) is used: "
                f"{used:,} / {budget:,} sonnet-eq {counted}. This is a spend total, not the context window."
                + (f" {ctx_note}." if ctx_note else "") + " " + advice
            )
        )
        return 0

    if in_home and not lean_schedule.timer_alive() and lean_schedule.any_due():
        lean_schedule.spawn_runner()  # no `lean-agent up` timer: run due scheduled jobs in the background
    if in_home and not checking:
        if not state.get("sched_seen"):  # a new session: only results from now on (older ones are in the hand-off)
            state["sched_seen"] = datetime.datetime.now().isoformat(timespec="seconds")
        new = lean_schedule.results_since(state["sched_seen"])
        if new:
            state["sched_seen"] = new[-1]["ts"]
            usage.save_state(session_id, state)
            emit(additionalContext="lean-agent: scheduled job(s) finished: " + "; ".join(
                f"#{r['id']} `lean-agent {' '.join(r['args'])}` exit {r['rc']}: {r['first'][:120]} (full: {r['output']})"
                for r in new[-5:]) + ". Tell the user in a line or two if it matters to them.")
            return 0

    compact_at = compaction_point()
    # before Claude Code compacts: at 80% of its compaction point (the configured one, else its default for the model's
    # window; LEAN_AGENT_CTX_NUDGE sets it directly, and 100,000 applies when the environment can't be read), then every
    # 50,000 more
    nudge_at = int(os.environ.get("LEAN_AGENT_CTX_NUDGE") or (compact_at * 0.8 if compact_at else 100000))
    if in_home and not checking and nudge_at and ctx >= nudge_at and ctx >= (state.get("nudged") or 0) + 50000:
        state["nudged"] = ctx
        usage.save_state(session_id, state)
        if compact_at and ctx < compact_at:
            emit(additionalContext=(
                f"lean-agent: the context is ~{ctx:,} tokens; Claude Code compacts at ~{compact_at:,}. Before that "
                "(standing rule): run `lean-agent context --no-probe` to see what fills your messages, save anything "
                "still open with `lean-agent handoff --note \"...\" --kind fyi`, tell the user in one line, then go on. Keep "
                "replies and command output short from here."))
            return 0
        calls = state["totals"].get("_calls") or 1
        models = state.get("models") or {}
        model = max(models, key=lambda m: usage.units(models[m], m)) if models else "sonnet"
        per100 = int(usage.units({"cache_read_input_tokens": max(0, ctx - 20000) * 100}, model))
        msg = (f"lean-agent: this session re-reads ~{ctx:,} tokens of context on every call (average "
               f"{state['totals'].get('_ctx', 0) // calls:,} per call so far). Compacting to ~20K would save about "
               f"{per100:,} sonnet-eq per 100 calls. Keep replies short, then ask the user to send /compact (lean-agent "
               "tells the summary what to keep), or run `lean-agent handoff` and go on in a fresh session.")
        emit(additionalContext=msg)
        return 0

    usage.save_state(session_id, state)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # never break the user's session over accounting
        print(f"lean-agent budget hook error: {exc}", file=sys.stderr)
        sys.exit(0)
