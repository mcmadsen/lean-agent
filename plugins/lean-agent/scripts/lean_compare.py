"""`lean-agent compare <project>`: a clean Claude Code session in the project against lean-agent's sessions.

Overhead mode measures the first turn's input tokens of a trivial prompt (clean, one source switched off at a time,
a worker, a thread session) and reads the front desk's startup injections from the text lean-agent would inject.
Task mode runs one read-only task clean and as a lean-agent run and lets a haiku judge compare the answers.
Reports hold numbers and source NAMES only (files, servers, skills), never contents. `la` is the lean_agent module."""
import datetime
import glob
import json
import os
import re
import subprocess
import sys
import time

import usage

PROMPT = "Reply with OK."
ROWS = ("tools", "mcp", "memory", "skills", "system prompt", "messages")
LABELS = {"tools": "system tools", "mcp": "MCP tools", "memory": "memory files", "skills": "skills",
          "system prompt": "system prompt", "messages": "startup messages"}
EST_TOOL, EST_MCP_TOOL, EST_SKILL = 420, 300, 130  # tokens, used only where no flag measures the source
COLUMNS = ("clean", "worker", "thread session", "front desk")
JUDGE_PROMPT = ("Two answers to the same read-only task about a code project. Judge correctness and completeness only "
                "(not style). Reply with JSON only: {{\"winner\": \"A\"|\"B\"|\"tie\", \"reason\": \"<one sentence>\"}}.\n\n"
                "TASK:\n{task}\n\nANSWER A:\n{a}\n\nANSWER B:\n{b}\n")


def fmt(n):
    n = int(n or 0)
    return f"{n / 1000:.1f}k" if n >= 1000 else str(n)


def compare_dir(la):
    return la.home("compare")


# ------------------------------------------------------------------ running claude

def clean_env():
    """The user's normal environment without any LEAN_AGENT_* key: lean-agent's hooks stay inert."""
    return {k: v for k, v in os.environ.items() if not k.startswith("LEAN_AGENT_")}


def claude_bin():
    return os.environ.get("LEAN_AGENT_CLAUDE") or "claude"


def help_flags():
    """The long flags `claude --help` lists (the installed version decides which sources can be switched off)."""
    try:
        out = subprocess.run([claude_bin(), "--help"], capture_output=True, text=True, timeout=60, env=clean_env())
    except (OSError, subprocess.TimeoutExpired):
        return set()
    return set(re.findall(r"(?<![\w-])(--[a-z][a-z0-9-]*)", out.stdout + out.stderr))


def parse_stream(raw):
    """init event, first turn's input tokens, result totals and final text from a stream-json output."""
    r = {"init": {}, "first_input": None, "usage": {}, "cost": None, "turns": None, "answer": "", "error": None}
    for line in raw.splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if not isinstance(ev, dict):
            continue
        t = ev.get("type")
        if t == "system" and ev.get("subtype") == "init":
            r["init"] = {k: ev.get(k) for k in ("tools", "mcp_servers", "slash_commands", "skills", "model")}
        elif t == "assistant" and r["first_input"] is None:
            u = (ev.get("message") or {}).get("usage") or {}
            r["first_input"] = sum(u.get(k, 0) or 0 for k in usage.FIELDS[:3])
        elif t == "result":
            r["usage"] = ev.get("usage") or {}
            r["cost"] = ev.get("total_cost_usd")
            r["turns"] = ev.get("num_turns")
            r["answer"] = (ev.get("result") or "").strip()
            if ev.get("is_error"):
                r["error"] = str(ev.get("subtype") or "error")
    if r["first_input"] is None and r["usage"]:
        r["first_input"] = sum(r["usage"].get(k, 0) or 0 for k in usage.FIELDS[:3])
    return r


def run_claude(model, flags, cwd, env, prompt=PROMPT, max_turns=1, max_usd=0.5, timeout=240):
    cmd = [claude_bin(), "-p", "--output-format", "stream-json", "--verbose", "--model", model,
           "--max-turns", str(max_turns), "--max-budget-usd", str(max_usd), *flags]
    t0 = time.time()
    try:
        p = subprocess.run(cmd, input=prompt, capture_output=True, text=True, cwd=cwd, env=env, timeout=timeout)
        raw, err = p.stdout, p.stderr
    except (OSError, subprocess.TimeoutExpired) as e:
        return {"init": {}, "first_input": None, "usage": {}, "cost": None, "turns": None, "answer": "",
                "error": f"{type(e).__name__}", "seconds": round(time.time() - t0, 1)}
    r = parse_stream(raw)
    r["seconds"] = round(time.time() - t0, 1)
    if r["first_input"] is None:
        r["error"] = r["error"] or ("no usage in the stream: " + (err or raw)[-120:].strip())
    return r


# ------------------------------------------------------------------ memory files

IMPORT_RE = re.compile(r"(?<![\w`/])@(~?[\w./-]+\.[\w]+)")


def memory_files(project):
    """[(label, path, chars)] of the CLAUDE.md files, rules and their @imports that Claude Code loads for the project."""
    project = os.path.realpath(project)
    home = os.path.expanduser("~")
    found = []
    d = project
    while True:
        for rel in ("CLAUDE.md", "CLAUDE.local.md", os.path.join(".claude", "CLAUDE.md")):
            found.append(os.path.join(d, rel))
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    found.append(os.path.join(home, ".claude", "CLAUDE.md"))
    for base in (project, home):
        found += sorted(glob.glob(os.path.join(base, ".claude", "rules", "**", "*.md"), recursive=True))
    out, seen = [], set()

    def add(path, depth):
        path = os.path.realpath(os.path.expanduser(path))
        if path in seen or not os.path.isfile(path):
            return
        seen.add(path)
        try:
            text = open(path, encoding="utf-8", errors="replace").read()
        except OSError:
            return
        label = os.path.relpath(path, project) if path.startswith(project + os.sep) else path.replace(home, "~", 1)
        out.append((label, path, len(text)))
        if depth < 5:
            for m in IMPORT_RE.findall(text):
                add(m if m.startswith(("~", "/")) else os.path.join(os.path.dirname(path), m), depth + 1)

    for f in found:
        add(f, 0)
    return out


def skill_names(init):
    names = init.get("skills") or init.get("slash_commands") or []
    return sorted(str(n) for n in names)


# ------------------------------------------------------------------ the measurements

def merge_settings(flags, extra):
    """flags with `extra` merged into their one --settings JSON (Claude Code takes the flag once)."""
    flags = list(flags)
    for i, f in enumerate(flags[:-1]):
        if f == "--settings":
            try:
                cur = json.loads(flags[i + 1])
            except ValueError:
                cur = {}
            flags[i + 1] = json.dumps(dict(cur, **extra))
            return flags
    return flags + ["--settings", json.dumps(extra)]


def source_flags(has, mem):
    """{source: flags that switch it off} for the sources this claude version can drop; the others are estimated."""
    f = {}
    if "--tools" in has:
        f["tools"] = ["--tools", ""]
    if "--strict-mcp-config" in has and "--mcp-config" in has:
        f["mcp"] = ["--strict-mcp-config", "--mcp-config", json.dumps({"mcpServers": {}})]
    if "--disable-slash-commands" in has:
        f["skills"] = ["--disable-slash-commands"]
    if "--settings" in has and mem:
        f["memory"] = ["--settings", json.dumps({"claudeMdExcludes": sorted({p for _, p, _ in mem})})]
    return f


class Meter:
    """Runs claude and keeps the running cost against the cap."""

    def __init__(self, a):
        self.cost, self.runs, self.skipped, self.cap, self.model = 0.0, 0, [], a.max_usd, a.model

    def run(self, name, flags, cwd, env, **kw):
        if self.cost >= self.cap:
            self.skipped.append(name)
            return None
        r = run_claude(self.model, flags, cwd, env, max_usd=max(0.01, round(self.cap - self.cost, 4)), **kw)
        self.runs += 1
        self.cost += r.get("cost") or 0
        return r


def tokens_of(r):
    return r["first_input"] if r and r.get("first_input") is not None else None


def table_cell(tokens, how):
    return {"tokens": int(tokens), "how": how}


def clean_column(la, a, project, meter, has):
    env = clean_env()
    mem = memory_files(project)
    base = meter.run("clean", [], project, env)
    if not tokens_of(base):
        la.die("the clean run gave no usage" + (f" ({base['error']})" if base and base.get("error") else "")
               + "; is `claude` signed in?")
    total = tokens_of(base)
    init = base["init"]
    tools = init.get("tools") or []
    mcp_tools = [t for t in tools if str(t).startswith("mcp__")]
    builtin = [t for t in tools if not str(t).startswith("mcp__")]
    flags = source_flags(has, mem)
    rows, results = {}, {}
    for src in ("tools", "mcp", "memory", "skills"):
        r = meter.run("no " + src, flags[src], project, env) if src in flags else None
        results[src] = r
        t = tokens_of(r)
        if t is not None:
            rows[src] = table_cell(max(0, total - t), "measured")
    est = {"tools": len(builtin) * EST_TOOL, "mcp": len(mcp_tools) * EST_MCP_TOOL,
           "memory": sum(c for _, _, c in mem) // 4, "skills": len(skill_names(init)) * EST_SKILL}
    for src in ("tools", "mcp", "memory", "skills"):
        if src == "memory" and not mem:
            rows[src] = table_cell(0, "measured")
        elif src not in rows:
            rows[src] = table_cell(est[src], "estimated")
    floor = None
    if len(flags) == 4 and "--system-prompt" in has:  # every source off and a minimal system prompt: the messages alone
        ff = [x for f in flags.values() for x in f]
        floor = meter.run("floor", ff + ["--system-prompt", "x"], project, env)
    ft = tokens_of(floor)
    rows["messages"] = table_cell(ft, "measured") if ft is not None else table_cell(len(PROMPT) // 4 + 60, "estimated")
    other = sum(rows[s]["tokens"] for s in ("tools", "mcp", "memory", "skills", "messages"))
    rows["system prompt"] = table_cell(max(0, total - other), "difference")
    info = {"tools": len(builtin), "mcp_tools": len(mcp_tools), "model": init.get("model"),
            "mcp_servers": [{"name": s.get("name") if isinstance(s, dict) else str(s),
                             "tools": sum(1 for t in mcp_tools if str(t).startswith(
                                 "mcp__" + re.sub(r"[^A-Za-z0-9_-]", "_", str(s.get("name") if isinstance(s, dict) else s)) + "__"))}
                            for s in init.get("mcp_servers") or []],
            "skills": skill_names(init),
            "memory_files": [{"name": n, "tokens": c // 4} for n, _, c in mem]}
    return {"total": total, "rows": rows, "info": info, "cost": base.get("cost")}


def column_from(total, rows_known, floor_msgs, info):
    rows = dict(rows_known)
    other = sum(rows[s]["tokens"] for s in ("tools", "mcp", "memory", "skills", "messages"))
    rows["system prompt"] = table_cell(max(0, total - other), "difference")
    return {"total": total, "rows": rows, "info": info}


def lean_column(la, a, project, slug, meter, clean, has, kind):
    """worker | thread: measured total, source rows scaled/estimated from the clean column and the files lean-agent writes."""
    env = dict(os.environ)
    ci = clean["info"]
    per_tool = (clean["rows"]["tools"]["tokens"] / ci["tools"]) if ci["tools"] else EST_TOOL
    per_mcp = (clean["rows"]["mcp"]["tokens"] / ci["mcp_tools"]) if ci["mcp_tools"] else EST_MCP_TOOL
    extra = {}
    if kind == "worker":
        wd = la.home("work", "compare-" + datetime.datetime.now().strftime("%m%d-%H%M%S"))
        os.makedirs(wd, exist_ok=True)
        append, extra["cards"] = worker_append(la, slug, project)
        ap = os.path.join(wd, "append.md")
        with open(ap, "w") as fh:
            fh.write(append)
        native = la.project_rules_on(slug)
        flags = ["--setting-sources", "project" if native else "", "--strict-mcp-config", "--disable-slash-commands",
                 "--tools", la.READONLY_TOOLS + ",Bash", "--permission-mode", "default", "--add-dir", project,
                 "--append-system-prompt-file", ap]
        cwd = project
        mem_tokens = la.est_tokens(append) + (clean["rows"]["memory"]["tokens"] if native else 0)
        n_tools = len(la.READONLY_TOOLS.split(",")) + 1
    else:
        h = la.home("home")
        if not os.path.isdir(h):
            h = la.prepare_home()
        flags = merge_settings(la.session_flags(h, "thread"), {"disableAllHooks": True})
        env["LEAN_AGENT_SESSION_ROLE"] = "thread"
        cwd = la.threads_home(h)  # thread sessions run in their own folder, with the thread guide
        if not os.path.isdir(cwd):
            la.prepare_home()
        mem_tokens = sum(c for n, p, c in memory_files(cwd)) // 4
        n_tools = None
    r = meter.run(kind, flags, cwd, env)
    total = tokens_of(r)
    if total is None:
        return None
    init = r["init"]
    tools = init.get("tools") or []
    mcp_n = sum(1 for t in tools if str(t).startswith("mcp__"))
    builtin_n = len(tools) - mcp_n if tools else (n_tools or 0)
    skills_n = len(skill_names(init))
    rows = {"tools": table_cell(builtin_n * per_tool, "estimated"),
            "mcp": table_cell(mcp_n * per_mcp, "estimated" if mcp_n else "measured"),
            "memory": table_cell(mem_tokens, "estimated"),
            "skills": table_cell(skills_n * EST_SKILL, "estimated" if skills_n else "measured"),
            "messages": dict(clean["rows"]["messages"])}
    col = column_from(total, rows, None, dict(extra, tools=builtin_n, mcp_tools=mcp_n, skills=skills_n))
    col["cost"] = r.get("cost")
    return col


def worker_append(la, slug, project):
    """The system-prompt addition `run --read-only` gives a default worker for this project, and the card ids in it."""
    lib = {c["id"]: c for c in la.load_cards(slug)}
    ttype = la.task_type(PROMPT, True, False)
    cards = [c for c in lib.values() if la.is_core(c, ttype) and not c.get("archived") and not c.get("is_rule")]
    cards = [c for c in cards if not c.get("is_rule")] + la.lean_rules.pick_within_budget(
        [c for c in lib.values() if c.get("is_rule")])
    if la.project_rules_on(slug):
        cards = [c for c in cards if not la.is_rule_card(c)]
    text = la.build_append(project, cards, True, None, False, "", 0, branch_rule=False, internal=False)
    return text, [{"id": c["id"], "tokens": c.get("tokens", 0)} for c in cards]


def front_desk_column(la, a, meter, clean, thread_col):
    """No new session: the thread column's fixed part (thread guide in <home>/threads; the front desk's own guide is in <home>/home) plus
    the text lean-agent injects at start."""
    import compact_hook
    h = la.home("home")
    cps = [n for n in compact_hook.load_notes() if n.get("kind") == "checkpoint" and compact_hook.checkpoint_owner(n) == "main"]
    cp = str(cps[-1].get("text", "")) if cps else ""
    if cp:
        cp = compact_hook.cut_lines(cp, compact_hook.CHECKPOINT_CAP)
    inj = {"hand-off": la.est_tokens(compact_hook.handoff(inject=True)),
           "checkpoint": la.est_tokens(cp),
           "thread table": la.est_tokens(compact_hook.threads_summary() or ""),
           "brief (as injected)": la.est_tokens(compact_hook.brief(3000, peek=True))}
    desk = la.front_desk_file(h)
    desk_t = la.est_tokens(open(desk).read()) if os.path.isfile(desk) else 0
    if not thread_col:
        return None
    rows = {k: dict(v) for k, v in thread_col["rows"].items() if k != "system prompt"}
    home_md = os.path.join(la.threads_home(h), "CLAUDE.md")
    md_t = os.path.getsize(home_md) // 4 if os.path.isfile(home_md) else 0  # the front desk's folder holds no thread guide
    rows["memory"] = table_cell(max(0, thread_col["rows"]["memory"]["tokens"] - md_t) + desk_t, "estimated")
    rows["messages"] = table_cell(rows["messages"]["tokens"] + inj["brief (as injected)"], "estimated")
    total = (thread_col["total"] - thread_col["rows"]["messages"]["tokens"] - thread_col["rows"]["memory"]["tokens"]
             + rows["memory"]["tokens"] + rows["messages"]["tokens"])
    col = column_from(total, rows, None, {"injections": inj, "front_desk_file": desk_t})
    col["rows"]["system prompt"] = table_cell(thread_col["rows"]["system prompt"]["tokens"], "difference")
    return col


# ------------------------------------------------------------------ memory breakdown

BIG_SOURCE = 1000  # tokens: a source this large gets a suggestion line
MEM_RUNS = 30


def mem_kind(path):
    """claude-md | rule | import: what kind of document a memory file is (rules are kept, imports may become cards)."""
    base = os.path.basename(path)
    if os.sep + os.path.join(".claude", "rules") + os.sep in path:
        return "rule"
    if base in ("CLAUDE.md", "CLAUDE.local.md"):
        return "claude-md"
    return "import"


def file_sources(files, own=None, skip=None):
    """[(source dict)] of memory_files() entries; `skip`: real path left out; `own`: real path that is lean-agent's guide."""
    out = []
    for label, path, chars in files:
        rp = os.path.realpath(path)
        if skip and rp == os.path.realpath(skip):
            continue
        out.append({"name": label, "kind": mem_kind(path), "tokens": (chars + 3) // 4,
                    "own": bool(own and rp in own), "path": path})
    return out


def memory_breakdown(la, slug, project, kinds):
    """{session kind: [source]} of what each kind loads at start; a source is {name, kind, tokens, own, path?}."""
    import compact_hook
    out = {}
    h = la.home("home")
    desk = la.front_desk_file(h)
    t = la.threads_home(h)
    tguide = os.path.join(t, "CLAUDE.md")
    own = {os.path.realpath(desk), os.path.realpath(tguide)}
    threads = (la.lean_threads.load().get("threads") or {}) if os.path.isdir(h) else {}
    if "clean" in kinds:
        out["clean"] = file_sources(memory_files(project))
    if "worker" in kinds:
        native = la.project_rules_on(slug)
        src = [s for s in file_sources(memory_files(project)) if not s["name"].startswith("~")] if native else []
        append, cards = worker_append(la, slug, project)
        card_t = 0
        for c in cards:
            card_t += c.get("tokens", 0)
            src.append({"name": "card:" + c["id"], "kind": "card", "tokens": c.get("tokens", 0), "own": True})
        src.append({"name": "worker protocol (system prompt addition)", "kind": "protocol", "own": True,
                    "tokens": max(0, la.est_tokens(append) - card_t)})
        out["worker"] = src
    if "thread session" in kinds:
        src = file_sources(memory_files(t), own=own)
        line = max([la.est_tokens(f'Thread {t} "{(v or {}).get("title") or t}"') for t, v in threads.items()] or [8])
        src.append({"name": "thread line (SessionStart hook, every start)", "kind": "brief", "tokens": line, "own": True})
        sizes = []
        for t in list(threads)[-10:]:
            try:
                sizes.append(la.est_tokens(compact_hook.fresh_brief(t)))
            except Exception:  # noqa: BLE001 - a thread without a brief is left out
                pass
        src.append({"name": "thread brief (first message of a fresh session)", "kind": "brief", "own": True,
                    "tokens": max(sizes) if sizes else compact_hook.FRESH_BRIEF_TOKENS})
        out["thread session"] = src
    if "front desk" in kinds:
        src = file_sources(memory_files(h), own=own)
        cps = [n for n in compact_hook.load_notes() if n.get("kind") == "checkpoint" and compact_hook.checkpoint_owner(n) == "main"]
        cp = compact_hook.cut_lines(str(cps[-1].get("text", "")), compact_hook.CHECKPOINT_CAP) if cps else ""
        for name, text in (("checkpoint (brief at start)", cp), ("thread table (brief at start)", compact_hook.threads_summary() or ""),
                           ("hand-off (brief at start)", compact_hook.handoff())):
            src.append({"name": name, "kind": "brief", "tokens": la.est_tokens(text), "own": True})
        out["front desk"] = src
    return out


def feedback_of(la, r):
    """(used, unneeded) card ids a run recorded, or None: the run record's own field, else the LEAN-FEEDBACK line of its result."""
    fb = r.get("feedback") if isinstance(r.get("feedback"), dict) else None
    if fb is None and r.get("workdir"):
        try:
            fb = la.parse_feedback(la.run_result_text(r))[1] or None
        except Exception:  # noqa: BLE001
            fb = None
    if not fb:
        return None
    return set(fb.get("used") or []), set(fb.get("unneeded") or [])


def tool_call_text(path, cap=4000000):
    """All tool-call inputs of a transcript as one lowercase string (never stored or printed)."""
    parts, seen = [], 0
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                seen += len(line)
                if seen > cap:
                    break
                if '"tool_use"' not in line:
                    continue
                try:
                    msg = (json.loads(line).get("message") or {}).get("content")
                except ValueError:
                    continue
                for b in msg if isinstance(msg, list) else []:
                    if isinstance(b, dict) and b.get("type") == "tool_use":
                        parts.append(json.dumps(b.get("input") or {}))
    except OSError:
        return ""
    return "\n".join(parts).lower()


def headings_of(path, n=8):
    out = []
    try:
        for line in open(path, encoding="utf-8", errors="replace"):
            m = re.match(r"#{1,4}\s+(\S.{3,80})$", line.rstrip())
            if m:
                out.append(m.group(1).strip().lower())
                if len(out) >= n:
                    break
    except OSError:
        pass
    return out


def usage_evidence(la, slug, project, bykind, n=MEM_RUNS):
    """One record per distinct source: tokens, loaded_by, and used in X of N runs (cards: the recorded feedback; documents:
    whether the file name or a heading shows in the tool calls of the last N run and thread transcripts)."""
    runs = [r for r in la.ledger() if isinstance(r, dict) and r.get("project") == slug and not r.get("role")][-n:]
    fbs = [(r, feedback_of(la, r)) for r in runs]
    tpaths = []
    for r in runs:
        if r.get("session_id"):
            tpaths.append(la.service_session.transcript_path(project, str(r["session_id"])))
    try:
        for t in (la.lean_threads.load().get("threads") or {}).values():
            for sid in (list(t.get("session_history") or []) + [t.get("session_id")])[-n:]:
                if sid:
                    tpaths.append(la.transcript_of(str(sid)))
    except Exception:  # noqa: BLE001
        pass
    tpaths = [p for p in dict.fromkeys(tpaths) if os.path.isfile(p)]
    tpaths = sorted(tpaths, key=os.path.getmtime)[-n:]
    texts = [tool_call_text(p) for p in tpaths]
    srcs = {}
    for kind, items in bykind.items():
        for s in items:
            e = srcs.setdefault(s["name"], {"name": s["name"], "kind": s["kind"], "tokens": s["tokens"], "loaded_by": [],
                                            "_path": s.get("path"), "own": s.get("own", False)})
            e["loaded_by"].append(kind)
            e["tokens"] = max(e["tokens"], s["tokens"])
    for e in srcs.values():
        e.update(used=None, of=None, evidence="unknown")
        if e["kind"] == "card":
            cid = e["name"][len("card:"):]
            seen = [fb for r, fb in fbs if fb is not None and cid in (r.get("cards") or [])]
            if seen:
                e.update(used=sum(1 for u, _ in seen if cid in u), of=len(seen), evidence="run feedback",
                         unneeded=sum(1 for _, x in seen if cid in x))
        elif e["_path"] and texts:
            keys = [os.path.basename(e["_path"]).lower()] + headings_of(e["_path"])
            e.update(used=sum(1 for t in texts if any(k in t for k in keys)), of=len(texts), evidence="tool calls")
        e.pop("_path")
    return {"runs_examined": len(runs), "transcripts_examined": len(tpaths), "sources": list(srcs.values())}


def memory_suggestions(mem):
    """One line per source above BIG_SOURCE tokens that thread sessions load: keep (rules) or a card candidate."""
    out = []
    for e in sorted(mem["sources"], key=lambda e: -e["tokens"]):
        if e["tokens"] <= BIG_SOURCE or "thread session" not in e["loaded_by"]:
            continue
        ev = f"used in {e['used']} of {e['of']} runs/transcripts" if e["of"] else "usage unknown"
        if e["kind"] in ("claude-md", "rule"):
            out.append(f"thread sessions load {e['name']} ~{fmt(e['tokens'])} tokens ({ev}): keep (rules)")
        elif e["kind"] == "brief":
            out.append(f"thread sessions load {e['name']} ~{fmt(e['tokens'])} tokens ({ev}): keep (the thread's own state)")
        else:
            out.append(f"thread sessions load {e['name']} ~{fmt(e['tokens'])} tokens ({ev}): candidate for a card "
                       f"(saves ~{fmt(e['tokens'])} tokens per thread start)")
    return out


def render_memory(mem, kinds):
    rows = [("source", "tokens", "loaded by", "used in")]
    for e in sorted(mem["sources"], key=lambda e: -e["tokens"]):
        rows.append((e["name"], fmt(e["tokens"]), ", ".join(e["loaded_by"]),
                     f"{e['used']} of {e['of']}" if e["of"] else "unknown"))
    w = [min(60, max(len(r[i]) for r in rows)) for i in range(3)]
    lines = [f"Memory sources at start (last {mem['runs_examined']} runs, {mem['transcripts_examined']} transcripts examined):"]
    for r in rows:
        lines.append(f"{r[0][:w[0]]:<{w[0] + 2}}{r[1]:>{w[1] + 2}}  {r[2]:<{w[2]}}  {r[3]}")
    for k in kinds:
        lines.append(f"{k}: ~{fmt(sum(s['tokens'] for s in mem['by_kind'].get(k, [])))} tokens in {len(mem['by_kind'].get(k, []))} sources")
    return "\n".join(lines)


def memory_report(la, slug, project, kinds):
    by = memory_breakdown(la, slug, project, kinds)
    mem = usage_evidence(la, slug, project, by)
    mem["by_kind"] = {k: [{"name": s["name"], "kind": s["kind"], "tokens": s["tokens"]} for s in v] for k, v in by.items()}
    return mem


# ------------------------------------------------------------------ report

def fixed_of(col):
    return col["total"] - col["rows"]["messages"]["tokens"]


def render_table(cols):
    names = [n for n in COLUMNS if cols.get(n)]
    w = max(14, max(len(n) for n in names) + 2)

    def cell(c, row):
        if row == "Total":
            return fmt(c["total"])
        if row == "Fixed overhead":
            return "~" + fmt(fixed_of(c))
        x = c["rows"][row]
        return ("~" if x["how"] in ("estimated", "difference") else "") + fmt(x["tokens"])

    lines = [f"{'':<18}" + "".join(f"{n:>{w}}" for n in names)]
    for row in ("Total", "Fixed overhead", *ROWS):
        lines.append(f"{LABELS.get(row, row):<18}" + "".join(f"{cell(cols[n], row):>{w}}" for n in names))
    lines.append("(~ = estimated or by difference; the rest is measured from the first turn's input tokens)")
    return "\n".join(lines)


def used_runs(la, slug, server, n=30):
    runs = [r for r in la.ledger() if isinstance(r, dict) and r.get("project") == slug and not r.get("role")][-n:]
    prefix = "mcp__" + re.sub(r"[^A-Za-z0-9_-]", "_", server) + "__"
    return sum(1 for r in runs if any(str(t).startswith(prefix) for t in (r.get("mcp_calls") or {}))), len(runs)


def suggestions(la, slug, cols, task=None, memrep=None):
    out = []
    clean, wk, th, fd = (cols.get(n) for n in COLUMNS)
    if fd:
        inj = fd["info"]["injections"]
        total = inj["brief (as injected)"]
        big = max(("hand-off", "checkpoint", "thread table"), key=lambda k: inj[k])
        out.append(f"front desk start injects ~{fmt(total)} tokens: hand-off {fmt(inj['hand-off'])}, checkpoint "
                   f"{fmt(inj['checkpoint'])}, thread table {fmt(inj['thread table'])} - largest is {big}")
    if clean:
        mem = clean["rows"]["memory"]["tokens"]
        if mem and th:
            card_t = sum(c.get("tokens", 0) for c in la.load_cards(slug) if c.get("kind") in ("claude-md", "rule"))
            out.append(f"threads load project memory ~{fmt(mem)} tokens in full; cards cover ~{fmt(card_t)} of it "
                       f"({', '.join(m['name'] for m in clean['info']['memory_files'][:4])})")
        for s in clean["info"]["mcp_servers"]:
            allt = clean["info"]["mcp_tools"] or 1
            cost = clean["rows"]["mcp"]["tokens"] * s["tools"] // allt
            g, n = used_runs(la, slug, s["name"])
            if cost:
                out.append(f"MCP server {s['name']} adds ~{fmt(cost)} tokens ({s['tools']} tools) and was used in {g} of "
                           f"the last {n} runs")
        sk = clean["rows"]["skills"]["tokens"]
        if sk:
            out.append(f"skills: ~{fmt(sk)} tokens ({len(clean['info']['skills'])} listed), lean-agent loads none")
        if th and th["total"] > clean["total"]:
            out.append(f"thread sessions start at ~{fmt(th['total'])} vs {fmt(clean['total'])} clean: look at their memory "
                       "and startup messages")
    if clean and wk:
        out.append(f"a worker starts at {fmt(wk['total'])} vs {fmt(clean['total'])} clean "
                   f"({saving_pct(clean['total'], wk['total'])}% less)")
    if memrep:
        out += memory_suggestions(memrep)
    if task:
        out.append(f"task: lean-agent used {task['saving_pct']}% {'fewer' if task['saving_pct'] >= 0 else 'more'} "
                   f"sonnet-eq tokens than a clean run; judge: {task['judge'].get('winner', '?')}")
    return out


def saving_pct(base, new):
    return round(100 * (base - new) / base) if base else 0


def learned_slug(la, ref):
    projs = la.projects()
    if ref in projs:
        return ref
    hits = [s for s, v in projs.items() if os.path.basename(v["path"]) == ref or s.startswith(str(ref) + "-")]
    if len(hits) == 1:
        return hits[0]
    path = os.path.abspath(os.path.expanduser(str(ref)))
    for s, v in projs.items():
        if la.same_path(v["path"], path):
            return s
    la.die(f"project {ref!r} is not learned; compare only runs on learned projects (lean-agent learn <path>)")


def save_report(la, rep):
    d = compare_dir(la)
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, f"{datetime.datetime.now().strftime('%Y%m%d-%H%M%S')}-{rep['project']}.json")
    la.save_json(path, rep)
    return path


def latest_report(la, slug):
    files = sorted(glob.glob(os.path.join(compare_dir(la), f"*-{slug}.json")))
    for f in reversed(files):
        r = la.load_json(f, {})
        if r.get("project") == slug:
            return r
    return None


def history(la, slug=None):
    files = sorted(glob.glob(os.path.join(compare_dir(la), "*.json")))
    if not files:
        print("no comparisons yet: lean-agent compare <project>")
        return 0
    for f in files:
        r = la.load_json(f, {})
        if slug and r.get("project") != slug:
            continue
        t = r.get("totals") or {}
        print(f"{str(r.get('ts', ''))[:16].replace('T', ' ')}  {r.get('project', '?'):<24}{r.get('mode', '?'):<9}"
              f"clean {fmt(t.get('clean'))} -> lean-agent {fmt(t.get('lean'))}  saving {r.get('saving_pct', 0)}%"
              f"  cost ${r.get('cost_usd') or 0:.3f}")
    return 0


# ------------------------------------------------------------------ task mode

def task_mode(la, a, slug, project, meter):
    task = la.read_text(a.task_file) if a.task_file else a.task.strip()
    rd = la.READONLY_TOOLS
    clean = run_claude(a.model, ["--tools", rd, "--allowedTools", rd, "--permission-mode", "default"], project,
                       clean_env(), prompt=task, max_turns=a.max_turns, max_usd=a.max_usd, timeout=900)
    meter.cost += clean.get("cost") or 0
    exe = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lean_agent.py")
    t0 = time.time()
    p = subprocess.run([sys.executable, exe, "run", "-p", slug, "-m", a.model, "--why", "compare with a clean session",
                        "--read-only", "--cards", "auto", "--again", "--yes", "--max-turns", str(a.max_turns),
                        "--max-usd", str(a.max_usd), task], capture_output=True, text=True, timeout=1800)
    wall = round(time.time() - t0, 1)
    m = re.search(r"run (\d{4}-\d{6}-[0-9a-f]{4})", p.stdout + p.stderr)
    rec = next((r for r in reversed(la.ledger()) if m and r.get("id") == m.group(1)), None) or {}
    lean_answer = "\n".join(l for l in p.stdout.splitlines() if not re.match(r"^(run \d|lean-agent:|resume:|worktree:)", l)).strip()
    meter.cost += rec.get("cost_usd") or 0
    cu = int(usage.units(clean.get("usage") or {}, a.model))
    lu = int(rec.get("units") or 0)
    judge = {}
    if clean.get("answer") and lean_answer:
        try:
            jp = JUDGE_PROMPT.format(task=task[:4000], a=clean["answer"][:6000], b=lean_answer[:6000])
            jr = run_claude("haiku", ["--tools", "", "--safe-mode"], la.home("work"), clean_env(), prompt=jp, timeout=180,
                            max_usd=0.1)
            meter.cost += jr.get("cost") or 0
            jm = re.search(r"\{.*\}", jr.get("answer") or "", re.S)
            judge = json.loads(jm.group(0)) if jm else {}
        except (ValueError, OSError):
            judge = {}
    return {"clean": {"units": cu, "cost_usd": clean.get("cost"), "turns": clean.get("turns"), "seconds": clean.get("seconds"),
                      "error": clean.get("error")},
            "lean": {"units": lu, "cost_usd": rec.get("cost_usd"), "turns": rec.get("turns"), "seconds": wall,
                     "run": rec.get("id"), "status": rec.get("status")},
            "judge": {"winner": {"A": "clean", "B": "lean-agent"}.get(judge.get("winner"), judge.get("winner") or "?")},
            "task_chars": len(task), "saving_pct": saving_pct(cu, lu)}, str(judge.get("reason") or "")


# ------------------------------------------------------------------ the command

def cmd(la, a):
    if a.history:
        return history(la, learned_slug(la, a.project) if a.project else None)
    if not a.project:
        la.die("compare needs a project: lean-agent compare <project> (or --history)")
    slug = learned_slug(la, a.project)
    project = la.projects()[slug]["path"]
    if a.max_usd > 1 and not a.yes:
        la.die(f"--max-usd {a.max_usd} is over $1; add --yes to confirm")
    if a.task_file and not a.task:
        a.task = None
    meter = Meter(a)
    rep = {"ts": la.now_iso(), "project": slug, "model": a.model, "max_usd": a.max_usd}
    if a.task or a.task_file:
        print(f"compare (task mode) in {slug}: expected cost up to ${2 * a.max_usd + 0.1:.2f} "
              f"(clean run and lean-agent run capped at ${a.max_usd} each, plus a cheap judge); read-only, nothing is written")
        res, reason = task_mode(la, a, slug, project, meter)
        rep.update(mode="task", task=res, totals={"clean": res["clean"]["units"], "lean": res["lean"]["units"]},
                   saving_pct=res["saving_pct"])
        c, l = res["clean"], res["lean"]
        print(f"{'':<14}{'clean':>12}{'lean-agent':>12}")
        print(f"{'sonnet-eq':<14}{fmt(c['units']):>12}{fmt(l['units']):>12}")
        print(f"{'cost':<14}{'$%.3f' % (c['cost_usd'] or 0):>12}{'$%.3f' % (l['cost_usd'] or 0):>12}")
        print(f"{'turns':<14}{str(c['turns'] or '?'):>12}{str(l['turns'] or '?'):>12}")
        print(f"{'wall time':<14}{str(c['seconds']) + 's':>12}{str(l['seconds']) + 's':>12}")
        print(f"judge: {res['judge']['winner']}" + (f" - {reason[:300]}" if reason else ""))
        cols = {}
        rep["suggestions"] = suggestions(la, slug, cols, res)
    else:
        print(f"compare in {slug}: model {a.model}, cap ${a.max_usd}; a handful of one-turn calls (OK prompt)")
        has = help_flags()
        clean = clean_column(la, a, project, meter, has)
        cols = {"clean": clean, "worker": lean_column(la, a, project, slug, meter, clean, has, "worker"),
                "thread session": lean_column(la, a, project, slug, meter, clean, has, "thread")}
        cols["front desk"] = front_desk_column(la, a, meter, clean, cols["thread session"])
        cols = {k: v for k, v in cols.items() if v}
        print(render_table(cols))
        mem = memory_report(la, slug, project, list(cols))
        print(render_memory(mem, list(cols)))
        for k, v in cols.items():
            if k != "clean" and v["info"].get("cards"):
                print(f"worker cards: " + ", ".join(f"{c['id']} ({fmt(c['tokens'])})" for c in v["info"]["cards"][:8]))
        if meter.skipped:
            print(f"cap reached: not run: {', '.join(meter.skipped)} (rows estimated)")
        lean = cols.get("worker") or {"total": 0}
        rep.update(mode="overhead", columns={k: {"total": v["total"], "fixed": fixed_of(v), "rows": v["rows"], "info": v["info"]}
                                             for k, v in cols.items()},
                   totals={"clean": clean["total"], "lean": lean["total"]},
                   saving_pct=saving_pct(clean["total"], lean["total"]), flags_found=sorted(
                       f for f in ("--tools", "--strict-mcp-config", "--mcp-config", "--settings", "--disable-slash-commands",
                                   "--setting-sources", "--system-prompt", "--append-system-prompt-file") if f in has),
                   skipped=meter.skipped, memory=mem)
        rep["suggestions"] = suggestions(la, slug, cols, memrep=mem)
    rep["cost_usd"] = round(meter.cost, 4)
    print(f"cost of this comparison: ${meter.cost:.3f} (cap ${a.max_usd})")
    print("Suggestions:")
    for s in rep["suggestions"] or ["(nothing to suggest from these numbers)"]:
        print(f"- {s}")
    path = save_report(la, rep)
    print(f"report saved: {path} (numbers and source names only); lean-agent compare --history")
    return 0
