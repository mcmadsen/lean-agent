# Changelog

## Unreleased

### Fixed
- **Automatic context restart no longer fails while the thread is running** (1.0.19 field: three times "tN is running: no new session started" at 124k of 120k, a manual `restart` right after worked). The timer now stops a session that still shows as working exactly as the manual restart does (the hard stop already refuses its tool calls), under the same grace rule (idle 20 s, or `threads.stopGraceMinutes` after the record). A failed automatic restart is retried at every timer tick (at most 5 tries), then ONE desk notice names the reason and offers `restart`.
- **Hard stop**: a spec pins that the 2nd, 3rd... turn end over the limit writes no further record and that every tool call but `lean_report` is refused; a turn end without an engine session id no longer writes a record every turn (it falls back to the thread's recorded session).

- **"Done" before the output existed.** A done report is checked by script before it counts: every path in its text that looks like an output file (absolute or `~/...`, with an extension, after words like saved / written / created / at / in, or in backticks) must exist. A missing one makes `lean_report` refuse the done state ("not done: <path> does not exist; write it (a worker's 'written' is not proof) or drop the claim"), recorded in the refusal record (rule `done-output-missing`); nothing reaches the desk, so the auto-close never sees a done report that failed. URLs, paths next to "deleted / removed / renamed" and files git tracks as deleted are not claims.

### Added
- **Stall watchdog.** A thread whose session is alive and working but made no tool call and no report for `threads.stallMinutes` (default 20), or whose queued messages stayed unread that long, is `stalled`: red in the pane and in `lean_thread list` (which names the last activity time), ONE desk notice + toast per stall ("t7 has done nothing for 25 min, 3 messages unread: wake or restart it"), and a reminder line in the desk's context once per desk turn while it lasts. The thread's own hooks write `activity.json` in its folder (tool calls of the thread or of its workers, reports, prompts), so a thread waiting on a worker that still works is not stalled; a session waiting for your answer never is. `threads.stallRestart` (default false): when true the mod restarts a stalled thread itself (same path as the context restart) and says so.

## 1.0.19

### Fixed

- **A thread stops working once it has checkpointed** (field, 1.0.18: a thread past `threadTokens` 120k kept working and reported the checkpoint again at
  123k, 130k, 137k, 143k; the desk restarts only an idle session, and a thread that keeps taking turns is never idle). At or over `threadTokens` (the
  size at a turn end, and `$.session.usage()` every 10 tool calls of a long turn) the mod writes the snapshot and ONE record per session, then refuses
  every tool call of the thread itself but `lean_report` ("context limit reached (123k of 120k): your state is saved. End your turn now; ..."; refusal rule
  `context-limit`). Running workers finish; their results go into the snapshot's pending results, not acted on. A thread whose last report is a question or
  `blocked` may still ask and report. The desk restarts it as soon as its session is idle (20 s) or `threads.stopGraceMinutes` (default 3) after the
  record, even if it still shows as working; a later turn end over the limit no longer drops the restart. The loop guard stays (one automatic restart per
  thread per 10 minutes; a fresh session that starts over the limit asks you). Done / blocked / question threads are stopped the same way and not restarted.
- No checkpoint chatter: the thread guide and the `lean_report` description say the mod reports it; a `lean_report` that is only a checkpoint / context notice
  is accepted once, then answered with the stop line.

### Changed

- Leaner threads: the pane / list show the growth per turn (`ctx 96k/120k, +4k/turn`, last 20 turn-end samples in `context.json`); `lean_doctor context tN`
  names the top three sources with one fix each; `threadTokens` 120000 / `threadWarnTokens` 100000 unchanged, README says it can be raised (160000) and what
  that costs per request. Not changed: a BACKGROUND worker's result notification is not cut to the job schema (no hook sees it; only a foreground result is).
- Measured base of a session (haiku, one word, input + cache read + cache creation): plain folder, all built-in tools 42,044 · `--tools Agent,Bash,Read`
  10,230 · `--tools ''` 3,730 · thread folder as is 47,133 · thread folder `--tools Agent,Bash,Read` 19,779. `config threads.tools` (array) adds `--tools` to a
  thread's fresh start, automatic restart and resume (ignored with `lean.orchestrate: false`). A subagent can only use the tools its parent
  has (measured: a worker under `Agent,Bash,Read,Skill,SendMessage,TaskStop` has no Write), so threads now start with a default list that keeps workers
  working: `Agent, Bash, Read, Edit, Write, Grep, Glob, Skill, SendMessage, TaskStop, ToolSearch, WebFetch, WebSearch` (a real thread folder: 47.1k -> 31.0k,
  about 16k less on every request); `threads.tools: []` or `"all"` brings the full set back. `permissions.deny` does not remove a tool from the request.
- `lean_doctor overhead [tN]` shows the REAL base (the first request of a session transcript) next to the text estimate; a thread session's mod records its
  first request (`base.json`) and the start reply of a thread says the measured base.

## 1.0.18

### Changed

- **Workers may read and edit, readers read; only the desk and the threads orchestrate.** No `allow-edit` / `allow-cmd` grant is needed any more.
  `lean-agent:worker-*`: Edit / Write anywhere Claude Code's own permission check allows, except lean-agent's own state under the lean home (config.json,
  projects.json, grants, approvals, review records, other threads' folders) and permission / settings files; Bash is not limited by our command rules.
  `reader-*` and the explorer: any read tool and any shell read (pipes included), but no file written outside a temp folder (a redirect, `tee`, `sed -i`, `rm`,
  `git commit` ... are refused). The reviewer and the auditor stay on the read-only command list (their verdicts must be trustworthy; the auditor now has the
  readers' wide read commands). Never, for any subagent: `git push`, tags, releases, a forge write (`gh` / `az`), a change of permissions or settings.
- `allow-edit:` / `allow-cmd:` lines in a brief (and `allowEdit` / `allowCmd` on `lean_thread new`) are accepted and ignored: never a refusal. `allow-mcp:`, `job:`,
  the step budgets, the result schema, the worker count, the retry rule and `why-sonnet` are unchanged. The grants-did-not-arrive fallback (`grant-lost`) and the
  `grant-missing` / `grant-mismatch` refusals are gone. Agent descriptions, the thread template, the thread and worktree skills say "workers may read and edit".
- Every place that asks for the foreground says: set the Agent parameter `run_in_background` to the boolean false (never the string); a worker that still starts
  in the background is fine: wait for its result notification, do not poll or duplicate the job.

### Fixed

- A dead end when the permission check denies a worker call (field: Claude Code's auto mode classifier, "[Destructive or Unwanted Actions]"; our guard refused
  the thread's own edit, so nothing could land). The engine's `PermissionDenied` event (it carries `tool_name`, `tool_input`, `tool_use_id`, `reason`; it fires after
  auto mode classifier denials per Claude Code's changelog; this hook only records and never answers `retry`) and, as a fallback, a failed Agent result whose text
  says the permission check / classifier denied it, record the denial: the thread's own Edit / Write on the paths that brief named (and its small reads there) are
  allowed for the session, the thread is told "do this one step yourself", and a `delegation-denied` refusal row is logged for the feedback export. No permission
  is changed; the engine's own check still judges each edit.
- A thread's own read-only git (status, log, diff, show, branch listing, rev-parse, merge-base, worktree list, ls-files) and `ls` in its registered worktrees and
  project repos are allowed (the readers' read-only flag checks; the Bash result cap applies), so it does not spawn a reader for a diff.
- A thread that reported done while a background worker's notification is pending showed `running`; the pane and `lean_thread list` now say `done (finishing)`
  when the last report is done and the session's status is idle.

## 1.0.17

### Fixed

- Auto mode (Claude Code) refused every worker call: "auto mode classifier gave no verdict ... a hook changed this call's input after auto mode
  reviewed it", and the identical reissue was then refused by the duplicate guard. 1.0.16 handed the Agent call on with `run_in_background: false`
  (the foreground rewrite for lean-agent types and the auditor). **No tool.call hook changes a call's input any more** (a spec fails if one does);
  the foreground is asked for instead: the agent descriptions, the step hint, the audit brief and the thread template say "pass
  `run_in_background: false`". A background worker still works (its result is cut to the job schema when it arrives, grants survive the launch);
  a background auditor's verdict goes through `record-audit`.
- The retry guard ("this exact job already ran once / a third identical try is refused") counted a call when it was issued. It now counts only a
  worker that RAN (a real result, or a background launch accepted): a call our guard denied, the permission check or the classifier rejected, or
  that errored before a worker started uses no try, no slot and leaves no grant entry. Two real runs still refuse the third identical one.

## 1.0.16

### Fixed

- Hotfix (blocked all delegated edits): a worker's `allow-edit` / `allow-cmd` / `allow-mcp` grant, its job type, its worker slot and its step budget were
  tied to the thread's Agent CALL, but subagents run in the background by default and the call returns at once, so the grant was deleted before the worker
  acted (every edit refused, resumed workers ended without a report, auditor verdicts lost). They now live as long as the SUBAGENT: a background launch
  binds the grant to the agent id from the result (`async_launched`) and `classic.SubagentStop` releases it (and the slot and the step count); a foreground
  call releases at return; a resumed worker (same id) keeps its grant; stale entries (older than `grants.ttlMinutes`, default 120, or from another session)
  are dropped at session start and on every write.
- A thread's Agent call for a `lean-agent:*` type is handed on with `run_in_background` false (undefined or true), so the result comes back in the call and
  the result schema and cap apply; the grant, slot and budget hold even when the engine ignores that.
- Grants and edited paths are compared the same way: both by the real path of the deepest existing parent (symlinks, `/private/tmp`, `..`, doubled and trailing
  slashes, `~`, a file not yet created, a file grant versus a directory grant, case-insensitive file systems). The refusal says which it is: `no grant is
  recorded for this worker (granted on the call: none found)` (rule `grant-missing`) or `the path <p> is not within the granted roots: <roots>` (`grant-mismatch`).
- Fail fast instead of a retry spiral: after 2 worker edits are refused inside a root the thread granted, the next refusal and the thread's next worker Agent call
  say `grants are not reaching workers (lean-agent bug or a version mix): do this edit yourself now`; the thread's own edit under those roots is allowed for the
  rest of the session (refusal row `grant-lost`).

## 1.0.15

### Added

#### Measured first: why a thread gets blocked

Read-only measurement before any code, from the feedback exports on hand (7 distinct files, 2026-11-18 to 2026-11-20, lean-agent 1.0.5
to 1.0.12; one of them was exported twice, byte for byte, and is counted once) and from the guard, the specs and the skills. A refusal
row in an export keeps the agent type, the refused program (first word) and the reason, not the whole command. The exports are the
user's and private: no text of them is copied here, the examples below are synthetic.

| Kind of block | Source | How often in the data | Avoidable? | Fix |
|---|---|---|---|---|
| A reader / reviewer / explorer subagent refused a shell command (`reader-sonnet` 26, `reviewer` 42 of 68) | lean-agent guard, `tool.call` refusal | 68 of 78 guard refusals. 63 carry the 1.0.5 to 1.0.9 wording ("only its built-in read-only git commands"): readers could not read enough, fixed since 1.0.9 and widened in 1.0.14 (globs, `2>/dev/null`, `rg` with no path, `sort`, `uniq`, `cut`, `tr`, `nl`). The 5 on 1.0.12: `cd` x3, `rg` x2 (one "shell form", one "flag / path / operand") | Mostly fixed. What is left refuses on purpose: `cd`, any other redirect, `;`, `&&`, `$(...)`, `xargs`, a path outside the roots. The two `rg` rows may be commands 1.0.14 allows now (the export does not keep the command) | None new: the refusal text names the program and the reason; `lean_doctor refusals` (this release) groups them with a one-line fix and the doctor says when one repeats |
| The desk was refused a command in strict mode ("route this to a thread") | lean-agent guard, the desk | 10 of 78 (4 + 4 + 2 over three exports; 2 of them a Read outside `~/.lean-agent`) | Yes, by routing: the desk does not run things | The desk guide already says route; `lean_doctor refusals` shows it. The `pr` skill's desk steps were fixed earlier (every step names its role) |
| A worker's edit refused as outside `allow-edit` | lean-agent guard | 0 in these exports (the code path exists; 1.0.14 added the "stop and report that exact path" text) | Yes: a thread that names too few paths | Grants up front: `lean_thread new` takes `allowEdit` / `allowCmd`, the brief carries them, and the thread guide tells the desk to name a path outside the worktree (a repo's `.claude/skills/...` file is the usual one) |
| A subagent cap asked the user ("may I run the review passes?") | A cap in the user's own CLAUDE.md read by the thread (policy rule), plus lean-agent's `agents.cap` | 1 report (a thread counted the push gate's reviewer passes against a cap of 4) | Fixed in 1.0.13 / 1.0.14: reviewer passes and the second-opinion reader are exempt and the guide says so | None new |
| A remote write by a thread: an Azure DevOps work-item update, a PR thread reply (a script POSTing the comment) | Claude Code permission check / auto-mode classifier, not lean-agent | 2 blocked reports from one thread in one day | Yes, and only here: the thread cannot get past the classifier and a hook cannot carry the desk's yes (1.0.14) | Typed desk-executed actions (this release): the thread asks with `lean_report` `action`, the user decides through the desk, the mod performs exactly the approved write. NOT covered: the same script also PATCHed the PR thread's status (fixed / closed) after replying; that is outside the five kinds and stays a manual step (reported, not built) |
| `git push` / `gh pr create` by a thread | Claude Code auto-mode classifier (the guard also refuses it with the push-gate text) | 1 denied push, 1 push refused because the worktree was not registered | By design: the push gate is the desk's, after a green review and the user's yes | None new. The thread guide already says "report ready to push"; the denied push was a thread trying it anyway |
| Not a permission block at all (reported as `blocked`): an MCP server not signed in (2), a worktree registry slot taken (1), a thread that did not post a reply because the user's own rule says "only after a first-attempt green" (1) | The environment, the registry, a policy rule in the user's project CLAUDE.md | 4 | The policy rule is right and stays; the other two are setup | None: the doctor row and the worktree skill cover them |

Read from this: the avoidable blocks are the classifier's denials of remote writes (the only kind a user had to answer in the thread's
own session), and the grants a thread forgot. Nothing in settings.json was widened and the guard was not widened for anything that
writes or runs a program. A harmless class the classifier keeps denying, other than the five write kinds below: none showed up in
the data (the PATCH of a PR thread's status above is a write, not a harmless read).

- **Typed desk-executed actions: a thread's remote write is approved at the desk and sent by the mod.** `lean_report` takes
  `action: {kind, params, why}` (state blocked) for five kinds only, from a fixed table in `hooks/deskactions.ts`: `ado-pr-reply`,
  `ado-pr-comment`, `ado-workitem-comment`, `ado-workitem-update` (fields `state`, `assignedTo`, `tags`, `title`) and `gh-pr-comment`.
  An unknown kind or param is refused with the list; no command, no push, merge, delete or settings change. The mod stores the request
  signed (HMAC with the review key), with the exact rendering (method, URL, body) and its sha256; the pane's "Needs you" shows the
  exact text with Approve / Deny (two presses), the desk's inbox line says what to do. `lean_thread action-list` prints the question
  to ask; the desk asks the user with AskUserQuestion (request id, check code and exact text in the question; options Approve, Deny,
  Edit first); the desk's `tool.call` hook reads the user's answer from the tool's own result and records it for that one request.
  `lean_thread approve-action <id>` (desk only) is refused unless a signed human Approve for that id and text is on record, the request
  is under 2 h old and unused, and the text derived again from the params has the signed check code; single use. The mod sends it:
  Azure DevOps through `az account get-access-token` and `curl` with the token and body on stdin (never in argv, a log or an output),
  GitHub through `gh api`; it records the result in the thread's `history.jsonl` and messages the thread. A failing send leaves the
  request approved and unused and says why; a connection that broke mid-request is marked used and reported as unknown. Specs with canned
  `az` / `curl` / `gh` output for every kind, the answer binding, forged and model-made approvals, a changed text, replay, expiry,
  another thread's request, the token never in argv or output, and failing executors. New modules `hooks/deskactions.ts`,
  `hooks/refusals.ts`. See [README](README.md#remote-writes-go-through-the-desk-typed-actions).
- **`lean_doctor refusals`**: the guard's recorded refusals (the rows the feedback export lists under "Guard refusals") grouped by
  pattern with a count and a one-line fix (a grant the brief should have given, a command the readers lack, a path a worker needs), and a
  `note top refusals` doctor row when one pattern repeats (config `refusals.repeat`, default 3).
- **Grants up front**: `lean_thread new` takes `allowEdit` (absolute paths at least two levels deep) and `allowCmd` (plain read-only
  commands); they become `allow-edit:` / `allow-cmd:` lines at the end of the thread's brief, which the thread copies into its workers'
  Agent prompts. A relative path, `..`, a path that is too wide, a comma or a shell form is refused before anything is created.

- **Execution model** (`lean.orchestrate`, default on; see [README](README.md#execution-model)): the guard makes the desk a router
  (project reads, searches, edits and Agent are refused: "the desk routes: …"; its tool results are cut to `deskToolResultChars`), a
  thread an orchestrator (own Edit/Write on project files, greps and most Bash refused; `threads.directReads` small direct reads per
  turn), and every other step one small, haiku-by-default worker job: `why-sonnet:` line for sonnet, brief ≤ `workers.briefChars`,
  `workers.steps` tool calls per worker, `threads.workers` at once, a worker never spawns workers, Agent results cut to
  `agentResultChars` with the full text saved. Small workers and reviewer passes are exempt from the user's `agents.cap`.
- `lean_run`: test / build runs with the output in a file; the thread gets exit code, failing test names and the last 40 lines.
- `hooks/preflight.ts`: the preflight pack (`preflightText`) of a thread's fresh start, computed by script.
- `lean_doctor context`: tokens by tool and size bucket, the top 10 results, delegated against direct, Haiku share, from the transcript.
- Worker and reader agent definitions: one step, `split: <rest>`, ≤ 30 lines, no nested agents.
- **Fixed overhead** (see [README](README.md#fixed-overhead)): `lean_doctor overhead` measures what each role's request carries before any
  work (template, agent definition, skills listing, lean-agent tool schemas; with a transcript the first request and the MCP share).
  `hooks/leantools.ts`: `deskSettings()` / `threadSettings()` / `mergeSettings()`, the settings that remove tools the desk and a thread
  never use (deny rules, engine `env` switches); a connector or MCP server of the project is never disabled for a thread. Worker and reader
  agents carry `maxTurns`.
- **MCP opt-in per job**: a brief line `allow-mcp: <server>` grants one server's read-only tools to `lean-agent:reader-mcp` for that job;
  other servers, write tools (`allow-mcp-write` needs the user's approval) and calls without a grant are refused; the result goes through the
  output cap.
- **Job types**: `job: lookup|edit|run|check` as the first brief line: return schemas enforced by script (result cut and marked), step
  budgets 5 / 8 / 3 / 5 (`workers.stepsByJob`, `workers.steps` the ceiling, `workers.requireJob`), and a retry rule per (thread, brief):
  the second identical brief needs `why-sonnet:`, the third is refused.

The store is the memory: a session started from scratch knows what it needs from the old one through lean-agent, so sessions stay small
and replaceable. All by script, no model turn.

- State snapshot: at every main-thread turn end the thread's own mod writes `<thread folder>/state.json` atomically (branch, HEAD,
  `git status --short`, diff stat, files edited this turn, task list, last report, open questions, context tokens). The handover carries it
  as "State at the end of the last turn"; a `preflightText` provider registers with `setPreflight` (handover.ts).
- `lean_doctor handover tN` prints exactly what a fresh session would get: the sections with their token sizes and what is missing (no goal,
  no notes, no snapshot). The handover is trimmed to config `handoverTokens` (default 6000), the least needed first, newest kept; every
  cut line names the file with the full text.
- Automatic restart at the context limit: at a turn end over `threadTokens` with work left (not after done, blocked or a question) the
  thread's mod writes the snapshot and a mod-authored record to the desk inbox; the desk's 30 s timer restarts the thread by script once its
  session has been idle 20 s (fresh session, task-first prompt, old session removed), with a notice and a toast with size and estimated cost.
  Never mid-turn, one automatic restart per thread per 10 minutes, a fresh session that starts over the limit stops and asks the user, only
  while the desk runs. Config `threads.autoRestart` (default true). The check at the next message stays.
- `lean_thread find <words|PR|branch|project>` (script search over titles, goals, branches, reports, notes, remembered items and snapshots),
  `lean_thread ask tN "<q>"` (from the store by script when lines match, else a FRESH haiku/low session with the handover, config
  `ask.model` / `ask.effort`; the big old session is never resumed) and `lean_thread report tN` (state, sha, review verdict, open
  questions, counts, path of the full text).
- Plan window: sessions snapshot `rateLimits` to `desk/windows.json`; `lean_doctor stats` leads with "5h window: 78% used, resets 14:20 (in
  1h 13m) | 7d: 41%" and the snapshot age (`windowLine(h)` is exported from stats.ts for the pane); the desk notices at 80 % and 90 % once
  per window, naming the working threads; above config `window.holdAbove` (default 85) `new` and `start` replies carry a warning.

- **Every review runs through `lean-agent:review`, with evidence.** `lean_thread new` takes `review: {pr | branch | sha, base?}` (and
  `project`): it starts a review thread whose brief the mod builds from `templates/review-brief.md` (load the skill, prepare at level full,
  run the passes, record, report); sonnet / high by default, a haiku is raised to sonnet and the reply says so. A kind-review thread
  cannot report `done` unless a signed `lean_review` record of the full level exists for the sha it prepared; the mod appends the evidence
  (record sha, level, passes, per-pass verdicts, findings by severity) from the store to the report itself
  (`reviewkind.ts`, `reviewevidence.ts`; the gate runs in `register.tsx` before `lean_report`).
- **External review.** `lean_review prepare` takes `ref` (a PR number or URL, a branch, a tag or a sha of the project's origin) and reads it
  read-only: the mod fetches the ref and the base into its own scratch repository and never touches the user's tree or refs.
  `record` with `mode: "external"` is never green and says it never counts for the push gate (`reviewext.ts`; skill section "External review").
  The record now also keeps `level`, `verdicts` and `counts` (display data, not signed).
- **Direct calls.** `/lean-agent:review <pr|branch|sha|url> [base]` on the desk starts the review thread, in a thread it reviews the
  worktree as before (the skill is offered to both roles, body by role). `/lean-agent:list` lists threads (`/lean-agent:threads` stays as an
  alias). `handover`, `rules-pr` and `review-learn` are offered on the desk too (they route to a thread); `stats`, `doctor`, `budget` and
  `scripts` got an argument-hint. The skills contract checks that every desk skill and command has a description and an argument-hint, and
  understands `## Desk` / `## Thread` sections.
- **Coaching tips.** `hooks/intents.ts` is a table (regex -> command + example); when what the user typed to the desk matches, the turn gets one
  line to add to the reply ("Tip: do this directly with /lean-agent:review <pr>"): at most once per command per day, silent for 7 days after
  the user used that command directly, one per turn, desk only, config `tips` (default on, `false` switches it off). The table decides,
  never a model, and a tip never blocks anything.
- **Dismiss.** `lean_thread dismiss tN` and a two-press **Dismiss** button on a blocked card record in `history.jsonl` that the user
  acknowledged that blocked report: the notice and the blocked badge go until a NEWER blocked report arrives; the report stays in the inbox.

- **Refusals and missing tools are feedback.** Every refusal path of this release writes ONE record through ONE helper (`feedback.ts`
  `logRefusal`): role (desk, thread, worker), rule id, short text, running version, into the file the feedback export reads. Rule ids:
  `desk-routing`, `thread-orchestrate` (own edit, read, grep), `worker-step-budget`, `brief-too-long`, `why-sonnet-missing`, `job-missing`,
  `worker-slots`, `worker-spawn`, `retry-limit`, `allow-mcp-missing`, `allow-mcp-other-server`, `allow-mcp-write-tool`, `run-refused`
  (`lean_run`), `action-unknown-kind`, `result-trimmed` (a worker result cut to its schema: one row each, counted), `auto-restart-loop`,
  `review-report-gate`, `external-review-refused`; the older guard refusals keep their pattern name as the rule. The export lists them as
  `(xN) [agent] rule: text (version)` under "Guard refusals since the last export".
- **Missing tools** (kind `missing-tool`, same file, `logMissingTool`): a tool call that fails because the tool is not available to that
  session or worker (the engine's "no such tool" / "server not connected" answer, matched narrowly: a failing test is never one), and a
  worker's `split:` / `missing:` / `refused:` answer lines. Recorded with role, tool or server (`mcp <server>`), job type and a count. The feedback
  export gets a "Missing tools since the last export" section next to "Guard refusals" (grouped, counts, anonymised) and `lean_doctor refusals`
  lists both. Specs: one per path, each checking that it lands in the export (`refusalrecord.test.ts`, `autorestart.test.ts`).

### Changed

- **Rule text diet** (always-loaded guides, one short line per rule, no history or rationale, nothing the guard already enforces except
  the name of the right tool; every rule kept, the contract check's required sentences unchanged). Tokens are chars / 4 from
  `lean_doctor overhead`'s script:

  | text | before | after | change |
  |---|---:|---:|---:|
  | `templates/front-desk.md` (the desk's guide) | 3222 | 1056 | -67% |
  | `templates/thread.md` (every thread's guide) | 2679 | 1567 | -42% |
  | `skills/thread/SKILL.md` (the desk's thread skill) | 4683 | 1352 | -71% |
  | desk guide in all (template + thread skill) | 7905 | 2408 | -70% |

  The new model is stated once: the desk routes only; a thread orchestrates only; every read, search or edit is one single-step job for a
  small worker (haiku by default, `why-sonnet:`, `job:` line, `allow-edit:` / `allow-cmd:` / `allow-mcp:` grants); tests and builds go
  through `lean_run`; the store is the memory (state snapshot, automatic restart, `find` / `ask` / `report`). The thread skill gets its
  `argument-hint`, so the contract no longer exempts it.
- **Approvals of the five write kinds go through the desk** (this reverses 1.0.14's "answered in the thread's own session" for those
  kinds only; no hook carries a decision, the mod performs the approved action itself). Everything else a permission check denies is
  still answered in the thread's own session (`approval`, Open tN). The thread guide tells a thread to use `action` instead of trying the
  write; the desk guide and the thread skill describe the flow; the skills contract checks the wording and that only the question hook
  and the pane's press write a human answer.
- A blocked thread that carries an `action` request shows the request's card, not the generic "tN is blocked" row on top of it.
- Not built, on purpose: any allow rule in a settings file to get past the classifier, and any widening of the guard for a command that
  writes or runs a program. Not covered: a PR thread's status change (fixed / closed) after a reply (reported above). Not run live: the
  user's answer is read from the engine's typed `AskUserQuestion` result; if a real result does not carry it the desk says so and the
  pane's Approve / Deny is the decision.

- **Pane header.** "lean-agent is not set up" and the Set up button show only when the setup itself is missing (desk folder, trust, model
  line, folder access, opener, launch agent, 1.0 state). What else the doctor found shows as "Doctor: N findings (F fix, I info)" with a
  Run fix button when something needs a fix.

- **The 1.0.15 changes are wired together.** The handover includes the preflight pack (`setPreflight(preflightFor)`: the thread's registered
  worktree, else its project folder); the thread settings writer writes `leantools.ts` `threadSettings()` (deny list for built-ins a thread
  never calls, the engine's switches in `env`) and `lean_doctor fix` merges `deskSettings()` into the desk's settings; the desk pane shows the
  plan window line under the header (`windowLine`); the orchestrate rules of a thread allow `lean_thread find` / `ask` / `report` / `dismiss`,
  `lean_run`, `lean_review`, the review skill's read-only git and reviewer passes (no brief limit, no `why-sonnet:`), and an MCP reader worker
  with an `allow-mcp:` grant. The execution model is off in the shared test host unless a spec opts in (`fakeHost(on, { orchestrate: true })`).

### Fixed

- **Final review of the 1.0.15 diff** (five single-focus read-only reviews; each claim checked in the code first):
  - Desk actions: an Approve counts only for the canonical question (text, option labels and descriptions, order, no multiSelect), not for
    any text that merely contains the request; zero-width and bidi characters are refused in a request; the "used" mark is written before
    the send and cleared only by a definite failure (a crash or timeout mid-send never allows a second send); the pane offers no Approve for
    a text it cannot show in full (the desk's question shows all of it).
  - Execution model: a thread's own Edit / Write / Read / Grep / search inside lean-agent's state no longer reaches the project worktrees,
    `config.json`, `projects.json`, grants or review records; `lean_run` ends after 10 minutes and is refused to a worker; a worker slot
    is freed when recording its grants fails.
  - Automatic restart: one tick at a time, no restart of a finished thread. `lean_thread ask` starts its fresh session with no tools, no MCP,
    no skills, no saved session and a budget.
  - Review gate and push: the external-review scratch repository runs git with its own hooks, fsmonitor and ssh command overridden; an
    ambiguity (several unregistered worktrees at the sha) is never settled by taking over a closed owner's worktree.
  - Export: a worker's own words are no longer exported (only `split` / `missing` / `refused`); a refused external review logs a fixed
    text; MCP server names that are not well-known public ones are masked.

- The desk's `push` and `lean_worktree register` take over a worktree registered to a closed thread (or a thread that no longer exists): the
  registry entry moves to the pushing/registering thread (`adopted: true`, former owner in `from`), written only after the push's gates hold,
  logged in the thread's history and said in the reply; a worktree of an open, parked or closing thread is refused with the owner and its
  state named. Doctor gets an info row for worktrees owned by closed threads.

- A type error in `reviewext.ts` (the ref narrowed to `never` after the `refOk` guard) that the validator reported as a warning.

### Removed

- Built-in tools the desk can never call and tools a thread never calls are no longer in their tool lists (`permissions.deny` in the folder
  settings, `hooks/leantools.ts`): fewer tool schemas in every request. Connectors and MCP servers of a thread's project are never denied.

## 1.0.14

### Added
- **Thread status is the truth.** "Running" is what `claude agents --json --all` says, not a recorded flag. `lean_thread list`, the pane
  cards, the thread pane and the send / wake replies show running | idle (N unread queued) | stuck (unread for `threads.stuckMinutes`,
  default 10, no tool call or inbox read) | done / parked. A `send` to an idle session wakes it (within 30 s of a wake it only queues
  and says "session idle: wake or restart it"); a `send` to a stuck one queues and says "stuck: wake or restart it"; neither is ever
  called "running". `wake` replaces a stuck session whose turn ended and wakes an idle one even with nothing queued;
  a session that is still working is never stopped by send, wake or resume (only `restart` replaces it). A `[working]` report of a
  session that is not running is marked stale, and a start that ended its turn without a tool call is reported loudly ("started, but it
  ended its turn at once: wake it with the task"). See [README](README.md#thread-sessions-what-running-means-wake-names-leftovers).
- **Session names**: every fresh start and restart is named `tN · title` (with "(2)", "(3)" after restarts) and the name is read back
  from `claude agents`. Claude Code has no command to rename a background session, so an old one is left (the doctor row says so).
  A restart or fresh start says what the new session costs ("handover about N tokens, ~$X first turn, estimate").
- **Thread context limit, restart at turn end.** Config `threadTokens` (default 120000). The thread's own mod records its context size
  after every turn in `threads/tN/context.json`. When the next `send`, `wake`, `resume` or chaser message finds an idle or done session
  over the limit, a NEW session starts with the handover instead of a resume ("context was 142k (limit 120k): started a new session ...
  ~$0.05 first turn, estimate"). A working session is never touched; a session with no size of its own counts as under the limit.
  New module `hooks/threadcontext.ts`. See [README](README.md#thread-context-limit-and-keep-mode).
- **Context in the pane and the list**: `ctx 108k/120k` on the card, the thread pane and `lean_thread list` (dim, yellow above
  `threadWarnTokens`, default 100000 or 83% of the limit, red over the limit; `ctx unknown` when nothing is recorded). The card's
  status line is one line: state word, today's cost badge, ctx, agents N/cap, branch, review verdict.
- **Keep mode** (opt-in): `keep: true` on `lean_thread new` / `start`, `lean_thread keep tN on|off`, a "Keep session" choice on the
  new-thread form. A thread in keep mode that reported done is resumed for follow-ups until its context passes the limit, then the
  restart applies. The desk's tick does not finish a thread in keep mode.
- **Review cost: two levels and an expected cost.** `lean_review prepare` takes `level`: `light` (the default) is ONE sonnet pass on
  correctness, behaviour and reuse and never records green; `full` is the strict review (every pass, two runs for a high-risk diff)
  the push gate needs, asked for only before "ready to push". The level a sha was prepared at is kept in the mod's store, so a light
  pass cannot be recorded green by leaving the level out. `level` and `worktree` are in the registered tool's schema, so a thread can
  ask for `full`. `prepare` prints `expected review cost ~$1.20 (2 passes, sonnet; ...)`: the median of this project's earlier reviewer
  passes in the ledger, else a stated default of $1.50 a pass. New modules `reviewcost.ts`, `reviewexclude.ts`.
- **Generated files are left out of a review**: out of the file lists, the risk, the line count and the diff the reviewer reads (it gets
  `':(exclude,literal)path'` pathspecs; a change that edits `.gitattributes` cannot mark its own files). Files marked
  `linguist-generated`, `*.snap`, golden / fixtures / `__snapshots__` paths, lockfiles, minified bundles and `config.json`
  `review.exclude` globs; the prepare text says how many files and lines. The prompt carries the thread's registered worktree
  (`git -C <worktree> ...`) and the `allow-cmd:` line for it.
- **Readers and the reviewer run more read-only commands**: unquoted globs whose every match is inside the allowed folders,
  `2>/dev/null`, `rg`/`grep` with no path (cwd inside the roots), and `sort` (no `-o`), `uniq` (one operand), `cut`, `tr`, `nl`.
  `xargs`, `cd`, any other redirect, `;`, `&&`, `$(...)` and paths outside the roots stay refused, and so does a word that mixes a
  quoted and an unquoted glob character (the shell reads the quoted one literally).
- **Budget alerts by default** (`config.json` `budget.daily` 25 USD and `budget.threadDaily` 20 USD, `"off"` allowed): a desk notice and
  a toast at 50% and 80% of the daily budget (once per day per level; today's spend, the top 3 threads and their models) and when one
  thread passes its daily alert; the chaser asks a stale expensive thread what the spend bought. The thread cards show today's cost
  with a `!` when it is over the alert (`threadCostsToday` / `costBadge`, stats.ts).
- **`lean_script record-audit`** (name, sha, verdict adopt|adapt|reject, network / deletes / secrets / generalises, reads, writes,
  hardcoded, changes, reason) for the audit thread or the thread that started the auditor: checked like an auditor's reply (stored
  sha, every flag answered, the mod's own rules on top) and only after the mod saw an auditor call with the exact brief for that text
  go through. A verdict passed on this way never adopts by itself.
- **Restart desk remembers the desk it replaced and keeps asking you to archive it.** No engine call closes a session, and the desk is a
  Desktop session that `claude rm` / `claude stop` (background sessions) are not assumed to reach. The restart records the old desk's
  id and title (`desk/old-desk.json`) before the new desk opens; the new desk's first notice, then once per desk turn, and the doctor
  name it and say "archive it in the Claude app (right-click, Archive)" until `claude agents --json --all` no longer lists it as an
  active row (also ends 7 days after the restart). A desk session never listed there cannot be checked: the reminder ends 24 h after
  the restart, or at once with `lean_doctor dismiss-old-desk`. `claude rm <id>` (no flags) is tried only when that exact id is listed
  as a background-kind session that is not working and runs in the desk folder; the result is logged. Never the new desk, never
  `--discard-unpushed` / `--force-remove-worktree`, never a stop of the app or a service.
- New doctor row "stale thread sessions" (`hooks/threadsessions.ts`); `doctor fix` removes them the way a restart does.

### Changed
- **Approvals are answered in the thread's own session.** The desk is told that an approval of a thread's denied action is answered in
  the thread's session (the pane's Open tN), never asked with AskUserQuestion and never relayed with `send`: a relayed yes does not
  satisfy the permission check. A thread no longer reports `blocked` with an `approval` for something it decides itself (a subagent
  cap, a model choice). The honest limit: no hook can carry a desk yes past a classifier denial. `classic.PermissionRequest` only
  answers an ask that goes to a person, and in auto mode what the classifier refuses is a verdict, not an ask; `classic.PermissionDenied`
  can only let the model retry the same call through the same check; a hook could wait minutes for the user's answer, but that changes
  nothing. So the planned grant flow (signed single-use grants) was not built. An expensive model (the pane's Approve) and a push
  (`approve-push`) are unchanged. (Read from the engine's plugin-authoring typings; not run against a live auto-mode session.)
- **Restart, wake and the handover put the task first**: "Resume the work now (task: ...). Answer status requests with a short
  lean_report as a side effect, never as the whole turn." A status request mid-work gets a one-line report without ending the turn.
- A done thread's next message says "new session (not in keep mode)"; a resume says the context size and the estimated cached re-read
  cost when the size is known.
- The thread guide: light review at intermediate checkpoints and `level: "full"` only before "ready to push"; a worker whose edit is
  refused for a path outside its `allow-edit` grant stops and reports that exact path. The thread and desk guides explain the context
  limit, the pane warning and keep mode.
- Doctor: "the desk spent $X on opus today" counts only spend after lean-agent pinned the model (earlier spend today is a note), and
  "opus is N% of spend" is a FIX only while a thread is on opus now, naming only those threads; otherwise a note.
- `decide adopt` with no stored verdict takes the audit thread's last report with a `LEAN-AUDIT` line for that text instead of "was
  never audited" (logged); a network flag still needs your explicit adopt. `audit` says "Audit started; verdict not recorded yet",
  `show` says "audited, waiting for the verdict", and the desk starts only one audit thread per script text.
- The thread `CLAUDE.md` no longer keeps a stale `model:` line after a model change (regenerated at every fresh start) and says that
  tools starting the shell in the worktree are fine while the thread itself never `cd`s.

### Fixed
- **A stale "needs your yes" card no longer stays after the thread carried on.** The card now exists only while the thread is really
  blocked: the session is not working, and it has made no tool call since it reported (the mod notes the first one, `approvals.ts`);
  the generic "tN is blocked" row, its toast and the red state word end with it. Limits: any later tool call of the thread's main loop
  counts, so a desk wake or chaser message that makes a blocked thread call a tool also ends the card (the thread's own report is then
  what is left); the notes live in the mod store, shared between a thread's session and the desk, but this was not run live. The thread
  detail does not know the usage-limit pause, so a paused thread keeps its card in the pane and loses it in the detail.
- **"Open tN" opened a new desk.** A session started in a thread's folder is that thread, whatever its session id: the role is decided
  by the folder first (the desk folder is the desk, `~/.lean-agent/threads/tN` is thread tN) and by the session id second; an unknown
  id in a thread folder never becomes a desk and is recorded in the thread's `sids`. (A session id that another open thread holds still
  wins over a thread folder.) This is the part that could be fixed without running the app.
- **"Open tN" no longer implies the right session opened.** After the link is handed to the system opener the reply says: if a new
  desk opened instead, close it; the thread's session is in the app's session list as `tN · title`; `claude attach <id>` reaches it
  from a terminal. README Troubleshooting has the checks to run on a Mac (not verified that the app resolves a `claude --bg` id).
- **A script audit's verdict is no longer lost when the auditor ran in the background.** The mod recorded the verdict only from the
  auditor's own Agent reply, which a background call does not have. A verdict passed with `record-audit` never adopts by itself (an
  `adopt` waits for your Adopt / Reject; adapt and reject take effect).

### Removed
- **Superseded thread sessions**: after a fresh session replaces an old one, the old one is removed from the app's list with
  `claude rm <old id>` (never `--discard-unpushed`, never `--force-remove-worktree`, never a live or working process, never the new
  session; a refusal is logged and left). Config `threads.removeOld` (default true) turns that off.
- The desk no longer asks an approval of a thread's denied action with AskUserQuestion, and "running" is no longer claimed from a recorded flag.

## 1.0.13

### Fixed
- **A restart, start or resume that names no model no longer waits for approval of an opus the thread was only recorded on.** It starts
  on sonnet and the reply says so ("tN was recorded on opus; started on sonnet"); an opus you approved for the thread is still kept, and
  a call that names opus is still held for your Approve. `restart` of a parked thread reopens it in the same step; a resume of a
  session recorded on an unapproved opus starts a new session on sonnet (a resume cannot change a saved model).
- **A subagent cap in your own CLAUDE.md no longer stops the review.** Reviewer passes and the second-opinion reader are exempt from any
  subagent cap, and the review skill, the thread guide and the prepare text now say so. The push gate's refusal says how many passes
  are still missing and over which commits; `lean_thread list` and the pane card show "agents 3/4" when `agents.cap` is set.
- Handovers and docs said `lean_thread threads`; the action is `list`.

## 1.0.12

### Added
- **Expensive models need your approval, and only your press in the pane gives it** ([README: Expensive models](README.md#agents)). Opus
  or anything that is not haiku or sonnet (a deny-by-default test: fable and unknown names count) is never chosen by a session. A
  `lean_thread new|start|reopen|restart|resume` that asks for one, with a `reason` (required), does not start the thread: the request
  (thread, model, effort, reason) is a card in "Needs you" with **Approve** and **Deny** (two presses each) and **Start on sonnet
  instead**; the reply tells the desk to ask you to press Approve. Inside sessions the guard (`tool.call`) refuses an Agent call to
  `lean-agent:worker-opus` or to an agent whose model resolves to an expensive one (plugin, project and user agent files), an Agent
  `model` override to one, a Bash `claude ... --model <x>` / `-m <x>` / `ANTHROPIC_MODEL=<x> claude` started by a thread, a worker or the
  desk, and a `lean_compare` on one ("opus needs the user's approval: report it and stop"; the refusal is also a card to approve or deny).
  An approval is signed (HMAC with the review key in the mod's own store), for one thread (or the desk) and one model family, ends when
  the thread closes and after 24 h at most, and is logged in the thread's `history.jsonl` with the time and what was approved; no
  `lean_thread` / `lean_doctor` / `lean_script` action, no `config.json` value and no message can create one (a source check in
  `skills-contract.test.sh` keeps `grantModelApproval` to the pane's one Approve press). A resume, wake or send of an older thread whose
  recorded model is expensive waits for the same press (its messages stay queued, nothing is stopped). New module `hooks/expensive.ts`.
- **Two independent sonnet reviewer passes for a high-risk diff, merged like 0.45's `review --runs 2`.** `lean_review prepare` prints
  `reviewer: sonnet x2 (risk: ...)`; the thread runs two separate reviewer Agent calls and passes both JSON blocks to `record` as
  `reviews: [a, b]` (or to the new `merge` action, whose block is accepted unchanged as `review`; its digest is kept in the mod's store,
  so a hand-written `runs: 2` is one pass). Findings are matched by category, file and wording, marked `[2/2]` when both runs found them
  and `[1/2]` otherwise, and the union counts. A high-risk diff with one block, or two identical blocks, is never green. New module
  `hooks/reviewmerge.ts`.
- **`lean_doctor stats` shows the opus share** of the window's spend with the threads that run on opus, and `lean_doctor check` has a FIX
  row when opus is over 40 % of the last 7 days' spend ("opus is 64% of spend: threads t1, t3 run on opus").
- **A red "Needs you" row** when the app started the desk on an expensive model and the mod could not switch it to sonnet / high.
- **`lean_review` `learn` follow-ups.** (1) A checklist line may be `{text, area}`: a line about ONE area's commands or layout is not stored,
  the answer returns it under "NOT stored ... run the learn skill with --area <area>" (the tool never writes a rule file: the rule caps
  and the scripts block stay the learn skill's), a line a reviewer would check in any change stays a plain string and goes to the store;
  the review-learn skill has the one-line test. An area that is not a folder or rule name is refused. (2) `learn` runs the helper
  existence check of `lessons-verify` (one shared function) before it adds a helper and refuses one whose path and symbol it cannot find,
  naming it ("refused helper X (path): path ... and symbol ... not found on HEAD"); the other helpers are added; with no repo or no commit
  the helpers are added and the answer says they were not checked. (3) The answer ends with what the last `prs` fetch dropped (the owner's
  own comments, system threads, deleted comments, approvals, typo fixes) next to its own result, for twelve hours after the fetch.
- **One PR-comment fetch for GitHub and Azure DevOps, shared by the `pr` and `review-learn` skills** (`hooks/prhost.ts`, `lean_review`
  action `prs`: `project`, `pr` or `last` (default 10, at most 30), `base`, `repo`). `review-learn` was GitHub-only (`gh api user`); an
  Azure DevOps project (origin on `dev.azure.com`, `*.visualstudio.com`, or the ssh forms) got nothing. The host now comes from the origin
  URL, like the `pr` skill: github.com uses `gh` (owner = `gh api user --jq .login`, the last merged PRs, `gh pr view --json
  reviews,comments` and the inline comments); Azure DevOps uses `az` (owner = `az account show --query user.name`; `az repos pr list
  --status completed --top N --target-branch <base>`, then other targets when fewer than N; the threads from the REST endpoint
  `.../pullRequests/<n>/threads` with a bearer token from `az account get-access-token --resource
  499b84ac-1321-427f-aa17-267ca6975798`, handed to curl on stdin, kept out of every argument list, scrubbed from every error and never
  printed; never a PAT). A script drops what is never a lesson and counts each kind: the owner's own comments, system threads (the
  `CodeReviewThreadType` property: votes, policy results, ref updates, reviewer changes, and comments with `commentType: system`), deleted
  threads and comments, bare approvals and typo fixes; an Azure thread's status (active, fixed, wontFix, closed, byDesign) stays with its
  comments, replies are marked. The `comments` step of the `pr` skill uses the same call, so the two cannot drift. GitHub reads the
  inline comments with gh's own `{owner}/{repo}` placeholders (a fork, or an Enterprise host gh is logged in to, reads the repo the PRs
  are in; an origin host that is neither github.com nor Azure is tried through `gh repo view` before it is refused), joins paginated pages
  by scanning (a `[1] [2]` inside a comment is left alone), and the Azure thread read uses plain `curl -f` (no curl 7.76 option). Only a
  fetch of the last N PRs is remembered for `learn`'s report; a look at one PR does not replace it. Direct sends to a desk that is not
  recorded and not live remember the miss for a minute instead of running `claude agents` for every report.
- **A thread says which lean-agent code it runs, and the desk shows it when that is not the installed one.** A thread restarted from the
  pane while 1.0.11 was installed loaded the review skill from the cached 1.0.9 folder, its `lean_review` only took 1.0.9's fields, its
  refusals said "(lean-agent 1.0.9)", and nothing told the desk: `thread.json` `version` is the version the DESK saw installed when it
  started the session, not what the session loaded. Now the thread's own mod writes `running` (`version`, `sid`, `at`) into `thread.json`
  at its session start (once per session; a desk save keeps it; the record of an older session is ignored). `lean_thread` `list` adds
  `running 1.0.9, installed 1.0.11` to a thread's line when they differ (and `codeVersion` / `skew` to its data); a start, restart or
  reopen waits up to 6 s for the new session's report and adds the same words and "ask it for nothing the running version lacks" to
  its reply. A session on code older than this feature never reports, which is exactly the stale-plugin case: after the wait the reply
  says "tN has not reported which lean-agent version it runs ... ask it for nothing newer than it can do", and `threads` shows "version
  unreported" for a live session a minute after its start; `resume` trusts what the session reported (a session that really runs older code is replaced by a fresh one, not resumed);
  the doctor has a `FIX thread tN running X, installed Y` row per skewed thread (a newer, dev copy is a note) with the cause and what the
  user can do. The desk guide says not to ask such a thread for features its version lacks and to restart it once the cause is fixed
  (and never to restart a service itself). Finding (README "Troubleshooting"): lean-agent causes none of it: a thread's `settings.json`
  only switches other plugins off (no `enabledPlugins` pin on lean-agent, no `--plugin-dir`), and the plugin cache keeps every installed
  version's folder. The most likely cause is the background service behind `claude --bg`, which keeps the plugin state it loaded at its
  own start and hands it to every session it starts until it is restarted (`claude plugin update` itself says "restart required to
  apply"). Established from the code and the CLI help, not reproduced. The doctor row tells the user to quit and reopen the Claude app
  when no thread is working, then restart the thread; lean-agent never restarts a service itself.
- **A subagent cap that leaves room for the review.** `config.json` `agents.cap` (a whole number; absent or 0 = lean-agent sets none) is
  the most subagents a thread's own loop may start in one session (the session id in thread.json; a restart counts from zero again,
  the count is `threads/<tN>/subagents.json`). Reviewer passes (`lean-agent:reviewer`, up to 6 per session: two independent runs of up to
  three passes fit) and the review's second-opinion reader (a `lean-agent:reader-haiku|sonnet` whose prompt has the line `review:
  second-opinion`, up to 2) are not counted and never refused by the cap; past those numbers they count like any subagent, so the marker
  cannot dodge the cap. A thread that spent its cap on traces used to have room for one reviewer pass; the review skill now says how the
  cap applies (a cap in the user's own CLAUDE.md is read the same way) and tells the thread to put the marker line on the second-opinion
  reader only.

### Changed
- **MODEL POLICY (cost data: by model opus $93.78, sonnet $26.79, haiku $0.75; reviewer agents in threads $13.89 of that).**
  - **The desk is pinned to sonnet / high again; the 1.0.10 opus pin is reverted.** `lean_doctor fix` replaces the opus pin that 1.0.10 and
    1.0.11 wrote (the row says "1.0.10 and 1.0.11 pinned opus; the desk is on sonnet again"); a `desk.model` / `desk.effort` the user set in
    `config.json` still wins. At a desk session start the model-set path switches an opus (or fable) desk to sonnet / high; the doctor rows,
    the desk template, the thread skill and the README say the same.
  - **The reviewer is always sonnet** (`hooks/reviewtool.ts` prepare no longer picks opus by risk; the same risk classifier now decides
    one or two runs). Opus reviews only when `config.json` `review.model` is `opus` or the brief explicitly asks AND the user approved it for
    that thread in the pane; otherwise sonnet runs and a request waits in "Needs you".
  - **`worker-opus` stays available but is never the default**: its description and the worker selection text say "only when the user
    asks", and the guard refuses it without the user's approval for the thread.
  - The new-thread form keeps sonnet as the default; picking opus shows a note and a Reason field, and Start files the request.
- **Subagent effort: `worker-sonnet` and `worker-opus` run at effort medium (was high).** A worker does one briefed task, so the reasoning
  budget is spent where the task is chosen and checked, in the thread. Unchanged: `reviewer` and `auditor` high, `reader-sonnet` medium, the
  haiku agents, `reader-haiku` and the explorer low, threads and the desk sonnet / high. Nothing in the doctor, `stats` or the
  specs read an agent's effort, so only the two agent files and the README line changed.
- **The desk pane is a dashboard, not a list** ([README: The pane](README.md#the-pane)). A header with the model/effort chip, the desk's
  context as a bar against `deskTokens` (yellow from 80 %, red from 100 %, **Restart desk** beside it from 80 %), today's and the 7-day
  spend, and the version and refresh time small and dim; the one-time "lean-agent set the model" line is drawn once, then the chip says
  so. **Needs you (N)** comes first and only when something waits: approvals (the 1.0.10 **Open tN** rows), unanswered thread questions,
  reports ready to push (sha, branch, review green, "ask the desk to push", no push button), blocked threads, scripts waiting for
  Adopt / Reject, the desk over its limit; each is a card with its button. Every open thread is a bordered card coloured by state: id
  and the whole title (wrapped, not cut), the state as ONE word (no more `[running]` next to `busy`), model/effort, branch, the review
  verdict from the signed review record of the commit the reports name (`review green` / `review not green` / `no review`), today's
  cost, the last report on one line, and **Open** (the thread's detail pane), **Resume** / **Start**, **Restart**, **Close**.
- **The inbox replaces the flat Answers list**: grouped by thread, unread first, at most the last 5 read rows per thread ("show all"
  for more), read rows older than 7 days archived (hidden in the pane, kept in `inbox.jsonl`), **ack all** stays. Closed threads stay
  folded with their count; Projects and Scripts are one folded **More** section; Goals shows only when there are some.
- **Footer actions**: **New thread**, **Feedback export** (the `/lean-agent-feedback` export, from the pane) and **Setup / repair**.
  **Restart desk** is in the header (from 80 % of the limit), on the "desk over its limit" card and, always, in the footer (the same two-press
  confirm; the pane's **Open** and **New thread** buttons open the real thread pane and new-thread form).
- **A minimized widget** (`placement: "widget"`, Claude desktop) draws a glance only, with no button: running and blocked threads,
  how many need you, desk context in percent, today's spend. A narrow body (under 50 columns) gets shorter rows and wrapping buttons.

### Fixed
- **Desk push with `pr` now works on Azure DevOps.** The PR host is picked from the push remote's URL (as the `pr` skill does):
  GitHub keeps `gh pr create`; `dev.azure.com/<org>/<project>/_git/<repo>`, the old `<org>.visualstudio.com` form and both ssh forms
  open the PR with `az repos pr create --org https://dev.azure.com/<org> --project .. --repository .. --source-branch .. --target-branch ..`
  (argv, no shell; `az` is found on PATH or in `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`; it uses the user's `az login`, never a
  token) and the PR link is read from its JSON. When `az` is missing or fails, the reply gives the create-PR link
  (`.../_git/<repo>/pullrequestcreate?sourceRef=<branch>&targetRef=<base>`, URL-encoded) and says "az repos pr create needs az + az login"
  instead of advising to install `gh`. An already open PR is found with `az repos pr list` and reported as open.
- **An unregistered worktree no longer blocks the desk's push.** A thread that made its worktree with plain `git worktree add` got
  "tN has no registered worktree". The push now adopts it when it is a linked worktree of the project's own repository (`git worktree list`),
  on a branch, with HEAD equal to the approved sha, and no registry entry (of any thread) has it; it is registered for the thread
  (`adopted`) and every other gate (branch, review, approval) still applies. Several candidates are named, never guessed.
- **A taken registry key no longer fails silently** ("The registry has no free slot for this path"). New `lean_worktree` tool for threads
  (`register`, `list`; `hooks/worktreereg.ts`) replaces hand-editing `worktrees.json`: a key whose recorded path is gone or no longer a
  worktree is replaced; a key held by another live worktree gets a suffixed key (`<project>/<branch>~2`); the same worktree of another
  thread, a damaged file and a failed write are refusals that say why. The review skill's ready-to-push step registers first.
- **A tracked, team-shared `CLAUDE.md` is no "memory file" to trim.** `compare` marks every memory file tracked or untracked
  (`git ls-files` in its folder, shown as `(tracked)` / `(untracked)` in the report); a tracked one gets "team file: trimming needs a PR
  in the repo", no `learn --gaps` advice. `lean_rules` `record` now refuses a rule whose lines already appear in an always-loaded file
  (the repo's `CLAUDE.md`, tracked or not, `.claude/CLAUDE.md`, `CLAUDE.local.md`, the user's `~/.claude/CLAUDE.md`; it names the lines,
  and `covered_by` is the way out when nothing else is left), and `lean_rules` `check` reports such lines (the rule would load them twice).
- **The feedback export leaked branch names, a colleague's first name and the OS build.** Blocked-thread lines kept "Branch
  infra/<words>", a branch inside a registry key and a worktree path, and "did not post the reply to <Name>"; the environment text kept
  "Darwin 25.6.0". Now a branch name is masked after the word branch/Branch, in worktree folders (`.../worktrees/<project>/<folder>`),
  in registry keys, and wherever the worktree registry's own branches appear (checked first, so a branch that holds a project's name
  is still masked as a branch); a first segment that is a branch type (`bugfix/`, `feature/`, `infra/`, `release/` ...) stays, the
  rest becomes `<branch>`, any other first segment is masked too (it may be a person), and default branches are left. A capitalised
  word after "reply to", "asked by", "from" or "to" becomes `<name>` unless it is a product or common word. "Darwin 25.6.0" becomes
  "Darwin" (also Linux, Windows_NT, macOS). The final check refuses to write the file when a known branch, a branch after the word
  "branch", an unmasked worktree folder, a name after "reply to" / "asked by" or an OS build survives.
- **Push and registry hardening (from the strict review of the above).** A worktree is the project's by its git common dir, not by the
  folder it sits in, so one made with `git worktree add ../x` keeps working on the second push after it was adopted or registered (the
  main checkout itself is refused); an adopted worktree gets the project's own `guards.push-deny` list; adoption happens only when the
  thread has no live registered worktree and the registry is written only once the review and the approval hold (a refused push changes
  nothing); another thread's worktree is never taken over under a new key, and a shared one keeps its owner while the newcomer gets its
  own key; `prune` only drops what it saw stale. On Azure DevOps a PR title or body that starts with `@` is padded so `az` never reads it
  as a file, `@` is no part of a project or repository name, and a URL such as `https://host#@dev.azure.com/..` is not Azure DevOps. The
  export keeps tool names (Read, Bash ...) after "from" / "to", keeps the file inside a worktree folder, and masks `branch (x/y)` and
  comma lists of branches. `compare` also reads the memory file's path from the source column when that is where `/context` puts it.
- **Doctor:** a stale registry entry (folder gone, or git says it is no worktree) is a FIX row and `fix` prunes it; a git that does not
  answer never makes an entry stale. The desk's spend on the model the app started it on is an info note ("the app started the desk on
  <model>; lean-agent switched it to opus"), not FIX, once the pin switched the session (`desk/model-set.json`, verified switches only,
  today only, not when a later session could not be set).

- **The review skill's `allow-cmd` grants work from the thread folder.** The thread's session folder is not a repository, so the grants
  `git diff <base>...<sha>`, `git log ...`, `git show <sha>` and `git merge-base ...` failed with "not a git repository" there. The skill
  now grants them as `git -C <worktree> diff|log|show|merge-base ...`. Grant matching in the guard compares word by word: spacing, quotes,
  `--no-pager` and the spelling of the `-C` path (`/w/`, `/w/../w`) no longer decide, a grant for one checkout is never one for another,
  and a command with a pipe, redirect or substitution still never rides on a grant. `git merge-base` (read-only) is now built in for the
  readers and the reviewer, like `diff`, `log`, `show`, `status` and `rev-parse`.
- **An auditor's verdict is recorded even when the thread asked for the background.** An `lean-agent:auditor` Agent call with
  `run_in_background: true` returned "Async agent launched" at once and its `LEAN-AUDIT` line arrived later in a hand-back that no hook
  records, so the script stayed unaudited. The thread's `tool.call` hook now hands such a call on with `run_in_background: false` (other
  agent types keep their request) and tells the thread; if an engine ignores the switch and the reply is still "Async agent launched",
  the thread is told no verdict was recorded and to run the audit again in the foreground.
- **A thread's direct report finds the desk again after a desk restart.** A report refused with "no live session on this machine has
  id <uuid>" (the desk had restarted, the thread still held the old id in `desk.json`) fell back to the inbox and kept sending to the dead
  id. The send now looks up the desk's live session (`claude agents --json`, the session in the desk folder, the newest when several)
  when it is refused or when no id is recorded, writes it to `desk.json` for every thread, and sends once more; the result line says
  "the desk had a new session". No live desk session = the refusal stands and the inbox has the row, as before.
- **With `attribution` off a thread no longer follows Claude Code's own "end commits with Co-Authored-By / Claude-Session" reminder.**
  The reminder comes from the engine's attribution setting, which a thread's CLAUDE.md ("no trailers") could not outvote. The thread's
  `.claude/settings.json` now carries `attribution: {commit: "", pr: "", sessionUrl: false}` (empty text hides the trailer and the
  PR line, `sessionUrl: false` drops the `Claude-Session` link) and the deprecated `includeCoAuthoredBy: false` for an older engine,
  written at every start and restart; nothing is set when config.json `attribution` is on. The CLAUDE.md line also names the reminder it
  overrides ("Attribution for git commits and pull requests") for an engine that ignores the settings.
- **A restart brief says where the full text of a cut report is.** Earlier reports in the handover are cut to 700 characters (the newest
  is whole up to 20,000) and used to end in "..." with nothing to follow. A cut line now ends in `(cut: full text in
  <home>/.lean-agent/desk/reports/<ts>-<thread>-<kind>.md)`; the handover writes that file when the desk never did (a short report, or
  one pruned after 30 days), never overwrites one that exists, and names the inbox row instead when a file cannot be written.
- **The read-only agents no longer open with a refused `cd <dir> && cat ...`.** `reader-sonnet`, `reader-haiku` and `explorer` now say up
  front "absolute paths only, never `cd`" (use `/abs/path/file` or `git -C /abs/repo ...`); the skills contract check fails when one of
  them loses the sentence.
- **Type warnings.** `claude plugin validate` no longer reports the implicit-`any` warnings of the pane specs, and the four
  `mcp__lean-agent__*` tool matchers are `as const` template literals (validate passes with only the existing icon warning).

### Removed
- **The 1.0.10 opus pin of the desk** (the desk default is sonnet / high again; `lean_doctor fix` replaces the pin 1.0.10 and 1.0.11 wrote).
- **The automatic opus choice of the reviewer by risk** (`chooseModel` returned opus for security, concurrency, schema, UI strings,
  public API, config formats, removed symbols and large diffs): the same risk now means two sonnet runs.
- **`worker-opus` as a default choice**: it stays available, but only when the user asks and approves it in the pane.
- **The pane's stub buttons** (`hooks/panelinks.ts` said "comes in this release"): Open and New thread open the real panes.

## 1.0.11

### Fixed
- **The learned review checklist was orphaned by the 0.45 -> 1.0 migration, so reviews ran without it.** 0.45 kept the lessons human
  reviewers taught it (a `review-checklist` and a `shared-helpers` card per project, hundreds of lines in a big project) in
  `library/<project>/cards.json` plus a registry (`_lessons`, with ids, batches, dates) in `<project>/review-learned.json` and an undo log
  in `<project>/review-learn-batches.json`. `migrate` only moved `<project>/cards/`, so none of it was copied, indexed or read, and a PR
  that added a second implementation of an existing helper got no warning. Now `migrate` and the versioned tidy step (`TIDY_VERSION` 5,
  so installs that already migrated get it at their next start) copy those four files of every registered project to
  `legacy-0.45/lessons-<project>/` (the originals are never deleted) and import the live lines into a per-project lesson store,
  `~/.lean-agent/<project>/review-lessons.jsonl` (id, family, topic, text, paths, keywords, source, added, dropped). Lines 0.45 had already
  removed are kept as `dropped`; a re-run adds nothing; a line you removed here is not brought back by a later import. The note cards of
  `cards.json` are listed in `legacy-0.45/index.md` as candidate facts for `learn`; the two review families are not (they are lessons).
- **The reviewer got no project knowledge when it read through git.** The path-scoped rule loader fired on a Read or on a shell command
  naming an absolute path, never on `git -C <repo> show <rev>:<path>`, `git grep`, `git diff -- <path>`, `git log -p -- <path>`, `git blame`,
  or a plain `git show <rev>:<path>` in the project's worktree. Those read-only git commands now count as touching the files they name
  (relative to the repo, `cd <abs> &&` and `-C` followed), and for the reviewer the checkout itself counts: a path-less `git diff` gets
  `_project.md` and the rules written for the whole repo, once per context. Writing git commands (`status`, `commit`, `push`, `add`) never
  trigger it; a `..` path is refused as before.

### Added
- **The review lesson store** (`hooks/reviewlessons.ts`): the learned checklist and the list of existing shared helpers live outside
  `rules/*.md` (25 lines / 2000 characters per rule cannot hold hundreds of lines). It has its own cap (1500 live lines,
  `config.json` `review.lessonMax`).
- **Selection by script, not by a model.** `lean_review` `lessons` (`project`, `base`/`head` or `paths`, optional `goal`, `repo`,
  `budget`) returns the text block for a reviewer prompt: the lines whose paths or globs match the changed files, whose helper symbol
  occurs in the diff, whose symbols or words occur in the diff or the goal, plus the helpers in the same or the next folder, grouped by
  topic, capped at about 4 x 800 tokens (`config.json` `review.lessonTokens`, default 3200), always starting with the general reuse rule
  ("before accepting new code that detects, parses or normalises something, search for an existing helper and name it"). Deterministic;
  every call logs which lines and why to `~/.lean-agent/logs/review-lessons.jsonl`. For other code: `reviewLessons(host, project,
  changedPaths, diffText, { budget?, goal? })` and `lessonsFor(host, { project, repo?, base?, head?, paths?, goal? })`.
- **Learning into the store.** `review-learn` adds lines with `lean_review` `learn` (`checklist`, `helpers` `{name, where, what}`,
  `replace` `[{old, new}]`): near-duplicates are skipped, a helper with a known name updates its line. `lessons-list`, `lessons-rm`
  (soft: the line is marked dropped), `lessons-undo` (the last batch, 30 are kept) and `lessons-verify` (helper lines whose code path or
  symbol cannot be found; `apply: true` drops them) work like 0.45's `review learn --list / --rm / --undo / --verify`.
- `lean_rules check` and the doctor warn when a project has 0.45 lessons that are not imported, and report the store's size by family,
  the last import and how many lines are dropped.
- The lesson actions are part of the same `lean_review` tool as `prepare`, `record` and `decline` (one action enum, one schema); the
  `review` skill asks for `lessons` after `prepare` and puts the block into the reviewer's prompt.

### Changed
- **The strict review of 0.45 is back** (the 1.0 port had cut it to "find bugs, list by severity"). `agents/reviewer.md` carries the
  ordered passes 0-7 (completeness; correctness traced end to end; behaviour before -> after with intended/unintended, risks with one
  concrete check each, removed side effects; reuse and duplication with a search per new symbol; scope and platform with siblings;
  tests with a coverage table; defaults and state; style last), the severity rules, and a structured JSON block before the
  `LEAN-FEEDBACK` line. `skills/review` runs it in up to 3 passes with a second pass that only sees the open findings, the declines and
  the delta since the last reviewed sha.
- **`lean_review` has three review actions** (`prepare`, `record`, `decline`; the lesson actions are listed under Added). `prepare` computes the review's inputs from the diff without a model (new symbols and files,
  edited tests whose assertions change, new defaulted parameters, new module-level state, changed/moved/removed exports; TS/JS, Python,
  Go, Rust, C#, Java, Kotlin, Swift), picks the reviewer model by risk (opus for security, concurrency, migrations/schema/storage, UI
  strings, public API, config formats, removed public symbols, ~800+ lines; sonnet otherwise and on re-reviews; `config.json`
  `review.model` wins) and says whether a search-only second opinion comes first. `record` (the default) now REFUSES green, with the
  reason and recorded not green, when a new symbol has no `reuse` entry, an edited test no `coverage` entry, a second-opinion candidate
  no answer, an earlier blocker/major is neither listed again nor `fixed`, git could not produce the diff, the range is empty, `base` is not a
  branch or tag name, or a blocker/major finding is open; green without the reviewer's JSON (`review`) is refused. `decline`
  records a finding the user decided not to fix (project, branch or all branches, kind + symbol, why); later reviews are told and
  leave it out. The HMAC signing is unchanged.
- Earlier rounds' reuse and coverage entries are kept in the mod's own store (not in a file a session can write), so a re-review
  converges: a new major about code unchanged since the last review is a minor.
- The reviewer's built-in command line now names the 1.0 read-only set (`git ls-files` too; no `git grep`).

## 1.0.10

### Fixed
- **Readers and the reviewer could not read enough.** The built-in read-only Bash set of `lean-agent:reader-*` and `reviewer` (already
  `git`, `rg`, `grep`, `find`, `ls`, `wc`, `head`, `tail`, `cat`) now also has `sed -n`, `stat`, `file`, `diff`, `jq` and `tree`, on
  paths inside the same roots as `git -C` (the thread's worktree, registered projects, `~/.lean-agent`), joined only by `|`. Listed
  flags only, so these stay refused: `find -exec/-execdir/-ok/-delete/-fprint*/-fls`, `sed` without `-n`, with `-i`, `-f`, or a script that
  has `w W e r R a i c b t` or an `s` flag `w` / `e` (a bracket expression holding the delimiter is refused too: GNU sed and the macOS
  sed split it differently), `stat -L/-f`, `file -L/-f`, `diff -r/-X/--from-file` (and `diff` on anything but two existing plain files: on directories it follows a symlink out of the roots), `jq -f`, `--rawfile`, `--slurpfile`, `-L`, `env`,
  `$ENV`, `import`, `include`, `tree -o/-l/--fromfile`, redirects, `;`, `&&`, `||`, `$(...)`, backticks, `&`, here-docs and any stage that
  is not itself in the set. The explorer, the auditor and the desk keep their smaller sets.
- **The guard's refusal names the refused program** (first word only, never an argument; a plain name or `?`): `lean-agent: refused: npm
  (not a built-in read-only command); reviewer may run only its built-in read-only commands (...)`. The reason says whether the program is
  not built in, is built in but with a flag or path that is not allowed, or the command uses shell syntax. The feedback export's
  guard-refusals section therefore shows WHAT was asked for (rows group by this text).
- **Feedback export anonymiser gaps.** Ids after `work item`, `work-item`, `PR`, `pull request`, `pullrequest`, `thread`, `issue`,
  `ticket`, `story` and `--id` are masked (`--id 123`, `--id=123`, `PR!123`), so are result fields (`"id": 123`, `pullRequestId=123`,
  `thread_id: 123`, `number: 123`) and every bare number of 4+ digits inside a quoted or backticked command; counts followed by a unit
  (`chars`, `tokens`, `k`, `ms`, `s`, `%`, `lines`, `rows`, `files`, `tests`) stay, and so do thread ids `tN`. The final check also
  refuses to write the file when a word-plus-id survived.

- **The desk now runs Opus / high** (the user's decision; the alias `opus` is the latest Opus). `DESK_DEFAULT` in `hooks/models.ts`
  is `opus` / `high`; `config.json` `desk.model` / `desk.effort` still override and win. Threads stay sonnet / high. Setup (`doctor fix`)
  pins the desk folder's `settings.json` to it and replaces a sonnet pin an older setup wrote, the doctor row then reads `desk pinned to
  opus / effort high (was sonnet / high: updated, an older setup pinned sonnet; the desk default is now opus)` (a user's `desk.model` in
  config.json is kept and named: `... config.json desk.model`; a hand-edited model gets no cause: `... the desk default is opus`); the
  check row for such a file says `... doctor fix updates it`. The README, the doctor skill and the texts below follow the pin (the
  desk template never named the desk's model) (`pick Opus in the app's model menu (lean-agent pins opus / high)`).
- **The desk ran another model than its pin.** The pin is in the desk folder's `settings.json`, but a session the Claude app
  starts (by hand or through the new-session deep link) can take the app's own model menu instead. The engine has no model setter
  (`$.session.model()` only reads), but it has the `/config` rows (`$.config.list()` / `$.config.set()`, "as if the person did in the
  menu") and a `turn.step` hook that rewrites one request's model (not used: it would override the user's own choice at every step).
  So, once per desk session (at `session.start` when the model is known then, else at the first request), when the session's model or
  the effort row differs from the pin (`config.json` `desk`, default opus / high), the Model and Effort rows are set through
  `$.config.set` and a dim pane line says so (`the desk was on <model> (the app chose it); lean-agent set opus / high through
  /config (the app may keep that as your default for new sessions)`, naming only what was really written; the desk's next prompt says
  it too). `$.config.set` is the /config menu's own writer, so whether the app keeps the change as the user's default for other
  sessions could not be checked from the types: the line says so. The session's own model is what is judged (`$.session.model()`;
  a title or summary request on a small model is nobody's pin), the plain option (`opus`) wins over `opusplan`-like names. Nothing is forced when that is not possible (no such row, no option of that family, locked, denied,
  throws, or the model did not move): `~/.lean-agent/desk/model.json` holds the state, the pane shows one top row `the desk runs
  <model>; pick Opus in the app's model menu (lean-agent pins opus / high)` and a notice, and a later request on the pin clears both.
  After the one attempt a changed model is only noted, never written again (no fight with the user's menu). A model of no known family
  (a gateway's) claims nothing. Threads are not touched: they are started with `--model` / `--effort`. Whether this build's
  `/config` has a Model row could not be checked from the types alone; the fallback row covers a build that has none.
- **Doctor text for a desk that spent on another model.** It no longer claims "started before setup pinned the model" unless that is
  known: setup now records when the pin changed (`desk/pinned.json`), and the claim is made only when the live desk session started
  before that. Otherwise it says `the app chose another model for this session: pick Opus in its model menu` (and, when the live desk
  session runs the pin now, `the live desk session runs opus now`).

### Added
- **A thread blocked on a permission denial can be answered where Claude Code judges it.** Claude Code's permission check judges a command
  in the session that runs it, and the user's yes was given to the desk. `lean_report` has an optional `approval` (state `blocked` only:
  the exact command or action the user must approve, at most 300 characters); the thread rules say: when the permission check denies an
  action the user asked for, report blocked with `approval` and stop, never retry another way. The pane shows `tN needs your yes in its
  own session: <action>` with an `Open tN` button (no button while the thread is working). The press stops the thread's idle process
  (the stop-before-replace helper: only a session in the thread folder, never a working one; it waits until the process is gone),
  then opens `claude://resume?session=<sessionId>` with the system opener (argv, no shell: `open` on macOS, `xdg-open`, `rundll32`). Nothing is
  stopped when the Claude app is not running (macOS). A failing opener answers `Could not open the Claude app: <first line>; open tN
  from the session list in the Claude app by hand`. The desk guide says: tell the user to press Open tN and answer there; the desk never
  performs the action itself and never routes around the check (the push flow of 1.0.8 stays for pushes). The desk's direct line for
  such a report carries the same instruction.
- Thread rules: state `blocked` is for being stuck; finished work is `done`.

### Checked, nothing to fix
- **"Threads blocked" with a report that starts "Done:".** `lean_report` stores the `state` the thread passed, unchanged (it is neither
  derived from the text nor coerced), and the export's filter is exactly `kind: report` and `state: blocked`; no other code writes
  an inbox row with that state. So that thread really sent `blocked` with a text that said done. The export is right to list it; the
  thread rule above now says what each state is for.
- **claude.ai connectors in a project profile.** `profile.ts` already accepts `claude.ai X` and matches the connector's tools
  (`mcp__claude_ai_X__...`) apart from a plugin server of the same product (`mcp__plugin_x_x__...`): the profile entry `claude.ai X`
  loads the connector and defers the plugin's server (still found through ToolSearch), while the bare product name `x` matches both
  spellings. Specs added. Threads get what the profile names and nothing is removed.

### Not done
- **Doctor row "plugin server <x> is not signed in; the claude.ai <X> connector is".** The data cannot be reached from the mod. The mod's
  `Host` is files, processes, env, clock and store; there is no MCP status or tool-list API (the tool list is seen only per call or per
  `tool.describe`), and a server's "needs sign-in" / "connected" state is in no config file. `claude mcp list` prints it, but it health-checks
  every configured server (it starts stdio servers and calls remote ones), which a doctor check must not do. The existing `MCP` doctor rows
  keep reporting unset `${VAR}` references only. A profile that names `claude.ai X` (above) is the way to make threads use the connector.

## 1.0.9

### Fixed
- **The desk retried a compaction after every turn and showed a red failure in Claude Desktop.** The desk there is an SDK
  (headless) session, and the engine answers `$.session.compact: not available in a headless (-p / SDK) session yet: compaction
  here runs inside a turn (a /compact prompt)`; the "hopeless" check did not match that text. It now matches both message shapes
  and any "not available" for `session.compact`. The headless answer is asked once per session start and recorded as
  `unavailable` (not `failed`): no retry at the turn end or after the retry gap, no notice, no automatic handover. One calm
  state instead: "desk context Nk: the app cannot compact the desk automatically. Press Restart desk (fresh desk with the handover)
  or type /compact".
- **Pane:** while the desk is over `deskTokens` and cannot be compacted by the mod, that line is shown at the top with a
  `Restart desk` button next to it (same two-step press as the one at the bottom); it replaces the footer line.
- **Doctor:** the `last desk compaction` row for that case is a `note` row with the advice, not `FIX`. A `failed` record that
  holds the headless text (written by 1.0.8) reads as the same note.
- **Restart desk and Open desk opened nothing.** Both ran `claude --desktop`, which refuses when its output is captured ("can't run
  non-interactively"), as it always is from the mod. They now open the app's own deep link
  `claude://code/new?folder=<percent-encoded real path of ~/lean-agent-desk>` with the system opener, as argv without a shell:
  `open` on macOS, `xdg-open` on Linux, `rundll32 url.dll,FileProtocolHandler` on Windows (`explorer.exe` exits 1 on success). A
  failing opener answers "Could not open the Claude app: <first line>; start a new session in ~/lean-agent-desk by hand" (Restart
  desk keeps the handover either way and says where it is). `claude --desktop` is only tried when the opener cannot be started
  at all. The "app is not running" check is macOS only.
- **The login opener had the same bug.** `opener/open-desk.sh` ran `claude --desktop >>"$log" 2>&1`, which the CLI refuses
  (redirected output). It now opens the same deep link with `/usr/bin/open` (the real desk path, percent-encoded byte by byte
  in `sh`), and runs `claude --desktop` in the desk folder only when `open` fails. The last log line, which the doctor shows as
  "last opener run", is always the outcome: "desk opened in the Claude app (deep link, exit 0)", "desk opened in the desk folder
  (claude --desktop, ...; the deep link failed: ...)" or "desk not opened: open exit N (first line); claude --desktop exit M; start a
  new session in ~/lean-agent-desk by hand". An installed copy is refreshed by `doctor --fix` (the doctor's "opener script
  current" row).
- Not done: the mod does not start `/compact` itself in a headless session. The engine types document `$.command.run`,
  `$.prompt.submit` and `$.skill.prompt`, but none of them says it works headless (reasons in the header of `deskcompact.ts`).

## 1.0.8

### Fixed
- **A thread could not push even after the user approved it.** A push has two gates: lean-agent's (a green review or the desk's
  `approve-push` for the exact sha) and Claude Code's own permission check, which judges each command in the session that runs it.
  The user's "push and open the PR" is said to the desk, so a thread's session never saw it and refused `git push` as unwanted.
  The push now runs where the user approved it, in the desk: the new `lean_thread` action `push` (`tN`, full `sha`, optional
  `pr: { title, body?, base?, draft? }`) follows `approve-push`. Before anything leaves the machine it checks, in order, and refuses
  with the reason: the desk role, the thread and a non-private project, the full sha, the thread's registered worktree (a linked
  worktree of the project's own repository) with that sha as HEAD on a branch that is not protected, guarded or the remote's
  default (read from the remote when unknown here; still unknown = refused), a green review for the sha, a valid approval
  (consumed by the push: a second `push` is refused). Then it pushes that exact commit to `<remote>/<branch>` (never `--force`,
  never a tag, no prompt, bounded in time; the upstream is set afterwards) and, with `pr`, runs `gh pr create` from the worktree
  (the body on stdin) (`gh` found on PATH, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`; missing: the
  reply gives the compare URL from the push output; no PR after a failed push). The reply, the thread's `history.jsonl` and a
  queued message to the thread record what happened, failures with the step and the first error line.
- Threads never run `git push` or `gh pr create`: the push gate's refusal for a thread, the `review` and `pr` skills, the thread
  rules and the desk guide now say "report `ready to push <sha> (branch, PR title)` and stop"; the desk asks the user, naming the
  exact sha and branch, and pushes. The push gate itself is unchanged (the thread's pre-push hook too).
- **Desk push follow-ups.** A branch pushed to a fork (the push remote's repository is not that of `upstream`, else `origin`) is
  opened with `gh pr create --head <owner>:<branch> --repo <base>` (owner and repository read from the remote URLs; a URL that is
  not plain host/owner/repo is never guessed at, and without `pr.base` the base repository's own default branch is used). A closed
  or closing thread cannot be pushed ("reopen tN first"; nothing is consumed); a parked one only paused, so it can.
- **Rule path patterns are compiled once and bounded.** The loader compiled every `paths:` glob on every tool call; it now keeps the
  compiled globs per rule file sha (at most 200 files, the oldest goes first). A pattern past 200 characters, 4 `**`, 4 brace
  groups or 16 commas never matches (brace groups multiply), and doctor shows a `FIX` row naming the rule (`lean_rules check` warns).
- **The desk handover is served once.** A new desk session's start renames `desk/handover.md` to `handover-read-<date>.md` (the last
  3 are kept) and its first prompt names that path and when it was written, so a later desk never finds a stale handover as a fresh one. Only a NEW desk session consumes it: the file's last line names the
  session that wrote it, and that session's own start (a resume, a compaction, a reload) leaves it where it is.
- **A parent guide that comes back while the desk runs is caught within 30 s**, not at the next `lean_thread` call: the desk's tick
  stats the guide files (size, and mtime when the host gives one) and runs the guard when one changed, and again at the next tick
  when a stale guide is still there (a failed move).
- **The ledger split keeps equal rows.** Byte-identical rows (two equal turns in one second) were dropped when 1.0 rows moved out of
  a legacy file; they are kept now (a retry after a crash still adds only what is missing). The notice names the rows kept in
  `ledger.jsonl` and the rows of a past month moved to `ledger-YYYY-MM.jsonl` files separately.
- **`desk/reports/` is pruned**: files older than 30 days, then all but the newest 500, at most once an hour when a full-text report
  file is written. The file of a send the desk refused is removed (the unread row hands the text over in full).
- Not done: learned rules for a plain (non-thread) session in a registered project. The checkouts already load synced rules natively,
  and injecting them into every non-lean session would double them and cost a `git worktree list` per project each minute (the
  reasons are in `ruleload.ts`).

## 1.0.7

### Removed
- **Thread checkpoints (1.0.6) are gone.** A thread is no longer asked mid-work to report its context size and restart: no
  instruction at tool boundaries, no `lean_report` state `checkpoint` (the schema is `working | blocked | done`), no
  `threads/tN/checkpoint.json`, no 10 s checkpoint sweep, no "checkpoint N" in the pane, no `checkpoints` line in `lean_doctor stats`,
  no config `checkpoint.threadTokens` / `checkpoint.enabled`. A `checkpoint.json` left on disk by 1.0.6 is ignored; `checkpoints` /
  `lastCheckpoint` in an old `thread.json` stay readable and nothing writes them; an old inbox row with state `checkpoint` shows as before.

### Fixed
- **`lean_report` failed with "posix_spawn 'mkdir' ENOENT" and the report never reached the desk.** `$.process.run` defaults its working
  folder to the SESSION's, and a thread that had cd'ed into a worktree that was then removed made every spawn fail before the command
  started (Node names the command, not the folder). Now every process the mod runs has an existing folder: with no `cwd` given the
  user's home is used (`hostOf`, the one place every call goes through), and when a spawn with a `cwd` that was given (a repo, a thread
  folder) is refused with ENOENT the folder is looked at: gone = the call rejects with "folder <x> is gone" instead of a spawn error.
  `lean_report` also never loses a report: a write refused by a spawn error is tried once more with the home folder; when that fails
  too, the tool answers FAILED with the report text and the exact error, so the thread can paste it, and `lean_doctor check` shows the
  failure (`report-failure.json`: one record per thread, cleared by that thread's next report, dropped after 24 h). The thread rules
  say: never remove the worktree you are in.
- **A plugin MCP server that needs a variable works again in the desk and in threads.** A config such as
  `https://${DD_MCP_DOMAIN:-not-setup}/v1/mcp` got its placeholder default (`getaddrinfo ENOTFOUND not-setup`), because the desk runs
  in the Claude app and threads are started from it: the user's shell variables never reach them, and editing the default in the
  plugin folder is lost (background sessions copy synced plugins, updates reset them). 0.45 solved this; 1.0 had dropped it. Restored
  as mod code (no model reads configs or values):
  - **Detect.** `lean_doctor check` (also `/lean-agent-setup` and the pane) scans the MCP configs of enabled plugins (installed ones
    and plugins synced from claude.ai, `plugin.json` `mcpServers` / `.mcp.json`), the user's MCP servers (`~/.claude.json`) and
    registered projects' `.mcp.json` for `${VAR}` / `${VAR:-default}` whose variable is not in the env a desk or thread session gets
    (the user settings `env` block; not the shell). One `MCP ` row per server, names only: `plugin:<p>:<server> needs NAME (unset: it
    falls back to 'not-setup', a placeholder, so the server cannot connect)`. A placeholder default (a word like `not-setup`, or a bare
    host in a URL) is flagged; empty and usable defaults are not reported. These rows are not setup problems.
  - **Fix (non-secret values).** `lean_doctor` action `mcp-env` (desk): with `name` + `value` it merges the variable into the `env`
    block of `~/.claude/settings.json` (other keys kept, atomic, written through a symlinked file), so every new session gets it
    (app, terminal, desk, threads); without arguments it lists what needs one. Names that look secret (`KEY`, `TOKEN`, `SECRET`,
    `PASSWORD`, `CREDENTIAL`, `AUTH`, `PAT`) and names that change how sessions run (`PATH`, `NODE_*`, `GIT_*`, proxies, `CLAUDE_*`...)
    are refused, as are values that look like a credential (URL with a password or `?key=`, token prefixes, long random strings; a
    UUID, a path, `JIRA_URL`, `AUTH0_DOMAIN` are fine); only a variable an enabled plugin's or the user's own MCP config references is
    written (an allowlist; a project's `.mcp.json` is listed, never opens it); an existing different value is not overwritten unless
    the call says `replace: true` (the reply says "replaced"); the reply never repeats the value. The pane has no text field, so the
    desk asks (AskUserQuestion) and makes the call.
  - **Secrets never go into `settings.json`.** `~/.lean-agent/mcp-env.json` (0.45's form, user-only) holds `{"NAME": {"command":
    "..."}}` (a string runs as `/bin/sh -c`, a list as an argv) or `{"value": "..."}`. At THREAD start the mod runs the command (15 s)
    (the commands run side by side, at every thread session start: new, start, reopen, checkpoint, a resume of an older-version
    thread) and writes the value into that thread's own `.claude/settings.json` (created empty and `chmod 600` before it is filled and
    the mode checked after; if that fails the thread starts without the values and says so), only for names an MCP config references
    and only when the user `env` block does not already set them; a file that is not the user's own or that others can write
    (checked before it is read, symlinks followed) is ignored, and one others can only read is tightened to 600. Nothing writes a command (no tool, no model); the start reply names names
    only. For the desk and the app the way is OAuth sign-in through the server.
  - **Which value wins** (checked live with Claude Code 2.1.328): a user `env` value resolves `${VAR:-default}` in a user MCP server's
    URL; a project's (thread folder's) `env` value resolves it too when the user block lacks the name; with both set the user's value
    is used. So a thread's env fills gaps and never shadows; `threadSettings` merges it with the git-hooks env.
  - **0.45 import.** The versioned tidy (now version 4) moves the plain non-secret values of `~/.lean-agent/mcp-env.json` (and
    `legacy-0.45/mcp-env.json`) into the settings `env` block once, keeps command entries and secrets in `mcp-env.json`, and the
    doctor names what moved and what stayed. A `settings.json` that does not parse keeps the import pending.
  - README section "MCP servers that need a variable (e.g. a site/domain)"; doctor skill and desk guide text.

### Added
- **Done = session over.** When a thread's last report is `done` and its turn has ended, the desk's 10 s tick stops its process
  (the stop-before-replace helper; only a session in the thread's folder) and marks `thread.json` `finished`: "t3 finished: next
  message starts a new session". A thread that reported done but is still on a final step is stopped only once it is idle. Any
  later `send`, `wake`, `resume` or `start` starts a NEW session with the handover (brief, goal, notes, reports including the done
  report, queued messages, branch/worktree) through the same path as a reopen, never a resume of the old conversation. Blocked, question
  and progress reports never finish a session.
- **Restart buttons in the pane.** Every open thread row has `Restart` (confirm on the second press; for a working thread the label
  reads "Confirm restart t3 (it is working: the current step is lost)"): the session is stopped (only one in the thread's folder, waits
  until it is gone) and a new session starts with the handover, same model and effort, reason "Restarted from the pane.". The same as
  `lean_thread restart tN` (the desk, only when the user asks). `Restart desk` writes `desk/handover.md` now and opens a new desk
  session (`openDesk`): "New desk opened with the handover: close this one"; also the command `/lean-agent-restart-desk`.
- **Oversized tool results are cut before a thread sees them.** A Bash or MCP text over 20000 characters (config `toolResultChars`,
  `0` = off, below 2000 ignored) keeps head and tail; the full text is saved under `~/.lean-agent/output/` (one folder, shared with the Bash line squeeze; pruned: files older than 7 days and all but the newest 2000 go, at most once an hour) and one line says where. Edit and
  Write results, errors, a subagent's results, lean-agent's own tools and the desk are never touched. `lean_doctor stats` counts it
  ("saved 140.0k chars in 12 results"). The thread rules say: big reads and searches go to reader subagents, which return conclusions.

### Changed
- **Desk compaction** (not a checkpoint, stays): the default limit is 200k (config `deskTokens`; the 1.0.6 `checkpoint.deskTokens` is still
  read). The reason of every vetoed or failed compaction is recorded (`desk/compact.json`, a notice, a `lean_doctor check` row) and the
  compaction is tried again when the desk's turn ends (before: ten minutes later). The status text reads "desk context Nk: type
  /compact (or start a new desk session; it reads the handover)". Three vetoes in a row give the handover file and that status line too;
  the compaction notes are written once per episode; the notice and the doctor row clear when the context is small again. The code
  moved from `checkpoint.ts` to `deskcompact.ts`.
- The goals chaser skips a finished thread (or one whose last report is done): its message would start a whole new session. A finish
  that fails (stop refused, session outside the thread folder) is retried after 5 minutes and given up after 5 tries with a notice.

## 1.0.6

One combined release: checkpoints (threads and the desk), the 1.0.6b reply, delivery and feedback-export fixes, lazy loading per
project (profiles, needs, usage counter), and the urgent rule-loading, sync, 0.45 guide and ledger fixes.

### Added
- **Checkpoints are back (threads and the desk).** A session has a 1M-token window, so the engine's own auto-compact comes very late and
  every request pays for the whole context in cache reads. The mod now keeps each session's context size (input + cache read + cache
  write of the main loop's latest request) and acts at `checkpoint.threadTokens` / `checkpoint.deskTokens` (config.json, both default
  100000; `checkpoint.enabled` default true).
  - **Threads.** Over the threshold, at the next tool boundary of the main loop (never while a subagent or a `git push` runs, never
    for a parked or closed thread, at most one checkpoint per 20 minutes), the mod adds ONE instruction to a tool result (or the next
    wake prompt): finish the current step, then `lean_report` with the new state `checkpoint` (branch, worktree, last commit, pushed?,
    done, open items, next step) and stop. At that turn's end the mod marks the thread ready (`threads/tN/checkpoint.json`); the desk's
    10 s tick then starts a NEW background session for the same tN through the reopen-as-fresh path (handover from the brief, goal,
    notes, report history including the checkpoint, remembered items and queued messages; the thread's own model and effort; the new
    session id is appended to `sids`; `thread.json` counts `checkpoints`) and stops the old session. A thread that does not report gets
    one reminder turn, then is checkpointed anyway from the reports it already wrote. A start that fails is retried after a minute and
    given up after five tries with a notice.
  - **Desk.** When the desk is idle and over its threshold the mod calls `$.session.compact` with fixed instructions (keep goals, the
    open threads table, unanswered thread questions, the user's preferences and decisions, pending approvals; drop tool outputs and old
    report texts); a hook veto is retried after ten minutes. When compaction is not possible it writes `~/.lean-agent/desk/handover.md`
    and shows "desk context Nk: start a new desk session (it reads the handover)" in the status line and the pane; the desk's CLAUDE.md
    tells a new desk session to read that file. The handoff notes of the `session.compact` hook keep working (the engine skips a
    plugin's own hook for its own compaction, so the mod writes the notes itself before calling it).
  - **Pane and stats.** Thread rows show "checkpoint N" after a checkpoint, the pane footer shows the desk's context size, and
    `lean_doctor stats` counts checkpoints per thread.
  - `lean_report` `state` accepts `checkpoint` (it never wakes the desk: it is recorded like a progress report).

### Fixed (threads: replies and delivery)
- **`new` / `start` / `reopen` say what the session got.** The reply is now `t12 started (<sid>) · sonnet/high`, and the generated thread
  `CLAUDE.md` has the line `model: sonnet, effort: high (from thread.json)` (a reopen rewrites it with the choice the new session
  starts with), so neither the desk nor the thread has to look it up.
- **`close` says what happened to the session** (`t3 closed; session stopped`, `... no running session (already stopped)`,
  `... no session in the list (already removed)`, `... no session was ever started`). After the stop it runs `claude rm <id>` so the
  stopped session leaves the app's list (its conversation is kept: `claude --resume` lists it), only for a session whose folder is the
  thread's own (`rm` also deletes a worktree the session was started in) and never with `--discard-unpushed` or
  `--force-remove-worktree`; when `rm` refuses, the reply says so ("the app keeps stopped sessions in its list (claude rm: ...)") and
  the thread is closed anyway. The CLI has no command to rename a background session, so closed sessions are not labelled
  "[closed] tN".
- **A long report arrives once.** A report longer than `DIRECT_MAX` (1500 characters) used to arrive twice: cut as a direct line, then
  in full at the next prompt. The full text is now written to `~/.lean-agent/desk/reports/<ts>-<tN>-<report|ask>.md` (plain lines the desk can
  Read), the cut line names that file and carries its row key too, so the row counts as delivered and nothing hands it over again
  (the pane's Answers list still has it). When the file cannot be written, or the send is refused, the row stays unread for the next
  prompt as before. The pointer is an absolute path, and the file is only written for a real thread id. A question is cut only past
  8,000 characters (its options are clamped to 1,000 in the line); the file has all of it. The generated thread guide leaves the `model:` line out when it is built without a
  choice (compare's throw-away folder), and `close` also removes the session when the listing prints the real path of a linked home.

### Fixed (desk, feedback export)
- **The desk can open lean-agent files in the app.** The app refused `~/.lean-agent/feedback-export/<file>.md` ("This file is outside
  this session's folders"). Setup (`/lean-agent-setup`, the pane button, `lean_doctor fix`) now merges `~/.lean-agent` into the desk
  folder's `.claude/settings.json` `permissions.additionalDirectories` (every other key and folder of the user stays; a file that does
  not parse is left alone and said so), and the doctor check flags it as a FIX row when it is missing.
- **`/lean-agent-feedback` talks to the user.** The reply was wording meant for a model ("show the path; the user pastes ..."). It is
  now "Feedback export written: <path> (36 KB, anonymised). Nothing was posted. Paste it to the maintainers, or ask the desk to post
  it."; the refused and failed replies are plain words too (they say nothing was posted).
- **Draft headings in the export.** A draft was titled `### <secret>.md` because its long date-slug file name looked like a secret. The
  title is now the draft's first heading (its first line when there is no heading; the file name as words when the draft is empty).
  File names only go through the home, user-name, project and path rules, never the secret or hash rules.
- **The export always has its aggregate sections.** A first real export had none although `feedback.jsonl` held 133 rows: the 0.45
  rows lived in `~/.lean-agent/feedback/feedback.jsonl`, which was not read, and a row's time in seconds or as a date string was not
  understood. Both files are read (a row in both counts once), old shapes (`missing` and `refused` as strings, a status-less row, a
  numeric-string or ISO time) are understood, and every section is printed with `none` when empty (notes, doctor problems, drafts,
  reports by status, reports naming missing context, `missing`, `refused`, `unverified`, `unreached`, guard refusals, script
  candidates, blocked threads), plus a `Read:` line with the row count of each file, so a missing section can no longer hide a bug.
  A feedback, gap, refusal or inbox row with no readable time is counted by the first export only. Drafts keep every line but the one
  used as the title, and a long title is cut after anonymising.
- **The public repo path survives the anonymiser.** `github.com/mcmadsen/lean-agent` and `mcmadsen/lean-agent` became
  `<user>/lean-agent` when the OS user name equals the repo owner. The exact public repo path now passes before the user-name rule
  (another repo of the owner, a longer name such as `mcmadsen/lean-agent-extras`, and the plain name are still masked).

### Added (lazy loading: MCP servers and plugin skills per project)
- **Project profile = allow-list.** `~/.lean-agent/<project>/profile.json` holds `mcp: [...]` and `plugins: [...]`. A project without
  one behaves exactly as before (nothing is held back; a list left out of a profile is not restricted either). A thread started in a
  project with a profile loads that set: plugins outside `plugins` are switched off in the thread folder's `.claude/settings.json`
  (`enabledPlugins`, like `model` and `effortLevel`; only plugins that are skills and nothing else: never lean-agent itself, and never a
  plugin with an MCP server, hooks, agents, commands or tools of its own, which would be removed instead of deferred, or one whose folder
  cannot be read), and MCP servers outside `mcp` are DEFERRED, not removed: the thread's mod answers `tool.describe`
  with `isDeferred: true` for their tools, so their names stay findable through ToolSearch and a thread that unexpectedly needs one
  still calls it. lean-agent's own tools are never touched. (`--strict-mcp-config` was not used: it needs the config of every server
  regenerated, which cannot be done for connectors and plugin servers; the mod's deferral works for every source.)
- **`needs`** on `lean_thread new` / `start` / `reopen` (closed thread): `needs: ["azure-devops"]` adds to the profile for that thread
  only (kept in `thread.json`, so a later start keeps it). The thread's CLAUDE.md says what is loaded and how to ask for more (ToolSearch
  the server name; else `lean_ask` the desk, which starts it with `needs`).
- **`lean_thread profile`** (desk): show a project's profile with the usage counted in its threads, set `mcp` / `plugins`, `fill: true`
  to add what the threads really called, `on: false` to remove. **`lean_profile`** (thread tool, used by the learn skill) shows or fills
  the same from usage. Threads count the MCP servers and skills they call in `threads/tN/usage.json` (names and counts, never arguments);
  `fill` never removes a name, learns nothing from threads that have no counter yet, creates an `mcp` list only where a server was really
  called (a project whose threads called none gets no empty allow-list), and never creates a `plugins` list (a skill run by slash command
  is not counted: the used plugins are reported, a list the profile already has grows). A profile with a damaged list counts as no
  profile (and `profile` says so). `lean_profile` is a deferred tool in threads.
- **What a thread loaded is visible.** `new` / `start` / `reopen` answer `tN started (<sid>) · sonnet/high · mcp: a,b · plugins: x` (one line:
  model/effort always, the loaded set only for a project with a profile) and `list` shows it per thread
  (only for projects with a profile). `compare` starts its thread column like a thread of the project (profile applied) and adds a
  "Loaded in thread" line.
- **Ledger rows carry effort and the thread's model** (from `thread.json`). `stats` adds "by thread model/effort" and one line
  "threads at the default (sonnet/high): N, $X, median $Y", plus the share of thread spend from before the rows carried it.

### Changed
- **`compare` suggestions no longer mislead.** Per-server and per-plugin figures are labelled "definition size, mostly deferred, not
  first-turn cost" (the measured effect is the "One source off at a time" line). A server or plugin with recorded use reads "used 41
  times in 12 threads: keep"; lean-agent's own server is never suggested; advice is given for the thread column only (not the clean
  column, not the desk); the lever printed is the project profile, not the global `tools.thread.drop`.

### Fixed (rules, sync, 0.45 guide, ledger)
Urgent rule-loading, sync, guide and ledger fixes found on a real machine (field report: rules never reached threads, 16 of 17 synced
copies deleted, a stale 0.45 guide still loaded, today's rows moved out of `ledger.jsonl`).

- **Learned rules never reached threads.** Measured with the engine (2.1.327): `.claude/rules` loads only beneath the session's ROOT.
  A thread's root is its own folder and it reads the project by absolute path, so with the engine alone no rule loaded and no
  `InstructionsLoaded` was ever fired (a session rooted elsewhere reading `<repo>/src/a.ts` loaded nothing, with or without
  `--add-dir <repo>` or `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD`; only a session rooted in the repo did). The mod is now the
  loader (`hooks/ruleload.ts`): on a thread's or its subagent's Read, Edit, Write, Grep, Glob of a path inside a registered project or
  one of its worktrees, and on a read-only `cat`/`head`/`tail`/`rg`/`grep`/`ls` ... naming one, every rule of the store whose `paths:`
  match is appended ONCE per context (the session, and each subagent separately) to that tool result; a repo-wide search does not
  dump every rule. `_project.md` is a prompt section of the thread from its start, and a subagent's first tool result carries it.
  Each injection is a row in `logs/rules-loaded.jsonl` (rule, project, session, thread, agent, trigger, sha) which `stats` counts;
  a load the engine did itself (a session rooted in the checkout) marks the rule as given: nothing is injected twice (key: rule +
  sha). A live run: control rooted elsewhere NONE and 0 events; with the mod, both the `_project` token and the path rule's token
  reached the model and 2 rows were logged.
- **Notices for a thread's first prompt never arrived.** `session.start` has no `context` field (the engine ignores it), so the
  "rules for X are stale" line given there never reached a thread. Role-setup lines now go with the first `prompt.submit`.
- **1.0.5 sync deleted 16 of 17 rule copies, and nobody was told.** The new size caps made sync skip the failing rules and
  `mirror` then removed their old copies. Now a rule over a cap (written by an older version) is grandfathered: copied anyway and
  reported, up to three times the cap; beyond that it is skipped, and a skipped rule never deletes the copy a checkout already has.
  Only a rule whose store file is gone is removed. The thread start now uses the sync result: its first prompt says "rules: N
  skipped (over cap: ...), M over the cap but loaded anyway (...); run learn --trim or lean_rules check"; `lean_rules stats`
  returns `overCap`; and the desk's first session after an update runs `lean_rules check` for every project once and says so (pane
  notice + the desk's next prompt). A thread start now syncs the checkout AND every worktree of the project (`git worktree list`,
  so a plain `git worktree add` one too), not only the checkout.
- **`"rules": "off"` in projects.json** (a 0.45 key): nothing in 1.0 read it. It is dropped (not honoured: a project with learned
  rules wants them loaded) the first time the desk starts after the update, and the desk is told which project had it.
- **`stats` and `compare` said "17 never loaded" when no load had ever been recorded.** They now say "no rule load has ever been
  recorded (log absent): loading unverified", and `--trim` is suggested only for rules a recorded load came after (the log has an
  event from after the rule was written); `lean_rules stats` returns `verified`, `events`, `neverConfirmed`.
- **A stale 0.45 orchestrator guide kept loading into every thread** (`~/.lean-agent/threads/CLAUDE.md`). The tidy that moves it
  ran once per version and never looked again (and a session reads its parent folders' CLAUDE.md before any mod hook runs). A cheap
  `guardParents` check, outside the version gate, now runs at the `session.start` of every role, before the desk starts, wakes or
  messages a thread, and in `doctor fix`: a parent CLAUDE.md that is the 0.45 guide (its "orchestrator guide" title, or
  commands of the removed CLI such as `lean-agent run`) and that 1.0 did not write moves to `legacy-0.45/` (under a lock; an older
  backup keeps its name, the new one gets a timestamp); a user's own file, even one that mentions lean-agent, is never touched. The tidy
  version is 3, so the full tidy also runs once more for everyone on 1.0.x. 1.0 writes a one-line guard file
  `~/.lean-agent/threads/CLAUDE.md` (about 40 tokens per thread, marked as generated) in its place, so a stale one coming back is
  noticed and moved at the next start.
- **The ledger rotation moved today's 1.0 rows out of `ledger.jsonl`, silently.** A ledger that starts with a 0.45 row is now split
  by row format: 0.45 rows go to `ledger-legacy.jsonl`, 1.0 rows stay in `ledger.jsonl` (lossless: the 1.0 rows are only appended,
  never swapped in by a rewrite, under a lock, verified before the legacy file is replaced, resumable without a duplicate). A
  `ledger-legacy.jsonl` that 1.0.5 left holding 1.0 rows is repaired at the next start (and again at every start until it worked).
  Every rotation or repair is announced once: a pane notice, and the desk's first prompt of its next start whichever session rotated. A rule given to a
  thread is given again after a compaction. `stats` states its period and the ledger files
  it read, and warns when `ledger.jsonl` starts inside the window. A rebuilt rollup no longer reads an empty file for a ledger over
  4 MiB (`fs.read` rejects it: the text now comes from `tail`). A thread asks the desk for spend with `lean_ask` (the stats skill says
  so; no new thread tool, so no new tool definition in every thread) and never reads `ledger.jsonl` itself.

### Fixed (release review of the combined 1.0.6)
- **A checkpoint instruction never rides on the result of `lean_report` or `lean_ask`**, and a `lean_report` with state `checkpoint` from a
  thread that was never asked is only a progress report: a thread that had just reported `done` could be told to checkpoint in the same
  result and be restarted as a fresh session; the instruction comes with the next call instead.
- **The desk sees a checkpoint report cut to its first 300 characters** (the fresh thread session reads the whole report from its
  handover; the pane's Answers list has it), so checkpoints no longer put a long handover into the desk's own context.
- **The ledger split sends 1.0 rows of a past month to their own `ledger-YYYY-MM.jsonl`** instead of appending them to `ledger.jsonl`
  (which would then start in a past month and be rotated away whole at the next start, today's rows with it).
- **Rule stats read a load log over 4 MiB from its tail** (the newest 3 MB) instead of calling it "log absent: loading unverified";
  a rule written before the oldest row read is never reported as "never loaded" (`--trim` is not told about it).
- `session.compact` forgets the context size and re-arms the rule loader on the same condition (the compaction went ahead).

## 1.0.5

One combined release: the desk, thread and pane work, the learn flow, stats and compare work, and scripts over models with the
feedback export. The sections are grouped by area.

### Fixed (learn flow, stats, mod)
- **Version skew is visible.** A session keeps the hooks module it loaded at start, while skills, agents and templates are read from
  the plugin folder again after `claude plugin update`: the skill text could say 1.0.4 while the guard refused like 1.0.3 (an explorer
  was refused `rg`, `ls` and `cat`). The mod now compares its own version with the installed one (the plugin root's
  `.claude-plugin/plugin.json` and Claude Code's `installed_plugins.json`, the higher wins; cached for a minute) at `session.start`
  and every `turn.start`: a status line and one `prompt.compose` line say "lean-agent code X is running but Y is installed: start a
  new session (threads: close and Start)". `lean_doctor check` reports it as a FIX row. Every refusal of the guard (`decide`) ends with
  "(lean-agent <running version>)", and `feedback.jsonl` rows and `refusals.jsonl` carry the running version.

### Added (learn flow, stats, compare)
- **An explorer that can explore.** The learn skill runs ONE preflight explorer (`git -C <repo> ls-files <folder> | head -3`,
  `rg -n <word> <file>`) before launching the rest; on a refusal the lead lists the files itself and hands each explorer a capped
  `git ls-files` list, or uses `lean-agent:reader-sonnet`. The lead always passes the capped list. `agents/explorer.md` says Grep/Glob
  may not exist, to use the read-only Bash commands and to stop and report a refused command. Small areas are explored inline by the
  lead; explorers are for big ones. Judgment-heavy areas use `reader-sonnet`, listing work stays on the haiku explorer.
- **LEAN-FEEDBACK `refused`, `unverified`, `unreached`** (explorer and readers): commands the guard refused with its text, claims not
  checked, folders not covered. Counts and the first entries go to `feedback.jsonl`, refusals to `refusals.jsonl`.
- **Deltas, not restatements.** The brief carries the area's folders, the capped file list and the repo's own docs
  (`CLAUDE.md`, `.claude/rules`): "read these first, return only what they do not say, contradictions as `CONFLICT` with both sides".
  A rule bullet may point at a doc (`see <path>`) but never restates it.
- **Modes and budgets.** `--gaps` (default when the repo has its own docs) and `--full`. Size budget next to the line cap: 2,000
  characters per rule (about 500 tokens), 600 for `_project` (about 150), no line wider than 240; lines count non-empty body lines.
  `lean_rules check` is a dry run (lines, chars, cap violations, rules without `paths:`, covered and missing areas); `sync` skips a
  rule over any cap and says why. `record` counts `lines` from the file itself (a differing caller value is reported) and warns when a
  rule is over a cap. A rule's `paths:` takes several globs (and `{a,b}` braces): the way to wire areas together.
- **Areas covered by repo docs** are recorded with `covered_by: <doc>` (no rule file): never stale, skipped by the next run.
- **Verification.** Hard rule: a rule line is written or kept only if checked against the code in the run; the rest goes to an
  `UNVERIFIED` list in the report. `lean_rules verify` extracts every backticked path, symbol and number of each rule (and its
  `relies-on` list) and searches the repo with `git grep -F` / `git ls-files` (read-only, at most 150 names per call, 40 per rule); the
  skill's `--verify` mode then re-checks semantically only what it cannot judge (KEEP / FIX / DROP).
- **`relies-on:`** in the rule footer (written by `record` from `relies`): an area is stale when a relied-on file changed or vanished
  since the recorded sha, not only by changed-file count; the count limit is `max(15, 10% of the area's files)`.
- **Legacy 0.45 cards.** learn step 0 reads `legacy-0.45/index.md` and the project's cards as candidate facts (drop hashes, PR status,
  sizes, counts, dates, diaries, `file:line` cites; keep mechanisms, invariants, commands, traps; narrative to `lean_remember`). The
  migration, and the versioned tidy (now v2, so people migrated earlier get it too), write that index: per card file, title, size and
  area guess.
- **Subagent caps.** `learn.maxExplorers` in `config.json` (default 4) or a cap from the user's `CLAUDE.md`: areas are grouped into at
  most that many assignments, 25 lines per area each; the explorer reports `unreached`.
- **Sync of every worktree.** `lean_rules sync` with `all: true` syncs every worktree of the project (`git worktree list --porcelain`
  plus `worktrees.json`) and answers one line per checkout ("<path>: copied N, removed M, skipped K, exclude ok") and the skipped
  rules once; `verbose: true` lists every path. The skill says recipe skills are synced together with rules.
- **Stats are computed by the mod.** The desk could not answer "stats" itself: the skill had a model read and sum a ledger that was
  about 27 MB after a day. `lean_doctor` has a new action `stats` (`days` default 7, max 90; `project`): spend today and for the
  window with request counts, today against `dailyCapUsd`, tables by model, role x model, role, agent and thread (top 10 + rest),
  rule loads per project (never-loaded rules listed, `_project.md` included), worker feedback and gaps, and the count of 0.45 and
  unparsable ledger lines. The `stats` skill says "call it; never read `ledger.jsonl` yourself". The pane footer reads
  "budget today: $x · 7d $y" (view.ts, no pane change).
- **One ledger reader, with rollups.** `hooks/ledger.ts` folds the ledger into per-day aggregates (by model, agent, role, thread and
  role x model: dollars, tokens, requests) kept in `~/.lean-agent/rollup.json` with a byte offset per ledger file; a sync reads only
  the bytes past the offset (`tail -c +N`), never the file from the top. It is rebuilt from the files only when missing, damaged or a
  file is shorter than its offset. The daily-cap cache of `budget.ts` is rebuilt from the same rollup on a new day, so the day change
  no longer reads the whole ledger either.
- **Both ledger schemas.** The 0.45 rows (ISO `ts`, `cost_usd`, `usage{...}`, no `role`/`usd`; about 2 KB each, most of an old
  ledger) were skipped, so "7 days" showed only today. They are read now: `cost_usd` is the dollars, role is `unknown`, the 0.45
  worker role is the agent, the thread is `thread` or `-`. They are never counted against a daily cap.
- **Ledger rotation, no row lost.** At session start a `ledger.jsonl` that begins with a 0.45 row is renamed once to
  `ledger-legacy.jsonl`, and one that begins in a past month to `ledger-YYYY-MM.jsonl`; a fresh `ledger.jsonl` follows. It is a
  rename (a concurrent writer lands in the old or the new file), the rollup offset moves with the file, and every reader (stats,
  caps) reads all `ledger*.jsonl`. The rollup also remembers each file's first line: a renamed file (a crash between the rename and
  the rollup write, another session in between) is recognised by it and not folded twice, and a fresh `ledger.jsonl` that outgrew an
  old offset rebuilds instead of being read mid-line; the cap cache is dropped by a rotation. (0.45 wrote naive timestamps: read as
  UTC, which only moves an old row across midnight.) New rows leave out zero token counts (about 100 bytes shorter; a missing number reads as 0).
- **Rule loads are counted again.** `lean_rules stats` showed no load for rules that had loaded. The `InstructionsLoaded` shell hook
  was the only path, so the mod now also logs `classic.InstructionsLoaded` itself into the same log; a load seen by both counts once,
  and `_project.md` is listed (it was left out of "never loaded"). Not checked on a live Claude Code session in this work (a nested
  session was not allowed): confirm with a learned rule and a Read of a matching file.
- **Unexpected models are visible.** The stats table shows role x model, and `lean_doctor check` lists spend today of the desk on a
  model other than the one lean-agent pins, of threads on a model no thread was started on, and live sessions
  (`claude agents --json`, when it reports a model) that differ from what lean-agent started. Those rows need a new session, not a
  setup press.
- **Learn collects script knowledge.** Explorers also report the repo's own scripts for an area (`SCRIPTS`: package.json scripts,
  Makefile/justfile targets, tools/ and scripts/ folders, CI steps that run locally, each with the question it answers) and
  mechanical work a thread would otherwise spend model time on (`MECHANICAL`); rules then say "for X run `<script>`" instead of
  describing how to find X. A `<!-- lean-agent:scripts -->` ... `<!-- /lean-agent:scripts -->` block in a rule (the mod writes
  adopted scripts there at every sync) is kept byte for byte by rewrites and never deleted by `--trim`; the footer matcher no longer takes it for
  the footer. `--trim` lists mechanical-looking gaps as `SCRIPT CANDIDATES` in the report.
- **Compare is back (rebuilt the 1.0 way).** `lean_doctor` `compare` (desk; `project`, `mode` overhead or history) and a thread's
  `lean_compare` (task mode) run `claude -p "Reply with OK." --output-format json` and `claude -p "/context"` (local, free) in the
  project folder with lean-agent switched off (`--settings` `enabledPlugins` false for the installed `lean-agent@...`, checked live: a
  disabled plugin's tokens drop out of the first turn), in a throw-away thread-shaped folder and in the desk folder: clean / thread /
  desk side by side (first-turn input tokens measured, cost, and `/context`'s categories), skills and MCP switched off one at a time on
  the clean column, suggestions with the concrete step (plugins to switch off, `tools.thread.drop`, memory files into path rules,
  rules that never loaded, script candidates), capped at $0.25. Task mode (the `compare` skill, run in a thread after the user agrees to
  the cost) runs one read-only task clean and as a thread on the same model and effort and a haiku judge compares correctness and
  completeness. Reports: `~/.lean-agent/compare/<date>-<project>.md` and `history.jsonl`, names and numbers only; a private project is
  never compared. README section "Compare".

### Fixed (squeeze)
- **A long failing Bash command failed the whole tool call.** `squeezeResult` rewrote the Bash result as a string. The engine validates
  a hook's answer against the tool's output schema, and Bash's result is the record `{ stdout, stderr, interrupted, ... }` (a failed
  call's is its error text): the string answer was refused ("expected object, received string"), so any long output of a command that
  exited non-zero failed outright, and the successful ones, being records, were never squeezed at all. It now squeezes `stdout` and
  `stderr` of the record, keeps its shape and every other field, saves the full text first, and leaves every other shape (error text,
  content blocks) untouched.

### Changed (desk, threads, pane)
- **Effort defaults go up where mistakes are expensive.** Threads default to sonnet / effort **high** (was medium); `config.json`
  `threads.effort` and `lean_thread new|start` `effort` still override. `worker-sonnet` and `reviewer` run at effort high,
  `reader-sonnet` at medium (was low), `worker-opus` stays high, `worker-haiku`, `reader-haiku` and `explorer` stay low.
- **Reopen is a fresh session, never a resume.** `lean_thread reopen` (and the pane's Reopen) on a CLOSED thread starts a new
  background session in the same folder (same tN, project, worktree, branch; `--model` / `--effort` from `thread.json`) with a
  handover the mod builds: brief, project / worktree / branch, goal (a close keeps the cleared goal's text), notes.md, the thread's
  report history (oldest first, about 4k tokens, the newest report whole), its `lean_remember` items and queued desk messages. The
  old session id stays in `sids`; its conversation is never resumed. It also regenerates the thread's own CLAUDE.md from the current
  template (only when lean-agent wrote it), so a fresh session runs today's code and rules. Result: "tN reopened as a new session
  (old conversation kept read-only)". A parked thread's `reopen` still only flips the state.
- `resume` of a thread that is not closed stays a resume, except when `thread.json` `version` (the lean-agent version installed when
  its session started or was resumed) is older than the installed one: then it starts fresh the same way and says why. An unrecorded
  version is unknown and resumes. `close` clears the thread's goal itself; it never deletes anything.
- A `done` report is a handover: the thread template asks for branch, worktree path, last commit, pushed or not, open items and next
  step, and `lean_report` answers a done report that lacks most of them with a one-line reminder.
- **Thread -> desk direct.** `lean_report` (done, blocked, or `important: true`) and `lean_ask` still write the inbox (source of truth,
  pane, dedupe) and also `$.session.send` one compact line (`[lean-agent] t3 done: ... (close t3 when nothing is left)`) to the
  desk's session; the desk records its session id in `~/.lean-agent/desk.json` when it resolves as desk. The desk's `session.receive`
  hook (origin plugin lean-agent) marks that inbox row delivered, so the next prompt does not repeat it. A missing desk id or a refused
  or failed send falls back to the inbox alone (and the desk's own 10 s `prompt.submit` relay, `desk.autoRelay`), and the tool result
  says so. Verified live: a message sent from one background session to another session id on the same machine arrives as a peer
  message and starts a turn in an idle session. Desk -> thread keeps the inbox queue (read at the thread's next tool step, a wake for
  an idle one): for a running thread `$.session.send` would add nothing and could deliver twice.
- **Pane.** Every section header (Goals, Answers, Projects, Threads, Closed) is a toggle button with a count (`▾ Answers (14, 2
  unread)`); the fold state lives in `$.state` (declared in `types/index.d.ts`), so it survives redraws and mod reloads. Defaults:
  Goals open when there is a goal, Answers open, Projects folded, Threads open, Closed folded. Answers show the newest 5 and "show all
  (N)"; with more than 8 rows "show all" groups them by thread (foldable, the folded group shows its newest line). A row is a button
  that expands to the full report text; unread rows come first with a dot, read ones are dimmed.
- **Pane: Close.** Each thread row has Close (first press arms "Confirm close tN" for 10 s, the second closes through
  `lean_thread close`: stops a finished-but-alive session, clears the goal, no model turn); a working thread shows "busy" instead. A
  "Close all done" button appears when 2+ threads reported done and closes only those whose last report is done and whose session is
  not working (blocked, asking and working threads stay; the check is repeated at the second press). Closed threads move to a
  collapsed "Closed (N)" with a Reopen button each. A session waiting on a prompt nobody answers (`claude agents` `waitingFor`) is
  marked "needs you: open it in the app".

### Added (desk, threads)
- **Usage-limit auto-resume** (spec: `docs/usage-limit-resume.md`). A thread session blocked by the account's usage limit (`claude
  agents --json` state `blocked` without `waitingFor`) used to sit there until someone noticed. The desk's mod (every 60 s) finds
  the reset time (the thread's own mod records the exhausted rate-limit windows at the failed turn; else the last "You've hit your
  ... limit · resets 4pm (UTC)" line of `claude logs <id>`, parsed: `4pm`, `16:00`, `(UTC)` / `(GMT+2)` / IANA zones, `Nov 20, 4pm`,
  `in 2h`; anything else is no answer), and two minutes after it stops a lingering process (`claude stop`, wait until no pid) and
  runs `claude --bg --resume <sid> -- "The usage limit reset; check your worktree state and continue."` (queued desk messages ride
  along). Once per reset (`threads/tN/limit.json` holds the mark, set before the resume; a failed start gives it back, three tries),
  never for a parked or closed thread (marked cancelled, a later reopen does not revive it), never over a working or
  permission-blocked session. The pane row says "paused until 16:00" (instead of "needs you") and keeps Close.
  `desk.autoResume: false` in `config.json` turns it off. Not yet seen on a live limit: see the spec's last section.

### Fixed (desk, threads)
- Background threads blocked silently on permission prompts nobody answers. The `worktree` skill and the thread template say to create
  worktrees with `git -C <repo> worktree add <abs path>` under `~/.lean-agent/worktrees` and never with Claude Code's EnterWorktree
  tool (it asks for a path outside `.claude/worktrees/`); the thread template adds three work rules (edit files only with Edit / Write,
  one simple command per Bash call with absolute paths and `git -C`, never `cd`, no EnterWorktree). The skills contract fails when a
  skill, template or command names EnterWorktree without forbidding it.
- A worktree or branch folder no longer lands in `projects.json`: `project-add` refuses a path that is a linked git worktree, lives
  under `~/.lean-agent/worktrees` or is in `worktrees.json` (it names the main checkout to register instead), and `lean_doctor check`
  flags an existing entry whose path is a worktree (offering `project-remove`, which never deletes files).

### Fixed (desk skills, relay)
- The `pr` skill no longer promises the desk what strict mode refuses. Every step names its role: the desk only reads status
  (`gh pr view|list|status`, `gh search prs`, `az repos pr list|show`); create, comments, update and every push are "route to the
  thread that owns the branch". The host comes from the project's origin URL: github.com uses `gh`; dev.azure.com and
  `*.visualstudio.com` use `az repos pr list|show|create|update` (REST with a PAT as the fallback); a missing or logged-out CLI is
  reported plainly instead of "command not found".
- Desk strict mode allows those read-only forms (`deskBashOk` reuses the private-project guard's own gh/az read-only classifier,
  so the two cannot drift; no `--web`, `--output-file`, `--template`, pipe, redirect or expansion) and `git -C <dir> remote get-url
  <remote>` (to find the host). `gh search` is now read-only in private projects too.
- Skills offered to the desk no longer name thread-only tools or the desk's missing Write/Edit: each step says who runs it
  (`thread: lean_report; desk: tell the user`). The `goals` skill sets and clears through new `lean_thread` actions `goal-set` /
  `goal-clear` (tN, text): two enum words in a tool the desk already has, no new tool, the mod writes the file, and it works for a
  parked or closed thread that a `send` would not wake.
- `lean_thread new` refuses a project that is not registered and answers with the known names (nothing is created); `list` shows
  each thread's project; `commands/new.md` and the `thread` skill say projects come from `lean_thread projects`.
- Reports reach an idle desk. The engine's `$.prompt.submit` starts a turn once the session is idle, so a question or a `done` /
  `blocked` report now starts ONE desk turn with the unread reports (at most once a minute, never while a turn runs, never for
  `working` progress; `desk.autoRelay: false` in `config.json` turns it off and reports wait for the user's next message). A
  refused submit marks the reports unread again.
- Finished threads are closed by the desk: the desk template and `thread` skill say "close it yourself (and clear its goal); never
  ask a thread to close itself", the thread template says a thread cannot close itself and reports done, and a delivered `done`
  report ends with "(close tN when nothing is left)".

### Added (skills roles)
- Skills declare `roles: desk, thread` in their front matter. `hooks/skills-contract.mjs` (run by `skills-contract.test.sh`) checks
  that every `lean_*` tool a skill names exists for a role the skill is offered to (and is marked where only one role has it) and
  extracts the Bash commands a skill gives the desk; `hooks/skills-roles.test.ts` runs them through `deskBashOk`.
  `hooks/skills-desk-commands.ts` is generated (`node plugins/lean-agent/hooks/skills-contract.mjs --write`).

### Added (scripts, feedback export)
- **Scripts over models.** If a simple script can do a job (counting, summing, aggregating, listing, transforming, diffing,
  validating), run it instead of a model reading the data; and any script a session fabricates is audited and judged before it
  is reused. The thread template, the worker and reader prompts, the `learn` skill and the desk template say so (2-3 lines each).
- New tool `lean_script` (thread and desk) and skill `scripts`:
  - `propose` (thread): the mod copies the script into `~/.lean-agent/scripts/candidates/<name>/` with `meta.json` (purpose, run
    with `{script}`, inputs, outputs, author, project or `global`, created, sha256) and **never executes it**. A secret in the text
    refuses the proposal. A script about lean-agent's own data (`~/.lean-agent` files) is also filed in `feedback.jsonl` as
    a "candidate for lean-agent core".
  - Nudge: when a thread's Bash runs a script file it wrote this session from a scratch place (`/tmp`, a scratchpad, its own
    folder) and nothing proposed it, the next prompt carries one line, once per file: "you ran <file>; if it is reusable,
    lean_script propose it".
  - `audit`: a thread gets the brief for the new read-only `lean-agent:auditor` agent (sonnet/high, a fixed checklist: reads,
    writes, network, deletes, secrets, hardcoded values, determinism, error handling, other data); the desk starts a thread that
    does it. The auditor ends with a `LEAN-AUDIT` line and **the mod records the verdict** when the Agent call returns, applying
    its own rules: network, deletes or overwrites, writes outside the declared outputs, hardcoded values, a home path or email in
    the text, or a script right only for its original data are never `adopt` (they become `adapt` with the concrete changes); a
    secret is `reject`. Verdicts are `adopt`, `adapt` (changes), `reject` (reason); a tampered copy (sha256) is refused. There is
    no way to hand the mod a verdict: it is taken only from an auditor's Agent reply, only for the candidate folder that call's
    prompt names, once per script content.
  - The `run` line is a bare interpreter (python3, node, bash, sh, ruby, perl ...) then `{script}`, no inline-code flags, quotes or
    shell operators; `outputs` may not be a catch-all; inputs/outputs/purpose are one line and scanned like the script; a thread
    proposes only for its own project or `global`. The store is changed under a lock folder (threads and the desk are separate
    processes; a stale lock is moved aside by one taker, a holder releases only its own) and `lean_rules sync` generates a
    script's skill from the verified meta, only while it is still adopted, still the audited text, with an audit for exactly it.
    The mod also scans the text for network and delete patterns (never `adopt`); the auditor's other claims are its judgement,
    and `decide` is the human gate. The sha-256 moved to `sha.ts` (reviews and the script store share it).
  - `adopt` moves the script to `~/.lean-agent/scripts/<name>/` or `~/.lean-agent/<project>/scripts/<name>/` and writes a recipe
    skill `lean-agent-script-<name>` with `run: <command>`; `lean_rules sync` copies it into checkouts (git-excluded).
    `list`, `show`, `retire` (kept under `scripts/retired/`); a Bash run of an adopted script is counted in `scripts/uses.jsonl`.
  - Desk: the pane shows "Scripts: N candidates, M adopted"; `lean_script decide <name> adopt|reject` (desk only, with a reason, logged in
    `scripts/decisions.jsonl`) lets the user override a verdict. Adopting over an audit that said otherwise needs `confirm: true`;
    a script with a secret or a hardcoded home path or email is never adopted, not even by the user, and a script that was never
    audited cannot be adopted.
- **Feedback export, done by the mod.** `/lean-agent-feedback [notes]` (a mod command, any session, no model turn) and the desk's
  `lean_doctor` action `export` write ONE markdown file `~/.lean-agent/feedback-export/<YYYY-MM-DD-HHMM>.md` and print its path:
  the notes, the environment (running vs installed lean-agent version with a SKEW flag, `claude --version`, OS family), the doctor's
  problem lines, every draft in `feedback-drafts/` not exported before, the LEAN-FEEDBACK since the last export (counts by status;
  the `missing` / `refused` / `unverified` / `unreached` texts grouped and de-duplicated with counts; gap lines count as `missing`),
  the guard refusals (text, agent type, counts; the mod logs each refusal it makes, `src: "guard"`, to `refusals.jsonl`: the ONE file
  and the one writer, `appendRefusal`, that also takes the refusals workers report in LEAN-FEEDBACK as `src: "worker"` rows; the
  export counts the guard rows as refusals and takes the worker rows for the `refused` texts, and reads the `unverified` /
  `unreached` texts from the feedback rows' `unverifiedClaims` / `unreachedFolders`; `core-candidate` rows are skipped), the script candidates
  flagged for lean-agent core and the threads that reported `blocked`. It is anonymised by code, deterministically: home dir and
  any user's home folder (macOS or Linux style) to `~`, the OS user name, registered project names to project-A, B ... (a stable local map in
  `feedback-export/projects.map.json`, never exported; thread ids stay), emails, URLs other than the lean-agent repo, azure
  organisations, hex of 7+ characters, numbers after PR / issue / ticket words and `#`, tokens and keys. A final check REFUSES to write
  the file when a known private string survived and names the rule that missed. Over 40 KB the oldest and least repeated items are
  summarised. The stable project-name map lives in `~/.lean-agent/.private/`, not in the export folder; scp-style remotes, IPs,
  host names, env-style credentials (`DB_PASSWORD=...`) and a registered project's folder name are masked too. It never posts and uses no network; `skills/feedback` says: a single report is a draft as before (post with `gh` only
  if installed and only on an explicit yes), "export" is this.
- **Scripts are easy to update.** An adopted script keeps versions (`scripts/<name>/v1/`, `v2/` ..., sha256, author, date and audit
  verdict per version, `current` in `meta.json`) and a stable `scripts/<name>/run` that the rule line and the recipe skill always
  name, so an update never edits a rule or a skill. `lean_script update <name>` (thread or desk; a new file or exact `edits`) stores a
  pending version with a diff and the auditor audits only the change plus the checklist; a changed purpose or run line is shown in
  the verdict and needs the desk's `decide`. On adopt `current` switches and `run` is overwritten. `rollback <name> [version]` (desk;
  a thread gives a reason) switches back at once and is logged; `diff` and `show` print versions, verdicts, uses and failures.
  A failed Bash run of an adopted script is counted, two failures (or `report-bad <name> <why>`) mark it `needs-update` (rule line,
  `list`, desk pane; the next thread that uses it is nudged once to send a fix). A script edited by hand (sha mismatch) is
  `edited, unaudited`: no skill is shipped for it, the rule line says so, a thread run is warned about, a subagent may not run it.
  Hardening: the auditor echoes the sha256 of the text it read (`"sha"` in its `LEAN-AUDIT` line, taken from the brief) and the mod
  refuses a reply that does not match the stored text, so an audit started on an older text is never recorded against a newer one;
  version numbers are never reused (not after a replaced, rejected or rolled-back update); a rollback drops the update that waits; a
  thread changes only its own project's scripts and global ones (update, rollback, report-bad, retire, as propose); the desk's
  audit thread is started after the store lock is released.
- **"Can this be a script" lives in the rules.** On adopt, and at every `lean_rules sync`, the mod writes ONE line per adopted
  script between `<!-- lean-agent:scripts -->` markers into the rule of its area (else `_project`), regenerated from the store so
  learn/trim rewrites keep it, within the rule caps (overflow goes to `_project`, then one "N more scripts" pointer); retire removes
  it. `_project` gets once the line "Prefer scripts over model work ...". A thread's `lean_report` with state `done` is asked once per
  session whether a step could have been a script. `lean_rules stats` lists `scriptCandidates`: reported gaps that read like
  mechanical work (count, list, sum, find all, which files).
- **An audit adopts on its own only when the mod proves the script clean.** An `adopt` verdict used to adopt at once, on an auditor
  prompt the thread wrote. Now (1) the auditor's prompt must be exactly the brief the mod generated and returned to the thread
  (`briefBlock`): the guard refuses any other prompt for `lean-agent:auditor` (extra instructions, a stale brief), and the mod ignores
  a verdict whose prompt differs; (2) the script adopts by itself only when the run line is on the allowlist, there is no secret or
  privacy finding, no network or delete (the auditor's answer and the mod's text scan), no write outside its declared outputs (a
  stdout-only declaration with a file write in the text is caught) and nothing hardcoded; (3) otherwise, when the auditor said adopt,
  the status becomes `audited` and it WAITS for the desk (an update waits the same way): the pane's Scripts line lists it with
  Adopt / Reject (two presses, like Close), `lean_script decide` does the same, both logged as the user's decision (adopting over
  the mod's rules needs confirm; a secret, a privacy finding or a bad run line is never adoptable). `lean_script` `list`, `show`,
  `diff` and `audit` show a thread only its own project's scripts and the global ones.
  The proof is a heuristic, not a guarantee: the text scan sends to the desk whatever it cannot see (a program the script starts,
  code built at run time, a write through a variable mode, a shell redirect, a copy, text addressed to the auditor), and for a script
  that declares files the auditor's list of writes is the only check. The pane's Adopt / Reject are bound to the sha256 of the text
  that was shown (a script proposed again under the same name between the two presses is refused), `decide` refuses a run line off
  the allowlist, and a thread cannot replace another project's script by proposing under its name.
- Review fixes elsewhere: the handover prompt of a reopen is cut by bytes as well as characters (3-byte characters could pass the
  argv limit); a submodule or `--separate-git-dir` checkout (a `.git` file that is not `.git/worktrees/...`) is no longer taken for a
  linked worktree by `project-add` and the doctor; the daily-cap cache no longer counts a row appended during its own rebuild twice;
  `lean_doctor stats` ignores a `project` that is not a plain name; the folder lock re-reads the stale token right before taking a
  dead lock over.
- Rules: `lean_rules stats` counts only the loads from the project's own checkouts (a same-named rule of another project no longer
  hides this project's never-loaded one; a project with no registered folder counts every load, as before). The script-rule rebuild
  and a learn `record` take one lock folder per project (`.rules-lock`, shared lock code in `folderlock.ts`, also used by the script
  store), so a rule is never rewritten by both at once.
- The `auditor` agent type gets the explorer's built-in read-only commands; an Agent call for it with `allow-*` lines from a
  session that cannot own grants is refused like the other agent types.

## 1.0.4

### Added
- **Push approval.** The review-gate refusal named an override that did not exist. Now the desk's `lean_thread` has
  `approve-push` (tN, full sha, reason?): a signed (same HMAC store as `lean_review`), single-use record, valid 2 hours, logged in
  the thread's `history.jsonl`; the push gate accepts it like a green review. Only the desk has the tool; the record is bound to
  project, sha and thread, consumption is kept in the mod's store (a thread that rewrites the record cannot revive it), it is
  taken atomically and only when every pushed sha is covered. It is not bound to a remote or branch, and it is consumed when the
  guard accepts the command (a push that then fails needs a new approval). The desk template says to use it only when the user explicitly approved in the chat. The refusal says
  "ask the desk: approve-push tN <sha>" and prints the manual `git -C <worktree> push <remote> <branch>`. Private projects are
  still never pushed.
- **Read-only search without Grep/Glob.** This Claude Code build has neither tool. `lean-agent:reader-*`, `reviewer` and
  `explorer` now always run `rg`, `grep`, `find` (not `-exec`, `-execdir`, `-ok`, `-okdir`, `-delete`, `-fprint*`, `-fls`),
  `ls`, `wc`, `head`, `tail`, `cat` on paths inside `~/.lean-agent` (thread folders, worktrees) or a registered project (the session
  folder alone is no root), and pipes
  between such commands (and the built-in git reads). A strict scanner proves each pipeline plain: no redirect, substitution,
  `;`/`&`/`||`, and no unquoted glob, `{a,b}` brace expansion, word-initial tilde or `$`; quote patterns. Each command has an allow-list of flags (and `find` of predicates): any other flag, abbreviation or
  cluster letter refuses the command, so there is no `-exec`, `-delete`, `-fprint*`, `-L`/`-H`/`--follow`, `-f`/`--file`,
  `--pre`, `-z`, `tail -f`, `--files0-from`; any `..` word is refused. The desk may run the same under `~/.lean-agent`.
  The agent prompts, the learn / review / find / lean-mode skills and the templates say so.
- An Agent call for one of our agent types (`lean-agent:` or the bare name a grant also binds to) with `allow-cmd` / `allow-edit` lines from a session that cannot own grants (not a
  thread's own loop) is refused up front, with the reason.
- The worktree skill installs dependencies in a fresh worktree from the lockfile (`yarn install --frozen-lockfile` / `--immutable`
  by yarn version, `npm ci`, `pnpm install --frozen-lockfile`) through a worker and reports it; it never symlinks
  `node_modules` (borrowing only from a donor with byte-identical lockfile and `link:` / `file:` targets, and it says which),
  and it can **adopt** a worktree made with plain `git worktree add`.
- A thread can report `superseded: true` with `lean_report` (its brief was replaced by a later user message); the desk text and the
  pane row show it.
- New threads get the attribution setting in their CLAUDE.md (`attribution: off - ...`), from config.json `attribution` (default
  false); existing threads keep the file they have.

### Changed
- A session first resolved as thread tN records its id in `threads/tN/thread.json` `sids` (`sid` stays; the desk's saves keep ids
  written meanwhile), so a later start from any folder resolves by id; a closed thread or an id held by two records matches nothing. Every refusal of a role-bound tool says the tool, the role, where the session started and what
  its id matched.
- A tidy, once per version and also on `migrate`, runs for everyone, also on 1.0.x: `CLAUDE.md` guides that mention lean-agent and 1.0
  did not write, above a thread or worktree folder or under a project folder (the 0.45 ones tell threads to use the removed CLI),
  and `current-thread.json` (written by the 0.45 CLI; 1.0 never reads it) move to `legacy-0.45/` (an earlier backup is never
  overwritten). A user's own notes that do not mention lean-agent stay. `lean_doctor check` flags such files, also a per-thread
  one (that one is moved by hand).

## 1.0.3

### Fixed
- A subagent whose type cannot be read is `unresolved` (was `unknown`): a reader with no grants, refused with "agent type
  unresolved" so it can be reported; the debug log line `agent fields` shows what the engine gave. Verified live: the engine's
  AgentInfo carries `type: "lean-agent:explorer"`, which resolves, and the explorer ran `git ls-files` and `git log` with no grant.
  `git -C <dir>` for the built-in git commands may point into the session folder, `~/.lean-agent` and registered projects.
- A thread or desk keeps its role. A Bash `cd` into the repo no longer demotes it to plain (so `lean_rules` works after a
  `cd`, and the desk stays in strict mode wherever it moves); only plain -> desk/thread is promoted on a folder change. A
  session whose id is a thread's `sid` is that thread from any folder, and a thread/desk tool that would refuse looks the role
  up once more first. The learn skill and thread template say to use `git -C <repo>` instead of `cd`.
- Readers no longer depend on the brief for read-only git. `lean-agent:explorer` can always run `git ls-files` and `git log`;
  `lean-agent:reader-*` and `lean-agent:reviewer` can always run `git log`, `ls-files`, `show`, `diff`, `status` and `rev-parse`
  (a learn thread reported Bash refused for `git ls-files` / `git log`). Read-only by construction: one plain command, no redirect,
  pipe, quote-wrapped `; | < >`, expansion, brace, tilde or glob (`{ } ~ $ * ? [`; use Glob for patterns), no `-c` / `--config-env` / `--exec-path`, no `--output` / `-o` on log, diff and show, no `--ext-diff`,
  one absolute `-C <dir>` only inside the session folder, `~/.lean-agent` or a registered project (no `..`). `allow-cmd` grants still add on top; `other:explorer` and a bare `explorer` get nothing built in. Residual risk, accepted: the repo's own config can run programs for `status` / `diff` / `show` (fsmonitor, textconv), and `status` refreshes `.git/index`.
- The learn skill's explorer brief lists the area folders and points at Glob/Grep; the explorer prompt and the thread
  template say what is built in.

## 1.0.2

### Added
- Model and effort are pinned. The desk folder's `.claude/settings.json` gets `model: sonnet`, `effortLevel: high` (setup /
  `lean_doctor fix`, merged into an existing file; `lean_doctor check` reports a missing or different value; config.json
  `desk.model` / `desk.effort` override). Threads start with `--model sonnet --effort medium` instead of the user's default
  model (config.json `threads.model` / `threads.effort`, or `model` / `effort` on `lean_thread` `new` / `start`); the choice is
  recorded in `thread.json`, written to the thread folder's settings, and shown in `list` and the pane row. A resume passes
  no flags. The plugin's agents set `effort` (workers haiku low / sonnet medium / opus high, readers and explorer low, reviewer medium).
- The desk can answer "what projects do we have?": `lean_thread` gets `projects` (path, private, guards, learned rules with
  areas / last learned / stale, open threads; private projects hidden by the 0.45 private switch only with `all: true`),
  `project-add` (existing folder, real path), `project-remove` (unregisters only, refused while a thread uses it) and
  `project-private`. The desk pane has a compact Projects section, and the desk's CLAUDE.md says the desk may Read files
  under `~/.lean-agent`. A damaged `projects.json` is never overwritten; writes are serialised; a private project cannot be
  removed, and turning private off needs `confirm: true` (the desk asks the user first).
- The desk records what happened to its skill listing ("trimmed 5 -> 2", "format not recognised", "no skill_listing
  attachment seen"; names and counts only, never text) and shows it in the pane footer and in `lean_doctor check`, with the
  attachment and section names seen this session, so a report needs no debug log.

### Fixed
- The plugin's subagents are named with the plugin prefix in the Agent tool (`lean-agent:worker-sonnet`, `lean-agent:reviewer`,
  ...). The guard matched `/^worker-/`, so a real worker counted as a reader and could not edit even with an `allow-edit`
  grant. Only a type with exactly a leading `lean-agent:` is ours now (`lean-agent:worker-*` = worker; a bare `worker-x`
  from a user/project agent and another plugin's `x:worker-y` are readers). Grants bind with either spelling, `workerCaps`
  keys may be `worker-opus` or `lean-agent:worker-opus`, stats and feedback merge both spellings, and the templates, skills
  and README name the agents with the prefix. The spawned type is read from `AgentInfo.type` (what `$.agent.list()` names it);
  the code read `subagentType`, which that row does not carry, so every subagent counted as an unknown reader.
- **Open desk** no longer says "The Claude app is not running" inside the Claude app: a pane drawn on the desktop surface
  skips the check. Elsewhere the check calls `/usr/bin/pgrep` (`-x Claude`, then `-f` on the app binary path), and if the
  check itself errors `claude --desktop` is tried anyway and its real error is shown. The login opener uses the same two checks.
- Thread resume ran `claude --bg --resume <sid> -n <label> -- <prompt>`; any extra flag makes the CLI start a copy of the
  session. It now passes only `--resume <sid> -- <prompt>`. That continues the session itself only once its process has exited:
  a finished session whose process is still alive (listed with a pid, state done) is stopped first (`claude stop`, then
  waited for), a working one is never stopped or resumed (the listing is read again right before the stop). Closing a thread also stops a finished session that still has its process. If the CLI still prints "started a copy as <id>" the thread
  follows the copy (when the id names exactly one listed session) and the result says so.
- The desk's skill-listing trim did not take effect on a real Mac: the engine caches `prompt.attachment`, and a listing built
  while the session was still in its spare folder (role not yet the desk) stayed. The role change now asks for the
  attachments, sections and tool descriptions again. The filter also accepts renamed listing types (any name holding
  "skill"), backticked and `*` bullets, and a listing in the Skill tool's description; an unknown format is still left untouched.
- On the desk, the agent listing (`agent.offer`) and MCP-instructions sections/attachments are left out; the desk never spawns subagents.
- Closing a thread ran the nonexistent `claude agents stop <sid>`; it now runs `claude stop <id>` (first 8 chars of the sid).

## 1.0.1

### Added
- Setup without a model turn: `/lean-agent-setup` (check + fix, any session) and a **Set up lean-agent** button in the
  `/lean-agent` pane, which now works in every session (it opens by itself only in the desk): setup first, **Open desk** in a session that is not the desk,
  **Setup / repair** in the desk. One code path with `lean_doctor fix`.

### Changed
- The desk's tool pool is cut to the tools strict mode can allow (plus lean-agent's own), its skill listing to lean-agent's
  skills: far less context before the first message. `tools.desk.drop` still applies on top; threads and plain sessions are unchanged.

### Fixed
- A desk (or thread) session the Claude app pre-starts in a spare folder and then moves into the chosen folder now gets
  its tools, timers and git hooks: the role is decided again when the directory changes (`CwdChanged`, checked lazily at
  each turn and prompt too).
- Session start is fail-soft: one failing setup step no longer stops tool registration.
- `tool.list` now answers the engine's `{ value }` shape, so `tools.<role>.drop` takes effect.

## 1.0.0

One major release: lean-agent is now pure Claude Code.

### Changed
- The desk is a local Claude desktop session in `~/lean-agent-desk`; threads are `claude --bg` sessions, one folder each.
- Learned project knowledge is path-scoped rules (copied into `.claude/rules/lean-agent/`, git-excluded) instead of cards.
- Recipes are project skills. Budgets are cost-only. Threads run with an allow-list (Edit/Write inside the lean-agent folder, which holds their worktrees; Bash); `git push` needs a signed green review in registered projects only, shared branches are never force-pushed, and private projects are never pushed or published (an allow-list: only read-only gh/az calls pass, found anywhere in the command, unparsable commands are denied).
- A login opener (`com.lean-agent.desk`) waits for the Claude app and opens the desk; it never launches the app.
- New `doctor` skill and `lean_doctor` tool: check, fix, migrate.

### Removed
- The `lean-agent` CLI, all Python scripts, the hosted desk and Remote Control hosting without the app, desk switching,
  the `com.lean-agent.up` service, plan-window percentages and the hosted Live Map.
- Linux support: 1.0 is macOS-only (it needs the Claude desktop app). Linux users stay on 0.45.

### Migration from 0.45
- Automatic: the first session the 1.0 mod starts (any local session) unloads a leftover 0.45 service at once
  (`launchctl bootout`; `systemctl --user disable --now` for a Linux unit) so it cannot crash-loop after
  `claude plugin update` removed its files, then runs the idempotent migrate. If that fails the status line and the
  pane say "lean-agent 1.0: run migrate in the desk". Details are logged in `~/.lean-agent/logs/migrate.jsonl`.
- All open 0.45 threads are closed (a list is kept in `~/.lean-agent/legacy-0.45/`);
  goals, questions, recipes and the other state are converted or kept; cards are archived and re-learned with `learn`.
- The old service is unloaded and the old `lean-agent` command shim is removed.
- Kept from 0.45: plain pushes to `main`, `master`, `develop` and `release/*` (or a project's own `guards.push-deny` in
  `projects.json`) are refused at the shell level and in the pre-push hook; overrides: `LEAN_AGENT_PUSH_GUARD_OVERRIDE=1`, and
  pushes to a local path / `file://` URL are not checked. Residual risk (documented): a push hidden in `python -c`
  is not parsed by the shell guard; the pre-push hook is the backstop.

See `docs/design-1.0.md`.
