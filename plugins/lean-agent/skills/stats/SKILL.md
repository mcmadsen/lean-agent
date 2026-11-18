---
name: stats
description: Show what lean-agent sessions and workers cost (per model, agent and thread), which learned rules load, and how workers rated their briefs. Use when the user asks about spend, usage or whether the rules help.
---

Read `~/.lean-agent/ledger.jsonl` (one JSON line per model request: `ts`, `role`, `tN`, `agent`, `model`, `in`, `out`,
`cache_read`, `cache_write`, `usd`). Sum `usd` for today and for the last 7 days, and per model, per `agent`
(missing = the main loop) and per `tN`. Show a short table, then one or two sentences on where the money went (cache
reads, output, an expensive worker model). The budget is cost-only: a daily cap per role (`dailyCapUsd`) and an
optional per-worker cap (`workerCapUsd`, `workerCaps`) in `~/.lean-agent/config.json`; no plan-window percentage exists.

For rules, call `lean_rules` `stats` (loads per rule, rules that never loaded). `~/.lean-agent/feedback.jsonl` holds each
worker's LEAN-FEEDBACK status; `gaps.jsonl` the context it had to discover.
