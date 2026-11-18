---
name: stats
description: Show what lean-agent sessions and workers cost (per model, role, agent and thread), the daily caps, which learned rules load, and how workers rated their briefs. Use when the user asks about spend, usage or whether the rules help.
roles: desk, thread
---

Desk: call `lean_doctor` with `action: stats` (optional `days`, default 7, max 90; `project` for one project's rules). The mod
computes everything, so one call answers: spend today and for the window with request counts, today against the daily
caps, tables by model, by role x model (a model lean-agent did not configure shows up there), by role, by agent and by
thread (top 10 and the rest), by thread model/effort (the choice each thread was started with, from the ledger rows, with
the share of thread spend from before that was recorded) and one line "threads at the default (sonnet/high): N, $X, median $Y" to judge the
default, rule loads per project (including `_project.md` and the rules that never loaded), worker
feedback and gaps, and how many ledger lines were 0.45 rows or unparsable. **Never read `~/.lean-agent/ledger.jsonl`
yourself** (it can be tens of megabytes; the mod keeps per-day totals in `rollup.json`) and never start a thread to sum it.
Show the tables as they are, then one or two sentences on where the money went (cache reads, output, an expensive model, a
thread that dominates).
Desk: `lean_doctor` `check` also names live sessions on an unexpected model.

Thread: has no `lean_doctor`; for rules call `lean_rules` `stats` (loads per rule, rules that never loaded); for spend say so
and the desk answers.

The budget is cost-only: a daily cap per role (`dailyCapUsd`) and an optional per-worker cap (`workerCapUsd`, `workerCaps`) in
`~/.lean-agent/config.json`; no plan-window percentage exists. Files, one place each: the ledger is `~/.lean-agent/ledger.jsonl`
(past months `ledger-YYYY-MM.jsonl`, 0.45 history `ledger-legacy.jsonl`; stats reads all of them, both row formats);
worker LEAN-FEEDBACK status is `~/.lean-agent/feedback.jsonl`, refused commands `refusals.jsonl`; gaps are
`~/.lean-agent/<project>/gaps.jsonl` (`~/.lean-agent/gaps.jsonl` when the project is unknown). `feedback/` and `work/*/gaps.json` are
0.45 leftovers (notes about lean-agent itself, per-run gaps): a different thing, not counted.
