---
name: budget
description: Show lean-agent's usage tokens (the current 5 h window, all time, per thread) and set the optional token caps. Use when the user asks about remaining budget, usage or wants to change a cap.
argument-hint: [show | cap <tokens>]
roles: desk, thread
---

lean-agent counts usage in **usage tokens** (weighted: input + 1.25 x cache write + 0.1 x cache read + 5 x output; `budget.weights` moves the factors), never in dollars: the limit of a plan is its 5 h and 7 d windows.
Two scopes: the **current window** (since the window's reset time minus 5 h; a rolling 5 h when the engine reports none) with the percentage the engine reports, and **all time** since `budget.since` (default: the first usage lean-agent has).
Desk: `lean_doctor` `stats` shows both, per desk, per thread and per kind (main, reviewers, workers, readers), with the raw token sums next to the weighted ones; never read the ledger yourself. Desk: `lean_doctor` `budget-reset` (or `lean_config set budget.since today`) starts the all-time count again.
Thread: for usage, ask the desk with `lean_ask`. A thread's figure counts ONLY its own sessions (its restarts and subagents, from its creation on), never the desk's or another thread's.
The main control is the window percentage: `window.throttleAbove` (70), `window.blockAbove` (92), `window.capFiveHourPct` (none). The token caps are optional extras, all off by default: `budget.windowTokens` (per current window) and `budget.allTimeTokens` (since `budget.since`) hold all new work at the cap, with a desk notice at 80% and 100%; `threads.softTokens` (one nudge at 80%, one desk notice at 100%, the thread goes on; desk: `lean_thread` `budget` `tN` `2m` sets one thread's own), `threads.hardTokens` (a real stop: the thread is told to report and stop, its new Agent calls are refused); `review.askAboveTokens` and `review.maxTokens` for the size of a review fan-out.
Old dollar keys (`dailyCapUsd`, `workerCapUsd`, `workerCaps`, `budget.daily`, `budget.threadDaily`, `threads.softUsd`, `threads.hardUsd`, `review.askAboveUsd`, `review.maxUsd`) are no longer used and enforce nothing. Desk: `lean_config validate` names them, `lean_config unset <key>` removes them. An estimate at API list prices is one optional line of `lean_doctor` `stats` (`stats.showUsd`).
To change a cap, thread: report to the desk what to change (a thread never edits `config.json`); desk: `lean_config set budget.windowTokens 5000000` (`lean_config unset <key>` removes a cap; the review caps are safety settings: the user's typed `/lean-agent:config review.maxTokens 10000000` or an Approve on the question the tool returns).
