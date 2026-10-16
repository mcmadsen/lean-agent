#!/usr/bin/env python3
"""lean-agent: run Claude Code worker agents on as few tokens as possible.

An orchestrator session (started with `lean-agent up`) lives in its own folder,
so it never loads your projects' CLAUDE.md, skills or plugins. It delegates
work with `lean-agent run`, which starts an isolated headless worker that gets
only the context cards and tools the orchestrator picked. Workers report back
which context they used, and the context library improves from that.
"""
import argparse
import contextlib
import datetime
import glob
import hashlib
import json
import os
import re
import subprocess
import sys
import uuid

try:
    import fcntl
except ImportError:  # Windows: no locking, parallel runs may lose a stats update
    fcntl = None

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import usage  # noqa: E402
import lean_mcp  # noqa: E402
import lean_memory  # noqa: E402

PLUGIN_ROOT = os.path.dirname(HERE)
REPO = "mcmadsen/lean-agent"
PLUGIN = "lean-agent@lean-agent"
TEMPLATE_MARK = "<!-- lean-agent orchestrator template v"
TEMPLATE_VERSION = 4

WORKER_TOOLS = "Bash,Read,Edit,Write,Glob,Grep"
READONLY_TOOLS = "Read,Glob,Grep"
SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "dist", "build", "target", "__pycache__", ".next", "vendor"}
STOPWORDS = set("the and for with that this from into have has are was were will would should could "
                "you your our their not but all any can use using used make add fix get set run".split())

WORKER_PROTOCOL = """\
You are a lean-agent worker. Another agent gave you one task; it cannot see your
reasoning, only your final reply.

Project: {project}
Your working directory is NOT the project. Use absolute paths, and run shell
commands as `cd {project} && <command>`.

Work frugally: Grep/Glob before Read, read line ranges rather than whole files,
use quiet command flags (-q, --silent, | tail -n 40), no narration. Read other
project files only when the task needs them.

End your reply with a short result (what you did, files changed, anything
unresolved), then one final line exactly like this:
LEAN-FEEDBACK {{"status": "done|partial|failed", "used": ["card-id"], "unneeded": ["card-id"], "missing": "context you had to discover that should have been given up front, or empty", "remember": []}}

"remember" is shared memory for future agents. Usually leave it empty. Add an item
only for a durable fact that can't be derived from the code or git history, such as a
user correction, a decision, or where external info lives:
{{"type": "feedback|project|reference|user", "text": "one or two sentences"}}
"""


# ---------------------------------------------------------------- helpers

def home(*parts):
    return os.path.join(os.path.expanduser(os.environ.get("LEAN_AGENT_HOME") or "~/.lean-agent"), *parts)


def env_num(name, default, cast=int):
    try:
        return cast(os.environ.get(name) or default)
    except ValueError:
        return cast(default)


def die(msg, code=1):
    print(f"lean-agent: {msg}", file=sys.stderr)
    sys.exit(code)


def load_json(path, default):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w") as fh:
        json.dump(data, fh, indent=1)
    os.replace(tmp, path)


def append_jsonl(path, entry):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a") as fh:
        fh.write(json.dumps(entry) + "\n")


def read_jsonl(path):
    try:
        with open(path) as fh:
            for line in fh:
                try:
                    yield json.loads(line)
                except ValueError:
                    pass
    except OSError:
        return


def read_text(path):
    with open(path, encoding="utf-8", errors="replace") as fh:
        return fh.read()


def est_tokens(text):
    return (len(text) + 3) // 4


def slugify(text, limit=48):
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    if len(slug) > limit:  # cut at a word boundary
        cut = slug[:limit + 1].rfind("-")
        slug = slug[:cut if cut > limit // 2 else limit]
    return slug.strip("-") or "card"


def now_iso():
    return datetime.datetime.now().isoformat(timespec="seconds")


def words(text):
    return {w for w in re.findall(r"[a-z][a-z0-9_]{2,}", text.lower()) if w not in STOPWORDS}


# ---------------------------------------------------------------- projects & library

def projects():
    return load_json(home("projects.json"), {})


def project_slug(path):
    name = slugify(os.path.basename(path), 24) or "project"
    return f"{name}-{hashlib.sha1(path.encode()).hexdigest()[:6]}"


def resolve_project(ref):
    projs = projects()
    if ref in projs:
        return ref, projs[ref]["path"]
    hits = [s for s, v in projs.items() if os.path.basename(v["path"]) == ref or s.startswith(ref + "-")]
    if len(hits) == 1:
        return hits[0], projs[hits[0]]["path"]
    path = os.path.abspath(os.path.expanduser(ref))
    if os.path.isdir(path):
        for s, v in projs.items():
            if v["path"] == path:
                return s, path
        return learn(path, quiet=True), path
    die(f"unknown project {ref!r}; register it with: lean-agent learn <path>")


def library_path(slug):
    return home("library", slug, "cards.json")


@contextlib.contextmanager
def library_lock(slug):
    """Serialise read-modify-write of a project's cards across parallel lean-agent processes."""
    path = home("library", slug, ".lock")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        if fcntl:
            fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            if fcntl:
                fcntl.flock(fh, fcntl.LOCK_UN)


def load_cards(slug):
    return load_json(library_path(slug), [])


def save_cards(slug, cards):
    save_json(library_path(slug), cards)


def split_sections(text):
    """Split markdown at level-1/2 headings (outside code fences); merge tiny pieces."""
    sections, head, buf, in_code = [], "overview", [], False
    for line in text.splitlines():
        if line.strip().startswith("```"):
            in_code = not in_code
        m = None if in_code else re.match(r"^(#{1,2})\s+(.+)", line)
        if m:
            if "\n".join(buf).strip():
                sections.append([head, "\n".join(buf).strip()])
            head, buf = m.group(2).strip(), [line]
        else:
            buf.append(line)
    if "\n".join(buf).strip():
        sections.append([head, "\n".join(buf).strip()])
    def content_len(body):
        lines = body.split("\n", 1)
        rest = lines[1] if body.startswith("#") and len(lines) > 1 else ("" if body.startswith("#") else body)
        return len(rest.strip())

    merged, carry = [], None
    for h, body in sections:
        if content_len(body) == 0:  # heading with nothing under it, e.g. a bare "# Title"
            carry = body if carry is None else carry + "\n\n" + body
            continue
        if carry:
            body, carry = carry + "\n\n" + body, None
        merged.append([h, body])
    if carry:
        if merged:
            merged[-1][1] += "\n\n" + carry
        else:
            merged.append([sections[0][0], carry])
    return merged


def find_memory_files(root, max_depth=5):
    """CLAUDE.md / CLAUDE.local.md / AGENTS.md files and .claude/rules, skipping worktrees and submodules."""
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        rel = os.path.relpath(dirpath, root)
        depth = 0 if rel == "." else rel.count(os.sep) + 1
        if "CLAUDE.md" in filenames:
            found.append(("claude-md", os.path.join(dirpath, "CLAUDE.md")))
        if "CLAUDE.local.md" in filenames:
            found.append(("local-md", os.path.join(dirpath, "CLAUDE.local.md")))
        has_claude = ("CLAUDE.md" in filenames or "CLAUDE.local.md" in filenames
                      or os.path.isfile(os.path.join(dirpath, ".claude", "CLAUDE.md")))
        if "AGENTS.md" in filenames and not has_claude:  # Claude Code's default: AGENTS.md only without CLAUDE.md
            found.append(("agents-md", os.path.join(dirpath, "AGENTS.md")))
        if os.path.basename(dirpath) == ".claude":
            dirnames[:] = []  # never descend into .claude/ (worktrees, skills, settings)
            continue
        keep = []
        for d in sorted(dirnames):
            if d in SKIP_DIRS or (d.startswith(".") and d != ".claude") or depth >= max_depth:
                continue
            if os.path.isfile(os.path.join(dirpath, d, ".git")):
                continue  # git worktree or submodule: a separate checkout
            keep.append(d)
        dirnames[:] = keep
    for path in sorted(glob.glob(os.path.join(root, ".claude", "rules", "**", "*.md"), recursive=True)):
        found.append(("rule", path))
    return found


GENERIC_DIRS = {"app", "apps", "src", "web", "api", "lib", "libs", "client", "server", "frontend",
                "backend", "packages", "core", "main", "docs", "test", "tests"}


def scope_of(rel_dir, min_parts=1):
    """(title scope, id scope) for where a CLAUDE.md lives, ignoring '.claude' path parts.

    The id uses the folder name, plus parents when the name is generic (App, src, ...)
    or when min_parts asks for more to avoid a clash with another folder."""
    parts = [p for p in rel_dir.split(os.sep) if p and p not in (".", ".claude")]
    if not parts:
        return "", ""
    n = max(min_parts, 2 if slugify(parts[-1]) in GENERIC_DIRS else 1)
    return "/".join(parts[-max(n, 2):]), slugify("-".join(parts[-n:]), 28)


def parse_skill(path):
    text = read_text(path)
    meta, body = {}, text
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", text, re.S)
    if m:
        body = m.group(2)
        for line in m.group(1).splitlines():
            k, _, v = line.partition(":")
            meta[k.strip()] = v.strip().strip("\"'")
    d = os.path.dirname(path)
    extras = sorted(f for f in os.listdir(d) if f != "SKILL.md")
    if extras:
        body = body.rstrip() + f"\n\n(Supporting files in {d}: {', '.join(extras)})"
    return meta.get("name") or os.path.basename(d), meta.get("description", ""), body.strip()


def learn(path, include_user_skills=False, quiet=False, name=None):
    path = os.path.abspath(os.path.expanduser(path))
    if not os.path.isdir(path):
        die(f"not a directory: {path}")
    slug = next((s for s, v in projects().items() if v["path"] == path), None)
    if name:
        slug = slugify(name, 32)
        other = projects().get(slug)
        if other and other["path"] != path:
            die(f"project name {slug!r} is already used for {other['path']}")
    slug = slug or project_slug(path)

    fresh, ids = [], set()

    def add(kind, title, source, text, base=None):
        base = base or slugify(title)
        cid, n = base, 2
        while cid in ids:
            cid, n = f"{base}-{n}", n + 1
        ids.add(cid)
        fresh.append({"id": cid, "kind": kind, "title": title, "source": source, "text": text})

    scope_owner = {}  # id scope -> folder, so two folders never share a prefix
    for kind, f in find_memory_files(path):
        rel = os.path.relpath(f, path)
        if kind == "rule":
            scope = "rule " + os.path.splitext(os.path.basename(f))[0]
            ss = slugify(scope, 28)
        else:
            d = os.path.dirname(rel)
            n = 1
            scope, ss = scope_of(d, n)
            while ss and scope_owner.get(ss, d) != d and n < 6:
                n += 1
                scope, ss = scope_of(d, n)
            if ss:
                scope_owner[ss] = d
        for i, (head, body) in enumerate(split_sections(read_text(f))):
            title = f"{scope}: {head}" if scope else head
            hs = slugify(head, 28)
            if ss and i == 0 and (body.startswith(f"# {head}\n") or head == "overview"):
                base = ss  # a nested file's intro section is named after its folder
            else:
                base = hs if not ss or hs.startswith(ss) else f"{ss}-{hs}"
            add(kind, title, rel, body, base=base)

    skill_dirs = [os.path.join(path, ".claude", "skills")]
    if include_user_skills:
        skill_dirs.append(os.path.expanduser("~/.claude/skills"))
    for sd in skill_dirs:
        for f in sorted(glob.glob(os.path.join(sd, "*", "SKILL.md"))):
            name, desc, body = parse_skill(f)
            add("skill", f"skill {name}" + (f" - {desc}" if desc else ""), f, body, base="skill-" + slugify(name, 32))

    with library_lock(slug):
        prev_slug = next((s for s, v in projects().items() if v["path"] == path), slug)
        old = {c["id"]: c for c in load_cards(slug) or load_cards(prev_slug)}
        cards = []
        for c in fresh:
            prev = old.pop(c["id"], {})
            c.update({
                "tokens": est_tokens(c["text"]),
                "core": prev.get("core", False), "archived": prev.get("archived", False),
                "offered": prev.get("offered", 0), "used": prev.get("used", 0), "unneeded": prev.get("unneeded", 0),
                "updated": now_iso(),
            })
            cards.append(c)
        cards += [c for c in old.values() if c["kind"] in ("note", "memory")]  # survive re-learning
        save_cards(slug, cards)

    projs = projects()
    for other in [s for s, v in projs.items() if v["path"] == path and s != slug]:
        del projs[other]  # renamed with --name
    projs[slug] = {"path": path, "learned": now_iso()}
    save_json(home("projects.json"), projs)
    cards = sync_memory(slug)

    if not quiet:
        total = sum(c["tokens"] for c in cards)
        print(f"Learned {path} as '{slug}': {len(cards)} cards, ~{total:,} tokens if loaded in full.")
        print(f"Workers get only the cards you pick. List them: lean-agent cards {slug}")
    return slug


def memory_store():
    return lean_memory.store_dir(home())


def sync_memory(slug):
    """Mirror the shared memory store into a project's cards (global memories + this project's)."""
    mems = [m for m in lean_memory.read_all(memory_store()) if m["scope"] in (lean_memory.GLOBAL, slug)]
    fresh = {}
    for m in mems:
        cid = "mem-" + slugify(m["stem"], 40)
        fresh[cid] = {"id": cid, "kind": "memory", "title": f"memory {m['type']}: {m['description'] or m['name']}"[:120],
                      "source": m["file"], "text": m["body"], "tokens": est_tokens(m["body"])}
    with library_lock(slug):
        cards = load_cards(slug)
        kept = []
        for c in cards:
            if c["kind"] != "memory":
                kept.append(c)
            elif c["id"] in fresh:
                c.update(fresh.pop(c["id"]))
                kept.append(c)
        for c in fresh.values():
            c.update({"core": False, "archived": False, "offered": 0, "used": 0, "unneeded": 0, "updated": now_iso()})
            kept.append(c)
        if kept != cards or fresh:
            save_cards(slug, kept)
    return kept


def card_rate(c):
    return f"{c['used']}/{c['offered']}" if c["offered"] else "-"


# ---------------------------------------------------------------- commands: library

def cmd_learn(a):
    learn(a.path, include_user_skills=a.user_skills, name=a.name)


def cmd_projects(a):
    projs = projects()
    if not projs:
        print("No projects yet. Add one: lean-agent learn <path>")
    for slug, v in sorted(projs.items()):
        cards = [c for c in load_cards(slug) if not c.get("archived")]
        print(f"{slug:<32} {len(cards):>3} cards  {v['path']}")


def cmd_cards(a):
    slug, _ = resolve_project(a.project)
    sync_memory(slug)
    cards = [c for c in load_cards(slug) if a.all or not c.get("archived")]
    if a.filter:
        f = a.filter.lower()
        cards = [c for c in cards if f in c["id"] or f in c["title"].lower() or f in c["source"].lower()]
    if not cards:
        print("No cards match.")
        return
    w = max(len(c["id"]) for c in cards) + 2
    print(f" {'id':<{w}}{'kind':<10}{'~tok':>6}  {'used':>6}  title")
    for c in cards:
        flag = "*" if c.get("core") else ("x" if c.get("archived") else " ")
        print(f"{flag}{c['id']:<{w}}{c['kind']:<10}{c['tokens']:>6}  {card_rate(c):>6}  {c['title'][:70]}")
    print(f"{len(cards)} cards, ~{sum(c['tokens'] for c in cards):,} tokens.  * = core (always sent)   "
          "used = times a worker used it / times it was sent")


def find_card(cards, cid):
    for c in cards:
        if c["id"] == cid:
            return c
    die(f"no card {cid!r}")


def cmd_card(a):
    slug, _ = resolve_project(a.project)
    with library_lock(slug):
        _cmd_card(a)


def _cmd_card(a):
    slug, _ = resolve_project(a.project)
    cards = load_cards(slug)
    if a.action == "show":
        c = find_card(cards, a.id)
        print(f"# {c['title']}  ({c['kind']}, ~{c['tokens']} tok, used {card_rate(c)}, source {c['source']})\n")
        print(c["text"])
        return
    if a.action == "add":
        text = read_text(a.file) if a.file else (a.text or "")
        if not text.strip():
            die("card add needs --text or --file")
        existing = next((c for c in cards if c["id"] == a.id), None)
        if existing:
            existing.update(text=text.strip(), tokens=est_tokens(text), updated=now_iso(), archived=False)
            if a.title:
                existing["title"] = a.title
            if a.core:
                existing["core"] = True
        else:
            cards.append({"id": slugify(a.id), "kind": "note", "title": a.title or a.id, "source": "learned",
                          "text": text.strip(), "tokens": est_tokens(text), "core": a.core, "archived": False,
                          "offered": 0, "used": 0, "unneeded": 0, "updated": now_iso()})
        save_cards(slug, cards)
        print(f"saved card {a.id} (~{est_tokens(text)} tok)")
        return
    c = find_card(cards, a.id)
    if a.action == "rm":
        if c["kind"] == "note":
            cards.remove(c)
        else:
            c["archived"] = True
    elif a.action == "core":
        c["core"] = not a.off
    save_cards(slug, cards)
    print(f"{a.action} {a.id}: ok")


def suggest(slug, task, max_tokens):
    cards = [c for c in load_cards(slug) if not c.get("archived")]
    tw = words(task)
    picked = [c for c in cards if c.get("core")]
    budget = max_tokens - sum(c["tokens"] for c in picked)
    scored = []
    for c in cards:
        if c.get("core"):
            continue
        overlap = 3 * len(tw & words(c["title"])) + len(tw & words(c["text"]))
        if not overlap and c["kind"] == "memory" and c["title"].startswith(("memory user", "memory feedback")):
            overlap = 1  # preferences and corrections apply broadly; optimize archives the ones never used
        if overlap:
            usefulness = (c["used"] + 1) / (c["offered"] + 2)  # Laplace-smoothed hit rate
            scored.append((overlap * (0.5 + usefulness), c))
    for score, c in sorted(scored, key=lambda x: -x[0]):
        if c["tokens"] <= budget:
            picked.append(c)
            budget -= c["tokens"]
    return picked


def cmd_suggest(a):
    slug, _ = resolve_project(a.project)
    sync_memory(slug)
    picked = suggest(slug, a.task, a.max_tokens)
    if not picked:
        print("No matching cards; the worker will start with the project path only.")
        return
    for c in picked:
        print(f"{'core' if c.get('core') else 'match':<6}{c['id']:<34}~{c['tokens']:>5} tok  used {card_rate(c):>5}  {c['title'][:50]}")
    print(f"\n--cards {','.join(c['id'] for c in picked if not c.get('core'))}   (core cards are always sent)")


# ---------------------------------------------------------------- commands: runs

def ledger():
    return list(read_jsonl(home("ledger.jsonl")))


def parse_feedback(text):
    """Split the worker reply into (summary, feedback dict)."""
    fb, lines = {}, text.rstrip().splitlines()
    for i in range(len(lines) - 1, -1, -1):
        m = re.search(r"LEAN-FEEDBACK\s*(\{.*\})", lines[i])
        if m:
            try:
                fb = json.loads(m.group(1))
            except ValueError:
                fb = {}
            del lines[i]
            break
    return "\n".join(lines).strip(), fb if isinstance(fb, dict) else {}


def build_append(project, cards):
    parts = [WORKER_PROTOCOL.format(project=project)]
    if cards:
        parts.append("# Project context (selected for this task)\n")
        for c in cards:
            parts.append(f"## [{c['id']}] {c['title']}\n{c['text']}\n")
    return "\n".join(parts)


def mcp_cache():
    return load_json(home("mcp-tools.json"), {})


def server_tools(name, cfg, refresh=False):
    """Tool list for a server as {tool: ~tokens}, from cache or a direct stdio probe; None if unknown."""
    cache = mcp_cache()
    if not refresh and name in cache:
        return cache[name]["tools"]
    try:
        tools = lean_mcp.probe(cfg)
    except lean_mcp.ProbeError:
        return None
    cache[name] = {"tools": {t["name"]: lean_mcp.tool_tokens(t) for t in tools if t.get("name")},
                   "probed": now_iso(), "type": lean_mcp.server_type(cfg)}
    save_json(home("mcp-tools.json"), cache)
    return cache[name]["tools"]


def resolve_mcp(project, specs):
    """Turn --mcp specs into (servers config, allowed tool rules, disallowed tool names)."""
    available = lean_mcp.discover(project)
    servers, allowed, disallowed = {}, [], []
    for name, wanted in lean_mcp.parse_specs(specs):
        if name not in available:
            die(f"unknown MCP server {name!r}; configured: {', '.join(sorted(available)) or 'none'} "
                f"(see: lean-agent mcp list)")
        cfg = available[name]["config"]
        servers[name] = cfg
        prefix = lean_mcp.tool_prefix(name)
        if not wanted:
            allowed.append(prefix.rstrip("_"))  # mcp__server: every tool of that server
            continue
        known = server_tools(name, cfg)
        if known is not None:
            unknown = [t for t in wanted if t not in known]
            if unknown:
                die(f"{name} has no tool(s) {', '.join(unknown)}; it has: {', '.join(sorted(known))}")
            disallowed += [prefix + t for t in known if t not in wanted]
        else:
            print(f"lean-agent: tool list of {name} unknown (not stdio, or probe failed); only the chosen tools "
                  "are allowed, but the others' definitions still load", file=sys.stderr)
        allowed += [prefix + t for t in wanted]
    return servers, allowed, disallowed


def cmd_run(a):
    prev = None
    if a.resume:
        prev = next((r for r in reversed(ledger()) if r["id"] == a.resume), None)
        if not prev or not prev.get("session_id"):
            die(f"no resumable run {a.resume!r}")
    task = " ".join(a.task).strip()
    if task == "-" or (not task and a.task_file is None and not sys.stdin.isatty()):
        task = sys.stdin.read().strip()
    elif a.task_file:
        task = read_text(a.task_file).strip()
    if not task:
        die("no task given")

    model = a.model or (prev and prev["model"])
    if not model:
        die("choose a model for this worker: --model haiku|sonnet|opus (and say why with --why)")
    if not prev and not a.why:
        die("say why you chose this model and context: --why \"...\"")

    hit = usage.exhausted_window()
    if hit:
        die(usage.describe_exhausted(hit), 3)

    if prev:
        slug, project = prev["project"], prev["project_path"]
        cards, workdir, run_id = [], prev["workdir"], prev["id"]
        tools = prev.get("tools", WORKER_TOOLS)
    else:
        slug, project = resolve_project(a.project)
        sync_memory(slug)
        lib = {c["id"]: c for c in load_cards(slug)}
        wanted = [x for x in (a.cards or "").split(",") if x]
        if a.cards == "auto":
            cards = suggest(slug, task, a.max_context)
        else:
            missing = [x for x in wanted if x not in lib]
            if missing:
                die(f"unknown card(s): {', '.join(missing)} (see: lean-agent cards {slug})")
            cards = [c for c in lib.values() if c.get("core") and not c.get("archived")]
            cards += [lib[x] for x in wanted if lib[x] not in cards]
        run_id = datetime.datetime.now().strftime("%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
        workdir = home("work", run_id)
        os.makedirs(workdir, exist_ok=True)
        with open(os.path.join(workdir, "append.md"), "w") as fh:
            fh.write(build_append(project, cards))
        tools = a.tools or (READONLY_TOOLS if a.read_only else WORKER_TOOLS)

    mcp_specs = prev.get("mcp") if prev else (a.mcp or [])
    mcp_servers, mcp_allowed, mcp_disallowed = resolve_mcp(project, mcp_specs) if mcp_specs else ({}, [], [])
    mcp_path = os.path.join(workdir, "mcp.json")
    if mcp_servers:
        lean_mcp.write_config(mcp_path, mcp_servers)
        # --safe-mode disables MCP; this keeps the same isolation but admits exactly these servers
        isolation = ["--setting-sources", "", "--strict-mcp-config", "--mcp-config", mcp_path]
        if mcp_disallowed:
            isolation += ["--disallowedTools", ",".join(mcp_disallowed)]
    else:
        isolation = ["--safe-mode"]

    claude = os.environ.get("LEAN_AGENT_CLAUDE") or "claude"
    cmd = [claude, "-p", "--output-format", "json", "--model", model,
           *isolation, "--disable-slash-commands",
           "--tools", tools, "--allowedTools", ",".join([tools] + mcp_allowed),
           "--permission-mode", os.environ.get("LEAN_AGENT_WORKER_PERMISSION_MODE") or "acceptEdits",
           "--add-dir", project,
           "--append-system-prompt-file", os.path.join(workdir, "append.md"),
           "--max-turns", str(a.max_turns)]
    if a.max_usd > 0:
        cmd += ["--max-budget-usd", str(a.max_usd)]
    if prev:
        cmd += ["--resume", prev["session_id"]]

    env = dict(os.environ)
    env.pop("CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD", None)  # never pull in the project's CLAUDE.md
    env.setdefault("BASH_MAX_OUTPUT_LENGTH", os.environ.get("LEAN_AGENT_WORKER_BASH_OUTPUT") or "12000")
    env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "1"  # memory comes from lean-agent cards instead

    started = datetime.datetime.now()
    started_utc = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    try:
        proc = subprocess.run(cmd, input=task, capture_output=True, text=True, cwd=workdir, env=env,
                              timeout=env_num("LEAN_AGENT_RUN_TIMEOUT", 1800))
        raw, err = proc.stdout, proc.stderr
    except subprocess.TimeoutExpired as exc:
        raw, err = exc.stdout or "", "timed out"
        raw = raw.decode() if isinstance(raw, bytes) else raw
    except FileNotFoundError:
        die(f"'{claude}' not found on PATH")
    finally:
        if os.path.exists(mcp_path):
            os.remove(mcp_path)  # may hold tokens; rebuilt from your config on --resume
    seconds = int((datetime.datetime.now() - started).total_seconds())

    try:
        out = json.loads(raw.strip().splitlines()[-1]) if raw.strip() else {}
    except ValueError:
        out = {}
    with open(os.path.join(workdir, "result.json"), "a") as fh:
        fh.write((raw.strip() or json.dumps({"stderr": err[-4000:]})) + "\n")

    summary, fb = parse_feedback(out.get("result") or "")
    subtype = out.get("subtype") or "error"
    if subtype.startswith("error_max"):
        status = "stopped:" + subtype[len("error_"):]
    elif out.get("is_error") or not out:
        status = "error"
    else:
        status = fb.get("status") or "done"
    u = out.get("usage") or {}
    weighted = usage.weighted(u)

    # learning: card stats and missing context
    used, unneeded = set(fb.get("used") or []), set(fb.get("unneeded") or [])
    sent = {c["id"] for c in cards}
    if sent or used or unneeded:
        with library_lock(slug):
            lib = load_cards(slug)
            for c in lib:
                if c["id"] in sent:
                    c["offered"] += 1
                if c["id"] in used:
                    c["used"] += 1
                if c["id"] in unneeded:
                    c["unneeded"] += 1
            save_cards(slug, lib)
    remembered = []
    for item in fb.get("remember") or []:
        if isinstance(item, str):
            item = {"type": "project", "text": item}
        if not isinstance(item, dict) or not str(item.get("text", "")).strip():
            continue
        mtype = item.get("type") if item.get("type") in lean_memory.TYPES else "project"
        scope = lean_memory.GLOBAL if mtype in ("user", "feedback") else slug
        path = lean_memory.add(memory_store(), str(item["text"]), mtype, scope=scope, source=f"run {run_id}")
        if path:
            remembered.append(os.path.splitext(os.path.basename(path))[0])
    missing_note = (fb.get("missing") or "").strip()
    if missing_note:
        append_jsonl(home("library", slug, "missing.jsonl"),
                     {"ts": now_iso(), "run": run_id, "task": task[:160], "missing": missing_note})

    entry = {
        "id": run_id, "ts": now_iso(), "project": slug, "project_path": project, "workdir": workdir,
        "model": model, "why": a.why or (prev and "resume"), "cards": sorted(sent), "tools": tools,
        "status": status, "turns": out.get("num_turns"), "seconds": seconds,
        "usage": {k: u.get(k, 0) for k in usage.FIELDS}, "weighted": weighted,
        "units": int(usage.units(u, model)),
        "cost_usd": out.get("total_cost_usd"), "session_id": out.get("session_id") or (prev and prev["session_id"]),
        "resumed": bool(prev), "task": task[:300], "missing": missing_note,
        "mcp": mcp_specs, "mcp_calls": lean_mcp.count_mcp_calls(workdir, out.get("session_id"), started_utc)
        if mcp_specs else {},
    }
    append_jsonl(home("ledger.jsonl"), entry)

    cost = f"${entry['cost_usd']:.2f}" if isinstance(entry["cost_usd"], (int, float)) else "$?"
    print(f"run {run_id} · {model} · {status} · {entry['turns'] or '?'} turns · {weighted:,} weighted tok · {cost} · {seconds}s")
    limit = env_num("LEAN_AGENT_RESULT_CHARS", 2500)
    if summary:
        print(summary if len(summary) <= limit else summary[:limit] + f"\n… [{len(summary) - limit} chars more in {workdir}/result.json]")
    elif status == "error":
        print((err or raw)[-1500:].strip())
    if fb:
        print(f"feedback: used={sorted(used)} unneeded={sorted(unneeded)}" + (f" missing={missing_note!r}" if missing_note else ""))
    if remembered:
        print(f"remembered: {', '.join(remembered)}")
    if mcp_specs:
        calls = entry["mcp_calls"]
        print("mcp: " + (", ".join(f"{k} x{v}" for k, v in sorted(calls.items())) or "no MCP tool calls"))
    print(f"resume: lean-agent run --resume {run_id} \"<follow-up>\"")
    return 0 if status in ("done", "partial") else 1


def cmd_mcp(a):
    project = resolve_project(a.project)[1] if getattr(a, "project", None) else None
    servers = lean_mcp.discover(project)
    if a.action == "list":
        if not servers:
            print("No MCP servers configured (looked in ~/.claude.json, <project>/.mcp.json, Claude Desktop config).")
            return
        cache = mcp_cache()
        print(f"{'server':<24}{'type':<7}{'source':<9}{'tools':>6}{'~tok':>8}")
        for name, info in sorted(servers.items()):
            tools = cache.get(name, {}).get("tools")
            if tools is None and a.probe:
                tools = server_tools(name, info["config"], refresh=True)
            n, tok = (len(tools), f"{sum(tools.values()):,}") if tools is not None else ("?", "?")
            print(f"{name:<24}{lean_mcp.server_type(info['config']):<7}{info['source']:<9}{n:>6}{tok:>8}")
        print("~tok = tool definitions a worker carries on every turn if given the whole server."
              + ("" if a.probe else "  Fill in ? with --probe (stdio servers)."))
        return
    if a.server not in servers:
        die(f"unknown MCP server {a.server!r}; configured: {', '.join(sorted(servers)) or 'none'}")
    cfg = servers[a.server]["config"]
    if a.measure:
        measure_server(a.server, cfg)
        return
    tools = server_tools(a.server, cfg, refresh=True)
    if tools is None:
        die(f"could not list tools of {a.server} directly; try --measure")
    for t, tok in sorted(tools.items(), key=lambda kv: -kv[1]):
        print(f"{tok:>7,} tok  {t}")
    print(f"{sum(tools.values()):>7,} tok  total for {len(tools)} tools.  "
          f"Give a worker only what it needs: --mcp {a.server}:<tool>,<tool>")


def measure_server(name, cfg):
    """Measure a server's per-turn context cost with two tiny Haiku calls (works for any server type)."""
    claude = os.environ.get("LEAN_AGENT_CLAUDE") or "claude"
    d = home("work", "measure-" + uuid.uuid4().hex[:6])
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, "mcp.json")
    lean_mcp.write_config(path, {name: cfg})
    sizes = []
    try:
        for extra in ([], ["--mcp-config", path]):
            out = subprocess.run([claude, "-p", "--output-format", "json", "--model", "haiku", "--setting-sources", "",
                                  "--strict-mcp-config", *extra, "--disable-slash-commands", "--tools", WORKER_TOOLS,
                                  "--max-turns", "1"], input="Reply with just OK. Do not use tools.",
                                 capture_output=True, text=True, cwd=d, timeout=180)
            u = (json.loads(out.stdout.strip().splitlines()[-1]) if out.stdout.strip() else {}).get("usage") or {}
            sizes.append(sum(u.get(k, 0) for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")))
    finally:
        os.remove(path)
    print(f"{name}: ~{sizes[1] - sizes[0]:,} tokens of context per worker turn (baseline {sizes[0]:,})")


def cmd_memory(a):
    store = memory_store()
    scope = lean_memory.GLOBAL
    project_path = None
    if getattr(a, "project", None):
        scope, project_path = resolve_project(a.project)
    if a.action == "where":
        print(f"lean-agent memory store: {store}")
        dirs = lean_memory.claude_memory_dirs(project_path)
        print("Claude Code auto-memory folders found: " + (", ".join(dirs) if dirs else "none"))
        return
    if a.action == "import":
        sources = [os.path.abspath(os.path.expanduser(a.source))] if a.source else lean_memory.claude_memory_dirs(project_path)
        if not sources:
            die("no Claude Code auto-memory folders found; pass one with --from DIR")
        added, skipped = lean_memory.import_dirs(store, sources, scope=scope)
        print(f"Imported {added} memories ({skipped} duplicates skipped) from: {', '.join(sources)}")
        print(f"Store: {store}")
        if added:
            print("Your original files are untouched. Once you're happy, stop Claude Code loading MEMORY.md into every "
                  "session: set \"autoMemoryEnabled\": false in ~/.claude/settings.json (and drop autoMemoryDirectory).")
        for slug in projects():
            sync_memory(slug)
        return
    if a.action == "add":
        if not a.text:
            die("memory add needs the text")
        mtype = a.type or "project"
        path = lean_memory.add(store, a.text, mtype, scope=scope, name=a.name, source="lean-agent memory add")
        print(f"saved {os.path.basename(path)}" if path else "already remembered")
        for slug in projects():
            sync_memory(slug)
        return
    if a.action == "rm":
        if not a.text:
            die("memory rm needs the memory name (file name without .md)")
        stem = a.text[4:] if a.text.startswith("mem-") else a.text
        matches = [m["stem"] for m in lean_memory.read_all(store) if slugify(m["stem"], 40) == slugify(stem, 40)]
        if not matches or not lean_memory.remove(store, matches[0]):
            die(f"no memory {a.text!r}")
        for slug in projects():
            sync_memory(slug)
        print(f"removed {matches[0]}")
        return
    mems = lean_memory.read_all(store)
    if a.project:
        mems = [m for m in mems if m["scope"] in (lean_memory.GLOBAL, scope)]
    if not mems:
        print(f"No memories in {store}. Import Claude Code's: lean-agent memory import")
        return
    for m in mems:
        sc = "" if m["scope"] == lean_memory.GLOBAL else f" [{m['scope']}]"
        print(f"mem-{slugify(m['stem'], 40):<44}{m['type']:<10}{est_tokens(m['body']):>5} tok{sc}  {(m['description'] or m['name'])[:60]}")
    print(f"{len(mems)} memories in {store}")


def cmd_stats(a):
    runs = ledger()
    if a.project:
        slug, _ = resolve_project(a.project)
        runs = [r for r in runs if r["project"] == slug]
    if a.today:
        runs = [r for r in runs if r["ts"].startswith(datetime.date.today().isoformat())]
    elif a.days:
        cutoff = (datetime.datetime.now() - datetime.timedelta(days=a.days)).isoformat()
        runs = [r for r in runs if r["ts"] >= cutoff]
    if not runs:
        print("No runs yet.")
    else:
        by = {}
        for r in runs:
            m = by.setdefault(r["model"], {"n": 0, "ok": 0, "u": 0, "usd": 0.0})
            m["n"] += 1
            m["ok"] += r["status"] == "done"
            m["u"] += r.get("units", int(r.get("weighted", 0) * usage.model_rate(r["model"])))
            m["usd"] += r.get("cost_usd") or 0
        print(f"{'model':<14}{'runs':>6}{'done':>7}{'avg sonnet-eq':>15}{'total sonnet-eq':>17}{'API $':>9}")
        for model, m in sorted(by.items(), key=lambda kv: -kv[1]["u"]):
            print(f"{model:<14}{m['n']:>6}{m['ok'] * 100 // m['n']:>6}%{m['u'] // m['n']:>15,}{m['u']:>17,}{'$%.2f' % m['usd']:>9}")
    print()
    print_limits()


def print_limits():
    w = usage.window_usage()
    budgets = usage.window_budgets()
    for name, label in (("5h", "Last 5 hours"), ("week", "Last 7 days ")):
        lean, total, budget = w[name]["lean"], w[name]["all"], budgets[name]
        line = f"{label}: lean-agent {lean:,}"
        if budget:
            line += f" of {budget:,} ({lean * 100 // budget}%)"
            if lean >= budget and w[name]["frees_at"]:
                line += f", frees up from {w[name]['frees_at']:%a %H:%M}"
        else:
            line += " (no budget)"
        print(line + f"  | all Claude Code on this machine: {total:,}")
    print("Units: Sonnet-equivalent tokens (Haiku 5.5 counts 0.05x, Opus 5.5 2x, Fable 5.1 5x). "
          "Compare with /usage in Claude Code.")


def cmd_limits(a):
    if a.off or a.five_h is not None or a.week is not None:
        cur = load_json(usage.limits_path(), {})
        if a.off:
            cur = {}
        if a.five_h is not None:
            cur["5h"] = a.five_h
        if a.week is not None:
            cur["week"] = a.week
        save_json(usage.limits_path(), cur)
    for env in ("LEAN_AGENT_5H_BUDGET", "LEAN_AGENT_WEEKLY_BUDGET"):
        if os.environ.get(env):
            print(f"note: {env} is set in the environment and overrides the saved value")
    print_limits()

def cmd_optimize(a):
    slug, _ = resolve_project(a.project)
    sync_memory(slug)
    with library_lock(slug):
        _cmd_optimize(a)


def _cmd_optimize(a):
    slug, _ = resolve_project(a.project)
    cards = load_cards(slug)
    actions = []
    for c in cards:
        if c.get("archived") or c["offered"] < a.min_runs:
            continue
        rate = c["used"] / c["offered"]
        if not c.get("core") and rate >= 0.8:
            actions.append(("core", c, f"used in {card_rate(c)} runs: always send it"))
        elif c.get("core") and rate < 0.4:
            actions.append(("uncore", c, f"core but used in only {card_rate(c)} runs"))
        elif not c.get("core") and rate <= 0.2 and c["unneeded"] >= 2:
            actions.append(("archive", c, f"used in {card_rate(c)} runs, marked unneeded {c['unneeded']}x"))
        if rate >= 0.5 and c["tokens"] > 600:
            actions.append(("trim", c, f"~{c['tokens']} tok and often used: rewrite shorter with `card add {slug} {c['id']} --file ...`"))
    if not actions:
        print(f"No card changes suggested yet (cards need {a.min_runs}+ runs of data).")
    for act, c, why in actions:
        print(f"{act:<8}{c['id']:<34}{why}")
    if a.apply:
        for act, c, _ in actions:
            if act == "core":
                c["core"] = True
            elif act == "uncore":
                c["core"] = False
            elif act == "archive":
                c["archived"] = True
        save_cards(slug, cards)
        print("Applied core/uncore/archive changes (trims are up to you).")
    mcp_runs = {}
    for r in ledger():
        if r.get("project") != slug or r.get("resumed"):
            continue
        for name, wanted in lean_mcp.parse_specs(r.get("mcp")):
            m = mcp_runs.setdefault(name, {"runs": 0, "used_runs": 0, "calls": {}})
            m["runs"] += 1
            prefix = lean_mcp.tool_prefix(name)
            mine = {k[len(prefix):]: v for k, v in (r.get("mcp_calls") or {}).items() if k.startswith(prefix)}
            m["used_runs"] += bool(mine)
            for t, v in mine.items():
                m["calls"][t] = m["calls"].get(t, 0) + v
    for name, m in sorted(mcp_runs.items()):
        if m["runs"] < a.min_runs:
            continue
        if not m["used_runs"]:
            print(f"mcp     {name:<34}given in {m['runs']} runs, never called: stop passing --mcp {name}")
        else:
            used = sorted(m["calls"], key=lambda t: -m["calls"][t])
            print(f"mcp     {name:<34}called in {m['used_runs']}/{m['runs']} runs; tools used: "
                  f"{', '.join(used)} -> --mcp {name}:{','.join(used)}")
    notes = list(read_jsonl(home("library", slug, "missing.jsonl")))[-a.notes:]
    if notes:
        print("\nRecent context gaps reported by workers (turn recurring ones into cards with `lean-agent card add`):")
        for n in notes:
            print(f"- [{n['run']}] {n['missing'][:200]}")


# ---------------------------------------------------------------- commands: setup

ORCHESTRATOR_ENV = {
    "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1",   # memory lives in lean-agent; no MEMORY.md on every turn
    "LEAN_AGENT_BUDGET": "1000000",           # orchestrator session budget (weighted tokens)
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "70",
    "BASH_MAX_OUTPUT_LENGTH": "20000",
    "MAX_MCP_OUTPUT_TOKENS": "10000",
    "CLAUDE_CODE_SUBAGENT_MODEL": "sonnet",
}


def prepare_home():
    h = home("home")
    os.makedirs(os.path.join(h, ".claude"), exist_ok=True)
    target = os.path.join(h, "CLAUDE.md")
    template = read_text(os.path.join(PLUGIN_ROOT, "templates", "orchestrator.md"))
    current = read_text(target) if os.path.exists(target) else ""
    m = re.search(re.escape(TEMPLATE_MARK) + r"(\d+)", current)
    if not current or (m and int(m.group(1)) < TEMPLATE_VERSION):
        with open(target, "w") as fh:
            fh.write(template)
    settings = os.path.join(h, ".claude", "settings.json")
    if not os.path.exists(settings):
        save_json(settings, {"permissions": {"allow": ["Bash(lean-agent:*)"]}})
    return h


def set_home_model(h, model):
    """Pin the orchestrator's model in its folder's settings.

    `claude remote-control` silently drops a global --model flag, so remote sessions
    would start on your default model (possibly the most expensive one); a `model`
    key in the folder's .claude/settings.json is what those sessions read."""
    path = os.path.join(h, ".claude", "settings.json")
    data = load_json(path, {})
    if model in (None, "", "default"):
        data.pop("model", None)
    else:
        data["model"] = model
    save_json(path, data)


def claude_global_config():
    base = os.environ.get("CLAUDE_CONFIG_DIR")
    return os.path.join(base, ".claude.json") if base else os.path.expanduser("~/.claude.json")


def is_trusted(folder):
    projs = load_json(claude_global_config(), {}).get("projects") or {}
    return any((projs.get(p) or {}).get("hasTrustDialogAccepted")
               for p in {folder, os.path.realpath(folder)})


TRUST_HINT = ("the orchestrator home is not trusted yet, so Claude Code ignores its permission rules and every "
              "`lean-agent` command will ask for approval. Fix once with: lean-agent trust")


def cmd_trust(a):
    h = prepare_home()
    if is_trusted(h):
        print(f"{h} is already trusted.")
        return 0
    if a.write_config:
        cfg = claude_global_config()
        if not os.path.exists(cfg):
            die(f"{cfg} not found; run `claude` once first")
        data = load_json(cfg, None)
        if data is None:
            die(f"could not parse {cfg}; not touching it")
        backup = cfg + ".lean-agent.bak"
        with open(cfg) as src, open(backup, "w") as dst:
            dst.write(src.read())
        data.setdefault("projects", {}).setdefault(h, {})["hasTrustDialogAccepted"] = True
        save_json(cfg, data)
        print(f"Marked {h} as trusted in {cfg} (backup: {backup}).")
        print("Do this while no Claude Code session is starting up, since Claude Code also writes that file.")
        return 0
    print(f"Opening Claude Code in {h}.")
    print("Accept the trust dialog, then type /exit. (Or rerun with --write-config to set it without the dialog.)")
    os.chdir(h)
    return subprocess.run(["claude"]).returncode


def cmd_up(a):
    h = prepare_home()
    set_home_model(h, a.model)
    if not is_trusted(h):
        print(f"lean-agent: warning: {TRUST_HINT}", file=sys.stderr)
    env = dict(os.environ)
    for k, v in ORCHESTRATOR_ENV.items():
        env.setdefault(k, v)
    if a.budget:
        env["LEAN_AGENT_BUDGET"] = str(a.budget)
    if a.budget_5h is not None or a.budget_week is not None:
        cur = load_json(usage.limits_path(), {})
        if a.budget_5h is not None:
            cur["5h"] = a.budget_5h
        if a.budget_week is not None:
            cur["week"] = a.budget_week
        save_json(usage.limits_path(), cur)
    bindir = os.path.join(PLUGIN_ROOT, "bin")
    env["PATH"] = bindir + os.pathsep + env.get("PATH", "")  # `lean-agent` works even without the plugin
    cmd = [os.environ.get("LEAN_AGENT_CLAUDE") or "claude"]
    if a.model:
        cmd += ["--model", a.model]
    if a.local:
        print(f"lean-agent: orchestrator in {h} (model {a.model or 'default'})")
    else:
        cmd += ["remote-control", "--name", a.name]
        if a.permission_mode:
            cmd += ["--permission-mode", a.permission_mode]
        print(f"lean-agent: orchestrator in {h}, model {a.model or 'default'}, "
              f"session budget {env['LEAN_AGENT_BUDGET']} weighted tokens")
        print(f"lean-agent: open the Claude app (Code) and pick \"{a.name}\"")
    extra = a.extra[1:] if a.extra[:1] == ["--"] else a.extra
    cmd += extra  # e.g. `lean-agent up -- --debug --debug-file /tmp/rc.log`
    os.chdir(h)
    try:
        os.execvpe(cmd[0], cmd, env)
    except FileNotFoundError:
        die("'claude' not found on PATH")


def cmd_install(a):
    subprocess.run(["claude", "plugin", "marketplace", "add", REPO])
    r = subprocess.run(["claude", "plugin", "install", PLUGIN])
    h = prepare_home()
    print(f"Orchestrator home: {h}")
    if not is_trusted(h):
        print(f"Next: {TRUST_HINT}")
    sys.exit(r.returncode)


def cmd_env(a):
    if a.json:
        print(json.dumps({"env": ORCHESTRATOR_ENV}, indent=2))
    else:
        for k, v in ORCHESTRATOR_ENV.items():
            print(f"export {k}={v}")


def cmd_budget(a):
    sys.exit(usage.report(a.session))


def cmd_home(a):
    print(prepare_home())


# ---------------------------------------------------------------- CLI

def main(argv=None):
    ap = argparse.ArgumentParser(prog="lean-agent", description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("up", help="start the orchestrator (Remote Control by default)")
    s.add_argument("--model", default="sonnet",
                   help="orchestrator model, pinned in the home's settings (default: sonnet; 'default' = your own)")
    s.add_argument("--name", default="lean-agent", help="session name in the Claude app")
    s.add_argument("--budget", type=int, help="orchestrator session budget, weighted tokens")
    s.add_argument("--budget-5h", type=int, help="lean-agent budget per 5-hour window (Sonnet-equivalent tokens)")
    s.add_argument("--budget-week", type=int, help="lean-agent budget per 7 days (Sonnet-equivalent tokens)")
    s.add_argument("--permission-mode", help="e.g. acceptEdits, auto")
    s.add_argument("--local", action="store_true", help="interactive terminal session instead of Remote Control")
    s.add_argument("extra", nargs=argparse.REMAINDER,
                   help="after --: extra flags for claude / claude remote-control, e.g. -- --debug")
    s.set_defaults(fn=cmd_up)

    s = sub.add_parser("install", help="install the plugin and create the orchestrator home")
    s.set_defaults(fn=cmd_install)
    s = sub.add_parser("trust", help="trust the orchestrator home so its permission rules apply")
    s.add_argument("--write-config", action="store_true",
                   help="set hasTrustDialogAccepted in ~/.claude.json instead of opening Claude")
    s.set_defaults(fn=cmd_trust)
    s = sub.add_parser("home", help="create (if needed) and print the orchestrator home folder")
    s.set_defaults(fn=cmd_home)
    s = sub.add_parser("env", help="print orchestrator env defaults")
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=cmd_env)
    s = sub.add_parser("budget", help="token usage of the current orchestrator session")
    s.add_argument("session", nargs="?")
    s.set_defaults(fn=cmd_budget)

    s = sub.add_parser("learn", help="index a project's CLAUDE.md, rules and skills into context cards")
    s.add_argument("path")
    s.add_argument("--name", help="short project name to use instead of <folder>-<hash>")
    s.add_argument("--user-skills", action="store_true", help="also index ~/.claude/skills")
    s.set_defaults(fn=cmd_learn)
    s = sub.add_parser("projects", help="list learned projects")
    s.set_defaults(fn=cmd_projects)
    s = sub.add_parser("cards", help="list a project's context cards")
    s.add_argument("project")
    s.add_argument("filter", nargs="?", help="only cards whose id, title or source contains this")
    s.add_argument("--all", action="store_true", help="include archived cards")
    s.set_defaults(fn=cmd_cards)
    s = sub.add_parser("card", help="show/add/rm/core one card")
    s.add_argument("action", choices=["show", "add", "rm", "core"])
    s.add_argument("project")
    s.add_argument("id")
    s.add_argument("--title")
    s.add_argument("--text")
    s.add_argument("--file")
    s.add_argument("--core", action="store_true", help="add: mark as core")
    s.add_argument("--off", action="store_true", help="core: unmark")
    s.set_defaults(fn=cmd_card)
    s = sub.add_parser("suggest", help="suggest cards for a task")
    s.add_argument("project")
    s.add_argument("task")
    s.add_argument("--max-tokens", type=int, default=3000)
    s.set_defaults(fn=cmd_suggest)

    s = sub.add_parser("run", help="run an isolated worker on a project")
    s.add_argument("task", nargs="*", help="task text, or - to read stdin")
    s.add_argument("--project", "-p")
    s.add_argument("--model", "-m", help="haiku | sonnet | opus | full model id (required)")
    s.add_argument("--why", help="one line: why this model and context (required)")
    s.add_argument("--cards", help="comma-separated card ids, or 'auto'")
    s.add_argument("--max-context", type=int, default=3000, help="token cap for --cards auto")
    s.add_argument("--read-only", action="store_true", help=f"tools: {READONLY_TOOLS}")
    s.add_argument("--tools", help=f"explicit tool list (default {WORKER_TOOLS})")
    s.add_argument("--max-turns", type=int, default=env_num("LEAN_AGENT_MAX_TURNS", 40))
    s.add_argument("--max-usd", type=float, default=env_num("LEAN_AGENT_RUN_MAX_USD", 3.0, float))
    s.add_argument("--task-file")
    s.add_argument("--resume", metavar="RUN_ID", help="continue a previous run's session")
    s.add_argument("--mcp", action="append", metavar="SERVER[:TOOL,TOOL]",
                   help="give the worker this MCP server, optionally only these tools (repeatable)")
    s.set_defaults(fn=cmd_run)

    s = sub.add_parser("mcp", help="MCP servers workers can use: list, tools <server>")
    s.add_argument("action", choices=["list", "tools"])
    s.add_argument("server", nargs="?")
    s.add_argument("--project", "-p", help="include this project's .mcp.json and local-scope servers")
    s.add_argument("--probe", action="store_true", help="list: query stdio servers for their tools")
    s.add_argument("--measure", action="store_true", help="tools: measure real per-turn cost with 2 Haiku calls")
    s.set_defaults(fn=cmd_mcp)

    s = sub.add_parser("memory", help="shared memory: where | import | list | add | rm")
    s.add_argument("action", choices=["where", "import", "list", "add", "rm"])
    s.add_argument("text", nargs="?", help="add: the memory text; rm: its name")
    s.add_argument("--project", "-p", help="scope to a project (default: global)")
    s.add_argument("--type", choices=lean_memory.TYPES, help="add: memory type (default project)")
    s.add_argument("--name", help="add: short name")
    s.add_argument("--from", dest="source", metavar="DIR", help="import: folder to import (default: Claude's)")
    s.set_defaults(fn=cmd_memory)

    s = sub.add_parser("limits", help="usage in the 5-hour and weekly windows; set budgets for them")
    s.add_argument("--5h", dest="five_h", type=int, metavar="N", help="budget per rolling 5 hours (0 = none)")
    s.add_argument("--week", type=int, metavar="N", help="budget per rolling 7 days (0 = none)")
    s.add_argument("--off", action="store_true", help="remove both budgets")
    s.set_defaults(fn=cmd_limits)

    s = sub.add_parser("stats", help="runs, success rate and tokens by model")
    s.add_argument("--project", "-p")
    s.add_argument("--today", action="store_true")
    s.add_argument("--days", type=int)
    s.set_defaults(fn=cmd_stats)
    s = sub.add_parser("optimize", help="tune a project's cards from worker feedback")
    s.add_argument("project")
    s.add_argument("--apply", action="store_true")
    s.add_argument("--min-runs", type=int, default=3)
    s.add_argument("--notes", type=int, default=10)
    s.set_defaults(fn=cmd_optimize)

    a = ap.parse_args(argv)
    if a.cmd == "run" and not a.resume and not a.project:
        ap.error("run needs --project (or --resume)")
    return a.fn(a) or 0


if __name__ == "__main__":
    sys.exit(main())
