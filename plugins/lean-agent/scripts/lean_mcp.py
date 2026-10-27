"""MCP support for lean-agent workers: find configured servers, measure their tools, build per-run configs.

Workers normally run in --safe-mode, which turns MCP off. A run that asks for MCP
servers uses `--setting-sources ""` + `--strict-mcp-config` instead: the same
isolation (no user/project settings, CLAUDE.md, plugins or hooks), plus exactly the
servers and tools the orchestrator picked.
"""
import glob
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


def config_dir():
    return os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")


def plugin_switches(project_path=None):
    """{plugin id (name@marketplace): on?} from user, project and local settings (later files win)."""
    files = [os.path.join(config_dir(), "settings.json")]
    if project_path:
        files += [os.path.join(project_path, ".claude", f) for f in ("settings.json", "settings.local.json")]
    state = {}
    for f in files:
        for pid, on in (_load(f).get("enabledPlugins") or {}).items():
            state[pid] = bool(on)
    return state


def enabled_plugins(project_path=None):
    return {pid for pid, on in plugin_switches(project_path).items() if on}


def settings_env():
    """The `env` block of the user's settings: Claude Code puts it in its environment, so ${VAR} in a
    plugin's config sees it too (it wins over the shell's value)."""
    return {k: str(v) for k, v in (_load(os.path.join(config_dir(), "settings.json")).get("env") or {}).items()}


def installed_plugins(project_path=None):
    """[(plugin id, install path)] from Claude Code's installed_plugins.json (format 1 or 2)."""
    data = _load(os.path.join(config_dir(), "plugins", "installed_plugins.json")).get("plugins") or {}
    out = []
    for pid, recs in data.items():
        for rec in recs if isinstance(recs, list) else [recs]:
            if not isinstance(rec, dict) or not rec.get("installPath"):
                continue
            where = rec.get("projectPath")
            if where and (not project_path or os.path.realpath(where) != os.path.realpath(project_path)):
                continue  # installed for another project
            out.append((pid, rec["installPath"]))
            break
    return out


def synced_plugins():
    """[(name@synced, path)] for plugins synced from claude.ai (plugins/synced/<bucket>/<dir>). Claude Code
    loads them under the marketplace name "synced", so that's their id in enabledPlugins."""
    out = []
    for manifest in sorted(glob.glob(os.path.join(config_dir(), "plugins", "synced", "*", "manifest.json"))):
        bucket = os.path.dirname(manifest)
        for rec in _load(manifest).get("plugins") or []:
            path = os.path.join(bucket, str(rec.get("name") or ""))
            if not rec.get("name") or not os.path.isdir(path):
                continue
            name = _load(os.path.join(path, ".claude-plugin", "plugin.json")).get("name") or rec["name"]
            out.append((f"{name}@synced", path))
    return out


def plugin_options(pid, manifest):
    """A plugin's option values: its userConfig defaults, then pluginConfigs.<id>.options in user settings.
    Sensitive options live in Claude Code's credentials store and aren't readable here."""
    opts = {k: v.get("default") for k, v in (manifest.get("userConfig") or {}).items()
            if isinstance(v, dict) and v.get("default") is not None}
    conf = (_load(os.path.join(config_dir(), "settings.json")).get("pluginConfigs") or {}).get(pid) or {}
    opts.update(conf.get("options") or {})
    return opts


def lean_file(name):
    return os.path.join(os.path.expanduser(os.environ.get("LEAN_AGENT_HOME") or "~/.lean-agent"), name)


_ENV_CACHE = {}


def env_from_command(name):
    """A variable's value set with `lean-agent mcp env NAME VALUE`, or from the command saved with
    `lean-agent mcp env NAME --command ...` (e.g. `gh auth token`), run when needed and kept in memory only;
    None if there's neither or the command failed."""
    rec = _load(lean_file("mcp-env.json")).get(name) or {}
    if rec.get("value") is not None:
        return str(rec["value"])
    cmd = rec.get("command")
    if not cmd:
        return None
    if name not in _ENV_CACHE:
        try:
            p = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL)
            _ENV_CACHE[name] = p.stdout.strip() if p.returncode == 0 and p.stdout.strip() else None
        except (OSError, subprocess.TimeoutExpired):
            _ENV_CACHE[name] = None
    return _ENV_CACHE[name]


def _expand(value, root, data, options=None, missing=None, env=None):
    """${CLAUDE_PLUGIN_ROOT}, ${CLAUDE_PLUGIN_DATA}, ${user_config.x}, ${VAR} and ${VAR:-default} in a plugin's
    server config, as Claude Code does; names it can't fill go into `missing` ("env:VAR" for variables)."""
    env = env if env is not None else dict(os.environ, **settings_env())
    if isinstance(value, str):
        value = value.replace("${CLAUDE_PLUGIN_ROOT}", root).replace("${CLAUDE_PLUGIN_DATA}", data)

        def opt(m):
            if (options or {}).get(m.group(1)) is not None:
                return str(options[m.group(1)])
            if missing is not None:
                missing.append(m.group(1))
            return m.group(0)
        value = re.sub(r"\$\{user_config\.([^}]+)\}", opt, value)

        def var(m):
            if m.group(2) is not None:  # ${VAR:-default}: the default when unset or empty
                return env.get(m.group(1)) or env_from_command(m.group(1)) or m.group(2)
            if m.group(1) in env:
                return env[m.group(1)]
            from_cmd = env_from_command(m.group(1))
            if from_cmd is not None:
                return from_cmd
            if missing is not None:
                missing.append("env:" + m.group(1))
            return m.group(0)
        return re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}", var, value)
    if isinstance(value, list):
        return [_expand(v, root, data, options, missing, env) for v in value]
    if isinstance(value, dict):
        return {k: _expand(v, root, data, options, missing, env) for k, v in value.items()}
    return value


def plugin_servers(project_path=None):
    """MCP servers that enabled Claude Code plugins provide, named like Claude Code does: plugin:<plugin>:<server>.

    The config is kept as the plugin wrote it (only variables expanded): Claude Code keys a server's stored
    OAuth login by its name plus type, url and headers, so a worker given the same name and config reuses it."""
    switches = plugin_switches(project_path)
    copies = {}  # server name -> [entry, ...]: the installed copy first, then synced ones
    candidates = [(pid, root, switches.get(pid, False), "installed") for pid, root in installed_plugins(project_path)]
    candidates += [(pid, root, switches.get(pid, True), "synced") for pid, root in synced_plugins()]  # on by default
    for pid, root, on, kind in candidates:
        if not on:
            continue
        manifest = _load(os.path.join(root, ".claude-plugin", "plugin.json"))
        name = manifest.get("name") or pid.split("@")[0]
        decl = manifest.get("mcpServers", "./.mcp.json")
        mapping = {}
        for item in decl if isinstance(decl, list) else [decl]:
            if isinstance(item, str):
                item = _load(os.path.join(root, item))
            if isinstance(item, dict):
                item = item.get("mcpServers", item)
                mapping.update({k: v for k, v in item.items() if isinstance(v, dict)})
        data = os.path.join(config_dir(), "plugins", "data", re.sub(r"[^A-Za-z0-9_-]", "-", pid))
        options = plugin_options(pid, manifest)
        for server, raw in mapping.items():
            missing = []
            cfg = _expand(raw, root, data, options, missing)
            if "command" in cfg and options:  # stdio servers also get the options as env vars
                env = dict(cfg.get("env") or {})
                for k, v in options.items():
                    env.setdefault("CLAUDE_PLUGIN_OPTION_" + re.sub(r"[^A-Za-z0-9]", "_", k).upper(), str(v))
                cfg = dict(cfg, env=env)
            copies.setdefault(f"plugin:{name}:{server}", []).append({
                "config": cfg, "raw": raw, "source": "plugin", "plugin": pid, "copy": kind, "path": root,
                "alias": name if len(mapping) == 1 else f"{name}-{server}", "missing_options": sorted(set(missing))})
    seen = load_claude_view()
    fixes = _load(lean_file("mcp-overrides.json"))
    found = {}
    for full, entries in copies.items():
        for e in entries:  # corrections doctor learned from `claude mcp get` (type and url only, never secrets)
            fix = fixes.get(full) or {}
            if fix and fix.get("from") == server_target(e["config"]):
                e["config"] = {**e["config"], **{k: v for k, v in fix.items() if k in ("type", "url")}}
        # A copy still holding the plugin's setup placeholder can't work; of the rest, the copy Claude Code
        # itself uses when `claude mcp list` has been seen (doctor records it), else the installed one,
        # which Claude Code prefers over a synced duplicate.
        target = (seen.get(full) or {}).get("target")
        usable = [e for e in entries if not placeholder_host(e["config"])] or entries
        pick = next((e for e in usable if target and server_target(e["config"]) == target), usable[0])
        if len(entries) > 1:
            pick = dict(pick, other_copies=[e["path"] for e in entries if e is not pick],
                        unset_copies=[e["path"] for e in entries if placeholder_host(e["config"])],
                        copies_differ=len({json.dumps(e["config"], sort_keys=True) for e in entries}) > 1)
        found[full] = pick
    return found


def placeholder_host(cfg):
    """The host of a URL that can't be real (no dot, not localhost or an address), e.g. a plugin's
    `${DOMAIN:-not-setup}` default before its setup ran; '' when the URL looks usable."""
    m = re.match(r"^[a-z][a-z0-9+.-]*://(?:[^@/]*@)?([^/:?#]+)", str(cfg.get("url") or ""), re.I)
    host = m.group(1).lower() if m else ""
    if not host or "." in host or host == "localhost" or ":" in host or "${" in host:
        return ""
    return host


def config_problems(cfg):
    """What's visibly wrong with a server config before anything connects: a placeholder host, a variable
    left unexpanded, a header with no value or token, a line break in a header."""
    out = []
    host = placeholder_host(cfg)
    if host:
        out.append(f"URL host {host!r} is a placeholder: this plugin copy isn't set up")
    for where, text in [("URL", str(cfg.get("url") or ""))] + [
            (f"header {k}", str(v)) for k, v in (cfg.get("headers") or {}).items()]:
        left = re.findall(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", text)
        if left:
            out.append(f"{where} needs {', '.join(left)}, which isn't set")
        elif where.startswith("header") and re.search(r"[\r\n]", text):
            out.append(f"{where} contains a line break (a token with a trailing newline?)")
        elif where.lower() == "header authorization" and re.fullmatch(r"\s*(Bearer|Basic|token)?\s*", text, re.I):
            out.append(f"{where} has no token (its variable is empty)")
    return out


def http_reason(cfg, timeout=8):
    """Why an http server refuses a connection, from one MCP initialize request with its headers: '' if it
    answers normally or asks for a sign-in (the stored login handles that), else e.g. 'host not found' or
    'HTTP 400: malformed Authorization header'."""
    import urllib.error
    import urllib.request
    url = cfg.get("url")
    if not url or cfg.get("type") not in ("http", "sse", None):
        return ""
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": PROTOCOL_VERSION, "capabilities": {}, "clientInfo": {"name": "lean-agent", "version": "1"}}})
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
               **{k: str(v) for k, v in (cfg.get("headers") or {}).items() if v not in ("", None)}}
    try:
        req = urllib.request.Request(url, data=body.encode(), headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=timeout):
            return ""
    except urllib.error.HTTPError as e:
        if e.code == 401 and "www-authenticate" in {k.lower() for k in e.headers.keys()}:
            return ""
        try:
            text = e.read(400).decode("utf-8", "replace")
        except OSError:
            text = ""
        try:
            j = json.loads(text)
            text = str(j.get("message") or j.get("error_description") or j.get("error") or text)
        except ValueError:
            pass
        first = " ".join(text.split())[:160]
        return f"HTTP {e.code}" + (f": {first}" if first else "")
    except urllib.error.URLError as e:
        r = str(getattr(e, "reason", e))
        return "host not found (no DNS entry)" if re.search(r"Name or service not known|nodename nor servname|"
                                                             r"getaddrinfo|No address", r) else r[:160]
    except (OSError, ValueError) as e:
        return str(e)[:160]


def server_target(cfg):
    """What `claude mcp list` prints for a server: its URL, or its command line."""
    return cfg.get("url") or " ".join([str(cfg.get("command", ""))] + [str(x) for x in cfg.get("args") or []]).strip()


def claude_view_path():
    return os.path.join(os.path.expanduser(os.environ.get("LEAN_AGENT_HOME") or "~/.lean-agent"), "claude-mcp-view.json")


def load_claude_view():
    return _load(claude_view_path())


def save_claude_view(view):
    """Remember what `claude mcp list` showed, so discovery picks the same plugin copy as Claude Code."""
    path = claude_view_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as fh:
            json.dump({k: {"status": st, "target": t, "seen": time.strftime("%Y-%m-%dT%H:%M:%S")}
                       for k, (st, t) in view.items()}, fh, indent=1)
    except OSError:
        pass


def claude_mcp_list(timeout=90):
    """{server name: (status, target)} from `claude mcp list`, which connects every server the way the
    user's own sessions do; {} if it can't run. Status: connected, needs-auth, failed or the raw text."""
    claude = os.environ.get("LEAN_AGENT_CLAUDE") or "claude"
    try:
        out = subprocess.run([claude, "mcp", "list"], capture_output=True, text=True, timeout=timeout,
                             stdin=subprocess.DEVNULL).stdout
    except (OSError, subprocess.TimeoutExpired):
        return {}
    found = {}
    for line in out.splitlines():
        m = re.match(r"^(\S+?): (.*) - (.+)$", line.strip())
        if not m:
            continue
        raw = m.group(3).lower()
        status = ("connected" if "connected" in raw else "needs-auth" if "auth" in raw
                  else "failed" if "fail" in raw else raw.strip())
        found[m.group(1)] = (status, re.sub(r"\s*\((HTTP|SSE|stdio)\)$", "", m.group(2), flags=re.I).strip())
    if found:
        save_claude_view(found)
    return found


def claude_mcp_get(name, timeout=60):
    """Claude Code's own view of one server ({"type", "url", "headers"}) from `claude mcp get`; {} if unknown."""
    claude = os.environ.get("LEAN_AGENT_CLAUDE") or "claude"
    try:
        out = subprocess.run([claude, "mcp", "get", name], capture_output=True, text=True, timeout=timeout,
                             stdin=subprocess.DEVNULL).stdout
    except (OSError, subprocess.TimeoutExpired):
        return {}
    cfg, in_headers = {}, False
    for line in out.splitlines():
        m = re.match(r"^\s{2}(Type|URL|Command|Args|Headers):\s?(.*)$", line)
        if m:
            in_headers = m.group(1) == "Headers"
            if m.group(1) in ("Type", "URL"):
                cfg[m.group(1).lower()] = m.group(2).strip()
            elif in_headers:
                cfg["headers"] = {}
            continue
        h = re.match(r"^\s{4}([^:\s][^:]*):\s?(.*)$", line)
        if in_headers and h:
            cfg["headers"][h.group(1)] = h.group(2).strip()
        elif not line.startswith("    "):
            in_headers = False
    return cfg


def resolve_name(name, servers):
    """A configured server name, or a plugin server's short alias; None if neither."""
    if name in servers:
        return name
    hits = [n for n, v in servers.items() if v.get("alias") == name]
    return hits[0] if len(hits) == 1 else None


def display_names(servers):
    """{full name: alias or None}: an alias is shown only when no configured server has that name."""
    return {n: (v.get("alias") if v.get("alias") and v["alias"] not in servers else None) for n, v in servers.items()}


def discover(project_path=None):
    """Configured MCP servers as {name: {"config": {...}, "source": str}}.

    Later sources win, matching Claude Code's precedence (local > project > user);
    Claude Desktop chat-app servers rank lowest. Plugin servers have their own names.
    """
    servers = {}

    def add(source, mapping):
        for name, cfg in (mapping or {}).items():
            if isinstance(cfg, dict):
                servers[name] = {"config": cfg, "source": source}

    servers.update(plugin_servers(project_path))
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


_AUTH_ENV = re.compile(r"(^|_)(PAT|TOKEN|API_?KEY|SECRET|AZURE|AZUREDEVOPS|ADO)(_|$)", re.I)
_NOT_FOR_SERVERS = ("ANTHROPIC_", "CLAUDE", "LEAN_AGENT")  # the worker's own credentials never go to a server
UNAUTH = re.compile(r"anonymous|not authori[sz]ed|unauthori[sz]ed|\b401\b|\b403\b|authentication required|access denied", re.I)


SAFE_ENV = ("PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT", "APPDATA",
            "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PROGRAMFILES", "TEMP", "TMP", "COMSPEC", "PATHEXT",
            "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS")


def is_auth_env(name):
    return bool(_AUTH_ENV.search(name)) and not name.upper().startswith(_NOT_FOR_SERVERS)


_ALIASES = {"devops": ("ADO",)}  # short prefixes a server's own tooling is known to use


def server_terms(name):
    """The identifier tokens of a server key: 'azure-devops' -> ['azure', 'devops']."""
    return [t for t in re.split(r"[^a-z0-9]+", str(name or "").lower()) if len(t) >= 2 and t not in ("mcp", "server")]


def env_belongs_to(var, name):
    """Whether a shell variable is the server's own: its name carries all the server's identifier tokens
    (AZURE_DEVOPS_PAT, AZUREDEVOPS_PAT for 'azure-devops'), or a known short prefix of it (ADO_*)."""
    terms = server_terms(name)
    if not terms or var.upper().startswith(_NOT_FOR_SERVERS):
        return False
    parts = var.lower().split("_")
    if all(t in parts for t in terms) or "".join(terms) in parts:
        return True
    return any(var.upper().split("_")[0] == a for t in terms for a in _ALIASES.get(t, ()))


def with_auth_env(cfg, env=None, name=None):
    """A stdio server's config plus the variables it needs for auth. Claude Code starts an MCP server with only a
    small safe environment (HOME, PATH, ...) plus the config's own env block, so a token that lives in the user's
    shell never reaches it. Copied into that server's env block only: variables its own config names with no
    value, and shell variables whose name carries the server's own identifier tokens (see env_belongs_to). Other
    servers never get them. The config itself is left as it was."""
    if server_type(cfg) != "stdio":
        return cfg
    env = os.environ if env is None else env
    block = dict(cfg.get("env") or {})
    for k, v in list(block.items()):
        if v in (None, "") and (env.get(k) or env_from_command(k)):
            block[k] = env.get(k) or env_from_command(k)
    for k, v in env.items():
        if k not in block and v and name and env_belongs_to(k, name):
            block[k] = v
    return dict(cfg, env=block) if block != (cfg.get("env") or {}) else cfg


def auth_fix(name, cfg):
    """What to do when a server runs unauthenticated in a worker."""
    text = " ".join([str(cfg.get("command") or "")] + [str(x) for x in cfg.get("args") or []] + [name]).lower()
    fix = (f"A worker cannot open a browser, so a server that logs in interactively runs anonymous. Give {name} a "
           "token instead: put it in the server's env block (or export it, then `lean-agent mcp env VAR --command "
           "\"<prints it>\"`), or switch the server to its env/CLI-login mode if it has one")
    if "devops" in text:
        fix += " (for this server: add `-a azcli` after `az login`, or `-a env` with a PAT in its env block, to its args if your version supports it; see its README)"
    return fix + "."


def auth_state(name, cfg):
    """'' or a doctor/check line when the server probably depends on a login a worker can't do."""
    if server_type(cfg) != "stdio":
        return ""
    served = with_auth_env(cfg, name=name)
    if any(is_auth_env(k) for k in (served.get("env") or {})):
        return ""
    args = [str(x) for x in cfg.get("args") or []]
    if any(x in ("-a", "--authentication", "--auth") or x.startswith("--auth") for x in args):
        return ""
    return f"{name} has no token in its env and may log in interactively; workers can't. " + auth_fix(name, cfg)


class _Session:
    """A stdio server started the way a worker's Claude Code would, spoken to directly."""

    def __init__(self, cfg, timeout, name=None):
        env = {k: v for k, v in os.environ.items() if k in SAFE_ENV}  # what Claude Code gives a stdio server
        env.update({k: os.path.expandvars(str(v)) for k, v in (with_auth_env(cfg, name=name).get("env") or {}).items()})
        cmd = [os.path.expandvars(cfg["command"])] + [os.path.expandvars(str(x)) for x in cfg.get("args") or []]
        try:
            self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                         text=True, env=env, cwd=cfg.get("cwd") or None)
        except OSError as exc:
            raise ProbeError(f"could not start {cmd[0]}: {exc}")
        self.lines = queue.Queue()
        threading.Thread(target=lambda: [self.lines.put(l) for l in self.proc.stdout], daemon=True).start()
        self.deadline = time.time() + timeout
        self.mid = 0

    def send(self, msg):
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()

    def call(self, method, params):
        self.mid += 1
        mid = self.mid
        self.send({"jsonrpc": "2.0", "id": mid, "method": method, "params": params})
        while True:
            left = self.deadline - time.time()
            if left <= 0:
                raise ProbeError(f"timed out waiting for {method}")
            try:
                line = self.lines.get(timeout=left)
            except queue.Empty:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if isinstance(msg, dict) and msg.get("id") == mid:
                if "error" in msg:
                    raise ProbeError(f"{method}: {msg['error'].get('message')}")
                return msg.get("result") or {}

    def start(self):
        self.call("initialize", {"protocolVersion": PROTOCOL_VERSION, "capabilities": {},
                                 "clientInfo": {"name": "lean-agent", "version": "0.3"}})
        self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def tools(self):
        tools, cursor = [], None
        while True:
            res = self.call("tools/list", {"cursor": cursor} if cursor else {})
            tools += res.get("tools") or []
            cursor = res.get("nextCursor")
            if not cursor:
                return tools

    def close(self):
        self.proc.kill()


def probe(cfg, timeout=20.0, name=None):
    """List a stdio server's tools by speaking MCP to it directly (no model call)."""
    if server_type(cfg) != "stdio":
        raise ProbeError("only stdio servers can be probed directly; try `lean-agent mcp tools <server> --measure`")
    sess = _Session(cfg, timeout, name)
    try:
        sess.start()
        return sess.tools()
    except (BrokenPipeError, OSError) as exc:
        raise ProbeError(f"server exited: {exc}")
    finally:
        sess.close()


def pick_check_tool(tools):
    """The first tool that looks cheap and read-only (list/get/whoami/project), preferring one with no required arguments."""
    named = [t for t in tools if re.search(r"list|get|whoami|project", t.get("name") or "", re.I)]
    free = [t for t in named if not (t.get("inputSchema") or {}).get("required")]
    return (free or named or [None])[0]


def check(name, cfg, timeout=30.0):
    """Start the server as a worker would and make one cheap read-only call.
    Returns (status, detail): ok | unauthorized | failed | skipped."""
    if server_type(cfg) != "stdio":
        return "skipped", "only stdio servers can be checked directly"
    try:
        sess = _Session(cfg, timeout, name)
    except ProbeError as exc:
        return "failed", str(exc)
    try:
        sess.start()
        tools = sess.tools()
        tool = pick_check_tool(tools)
        if not tool:
            return "ok", f"{len(tools)} tools listed (no read-only tool to call)"
        res = sess.call("tools/call", {"name": tool["name"], "arguments": {}})
        text = " ".join(str(c.get("text") or "") for c in res.get("content") or [] if isinstance(c, dict))
        if res.get("isError") or UNAUTH.search(text):
            if UNAUTH.search(text):
                return "unauthorized", f"{tool['name']}: {text[:160]}"
            if re.search(r"required|invalid|missing|validation", text, re.I):
                return "ok", f"{tool['name']} reached the server (it wants arguments)"
            return "failed", f"{tool['name']}: {text[:160]}"
        return "ok", f"{tool['name']} answered"
    except ProbeError as exc:
        return ("unauthorized" if UNAUTH.search(str(exc)) else "failed"), str(exc)[:200]
    except (BrokenPipeError, OSError) as exc:
        return "failed", f"server exited: {exc}"
    finally:
        sess.close()


def parse_specs(specs):
    """['tickets:get_ticket,create_ticket', 'github'] -> [('tickets', ['get_ticket', 'create_ticket']), ('github', None)]"""
    out = []
    for spec in specs or []:
        if spec.startswith("plugin:"):  # plugin:<plugin>:<server>[:tools]
            parts = spec.split(":", 3)
            name, tools = ":".join(parts[:3]), (parts[3] if len(parts) > 3 else "")
            out.append((name.strip(), [t.strip() for t in tools.split(",") if t.strip()] or None))
            continue
        name, _, tools = spec.partition(":")
        name = name.strip()
        # "server:a,server:b" means "server:a,b": a repeated server prefix is the same server's next preset/tool
        wanted = [t.strip()[len(name) + 1:] if t.strip().startswith(name + ":") else t.strip()
                  for t in tools.split(",") if t.strip()]
        out.append((name, wanted or None))
    return out


def write_config(path, servers):
    """Write an --mcp-config file readable only by the owner (configs often carry tokens)."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump({"mcpServers": servers}, fh)


def transcript_for(workdir, session_id):
    cfg = config_dir()
    for d in dict.fromkeys([workdir, os.path.realpath(workdir)]):
        path = os.path.join(cfg, "projects", re.sub(r"[^A-Za-z0-9]", "-", d), session_id + ".jsonl")
        if os.path.isfile(path):
            return path
    return None


def mcp_call_sequence(workdir, session_id, since_utc):
    """MCP tool names a worker called after `since_utc` (ISO), in order, read from its transcript.

    The transcript format is internal to Claude Code; on any surprise this returns []."""
    path = session_id and transcript_for(workdir, session_id)
    seq, seen = [], set()
    if not path:
        return seq
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
                        seq.append(block["name"])
    except OSError:
        return []
    return seq


USAGE_FIELDS = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")


def transcript_usage(workdir, session_id, since_utc):
    """Token usage of a worker's API calls after `since_utc`, summed from its transcript (one count per message
    id); {} when the transcript isn't there."""
    path = session_id and transcript_for(workdir, session_id)
    if not path:
        return {}
    totals, seen = dict.fromkeys(USAGE_FIELDS, 0), set()
    try:
        with open(path) as fh:
            for line in fh:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                msg = e.get("message") if isinstance(e, dict) else None
                if e.get("type") != "assistant" or not isinstance(msg, dict) or (e.get("timestamp") or "") < since_utc:
                    continue
                mid = msg.get("id") or e.get("uuid")
                if mid in seen or not isinstance(msg.get("usage"), dict):
                    continue
                seen.add(mid)
                for k in USAGE_FIELDS:
                    v = msg["usage"].get(k) or 0
                    totals[k] += int(v) if isinstance(v, (int, float)) else 0
    except OSError:
        return {}
    return totals if any(totals.values()) else {}


def count_mcp_calls(workdir, session_id, since_utc):
    """{tool: calls} for the MCP tools a worker called after `since_utc`."""
    counts = {}
    for name in mcp_call_sequence(workdir, session_id, since_utc):
        counts[name] = counts.get(name, 0) + 1
    return counts
