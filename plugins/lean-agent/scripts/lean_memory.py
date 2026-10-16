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
            "modified": meta.get("modified", ""),
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


def add(d, text, mtype="project", scope=GLOBAL, name=None, source=None, rebuild=True, description=None, stem=None):
    """Write one memory unless the same text is already stored. Returns its path, or None for a duplicate."""
    text = text.strip()
    if not text:
        return None
    digest = _digest(text)
    if any(_digest(m["body"]) == digest for m in read_all(d)):
        return None
    mtype = mtype if mtype in TYPES else "project"
    name = name or text.splitlines()[0][:60]
    base = _slug(name)
    if base.startswith(mtype + "_"):  # `--name feedback_x` must not become feedback_feedback_x
        base = base[len(mtype) + 1:]
    stem, n = _slug(stem, 60) if stem else f"{mtype}_{base}", 2
    path = os.path.join(d, stem + ".md")
    while os.path.exists(path):
        path, n = os.path.join(d, f"{stem}_{n}.md"), n + 1
    meta = {"name": name, "description": (description or text.splitlines()[0])[:120], "type": mtype, "scope": scope or GLOBAL,
            "modified": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
            "source": source}
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
                     description=m["description"] or None, stem=m["stem"])
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
    meta["modified"] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
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
