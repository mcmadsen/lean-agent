"""MCP support for lean-agent workers: find configured servers, measure their tools, build per-run configs.

Workers normally run in --safe-mode, which turns MCP off. A run that asks for MCP
servers uses `--setting-sources ""` + `--strict-mcp-config` instead: the same
isolation (no user/project settings, CLAUDE.md, plugins or hooks), plus exactly the
servers and tools the orchestrator picked.
"""
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time

PROTOCOL_VERSION = "2025-06-18"


def _load(path):
    try:
        with open(path) as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def claude_json_path():
    base = os.environ.get("CLAUDE_CONFIG_DIR")
    return os.path.join(base, ".claude.json") if base else os.path.expanduser("~/.claude.json")


def desktop_config_paths():
    if sys.platform == "darwin":
        return [os.path.expanduser("~/Library/Application Support/Claude/claude_desktop_config.json")]
    if os.name == "nt":
        return [os.path.join(os.environ.get("APPDATA", ""), "Claude", "claude_desktop_config.json")]
    return [os.path.expanduser("~/.config/Claude/claude_desktop_config.json")]


def discover(project_path=None):
    """Configured MCP servers as {name: {"config": {...}, "source": str}}.

    Later sources win, matching Claude Code's precedence (local > project > user);
    Claude Desktop chat-app servers rank lowest.
    """
    servers = {}

    def add(source, mapping):
        for name, cfg in (mapping or {}).items():
            if isinstance(cfg, dict):
                servers[name] = {"config": cfg, "source": source}

    for p in desktop_config_paths():
        add("desktop", _load(p).get("mcpServers"))
    cj = _load(claude_json_path())
    add("user", cj.get("mcpServers"))
    if project_path:
        add("project", _load(os.path.join(project_path, ".mcp.json")).get("mcpServers"))
        projs = cj.get("projects") or {}
        for key in dict.fromkeys([project_path, os.path.realpath(project_path)]):
            add("local", (projs.get(key) or {}).get("mcpServers"))
    return servers


def server_type(cfg):
    return cfg.get("type") or ("stdio" if "command" in cfg else "http")


def tool_prefix(server):
    """Claude Code names MCP tools mcp__<server>__<tool>."""
    return "mcp__" + re.sub(r"[^A-Za-z0-9_-]", "_", server) + "__"


def tool_tokens(tool):
    payload = {"name": tool.get("name"), "description": tool.get("description", ""),
               "input_schema": tool.get("inputSchema", {})}
    return (len(json.dumps(payload)) + 3) // 4


class ProbeError(Exception):
    pass


def probe(cfg, timeout=20.0):
    """List a stdio server's tools by speaking MCP to it directly (no model call)."""
    if server_type(cfg) != "stdio":
        raise ProbeError("only stdio servers can be probed directly; try `lean-agent mcp tools <server> --measure`")
    env = dict(os.environ)
    env.update({k: os.path.expandvars(str(v)) for k, v in (cfg.get("env") or {}).items()})
    cmd = [os.path.expandvars(cfg["command"])] + [os.path.expandvars(str(x)) for x in cfg.get("args") or []]
    try:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                text=True, env=env, cwd=cfg.get("cwd") or None)
    except OSError as exc:
        raise ProbeError(f"could not start {cmd[0]}: {exc}")
    lines = queue.Queue()
    threading.Thread(target=lambda: [lines.put(l) for l in proc.stdout], daemon=True).start()
    deadline = time.time() + timeout

    def send(msg):
        proc.stdin.write(json.dumps(msg) + "\n")
        proc.stdin.flush()

    def call(mid, method, params):
        send({"jsonrpc": "2.0", "id": mid, "method": method, "params": params})
        while True:
            left = deadline - time.time()
            if left <= 0:
                raise ProbeError(f"timed out waiting for {method}")
            try:
                line = lines.get(timeout=left)
            except queue.Empty:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if msg.get("id") == mid:
                if "error" in msg:
                    raise ProbeError(f"{method}: {msg['error'].get('message')}")
                return msg.get("result") or {}

    try:
        call(1, "initialize", {"protocolVersion": PROTOCOL_VERSION, "capabilities": {},
                               "clientInfo": {"name": "lean-agent", "version": "0.3"}})
        send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        tools, cursor, mid = [], None, 2
        while True:
            res = call(mid, "tools/list", {"cursor": cursor} if cursor else {})
            tools += res.get("tools") or []
            cursor, mid = res.get("nextCursor"), mid + 1
            if not cursor:
                return tools
    except (BrokenPipeError, OSError) as exc:
        raise ProbeError(f"server exited: {exc}")
    finally:
        proc.kill()


def parse_specs(specs):
    """['tickets:get_ticket,create_ticket', 'github'] -> [('tickets', ['get_ticket', 'create_ticket']), ('github', None)]"""
    out = []
    for spec in specs or []:
        name, _, tools = spec.partition(":")
        out.append((name.strip(), [t.strip() for t in tools.split(",") if t.strip()] or None))
    return out


def write_config(path, servers):
    """Write an --mcp-config file readable only by the owner (configs often carry tokens)."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump({"mcpServers": servers}, fh)


def transcript_for(workdir, session_id):
    cfg = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    for d in dict.fromkeys([workdir, os.path.realpath(workdir)]):
        path = os.path.join(cfg, "projects", re.sub(r"[^A-Za-z0-9]", "-", d), session_id + ".jsonl")
        if os.path.isfile(path):
            return path
    return None


def count_mcp_calls(workdir, session_id, since_utc):
    """MCP tool calls a worker made after `since_utc` (ISO), read from its transcript.

    The transcript format is internal to Claude Code; on any surprise this returns {}.
    """
    path = session_id and transcript_for(workdir, session_id)
    counts, seen = {}, set()
    if not path:
        return counts
    try:
        with open(path) as fh:
            for line in fh:
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if entry.get("type") != "assistant" or (entry.get("timestamp") or "") < since_utc:
                    continue
                for block in (entry.get("message") or {}).get("content") or []:
                    if (isinstance(block, dict) and block.get("type") == "tool_use"
                            and str(block.get("name", "")).startswith("mcp__") and block.get("id") not in seen):
                        seen.add(block.get("id"))
                        counts[block["name"]] = counts.get(block["name"], 0) + 1
    except OSError:
        return {}
    return counts
