#!/usr/bin/env python3
"""Compact view of a big JSON result (e.g. an MCP tool output Claude Code saved to a file).

    lean-json <file> [--fields a,b.c] [--grep TEXT] [--exclude TEXT] [--max N]

Drops links, URLs, avatars, descriptors and empty values, turns identity objects into their display name,
shortens long strings, and prints one compact line per item of the main list. --fields keeps only those
(dotted) fields per item; --grep keeps items whose text contains TEXT (case-insensitive).
"""
import argparse
import json
import re
import sys

NOISE = re.compile(r"^(_links|links|url|href|.*Url|.*URL|avatar.*|image.*|descriptor|etag|.*Descriptor|"
                   r"isContainer|isDeleted|subjectKind|directoryAlias|profileUrl)$")


def load(path):
    with open(path, encoding="utf-8", errors="replace") as fh:
        text = fh.read()
    data = json.loads(text)
    # an MCP result: {"content": [{"type": "text", "text": "<json>"}]} or a list of such blocks
    blocks = data.get("content") if isinstance(data, dict) else data if isinstance(data, list) else None
    if isinstance(blocks, list) and blocks and all(isinstance(b, dict) and b.get("type") == "text" for b in blocks):
        parts = []
        for b in blocks:
            try:
                parts.append(json.loads(b["text"]))
            except (ValueError, KeyError):
                parts.append(b.get("text"))
        data = parts[0] if len(parts) == 1 else parts
    return data


def compact(v, depth=0):
    if isinstance(v, dict):
        if "displayName" in v and depth > 0 and not any(isinstance(x, (list, dict)) for k, x in v.items()
                                                       if k != "displayName" and not NOISE.match(k)):
            # an identity: just the name
            return v["displayName"]
        out = {}
        for k, x in v.items():
            if NOISE.match(k):
                continue
            x = compact(x, depth + 1)
            if x in (None, "", [], {}):
                continue
            out[k] = x
        return out
    if isinstance(v, list):
        return [y for y in (compact(x, depth + 1) for x in v) if y not in (None, "", [], {})]
    if isinstance(v, str) and len(v) > 1500:
        return v[:1500] + f"… [{len(v) - 1500} chars more]"
    return v


def main_list(data):
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        lists = [(k, v) for k, v in data.items() if isinstance(v, list)]
        if len(lists) == 1:
            return lists[0][1]
        for k in ("value", "items", "results", "threads", "data"):
            if isinstance(data.get(k), list):
                return data[k]
    return [data]


def pick(item, fields):
    out = {}
    for f in fields:
        cur = item
        for part in f.split("."):
            if isinstance(cur, list):
                cur = [c.get(part) if isinstance(c, dict) else None for c in cur]
            elif isinstance(cur, dict):
                cur = cur.get(part)
            else:
                cur = None
        if cur not in (None, "", [], {}):
            out[f] = cur
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(prog="lean-json", description=__doc__.split("\n\n")[0])
    ap.add_argument("file")
    ap.add_argument("--fields", help="comma-separated dotted fields to keep per item, e.g. id,status,comments.content")
    ap.add_argument("--grep", help="keep items whose text contains this (case-insensitive)")
    ap.add_argument("--exclude", action="append", metavar="TEXT",
                    help="drop items whose text contains this, e.g. --exclude '\"commentType\":\"system\"'")
    ap.add_argument("--max", type=int, default=200, help="at most this many items")
    a = ap.parse_args(argv)
    try:
        data = load(a.file)
    except (OSError, ValueError) as exc:
        sys.exit(f"lean-json: can't read {a.file} as JSON: {exc}")
    items = [compact(x, 1) for x in main_list(data)]
    if a.fields:
        items = [pick(x, [f.strip() for f in a.fields.split(",") if f.strip()]) if isinstance(x, dict) else x
                 for x in items]
    if a.grep:
        items = [x for x in items if a.grep.lower() in json.dumps(x, ensure_ascii=False).lower()]
    for ex in a.exclude or []:
        items = [x for x in items if ex.lower() not in json.dumps(x, ensure_ascii=False, separators=(",", ":")).lower()]
    items = [x for x in items if x not in (None, "", [], {})]
    for x in items[:a.max]:
        print(json.dumps(x, ensure_ascii=False, separators=(",", ":")))
    if len(items) > a.max:
        print(f"… {len(items) - a.max} more items (use --max or --grep)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
