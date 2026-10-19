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
import time
import uuid

try:
    import fcntl
except ImportError:  # Windows: no locking, parallel runs may lose a stats update
    fcntl = None

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import usage  # noqa: E402
import lean_mcp  # noqa: E402
import lean_log  # noqa: E402
import lean_memory  # noqa: E402

PLUGIN_ROOT = os.path.dirname(HERE)
REPO = "mcmadsen/lean-agent"
PLUGIN = "lean-agent@lean-agent"
OLD_TEMPLATE_MARK = "<!-- lean-agent orchestrator template v"   # homes written before the generated guide
GUIDE_MARK = "<!-- lean-agent guide "
BLOCK_BEGIN = "<!-- lean-agent:begin"
BLOCK_END = "<!-- lean-agent:end -->"
BLOCK_RE = re.compile(r"\n*<!-- lean-agent:begin[^>]*-->.*?<!-- lean-agent:end -->\n*", re.S)
PRECEDENCE_MARK = "<!-- lean-agent:precedence -->"
PRECEDENCE_LINE = (PRECEDENCE_MARK + " In repos and sessions with lean-agent rules (a lean-agent block or the lean-agent "
                   "home), those rules on subagents, the Agent tool and workflows take precedence over this file.")
CONFLICT_RE = re.compile(r"(?i)\b(sub-?agents?|agent tool|task tool|workflow tool|workflows?|spawn)\b")

WORKER_TOOLS = "Bash,Read,Edit,Write,Glob,Grep"
READONLY_TOOLS = "Read,Glob,Grep"
SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "dist", "build", "target", "__pycache__", ".next", "vendor"}
STOPWORDS = set("the and for with that this from into have has are was were will would should could "
                "you your our their not but all any can use using used make add fix get set run".split())

WORKER_PROTOCOL = """\
You are a lean-agent worker. Another agent gave you one task; it cannot see your
reasoning, only your final reply.

Project: {project}
Your working directory is NOT the project. Use absolute paths.
{shell_rule}

Work frugally: Grep/Glob for the symbol first, then Read only the line range you need
(offset/limit); never read a whole file over ~200 lines. Don't re-read what you already have,
use quiet command flags (-q, --silent), no narration. Read other project files only
when the task needs them. Run builds, tests, installs and linters through
`{sq} <command>`: it drops the noise (progress, downloads, passing tests,
repeated warnings), keeps every error with its stack trace and the closing summary, keeps
the exit code, and saves the full output and an errors-only copy (paths in its first line).
Don't pipe those commands through `tail`/`head`: that cuts off the errors.

Ask, don't guess: if the task's target (a person, chat, channel, ticket, branch or
file) or its intent is not uniquely clear from the task and what you find, stop and
return status "needs-input" with your question and the candidates you found.

{send_rule}
{browser_rule}
{role_rule}Start your reply with a one or two sentence summary of the outcome. Then give the result
(what you did, files changed, anything unresolved), then one final line exactly like this:
"used" lists only cards whose content changed what you did, not cards you merely received.
LEAN-FEEDBACK {{"status": "done|partial|failed|needs-input|awaiting-confirmation", "used": ["card-id"], "unneeded": ["card-id"], "missing": "context you had to discover that should have been given up front, or empty", "remember": []}}

"remember" is shared memory for future agents. Usually leave it empty. Add an item
only for a durable fact that can't be derived from the code or git history, such as a
user correction, a decision, or where external info lives:
{{"type": "feedback|project|reference|user", "text": "one or two sentences"}}
"""

SHELL_RULE = "Run shell commands as `cd {project} && <command>`."
READONLY_SHELL_RULE = ("You are read-only. The only shell commands you can run are read-only git commands, written as\n"
                       "`git -C {project} <show|log|grep|diff|blame|status|ls-files|ls-tree|cat-file|rev-parse|branch|fetch> ...`\n"
                       "(no `cd`, no pipes to other programs). Everything else is refused.")
SEND_RULE = ("Outward actions: do NOT do anything that leaves this machine and can't be undone, such as\n"
             "sending or posting a message, submitting a form, publishing, merging, deploying, or deleting\n"
             "remote data. Do the work up to that point (e.g. type the draft), then stop with status\n"
             "\"awaiting-confirmation\" and state exactly what would be done: where, to whom, and the exact text.\n")
ALLOW_SEND_RULE = ("Outward actions: the user explicitly approved this outward action: {approved}\n"
                   "Do exactly that, once, then verify it happened. Anything beyond it still needs approval:\n"
                   "stop with status \"awaiting-confirmation\".\n")
BROWSER_RULE = ("Browser: you control the user's real Chrome (signed in as them) through the Claude in Chrome\n"
                "tools. Always work in a new tab and never touch the user's existing tabs. If a login, MFA,\n"
                "CAPTCHA or account picker appears, stop with status \"needs-input\".\n")
READONLY_GIT = ("show", "log", "grep", "diff", "blame", "status", "ls-files", "ls-tree", "cat-file", "rev-parse",
                "branch", "fetch")
CHROME = "claude-in-chrome"


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
    lean_log.log("error" if code not in (0, 2, 3) else "debug", "cli", f"{' '.join(sys.argv[1:3])}: {msg}")
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


def stem(w):
    for suffix in ("ing", "ies", "es", "ed", "s"):
        if w.endswith(suffix) and len(w) - len(suffix) >= 4:
            return w[: -len(suffix)] + ("y" if suffix == "ies" else "")
    return w


def words(text):
    return {stem(w) for w in re.findall(r"[a-z][a-z0-9_]{2,}", text.lower()) if w not in STOPWORDS}


BROWSER_WORDS = {stem(w) for w in "teams gmail slack outlook email mail chat message messages post reply browser "
                 "website webpage chrome".split()}
READ_WORDS = {stem(w) for w in "find which where what list show explain investigate look check summarize summarise "
              "compare why how read review audit inspect trace locate count search".split()}
CHANGE_WORDS = {stem(w) for w in "fix implement change refactor rename update write create build migrate remove "
                "delete bump upgrade edit patch".split()}
JUDGE_WORDS = {stem(w) for w in "decide decision verdict recommend recommendation assess evaluate judge should "
               "whether choose pick prioritize".split()}
GATHER_WORDS = {stem(w) for w in "investigate gather collect find check compare research look list".split()}


def task_type(task, read_only=False, chrome=False):
    """read | change | browser, used for per-type core cards and model stats."""
    tw = words(task)
    if chrome or tw & BROWSER_WORDS:
        return "browser"
    if read_only:
        return "read"
    if tw & CHANGE_WORDS:
        return "change"
    return "read" if tw & READ_WORDS else "change"


def is_core(c, ttype):
    return bool(c.get("core")) or ttype in (c.get("core_types") or [])


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


def is_project_ref(ref):
    projs = projects()
    if ref in projs or any(os.path.basename(v["path"]) == ref for v in projs.values()):
        return True
    return os.path.isdir(os.path.expanduser(ref)) and os.sep in ref


def library_path(slug):
    return home("library", slug, "cards.json")


_held_locks = {}


@contextlib.contextmanager
def library_lock(slug):
    """Serialise read-modify-write of a project's cards across parallel lean-agent processes.

    Re-entrant within one process, so a locked command can call helpers that lock too."""
    if _held_locks.get(slug):
        _held_locks[slug] += 1
        try:
            yield
        finally:
            _held_locks[slug] -= 1
        return
    path = home("library", slug, ".lock")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        if fcntl:
            fcntl.flock(fh, fcntl.LOCK_EX)
        _held_locks[slug] = 1
        try:
            yield
        finally:
            _held_locks[slug] = 0
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


def learn(path, include_user_skills=False, quiet=False, name=None, rules=None):
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
        for i, (head, body) in enumerate(split_sections(BLOCK_RE.sub("\n", read_text(f)))):
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
        source_changed = []
        for c in fresh:
            prev = old.pop(c["id"], {})
            if prev.get("edited"):  # hand edits (card add) win over the source; say when the source moved on
                if prev.get("source_text") != c["text"]:
                    source_changed.append(c["id"])
                c.update(text=prev["text"], title=prev.get("title", c["title"]), edited=True,
                         source_text=c["text"])
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
    kept = dict(projs.get(slug) or {})
    for other in [s for s, v in projs.items() if v["path"] == path and s != slug]:
        kept = {**projs.pop(other), **kept}  # renamed with --name: keep its settings
    rules = "off" if rules is False else kept.get("rules")
    projs[slug] = {**kept, "path": path, "learned": now_iso(), "rules": rules}
    save_json(home("projects.json"), projs)
    cards = sync_memory(slug)
    if rules != "off":
        target, _ = install_block(slug)
        if not quiet:
            print(f"lean-agent rules for this repo: {target} (refresh with `lean-agent rules {slug}`, "
                  f"remove with `--off`)")
    elif rules == "off":
        remove_blocks(path)
    if source_changed and not quiet:
        print("note: kept your edited text for cards whose CLAUDE.md source changed since: " + ", ".join(source_changed))

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
        before = json.dumps(cards, sort_keys=True)
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
        if json.dumps(kept, sort_keys=True) != before:  # cards are updated in place, so compare snapshots
            save_cards(slug, kept)
    return kept


def card_rate(c):
    return f"{c['used']}/{c['offered']}" if c["offered"] else "-"


# ---------------------------------------------------------------- commands: library

def cmd_learn(a):
    learn(a.path, include_user_skills=a.user_skills, name=a.name, rules=False if a.no_rules else None)


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
        if existing and existing["kind"] == "memory":  # write through, or the next sync would undo it
            if not lean_memory.edit(memory_store(), a.id, text, description=a.title):
                die(f"memory behind {a.id} not found")
            if a.core:
                existing["core"] = True
                save_cards(slug, cards)
            sync_memory(slug)
            print(f"updated memory {a.id} (~{est_tokens(text)} tok); its card keeps stats and core flag")
            return
        if existing:
            if existing["kind"] != "note":
                existing.setdefault("source_text", existing["text"])
                existing["edited"] = True  # `learn` keeps this text
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
            if c["kind"] == "memory":
                print(f"archived the card in {slug} only; delete the memory everywhere with `lean-agent memory rm {a.id}`")
    elif a.action == "core":
        c["core"] = not a.off
    save_cards(slug, cards)
    print(f"{a.action} {a.id}: ok")


def suggest(slug, task, max_tokens, ttype=None, explain=False, strict=False, limit=None):
    """Core cards for this task type plus the most relevant cards that fit `max_tokens`.

    Relevance uses word rarity across the library (common words count little) and requires a
    distinctive title word, or several body words; big cards need a title match. strict (for
    `--cards auto` and `suggest`) needs a title match or a small card sharing 3+ distinctive words,
    keeps only cards scoring at least 40% of the
    best one, and at most `limit` of them. Returns the picked cards, or with explain=True
    (picked, reasons, closest rejected card)."""
    import math
    cards = [c for c in load_cards(slug) if not c.get("archived")]
    ttype = ttype or task_type(task)
    tw = words(task)
    n = len(cards) or 1
    df = {}
    for c in cards:
        for w in words(c["title"]) | words(c["text"]):
            df[w] = df.get(w, 0) + 1
    idf = {w: math.log((n + 1) / (df.get(w, 0) + 1)) for w in tw}
    picked = [c for c in cards if is_core(c, ttype)]
    reasons = {c["id"]: f"core for {ttype}" if ttype in (c.get("core_types") or []) else "core" for c in picked}
    budget = max_tokens - sum(c["tokens"] for c in picked)
    scored, closest = [], None
    for c in cards:
        if is_core(c, ttype):
            continue
        title_hits = tw & words(c["title"])
        body_hits = (tw & words(c["text"])) - title_hits
        t_score = sum(idf[w] for w in title_hits)
        b_score = sum(idf[w] for w in body_hits)
        if strict:  # a title match, or a small card that shares 3+ distinctive words with the task
            relevant = t_score >= 1.0 or (b_score >= 3.0 and len(body_hits) >= 3 and c["tokens"] <= 400)
        else:
            relevant = t_score >= 1.0 or (b_score >= 3.0 and len(body_hits) >= 2)
        if c["tokens"] > 800 and t_score < 1.0:
            relevant = False  # a big card has to be clearly about the task
        why = ", ".join(sorted(title_hits)) and f"title: {', '.join(sorted(title_hits))}" or \
            f"text: {', '.join(sorted(body_hits))}"
        pref = (c["kind"] == "memory" and c["title"].startswith(("memory user", "memory feedback"))
                and c["tokens"] <= 150)
        if not relevant and pref:
            scored.append((0.5, c, "preference memory"))
            continue
        if not relevant:
            if (t_score + b_score) and (closest is None or t_score + b_score > closest[0]):
                closest = (t_score + b_score, c, why)
            continue
        usefulness = (c["used"] + 1) / (c["offered"] + 2)
        score = (3 * t_score + b_score) * (0.5 + usefulness) / (1 + c["tokens"] / 1500)
        scored.append((score, c, why))
    top = max((sc for sc, _, why in scored if why != "preference memory"), default=0)
    matches = 0
    for score, c, why in sorted(scored, key=lambda x: -x[0]):
        pref = why == "preference memory"
        if strict and not pref and (score < 0.4 * top or (limit is not None and matches >= limit)):
            if closest is None:
                closest = (score, c, why + "; weaker than the best matches")
            continue
        if c["tokens"] <= budget:
            picked.append(c)
            reasons[c["id"]] = why
            budget -= c["tokens"]
            matches += not pref
    if explain:
        return picked, reasons, closest
    return picked


def recommend_model(ttype):
    """(model, why) for a task type: cheapest model that has done this type well, else a default."""
    runs = [r for r in ledger() if not r.get("resumed")]
    best = None
    for model in ("haiku", "sonnet", "opus"):
        mine = [r for r in runs if r["model"] == model and
                (r.get("type") or ("read" if r.get("read_only") else "change")) == ttype]
        if len(mine) >= 3:
            ok = sum(r["status"] in ("done", "awaiting-confirmation") for r in mine) / len(mine)
            avg = sum(r.get("units", 0) for r in mine) // len(mine)
            if ok >= 0.8:
                best = (model, f"{ttype} runs on {model}: {ok:.0%} done, ~{avg:,} sonnet-eq avg")
                break
    if not best:
        best = {"read": ("haiku", "default for read-only lookups"),
                "browser": ("sonnet", "default for browser tasks"),
                "change": ("sonnet", "default for code changes")}[ttype]
    line, low = budget_line()
    if low and best[0] != "haiku":
        best = ("haiku", best[1] + "; budget is low, so prefer haiku and smaller steps")
    return best


def cmd_suggest(a):
    slug, _ = resolve_project(a.project)
    sync_memory(slug)
    ttype = task_type(a.task)
    picked, reasons, closest = suggest(slug, a.task, a.max_tokens, ttype, explain=True, strict=True,
                                       limit=a.max_cards)
    model, why = recommend_model(ttype)
    flags = f"-m {model}" + (" --read-only" if ttype == "read" else "") + (" --chrome" if ttype == "browser" else "")
    print(f"task type: {ttype} · recommended: {flags}  ({why})")
    tw = words(a.task)
    if tw & JUDGE_WORDS and tw & GATHER_WORDS:
        print("split: 1) -m haiku --read-only gathers the facts; 2) -m sonnet judges from those facts only "
              "(pass run 1's answer with --task-file)")
    line, _ = budget_line()
    if line:
        print(line)
    if not picked:
        hint = f" (closest: {closest[1]['id']}, {closest[2]}, not distinctive enough)" if closest else ""
        print(f"No relevant cards{hint}. Run without --cards.")
        return
    total = 0
    for c in picked:
        total += c["tokens"]
        label = "core" if reasons[c["id"]].startswith("core") else "match"
        print(f"{label:<6}{c['id']:<36}~{c['tokens']:>5,} tok  used {card_rate(c):>5}  {reasons[c['id']]}")
    print(f"total ~{total:,} tok of {a.max_tokens:,} budget")
    extra = [c["id"] for c in picked if not reasons[c["id"]].startswith("core")]
    print(f"--cards {','.join(extra)}   (core cards are sent anyway)" if extra else "Only core cards apply; leave out --cards.")


# ---------------------------------------------------------------- commands: runs

def ledger():
    return list(read_jsonl(home("ledger.jsonl")))


def parse_marker(text, marker):
    """(text without the `MARKER {json}` line, parsed dict) for the last such line."""
    lines = text.rstrip().splitlines()
    for i in range(len(lines) - 1, -1, -1):
        m = re.search(re.escape(marker) + r"\s*(\{.*\})", lines[i])
        if m:
            try:
                data = json.loads(m.group(1))
            except ValueError:
                data = {}
            del lines[i]
            return "\n".join(lines).strip(), data if isinstance(data, dict) else {}
    return text.strip(), {}


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


def build_append(project, cards, read_only=False, allow_send=None, chrome=False, role_rule=""):
    parts = [WORKER_PROTOCOL.format(
        project=project, sq=os.path.join(PLUGIN_ROOT, "bin", "lean-sq"),
        shell_rule=(READONLY_SHELL_RULE if read_only else SHELL_RULE).format(project=project),
        send_rule=ALLOW_SEND_RULE.format(approved=allow_send) if allow_send else SEND_RULE,
        browser_rule=BROWSER_RULE if chrome else "",
        role_rule=role_rule)]
    if cards:
        parts.append("# Project context (selected for this task)\n")
        for c in cards:
            parts.append(f"## [{c['id']}] {c['title']}\n{c['text']}\n")
    return "\n".join(parts)


def mcp_cache():
    return load_json(home("mcp-tools.json"), {})


def server_tools(name, cfg, refresh=False, session=True):
    """Tool list for a server as {tool: ~tokens}, from cache, a direct stdio probe, or (any server type,
    with session=True) a one-turn Haiku session that connects the way a worker does; None if unknown."""
    cache = mcp_cache()
    if (not refresh and name in cache and cache[name].get("tools")
            and cache[name].get("key", config_key(cfg)) == config_key(cfg)):  # a plugin update changes the config
        return cache[name]["tools"]
    try:
        tools = lean_mcp.probe(cfg)
        entry = {"tools": {t["name"]: lean_mcp.tool_tokens(t) for t in tools if t.get("name")}, "status": "connected"}
    except lean_mcp.ProbeError:
        if not session:
            return None
        entry = session_probe_server(name, cfg)
    entry.update(probed=now_iso(), type=lean_mcp.server_type(cfg), key=config_key(cfg))
    cache = mcp_cache()
    cache[name] = entry
    save_json(home("mcp-tools.json"), cache)
    return entry["tools"] or None


def config_key(cfg):
    return hashlib.sha1(json.dumps(cfg, sort_keys=True).encode()).hexdigest()[:12]


def session_probe_server(name, cfg):
    """Connect to one server exactly as a worker would (same name and config, so a stored login is reused)
    and read its status and tool names; tokens per tool are the measured total split evenly."""
    print(f"lean-agent: connecting to {name} the way a worker does (one small Haiku call; cached)...",
          file=sys.stderr, flush=True)
    d = home("work", "mcp-probe")
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, "mcp.json")
    lean_mcp.write_config(path, {name: cfg})
    base = ["--setting-sources", "", "--strict-mcp-config"]
    try:
        cache = mcp_cache()
        baseline = (cache.get("_baseline") or {}).get("ctx")
        if not baseline:
            _, _, baseline = _probe_session(base, d)
            cache["_baseline"] = {"ctx": baseline, "probed": now_iso()}
            save_json(home("mcp-tools.json"), cache)
        tools, servers, ctx = _probe_session(base + ["--mcp-config", path], d)
    finally:
        os.remove(path)
    prefix = lean_mcp.tool_prefix(name)
    names = [t[len(prefix):] for t in tools if t.startswith(prefix)]
    status = next((x.get("status") for x in servers if x.get("name") == name), None) or "absent"
    each = max(0, ctx - baseline) // len(names) if names and baseline else 0
    return {"tools": {t: each for t in names}, "status": status, "estimated": True}


READ_TOOL_RE = re.compile(r"(^|[_-])(get|list|search|read|query|fetch|find|view|show|describe|count|lookup)([_-]|$)", re.I)


def mcp_presets(server, known=None):
    """{preset: [tools]} for a server: the user's presets plus an automatic `read` preset."""
    presets = dict(load_json(home("mcp-presets.json"), {}).get(server, {}))
    if known and "read" not in presets:
        read = sorted(t for t in known if READ_TOOL_RE.search(t))
        if read:
            presets["read"] = read
    return presets


def expand_tools(server, wanted, known):
    """Expand preset names in a --mcp tool list; keep real tool names."""
    presets = mcp_presets(server, known)
    out = []
    for t in wanted:
        if (known is None or t not in known) and t in presets:
            out += presets[t]
        else:
            out.append(t)
    return list(dict.fromkeys(out))


def unknown_server(name, available):
    names = [f"{n} ({al})" if al else n for n, al in sorted(lean_mcp.display_names(available).items())]
    die(f"unknown MCP server {name!r}; configured: {', '.join(names) or 'none'} (see: lean-agent mcp list)")


def canonical_specs(project, specs):
    """--mcp specs with plugin aliases replaced by full server names (plugin:<plugin>:<server>)."""
    available = lean_mcp.discover(project)
    out = []
    for name, wanted in lean_mcp.parse_specs(specs):
        full = lean_mcp.resolve_name(name, available)
        if not full:
            unknown_server(name, available)
        out.append(full + (":" + ",".join(wanted) if wanted else ""))
    return out


def resolve_mcp(project, specs):
    """Turn --mcp specs into (servers config, allowed tool rules, disallowed tool names)."""
    available = lean_mcp.discover(project)
    servers, allowed, disallowed = {}, [], []
    for name, wanted in lean_mcp.parse_specs(specs):
        if name not in available:
            unknown_server(name, available)
        cfg = available[name]["config"]
        servers[name] = cfg
        prefix = lean_mcp.tool_prefix(name)
        if not wanted:
            allowed.append(prefix.rstrip("_"))  # mcp__server: every tool of that server
            continue
        known = server_tools(name, cfg)
        wanted = expand_tools(name, wanted, known)
        if known is not None:
            unknown = [t for t in wanted if t not in known]
            if unknown:
                presets = ", ".join(sorted(mcp_presets(name, known))) or "none"
                die(f"{name} has no tool or preset {', '.join(unknown)}; presets: {presets}; "
                    f"tools: {', '.join(sorted(known))}")
            disallowed += [prefix + t for t in known if t not in wanted]
        else:
            print(f"lean-agent: tool list of {name} unknown (it didn't connect: `lean-agent mcp tools {name}`); "
                  "only the chosen tools are allowed, but the others' definitions still load", file=sys.stderr)
        status = (mcp_cache().get(name) or {}).get("status")
        if status and status != "connected":
            print(f"lean-agent: warning: {name} was {status} when lean-agent last connected to it as a worker "
                  f"(see: lean-agent doctor)", file=sys.stderr)
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

    wt = None
    if prev:
        slug, project = prev["project"], prev["project_path"]
        cards, workdir, run_id = [], prev["workdir"], prev["id"]
        tools = prev.get("tools", WORKER_TOOLS)
        read_only = prev.get("read_only", False)
        chrome_spec = prev.get("chrome")
        role_file = os.path.join(workdir, "role.md")
        role_rule = getattr(a, "role_rule", None) or (read_text(role_file) if os.path.exists(role_file) else "")
        lib = {c["id"]: c for c in load_cards(slug)}
        with open(os.path.join(workdir, "append.md"), "w") as fh:  # same context, current send/browser rules
            fh.write(build_append(project, [lib[c] for c in prev.get("cards", []) if c in lib], read_only,
                                  a.allow_send, bool(chrome_spec), role_rule))
    else:
        slug, project = resolve_project(a.project)
        sync_memory(slug)
        if getattr(a, "worktree", None):
            wt = ensure_worktree(slug, project, a.worktree)
            project = wt["path"]
            print(f"worktree: {wt['ref']} at {wt['path']} ({'reused' if wt['reused'] else 'created'}"
                  f"{', on branch ' + wt['branch'] if wt['branch'] else ', detached'})", flush=True)
        lib = {c["id"]: c for c in load_cards(slug)}
        wanted = [x for x in (a.cards or "").split(",") if x and x != "none"]
        if getattr(a, "card_list", None) is not None:  # chosen by the caller (e.g. `review`)
            cards = a.card_list
        elif a.cards == "auto":
            cards = suggest(slug, task, a.max_context,
                            getattr(a, "ttype", None) or task_type(task, a.read_only, bool(a.chrome)),
                            strict=True, limit=a.max_cards)
        else:
            missing = [x for x in wanted if x not in lib]
            if missing:
                die(f"unknown card(s): {', '.join(missing)} (see: lean-agent cards {slug})")
            ttype = getattr(a, "ttype", None) or task_type(task, a.read_only, bool(a.chrome))
            cards = [c for c in lib.values() if is_core(c, ttype) and not c.get("archived")]
            cards += [lib[x] for x in wanted if lib[x] not in cards]
        run_id = datetime.datetime.now().strftime("%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
        workdir = home("work", run_id)
        os.makedirs(workdir, exist_ok=True)
        read_only = bool(a.read_only)
        chrome_spec = a.chrome
        if chrome_spec and not re.match(r"^[\w,-]+$", chrome_spec):  # `--chrome "the task"`: it's the task
            task = (chrome_spec + " " + task).strip()
            chrome_spec = "all"
        for spec in list(a.mcp or []):  # --mcp claude-in-chrome[:tools] is an alias for --chrome[=tools]
            if spec.split(":", 1)[0] == CHROME:
                a.mcp.remove(spec)
                chrome_spec = spec.split(":", 1)[1] if ":" in spec else "all"
        role_rule = getattr(a, "role_rule", "") or ""
        if wt:
            role_rule = WORKTREE_RULE.format(**wt) + ("\n" + role_rule if role_rule else "")
        if role_rule:
            with open(os.path.join(workdir, "role.md"), "w") as fh:
                fh.write(role_rule)
        with open(os.path.join(workdir, "append.md"), "w") as fh:
            fh.write(build_append(project, cards, read_only, a.allow_send, bool(chrome_spec), role_rule))
        tools = a.tools or (READONLY_TOOLS + ",Bash" if read_only else WORKER_TOOLS)

    mcp_specs = prev.get("mcp") if prev else canonical_specs(project, a.mcp or [])
    mcp_servers, mcp_allowed, mcp_disallowed = resolve_mcp(project, mcp_specs) if mcp_specs else ({}, [], [])
    mcp_path = os.path.join(workdir, "mcp.json")
    chrome_allowed, chrome_disallowed, chrome_profile = resolve_chrome(chrome_spec, project) if chrome_spec else ([], [], None)
    if mcp_servers or chrome_spec:
        if mcp_servers:
            lean_mcp.write_config(mcp_path, mcp_servers)
        # --safe-mode disables MCP and Chrome; this keeps the same isolation but admits exactly these servers
        isolation = ["--setting-sources", ""]
        if chrome_profile != "loose":
            isolation += ["--strict-mcp-config"]
        if mcp_servers:
            isolation += ["--mcp-config", mcp_path]
        if chrome_spec:
            isolation += ["--chrome"]
        if mcp_disallowed or chrome_disallowed:
            isolation += ["--disallowedTools", ",".join(mcp_disallowed + chrome_disallowed)]
    else:
        isolation = ["--safe-mode"]
    if read_only:
        allowed = READONLY_TOOLS.split(",") + [f"Bash(git -C {project} {sub}:*)" for sub in READONLY_GIT]
        permission_mode = "default"
    else:
        allowed = [tools]
        permission_mode = os.environ.get("LEAN_AGENT_WORKER_PERMISSION_MODE") or "acceptEdits"

    claude = os.environ.get("LEAN_AGENT_CLAUDE") or "claude"
    cmd = [claude, "-p", "--output-format", "json", "--model", model,
           *isolation, "--disable-slash-commands",
           "--tools", tools, "--allowedTools", ",".join(allowed + mcp_allowed + chrome_allowed),
           "--permission-mode", permission_mode,
           "--add-dir", project,
           "--append-system-prompt-file", os.path.join(workdir, "append.md"),
           "--max-turns", str(a.max_turns)]
    role = getattr(a, "role", None) or (prev or {}).get("role")
    review_meta = getattr(a, "review_meta", None)
    if not review_meta and prev and role == "reviewer":  # `run --resume` of a reviewer: review what's there now
        review_meta, _ = refresh_review_meta(prev["project_path"], prev.get("review_meta") or {})
    effort = getattr(a, "effort", None) or (prev or {}).get("effort")
    if effort:
        cmd += ["--effort", effort]
    if a.max_usd > 0:
        cmd += ["--max-budget-usd", str(a.max_usd)]
    if prev:
        cmd += ["--resume", prev["session_id"]]

    env = dict(os.environ)
    env.pop("CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD", None)  # never pull in the project's CLAUDE.md
    env.setdefault("BASH_MAX_OUTPUT_LENGTH", os.environ.get("LEAN_AGENT_WORKER_BASH_OUTPUT") or "12000")
    env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "1"  # memory comes from lean-agent cards instead

    for line in mcp_cost_lines(mcp_specs, chrome_spec):
        print(line, flush=True)

    wt_name = (prev or {}).get("worktree") or (wt and wt["name"])
    wt_lock = worktree_lock(slug, wt_name, read_only) if wt_name else contextlib.nullcontext()
    started = datetime.datetime.now()
    started_utc = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    try:
        with wt_lock:
            proc = subprocess.run(cmd, input=today_line() + "\n\n" + task, capture_output=True, text=True,
                                  cwd=workdir, env=env,
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
    mcp_seq = (lean_mcp.mcp_call_sequence(workdir, out.get("session_id"), started_utc)
               if (mcp_specs or chrome_spec) else [])
    offered = offered_tools(mcp_specs)
    review = None
    if role == "reviewer":
        summary, review = parse_marker(summary, "LEAN-REVIEW")
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
    run_type = (prev or {}).get("type") or getattr(a, "ttype", None) or task_type(task, read_only, bool(chrome_spec))
    used, unneeded = set(fb.get("used") or []), set(fb.get("unneeded") or [])
    sent = {c["id"] for c in cards}
    if sent or used or unneeded:
        with library_lock(slug):
            lib = load_cards(slug)
            for c in lib:
                bt = c.setdefault("by_type", {}).setdefault(run_type, {"offered": 0, "used": 0, "unneeded": 0})
                if c["id"] in sent:
                    c["offered"] += 1
                    bt["offered"] += 1
                if c["id"] in used:
                    c["used"] += 1
                    bt["used"] += 1
                if c["id"] in unneeded:
                    c["unneeded"] += 1
                    bt["unneeded"] += 1
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
        "parent_session": os.environ.get("CLAUDE_CODE_SESSION_ID"),
        "mcp": mcp_specs, "mcp_calls": {t: mcp_seq.count(t) for t in dict.fromkeys(mcp_seq)},
        "mcp_seq": mcp_seq[:60], "mcp_offered": {k: len(v) for k, v in offered.items()},
        "result_head": (summary or "")[:600],
        "read_only": read_only, "chrome": chrome_spec, "allow_send": bool(a.allow_send), "type": run_type,
        "role": role, "effort": effort, "worktree": wt_name, "review_meta": review_meta,
    }
    append_jsonl(home("ledger.jsonl"), entry)
    if not isinstance(sys.stdout, Tee):
        sys.stdout = Tee(sys.stdout, os.path.join(workdir, f"summary-{len(glob.glob(os.path.join(workdir, 'summary-*.txt'))) + 1}.txt"))
    lean_log.log("error" if entry["status"] in ("failed", "error") or entry["status"].startswith("stopped") else "debug",
                 "run", f"{run_id} {slug} {model} {entry['status']} {entry.get('turns') or '?'} turns "
                 f"{entry.get('units', 0):,} sonnet-eq ${entry.get('cost_usd') or 0:.2f}"
                 f"{' role ' + role if role else ''}: {task[:160]!r}"
                 + (f"; worker said: {str(out.get('result') or '')[:300]!r}" if entry["status"] in ("failed", "error") else ""))

    cost = f"${entry['cost_usd']:.2f}" if isinstance(entry["cost_usd"], (int, float)) else "$?"
    print(f"run {run_id} · {model} · {status} · {entry['turns'] or '?'} turns · {seconds}s · "
          f"{entry['units']:,} sonnet-eq tok · {cost}")
    print(f"  tokens: input {u.get('input_tokens', 0):,} · cache write {u.get('cache_creation_input_tokens', 0):,}"
          f" · cache read {u.get('cache_read_input_tokens', 0):,} · output {u.get('output_tokens', 0):,}")
    ctx = u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0) + u.get("cache_read_input_tokens", 0)
    if ctx and entry["turns"]:
        per_turn = ctx // max(1, entry["turns"])
        own = est_tokens(read_text(os.path.join(workdir, "append.md")))
        ext = tools_overhead(mcp_specs, mcp_allowed, chrome_spec)
        n_off, n_used = sum(len(v) for v in offered.values()), len(set(mcp_seq))
        tools_note = f" ({n_off} offered, {n_used} used)" if offered else ""
        print(f"  context per turn ~{per_turn:,}: lean-agent protocol + cards ~{own:,} · MCP/browser tools ~{ext:,}"
              f"{tools_note} · Claude Code system prompt, built-in tools, conversation ~{max(0, per_turn - own - ext):,}")
    for line in narrowing_hints(offered, mcp_seq):
        print("  " + line)
    line, low = budget_line()
    if line:
        print("  " + line)
    limit = env_num("LEAN_AGENT_RESULT_CHARS", 12000)
    if summary:
        print(summary if len(summary) <= limit else summary[:limit] + f"\n… [{len(summary) - limit} chars more in {workdir}/result.json]")
    elif status == "error":
        print((err or raw)[-1500:].strip())
    if fb:
        print(f"feedback: used={sorted(used)} unneeded={sorted(unneeded)}" + (f" missing={missing_note!r}" if missing_note else ""))
    if remembered:
        print(f"remembered: {', '.join(remembered)}")
    if status == "needs-input":
        print("ACTION NEEDED: the worker needs an answer (see above). Ask the user, then: "
              f"lean-agent run --resume {run_id} \"<answer>\"")
    elif status == "awaiting-confirmation":
        print("ACTION NEEDED: an outward action is prepared but NOT done. Show the user exactly what would happen. "
              f"Only if they approve: lean-agent run --resume {run_id} --allow-send \"<what was approved>\" \"Do it now\"")
    if mcp_specs or chrome_spec:
        calls = entry["mcp_calls"]
        print("mcp: " + (", ".join(f"{k} x{v}" for k, v in sorted(calls.items())) or "no MCP tool calls"))
    print(f"resume: lean-agent run --resume {run_id} \"<follow-up>\"")
    if role == "reviewer":
        return report_review(slug, entry["project_path"], entry, review or {}, review_meta or {})
    return 0 if status in ("done", "partial", "needs-input", "awaiting-confirmation") else 1


def today_line():
    """The worker's first line, so 'last Monday' or 'this morning' needs no brief."""
    now = datetime.datetime.now().astimezone()
    off = now.strftime("%z")
    return (f"Today is {now:%A %Y-%m-%d}, {now:%H:%M} {now.tzname() or ''} "
            f"(UTC{off[:3]}:{off[3:]}).").replace("  ", " ")


def offered_tools(mcp_specs):
    """{server: [tool names the run was given]} for servers whose tool list is known."""
    out, cache = {}, mcp_cache()
    for name, wanted in lean_mcp.parse_specs(mcp_specs):
        known = (cache.get(name) or {}).get("tools")
        if known:
            out[name] = expand_tools(name, wanted, known) if wanted else list(known)
    return out


def narrowing_hints(offered, mcp_seq):
    """'offered N tools, used M' plus the --mcp spec (or a saved preset) that would have been enough."""
    lines, cache = [], mcp_cache()
    for name, tools in offered.items():
        prefix = lean_mcp.tool_prefix(name)
        used = list(dict.fromkeys(t[len(prefix):] for t in mcp_seq if t.startswith(prefix)))
        if len(used) >= len(tools):
            continue
        known = (cache.get(name) or {}).get("tools") or {}
        cost = lambda ts: sum(known.get(t, 0) for t in ts)
        line = f"mcp: {name} offered {len(tools)} tools (~{cost(tools):,} tok/turn), used {len(used)}"
        if not used:
            lines.append(line + f": next time leave out --mcp {name}")
            continue
        fits = [(p, ts) for p, ts in mcp_presets(name, known).items() if set(used) <= set(ts) and len(ts) < len(tools)]
        if fits:
            p, ts = min(fits, key=lambda x: cost(x[1]))
            lines.append(line + f": preset {name}:{p} covers it (~{cost(ts):,} tok)")
        else:
            lines.append(line + f" ({', '.join(used)}): next time --mcp {name}:{','.join(used)} (~{cost(used):,} tok), "
                         f"or save it: lean-agent mcp preset {name} <name> {','.join(used)}")
    return lines


def mcp_cost_lines(mcp_specs, chrome_spec):
    """One line per MCP server (and the browser) with the per-turn cost of the chosen tools."""
    lines, cache = [], mcp_cache()
    for name, wanted in lean_mcp.parse_specs(mcp_specs):
        known = (cache.get(name) or {}).get("tools")
        if not known:
            lines.append(f"mcp: {name} (tool cost unknown; measure with `lean-agent mcp tools {name}`)")
            continue
        chosen = expand_tools(name, wanted, known) if wanted else list(known)
        cost, whole = sum(known.get(t, 0) for t in chosen), sum(known.values())
        line = f"mcp: {name} {len(chosen)}/{len(known)} tools ~{cost:,} tok per turn (whole server ~{whole:,})"
        if not wanted and whole > 5000:
            line += f"; narrow it: --mcp {name}:<preset|tool,...> (presets: lean-agent mcp preset {name})"
        lines.append(line)
    if chrome_spec:
        st = chrome_state()
        n = len(st.get("tools") or [])
        k = n if chrome_spec == "all" else len(chrome_spec.split(","))
        lines.append(f"browser: {k}/{n} Claude in Chrome tools ~{tools_overhead([], [], chrome_spec):,} tok per turn")
    return lines


def tools_overhead(mcp_specs, mcp_allowed, chrome_spec):
    """Estimated tokens per turn for the MCP and browser tool definitions a run carries."""
    total, cache = 0, mcp_cache()
    for name, wanted in lean_mcp.parse_specs(mcp_specs):
        tools = (cache.get(name) or {}).get("tools") or {}
        chosen = set(expand_tools(name, wanted, tools)) if wanted else set(tools)
        total += sum(v for t, v in tools.items() if t in chosen)
    if chrome_spec:
        st = chrome_state()
        all_tools = st.get("tools") or []
        share = 1.0 if chrome_spec == "all" or not all_tools else len(chrome_spec.split(",")) / len(all_tools)
        total += int(st.get("tokens", 0) * min(1.0, share))
    return total


def budget_line():
    """('budget left: 5h 62% · week 80%', low?) for the plan windows that have a budget."""
    budgets, pbud = usage.window_budgets(), usage.pct_budgets()
    if not any(budgets.values()) and not pbud:
        return "", False
    w = usage.window_usage()
    parts, low = [], False
    for name, label in (("5h", "session"), ("week", "week")):
        if budgets[name]:
            left = max(0, 100 - w[name]["lean"] * 100 // budgets[name])
            parts.append(f"{label} {left}%")
            low = low or left < 25
        cap = pbud.get("session" if name == "5h" else "week")
        if cap and w[name]["plan_pct"] is not None:
            left = max(0, round(100 - w[name]["plan_pct"] * 100 / cap))
            parts.append(f"{label} {left}% of your {cap}% plan share")
            low = low or left < 25
    text = "budget left: " + " · ".join(parts)
    if low:
        text += " (low: prefer -m haiku, --read-only and smaller steps)"
    return text, low


REVIEWER_RULE = """\
Role: you are the reviewer and tech lead for this change, the last quality gate before a pull request.
Workers wrote it cheaply; your job is to make sure the quality is still right. You can only read code
and git history. You can't run tests, build, or change anything, and you mustn't try.

The change: {scope}
Start with `git -C {project} diff --stat {diff_range}`, then read each file's diff with
`git -C {project} diff {diff_range} -- <file>`, and only the surrounding code you need (line ranges).
{read_rule}

Judge what matters: correctness (logic, edge cases, error handling, concurrency), whether it does what
the change intends, consistency with the project rules in your context, tests (do they cover the change
and would they catch a regression?), security, data/migration/API compatibility, and performance
pitfalls. Skip what a linter or formatter catches. Be specific (file:line, what, why, a concrete
suggestion), and don't pad: if the change is good, approve it.

Severity: blocker (must fix before the PR), major (should fix), minor, nit.
Verdict: "approve" (no blockers or majors), "changes-requested", or "needs-checks" (you can't judge
without something being run or verified; list exactly what under "checks").

Before the LEAN-FEEDBACK line, add one line exactly like this (valid JSON, one line):
LEAN-REVIEW {{"verdict": "approve|changes-requested|needs-checks", "findings": [{{"severity": "blocker|major|minor|nit", "file": "path", "line": 0, "issue": "...", "why": "...", "suggestion": "..."}}], "checks": [{{"what": "what to run or verify", "why": "..."}}]}}
"""


def git(path, *args):
    p = subprocess.run(["git", "-C", path, *args], capture_output=True, text=True)
    return p.stdout.strip() if p.returncode == 0 else None


def default_base(path):
    ref = git(path, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD")
    if ref:
        return ref.replace("refs/remotes/", "")
    for cand in ("origin/main", "origin/master", "origin/develop", "main", "master", "develop"):
        if git(path, "rev-parse", "--verify", "--quiet", cand):
            return cand
    return None


def untracked_files(path):
    return (git(path, "ls-files", "--others", "--exclude-standard") or "").split()


def review_state(path):
    """A fingerprint of what's being reviewed: HEAD plus uncommitted and untracked changes."""
    head = git(path, "rev-parse", "HEAD") or "?"
    h = hashlib.sha1((git(path, "diff", "HEAD") or "").encode())
    new = untracked_files(path)
    for f in new:
        h.update(f.encode())
        try:
            with open(os.path.join(path, f), "rb") as fh:
                h.update(fh.read())
        except OSError:
            pass
    dirty = bool(git(path, "diff", "HEAD")) or bool(new)
    return head, h.hexdigest()[:12] if dirty else ""


def reviews_path(slug):
    return home("reviews", slug + ".jsonl")


def review_target(path, ref=None):
    """(commit, dirty fingerprint, label, mode) of what a review covers: a ref, or the working tree."""
    if ref:
        sha = git(path, "rev-parse", "--verify", "--quiet", ref + "^{commit}")
        if not sha:
            die(f"unknown ref {ref!r} in {path} (fetch it first, or check the name)")
        return sha, "", ref, "ref"
    head, dirty = review_state(path)
    branch = git(path, "rev-parse", "--abbrev-ref", "HEAD") or "HEAD"
    return head, dirty, branch, "worktree"


def find_review(slug, path, ref=None):
    """The latest review covering exactly the current state of `ref` (or of the working tree)."""
    sha, dirty, label, mode = review_target(path, ref)
    for r in reversed(list(read_jsonl(reviews_path(slug)))):
        if r["head"] == sha and r.get("dirty", "") == dirty:
            return r, (sha, label)
    return None, (sha, label)


def refresh_review_meta(path, meta, fetch=True):
    """The review's target moved on (fixes landed): point the meta at what's there now. Returns (meta, where)."""
    meta = dict(meta)
    if meta.get("mode") == "ref":
        if meta.get("ref", "").startswith("origin/") and fetch:
            git(path, "fetch", "-q", "origin")
        sha, _, _, _ = review_target(path, meta["ref"])
        meta["head"] = sha
        rng = f"{meta['merge_base']} {sha}"
        where = (f"{meta['ref']} is now at {sha[:12]}. Re-review `git -C {path} diff {rng}`; read files with "
                 f"`git -C {path} show {sha}:<path>` (they are not checked out).")
    else:
        meta["head"], meta["dirty"] = review_state(path)
        where = f"Re-review the current diff from {meta.get('merge_base')} to the working tree."
    return meta, where


def previous_findings(slug, label, mode):
    """The latest recorded review of the same branch/ref, for a fresh review to check against."""
    for r in reversed(list(read_jsonl(reviews_path(slug)))):
        if r.get("ref") == label and r.get("mode", "worktree") == mode:
            return r
    return None


def cmd_review(a):
    slug, path = resolve_project(a.project)
    if a.head and a.head.startswith("origin/") and not a.no_fetch:
        git(path, "fetch", "-q", "origin")  # updates remote refs only; the working tree isn't touched
    if a.status:
        match, (sha, label) = find_review(slug, path, a.head)
        if match:
            print(f"review {match['run']} of {label} @ {sha[:12]}: {match['verdict']}")
            return 0 if match["verdict"] == "approve" else 1
        last = (list(read_jsonl(reviews_path(slug))) or [None])[-1]
        if not last:
            print(f"No review yet. Run: lean-agent review {slug}" + (f" --head {a.head}" if a.head else ""))
        else:
            what = f"{last.get('ref') or '?'} @ {last['head'][:12]}"
            why = ("uncommitted changes differ from the reviewed state" if last["head"] == sha
                   else "new commits since")
            print(f"stale: no review covers {label} @ {sha[:12]} as it is now ({why}). The latest review "
                  f"({last['run']}, {last['verdict']}) was of {what}"
                  + ("" if a.head or last.get("mode") != "ref" else f"; check it with --status --head {last['ref']}")
                  + ".")
        return 1
    model = os.environ.get("LEAN_AGENT_REVIEW_MODEL") or "sonnet"
    effort = os.environ.get("LEAN_AGENT_REVIEW_EFFORT") or "high"
    line, low = budget_line()
    if low:
        print(f"lean-agent: budget is low, but the reviewer stays on {model} (effort {effort}): quality gate.",
              file=sys.stderr)
    if a.resume:
        def matches(r):
            m = r.get("review_meta") or {}
            if a.head:
                return m.get("mode") == "ref" and m.get("ref") == a.head
            return True
        prev = next((r for r in reversed(ledger()) if r.get("role") == "reviewer" and r["project"] == slug
                     and matches(r)), None)
        if not prev:
            die(f"no earlier review of {a.head or slug} to resume"
                + (f"; start one: lean-agent review {slug} --head {a.head}" if a.head else ""))
        meta, where = refresh_review_meta(path, prev.get("review_meta") or {}, fetch=not a.no_fetch)
        print(f"re-review of {meta.get('ref') or '?'} @ {meta['head'][:12]} (resuming reviewer {prev['id']})",
              flush=True)
        task = (f"The change was updated after your review. {where} Check whether each earlier finding is "
                "resolved, and look for new problems. " + (a.focus or ""))
        ns = argparse.Namespace(resume=prev["id"], task=[task], task_file=None, model=None, why=None, cards=None,
                                project=None, read_only=True, chrome=None, mcp=None, tools=None, allow_send=None,
                                max_turns=a.max_turns, max_usd=a.max_usd, max_context=4000, role="reviewer",
                                effort=effort, review_meta=meta)
        return cmd_run(ns)
    base = a.base or default_base(path)
    if not base:
        die("no base branch found; pass --base <branch>")
    sha, dirty, label, mode = review_target(path, a.head)
    merge_base = git(path, "merge-base", base, sha)
    if not merge_base:
        die(f"can't find a merge base between {base} and {label} in {path}")
    if mode == "ref":
        rng = f"{merge_base} {sha}"
        names = (git(path, "diff", "--name-only", merge_base, sha) or "").split()
        new = []
        stat = git(path, "diff", "--stat", merge_base, sha) or ""
        scope = (f"the commits on {label} since it branched from {base} (merge base {merge_base[:12]}), "
                 f"up to {sha[:12]}: {len(names)} files.")
        read_rule = (f"These files are NOT checked out (the working tree is on something else). Read them at the "
                     f"reviewed commit with `git -C {path} show {sha}:<path>`, and use `git -C {path} grep -n <pattern> "
                     f"{sha}` to search. Never read the working-tree copies, they're a different version.")
    else:
        rng = merge_base
        new = untracked_files(path)
        names = (git(path, "diff", "--name-only", merge_base) or "").split() + new
        stat = git(path, "diff", "--stat", merge_base) or ""
        if new:
            stat += "\nNew files not yet tracked by git (not in the diff; Read them in full):\n" + "\n".join(
                f" {f}" for f in new)
        scope = (f"everything since branching from {base} (merge base {merge_base[:12]}) up to the working tree"
                 + (", including uncommitted changes" if dirty else "") + f": {len(names)} files"
                 + (f", {len(new)} of them new and untracked (read those directly)" if new else "") + ".")
        read_rule = ""
    if not names:
        die(f"nothing to review: no changes on {label} since {base}")
    path_words = " ".join(re.split(r"[/._-]+", " ".join(names)))
    cards = suggest(slug, path_words + " " + (a.focus or ""), a.max_context, "review")
    task = f"Review this change before it becomes a pull request.\n\nFiles changed:\n{stat}\n"
    earlier = previous_findings(slug, label, mode)
    if earlier and (earlier.get("findings") or earlier.get("checks")):
        lines = [f"- [{f.get('severity', '?')}] {f.get('file', '?')}:{f.get('line', '')} {f.get('issue', '')}"[:240]
                 for f in earlier.get("findings", [])[:15]]
        lines += [f"- [check] {c.get('what', '')}"[:240] for c in earlier.get("checks", [])[:5]]
        task += (f"\nAn earlier review of {label} (at {earlier['head'][:12]}, verdict {earlier['verdict']}) found:\n"
                 + "\n".join(lines) + "\nSay for each whether it is resolved now; don't repeat resolved ones as "
                 "findings. Still look at the whole change.\n")
        print(f"review: passing {len(lines)} earlier findings from review {earlier['run']} of {label}", flush=True)
    if a.focus:
        task += f"\nThe author asks you to look closely at: {a.focus}\n"
    meta = {"base": base, "merge_base": merge_base, "head": sha, "dirty": dirty, "ref": label, "mode": mode,
            "files": len(names)}
    ns = argparse.Namespace(resume=None, task=[task], task_file=None, model=model,
                            why=f"pre-PR review ({effort} effort)", cards=None, card_list=cards, project=slug,
                            read_only=True, chrome=None, mcp=None, tools=None, allow_send=None, max_turns=a.max_turns,
                            max_usd=a.max_usd, max_context=a.max_context, ttype="review", role="reviewer",
                            effort=effort, review_meta=meta,
                            role_rule=REVIEWER_RULE.format(scope=scope, project=path, diff_range=rng,
                                                           read_rule=read_rule))
    return cmd_run(ns)


def report_review(slug, project, entry, review, meta):
    verdict = review.get("verdict") or "unknown"
    findings = [f for f in review.get("findings") or [] if isinstance(f, dict)]
    checks = [c for c in review.get("checks") or [] if isinstance(c, dict)]
    if meta.get("mode") == "ref":
        head, dirty = meta["head"], ""
    else:  # the working tree as it is now, after the review
        head, dirty = review_state(project)
    append_jsonl(reviews_path(slug), {"ts": now_iso(), "run": entry["id"], "verdict": verdict, "head": head,
                                      "dirty": dirty, "ref": meta.get("ref"), "mode": meta.get("mode", "worktree"),
                                      "base": meta.get("base"), "findings": findings, "checks": checks})
    order = {"blocker": 0, "major": 1, "minor": 2, "nit": 3}
    label = meta.get("ref") or "the working tree"
    print(f"\nREVIEW: {verdict.upper()} · {len(findings)} findings · {len(checks)} checks to run"
          f" · recorded for {label} @ {head[:12]}" + (" + uncommitted changes" if dirty else ""))
    for f in sorted(findings, key=lambda f: order.get(f.get("severity"), 9)):
        loc = f"{f.get('file', '?')}:{f.get('line', '')}".rstrip(":")
        print(f"  [{f.get('severity', '?')}] {loc}: {f.get('issue', '')}")
        if f.get("suggestion"):
            print(f"      fix: {f['suggestion']}")
    for c in checks:
        print(f"  [check] {c.get('what', '')}" + (f" ({c['why']})" if c.get("why") else ""))
    blocking = [f for f in findings if f.get("severity") in ("blocker", "major")]
    if verdict == "approve" and not blocking:
        print("Approved: OK to prepare the PR (still an outward action: ask the user before creating it).")
        return 0
    print("NOT approved. Delegate fixes (blockers/majors) and the checks to workers, then re-review: "
          f"lean-agent review {slug} --resume")
    return 2


WORKTREE_RULE = """\
Worktree: you work in a lean-agent git worktree of {ref} at {path}. It is shared with other
workers and is NOT the user's checkout. {commit_rule}
Dependencies and build output persist between workers, so check before installing (e.g. whether
node_modules or a virtualenv already exists) and install only what's missing. Don't delete, reset
or clean anything you didn't create.
"""


def worktree_index():
    return load_json(home("worktrees.json"), {})


def ensure_worktree(slug, repo, ref):
    """A shared worktree of `ref` for this project: reuse it (moved to the ref's tip when clean) or create it."""
    if ref.startswith("origin/"):
        git(repo, "fetch", "-q", "origin")
    sha = git(repo, "rev-parse", "--verify", "--quiet", ref + "^{commit}")
    if not sha:
        die(f"unknown ref {ref!r} in {repo}")
    name = slugify(ref.replace("/", "-"), 60)
    path = home("worktrees", slug, name)
    reused = os.path.isdir(path) and git(path, "rev-parse", "--git-dir") is not None
    remote_branch = ref[len("origin/"):] if ref.startswith("origin/") else None
    if reused:
        branch = git(path, "symbolic-ref", "--quiet", "--short", "HEAD")
        if git(path, "status", "--porcelain", "--untracked-files=no"):
            print(f"lean-agent: worktree {path} has uncommitted changes; using it as it is", file=sys.stderr)
        elif not branch:
            git(path, "checkout", "-q", "--detach", sha)
        elif remote_branch and git(path, "merge", "-q", "--ff-only", sha) is None:
            print(f"lean-agent: branch {branch} in {path} has commits that aren't on {ref} (not pushed yet?); "
                  "leaving it as it is", file=sys.stderr)
    else:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        branch = None
        local = remote_branch or ref
        if remote_branch and not git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/" + local):
            # a PR branch from the remote: a local branch that tracks it, so fixes can be pushed back
            p = subprocess.run(["git", "-C", repo, "worktree", "add", "-q", "--track", "-b", local, path, ref],
                               capture_output=True, text=True)
            branch = local if p.returncode == 0 else None
        elif git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/" + local):
            p = subprocess.run(["git", "-C", repo, "worktree", "add", "-q", path, local], capture_output=True, text=True)
            branch = local if p.returncode == 0 else None  # fails when the branch is checked out elsewhere
            if branch and remote_branch and git(path, "merge", "-q", "--ff-only", sha) is None:
                print(f"lean-agent: local branch {local} has commits that aren't on {ref}; using it as it is",
                      file=sys.stderr)
        if not branch:
            p = subprocess.run(["git", "-C", repo, "worktree", "add", "-q", "--detach", path, sha],
                               capture_output=True, text=True)
            if p.returncode != 0:
                die(f"git worktree add failed: {(p.stderr or p.stdout).strip()[:300]}")
    setup = (projects().get(slug) or {}).get("worktree_setup")
    idx_entry = (worktree_index().get(slug) or {}).get(name) or {}
    if setup and (not reused or idx_entry.get("setup") not in ("ok", "running")):
        run_worktree_setup(slug, name, path, setup)
    idx = worktree_index()
    entry = idx.setdefault(slug, {}).get(name, {"created": now_iso()})
    entry.update(path=path, ref=ref, sha=sha, branch=branch, repo=repo, last_used=now_iso())
    idx[slug][name] = entry
    save_json(home("worktrees.json"), idx)
    commit_rule = (f"It's on branch {branch}, so commits you make land on that branch. Never push: lean-agent "
                   "pushes after review and the user's approval."
                   if branch else "It's a detached checkout: commits here are on no branch, so don't commit "
                   "unless the task asks you to.")
    return {"path": path, "name": name, "ref": ref, "branch": branch, "reused": reused, "commit_rule": commit_rule}


def run_worktree_setup(slug, name, path, command):
    """The project's setup command (install, build) in a new worktree, once; output goes to a log file."""
    log = home("worktrees", slug, f".{name}.setup.log")
    print(f"worktree setup: {command}", flush=True)

    def mark(state):
        idx = worktree_index()
        idx.setdefault(slug, {}).setdefault(name, {"created": now_iso()})["setup"] = state
        save_json(home("worktrees.json"), idx)
    mark("running")
    t0 = time.time()
    with open(log, "w") as fh:
        try:
            rc = subprocess.run(command, shell=True, cwd=path, stdout=fh, stderr=subprocess.STDOUT,
                                stdin=subprocess.DEVNULL, timeout=3600).returncode
        except subprocess.TimeoutExpired:
            rc = 124
    mark("ok" if rc == 0 else f"failed ({rc})")
    if rc == 0:
        print(f"worktree setup: done in {time.time() - t0:.0f}s (log {log})", flush=True)
    else:
        with open(log, errors="replace") as fh:
            tail = "".join(fh.readlines()[-15:])
        print(f"worktree setup FAILED (exit {rc}); the worker starts anyway. Last lines of {log}:\n{tail}",
              file=sys.stderr, flush=True)


@contextlib.contextmanager
def worktree_lock(slug, name, shared):
    """Read-only workers share a worktree; workers that change files get it to themselves."""
    path = home("worktrees", slug, f".{name}.lock")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        if fcntl:
            mode = fcntl.LOCK_SH if shared else fcntl.LOCK_EX
            try:
                fcntl.flock(fh, mode | fcntl.LOCK_NB)
            except OSError:
                print(f"lean-agent: waiting for another worker using worktree {name}...", file=sys.stderr, flush=True)
                fcntl.flock(fh, mode)
        try:
            yield
        finally:
            if fcntl:
                fcntl.flock(fh, fcntl.LOCK_UN)


def cmd_worktrees(a):
    idx = worktree_index()
    slugs = [resolve_project(a.project)[0]] if a.project else sorted(idx)
    found = False
    for slug in slugs:
        for name, w in sorted((idx.get(slug) or {}).items()):
            if not os.path.isdir(w["path"]):
                continue
            found = True
            dirty = " (uncommitted changes)" if git(w["path"], "status", "--porcelain") else ""
            print(f"{slug:<16} {w['ref']:<36} {'branch ' + w['branch'] if w.get('branch') else 'detached':<24} "
                  f"last used {w['last_used'][:16]}{dirty}\n{'':<17}{w['path']}")
    if not found:
        print("No lean-agent worktrees. Workers get one with: lean-agent run <project> --worktree <branch> ...")


def cmd_worktree(a):
    if a.action == "setup":
        return worktree_setup_cmd(a)
    if a.action == "push":
        return worktree_push(a)
    if not a.ref:
        die("which worktree? lean-agent worktree rm <project> <ref>")
    slug, repo = resolve_project(a.project)
    idx = worktree_index()
    name = slugify(a.ref.replace("/", "-"), 60)
    w = (idx.get(slug) or {}).get(name)
    if not w:
        die(f"no lean-agent worktree for {a.ref} in {slug} (see: lean-agent worktrees {slug})")
    if os.path.isdir(w["path"]) and git(w["path"], "status", "--porcelain") and not a.force:
        die(f"{w['path']} has uncommitted changes; pass --force to remove it anyway")
    p = subprocess.run(["git", "-C", repo, "worktree", "remove"] + (["--force"] if a.force else []) + [w["path"]],
                       capture_output=True, text=True)
    if p.returncode != 0 and os.path.isdir(w["path"]):
        die(f"git worktree remove failed: {(p.stderr or p.stdout).strip()[:300]}")
    del idx[slug][name]
    save_json(home("worktrees.json"), idx)
    print(f"removed {w['path']}")


def worktree_setup_cmd(a):
    slug, _ = resolve_project(a.project)
    projs = projects()
    command = a.command
    if a.off:
        projs[slug].pop("worktree_setup", None)
        save_json(home("projects.json"), projs)
        print(f"{slug}: no setup command for new worktrees")
        return 0
    if command:
        projs[slug]["worktree_setup"] = command
        save_json(home("projects.json"), projs)
    cur = projs[slug].get("worktree_setup")
    print(f"{slug}: new worktrees run: {cur}" if cur else
          f"{slug}: no setup command. Set one: lean-agent worktree setup {slug} --run \"npm ci && npm run build\"")
    if command and a.ref:
        w = (worktree_index().get(slug) or {}).get(slugify(a.ref.replace("/", "-"), 60))
        if not w:
            die(f"no lean-agent worktree for {a.ref} in {slug}")
        run_worktree_setup(slug, slugify(a.ref.replace("/", "-"), 60), w["path"], command)
    return 0


def worktree_push(a):
    """Push a worktree's branch to origin: an outward action, so it needs a review and the user's approval."""
    slug, repo = resolve_project(a.project)
    if not a.ref:
        die("which branch? lean-agent worktree push <project> <ref>")
    w = (worktree_index().get(slug) or {}).get(slugify(a.ref.replace("/", "-"), 60))
    if not w or not os.path.isdir(w["path"]):
        die(f"no lean-agent worktree for {a.ref} in {slug} (see: lean-agent worktrees {slug})")
    path, branch = w["path"], git(w["path"], "symbolic-ref", "--quiet", "--short", "HEAD")
    if not branch:
        die(f"{path} is a detached checkout: there's no branch to push")
    if git(path, "status", "--porcelain", "--untracked-files=no"):
        die(f"{path} has uncommitted changes: have a worker commit them (or discard them) first")
    upstream = git(path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
    remote_ref = upstream or f"origin/{branch}"
    if not a.no_fetch:
        git(path, "fetch", "-q", "origin")
    has_remote = git(path, "rev-parse", "--verify", "--quiet", remote_ref) is not None
    if has_remote and git(path, "merge-base", "--is-ancestor", remote_ref, "HEAD") is None:
        die(f"{remote_ref} has commits that {branch} doesn't have: someone else pushed. Let a worker merge or "
            f"rebase onto {remote_ref} in the worktree, review again, then push. (lean-agent never force-pushes.)")
    commits = (git(path, "log", "--oneline", f"{remote_ref}..HEAD") if has_remote
               else git(path, "log", "--oneline", "-20", "HEAD")) or ""
    if has_remote and not commits:
        print(f"nothing to push: {branch} is the same as {remote_ref}")
        return 0
    sha = git(path, "rev-parse", "HEAD")
    match, _ = find_review(slug, path, "HEAD")
    if not match or match["verdict"] != "approve":
        die(f"{branch} @ {sha[:12]} has no approving review. Run: lean-agent review {slug} --head {branch}"
            + (f" --base <base>" if not has_remote else ""), 2)
    target = remote_ref.split("/", 1)[1] if "/" in remote_ref else branch
    print(f"push {branch} @ {sha[:12]} to origin/{target}" + ("" if has_remote else " (a new remote branch)")
          + f", reviewed in {match['run']}:\n" + "\n".join("  " + c for c in commits.splitlines()))
    if not a.allow_send:
        print("ACTION NEEDED: pushing is an outward action and was NOT done. Show the user the commits above. Only if "
              f"they approve: lean-agent worktree push {slug} {a.ref} --allow-send \"<what the user approved>\"")
        return 2
    p = subprocess.run(["git", "-C", path, "push", "origin", f"HEAD:refs/heads/{target}"],
                       capture_output=True, text=True)
    append_jsonl(home("pushes.jsonl"), {"ts": now_iso(), "project": slug, "branch": branch, "to": f"origin/{target}",
                                        "sha": sha, "review": match["run"], "approved": a.allow_send,
                                        "ok": p.returncode == 0})
    if p.returncode != 0:
        die(f"git push failed: {(p.stderr or p.stdout).strip()[:400]}")
    if not upstream:
        git(path, "branch", "-q", f"--set-upstream-to=origin/{target}")
    print(f"pushed {branch} @ {sha[:12]} to origin/{target}")
    return 0


def chrome_state():
    return load_json(home("chrome.json"), {})


def resolve_chrome(spec, project):
    """(allowed rules, disallowed tool names, profile) for a --chrome[=tools] run."""
    st = chrome_state()
    if not st.get("ok"):
        die("Claude in Chrome hasn't been verified for workers yet: run `lean-agent chrome check` once "
            "(Chrome running, extension installed and signed in)")
    prefix = lean_mcp.tool_prefix(CHROME)
    known = st.get("tools") or []
    disallowed = []
    if st.get("profile") == "loose":  # no --strict-mcp-config: keep the user's other MCP servers out
        disallowed += [lean_mcp.tool_prefix(n).rstrip("_") for n in lean_mcp.discover(project)]
    if spec in (None, "", "all"):
        return [prefix.rstrip("_")], disallowed, st.get("profile")
    wanted = [t.strip() for t in spec.split(",") if t.strip()]
    unknown = [t for t in wanted if known and t not in known]
    if unknown:
        die(f"{CHROME} has no tool(s) {', '.join(unknown)}; it has: {', '.join(known)}")
    disallowed += [prefix + t for t in known if t not in wanted]
    return [prefix + t for t in wanted], disallowed, st.get("profile")


def _probe_session(extra, cwd):
    """Start a 1-turn Haiku session; return (tool names, mcp servers, context tokens) from its stream."""
    claude = os.environ.get("LEAN_AGENT_CLAUDE") or "claude"
    cmd = [claude, "-p", "--output-format", "stream-json", "--verbose", "--model", "haiku",
           "--disable-slash-commands", "--tools", "Read", "--max-turns", "1", *extra]
    try:
        out = subprocess.run(cmd, input="Reply with just OK. Do not use tools.", capture_output=True,
                             text=True, cwd=cwd, timeout=180).stdout
    except (OSError, subprocess.TimeoutExpired):
        return [], [], 0
    tools, servers, ctx = [], [], 0
    for line in out.splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get("type") == "system" and ev.get("subtype") == "init":
            tools, servers = ev.get("tools") or [], ev.get("mcp_servers") or []
        elif ev.get("type") == "result":
            u = ev.get("usage") or {}
            ctx = sum(u.get(k, 0) for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
    return tools, servers, ctx


def cmd_chrome(a):
    if a.action == "status":
        st = chrome_state()
        if not st:
            print("Not checked yet. Run: lean-agent chrome check")
        else:
            print(f"{'OK' if st.get('ok') else 'NOT available'} (checked {st.get('checked')}, profile {st.get('profile')}); "
                  f"{len(st.get('tools') or [])} tools, ~{st.get('tokens', 0):,} tokens per worker turn")
            if st.get("tools"):
                print("tools: " + ", ".join(st["tools"]))
        return
    d = home("work", "chrome-check")
    os.makedirs(d, exist_ok=True)
    prefix = lean_mcp.tool_prefix(CHROME)
    base = ["--setting-sources", ""]
    _, _, baseline = _probe_session(base + ["--strict-mcp-config"], d)
    result = {"ok": False, "checked": now_iso()}
    for profile, extra in (("strict", ["--strict-mcp-config", "--chrome"]),
                           ("loose", ["--chrome"] + (["--disallowedTools", ",".join(
                               lean_mcp.tool_prefix(n).rstrip("_") for n in lean_mcp.discover())]
                               if lean_mcp.discover() else []))):
        tools, servers, ctx = _probe_session(base + extra, d)
        chrome_tools = [t[len(prefix):] for t in tools if t.startswith(prefix)]
        status = next((s.get("status") for s in servers if s.get("name") == CHROME), None)
        print(f"{profile:<7} {CHROME}: {status or 'absent'}, {len(chrome_tools)} tools")
        if chrome_tools:
            result.update(ok=True, profile=profile, tools=chrome_tools, tokens=max(0, ctx - baseline),
                          server_status=status)
            break
    save_json(home("chrome.json"), result)
    if result["ok"]:
        print(f"Workers can use Claude in Chrome ({result['profile']} isolation): {len(result['tools'])} tools, "
              f"~{result['tokens']:,} tokens of context per worker turn.")
        print("Give a worker only what it needs, e.g. --chrome " + ",".join(result["tools"][:3]))
        print("Sites must be allowed in the Claude extension's settings; headless workers can't answer site prompts.")
    else:
        print("Claude in Chrome isn't available to headless workers on this machine. Check: Chrome is running, "
              "the Claude extension is installed and signed in to the same account/organization as Claude Code "
              "(`/status`), and `claude --chrome` then `/chrome` shows Status: Enabled.")
        return 1


def cmd_mcp(a):
    project = resolve_project(a.project)[1] if getattr(a, "project", None) else None
    servers = lean_mcp.discover(project)
    if a.server and a.server != CHROME:
        a.server = lean_mcp.resolve_name(a.server, servers) or a.server
    if a.action == "list":
        if not servers:
            print("No MCP servers configured (looked in ~/.claude.json, <project>/.mcp.json, Claude Desktop config).")
            return
        cache = mcp_cache()
        aliases = lean_mcp.display_names(servers)
        width = max([24] + [len(n) + 2 for n in servers])
        print(f"{'server':<{width}}{'type':<7}{'source':<9}{'tools':>6}{'~tok':>8}")
        for name, info in sorted(servers.items()):
            tools = cache.get(name, {}).get("tools")
            if tools is None and a.probe:
                tools = server_tools(name, info["config"], refresh=True)
            n, tok = (len(tools), f"{sum(tools.values()):,}") if tools else ("?", "?")
            notes = []
            if aliases.get(name):
                notes.append(f"--mcp {aliases[name]}:...")
            st = cache.get(name, {}).get("status")
            if st and st != "connected":
                notes.append(f"{st} for workers")
            print(f"{name:<{width}}{lean_mcp.server_type(info['config']):<7}{info['source']:<9}{n:>6}{tok:>8}"
                  + (f"  ({'; '.join(notes)})" if notes else ""))
        st = chrome_state()
        if st.get("ok"):
            print(f"{CHROME:<24}{'chrome':<7}{'builtin':<9}{len(st['tools']):>6}{st.get('tokens', 0):>8,}  (use --chrome)")
        elif not st:
            print(f"{CHROME:<24}{'chrome':<7}{'builtin':<9}{'?':>6}{'?':>8}  (run: lean-agent chrome check)")
        print("~tok = tool definitions a worker carries on every turn if given the whole server."
              + ("" if a.probe else "  Fill in ? with --probe (http servers: one small Haiku call each)."))
        return
    if a.action == "preset":
        if not a.server:
            die("mcp preset needs a server: lean-agent mcp preset <server> [<name> <tool,tool>] [--rm]")
        known = mcp_cache().get(a.server, {}).get("tools")
        store = load_json(home("mcp-presets.json"), {})
        if a.preset_name and (a.preset_tools or a.rm):
            mine = store.setdefault(a.server, {})
            if a.rm:
                mine.pop(a.preset_name, None)
            else:
                tools = [t.strip() for t in a.preset_tools.split(",") if t.strip()]
                bad = [t for t in tools if known and t not in known]
                if bad:
                    die(f"{a.server} has no tool(s) {', '.join(bad)}")
                mine[a.preset_name] = tools
            save_json(home("mcp-presets.json"), store)
        presets = mcp_presets(a.server, known)
        if not presets:
            print(f"No presets for {a.server}. Add one: lean-agent mcp preset {a.server} <name> <tool,tool>")
        for name, tools in sorted(presets.items()):
            cost = sum((known or {}).get(t, 0) for t in tools)
            auto = " (automatic)" if name == "read" and name not in store.get(a.server, {}) else ""
            print(f"{a.server}:{name}{auto}  {len(tools)} tools ~{cost:,} tok  {', '.join(tools)}")
        return
    if a.server == CHROME:
        return cmd_chrome(argparse.Namespace(action="status"))
    if a.server not in servers:
        unknown_server(a.server, servers)
    cfg = servers[a.server]["config"]
    if a.measure:
        measure_server(a.server, cfg)
        return
    tools = server_tools(a.server, cfg, refresh=True)
    status = (mcp_cache().get(a.server) or {}).get("status")
    if tools is None:
        die(f"{a.server} gave workers no tools (status: {status or 'unknown'}). "
            + (MCP_AUTH_HINT.format(name=a.server) if status in ("needs-auth", "failed") else "Try --measure."))
    if (mcp_cache().get(a.server) or {}).get("estimated"):
        print("(per-tool tokens are the measured total split evenly)")
    for t, tok in sorted(tools.items(), key=lambda kv: -kv[1]):
        print(f"{tok:>7,} tok  {t}")
    print(f"{sum(tools.values()):>7,} tok  total for {len(tools)} tools.  "
          f"Give a worker only what it needs: --mcp {a.server}:<tool>,<tool>")


MCP_AUTH_HINT = ("Workers connect with the same name and config as Claude Code, so they reuse its stored login; "
                 "if it says needs-auth, sign in once in Claude Code (/mcp, pick {name}), then: lean-agent mcp tools {name}")


def diagnose_plugin_server(name, info, claude_view, servers):
    """(ok, message, fix) for one plugin MCP server: can a worker use it, and if not, why."""
    label = f"plugin MCP server {name}"
    missing = info.get("missing_options") or []
    env_missing = [m[4:] for m in missing if m.startswith("env:")]
    opt_missing = [m for m in missing if not m.startswith("env:")]
    if opt_missing:
        return (False, f"{label}: plugin option(s) {', '.join(opt_missing)} aren't readable (sensitive options are "
                f"in Claude Code's credentials store), so workers can't build its config",
                "set the option non-sensitively in /plugin manage, or add the server with `claude mcp add`")
    if env_missing:
        return (False, f"{label}: its config uses ${{{'}, ${'.join(env_missing)}}} and lean-agent can't see "
                "that variable", f"put it in the `env` block of {lean_mcp.config_dir()}/settings.json "
                "(lean-agent reads it there), or export it before `lean-agent up`")
    c = mcp_cache().get(name) or {}
    fresh = c.get("key") == config_key(info["config"]) and c.get("probed", "") >= (
        datetime.datetime.now() - datetime.timedelta(days=1)).isoformat(timespec="seconds")
    if not fresh:
        server_tools(name, info["config"], refresh=True)
        c = mcp_cache().get(name) or {}
    worker = c.get("status") or "unknown"
    alias = lean_mcp.display_names(servers).get(name)
    if worker == "connected" and c.get("tools"):
        return True, f"{label}: usable by workers ({len(c['tools'])} tools; --mcp {alias or name}:<preset|tools>)", None
    mine = info["config"].get("url") or " ".join([info["config"].get("command", "")] + info["config"].get("args", []))
    if claude_view and name not in claude_view:
        return (False, f"{label}: {worker} as a worker, and Claude Code doesn't list it (`claude mcp list`)",
                "enable the plugin in /plugin, or ignore this if you don't use it")
    theirs_status, theirs = claude_view.get(name, (None, None))
    if theirs_status and theirs_status != "connected":
        how = ("sign in: open Claude Code, /mcp, pick it, Authenticate" if theirs_status == "needs-auth"
               else "it fails in Claude Code too: fix it there first (`claude mcp list`, /mcp)")
        return False, f"{label}: {theirs_status} in Claude Code itself, so workers can't use it either", how
    if theirs and theirs.split("?")[0] != mine.split("?")[0]:
        return (False, f"{label}: {worker} as a worker; Claude Code connects to {theirs} but lean-agent built "
                f"{mine}", "the plugin's config has a value lean-agent resolves differently (an env var set "
                "only in Claude Code's environment?); put it in the settings.json `env` block")
    if worker == "needs-auth":
        seen = "connected in Claude Code but " if theirs_status == "connected" else ""
        return (False, f"{label}: {seen}needs-auth as a worker: no stored login matches lean-agent's copy of "
                "the config (sign in once in Claude Code: /mcp)", "re-run `lean-agent mcp tools " + name + "`; if it stays, "
                "add the server with `claude mcp add` and sign in once for workers")
    empty = [h for h, v in (info["config"].get("headers") or {}).items() if v == ""]
    return (False, f"{label}: {worker} as a worker" + (f" (empty headers: {', '.join(empty)})" if empty else ""),
            f"see why: lean-agent mcp tools {name} --measure, and lean-agent logs")


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
    if a.action == "edit":
        if not a.text or not a.new_text:
            die('memory edit needs the memory name and the new text: lean-agent memory edit <name> "<text>"')
        if not lean_memory.edit(store, a.text, a.new_text, mtype=a.type, description=a.name):
            die(f"no memory {a.text!r} (see: lean-agent memory list)")
        for slug in projects():
            sync_memory(slug)
        print(f"updated {a.text}")
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
    budgets, pbud = usage.window_budgets(), usage.pct_budgets()
    cfg = usage.load_limits()
    for name in ("5h", "week"):
        x = w[name]
        if x["aligned"]:
            label = "Session" if name == "5h" else "Week   "
            if x["start"] is None:
                print(f"{label}: no session since the last reset; the next one starts with your next message")
                continue
            span = f" ({x['start'].astimezone():%a %H:%M} to {x['reset'].astimezone():%a %H:%M})"
        else:
            label, span = ("Last 5 hours" if name == "5h" else "Last 7 days "), ""
        line = f"{label}{span}: lean-agent {x['lean']:,}"
        if budgets[name]:
            line += f" of {budgets[name]:,} ({x['lean'] * 100 // budgets[name]}%)"
            if x["lean"] >= budgets[name] and x["frees_at"]:
                line += f", frees up from {x['frees_at']:%a %H:%M}"
        line += f" | all Claude Code here {x['all']:,}"
        if x["plan_pct"] is not None:
            line += f" | plan ≈ {x['plan_pct']:.0f}%"
            cap = pbud.get("session" if name == "5h" else "week")
            if cap:
                line += f" (agents stop at {cap}%)"
        print(line)
        if name == "week" and x["fam"]:
            fams = []
            for f, comp in sorted(x["fam"].items(), key=lambda kv: -usage.plan_units({kv[0]: kv[1]})):
                part = f"{f} {int(usage.plan_units({f: comp}, cfg.get('weights'))):,}"
                if x["family_pct"].get(f) is not None:
                    part += f" (≈ {x['family_pct'][f]:.0f}% of its own limit)"
                fams.append(part)
            print("  by model: " + ", ".join(fams))
    print("Units: Sonnet-equivalent tokens (Haiku 5.5 counts 0.05x, Opus 5.5 2x, Fable 5.1 5x).")
    if not cfg.get("plan"):
        print("Windows roll. To follow your plan's reset times: "
              "lean-agent limits plan --session-resets 13:30 --week-resets \"Sat 12:00\" (as /usage shows them)")
    elif not cfg.get("caps"):
        print("Plan % unknown. Calibrate once from /usage: lean-agent limits calibrate session=37 week=12 [fable=8]")
    else:
        print(f"Plan % calibrated from /usage ({cfg.get('fit', 'default weights')}). Usage from claude.ai "
              "or other machines isn't seen here; calibrate again now and then.")


def parse_reset(text, weekly=False):
    """'13:30', '1:30 PM', '2026-10-19 13:30' (session) or 'Sat 12:00', 'Saturday 12pm' (weekly), local time."""
    import datetime
    t = text.strip().lower().replace(".", "")
    day = None
    if weekly:
        names = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
        first, _, rest = t.partition(" ")
        if first[:3] not in names:
            die(f"--week-resets: start with a weekday, e.g. \"Sat 12:00\" (got {text!r})")
        day, t = names.index(first[:3]), rest.strip()
    date = None
    if not weekly and len(t) > 10 and t[4] == "-":
        date, t = datetime.date.fromisoformat(t[:10]), t[10:].strip()
    pm, am = t.endswith("pm"), t.endswith("am")
    t = t[:-2].strip() if pm or am else t
    try:
        h, _, m = t.partition(":")
        h, m = int(h), int(m or 0)
    except ValueError:
        die(f"can't read the time in {text!r}; use e.g. 13:30 or 1:30 PM")
    if pm and h < 12:
        h += 12
    if am and h == 12:
        h = 0
    if not (0 <= h < 24 and 0 <= m < 60):
        die(f"can't read the time in {text!r}")
    if weekly:
        return {"weekday": day, "time": f"{h:02d}:{m:02d}"}
    now = datetime.datetime.now().astimezone()
    if date:
        r = datetime.datetime.combine(date, datetime.time(h, m)).astimezone()
    else:
        r = now.replace(hour=h, minute=m, second=0, microsecond=0)
        if r <= now:
            r += datetime.timedelta(days=1)
    return r.isoformat(timespec="minutes")


def cmd_limits(a):
    action = a.action or "show"
    cfg = usage.load_limits()
    if action == "plan":
        if not (a.session_resets or a.week_resets or a.off):
            die("say when your windows reset, as /usage shows: --session-resets 13:30 --week-resets \"Sat 12:00\"")
        plan = {} if a.off else cfg.get("plan") or {}
        if a.session_resets:
            plan["session_reset"] = parse_reset(a.session_resets)
        if a.week_resets:
            plan["week_reset"] = parse_reset(a.week_resets, weekly=True)
        cfg["plan"] = plan
        if a.off:
            cfg.pop("caps", None)
        usage.save_limits(cfg)
    elif action == "calibrate":
        if not a.values:
            die("give the percentages /usage shows now: lean-agent limits calibrate session=37 week=12 [fable=8]")
        pcts = {}
        for v in a.values:
            k, _, n = v.partition("=")
            k = {"5h": "session", "weekly": "week", "mythos": "fable"}.get(k.strip().lower(), k.strip().lower())
            if k not in ("session", "week", *usage.FAMILIES) or not n:
                die(f"can't read {v!r}: use session=N, week=N or a model family ({', '.join(usage.FAMILIES)})=N")
            try:
                pcts[k] = float(n.rstrip("%"))
            except ValueError:
                die(f"can't read the percentage in {v!r}")
        if not (cfg.get("plan") or {}).get("session_reset") and "session" in pcts:
            print("note: no plan reset time set, so the session is taken as the last 5 hours "
                  "(lean-agent limits plan --session-resets HH:MM is more exact)")
        w = usage.window_usage()
        if "session" in pcts and not w["5h"]["fam"]:
            die("no usage seen in the current session window on this machine, so there is nothing to calibrate against")
        cfg = usage.calibrate(pcts)
        print(f"calibrated: {cfg['fit']}")
    else:
        changed = False
        if a.off:
            cfg = {k: v for k, v in cfg.items() if k not in ("5h", "week", "pct_budgets")}
            changed = True
        for key, val in (("5h", a.five_h), ("week", a.week)):
            if val is not None:
                cfg[key] = val
                changed = True
        for key, val in (("session", a.session_pct), ("week", a.week_pct)):
            if val is not None:
                cfg.setdefault("pct_budgets", {})[key] = val
                changed = True
        if (a.session_pct or a.week_pct) and not cfg.get("caps"):
            print("note: the plan % budgets apply once you calibrate: lean-agent limits calibrate session=N week=N")
        if changed:
            usage.save_limits(cfg)
    for env in ("LEAN_AGENT_5H_BUDGET", "LEAN_AGENT_WEEKLY_BUDGET"):
        if os.environ.get(env):
            print(f"note: {env} is set in the environment and overrides the saved value")
    print_limits()


def cmd_optimize(a):
    slug, _ = resolve_project(a.project)
    sync_memory(slug)
    with library_lock(slug):
        _cmd_optimize(a)
        _draft_proposals(a, slug)


TOOL_VERBS = {"get", "list", "search", "read", "query", "fetch", "find", "view", "show", "describe", "count",
              "lookup", "create", "update", "delete", "set", "add", "remove", "run", "mcp", "the", "by", "for", "and"}


def run_tools(r):
    """{server: [tools in the order first called]} from a run record."""
    seq = r.get("mcp_seq") or [t for t, n in (r.get("mcp_calls") or {}).items() for _ in range(n)]
    out = {}
    for name, _ in lean_mcp.parse_specs(r.get("mcp")):
        prefix = lean_mcp.tool_prefix(name)
        used = list(dict.fromkeys(t[len(prefix):] for t in seq if t.startswith(prefix)))
        if used:
            out[name] = used
    return out


def _jaccard(x, y):
    return len(x & y) / len(x | y) if x | y else 0.0


def preset_name(server, tools):
    """A short preset name from the words the tool names share (search_x_metrics, get_x_metric -> metric)."""
    skip = TOOL_VERBS | set(re.split(r"[^a-z0-9]+", server.lower()))
    counts = {}
    for t in tools:
        for w in set(re.split(r"[^a-z0-9]+", t.lower())):
            w = w[:-1] if w.endswith("s") and len(w) > 3 else w
            if w and w not in skip:
                counts[w] = counts.get(w, 0) + 1
    best = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    return (best[0][0] if best else "task") + ("s" if best and not best[0][0].endswith("s") else "")


def draft_proposals(slug):
    """New-card and preset drafts from what successful workers actually did (no 5-run threshold).

    One successful run with a distinctive MCP pattern (2+ tools, or 4+ calls, or 6+ turns) gives a recipe
    card draft; runs with the same server and a similar tool set, or similar task wording, are grouped.
    A preset is drafted when a run was given far more tools than it used, or a pattern recurs."""
    runs = [r for r in ledger() if r.get("project") == slug and not r.get("resumed")
            and r.get("status") == "done" and r.get("role") != "reviewer"]
    cards = [c for c in load_cards(slug) if not c.get("archived")]
    cache = mcp_cache()
    groups = []
    for r in runs:
        tools = run_tools(r)
        if not tools:
            continue
        tw = words(r["task"])
        for g in groups:
            same_srv = set(tools) & set(g["tools"])
            if any(_jaccard(set(tools[s]), set(g["tools"][s])) >= 0.6 for s in same_srv) or _jaccard(tw, g["words"]) >= 0.5:
                g["runs"].append(r)
                for s, ts in tools.items():
                    g["tools"][s] = list(dict.fromkeys(g["tools"].get(s, []) + ts))
                g["words"] |= tw
                break
        else:
            groups.append({"runs": [r], "tools": {s: list(ts) for s, ts in tools.items()}, "words": set(tw)})
    drafts = []
    for g in groups:
        first, n = g["runs"][0], len(g["runs"])
        calls = sum(sum((r.get("mcp_calls") or {}).values()) for r in g["runs"])
        distinctive = any(len(ts) >= 2 for ts in g["tools"].values()) or calls >= 4 or (first.get("turns") or 0) >= 6
        all_tools = {t for ts in g["tools"].values() for t in ts}
        covered = next((c for c in cards if sum(t in c["text"] for t in all_tools) * 2 >= max(1, len(all_tools))), None)
        key = hashlib.sha1(json.dumps(sorted(g["tools"].items())).encode()).hexdigest()[:6]
        if distinctive and not covered:
            title_words = [w for w in re.findall(r"[A-Za-z][A-Za-z0-9-]+", first["task"]) if w.lower() not in STOPWORDS]
            title = "How to: " + " ".join(title_words[:9])
            lines = [f"Recipe from {n} successful run{'s' if n > 1 else ''} ({', '.join(r['id'] for r in g['runs'][:4])}).",
                     f"Task like: {first['task'][:200]}", ""]
            for srv, ts in g["tools"].items():
                counts = {}
                for r in g["runs"]:
                    for t, k in (r.get("mcp_calls") or {}).items():
                        counts[t] = counts.get(t, 0) + k
                prefix = lean_mcp.tool_prefix(srv)
                lines.append(f"Steps that worked ({srv}):")
                lines += [f"{i}. {t}" + (f" (x{counts[prefix + t]})" if counts.get(prefix + t, 0) > 1 else "")
                          for i, t in enumerate(ts, 1)]
                known = (cache.get(srv) or {}).get("tools") or {}
                cost = sum(known.get(t, 0) for t in ts)
                lines.append(f"Give the worker only these: --mcp {srv}:{','.join(ts)}" + (f" (~{cost:,} tok/turn)" if cost else ""))
            if first.get("result_head"):
                lines += ["", "What a good answer looked like: " + first["result_head"][:240].replace("\n", " ")]
            lines += ["", f"Cost without this card: {first.get('turns') or '?'} turns, {first.get('units', 0):,} sonnet-eq. "
                      "Edit the steps (ids, queries, time windows) so the next worker skips the exploring."]
            drafts.append({"id": f"draft-card-{key}", "kind": "card", "card_id": slugify("recipe-" + "-".join(
                w.lower() for w in title_words[:5]), 50), "title": title, "text": "\n".join(lines), "runs": n,
                "why": f"from {n} run{'s' if n > 1 else ''}: {first.get('turns') or '?'} turns, "
                       f"{first.get('units', 0):,} sonnet-eq, {calls} MCP calls"})
        for srv, ts in g["tools"].items():
            known = (cache.get(srv) or {}).get("tools") or {}
            offered = max((r.get("mcp_offered") or {}).get(srv, 0) for r in g["runs"])
            presets = mcp_presets(srv, known)
            if any(set(ts) == set(v) for v in presets.values()):
                continue
            if n >= 2 or (offered and offered >= 2 * len(ts) and offered - len(ts) >= 5):
                name = preset_name(srv, ts)
                while name in presets:
                    name += "2"
                cost, whole = sum(known.get(t, 0) for t in ts), sum(known.values())
                used_preset = next((p for p, v in presets.items() if offered and len(v) == offered), None)
                vs = (f" vs {used_preset} ~{sum(known.get(t, 0) for t in presets[used_preset]):,}" if used_preset
                      else f" vs whole server ~{whole:,}" if whole else "")
                drafts.append({"id": f"draft-preset-{key}-{slugify(srv, 20)}", "kind": "preset", "server": srv,
                               "name": name, "tools": ts, "runs": n,
                               "why": f"{len(ts)} tools ~{cost:,} tok/turn{vs}; offered {offered or '?'}, used {len(ts)}"
                                      f" in {n} run{'s' if n > 1 else ''}"})
    return drafts


def _draft_proposals(a, slug):
    path = home("library", slug, "drafts.json")
    state = load_json(path, {})
    drafts = [d for d in draft_proposals(slug) if state.get(d["id"]) not in ("accepted", "rejected")]
    for rid in (a.reject or "").split(","):
        if rid:
            state[rid] = "rejected"
    accept = [x for x in (a.accept or "").split(",") if x]
    for d in drafts:
        if d["id"] in accept:
            if d["kind"] == "card":
                _cmd_card(argparse.Namespace(project=slug, action="add", id=d["card_id"], title=d["title"],
                                             text=d["text"], file=None, core=False))
            else:
                store = load_json(home("mcp-presets.json"), {})
                store.setdefault(d["server"], {})[d["name"]] = d["tools"]
                save_json(home("mcp-presets.json"), store)
                print(f"saved preset {d['server']}:{d['name']} = {','.join(d['tools'])}")
            state[d["id"]] = "accepted"
    unknown = [x for x in accept if x not in {d["id"] for d in drafts}]
    if unknown:
        print(f"no open draft {', '.join(unknown)} (see: lean-agent optimize {slug})")
    if a.accept or a.reject:
        save_json(path, state)
    left = [d for d in drafts if d["id"] not in accept and state.get(d["id"]) != "rejected"]
    if not left:
        return
    print("\nDrafts from what workers did (review, then accept or reject):")
    for d in left:
        if d["kind"] == "card":
            print(f"new card  {d['id']}  -> card {d['card_id']}: {d['title']}  ({d['why']})")
            print("    " + d["text"].replace("\n", "\n    "))
        else:
            print(f"preset    {d['id']}  -> --mcp {d['server']}:{d['name']} = {','.join(d['tools'])}  ({d['why']})")
    print(f"accept: lean-agent optimize {slug} --accept <id>[,<id>]   reject: --reject <id>. "
          f"To change a card's text first, accept it, then `lean-agent card add {slug} <card> --file <file>`.")


def _cmd_optimize(a):
    slug, _ = resolve_project(a.project)
    cards = load_cards(slug)
    actions = []
    for c in cards:
        if c.get("archived"):
            continue
        for t, bt in sorted((c.get("by_type") or {}).items()):
            if bt["offered"] < a.min_runs:
                continue
            rate = bt["used"] / bt["offered"]
            in_core = t in (c.get("core_types") or [])
            if not in_core and rate >= 0.8 and not bt["unneeded"]:
                actions.append(("core", c, f"for {t} tasks: used in {bt['used']}/{bt['offered']}, never unneeded", t))
            elif in_core and rate < 0.4:
                actions.append(("uncore", c, f"for {t} tasks: used in only {bt['used']}/{bt['offered']}", t))
        if c.get("core") and c["offered"] >= a.min_runs and c["used"] / c["offered"] < 0.4:
            actions.append(("uncore", c, f"core for every task but used in only {card_rate(c)} runs", "*"))
        if c["offered"] >= a.min_runs:
            rate = c["used"] / c["offered"]
            if not is_core(c, "") and rate <= 0.2 and c["unneeded"] >= 2:
                actions.append(("archive", c, f"used in {card_rate(c)} runs, marked unneeded {c['unneeded']}x", None))
            if rate >= 0.5 and c["tokens"] > 600:
                actions.append(("trim", c, f"~{c['tokens']} tok and often used: rewrite shorter with "
                                f"`card add {slug} {c['id']} --file ...`", None))
    if not actions:
        print(f"No trim/core/archive changes yet (those need {a.min_runs}+ runs per card; new-card drafts don't).")
    for act, c, why, _ in actions:
        print(f"{act:<8}{c['id']:<34}{why}")
    if a.apply:
        for act, c, _, t in actions:
            if act == "core":
                c["core_types"] = sorted(set(c.get("core_types") or []) | {t})
            elif act == "uncore" and t == "*":
                c["core"] = False  # an old global core card that workers don't use
            elif act == "uncore":
                c["core_types"] = [x for x in c.get("core_types") or [] if x != t]
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
        if m["runs"] < min(2, a.min_runs):
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
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "70",
    "BASH_MAX_OUTPUT_LENGTH": "20000",
    "MAX_MCP_OUTPUT_TOKENS": "10000",
    "CLAUDE_CODE_SUBAGENT_MODEL": "sonnet",
}


def seed_recipes():
    """Add built-in how-to memories once (a recipe you delete stays deleted)."""
    seeded_path = home("recipes-seeded.json")
    seeded = load_json(seeded_path, [])
    changed = False
    for f in sorted(glob.glob(os.path.join(PLUGIN_ROOT, "templates", "recipes", "*.md"))):
        stem = "recipe_" + os.path.splitext(os.path.basename(f))[0]
        if stem in seeded:
            continue
        meta, body = lean_memory.parse(read_text(f))
        lean_memory.add(memory_store(), body, meta.get("type", "reference"), name=meta.get("name"),
                        description=meta.get("description"), stem=stem, source="lean-agent recipe")
        seeded.append(stem)
        changed = True
    if changed:
        save_json(seeded_path, seeded)


def cli_reference():
    """Markdown list of every subcommand's exact usage, generated from the parser."""
    ap = build_parser()
    subs = next(x for x in ap._actions if isinstance(x, argparse._SubParsersAction))
    helps = {c.dest: c.help for c in subs._choices_actions}
    lines = []
    for name, parser in subs.choices.items():
        usage = " ".join(parser.format_usage().replace("usage: ", "", 1).replace("[-h] ", "").split())
        lines.append(f"- `{usage}`: {helps.get(name, '')}")
    return "\n".join(lines)


def default_project(path=None):
    """Learned project containing `path` (default: cwd), else the first learned one, else 'shop'."""
    projs = projects()
    p = os.path.realpath(path or os.getcwd())
    for slug, v in projs.items():
        root = os.path.realpath(v["path"])
        if p == root or p.startswith(root + os.sep):
            return slug
    return next(iter(sorted(projs)), "shop")


def render(template, project):
    text = read_text(os.path.join(PLUGIN_ROOT, "templates", template)).replace("{{P}}", project)
    if "{{CLI_REFERENCE}}" in text:
        text = text.replace("{{CLI_REFERENCE}}", cli_reference())
    return text


def text_hash(text):
    return hashlib.sha1(text.encode()).hexdigest()[:10]


def render_guide(project=None):
    return render("guide.md", project or default_project())


def render_block(slug):
    body = render("repo-block.md", slug).strip()
    return f"{BLOCK_BEGIN} {text_hash(body)} (generated by lean-agent; edits inside are replaced) -->\n{body}\n{BLOCK_END}"


def rules_target(path):
    """CLAUDE.local.md, unless the repo relies on AGENTS.md (a CLAUDE.local.md would stop Claude reading it)."""
    has_claude = any(os.path.exists(os.path.join(path, f)) for f in ("CLAUDE.md", os.path.join(".claude", "CLAUDE.md")))
    if os.path.exists(os.path.join(path, "AGENTS.md")) and not has_claude:
        return os.path.join(path, ".claude", "rules", "lean-agent.md")
    return os.path.join(path, "CLAUDE.local.md")


def git_exclude(path, target):
    """Keep `target` out of git via .git/info/exclude (local only), unless it's already ignored."""
    rel = os.path.relpath(target, path)
    try:
        if subprocess.run(["git", "-C", path, "check-ignore", "-q", rel], capture_output=True).returncode == 0:
            return
        common = subprocess.run(["git", "-C", path, "rev-parse", "--git-common-dir"], capture_output=True,
                                text=True)
    except OSError:
        return
    if common.returncode != 0:
        return
    git_dir = common.stdout.strip()
    git_dir = git_dir if os.path.isabs(git_dir) else os.path.join(path, git_dir)
    exclude = os.path.join(git_dir, "info", "exclude")
    os.makedirs(os.path.dirname(exclude), exist_ok=True)
    with open(exclude, "a") as fh:
        fh.write(f"\n/{rel}\n")


def install_block(slug):
    """Write or refresh the lean-agent block in the project's rules file. Returns (file, changed)."""
    path = projects()[slug]["path"]
    target = rules_target(path)
    block = render_block(slug)
    current = read_text(target) if os.path.exists(target) else ""
    if BLOCK_BEGIN in current:
        new = BLOCK_RE.sub("\n\n" + block + "\n", current, count=1).strip("\n") + "\n"
    else:
        new = (current.rstrip("\n") + "\n\n" if current.strip() else "") + block + "\n"
    if new == current:
        return target, False
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "w") as fh:
        fh.write(new)
    git_exclude(path, target)
    return target, True


def remove_blocks(path):
    for target in (os.path.join(path, "CLAUDE.local.md"), os.path.join(path, ".claude", "rules", "lean-agent.md")):
        if os.path.exists(target) and BLOCK_BEGIN in read_text(target):
            rest = BLOCK_RE.sub("\n\n", read_text(target)).strip()
            if rest:
                with open(target, "w") as fh:
                    fh.write(rest + "\n")
            else:
                os.remove(target)


def refresh_blocks():
    for slug, v in projects().items():
        if v.get("rules") != "off" and os.path.isdir(v["path"]):
            install_block(slug)


def write_home_guide(h):
    target = os.path.join(h, "CLAUDE.md")
    body = render_guide()
    text = f"{GUIDE_MARK}{text_hash(body)} (generated by lean-agent; delete this line to stop updates) -->\n{body}"
    current = read_text(target) if os.path.exists(target) else ""
    managed = not current or current.startswith(GUIDE_MARK) or current.startswith(OLD_TEMPLATE_MARK)
    if managed and current != text:
        with open(target, "w") as fh:
            fh.write(text)
    return managed


# Tools an orchestrator never needs. Denying them removes their definitions from every turn's context
# (measured: ~35.7k -> ~6.6k tokens per turn) and makes the "never the Agent/Workflow tool" rule a hard
# guarantee. Names that don't exist in a given Claude Code version are ignored.
ORCHESTRATOR_DENY = [
    "Agent", "Task", "Workflow", "Edit", "MultiEdit", "Write", "NotebookEdit", "NotebookRead", "WebFetch", "WebSearch",
    "Skill", "Glob", "Grep", "LS", "TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "EnterPlanMode",
    "EnterWorktree", "ExitWorktree", "LSP", "Artifact", "ArtifactComments", "ArtifactData", "CronCreate", "CronDelete",
    "CronList", "DesignSync", "ListAgents", "ListConnectors", "ListPlugins", "ListSkills", "ReadNotifications",
    "ReportFindings", "ScheduleWakeup", "SearchMcpRegistry", "SearchPlugins", "SearchSkills", "SendMessage",
    "SendUserFile", "ShowOnboardingRolePicker", "SuggestConnectors", "SuggestPluginInstall", "SuggestSkills",
]
PLUGIN_ID = "lean-agent@lean-agent"


def orchestrator_settings(existing):
    """lean-agent's keys for the home's .claude/settings.json; other keys (e.g. model) are kept."""
    data = dict(existing)
    perms = dict(data.get("permissions") or {})
    perms["allow"] = sorted(set(perms.get("allow") or []) | {"Bash(lean-agent:*)"})
    if os.environ.get("LEAN_AGENT_ORCHESTRATOR_TRIM") == "0":  # full context: drop lean-agent's trimming keys
        perms.pop("deny", None)
        data["permissions"] = perms
        for key in ("disableBundledSkills", "disableClaudeAiConnectors", "claudeMdExcludes", "enabledPlugins"):
            data.pop(key, None)
        return data
    servers = [n for n, v in lean_mcp.discover().items() if v["source"] in ("user", "desktop")]
    perms["deny"] = sorted(set(ORCHESTRATOR_DENY) | {lean_mcp.tool_prefix(n).rstrip("_") for n in servers})
    data["permissions"] = perms
    data["disableBundledSkills"] = True
    data["disableClaudeAiConnectors"] = True
    cfg = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    excludes = [os.path.join(cfg, "CLAUDE.md")]
    p = os.path.dirname(home("home"))
    while True:  # CLAUDE.md files in folders above the home (e.g. ~/CLAUDE.md)
        excludes += [os.path.join(p, "CLAUDE.md"), os.path.join(p, "CLAUDE.local.md")]
        if os.path.dirname(p) == p:
            break
        p = os.path.dirname(p)
    data["claudeMdExcludes"] = excludes
    user = load_json(os.path.join(cfg, "settings.json"), {})
    plugins = {k: False for k, v in (user.get("enabledPlugins") or {}).items() if v and k != PLUGIN_ID}
    data["enabledPlugins"] = dict(data.get("enabledPlugins") or {}, **plugins)
    return data


REPO_ROOT = os.path.dirname(os.path.dirname(PLUGIN_ROOT))


def clone_root():
    """The git clone this code runs from, or None (e.g. when running from Claude Code's plugin cache)."""
    if os.path.isdir(os.path.join(REPO_ROOT, ".git")) and os.path.isfile(os.path.join(REPO_ROOT, "bin", "lean-agent")):
        return REPO_ROOT
    return None


def register_source():
    """Point the installed plugin's hooks and CLI at this clone (see scripts/trampoline.py)."""
    root = clone_root()
    if not root:
        return
    path = home("source")
    current = read_text(path).strip() if os.path.exists(path) else ""
    if current != root:
        os.makedirs(home(), exist_ok=True)
        with open(path, "w") as fh:
            fh.write(root + "\n")


def prepare_home():
    h = home("home")
    os.makedirs(os.path.join(h, ".claude"), exist_ok=True)
    register_source()
    seed_recipes()
    write_home_guide(h)
    settings = os.path.join(h, ".claude", "settings.json")
    save_json(settings, orchestrator_settings(load_json(settings, {})))
    local = os.path.join(h, ".claude", "settings.local.json")
    if os.environ.get("LEAN_AGENT_ORCHESTRATOR_TRIM") != "0":
        save_json(local, dict(load_json(local, {}), syncClaudeAiSkills=False))  # only honoured in local/user scope
    return h


def cmd_guide(a):
    print(render_guide(resolve_project(a.project)[0] if a.project else None))


def cmd_rules(a):
    slug, path = resolve_project(a.project)
    projs = projects()
    projs[slug]["rules"] = "off" if a.off else None
    save_json(home("projects.json"), projs)
    if a.off:
        remove_blocks(path)
        print(f"removed the lean-agent block from {path}")
    else:
        target, changed = install_block(slug)
        print(f"{'updated' if changed else 'up to date'}: {target}")


def cmd_logs(a):
    if a.level == "verbose":
        files = sorted(glob.glob(lean_log.log_dir("verbose", "*.log")), key=os.path.getmtime)[-a.n:]
        if not files:
            print(f"No saved command outputs yet ({lean_log.log_dir('verbose')}).")
        for f in files:
            print(f"{os.path.getsize(f):>10,}  {f}")
        return 0
    path = lean_log.log_dir(f"{a.level}.log")
    if not os.path.exists(path):
        print(f"No {a.level} log yet ({path}).")
        return 0
    with open(path, encoding="utf-8", errors="replace") as fh:
        lines = fh.readlines()
    entries, cur = [], []
    for line in lines:  # continuation lines start with 4 spaces
        if line.startswith("    ") and cur:
            cur.append(line)
        else:
            cur = [line]
            entries.append(cur)
    for e in entries[-a.n:]:
        sys.stdout.write("".join(e))
    print(f"({len(entries[-a.n:])} of {len(entries)} entries from {path})")
    return 0


def cmd_runs(a):
    runs = ledger()
    if a.project:
        slug, _ = resolve_project(a.project)
        runs = [r for r in runs if r["project"] == slug]
    if a.show or a.tokens:
        rid = a.show if a.show and a.show != "last" else (runs[-1]["id"] if runs else None)
        r = next((x for x in reversed(runs) if x["id"] == rid), None)
        if not r:
            die(f"no run {rid!r}" if rid else "no runs yet")
        files = sorted(glob.glob(os.path.join(r["workdir"], "summary-*.txt")),
                       key=lambda f: int(re.sub(r"\D", "", os.path.basename(f)) or 0))
        if not files:  # runs from before summaries were saved: rebuild the run line from the ledger
            cost = f"${r['cost_usd']:.2f}" if isinstance(r.get("cost_usd"), (int, float)) else "$?"
            print(f"run {r['id']} · {r['model']} · {r['status']} · {r.get('turns') or '?'} turns · "
                  f"{r.get('units', 0):,} sonnet-eq tok · {cost}")
            return
        text = read_text(files[-1])
        if a.tokens and not a.show:
            text = "".join(l for l in text.splitlines(True)
                           if l.startswith(("run ", "  tokens:", "  context per turn", "  mcp:", "  budget left")))
        sys.stdout.write(text)
        if len(files) > 1:
            print(f"({len(files)} turns of this run; this is the latest: {files[-1]})")
        return
    if a.last:
        if not runs:
            die("no runs yet")
        print(runs[-1]["id"])
        return
    for r in runs[-a.n:]:
        print(f"{r['id']}  {r['status']:<22} {r['model']:<7} {r['project']:<16} {r['task'][:70]}")


def instruction_files(path):
    """Instruction files Claude Code loads at launch in `path`, in load order."""
    cfg = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    files = [os.path.join(cfg, "CLAUDE.md")]
    chain, p = [], os.path.realpath(path)
    while True:
        chain.append(p)
        parent = os.path.dirname(p)
        if parent == p:
            break
        p = parent
    for d in reversed(chain):
        files += [os.path.join(d, "CLAUDE.md"), os.path.join(d, ".claude", "CLAUDE.md"),
                  os.path.join(d, "CLAUDE.local.md")]
        files += sorted(glob.glob(os.path.join(d, ".claude", "rules", "*.md")))
    return [f for f in dict.fromkeys(files) if os.path.isfile(f)]


def cmd_doctor(a):
    path = os.path.realpath(os.path.expanduser(a.path or os.getcwd()))
    bad = []

    def report(ok, msg, fix=None):
        mark = {True: "✓", False: "✗", None: "!"}[ok]
        print(f"{mark} {msg}" + (f"\n    fix: {fix}" if fix and ok is not True else ""))
        if ok is False:
            bad.append(msg)

    import shutil
    report(bool(shutil.which("lean-agent")), "lean-agent is on PATH", "run ./install in your lean-agent clone")
    h = home("home")
    if a.fix:
        prepare_home()
    guide_file = os.path.join(h, "CLAUDE.md")
    current = read_text(guide_file) if os.path.exists(guide_file) else ""
    expected = text_hash(render_guide())
    if not current:
        report(False, "orchestrator home has a guide", "lean-agent home  (or doctor --fix)")
    elif not current.startswith(GUIDE_MARK):
        report(None, "orchestrator guide is hand-maintained (no lean-agent marker), so it isn't updated")
    else:
        report(current.startswith(f"{GUIDE_MARK}{expected}"), "orchestrator guide is current",
               "lean-agent home  (or doctor --fix)")
    report(is_trusted(h), "orchestrator home is trusted", "lean-agent trust")

    slug = default_project(path)
    projs = projects()
    in_project = slug in projs and (path + os.sep).startswith(os.path.realpath(projs[slug]["path"]) + os.sep)
    root = os.path.realpath(projs[slug]["path"]) if in_project else None
    is_home = path == os.path.realpath(h) or path.startswith(os.path.realpath(h) + os.sep)
    if not in_project and not is_home:
        report(False, f"{path} is inside a learned project or the lean-agent home",
               "lean-agent learn <repo root> --name <name>")
    if in_project and a.fix and projs[slug].get("rules") != "off":
        install_block(slug)

    files = instruction_files(path)
    print("  instruction files loaded here: " + (", ".join(files) or "none"))
    if in_project:
        want = render_block(slug).splitlines()[0]
        holders = [f for f in files if BLOCK_BEGIN in read_text(f)]
        current_holders = [f for f in holders if want in read_text(f)]
        if projs[slug].get("rules") == "off":
            report(None, f"lean-agent block is switched off for {slug}", f"lean-agent rules {slug}")
        elif current_holders:
            report(True, f"lean-agent rules load here (from {current_holders[0]})")
        else:
            report(False, "lean-agent rules load here" + (" (block is outdated)" if holders else ""),
                   f"lean-agent rules {slug}  (or doctor --fix)")
        if (os.path.exists(os.path.join(root, "AGENTS.md")) and os.path.exists(os.path.join(root, "CLAUDE.local.md"))
                and not os.path.exists(os.path.join(root, "CLAUDE.md"))):
            report(None, "this repo has AGENTS.md; a CLAUDE.local.md stops Claude reading it",
                   "move the block: delete CLAUDE.local.md, then lean-agent rules " + slug)

    for f in files:
        text = BLOCK_RE.sub("\n", read_text(f))
        if f.startswith(os.path.realpath(h) + os.sep):
            continue  # the guide itself
        hits = [(i + 1, line.strip()) for i, line in enumerate(text.splitlines())
                if CONFLICT_RE.search(line) and PRECEDENCE_MARK not in line]
        if not hits:
            continue
        inside = root and f.startswith(root + os.sep)
        if PRECEDENCE_MARK in text:
            report(True, f"{f} mentions subagents/workflows but defers to lean-agent")
            continue
        if a.fix and not inside:
            with open(f, "a") as fh:
                fh.write("\n" + PRECEDENCE_LINE + "\n")
            report(True, f"{f}: added a note that lean-agent rules take precedence")
            continue
        where = "; ".join(f"line {n}: {t[:70]}" for n, t in hits[:2])
        if inside:
            report(None, f"{f} has subagent/workflow guidance ({where}); the lean-agent block says it wins")
        else:
            report(False, f"{f} contradicts lean-agent ({where})", "lean-agent doctor --fix  (adds a one-line precedence note)")

    st = chrome_state()
    print("  chrome for workers: " + ("verified" if st.get("ok") else "not verified (lean-agent chrome check)"))
    plugin_srv = {n: v for n, v in lean_mcp.discover().items() if v["source"] == "plugin"}
    claude_view = lean_mcp.claude_mcp_list() if plugin_srv else {}
    for name, info in sorted(plugin_srv.items()):
        report(*diagnose_plugin_server(name, info, claude_view, plugin_srv))
    budgets = usage.window_budgets()
    parts = [f"{k}={v:,}" for k, v in budgets.items() if v]
    parts += [f"{k}={v}% of plan" for k, v in usage.pct_budgets().items()]
    cfg = usage.load_limits()
    print("  window budgets: " + (", ".join(parts) or "none (lean-agent limits)")
          + ("; plan reset times set" if cfg.get("plan") else "; windows roll (lean-agent limits plan)")
          + ("; calibrated" if cfg.get("caps") else ""))
    print("doctor: " + ("all good" if not bad else f"{len(bad)} problem(s)"))
    return 1 if bad else 0



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
    sys.stdout.flush()
    return subprocess.run(["claude"]).returncode


def bridge_pointer(h):
    """Where `claude remote-control` remembers the session to bring back for this folder."""
    cfg = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    return os.path.join(cfg, "projects", re.sub(r"[^A-Za-z0-9]", "-", h), "bridge-pointer.json")


def cmd_up(a):
    h = prepare_home()
    refresh_blocks()
    save_json(home("up.json"), {"started": now_iso(), "server_env": ORCHESTRATOR_ENV, "name": a.name,
                                "local": a.local})
    set_home_model(h, a.model)
    if a.fresh:
        # remote-control keeps a pointer on exit so the next start can resume the old session; if that
        # session was archived or expired, every start fails with "registerWorker ... 404". Start clean.
        for path in dict.fromkeys([bridge_pointer(h), bridge_pointer(os.path.realpath(h))]):
            if os.path.exists(path):
                os.remove(path)
                print(f"lean-agent: removed {path}; starting a new Remote Control session")
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
        cap = env.get("LEAN_AGENT_BUDGET")
        print(f"lean-agent: orchestrator in {h}, model {a.model or 'default'}"
              + (f", self-set session cap {int(cap):,} sonnet-eq" if cap else ""))
        print(f"lean-agent: open the Claude app (Code) and pick \"{a.name}\"")
    extra = a.extra[1:] if a.extra[:1] == ["--"] else a.extra
    cmd += extra  # e.g. `lean-agent up -- --debug --debug-file /tmp/rc.log`
    os.chdir(h)
    sys.stdout.flush()  # exec replaces the process; unflushed output would be lost when piped
    sys.stderr.flush()
    try:
        os.execvpe(cmd[0], cmd, env)
    except FileNotFoundError:
        die("'claude' not found on PATH")


def cmd_sync(a):
    root = clone_root()
    if not root:
        die("this lean-agent isn't running from a git clone, so there's nothing to pull; "
            "update the plugin with: claude plugin update " + PLUGIN_ID)
    claude = os.environ.get("LEAN_AGENT_CLAUDE") or "claude"
    if not a.no_pull:
        old = git(root, "rev-parse", "HEAD")
        if git(root, "status", "--porcelain", "--untracked-files=no"):
            print(f"lean-agent: {root} has local changes; not pulling (commit or stash them, then sync again)")
        else:
            p = subprocess.run(["git", "-C", root, "pull", "--ff-only", "-q"], capture_output=True, text=True)
            if p.returncode != 0:
                print(f"lean-agent: git pull failed: {(p.stderr or p.stdout).strip()[:300]}")
            new = git(root, "rev-parse", "HEAD")
            if new and old and new != old:
                log = git(root, "log", "--oneline", f"{old}..{new}") or ""
                print(f"pulled {len(log.splitlines())} commit(s) ({old[:7]}..{new[:7]}):")
                for line in log.splitlines()[:15]:
                    print("  " + line)
                sys.stdout.flush()
                script = os.path.join(root, "plugins", "lean-agent", "scripts", "lean_agent.py")
                os.execv(sys.executable, [sys.executable, script, "sync", "--no-pull", "--pulled"]
                         + (["--no-learn"] if a.no_learn else []))
            elif p.returncode == 0:
                print(f"code: already up to date ({(new or '?')[:7]})")

    plugin = "skipped (claude not found)"
    try:
        subprocess.run([claude, "plugin", "marketplace", "update", "lean-agent"], capture_output=True, text=True,
                       timeout=120)
        p = subprocess.run([claude, "plugin", "update", PLUGIN_ID], capture_output=True, text=True, timeout=120)
        plugin = "updated" if p.returncode == 0 else f"not updated ({(p.stderr or p.stdout).strip()[:120]})"
    except (OSError, subprocess.TimeoutExpired):
        pass

    guide_file = home("home", "CLAUDE.md")
    before = read_text(guide_file) if os.path.exists(guide_file) else ""
    settings_file = home("home", ".claude", "settings.json")
    settings_before = read_text(settings_file) if os.path.exists(settings_file) else ""
    prepare_home()
    guide_changed = (read_text(guide_file) if os.path.exists(guide_file) else "") != before
    settings_changed = read_text(settings_file) != settings_before

    relearned = []
    if not a.no_learn:
        for slug, v in sorted(projects().items()):
            if os.path.isdir(v["path"]):
                n_before = len(load_cards(slug))
                learn(v["path"], quiet=True, name=slug)
                relearned.append(f"{slug} ({n_before}->{len(load_cards(slug))} cards)")
    refresh_blocks()

    up = load_json(home("up.json"), {})
    restart = bool(up) and not up.get("local") and up.get("server_env") != ORCHESTRATOR_ENV
    print(f"plugin: {plugin}")
    print(f"orchestrator guide: {'changed' if guide_changed else 'unchanged'} · "
          f"orchestrator settings: {'changed' if settings_changed else 'unchanged'}")
    if relearned:
        print("re-learned: " + ", ".join(relearned) + " (card stats kept; repo blocks refreshed)")
    print(f"hooks and in-session `lean-agent` now run {root}")
    if restart:
        print("NEXT: restart `lean-agent up` once: its server settings changed.")
    elif guide_changed or settings_changed or a.pulled:
        print("NEXT: start a new lean-agent session in the Claude app (no need to restart `lean-agent up`; "
              "the server keeps running). A session that's already open can re-read the rules with `lean-agent guide`.")
    else:
        print("Nothing changed for running sessions.")


def cmd_install(a):
    subprocess.run(["claude", "plugin", "marketplace", "add", REPO])
    r = subprocess.run(["claude", "plugin", "install", PLUGIN])
    h = prepare_home()
    refresh_blocks()
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


def session_workers(session_id, first_ts, last_ts):
    """[(model, runs, sonnet-eq)] for runs started from an orchestrator session: by recorded parent
    session, or (older runs) by time within the session."""
    def to_utc(local_iso):  # ledger times are local; transcript times are UTC
        try:
            return datetime.datetime.fromisoformat(local_iso).astimezone(datetime.timezone.utc).strftime(
                "%Y-%m-%dT%H:%M:%S")
        except ValueError:
            return ""
    rows = {}
    for r in ledger():
        if r.get("parent_session"):
            mine = r["parent_session"] == session_id
        else:
            ts = to_utc(r.get("ts", ""))
            mine = bool(first_ts and last_ts and ts and first_ts[:19] <= ts <= last_ts[:19])
        if mine:
            m = rows.setdefault(r["model"], [0, 0.0])
            m[0] += 1
            m[1] += r.get("units", r.get("weighted", 0) * usage.model_rate(r["model"]))
    return [(m, n, u) for m, (n, u) in rows.items()]


def cmd_budget(a):
    sys.exit(usage.report(a.session, workers=session_workers))


def cmd_home(a):
    print(prepare_home())


# ---------------------------------------------------------------- CLI

def build_parser():
    ap = argparse.ArgumentParser(prog="lean-agent", description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("up", help="start the orchestrator (Remote Control by default)")
    s.add_argument("--model", default="sonnet",
                   help="orchestrator model, pinned in the home's settings (default: sonnet; 'default' = your own)")
    s.add_argument("--name", default="lean-agent", help="session name in the Claude app")
    s.add_argument("--budget", type=int, help="optional self-set cap per orchestrator session (sonnet-eq tokens)")
    s.add_argument("--budget-5h", type=int, help="lean-agent budget per 5-hour window (Sonnet-equivalent tokens)")
    s.add_argument("--budget-week", type=int, help="lean-agent budget per 7 days (Sonnet-equivalent tokens)")
    s.add_argument("--permission-mode", help="e.g. acceptEdits, auto")
    s.add_argument("--local", action="store_true", help="interactive terminal session instead of Remote Control")
    s.add_argument("--fresh", action="store_true",
                   help="don't resume the previous Remote Control session (fixes 'registerWorker ... 404')")
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
    s.add_argument("--no-rules", action="store_true", help="don't write the lean-agent block into the repo")
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
    s.add_argument("--max-tokens", type=int, default=2000)
    s.add_argument("--max-cards", type=int, default=4, help="at most this many matching (non-core) cards")
    s.set_defaults(fn=cmd_suggest)

    s = sub.add_parser("run", help="run an isolated worker on a project")
    s.add_argument("task", nargs="*", help="task text, or - to read stdin")
    s.add_argument("--project", "-p")
    s.add_argument("--model", "-m", help="haiku | sonnet | opus | full model id (required)")
    s.add_argument("--why", help="one line: why this model and context (required)")
    s.add_argument("--cards", help="comma-separated card ids, or 'auto'")
    s.add_argument("--max-context", type=int, default=2000, help="token cap for --cards auto")
    s.add_argument("--max-cards", type=int, default=4, help="--cards auto: at most this many matching cards")
    s.add_argument("--read-only", action="store_true", help=f"tools: {READONLY_TOOLS}")
    s.add_argument("--tools", help=f"explicit tool list (default {WORKER_TOOLS})")
    s.add_argument("--max-turns", type=int, default=env_num("LEAN_AGENT_MAX_TURNS", 40))
    s.add_argument("--max-usd", type=float, default=env_num("LEAN_AGENT_RUN_MAX_USD", 3.0, float))
    s.add_argument("--task-file")
    s.add_argument("--resume", metavar="RUN_ID", help="continue a previous run's session")
    s.add_argument("--effort", choices=["low", "medium", "high", "xhigh", "max"], help="model effort for the worker")
    s.add_argument("--worktree", metavar="REF", help="run in a shared lean-agent git worktree of this branch/ref "
                   "(your checkout is never touched; installed deps persist for the next worker)")
    s.add_argument("--chrome", nargs="?", const="all", metavar="TOOL,TOOL",
                   help="give the worker the user's Chrome via Claude in Chrome (optionally only these tools)")
    s.add_argument("--allow-send", metavar="WHAT",
                   help="the user approved this outward action (send/post/submit...); describe exactly what")
    s.add_argument("--mcp", action="append", metavar="SERVER[:TOOL,TOOL]",
                   help="give the worker this MCP server, optionally only these tools (repeatable)")
    s.set_defaults(fn=cmd_run)

    s = sub.add_parser("chrome", help="Claude in Chrome for workers: check (once) | status")
    s.add_argument("action", choices=["check", "status"])
    s.set_defaults(fn=cmd_chrome)

    s = sub.add_parser("mcp", help="MCP servers workers can use: list, tools <server>, preset <server> ...")
    s.add_argument("action", choices=["list", "tools", "preset"])
    s.add_argument("server", nargs="?")
    s.add_argument("preset_name", nargs="?", help="preset: name to set or remove")
    s.add_argument("preset_tools", nargs="?", help="preset: comma-separated tools")
    s.add_argument("--rm", action="store_true", help="preset: remove it")
    s.add_argument("--project", "-p", help="include this project's .mcp.json and local-scope servers")
    s.add_argument("--probe", action="store_true", help="list: query stdio servers for their tools")
    s.add_argument("--measure", action="store_true", help="tools: measure real per-turn cost with 2 Haiku calls")
    s.set_defaults(fn=cmd_mcp)

    s = sub.add_parser("memory", help="shared memory: where | import | list | add | edit | rm")
    s.add_argument("action", choices=["where", "import", "list", "add", "edit", "rm"])
    s.add_argument("text", nargs="?", help="add: the memory text; edit/rm: the memory's name")
    s.add_argument("new_text", nargs="?", help="edit: the new text")
    s.add_argument("--project", "-p", help="scope to a project (default: global)")
    s.add_argument("--type", choices=lean_memory.TYPES, help="add: memory type (default project)")
    s.add_argument("--name", help="add: short name (the type is added for you); edit: new description")
    s.add_argument("--from", dest="source", metavar="DIR", help="import: folder to import (default: Claude's)")
    s.set_defaults(fn=cmd_memory)

    s = sub.add_parser("limits", help="usage in your plan's session and weekly windows; budgets for agents")
    s.add_argument("action", nargs="?", choices=["show", "plan", "calibrate"],
                   help="plan: set the reset times /usage shows; calibrate: record /usage percentages")
    s.add_argument("values", nargs="*", metavar="KEY=PCT", help="calibrate: session=37 week=12 fable=8")
    s.add_argument("--session-resets", metavar="TIME", help="plan: when the current session resets (13:30, 1:30 PM)")
    s.add_argument("--week-resets", metavar="DAY TIME", help="plan: when the week resets (\"Sat 12:00\")")
    s.add_argument("--session-pct", type=int, metavar="PCT", help="stop agents at this %% of the session limit (0 = none)")
    s.add_argument("--week-pct", type=int, metavar="PCT", help="stop agents at this %% of the weekly limit (0 = none)")
    s.add_argument("--5h", dest="five_h", type=int, metavar="N", help="lean-agent budget per session window, sonnet-eq (0 = none)")
    s.add_argument("--week", type=int, metavar="N", help="lean-agent budget per week window, sonnet-eq (0 = none)")
    s.add_argument("--off", action="store_true", help="remove the budgets (with plan: the plan and calibration)")
    s.set_defaults(fn=cmd_limits)

    s = sub.add_parser("stats", help="runs, success rate and tokens by model")
    s.add_argument("--project", "-p")
    s.add_argument("--today", action="store_true")
    s.add_argument("--days", type=int)
    s.set_defaults(fn=cmd_stats)
    s = sub.add_parser("optimize", help="tune a project's cards from worker feedback")
    s.add_argument("project")
    s.add_argument("--apply", action="store_true")
    s.add_argument("--min-runs", type=int, default=5, help="runs of a task type before a card can become core for it")
    s.add_argument("--notes", type=int, default=10)
    s.add_argument("--accept", metavar="IDS", help="write these drafts (cards with card add, presets with mcp preset)")
    s.add_argument("--reject", metavar="IDS", help="stop proposing these drafts")
    s.set_defaults(fn=cmd_optimize)

    s = sub.add_parser("review", help="pre-PR review by a read-only reviewer (sonnet, high effort)")
    s.add_argument("project")
    s.add_argument("--base", help="branch the change is based on (default: origin's default branch)")
    s.add_argument("--head", metavar="REF", help="review this branch/commit straight from git (no checkout needed); "
                   "with --status: check that ref")
    s.add_argument("--no-fetch", action="store_true", help="don't `git fetch origin` for origin/* refs")
    s.add_argument("--focus", help="what the reviewer should look at closely")
    s.add_argument("--resume", action="store_true", help="re-review after fixes, in the same reviewer session")
    s.add_argument("--status", action="store_true", help="exit 0 only if the current code has an approve")
    s.add_argument("--max-usd", type=float, default=env_num("LEAN_AGENT_REVIEW_MAX_USD", 5.0, float))
    s.add_argument("--max-turns", type=int, default=env_num("LEAN_AGENT_REVIEW_MAX_TURNS", 60))
    s.add_argument("--max-context", type=int, default=4000, help="token cap for the review's cards")
    s.set_defaults(fn=cmd_review)

    s = sub.add_parser("sync", help="pull lean-agent, update the plugin, refresh guide, settings, projects and repo blocks")
    s.add_argument("--no-pull", action="store_true", help="don't git pull; just refresh everything")
    s.add_argument("--no-learn", action="store_true", help="don't re-learn projects")
    s.add_argument("--pulled", action="store_true", help=argparse.SUPPRESS)
    s.set_defaults(fn=cmd_sync)

    s = sub.add_parser("worktrees", help="list lean-agent's shared worktrees")
    s.add_argument("project", nargs="?")
    s.set_defaults(fn=cmd_worktrees)
    s = sub.add_parser("worktree", help="shared worktrees: rm, setup (run on new ones), push (after review + approval)")
    s.add_argument("action", choices=["rm", "setup", "push"])
    s.add_argument("project")
    s.add_argument("ref", nargs="?", help="the worktree's branch (setup: also run the command there now)")
    s.add_argument("--run", dest="command", metavar="COMMAND", help="setup: the command for new worktrees")
    s.add_argument("--force", action="store_true", help="rm: remove even with uncommitted changes")
    s.add_argument("--off", action="store_true", help="setup: no setup command")
    s.add_argument("--allow-send", metavar="APPROVED", help="push: what the user approved (the push happens only with this)")
    s.add_argument("--no-fetch", action="store_true", help="push: don't fetch origin first")
    s.set_defaults(fn=cmd_worktree)

    s = sub.add_parser("logs", help="lean-agent's local logs: error (default), debug, or verbose (saved outputs)")
    s.add_argument("level", nargs="?", default="error", choices=["error", "debug", "verbose"])
    s.add_argument("-n", type=int, default=20, help="last N entries")
    s.set_defaults(fn=cmd_logs)

    s = sub.add_parser("runs", help="recent worker runs (id, status, model, task)")
    s.add_argument("--project", "-p")
    s.add_argument("--last", action="store_true", help="print only the id of the latest run")
    s.add_argument("--tokens", action="store_true", help="print the latest (or --show) run's run/tokens/context lines again")
    s.add_argument("--show", nargs="?", const="last", metavar="RUN_ID",
                   help="print a run's whole summary again (default: the latest run)")
    s.add_argument("-n", type=int, default=10)
    s.set_defaults(fn=cmd_runs)

    s = sub.add_parser("guide", help="print the full orchestrator guide (rules, examples, CLI reference)")
    s.add_argument("project", nargs="?")
    s.set_defaults(fn=cmd_guide)

    s = sub.add_parser("rules", help="write/refresh (or --off: remove) the lean-agent block in a repo")
    s.add_argument("project")
    s.add_argument("--off", action="store_true")
    s.set_defaults(fn=cmd_rules)

    s = sub.add_parser("doctor", help="check setup and which instructions load in a folder (default: here)")
    s.add_argument("path", nargs="?")
    s.add_argument("--fix", action="store_true", help="refresh guide and repo block, add precedence notes")
    s.set_defaults(fn=cmd_doctor)
    return ap


def main(argv=None):
    ap = build_parser()
    argv = list(sys.argv[1:] if argv is None else argv)
    if (len(argv) > 2 and argv[0] == "run" and not argv[1].startswith("-")
            and not {"-p", "--project", "--resume"} & set(argv) and is_project_ref(argv[1])):
        argv = ["run", "-p", argv[1]] + argv[2:]  # `lean-agent run <project> ...` like `cards <project>`
    a, leftover = ap.parse_known_args(argv)
    if leftover:
        if a.cmd != "run" or any(x.startswith("-") for x in leftover):
            ap.error("unrecognized arguments: " + " ".join(leftover))
        a.task += leftover  # task words given after options
    if a.cmd == "run" and not a.resume and not a.project:
        ap.error("run needs --project (or --resume)")
    try:
        return a.fn(a) or 0
    finally:
        if isinstance(sys.stdout, Tee):
            sys.stdout.close()


class Tee:
    """Copy everything printed to a file too: a run's summary can be shown again with `runs --show`
    even when the caller cut its output short (e.g. `| tail`)."""

    def __init__(self, stream, path):
        self.stream, self.fh = stream, open(path, "w", encoding="utf-8")

    def write(self, text):
        self.fh.write(text)
        return self.stream.write(text)

    def flush(self):
        self.fh.flush()
        self.stream.flush()

    def close(self):
        self.fh.close()
        sys.stdout = self.stream

    def __getattr__(self, name):
        return getattr(self.stream, name)


if __name__ == "__main__":
    sys.exit(main())
