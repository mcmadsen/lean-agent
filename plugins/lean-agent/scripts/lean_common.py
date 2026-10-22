"""Small helpers shared by lean_agent, dashboard, dash_chat and dash_service (stdlib only, so any of them can import it)."""
import json
import os

PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


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
