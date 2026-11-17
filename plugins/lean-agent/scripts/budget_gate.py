"""The budget hook's no-op gate (stdlib only, imported by the trampoline before the hook is compiled): decides from the
event and the environment alone whether any check of budget_hook.py can apply."""
import os

def in_home_or_service(cwd, home):
    """Is this the orchestrator (cwd in the lean-agent home) or the service session?"""
    return cwd == home or cwd.startswith(home + os.sep) or os.environ.get("LEAN_AGENT_SERVICE_SESSION") == "1"


def is_front_desk(event):
    """Is this session the real front desk (and so subject to strict mode and the orchestrator rules)? Only the sessions
    `lean-agent up` hosts (LEAN_AGENT_SERVICE_SESSION=1, or a `up --local` terminal session) and the attached external desk
    (desk.json names this session id with a fresh heartbeat). Any other session, in any folder, is a normal session."""
    if os.environ.get("LEAN_AGENT_SERVICE_SESSION") == "1" or os.environ.get("LEAN_AGENT_LOCAL_UP") == "1":
        return True
    try:
        import sys
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import lean_desk
        return lean_desk.is_desk(event.get("session_id"))
    except Exception:  # noqa: BLE001
        return False


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


NOOP_BASH_WORDS = ("push", "remote", "create", "review")


def nothing_to_do(event):
    """True when no check of this hook can apply (decided from the event and the environment only, no heavy import):
    a session outside the lean-agent home and service, no session spend cap in the environment, and (for Bash) a command
    that is not a publish. Everything doubtful is False and the full hook runs."""
    name = event.get("hook_event_name")
    if name == "UserPromptSubmit":
        return not prompt_needs_hook(event)
    cwd = os.path.realpath(event.get("cwd") or os.getcwd())
    home = os.path.realpath(os.path.abspath(os.path.expanduser(os.environ.get("LEAN_AGENT_HOME") or "~/.lean-agent")))
    if in_home_or_service(cwd, home):
        return False
    if name == "Stop":
        return True
    if os.environ.get("LEAN_AGENT_SESSION_ROLE") in ("main", "thread"):
        return False
    if os.environ.get("LEAN_AGENT_BUDGET") not in (None, "", "0"):
        return False
    if event.get("tool_name") == "Bash":
        command = str((event.get("tool_input") or {}).get("command") or "")
        if any(k in command for k in NOOP_BASH_WORDS):
            return False
    return True
