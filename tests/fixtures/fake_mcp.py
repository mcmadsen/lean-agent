#!/usr/bin/env python3
"""Minimal stdio MCP server: a ticket tracker with one small and one large tool."""
import json, sys
BIG = {"type": "object", "properties": {f"field_{i}": {"type": "string", "description": "An optional filter field with a long description " * 3} for i in range(40)}}
TOOLS = [
    {"name": "get_ticket", "description": "Fetch a ticket by id from the tracker.",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}},
    {"name": "search_tickets", "description": "Search tickets with many filters.", "inputSchema": BIG},
]
for line in sys.stdin:
    try:
        msg = json.loads(line)
    except ValueError:
        continue
    if "id" not in msg:
        continue
    m, r = msg.get("method"), None
    if m == "initialize":
        r = {"protocolVersion": msg["params"].get("protocolVersion", "2025-06-18"), "capabilities": {"tools": {}},
             "serverInfo": {"name": "tickets", "version": "1"}}
    elif m == "tools/list":
        r = {"tools": TOOLS}
    elif m == "tools/call":
        tid = msg["params"]["arguments"].get("id", "?")
        r = {"content": [{"type": "text", "text": f"Ticket {tid}: Checkout total wrong when discount applied. Priority: high. CODEWORD=WALRUS"}]}
    else:
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": "no method"}}), flush=True)
        continue
    print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": r}), flush=True)
