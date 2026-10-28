"""Shared memory for lean-agent, stored in Claude Code's auto-memory file format.

The store is a folder of topic files with YAML-ish frontmatter (name, description,
type, scope, modified) plus a MEMORY.md index, the same layout Claude Code's auto
memory uses, so it stays readable and editable by hand. Unlike auto memory, no
session loads the whole index: the orchestrator sends workers only the memories
that are relevant, as context cards.

    type:  user | feedback | project | reference   (as in Claude Code auto memory)
    scope: global | <project name>                 (global memories reach every project)
"""
import datetime
import glob
import hashlib
import json
import os
import re

import lean_rules

TYPES = ("user", "feedback", "project", "reference")
GLOBAL = "global"


def _expand(path):
    return os.path.abspath(os.path.expanduser(path))


def config_dir():
    return os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")


def _load(path):
    try:
        with open(path) as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def store_dir(lean_home):
    d = _expand(os.environ.get("LEAN_AGENT_MEMORY_DIR") or os.path.join(lean_home, "memory"))
    os.makedirs(d, exist_ok=True)
    return d


def git_root(path):
    p = _expand(path)
    while True:
        if os.path.exists(os.path.join(p, ".git")):
            return p
        parent = os.path.dirname(p)
        if parent == p:
            return _expand(path)
        p = parent


def claude_memory_dirs(project=None):
    """Claude Code auto-memory folders to import from.

    autoMemoryDirectory from settings (local > project > user), the per-project default
    folder for `project`, and with no project every ~/.claude/projects/*/memory.
    """
    dirs = []
    sources = []
    if project:
        sources += [os.path.join(project, ".claude", "settings.local.json"),
                    os.path.join(project, ".claude", "settings.json")]
    sources.append(os.path.join(config_dir(), "settings.json"))
    for s in sources:
        v = _load(s).get("autoMemoryDirectory")
        if isinstance(v, str) and v.strip():
            dirs.append(_expand(v))
            break
    if project:
        name = re.sub(r"[^A-Za-z0-9]", "-", git_root(project))
        dirs.append(os.path.join(config_dir(), "projects", name, "memory"))
    else:
        dirs += sorted(glob.glob(os.path.join(config_dir(), "projects", "*", "memory")))
    return [d for d in dict.fromkeys(dirs) if os.path.isdir(d)]


def parse(text):
    """Split a memory file into (frontmatter dict, body)."""
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", text, re.S)
    if not m:
        return {}, text.strip()
    meta = {}
    for line in m.group(1).splitlines():
        k, sep, v = line.partition(":")
        if sep and k.strip():
            meta[k.strip()] = v.strip().strip("\"'")
    return meta, m.group(2).strip()


def index_titles(d):
    """{file name: description} from MEMORY.md lines like `- [Title](file.md) - hook`."""
    out = {}
    try:
        with open(os.path.join(d, "MEMORY.md"), encoding="utf-8", errors="replace") as fh:
            for line in fh:
                m = re.search(r"\[([^\]]+)\]\(([^)]+\.md)\)\s*[-:—–]*\s*(.*)", line)
                if m:
                    out[os.path.basename(m.group(2))] = (m.group(3).strip() or m.group(1).strip())
    except OSError:
        pass
    return out


def read_all(d):
    titles = index_titles(d)
    out = []
    for f in sorted(glob.glob(os.path.join(d, "*.md"))):
        if os.path.basename(f) == "MEMORY.md":
            continue
        with open(f, encoding="utf-8", errors="replace") as fh:
            meta, body = parse(fh.read())
        if not body:
            continue
        stem = os.path.splitext(os.path.basename(f))[0]
        out.append({
            "file": f, "stem": stem, "body": body,
            "name": meta.get("name") or stem.replace("_", " "),
            "description": meta.get("description") or titles.get(os.path.basename(f), ""),
            "type": meta.get("type") if meta.get("type") in TYPES else "project",
            "scope": meta.get("scope") or GLOBAL,
            "modified": meta.get("modified", ""), "source": meta.get("source", ""),
            "created": meta.get("created") or meta.get("modified", ""),  # backfilled from `modified` when missing
        })
    return out


def _norm(text):
    return re.sub(r"\s+", " ", text.strip().lower())


def _digest(text):
    return hashlib.sha1(_norm(text).encode()).hexdigest()


def _slug(text, limit=40):
    s = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
    return s[:limit].rstrip("_") or "memory"


def _frontmatter(meta):
    return "---\n" + "".join(f"{k}: {v}\n" for k, v in meta.items() if v not in (None, "")) + "---\n"


def rebuild_index(d):
    lines = ["# Memory index (managed by lean-agent)", ""]
    for m in read_all(d):
        hook = (m["description"] or m["body"].splitlines()[0])[:120]
        scope = "" if m["scope"] == GLOBAL else f" [{m['scope']}]"
        lines.append(f"- [{m['name']}]({os.path.basename(m['file'])}) - {m['type']}{scope}: {hook}")
    with open(os.path.join(d, "MEMORY.md"), "w") as fh:
        fh.write("\n".join(lines) + "\n")


def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def _targets(text, mtype):
    return lean_rules.classify(text, mtype)["targets"]


def _same(a_text, a_name, a_type, b):
    """Near-identical: same type, token-set similarity >= 0.75 of both text and title, same rule targets."""
    return (b["scope"] and b["type"] == a_type and lean_rules.near_duplicate(a_text, a_name, b["body"], b["name"],
                                                     _targets(a_text, a_type), _targets(b["body"], b["type"])))


MAX_BODY = 2000


_ENTRY_START = re.compile(r"(?m)^(?=- \d{4}-\d\d-\d\d: )")
TRUNCATED = "[truncated]"


def _trim_entries(body):
    """Cap a body at MAX_BODY chars by dropping whole oldest entries (the text before the first dated line counts
    as the oldest); never cuts inside an entry. A single entry over the cap keeps its head and is marked truncated."""
    if len(body) <= MAX_BODY:
        return body
    parts = [p for p in _ENTRY_START.split(body) if p.strip()]
    while len(parts) > 1 and len("".join(parts).rstrip()) > MAX_BODY:
        parts.pop(0)
    body = "".join(parts).rstrip()
    if len(body) > MAX_BODY:
        body = body[:MAX_BODY - len(TRUNCATED) - 1].rstrip() + " " + TRUNCATED
    return body


def _append_detail(m, text, force=False):
    """Add the new text under a dated line to an existing memory; the entry is capped at MAX_BODY chars, keeping
    the newest parts. Returns its path."""
    with open(m["file"], encoding="utf-8", errors="replace") as fh:
        meta, body = parse(fh.read())
    text = text.strip()
    if _norm(text) in _norm(body) or not force and lean_rules.tokens(text) <= lean_rules.tokens(body):
        return m["file"]  # nothing new to add
    body = body.rstrip() + f"\n- {datetime.date.today().isoformat()}: {text}"
    body = _trim_entries(body)
    meta["modified"] = _now()
    meta.setdefault("created", m["created"])
    with open(m["file"], "w") as fh:
        fh.write(_frontmatter(meta) + "\n" + body + "\n")
    return m["file"]


def add(d, text, mtype="project", scope=GLOBAL, name=None, source=None, rebuild=True, description=None, stem=None,
        dedupe=True):
    """Write one memory unless the same text is already stored. Returns its path, or None for a duplicate.
    A near-identical entry (same scope, same targets) is updated with the new detail instead of getting a twin."""
    text = text.strip()
    if not text:
        return None
    digest = _digest(text)
    existing = read_all(d)
    if any(_digest(m["body"]) == digest for m in existing):
        return None
    mtype = mtype if mtype in TYPES else "project"
    if dedupe:
        twin = next((m for m in existing if m["scope"] == (scope or GLOBAL)
                     and _same(text, name or text.splitlines()[0][:60], mtype, m)), None)
        if twin:
            path = _append_detail(twin, text)
            if rebuild:
                rebuild_index(d)
            return path
    if source and name:  # the same source and name is the same memory: refresh it instead of adding a `_2` twin
        same = next((m for m in existing if m["source"] == source and m["name"] == name and m["scope"] == (scope or GLOBAL)), None)
        if same:
            with open(same["file"], encoding="utf-8", errors="replace") as fh:
                meta, _ = parse(fh.read())
            meta.update(type=mtype, modified=_now(), description=(description or text.splitlines()[0])[:120])
            meta.setdefault("created", same["created"])
            with open(same["file"], "w") as fh:
                fh.write(_frontmatter(meta) + "\n" + text + "\n")
            if rebuild:
                rebuild_index(d)
            return same["file"]
    name = name or text.splitlines()[0][:60]
    base = _slug(name)
    if base.startswith(mtype + "_"):  # `--name feedback_x` must not become feedback_feedback_x
        base = base[len(mtype) + 1:]
    stem, n = _slug(stem, 60) if stem else f"{mtype}_{base}", 2
    path = os.path.join(d, stem + ".md")
    while os.path.exists(path):
        path, n = os.path.join(d, f"{stem}_{n}.md"), n + 1
    meta = {"name": name, "description": (description or text.splitlines()[0])[:120], "type": mtype, "scope": scope or GLOBAL,
            "created": _now(), "modified": _now(), "source": source}
    with open(path, "w") as fh:
        fh.write(_frontmatter(meta) + "\n" + text + "\n")
    if rebuild:
        rebuild_index(d)
    return path


def import_dirs(d, sources, scope=GLOBAL):
    """Copy memories from Claude auto-memory folders into the store. Returns (added, skipped)."""
    added = skipped = 0
    for src in sources:
        if _expand(src) == _expand(d):
            continue
        for m in read_all(src):
            ok = add(d, m["body"], m["type"], scope=m["scope"] if m["scope"] != GLOBAL else scope,
                     name=m["name"], source=f"imported from {m['file']}", rebuild=False,
                     description=m["description"] or None, stem=m["stem"], dedupe=False)
            added, skipped = (added + 1, skipped) if ok else (added, skipped + 1)
    rebuild_index(d)
    return added, skipped


def find(d, ref):
    """A memory by file stem, `mem-<id>` card id, or its name; None if not found."""
    def norm(x):
        return re.sub(r"[^a-z0-9]+", "-", x.lower()).strip("-")

    key = norm(ref[4:] if ref.startswith("mem-") else ref)
    for m in read_all(d):
        names = {norm(m["stem"]), norm(m["name"])}
        names |= {n[len(m["type"]) + 1:] for n in list(names) if n.startswith(m["type"] + "-")}  # without type
        if key in names:
            return m
    return None


def edit(d, ref, text=None, mtype=None, description=None, scope=None):
    """Rewrite one memory in place (same file, so its card id, stats and core flag survive)."""
    m = find(d, ref)
    if not m:
        return None
    with open(m["file"], encoding="utf-8", errors="replace") as fh:
        meta, body = parse(fh.read())
    if text is not None:
        body = text.strip()
    if mtype in TYPES:
        meta["type"] = mtype
    if description:
        meta["description"] = description[:120]
    elif text is not None and not meta.get("description"):
        meta["description"] = body.splitlines()[0][:120]
    if scope:
        meta["scope"] = scope
    meta.setdefault("created", meta.get("modified") or _now())
    meta["modified"] = _now()
    with open(m["file"], "w") as fh:
        fh.write(_frontmatter(meta) + "\n" + body + "\n")
    rebuild_index(d)
    return m["file"]


def remove(d, stem):
    path = os.path.join(d, stem + ".md")
    if not os.path.exists(path):
        return False
    os.remove(path)
    rebuild_index(d)
    return True


def clusters(d, scopes=None):
    """Groups (lists, oldest first) of near-duplicate memories of one scope and one type."""
    mems = sorted((m for m in read_all(d) if scopes is None or m["scope"] in scopes),
                  key=lambda m: (m["created"] or "9", m["stem"]))
    groups = []  # each group is compared against its first (oldest) entry only, so no chains
    for m in mems:
        home = next((g for g in groups if g[0]["scope"] == m["scope"] and _same(m["body"], m["name"], m["type"], g[0])), None)
        if home:
            home.append(m)
        else:
            groups.append([m])
    return [g for g in groups if len(g) > 1]


def merge_cluster(d, group):
    """Keep the oldest entry, append the others' extra detail (dated, short) and delete them. Returns the kept stem."""
    keep, rest = group[0], group[1:]
    for m in rest:
        _append_detail(read_all_one(d, keep), m["body"], force=True)  # merged before the file goes
        os.remove(m["file"])
    rebuild_index(d)
    return keep["stem"]


def read_all_one(d, m):
    return next(x for x in read_all(d) if x["file"] == m["file"])


_SUFFIXED = re.compile(r"^(.+)_(\d+)$")


def heal(d):
    """Merge `<name>` / `<name>_N` pairs that are exact or near-identical copies (same rules as dedupe). Returns the
    number merged."""
    by_stem = {m["stem"]: m for m in read_all(d)}
    merged = 0
    for stem in sorted(by_stem):
        m = _SUFFIXED.match(stem)
        base = by_stem.get(m.group(1)) if m else None
        dup = by_stem[stem]
        if base and base["scope"] == dup["scope"] and base["type"] == dup["type"] and (
                _digest(base["body"]) == _digest(dup["body"]) or _same(dup["body"], dup["name"], dup["type"], base)):
            merge_cluster(d, [base, dup])
            merged += 1
    return merged
