#!/usr/bin/env python3
"""lean-agent: run Claude Code worker agents on as few tokens as possible.

An orchestrator session (started with `lean-agent up`) lives in its own folder,
so it never loads your projects' CLAUDE.md, skills or plugins. It delegates
work with `lean-agent run`, which starts an isolated headless worker that gets
only the context cards and tools the orchestrator picked. Workers report back
which context they used, and the context library improves from that.
"""
import argparse
import datetime
import glob
import hashlib
import json
import os
import re
import subprocess
import sys
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import usage  # noqa: E402

PLUGIN_ROOT = os.path.dirname(HERE)
REPO = "mcmadsen/lean-agent"
PLUGIN = "lean-agent@lean-agent"
TEMPLATE_MARK = "<!-- lean-agent orchestrator template v"
TEMPLATE_VERSION = 1

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
LEAN-FEEDBACK {{"status": "done|partial|failed", "used": ["card-id"], "unneeded": ["card-id"], "missing": "context you had to discover that should have been given up front, or empty"}}
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
    tmp = path + ".tmp"
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
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:limit].strip("-") or "card"


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
    """CLAUDE.md files (incl. dir/.claude/CLAUDE.md) and .claude/rules, skipping worktrees and submodules."""
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        rel = os.path.relpath(dirpath, root)
        depth = 0 if rel == "." else rel.count(os.sep) + 1
        if "CLAUDE.md" in filenames:
            found.append(("claude-md", os.path.join(dirpath, "CLAUDE.md")))
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


def scope_of(rel_dir):
    """(title scope, id scope) for where a CLAUDE.md lives, ignoring '.claude' path parts.

    The id uses the folder name, plus its parent when the name is generic (App, src, ...)."""
    parts = [p for p in rel_dir.split(os.sep) if p and p not in (".", ".claude")]
    if not parts:
        return "", ""
    last = parts[-1]
    id_parts = parts[-2:] if slugify(last) in GENERIC_DIRS and len(parts) > 1 else [last]
    return "/".join(parts[-2:]), slugify("-".join(id_parts), 28)


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

    for kind, f in find_memory_files(path):
        rel = os.path.relpath(f, path)
        if kind == "rule":
            scope = "rule " + os.path.splitext(os.path.basename(f))[0]
            ss = slugify(scope, 28)
        else:
            scope, ss = scope_of(os.path.dirname(rel))
        for head, body in split_sections(read_text(f)):
            title = f"{scope}: {head}" if scope else head
            hs = slugify(head, 28)
            base = hs if not ss or hs.startswith(ss) else f"{ss}-{hs}"
            add(kind, title, rel, body, base=base)

    skill_dirs = [os.path.join(path, ".claude", "skills")]
    if include_user_skills:
        skill_dirs.append(os.path.expanduser("~/.claude/skills"))
    for sd in skill_dirs:
        for f in sorted(glob.glob(os.path.join(sd, "*", "SKILL.md"))):
            name, desc, body = parse_skill(f)
            add("skill", f"skill {name}" + (f" - {desc}" if desc else ""), f, body, base="skill-" + slugify(name, 32))

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
    cards += [c for c in old.values() if c["kind"] == "note"]  # learned notes survive re-learning
    save_cards(slug, cards)

    projs = projects()
    for other in [s for s, v in projs.items() if v["path"] == path and s != slug]:
        del projs[other]  # renamed with --name
    projs[slug] = {"path": path, "learned": now_iso()}
    save_json(home("projects.json"), projs)

    if not quiet:
        total = sum(c["tokens"] for c in cards)
        print(f"Learned {path} as '{slug}': {len(cards)} cards, ~{total:,} tokens if loaded in full.")
        print(f"Workers get only the cards you pick. List them: lean-agent cards {slug}")
    return slug


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


def spent_today():
    today = datetime.date.today().isoformat()
    return sum(r.get("weighted", 0) for r in ledger() if r.get("ts", "").startswith(today))


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

    daily = env_num("LEAN_AGENT_DAILY_BUDGET", 0)
    if daily and spent_today() >= daily:
        die(f"daily budget used up ({spent_today():,} / {daily:,} weighted tokens); raise LEAN_AGENT_DAILY_BUDGET to continue", 3)

    if prev:
        slug, project = prev["project"], prev["project_path"]
        cards, workdir, run_id = [], prev["workdir"], prev["id"]
        tools = prev.get("tools", WORKER_TOOLS)
    else:
        slug, project = resolve_project(a.project)
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

    claude = os.environ.get("LEAN_AGENT_CLAUDE") or "claude"
    cmd = [claude, "-p", "--output-format", "json", "--model", model,
           "--safe-mode", "--disable-slash-commands",
           "--tools", tools, "--allowedTools", tools,
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

    started = datetime.datetime.now()
    try:
        proc = subprocess.run(cmd, input=task, capture_output=True, text=True, cwd=workdir, env=env,
                              timeout=env_num("LEAN_AGENT_RUN_TIMEOUT", 1800))
        raw, err = proc.stdout, proc.stderr
    except subprocess.TimeoutExpired as exc:
        raw, err = exc.stdout or "", "timed out"
        raw = raw.decode() if isinstance(raw, bytes) else raw
    except FileNotFoundError:
        die(f"'{claude}' not found on PATH")
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
    lib = load_cards(slug)
    used, unneeded = set(fb.get("used") or []), set(fb.get("unneeded") or [])
    sent = {c["id"] for c in cards}
    for c in lib:
        if c["id"] in sent:
            c["offered"] += 1
        if c["id"] in used:
            c["used"] += 1
        if c["id"] in unneeded:
            c["unneeded"] += 1
    if sent or used or unneeded:
        save_cards(slug, lib)
    missing_note = (fb.get("missing") or "").strip()
    if missing_note:
        append_jsonl(home("library", slug, "missing.jsonl"),
                     {"ts": now_iso(), "run": run_id, "task": task[:160], "missing": missing_note})

    entry = {
        "id": run_id, "ts": now_iso(), "project": slug, "project_path": project, "workdir": workdir,
        "model": model, "why": a.why or (prev and "resume"), "cards": sorted(sent), "tools": tools,
        "status": status, "turns": out.get("num_turns"), "seconds": seconds,
        "usage": {k: u.get(k, 0) for k in usage.FIELDS}, "weighted": weighted,
        "cost_usd": out.get("total_cost_usd"), "session_id": out.get("session_id") or (prev and prev["session_id"]),
        "resumed": bool(prev), "task": task[:300], "missing": missing_note,
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
    print(f"resume: lean-agent run --resume {run_id} \"<follow-up>\"")
    return 0 if status in ("done", "partial") else 1


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
            m = by.setdefault(r["model"], {"n": 0, "ok": 0, "w": 0, "usd": 0.0})
            m["n"] += 1
            m["ok"] += r["status"] == "done"
            m["w"] += r.get("weighted", 0)
            m["usd"] += r.get("cost_usd") or 0
        print(f"{'model':<14}{'runs':>6}{'done':>7}{'avg weighted':>15}{'total weighted':>17}{'cost':>10}")
        for model, m in sorted(by.items(), key=lambda kv: -kv[1]["w"]):
            print(f"{model:<14}{m['n']:>6}{m['ok'] * 100 // m['n']:>6}%{m['w'] // m['n']:>15,}{m['w']:>17,}{'$%.2f' % m['usd']:>10}")
    daily = env_num("LEAN_AGENT_DAILY_BUDGET", 0)
    today = spent_today()
    print(f"\nToday: {today:,} weighted tokens" + (f" of {daily:,} daily budget ({today * 100 // daily}%)" if daily else " (no daily budget set)"))


def cmd_optimize(a):
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
    notes = list(read_jsonl(home("library", slug, "missing.jsonl")))[-a.notes:]
    if notes:
        print("\nRecent context gaps reported by workers (turn recurring ones into cards with `lean-agent card add`):")
        for n in notes:
            print(f"- [{n['run']}] {n['missing'][:200]}")


# ---------------------------------------------------------------- commands: setup

ORCHESTRATOR_ENV = {
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


def cmd_up(a):
    h = prepare_home()
    env = dict(os.environ)
    for k, v in ORCHESTRATOR_ENV.items():
        env.setdefault(k, v)
    if a.budget:
        env["LEAN_AGENT_BUDGET"] = str(a.budget)
    if a.daily_budget:
        env["LEAN_AGENT_DAILY_BUDGET"] = str(a.daily_budget)
    bindir = os.path.join(PLUGIN_ROOT, "bin")
    env["PATH"] = bindir + os.pathsep + env.get("PATH", "")  # `lean-agent` works even without the plugin
    cmd = ["claude"]
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
    s.add_argument("--model", default="sonnet", help="orchestrator model (default: sonnet)")
    s.add_argument("--name", default="lean-agent", help="session name in the Claude app")
    s.add_argument("--budget", type=int, help="orchestrator session budget, weighted tokens")
    s.add_argument("--daily-budget", type=int, help="daily budget for all worker runs, weighted tokens")
    s.add_argument("--permission-mode", help="e.g. acceptEdits, auto")
    s.add_argument("--local", action="store_true", help="interactive terminal session instead of Remote Control")
    s.set_defaults(fn=cmd_up)

    s = sub.add_parser("install", help="install the plugin and create the orchestrator home")
    s.set_defaults(fn=cmd_install)
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
    s.set_defaults(fn=cmd_run)

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
