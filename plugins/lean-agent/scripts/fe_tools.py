"""Low-token tools for large front-end work (a refactor, a migration) in any JS/TS project: the script does the
bulk reading and running, and the model gets a few lines.

    map       an import graph of the code (no model): who uses what, dependencies, routes, unused files
    count     named regex counters with history: how much of a legacy pattern is left
    check     type-check / lint / test commands compared against a baseline: only new errors are shown
    parity    per-route screenshots, page text and console errors against a baseline (Playwright)
    codemod   run a codemod command on a throwaway copy (dry run) or for real, and summarise the change
    slices    a refactor plan from the map: shared parts first, then one slice per route or folder

Everything is kept under ~/.lean-agent/<tool>/<project>/; nothing here calls a model.
"""
import collections
import datetime
import difflib
import fnmatch
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import zlib

CODE_EXT = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte")
STYLE_EXT = (".css", ".scss", ".sass", ".less")
SKIP_DIRS = {"node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".nuxt", ".svelte-kit", ".turbo",
             ".cache", "vendor", "storybook-static", ".output", ".vercel", ".parcel-cache", "tmp", ".idea", ".vscode"}
TEST_RE = re.compile(r"(\.|/|^)(test|spec|stories|story)\.[^/]+$|(^|/)(__tests__|__mocks__|e2e|cypress|tests?)/")
RESOLVE_EXT = CODE_EXT + (".d.ts", ".json") + STYLE_EXT


def lean_home(*parts):
    return os.path.join(os.path.abspath(os.path.expanduser(os.environ.get("LEAN_AGENT_HOME") or "~/.lean-agent")), *parts)


def _load(path, default):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def _save(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w") as fh:
        json.dump(data, fh, indent=1)
    os.replace(tmp, path)


def _now():
    return datetime.datetime.now().isoformat(timespec="seconds")


class Fail(Exception):
    """A user-facing error: the CLI prints it and exits 1."""


def work_dir(slug, path, given=None):
    """Where to run: --dir, else the current directory when it's in the project or one of its lean-agent
    worktrees (a worker runs there), else the project."""
    if given:
        d = os.path.abspath(os.path.expanduser(given))
        if not os.path.isdir(d):
            raise Fail(f"no such directory {given}")
        return d
    cwd = os.path.realpath(os.getcwd())
    for root in (os.path.realpath(path), os.path.realpath(lean_home("worktrees", slug))):
        if cwd == root or cwd.startswith(root + os.sep):
            top = subprocess.run(["git", "-C", cwd, "rev-parse", "--show-toplevel"], capture_output=True, text=True)
            return top.stdout.strip() if top.returncode == 0 and top.stdout.strip() else cwd
    return path


def git_files(root):
    """The files git knows in root (tracked, plus untracked ones .gitignore doesn't exclude), relative to root;
    None when root isn't in a git checkout."""
    try:
        p = subprocess.run(["git", "-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
                           capture_output=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return None
    if p.returncode != 0:
        return None
    return sorted({f for f in p.stdout.decode("utf-8", "replace").split("\0") if f})


def excludes_for(slug):
    return _load(lean_home("maps", slug, "excludes.json"), [])


def walk(root, exts=CODE_EXT + STYLE_EXT, sub=None, globs=None, exclude=()):
    """Relative paths of source files under root (or root/sub), skipping build output and dependencies: what
    .gitignore excludes (in a git checkout), node_modules/dist/build/..., hidden folders and `exclude` globs.
    exts=None: any file (the globs decide)."""
    def keep(rel):
        name = rel.rsplit("/", 1)[-1]
        parts = rel.split("/")[:-1]
        if any(p in SKIP_DIRS or p.startswith(".") for p in parts):
            return False
        if (exts and not name.endswith(exts)) or name.endswith(".min.js"):
            return False
        if any(fnmatch.fnmatch(rel, g) or fnmatch.fnmatch(rel, g.rstrip("/") + "/*") or
               any(fnmatch.fnmatch("/".join(parts[:i + 1]), g.rstrip("/")) for i in range(len(parts)))
               for g in exclude or ()):
            return False
        if globs and not any(fnmatch.fnmatch(rel, g) or fnmatch.fnmatch(name, g) for g in globs):
            return False
        return True
    listed = git_files(root)
    if listed is not None:
        pre = (sub.strip("/") + "/") if sub else ""
        for rel in listed:
            if rel.startswith(pre) and os.path.isfile(os.path.join(root, rel)) and keep(rel):
                yield rel
        return
    base = os.path.join(root, sub) if sub else root
    for d, dirs, files in os.walk(base):
        dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS and not x.startswith("."))
        for f in sorted(files):
            rel = os.path.relpath(os.path.join(d, f), root).replace(os.sep, "/")
            if keep(rel):
                yield rel


def _read(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return ""


# ------------------------------------------------------------------------------------------------- map

IMPORT_RE = re.compile(r"""(?:^|[;\s}])(?:import|export)\s+(?:type\s+)?(?:([\w*${}\s,]+?)\s+from\s+)?['"]([^'"\n]+)['"]""",
                       re.M)
DYNAMIC_RE = re.compile(r"""\b(?:require|import)\s*\(\s*['"]([^'"\n]+)['"]\s*\)""")
CSS_RE = re.compile(r"""@(?:import|use|forward)\s+(?:url\()?\s*['"]([^'"\n]+)['"]""")
EXPORT_DECL_RE = re.compile(r"\bexport\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?"
                            r"(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)")
EXPORT_LIST_RE = re.compile(r"\bexport\s*\{([^}]*)\}(?!\s*from)")
ROUTE_DECL_RE = re.compile(r"""\bpath\s*[:=]\s*\{?\s*['"`](/[^'"`\s]*)['"`]""")
ROUTER_FILE_RE = re.compile(r"""from\s+['"](?:react-router(?:-dom)?|vue-router|@tanstack/react-router)['"]|createBrowserRouter|createHashRouter|<Routes\b|new\s+VueRouter""")
ROUTE_REL_RE = re.compile(r"""\bpath\s*[:=]\s*\{?\s*['"`]((?:/|[A-Za-z0-9:*])[^'"`\s]*)['"`]""")
ROUTE_CONST_RE = re.compile(r"""\bpath\s*=\s*\{\s*[A-Za-z_$][\w$.]*\s*\}|\bpath\s*:\s*[A-Za-z_$][\w$.]*\s*[,}]""")
ROUTE_COMP_RE = re.compile(r"""(?:element\s*[:=]\s*\{?\s*<\s*|[cC]omponent\s*[:=]\s*\{?\s*)([A-Z][\w$]*)""")
ROUTE_LAZY_RE = re.compile(r"""import\s*\(\s*['"]([^'"]+)['"]\s*\)""")
COMMENT_RE = re.compile(r'("(?:\\.|[^"\\])*")|//[^\n]*|/\*.*?\*/', re.S)


def _json5(text):
    text = COMMENT_RE.sub(lambda m: m.group(1) or "", text)
    return json.loads(re.sub(r",(\s*[}\]])", r"\1", text))


def aliases(root):
    """[(prefix, [target dirs])] and baseUrl from tsconfig/jsconfig (one level of `extends`)."""
    out, base = [], None
    for name in ("tsconfig.json", "jsconfig.json", "tsconfig.base.json"):
        path = os.path.join(root, name)
        seen = 0
        while os.path.exists(path) and seen < 3:
            seen += 1
            try:
                conf = _json5(_read(path))
            except ValueError:
                break
            opts = conf.get("compilerOptions") or {}
            here = os.path.dirname(path)
            b = os.path.normpath(os.path.join(here, opts.get("baseUrl", "."))) if opts.get("baseUrl") or opts.get("paths") else None
            base = base or (b if opts.get("baseUrl") else None)
            for pat, targets in (opts.get("paths") or {}).items():
                prefix = pat.rstrip("*")
                dirs = [os.path.normpath(os.path.join(b or here, t.rstrip("*"))) for t in targets or []]
                out.append((prefix, dirs))
            ext = conf.get("extends")
            if isinstance(ext, str) and ext.startswith("."):
                path = os.path.normpath(os.path.join(here, ext if ext.endswith(".json") else ext + ".json"))
            else:
                break
    out.sort(key=lambda x: -len(x[0]))
    return out, base


def _resolve(root, frm, spec, al, base):
    """A relative file path for an import, "pkg:<name>" for a package, or None."""
    cands = []
    if spec.startswith("."):
        cands.append(os.path.normpath(os.path.join(root, os.path.dirname(frm), spec)))
    else:
        for prefix, dirs in al:
            if prefix and spec.startswith(prefix) or spec == prefix.rstrip("/"):
                rest = spec[len(prefix):] if spec.startswith(prefix) else ""
                cands += [os.path.join(d, rest) for d in dirs]
        if base:
            cands.append(os.path.join(base, spec))
        if spec.startswith("~/") or spec.startswith("@/"):
            cands += [os.path.join(root, "src", spec[2:]), os.path.join(root, spec[2:])]
    for c in cands:
        for p in [c] + [c + e for e in RESOLVE_EXT] + [os.path.join(c, "index" + e) for e in RESOLVE_EXT]:
            if os.path.isfile(p):
                rel = os.path.relpath(p, root).replace(os.sep, "/")
                return None if rel.startswith("..") else rel
    if spec.startswith(".") or spec.startswith("/"):
        return None
    spec = spec.lstrip("~")
    parts = spec.split("/")
    return "pkg:" + ("/".join(parts[:2]) if spec.startswith("@") and len(parts) > 1 else parts[0])


def _names(clause):
    if not clause:
        return []
    names = []
    clause = clause.strip()
    m = re.match(r"([A-Za-z_$][\w$]*)\s*(?:,|$)", clause)
    if m and not clause.startswith("{") and not clause.startswith("*"):
        names.append("default")
    if "* as" in clause or clause.startswith("*"):
        names.append("*")
    b = re.search(r"\{([^}]*)\}", clause, re.S)
    if b:
        for part in b.group(1).split(","):
            n = part.strip().split(" as ")[0].replace("type ", "").strip()
            if n:
                names.append(n)
    return names


def frameworks(root):
    """Package names from package.json (dependencies and devDependencies), for file-system routing."""
    pkg = _load(os.path.join(root, "package.json"), {})
    return set((pkg.get("dependencies") or {})) | set((pkg.get("devDependencies") or {}))


def _fs_route(rel, fw=()):
    """A route for file-system routing (Next/Nuxt pages/, Next app/, SvelteKit routes/), or None."""
    m = re.search(r"(?:^|/)pages/(.+)\.(?:tsx|jsx|ts|js|vue|svelte)$", rel) if {"next", "nuxt"} & set(fw) else None
    if m and not re.search(r"(^|/)(_app|_document|_error|api/)", m.group(1)):
        r = re.sub(r"(^|/)index$", "", m.group(1))
        return "/" + r
    m = re.search(r"(?:^|/)app/(?:(.*)/)?page\.(?:tsx|jsx|ts|js)$", rel)
    if m:
        return "/" + "/".join(p for p in (m.group(1) or "").split("/") if not p.startswith("("))
    m = re.search(r"(?:^|/)routes/(?:(.*)/)?\+page\.svelte$", rel)
    if m:
        return "/" + (m.group(1) or "")
    return None


def build_map(root, exclude=()):
    al, base = aliases(root)
    fw = frameworks(root)
    files, routes, unread = {}, [], 0
    for rel in walk(root, exclude=exclude):
        text = _read(os.path.join(root, rel))
        imports = {}
        regs = [(m.group(2), _names(m.group(1))) for m in IMPORT_RE.finditer(text)]
        regs += [(m.group(1), ["*"]) for m in DYNAMIC_RE.finditer(text)]
        if rel.endswith(STYLE_EXT + (".vue", ".svelte")):
            regs += [(m.group(1), ["*"]) for m in CSS_RE.finditer(text)]
        for spec, names in regs:
            to = _resolve(root, rel, spec, al, base)
            if to and to != rel:
                imports.setdefault(to, set()).update(names)
        exports = sorted(set(EXPORT_DECL_RE.findall(text)) | {
            n.strip().split(" as ")[-1].strip() for b in EXPORT_LIST_RE.findall(text) for n in b.split(",") if n.strip()})
        if re.search(r"\bexport\s+default\b", text) or rel.endswith((".vue", ".svelte")):
            exports.append("default")
        files[rel] = {"lines": text.count("\n") + 1, "imports": {k: sorted(v) for k, v in imports.items()},
                      "exports": exports, "test": bool(TEST_RE.search(rel))}
        fr = _fs_route(rel, fw)
        if fr is not None:
            routes.append({"route": fr, "file": rel, "declared_in": rel})
        router = bool(ROUTER_FILE_RE.search(text))
        if not files[rel]["test"] and router:
            unread += len(ROUTE_CONST_RE.findall(text))
        if not files[rel]["test"]:
            for m in (ROUTE_REL_RE if router else ROUTE_DECL_RE).finditer(text):
                near = text[m.end():m.end() + 400]
                entry = None
                lazy = ROUTE_LAZY_RE.search(near[:200])
                comp = ROUTE_COMP_RE.search(near)
                if lazy:
                    entry = _resolve(root, rel, lazy.group(1), al, base)
                elif comp:
                    name = comp.group(1)
                    entry = next((to for to, names in imports.items() if not to.startswith("pkg:") and (
                        name in names or ("default" in names and os.path.splitext(os.path.basename(to))[0] == name))),
                        None) or (rel if name in exports else None)
                route = m.group(1) if m.group(1).startswith("/") else "/" + m.group(1)
                if route == "/*" or route.endswith("*") and len(route) <= 2:
                    continue  # a catch-all
                routes.append({"route": route, "file": entry if entry and not entry.startswith("pkg:") else None,
                               "declared_in": rel})
    seen, uniq = set(), []
    for r in routes:
        key = (r["route"], r["file"])
        if key not in seen:
            seen.add(key)
            uniq.append(r)
    return {"root": root, "built": time.time(), "count": len(files), "files": files, "routes": uniq,
            "routes_unread": unread}


def map_path(slug, root):
    return lean_home("maps", slug, hashlib.sha1(os.path.realpath(root).encode()).hexdigest()[:10] + ".json")


def load_map(slug, root, refresh=False, log=None):
    """The cached map, rebuilt when a source file changed (a stat walk, no reading), the excludes changed, or on
    refresh."""
    path = map_path(slug, root)
    exclude = excludes_for(slug)
    data = None if refresh else _load(path, None)
    if data and data.get("exclude", []) != exclude:
        data = None
    if data:
        n, newest = 0, 0.0
        for rel in walk(root, exclude=exclude):
            n += 1
            try:
                newest = max(newest, os.path.getmtime(os.path.join(root, rel)))
            except OSError:
                pass
        if n != data.get("count") or newest > data.get("built", 0):
            data = None
    if not data:
        data = build_map(root, exclude)
        data["exclude"] = exclude
        _save(path, data)
        if log:
            log(f"(map built: {data['count']} files)")
    return data


def users_of(data):
    rev = collections.defaultdict(dict)
    for f, info in data["files"].items():
        for to, names in info["imports"].items():
            rev[to][f] = names
    return rev


def _top(rel, depth=2):
    parts = rel.split("/")
    return "/".join(parts[:min(depth, len(parts) - 1)]) or "."


def _match_files(data, what):
    """Files a query names: an exact path, a path prefix (folder), or a file name / symbol."""
    files = data["files"]
    w = what.strip("./")
    if w in files:
        return [w]
    pre = [f for f in files if f.startswith(w.rstrip("/") + "/")]
    if pre:
        return pre
    base = [f for f in files if os.path.splitext(os.path.basename(f))[0] == w or f.endswith("/" + w)]
    if base:
        return base
    return [f for f, i in files.items() if w in i["exports"]]


def closure(data, start, tests=False):
    """Internal files reachable from `start` (a list of files) through imports."""
    seen, todo = set(), list(start)
    while todo:
        f = todo.pop()
        if f in seen or f not in data["files"]:
            continue
        seen.add(f)
        todo += [t for t in data["files"][f]["imports"] if not t.startswith("pkg:")]
    return {f for f in seen if tests or not data["files"][f]["test"]}


def map_report(data, a):
    files, out = data["files"], []
    lim = a.max or 25
    if a.who_uses:
        targets = _match_files(data, a.who_uses)
        if not targets:
            raise Fail(f"nothing in the map matches {a.who_uses!r} (a path, a folder, a file name or an exported name)")
        sym = a.who_uses if not any(t == a.who_uses.strip("./") for t in targets) and any(
            a.who_uses in files[t]["exports"] for t in targets) else None
        rev = users_of(data)
        inside = set(targets)
        users = {}
        for t in targets:
            for u, names in rev.get(t, {}).items():
                if u in inside:
                    continue
                if sym and sym not in names and "*" not in names and not (sym == "default"):
                    continue
                users.setdefault(u, set()).update(names)
        what = f"{a.who_uses}" + (f" ({len(targets)} files)" if len(targets) > 1 else "")
        out.append(f"{what}: used by {len(users)} file{'s' if len(users) != 1 else ''}"
                   + (f" ({sum(1 for u in users if files[u]['test'])} tests)" if users else ""))
        by = collections.Counter(_top(u) for u in users)
        out.append("  by folder: " + ", ".join(f"{k} {v}" for k, v in by.most_common(8)) if users else "")
        for u in sorted(users, key=lambda u: (files[u]["test"], u))[:lim]:
            names = sorted(n for n in users[u] if n not in ("*",))
            out.append(f"  {u}" + (f"  [{', '.join(names[:6])}]" if names else ""))
        if len(users) > lim:
            out.append(f"  ... {len(users) - lim} more (--max N)")
    elif a.deps:
        targets = _match_files(data, a.deps)
        if not targets:
            raise Fail(f"nothing in the map matches {a.deps!r}")
        inside = set(targets)
        internal, pkgs = collections.Counter(), collections.Counter()
        for t in targets:
            for to in files[t]["imports"]:
                if to.startswith("pkg:"):
                    pkgs[to[4:]] += 1
                elif to not in inside:
                    internal[to] += 1
        reach = closure(data, targets) - inside
        out.append(f"{a.deps}: {len(targets)} file{'s' if len(targets) != 1 else ''}, "
                   f"{sum(files[t]['lines'] for t in targets):,} lines; imports {len(internal)} other files "
                   f"({len(reach)} reachable in all) and {len(pkgs)} packages")
        if pkgs:
            out.append("  packages: " + ", ".join(f"{p} {n}" for p, n in pkgs.most_common(12)))
        for to, n in internal.most_common(lim):
            out.append(f"  {to}" + (f"  ({n} imports)" if n > 1 else ""))
        if len(internal) > lim:
            out.append(f"  ... {len(internal) - lim} more (--max N)")
    elif a.unused:
        rev = users_of(data)
        entries = {r["file"] for r in data["routes"] if r["file"]} | {r["declared_in"] for r in data["routes"]}
        cand = [f for f, i in files.items() if not i["test"] and f not in rev and f not in entries
                and not re.search(r"(^|/)(index|main|app|App|_app|setup|vite\.config|next\.config|.*\.config|"
                                  r".*\.d)\.\w+$", f) and not f.endswith(STYLE_EXT)]
        out.append(f"{len(cand)} file{'s' if len(cand) != 1 else ''} nothing imports (not entry points, configs or "
                   "tests; check dynamic use before deleting):")
        for f in sorted(cand, key=lambda f: -files[f]["lines"])[:lim]:
            out.append(f"  {f}  ({files[f]['lines']} lines)")
        if len(cand) > lim:
            out.append(f"  ... {len(cand) - lim} more (--max N)")
    elif a.route is not None:
        hits = [r for r in data["routes"] if a.route in ("", "all") or r["route"] == a.route
                or r["route"].startswith(a.route.rstrip("/") + "/")]
        if not hits:
            raise Fail(f"no route {a.route!r} in the map ({len(data['routes'])} routes; --route all lists them)"
                       + (f"; {data.get('routes_unread')} route paths are constants (path={{ROUTES.x}}) the map can't "
                          "read" if data.get("routes_unread") else ""))
        for r in hits[:lim * 2]:
            if r["file"]:
                c = closure(data, [r["file"]])
                out.append(f"{r['route']}  {r['file']}  ({len(c)} files, {sum(files[f]['lines'] for f in c):,} lines"
                           " with its imports)" + (f"  declared in {r['declared_in']}" if r["declared_in"] != r["file"] else ""))
            else:
                out.append(f"{r['route']}  (component not found; declared in {r['declared_in']})")
        if data.get("routes_unread"):
            out.append(f"({data['routes_unread']} more route paths are constants, e.g. path={{ROUTES.x}}, which the map "
                       "can't read; nested child paths are shown without their parent's prefix)")
    elif a.find:
        hits = [(f, i) for f, i in files.items() if a.find in i["exports"]]
        out.append(f"{a.find}: exported by {len(hits)} file{'s' if len(hits) != 1 else ''}")
        rev = users_of(data)
        for f, i in hits[:lim]:
            out.append(f"  {f}  (used by {len(rev.get(f, {}))})")
    else:
        code = [f for f, i in files.items() if not i["test"]]
        out.append(f"{data['root']}: {len(files)} files ({len(files) - len(code)} tests), "
                   f"{sum(i['lines'] for i in files.values()):,} lines, {len(data['routes'])} routes")
        by = collections.defaultdict(lambda: [0, 0])
        for f in code:
            by[_top(f)][0] += 1
            by[_top(f)][1] += files[f]["lines"]
        out.append("folders: " + ", ".join(f"{k} {n} files/{l:,} lines" for k, (n, l) in
                                           sorted(by.items(), key=lambda x: -x[1][1])[:10]))
        pkgs = collections.Counter(to[4:] for i in files.values() for to in i["imports"] if to.startswith("pkg:"))
        out.append("packages: " + ", ".join(f"{p} {n}" for p, n in pkgs.most_common(12)))
        rev = users_of(data)
        most = sorted(((len(rev.get(f, {})), f) for f in code), reverse=True)[:8]
        out.append("most used: " + ", ".join(f"{f} ({n})" for n, f in most if n))
        tested = {to for f, i in files.items() if i["test"] for to in i["imports"]}
        big = sorted((f for f in code if f not in tested and files[f]["lines"] > 150), key=lambda f: -files[f]["lines"])
        if big:
            out.append(f"biggest without a test importing them: " + ", ".join(
                f"{f} ({files[f]['lines']})" for f in big[:6]))
        out.append("ask: --who-uses X | --deps PATH | --route /x | --route all | --unused | --find Name")
    return "\n".join(l for l in out if l is not None)


# ------------------------------------------------------------------------------------------------ count

def counters_path(slug):
    return lean_home("counts", slug + ".json")


def history_path(slug):
    return lean_home("counts", slug + ".jsonl")


def count_history(slug):
    out = []
    try:
        with open(history_path(slug)) as fh:
            for line in fh:
                try:
                    out.append(json.loads(line))
                except ValueError:
                    pass
    except OSError:
        pass
    return out


def run_counter(root, c):
    rx = re.compile(c["regex"], re.M)
    per_file = {}
    exts = None if c.get("globs") else CODE_EXT + STYLE_EXT + (".html", ".htm")
    for rel in walk(root, exts=exts, sub=c.get("path"), globs=c.get("globs"), exclude=c.get("exclude") or ()):
        n = len(rx.findall(_read(os.path.join(root, rel))))
        if n:
            per_file[rel] = n
    return per_file


def cmd_count(slug, path, a, log=print):
    conf = _load(counters_path(slug), {})
    root = work_dir(slug, path, a.dir)
    if a.action == "add":
        if len(a.args) < 2:
            raise Fail('lean-agent count <project> add NAME "REGEX" [--glob "*.tsx"] [--path src]')
        name, rx = a.args[0], " ".join(a.args[1:])
        try:
            re.compile(rx)
        except re.error as e:
            raise Fail(f"bad regex: {e}")
        conf[name] = {"regex": rx, "globs": [g.strip() for g in (a.glob or "").split(",") if g.strip()] or None,
                      "path": a.path, "added": _now()}
        _save(counters_path(slug), conf)
        log(f"counter {name}: {rx}")
        a.args = [name]
    elif a.action == "rm":
        for n in a.args:
            conf.pop(n, None)
        _save(counters_path(slug), conf)
        log(f"removed {', '.join(a.args)}")
        return 0
    names = a.args or sorted(conf)
    if not names:
        log('No counters yet: lean-agent count <project> add legacy-api "from [\'\\"]@/legacy/api" --glob "*.ts,*.tsx"')
        return 0
    hist = count_history(slug)
    for name in names:
        c = conf.get(name)
        if not c:
            raise Fail(f"no counter {name!r} (lean-agent count {slug})")
        per_file = run_counter(root, dict(c, exclude=excludes_for(slug)))
        total = sum(per_file.values())
        mine = [h for h in hist if h.get("name") == name]
        first = mine[0] if mine else None
        last = mine[-1] if mine else None
        trend = ""
        if first and first["total"] == total and (not last or last["total"] == total):
            trend = f" (unchanged since {first['ts'][5:10]})"
        elif first and first["total"]:
            trend = f" (was {first['total']} on {first['ts'][5:10]}, {100 * (total - first['total']) // first['total']:+d}%"
            trend += f"; last {last['total']} {last['ts'][5:16].replace('T', ' ')})" if last is not first else ")"
        log(f"{name}: {total} in {len(per_file)} file{'s' if len(per_file) != 1 else ''}{trend}")
        by = collections.Counter()
        for f, n in per_file.items():
            by[_top(f)] += n
        if by and (a.by_folder or not a.files):
            log("  " + ", ".join(f"{k} {v}" for k, v in by.most_common(8 if not a.by_folder else 40)))
        if a.files:
            for f, n in sorted(per_file.items(), key=lambda x: -x[1])[:a.max or 25]:
                log(f"  {n:>4}  {f}")
        if root == os.path.realpath(path) or root == path:  # history follows the project, not worktrees
            if not last or last["total"] != total or _now()[:13] != last["ts"][:13]:
                os.makedirs(os.path.dirname(history_path(slug)), exist_ok=True)
                with open(history_path(slug), "a") as fh:
                    fh.write(json.dumps({"ts": _now(), "name": name, "total": total, "files": len(per_file),
                                         "by": dict(by.most_common(20))}) + "\n")
    return 0


# ------------------------------------------------------------------------------------------------ check

ERR_PATTERNS = [
    # tsc: src/a.ts(12,5): error TS2322: Type ...
    re.compile(r"^(?P<file>[^\s(][^(\n]*?)\((?P<line>\d+),(?P<col>\d+)\):\s*(?P<sev>error|warning)\s+(?P<code>TS\d+):\s*(?P<msg>.+)$"),
    # tsc --pretty / eslint unix / stylelint compact / generic compilers: src/a.ts:12:5 - error TS2322: ...
    re.compile(r"^(?P<file>[^\s:][^:\n]*\.[A-Za-z]{1,5}):(?P<line>\d+)(?::(?P<col>\d+))?:?\s*-?\s*"
               r"(?:(?P<sev>error|warning|Error|Warning)\b:?\s*)?(?:(?P<code>TS\d+|E\d+|W\d+):?\s*)?(?P<msg>.+)$"),
]
STYLISH_FILE = re.compile(r"^(?:[A-Za-z]:)?[^\s]*[/\\][^\s]+\.[A-Za-z]{1,5}$|^[^\s/]+\.[A-Za-z]{1,5}$")
STYLISH_ROW = re.compile(r"^\s+(?P<line>\d+):(?P<col>\d+)\s+(?P<sev>error|warning)\s+(?P<msg>.+?)(?:\s{2,}(?P<code>[@\w/-]+))?\s*$")
TEST_FAIL = [re.compile(r"^(?:FAIL|ERROR): (?P<msg>\S+(?: \([\w.]+\))?)"),  # unittest
             re.compile(r"^\s*FAIL\s+(?P<file>(?!\()\S+)"), re.compile(r"^\s*(?:✕|×|✗)\s+(?P<msg>.+?)(?:\s+\(\d+(?:\.\d+)?\s*m?s\))?\s*$"),
             re.compile(r"^FAILED\s+(?P<file>\S+?)(?:::(?P<msg>\S+))?(?:\s|$)")]
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def parse_errors(text, root, warnings=False):
    """[(fingerprint, shown)]: one per error found; fingerprints leave line numbers out (they move)."""
    out, cur_file = [], None
    norm = lambda m: re.sub(r"\d+", "N", " ".join(str(m).split()))[:200]
    rel = lambda f: os.path.relpath(f, root).replace(os.sep, "/") if os.path.isabs(f) else f.replace(os.sep, "/").lstrip("./")
    for raw in text.splitlines():
        line = ANSI.sub("", raw).rstrip()
        if not line.strip():
            continue
        m = STYLISH_ROW.match(line)
        if m and cur_file:
            if m.group("sev") == "error" or warnings:
                code = m.group("code") or ""
                out.append(((cur_file, code, norm(m.group("msg"))), f"{cur_file}:{m.group('line')}: {m.group('msg')}"
                            + (f" [{code}]" if code else "")))
            continue
        if STYLISH_FILE.match(line.strip()) and not line.startswith(" "):
            cur_file = rel(line.strip())
            continue
        hit = False
        for p in ERR_PATTERNS:
            m = p.match(line.strip())
            if m:
                sev = (m.group("sev") or "error").lower()
                if re.match(r"\w*Warning\b", m.group("msg") or ""):
                    sev = "warning"  # Python's ResourceWarning / DeprecationWarning lines
                f = m.group("file")
                if sev == "warning" and not warnings:
                    hit = True
                    break
                if not re.search(r"\.[A-Za-z]{1,5}$", f) or f.startswith(("http", "at ")):
                    continue
                code = m.group("code") or ""
                out.append(((rel(f), code, norm(m.group("msg"))), f"{rel(f)}:{m.group('line')}: {m.group('msg').strip()}"
                            + (f" [{code}]" if code and code not in m.group("msg") else "")))
                hit = True
                break
        if hit:
            continue
        for p in TEST_FAIL:
            m = p.match(line)
            if m:
                gd = m.groupdict()
                f, msg = gd.get("file") or "", gd.get("msg") or ""
                out.append((("test", rel(f) if f else "", norm(msg)), ("FAIL " + rel(f) + (" " + msg if msg else "")).strip()
                            if f else "✕ " + msg))
                break
    return out


def checks_dir(slug):
    return lean_home("checks", slug)


def cmd_check(slug, path, a, log=print):
    conf_path = os.path.join(checks_dir(slug), "config.json")
    conf = _load(conf_path, {})
    if a.action == "add":
        if len(a.args) < 2:
            raise Fail('lean-agent check <project> add NAME "COMMAND" (e.g. add types "npx tsc --noEmit")')
        conf[a.args[0]] = {"cmd": " ".join(a.args[1:]), "timeout": a.timeout or 1800}
        _save(conf_path, conf)
        log(f"check {a.args[0]}: {conf[a.args[0]]['cmd']}  (record what's broken today: lean-agent check {slug} baseline)")
        return 0
    if a.action == "rm":
        for n in a.args:
            conf.pop(n, None)
        _save(conf_path, conf)
        log(f"removed {', '.join(a.args)}")
        return 0
    if not conf:
        log(f'No checks yet: lean-agent check {slug} add types "npx tsc --noEmit"; add lint "npx eslint src"; '
            f'add tests "npx vitest run", then lean-agent check {slug} baseline')
        return 0
    names = [n for n in a.args if n in conf] or sorted(conf)
    unknown = [n for n in a.args if n not in conf]
    if unknown:
        raise Fail(f"no check {', '.join(unknown)} (have: {', '.join(sorted(conf))})")
    root = work_dir(slug, path, a.dir)
    bad = 0
    for name in names:
        c = conf[name]
        started = time.time()
        try:
            p = subprocess.run(c["cmd"], shell=True, cwd=root, capture_output=True, text=True,
                               timeout=a.timeout or c.get("timeout") or 1800, stdin=subprocess.DEVNULL)
            rc, text = p.returncode, (p.stdout or "") + "\n" + (p.stderr or "")
        except subprocess.TimeoutExpired:
            rc, text = 124, ""
        secs = int(time.time() - started)
        errs = parse_errors(text, root, a.warnings)
        cur = collections.Counter(fp for fp, _ in errs)
        bpath = os.path.join(checks_dir(slug), name + ".baseline.json")
        if a.action == "baseline":
            _save(bpath, {"ts": _now(), "rc": rc, "dir": root, "errors": [[list(fp), n] for fp, n in cur.items()]})
            log(f"{name}: baseline recorded: {sum(cur.values())} error{'s' if sum(cur.values()) != 1 else ''}, exit {rc} ({secs}s)"
                + ("" if errs or rc == 0 else "; no errors recognised in its output (only its exit code is compared)"))
            continue
        base = _load(bpath, None)
        if rc == 124 and not text:
            log(f"{name}: timed out after {a.timeout or c.get('timeout') or 1800}s")
            bad += 1
            continue
        if base is None:
            log(f"{name}: exit {rc}, {sum(cur.values())} errors ({secs}s); no baseline yet, so all count as new "
                f"(lean-agent check {slug} baseline {name})")
            base_c = collections.Counter()
        else:
            base_c = collections.Counter({tuple(fp): n for fp, n in base.get("errors") or []})
        new, seen = [], collections.Counter()
        for fp, shown in errs:
            seen[fp] += 1
            if seen[fp] > base_c.get(fp, 0):
                new.append(shown)
        fixed = sum(max(0, n - cur.get(fp, 0)) for fp, n in base_c.items())
        if base is not None:
            state = "ok" if not new and (rc == 0 or errs or rc == base.get("rc")) else "NEW ERRORS" if new else f"FAILED (exit {rc})"
            log(f"{name}: {state} · {len(new)} new, {fixed} fixed (baseline {sum(base_c.values())}, now {sum(cur.values())}; {secs}s)")
        for s in new[:a.max or 15]:
            log("  " + s[:240])
        if len(new) > (a.max or 15):
            log(f"  ... {len(new) - (a.max or 15)} more new (--max N)")
        if not errs and rc != 0 and (base is None or rc != base.get("rc")):
            tail = [ANSI.sub("", l) for l in text.strip().splitlines() if l.strip()][-20:]
            log(f"  exit {rc} and no errors recognised; the end of its output:")
            for l in tail:
                log("  | " + l[:200])
            bad += 1
        elif new:
            bad += 1
        if base is not None and not new and fixed and a.update:
            _save(bpath, {"ts": _now(), "rc": rc, "dir": root, "errors": [[list(fp), n] for fp, n in cur.items()]})
            log(f"  (baseline lowered to {sum(cur.values())})")
    return 1 if bad else 0


# ----------------------------------------------------------------------------------------------- parity

def png_read(path):
    """(width, height, channels, [row bytes]) of an 8-bit, non-interlaced RGB/RGBA/gray PNG (what browsers write)."""
    with open(path, "rb") as fh:
        data = fh.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos, idat, w = 8, [], None
    while pos < len(data):
        n = int.from_bytes(data[pos:pos + 4], "big")
        kind = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + n]
        if kind == b"IHDR":
            w, h, depth, ctype, _, _, interlace = int.from_bytes(body[:4], "big"), int.from_bytes(body[4:8], "big"), \
                body[8], body[9], body[10], body[11], body[12]
            if depth != 8 or interlace or ctype not in (0, 2, 4, 6):
                raise ValueError("unsupported PNG format")
            ch = {0: 1, 2: 3, 4: 2, 6: 4}[ctype]
        elif kind == b"IDAT":
            idat.append(body)
        elif kind == b"IEND":
            break
        pos += 12 + n
    raw = zlib.decompress(b"".join(idat))
    stride = w * ch
    rows, prev, i = [], bytearray(stride), 0
    for _ in range(h):
        f = raw[i]
        line = bytearray(raw[i + 1:i + 1 + stride])
        i += 1 + stride
        if f == 1:
            for x in range(ch, stride):
                line[x] = (line[x] + line[x - ch]) & 255
        elif f == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 255
        elif f == 3:
            for x in range(stride):
                line[x] = (line[x] + ((line[x - ch] if x >= ch else 0) + prev[x]) // 2) & 255
        elif f == 4:
            for x in range(stride):
                a_ = line[x - ch] if x >= ch else 0
                b_, c_ = prev[x], prev[x - ch] if x >= ch else 0
                p = a_ + b_ - c_
                pa, pb, pc = abs(p - a_), abs(p - b_), abs(p - c_)
                line[x] = (line[x] + (a_ if pa <= pb and pa <= pc else b_ if pb <= pc else c_)) & 255
        rows.append(bytes(line))
        prev = line
    return w, h, ch, rows


def png_write(path, w, h, rows, ch=3):
    """A minimal PNG writer (for tests and diff images)."""
    ctype = {1: 0, 3: 2, 4: 6}[ch]
    raw = b"".join(b"\x00" + r for r in rows)
    chunk = lambda k, b: len(b).to_bytes(4, "big") + k + b + zlib.crc32(k + b).to_bytes(4, "big")
    with open(path, "wb") as fh:
        fh.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", w.to_bytes(4, "big") + h.to_bytes(4, "big")
                                              + bytes([8, ctype, 0, 0, 0])) + chunk(b"IDAT", zlib.compress(raw))
                 + chunk(b"IEND", b""))


def png_diff(a_path, b_path, tolerance=24):
    """(share of pixels that differ, (top, bottom) rows of the changed area as fractions, or None)."""
    wa, ha, ca, ra = png_read(a_path)
    wb, hb, cb, rb = png_read(b_path)
    if (wa, ha) != (wb, hb):
        return 1.0, (0.0, 1.0), f"size {wa}x{ha} -> {wb}x{hb}"
    diff, top, bottom = 0, None, None
    cmp_ch = min(ca, cb, 3)
    for y in range(ha):
        if ra[y] == rb[y] and ca == cb:
            continue
        row_a, row_b, n = ra[y], rb[y], 0
        for x in range(wa):
            pa, pb = x * ca, x * cb
            if any(abs(row_a[pa + k] - row_b[pb + k]) > tolerance for k in range(cmp_ch)):
                n += 1
        if n:
            diff += n
            top = y if top is None else top
            bottom = y
    if not diff:
        return 0.0, None, None
    return diff / (wa * ha), (top / ha, (bottom + 1) / ha), None


def _area(span):
    t, b = span
    where = "top" if b <= 0.34 else "bottom" if t >= 0.66 else "middle" if t >= 0.25 and b <= 0.75 else None
    return f"rows {int(t * 100)}-{int(b * 100)}%" + (f" ({where})" if where else "")


PARITY_JS = r"""
const fs = require('fs'), path = require('path');
let pw = null;
for (const m of ['playwright', '@playwright/test', 'playwright-core']) { try { pw = require(m); break; } catch (e) {} }
if (!pw) { console.error('NO_PLAYWRIGHT'); process.exit(3); }
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
(async () => {
  const opts = {};
  if (process.env.LEAN_AGENT_CHROMIUM) opts.executablePath = process.env.LEAN_AGENT_CHROMIUM;
  const browser = await pw.chromium.launch(opts);
  const ctx = await browser.newContext(Object.assign({viewport: cfg.viewport}, cfg.storage ? {storageState: cfg.storage} : {}));
  const results = [];
  for (const r of cfg.routes) {
    const page = await ctx.newPage(), errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
    page.on('pageerror', e => errors.push(String(e.message || e).slice(0, 300)));
    let status = null, error = null;
    try {
      const resp = await page.goto(cfg.url.replace(/\/$/, '') + r, {waitUntil: 'networkidle', timeout: 60000});
      status = resp ? resp.status() : null;
      if (cfg.wait) await page.waitForTimeout(cfg.wait);
      if (cfg.mask && cfg.mask.length)
        await page.addStyleTag({content: cfg.mask.map(s => s + '{visibility:hidden !important}').join('\n')});
      await page.addStyleTag({content: '*,*::before,*::after{animation:none !important;transition:none !important;caret-color:transparent !important}'});
    } catch (e) { error = String(e.message || e).split('\n')[0].slice(0, 300); }
    const file = path.join(cfg.out, r.replace(/[^\w-]+/g, '_').replace(/^_*$/, 'root') + '.png');
    let text = '';
    try { await page.screenshot({path: file, fullPage: !!cfg.full}); text = await page.evaluate(() => document.body ? document.body.innerText : ''); }
    catch (e) { error = error || String(e.message || e).split('\n')[0].slice(0, 300); }
    results.push({route: r, status, error, errors, shot: file, text: text.slice(0, 200000)});
    await page.close();
  }
  fs.writeFileSync(path.join(cfg.out, 'results.json'), JSON.stringify(results));
  await browser.close();
})().catch(e => { console.error(String(e && e.stack || e)); process.exit(1); });
"""


def parity_dir(slug, *parts):
    return lean_home("parity", slug, *parts)


def _reachable(url):
    try:
        urllib.request.urlopen(url, timeout=3)
        return True
    except Exception as e:  # an HTTP error still means a server answers
        return hasattr(e, "code")


def run_pages(slug, root, conf, out_dir, routes, log):
    shutil.rmtree(out_dir, ignore_errors=True)
    os.makedirs(out_dir)
    server = None
    if not _reachable(conf["url"]):
        if not conf.get("start"):
            raise Fail(f"nothing answers at {conf['url']}; start the dev server, or let parity start it: "
                       f'lean-agent parity {slug} set --start "npm run dev"')
        log(f"starting the dev server: {conf['start']}")
        server = subprocess.Popen(conf["start"], shell=True, cwd=root, stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, start_new_session=True)
        for _ in range(int(conf.get("start_timeout") or 180)):
            if _reachable(conf["url"]):
                break
            if server.poll() is not None:
                raise Fail(f"the dev server stopped (exit {server.returncode}) before {conf['url']} answered")
            time.sleep(1)
        else:
            raise Fail(f"{conf['url']} didn't answer within {conf.get('start_timeout') or 180}s")
    try:
        w, h = (int(x) for x in str(conf.get("viewport") or "1280x800").lower().split("x"))
        cfg_path = os.path.join(out_dir, "config.json")
        with open(cfg_path, "w") as fh:
            json.dump({"url": conf["url"], "routes": routes, "viewport": {"width": w, "height": h}, "out": out_dir,
                       "wait": int(conf.get("wait") or 300), "mask": conf.get("mask") or [], "full": bool(conf.get("full")),
                       "storage": conf.get("storage")}, fh)
        script = os.path.join(out_dir, "run.js")
        with open(script, "w") as fh:
            fh.write(PARITY_JS)
        node_path = [os.path.join(root, "node_modules"), os.path.join(os.path.realpath(root), "node_modules")]
        extra = os.environ.get("LEAN_AGENT_PLAYWRIGHT_DIR")
        if extra:
            node_path += [os.path.join(extra, "node_modules"), extra]
        env = dict(os.environ, NODE_PATH=os.pathsep.join(node_path + [os.environ.get("NODE_PATH", "")]))
        if not shutil.which("node"):
            raise Fail("parity needs Node.js (node on PATH)")
        p = subprocess.run(["node", script, cfg_path], cwd=root, env=env, capture_output=True, text=True, timeout=1800)
        if p.returncode == 3 or "NO_PLAYWRIGHT" in p.stderr:
            raise Fail("parity needs Playwright: in the project `npm i -D @playwright/test && npx playwright install "
                       "chromium`, or point LEAN_AGENT_PLAYWRIGHT_DIR at a folder where it's installed")
        if p.returncode != 0:
            raise Fail("the browser run failed: " + " ".join(p.stderr.split())[-400:])
        return _load(os.path.join(out_dir, "results.json"), [])
    finally:
        if server and server.poll() is None:
            try:
                os.killpg(server.pid, 15)
            except OSError:
                pass


def cmd_parity(slug, path, a, log=print):
    conf_path = parity_dir(slug, "config.json")
    conf = _load(conf_path, {})
    if a.action == "set":
        if a.url:
            conf["url"] = a.url
        if a.routes:
            conf["routes"] = [r.strip() for r in a.routes.split(",") if r.strip()]
        if a.routes_from_map:
            data = load_map(slug, work_dir(slug, path, a.dir), log=log)
            conf["routes"] = sorted({r["route"] for r in data["routes"]
                                     if not re.search(r"[\[:*]", r["route"])}) or conf.get("routes") or []
        for k in ("start", "viewport", "storage"):
            if getattr(a, k, None):
                conf[k] = getattr(a, k)
        if a.mask:
            conf["mask"] = [m.strip() for m in a.mask.split(",") if m.strip()]
        if a.wait is not None:
            conf["wait"] = a.wait
        if a.threshold is not None:
            conf["threshold"] = a.threshold
        if a.full:
            conf["full"] = True
        _save(conf_path, conf)
        log(f"parity for {slug}: {conf.get('url') or '(no --url yet)'}, {len(conf.get('routes') or [])} routes"
            + (f", starts `{conf['start']}` when nothing answers" if conf.get("start") else "")
            + (f"; masked: {', '.join(conf['mask'])}" if conf.get("mask") else ""))
        return 0
    if not conf.get("url") or not conf.get("routes"):
        raise Fail(f'set it up first: lean-agent parity {slug} set --url http://localhost:3000 --routes "/,/settings" '
                   "(or --routes-from-map)")
    root = work_dir(slug, path, a.dir)
    routes = [r.strip() for r in (a.route or "").split(",") if r.strip()] or conf["routes"]
    if a.action == "baseline":
        res = run_pages(slug, root, conf, parity_dir(slug, "baseline"), routes, log)
        bad = [r for r in res if r.get("error") or (r.get("status") or 200) >= 400]
        log(f"parity baseline: {len(res)} routes recorded" + (f"; {len(bad)} with errors: " + ", ".join(
            f"{r['route']} ({r.get('error') or r.get('status')})" for r in bad[:5]) if bad else ""))
        return 0
    base = {r["route"]: r for r in _load(parity_dir(slug, "baseline", "results.json"), [])}
    if not base:
        raise Fail(f"no baseline yet: lean-agent parity {slug} baseline (on the code as it is before the change)")
    res = run_pages(slug, root, conf, parity_dir(slug, "current"), routes, log)
    threshold = float(conf.get("threshold") or 0.1) / 100
    same, lines = 0, []
    for r in res:
        b = base.get(r["route"])
        if not b:
            lines.append(f"  {r['route']}: not in the baseline")
            continue
        notes = []
        if r.get("error"):
            notes.append(f"failed to load: {r['error']}")
        if (r.get("status") or 200) != (b.get("status") or 200):
            notes.append(f"status {b.get('status')} -> {r.get('status')}")
        try:
            share, span, why = png_diff(b["shot"], r["shot"])
            if why:
                notes.append(why)
            elif share > threshold:
                notes.append(f"{share * 100:.1f}% of pixels differ, {_area(span)}")
        except (OSError, ValueError, KeyError) as e:
            notes.append(f"no screenshot to compare ({e})")
        bt = [l.strip() for l in (b.get("text") or "").splitlines() if l.strip()]
        rt = [l.strip() for l in (r.get("text") or "").splitlines() if l.strip()]
        if bt != rt:
            d = [l for l in difflib.unified_diff(bt, rt, lineterm="", n=0) if l[:1] in "+-" and l[:3] not in ("+++", "---")]
            notes.append(f"text: {len([l for l in d if l[0] == '-'])} lines gone, {len([l for l in d if l[0] == '+'])} new"
                         + (": " + " | ".join(l[:60] for l in d[:3]) if d else ""))
        new_errs = [e for e in r.get("errors") or [] if e not in (b.get("errors") or [])]
        if new_errs:
            notes.append(f"{len(new_errs)} new console error{'s' if len(new_errs) > 1 else ''}: {new_errs[0][:120]}")
        if notes:
            lines.append(f"  {r['route']}: " + "; ".join(notes))
        else:
            same += 1
    log(f"parity: {same}/{len(res)} routes unchanged" + ("" if same == len(res) else
                                                          f" (screenshots: {parity_dir(slug, 'current')})"))
    for l in lines:
        log(l)
    return 0 if same == len(res) else 1


# ---------------------------------------------------------------------------------------------- codemod

def _git(d, *args, check=False):
    p = subprocess.run(["git", "-C", d, *args], capture_output=True, text=True)
    if check and p.returncode != 0:
        raise Fail(f"git {' '.join(args)}: {(p.stderr or p.stdout).strip()[:200]}")
    return p.stdout if p.returncode == 0 else None


def _change_summary(d, since, created, skip=(), sample=3, sample_lines=25, before=None):
    """Lines describing the working tree of `d` against commit `since` plus the files `created`; `before` holds
    the content of files git doesn't track yet, so changes to them count too."""
    num = _git(d, "diff", "--no-renames", "--numstat", since) or ""
    changed, local = [], {}
    for f, old in (before or {}).items():
        new_text = _read(os.path.join(d, f)) if os.path.exists(os.path.join(d, f)) else None
        if new_text != old:
            dl = list(difflib.unified_diff(old.splitlines(), (new_text or "").splitlines(), lineterm="", n=1))
            local[f] = dl
            changed.append((f, sum(1 for l in dl if l.startswith("+") and not l.startswith("+++")),
                            sum(1 for l in dl if l.startswith("-") and not l.startswith("---"))))
    for line in num.splitlines():
        parts = line.split("\t")
        if len(parts) == 3:
            add, rm, f = parts
            changed.append((f, int(add) if add.isdigit() else 0, int(rm) if rm.isdigit() else 0))
    deleted = set((_git(d, "diff", "--no-renames", "--name-only", "--diff-filter=D", since) or "").split())
    new = []
    for f in sorted(created):
        if f in skip:
            continue
        try:
            new.append((f, _read(os.path.join(d, f)).count("\n") + 1))
        except OSError:
            pass
    if not changed and not new:
        return ["no files changed"], 0
    adds, rms = sum(c[1] for c in changed) + sum(n for _, n in new), sum(c[2] for c in changed)
    out = [f"{len(changed) - len(deleted)} file{'s' if len(changed) - len(deleted) != 1 else ''} changed, {len(new)} new, "
           f"{len(deleted)} deleted (+{adds} -{rms})"]
    by = collections.defaultdict(lambda: [0, 0, 0])
    for f, ad, rm in changed:
        by[_top(f)][0] += 1
        by[_top(f)][1] += ad
        by[_top(f)][2] += rm
    for f, n in new:
        by[_top(f)][0] += 1
        by[_top(f)][1] += n
    for k, (n, ad, rm) in sorted(by.items(), key=lambda x: -(x[1][1] + x[1][2]))[:10]:
        out.append(f"  {k}: {n} files +{ad} -{rm}")
    picks, seen_dirs = [], set()
    for f, ad, rm in sorted(changed, key=lambda c: -(c[1] + c[2])):
        if _top(f) not in seen_dirs and f not in deleted:
            seen_dirs.add(_top(f))
            picks.append(f)
        if len(picks) >= sample:
            break
    for f in picks:
        diff = local.get(f) or (_git(d, "diff", "--no-renames", "-U1", since, "--", f) or "").splitlines()
        body = [l for l in diff if not l.startswith(("diff --git", "index ", "--- ", "+++ ", "---", "+++"))]
        out.append(f"sample {f}:")
        out += ["  " + l[:160] for l in body[:sample_lines]]
        if len(body) > sample_lines:
            out.append(f"  ... ({len(body) - sample_lines} more diff lines)")
    return out, len(changed) + len(new)


def cmd_codemod(slug, path, a, log=print):
    if not a.command:
        raise Fail('lean-agent codemod <project> "npx jscodeshift -t mods/rename.js src" [--apply]')
    d = work_dir(slug, path, a.dir)
    top = (_git(d, "rev-parse", "--show-toplevel") or "").strip()
    if not top:
        raise Fail("codemod needs a git checkout (it compares against git to summarise the change)")
    offset = os.path.relpath(os.path.realpath(d), os.path.realpath(top))  # /tmp may be a symlink (macOS)
    snap = (_git(top, "stash", "create") or "").strip() or (_git(top, "rev-parse", "HEAD") or "").strip()
    untracked = set((_git(top, "ls-files", "--others", "--exclude-standard") or "").split("\n")) - {""}
    before = {}
    for f in sorted(untracked)[:2000]:  # new files the checkout already has: a codemod may change them too
        full = os.path.join(top, f)
        if os.path.isfile(full) and os.path.getsize(full) < 1_000_000:
            before[f] = _read(full)
    if a.apply:
        run_in, cleanup, links = d, None, set()
    else:
        tmp = tempfile.mkdtemp(prefix="codemod-", dir=os.environ.get("TMPDIR") or None)
        os.rmdir(tmp)
        _git(top, "worktree", "add", "--detach", tmp, snap, check=True)
        cleanup = tmp
        for f in untracked:  # the worker's new files are part of the code the codemod sees
            src = os.path.join(top, f)
            if os.path.isfile(src):
                os.makedirs(os.path.dirname(os.path.join(tmp, f)), exist_ok=True)
                shutil.copy2(src, os.path.join(tmp, f))
        links = set()
        for dirpath, dirs, _ in os.walk(top):  # dependencies, so jscodeshift / ts-morph resolve
            rel = os.path.relpath(dirpath, top)
            if rel.count(os.sep) > 3 or ".git" in rel.split(os.sep):
                dirs[:] = []
                continue
            if "node_modules" in dirs:
                target = os.path.join(tmp, rel, "node_modules")
                if not os.path.exists(target):
                    os.makedirs(os.path.dirname(target), exist_ok=True)
                    os.symlink(os.path.join(dirpath, "node_modules"), target)
                    links.add(os.path.normpath(os.path.join(rel, "node_modules")).replace(os.sep, "/"))
            dirs[:] = [x for x in dirs if x not in SKIP_DIRS]
        run_in = os.path.normpath(os.path.join(tmp, offset))
    try:
        try:
            p = subprocess.run(a.command, shell=True, cwd=run_in, capture_output=True, text=True,
                               timeout=a.timeout or 1800, stdin=subprocess.DEVNULL)
            rc, out = p.returncode, (p.stdout or "") + (p.stderr or "")
        except subprocess.TimeoutExpired:
            rc, out = 124, "timed out"
        root = top if a.apply else cleanup
        now_untracked = set((_git(root, "ls-files", "--others", "--exclude-standard") or "").split("\n")) - {""}
        created = {f for f in now_untracked - untracked if not any(f == l or f.startswith(l + "/") for l in links)}
        summary, n = _change_summary(root, snap, created, skip=links, before=before)
        log(f"codemod ({'applied' if a.apply else 'dry run, nothing changed in ' + d}): exit {rc}; " + summary[0])
        for l in summary[1:]:
            log(l)
        tail = [ANSI.sub("", l) for l in out.strip().splitlines() if l.strip()][-10:]
        if tail:
            log("output (last lines):")
            for l in tail:
                log("  | " + l[:200])
        if not a.apply and n:
            log(f"apply it: lean-agent codemod {slug} {shlex.quote(a.command)} --apply"
                + (f" --dir {shlex.quote(d)}" if d != path else "") + f"; then lean-agent check {slug}")
        return 0 if rc == 0 else 1
    finally:
        if cleanup:
            _git(top, "worktree", "remove", "--force", cleanup)
            shutil.rmtree(cleanup, ignore_errors=True)
            _git(top, "worktree", "prune")


# ----------------------------------------------------------------------------------------------- slices

def plan_slices(data, by="auto", depth=2, src=None, min_shared=2):
    """{"enablers": [...], "slices": [...]}: units (routes, or folders), the files more than one of them uses
    grouped by folder (shared parts to do first), and each unit's own files."""
    files = data["files"]
    code = {f for f, i in files.items() if not i["test"] and (not src or f.startswith(src.rstrip("/") + "/"))}
    units = {}
    if by in ("auto", "route") and any(r["file"] for r in data["routes"]):
        for r in data["routes"]:
            if r["file"]:
                units.setdefault(r["route"], set()).update(closure(data, [r["file"]]) & code)
    if not units:
        for f in code:
            parts = f.split("/")
            key = "/".join(parts[:depth]) if len(parts) > depth else "/".join(parts[:-1]) or "."
            units.setdefault(key, set()).add(f)
        for k in list(units):  # a folder unit also needs what its files import
            units[k] = closure(data, sorted(units[k])) & code
    owners = collections.defaultdict(set)
    for u, fs in units.items():
        for f in fs:
            owners[f].add(u)
    shared = {f for f, us in owners.items() if len(us) >= min_shared}
    groups = collections.defaultdict(set)
    for f in shared:
        groups[_top(f, depth)].add(f)
    enablers = []
    for g, fs in groups.items():
        users = set().union(*(owners[f] for f in fs))
        enablers.append({"name": g, "files": sorted(fs), "lines": sum(files[f]["lines"] for f in fs),
                         "used_by": sorted(users)})
    enablers.sort(key=lambda e: (-len(e["used_by"]), -e["lines"], e["name"]))
    slices = []
    for u, fs in units.items():
        own = sorted(fs - shared)
        needs = sorted({e["name"] for e in enablers if u in e["used_by"]})
        slices.append({"name": u, "files": own, "lines": sum(files[f]["lines"] for f in own), "needs": needs})
    slices.sort(key=lambda s: (s["lines"], s["name"]))
    return {"enablers": enablers, "slices": slices}


def slices_report(plan, limit=60):
    out = [f"{len(plan['enablers'])} shared part{'s' if len(plan['enablers']) != 1 else ''} first, then "
           f"{len(plan['slices'])} slice{'s' if len(plan['slices']) != 1 else ''} (smallest first):"]
    for i, e in enumerate(plan["enablers"][:limit], 1):
        out.append(f"  S{i}. shared {e['name']}: {len(e['files'])} files, {e['lines']:,} lines, used by "
                   f"{len(e['used_by'])} slices")
    for i, s in enumerate(plan["slices"][:limit], 1):
        out.append(f"  {i}. {s['name']}: {len(s['files'])} own files, {s['lines']:,} lines"
                   + (f"; needs {', '.join(s['needs'][:4])}" + (" ..." if len(s["needs"]) > 4 else "") if s["needs"] else ""))
    if len(plan["slices"]) > limit:
        out.append(f"  ... {len(plan['slices']) - limit} more")
    return "\n".join(out)
