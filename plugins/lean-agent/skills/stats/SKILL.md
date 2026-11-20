---
name: stats
description: Show what lean-agent sessions and workers cost (per model, role, agent and thread), the daily caps, which learned rules load, and how workers rated their briefs. Use when the user asks about spend, usage or whether the rules help.
roles: desk, thread
---

Desk: call `lean_doctor` with `action: stats` (optional `days`, default 7, max 90; `project` for one project's rules). The mod
computes everything, so one call answers: spend today and for the window with request counts, today against the daily
caps, tables by model with a line "opus share: x% of the window's spend (threads tN spent on opus or are on it; on opus now: ...)" (an expensive model needs the user's approval in the pane, so a high share is worth a sentence), by role x model (a model lean-agent did not configure shows up there), by role, by agent and by
thread (top 10 and the rest), by thread model/effort (the choice each thread was started with, from the ledger rows, with
the share of thread spend from before that was recorded) and one line "threads at the default (sonnet/high): N, $X, median $Y" to judge the
default, a line `output cap (7d): saved 140.0k chars in 12 results` when oversized Bash/MCP results were cut before a thread saw them, rule loads per project (including `_project.md` and the rules that never loaded), worker
feedback and gaps, and how many ledger lines were 0.45 rows or unparsable. **Never read `~/.lean-agent/ledger.jsonl`
yourself** (it can be tens of megabytes; the mod keeps per-day totals in `rollup.json`) and never start a thread to sum it.
Show the tables as they are, then one or two sentences on where the money went (cache reads, output, an expensive model, a
thread that dominates).
Desk: `lean_doctor` `check` also names live sessions on an unexpected model.

Thread: has no `lean_doctor`; for rules call `lean_rules` `stats` (loads per rule, whether loading was ever observed).
Thread: for spend, ask the desk with `lean_ask` ("spend for the last N days?"); the desk answers from its own stats.
Never read `ledger.jsonl` yourself: after a rotation it holds only the newest rows. Every stats output states its period and the
ledger files it read, and warns when `ledger.jsonl` starts inside the window.

The budget is cost-only: a daily cap per role (`dailyCapUsd`) and an optional per-worker cap (`workerCapUsd`, `workerCaps`) in
`~/.lean-agent/config.json`; no plan-window percentage exists. Files, one place each: the ledger is `~/.lean-agent/ledger.jsonl`
(past months `ledger-YYYY-MM.jsonl`, 0.45 history `ledger-legacy.jsonl`: only the 0.45 rows, today's 1.0 rows stay in `ledger.jsonl`; stats reads all of them, both row formats);
worker LEAN-FEEDBACK status is `~/.lean-agent/feedback.jsonl`, refused commands `refusals.jsonl`; gaps are
`~/.lean-agent/<project>/gaps.jsonl` (`~/.lean-agent/gaps.jsonl` when the project is unknown). `feedback/` and `work/*/gaps.json` are
0.45 leftovers (notes about lean-agent itself, per-run gaps): a different thing, not counted.
