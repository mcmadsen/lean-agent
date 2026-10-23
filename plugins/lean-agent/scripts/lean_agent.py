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
import io
import json
import os
import re
import shlex
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
import push_guard  # noqa: E402
import lean_schedule  # noqa: E402
import lean_threads  # noqa: E402
import service_session  # noqa: E402
from lean_common import DEFAULT_COMPACT_PCT, DEFAULT_COMPACT_WINDOW, compaction_point, pid_alive as dashboard_pid_alive, plugin_version  # noqa: E402

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
{role_rule}{answer_rule}Start your reply with a one or two sentence summary of the outcome. Then give the result
(what you did, files changed, anything unresolved), then one final line exactly like this:
"used" lists only cards whose content changed what you did, not cards you merely received.
LEAN-FEEDBACK {{"status": "done|partial|failed|needs-input|awaiting-confirmation", "used": ["card-id"], "unneeded": ["card-id"], "missing": "context you had to discover that should have been given up front, or empty", "remember": []}}

"remember" is shared memory for future agents. Usually leave it empty. Add an item
only for a durable fact that can't be derived from the code or git history, such as a
user correction, a decision, or where external info lives:
{{"type": "feedback|project|reference|user", "text": "one or two sentences"}}
"""

DETAILS_MARK = "=== DETAILS ==="
ANSWER_RULE = """\
Your reply goes into the orchestrator's context, which is re-read on every later call, so keep the
answer short: the summary, then at most {n} lines with what it needs for the next step (the result,
the ids, paths and numbers it will use, anything unresolved or risky). Put everything else (full
tables, long lists, evidence, logs, per-item detail) after a line that is exactly `{mark}`:
lean-agent saves that part to a file and shows only its path. The LEAN-* lines still come last.

"""

SHELL_RULE = "Run shell commands as `cd {project} && <command>`."
MUTATING_WORDS = {"delete", "create", "update", "set", "apply", "push", "rm", "merge", "deploy", "remove", "add", "put",
                  "post", "patch", "install", "exec", "write", "reset", "approve", "complete", "abandon", "queue"}
CLI_RE = re.compile(r"(?<![\w/-])(az|gh|kubectl|aws|gcloud|curl|wget|docker|terraform|helm|psql|sqlcmd|glab|jq)(?=\s)")
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


KEY_TOKEN_RES = [re.compile(r"`([^`]{2,80})`"), re.compile(r"(?m)^#+\s*(.+)$"),
                 re.compile(r"\b[\w.-]+/[\w./-]+\b"), re.compile(r"\b[A-Z][A-Z0-9_]{2,}\b"),
                 re.compile(r"\b\w*[a-z][A-Z]\w*\b"), re.compile(r"\b\w+_\w+\b"), re.compile(r"\b\d[\d.,:]*\b")]


def key_tokens(text):
    """What a shorter card must keep: headings, `code`, paths, CONSTANTS, camelCase/snake_case names, numbers."""
    out = set()
    for rx in KEY_TOKEN_RES:
        for m in rx.finditer(text):
            out.add((m.group(1) if rx.groups else m.group(0)).strip())
    return {t for t in out if t}


SHORTEN_PROMPT = """Rewrite this context card for an AI coding agent to be about half as long. Keep every rule, command,
path, name, number and heading; drop repetition, filler and explanations the agent doesn't need to act. Use the
same headings. Output only the new card text, nothing else.

---
{text}
"""


def shorten_card(slug, cards, a):
    """Propose a shorter text for a card (one Haiku call) and check nothing important got lost."""
    c = find_card(cards, a.id)
    claude = os.environ.get("LEAN_AGENT_CLAUDE") or "claude"
    d = home("work", "shorten")
    os.makedirs(d, exist_ok=True)
    try:
        out = subprocess.run([claude, "-p", "--output-format", "stream-json", "--verbose", "--model", a.model or "haiku",
                              "--max-turns", "1", "--tools", "", "--safe-mode"],
                             input=SHORTEN_PROMPT.format(text=c["text"]), capture_output=True, text=True, cwd=d,
                             timeout=180).stdout
    except (OSError, subprocess.TimeoutExpired) as exc:
        die(f"couldn't run {claude}: {exc}")
    new = ""
    for line in out.splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get("type") == "result":
            new = (ev.get("result") or "").strip()
        elif ev.get("type") == "rate_limit_event":
            usage.record_plan_usage(ev.get("rate_limit_info"))
    if not new:
        die("no shorter text came back")
    lost = sorted(key_tokens(c["text"]) - key_tokens(new) - {t for t in key_tokens(c["text"]) if t in new})
    c["shorten_checked"] = now_iso()
    if est_tokens(new) > c["tokens"] * 0.9:
        save_cards(slug, cards)
        print(f"{c['id']}: not worth it (~{c['tokens']:,} -> ~{est_tokens(new):,} tokens, under 10% saved); "
              "optimize won't suggest trimming it again for 30 days")
        return 0
    print(f"{c['id']}: ~{c['tokens']:,} -> ~{est_tokens(new):,} tokens")
    print("--- proposed text ---\n" + new + "\n---")
    if lost:
        print("lost (not in the shorter text): " + ", ".join(lost[:30]))
    if a.save:
        save_cards(slug, cards)
        if lost and not a.force:
            die("not saved: the shorter text lost the items above (edit it, or --save --force)")
        c.update(text=new, tokens=est_tokens(new), updated=now_iso(), edited=True)
        c.setdefault("source_text", c.get("text"))
        save_cards(slug, cards)
        print(f"saved card {c['id']}")
    else:
        print(f"save it with: lean-agent card shorten {slug} {c['id']} --save" + ("" if not lost else " --force"))
    return 0


def cmd_card(a):
    slug, _ = resolve_project(a.project)
    with library_lock(slug):
        _cmd_card(a)


def _cmd_card(a):
    slug, _ = resolve_project(a.project)
    cards = load_cards(slug)
    if a.action == "shorten":
        return shorten_card(slug, cards, a)
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
        if c["core"] and c.get("archived"):
            c["archived"] = False
            print(f"{a.id} was archived; unarchived it (a core card has to be live)")
    elif a.action == "unarchive":
        if not c.get("archived"):
            print(f"{a.id} isn't archived")
            return
        c["archived"] = False
    elif a.action == "protect":
        c["protected"] = not a.off
        print(f"{a.id}: " + ("protected: optimize won't archive, demote or trim it" if c["protected"] else "no longer protected"))
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
    picked = [c for c in cards if is_core(c, ttype) and not (strict and often_unneeded(c, ttype))]
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


def often_unneeded(card, ttype):
    """A core card that workers of this task type called unneeded 3+ times and never used (and that isn't
    protected): `--cards auto` leaves it out."""
    bt = (card.get("by_type") or {}).get(ttype) or {}
    return not card.get("protected") and bt.get("unneeded", 0) >= 3 and not bt.get("used")


def similar_runs(task, runs=None):
    """{model: [runs]} of earlier first runs whose task shares most of its distinctive words with this one."""
    tw = words(task)
    out = {}
    if len(tw) < 2:
        return out
    for r in runs if runs is not None else ledger():
        if r.get("resumed") or r.get("role"):
            continue
        rw = words(r.get("task") or "")
        if rw and len(tw & rw) / len(tw | rw) >= 0.35:
            out.setdefault(model_family(r["model"]), []).append(r)
    return out


def model_family(model):
    m = (model or "").lower()
    return next((f for f in ("haiku", "sonnet", "opus", "fable") if f in m), m)


def done_ok(r):
    return r.get("status") in ("done", "awaiting-confirmation", "needs-input")


def recommend_model(ttype, task=None):
    """(model, why) for a task: haiku first when similar tasks went well on it; else the cheapest model that has
    done this task type well; else a default."""
    runs = [r for r in ledger() if not r.get("resumed")]
    best = None
    for model, mine in sorted(similar_runs(task, runs).items() if task else [],
                              key=lambda kv: ("haiku", "sonnet", "opus", "fable").index(kv[0])
                              if kv[0] in ("haiku", "sonnet", "opus", "fable") else 9):
        ok = sum(map(done_ok, mine))
        if len(mine) >= 3 and ok / len(mine) >= 0.8:
            avg = sum(r.get("units", 0) for r in mine) // len(mine)
            return model, f"similar tasks ran on {model}: {ok}/{len(mine)} done, ~{avg:,} sonnet-eq avg"
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
    elif pace_line()[1] and best[0] != "haiku":
        best = ("haiku", best[1] + "; ahead of pace for the week, so prefer haiku and smaller steps")
    elif usage.session_pressure()[1] and best[0] != "haiku":
        best = ("haiku", best[1] + f"; the session window is at {usage.session_pressure()[0]:.0f}%, so prefer haiku "
                "and smaller steps until it resets")
    return best


def cmd_suggest(a):
    slug, _ = resolve_project(a.project)
    sync_memory(slug)
    ttype = task_type(a.task)
    picked, reasons, closest = suggest(slug, a.task, a.max_tokens, ttype, explain=True, strict=True,
                                       limit=a.max_cards)
    model, why = recommend_model(ttype, a.task)
    flags = f"-m {model}" + (" --read-only" if ttype == "read" else "") + (" --chrome" if ttype == "browser" else "")
    if model != "haiku" and ttype != "browser":
        flags += f" --escalate haiku,{model}"  # try haiku first; the next model only if it fails
    print(f"task type: {ttype} · recommended: {flags}  ({why})")
    sim = similar_runs(a.task)
    if sim:
        print("similar tasks before: " + " · ".join(
            f"{m} {sum(map(done_ok, rs))}/{len(rs)} done (~{sum(r.get('units', 0) for r in rs) // len(rs):,} sonnet-eq)"
            for m, rs in sorted(sim.items())))
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


def parse_remote(url):
    """{"host", "org", "project", "repo"} from a git remote URL (Azure DevOps https/ssh, GitHub, GitLab, ...)."""
    u = (url or "").strip()
    m = (re.match(r"^https?://(?:[^@/]+@)?dev\.azure\.com/([^/]+)/([^/]+)/_git/([^/?#]+)", u)
         or re.match(r"^(?:ssh://)?git@ssh\.dev\.azure\.com:(?:22/)?v3/([^/]+)/([^/]+)/([^/?#]+)", u))
    if m:
        return {"host": "Azure DevOps", "org": m.group(1), "project": m.group(2), "repo": m.group(3)}
    m = (re.match(r"^https?://(?:[^@/]+@)?([^./]+)\.visualstudio\.com/(?:DefaultCollection/)?([^/]+)/_git/([^/?#]+)", u)
         or re.match(r"^(?:ssh://)?[^@]+@vs-ssh\.visualstudio\.com:(?:22/)?v3/([^/]+)/([^/]+)/([^/?#]+)", u))
    if m:
        return {"host": "Azure DevOps", "org": m.group(1), "project": m.group(2), "repo": m.group(3)}
    m = re.match(r"^(?:https?://(?:[^@/]+@)?|(?:ssh://)?git@)([^/:]+)[/:](.+?)/([^/]+?)(?:\.git)?/?$", u)
    if m:
        return {"host": m.group(1), "org": m.group(2), "project": None, "repo": m.group(3)}
    return {}


def repo_identity(slug, path):
    """Where this project lives in its git host / tracker: a saved `review learn --tracker ...` setting wins,
    else what the origin remote says."""
    ident = parse_remote(git(path, "remote", "get-url", "origin") or "")
    ident.update({k: v for k, v in ((projects().get(slug) or {}).get("tracker") or {}).items() if k != "notes"})
    return ident


def repo_identity_text(slug, path):
    ident = repo_identity(slug, path)
    if not ident:
        return ("Repository identity: unknown (no origin remote). Don't guess the organization, project or "
                "repository; if a tool needs them and you can't find them, stop with needs-input and ask.")
    parts = [f"{k} {ident[k]}" for k in ("host", "org", "project", "repo") if ident.get(k)]
    text = ("Repository identity (from git; use these exact values in tool calls, and never use lean-agent's "
            f"project name `{slug}` as a tracker project): " + ", ".join(parts) + ". If a lookup with these "
            "returns nothing, say exactly what you called and stop with needs-input instead of answering "
            "from nothing.")
    if ident.get("me_id") or ident.get("me_name"):
        text += (f"\nYou act as {ident.get('me_name') or 'the user'}" + (f" (identity id {ident['me_id']})" if
                 ident.get("me_id") else "") + ": use that id where a tool needs the user (assignee, reviewer, "
                 "vote); `@me` may not work.")
    conf = (projects().get(slug) or {}).get("tracker") or {}
    notes = active_notes(conf) + tracker_facts_text(conf)
    if notes:
        text += "\nTracker notes for this project (\"unknown\" means check before relying on it):\n" + \
            "\n".join(f"- {n}" for n in notes[:25])
    return text


def code_tools_note(project):
    """For a JS/TS project: the cheap code tools a worker should use instead of reading files ('' otherwise)."""
    if not os.path.exists(os.path.join(project, "package.json")):
        return ""
    slug = next((s for s, v in projects().items() if v.get("path") == project), None)
    if not slug:
        return ""
    la = os.path.join(PLUGIN_ROOT, "bin", "lean-agent")
    lines = ["# Cheap code tools (no model; prefer them to reading or grepping many files; in a worktree add --dir .)",
             f"- `{la} map {slug} --who-uses X` | `--deps PATH` | `--route /x` | `--unused` | `--find Name`: the import "
             "graph, answered in a few lines."]
    if load_json(home("checks", slug, "config.json"), {}):
        lines.append(f"- `{la} check {slug}`: type-check / lint / tests; only errors that are new against the baseline. "
                     "Run it before you say you're done; don't read full tool output.")
    if load_json(home("counts", slug + ".json"), {}):
        lines.append(f"- `{la} count {slug}`: how much of each tracked legacy pattern is left (`--files` lists them).")
    if load_json(home("parity", slug, "config.json"), {}).get("routes"):
        lines.append(f"- `{la} parity {slug}`: per-route screenshots, page text and console errors against the baseline.")
    lines.append(f'- `{la} codemod {slug} "<command>"` runs a codemod on a throwaway copy and summarises the change; '
                 "`--apply` runs it for real. For the same mechanical edit in many files, write a codemod "
                 "(jscodeshift, ts-morph or a script) instead of editing files one by one.")
    return "\n".join(lines) + "\n"


def build_append(project, cards, read_only=False, allow_send=None, chrome=False, role_rule="", answer_lines=0):
    parts = [WORKER_PROTOCOL.format(
        answer_rule=ANSWER_RULE.format(n=answer_lines, mark=DETAILS_MARK) if answer_lines else "",
        project=project, sq=os.path.join(PLUGIN_ROOT, "bin", "lean-sq"),
        shell_rule=(READONLY_SHELL_RULE if read_only else SHELL_RULE).format(project=project),
        send_rule=ALLOW_SEND_RULE.format(approved=allow_send) if allow_send else SEND_RULE,
        browser_rule=BROWSER_RULE if chrome else "",
        role_rule=role_rule)]
    tools = code_tools_note(project)
    if tools:
        parts.append(tools)
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
    if entry.get("status") != "connected":  # say why, not only that it failed
        reasons = lean_mcp.config_problems(cfg)
        if not reasons and lean_mcp.server_type(cfg) in ("http", "sse") and os.environ.get("LEAN_AGENT_HTTP_CHECK") != "0":
            reasons = [r for r in [lean_mcp.http_reason(cfg)] if r]
        entry["error"] = "; ".join(reasons)
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
                    f"tools: {', '.join(sorted(known))}"
                    + (f" (several presets or tools of one server go after one colon: --mcp {name}:a,b; another "
                       "server needs its own --mcp)" if any(":" in u for u in unknown) else ""))
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


PRICE_SONNET_EQ_USD = 3.0 / 1_000_000  # one sonnet-eq token at Sonnet's input price, for comparing estimates


def expected_run_units(model, ttype=None):
    """Median sonnet-eq of earlier plain runs (no reviews) on this model, same task type when there are enough."""
    runs = [r for r in ledger() if usage.model_rate(r.get("model")) == usage.model_rate(model) and not r.get("resumed")
            and r.get("units") and not r.get("role")]
    typed = [r for r in runs if ttype and r.get("type") == ttype]
    pick = sorted(r["units"] for r in (typed if len(typed) >= 2 else runs))
    return (pick[len(pick) // 2], len(pick)) if pick else (None, 0)


def plan_share(units):
    """(share of the session window `units` would take, session % now) from Claude's numbers; (None, None)."""
    real, age = usage.plan_usage()
    if not real or "five_hour" not in real or age is None or age > 120:
        return None, None
    now_pct = real["five_hour"]["pct"]
    w = usage.window_usage()["5h"]
    if not now_pct or not w["all"]:
        return None, now_pct
    per_pct = w["all"] / now_pct  # sonnet-eq per 1% of the session window, from what this machine used
    return units / per_pct, now_pct


def expensive_run_check(a, model, task):
    """Before an Opus/Fable-class run: print the expected cost and plan share; ask for --yes when it's large."""
    if usage.model_rate(model) < 2:
        return
    units, n = expected_run_units(model, getattr(a, "ttype", None))
    if units is None:
        fix, k = estimate_correction("guess-run")
        units = int(200000 * usage.model_rate(model) * fix)  # no history yet: a rough guess
        how = "a rough guess (no earlier runs on this model)" + (f", corrected x{fix:.1f}" if k else "")
        a.estimate = (units * PRICE_SONNET_EQ_USD, "guess-run")
    else:
        how = f"typical run on this model: median of {n} earlier run(s)"
        a.estimate = (units * PRICE_SONNET_EQ_USD, "history-run")
    share, now_pct = plan_share(units)
    line = f"lean-agent: {model} run, expected ~{units:,} sonnet-eq ({how})"
    if share is not None:
        line += f", about {share:.0f}% of your session window (now {now_pct:.0f}%)"
    elif now_pct is not None:
        line += f" (session window now {now_pct:.0f}%)"
    print(line, file=sys.stderr, flush=True)
    limit = env_num("LEAN_AGENT_CONFIRM_PCT", 10)
    if not getattr(a, "yes", False) and ((share or 0) >= limit or (now_pct or 0) >= 50):
        die(f"that's a large share of your plan: ask the user, then add --yes (or use -m sonnet)", 2)


def duplicate_launch_guard(a, model, task):
    """Refuse the same task (project, model, task text) while it runs or right after it finished, unless --again:
    an orchestrator that retries a command it thinks failed shouldn't pay for the work twice."""
    key = hashlib.sha1(f"{a.project}|{model}|{task.strip()}".encode()).hexdigest()[:16]
    marker = home("running", key + ".json")
    if not getattr(a, "again", False):
        m = load_json(marker, {})
        alive = False
        if m.get("pid"):
            try:
                os.kill(m["pid"], 0)
                alive = True
            except OSError:
                alive = False
        if alive:
            die(f"the same task is already running (started {m.get('started', '?')}, pid {m['pid']}); wait for it, "
                "or pass --again to start another", 2)
        recent = next((r for r in reversed(ledger()) if r.get("launch_key") == key), None)
        if recent and (datetime.datetime.now() - datetime.datetime.fromisoformat(recent["ts"])).total_seconds() < 90:
            die(f"the same task finished moments ago as run {recent['id']} ({recent['status']}): see it with "
                f"`lean-agent runs --show {recent['id']}`, or pass --again to run it again", 2)
    os.makedirs(os.path.dirname(marker), exist_ok=True)
    save_json(marker, {"pid": os.getpid(), "started": now_iso()})
    return key


def cmd_run(a):
    if getattr(a, "escalate", None) and not a.resume:
        return run_escalating(a)
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
    launch_key = None
    if not prev and not getattr(a, "role", None) and os.environ.get("LEAN_AGENT_LAUNCH_GUARD") != "0":
        launch_key = duplicate_launch_guard(a, model, task)
    if not prev and not getattr(a, "role", None):
        expensive_run_check(a, model, task)

    # a short answer for the orchestrator, details in a file (not for reviewers etc.: their output is parsed)
    if getattr(a, "role", None) or (prev or {}).get("role"):
        answer_lines = 0
    elif getattr(a, "answer_lines", None) is not None:
        answer_lines = max(0, a.answer_lines)
    elif prev:
        answer_lines = prev.get("answer_lines") or 0
    else:
        answer_lines = env_num("LEAN_AGENT_ANSWER_LINES", 0)
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
                                  a.allow_send, bool(chrome_spec), role_rule, answer_lines))
    else:
        slug, project = resolve_project(a.project)
        sync_memory(slug)
        if getattr(a, "worktree", None):
            wt = ensure_worktree(slug, project, a.worktree, reset=getattr(a, "reset_worktree", False))
            project = wt["path"]
            print(f"worktree: {wt['ref']} at {wt['path']} ({'reused' if wt['reused'] else 'created'}"
                  f"{', on branch ' + wt['branch'] if wt['branch'] else ', detached'}, HEAD {wt['head'][:10]})", flush=True)
            if wt.get("moved"):
                print(f"worktree: HEAD moved from {wt['moved'][0][:10]} to {wt['moved'][1][:10]} ({wt['ref']}'s tip)",
                      flush=True)
            if not a.read_only:
                task += ("\n\n(You work in a lean-agent worktree. If the task has several items, commit each one when "
                         "it's done, before the next, so a turn limit never leaves all of the work uncommitted.)")
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
        if a.mcp:  # external systems need the exact identifiers, not a guess from lean-agent's project name
            ident = repo_identity_text(slug, project)
            ident += ("\nWhen an MCP result is too big and Claude Code saves it to a file, don't read the file whole: "
                      f"run `{os.path.join(PLUGIN_ROOT, 'bin', 'lean-json')} <file>` for a compact view (add "
                      "`--fields a,b.c` to keep only some fields, `--grep TEXT` to keep matching items).\n")
            role_rule = (role_rule + "\n" if role_rule else "") + ident
        if getattr(a, "ref", None):
            if a.ref.startswith("origin/"):
                git(project, "fetch", "-q", "origin")
            ref_sha = git(project, "rev-parse", "--verify", "--quiet", a.ref + "^{commit}")
            if not ref_sha:
                die(f"unknown ref {a.ref!r} in {project}")
            role_rule = (role_rule + "\n" if role_rule else "") + (
                f"The code to look at is {a.ref} ({ref_sha[:12]}), and the project's working tree is NOT on it. "
                f"Read files with `git -C {project} show {ref_sha}:<path>`, list them with `git -C {project} "
                f"ls-tree -r --name-only {ref_sha}`, search with `git -C {project} grep -n <pattern> {ref_sha}`. "
                "Never read the working-tree copies: they're a different version.\n")
        if attribution() == "off":
            role_rule = (role_rule + "\n" if role_rule else "") + NO_ATTRIBUTION_RULE
        if role_rule:
            with open(os.path.join(workdir, "role.md"), "w") as fh:
                fh.write(role_rule)
        with open(os.path.join(workdir, "append.md"), "w") as fh:
            fh.write(build_append(project, cards, read_only, a.allow_send, bool(chrome_spec), role_rule, answer_lines))
        tools = a.tools or (READONLY_TOOLS + ",Bash" if read_only else WORKER_TOOLS)

    todo_id = (prev or {}).get("todo") or getattr(a, "todo", None)
    if todo_id is not None and not (prev or {}).get("todo"):
        data = todos()
        t = next((x for x in data["items"] if x["id"] == todo_id), None)
        if not t:
            die(f"no todo #{todo_id} (lean-agent todo list)")
        if t["status"] == "open":  # working on it now: the board shows it in progress
            t["status"] = "doing"
            save_json(home("todo.json"), data)
    allow_cmd = (prev or {}).get("allow_cmd") or [c.strip() for c in getattr(a, "allow_cmd", None) or [] if c.strip()]
    if allow_cmd and not read_only:
        die("--allow-cmd is for --read-only workers (other workers run any command)")
    for c in allow_cmd:
        bad = set(re.findall(r"[a-z]+", c.lower())) & MUTATING_WORDS
        if bad:
            die(f"--allow-cmd {c!r}: {', '.join(sorted(bad))} changes something; a read-only worker only gets "
                "commands that read (show, list, get, view, log)")
    if allow_cmd and not prev:  # tell the worker, now and on a resume (role.md is read again then)
        note = ("\nBesides read-only git you may run exactly these read-only commands (and nothing else): "
                + "; ".join(f"`{c} ...`" for c in allow_cmd) + "\n")
        for f in ("append.md", "role.md"):
            with open(os.path.join(workdir, f), "a") as fh:
                fh.write(note)
    if read_only and not allow_cmd and not prev:
        named = CLI_RE.findall(task)
        if named:
            print(f"lean-agent: warning: a --read-only worker can only run read-only git, and this task names "
                  f"`{named[0]}`. Allow exactly what it needs, e.g. --allow-cmd \"{named[0]} <read-only subcommand>\", "
                  "or look it up yourself.", file=sys.stderr)
    mcp_specs = prev.get("mcp") if prev else canonical_specs(project, a.mcp or [])
    mcp_servers, mcp_allowed, mcp_disallowed = resolve_mcp(project, mcp_specs) if mcp_specs else ({}, [], [])
    for sname, scfg in mcp_servers.items():
        for problem in lean_mcp.config_problems(scfg):
            print(f"lean-agent: warning: {sname}: {problem} (lean-agent doctor says more)", file=sys.stderr)
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
    lean_json = os.path.join(PLUGIN_ROOT, "bin", "lean-json")
    if read_only:
        allowed = READONLY_TOOLS.split(",") + [f"Bash(git -C {project} {sub}:*)" for sub in READONLY_GIT]
        allowed.append(f"Bash({lean_json}:*)")  # reads a file, prints a compact view
        allowed += [f"Bash({c}:*)" for c in allow_cmd]  # read-only commands the orchestrator named
        permission_mode = "default"
    else:
        allowed = [tools]
        permission_mode = os.environ.get("LEAN_AGENT_WORKER_PERMISSION_MODE") or "acceptEdits"

    claude = os.environ.get("LEAN_AGENT_CLAUDE") or "claude"
    cmd = [claude, "-p", "--output-format", "stream-json", "--verbose", "--model", model,
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
    flag_settings = {}
    if attribution() == "off":  # Claude Code's own commit/PR attribution, switched off for this worker
        flag_settings["attribution"] = NO_ATTRIBUTION
    hooks = {"PreToolUse": [{"matcher": "Bash", "hooks": [{  # never a push to a guarded branch (lean-agent guard)
        "type": "command", "timeout": 20, "command": f"python3 {json.dumps(os.path.join(HERE, 'push_guard.py'))}"}]}]}
    if mcp_specs:  # trim big MCP results before the model reads them
        hooks["PostToolUse"] = [{"matcher": "mcp__.*", "hooks": [{
            "type": "command", "timeout": 20,
            "command": f"python3 {json.dumps(os.path.join(HERE, 'mcp_trim_hook.py'))}"}]}]
    flag_settings["hooks"] = hooks
    if flag_settings:
        cmd += ["--settings", json.dumps(flag_settings)]
    if prev:
        cmd += ["--resume", prev["session_id"]]

    env = dict(os.environ)
    env.pop("CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD", None)  # never pull in the project's CLAUDE.md
    env.pop("LEAN_AGENT_SERVICE_SESSION", None)  # the service session's hooks (session, permission) must not act in a worker
    env["BASH_MAX_OUTPUT_LENGTH"] = os.environ.get("LEAN_AGENT_WORKER_BASH_OUTPUT") or "8000"  # not the orchestrator's
    env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "1"  # memory comes from lean-agent cards instead
    env = push_guard.git_env(env)  # git refuses pushes to guarded branches (pre-push), whatever the worker runs
    if getattr(a, "fields", None):
        env["LEAN_AGENT_MCP_FIELDS"] = a.fields

    print(f"run {run_id} started · {model} · {slug}" + (" (resumed)" if prev else "") +
          f" · see it later with `lean-agent runs --show {run_id}`", file=sys.stderr, flush=True)
    running_key = launch_key or run_id  # every run is listed while it runs (the dashboard, the status line)
    save_json(home("running", running_key + ".json"), {"pid": os.getpid(), "started": now_iso(), "run": run_id,
                                                      "task": task[:2000], "model": model, "project": slug,
                                                      "workdir": workdir, "todo": todo_id, "effort": effort,
                                                      "branch": (wt or {}).get("branch") if isinstance(wt, dict) else None,
                                                      "role": getattr(a, "role", None)
                                                      or (prev or {}).get("role")})
    for line in mcp_cost_lines(mcp_specs, chrome_spec):
        print(line, flush=True)

    wt_name = (prev or {}).get("worktree") or (wt and wt["name"])
    wt_lock = worktree_lock(slug, wt_name, read_only) if wt_name else contextlib.nullcontext()
    started = datetime.datetime.now()
    started_utc = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    max_reads = 0 if role else (a.max_reads if getattr(a, "max_reads", None) is not None
                                else env_num("LEAN_AGENT_RUN_MAX_READS", 6000000))
    def note_session(sid):  # so `lean-agent run --resume <id>` works even if this process or the worker dies
        rec = load_json(home("running", running_key + ".json"), None)
        if isinstance(rec, dict):
            save_json(home("running", running_key + ".json"), dict(rec, session_id=sid))
    try:
        with wt_lock:
            raw, err, reads = stream_worker(cmd, today_line() + "\n\n" + task, workdir, env,
                                            env_num("LEAN_AGENT_RUN_TIMEOUT", 1800), max_reads, note_session)
    except FileNotFoundError:
        die(f"'{claude}' not found on PATH")
    finally:
        if os.path.exists(mcp_path):
            os.remove(mcp_path)  # may hold tokens; rebuilt from your config on --resume
    seconds = int((datetime.datetime.now() - started).total_seconds())

    out, result_line = {}, ""
    for line in raw.splitlines():  # stream-json: the final "result" event, plus the plan's rate-limit events
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if not isinstance(ev, dict):
            continue
        if ev.get("type") == "result":
            out, result_line = ev, line
        elif ev.get("type") == "rate_limit_event":
            usage.record_plan_usage(ev.get("rate_limit_info"))
    with open(os.path.join(workdir, "result.json"), "a") as fh:
        fh.write((result_line or json.dumps({"stderr": err[-4000:], "stdout_tail": raw[-2000:]})) + "\n")

    tu = lean_mcp.transcript_usage(workdir, out.get("session_id"), started_utc)
    if tu and sum(tu.values()) > sum((out.get("usage") or {}).get(k, 0) or 0 for k in usage.FIELDS):
        out["usage"] = dict(out.get("usage") or {}, **tu)  # the result's usage can under-count; the transcript doesn't
    summary, fb = parse_feedback(out.get("result") or "")
    mcp_seq = (lean_mcp.mcp_call_sequence(workdir, out.get("session_id"), started_utc)
               if (mcp_specs or chrome_spec) else [])
    offered = offered_tools(mcp_specs)
    review = None
    if role in ("reviewer", "reuse-check"):
        summary, review = parse_marker(summary, "LEAN-REVIEW")
        save_json(os.path.join(workdir, "review.json"), review or {})
    elif role == "review-learn":
        summary, learned = parse_marker(summary, "LEAN-CHECKLIST")
        save_json(os.path.join(workdir, "checklist.json"), learned or {})
    elif role == "tracker-discover":
        summary, found = parse_marker(summary, "LEAN-TRACKER")
        save_json(os.path.join(workdir, "tracker.json"), found or {})
    details_path, n_details, answer_cut = None, 0, False
    if answer_lines and summary:
        summary, details_path, n_details, answer_cut = split_answer(summary, answer_lines, workdir)
    if reads.get("stopped") and not out.get("type"):  # stopped by lean-agent: no result event, so build one
        out = {"subtype": "error_max_context_reads", "session_id": reads.get("session_id"),
               "num_turns": reads["turns"], "usage": reads["usage"]}
    subtype = out.get("subtype") or "error"
    if subtype.startswith("error_max"):
        status = "stopped:" + subtype[len("error_"):]
        dirty = (git(project, "status", "--porcelain") or "").splitlines() if wt_name or (prev or {}).get("worktree") else []
        if dirty:
            print(f"lean-agent: run {run_id} stopped at its limit ({subtype[len('error_max_'):]}) with {len(dirty)} "
                  f"uncommitted file(s) in {project}: resume it to commit what's done and go on "
                  f"(lean-agent run --resume {run_id} \"commit what is finished, then continue\")", file=sys.stderr)
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
        "cost_usd": out.get("total_cost_usd"), "session_id": out.get("session_id") or reads.get("session_id") or (prev and prev["session_id"]),
        "resumed": bool(prev), "task": task[:300], "missing": missing_note,
        "parent_session": os.environ.get("CLAUDE_CODE_SESSION_ID"),
        "mcp": mcp_specs, "mcp_calls": {t: mcp_seq.count(t) for t in dict.fromkeys(mcp_seq)},
        "mcp_seq": mcp_seq[:60], "mcp_offered": {k: len(v) for k, v in offered.items()},
        "result_head": (summary or "")[:600],
        "read_only": read_only, "chrome": chrome_spec, "allow_send": bool(a.allow_send), "type": run_type,
        "allow_cmd": allow_cmd, "todo": todo_id,
        "role": role, "effort": effort, "worktree": wt_name, "review_meta": review_meta, "launch_key": launch_key,
        "recipe": (getattr(a, "recipe", None) or (None, None))[0],
        "recipe_step": (getattr(a, "recipe", None) or (None, None))[1],
        "estimate_usd": (getattr(a, "estimate", None) or (None, None))[0],
        "estimate_kind": (getattr(a, "estimate", None) or (None, None))[1],
        "answer_lines": answer_lines, "details": details_path,
    }
    append_jsonl(home("ledger.jsonl"), entry)
    LAST_RUN[:] = [entry]
    if running_key:
        try:
            os.remove(home("running", running_key + ".json"))
        except OSError:
            pass
    if isinstance(sys.stdout, Tee):  # a second run in the same command (review after its second opinion)
        sys.stdout.close()
    sys.stdout = Tee(sys.stdout, os.path.join(workdir, f"summary-{len(glob.glob(os.path.join(workdir, 'summary-*.txt'))) + 1}.txt"))
    lean_log.log("error" if entry["status"] in ("failed", "error") or entry["status"].startswith("stopped") else "debug",
                 "run", f"{run_id} {slug} {model} {entry['status']} {entry.get('turns') or '?'} turns "
                 f"{entry.get('units', 0):,} sonnet-eq ${entry.get('cost_usd') or 0:.2f}"
                 f"{' role ' + role if role else ''}: {task[:160]!r}"
                 + (f"; worker said: {str(out.get('result') or '')[:300]!r}" if entry["status"] in ("failed", "error") else ""))

    cost = f"${entry['cost_usd']:.2f}" if isinstance(entry["cost_usd"], (int, float)) else "$?"
    print(f"run {run_id} · {model} · {status} · {entry['turns'] or '?'} turns · {seconds}s · "
          f"{entry['units']:,} sonnet-eq tok · {cost}")
    detail(f"  tokens: input {u.get('input_tokens', 0):,} · cache write {u.get('cache_creation_input_tokens', 0):,}"
          f" · cache read {u.get('cache_read_input_tokens', 0):,} · output {u.get('output_tokens', 0):,}")
    ctx = u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0) + u.get("cache_read_input_tokens", 0)
    if ctx and entry["turns"]:
        per_turn = ctx // max(1, entry["turns"])
        own = est_tokens(read_text(os.path.join(workdir, "append.md")))
        ext = tools_overhead(mcp_specs, mcp_allowed, chrome_spec)
        n_off, n_used = sum(len(v) for v in offered.values()), len(set(mcp_seq))
        tools_note = f" ({n_off} offered, {n_used} used)" if offered else ""
        detail(f"  context per turn ~{per_turn:,}: lean-agent protocol + cards ~{own:,} · MCP/browser tools ~{ext:,}"
              f"{tools_note} · Claude Code system prompt, built-in tools, conversation ~{max(0, per_turn - own - ext):,}")
    for line in narrowing_hints(offered, mcp_seq):
        detail("  " + line)
    sv = run_savings(entry)
    if sv["context"] or sv["model"]:
        base, measured = baseline_ctx(slug)
        total = sv["context"] + sv["model"]
        model_part = (f"model choice saved ~{sv['model']:,}" if sv["model"] >= 0 else
                      f"{model} costs ~{-sv['model']:,} more than Sonnet would")
        head = f"saved ~{total:,} sonnet-eq" if total >= 0 else f"extra cost vs Sonnet ~{-total:,} sonnet-eq"
        detail(f"  {head} (estimate): context saved ~{sv['context']:,} vs a normal session's ~{base:,}/turn"
              f"{'' if measured else ' (assumed)'} · {model_part}")
    line, low = budget_line()
    if line:
        print("  " + line)
    limit = env_num("LEAN_AGENT_RESULT_CHARS", 12000)
    if summary and role in ("reviewer", "reuse-check") and BRIEF:
        detail(summary)  # the review's findings follow; the reviewer's prose is in `runs --show`
    elif summary:
        print(summary if len(summary) <= limit else summary[:limit] + f"\n… [{len(summary) - limit} chars more in {workdir}/result.json]")
    if details_path:
        print(f"details: {n_details} more lines in {details_path}"
              + (f" (the answer ran past {answer_lines} lines; the rest starts the file)" if answer_cut else "")
              + f" · read one part: lean-agent runs --show {run_id} --details --grep TEXT")
    elif status == "error":
        print((err or raw)[-1500:].strip())
    if fb:
        detail(f"feedback: used={sorted(used)} unneeded={sorted(unneeded)}" + (f" missing={missing_note!r}" if missing_note else ""))
    if remembered:
        print(f"remembered: {', '.join(remembered)}")
    turns_n = entry.get("turns") or 0
    if status == "stopped:max_context_reads":
        print(f"STOPPED by lean-agent: the worker re-read {reads['ctx']:,} tokens of context over {turns_n} turns "
              f"(~{reads['ctx'] // max(1, turns_n):,} per turn), past --max-reads {max_reads:,}. Split the task into "
              "smaller workers (one per file, item or question; -m haiku to gather, one more to combine), or let it "
              f"go on: lean-agent run --resume {run_id} --max-reads {max_reads * 2} \"continue\"")
    elif status in ("done", "partial") and turns_n >= 40 and ctx // max(1, turns_n) >= 60000:
        print(f"  heavy run: {turns_n} turns at ~{ctx // turns_n:,} context each. Next time split it into "
              "smaller parallel workers and one that combines their answers.")
    if status == "needs-input":
        print("ACTION NEEDED: the worker needs an answer (see above). Ask the user, then: "
              f"lean-agent run --resume {run_id} \"<answer>\"")
    elif status == "awaiting-confirmation":
        print("ACTION NEEDED: an outward action is prepared but NOT done. Show the user exactly what would happen. "
              f"Only if they approve: lean-agent run --resume {run_id} --allow-send \"<what was approved>\" \"Do it now\"")
    if mcp_specs or chrome_spec:
        calls = entry["mcp_calls"]
        detail("mcp: " + (", ".join(f"{k} x{v}" for k, v in sorted(calls.items())) or "no MCP tool calls"))
    print(f"resume: lean-agent run --resume {run_id} \"<follow-up>\"")
    if role == "reviewer" and (review_meta or {}).get("multi"):
        print(f"review pass {review_meta['multi']}: {len((review or {}).get('findings') or [])} findings "
              f"(merged after the last pass)")
        return 0
    if role == "reviewer":
        return report_review(slug, entry["project_path"], entry, review or {}, review_meta or {})
    if role == "reuse-check":
        n = len([r for r in (review or {}).get("reuse") or [] if isinstance(r, dict) and r.get("candidates")])
        print(f"second opinion: {n} reuse candidates passed to the reviewer")
        return 0
    return 0 if status in ("done", "partial", "needs-input", "awaiting-confirmation") else 1


def note_progress(workdir, turn, msg, u):
    """One line per worker turn in progress.jsonl (what it did, its context), for watching a run while it runs."""
    steps = []
    for c in msg.get("content") or []:
        if not isinstance(c, dict):
            continue
        if c.get("type") == "tool_use":
            inp = c.get("input") or {}
            what = next((str(inp[k]) for k in ("command", "file_path", "pattern", "url", "path", "query", "description")
                         if inp.get(k)), "")
            steps.append(f"{c.get('name')}: {' '.join(what.split())[:140]}")
        elif c.get("type") == "text" and str(c.get("text") or "").strip():
            steps.append("says: " + " ".join(str(c["text"]).split())[:140])
    ctx = sum(int(u.get(k) or 0) for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
    try:
        with open(os.path.join(workdir, "progress.jsonl"), "a") as fh:
            fh.write(json.dumps({"ts": now_iso(), "turn": turn, "ctx": ctx, "steps": steps}) + "\n")
    except OSError:
        pass


def stream_worker(cmd, prompt, workdir, env, timeout, max_reads=0, on_session=None):
    """Run a worker and read its stream-json as it comes, so a run that keeps re-reading a large context
    can be stopped (after `max_reads` context tokens summed over its calls; 0 = never) and resumed later.
    `on_session(id)` is called once, when the first event carries the session id. Returns
    (stdout, stderr, {"ctx", "turns", "usage", "session_id", "stopped"})."""
    import tempfile
    import threading
    reads = {"ctx": 0, "turns": 0, "usage": {k: 0 for k in usage.FIELDS}, "session_id": None, "stopped": False}
    seen, lines = set(), []
    with tempfile.TemporaryFile("w+") as errf:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errf, text=True,
                                cwd=workdir, env=env)
        timed_out = []

        def on_timer():
            timed_out.append(True)  # lean-agent's own timer fired: the only kill it may call a timeout
            proc.kill()
        timer = threading.Timer(timeout, on_timer)
        timer.start()
        try:
            try:
                proc.stdin.write(prompt)
                proc.stdin.close()
            except BrokenPipeError:
                pass
            for line in proc.stdout:
                lines.append(line)
                if '"session_id"' in line or '"assistant"' in line:
                    try:
                        ev = json.loads(line)
                    except ValueError:
                        continue
                    if not isinstance(ev, dict):
                        continue
                    if not reads["session_id"] and ev.get("session_id"):
                        reads["session_id"] = ev["session_id"]
                        if on_session:
                            on_session(reads["session_id"])
                    msg = ev.get("message") if ev.get("type") == "assistant" else None
                    if not isinstance(msg, dict) or not isinstance(msg.get("usage"), dict) or msg.get("id") in seen:
                        continue
                    seen.add(msg.get("id"))
                    u = msg["usage"]
                    reads["turns"] += 1
                    note_progress(workdir, reads["turns"], msg, u)
                    for k in usage.FIELDS:
                        reads["usage"][k] += int(u.get(k) or 0)
                    reads["ctx"] += sum(int(u.get(k) or 0) for k in
                                        ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
                    if max_reads and reads["ctx"] > max_reads:
                        reads["stopped"] = True
                        proc.terminate()
                        break
            if reads["stopped"]:
                try:
                    proc.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    proc.kill()
            lines.append(proc.stdout.read() or "")  # not communicate(): stdin is closed already (3.9 flushes it)
            proc.wait()
        finally:
            timer.cancel()
        errf.seek(0)
        err = errf.read()
    if timed_out:
        err = (err + f"\ntimed out after {timeout:g} s").strip()
    elif proc.returncode < 0 and not reads["stopped"]:
        n = -proc.returncode
        err = (err + f"\nkilled by signal {n}" + (" (outside lean-agent, e.g. out of memory)" if n == 9 else
                                                    " (outside lean-agent)")).strip()
    return "".join(lines), err, reads


LAST_RUN = []  # the entry of the run this process made last


def run_escalating(a):
    """--escalate haiku,sonnet: run on the first model; only if that run fails, run the task again (fresh) on
    the next one."""
    import copy
    models = [m.strip() for m in a.escalate.split(",") if m.strip()]
    if a.task == ["-"] or (not a.task and a.task_file is None and not sys.stdin.isatty()):
        a.task, a.task_file = [sys.stdin.read().strip()], None  # read once, for every attempt
    rc = 1
    print(f"escalate: {' -> '.join(models)} (the next model only if a run fails)", flush=True)
    for i, model in enumerate(models):
        b = copy.copy(a)
        b.escalate, b.model, b.again = None, model, a.again or i > 0
        b.why = a.why or f"escalation {'/'.join(models)}"
        LAST_RUN[:] = []
        rc = cmd_run(b)
        last = LAST_RUN[0] if LAST_RUN else {}
        if done_ok(last) or last.get("status") == "partial" or i == len(models) - 1:
            return rc
        print(f"escalating: {model} run {last.get('id')} ended {last.get('status')}; trying {models[i + 1]}",
              flush=True)
    return rc


def split_answer(text, n, workdir):
    """(answer, details file, detail lines, cut) for a reply written to the answer contract: what follows the
    DETAILS line goes to a file. An answer far over n lines is cut there too (the rest opens the file), so
    nothing is lost, only kept out of the orchestrator's context."""
    head, _, rest = text.partition(DETAILS_MARK)
    head, rest, cut = head.rstrip(), rest.strip("\n"), False
    lines = head.splitlines()
    if len(lines) > n + 5:  # some slack: the contract is the worker's, this is only the safety net
        head, cut = "\n".join(lines[:n]), True
        rest = "\n".join(lines[n:]) + ("\n\n" + rest if rest else "")
    if not rest.strip():
        return head, None, 0, False
    path = os.path.join(workdir, f"details-{len(glob.glob(os.path.join(workdir, 'details-*.md'))) + 1}.md")
    with open(path, "w") as fh:
        fh.write(rest.rstrip() + "\n")
    return head, path, len(rest.splitlines()), cut


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
and git history. You can't run tests, build, or change anything, and you mustn't try. Spend your turns on
reading and searching the code, not on style.

The change: {scope}
Start with `git -C {project} diff --stat {diff_range}`, then read each file's diff with
`git -C {project} diff {diff_range} -- <file>`, and only the surrounding code you need (line ranges).
The code before the change: `git -C {project} show {base_ref}:<path>`.
{read_rule}
New symbols and files in this change (found by lean-agent; check every one): {new_symbols}
{focus}
Do these passes in order. Report what you searched and found fine, and what you could not verify.

0. Completeness: what the change promises versus what it delivers. In one line, state its goal (from the stated
   goal below, the branch name, commit messages, docs). Then follow the whole chain the goal needs (for a feature:
   code, config, build, signing, hosting/upload, update path, pipeline step, user-facing docs) and say which
   parts the change makes work and which it doesn't. Every self-declared gap (listed above, or one you find:
   "not done yet", TODO, placeholder, a doc saying it doesn't work yet) goes in "gaps". A gap that keeps the goal
   from working is a major finding (category "completeness") unless the change says it's out of scope; when it
   plausibly is out of scope, list it in "gaps" with "scoped_out" saying where that's stated or "ask the user".
1. Correctness, tracing each changed path end to end: from its entry points (callers, events, timers) through
   the changed code to its effects (state, requests, callbacks, consumers). Concurrency, ordering, cleanup on
   logout/teardown, error paths, edge cases. Does the change do what it says?
2. Reuse and duplication. For every new file, hook, store, util, component, class or exported function above:
   search the repository (Grep/Glob, `git -C {project} grep -n <pattern> {grep_ref}`) for existing code with the
   same job, by name, key identifiers and behaviour words (counter, register, subscribe, store, cache, overlay,
   defer, retry, debounce, poll, map). At least one search per new symbol. A thin wrapper or hook that calls
   existing code is "wraps-existing" (reuse done right); read the new symbol's body before calling it a copy.
3. Scope and platform. Does it fix one instance of a class of problem (one dialog, field, site, endpoint) while
   siblings share the cause? List the siblings you checked. For new state handling (dismiss, hide, defer,
   cleanup, retries, caching), is there an existing hook or lifecycle that already does it reversibly?
4. Tests. For every test the change edits so that its assertions change (renamed, expectation flipped,
   deleted, skipped; the list above): what behaviour did it protect before? Is that still protected by another
   test (search), lost, or removed on purpose (say why)? For each new or changed behaviour, is the complement
   tested (the case that must NOT change), and the scoped vs unscoped / empty / boundary variants? Read each new
   test against the code before the change: would it fail without the fix? Lost coverage of behaviour the
   change says must stay is major; a missing test for a boundary or complement case of new behaviour is minor
   (list the cases), unless the code for that case is wrong.
5. Defaults and state. For each new or changed parameter with a default (list above): do production callers
   always pass it? If so, the default only hides mistakes ("make it required", minor); if the default
   recomputes something the fix says must be captured earlier, it's a correctness finding. When the change
   merges, widens or substitutes a value (scope, filter, version, token), list the consumers of the old value
   (flags, timestamps, caches, metrics) and check they see the right one. For new module-level state (list
   above): do the specs reset it, or does the module export a reset? Accidental isolation is a nit (tests).
6. Then style and comments: import cycles, misleading names or comments, dead code. Skip what a linter catches.

Severity: blocker (must fix before the PR), major (should fix), minor, nit. Duplication is major only when the
change copies logic that exists elsewhere (about 10+ lines, or a multi-branch algorithm) or adds a second copy
of a mechanism (a counter, store, subscription, cache); a field map, label formatter or 2-3 line pattern is
minor, and duplication that already exists across other components is a minor follow-up. A too-narrow fix
with obvious siblings is major. If you'd call it optional, it is minor. A finding that rests on something you
didn't verify goes under "checks" ("unverified: ..."), not as a major. Style never outranks the passes above.
Reuse verdicts: "duplicate" (copies existing code outside this change: reuse it instead), "extends-existing" or
"wraps-existing" (builds on existing code: good, no finding), "justified-new" (nothing existing fits; say why).
Categories: completeness, correctness, duplication, scope, platform, tests, security, compatibility, performance,
style.
Verdict: "approve" (no blockers or majors, every new symbol has a reuse entry, every edited test has a
coverage entry), "changes-requested", or "needs-checks" (you can't judge without something being run).
Be specific (file:line, what, why, a concrete suggestion). Don't pad: if the change is good, approve it.

Before the LEAN-FEEDBACK line, add one line exactly like this (valid JSON, one line):
LEAN-REVIEW {{"verdict": "approve|changes-requested|needs-checks", "searches": [{{"for": "what you searched", "found": "file:line, ... or nothing"}}], "reuse": [{{"symbol": "new symbol", "candidates": ["file:line existing symbol"], "verdict": "duplicate|extends-existing|wraps-existing|justified-new", "why": "..."}}], "siblings": [{{"checked": "sibling", "needs_fix": true}}], "coverage": [{{"test": "edited test", "protected": "behaviour it protected", "verdict": "still-covered|lost|intentional", "by": "other test or why"}}], "findings": [{{"severity": "blocker|major|minor|nit", "category": "completeness|correctness|duplication|scope|platform|tests|security|compatibility|performance|style", "file": "path", "line": 0, "issue": "...", "why": "...", "suggestion": "..."}}], "checks": [{{"what": "what to run or verify", "why": "..."}}], "fine": ["what you checked and found fine"], "unverified": ["what you could not verify"], "goal": "what the change promises, in one line", "gaps": [{{"what": "what isn't delivered", "file": "path or commit", "line": 0, "blocks_goal": true, "scoped_out": "where it says it's out of scope, or ask the user, or empty"}}]}}
"""

REUSE_RULE = """\
Role: a fast, search-only second opinion before the main review. You can only read code and git history.
Your only job: for each new symbol or file below, find existing code in the repository that already does
the same job, so the change doesn't add a duplicate. Don't review style, tests or correctness.

The change: {scope}
{read_rule}
New symbols and files: {new_symbols}

A thin wrapper or hook that calls existing code is "wraps-existing" (fine), not a duplicate.
{decisions}
For each one, read its definition in the diff (`git -C {project} diff {diff_range} -- <file>`), then search
the repository by name, key identifiers and behaviour words (counter, register, subscribe, store, overlay,
defer, hide, retry, debounce, poll, map) with Grep/Glob or `git -C {project} grep -n <pattern> {grep_ref}`.
Also note siblings that share the problem (other dialogs, fields, endpoints). Be brief.

Before the LEAN-FEEDBACK line, add one line exactly like this (valid JSON, one line):
LEAN-REVIEW {{"verdict": "needs-checks", "searches": [{{"for": "...", "found": "..."}}], "reuse": [{{"symbol": "...", "candidates": ["file:line existing symbol"], "verdict": "duplicate|extends-existing|wraps-existing|justified-new", "why": "..."}}], "siblings": [{{"checked": "...", "needs_fix": true}}], "findings": [], "checks": []}}
"""

NEW_SYMBOL_RES = [re.compile(p) for p in (
    r"^\+\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)",
    r"^\+\s*(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)",
    r"^\+\s*(?:const|let)\s+(use[A-Z][\w$]*|[\w$]*(?:Store|Context|Provider|Manager|Registry|Service))\s*[=:]",
    r"^\+\s*(?:async\s+)?def\s+([A-Za-z]\w*)",
    r"^\+\s*class\s+([A-Za-z_]\w*)",
    r"^\+func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)",
    r"^\+\s*pub(?:\(crate\))?\s+(?:async\s+)?(?:fn|struct|enum|trait)\s+(\w+)",
    r"^\+\s*(?:public|internal|protected)\s+(?:static\s+|sealed\s+|abstract\s+|partial\s+|async\s+|override\s+|virtual\s+)*"
    r"(?:class|interface|record|struct|enum)\s+(\w+)",
    r"^\+\s*(?:public|internal)\s+(?:static\s+|async\s+|override\s+|virtual\s+)*[\w<>\[\],.?]+\s+([A-Z]\w*)\s*\(",
)]
TEST_PATH_RE = re.compile(r"(^|/)(tests?|__tests__|spec|e2e)(/|$)|[._-](test|spec)s?\.\w+$|_test\.go$", re.I)


def changed_hunks(path, rng_args):
    """{file: [(first, last), ...]} of the lines this change adds or edits (new side of the diff)."""
    out, cur = {}, None
    for line in (git(path, "diff", "-U0", "--no-color", *rng_args) or "").splitlines():
        if line.startswith("+++ "):
            cur = line[6:] if line.startswith("+++ b/") else None
        elif line.startswith("@@") and cur:
            m = re.search(r"\+(\d+)(?:,(\d+))?", line)
            if m:
                start, n = int(m.group(1)), int(m.group(2) or 1)
                if n:
                    out.setdefault(cur, []).append((start, start + n - 1))
    return out


def existed_before(path, base, rel, name):
    """Whether `name` was already defined in `rel` at `base` (then the change edits it; it isn't new)."""
    text = git(path, "show", f"{base}:{rel}") if base else None
    if not text:
        return False
    return re.search(r"\b(function\*?|const|let|var|class|interface|type|enum|def|func|fn|struct|trait|record)\s+"
                     + re.escape(name) + r"\b", text) is not None or re.search(
                     r"^\s*(public|internal|protected|private)?[\w<>\[\],.?\s]*\b" + re.escape(name) + r"\s*\(",
                     text, re.M) is not None and name[:1].isupper()


def new_symbols(path, rng_args, new_files=()):
    """New files and newly defined symbols in a diff (not in test files), for the reuse pass. A symbol that
    already existed at the base (a signature change, an edit) isn't new."""
    diff = git(path, "diff", "-U0", "--no-color", *rng_args) or ""
    base = rng_args[0] if rng_args else None
    files, syms, cur = [], [], None
    for line in diff.splitlines():
        if line.startswith("+++ "):
            cur = line[6:] if line.startswith("+++ b/") else None
            continue
        if line.startswith("new file mode") or cur is None or TEST_PATH_RE.search(cur or ""):
            continue
        for rx in NEW_SYMBOL_RES:
            m = rx.match(line)
            if m:
                name = m.group(1)
                if len(name) > 2 and (name, cur) not in syms and not existed_before(path, base, cur, name):
                    syms.append((name, cur))
                break
    for line in (git(path, "diff", "--name-status", *rng_args) or "").splitlines():
        st, _, f = line.partition("\t")
        if st.startswith("A") and not TEST_PATH_RE.search(f):
            files.append(f)
    for f in new_files:  # untracked files: their content is all new
        if TEST_PATH_RE.search(f):
            continue
        files.append(f)
        try:
            with open(os.path.join(path, f), errors="replace") as fh:
                for text in fh.read(200000).splitlines():
                    for rx in NEW_SYMBOL_RES:
                        m = rx.match("+" + text)
                        if m and len(m.group(1)) > 2 and (m.group(1), f) not in syms:
                            syms.append((m.group(1), f))
                            break
        except OSError:
            pass
    return {"files": list(dict.fromkeys(files))[:20], "symbols": [f"{n} ({f})" for n, f in syms[:30]]}


TEST_TITLE_RE = re.compile(r"""^\s*(?:it|test|specify)(?:\.(?:only|skip|each\([^)]*\)))?\s*\(\s*(['"`])(.+?)\1|"""
                           r"""^\s*(?:async\s+)?def\s+(test_\w+)|^func\s+(Test\w+)|"""
                           r"""^\s*\[(?:Fact|Test|TestMethod|Theory)\][^\n]*|^\s*public\s+(?:async\s+)?\w+\s+(\w+Test\w*)\s*\(""")
ASSERT_RE = re.compile(r"\b(expect|assert\w*|should|toBe|toEqual|toHaveBeenCalled\w*|toMatch\w*|Assert\.)", re.I)
SKIP_RE = re.compile(r"\b(it|test|describe)\.skip\b|\bx(it|describe)\s*\(|@(pytest\.mark\.)?skip|\[Ignore\]|t\.Skip\(")
DEF_START_RE = re.compile(r"(?:\bfunction\b[^(]*|\bdef\s+\w+\s*|\b\w+\s*=\s*(?:async\s*)?|^\s*(?:export\s+)?(?:async\s+)?"
                          r"(?:public\s+|private\s+|static\s+)*\w+\s*)\(")


def def_params(line):
    """Parameters of a function defined on this line (balanced parentheses), split at top-level commas."""
    m = DEF_START_RE.search(line)
    if not m or not re.search(r"\bfunction\b|\bdef\b|=>|\)\s*(\{|:)", line):
        return []
    i, depth, buf, parts = m.end(), 1, "", []
    while i < len(line) and depth:
        ch = line[i]
        depth += ch in "([{"
        depth -= ch in ")]}"
        if depth and ch == "," and depth == 1:
            parts.append(buf)
            buf = ""
        elif depth:
            buf += ch
        i += 1
    return parts + ([buf] if buf.strip() else [])
MODULE_STATE_RE = re.compile(r"^(?:export\s+)?(?:let|var)\s+([A-Za-z_$][\w$]*)|^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*="
                             r"\s*(?:new\s+(?:Map|Set|WeakMap|Array)\b|\[|\{)|^([a-z_]\w*)\s*(?::\s*[\w\[\], ]+)?=\s*"
                             r"(?:\[|\{|None\b|set\(|dict\(|0\b)")


def _test_title(line):
    m = TEST_TITLE_RE.match(line)
    if not m:
        return None
    return next((g for g in (m.group(2), m.group(3), m.group(4), m.group(5)) if g), None) or line.strip()[:60]


def change_focus(path, rng_args):
    """What a reviewer should look at besides reuse, found from the diff without a model:
    tests whose assertions the change edits (renamed, flipped, deleted, skipped), new parameters with defaults,
    and new module-level state."""
    base = rng_args[0] if rng_args else None
    diff = git(path, "diff", "-U0", "--no-color", *rng_args) or ""
    tests, params, state = {}, [], []
    cur = old_line = new_line = None
    removed_titles, added_titles = {}, {}
    old_assert_lines = {}
    hunks = []  # (file, [removed lines], [added lines]) to spot pure renames
    for line in diff.splitlines():
        if line.startswith("+++ "):
            cur = line[6:] if line.startswith("+++ b/") else None
            continue
        if line.startswith("--- "):
            continue
        m = re.match(r"^@@ -(\d+)(?:,\d+)? \+(\d+)", line)
        if m:
            old_line, new_line = int(m.group(1)), int(m.group(2))
            hunks.append((cur, [], []))
            continue
        if hunks and line[:1] in "+-":
            hunks[-1][1 if line[0] == "-" else 2].append(line[1:])
        if cur is None or old_line is None:
            continue
        is_test = bool(TEST_PATH_RE.search(cur))
        if line.startswith("-"):
            body = line[1:]
            if is_test:
                t = _test_title(body)
                if t:
                    removed_titles.setdefault(cur, []).append(t)
                if ASSERT_RE.search(body):
                    old_assert_lines.setdefault(cur, []).append(old_line)
            old_line += 1
        elif line.startswith("+"):
            body = line[1:]
            if is_test:
                t = _test_title(body)
                if t:
                    added_titles.setdefault(cur, []).append(t)
                if SKIP_RE.search(body):
                    tests.setdefault(cur, {})[(t or body.strip())[:80]] = "skipped"
            else:
                for part in def_params(body):
                    pm = re.match(r"\s*([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=\s*(.+)", part)
                    if pm and not part.strip().startswith("..."):
                        params.append(f"{pm.group(1)} = {pm.group(2).strip()} ({cur}:{new_line})")
                ms = MODULE_STATE_RE.match(body)
                if ms and not body.startswith((" ", "\t")):
                    name = next(g for g in ms.groups() if g)
                    base_text = (git(path, "show", f"{base}:{cur}") or "") if base else ""
                    if not re.search(r"^(?:export\s+)?(?:let|var|const)?\s*" + re.escape(name) + r"\b\s*[:=]",
                                     base_text, re.M):
                        state.append(f"{name} ({cur}:{new_line})")
            new_line += 1
    renamed = {}  # a hunk that only swaps one test title for a similar one: same body, same assertions
    for f, rem, add in hunks:
        if f and TEST_PATH_RE.search(f) and len(rem) == 1 and len(add) == 1:
            old_t, new_t = _test_title(rem[0]), _test_title(add[0])
            if old_t and new_t and _jaccard(_words(old_t), _words(new_t)) >= 0.5:
                renamed[(f, old_t)] = new_t
    for f, titles in removed_titles.items():
        added = set(added_titles.get(f, []))
        for t in titles:
            if t not in added and (f, t) not in renamed:
                tests.setdefault(f, {})[t] = "renamed or removed"
    for f, lines in old_assert_lines.items():  # map removed assertion lines to the test they were in
        text = git(path, "show", f"{base}:{f}") if base else None
        if not text:
            continue
        starts = [(i + 1, _test_title(l)) for i, l in enumerate(text.splitlines()) if _test_title(l)]
        for ln in lines:
            owner = None
            for start, title in starts:
                if start <= ln:
                    owner = title
            if owner:
                tests.setdefault(f, {}).setdefault(owner, "assertions changed")
    for (f, t) in renamed:
        if tests.get(f, {}).get(t) == "assertions changed":
            continue  # renamed AND its assertions changed: still needs a coverage entry
        tests.get(f, {}).pop(t, None)
    return {"tests": [f"{f}: '{t}' ({why})" for f, d in tests.items() for t, why in d.items()][:25],
            "params": list(dict.fromkeys(params))[:15], "state": list(dict.fromkeys(state))[:15],
            "renamed": [f"{f}: '{o}' -> '{n}'" for (f, o), n in renamed.items()][:15]}


GAP_RE = re.compile(
    r"\bnot (?:done|implemented|supported|wired(?: up)?|hosted|signed|published|shipped|built|handled|ready)(?: yet)?\b"
    r"|\bnot yet\b|\bno [\w-]+(?: [\w-]+)? yet\b|\bcan(?:not|'t) be (?:shipped|released|used|installed)\b"
    r"|\binstalls nothing\b|\bdoes nothing yet\b|\bplaceholder\b|\bstub(?:bed)?\b|\bfollow[- ]up\b"
    r"|\bcoming soon\b|\buntil (?:one|it|this|that|they) (?:is|are)\b|\bwork in progress\b", re.I)
GAP_MARK_RE = re.compile(r"\b(TODO|FIXME|XXX|TBD)\b")
DOC_PLACEHOLDER_RE = re.compile(r"<(?:your[-_ ]?)?[a-z][\w-]*(?:host|url|domain|token|tenant|org|server|bucket|endpoint)[\w-]*>",
                                re.I)
DOC_RE = re.compile(r"\.(md|mdx|rst|txt|adoc)$|(^|/)(docs?|README)[/.]", re.I)
# in code only comments count, and not the words code uses for things (a placeholder, a stub, a follow-up call)
CODE_GAP_RE = re.compile(
    r"\bnot (?:done|implemented|supported|wired(?: up)?|hosted|signed|published|shipped|built|handled|ready)(?: yet)?\b"
    r"|\bnot yet\b|\bno [\w-]+(?: [\w-]+)? yet\b|\bcan(?:not|'t) be (?:shipped|released|used|installed)\b"
    r"|\binstalls nothing\b|\bdoes nothing yet\b|\buntil (?:one|it|this|that|they) (?:is|are)\b", re.I)
NOT_IMPLEMENTED_RE = re.compile(r"not implemented|NotImplemented", re.I)
SKIP_GAP_FILE_RE = re.compile(r"(^|/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|\.min\.\w+$|\.(png|jpe?g|gif|ico|pdf|zip|lock)$")
COMMENT_STARTS = ("//", "#", "*", "/*", "<!--", "--", ";", '"' * 3, "'" * 3)


def comment_part(body):
    """The comment in a line of code ('' if none): a whole-line comment, or what follows // # /* <!-- after code."""
    s = body.lstrip()
    if s.startswith(COMMENT_STARTS):
        return s
    m = re.search(r"\s(?://|#|/\*|<!--)\s?(.*)$", body)
    return m.group(1) if m else ""


def gap_line(rel, body):
    """Whether an added line says something isn't done: any line of a doc; the comments of code."""
    if SKIP_GAP_FILE_RE.search(rel):
        return False
    if DOC_RE.search(rel):
        return bool(GAP_RE.search(body) or GAP_MARK_RE.search(body) or DOC_PLACEHOLDER_RE.search(body))
    note = comment_part(body)
    return bool((note and (CODE_GAP_RE.search(note) or GAP_MARK_RE.search(note))) or NOT_IMPLEMENTED_RE.search(body))


def self_declared_gaps(path, rng_args, new_files=()):
    """Lines the change adds (code, docs, comments) and its commit messages that say something isn't done:
    "not done yet", "not yet wired", TODO, placeholder, stub, "<host>" in a doc, ... A change can document its own
    gap; the reviewer has to say whether that gap keeps the change from doing what it promises."""
    out, cur, line_no = [], None, 0
    for line in (git(path, "diff", "-U0", "--no-color", *rng_args) or "").splitlines():
        if line.startswith("+++ "):
            cur = line[6:] if line.startswith("+++ b/") else None
            continue
        m = re.match(r"^@@ -\d+(?:,\d+)? \+(\d+)", line)
        if m:
            line_no = int(m.group(1))
            continue
        if line.startswith("+") and cur:
            body = line[1:].strip()
            if gap_line(cur, body):
                out.append(f"{cur}:{line_no}: {body[:160]}")
            line_no += 1
    for rel in new_files:  # untracked files in a working-tree review: every line is new
        try:
            with open(os.path.join(path, rel), errors="replace") as fh:
                for i, body in enumerate(fh.read(200000).splitlines(), 1):
                    if gap_line(rel, body.strip()):
                        out.append(f"{rel}:{i}: {body.strip()[:160]}")
        except (OSError, UnicodeDecodeError):
            pass
    rng = rng_args[0] + ".." + rng_args[1] if len(rng_args) == 2 else (rng_args[0] + "..HEAD" if rng_args else "")
    for msg in (git(path, "log", "--format=%s%n%b", rng) or "").splitlines() if rng else []:
        if GAP_RE.search(msg) or GAP_MARK_RE.search(msg):
            out.append(f"commit message: {msg.strip()[:160]}")
    return list(dict.fromkeys(out))[:25]


def sparse_checkout_dirs(path, ref):
    """{pipeline file: [dirs]} for CI pipelines in the repository that check out only some directories."""
    out = {}
    files = (git(path, "grep", "-l", "-E", "sparseCheckoutDirectories|sparse-checkout", ref, "--",
                 "*.yml", "*.yaml") or "").splitlines()
    for f in files:
        f = f.split(":", 1)[1] if f.startswith(ref + ":") else f
        text = git(path, "show", f"{ref}:{f}") or ""
        dirs = []
        for m in re.finditer(r"sparseCheckoutDirectories:\s*['\"]?([^'\"\n]+)", text):
            dirs += m.group(1).split()
        for m in re.finditer(r"sparse-checkout:\s*(\|[^\n]*\n((?:[ \t]+\S[^\n]*\n?)+)|['\"]?([^'\"\n|]+))", text):
            dirs += (m.group(2) or m.group(3) or "").split()
        dirs = [d.strip("/").strip() for d in dirs if d.strip("/").strip() and not d.startswith("#")]
        if dirs:
            out[f] = dirs
    return out


def ci_parity(path, rng_args, head="HEAD"):
    """Paths the change's tests read in top-level folders a sparse CI checkout leaves out: green in a worker's full
    worktree, red in CI."""
    pipelines = sparse_checkout_dirs(path, head)
    if not pipelines:
        return []
    covered = {d for ds in pipelines.values() for d in ds}
    top = set((git(path, "ls-tree", "--name-only", "-d", head) or "").split())
    out, cur, line_no = [], None, 0
    for line in (git(path, "diff", "-U0", "--no-color", *rng_args) or "").splitlines():
        if line.startswith("+++ "):
            cur = line[6:] if line.startswith("+++ b/") else None
            continue
        m = re.match(r"^@@ -\d+(?:,\d+)? \+(\d+)", line)
        if m:
            line_no = int(m.group(1))
            continue
        if line.startswith("+") and cur:
            if TEST_PATH_RE.search(cur):
                for lit in re.findall(r"['\"`]([^'\"`\s]{2,})['\"`]", line[1:]):
                    seg = re.sub(r"^(\.\.?/)+", "", lit).split("/")[0]
                    if seg in top and not any(d == seg or d.startswith(seg + "/") or seg.startswith(d + "/")
                                              for d in covered):
                        pipe = ", ".join(f"{f} ({' '.join(ds)})" for f, ds in pipelines.items())[:200]
                        out.append(f"{cur}:{line_no}: reads `{lit}`, outside the sparse checkout of {pipe}")
            line_no += 1
    return list(dict.fromkeys(out))[:15]


def focus_text(fc):
    parts = []
    if fc.get("renamed"):
        parts.append("Tests only renamed (same body; no coverage entry needed):\n" +
                     "\n".join(f"- {t}" for t in fc["renamed"]))
    if fc["tests"]:
        parts.append("Tests whose assertions this change edits (pass 4: what did each protect, is that still "
                     "protected elsewhere, or was it removed on purpose?):\n" + "\n".join(f"- {t}" for t in fc["tests"]))
    if fc["params"]:
        parts.append("New or changed parameters with defaults (pass 5):\n" + "\n".join(f"- {p}" for p in fc["params"]))
    if fc["state"]:
        parts.append("New module-level state (pass 5: do the specs reset it?):\n" + "\n".join(f"- {x}" for x in fc["state"]))
    if fc.get("ci_parity"):
        parts.append("CI parity: tests that read folders the CI pipeline's sparse checkout leaves out (they pass in a "
                     "full worktree and fail in CI; pass 4):\n" + "\n".join(f"- {x}" for x in fc["ci_parity"]))
    if fc.get("gaps"):
        parts.append("Self-declared gaps: added lines and commit messages that say something isn't done (pass 0: "
                     "does each keep the change from doing what it promises? Put every one in \"gaps\"):\n"
                     + "\n".join(f"- {g}" for g in fc["gaps"]))
    return ("\n".join(parts) + "\n") if parts else ""


def symbols_text(ns):
    parts = [f"new file {f}" for f in ns["files"]] + ns["symbols"]
    return ("\n" + "\n".join(f"- {p}" for p in parts)) if parts else "none found automatically (still check new code)"


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
    same = [r for r in read_jsonl(reviews_path(slug)) if r["head"] == sha and r.get("dirty", "") == dirty]
    return decisive(same), (sha, label)


def decisive(records):
    """The review that counts among reviews of the same commit: the latest that decided (approve or
    changes-requested); a later needs-checks run (a check, a --resume test) doesn't hide it. None if empty."""
    if not records:
        return None
    decided = [r for r in records if r.get("verdict") in ("approve", "changes-requested")]
    return (decided or records)[-1]


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


def declined_path(slug):
    return home("reviews", slug + ".declined.jsonl")


def bare_ref(ref):
    return re.sub(r"^(refs/heads/|refs/remotes/)?(origin/)?", "", str(ref or ""))


_BRANCH_OF = {}


def branch_of(path, ref):
    """The branch a review of `ref` belongs to, so reviews and decisions follow the branch, not the commit: the
    branch's own name, or the one branch (other than the base branches) whose history holds that commit; ''."""
    if not path or not ref or ref == "working tree":
        return ""
    key = (path, ref)
    if key in _BRANCH_OF:
        return _BRANCH_OF[key]
    b = bare_ref(ref)
    out = ""
    if any(git(path, "show-ref", "--verify", "--quiet", r) is not None for r in (f"refs/heads/{b}", f"refs/remotes/origin/{b}")):
        out = b
    else:
        sha = git(path, "rev-parse", "--verify", "--quiet", ref + "^{commit}")
        if sha:
            bases = {"HEAD", "main", "master", "develop", "origin", bare_ref(default_base(path) or "")}
            names = {bare_ref(n) for n in (git(path, "for-each-ref", "--contains", sha, "--format=%(refname:short)",
                                               "refs/heads", "refs/remotes") or "").split()} - bases
            out = next(iter(names)) if len(names) == 1 else ""
    _BRANCH_OF[key] = out
    return out


def same_line(path, old, new, branch=""):
    """Whether commit `new` continues the work reviewed at `old`: `old` is in its history, or it was amended or
    rebased away on the same branch (the branch's reflog had it)."""
    if not old or not new:
        return False
    if old == new or git(path, "merge-base", "--is-ancestor", old, new) is not None:
        return True
    for r in ([branch, f"origin/{branch}"] if branch else []):
        if old in (git(path, "log", "-g", "--format=%H", r) or "").split():
            return True
    return False


def code_moved(path, old, new, file, line, around=3):
    """Whether the lines around `file:line` (at commit `old`) changed by commit `new`."""
    try:
        line = int(line)
    except (TypeError, ValueError):
        return False
    if not line or not old or not new or old == new:
        return False
    diff = git(path, "diff", "-U0", "--no-color", old, new, "--", str(file)) or ""
    for m in re.finditer(r"^@@ -(\d+)(?:,(\d+))? ", diff, re.M):
        start, n = int(m.group(1)), int(m.group(2) or 1)
        if start - around <= line <= start + max(n, 1) + around:
            return True
    return False


def declined_for(slug, ref, path=None, head=None, include_moved=False):
    """What the user declined for this branch (or for every branch): recognised on later commits of the same
    branch; one whose code changed since no longer applies by itself (include_moved: listed, marked "moved")."""
    br = branch_of(path, ref) if path else ""
    out = []
    for d in read_jsonl(declined_path(slug)):
        if not (d.get("ref") in (ref, None) or (br and (d.get("branch") == br or bare_ref(d.get("ref")) == br))):
            continue
        if path and head and d.get("head") and d.get("file") and code_moved(path, d["head"], head, d["file"], d.get("line")):
            if include_moved:
                out.append(dict(d, moved=True))
            continue  # the code it was about changed: it may come up again
        out.append(d)
    return out


def decisions_text(slug, ref, path=None, head=None):
    """Earlier findings and declined ones for this branch, for the reviewers to respect."""
    lines = [(f"- out of scope (the user's word): {d.get('file', '?')}: {d.get('gap', '')[:160]} (why: {d.get('why', '')[:160]})"
              if d.get("gap") else
              f"- declined: [{d.get('category') or '?'}] {d.get('file', '?')}: {d.get('issue', '')[:160]} "
              f"(why: {d.get('why', '')[:160]})") + (" [the code it points at changed since: raise it only if it "
                                                     "still applies]" if d.get("moved") else "")
             for d in declined_for(slug, ref, path, head, include_moved=True)][:15]
    if not lines:
        return ""
    return ("Decided with the author earlier (don't raise these again unless the change makes them newly "
            "relevant, and then say what changed):\n" + "\n".join(lines) + "\n")


def _words(t):
    return {w for w in re.findall(r"[a-z0-9]{3,}", str(t).lower())}


def finding_symbol(f):
    """The code symbol a finding is about: its own field, else the first identifier-like word in its text."""
    if f.get("symbol"):
        return str(f["symbol"]).split(" (")[0]
    text = " ".join(str(f.get(k, "")) for k in ("issue", "file"))
    m = re.search(r"`([A-Za-z_$][\w$.]{2,})`", text) or re.search(r"\b([a-z]+[A-Z][\w$]*|[A-Z][a-z]+[A-Z][\w$]*)\b", text)
    return m.group(1) if m else ""


def _norm_gap(t):
    return " ".join(re.findall(r"[a-z]{3,}", str(t).lower()))


def gap_declined(g, declined):
    """A known gap the user acknowledged (lean-agent review decline <project> g<n>), recognised on later tips by
    file and normalised text, whatever number it gets and however the reviewer words it."""
    text = _norm_gap(g.get("what", ""))
    for d in declined:
        if not d.get("gap"):
            continue
        theirs = _norm_gap(d["gap"])
        same_file = os.path.basename(str(d.get("file") or "")) == os.path.basename(str(g.get("file") or ""))
        if text and theirs and (text in theirs or theirs in text):
            return True
        if _jaccard(set(text.split()), set(theirs.split())) >= (0.25 if same_file else 0.45):
            return True
    return False


def is_declined(f, declined):
    sym = finding_symbol(f)
    for d in declined:
        if d.get("symbol") and sym and d["symbol"] == sym and (not d.get("category") or not f.get("category")
                                                                or d["category"] == f["category"]):
            return True  # stable key: same symbol and kind, whatever the number, file field or wording
        if d.get("category") and f.get("category") and d["category"] != f["category"]:
            continue
        if d.get("file") and f.get("file") and os.path.basename(str(d["file"])) != os.path.basename(str(f["file"])):
            continue
        if _jaccard(_words(f.get("issue", "")), _words(d.get("issue", ""))) >= 0.35:
            return True
    return False


def second_opinion(a, slug, path, ns_syms, names, scope, read_rule, rng, grep_ref, cards):
    """For big or new-abstraction diffs, a cheap search-only pass for reuse candidates; their text, or ''."""
    mode = getattr(a, "second_opinion", "auto") or "auto"
    big = len(ns_syms["symbols"]) >= 3 or len(ns_syms["files"]) >= 2 or len(names) >= 12
    if mode == "off" or (mode == "auto" and not big) or not (ns_syms["symbols"] or ns_syms["files"]):
        return ""
    model = os.environ.get("LEAN_AGENT_REUSE_MODEL") or "haiku"
    print(f"review: second opinion first ({model}, search-only reuse pass)", flush=True)
    ns = argparse.Namespace(resume=None, task=["Find existing code that the new symbols duplicate."], task_file=None,
                            model=model, why="reuse/duplication second opinion", cards=None, card_list=cards,
                            project=slug, read_only=True, chrome=None, mcp=None, tools=None, allow_send=None,
                            max_turns=30, max_usd=1.0, max_context=a.max_context, ttype="review", role="reuse-check",
                            review_meta={"ref": getattr(a, "_label", None), "mode": "second-opinion"},
                            effort="low", role_rule=REUSE_RULE.format(scope=scope, project=path, diff_range=rng,
                                                                     read_rule=read_rule, grep_ref=grep_ref,
                                                                     new_symbols=symbols_text(ns_syms),
                                                                     decisions=getattr(a, "_decisions", "")))
    try:
        cmd_run(ns)
    except SystemExit:
        return ""
    run = next((r for r in reversed(ledger()) if r.get("role") == "reuse-check" and r["project"] == slug), None)
    rv = load_json(os.path.join(run["workdir"], "review.json"), {}) if run else {}
    lines = []
    for r in rv.get("reuse") or []:
        if isinstance(r, dict) and r.get("candidates") and r.get("verdict") not in REUSE_OK:
            lines.append(f"- {r.get('symbol')}: {', '.join(map(str, r['candidates']))[:300]} "
                         f"(suggests {r.get('verdict', '?')}: {str(r.get('why', ''))[:160]})")
    for sb in rv.get("siblings") or []:
        if isinstance(sb, dict) and sb.get("needs_fix"):
            lines.append(f"- sibling that may share the problem: {sb.get('checked')}")
    a._second = [r for r in rv.get("reuse") or [] if isinstance(r, dict) and r.get("candidates")
                 and r.get("verdict") in ("reuse", "duplicate")]
    return "\n".join(lines[:25])


REVIEW_CARDS = {
    "review-checklist": ("Review checklist (lessons from human reviews)",
                         "Things human reviewers caught that an automated review missed. Check each one that applies "
                         "to the change, and say so in your review.\n"),
    "shared-helpers": ("Existing shared helpers and mechanisms",
                       "Reuse these before adding new code with the same job (name, where, what it does).\n"),
}

LEARN_RULE = """\
Role: you turn a human code review into lessons for an automated reviewer. You can only read: the pull
request threads (MCP tools) and the code (Read/Grep/Glob, read-only git in {project}).
Read the review threads of pull request {pr} (all threads people wrote; skip system/status threads). If the
tools return no threads, check the identifiers you used against the repository identity below; don't report
"no comments" unless the pull request itself was found.

Here is what lean-agent's own reviewer found for this change. Its claims are not facts: only the code and the
humans' final words are.
{ours}

The project's review cards already say this (don't repeat it; to correct a line, put it under "replace"):
{existing}

1. List what the human reviewers found that the automated review missed, especially duplicated or reinvented
   code, fixes too narrow for sibling cases, and state handling the platform already provides. Turn each into a
   general checklist line for future reviews of this project ("Before adding X, check Y in Z").
2. For every existing helper or mechanism a human pointed to, open the code and confirm where it lives: give
   the file path relative to the repository root (as `git ls-files` shows it) and what it does. If you can't
   find it in the code, leave it out; don't write "not confirmed".
3. A thread that ends with a decision to leave something out (won't fix, out of scope, separate ticket) is a
   decision, not a lesson: put it under "declined" with the reason as written.
4. Report only what people wrote; if a thread didn't answer something, don't say it did. No names of people.
   Skip style nits.

Before the LEAN-FEEDBACK line, add one line exactly like this (valid JSON, one line):
LEAN-CHECKLIST {{"checklist": ["..."], "helpers": [{{"name": "...", "where": "path/in/repo", "what": "..."}}], "replace": [{{"old": "existing line", "new": "corrected line"}}], "declined": [{{"file": "path", "category": "scope|duplication|platform|correctness|tests|style", "issue": "...", "why": "..."}}], "threads_read": [1, 2]}}
"""


def _similar(a, b, cut=0.6):
    return _jaccard(_words(a), _words(b)) >= cut


def add_to_review_cards(slug, checklist=(), helpers=(), replace=()):
    """Add lessons to the project's review-checklist and shared-helpers cards (core for reviews): near-duplicates
    of existing lines are skipped, a helper with a known name updates its line, and `replace` corrects lines."""
    cards = load_cards(slug)
    added = []
    for rp in replace:
        if not isinstance(rp, dict) or not rp.get("old") or not rp.get("new"):
            continue
        for c in cards:
            if c["id"] not in REVIEW_CARDS:
                continue
            lines = c["text"].splitlines()
            best = max(range(len(lines)), key=lambda i: _jaccard(_words(lines[i]), _words(rp["old"])), default=None)
            if best is not None and _similar(lines[best], rp["old"], 0.5):
                lines[best] = "- " + str(rp["new"]).lstrip("- ")
                c.update(text="\n".join(lines), tokens=est_tokens("\n".join(lines)), updated=now_iso())
                added.append((c["id"], "corrected: " + lines[best]))
                break
    for cid, items in (("review-checklist", [f"- {c.strip()}" for c in checklist if str(c).strip()]),
                       ("shared-helpers", [f"- {h['name']} ({h.get('where', '?')}): {h.get('what', '')}".strip()
                                           if isinstance(h, dict) else f"- {h}" for h in helpers if h])):
        if not items:
            continue
        title, intro = REVIEW_CARDS[cid]
        c = next((x for x in cards if x["id"] == cid), None)
        if not c:
            c = {"id": cid, "kind": "note", "title": title, "source": "learned", "text": intro.strip(), "tokens": 0,
                 "core": False, "core_types": ["review"] + (["change"] if cid == "shared-helpers" else []),
                 "archived": False, "offered": 0, "used": 0, "unneeded": 0}
            cards.append(c)
        lines = c["text"].splitlines()
        new = []
        for item in items:
            if cid == "shared-helpers":  # same helper name: update its line
                name = item[2:].split(" (")[0].strip().lower()
                at = next((i for i, l in enumerate(lines) if l[2:].split(" (")[0].strip().lower() == name), None)
                if at is not None:
                    if lines[at] != item:
                        lines[at] = item
                        added.append((cid, "updated: " + item))
                    continue
            if any(_similar(item, l) for l in lines + new):
                continue
            new.append(item)
        lines += new
        c.update(text="\n".join(lines), tokens=est_tokens("\n".join(lines)), updated=now_iso(), archived=False)
        added += [(cid, i) for i in new]
    save_cards(slug, cards)
    return added


def cmd_review_decline(a):
    """Record that findings of the latest review were discussed and declined, so later reviews leave them out."""
    slug, path = resolve_project(a.project)
    br = branch_of(path, a.head) if a.head else ""
    last = next((r for r in reversed(list(read_jsonl(reviews_path(slug)))) if not a.head or r.get("ref") == a.head
                 or (br and (r.get("branch") or branch_of(path, r.get("ref"))) == br)), None)
    if not last:
        die(f"no review of {a.head or slug} yet")
    if not a.numbers and not a.all_gaps:
        die("which? finding numbers (1 2), known gaps (g1 g2), or --all-gaps")
    if a.all_gaps:
        a.numbers = [f"g{i}" for i in range(1, len(last.get("gaps") or []) + 1)] + list(a.numbers or [])
        if not a.numbers:
            print(f"review {last['run']} has no known gaps")
            return 0
    for n in a.numbers:
        if str(n).lower().startswith("g"):
            gaps = last.get("gaps") or []
            try:
                g = gaps[int(str(n)[1:]) - 1]
            except (ValueError, IndexError):
                die(f"review {last['run']} has known gaps g1-g{len(gaps)}; got {n}" if gaps else
                    f"review {last['run']} has no known gaps")
            append_jsonl(declined_path(slug), {"ts": now_iso(), "ref": None if a.all_branches else last.get("ref"),
                                               "branch": last.get("branch") or branch_of(path, last.get("ref")),
                                               "head": last.get("head"), "line": g.get("line"),
                                               "file": g.get("file"), "gap": g.get("what", ""), "why": a.why,
                                               "review": last["run"]})
            print(f"acknowledged {n}: {g.get('file', '?')}: {str(g.get('what', ''))[:100]} ({a.why})")
            continue
        try:
            n = int(n)
        except ValueError:
            die(f"{n!r}: a finding number (1, 2, ...) or a known gap (g1, g2, ...)")
        if not 1 <= n <= len(last["findings"]):
            die(f"review {last['run']} has findings 1-{len(last['findings'])}; got {n}")
        f = last["findings"][n - 1]
        append_jsonl(declined_path(slug), {"ts": now_iso(), "ref": None if a.all_branches else last.get("ref"),
                                           "branch": last.get("branch") or branch_of(path, last.get("ref")),
                                           "head": last.get("head"), "line": f.get("line"),
                                           "file": f.get("file"), "category": f.get("category"),
                                           "symbol": finding_symbol(f),
                                           "issue": f.get("issue", ""), "why": a.why, "review": last["run"]})
        print(f"declined {n}. [{f.get('severity')}/{f.get('category') or '?'}] {f.get('file')}: {f.get('issue', '')[:100]}")
    print(f"Later reviews of {'every branch' if a.all_branches else (last.get('branch') or last.get('ref'))} are told "
          "about it and leave it out, on later commits too, until the code it points at changes.")
    return 0


def verify_refs(slug, path, ref=None):
    """Branches a helper may live on: --head, HEAD, the default branch, and the bases reviews used."""
    refs = [ref, "HEAD", default_base(path)] + [r.get("base") for r in read_jsonl(reviews_path(slug))]
    out = []
    for r in refs:
        if r and r not in out and git(path, "rev-parse", "--verify", "--quiet", r + "^{commit}"):
            out.append(r)
    return out


_TREE_CACHE = {}


def tracked_files(path, ref):
    key = (path, ref)
    if key not in _TREE_CACHE:
        _TREE_CACHE[key] = (git(path, "ls-tree", "-r", "--name-only", ref) or "").splitlines()
    return _TREE_CACHE[key]


def path_candidates(where):
    """Paths in a card's 'where' text: backticks, quotes, :line, #L, several paths in one go are all handled."""
    out = []
    for tok in re.split(r"[,;]|\s+and\s+|\s+", str(where)):
        tok = tok.strip().strip("`'\"()[]").split("#")[0]
        tok = re.sub(r":\d+(-\d+)?$", "", tok).lstrip("./")
        if tok and ("/" in tok or re.search(r"\.\w{1,5}$", tok)):
            out.append(tok.rstrip("/"))
    return out


def code_location(path, where, symbol, refs):
    """(found?, how) for a helper: a path (suffix match on tracked files) or, failing that, its symbol."""
    cands = path_candidates(where)
    for ref in refs:
        files = tracked_files(path, ref)
        for c in cands:
            if any(f == c or f.endswith("/" + c) or f.startswith(c + "/") or ("/" + c + "/") in ("/" + f) for f in files):
                return True, f"{c} on {ref}"
    names = [n for n in re.findall(r"[A-Za-z_$][\w$]{2,}", str(symbol))][:3]
    for ref in refs:
        for n in names:
            if git(path, "grep", "-q", "-w", n, ref, "--") is not None:
                return True, f"symbol {n} on {ref}"
    return False, (f"path {', '.join(cands) or '(none)'} and symbol {', '.join(names) or '(none)'} not found on "
                   + ", ".join(refs))


def verify_review_cards(slug, path, ref=None, apply=False):
    """Report (and with apply, remove) shared-helpers lines whose code can't be found on any relevant branch,
    and lines that say they weren't confirmed. Always says why."""
    refs = verify_refs(slug, path, ref)
    print(f"checking against: {', '.join(refs) or 'the working tree only'}")
    cards = load_cards(slug)
    flagged = 0
    for c in cards:
        if c["id"] not in REVIEW_CARDS:
            continue
        keep = []
        for line in c["text"].splitlines():
            why = "it says it wasn't confirmed" if "not confirmed" in line.lower() else None
            m = re.match(r"^- (.+?) \((.+)\)(?::|$)", line) if c["id"] == "shared-helpers" and not why else None
            if m:
                found, how = code_location(path, m.group(2), m.group(1), refs)
                if not found and not any(os.path.exists(os.path.join(path, x)) for x in path_candidates(m.group(2))):
                    why = how
            if why:
                flagged += 1
                print(f"{'removed' if apply else 'would remove'} from {c['id']}: {line[:120]}\n    because {why}")
                if apply:
                    continue
            keep.append(line)
        if apply:
            c.update(text="\n".join(keep), tokens=est_tokens("\n".join(keep)), updated=now_iso())
    if apply:
        save_cards(slug, cards)
    print(f"{flagged} line(s) {'removed' if apply else 'flagged'}"
          + ("" if apply or not flagged else "; nothing changed. Remove them with --verify --apply"))
    return 0


def code_path_exists(path, rel, ref=None):
    """Whether `rel` is in the repository: the working tree, or (suffix match) on `ref` or HEAD."""
    if os.path.exists(os.path.join(path, rel)):
        return True
    return code_location(path, rel, "", [r for r in (ref, "HEAD") if r])[0]


TRACKER_KEYS = ("host", "org", "project", "repo", "me_id", "me_name")
DISCOVER_RULE = """\
Role: find out, once, how this project's tracker works for the user, so later workers don't learn it by failing.
You can only read; never create, change or delete anything, not even to test.
1. The signed-in user's identity: display name, identity id (what tools want for assignee, reviewer or vote) and
   the email the tracker has for them. Look it up by name or from an item assigned to them if email doesn't work.
2. Work item states: for each work item type the project uses, read the type's definition (its state list, in
   order, with categories such as Proposed/In Progress/Resolved/Completed/Removed). Then cross-check with the
   states the user's real items have (a query for distinct states per type). Say per type where the list came
   from. Don't take state names from text matches in big files; when a result is saved to a file, read it with
   the lean-json tool (`--fields`) instead.
3. Rules that cost failures before. For each, say "verified" (and how: a tool schema, a type definition, a
   documented limit), "false", or "unknown". Don't guess:
   - voting on a pull request needs the user added as a reviewer first (does the vote tool take a reviewer id?)
   - work items can be deleted, and/or a type has a Removed state
   - a pull request description has a length limit (how many characters?)
Before the LEAN-FEEDBACK line, add one line exactly like this (valid JSON, one line):
LEAN-TRACKER {{"me": {{"id": "...", "name": "...", "email": "..."}}, "states": {{"<type>": {{"states": ["New", "Active", "Closed"], "source": "type definition|items|both"}}}}, "rules": [{{"rule": "...", "status": "verified|false|unknown", "how": "..."}}]}}
"""


def claude_account_email():
    return ((lean_mcp._load(lean_mcp.claude_json_path()).get("oauthAccount") or {}).get("emailAddress") or "").strip()


def email_warning(conf):
    if conf.get("email_ack"):
        return None
    me = ((conf.get("discovered") or {}).get("me") or {}).get("email") or ""
    mine = claude_account_email()
    if me and mine and me.lower() != mine.lower():
        return (f"the tracker knows you as {me}, but Claude is signed in as {mine}: lookups by your Claude email "
                "find nothing there; workers use the identity id instead (if that's expected, silence this once: "
                "lean-agent tracker <project> --ack-email)")
    return None


def active_notes(conf):
    gone = set(conf.get("superseded") or [])
    return [n for n in conf.get("notes") or [] if n not in gone]


def note_conflicts(conf):
    """(note number, note, discovered fact) where a hand-written note is about the same thing as a discovered fact
    but says something else (e.g. a different state list, or a rule discovery marked unknown/false)."""
    out = []
    facts = tracker_facts_text(conf)
    types = [t for t in ((conf.get("discovered") or {}).get("states") or {})]
    for i, n in enumerate(conf.get("notes") or [], 1):
        if n in (conf.get("superseded") or []):
            continue
        nw = {w for w in _words(n) if len(w) > 3}
        named = [t for t in types if t.lower() in n.lower()]
        candidates = facts
        if named:  # a note about one work item type is compared with that type's facts only
            candidates = [f for f in facts if any(f.lower().startswith(t.lower() + " ") for t in named)] or \
                [f for f in facts if not any(f.lower().startswith(t.lower() + " states") for t in types)]
        for f in candidates:
            fw = {w for w in _words(f) if len(w) > 3}
            if nw and fw and len(nw & fw) >= 2 and _jaccard(nw, fw) >= 0.25 and not _similar(n, f, 0.8):
                out.append((i, n, f))
                break
    return out


def tracker_facts_text(conf):
    """Discovered states and rules as lines for workers."""
    d = conf.get("discovered") or {}
    lines = []
    for t, info in (d.get("states") or {}).items():
        sts = info.get("states") if isinstance(info, dict) else info
        if sts:
            lines.append(f"{t} states: {', '.join(map(str, sts))}"
                         + (f" (from {info.get('source')})" if isinstance(info, dict) and info.get("source") else ""))
    for r in d.get("rules") or []:
        if isinstance(r, dict) and r.get("rule"):
            lines.append(f"{r['rule']}: {r.get('status', 'unknown')}" + (f" ({r['how']})" if r.get("how") else ""))
    return lines


def cmd_tracker(a):
    """Where the project lives in its tracker, who the user is there, and notes every MCP worker gets."""
    slug, path = resolve_project(a.project)
    projs = projects()
    conf = projs[slug].setdefault("tracker", {})
    for kv in a.values or []:
        k, _, v = kv.partition("=")
        k = k.strip()
        if k not in TRACKER_KEYS or not v.strip():
            die(f"use {', '.join(k_ + '=...' for k_ in TRACKER_KEYS)} (got {kv!r})")
        conf[k] = v.strip()
    if a.note:
        conf.setdefault("notes", []).append(a.note.strip())
    if a.ack_email:
        conf["email_ack"] = True
        print("email mismatch acknowledged: not shown again")
    for n in a.supersede or []:
        notes = conf.get("notes") or []
        if not 1 <= n <= len(notes):
            die(f"there are {len(notes)} notes")
        conf.setdefault("superseded", []).append(notes[n - 1])
        print(f"note {n} superseded (kept, but workers no longer get it): {notes[n - 1]}")
    if a.rm_note:
        notes = conf.get("notes") or []
        bad = [n for n in a.rm_note if not 1 <= n <= len(notes)]
        if bad or len(set(a.rm_note)) != len(a.rm_note):
            die(f"there are {len(notes)} notes; got {', '.join(map(str, a.rm_note))}")
        for n in sorted(a.rm_note, reverse=True):
            print(f"removed note {n}: {notes.pop(n - 1)}")
    save_json(home("projects.json"), projs)
    if a.discover:
        if not a.mcp:
            die("--discover needs the tracker's MCP server: --mcp <server>[:tools]")
        ns = argparse.Namespace(resume=None, task=["Find the user's tracker identity and the project's work item rules."],
                                task_file=None, model=a.model, why="learn the tracker's identity and rules once",
                                cards="none", card_list=None, project=slug, read_only=True, chrome=None, mcp=a.mcp,
                                tools=None, allow_send=None, max_turns=20, max_usd=1.0, max_context=2000, max_cards=4,
                                ttype="read", role="tracker-discover", effort="low", role_rule=DISCOVER_RULE)
        cmd_run(ns)
        run = next((r for r in reversed(ledger()) if r.get("role") == "tracker-discover" and r["project"] == slug), None)
        got = load_json(os.path.join(run["workdir"], "tracker.json"), {}) if run else {}
        projs = projects()
        conf = projs[slug].setdefault("tracker", {})
        me = got.get("me") or {}
        if me.get("id"):
            conf["me_id"] = str(me["id"])
        if me.get("name"):
            conf["me_name"] = str(me["name"])
        if got:  # a re-run replaces what discovery found before; hand-added notes stay
            conf["discovered"] = {"me": me, "states": got.get("states") or {}, "rules": got.get("rules") or [],
                                  "at": now_iso()}
        save_json(home("projects.json"), projs)
        if not got:
            print("discover: the worker didn't report anything usable; see its reply above")
    ident = repo_identity(slug, path)
    conf = projects()[slug].get("tracker", {})
    print(f"{slug} tracker: " + (", ".join(f"{k} {ident[k]}" for k in TRACKER_KEYS if ident.get(k)) or "nothing known"))
    facts = tracker_facts_text(conf)
    if facts:
        print(f"discovered ({(conf.get('discovered') or {}).get('at', '?')[:16]}; re-run --discover to refresh):")
        for f in facts:
            print(f"  - {f}")
    for i, n in enumerate(conf.get("notes") or [], 1):
        print(f"  {i}. {n}" + ("  (superseded)" if n in (conf.get("superseded") or []) else ""))
    for i, n, f in note_conflicts(conf):
        print(f"warning: note {i} may contradict what discovery found: \"{f}\". If discovery is right: "
              f"lean-agent tracker {slug} --supersede {i}")
    warn = email_warning(conf)
    if warn:
        print(f"warning: {warn}")
    print("Every worker given --mcp gets this.")
    return 0


def cmd_review_learn(a):
    slug, path = resolve_project(a.project)
    a.pr = a.pr or a.pr_id
    if a.verify:
        return verify_review_cards(slug, path, a.head, apply=a.apply)
    if a.tracker:
        projs = projects()
        conf = projs[slug].setdefault("tracker", {})
        for kv in a.tracker:
            k, _, v = kv.partition("=")
            if k.strip() not in TRACKER_KEYS or not v.strip():
                die(f"--tracker takes {', '.join(k_ + '=...' for k_ in TRACKER_KEYS)} (got {kv!r})")
            conf[k.strip()] = v.strip()
        save_json(home("projects.json"), projs)
        print(f"{slug}: tracker " + ", ".join(f"{k} {v}" for k, v in conf.items()) + " (saved; used by MCP workers)")
    checklist = [a.text] if a.text else []
    if a.file:
        checklist += [l.strip("-* \t") for l in read_text(a.file).splitlines() if l.strip()]
    helpers = []
    for h in a.helper or []:
        name, _, rest = h.partition("|")
        where, _, what = rest.partition("|")
        helpers.append({"name": name.strip(), "where": where.strip() or "?", "what": what.strip()})
    if a.pr:
        if not a.mcp:
            die("reading a pull request's threads needs its tracker: --mcp <server>:<preset or tools> "
                "(see: lean-agent mcp list)")
        last = next((r for r in reversed(list(read_jsonl(reviews_path(slug))))
                     if not a.head or r.get("ref") == a.head), None)
        ours = "\n".join(f"- [{f.get('severity')}] {f.get('file')}: {f.get('issue')}"
                         for f in (last or {}).get("findings", [])[:20]) or (
            "- (no findings)" if last else "- (no lean-agent review recorded)")
        if last:
            ours = f"(review {last['run']} of {last.get('ref')}, verdict {last['verdict']})\n" + ours
        lib = {c["id"]: c for c in load_cards(slug)}
        existing = "\n".join(lib[c]["text"] for c in REVIEW_CARDS if c in lib) or "(nothing yet)"
        seen_threads = load_json(home("reviews", slug + ".threads.json"), {}).get(str(a.pr)) or []
        if seen_threads:
            ours += ("\n\nThreads already learned from: " + ", ".join(map(str, seen_threads[:100])) + ". Fetch only "
                     "the others (by thread id if the tool takes one), unless one of these has new comments.")
        ns = argparse.Namespace(resume=None, task=[f"Learn from the human review of pull request {a.pr}."],
                                task_file=None, model=a.model, why="turn human review findings into checklist lines",
                                cards="none", card_list=None, project=slug, read_only=True, chrome=None, mcp=a.mcp,
                                tools=None, allow_send=None, max_turns=25, max_usd=1.5, max_context=2000,
                                max_cards=4, ttype="read", role="review-learn", effort="medium",
                                role_rule=LEARN_RULE.format(pr=a.pr, ours=ours, existing=existing[:6000], project=path))
        rc = cmd_run(ns)
        run = next((r for r in reversed(ledger()) if r.get("role") == "review-learn" and r["project"] == slug), None)
        got = load_json(os.path.join(run["workdir"], "checklist.json"), {}) if run else {}
        checklist += [c for c in got.get("checklist") or [] if isinstance(c, str) and "not confirmed" not in c.lower()]
        for h in got.get("helpers") or []:
            if not isinstance(h, dict) or not h.get("name"):
                continue
            where = str(h.get("where") or "").split(":")[0].strip().lstrip("./")
            if not where or not code_path_exists(path, where, a.head):
                print(f"left out helper {h['name']}: {where or 'no path'} isn't in the code")
                continue
            helpers.append(dict(h, where=where))
        replace = [r for r in got.get("replace") or [] if isinstance(r, dict)]
        if got.get("threads_read"):
            tp = home("reviews", slug + ".threads.json")
            th = load_json(tp, {})
            th[str(a.pr)] = sorted(set(map(str, th.get(str(a.pr), []))) | set(map(str, got["threads_read"])))
            save_json(tp, th)
        for d in got.get("declined") or []:
            if isinstance(d, dict) and d.get("issue"):
                append_jsonl(declined_path(slug), {"ts": now_iso(), "ref": a.head, "file": d.get("file"),
                                                   "category": d.get("category"), "issue": d["issue"],
                                                   "why": d.get("why", "declined in the PR"), "pr": a.pr})
                print(f"declined (from the PR): {d.get('file', '?')}: {d['issue'][:100]}")
        if run and run.get("status") == "needs-input" and not got:
            print(f"The worker couldn't find PR {a.pr}; see its question above. If the remote doesn't name the "
                  f"tracker project, set it once: lean-agent review learn {slug} --tracker project=<name>")
            return 2
        if rc and not got:
            return rc
    replace = locals().get("replace") or []
    if not checklist and not helpers and not replace and a.tracker and not a.pr:
        return 0
    if not checklist and not helpers and not replace:
        die("nothing to learn: give --text, --file, --helper \"name | where | what\", or --pr <id> --mcp <server>")
    added = add_to_review_cards(slug, checklist, helpers, replace)
    for cid, line in added:
        print(f"{cid}: {line}")
    print(f"{len(added)} lesson(s) added; every review of {slug} gets these cards "
          f"(see: lean-agent card show {slug} review-checklist)" if added else "Nothing new: already in the cards.")
    return 0


HIGH_RISK_WORDS = {"race", "concurrent", "concurrency", "mutex", "lock", "semaphore", "timeout", "interval", "timer",
                   "debounce", "throttle", "logout", "login", "auth", "token", "session", "migrate", "migration",
                   "schema", "sync", "async", "queue", "queued", "retry", "cache", "transaction", "webhook", "cron",
                   "pending", "inflight", "promise", "mutation"}


def estimate_correction(kind):
    """How far past estimates of this kind were off (median actual/estimate), from runs that recorded one."""
    ratios = sorted(r["cost_usd"] / r["estimate_usd"] for r in ledger()
                    if r.get("estimate_kind") == kind and r.get("estimate_usd") and r.get("cost_usd"))
    return (ratios[len(ratios) // 2], len(ratios)) if ratios else (1.0, 0)


def expected_review_cost(model):
    """(dollars, how) for one review on `model`: the average of earlier ones, else Sonnet's scaled by price
    and by how far such scaled estimates were off before."""
    def avg(m):
        xs = [r.get("cost_usd") or 0 for r in ledger() if r.get("role") == "reviewer" and not r.get("resumed")
              and usage.model_rate(r.get("model")) == usage.model_rate(m) and r.get("cost_usd")]
        return (sum(xs) / len(xs), len(xs)) if xs else (None, 0)
    mine, n = avg(model)
    if mine is not None:
        return mine, f"average of {n} earlier review(s)"
    base, n = avg("sonnet")
    base = base if base is not None else 0.25
    fix, k = estimate_correction("scaled-review")
    how = "estimated from Sonnet reviews and the price ratio" + (f", corrected x{fix:.1f} from {k} earlier estimate(s)"
                                                                  if k else "; a first estimate, often low")
    return base * usage.model_rate(model) * fix, how


def high_risk(path, rng_args, names):
    """Reasons a change deserves a stronger reviewer: concurrency, timers, auth/logout, sync, migrations, size."""
    diff = git(path, "diff", "-U0", "--no-color", *rng_args) or ""
    added = "\n".join(l for l in diff.splitlines() if l.startswith(("+", "-")) and not l.startswith(("+++", "---")))
    tokens = {t.lower() for t in re.findall(r"[A-Z]?[a-z]+|[A-Z]+(?![a-z])", added)}  # splits camelCase too
    hits = sorted(tokens & HIGH_RISK_WORDS)
    why = []
    if len(hits) >= 3:
        why.append("touches " + ", ".join(hits[:5]))
    if len(names) >= 15 or len(added.splitlines()) >= 600:
        why.append(f"large ({len(names)} files)")
    return why


def earlier_review(slug, path, head):
    """The latest reviewer run this review continues: of the same branch (with or without origin/), or of a commit
    the new one builds on (an ancestor, or amended away on the same branch) that isn't merged into the base."""
    want = git(path, "rev-parse", "--verify", "--quiet", head + "^{commit}") if head else None
    br = branch_of(path, head) if head else ""
    base = default_base(path)
    runs = [r for r in reversed(ledger()) if r.get("role") == "reviewer" and r.get("project") == slug]

    def matches(r, loose=False):
        m = r.get("review_meta") or {}
        if not head:
            return True
        if m.get("mode") != "ref":
            return False
        if bare_ref(m.get("ref")) == bare_ref(head) or (br and branch_of(path, m.get("ref")) == br):
            return True  # the same branch, with or without its remote
        if not loose or not want or not m.get("head"):
            return False
        return (same_line(path, m["head"], want, br)
                and not (base and git(path, "merge-base", "--is-ancestor", m["head"], base) is not None))
    prev = next((r for r in runs if matches(r)), None) or next((r for r in runs if matches(r, True)), None)
    if prev and head and bare_ref((prev.get("review_meta") or {}).get("ref")) != bare_ref(head):
        prev = dict(prev, review_meta=dict(prev.get("review_meta") or {}, ref=head))  # review what was named
    return prev


def workers_on(slug, path, head):
    """Workers running right now on the branch a review is about (fixes still coming)."""
    br = branch_of(path, head) or bare_ref(head)
    out = []
    for f in glob.glob(home("running", "*.json")):
        m = load_json(f, {})
        try:
            os.kill(int(m.get("pid", 0)), 0)
        except (OSError, ValueError, TypeError):
            continue
        if m.get("project") == slug and m.get("role") != "reviewer" and br and bare_ref(m.get("branch")) == br:
            out.append(m.get("run"))
    return out


def cmd_review(a):
    rc = review_main(a)
    if getattr(a, "for_push", False) and not a.status:
        print("Before the push: fix everything this review found in ONE worker (or one worktree session), then run "
              f"`lean-agent review {a.project}" + (f" --head {a.head}" if a.head else "") + "` once: it reviews only "
              "what changed since (sonnet unless that's high-risk) and checks the earlier findings, and declined "
              "findings and gaps stay declined on the new commits. Then `review --status` is the push gate.")
    return rc


def review_main(a):
    slug, path = resolve_project(a.project)
    if a.head and a.head.startswith("origin/") and not a.no_fetch:
        git(path, "fetch", "-q", "origin")  # updates remote refs only; the working tree isn't touched
    if a.status:
        match, (sha, label) = find_review(slug, path, a.head)
        if match:
            open_gaps = [g for g in match.get("gaps") or [] if not gap_declined(g, declined_for(slug, match.get("ref"), path, sha))]
            print(f"review {match['run']} of {label} @ {sha[:12]}: {match['verdict']}"
                  + (f", {len(open_gaps)} known gap(s) not acknowledged" if open_gaps else ""))
            for i, g in enumerate(open_gaps, 1):
                print(f"  g{i}. {g.get('file', '?')}: {str(g.get('what', ''))[:140]}")
            if match["verdict"] == "approve" and open_gaps:
                return 2
            return 0 if match["verdict"] == "approve" else 1
        prev_ = earlier_review(slug, path, a.head) if a.head else None
        old = ((prev_ or {}).get("review_meta") or {}).get("head")
        if old and old != sha:
            stat = git(path, "diff", "--numstat", old, sha) or ""
            size = sum(int(x) for l in stat.splitlines() for x in l.split("\t")[:2] if x.isdigit())
            was = next((r.get("verdict") for r in reversed(list(read_jsonl(reviews_path(slug)))) if r.get("head") == old), "?")
            print(f"not reviewed yet at {sha[:12]}: {branch_of(path, a.head) or a.head} was reviewed at {old[:12]} "
                  f"({was}); {size} lines changed since. Review just that: lean-agent review {slug} --head {a.head} "
                  f"(a delta review{', sonnet' if size <= env_num('LEAN_AGENT_DELTA_MAX_LINES', 800) else ''}).")
            return 1
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
    model = getattr(a, "reviewer_model", None) or os.environ.get("LEAN_AGENT_REVIEW_MODEL") or "sonnet"
    effort = os.environ.get("LEAN_AGENT_REVIEW_EFFORT") or "high"
    line, low = budget_line()
    if low:
        print(f"lean-agent: budget is low, but the reviewer stays on {model} (effort {effort}): quality gate.",
              file=sys.stderr)
    if a.head and not a.status:
        busy = workers_on(slug, path, a.head)
        if busy:
            msg = (f"{len(busy)} worker(s) still running on {branch_of(path, a.head) or a.head} ({', '.join(busy)}): "
                   "review once, after all of them")
            if getattr(a, "for_push", False) and not getattr(a, "yes", False):
                die(msg + " (or --yes to review now)", code=3)
            print(f"lean-agent: note: {msg}.", file=sys.stderr)
    delta_max = env_num("LEAN_AGENT_DELTA_MAX_LINES", 800)
    if (not a.resume and not getattr(a, "full_review", False) and a.head and not a.independent and a.runs == 1
            and not a.status):
        prev_ = earlier_review(slug, path, a.head)
        old = ((prev_ or {}).get("review_meta") or {}).get("head")
        new = git(path, "rev-parse", "--verify", "--quiet", a.head + "^{commit}")
        if prev_ and old and new and old != new:
            stat = git(path, "diff", "--numstat", old, new) or ""
            size = sum(int(x) for l in stat.splitlines() for x in l.split("\t")[:2] if x.isdigit())
            if size <= delta_max or getattr(a, "delta_only", False):
                print(f"review: {branch_of(path, a.head) or a.head} was reviewed at {old[:12]} (run {prev_['id']}); "
                      f"reviewing only what changed since ({size} lines) and whether the earlier findings are fixed. "
                      "--full-review reviews the whole change again.", flush=True)
                a.resume = True
            else:
                print(f"review: {size} changed lines since the review at {old[:12]} (over {delta_max}, "
                      "LEAN_AGENT_DELTA_MAX_LINES): a full review", flush=True)
    if a.resume:
        prev = earlier_review(slug, path, a.head)
        if not prev:
            die(f"no earlier review of {a.head or slug} to resume"
                + (f"; start one: lean-agent review {slug} --head {a.head}" if a.head else ""))
        old_head = (prev.get("review_meta") or {}).get("head")
        meta, where = refresh_review_meta(path, prev.get("review_meta") or {}, fetch=not a.no_fetch)
        print(f"re-review of {meta.get('ref') or '?'} @ {meta['head'][:12]} (after reviewer {prev['id']})",
              flush=True)
        since = ([old_head, meta["head"]] if meta.get("mode") == "ref" else [old_head]) if old_head else []
        changed = (git(path, "diff", "--name-only", *since) or "").split() if since else []
        ns_syms = new_symbols(path, since, untracked_files(path) if meta.get("mode") != "ref" else ()) \
            if since else {"files": [], "symbols": []}
        meta["new_symbols"] = ns_syms["files"] + ns_syms["symbols"]
        meta["resume"] = True
        focus = change_focus(path, since) if since else {"tests": [], "params": [], "state": [], "renamed": []}
        meta["edited_tests"] = focus["tests"]
        mb = meta.get("merge_base")
        if mb:  # gaps are about the whole change, not only what changed since the last review
            meta["gaps"] = self_declared_gaps(path, [mb, meta["head"]] if meta.get("mode") == "ref" else [mb],
                                              untracked_files(path) if meta.get("mode") != "ref" else ())
            focus["gaps"] = meta["gaps"]
        if getattr(a, "goal", None):
            meta["goal"] = a.goal
        if mb:
            meta["hunks"] = changed_hunks(path, [mb, meta["head"]] if meta.get("mode") == "ref" else [mb])
        dt = decisions_text(slug, meta.get("ref"), path, meta.get("head"))
        where += (" " + dt.replace("\n", " ") if dt else "")
        where += (f" Since your last review these files changed: {', '.join(changed[:30]) or 'none'}. Re-check only "
                  "(a) your earlier open findings against the new code (say for each: fixed / still open) and (b) "
                  "the changed files above, with the reuse, scope and platform passes limited to them. Don't "
                  "re-derive the design of code that didn't change, and don't raise declined findings again. New "
                  "symbols since then:" + symbols_text(ns_syms) + " " + focus_text(focus).replace("\n", " ") +
                  " Reply with a complete LEAN-REVIEW line again (open findings only, plus searches, reuse and "
                  "coverage for what's new).")
        if a.same_session or not since:  # the old way: continue the reviewer's whole session
            task = (f"The change was updated after your review. {where} Check whether each earlier finding is "
                    "resolved, and look for new problems. " + (a.focus or ""))
            ns = argparse.Namespace(resume=prev["id"], task=[task], task_file=None, model=None, why=None, cards=None,
                                    project=None, read_only=True, chrome=None, mcp=None, tools=None, allow_send=None,
                                    max_turns=a.max_turns, max_usd=a.max_usd, max_context=4000, role="reviewer",
                                    effort=effort, review_meta=meta)
            rc = cmd_run(ns)
            return reuse_follow_up(a, slug, meta, effort) if rc == 2 else rc
        # a fresh reviewer with a small context: the open findings and only what changed since the last review
        last = next((r for r in reversed(list(read_jsonl(reviews_path(slug)))) if r.get("run") == prev["id"]
                     or (r.get("ref") == meta.get("ref") and r.get("head") == old_head)), None) or {}
        open_items = [f"- [{f.get('severity')}/{f.get('category') or '?'}] {f.get('file')}:{f.get('line', '')} "
                      f"{str(f.get('issue', ''))[:200]}" for f in last.get("findings") or []]
        open_items += [f"- [check] {str(c.get('what', ''))[:200]}" for c in last.get("checks") or []]
        scope = (f"the changes to {meta.get('ref') or 'the working tree'} since the last review "
                 f"({old_head[:12]}..{meta['head'][:12]}): {len(changed)} files ({', '.join(changed[:15])})")
        read_rule = (f"These files are NOT checked out. Read them at the reviewed commit with `git -C {path} show "
                     f"{meta['head']}:<path>`, search with `git -C {path} grep -n <pattern> {meta['head']}`."
                     if meta.get("mode") == "ref" else "")
        task = ("Re-review after fixes. The earlier review's open items (say for each: fixed / still open, with "
                "file:line):\n" + ("\n".join(open_items[:25]) or "- none") + "\n\nGive the changes since then the full "
                "passes; don't re-review code that didn't change. " + decisions_text(slug, meta.get("ref"), path, meta["head"])
                + (a.focus or ""))
        cards = suggest(slug, " ".join(re.split(r"[/._-]+", " ".join(changed))), a.max_context, "review")
        meta["since_hunks"] = changed_hunks(path, since)
        meta["earlier"] = [str(f.get("issue", "")) for f in last.get("findings") or []]
        risk = high_risk(path, since, changed) if since else []
        delta_model = (getattr(a, "reviewer_model", None)
                       or ((prev.get("model") or model) if risk else os.environ.get("LEAN_AGENT_DELTA_REVIEW_MODEL") or "sonnet"))
        if risk and not getattr(a, "reviewer_model", None):
            print(f"review: the changes since are high-risk ({'; '.join(risk)}): {delta_model} again", flush=True)
        meta["after"] = {"run": prev["id"], "head": old_head}
        ns = argparse.Namespace(resume=None, task=[task], task_file=None, model=delta_model,
                                todo=getattr(a, "todo", None) or prev.get("todo"),
                                why=f"re-review after fixes ({effort} effort, fresh context)", cards=None,
                                card_list=cards, project=slug, read_only=True, chrome=None, mcp=None, tools=None,
                                allow_send=None, max_turns=a.max_turns, max_usd=a.max_usd, max_context=a.max_context,
                                ttype="review", role="reviewer", effort=effort, review_meta=meta,
                                role_rule=REVIEWER_RULE.format(scope=scope, project=path, diff_range=" ".join(since),
                                                               read_rule=read_rule, new_symbols=symbols_text(ns_syms),
                                                               grep_ref=meta["head"] if meta.get("mode") == "ref" else "",
                                                               base_ref=old_head, focus=focus_text(focus)))
        print(f"review: fresh re-review of what changed since {old_head[:12]} ({len(changed)} files, "
              f"{len(open_items)} open items, {delta_model}); --same-session continues the old reviewer instead",
              flush=True)
        rc = cmd_run(ns)
        return reuse_follow_up(a, slug, meta, effort) if rc == 2 else rc
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
    ns_syms = new_symbols(path, [merge_base, sha] if mode == "ref" else [merge_base], new)
    focus = change_focus(path, [merge_base, sha] if mode == "ref" else [merge_base])
    focus["gaps"] = self_declared_gaps(path, [merge_base, sha] if mode == "ref" else [merge_base],
                                       untracked_files(path) if mode != "ref" else ())
    focus["ci_parity"] = ci_parity(path, [merge_base, sha] if mode == "ref" else [merge_base],
                                   sha if mode == "ref" else "HEAD")
    grep_ref = sha if mode == "ref" else ""
    a._decisions = "" if a.independent else decisions_text(slug, label, path, sha)
    a._label = label
    if a.independent:
        a.second_opinion = "off"
        print("review: independent (no earlier findings, decisions or second opinion)", flush=True)
    cost, how = expected_review_cost(model)
    print(f"reviewer: {model}, effort {effort} (expected ~${cost:.2f}, {how})", flush=True)
    a._estimate = (cost, "scaled-review" if "price ratio" in how else "history-review")
    risk = high_risk(path, [merge_base, sha] if mode == "ref" else [merge_base], names)
    if risk and usage.model_rate(model) <= 1:
        strong = os.environ.get("LEAN_AGENT_STRONG_REVIEW_MODEL") or "opus"
        print(f"review: high-risk change ({'; '.join(risk)}). A stronger reviewer may find more: "
              f"--reviewer-model {strong} (~${expected_review_cost(strong)[0]:.2f}), or --runs 2 "
              f"(two independent passes, ~${2 * cost:.2f})", flush=True)
    print(f"review: {len(ns_syms['files'])} new files, {len(ns_syms['symbols'])} new symbols for the reuse pass · "
          f"{len(focus['tests'])} edited tests, {len(focus['params'])} defaults, {len(focus['state'])} module state",
          flush=True)
    task = f"Review this change before it becomes a pull request.\n\nFiles changed:\n{stat}\n"
    second = second_opinion(a, slug, path, ns_syms, names, scope, read_rule, rng, grep_ref, cards)
    if second:
        task += ("\nA quick, cheaper search-only pass suggests these reuse candidates and siblings. They are hints and "
                 "can be wrong: verify each in the code yourself and include it in your reuse/siblings sections "
                 "(agree or say why not):\n" + second + "\n")
    if a._decisions:
        task += "\n" + a._decisions
    earlier = None if a.independent else previous_findings(slug, label, mode)
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
    if getattr(a, "goal", None):
        task += f"\nThe change's stated goal (task, work item or PR title): {a.goal}\n"
    meta = {"base": base, "merge_base": merge_base, "head": sha, "dirty": dirty, "ref": label, "mode": mode,
            "files": len(names), "new_symbols": ns_syms["files"] + ns_syms["symbols"],
            "second_opinion": getattr(a, "_second", []),
            "hunks": changed_hunks(path, [merge_base, sha] if mode == "ref" else [merge_base]),
            "edited_tests": focus["tests"], "independent": bool(a.independent), "gaps": focus.get("gaps") or [],
            "goal": getattr(a, "goal", None), "ci_parity": focus.get("ci_parity") or []}
    ns = argparse.Namespace(resume=None, task=[task], task_file=None, model=model, estimate=getattr(a, "_estimate", None),
                            todo=getattr(a, "todo", None),
                            why=f"pre-PR review ({effort} effort)", cards=None, card_list=cards, project=slug,
                            read_only=True, chrome=None, mcp=None, tools=None, allow_send=None, max_turns=a.max_turns,
                            max_usd=a.max_usd, max_context=a.max_context, ttype="review", role="reviewer",
                            effort=effort, review_meta=meta,
                            role_rule=REVIEWER_RULE.format(scope=scope, project=path, diff_range=rng,
                                                           read_rule=read_rule, new_symbols=symbols_text(ns_syms),
                                                           grep_ref=grep_ref, base_ref=merge_base,
                                                           focus=focus_text(focus)))
    if (a.runs or 1) > 1:
        return multi_pass_review(a, slug, path, ns, meta, effort)
    rc = cmd_run(ns)
    return reuse_follow_up(a, slug, meta, effort) if rc == 2 else rc


SEVERITY_RANK = {"blocker": 0, "major": 1, "minor": 2, "nit": 3}


def merge_reviews(reviews):
    """One review from independent passes: findings matched by category, file and wording (counted per pass),
    reuse/coverage/checks unioned, the strictest verdict kept."""
    n = len(reviews)
    findings = []
    for rv in reviews:
        for f in rv.get("findings") or []:
            if not isinstance(f, dict):
                continue
            same = next((g for g in findings if g.get("category") == f.get("category")
                         and os.path.basename(str(g.get("file"))) == os.path.basename(str(f.get("file")))
                         and _jaccard(_words(g.get("issue", "")), _words(f.get("issue", ""))) >= 0.3), None)
            if same:
                same["_passes"] += 1
                if SEVERITY_RANK.get(f.get("severity"), 9) < SEVERITY_RANK.get(same.get("severity"), 9):
                    same["severity"] = f["severity"]
            else:
                findings.append(dict(f, _passes=1))
    for f in findings:
        f["issue"] = f"{f.get('issue', '')} [{f.pop('_passes')}/{n} passes]"

    def union(key, ident, better=None):
        out = {}
        for rv in reviews:
            for x in rv.get(key) or []:
                if not isinstance(x, dict):
                    continue
                k = str(x.get(ident, ""))[:80]
                if k not in out or (better and better(x, out[k])):
                    out[k] = x
        return list(out.values())
    order = ["approve", "needs-checks", "changes-requested"]
    verdict = max((rv.get("verdict") or "approve" for rv in reviews), key=lambda v: order.index(v) if v in order else 0)
    lists = lambda key: list(dict.fromkeys(x for rv in reviews for x in rv.get(key) or [] if isinstance(x, str)))
    return {"verdict": verdict, "findings": findings,
            "reuse": union("reuse", "symbol", lambda x, y: x.get("verdict") == "duplicate"),
            "coverage": union("coverage", "test", lambda x, y: x.get("verdict") == "lost"),
            "checks": union("checks", "what"), "siblings": union("siblings", "checked", lambda x, y: x.get("needs_fix")),
            "searches": [s_ for rv in reviews for s_ in rv.get("searches") or []],
            "fine": lists("fine"), "unverified": lists("unverified")}


def multi_pass_review(a, slug, path, ns, meta, effort):
    """`review --runs N`: N independent passes of the same reviewer, merged into one recorded review."""
    n = a.runs
    started = now_iso()
    print(f"review: {n} independent passes, merged (findings seen by more than one pass are marked)", flush=True)
    for i in range(n):
        one = argparse.Namespace(**vars(ns))
        one.review_meta = dict(meta, multi=i + 1)
        cmd_run(one)
    passes = [r for r in ledger() if r.get("role") == "reviewer" and r.get("ts", "") >= started
              and (r.get("review_meta") or {}).get("multi")][-n:]
    reviews = [load_json(os.path.join(r["workdir"], "review.json"), {}) for r in passes]
    if not passes:
        die("no review pass finished")
    entry = dict(passes[-1], cost_usd=sum(r.get("cost_usd") or 0 for r in passes),
                 units=sum(r.get("units", 0) for r in passes))
    rc = report_review(slug, path, entry, merge_reviews(reviews), meta)
    return reuse_follow_up(a, slug, meta, effort) if rc == 2 else rc


def reuse_follow_up(a, slug, meta, effort):
    """Once per review: if the reviewer left symbols unchecked or a justified-new verdict wasn't accepted, send it
    back (same session, cached context) to finish the reuse pass before the result goes to the user."""
    last = (list(read_jsonl(reviews_path(slug))) or [None])[-1]
    gaps = (last or {}).get("unchecked", []) + (last or {}).get("disputed", []) + [
        f"coverage entry for edited test {t}" for t in (last or {}).get("coverage_unchecked", [])] + [
        f"gap entry for {g.get('file', '?')}:{g.get('line') or ''} \"{str(g.get('what', ''))[:120]}\" (does it keep "
        "the goal from working? is it out of scope, and where does it say so?)"
        for g in (last or {}).get("gaps", []) if g.get("unaddressed")]
    if not last or not gaps:
        return 2
    prev = next((r for r in reversed(ledger()) if r["id"] == last["run"]), None)
    if not prev:
        return 2
    print(f"review: sending the reviewer back once to finish the reuse pass ({len(gaps)} open)", flush=True)
    task = ("Your review isn't complete. For each item below: a reuse entry (search the repository, at least one "
            "search each; for justified-new, say concretely why the existing code can't be reused or extended), a "
            "coverage entry (what the test protected, and whether that's still tested; a pure rename is "
            "still-covered), or a gap entry (pass 0):\n"
            + "\n".join(f"- {g}" for g in gaps[:20]) + "\nThen reply with a complete LEAN-REVIEW line again "
            "(all findings, searches and reuse entries, not only the new ones).")
    ns = argparse.Namespace(resume=prev["id"], task=[task], task_file=None, model=None, why=None, cards=None,
                            project=None, read_only=True, chrome=None, mcp=None, tools=None, allow_send=None,
                            max_turns=min(a.max_turns, 30), max_usd=min(a.max_usd, 2.0), max_context=4000,
                            role="reviewer", effort=effort, review_meta=meta)
    return cmd_run(ns)


DESIGN_CATEGORIES = ("completeness", "duplication", "scope", "platform")
CATEGORY_ORDER = {c: i for i, c in enumerate(DESIGN_CATEGORIES + ("correctness", "security", "compatibility",
                                                                   "performance", "tests", "style"))}


REUSE_OK = ("extend", "extends-existing", "wraps-existing")  # the change reuses existing code: no finding
# The reviewer's own words that a finding is optional. Only phrases, and only in its suggestion/why: "follow-up"
# alone is often the topic of the code ("a follow-up check"), not a judgement.
OPTIONAL_RE = re.compile(r"\b(optional(ly)?\b(?! (param|arg|field|chain))|(as|in) a (separate )?follow-?up|follow-?up "
                         r"(pr|change|ticket|task|work)|not required (for|in) this|nice[- ]to[- ]have|could be done "
                         r"later|pre-?existing (issue|duplication|pattern|code)|already (duplicated|repeated) (in|across)|"
                         r"out of scope for this (pr|change))", re.I)
UNVERIFIED_RE = re.compile(r"\b(i )?(did not|didn't|could not|couldn't|cannot|can't) (confirm|verify|check|see)|"
                           r"\bunverified\b|\bnot (verified|confirmed)\b", re.I)


def in_changed_lines(candidate, hunks):
    """Whether a candidate like 'path/file.ts:80 name' points into lines this change edits (= the change itself)."""
    m = re.match(r"\s*([^\s:]+):(\d+)", str(candidate))
    if not m:
        return False
    f, line = m.group(1).lstrip("./"), int(m.group(2))
    for path, ranges in (hunks or {}).items():
        if path == f or path.endswith("/" + f) or f.endswith("/" + path):
            if any(lo - 3 <= line <= hi + 3 for lo, hi in ranges):
                return True
    return False


def enforce_review_rules(review, meta, declined=()):
    """lean-agent's own rules on top of the reviewer's verdict.

    - every new symbol needs a reuse entry, else "reuse not checked" (no approve);
    - "duplicate"/"reuse" with an existing candidate outside the change becomes a major duplication finding;
      extend / wraps-existing are reuse (no finding), and a candidate inside the edited lines is the change itself;
    - a weak or disputed justified-new needs a reason;
    - findings the reviewer calls optional / follow-up / pre-existing are minor; unverified ones become checks;
    - declined findings (lean-agent review decline) are left out last, whoever raised them, and never flip the
      verdict; on a re-review, only minor or declined findings left means approve.
    Returns (verdict, findings, checks, notes)."""
    verdict = review.get("verdict") or "unknown"
    findings = [f for f in review.get("findings") or [] if isinstance(f, dict)]
    checks = [c for c in review.get("checks") or [] if isinstance(c, dict)]
    reuse = [r for r in review.get("reuse") or [] if isinstance(r, dict)]
    hunks = meta.get("hunks") or {}
    notes = []

    for f in list(findings):
        text = " ".join(str(f.get(k, "")) for k in ("issue", "why", "suggestion"))
        judgement = " ".join(str(f.get(k, "")) for k in ("why", "suggestion"))
        if f.get("severity") in ("blocker", "major") and UNVERIFIED_RE.search(text):
            findings.remove(f)
            checks.append({"what": f"unverified -> delegate a read-only check: {f.get('file', '?')}: "
                                   f"{str(f.get('issue', ''))[:200]}", "why": "the reviewer didn't verify it"})
            notes.append(f"turned an unverified {f.get('severity')} into a check ({f.get('file', '?')})")
        elif (f.get("severity") in ("blocker", "major") and OPTIONAL_RE.search(judgement)
              and f.get("category") != "completeness"):  # "a follow-up will host it" is the gap, not a reason
            f["severity"] = "minor"
            notes.append(f"lowered a finding the reviewer calls optional/follow-up/pre-existing to minor "
                         f"({f.get('file', '?')})")

    for f in list(findings):  # a duplication finding whose only "original" is inside the change itself
        if f.get("category") == "duplication":
            refs = re.findall(r"[\w./-]+\.\w{1,5}:\d+", " ".join(str(f.get(k, "")) for k in ("issue", "suggestion")))
            if refs and all(in_changed_lines(x, hunks) for x in refs):
                findings.remove(f)
                notes.append(f"dropped a duplication finding that points at the change's own lines ({f.get('file', '?')})")
    def mentions(f, names):
        text = " ".join(str(f.get(k, "")) for k in ("file", "issue", "suggestion", "why"))
        return any(n and n in text for n in names)
    for r in reuse:
        cands = [c for c in r.get("candidates") or [] if not in_changed_lines(c, hunks)]
        if r.get("verdict") not in ("reuse", "duplicate") or not cands:
            continue  # extend / wraps-existing / justified-new, or the "existing code" is this change itself
        sym = str(r.get("symbol") or "").split(" (")[0]
        names = [n for n in re.split(r"[\s/,]+", sym) if len(n) > 2]
        names += [str(c).split(":")[0] for c in cands]
        names += [w.split(" (")[1].rstrip(")") for w in meta.get("new_symbols") or []
                  if " (" in w and w.split(" (")[0] in names]
        if not any(f.get("category") == "duplication" and mentions(f, names) for f in findings):
            findings.append({"severity": "major", "category": "duplication", "file": r.get("symbol", "?"),
                             "line": 0, "symbol": sym,
                             "issue": f"{sym} duplicates existing code: {', '.join(map(str, cands))[:200]}",
                             "suggestion": "reuse the existing code instead" + (f": {r['why']}" if r.get("why") else "")})

    disputed = []
    second = {str(x.get("symbol", "")).split(" (")[0]: x for x in meta.get("second_opinion") or []}
    for r in reuse:
        if r.get("verdict") != "justified-new":
            continue
        sym = str(r.get("symbol") or "").split(" (")[0]
        other = next((x for k, x in second.items() if k and (k in sym or sym in k)), None)
        if other and [c for c in other.get("candidates") or [] if not in_changed_lines(c, hunks)]:
            disputed.append(f"{sym}: the second opinion says {other.get('verdict')} "
                            f"{', '.join(map(str, other['candidates']))[:160]}")
        elif r.get("candidates") and len(str(r.get("why") or "")) < 40:
            disputed.append(f"{sym}: marked justified-new next to {', '.join(map(str, r['candidates']))[:160]} "
                            "without saying why that can't be reused or extended")
    for d in disputed:
        checks.append({"what": "justify or fix: " + d, "why": "a new abstraction next to an existing one needs a reason"})
    if disputed:
        notes.append(f"{len(disputed)} justified-new verdict(s) not accepted")
    review["_disputed"] = disputed

    wanted = meta.get("new_symbols") or []
    covered = " ".join(str(r.get("symbol", "")) + " " + " ".join(map(str, r.get("candidates") or [])) for r in reuse)
    covered += " " + " ".join(str(f.get("file", "")) for f in findings if f.get("category") == "duplication")

    def is_covered(w):
        name = w.replace("new file ", "").split(" (")[0]
        if name in covered:
            return True
        if " (" not in w:  # a new file is checked when its symbols are
            return any(x.endswith(f"({name})") and x.split(" (")[0] in covered for x in wanted)
        return False
    missing = [w for w in wanted if not is_covered(w)]
    review["_missing"] = missing
    review["_covered"] = len(wanted) - len(missing)
    if missing:
        checks.append({"what": "reuse not checked for: " + ", ".join(missing[:10]),
                       "why": "every new symbol needs a search for existing code that does the same job"})
        notes.append(f"reuse not checked for {len(missing)} of {len(wanted)} new symbols")

    cov = [c for c in review.get("coverage") or [] if isinstance(c, dict)]
    edited = meta.get("edited_tests") or []
    cov_text = " ".join(str(c.get("test", "")) for c in cov)
    no_cov = [t for t in edited if t.split(": '", 1)[-1].split("' (")[0][:40] not in cov_text]
    if no_cov:
        checks.append({"what": "coverage not checked for edited tests: " + "; ".join(no_cov[:8]),
                       "why": "for each: what it protected, and whether that's still tested"})
        notes.append(f"coverage not checked for {len(no_cov)} of {len(edited)} edited tests")
    lost = [c for c in cov if c.get("verdict") == "lost"]
    if lost and not any(f.get("category") == "tests" and f.get("severity") in ("blocker", "major", "minor")
                        for f in findings):  # one finding for all of them, unless the reviewer wrote its own
        findings.append({"severity": "minor", "category": "tests", "file": "tests", "line": 0,
                         "issue": "coverage lost: " + "; ".join(f"'{c.get('test')}' protected {c.get('protected', '?')}"
                                                                for c in lost[:6]),
                         "suggestion": "add tests for these back, or say why they no longer apply"})
    review["_no_cov"] = no_cov

    # completeness: every gap the change declares itself, and every one the reviewer found, until acknowledged
    gaps = [dict(g) for g in review.get("gaps") or [] if isinstance(g, dict) and g.get("what")]
    small = [f for f in findings if f.get("severity") in ("minor", "nit")]
    gaps = [g for g in gaps if g.get("blocks_goal") is True or not any(  # a nit is a finding, not a gap
        _jaccard(_words(g.get("what", "")), _words(f.get("issue", ""))) >= 0.4 for f in small)]
    said = " ".join(f"{g.get('file', '')}:{g.get('line', '')} {g.get('what', '')}" for g in gaps)
    for hit in meta.get("gaps") or []:
        loc, _, text = hit.rpartition(": ") if hit.startswith("commit message") else hit.partition(": ")
        if hit.startswith("commit message"):
            loc, text = "commit message", hit.split(": ", 1)[1]
        file_ = loc.rsplit(":", 1)[0] if ":" in loc else loc
        if (file_ and file_ in said) or _jaccard(_words(text), _words(said)) >= 0.5:
            continue
        gaps.append({"what": text, "file": file_, "line": loc.rsplit(":", 1)[-1] if ":" in loc else 0,
                     "blocks_goal": None, "scoped_out": "", "unaddressed": True})
    kept = [g for g in gaps if not gap_declined(g, declined)]
    if len(kept) < len(gaps):
        notes.append(f"{len(gaps) - len(kept)} gap(s) declined earlier on this branch still apply (not asked again)")
    gaps = kept
    for g in gaps:
        if g.get("blocks_goal") is True and not str(g.get("scoped_out") or "").strip() and not any(
                f.get("category") == "completeness" and os.path.basename(str(f.get("file", ""))) ==
                os.path.basename(str(g.get("file", ""))) for f in findings):
            findings.append({"severity": "major", "category": "completeness", "file": g.get("file", "?"),
                             "line": g.get("line") or 0, "issue": f"the change doesn't deliver: {g['what']}",
                             "suggestion": "deliver it, or have the user confirm it's out of scope "
                                           "(lean-agent review decline <project> <gap> --why ...)"})
    if any(g.get("unaddressed") for g in gaps):
        notes.append(f"{sum(1 for g in gaps if g.get('unaddressed'))} self-declared gap(s) the reviewer didn't address")
    review["_gaps"] = gaps
    for hit in meta.get("ci_parity") or []:
        if not any(hit.split(":")[0] in str(c.get("what", "")) and "sparse" in str(c.get("what", "")) for c in checks):
            checks.append({"what": f"CI parity: {hit}. Run that spec in a checkout limited to the pipeline's sparse "
                                   "folders, or add the folder to the pipeline's sparse checkout",
                           "why": "it passes in a full worktree and fails in CI"})
    review["_goal"] = review.get("goal") or meta.get("goal")

    if meta.get("resume") and meta.get("since_hunks") is not None:
        # converge: on a re-review, a NEW major about code that didn't change since the last review is minor
        for f in findings:
            if f.get("severity") not in ("blocker", "major"):
                continue
            if any(_jaccard(_words(f.get("issue", "")), _words(e)) >= 0.3 for e in meta.get("earlier") or []):
                continue  # an earlier open finding, still open: keeps its severity
            loc = f"{f.get('file', '')}:{f.get('line') or 0}"
            if not in_changed_lines(loc, meta["since_hunks"]):
                f["severity"] = "minor"
                notes.append(f"new on re-review, about code that didn't change since the last review: minor "
                             f"({f.get('file', '?')}:{f.get('line', '')})")

    if declined:  # last, so nothing re-adds a declined finding
        kept = [f for f in findings if not is_declined(f, declined)]
        if len(kept) < len(findings):
            notes.append(f"left out {len(findings) - len(kept)} finding(s) declined earlier (lean-agent review decline)")
        findings = kept
    review["_declined_shown"] = [d for d in declined][:10]

    blocking = [f for f in findings if f.get("severity") in ("blocker", "major")]
    open_checks = [c for c in checks if not str(c.get("what", "")).startswith("unverified")] if meta.get("resume") else checks
    if verdict == "approve" and (blocking or missing or disputed or no_cov or (wanted and not review.get("searches"))):
        verdict = "changes-requested" if blocking else "needs-checks"
        notes.append(f"lean-agent changed the verdict from approve to {verdict}")
    elif verdict == "changes-requested" and not blocking and not missing and not disputed and not no_cov:
        # what made it request changes was declined, optional or unverified: nothing left to fix
        verdict = "needs-checks" if any(str(c.get("what", "")).startswith("unverified") for c in checks) else "approve"
        notes.append(f"only minor{', declined' if declined else ''} or unverified findings left: {verdict}")
    elif verdict == "needs-checks" and meta.get("resume") and not blocking and not missing and not disputed and not no_cov \
            and not open_checks and not any(str(c.get("what", "")).startswith("unverified") for c in checks):
        verdict = "approve"
    return verdict, findings, checks, notes


def report_review(slug, project, entry, review, meta):
    root = (projects().get(slug) or {}).get("path") or project
    declined = () if meta.get("independent") else declined_for(slug, meta.get("ref"), root, meta.get("head"))
    verdict, findings, checks, notes = enforce_review_rules(review, meta, declined)
    order = {"blocker": 0, "major": 1, "minor": 2, "nit": 3}
    findings.sort(key=lambda f: (order.get(f.get("severity"), 9), CATEGORY_ORDER.get(f.get("category"), 6)))
    if meta.get("mode") == "ref":
        head, dirty = meta["head"], ""
    else:  # the working tree as it is now, after the review
        head, dirty = review_state(project)
    append_jsonl(reviews_path(slug), {"ts": now_iso(), "run": entry["id"], "verdict": verdict, "head": head,
                                      "dirty": dirty, "ref": meta.get("ref"), "mode": meta.get("mode", "worktree"),
                                      "base": meta.get("base"), "findings": findings, "checks": checks,
                                      "reuse": review.get("reuse") or [], "new_symbols": meta.get("new_symbols") or [],
                                      "unchecked": review.get("_missing") or [], "disputed": review.get("_disputed") or [],
                                      "coverage_unchecked": review.get("_no_cov") or [],
                                      "gaps": review.get("_gaps") or [], "goal": review.get("_goal"),
                                      "branch": branch_of(root, meta.get("ref")) if meta.get("mode") == "ref" else "",
                                      "after": meta.get("after"), "delta": bool(meta.get("resume"))})
    order = {"blocker": 0, "major": 1, "minor": 2, "nit": 3}
    label = meta.get("ref") or "the working tree"
    reuse = [r for r in review.get("reuse") or [] if isinstance(r, dict)]
    print(f"\nREVIEW: {verdict.upper()} · {len(findings)} findings · {len(checks)} checks to run"
          f" · recorded for {label} @ {head[:12]}" + (" + uncommitted changes" if dirty else ""))
    for n in notes:
        print(f"  [lean-agent] {n}")
    n_new = len(meta.get("new_symbols") or [])
    if n_new:
        detail(f"  reuse: {review.get('_covered', 0)} of {n_new} new symbols checked · "
               f"{len(review.get('searches') or [])} searches")
    else:
        detail("  reuse: no new symbols (the change edits existing code)")
        reuse = []
    for r in reuse:
        cands = ", ".join(map(str, r.get("candidates") or [])) or "nothing found"
        detail(f"    {r.get('symbol', '?')} -> {cands[:160]} -> {r.get('verdict', '?')}")
    for c in review.get("coverage") or []:
        if isinstance(c, dict):
            detail(f"    test '{str(c.get('test', '?'))[:70]}': {c.get('verdict', '?')}"
                   + (f" ({str(c.get('by'))[:80]})" if c.get("by") else ""))
    for x in (review.get("unverified") or [])[:6]:
        detail(f"    could not verify: {str(x)[:140]}")
    for sb in review.get("siblings") or []:
        if isinstance(sb, dict):
            detail(f"    sibling {sb.get('checked', '?')}: {'needs the same fix' if sb.get('needs_fix') else 'fine'}")
    findings.sort(key=lambda f: (order.get(f.get("severity"), 9), CATEGORY_ORDER.get(f.get("category"), 6)))
    for i, f in enumerate(findings, 1):
        loc = f"{f.get('file', '?')}:{f.get('line', '')}".rstrip(":")
        cat = f"/{f['category']}" if f.get("category") else ""
        issue = str(f.get("issue", ""))
        say(f"  {i}. [{f.get('severity', '?')}{cat}] {loc}: {issue}",
            f"  {i}. [{f.get('severity', '?')}{cat}] {loc}: {issue if len(issue) <= 140 else issue[:137] + '...'}")
        if f.get("suggestion"):
            detail(f"      fix: {f['suggestion']}")
    for c in checks:
        print(f"  [check] {c.get('what', '')}" + (f" ({c['why']})" if c.get("why") else ""))
    gaps = review.get("_gaps") or []
    if review.get("_goal"):
        detail(f"  goal: {review['_goal']}")
    if gaps:
        print(f"  known gaps: {len(gaps)} (the user decides on each before a PR; acknowledge one: "
              f"lean-agent review decline {slug} g<n> --why \"...\")")
        for i, g in enumerate(gaps, 1):
            tag = ("blocks the goal" if g.get("blocks_goal") is True else
                   "not checked by the reviewer" if g.get("unaddressed") else
                   f"out of scope? {g.get('scoped_out')}" if g.get("scoped_out") else "doesn't block the goal")
            print(f"  g{i}. {g.get('file', '?')}{':' + str(g['line']) if g.get('line') else ''}: "
                  f"{str(g.get('what', ''))[:140]} [{tag}]")
    if review.get("_declined_shown"):
        detail("  declined earlier: " + "; ".join(f"{d.get('symbol') or d.get('file', '?')}: {str(d.get('issue') or d.get('gap') or '')[:60]}"
                                                for d in review["_declined_shown"]))
    runs = [r for r in ledger() if r.get("project") == slug and r.get("role") in ("reviewer", "reuse-check")
            and (r.get("review_meta") or {}).get("ref") == meta.get("ref")]
    cost = lambda rs: sum(r.get("cost_usd") or 0 for r in rs)
    print(f"  cost: this review ${entry.get('cost_usd') or 0:.2f} ({entry.get('units', 0):,} sonnet-eq) · "
          f"{meta.get('ref') or 'this change'} so far ${cost(runs):.2f} over {len(runs)} review run(s)")
    if BRIEF:
        print(f"  full review (reuse table, coverage, fixes): lean-agent runs --show {entry['id']}")
    blocking = [f for f in findings if f.get("severity") in ("blocker", "major")]
    if verdict == "approve" and not blocking and gaps:
        print(f"Approved, but with {len(gaps)} known gap(s): tell the user about each in one line and get their word "
              f"(out of scope: lean-agent review decline {slug} g<n> --why \"...\") before calling it ready or opening a PR.\n"
              f"approved: {len(gaps)} known gap(s) wait for your decision (exit 2 until each is declined or fixed; "
              "`review --status` exits 2 as well until then)")
        return 2
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


def ensure_worktree(slug, repo, ref, reset=False):
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
    moved = None
    if reused:
        branch = git(path, "symbolic-ref", "--quiet", "--short", "HEAD")
        head = git(path, "rev-parse", "HEAD") or ""
        ahead = head and head != sha and git(path, "merge-base", "--is-ancestor", head, sha) is None
        if ahead and not reset:
            # commits a worker made here and nobody pushed yet (e.g. a merge): never throw them away silently
            print(f"lean-agent: worktree {path} has commits that aren't on {ref} (HEAD {head[:10]}); keeping them "
                  f"(--reset-worktree discards them)", file=sys.stderr)
        elif git(path, "status", "--porcelain", "--untracked-files=no") and not reset:
            print(f"lean-agent: worktree {path} has uncommitted changes; using it as it is", file=sys.stderr)
        elif not branch:
            if head != sha:
                moved = (head, sha)
            git(path, "checkout", "-q", *(["--force"] if reset else []), "--detach", sha)
        elif reset:
            moved = (head, sha) if head != sha else None
            git(path, "reset", "-q", "--hard", sha)
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
    return {"path": path, "name": name, "ref": ref, "branch": branch, "reused": reused, "commit_rule": commit_rule,
            "head": git(path, "rev-parse", "HEAD") or "", "moved": moved}


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


def clean_merge_approval(slug, path):
    """The approving review of HEAD's first parent, when HEAD is a merge that git made on its own (no conflict
    edits: the same tree `git merge-tree` builds) and that touches none of the files the PR itself changed;
    else None. Merging the base branch in again then needs no new review."""
    parents = (git(path, "rev-list", "--parents", "-n", "1", "HEAD") or "").split()[1:]
    if len(parents) != 2:
        return None
    first, second = parents
    review = next((r for r in reversed(list(read_jsonl(reviews_path(slug))))
                   if r.get("head") == first and r.get("verdict") == "approve" and not r.get("dirty")), None)
    if not review:
        return None
    auto = git(path, "merge-tree", "--write-tree", first, second)
    if not auto or auto.split()[0] != git(path, "rev-parse", "HEAD^{tree}"):
        return None  # conflicts were resolved by hand, or git is too old to tell: review it
    base = git(path, "merge-base", first, second) or ""
    own = set((git(path, "diff", "--name-only", base, first) or "").split())
    merged_in = set((git(path, "diff", "--name-only", first, "HEAD") or "").split())
    if own & merged_in:
        return None
    label = git(path, "name-rev", "--name-only", "--refs=refs/remotes/*", second) or second[:10]
    return dict(review, _merged=label)


def worktree_push(a):
    """Push a worktree's branch to origin: an outward action, so it needs a review and the user's approval."""
    slug, repo = resolve_project(a.project)
    if not a.ref:
        die("which branch? lean-agent worktree push <project> <ref>")
    w = (worktree_index().get(slug) or {}).get(slugify(a.ref.replace("/", "-"), 60))
    if not w or not os.path.isdir(w["path"]):
        die(f"no lean-agent worktree for {a.ref} in {slug} (see: lean-agent worktrees {slug})")
    path, branch = w["path"], git(w["path"], "symbolic-ref", "--quiet", "--short", "HEAD")
    if not branch and w.get("ref", "").startswith("origin/"):
        branch = w["ref"][len("origin/"):]  # a detached worktree of origin/<branch>: its commits go to <branch>
    elif not branch:
        die(f"{path} is a detached checkout: there's no branch to push")
    dirty = git(path, "status", "--porcelain", "--untracked-files=no")
    if dirty and not a.only_commits:
        files = [l.split(None, 1)[-1] for l in dirty.splitlines() if l.strip()]  # "XY path" (git() strips the first)
        die(f"{path} has uncommitted changes in {', '.join(files[:8])}" + (f" and {len(files) - 8} more" if len(files) > 8 else "")
            + ": another worker's work in progress? Commit or discard them, or push only what is committed: "
            f"lean-agent worktree push {slug} {a.ref} --only-commits ...")
    if dirty:
        print(f"note: {len(dirty.splitlines())} uncommitted change(s) stay in the worktree; only commits are pushed")
    upstream = git(path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}") or (
        w["ref"] if w.get("ref", "").startswith("origin/") else None)
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
    if attribution() == "off":
        # only commits unique to this branch: anything on a remote-tracking branch is already published
        unique = (git(path, "rev-list", "HEAD", "--not", "--remotes") if git(path, "remote")
                  else git(path, "rev-list", "HEAD", "--not", w.get("ref") or "HEAD~20")) or ""
        rng = None
        bodies = git(path, "log", "--no-walk=unsorted", "--format=%H%n%B%n--END--", *unique.split()) if unique.strip() else ""
        bodies = bodies or ""
        credited = [sha_[:12] for sha_, body in re.findall(r"(?s)([0-9a-f]{40})\n(.*?)--END--", bodies)
                    if CLAUDE_CREDIT_RE.search(body)]
        if credited:
            die(f"commit(s) {', '.join(credited)} credit Claude, but attribution is off (lean-agent attribution). "
                "Have a worker reword them (git commit --amend / rebase -i is not available to workers: ask for "
                "`git rebase` with an exec that rewrites the message), or turn attribution on.")
    match, _ = find_review(slug, path, "HEAD")
    inherited = None
    if not match or match["verdict"] != "approve":
        inherited = clean_merge_approval(slug, path)
        if inherited:
            match = inherited
            print(f"approval carried over from {match['run']}: HEAD is a clean merge of {match['_merged']} into the "
                  f"reviewed {match['head'][:10]} and changes none of the PR's own files")
    if not match or match["verdict"] != "approve":
        die(f"{branch} @ {sha[:12]} has no approving review. Run: lean-agent review {slug} --head {branch}"
            + (f" --base <base>" if not has_remote else ""), 2)
    target = remote_ref.split("/", 1)[1] if "/" in remote_ref else branch
    hit = push_guard.guarded(target, push_guard.project_patterns(slug))
    if hit and not a.override_guard:
        die(f"refused: {branch} would be pushed to origin/{target}, which matches the push guard {hit!r} "
            f"(lean-agent guard list {slug}). lean-agent never pushes to it, whatever was approved: push to your "
            f"own branch and open a pull request (e.g. have a worker create a branch from {branch} and set its "
            "upstream to a new remote branch).", 3)
    if hit:
        print(f"push guard {hit!r} overridden: {a.override_guard}")
    print(f"push {branch} @ {sha[:12]} to origin/{target}" + ("" if has_remote else " (a new remote branch)")
          + f", reviewed in {match['run']}:\n" + "\n".join("  " + c for c in commits.splitlines()))
    if not a.allow_send:
        print("ACTION NEEDED: pushing is an outward action and was NOT done. Show the user the commits above. Only if "
              f"they approve: lean-agent worktree push {slug} {a.ref} --allow-send \"<what the user approved>\"")
        return 2
    push_env = push_guard.git_env(os.environ)
    if hit:  # the user's explicit, logged override
        push_env["LEAN_AGENT_PUSH_GUARD_OVERRIDE"] = "1"
    p = subprocess.run(["git", "-C", path, "push", "origin", f"HEAD:refs/heads/{target}"],
                       capture_output=True, text=True, env=push_env)
    append_jsonl(home("pushes.jsonl"), {"ts": now_iso(), "project": slug, "branch": branch, "to": f"origin/{target}",
                                        "sha": sha, "review": match["run"], "approved": a.allow_send,
                                        "guard_override": a.override_guard if hit else None,
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
        elif ev.get("type") == "rate_limit_event":
            usage.record_plan_usage(ev.get("rate_limit_info"))
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
    if a.action == "env":
        store = load_json(home("mcp-env.json"), {})
        value = a.preset_name  # `mcp env VAR VALUE`
        if a.server and a.rm:
            if store.pop(a.server, None) is None:
                print(f"{a.server}: not set")
            else:
                print(f"{a.server}: removed")
            save_json(home("mcp-env.json"), store)
        elif a.server and (a.command or value is not None):
            store[a.server] = {"command": a.command} if a.command else {"value": value}
            save_json(home("mcp-env.json"), store)
            os.chmod(home("mcp-env.json"), 0o600)
            lean_mcp._ENV_CACHE.pop(a.server, None)
            if a.command:
                ok = lean_mcp.env_from_command(a.server) is not None
                print(f"{a.server}: " + ("the command works; workers get the value when they start" if ok else
                                          "the command printed nothing or failed; fix it and set it again"))
            else:
                print(f"{a.server}: set (stored in {home('mcp-env.json')}, readable only by you; for a secret "
                      "prefer --command so nothing is stored)")
            used = [n for n, info in lean_mcp.discover().items() if "${" + a.server in json.dumps(
                info.get("raw") or info["config"])]
            print(f"{a.server}: used by " + (", ".join(used) if used else "no MCP server lean-agent knows of"))
        elif a.server and a.server not in store:
            print(f"{a.server}: not set. Set it: lean-agent mcp env {a.server} <value>  (or --command \"...\")")
        for k, v in sorted(store.items()):
            print(f"{k:<32} " + (f"from: {v['command']}" if v.get("command") else "value set"))
        if not store:
            print("No variables. For a plugin config that uses ${VAR} or ${VAR:-default}: "
                  "lean-agent mcp env VAR <value>, or --command \"<prints it>\"")
        return
    project = resolve_project(a.project)[1] if getattr(a, "project", None) else None
    servers = lean_mcp.discover(project)
    if a.server and a.server != CHROME:
        a.server = lean_mcp.resolve_name(a.server, servers) or a.server
    if a.action == "ignore":
        if a.server:
            if a.server not in servers and not a.rm:
                unknown_server(a.server, servers)
            set_ignored(a.server, not a.rm)
            print(f"{a.server}: " + ("checked again by doctor" if a.rm else
                                     "ignored: doctor skips it, `mcp list` marks it; --mcp still works if you ask"))
        names = sorted(ignored_servers())
        print("ignored: " + (", ".join(names) if names else "none"))
        return
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
            if name in ignored_servers():
                notes.append("ignored")
            if aliases.get(name):
                notes.append(f"--mcp {aliases[name]}:...")
            st = cache.get(name, {}).get("status")
            why = cache.get(name, {}).get("error") or "; ".join(lean_mcp.config_problems(info["config"]))
            if st and st != "connected":
                notes.append(f"{st} for workers" + (f": {why}" if why else ""))
            elif why:
                notes.append(why)
            if info.get("unset_copies") and info["path"] not in info["unset_copies"]:
                notes.append(f"uses {info.get('copy', 'the')} copy; another copy isn't set up")
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
        notes = load_json(home("mcp-preset-notes.json"), {})
        if a.preset_name and a.desc is not None:
            notes.setdefault(a.server, {})[a.preset_name] = a.desc
            save_json(home("mcp-preset-notes.json"), notes)
        presets = mcp_presets(a.server, known)
        if a.grep:  # e.g. which presets can read pull requests: --grep pull
            rx = re.compile(re.escape(a.grep), re.I)
            presets = {n: t for n, t in presets.items() if rx.search(n) or rx.search(" ".join(t))
                       or rx.search((notes.get(a.server) or {}).get(n, ""))}
        if not presets:
            print(f"No presets for {a.server}. Add one: lean-agent mcp preset {a.server} <name> <tool,tool>")
        for name, tools in sorted(presets.items()):
            cost = sum((known or {}).get(t, 0) for t in tools)
            auto = name == "read" and name not in store.get(a.server, {})
            desc = (notes.get(a.server) or {}).get(name) or ("automatic: the get/list/search tools" if auto else "")
            print(f"{a.server}:{name}  {len(tools)} tools ~{cost:,} tok" + (f"  {desc}" if desc else ""))
            print(f"    {', '.join(tools)}")
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


def align_with_claude(name, info):
    """Compare lean-agent's copy of a server with `claude mcp get`. A different type or url (no secrets) is
    saved as a correction and tried; header differences are only reported. Returns a doctor result or None."""
    theirs = lean_mcp.claude_mcp_get(name)
    mine = info["config"]
    if not theirs:
        return None
    diff = [k for k in ("type", "url") if theirs.get(k) and theirs[k] != mine.get(k)]
    h_mine, h_theirs = mine.get("headers") or {}, theirs.get("headers")
    h_diff = [] if h_theirs is None else sorted(k for k in set(h_mine) | set(h_theirs)
                                               if h_mine.get(k) != h_theirs.get(k))
    label = f"plugin MCP server {name}"
    if diff and not h_diff:
        fixes = load_json(home("mcp-overrides.json"), {})
        fixes[name] = {"from": lean_mcp.server_target(mine), **{k: theirs[k] for k in diff}}
        save_json(home("mcp-overrides.json"), fixes)
        cfg = {**mine, **{k: theirs[k] for k in diff}}
        server_tools(name, cfg, refresh=True)
        c = mcp_cache().get(name) or {}
        if c.get("status") == "connected" and c.get("tools"):
            return True, (f"{label}: usable by workers after matching Claude Code's {' and '.join(diff)} "
                          f"({len(c['tools'])} tools)"), None
        return (False, f"{label}: still {c.get('status') or 'unknown'} as a worker after matching Claude Code's "
                f"{' and '.join(diff)}", "sign in once more in Claude Code (/mcp), then: lean-agent doctor")
    if diff or h_diff:
        what = ", ".join(diff + [f"header {h}" for h in h_diff])
        return (False, f"{label}: connected in Claude Code but needs-auth as a worker: lean-agent's copy differs "
                f"from Claude Code's in {what}", "header values can be secrets, so lean-agent won't copy them; "
                "compare `claude mcp get " + name + "` with the plugin's .mcp.json")
    return None


def ignored_servers():
    """MCP servers marked as not used (`lean-agent mcp ignore`): doctor doesn't check them and `mcp list` marks
    them; a run that names one with --mcp still gets it."""
    return set(load_json(home("mcp-ignored.json"), []))


def set_ignored(name, on):
    names = ignored_servers()
    names = names | {name} if on else names - {name}
    save_json(home("mcp-ignored.json"), sorted(names))


def diagnose_plugin_server(name, info, claude_view, servers):
    """(ok, message, fix) for one plugin MCP server: can a worker use it, and if not, why."""
    label = f"plugin MCP server {name}"
    copies_note = ""
    if info.get("unset_copies") and info["path"] not in info["unset_copies"]:
        copies_note = f" (uses the {info.get('copy', '')} copy; an unused {'synced' if info.get('copy') == 'installed' else 'other'} copy isn't set up, which is fine)"
    elif info.get("copies_differ"):
        copies_note = f" [other copies differ: {', '.join(info.get('other_copies') or [])}; workers use {info['path']}]"
    problems = lean_mcp.config_problems(info["config"])
    if lean_mcp.placeholder_host(info["config"]):
        return (False, f"{label}: {problems[0]} (every copy: {', '.join([info['path']] + (info.get('other_copies') or []))})",
                "run the plugin's setup once in Claude Code (its setup skill or command), then: lean-agent doctor")
    missing = info.get("missing_options") or []
    env_missing = [m[4:] for m in missing if m.startswith("env:")]
    opt_missing = [m for m in missing if not m.startswith("env:")]
    if opt_missing:
        return (False, f"{label}: plugin option(s) {', '.join(opt_missing)} aren't readable (sensitive options are "
                f"in Claude Code's credentials store), so workers can't build its config",
                "set the option non-sensitively in /plugin manage, or add the server with `claude mcp add`")
    if env_missing:
        v = env_missing[0]
        return (False, f"{label}: its config uses ${{{'}, ${'.join(env_missing)}}} and lean-agent can't see "
                "that variable", f"let lean-agent fetch it when a worker starts, with no token on disk: "
                f"lean-agent mcp env {v} --command \"<prints it>\" (for GitHub: \"gh auth token\"; on macOS "
                f"a keychain item: \"security find-generic-password -s <name> -w\"). Or export it before "
                f"`lean-agent up`, or put it in the settings.json `env` block")
    c = mcp_cache().get(name) or {}
    fresh = c.get("key") == config_key(info["config"]) and c.get("probed", "") >= (
        datetime.datetime.now() - datetime.timedelta(days=1)).isoformat(timespec="seconds")
    if not fresh:
        server_tools(name, info["config"], refresh=True)
        c = mcp_cache().get(name) or {}
    worker = c.get("status") or "unknown"
    alias = lean_mcp.display_names(servers).get(name)
    if worker == "connected" and c.get("tools"):
        return (True, f"{label}: usable by workers ({len(c['tools'])} tools; --mcp {alias or name}:<preset|tools>)"
                + copies_note, None)
    if problems:
        why = "; ".join(problems)
        hint = ("set the variable for workers: lean-agent mcp env <VAR> <value> (or --command \"<prints it>\")"
                if any("isn't set" in p or "no token" in p for p in problems) else
                "check the token's value (no newline, no extra prefix); `lean-agent mcp env <VAR> --command ...` "
                "sets it for workers" if any("line break" in p for p in problems) or "uthorization" in why else
                f"see `claude mcp get {name}`; then: lean-agent mcp tools {name}")
        return False, f"{label}: {worker} as a worker: {why}{copies_note}", hint
    mine = lean_mcp.server_target(info["config"])
    if claude_view and name not in claude_view:
        return (False, f"{label}: {worker} as a worker, and Claude Code doesn't list it (`claude mcp list`)",
                "enable the plugin in /plugin, or ignore this if you don't use it")
    theirs_status, theirs = claude_view.get(name, (None, None))
    if theirs_status and theirs_status != "connected":
        how = ("sign in: open Claude Code, /mcp, pick it, Authenticate" if theirs_status == "needs-auth"
               else "it fails in Claude Code too: fix it there first (`claude mcp list`, /mcp)")
        return False, f"{label}: {theirs_status} in Claude Code itself, so workers can't use it either", how
    if theirs and theirs.split("?")[0] != mine.split("?")[0]:
        if info.get("other_copies"):
            return (False, f"{label}: {worker} as a worker; Claude Code connects to {theirs}, and none of the "
                    f"plugin's copies ({info['path']}, {', '.join(info['other_copies'])}) builds that",
                    "an env var set only in Claude Code's environment? put it in the settings.json `env` block")
        return (False, f"{label}: {worker} as a worker; Claude Code connects to {theirs} but lean-agent built "
                f"{mine}", "the plugin's config has a value lean-agent resolves differently (an env var set "
                "only in Claude Code's environment?); put it in the settings.json `env` block")
    if worker == "needs-auth" and theirs_status == "connected":
        fixed = align_with_claude(name, info)
        if fixed:
            return fixed
    if worker == "needs-auth":
        seen = "connected in Claude Code but " if theirs_status == "connected" else ""
        return (False, f"{label}: {seen}needs-auth as a worker: no stored login matches lean-agent's copy of "
                "the config (sign in once in Claude Code: /mcp)", "re-run `lean-agent mcp tools " + name + "`; if it stays, "
                "add the server with `claude mcp add` and sign in once for workers")
    empty = [h for h, v in (info["config"].get("headers") or {}).items() if v == ""]
    return (False, f"{label}: {worker} as a worker" + (f": {c['error']}" if c.get("error") else "")
            + (f" (empty headers: {', '.join(empty)})" if empty else "") + copies_note,
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
    if runs and getattr(a, "top", None):
        print(f"\nBiggest {min(a.top, len(runs))} runs:")
        for line in top_runs_lines(runs, a.top):
            print("  " + line)
    print()
    print_limits()


def print_plan_line():
    """Claude's own plan utilization (from the last worker or probe), the same numbers /usage shows."""
    real, age = usage.plan_usage()
    if not real:
        print("Plan (from Claude): not seen yet. It comes with every worker run; get it now with "
              "`lean-agent limits --refresh` (one tiny Haiku call).")
        return
    names = {"five_hour": "session", "seven_day": "week"}
    parts = []
    for key, w in sorted(real.items(), key=lambda kv: (kv[0] not in names, kv[0])):
        if key == "seven_day_oauth_apps":
            continue
        label = names.get(key) or (key.replace("seven_day_", "") + " week")
        when = (f" (resets {datetime.datetime.fromtimestamp(w['resets_at']).astimezone():%a %H:%M})"
                if w.get("resets_at") else "")
        parts.append(f"{label} {w['pct']:.0f}%{when}")
    stale = age is not None and age > usage.PLAN_FRESH_MINUTES
    print(f"Plan (from Claude, {age:.0f} min ago): " + " · ".join(parts)
          + ("  [old: refresh with `lean-agent limits --refresh`]" if stale else ""))


def print_limits():
    print_plan_line()
    line, _ = pace_line()
    if line:
        print(line)
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
            line += (f" | plan {x['plan_pct']:.0f}%" if x.get("plan_source") == "claude"
                     else f" | plan ≈ {x['plan_pct']:.0f}% (estimate)")
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
    real, age = usage.plan_usage()
    if real and age is not None and age <= usage.PLAN_FRESH_MINUTES:
        print("Plan % and reset times come from Claude itself (includes claude.ai and other machines).")
    elif cfg.get("caps"):
        print(f"Between Claude's reports, plan % is estimated from /usage calibration ({cfg.get('fit', 'default weights')}).")
    elif not cfg.get("plan"):
        print("Windows roll until Claude reports its reset times (after the next worker, or `limits --refresh`).")


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


def refresh_plan_usage():
    d = home("work", "plan-probe")
    os.makedirs(d, exist_ok=True)
    _probe_session(["--setting-sources", "", "--strict-mcp-config"], d)


def cmd_limits(a):
    action = a.action or "show"
    if a.refresh:
        refresh_plan_usage()
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
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf) if a.json else contextlib.nullcontext():  # --json prints only the result
            _unreject(a, slug)
            _cmd_optimize(a)
            _draft_proposals(a, slug)
        result = optimize_result(a, slug)
        save_json(home("optimize", f"{slug}.json"), result)  # the dashboard's "Needs you" entry reads this
    if a.json:
        print(json.dumps(result))


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


WRITE_TOOL_RE = re.compile(r"(^|[_-])(create|update|delete|remove|add|set|post|send|reply|merge|close|resolve|edit|"
                           r"write|upload|comment|assign|link|move|rename|trigger|start|stop|approve|vote|"
                           r"complete|abandon|push|publish|submit|cancel|restart|deploy)([_-]|$)", re.I)


def is_write_tool(name):
    return bool(WRITE_TOOL_RE.search(name))


def generalise(text):
    """A run's task wording without the specifics of that one run (ids, numbers, hashes, labels)."""
    t = re.sub(r"(?im)^\s*(goal|known|done when|context|task)\s*:\s*", "", str(text))
    t = re.sub(r"(?i)\b(PR|pull request|MR|merge request|issue|ticket|work item|thread|run)s?\s*[#!]?\s*\d+", r"\1 <id>", t)
    t = re.sub(r"\b[A-Z]{1,6}#\d+\b", "<ticket>", t)
    t = re.sub(r"\b[0-9a-f]{7,40}\b", "<sha>", t)
    t = re.sub(r"\b\d{3,}\b", "<n>", t)
    t = re.sub(r"(?<![\w/])(?:/[\w.-]+){2,}", "<path>", t)  # absolute paths of this machine
    return re.sub(r"[ \t]+", " ", t).strip()


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
    groups, used_names, drafted, extends = [], {}, {}, {}
    for r in runs:
        tools = run_tools(r)
        if not tools:
            continue
        tw = words(generalise(r["task"]))
        for g in groups:
            if g["read_only"] != bool(r.get("read_only")):
                continue  # read-only and changing runs never share a draft
            same_srv = set(tools) & set(g["tools"])
            if any(_jaccard(set(tools[s]), set(g["tools"][s])) >= 0.6 for s in same_srv) or _jaccard(tw, g["words"]) >= 0.5:
                g["runs"].append(r)
                for s, ts in tools.items():
                    g["tools"][s] = list(dict.fromkeys(g["tools"].get(s, []) + ts))
                g["words"] |= tw
                break
        else:
            groups.append({"runs": [r], "tools": {s: list(ts) for s, ts in tools.items()}, "words": set(tw),
                           "read_only": bool(r.get("read_only"))})
    drafts = []
    for g in groups:
        first, n = g["runs"][0], len(g["runs"])
        calls = sum(sum((r.get("mcp_calls") or {}).values()) for r in g["runs"])
        distinctive = any(len(ts) >= 2 for ts in g["tools"].values()) or calls >= 4 or (first.get("turns") or 0) >= 6
        all_tools = {t for ts in g["tools"].values() for t in ts}
        covered = next((c for c in cards if sum(t in c["text"] for t in all_tools) * 2 >= max(1, len(all_tools))), None)
        key = hashlib.sha1(json.dumps(sorted(g["tools"].items())).encode()).hexdigest()[:6]
        if distinctive and not covered:
            task_line = next((l for l in generalise(first["task"]).splitlines() if l.strip()), "")
            title_words = [w for w in re.findall(r"[A-Za-z][A-Za-z0-9-]+", task_line) if w.lower() not in STOPWORDS]
            title = "How to: " + " ".join(title_words[:9])
            lines = [f"Recipe from {n} successful run{'s' if n > 1 else ''} ({', '.join(r['id'] for r in g['runs'][:4])}).",
                     f"Task like: {generalise(first['task'])[:200]}", ""]
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
                lines += ["", "Example answer (from one run; its specifics will differ): "
                          + generalise(first["result_head"])[:240].replace("\n", " ")]
            lines += ["", f"Cost without this card: {first.get('turns') or '?'} turns, {first.get('units', 0):,} sonnet-eq. "
                      "Edit the steps (ids, queries, time windows) so the next worker skips the exploring."]
            drafts.append({"id": f"draft-card-{key}", "kind": "card", "card_id": slugify("recipe-" + "-".join(
                w.lower() for w in title_words[:5]), 50), "title": title, "text": "\n".join(lines), "runs": n,
                "why": f"from {n} run{'s' if n > 1 else ''}: {first.get('turns') or '?'} turns, "
                       f"{first.get('units', 0):,} sonnet-eq, {calls} MCP calls"})
        for srv, all_ts in g["tools"].items():
            known = (cache.get(srv) or {}).get("tools") or {}
            offered = max((r.get("mcp_offered") or {}).get(srv, 0) for r in g["runs"])
            presets = mcp_presets(srv, known)
            reads = [t for t in all_ts if not is_write_tool(t)]
            writes = [t for t in all_ts if is_write_tool(t)]
            variants = [("", reads)] if g["read_only"] or not writes else [("", reads), ("-write", all_ts)]
            for suffix, ts in variants:
                if not ts or any(set(ts) <= set(v) and len(v) <= max(len(ts) + 2, int(len(ts) * 1.5))
                                 for v in presets.values()):
                    continue  # an existing preset already covers these tools closely (a broad one like `read` doesn't)
                if frozenset(ts) in drafted.setdefault(srv, set()):
                    continue  # another draft in this batch has exactly these tools
                drafted[srv].add(frozenset(ts))
                sup = [(p_, v) for p_, v in presets.items() if set(v) < set(ts)]
                if sup:  # extend the closest existing preset instead of a new name next to it
                    p_, v = max(sup, key=lambda x: len(x[1]))
                    extra = [t for t in ts if t not in v]
                    if any(is_write_tool(t) for t in extra) and not any(is_write_tool(t) for t in v):
                        p_ = p_ if p_.endswith("-write") else p_ + "-write"  # a read-only preset stays read-only
                    ext = extends.setdefault((srv, p_), {"base": list(presets.get(p_) or v), "extra": [], "runs": 0})
                    ext["extra"] = list(dict.fromkeys(ext["extra"] + extra))
                    ext["runs"] += n
                    continue
                if not (n >= 2 or (offered and offered >= 2 * len(ts) and offered - len(ts) >= 5)):
                    continue
                taken = set(presets) | used_names.setdefault(srv, set())
                name = preset_name(srv, ts) + suffix
                k = 2
                while name in taken:  # never two drafts (or a saved preset) with one name
                    name = f"{preset_name(srv, ts)}{k}{suffix}"
                    k += 1
                used_names[srv].add(name)
                cost, whole = sum(known.get(t, 0) for t in ts), sum(known.values())
                used_preset = next((p for p, v in presets.items() if offered and len(v) == offered), None)
                vs = (f" vs {used_preset} ~{sum(known.get(t, 0) for t in presets[used_preset]):,}" if used_preset
                      else f" vs whole server ~{whole:,}" if whole else "")
                drafts.append({"id": f"draft-preset-{key}-{slugify(srv, 20)}{suffix}", "kind": "preset", "server": srv,
                               "name": name, "tools": ts, "runs": n,
                               "why": f"{len(ts)} tools ~{cost:,} tok/turn{vs}; offered {offered or '?'}, used {len(ts)}"
                                      f" in {n} run{'s' if n > 1 else ''}"
                                      + (f"; includes write tools: {', '.join(t for t in ts if is_write_tool(t))}"
                                         if suffix else "; read-only")})
    for (srv, name), ext in sorted(extends.items()):  # one proposal per preset: the union of what runs needed
        existing = mcp_presets(srv, (cache.get(srv) or {}).get("tools") or {})
        tools = list(dict.fromkeys(ext["base"] + ext["extra"]))
        if name in existing and set(tools) <= set(existing[name]):
            continue
        new_name = name not in existing
        writes = [t for t in ext["extra"] if is_write_tool(t)]
        drafts.append({"id": f"draft-extend-{slugify(srv, 20)}-{name}", "kind": "preset", "server": srv,
                       "name": name, "tools": tools, "runs": ext["runs"],
                       "why": (f"new preset {name}: " if new_name else f"extend existing preset {name} with ")
                              + ", ".join(ext["extra"]) + (f"; write tools: {', '.join(writes)}" if writes else "")})
    return drafts


def _draft_proposals(a, slug):
    path = home("library", slug, "drafts.json")
    state = load_json(path, {})
    drafts = [d for d in draft_proposals(slug) if state.get(d["id"]) not in ("accepted", "rejected")]
    for rid in (a.reject or "").split(","):
        if rid:
            known_ids = {d["id"] for d in draft_proposals(slug)} | {_action_id(act, c, t) for act, c, _, t in
                                                                  _card_actions(slug, load_cards(slug), a, set())[0]}
            state[rid] = "rejected"
            print(f"rejected {rid}: won't be proposed again" if rid in known_ids else
                  f"rejected {rid} (no open draft has that id now; it won't be proposed if it comes up)")
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


def _unreject(a, slug):
    """--unreject <ids>: propose these drafts or card suggestions again (undoes --reject)."""
    ids = [x for x in (getattr(a, "unreject", None) or "").split(",") if x]
    if not ids:
        return
    path = home("library", slug, "drafts.json")
    state = load_json(path, {})
    changed = False
    for rid in ids:
        if state.get(rid) == "rejected":
            del state[rid]
            changed = True
            print(f"unrejected {rid}: proposed again if it still applies")
        else:
            print(f"{rid} was not rejected")
    if changed:
        save_json(path, state)


def _action_id(act, c, t):
    return f"{act}:{c['id']}" + (f":{t}" if t else "")


def _card_actions(slug, cards, a, skip):
    """Card changes the numbers support: [(kind, card, reason, type)], and the protected ones held back.
    Ones rejected before (in drafts.json) are left out."""
    rejected = {k for k, v in load_json(home("library", slug, "drafts.json"), {}).items() if v == "rejected"}
    actions = []
    for c in cards:
        if c.get("archived") or c["id"] in skip:
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
            recently = (c.get("shorten_checked") or "") >= (datetime.datetime.now() - datetime.timedelta(days=30)).isoformat()
            if rate >= 0.5 and c["tokens"] > 600 and not recently:
                actions.append(("trim", c, f"~{c['tokens']} tok and often used: `lean-agent card shorten {slug} "
                                f"{c['id']}` proposes a shorter text and checks nothing important is lost", None))
    actions = [x for x in actions if _action_id(x[0], x[1], x[3]) not in rejected]
    held = [x for x in actions if x[1].get("protected") and x[0] in ("archive", "uncore", "trim")]
    actions = [x for x in actions if x not in held]
    return actions, held


def _suggestion_meta(c, t):
    """One line on what a card suggestion rests on: how often workers used the card (per task type when it is one)."""
    bt = (c.get("by_type") or {}).get(t) if t and t != "*" else None
    used, offered = (bt["used"], bt["offered"]) if bt else (c["used"], c["offered"])
    return f"used in {used} of {offered} {t + ' ' if bt else ''}runs"


def optimize_result(a, slug):
    """What is left to decide, as one JSON-able dict (also what the dashboard shows)."""
    skip = {x for x in (getattr(a, "skip", None) or "").split(",") if x}
    actions, _ = _card_actions(slug, load_cards(slug), a, skip)
    state = load_json(home("library", slug, "drafts.json"), {})
    drafts = [d for d in draft_proposals(slug) if state.get(d["id"]) not in ("accepted", "rejected")]
    return {"project": slug, "ts": datetime.datetime.now().isoformat(timespec="seconds"),
            "suggestions": [{"id": _action_id(act, c, t), "kind": act, "card": c["id"], "reason": why,
                             "used": c["used"], "offered": c["offered"], "meta": _suggestion_meta(c, t)}
                            for act, c, why, t in actions],
            "drafts": [{"id": d["id"], "kind": d["kind"], "title": d["title"] if d["kind"] == "card" else
                        f"Preset {d['server']}:{d['name']}",
                        "name": d["card_id"] if d["kind"] == "card" else d["name"],
                        "summary": d["why"]} for d in drafts]}


def _cmd_optimize(a):
    slug, _ = resolve_project(a.project)
    cards = load_cards(slug)
    skip = {x for x in (a.skip or "").split(",") if x}
    actions, held = _card_actions(slug, cards, a, skip)
    if held:
        print("(protected cards are not listed: " + ", ".join(f"{act} {c['id']}" for act, c, _, _ in held) + ")")
    if skip and not a.apply:
        print(f"(--skip leaves out {', '.join(sorted(skip))} for this run only; `lean-agent card protect {slug} <id>` "
              "keeps a card out for good)")
    if not actions and not (a.accept or a.reject):
        print(f"Cards: nothing to promote, demote, archive or trim right now (that needs {a.min_runs}+ runs per card; "
              "earlier --apply changes are already in). New-card and preset drafts follow below, if any.")
    for act, c, why, _ in actions:
        print(f"{act:<8}{c['id']:<34}{why}")
    if a.apply:
        wanted = None if a.apply == "all" else {x for x in a.apply.split(",") if x}
        if wanted is not None:
            for x in sorted(wanted - {_action_id(act, c, t) for act, c, _, t in actions}):
                print(f"no open suggestion {x} (see: lean-agent optimize {slug})")
            actions = [x for x in actions if _action_id(x[0], x[1], x[3]) in wanted]
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
        for act, c, _, _ in actions:
            if act in ("core", "uncore", "archive"):
                print(f"applied: {act} {c['id']}" + (f"  (undo: lean-agent card unarchive {slug} {c['id']})"
                                                     if act == "archive" else ""))
        print("Applied core/uncore/archive changes (trims are up to you)."
              + (f" Skipped: {', '.join(sorted(skip))}." if skip else ""))
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
    if list(read_jsonl(reviews_path(slug))) and not any(c["id"] == "review-checklist" for c in load_cards(slug)):
        print(f"review  after a human review of a PR, teach the reviewer what it missed: "
              f"lean-agent review learn {slug} <PR> --mcp <tracker>  (or --text \"...\")")
    acked_path = home("library", slug, "gaps-acked.json")
    acked = set(load_json(acked_path, []))
    if a.ack:
        ids = [x for x in a.ack.split(",") if x]
        acked |= set(ids)
        save_json(acked_path, sorted(acked))
        for x in ids:
            print(f"acknowledged gap from run {x}: not shown again")
    live_cards = [c for c in load_cards(slug) if not c.get("archived")]
    tconf = (projects().get(slug) or {}).get("tracker") or {}
    note_words = _words(" ".join(map(str, (tconf.get("notes") or []) + tracker_facts_text(tconf))))
    given = {r["id"]: set(r.get("cards") or []) for r in ledger() if r.get("project") == slug}
    notes = list(read_jsonl(home("library", slug, "missing.jsonl")))[-a.notes * 3:]
    open_gaps, covered = [], 0
    for n in notes:
        gw = {w for w in _words(n["missing"]) if len(w) > 3}
        if n["run"] in acked:
            continue
        # covered by a card the run DIDN'T get (it exists now), or by a tracker note. A card the run had and
        # still reported missing is unclear: keep showing that gap.
        had = given.get(n["run"], set())
        known = note_words | _words(" ".join(c["text"] for c in live_cards if c["id"] not in had))
        if gw and len(gw & known) / len(gw) >= 0.6:
            covered += 1
            continue
        open_gaps.append(n)
    open_gaps = open_gaps[-a.notes:]
    if open_gaps:
        print("\nContext gaps reported by workers (turn recurring ones into cards with `lean-agent card add`; "
              f"hide one with --ack <run-id>):")
        for n in open_gaps:
            print(f"- [{n['run']}] {n['missing'][:200]}")
    if covered:
        print(f"({covered} earlier gap(s) hidden: a card or tracker note already covers them)")


# ---------------------------------------------------------------- commands: setup

ORCHESTRATOR_ENV = {
    "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1",   # memory lives in lean-agent; no MEMORY.md on every turn
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": str(DEFAULT_COMPACT_PCT),
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": str(DEFAULT_COMPACT_WINDOW),  # with 70%: compact at ~67K tokens, not at 70% of a 1M window
    "BASH_MAX_OUTPUT_LENGTH": "20000",
    "MAX_MCP_OUTPUT_TOKENS": "10000",
    "CLAUDE_CODE_SUBAGENT_MODEL": "sonnet",
    "LEAN_AGENT_BRIEF": "1",          # lean-agent commands print one line per item (details on request)
    "LEAN_AGENT_ANSWER_LINES": "25",  # workers answer in <= 25 lines; the rest goes to a details file
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


NO_ATTRIBUTION = {"commit": "", "pr": "", "sessionUrl": False}  # Claude Code's own switch: no Claude credit lines
NO_ATTRIBUTION_RULE = """\
Attribution: the user doesn't want Claude credited. Never add "Co-Authored-By: Claude ...", "Generated with
Claude Code", a Claude session link or any other mention of Claude or AI to commit messages, PR titles or
descriptions, code comments, or review/PR comments.
"""
CLAUDE_CREDIT_RE = re.compile(r"(?im)^\s*co-authored-by:.*\b(claude|anthropic)\b|generated with \[?claude code|"
                              r"claude\.ai/code/session")


def attribution():
    """'on', 'off', or None when the user hasn't been asked yet."""
    return load_json(home("config.json"), {}).get("attribution")


def artifacts_on():
    return load_json(home("config.json"), {}).get("artifacts", "on") != "off"


def strict_on():
    return load_json(home("config.json"), {}).get("strict", "on") != "off"


def orchestrator_settings(existing):
    """lean-agent's keys for the home's .claude/settings.json; other keys (e.g. model) are kept."""
    data = dict(existing)
    if attribution() == "off":
        data["attribution"] = dict(NO_ATTRIBUTION)
    elif data.get("attribution") == NO_ATTRIBUTION:
        data.pop("attribution")
    perms = dict(data.get("permissions") or {})
    perms["allow"] = sorted(set(perms.get("allow") or []) | {"Bash(lean-agent:*)"})
    if os.environ.get("LEAN_AGENT_ORCHESTRATOR_TRIM") == "0":  # full context: drop lean-agent's trimming keys
        perms.pop("deny", None)
        data["permissions"] = perms
        for key in ("disableBundledSkills", "disableClaudeAiConnectors", "claudeMdExcludes", "enabledPlugins",
                    "autoCompactWindow"):
            data.pop(key, None)
        return data
    servers = [n for n, v in lean_mcp.discover().items() if v["source"] in ("user", "desktop")]
    trim = load_json(home("context-trim.json"), {})  # what `lean-agent context --apply` took out
    deny = set(ORCHESTRATOR_DENY)
    if artifacts_on():
        deny -= {"Artifact", "ArtifactComments"}  # ArtifactData stays denied
    perms["deny"] = sorted(deny | set(trim.get("deny") or [])
                           | {lean_mcp.tool_prefix(n).rstrip("_") for n in servers})
    data["permissions"] = perms
    data["disableBundledSkills"] = True
    data["autoCompactWindow"] = env_num("LEAN_AGENT_COMPACT_WINDOW", 100000)  # the orchestrator compacts early
    data["disableClaudeAiConnectors"] = True
    line = data.get("statusLine")
    if not line or "statusline.py" in str((line or {}).get("command", "")):  # a status line you set yourself stays
        data["statusLine"] = {"type": "command", "padding": 0, "command":
                              f"python3 {json.dumps(os.path.join(HERE, 'trampoline.py'))} statusline.py"}
    cfg = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    excludes = [os.path.join(cfg, "CLAUDE.md")]
    p = os.path.dirname(home("home"))
    excludes.append(os.path.join(cfg, "rules", "**"))  # the user's own rules (~/.claude/rules) are for their sessions
    while True:  # instruction files in folders above the home (e.g. ~/CLAUDE.md, ~/.claude/rules)
        excludes += [os.path.join(p, "CLAUDE.md"), os.path.join(p, "CLAUDE.local.md"),
                     os.path.join(p, ".claude", "CLAUDE.md"), os.path.join(p, ".claude", "rules", "**")]
        if os.path.dirname(p) == p:
            break
        p = os.path.dirname(p)
    # Claude Code matches resolved paths too: add the resolved form of each (e.g. macOS /var -> /private/var)
    excludes += load_json(home("context-trim.json"), {}).get("exclude") or []
    data["claudeMdExcludes"] = list(dict.fromkeys(excludes + [real_glob(x) for x in excludes]))
    user = load_json(os.path.join(cfg, "settings.json"), {})
    # the orchestrator carries no plugin tools (workers get plugin servers via --mcp): off also for synced
    # plugins, which are on by default and so aren't in the user's enabledPlugins
    on = [k for k, v in (user.get("enabledPlugins") or {}).items() if v]
    on += [pid for pid, _ in lean_mcp.synced_plugins() if user.get("enabledPlugins", {}).get(pid, True)]
    plugins = {k: False for k in on if k != PLUGIN_ID and not k.startswith(PLUGIN_ID.split("@")[0] + "@")}
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
    if a.cli:
        print(cli_reference())
        return
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
    if getattr(a, "dismiss", None):
        known = {r.get("id") for r in ledger()}
        d = load_json(home("dismissed.json"), {})
        for rid in a.dismiss:
            if rid not in known:
                die(f"no run {rid} (lean-agent runs)")
            d[f"run:{rid}"] = {"sig": "", "ts": now_iso()}
            d[f"q-{rid}"] = {"sig": "", "ts": now_iso()}
        save_json(home("dismissed.json"), d)
        print(f"dismissed {', '.join(a.dismiss)}: its question no longer waits on the dashboard")
        return 0
    runs = ledger()
    if a.project:
        slug, _ = resolve_project(a.project)
        runs = [r for r in runs if r["project"] == slug]
    if a.running:
        found = False
        for f in sorted(glob.glob(home("running", "*.json"))):
            m = load_json(f, {})
            try:
                os.kill(m.get("pid", 0), 0)
            except (OSError, TypeError):
                continue
            found = True
            print(f"{m.get('run', '?')}  running since {m.get('started', '?')[11:19]}  {m.get('model', '?'):<7} "
                  f"{m.get('project', '?'):<16} {m.get('task', '')[:70]}")
        if not found:
            print("No runs in progress.")
        return
    if a.show or a.tokens:
        rid = a.show if a.show and a.show != "last" else (runs[-1]["id"] if runs else None)
        r = next((x for x in reversed(runs) if x["id"] == rid), None)
        if not r:
            die(f"no run {rid!r}" if rid else "no runs yet")
        files = sorted(glob.glob(os.path.join(r["workdir"], "summary-*.txt")),
                       key=lambda f: int(re.sub(r"\D", "", os.path.basename(f)) or 0))
        if not files and not a.details:  # runs from before summaries were saved: rebuild the run line from the ledger
            cost = f"${r['cost_usd']:.2f}" if isinstance(r.get("cost_usd"), (int, float)) else "$?"
            print(f"run {r['id']} · {r['model']} · {r['status']} · {r.get('turns') or '?'} turns · "
                  f"{r.get('units', 0):,} sonnet-eq tok · {cost}")
            return
        if a.details:
            det = sorted(glob.glob(os.path.join(r["workdir"], "details-*.md")),
                         key=lambda f: int(re.sub(r"\D", "", os.path.basename(f)) or 0))
            if not det:
                die(f"run {r['id']} has no details file (its whole answer is in `lean-agent runs --show {r['id']}`)")
            files = det
        text = read_text(files[-1])
        if a.grep:
            rx = re.compile(re.escape(a.grep), re.I)
            text = "".join(l for l in text.splitlines(True) if rx.search(l)) or f"(no line matches {a.grep!r})\n"
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
        files += sorted(glob.glob(os.path.join(d, ".claude", "rules", "**", "*.md"), recursive=True))
    files += sorted(glob.glob(os.path.join(cfg, "rules", "**", "*.md"), recursive=True))  # the user's own rules
    return [f for f in dict.fromkeys(files) if os.path.isfile(f)]


def real_glob(pattern):
    """`pattern` with the folder before its first wildcard resolved through symlinks."""
    head, sep, tail = pattern.partition("*")
    d, base = os.path.split(head)
    return os.path.join(os.path.realpath(d), base) + sep + tail


def home_instruction_files(h):
    """[(path, ~tokens)] of the instruction files the orchestrator home really loads: those its settings'
    claudeMdExcludes doesn't leave out."""
    import fnmatch
    excludes = load_json(os.path.join(h, ".claude", "settings.json"), {}).get("claudeMdExcludes") or []
    out = []
    for f in instruction_files(h):
        if any(fnmatch.fnmatch(x, p) for p in excludes + [real_glob(p) for p in excludes]
               for x in (f, os.path.realpath(f))):
            continue
        out.append((f, est_tokens(read_text(f))))
    return out


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
    loaded = home_instruction_files(h) if os.path.isdir(h) else []
    if loaded:
        total = sum(t for _, t in loaded)
        report(None if len(loaded) > 1 else True, f"orchestrator loads ~{total:,} tokens of instructions on every call: "
               + ", ".join(f"{os.path.basename(f)} ~{t:,}" for f, t in loaded),
               "keep files other than lean-agent's guide out: lean-agent doctor --fix (refreshes the excludes)")
    report(is_trusted(h), "orchestrator home is trusted", "lean-agent trust")
    report(True, f"artifacts: {'on' if artifacts_on() else 'off'} (lean-agent config artifacts on|off)")
    report(True, f"strict orchestrator: {'on' if strict_on() else 'off'} (lean-agent config strict on|off)")

    slug = default_project(path)
    projs = projects()
    in_project = slug in projs and (path + os.sep).startswith(os.path.realpath(projs[slug]["path"]) + os.sep)
    root = os.path.realpath(projs[slug]["path"]) if in_project else None
    is_home = path == os.path.realpath(h) or path.startswith(os.path.realpath(h) + os.sep)
    if not in_project and not is_home:
        report(None, f"{path} isn't a learned project, so the per-project checks are skipped (run doctor in a "
               "project's folder for them, or `lean-agent learn <repo root> --name <name>` if this should be one)")
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

    stale = forward_old_hooks(dry=not a.fix)
    if stale and not a.fix:
        report(False, f"{len(stale)} hook script(s) in older cached plugin copies run outdated code (sessions "
               "started on them keep using them, e.g. an old session cap)", "lean-agent doctor --fix  (or sync)")
    elif stale:
        report(True, f"forwarded {len(stale)} old hook script(s) to the clone; open sessions use them from their "
               "next tool call")
    st = chrome_state()
    print("  chrome for workers: " + ("verified" if st.get("ok") else "not verified (lean-agent chrome check)"))
    import dashboard as _dash
    dcfg = _dash.settings()
    print(f"  dashboard: {'running' if dashboard_running() else 'not running'} on port {dcfg['port']}"
          + (" · Claude desktop preview entry in launch.json" if dcfg.get("preview") else
             " · no Claude desktop preview entry (lean-agent dashboard --preview)")
          + " · whether a session has the built-in browser tools can only be seen inside that session")
    for s_ in sorted(projects()):
        print(f"  {s_}: never pushes to " + (", ".join(push_guard.project_patterns(s_)) or "(nothing guarded)")
              + " (lean-agent guard)")
    for s_, v in projects().items():
        warn = email_warning(v.get("tracker") or {})
        if warn:
            report(None, f"{s_} tracker: {warn}")
    plugin_srv = {n: v for n, v in lean_mcp.discover().items() if v["source"] == "plugin"}
    claude_view = lean_mcp.claude_mcp_list() if plugin_srv else {}
    if claude_view:  # now that Claude Code's choice is known, pick the same copy of duplicated plugins
        plugin_srv = {n: v for n, v in lean_mcp.discover().items() if v["source"] == "plugin"}
    for name in getattr(a, "ignore", None) or []:
        set_ignored(lean_mcp.resolve_name(name, lean_mcp.discover()) or name, True)
    ignored = ignored_servers()
    for name, info in sorted(plugin_srv.items()):
        if name in ignored:
            print(f"  plugin MCP server {name}: ignored (not used; `lean-agent mcp ignore --rm {name}` to check it again)")
            continue
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


def disable_home_mcp(h):
    """Switch off, for the orchestrator home only, the MCP servers Claude Code would otherwise connect there
    (your user-scope servers and plugin servers): the orchestrator uses none of them, and a server that fails
    at start only adds a warning. Workers still get them with --mcp. Writes the same per-folder list `/mcp`
    uses (disabledMcpServers in ~/.claude.json); returns the names newly switched off."""
    if os.environ.get("LEAN_AGENT_ORCHESTRATOR_TRIM") == "0":
        return []
    cfg = claude_global_config()
    data = load_json(cfg, None) if os.path.exists(cfg) else None
    if not isinstance(data, dict):
        return []
    names = sorted(n for n, v in lean_mcp.discover().items() if v["source"] in ("user", "plugin"))
    proj = data.setdefault("projects", {}).setdefault(h, {})
    have = list(proj.get("disabledMcpServers") or [])
    new = [n for n in names if n not in have]
    if not new:
        return []
    proj["disabledMcpServers"] = have + new
    latest = load_json(cfg, None)  # Claude Code writes this file too: re-read right before writing
    if isinstance(latest, dict):
        latest.setdefault("projects", {}).setdefault(h, {})["disabledMcpServers"] = have + new
        data = latest
    save_json(cfg, data)
    return new


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


def ask_attribution_once():
    """At `up` in a terminal: the one question lean-agent asks before any commit or PR exists."""
    if attribution() is not None or not sys.stdin.isatty() or os.environ.get("LEAN_AGENT_NO_PROMPT"):
        return
    try:
        ans = input("lean-agent: should commits and PRs credit Claude as co-author? [y/N] ").strip().lower()
    except EOFError:
        return
    cmd_attribution(argparse.Namespace(value="on" if ans in ("y", "yes") else "off"))


def cmd_up(a):
    if getattr(a, "dashboard_only", False) and not service_session.supported():
        die("--dashboard-only needs a pty (macOS or Linux)")
    ask_attribution_once()
    h = prepare_home()
    refresh_blocks()
    prev = load_json(home("up.json"), {})
    save_json(home("up.json"), {"started": now_iso(), "server_env": ORCHESTRATOR_ENV, "name": a.name,
                                "local": a.local,
                                **({} if a.fresh else {k: prev[k] for k in ("session_id",) if prev.get(k)})})
    set_home_model(h, a.model)
    if a.fresh:
        drop_bridge_pointers(h)
    if not is_trusted(h):
        print(f"lean-agent: warning: {TRUST_HINT}", file=sys.stderr)
    off = disable_home_mcp(h)
    if off:
        print(f"lean-agent: MCP servers off for the orchestrator itself (workers still get them with --mcp): "
              f"{', '.join(off)}")
    env = dict(os.environ)
    for k, v in ORCHESTRATOR_ENV.items():
        env.setdefault(k, v)
    if a.compact_at:  # Claude Code's window can't go below 100K: lower the percentage instead
        window = max(100000, a.compact_at)
        env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"] = str(window)
        env["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"] = str(max(10, min(95, round(a.compact_at * 100 / window))))
    print(f"lean-agent: the orchestrator compacts at ~{compaction_point(int(env['CLAUDE_CODE_AUTO_COMPACT_WINDOW']), int(env['CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'])):,} "
          "tokens of context (keeps goals, approvals, open runs and findings; `--compact-at N` to change)", flush=True)
    for line in orchestrator_context_lines(h):
        print("lean-agent: " + line, flush=True)
    if a.budget:
        env["LEAN_AGENT_BUDGET"] = str(a.budget)
        env["LEAN_AGENT_BUDGET_SET"] = "1"  # chosen by the user (not the old built-in default)
    if a.budget_5h is not None or a.budget_week is not None:
        cur = load_json(usage.limits_path(), {})
        if a.budget_5h is not None:
            cur["5h"] = a.budget_5h
        if a.budget_week is not None:
            cur["week"] = a.budget_week
        save_json(usage.limits_path(), cur)
    up_info = load_json(home("up.json"), {})  # the dashboard's own conversation gets the same settings
    up_info["chat_env"] = {k: env[k] for k in list(ORCHESTRATOR_ENV) + ["LEAN_AGENT_BUDGET", "LEAN_AGENT_BUDGET_SET"]
                           if k in env}
    save_json(home("up.json"), up_info)
    env = push_guard.git_env(env)  # the orchestrator's own git commands are guarded too
    link = None
    if os.environ.get("LEAN_AGENT_DASHBOARD") != "0":
        import dashboard
        link = dashboard.start_background() if not a.local else None
        if a.local and not dashboard_running():
            subprocess.Popen([sys.executable, os.path.join(HERE, "dashboard.py")], stdin=subprocess.DEVNULL,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            link = dashboard.url()
        print(f"lean-agent: dashboard {link or dashboard.url()}" + ("" if link else " (already running)")
              + " (open it in a browser tab, e.g. Claude Desktop's built-in browser)", flush=True)
    dash_only = getattr(a, "dashboard_only", False)
    if dash_only and not link and os.environ.get("LEAN_AGENT_DASHBOARD") != "0":
        die("the dashboard didn't start (its port is taken: is another `lean-agent up` running?)")
    bindir = os.path.join(PLUGIN_ROOT, "bin")
    env["PATH"] = bindir + os.pathsep + env.get("PATH", "")  # `lean-agent` works even without the plugin
    cmd = [os.environ.get("LEAN_AGENT_CLAUDE") or "claude"]
    if a.model:
        cmd += ["--model", a.model]
    use_session = service_session.supported() and not a.local
    if a.local:
        print(f"lean-agent: orchestrator in {h} (model {a.model or 'default'})")
    elif dash_only:
        print(f"lean-agent: dashboard only: one interactive session in {h}, model {a.model or 'default'}; talk to it "
              "in the dashboard (Ctrl-C or the service stops it)", flush=True)
    else:
        if not use_session:
            cmd += ["remote-control", "--name", a.name]
        if a.permission_mode:
            cmd += ["--permission-mode", a.permission_mode]
        cap = env.get("LEAN_AGENT_BUDGET")
        print(f"lean-agent: orchestrator in {h}, model {a.model or 'default'}"
              + (f", self-set session cap {int(cap):,} sonnet-eq" if cap else ""))
        print(f"lean-agent: open the Claude app (Code) and pick \"{a.name}\"")
    extra = a.extra[1:] if a.extra[:1] == ["--"] else a.extra
    os.chdir(h)
    sys.stdout.flush()  # exec replaces the process; unflushed output would be lost when piped
    sys.stderr.flush()
    if a.local:
        try:
            os.execvpe(cmd[0], cmd + extra, env)  # e.g. `lean-agent up -- --debug --debug-file /tmp/rc.log`
        except FileNotFoundError:
            die("'claude' not found on PATH")
    if use_session:
        return host_session(cmd, extra, env, h, a.name, dash_only, a.permission_mode if dash_only else None)
    return remote_control(cmd + extra, env, h)


def host_session(cmd, extra, env, h, name, dash_only, permission_mode):
    """`up` hosts the one interactive orchestrator session in a pty it owns (so it also runs under launchd /
    systemd, where there is no terminal), with Remote Control unless --dashboard-only, and serves the socket
    the dashboard types into. A restart of `up` resumes the same conversation when its transcript exists."""
    import signal
    import threading
    sid = (load_json(home("up.json"), {}).get("session_id")) or str(uuid.uuid4())
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", sid):
        sid = str(uuid.uuid4())

    def build():
        resume = os.path.exists(service_session.transcript_path(h, sid))
        argv = list(cmd)
        if not dash_only:
            argv += ["--remote-control", name]
        if permission_mode:
            argv += ["--permission-mode", permission_mode]
        argv += ["--resume" if resume else "--session-id", sid] + extra
        return argv, sid

    state = {"seen": "", "stale": False}

    def on_text(text, host):
        state["seen"] = (state["seen"] + ANSI_RE.sub("", text))[-4000:]
        seen = state["seen"]
        if not state.get("served") and SERVED_RE.search(seen):
            state["served"] = True
            print("\nlean-agent: another Claude Code is serving this folder (often the Claude desktop app, or an "
                  "older `lean-agent up` in another terminal). Close it, then run `lean-agent up` again.", flush=True)
        if not state["stale"] and STALE_SESSION_RE.search(seen):
            state["stale"] = True
            if not state.get("retried"):
                host.terminate_for("stale")
            else:  # still the old session: say what still works
                print("\nlean-agent: Remote Control still tries the old session. The session works; pick the new "
                      "one in the app. If it keeps happening: claude update", flush=True)

    def on_stale():
        print("\nlean-agent: the previous Remote Control session is gone (deleted, archived or expired); "
              "starting a new one", flush=True)
        drop_bridge_pointers(h)
        state.update(seen="", stale=False, retried=True)

    host = service_session.Host(build, env, h, remote_control=not dash_only, on_text=on_text, on_stale=on_stale)
    threading.Thread(target=schedule_timer, daemon=True).start()

    for sig in (signal.SIGTERM, signal.SIGHUP):  # the service (or anyone) stops `up`: stop claude too, promptly
        signal.signal(sig, lambda *_: host.stop())
    try:
        rc = host.run()
    except FileNotFoundError:
        die("'claude' not found on PATH")
    except RuntimeError as exc:
        die(str(exc))
    except KeyboardInterrupt:
        host.stop()
        rc = 0
    if dash_only:
        try:
            import dash_chat
            dash_chat.chat().stop()
        except Exception:
            pass
    return rc


KEEP_TOOLS = {"Bash", "Read", "BashOutput", "TaskOutput", "KillShell", "TaskStop", "AskUserQuestion", "ToolSearch"}


def orchestrator_transcripts(h):
    cfg = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    found = []
    for d in dict.fromkeys([h, os.path.realpath(h)]):
        found += glob.glob(os.path.join(cfg, "projects", re.sub(r"[^A-Za-z0-9]", "-", d), "*.jsonl"))
    return sorted(set(found), key=os.path.getmtime, reverse=True)


def transcript_entries(path):
    try:
        with open(path, errors="replace") as fh:
            for line in fh:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if isinstance(e, dict):
                    yield e
    except OSError:
        return


def tool_use_counts(paths):
    """{tool name: calls} over orchestrator transcripts (MCP and lean-agent commands included)."""
    used = {}
    for path in paths:
        for e in transcript_entries(path):
            for c in ((e.get("message") or {}).get("content") or []) if e.get("type") == "assistant" else []:
                if isinstance(c, dict) and c.get("type") == "tool_use":
                    used[c.get("name")] = used.get(c.get("name"), 0) + 1
    return used


def _text_of(content):
    if isinstance(content, str):
        return content
    out = []
    for c in content or []:
        if isinstance(c, dict):
            out.append(c.get("text") or (_text_of(c.get("content")) if c.get("type") == "tool_result" else "")
                       or (json.dumps(c.get("input")) if c.get("type") == "tool_use" else ""))
    return "\n".join(x for x in out if x)


def message_items(path):
    """[(~tokens, kind, label)] for what the conversation holds now (after its last compaction)."""
    items, uses = [], {}
    for e in transcript_entries(path):
        if e.get("isCompactSummary") or e.get("subtype") == "compact_boundary":
            items = []  # earlier messages were replaced by the summary
            if e.get("isCompactSummary"):
                items.append((est_tokens(_text_of((e.get("message") or {}).get("content"))), "summary",
                              "compaction summary"))
            continue
        msg = e.get("message") or {}
        content = msg.get("content")
        if e.get("type") == "assistant":
            for c in content or []:
                if not isinstance(c, dict):
                    continue
                if c.get("type") == "tool_use":
                    inp = c.get("input") or {}
                    uses[c.get("id")] = (c.get("name"), str(inp.get("command") or inp.get("file_path") or "")[:90])
                    items.append((est_tokens(json.dumps(inp)), "tool call", f"{c.get('name')}: {uses[c.get('id')][1]}"))
                elif c.get("type") == "text":
                    items.append((est_tokens(c.get("text") or ""), "reply", (c.get("text") or "")[:70].replace("\n", " ")))
        elif e.get("type") == "user":
            if isinstance(content, str):
                items.append((est_tokens(content), "user", content[:70].replace("\n", " ")))
                continue
            for c in content or []:
                if isinstance(c, dict) and c.get("type") == "tool_result":
                    name, what = uses.get(c.get("tool_use_id"), ("?", ""))
                    items.append((est_tokens(_text_of(c.get("content"))), "output", f"{name}: {what}"))
                elif isinstance(c, dict) and c.get("type") == "text":
                    items.append((est_tokens(c.get("text") or ""), "user", (c.get("text") or "")[:70].replace("\n", " ")))
    return items


def message_advice(kind, label):
    if kind == "output" and "lean-agent" in label and not os.environ.get("LEAN_AGENT_BRIEF"):
        return "brief mode is off in this session: restart `lean-agent up` (it sets LEAN_AGENT_BRIEF)"
    if kind == "output" and re.search(r"lean-agent (run|do|review)\b", label):
        return "a worker answer: workers answer in <= 25 lines once `lean-agent up` sets LEAN_AGENT_ANSWER_LINES"
    if kind == "output" and label.startswith("Read"):
        return "a file read: have a -m haiku worker read it and answer the question instead"
    if kind == "output":
        return "command output: ask for less (--grep, head) or delegate it"
    if kind == "reply":
        return "a long reply: keep replies to a few lines"
    if kind == "tool call":
        return "a long task text: put long context in a card or a --task-file the worker reads"
    if kind == "user":
        return "pasted text: put long material in a file and give the path"
    return ""


def probe_home(h):
    """(init event, start-up context tokens) of a one-turn Haiku session in the home, as the orchestrator starts."""
    claude = os.environ.get("LEAN_AGENT_CLAUDE") or "claude"
    env = dict(os.environ, **ORCHESTRATOR_ENV)
    try:
        out = subprocess.run([claude, "-p", "--output-format", "stream-json", "--verbose", "--model", "haiku",
                              "--max-turns", "1"], input="Reply with just OK. Do not use tools.", capture_output=True,
                             text=True, cwd=h, env=env, timeout=180).stdout
    except (OSError, subprocess.TimeoutExpired):
        return {}, 0
    init, ctx = {}, 0
    for line in out.splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get("type") == "system" and ev.get("subtype") == "init":
            init = ev
        elif ev.get("type") == "result":
            u = ev.get("usage") or {}
            ctx = sum(u.get(k, 0) for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
    return init, ctx


def cmd_context(a):
    """What the orchestrator's context holds, what of it goes unused, and (--apply) taking that out."""
    h = prepare_home()
    trim_path = home("context-trim.json")
    trim = load_json(trim_path, {})
    if a.undo:
        save_json(trim_path, {})
        prepare_home()
        print("context: removed lean-agent context's denies and excludes; applies from the next session")
        return 0
    paths = orchestrator_transcripts(h)[:a.sessions]
    used = tool_use_counts(paths)
    calls = sum(used.values())
    print(f"Orchestrator sessions looked at: {len(paths)} (the latest {a.sessions}), {calls} tool calls")

    # what loads at start
    init, ctx = ({}, 0) if a.no_probe else probe_home(h)
    if ctx:
        print(f"Start-up context: ~{ctx:,} tokens (system prompt, tools, instruction files; one small Haiku call)")
    files = home_instruction_files(h)
    guide = os.path.join(h, "CLAUDE.md")
    extra = [(f, t) for f, t in files if os.path.realpath(f) != os.path.realpath(guide)]
    print("Instruction files: " + ", ".join(f"{os.path.basename(f)} ~{t:,}" for f, t in files))
    flagged_files = [f for f, _ in extra]
    for f, t in extra:
        print(f"  flag: {f} (~{t:,} tokens on every call) is not lean-agent's guide")
    tools = [t for t in init.get("tools") or [] if not t.startswith("mcp__")]
    keep = KEEP_TOOLS | set(a.keep or [])
    unused = sorted(t for t in tools if t not in used and t not in keep) if paths else []
    if tools:
        print(f"Tools: {len(tools)} loaded; used: " + (", ".join(f"{t} x{n}" for t, n in sorted(
            used.items(), key=lambda kv: -kv[1]) if t in tools) or "none"))
        if unused:
            print("  flag: never called in these sessions: " + ", ".join(unused))
    mcp = [s_.get("name") for s_ in init.get("mcp_servers") or [] if isinstance(s_, dict)]
    if mcp:
        print("  flag: MCP servers still load here: " + ", ".join(mcp) + " (lean-agent up switches them off)")
    for kind in ("agents", "skills"):
        names = [x if isinstance(x, str) else x.get("name", "?") for x in init.get(kind) or []]
        if names:
            print(f"  flag: {len(names)} {kind} load here ({', '.join(names[:8])}); the orchestrator doesn't use them"
                  + (" (Agent is denied); they come from your ~/.claude/agents" if kind == "agents" else ""))

    # what the conversation holds
    if paths:
        items = message_items(paths[0])
        total = sum(t for t, _, _ in items)
        by = {}
        for t, kind, _ in items:
            by[kind] = by.get(kind, 0) + t
        print(f"Messages now (latest session, since its last compaction): ~{total:,} tokens: "
              + ", ".join(f"{k} ~{v:,}" for k, v in sorted(by.items(), key=lambda kv: -kv[1])))
        for t, kind, label in sorted(items, key=lambda x: -x[0])[:a.top]:
            if t < 300:
                break
            print(f"  ~{t:>6,}  {kind:<9} {label[:80]}")
            tip = message_advice(kind, label)
            if tip:
                print(f"           -> {tip}")
        if total > 20000:
            print("  Messages can't be taken out of a running conversation: `lean-agent handoff --note` for what's "
                  "open, then /compact or /clear.")

    if not a.apply:
        if unused or flagged_files:
            print("Take the flagged tools and files out of the orchestrator's context: lean-agent context --apply "
                  "(--keep TOOL to keep one; --undo reverts)")
        return 0
    trim["deny"] = sorted(set(trim.get("deny") or []) | set(unused))
    trim["exclude"] = sorted(set(trim.get("exclude") or []) | set(flagged_files))
    save_json(trim_path, trim)
    prepare_home()
    print(f"applied: denied {len(unused)} tool(s), excluded {len(flagged_files)} file(s) in {h}/.claude/settings.json; "
          "applies from the next session (or /clear). Undo: lean-agent context --undo")
    return 0


def orchestrator_context_lines(h):
    """What the orchestrator's context holds: the guide's size now, and the last orchestrator session's start-up
    context (system prompt, tools, guide) and growth, measured from its transcript."""
    guide = os.path.join(h, "CLAUDE.md")
    lines = [f"context: the guide (CLAUDE.md) is ~{est_tokens(read_text(guide)):,} tokens"
             if os.path.exists(guide) else "context: no guide yet"]
    others = [(f, t) for f, t in home_instruction_files(h) if os.path.realpath(f) != os.path.realpath(guide)]
    if others:
        lines.append(f"context: also loaded on every call: " + ", ".join(f"{f} ~{t:,}" for f, t in others)
                     + " (keep them out: add them to claudeMdExcludes in " + os.path.join(h, ".claude", "settings.json") + ")")
    cfg = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    found = []
    for d in dict.fromkeys([h, os.path.realpath(h)]):
        found += glob.glob(os.path.join(cfg, "projects", re.sub(r"[^A-Za-z0-9]", "-", d), "*.jsonl"))
    series, path = [], None
    for f in sorted(set(found), key=os.path.getmtime, reverse=True):
        series = usage.context_series(f)
        if series:
            path = f
            break
    if not series:
        lines[0] += "; the start-up context is measured after the first session (`lean-agent budget` in a session)"
        return lines
    ctx = [c for _, c in series]
    when = datetime.datetime.fromtimestamp(os.path.getmtime(path)).strftime("%a %H:%M")
    lines[0] += (f"; last session ({when}): started at ~{ctx[0]:,} (system prompt, tools, guide), "
                 f"{len(ctx)} calls, ~{sum(ctx) // len(ctx):,} per call on average, ~{ctx[-1]:,} at the end, "
                 f"peak ~{max(ctx):,}")
    return lines


STALE_SESSION_RE = re.compile(r"(?:worker registration failed|registerWorker)[\s\S]{0,300}?\b404\b", re.I)


def drop_bridge_pointers(h):
    """remote-control keeps a pointer on exit so the next start can resume the old session; if that session
    was deleted, archived or expired, every start fails with "worker registration failed ... 404". Forget the
    session but keep the environment: remote-control leaves that registered when it stops, and a start that
    doesn't reuse it is refused ("This folder is already served ...")."""
    for path in dict.fromkeys([bridge_pointer(h), bridge_pointer(os.path.realpath(h))]):
        if not os.path.exists(path):
            continue
        data = load_json(path, {})
        if isinstance(data, dict) and data.get("environmentId"):
            save_json(path, {"sessionId": "", "environmentId": data["environmentId"],
                             "source": data.get("source") or "standalone"})
            print(f"lean-agent: {path}: forgot the old session (kept its environment); starting a new Remote "
                  "Control session", flush=True)
        else:
            os.remove(path)
            print(f"lean-agent: removed {path}; starting a new Remote Control session", flush=True)


def schedule_timer(every=300):
    """While `lean-agent up` runs: every few minutes, run the scheduled jobs that are due (and leave a heartbeat,
    so the orchestrator's hook knows it needn't start them itself)."""
    beat = home("scheduled", ".timer")
    while True:
        try:
            os.makedirs(os.path.dirname(beat), exist_ok=True)
            with open(beat, "w") as fh:
                fh.write(now_iso())
            if lean_schedule.any_due():
                with open(home("logs", "schedule.log"), "a") as log:
                    lean_schedule.run_due(log=lambda m: log.write(f"{now_iso()} {m}\n"))
        except Exception as exc:  # the timer must never take `up` down
            lean_log.log("error", "schedule", f"timer: {exc}")
        time.sleep(every)


def remote_control(cmd, env, h):
    """Run `claude remote-control`, passing its output through. If it can't bring back the previous session
    (deleted in the app, archived, expired: a 404 on worker registration), stop it, drop the pointer to that
    session and start once more with a new one, the same as `up --fresh`. Its output (stdout and stderr) goes
    through a pseudo-terminal when this is a terminal, so it still draws for one; keys go to it directly."""
    import signal
    import threading
    threading.Thread(target=schedule_timer, daemon=True).start()
    current = {}

    def stop(signum, _frame):  # the service (or anyone) stops `up`: stop claude too, promptly
        proc = current.get("proc")
        if proc and proc.poll() is None:
            proc.send_signal(signum)
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                proc.kill()
        sys.exit(0)
    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, stop)
    for attempt in (1, 2):
        stale, served = threading.Event(), threading.Event()
        proc, sources = start_watched(cmd, env)
        if proc is None:
            die("'claude' not found on PATH")
        current["proc"] = proc

        def pump(fd, out, _close):
            seen = ""
            while True:
                try:
                    raw = os.read(fd, 4096)
                except OSError:  # the pseudo-terminal closes when claude exits
                    break
                if not raw:
                    break
                out.buffer.write(raw)
                out.buffer.flush()
                seen = (seen + ANSI_RE.sub("", raw.decode("utf-8", "replace")))[-4000:]
                if not served.is_set() and SERVED_RE.search(seen):
                    served.set()
                    out.buffer.write(b"\nlean-agent: another Claude Code is serving this folder (often the Claude "
                                     b"desktop app, or an older `lean-agent up` in another terminal). Close it, then "
                                     b"run `lean-agent up` again.\n")
                    out.buffer.flush()
                if not stale.is_set() and STALE_SESSION_RE.search(seen):
                    stale.set()
                    if attempt == 1:
                        proc.terminate()
                    else:  # still the old session: say what still works
                        out.buffer.write(b"\nlean-agent: Remote Control still tries the old session. The server works; "
                                         b"pick the new session in the app. If it keeps happening: claude update\n")
                        out.buffer.flush()
        threads = [threading.Thread(target=pump, args=src, daemon=True) for src in sources]
        for t in threads:
            t.start()
        try:
            rc = proc.wait()
        except KeyboardInterrupt:  # Ctrl-C reaches claude too; let it shut down
            rc = proc.wait()
        for t in threads:
            t.join(timeout=2)
        for _, _, close in sources:
            try:
                close()
            except OSError:
                pass
        if not stale.is_set() or attempt == 2:
            return rc
        print("\nlean-agent: the previous Remote Control session is gone (deleted, archived or expired); "
              "starting a new one", flush=True)
        drop_bridge_pointers(h)
    return rc


SERVED_RE = re.compile(r"already served by (?:a terminal|another Claude Code)", re.I)
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\r")


def start_watched(cmd, env):
    """(process, [(fd to read, stream to copy to, close)]): one pseudo-terminal for stdout and stderr when stdout
    is a terminal (sized like it, and resized with it), else a pipe for each."""
    if sys.stdout.isatty():
        try:
            import pty
            import signal
            import struct
            import termios
            master, slave = pty.openpty()

            def resize(*_):
                try:
                    size = fcntl.ioctl(sys.stdout.fileno(), termios.TIOCGWINSZ, struct.pack("HHHH", 0, 0, 0, 0))
                    fcntl.ioctl(master, termios.TIOCSWINSZ, size)
                except OSError:
                    pass
            resize()
            try:
                proc = subprocess.Popen(cmd, env=env, stdout=slave, stderr=slave)
            except FileNotFoundError:
                return None, []
            finally:
                os.close(slave)  # only claude holds it now, so reading ends when claude exits
            signal.signal(signal.SIGWINCH, lambda *_: (resize(), proc.send_signal(signal.SIGWINCH)))
            return proc, [(master, sys.stdout, lambda: os.close(master))]
        except (ImportError, OSError, AttributeError):
            pass
    try:
        proc = subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except FileNotFoundError:
        return None, []
    return proc, [(proc.stdout.fileno(), sys.stdout, proc.stdout.close),
                  (proc.stderr.fileno(), sys.stderr, proc.stderr.close)]


FORWARD_MARK = "lean-agent: forwards to the clone"
FORWARD_STUB = """#!/usr/bin/env python3
# {mark}. This is an older cached copy of the plugin; sessions started on it keep this path for their
# hooks, so it hands over to the current code in the clone recorded in ~/.lean-agent/source.
import os, sys
home = os.path.expanduser(os.environ.get("LEAN_AGENT_HOME") or "~/.lean-agent")
try:
    root = open(os.path.join(home, "source")).read().strip()
except OSError:
    root = {root!r}
target = os.path.join(root, "plugins", "lean-agent", "scripts", {name!r})
if not os.path.isfile(target):
    sys.exit(0)  # no clone: do nothing rather than run outdated rules
os.execv(sys.executable, [sys.executable, target] + sys.argv[1:])
"""
HOOK_SCRIPTS = ("budget_hook.py", "squeeze_hook.py")


def old_plugin_copies():
    """Cached copies of this plugin other than the clone: Claude Code keeps the version a session started with,
    and sessions from before 0.3 call their hook scripts there directly (no trampoline)."""
    cfg = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    root = clone_root()
    out = []
    for d in glob.glob(os.path.join(cfg, "plugins", "cache", "*", "lean-agent", "*", "scripts")):
        if root and os.path.realpath(d).startswith(os.path.realpath(root)):
            continue
        out.append(d)
    return sorted(out)


def forward_old_hooks(dry=False):
    """Replace the hook scripts in older cached plugin copies with a stub that runs the clone's current code,
    so sessions that are already open get today's hooks from their next tool call. Returns the files changed."""
    root = clone_root()
    if not root:
        return []
    changed = []
    for d in old_plugin_copies():
        for name in HOOK_SCRIPTS:
            path = os.path.join(d, name)
            if not os.path.isfile(path) or FORWARD_MARK in read_text(path):
                continue
            changed.append(path)
            if not dry:
                with open(path, "w") as fh:
                    fh.write(FORWARD_STUB.format(mark=FORWARD_MARK, root=root, name=name))
    return changed


def cmd_sync(a):
    root = clone_root()
    if not root:
        die("this lean-agent isn't running from a git clone, so there's nothing to pull; "
            "update the plugin with: claude plugin update " + PLUGIN_ID)
    claude = os.environ.get("LEAN_AGENT_CLAUDE") or "claude"
    if a.check:  # look, don't touch
        git(root, "fetch", "-q", "origin")
        upstream = git(root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}") or "origin/main"
        behind = int(git(root, "rev-list", "--count", f"HEAD..{upstream}") or 0)
        if not behind:
            print(f"lean-agent {plugin_version()} is up to date")
            return 0
        theirs = git(root, "show", f"{upstream}:plugins/lean-agent/.claude-plugin/plugin.json") or "{}"
        try:
            new_version = json.loads(theirs).get("version", "?")
        except ValueError:
            new_version = "?"
        print(f"update available: lean-agent {plugin_version()} -> {new_version} ({behind} commit(s)). "
              "Install it: lean-agent sync")
        for line in (git(root, "log", "--format=  %s", f"HEAD..{upstream}") or "").splitlines()[:6]:
            print(line[:140])
        return 0
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
    forwarded = forward_old_hooks()
    if forwarded:
        print(f"older plugin copies: {len(forwarded)} hook script(s) now forward to the clone, so sessions that "
              "were already open get the current hooks from their next tool call")
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
    print(f"lean-agent {plugin_version()}")


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
    """[(model, runs, sonnet-eq)] for runs started from an orchestrator session."""
    rows = {}
    for r in session_runs(session_id, first_ts, last_ts):
        m = rows.setdefault(r["model"], [0, 0.0])
        m[0] += 1
        m[1] += r.get("units", r.get("weighted", 0) * usage.model_rate(r["model"]))
    return [(m, n, u) for m, (n, u) in rows.items()]


def session_runs(session_id, first_ts, last_ts):
    """Runs started from an orchestrator session: by recorded parent session, or (older runs) by time
    within the session."""
    def to_utc(local_iso):  # ledger times are local; transcript times are UTC
        try:
            return datetime.datetime.fromisoformat(local_iso).astimezone(datetime.timezone.utc).strftime(
                "%Y-%m-%dT%H:%M:%S")
        except ValueError:
            return ""
    out = []
    for r in ledger():
        if r.get("parent_session"):
            mine = r["parent_session"] == session_id
        else:
            ts = to_utc(r.get("ts", ""))
            mine = bool(first_ts and last_ts and ts and first_ts[:19] <= ts <= last_ts[:19])
        if mine:
            out.append(r)
    return out


def top_runs_lines(runs, n):
    """The biggest runs: where the tokens went."""
    out = []
    for r in sorted(runs, key=lambda r: -(r.get("units") or 0))[:n]:
        u, turns = r.get("usage") or {}, r.get("turns") or 0
        ctx = sum(u.get(k, 0) for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
        out.append(f"{r['id']}  {model_family(r['model']):<7}{r.get('units', 0):>11,} sonnet-eq  {turns:>3} turns  "
                   f"~{ctx // max(1, turns):>7,} ctx/turn  {r['status']:<12} "
                   + (f"[{r['role']}] " if r.get("role") else "") + str(r.get("task", ""))[:60].replace("\n", " "))
    return out


ASSUMED_BASELINE_CTX = 30000  # a normal Claude Code turn in a project: system prompt, tools, CLAUDE.md, skills, MCP


def baseline_ctx(slug):
    """(context tokens of one normal Claude Code turn in this project, measured?)."""
    b = load_json(home("baselines.json"), {}).get(slug) or {}
    return (b["ctx"], True) if b.get("ctx") else (ASSUMED_BASELINE_CTX, False)


def measure_baseline(slug, path):
    """One tiny Haiku turn in the project with the user's normal setup (CLAUDE.md, skills, MCP, plugins)."""
    claude = os.environ.get("LEAN_AGENT_CLAUDE") or "claude"
    try:
        out = subprocess.run([claude, "-p", "--output-format", "stream-json", "--verbose", "--model", "haiku",
                              "--max-turns", "1"], input="Reply with just OK. Do not use tools.", capture_output=True,
                             text=True, cwd=path, timeout=180).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    ctx = None
    for line in out.splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get("type") == "rate_limit_event":
            usage.record_plan_usage(ev.get("rate_limit_info"))
        elif ev.get("type") == "result":
            u = ev.get("usage") or {}
            ctx = sum(u.get(k, 0) for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
    if ctx:
        b = load_json(home("baselines.json"), {})
        b[slug] = {"ctx": ctx, "measured": now_iso()}
        save_json(home("baselines.json"), b)
    return ctx


def run_savings(r):
    """{"context": sonnet-eq saved by the lean worker context, "model": saved by the model choice} for a run."""
    u = r.get("usage") or {}
    turns = max(1, r.get("turns") or 1)
    ctx = sum(u.get(k, 0) for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
    base, _ = baseline_ctx(r.get("project"))
    extra = max(0, base - ctx / turns)
    rate = usage.model_rate(r.get("model"))
    context = extra * (1.25 + 0.1 * (turns - 1)) * rate  # first turn written to the cache, later turns re-read it
    weighted = r.get("weighted") or usage.weighted(u)
    return {"context": int(context), "model": int(weighted - weighted * rate)}


def cmd_savings(a):
    if a.measure:
        targets = [resolve_project(a.project)] if a.project else [(s_, v["path"]) for s_, v in projects().items()]
        for slug, path in targets:
            ctx = measure_baseline(slug, path)
            print(f"{slug}: a normal Claude Code turn carries ~{ctx:,} tokens of context" if ctx else
                  f"{slug}: couldn't measure (is `claude` signed in?)")
    since = (datetime.datetime.now() - datetime.timedelta(days=a.days)).isoformat()
    runs = [r for r in ledger() if r.get("ts", "") >= since and (not a.project or r["project"] == resolve_project(a.project)[0])]
    ctx_saved = model_saved = used = 0
    per_project = {}
    for r in runs:
        sv = run_savings(r)
        ctx_saved += sv["context"]
        model_saved += sv["model"]
        used += r.get("units", 0)
        per_project.setdefault(r["project"], [0, 0])
        per_project[r["project"]][0] += 1
        per_project[r["project"]][1] += sv["context"]
    sq_n = sq_saved = 0
    for e in read_jsonl(os.path.join(os.path.dirname(lean_log.log_dir()), "savings.jsonl")):
        if e.get("ts", "") >= since:
            sq_n += 1
            sq_saved += max(0, e.get("before", 0) - e.get("after", 0)) // 4
    total = ctx_saved + model_saved + sq_saved
    print(f"Estimated tokens saved, last {a.days} days (sonnet-eq; estimates, not measurements):")
    print(f"  worker context    {ctx_saved:>12,}  ({len(runs)} runs in a lean folder instead of the project)")
    for slug, (n, sv) in sorted(per_project.items(), key=lambda kv: -kv[1][1]):
        base, measured = baseline_ctx(slug)
        print(f"    {slug:<20} {n:>4} runs  vs ~{base:,} tokens/turn normal "
              + ("(measured)" if measured else "(assumed; measure: lean-agent savings --measure)"))
    print(f"  model choice      {model_saved:>12,}  (vs running every worker on Sonnet; Opus runs count negative)")
    print(f"  output squeezing  {sq_saved:>12,}  ({sq_n} long outputs shortened, counted once)")
    print(f"  total             {total:>12,}  · workers used {used:,}"
          + (f" · without lean-agent ~{used + total:,} ({(used + total) / used:.1f}x)" if used else ""))
    return 0


def cmd_attribution(a):
    if a.value:
        cfg = load_json(home("config.json"), {})
        cfg["attribution"] = a.value
        save_json(home("config.json"), cfg)
        h = home("home")
        settings = os.path.join(h, ".claude", "settings.json")
        if os.path.isdir(os.path.join(h, ".claude")):
            save_json(settings, orchestrator_settings(load_json(settings, {})))
    v = attribution()
    if v is None:
        print("attribution: not set yet. Ask the user once: should commits and PRs credit Claude as co-author? "
              "Then: lean-agent attribution on|off")
        return 2
    print(f"attribution: {v} · " + ("commits and PRs may credit Claude (Claude Code's default lines)" if v == "on" else
          "no Claude co-author lines or mentions in commits, PRs or comments; workers get Claude Code's attribution "
          "switched off, and worktree push refuses commits that credit Claude"))
    return 0


def cmd_config(a):
    if a.name == "strict":
        if a.value:
            cfg = load_json(home("config.json"), {})
            cfg["strict"] = a.value
            save_json(home("config.json"), cfg)
        print(f"strict: {'on' if strict_on() else 'off'} · the orchestrator "
              + ("may only run lean-agent commands and read lean-agent's own files; project work goes to workers"
                 if strict_on() else "may also run other commands and read project files"))
        return 0
    if a.name == "artifacts" and a.value:
        cfg = load_json(home("config.json"), {})
        cfg["artifacts"] = a.value
        save_json(home("config.json"), cfg)
        h = home("home")
        settings = os.path.join(h, ".claude", "settings.json")
        if os.path.isdir(os.path.join(h, ".claude")):
            save_json(settings, orchestrator_settings(load_json(settings, {})))
    print(f"artifacts: {'on' if artifacts_on() else 'off'} · the orchestrator "
          + ("may create and comment on artifacts (private until the user shares them)" if artifacts_on() else
             "can't use the Artifact tools"))
    return 0


def recipes_path(slug):
    return home("recipes", slug + ".json")


def cmd_recipe(a):
    slug, _ = resolve_project(a.project)
    store = load_json(recipes_path(slug), {})
    if a.action == "rm":
        if store.pop(a.name, None) is None:
            die(f"no recipe {a.name!r} in {slug}")
        save_json(recipes_path(slug), store)
        print(f"removed recipe {a.name}")
        return 0
    task = read_text(a.task_file) if a.task_file else (a.task or "")
    if not task.strip() or not a.model or not a.why:
        die("a recipe needs --task or --task-file, -m <model> and --why")
    r = {"model": a.model, "why": a.why, "read_only": a.read_only, "mcp": a.mcp or [], "cards": a.cards,
         "task": task.strip(), "evidence": a.evidence or [], "max_usd": a.max_usd, "max_turns": a.max_turns,
         "fields": a.fields, "complete": a.complete, "updated": now_iso()}
    if a.apply_task or a.apply_task_file:
        r["apply"] = {"task": (read_text(a.apply_task_file) if a.apply_task_file else a.apply_task).strip(),
                      "mcp": a.apply_mcp or a.mcp or [], "model": a.apply_model or a.model}
    store[a.name] = r
    save_json(recipes_path(slug), store)
    need = sorted(set(re.findall(r"\{(\w+)\}", r["task"] + (r.get("apply") or {}).get("task", ""))))
    print(f"saved recipe {a.name} for {slug}: lean-agent do {slug} {a.name}" + "".join(f" {k}=..." for k in need)
          + (" [--apply]" if r.get("apply") else ""))
    return 0


def cmd_recipes(a):
    slugs = [resolve_project(a.project)[0]] if a.project else sorted(projects())
    found = False
    for slug in slugs:
        for name, r in sorted(load_json(recipes_path(slug), {}).items()):
            found = True
            need = sorted(set(re.findall(r"\{(\w+)\}", r["task"])))
            flags = " --read-only" if r.get("read_only") else ""
            flags += "".join(f" --mcp {m}" for m in r.get("mcp") or [])
            print(f"{slug:<16} {name:<24} -m {r['model']}{flags}" + (" · has --apply" if r.get("apply") else "")
                  + (f" · needs {', '.join(need)}" if need else ""))
            print(f"{'':<17}{r['task'].splitlines()[0][:100]}")
    if not found:
        print("No recipes. Save one: lean-agent recipe add <project> <name> -m sonnet --why \"...\" --task-file <file>")
    return 0


def cmd_do(a):
    """Run a saved recipe: the stored model, flags, presets, cards and task, with {placeholders} filled."""
    slug, _ = resolve_project(a.project)
    r = load_json(recipes_path(slug), {}).get(a.name)
    if not r:
        die(f"no recipe {a.name!r} in {slug} (see: lean-agent recipes {slug})")
    values = {}
    for kv in a.values or []:
        k, _, v = kv.partition("=")
        values[k.strip()] = v
    step = r.get("apply") if a.apply else r
    if a.apply and not step:
        die(f"recipe {a.name} has no apply step")
    text = step["task"]
    missing = [k for k in sorted(set(re.findall(r"\{(\w+)\}", text))) if k not in values]
    if missing:
        die(f"recipe {a.name} needs " + ", ".join(f"{k}=..." for k in missing))
    for k, v in values.items():
        text = text.replace("{" + k + "}", v)
    if r.get("evidence"):
        text += "\n\nEvidence, strongest first:\n" + "\n".join(f"{i}. {e}" for i, e in enumerate(r["evidence"], 1))
    if r.get("fields"):
        text += (f"\n\nFetch only what you need: ask tools for (or keep) just these fields: {r['fields']}. When a result "
                 f"is saved to a file, read it with `{os.path.join(PLUGIN_ROOT, 'bin', 'lean-json')} <file> --fields "
                 f"{r['fields']}`; don't expand more than you need per item.")
    if r.get("complete"):
        text += ("\n\nEvery item must be in your answer exactly once: OK, a change (from -> to, with the evidence), or "
                 "unclear (with the reason). Don't skip items you didn't inspect: inspect them or mark them unclear. "
                 'End with one line: LEAN-ITEMS {"total": <items in scope>, "listed": <items in your answer>, '
                 '"missing": [<ids not listed>]}')
    check = None
    if a.apply:
        check = recipe_check_result(slug, a.name, a.from_run) if not a.fresh else None
        if check:
            text += (f"\n\nThe check (run {check[0]}) already produced this plan; use it, and re-read an item only to "
                     f"apply its change:\n{check[1][:6000]}")
            print(f"apply: using check run {check[0]} (--fresh to re-derive)", file=sys.stderr, flush=True)
        text += ("\n\nApply step: do only the changes listed in the check, one per item. "
                 + ("The user approved: " + a.allow_send if a.allow_send else
                    "Nothing is approved yet: list each change (item, from -> to, evidence) and stop with "
                    "awaiting-confirmation."))
    ns = argparse.Namespace(resume=None, task=[text], task_file=None, model=step.get("model") or r["model"],
                            todo=getattr(a, "todo", None),
                            why=f"recipe {a.name}: {r['why']}", cards=r.get("cards"), project=slug,
                            read_only=bool(r.get("read_only")) and not a.apply, chrome=None,
                            mcp=list(step.get("mcp") or r.get("mcp") or []), tools=None, allow_send=a.allow_send,
                            max_turns=r.get("max_turns") or 40, max_usd=r.get("max_usd") or 3.0, max_context=2000,
                            max_cards=4, ref=None, again=a.again, yes=a.yes,
                            recipe=(a.name, "apply" if a.apply else "check"), fields=r.get("fields"))
    rc = cmd_run(ns)
    if r.get("complete"):
        last = next((x for x in reversed(ledger()) if x.get("recipe") == a.name and x.get("project") == slug), None)
        _, items = parse_marker(run_result_text(last) if last else "", "LEAN-ITEMS")
        if not items:
            print("INCOMPLETE: the worker didn't report how many items it covered (no LEAN-ITEMS line)")
            return 1
        if items.get("missing") or (items.get("listed") or 0) < (items.get("total") or 0):
            print(f"INCOMPLETE: {items.get('listed')} of {items.get('total')} items listed; missing: "
                  f"{', '.join(map(str, items.get('missing') or [])) or '?'}. Resume it: lean-agent run --resume "
                  f"{last['id']} \"Cover the missing items too.\"")
            return 1
        print(f"complete: all {items.get('total')} items covered")
        reads = sum((last.get("mcp_calls") or {}).values())
        if items.get("total") and reads > 1.5 * items["total"]:
            print(f"note: {reads} tracker calls for {items['total']} items (more than one per item). One query that "
                  "returns the needed fields for all items (e.g. a query with a relations column, or a batch get) "
                  "is much cheaper: put that in the recipe's task.")
    return rc


def run_result_text(entry):
    """A finished run's full answer, from its result file."""
    try:
        with open(os.path.join(entry["workdir"], "result.json")) as fh:
            lines = [l for l in fh if l.strip()]
        return json.loads(lines[-1]).get("result") or ""
    except (OSError, ValueError, IndexError, KeyError):
        return ""


def recipe_check_result(slug, name, run_id=None, max_age_hours=2):
    """(run id, answer) of the recipe's latest check run (or the given one), if recent and done."""
    for r in reversed(ledger()):
        if r.get("project") != slug:
            continue
        if run_id and r["id"] != run_id:
            continue
        if not run_id and (r.get("recipe") != name or r.get("recipe_step") != "check" or r.get("status") != "done"):
            continue
        if not run_id and (datetime.datetime.now() - datetime.datetime.fromisoformat(r["ts"])).total_seconds() > max_age_hours * 3600:
            return None
        text, _ = parse_feedback(run_result_text(r))
        return (r["id"], text) if text else None
    return None


def cmd_text_len(a):
    text = sys.stdin.read() if a.file == "-" else read_text(a.file)
    print(f"{len(text):,} characters · {len(text.split()):,} words · {len(text.splitlines()):,} lines")
    if a.project:
        slug, _ = resolve_project(a.project)
        conf = (projects().get(slug) or {}).get("tracker") or {}
        facts = [f for f in tracker_facts_text(conf) if re.search(r"limit|length", f, re.I)]
        for n in facts or active_notes(conf):  # the discovered fact first, else hand-written notes
            m = re.search(r"(\d[\d,.]*)\s*(?:-|\s)?char", str(n), re.I)
            if m:
                limit = int(re.sub(r"[,.]", "", m.group(1)))
                state = "over" if len(text) > limit else "within"
                print(f"{state} the {limit:,}-character limit in the tracker notes ({str(n)[:80]})")
    return 0


def cmd_budget(a):
    if a.cap is not None or a.count:
        cur = load_json(home("session-cap.json"), {})
        if a.cap is not None:
            cur["cap"] = 0 if a.cap.lower() in ("off", "0", "none") else int(a.cap.replace(",", "").replace("_", ""))
        if a.count:
            cur["count"] = a.count
        cur["set"] = now_iso()
        save_json(home("session-cap.json"), cur)
        cap = cur.get("cap")
        print("session spend cap: " + ("off" if not cap else f"{cap:,} sonnet-eq") +
              f" (counting {'new tokens only' if cur.get('count') == 'new' else 'all billed tokens'}); "
              "applies to running sessions from their next tool call")
        if a.session is None:
            return 0
    print_plan_line()
    rc = usage.report(a.session, workers=session_workers)
    path = usage.find_transcript(a.session) if a.by_run else None
    if path:
        runs = session_runs(os.path.basename(path)[:-6], *usage.transcript_span(path))
        print(f"Biggest runs from this session ({len(runs)} in all):" if runs else "No runs from this session.")
        for line in top_runs_lines(runs, a.by_run):
            print("  " + line)
    sys.exit(rc)


# ---------------------------------------------------------------- commands: a week of work

PRIOS = {"high": 0, "normal": 1, "low": 2}


def todo_arg(v):
    """--todo N (or #N); `none` says the run isn't queue work (a quick lookup)."""
    return None if str(v).lower() in ("none", "-") else int(str(v).lstrip("#"))


def todos():
    return load_json(home("todo.json"), {"next": 1, "items": []})


def todo_line(t):
    bits = [f"#{t['id']}", {"doing": "[doing]", "done": "[done]"}.get(t["status"], "[open]")]
    if t.get("prio", "normal") != "normal":
        bits.append(t["prio"])
    bits.append(t["text"])
    extra = [x for x in (t.get("project"), t.get("ref"), f"due {t['due']}" if t.get("due") else "") if x]
    return " ".join(bits) + (f"  ({', '.join(extra)})" if extra else "")


def open_todos(data=None):
    items = [t for t in (data or todos())["items"] if t["status"] != "done"]
    return sorted(items, key=lambda t: (t["status"] != "doing", PRIOS.get(t.get("prio", "normal"), 1),
                                        t.get("due") or "9999", t["id"]))


def cmd_todo(a):
    data = todos()
    by_id = {t["id"]: t for t in data["items"]}

    def pick(n):
        try:
            t = by_id.get(int(str(n).lstrip("#")))
        except ValueError:
            t = None
        if not t:
            die(f"no todo #{n} (lean-agent todo list)")
        return t
    if a.action == "add":
        text = " ".join(a.args).strip()
        if not text:
            die('what? lean-agent todo add "Fix the export timeout" -p <project> --ref "PR 512"')
        project = resolve_project(a.project)[0] if a.project else None
        after = [int(x.strip().lstrip("#")) for x in (a.after or "").split(",") if x.strip()]
        missing = [x for x in after if x not in by_id]
        if missing:
            die(f"--after: no todo {', '.join('#' + str(x) for x in missing)}")
        t = {"id": data["next"], "text": text, "project": project, "ref": a.ref, "prio": a.prio or "normal",
             "due": a.due, "status": "open", "created": now_iso(), "notes": []}
        if a.epic:
            t["epic"], t["after"] = a.epic, after
            data.setdefault("epics", {}).setdefault(a.epic, {"project": project, "counts": []})
        elif after:
            t["after"] = after
        data["items"].append(t)
        data["next"] += 1
        save_json(home("todo.json"), data)
        print(f"added {todo_line(t)}")
        return 0
    if a.action in ("start", "done", "note", "rm", "reopen", "edit"):
        if not a.args:
            die(f"which one? lean-agent todo {a.action} <number>")
        t = pick(a.args[0])
        if a.action == "start":
            t["status"] = "doing"
        elif a.action == "reopen":
            t["status"] = "open"
        elif a.action == "done":
            t["status"], t["done_at"] = "done", now_iso()
            if len(a.args) > 1:
                t["notes"].append(" ".join(a.args[1:]))
                t["result"] = " ".join(a.args[1:])  # the board's Done card shows it
        elif a.action == "note":
            t["notes"].append(" ".join(a.args[1:]))
        elif a.action == "edit":
            if len(a.args) < 2:
                die('lean-agent todo edit N "<new text: a short title first>"')
            t["text"] = " ".join(a.args[1:])
            for k in ("ref", "prio", "due"):
                if getattr(a, k, None):
                    t[k] = getattr(a, k)
        else:
            data["items"].remove(t)
        save_json(home("todo.json"), data)
        print(f"{a.action}: {todo_line(t)}")
        return 0
    if a.action == "epic":
        if not a.args:
            epics = sorted({t.get("epic") for t in data["items"] if t.get("epic")})
            for e in epics:
                items, done, ready, blocked = epic_status(data, e)
                print(f"{e}: {len(done)}/{len(items)} done, {len(ready)} ready, {len(blocked)} waiting on others")
            if not epics:
                print('No epics. Add items with --epic NAME, or plan one: lean-agent slices <project> --create --epic NAME')
            return 0
        name = a.args[0]
        meta = data.setdefault("epics", {}).setdefault(name, {"project": None, "counts": []})
        if a.count:
            meta["counts"] = sorted(set(meta.get("counts") or []) | set(a.count))
            save_json(home("todo.json"), data)
        items, done, ready, blocked = epic_status(data, name)
        if not items:
            die(f"no items in epic {name!r}")
        print(f"{name}: {len(done)}/{len(items)} done, {len(ready)} ready, {len(blocked)} waiting on others"
              + (f"; counters: {', '.join(meta['counts'])}" if meta.get("counts") else ""))
        for t in sorted(ready, key=lambda t: (t["status"] != "doing", t["id"]))[:10]:
            print("  ready: " + todo_line(t))
        for t in blocked[:5]:
            print("  waits: " + todo_line(t) + f"  (after {', '.join('#' + str(x) for x in t.get('after') or [])})")
        return 0
    if a.action == "next":
        items = open_todos(data)
        if a.epic:
            ready = epic_status(data, a.epic)[2]
            items = [t for t in items if t in ready]
        if not items:
            print("Nothing open. Add work with: lean-agent todo add \"...\"")
            return 0
        t = items[0]
        print(todo_line(t))
        for n in t.get("notes") or []:
            print(f"  note: {n}")
        if t["status"] == "open":
            print(f"(start it: lean-agent todo start {t['id']}; done: lean-agent todo done {t['id']} \"<result>\")")
        return 0
    items = data["items"] if a.all else open_todos(data)
    if a.epic:
        items = [t for t in items if t.get("epic") == a.epic]
    if a.project:
        slug = resolve_project(a.project)[0]
        items = [t for t in items if t.get("project") == slug]
    if not items:
        print("No open todos." if not a.all else "No todos.")
    for t in items:
        print(todo_line(t))
    done_week = [t for t in data["items"] if t["status"] == "done" and (t.get("done_at") or "") >= (
        datetime.datetime.now() - datetime.timedelta(days=7)).isoformat()]
    if not a.all and done_week:
        print(f"({len(done_week)} done in the last 7 days: lean-agent todo list --all)")
    return 0


def _fe(fn, a):
    """Run a front-end tool (fe_tools) for a project; its errors become a short message."""
    import fe_tools
    slug, path = resolve_project(a.project)
    try:
        return fn(fe_tools)(slug, path, a)
    except fe_tools.Fail as e:
        die(str(e))


def cmd_map(a):
    def run(fe, slug, path, a):
        root = fe.work_dir(slug, path, a.dir)
        if a.exclude is not None or a.no_exclude:
            ex = [] if a.no_exclude else sorted(set(fe.excludes_for(slug)) | set(a.exclude or []))
            save_json(home("maps", slug, "excludes.json"), ex)
            print(f"excluded from map, count and slices: {', '.join(ex) or 'nothing'} (and whatever .gitignore "
                  "excludes)", file=sys.stderr)
        data = fe.load_map(slug, root, refresh=a.refresh, log=lambda m: print(m, file=sys.stderr))
        if a.json:
            print(json.dumps(data if not a.who_uses else fe.users_of(data), indent=1, default=sorted))
        else:
            print(fe.map_report(data, a))
        return 0
    return _fe(lambda fe: lambda slug, path, a: run(fe, slug, path, a), a)


def cmd_count(a):
    a.action = a.args.pop(0) if a.args and a.args[0] in ("add", "rm") else "show"
    return _fe(lambda fe: fe.cmd_count, a)


def cmd_check(a):
    a.action = a.args.pop(0) if a.args and a.args[0] in ("add", "rm", "baseline") else "run"
    return _fe(lambda fe: fe.cmd_check, a)


def cmd_parity(a):
    return _fe(lambda fe: fe.cmd_parity, a)


def cmd_codemod(a):
    return _fe(lambda fe: fe.cmd_codemod, a)


def cmd_slices(a):
    def run(fe, slug, path, a):
        root = fe.work_dir(slug, path, a.dir)
        data = fe.load_map(slug, root, log=lambda m: print(m, file=sys.stderr))
        plan = fe.plan_slices(data, a.by, a.depth, a.src)
        print(fe.slices_report(plan, a.max or 60))
        if not a.create:
            print(f"(create them as work-queue items: lean-agent slices {slug} --create --epic <name>)")
            return 0
        if not a.epic:
            die("--create needs --epic NAME (the slices become that epic's items)")
        data_t = todos()
        ids = {}
        for e in plan["enablers"]:
            t = {"id": data_t["next"], "text": f"{a.epic}: shared {e['name']} ({len(e['files'])} files, {e['lines']:,} "
                 f"lines; used by {len(e['used_by'])} slices)", "project": slug, "ref": None, "prio": "normal",
                 "due": None, "status": "open", "created": now_iso(), "notes": [], "epic": a.epic, "after": []}
            data_t["items"].append(t)
            ids[e["name"]] = t["id"]
            data_t["next"] += 1
        for sl in plan["slices"]:
            t = {"id": data_t["next"], "text": f"{a.epic}: {sl['name']} ({len(sl['files'])} own files, {sl['lines']:,} lines)",
                 "project": slug, "ref": None, "prio": "normal", "due": None, "status": "open", "created": now_iso(),
                 "notes": [], "epic": a.epic, "after": [ids[n] for n in sl["needs"] if n in ids]}
            data_t["items"].append(t)
            data_t["next"] += 1
        data_t.setdefault("epics", {}).setdefault(a.epic, {"project": slug, "counts": []})
        save_json(home("todo.json"), data_t)
        print(f"created {len(plan['enablers']) + len(plan['slices'])} items in epic {a.epic}; "
              f"the first ready one: lean-agent todo next --epic {a.epic}")
        return 0
    return _fe(lambda fe: lambda slug, path, a: run(fe, slug, path, a), a)


def epic_status(data, name):
    """(items, done, ready, blocked) of an epic: ready = open with everything it waits for done."""
    items = [t for t in data["items"] if t.get("epic") == name]
    status = {t["id"]: t["status"] for t in data["items"]}
    done = [t for t in items if t["status"] == "done"]
    open_ = [t for t in items if t["status"] != "done"]
    ready = [t for t in open_ if all(status.get(x) == "done" for x in t.get("after") or [])]
    blocked = [t for t in open_ if t not in ready]
    return items, done, ready, blocked


def doc_dirs():
    """Where `lean-agent doc write` may write: document folders, temp, lean-agent's docs, LEAN_AGENT_DOC_DIRS."""
    import tempfile
    dirs = [os.path.expanduser(d) for d in ("~/Downloads", "~/Documents", "~/Desktop")]
    dirs += [tempfile.gettempdir(), "/tmp", home("docs")]
    dirs += [os.path.expanduser(d) for d in (os.environ.get("LEAN_AGENT_DOC_DIRS") or "").split(os.pathsep) if d]
    return [os.path.realpath(d) for d in dirs]


def cmd_doc(a):
    """Write a document (stdin) to a document folder: the orchestrator has no Write tool, and this needs none."""
    target = os.path.realpath(os.path.expanduser(a.path))
    allowed = doc_dirs()
    if not any(target == d or target.startswith(d + os.sep) for d in allowed):
        die(f"doc write only writes under {', '.join(allowed)} (add folders with LEAN_AGENT_DOC_DIRS)")
    text = a.text if a.text is not None else sys.stdin.read()
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "a" if a.append else "w") as fh:
        fh.write(text if text.endswith("\n") or not text else text + "\n")
    print(f"{'appended' if a.append else 'wrote'} {text.count(chr(10)) + (0 if text.endswith(chr(10)) else 1)} lines "
          f"({len(text.encode())} bytes) to {target}")
    return 0


def cmd_thread(a):
    return lean_threads.cli(a.action, a.args, a.json)


def cmd_schedule(a):
    if a.when in ("-h", "--help") or any(x in ("-h", "--help") for x in a.args or []):
        build_parser()._subparsers._group_actions[0].choices["schedule"].print_help()
        return 0
    items = lean_schedule.jobs()
    if a.action == "run-due":
        lean_schedule.run_due()
        return 0
    if a.action == "defaults":
        wanted = [("daily 07:30", ["sync", "--check"]), ("fri 16:00", ["week"])]
        wanted += [("mon 07:45", ["optimize", slug]) for slug in sorted(projects())]
        have = {(j["when"], tuple(j["args"])) for j in items}
        for when, args in wanted:
            if (when, tuple(args)) in have:
                continue
            items.append({"id": max([j["id"] for j in items] + [0]) + 1, "when": when, "args": args,
                          "created": now_iso(), "enabled": True})
            print(f"scheduled #{items[-1]['id']}: {when}: lean-agent {' '.join(args)}")
        lean_schedule.save_jobs(items)
        print("Maintenance jobs: an update check every morning (it doesn't install anything), a weekly optimize "
              "report per project (no --apply), and a week report on Fridays. Pause one: lean-agent schedule pause <n>")
        return 0
    if a.action == "add":
        if not a.when or not a.args:
            die('lean-agent schedule add "weekdays 08:45" do <project> <recipe>')
        try:
            lean_schedule.parse_when(a.when)
        except ValueError as e:
            die(f"when: {e}")
        args = list(a.args[1:] if a.args[:1] == ["--"] else a.args)
        if args[0] in lean_schedule.NOT_SCHEDULABLE or args[0] not in build_parser()._subparsers._group_actions[0].choices:
            die(f"a schedule runs a lean-agent command (do, run, review, week, ...), not {args[0]!r}")
        if args[0] == "run" and "--why" not in args:
            args += ["--why", f"scheduled: {a.when}"]
        job = {"id": max([j["id"] for j in items] + [0]) + 1, "when": a.when, "args": args,
               "created": now_iso(), "enabled": True}
        items.append(job)
        lean_schedule.save_jobs(items)
        nxt = lean_schedule.next_run(job)
        print(f"scheduled #{job['id']}: {a.when}: lean-agent {' '.join(args)} (next {nxt:%a %H:%M})")
        print("Runs while `lean-agent up` is running (or from the orchestrator's next tool call); "
              "`lean-agent service install` keeps it running across restarts (optional).")
        return 0
    if a.action in ("rm", "run", "pause", "resume"):
        try:
            job = next(j for j in items if j["id"] == int(str(a.when or "").lstrip("#")))
        except (StopIteration, ValueError):
            die(f"no scheduled job {a.when!r} (lean-agent schedule list)")
        if a.action == "rm":
            items.remove(job)
        elif a.action in ("pause", "resume"):
            job["enabled"] = a.action == "resume"
        if a.action == "run":  # now, in the foreground; counts as its latest run
            job["last"] = now_iso()
            lean_schedule.save_jobs(items)
            return subprocess.run([sys.executable, os.path.abspath(__file__), *job["args"]], text=True).returncode
        lean_schedule.save_jobs(items)
        print(f"{a.action}: #{job['id']}")
        return 0
    if not items:
        print('No scheduled jobs. Add one: lean-agent schedule add "weekdays 08:45" do <project> <recipe>')
    for j in items:
        nxt = lean_schedule.next_run(j) if j.get("enabled", True) else None
        print(f"#{j['id']}  {j['when']:<16} lean-agent {' '.join(j['args'])}"
              + (f"  (next {nxt:%a %H:%M}" if nxt else "  (paused")
              + (f", last {j['last'][5:16].replace('T', ' ')})" if j.get("last") else ")"))
    recent = lean_schedule.results_since((datetime.datetime.now() - datetime.timedelta(days=2)).isoformat())
    for r in recent[-5:]:
        print(f"  ran #{r['id']} {r['ts'][5:16].replace('T', ' ')}: exit {r['rc']}: {r['first'][:90]}  ({r['output']})")
    runner = ("the `lean-agent up` timer" if lean_schedule.timer_alive() else
              "the orchestrator's next tool call (no `lean-agent up` timer seen in the last 15 minutes)")
    if items:
        print(f"Due jobs run from {runner}.")
    return 0


def pace_line():
    """('week: 48% of your plan used, 43% of the week gone: on pace', ahead?) from Claude's own numbers."""
    return usage.week_pace()


def cmd_week(a):
    days = a.days
    cutoff = (datetime.datetime.now() - datetime.timedelta(days=days)).isoformat()
    runs = [r for r in ledger() if r.get("ts", "") >= cutoff]
    if a.project:
        slug = resolve_project(a.project)[0]
        runs = [r for r in runs if r["project"] == slug]
    print(f"lean-agent, the last {days} days" + (f" ({a.project})" if a.project else ""))
    line, _ = pace_line()
    if line:
        print(line)
    if runs:
        ok = sum(r["status"] == "done" for r in runs)
        units = sum(r.get("units", 0) for r in runs)
        cost = sum(r.get("cost_usd") or 0 for r in runs)
        print(f"Runs: {len(runs)} ({ok} done) · {units:,} sonnet-eq · ${cost:.2f} API price")
        by = {}
        for r in runs:
            m = by.setdefault(model_family(r["model"]), [0, 0])
            m[0] += 1
            m[1] += r.get("units", 0)
        print("  by model: " + ", ".join(f"{m} {n} runs {u:,}" for m, (n, u) in sorted(by.items(), key=lambda kv: -kv[1][1])))
        byp = {}
        for r in runs:
            byp[r["project"]] = byp.get(r["project"], 0) + 1
        print("  by project: " + ", ".join(f"{p_} {n}" for p_, n in sorted(byp.items(), key=lambda kv: -kv[1])))
        saved = sum(run_savings(r)["context"] + run_savings(r)["model"] for r in runs)
        if saved > 0:
            print(f"  saved (estimate): ~{saved:,} sonnet-eq vs normal sessions on Sonnet")
        print("  biggest: " + "; ".join(f"{r['id']} {r.get('units', 0):,} {str(r.get('task', ''))[:40]!r}"
                                         for r in sorted(runs, key=lambda r: -r.get("units", 0))[:3]))
    else:
        print("Runs: none")
    reviews = []
    for f in glob.glob(home("reviews", "*.jsonl")):
        reviews += [r for r in read_jsonl(f) if r.get("ts", "") >= cutoff]
    if reviews:
        verdicts = {}
        for r in reviews:
            verdicts[r.get("verdict")] = verdicts.get(r.get("verdict"), 0) + 1
        print("Reviews: " + ", ".join(f"{v} {n}" for v, n in verdicts.items()))
    pushes = [p_ for p_ in read_jsonl(home("pushes.jsonl")) if p_.get("ts", "") >= cutoff and p_.get("ok")]
    if pushes:
        print("Pushed: " + ", ".join(f"{p_['branch']} -> {p_['to']}" for p_ in pushes[-8:]))
    data = todos()
    done = [t for t in data["items"] if t["status"] == "done" and (t.get("done_at") or "") >= cutoff]
    print(f"Todos: {len(done)} done, {len(open_todos(data))} open"
          + (": " + "; ".join(t["text"][:50] for t in done[-6:]) if done else ""))
    sched = lean_schedule.results_since(cutoff)
    if sched:
        print(f"Scheduled runs: {len(sched)} ({sum(r['rc'] != 0 for r in sched)} failed)")
    return 0


SERVICE_LABEL = "com.lean-agent.up"


def service_platform():
    return os.environ.get("LEAN_AGENT_SERVICE_PLATFORM") or ("mac" if sys.platform == "darwin" else
                                                            "linux" if sys.platform.startswith("linux") else "")


def service_file():
    if service_platform() == "mac":
        return os.path.expanduser(f"~/Library/LaunchAgents/{SERVICE_LABEL}.plist")
    return os.path.expanduser("~/.config/systemd/user/lean-agent.service")


def cmd_service(a):
    """Optional: keep `lean-agent up` running across logins, restarts and closed terminals."""
    plat = service_platform()
    if not plat:
        die("the background service is for macOS (launchd) and Linux (systemd --user)")
    path = service_file()
    bin_ = os.path.join(PLUGIN_ROOT, "bin", "lean-agent")
    log = home("logs", "service.log")
    tool = (os.environ.get("LEAN_AGENT_LAUNCHCTL") or "launchctl") if plat == "mac" else (
        os.environ.get("LEAN_AGENT_SYSTEMCTL") or "systemctl")
    uid = str(os.getuid()) if hasattr(os, "getuid") else "0"

    def ctl(*args, timeout=30):
        cmd = [tool, *args] if plat == "mac" else [tool, "--user", *args]
        try:
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            return 124, f"{' '.join(cmd)} didn't finish within {timeout}s"
        return p.returncode, (p.stdout + p.stderr).strip()

    def mac_running():
        rc, out = ctl("print", f"gui/{uid}/{SERVICE_LABEL}", timeout=15)
        return rc == 0 and bool(re.search(r"state = running", out)), rc == 0
    if a.action == "install":
        os.makedirs(os.path.dirname(path), exist_ok=True)
        os.makedirs(os.path.dirname(log), exist_ok=True)
        args = [bin_, "up", "--name", a.name] + (["--dashboard-only"] if getattr(a, "dashboard_only", False) else [])
        env = {"PATH": os.environ.get("PATH", ""), "HOME": os.path.expanduser("~"), "LEAN_AGENT_NO_PROMPT": "1"}
        if os.environ.get("LEAN_AGENT_HOME"):
            env["LEAN_AGENT_HOME"] = os.environ["LEAN_AGENT_HOME"]
        if plat == "mac":
            import plistlib
            with open(path, "wb") as fh:
                plistlib.dump({"Label": SERVICE_LABEL, "ProgramArguments": args, "RunAtLoad": True,
                               "KeepAlive": True, "ThrottleInterval": 60, "EnvironmentVariables": env,
                               "StandardOutPath": log, "StandardErrorPath": log,
                               "WorkingDirectory": home("home")}, fh)
            ctl("bootout", f"gui/{uid}/{SERVICE_LABEL}")
            rc, out = ctl("bootstrap", f"gui/{uid}", path)
        else:
            with open(path, "w") as fh:
                fh.write("[Unit]\nDescription=lean-agent orchestrator (lean-agent up)\n\n[Service]\n"
                         f"ExecStart={' '.join(shlex.quote(x) for x in args)}\nRestart=always\nRestartSec=60\n"
                         + "".join(f"Environment={k}={shlex.quote(v)}\n" for k, v in env.items())
                         + f"StandardOutput=append:{log}\nStandardError=append:{log}\n\n[Install]\n"
                         "WantedBy=default.target\n")
            ctl("daemon-reload")
            rc, out = ctl("enable", "--now", "lean-agent.service")
        print(f"installed {path}: `lean-agent up --name {a.name}` starts at login and restarts if it stops"
              + ("" if rc == 0 else f" (but {tool} said: {out[:200]})"))
        print(f"log: {log} · stop it: lean-agent service stop · remove it: lean-agent service uninstall")
        return 0 if rc == 0 else 1
    if not os.path.exists(path) and a.action != "uninstall":
        print("The background service isn't installed (it's optional). Install it: lean-agent service install")
        return 0
    if a.action == "uninstall":
        if plat == "mac":
            ctl("bootout", f"gui/{uid}/{SERVICE_LABEL}")
        else:
            ctl("disable", "--now", "lean-agent.service")
        if os.path.exists(path):
            os.remove(path)
            print(f"removed {path}")
        else:
            print("The background service isn't installed.")
        return 0
    if a.action == "logs":
        text = read_text(log) if os.path.exists(log) else ""
        sys.stdout.write("".join(text.splitlines(True)[-a.n:]) or "(no log yet)\n")
        return 0
    if a.action in ("restart", "stop"):
        running = [f for f in glob.glob(home("running", "*.json")) if dashboard_pid_alive(load_json(f, {}).get("pid"))]
        if running and not a.yes:
            die(f"{len(running)} worker(s) still running (lean-agent runs --running); they'd be stopped with it. "
                f"Wait for them, or: lean-agent service {a.action} --yes")
    if plat == "mac":
        target = f"gui/{uid}/{SERVICE_LABEL}"
        is_running, loaded = mac_running()
        if a.action == "status":
            print(f"service: {path}: " + ("running" if is_running else "loaded, not running" if loaded else "not loaded")
                  + f" (log: lean-agent service logs)")
            return 0 if is_running else 1
        if a.action == "start" and is_running:
            print("already running (lean-agent service restart restarts it with the current settings)")
            return 0
        if a.action == "stop":
            print("stopping (the orchestrator session shuts down; this can take up to a minute)...", flush=True)
            rc, out = ctl("bootout", target, timeout=90)
            print("stopped" if rc == 0 or not mac_running()[1] else f"stop: {out[:200]}")
            return 0
        if not loaded:
            rc, out = ctl("bootstrap", f"gui/{uid}", path)
            if rc != 0 and not mac_running()[1]:
                die(f"launchctl bootstrap failed: {out[:300]}")
            is_running = mac_running()[0]
        if a.action == "start":
            if not is_running:
                ctl("kickstart", target)
            print("started" if mac_running()[0] else "starting... (lean-agent service status / logs)")
            return 0
        print("restarting (the orchestrator session shuts down first; this can take up to a minute)...", flush=True)
        rc, out = ctl("kickstart", "-k", target, timeout=env_num("LEAN_AGENT_SERVICE_TIMEOUT", 90))
        if rc == 124:  # launchd is still waiting for the old one: unload and load it again
            ctl("bootout", target, timeout=60)
            ctl("bootstrap", f"gui/{uid}", path)
        time.sleep(1)
        print("restarted" if mac_running()[0] else "restarting... (lean-agent service status / logs)")
        return 0
    cmd = {"start": ["start", "lean-agent.service"], "restart": ["restart", "lean-agent.service"],
           "stop": ["stop", "lean-agent.service"], "status": ["status", "lean-agent.service"]}[a.action]
    rc, out = ctl(*cmd)
    if a.action == "status":
        state = re.search(r"state = (\w+)|Active: (\S+ \S+)", out)
        print(f"service: {path}: " + ((state.group(1) or state.group(2)) if state else ("running" if rc == 0 else "not running")))
    else:
        print(f"{a.action}: " + ("ok" if rc == 0 else out[:200]))
    return rc


def cmd_guard(a):
    projs = projects()
    if a.action in ("add", "rm"):
        if not a.project:
            die(f"lean-agent guard {a.action} <project> push-deny <pattern> ...")
        slug, _ = resolve_project(a.project)
        pats = list(a.patterns or [])
        if pats and pats[0] in ("push-deny", "require-pr"):  # the same thing: changed only through a pull request
            pats = pats[1:]
        if not pats:
            die("which branches? e.g. lean-agent guard add <project> push-deny \"release/*\" develop main")
        cur = push_guard.project_patterns(slug)
        if a.action == "add":
            cur += [p for p in pats if p not in cur]
        else:
            missing = [p for p in pats if p not in cur]
            if missing:
                die(f"{slug} has no push guard {', '.join(missing)} (lean-agent guard list {slug})")
            cur = [p for p in cur if p not in pats]
        projs[slug].setdefault("guards", {})["push-deny"] = cur
        save_json(home("projects.json"), projs)
    slugs = [resolve_project(a.project)[0]] if a.project else sorted(projs)
    for slug in slugs:
        pats = push_guard.project_patterns(slug)
        own = "push-deny" in ((projs.get(slug) or {}).get("guards") or {})
        print(f"{slug}: never pushes to " + (", ".join(pats) if pats else "(nothing guarded)")
              + ("" if own else " (defaults)") + (": they change only through pull requests" if pats else ""))
    if not slugs:
        print("no projects; new ones never push to " + ", ".join(push_guard.DEFAULT_PUSH_DENY))


def dashboard_running():
    import socket
    import dashboard
    with socket.socket() as sock:
        sock.settimeout(0.5)
        return sock.connect_ex(("127.0.0.1", dashboard.settings()["port"])) == 0


def cmd_dashboard(a):
    import dashboard
    cfg = dashboard.settings()
    if a.port or a.preview is not None:
        if a.port:
            cfg["port"] = a.port
        if a.preview is not None:
            cfg["preview"] = a.preview
        save_json(home("dashboard.json"), cfg)
        os.chmod(home("dashboard.json"), 0o600)
        path = home("home", ".claude", "launch.json")
        if cfg.get("preview"):
            path = dashboard.write_launch_config(cfg)
            print(f"preview: {path} has a \"lean-agent dashboard\" entry (http://localhost:{cfg['port']}); a Claude "
                  "desktop session in the orchestrator home can preview it. Its bare address works without the token "
                  "for the browser's own requests (other websites are still refused); restart the dashboard "
                  "(`lean-agent service restart` or `lean-agent up`) to apply. Undo: --preview off")
        elif a.preview is False:
            data = load_json(path, {})
            data["configurations"] = [c for c in data.get("configurations") or [] if c.get("name") != "lean-agent dashboard"]
            if os.path.exists(path):
                save_json(path, data)
            print("preview: off (the dashboard needs its token again after a restart)")
    if a.json:  # the dashboard's data, for an agent (the page itself is drawn by its script)
        print(json.dumps(dashboard.state(), indent=1))
        return 0
    if a.url or a.open:
        running = dashboard_running()
        link = dashboard.url()
        if not running:
            print(link + "  (not running: `lean-agent up` starts it, or `lean-agent dashboard`)")
        elif a.open:
            import webbrowser
            print(f"opened in your default browser: {link}" if webbrowser.open(link) else
                  f"couldn't open a browser from here; open this address yourself: {link}")
        else:
            print(link)
        return 0
    if a.port or a.preview is not None:
        return 0
    if dashboard_running():
        print(f"lean-agent dashboard is already running: {dashboard.url()}")
        return 0
    return dashboard.serve()


LOG_ERROR_RE = re.compile(r"\b(error|errors|fail(ed|ure|ures|s)?|exception|traceback|panic|fatal|assert(ion)?|"
                          r"not found|cannot|unable to|timed? ?out|denied|no such file|enoent)\b|##\[error\]|✗|✘|●", re.I)


def log_lines(text):
    """The lines of a saved log: plain text, or JSON that holds them (a list, or {"value": [...]} as CI APIs return)."""
    try:
        data = json.loads(text)
    except ValueError:
        return text.splitlines()
    if isinstance(data, dict):
        data = data.get("value") or data.get("lines") or data.get("log") or [json.dumps(data)]
    if isinstance(data, str):
        return data.splitlines()
    out = []
    for item in data if isinstance(data, list) else []:
        out += (item if isinstance(item, str) else json.dumps(item)).splitlines()
    return out


def cmd_grep_log(a):
    text = sys.stdin.read() if a.file == "-" else read_text(a.file)
    lines = [re.sub(r"\x1b\[[0-9;]*m", "", l) for l in log_lines(text)]
    rx = re.compile(a.pattern, re.I) if a.pattern else LOG_ERROR_RE
    hits = [i for i, l in enumerate(lines) if rx.search(l)]
    shown, last = 0, -1
    for i in hits:
        lo, hi = max(0, i - a.context), min(len(lines), i + a.context + 1)
        if lo > last + 1 and last >= 0:
            print("  ...")
        for j in range(max(lo, last + 1), hi):
            if shown >= a.max:
                break
            print(f"{j + 1:>6}{'>' if j == i else ' '} {lines[j][:300]}")
            shown += 1
        last = hi - 1
        if shown >= a.max:
            break
    print(f"({len(hits)} matching line(s) in {len(lines):,}" + (f"; showed the first {a.max} lines, narrow it with a "
          "PATTERN" if shown >= a.max else "") + ")")
    return 0 if hits else 1


def cmd_handoff(a):
    import compact_hook
    notes = compact_hook.load_notes()
    if a.note or a.done:
        if a.note:
            notes.append(dict({"ts": now_iso(), "text": " ".join(a.note.split())}, **({"kind": a.kind} if a.kind else {})))
        if a.done:
            drop = set(range(1, len(notes) + 1)) if a.done == "all" else {
                int(x) for x in a.done.split(",") if x.strip().isdigit()}
            notes = [n for i, n in enumerate(notes, 1) if i not in drop]
        save_json(compact_hook.notes_path(), notes)
    text = compact_hook.handoff(a.hours)
    with open(home("handoff.md"), "w") as fh:
        fh.write(text + "\n")
    if a.note or a.done:
        print((f"note {len(notes)} added" if a.note else f"closed {a.done}") + f"; {len(notes)} open")
        return
    print(text)
    print(f"(saved {home('handoff.md')}; a new or compacted orchestrator session starts with this note)")


def cmd_home(a):
    print(prepare_home())


# ---------------------------------------------------------------- CLI

def build_parser():
    ap = argparse.ArgumentParser(prog="lean-agent", description=__doc__.split("\n\n")[0])
    ap.add_argument("--version", action="version", version=f"lean-agent {plugin_version()}")
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("up", help="start the orchestrator (Remote Control by default)")
    s.add_argument("--model", default="sonnet",
                   help="orchestrator model, pinned in the home's settings (default: sonnet; 'default' = your own)")
    s.add_argument("--name", default="lean-agent", help="session name in the Claude app")
    s.add_argument("--budget", type=int, help="optional self-set cap per orchestrator session (sonnet-eq tokens)")
    s.add_argument("--compact-at", type=int, metavar="TOKENS", help="compact the orchestrator's context at about this "
                   "many tokens (default ~67,000)")
    s.add_argument("--budget-5h", type=int, help="lean-agent budget per 5-hour window (Sonnet-equivalent tokens)")
    s.add_argument("--budget-week", type=int, help="lean-agent budget per 7 days (Sonnet-equivalent tokens)")
    s.add_argument("--permission-mode", help="e.g. acceptEdits, auto")
    s.add_argument("--local", action="store_true", help="interactive terminal session instead of Remote Control")
    s.add_argument("--fresh", action="store_true",
                   help="don't resume the previous Remote Control session (done for you when it answers 404)")
    s.add_argument("--dashboard-only", action="store_true", help="no Remote Control: the dashboard (with its chat "
                   "with the orchestrator) and scheduled jobs only")
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
    s = sub.add_parser("recipe", help="save or remove a named recipe (a stored run: model, flags, presets, task)")
    s.add_argument("action", choices=["add", "rm"])
    s.add_argument("project")
    s.add_argument("name")
    s.add_argument("--model", "-m")
    s.add_argument("--why")
    s.add_argument("--task", help="task text; {name} placeholders are filled by `do ... name=value`")
    s.add_argument("--task-file")
    s.add_argument("--read-only", action="store_true")
    s.add_argument("--mcp", action="append", metavar="SERVER[:PRESET]")
    s.add_argument("--cards")
    s.add_argument("--evidence", action="append", metavar="TEXT", help="evidence hint, strongest first (repeatable)")
    s.add_argument("--apply-task", help="the step that makes the changes (outward actions need approval)")
    s.add_argument("--apply-task-file")
    s.add_argument("--apply-mcp", action="append", metavar="SERVER[:PRESET]", help="presets for the apply step (write tools)")
    s.add_argument("--apply-model")
    s.add_argument("--max-usd", type=float)
    s.add_argument("--max-turns", type=int)
    s.add_argument("--fields", help="the fields workers should fetch/keep (e.g. id,title,state,relations)")
    s.add_argument("--complete", action="store_true", help="every item must be listed (OK / change / unclear); "
                   "`do` fails the run otherwise")
    s.set_defaults(fn=cmd_recipe)

    s = sub.add_parser("recipes", help="list saved recipes")
    s.add_argument("project", nargs="?")
    s.set_defaults(fn=cmd_recipes)

    s = sub.add_parser("do", help="run a saved recipe: do <project> <recipe> [key=value ...] [--apply]")
    s.add_argument("project")
    s.add_argument("name")
    s.add_argument("values", nargs="*", metavar="KEY=VALUE")
    s.add_argument("--apply", action="store_true", help="run the recipe's apply step")
    s.add_argument("--allow-send", metavar="APPROVED", help="--apply: what the user approved (else it stops with the list)")
    s.add_argument("--from", dest="from_run", metavar="RUN_ID", help="--apply: use this check run's result")
    s.add_argument("--fresh", action="store_true", help="--apply: re-derive instead of using the last check")
    s.add_argument("--again", action="store_true")
    s.add_argument("--yes", action="store_true")
    s.add_argument("--todo", type=todo_arg, metavar="N", help="the work-queue item this is for "
                   "(shown on that card in the dashboard's board)")
    s.set_defaults(fn=cmd_do)

    s = sub.add_parser("text-len", help="characters/words/lines of a text, checked against limits in tracker notes")
    s.add_argument("file", help="a file, or - for stdin")
    s.add_argument("--project", "-p")
    s.set_defaults(fn=cmd_text_len)

    s = sub.add_parser("config", help="switches: artifacts on|off (may the orchestrator publish artifacts; default on), "
                       "strict on|off (the orchestrator only runs lean-agent commands; default on)")
    s.add_argument("name", choices=["artifacts", "strict"])
    s.add_argument("value", nargs="?", choices=["on", "off"])
    s.set_defaults(fn=cmd_config)

    s = sub.add_parser("attribution", help="should commits and PRs credit Claude? ask the user once, then set on|off")
    s.add_argument("value", nargs="?", choices=["on", "off"])
    s.set_defaults(fn=cmd_attribution)

    s = sub.add_parser("savings", help="estimated tokens saved: lean worker context, model choice, squeezed output")
    s.add_argument("--project", "-p")
    s.add_argument("--days", type=int, default=7)
    s.add_argument("--measure", action="store_true", help="measure a normal Claude Code turn per project (one tiny Haiku call each)")
    s.set_defaults(fn=cmd_savings)

    s = sub.add_parser("budget", help="token usage of the current orchestrator session; --cap sets the spend cap")
    s.add_argument("session", nargs="?")
    s.add_argument("--cap", metavar="N|off", help="self-set session spend cap in sonnet-eq tokens, for running "
                   "sessions too (no restart); off = none")
    s.add_argument("--count", choices=["billed", "new"], help="what the cap counts: all billed tokens, or new "
                   "tokens only (no cache re-reads)")
    s.add_argument("--by-run", type=int, nargs="?", const=10, metavar="N", help="also list this session's N biggest "
                   "worker runs")
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
    s.add_argument("action", choices=["show", "add", "rm", "core", "shorten", "unarchive", "protect"])
    s.add_argument("project")
    s.add_argument("id")
    s.add_argument("--save", action="store_true", help="shorten: save the proposal (only if nothing important is lost)")
    s.add_argument("--force", action="store_true", help="shorten: save even if something is lost")
    s.add_argument("-m", "--model", help="shorten: model (default haiku)")
    s.add_argument("--title")
    s.add_argument("--text")
    s.add_argument("--file")
    s.add_argument("--core", action="store_true", help="add: mark as core")
    s.add_argument("--off", action="store_true", help="core/protect: unmark")
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
    s.add_argument("--ref", metavar="REF", help="the branch/commit to look at when it isn't checked out (read with git show)")
    s.add_argument("--again", action="store_true", help="run even if the same task is running or just finished")
    s.add_argument("--yes", action="store_true", help="confirm an expensive run (large share of the plan window)")
    s.add_argument("--tools", help=f"explicit tool list (default {WORKER_TOOLS})")
    s.add_argument("--max-turns", type=int, default=env_num("LEAN_AGENT_MAX_TURNS", 40))
    s.add_argument("--max-usd", type=float, default=env_num("LEAN_AGENT_RUN_MAX_USD", 3.0, float))
    s.add_argument("--task-file")
    s.add_argument("--resume", metavar="RUN_ID", help="continue a previous run's session")
    s.add_argument("--effort", choices=["low", "medium", "high", "xhigh", "max"], help="model effort for the worker")
    s.add_argument("--worktree", metavar="REF", help="run in a shared lean-agent git worktree of this branch/ref "
                   "(your checkout is never touched; installed deps persist for the next worker)")
    s.add_argument("--reset-worktree", action="store_true", help="--worktree: move it to the ref's tip even if it "
                   "holds commits or changes that aren't there (they're discarded)")
    s.add_argument("--chrome", nargs="?", const="all", metavar="TOOL,TOOL",
                   help="give the worker the user's Chrome via Claude in Chrome (optionally only these tools)")
    s.add_argument("--allow-send", metavar="WHAT",
                   help="the user approved this outward action (send/post/submit...); describe exactly what")
    s.add_argument("--mcp", action="append", metavar="SERVER[:TOOL,TOOL]",
                   help="give the worker this MCP server, optionally only these tools (repeatable)")
    s.add_argument("--escalate", metavar="MODEL,MODEL", help="try the first model; if its run fails, run the task "
                   "again on the next (e.g. haiku,sonnet). Replaces --model")
    s.add_argument("--todo", type=todo_arg, metavar="N", help="the work-queue item this run "
                   "works on (it shows on that card in the dashboard's board; an open item becomes doing)")
    s.add_argument("--allow-cmd", action="append", metavar="PREFIX", help="--read-only: also allow this read-only "
                   "command prefix, e.g. \"az pipelines runs show\" (repeatable; commands that change things are refused)")
    s.add_argument("--max-reads", type=int, metavar="TOKENS", help="stop the worker once it has re-read this many "
                   "context tokens over all its calls (default LEAN_AGENT_RUN_MAX_READS, 6,000,000; 0 = no limit)")
    s.add_argument("--answer-lines", type=int, metavar="N", help="the worker answers in at most N lines and puts "
                   "the rest in a details file (0 = whole answer; default LEAN_AGENT_ANSWER_LINES, 25 in the orchestrator)")
    s.set_defaults(fn=cmd_run)

    s = sub.add_parser("chrome", help="Claude in Chrome for workers: check (once) | status")
    s.add_argument("action", choices=["check", "status"])
    s.set_defaults(fn=cmd_chrome)

    s = sub.add_parser("mcp", help="MCP servers workers can use: list, tools <server>, preset <server> ...")
    s.add_argument("action", choices=["list", "tools", "preset", "env", "ignore"])
    s.add_argument("server", nargs="?", help="a server; for env: the variable name")
    s.add_argument("preset_name", nargs="?", help="preset: name to set or remove")
    s.add_argument("preset_tools", nargs="?", help="preset: comma-separated tools")
    s.add_argument("--rm", action="store_true", help="preset/env/ignore: remove it")
    s.add_argument("--command", metavar="CMD", help="env: a command that prints the value (run per worker, not stored)")
    s.add_argument("--project", "-p", help="include this project's .mcp.json and local-scope servers")
    s.add_argument("--probe", action="store_true", help="list: query stdio servers for their tools")
    s.add_argument("--measure", action="store_true", help="tools: measure real per-turn cost with 2 Haiku calls")
    s.add_argument("--desc", metavar="TEXT", help="preset: what it's for (shown in the list)")
    s.add_argument("--grep", metavar="TEXT", help="preset: only presets whose name, description or tools contain TEXT")
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
    s.add_argument("--refresh", action="store_true", help="ask Claude for the plan's current usage now (one tiny Haiku call)")
    s.set_defaults(fn=cmd_limits)

    s = sub.add_parser("stats", help="runs, success rate and tokens by model")
    s.add_argument("--project", "-p")
    s.add_argument("--today", action="store_true")
    s.add_argument("--days", type=int)
    s.add_argument("--top", type=int, metavar="N", help="also list the N biggest runs (turns, context per turn, task)")
    s.set_defaults(fn=cmd_stats)
    s = sub.add_parser("optimize", help="tune a project's cards from worker feedback")
    s.add_argument("project")
    s.add_argument("--apply", nargs="?", const="all", metavar="IDS",
                   help="apply the card suggestions: all of them, or only these ids (see --json)")
    s.add_argument("--json", action="store_true", help="print what is left to decide as JSON (suggestions with ids, drafts)")
    s.add_argument("--min-runs", type=int, default=5, help="runs of a task type before a card can become core for it")
    s.add_argument("--notes", type=int, default=10)
    s.add_argument("--accept", metavar="IDS", help="write these drafts (cards with card add, presets with mcp preset)")
    s.add_argument("--reject", metavar="IDS", help="stop proposing these drafts or card suggestions")
    s.add_argument("--unreject", metavar="IDS", help="propose these rejected drafts or card suggestions again")
    s.add_argument("--ack", metavar="RUN_IDS", help="hide these runs' context gaps (already handled)")
    s.add_argument("--skip", metavar="CARD_IDS", help="leave these cards out of the suggestions and --apply")
    s.set_defaults(fn=cmd_optimize)

    s = sub.add_parser("review", help="pre-PR review by a read-only reviewer (sonnet, high effort)")
    s.add_argument("project")
    s.add_argument("--base", help="branch the change is based on (default: origin's default branch)")
    s.add_argument("--head", metavar="REF", help="review this branch/commit straight from git (no checkout needed); "
                   "with --status: check that ref")
    s.add_argument("--no-fetch", action="store_true", help="don't `git fetch origin` for origin/* refs")
    s.add_argument("--focus", help="what the reviewer should look at closely")
    s.add_argument("--goal", metavar="TEXT", help="what the change promises (task, work item or PR title): the "
                   "reviewer checks it's delivered end to end")
    s.add_argument("--resume", action="store_true", help="re-review after fixes: a fresh reviewer gets the open findings "
                   "and only what changed since (cheap); --same-session continues the old reviewer")
    s.add_argument("--same-session", action="store_true", help="--resume: continue the earlier reviewer session")
    s.add_argument("--full-review", action="store_true", help="review the whole change again, even when an earlier review of "
                   "the branch exists (by default only what changed since it is reviewed)")
    s.add_argument("--delta-only", action="store_true", help="review only what changed since the earlier review, "
                   "however large (default: a full review above LEAN_AGENT_DELTA_MAX_LINES, 800 lines)")
    s.add_argument("--for-push", action="store_true", help="the push gate: refuses while fix workers still run on the "
                   "branch, and says how to batch fixes before the next review")
    s.add_argument("--yes", action="store_true", help="--for-push: review even though workers still run")
    s.add_argument("--status", action="store_true", help="exit 0 only if the current code has an approve")
    s.add_argument("--runs", type=int, default=1, metavar="N", help="N independent passes merged into one review "
                   "(variance is real: 2 cheap passes often beat 1 expensive one)")
    s.add_argument("--independent", action="store_true", help="for comparison runs: no earlier findings, decisions, "
                   "second opinion or decline filtering")
    s.add_argument("--reviewer-model", metavar="MODEL", help="model for this review (default sonnet; e.g. opus or fable "
                   "for high-risk changes; the expected cost is printed first)")
    s.add_argument("--second-opinion", choices=["auto", "on", "off"], default="auto",
                   help="a cheap search-only reuse pass first (auto: for new abstractions or big diffs)")
    s.add_argument("--max-usd", type=float, default=env_num("LEAN_AGENT_REVIEW_MAX_USD", 6.0, float))
    s.add_argument("--max-turns", type=int, default=env_num("LEAN_AGENT_REVIEW_MAX_TURNS", 80))
    s.add_argument("--max-context", type=int, default=4000, help="token cap for the review's cards")
    s.add_argument("--todo", type=todo_arg, metavar="N", help="the work-queue item this is for "
                   "(shown on that card in the dashboard's board)")
    s.set_defaults(fn=cmd_review)

    s = sub.add_parser("tracker", help="the project's tracker: identity (org/project/repo, who you are) and notes "
                       "every MCP worker gets; --discover learns them once")
    s.add_argument("project")
    s.add_argument("values", nargs="*", metavar="KEY=VALUE", help=", ".join(TRACKER_KEYS))
    s.add_argument("--note", help="a fact workers should know, e.g. \"User Story has no Removed state\"")
    s.add_argument("--rm-note", type=int, action="append", metavar="N", help="remove note N (repeatable)")
    s.add_argument("--ack-email", action="store_true", help="stop warning that the tracker knows you by another email")
    s.add_argument("--supersede", type=int, action="append", metavar="N",
                   help="keep note N but stop giving it to workers (a discovered fact replaces it)")
    s.add_argument("--discover", action="store_true", help="find your identity id and the work item rules with a worker")
    s.add_argument("--mcp", action="append", metavar="SERVER[:TOOLS]", help="--discover: the tracker's MCP server")
    s.add_argument("-m", "--model", default="haiku", help="--discover: model (default haiku)")
    s.set_defaults(fn=cmd_tracker)

    s = sub.add_parser("review-decline", help="findings of the latest review that were discussed and declined "
                       "(also: review decline <project> <n>...)")
    s.add_argument("project")
    s.add_argument("numbers", nargs="*", metavar="N", help="finding numbers as the review printed them, or known "
                   "gaps (g1, g2: the user's word that it's out of scope)")
    s.add_argument("--all-gaps", action="store_true", help="acknowledge every known gap of the latest review")
    s.add_argument("--why", required=True, help="the decision, e.g. \"out of scope: separate ticket\"")
    s.add_argument("--head", metavar="REF", help="the branch whose latest review it is (default: the latest review)")
    s.add_argument("--all-branches", action="store_true", help="a project-wide decision, not just this branch")
    s.set_defaults(fn=cmd_review_decline)

    s = sub.add_parser("review-learn", help="lessons from human reviews -> review checklist + shared helpers cards "
                       "(also: review learn <project> ...)")
    s.add_argument("project")
    s.add_argument("pr_id", nargs="?", metavar="PR", help="same as --pr")
    s.add_argument("--text", help="one checklist line, e.g. \"Before adding overlay state, check the shared surface counter\"")
    s.add_argument("--file", help="checklist lines, one per line")
    s.add_argument("--helper", action="append", metavar="NAME | WHERE | WHAT", help="an existing helper to reuse (repeatable)")
    s.add_argument("--pr", help="read this pull request's review threads (needs --mcp) and learn what the review missed")
    s.add_argument("--mcp", action="append", metavar="SERVER[:TOOLS]", help="the tracker's MCP server, for --pr")
    s.add_argument("--head", metavar="REF", help="--pr: the branch the PR is for (to compare with its lean-agent review)")
    s.add_argument("--verify", action="store_true", help="list card lines whose helper can't be found (path or symbol) "
                   "on --head, HEAD, the default branch or a review base, with the reason")
    s.add_argument("--apply", action="store_true", help="with --verify: remove those lines")
    s.add_argument("-m", "--model", default="sonnet", help="--pr: model for reading the threads (default sonnet)")
    s.add_argument("--tracker", action="append", metavar="KEY=VALUE",
                   help="where the repo lives in the tracker when the git remote doesn't say (org=, project=, repo=); "
                        "saved for the project and given to every MCP worker")
    s.set_defaults(fn=cmd_review_learn)

    s = sub.add_parser("sync", help="pull lean-agent, update the plugin, refresh guide, settings, projects and repo blocks")
    s.add_argument("--no-pull", action="store_true", help="don't git pull; just refresh everything")
    s.add_argument("--no-learn", action="store_true", help="don't re-learn projects")
    s.add_argument("--check", action="store_true", help="only say whether an update is available (installs nothing)")
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
    s.add_argument("--allow-send", metavar="APPROVED", help="push: what the user approved (the push happens only with this). "
                   "A push needs an approving review of the commit (lean-agent review --head <branch>); a clean merge of "
                   "the base branch that touches none of the PR's files keeps the earlier approval")
    s.add_argument("--no-fetch", action="store_true", help="push: don't fetch origin first")
    s.add_argument("--only-commits", action="store_true", help="push: push the commits even when the shared "
                   "worktree has uncommitted changes (they aren't pushed)")
    s.add_argument("--override-guard", metavar="WHY", help="push: push to a guarded branch anyway (logged; only "
                   "when the user explicitly asked for exactly this)")
    s.set_defaults(fn=cmd_worktree)

    s = sub.add_parser("logs", help="lean-agent's local logs: error (default), debug, or verbose (saved outputs)")
    s.add_argument("level", nargs="?", default="error", choices=["error", "debug", "verbose"])
    s.add_argument("-n", type=int, default=20, help="last N entries")
    s.set_defaults(fn=cmd_logs)

    s = sub.add_parser("runs", help="recent worker runs (id, status, model, task)")
    s.add_argument("--project", "-p")
    s.add_argument("--last", action="store_true", help="print only the id of the latest run")
    s.add_argument("--running", action="store_true", help="runs in progress right now")
    s.add_argument("--dismiss", nargs="+", metavar="RUN_ID", help="the dashboard stops showing these runs' questions "
                   "(a failed or outdated run that needs nothing from you)")
    s.add_argument("--tokens", action="store_true", help="print the latest (or --show) run's run/tokens/context lines again")
    s.add_argument("--show", nargs="?", const="last", metavar="RUN_ID",
                   help="print a run's whole summary again (default: the latest run)")
    s.add_argument("--details", action="store_true", help="with --show: the run's details file instead")
    s.add_argument("--grep", metavar="TEXT", help="with --show/--details: only lines containing TEXT")
    s.add_argument("-n", type=int, default=10)
    s.set_defaults(fn=cmd_runs)

    s = sub.add_parser("context", help="what fills the orchestrator's context and what goes unused; --apply removes it")
    s.add_argument("--apply", action="store_true", help="deny the never-used tools and exclude extra instruction files")
    s.add_argument("--keep", action="append", metavar="TOOL", help="never take this tool out (repeatable)")
    s.add_argument("--undo", action="store_true", help="remove what --apply took out")
    s.add_argument("--sessions", type=int, default=8, help="how many recent orchestrator sessions to look at")
    s.add_argument("--top", type=int, default=8, help="how many of the biggest messages to list")
    s.add_argument("--no-probe", action="store_true", help="skip the start-up measurement (no Haiku call)")
    s.set_defaults(fn=cmd_context)

    s = sub.add_parser("todo", help="the work queue across sessions: add | list | next | start | done | note | rm")
    s.add_argument("action", nargs="?", default="list",
                   choices=["add", "list", "next", "start", "done", "note", "rm", "reopen", "edit", "epic"])
    s.add_argument("args", nargs="*", help="add: the text; start/done/note/rm: the number (done/note: then text)")
    s.add_argument("--project", "-p")
    s.add_argument("--ref", help="the tracker item, PR or branch it's about")
    s.add_argument("--prio", choices=list(PRIOS))
    s.add_argument("--due", metavar="YYYY-MM-DD")
    s.add_argument("--all", action="store_true", help="list: include done ones")
    s.add_argument("--epic", metavar="NAME", help="add: part of this epic; next/list: only this epic")
    s.add_argument("--after", metavar="N,N", help="add: ready only once these items are done")
    s.add_argument("--count", action="append", metavar="COUNTER", help="epic NAME: show this counter's progress "
                   "(lean-agent count) on the epic's board card")
    s.set_defaults(fn=cmd_todo)

    s = sub.add_parser("doc", help="write a document (from stdin) to Downloads, Documents, Desktop, temp or "
                       "~/.lean-agent/docs: doc write PATH [--append]")
    s.add_argument("action", choices=["write"])
    s.add_argument("path")
    s.add_argument("--append", action="store_true")
    s.add_argument("--text", help="the content (default: stdin)")
    s.set_defaults(fn=cmd_doc)

    s = sub.add_parser("map", help="the code's import graph (no model): who uses what, deps, routes, unused files")
    s.add_argument("project")
    s.add_argument("--who-uses", metavar="X", help="a file, folder, file name or exported name")
    s.add_argument("--deps", metavar="PATH", help="what a file or folder imports")
    s.add_argument("--route", nargs="?", const="all", metavar="/PATH", help="a route's entry and size (no value: all)")
    s.add_argument("--unused", action="store_true", help="files nothing imports")
    s.add_argument("--find", metavar="NAME", help="where a name is exported")
    s.add_argument("--dir", help="map this checkout (a worktree) instead of the project")
    s.add_argument("--refresh", action="store_true", help="rebuild now (it rebuilds by itself when files change)")
    s.add_argument("--exclude", action="append", metavar="GLOB", help="leave these paths out of map, count and slices "
                   "from now on, e.g. \"builds*/\" (kept; .gitignore is always honoured in a git checkout)")
    s.add_argument("--no-exclude", action="store_true", help="forget the saved --exclude list")
    s.add_argument("--max", type=int)
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=cmd_map)

    s = sub.add_parser("count", help="named regex counters with history: count <project> [add NAME REGEX | rm NAME | NAME...]")
    s.add_argument("project")
    s.add_argument("args", nargs="*")
    s.add_argument("--glob", help='add: only files matching, e.g. "*.ts,*.tsx"')
    s.add_argument("--path", help="add: only under this folder")
    s.add_argument("--files", action="store_true", help="list the files that still match")
    s.add_argument("--by-folder", action="store_true")
    s.add_argument("--dir", help="count in this checkout (a worktree); history is kept for the project only")
    s.add_argument("--max", type=int)
    s.set_defaults(fn=cmd_count)

    s = sub.add_parser("check", help="type-check/lint/test commands against a baseline, only new errors: "
                       "check <project> [add NAME CMD | rm NAME | baseline [NAME] | NAME...]")
    s.add_argument("project")
    s.add_argument("args", nargs="*")
    s.add_argument("--dir", help="run in this checkout (a worktree)")
    s.add_argument("--max", type=int, help="new errors shown per check (default 15)")
    s.add_argument("--warnings", action="store_true", help="count warnings too")
    s.add_argument("--update", action="store_true", help="lower the baseline when errors were fixed and none are new")
    s.add_argument("--timeout", type=int, help="seconds (default 1800)")
    s.set_defaults(fn=cmd_check)

    s = sub.add_parser("parity", help="per-route screenshots, text and console errors against a baseline (Playwright): "
                       "parity <project> set|baseline|check")
    s.add_argument("project")
    s.add_argument("action", nargs="?", default="check", choices=["set", "baseline", "check"])
    s.add_argument("--url", help="set: the running app, e.g. http://localhost:3000")
    s.add_argument("--routes", help='set: "/,/settings,/billing"')
    s.add_argument("--routes-from-map", action="store_true", help="set: every route the map found without parameters")
    s.add_argument("--start", help='set: command that starts the app when nothing answers, e.g. "npm run dev"')
    s.add_argument("--viewport", help="set: WIDTHxHEIGHT (default 1280x800)")
    s.add_argument("--storage", help="set: a Playwright storageState file (a signed-in session)")
    s.add_argument("--mask", help="set: CSS selectors hidden before the screenshot (clocks, avatars)")
    s.add_argument("--wait", type=int, help="set: ms to wait after the page settles (default 300)")
    s.add_argument("--threshold", type=float, help="set: %% of pixels that may differ (default 0.1)")
    s.add_argument("--full", action="store_true", help="set: full-page screenshots")
    s.add_argument("--route", help="baseline/check: only these routes (comma-separated)")
    s.add_argument("--dir", help="run the app from this checkout (a worktree)")
    s.set_defaults(fn=cmd_parity)

    s = sub.add_parser("codemod", help="run a codemod on a throwaway copy (default) or --apply, and summarise the change")
    s.add_argument("project")
    s.add_argument("command", nargs="?", help='e.g. "npx jscodeshift -t mods/rename.js src"')
    s.add_argument("--apply", action="store_true", help="run it on the checkout itself")
    s.add_argument("--dir", help="the checkout (a worktree)")
    s.add_argument("--timeout", type=int)
    s.set_defaults(fn=cmd_codemod)

    s = sub.add_parser("slices", help="a refactor plan from the map: shared parts first, then one slice per route/folder")
    s.add_argument("project")
    s.add_argument("--by", choices=["auto", "route", "folder"], default="auto")
    s.add_argument("--depth", type=int, default=2, help="folder depth of a slice / shared part (default 2)")
    s.add_argument("--src", help="only files under this folder")
    s.add_argument("--create", action="store_true", help="add them to the work queue")
    s.add_argument("--epic", help="--create: the epic they belong to")
    s.add_argument("--dir")
    s.add_argument("--max", type=int)
    s.set_defaults(fn=cmd_slices)

    s = sub.add_parser("schedule", help="recurring lean-agent jobs: list | add WHEN CMD... | rm N | run N | pause N | "
                       "resume N | defaults | run-due")
    s.add_argument("action", nargs="?", default="list",
                   choices=["list", "add", "rm", "run", "pause", "resume", "defaults", "run-due"])
    s.add_argument("when", nargs="?", help='add: "hourly", "every 2h", "daily 09:00", "weekdays 08:45", "mon,wed 10:00"; '
                   "rm/run/pause/resume: the job number")
    s.add_argument("args", nargs=argparse.REMAINDER, help="add: the lean-agent command, e.g. do <project> <recipe>")
    s.set_defaults(fn=cmd_schedule)

    s = sub.add_parser("thread", help="dashboard threads: new \"title\" | list | merge tB tA | unmerge tB | move MESSAGE THREAD")
    s.add_argument("action", choices=["new", "list", "merge", "unmerge", "move"])
    s.add_argument("args", nargs="*")
    s.add_argument("--json", action="store_true", help="list: as JSON")
    s.set_defaults(fn=cmd_thread)

    s = sub.add_parser("week", help="the last 7 days: pace, runs, reviews, pushes, todos, scheduled jobs")
    s.add_argument("--days", type=int, default=7)
    s.add_argument("--project", "-p")
    s.set_defaults(fn=cmd_week)

    s = sub.add_parser("service", help="optional: keep `lean-agent up` running across logins and restarts "
                       "(install | status | start | restart | stop | logs | uninstall)")
    s.add_argument("action", choices=["install", "status", "start", "restart", "stop", "logs", "uninstall"])
    s.add_argument("--yes", action="store_true", help="restart/stop even while workers are running")
    s.add_argument("--name", default="lean-agent", help="install: the session name in the Claude app")
    s.add_argument("--dashboard-only", action="store_true", help="install: run `up --dashboard-only` (no Remote "
                   "Control; you talk to lean-agent in the dashboard)")
    s.add_argument("-n", type=int, default=40, help="logs: last N lines")
    s.set_defaults(fn=cmd_service)

    s = sub.add_parser("guard", help="branches lean-agent never pushes to: list | add | rm (globs; default release/*, "
                       "develop, main, master)")
    s.add_argument("action", choices=["list", "add", "rm"])
    s.add_argument("project", nargs="?")
    s.add_argument("patterns", nargs="*", metavar="push-deny PATTERN")
    s.set_defaults(fn=cmd_guard)

    s = sub.add_parser("dashboard", help="the local dashboard (runs, queue, schedule, pace, context): serve it, or --url")
    s.add_argument("--url", action="store_true", help="print its address (with its token)")
    s.add_argument("--open", action="store_true", help="open it in your default browser")
    s.add_argument("--json", action="store_true", help="print its data as JSON (what the page shows), for agents")
    s.add_argument("--preview", type=lambda v: v.lower() not in ("off", "no", "0", "false"), nargs="?", const=True,
                   metavar="on|off", help="add it to the orchestrator home's .claude/launch.json (Claude desktop's "
                   "preview), and let its bare address work without the token for the browser's own requests")
    s.add_argument("--port", type=int, help="use this port from now on (default 8765)")
    s.set_defaults(fn=cmd_dashboard)

    s = sub.add_parser("grep-log", help="the lines that matter in a saved CI or build log (text, or JSON like "
                       "{\"value\": [lines]}): errors and failures, or a PATTERN")
    s.add_argument("file", help="the log file, or - for stdin")
    s.add_argument("pattern", nargs="?", help="a regular expression (default: errors and failures)")
    s.add_argument("-C", "--context", type=int, default=2, help="lines around each match (default 2)")
    s.add_argument("--max", type=int, default=80, help="lines to print at most (default 80)")
    s.set_defaults(fn=cmd_grep_log)

    s = sub.add_parser("handoff", help="the hand-off note a new or compacted orchestrator session starts from")
    s.add_argument("--note", metavar="TEXT", help="add an open item or pending decision")
    s.add_argument("--kind", choices=["decision", "reminder", "fyi"], help="--note: decision = the user must "
                   "decide or answer (shown under Waiting on you); reminder (default) or fyi go to the board's Notes")
    s.add_argument("--done", metavar="N,N|all", help="close open items by number")
    s.add_argument("--hours", type=int, default=12, help="runs from the last N hours (default 12)")
    s.set_defaults(fn=cmd_handoff)

    s = sub.add_parser("output", help="the full output of a command that brief mode shortened")
    s.add_argument("command", help="e.g. optimize, tracker, stats, cards")
    s.add_argument("--grep", metavar="TEXT", help="only lines containing TEXT")
    s.set_defaults(fn=cmd_output)

    s = sub.add_parser("guide", help="print the orchestrator guide (rules, examples); --cli: every command and flag")
    s.add_argument("project", nargs="?")
    s.add_argument("--cli", action="store_true", help="the CLI reference instead")
    s.set_defaults(fn=cmd_guide)

    s = sub.add_parser("rules", help="write/refresh (or --off: remove) the lean-agent block in a repo")
    s.add_argument("project")
    s.add_argument("--off", action="store_true")
    s.set_defaults(fn=cmd_rules)

    s = sub.add_parser("doctor", help="check setup and which instructions load in a folder (default: here)")
    s.add_argument("path", nargs="?")
    s.add_argument("--fix", action="store_true", help="refresh guide and repo block, add precedence notes")
    s.add_argument("--ignore", action="append", metavar="SERVER", help="mark an MCP server as not used, so doctor "
                   "stops checking it (same as `lean-agent mcp ignore SERVER`; repeatable)")
    s.set_defaults(fn=cmd_doctor)
    return ap


def main(argv=None):
    # the CLI is never the service session; its claude spawns must not inherit the marker
    os.environ.pop("LEAN_AGENT_SERVICE_SESSION", None)
    ap = build_parser()
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:2] in (["review", "learn"], ["review", "decline"]):
        argv = ["review-" + argv[1]] + argv[2:]
    if (len(argv) > 2 and argv[0] == "run" and not argv[1].startswith("-")
            and not {"-p", "--project", "--resume"} & set(argv) and is_project_ref(argv[1])):
        argv = ["run", "-p", argv[1]] + argv[2:]  # `lean-agent run <project> ...` like `cards <project>`
    global BRIEF
    flags = {"--brief", "--full"} & set(argv[1:]) if argv[:1] != ["up"] else set()
    argv = [x for i, x in enumerate(argv) if not (i and x in flags)]
    BRIEF = "--brief" in flags or (os.environ.get("LEAN_AGENT_BRIEF") == "1" and "--full" not in flags)
    a, leftover = ap.parse_known_args(argv)
    if leftover and a.cmd in ("mcp", "guard") and not any(x.startswith("-") for x in leftover):
        # Python 3.9's argparse leaves positionals that follow an option (`mcp ignore --rm <server>`) unparsed
        names = ["server", "preset_name", "preset_tools"] if a.cmd == "mcp" else ["project"]
        for n in names:
            if leftover and getattr(a, n, None) is None:
                setattr(a, n, leftover.pop(0))
        if a.cmd == "guard" and leftover:
            a.patterns = list(a.patterns or []) + leftover
            leftover = []
    if leftover:
        if a.cmd != "run" or any(x.startswith("-") for x in leftover):
            ap.error("unrecognized arguments: " + " ".join(leftover))
        a.task += leftover  # task words given after options
    if a.cmd == "run" and not a.resume and not a.project:
        ap.error("run needs --project (or --resume)")
    capture = BRIEF and a.cmd in BRIEF_COMMANDS and not getattr(a, "show", None)
    if capture:
        real, sys.stdout = sys.stdout, io.StringIO()
    try:
        return a.fn(a) or 0
    finally:
        if isinstance(sys.stdout, Tee):
            sys.stdout.close()
        if capture:
            text, sys.stdout = sys.stdout.getvalue(), real
            sys.stdout.write(brief_text(a.cmd, text))


BRIEF = False  # set in main(): --brief, or LEAN_AGENT_BRIEF=1 (orchestrator sessions) unless --full
BRIEF_COMMANDS = ("optimize", "tracker", "stats", "budget", "cards", "limits", "projects", "recipes", "savings")
BRIEF_LINES = 20


def detail(text=""):
    """A line that only full mode prints; brief mode keeps it in the run's saved summary (`runs --show`)."""
    if not BRIEF:
        print(text)
    elif isinstance(sys.stdout, Tee):
        sys.stdout.fh.write(str(text) + "\n")


def say(full, short):
    """Print `full`, or in brief mode `short` (the saved summary still gets `full`)."""
    if BRIEF and isinstance(sys.stdout, Tee):
        sys.stdout.fh.write(full + "\n")
        sys.stdout.stream.write(short + "\n")
    else:
        print(short if BRIEF else full)


def brief_text(cmd, text):
    """One line per item: item lines (indented 0-1 characters; a table's marker column counts as 0) up to
    BRIEF_LINES, without their indented detail lines; the full text is saved for `lean-agent output`."""
    lines = text.rstrip("\n").splitlines()
    if len(lines) <= BRIEF_LINES:
        return text
    path = home("output", f"{cmd}.txt")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        fh.write(text)
    heads = [l for l in lines if l.strip() and len(l) - len(l.lstrip()) <= 1]
    keep = heads[:BRIEF_LINES]
    return "\n".join(keep) + (f"\n[brief: {len(keep)} of {len(lines)} lines. More: `lean-agent output {cmd} "
                               f"--grep TEXT` (or all of it: `lean-agent output {cmd}`; --full prints it in full)]\n")


def cmd_output(a):
    path = home("output", f"{a.command}.txt")
    if not os.path.exists(path):
        if not BRIEF:
            die(f"no saved output for {a.command!r}: brief mode is off in this session (LEAN_AGENT_BRIEF isn't set; "
                "a `lean-agent up` from v0.14 sets it), so commands print everything and nothing is saved")
        die(f"no saved output for {a.command!r} (brief mode saves it when a command prints more than {BRIEF_LINES} lines)")
    text = read_text(path)
    if a.grep:
        rx = re.compile(re.escape(a.grep), re.I)
        text = "".join(l for l in text.splitlines(True) if rx.search(l)) or f"(no line matches {a.grep!r})\n"
    sys.stdout.write(text)


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
