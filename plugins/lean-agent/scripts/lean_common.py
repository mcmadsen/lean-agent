"""Small helpers shared by lean_agent, dashboard, dash_chat and dash_service (stdlib only, so any of them can import it)."""
import glob
import json
import os

PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_COMPACT_WINDOW = 100000  # the orchestrator's CLAUDE_CODE_AUTO_COMPACT_WINDOW
DEFAULT_COMPACT_PCT = 70  # ...and its CLAUDE_AUTOCOMPACT_PCT_OVERRIDE


def thread_key(tid):
    """The chat key of a thread id: `#12` -> `12`, `t3` stays."""
    tid = str(tid or "")
    return tid[1:] if tid.startswith("#") else tid


def compaction_point(window, pct):
    """Tokens at which Claude Code compacts: the percentage of the window, but never past the window minus its
    fixed autocompact buffer (LEAN_AGENT_COMPACT_BUFFER, default 33,000)."""
    # Claude Code's /context panel shows a 33k autocompact buffer on a 100k window, i.e. compaction at ~67k
    # (the percentage alone would say 70k).
    try:
        buffer = int(os.environ.get("LEAN_AGENT_COMPACT_BUFFER") or 33000)
    except ValueError:
        buffer = 33000
    return int(min(window * pct / 100, window - buffer))


def pid_alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError, TypeError):
        return False


def plugin_version():
    try:
        with open(os.path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json")) as fh:
            return json.load(fh).get("version") or "?"
    except (OSError, ValueError, AttributeError):
        return "?"


def tool_summary(name, inp):
    """One line for a tool call: the command, the file, the pattern ..."""
    inp = inp if isinstance(inp, dict) else {}
    for k in ("command", "file_path", "pattern", "url", "path", "query", "description", "prompt"):
        if inp.get(k):
            return " ".join(str(inp[k]).split())[:300]
    return " ".join(json.dumps(inp)[:200].split())


def questions_of(inp):
    """A multiple-choice question from Claude (AskUserQuestion), for the page to show as buttons."""
    out = []
    for q in (inp or {}).get("questions") or []:
        if isinstance(q, dict) and q.get("question"):
            out.append({"question": q["question"], "header": q.get("header"), "multi": bool(q.get("multiSelect")),
                        "options": [{"label": o.get("label"), "description": o.get("description")}
                                    for o in q.get("options") or [] if isinstance(o, dict) and o.get("label")]})
    return out


def stored_advice(directory, thread=None):
    """The advice `lean-agent advise` stored in `directory`, oldest first: {ts, thread, project, request, text}
    (only those of the chat thread `thread` when given)."""
    out = []
    for f in sorted(glob.glob(os.path.join(directory, "*.json"))):
        try:
            with open(f) as fh:
                d = json.load(fh)
        except (OSError, ValueError):
            continue
        if isinstance(d, dict) and d.get("text") and (thread is None or d.get("thread") == thread):
            out.append(d)
    return out
