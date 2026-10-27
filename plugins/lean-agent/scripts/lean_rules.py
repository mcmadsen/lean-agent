"""User rules ("never use X, use Y instead"): classification, matching and near-duplicate detection.

A rule is a memory/card of kind feedback or rule, or one whose text is a prohibition (never / don't / do not /
must not / avoid / not to be used) next to a use/call/run phrase. It carries `targets` (the forbidden MCP
servers, CLIs, tools or commands) and an `alternative` when the text names one.
"""
import re

RULE_TOKENS = 400  # token budget for the rules sent with every worker, advise and brief

PROHIBITION = re.compile(r"\b(never|don'?t|do\s+not|must\s+not|mustn'?t|should\s+not|shouldn'?t|avoid|"
                         r"not\s+to\s+be\s+used)\b", re.I)
USE_PHRASE = re.compile(r"\b(?:use|using|used|call|calling|run|running|invoke|invoking)\s+"
                        r"((?:(?:the|a|an|any|our)\s+)*)([^.;:\n]{1,80})", re.I)
INSTEAD = re.compile(r"\b(?:instead\s+of|rather\s+than)\b", re.I)
STOP = {"the", "a", "an", "any", "our", "it", "this", "that", "mcp", "cli", "server", "servers", "tool", "tools",
        "command", "commands", "and", "or", "to", "for", "of", "in", "on", "with", "when", "if", "instead", "again",
        "from", "by", "at", "as", "into", "them", "these", "those", "anything", "something", "more", "less", "first", "only", "directly"}
FIRST_PERSON_ONLY = {"tests", "test", "time", "care", "forget", "sure", "mock", "mocks"}


def _clean(tok):
    return tok.strip("`'\"()<>[]{},!?*_ ").lower()


def _phrase_target(phrase):
    """The name a use-phrase is about: its first meaningful word (`the tracker MCP server` -> tracker)."""
    for tok in phrase.split():
        t = _clean(tok)
        if t and t not in STOP:
            return t
    return ""


def _phrase_alt(phrase):
    p = re.split(r"\s+(?:instead|because|since|which|as\b)|[,(]", phrase, maxsplit=1)[0]
    return p.strip(" `'\"")[:60]


def classify(text, mtype="project"):
    """{"rule": bool, "targets": [...], "alternative": str} for one memory / card text."""
    text = text or ""
    targets, alternative = [], ""
    for m in USE_PHRASE.finditer(text):
        before = re.split(r"[.;\n]", text[max(0, m.start() - 60):m.start()])[-1]
        forbidden = bool(PROHIBITION.search(before)) and not re.search(r"\binstead\s+of\s*$", before, re.I)
        name = _phrase_target(m.group(2))
        if forbidden:
            if name and name not in targets and name not in FIRST_PERSON_ONLY:
                targets.append(name)
        elif not alternative:
            alternative = _phrase_alt(m.group(1) + m.group(2))
    # "use X instead of Y": Y is forbidden, X is the alternative
    for m in re.finditer(r"\b(?:instead\s+of|rather\s+than)\s+(?:(?:the|a|an|any|our)\s+)*([^.;:,\n]{1,60})", text, re.I):
        t = _phrase_target(m.group(1))
        if t and t not in targets:
            targets.append(t)
    prohibited = bool(targets) and bool(PROHIBITION.search(text) or INSTEAD.search(text))
    rule = mtype in ("feedback", "rule") or prohibited
    if not rule:
        return {"rule": False, "targets": [], "alternative": ""}
    alt_name = _phrase_target(alternative)
    targets = [t for t in targets if t != alt_name]
    return {"rule": True, "targets": targets, "alternative": alternative}


def _forms(name):
    n = re.sub(r"^plugin:", "", (name or "").lower())
    parts = [p for p in re.split(r"[:_\-./\s]+", n) if p]
    forms = {n, "".join(parts)}
    forms |= {p for p in parts if p not in ("mcp", "plugin", "server")}
    forms.add("-".join(p for p in parts if p not in ("mcp", "server")))
    return {f for f in forms if f}


def matches(target, *names):
    """True when a rule target names one of the server names/aliases/tools given."""
    t = _clean(target)
    if not t:
        return False
    tf = _forms(t)
    return any(tf & _forms(n) for n in names if n)


def tokens(text):
    return set(re.findall(r"[a-z0-9]+", (text or "").lower()))


def similarity(a, b):
    ta, tb = tokens(a), tokens(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def near_duplicate(new_text, new_title, old_text, old_title, new_targets=None, old_targets=None, threshold=0.75):
    if sorted(new_targets or []) != sorted(old_targets or []):
        return False
    return (similarity(new_text, old_text) >= threshold
            and bool(new_title) and similarity(new_title, old_title or "") >= threshold)


def pick_within_budget(rules, budget=RULE_TOKENS):
    """Newest, most specific (most targets) first, as many as fit `budget` tokens. rules: dicts with tokens/updated/targets."""
    ordered = sorted(rules, key=lambda c: (c.get("updated") or "", len(c.get("targets") or [])), reverse=True)
    ordered.sort(key=lambda c: not c.get("targets"))  # rules with targets before general feedback (stable)
    out = []
    for c in ordered:
        if c.get("tokens", 0) <= budget:
            out.append(c)
            budget -= c.get("tokens", 0)
    return out


def rule_line(c):
    text = " ".join((c.get("text") or "").split())[:200]
    alt = c.get("alternative")
    return f"Rule: {text}" + (f"; use {alt}" if alt and alt.lower() not in text.lower() else "")
