// THE REGISTRY of every key of ~/.lean-agent/config.json that the code reads (1.0.31): ONE table. lean_config (configtool.ts) lists, gets, sets,
// unsets and validates by it; the README table is generated from it (scripts/config-table.mjs); `node scripts/config-table.mjs --check` (run by
// hooks/skills-contract.test.sh) FAILS when the hooks read a key that is not here, when an entry has no description, or when the README
// drifts: add the key HERE when you add a reader.
// No imports on purpose (the table script loads this file alone). Nested ("threads": { "autoRestart" }) and flat ("threads.autoRestart")
// spellings: the writer keeps the file's style; `flat: true` marks the keys whose reader also accepts the flat spelling.

export type KeyType = 'boolean' | 'number' | 'enum' | 'string' | 'path' | 'list' | 'json'
export type Group = 'desk' | 'threads' | 'workers' | 'review' | 'budget' | 'pane' | 'feedback' | 'memory' | 'safety' | 'other'
export type Applies = 'now' | 'next-session' | 'desk-restart'
export type Entry = {
  key: string // dotted path
  type: KeyType
  default: unknown // null: not set / no limit
  description: string // ONE line, the user's wording
  group: Group
  applies: Applies
  src: string | string[] // the hooks source(s) that read it (the scan checks the key's name is in them)
  min?: number
  max?: number
  int?: boolean // whole numbers only
  zero?: boolean // 0 is allowed although below min (it means off)
  values?: readonly string[] // enum
  special?: readonly string[] // list: a single word that stands for the whole (e.g. all)
  shape?: 'array' | 'object' // json
  aliases?: readonly string[] // other spellings the reader accepts
  flat?: true // the reader also accepts the flat spelling "a.b"
  sensitive?: true // loosens a safety rule: changed only on the user's own typed words or their Approve
}

export const MODELS = ['haiku', 'sonnet', 'opus'] as const
export const EFFORTS = ['low', 'medium', 'high'] as const
export const GROUPS: readonly Group[] = ['desk', 'threads', 'workers', 'review', 'budget', 'pane', 'feedback', 'memory', 'safety', 'other']
export const APPLIES_TEXT: Record<Applies, string> = { now: 'takes effect now', 'next-session': 'takes effect from the next session (threads already running keep the old value)', 'desk-restart': 'takes effect after the desk restarts' }

const n = (min: number, extra: Partial<Entry> = {}): Partial<Entry> => ({ min, ...extra })
const mk = (key: string, type: KeyType, dflt: unknown, group: Group, applies: Applies, src: string | string[], description: string, x: Partial<Entry> = {}): Entry => ({ key, type, default: dflt, group, applies, src, description, ...x })
const S = { sensitive: true } as const

export const REGISTRY: readonly Entry[] = [
  // ---- desk ----
  mk('desk.model', 'enum', 'sonnet', 'desk', 'desk-restart', 'models.ts', 'Which model the desk session runs on.', { values: MODELS }),
  mk('desk.effort', 'enum', 'high', 'desk', 'desk-restart', 'models.ts', 'How much effort the desk session puts in.', { values: EFFORTS }),
  mk('desk.blockAppModel', 'boolean', false, 'desk', 'now', 'register.tsx', 'Refuse the app switching the desk to another model (default: it asks you first).'),
  mk('desk.autoRelay', 'boolean', true, 'desk', 'now', 'register.tsx', 'Hand a thread\'s report to the desk at once, without waiting for your next message.'),
  mk('desk.autoResume', 'boolean', true, 'desk', 'now', 'limits.ts', 'Resume a thread blocked by the usage limit two minutes after the limit resets.'),
  mk('desk.autoRestart', 'boolean', true, 'desk', 'now', 'deskcompact.ts', 'The mod opens a fresh desk itself when the desk must restart (off: only the Restart desk button).'),
  mk('desk.reportChars', 'number', 400, 'desk', 'now', 'reportdigest.ts', 'Characters of a thread report the desk gets (0 = the whole report).', n(0, { int: true })),
  mk('desk.contextLimit', 'number', 60000, 'desk', 'now', 'deskcompact.ts', 'The desk restarts itself (handover first) when its context passes this many tokens (the older deskTokens still counts when this is unset).', n(10000, { int: true, flat: true, aliases: ['deskTokens', 'checkpoint.deskTokens'] })),
  mk('desk.autoRestartPerDay', 'number', 12, 'desk', 'now', 'deskauto.ts', 'Automatic desk restarts allowed per 24 hours (and at most one every 30 minutes); past it only the Restart desk button.', { min: 1, max: 100, int: true, flat: true }),
  mk('desk.closeOld', 'enum', 'stop', 'desk', 'now', 'olddesk.ts', 'After a desk restart, stop the old desk session (stop) or also remove it from the list (remove), when it is a claude --bg one; off leaves it. A desktop desk is archived by you.', { values: ['stop', 'remove', 'off'], flat: true }),
  mk('deskToolResultChars', 'number', 6000, 'desk', 'now', 'orchestrate.ts', 'Largest tool result the desk keeps whole, in characters (longer ones are cut).', n(1, { int: true, flat: true })),
  mk('notify.toast', 'boolean', true, 'desk', 'now', 'notify.ts', 'Show a toast for desk notices.'),
  mk('notify.sound', 'boolean', false, 'desk', 'now', 'notify.ts', 'Play a sound with a toast (accepted; no sound clip is bundled yet).'),
  mk('tips', 'boolean', true, 'desk', 'now', 'tips.ts', 'Show an occasional tip about a lean-agent feature.'),
  mk('tools.desk.drop', 'list', [], 'desk', 'desk-restart', ['register.tsx', 'squeeze.ts'], 'Tool names (globs allowed) taken away from the desk.'),
  mk('tools.thread.drop', 'list', [], 'threads', 'next-session', ['register.tsx', 'squeeze.ts'], 'Tool names (globs allowed) taken away from threads.'),
  mk('tools.plain.drop', 'list', [], 'other', 'next-session', ['register.tsx', 'squeeze.ts'], 'Tool names (globs allowed) taken away from plain sessions that are not the desk or a thread.'),
  mk('handover.mode', 'enum', 'core', 'desk', 'now', 'handover.ts', 'What a restarted thread gets first: core (only what changes behaviour, rest on request) or full.', { values: ['core', 'full'] }),
  mk('handoverTokens', 'number', 6000, 'desk', 'now', 'handover.ts', 'In full handover mode: the handover is cut to about this many tokens.', n(500, { int: true })),
  // ---- threads ----
  mk('threads.model', 'enum', 'sonnet', 'threads', 'next-session', 'models.ts', 'Which model new threads run on.', { values: MODELS }),
  mk('threads.effort', 'enum', 'medium', 'threads', 'next-session', 'models.ts', 'How much effort new threads put in (medium; high when lean.orchestrate is off).', { values: EFFORTS }),
  mk('threads.autoRestart', 'boolean', true, 'threads', 'now', 'autorestart.ts', 'Restart a thread by itself when its context is full (off: it stops and asks).'),
  mk('threads.stopGraceMinutes', 'number', 3, 'threads', 'now', 'autorestart.ts', 'Minutes after the stop record before a still-working thread is restarted anyway.', n(0)),
  mk('threads.autoContinue', 'boolean', true, 'threads', 'now', 'continuepending.ts', 'Continue a thread that ends its turn with "next: ..." (off: no automatic continue).'),
  mk('threads.continueSeconds', 'number', 20, 'threads', 'now', 'continuepending.ts', 'Seconds a "next: ..." turn waits before the continue message is sent.', n(1)),
  mk('threads.keepGoing', 'boolean', true, 'threads', 'now', 'continuepending.ts', 'Keep going is the standing order of every work thread (review threads excluded); a thread\'s own keep-going on / off wins.'),
  mk('threads.endNudge', 'boolean', true, 'threads', 'now', ['endnudge.ts', 'continuepending.ts'], 'A turn that ends without lean_report (done, blocked, question) is nudged by script (once per ended turn, at most twice an hour) and, still unreported after idleAlertMinutes, raised to the desk.'),
  mk('threads.requireReport', 'boolean', true, 'threads', 'now', ['endnudge.ts', 'continuepending.ts'], 'A thread whose brief asks for ONE action that ends its turn without lean_report is nudged at once with the whole report rule (a mod cannot refuse a Stop).'),
  mk('threads.idleAlertMinutes', 'number', 10, 'threads', 'now', ['threadstate.ts', 'stall.ts'], 'Minutes a thread may be idle without a report before the desk gets one notice (0 = off).', n(0)),
  mk('threads.softCheckpointTokens', 'number', 80000, 'threads', 'next-session', ['threadcontext.ts', 'budgetcfg.ts'], 'A work thread this big is told once to checkpoint at its next boundary (an idle one is checkpointed by script).', { min: 20000, max: 400000, int: true, flat: true }),
  mk('threads.softUsd', 'number', 8, 'budget', 'now', ['budgetthread.ts', 'budgetcfg.ts'], 'Per-thread budget in USD from the ledger: one nudge at 80%, told to report and stop at 100% (0 = off; lean_thread budget tN overrides it).', { min: 0, max: 10000, flat: true }),
  mk('workitems.afterPr', 'enum', 'ask', 'threads', 'now', 'workitemflow.ts', 'After a PR is opened the mod asks for one Approve to link it to the thread\'s work item and set it to Reviewing (off: never).', { values: ['ask', 'off'], flat: true }),
  mk('workitems.reviewState', 'string', 'Reviewing', 'threads', 'now', 'workitemflow.ts', 'The work item state that request sets after a PR is opened.', { flat: true }),
  mk('workitems.onlyOwn', 'boolean', true, 'safety', 'now', ['owntask.ts', 'workitemflow.ts'], 'Link and move only a work item assigned to you for a PR you created (off: any work item the thread has).', { flat: true, ...S }),
  mk('workitems.lookup', 'boolean', true, 'threads', 'now', 'workitemflow.ts', 'A request to create a work item reads your active assigned work items (read-only) to show the closest ones.', { flat: true }),
  mk('threads.escalate', 'boolean', true, 'threads', 'now', 'deliver-to-thread.ts', 'Restart a thread that ignored a message from the desk (off: ask you first).'),
  mk('threads.answerWaitSeconds', 'number', 45, 'threads', 'now', 'deliver-to-thread.ts', 'Seconds a thread has to react to a message before it counts as ignored.', n(1)),
  mk('threads.waitReminderMinutes', 'number', 15, 'threads', 'now', 'deliver-to-thread.ts', 'Minutes an unanswered thread question waits before it comes back once.', n(1)),
  mk('threads.stuckMinutes', 'number', 10, 'threads', 'now', 'threadstate.ts', 'Minutes an unread message may wait before the thread counts as stuck.', n(1)),
  mk('threads.removeOld', 'boolean', true, 'threads', 'now', 'threadstate.ts', 'Remove the old stopped session of a thread after a restart.'),
  mk('threads.stallMinutes', 'number', 10, 'threads', 'now', 'threadstate.ts', 'Minutes without a tool call or report before a working thread counts as stalled.', n(1)),
  mk('threads.stallRestart', 'boolean', false, 'threads', 'now', 'threadstate.ts', 'Restart a stalled thread automatically (default: only flag it).'),
  mk('threads.plugins', 'list', [], 'safety', 'next-session', 'threadlean.ts', 'Plugins a thread loads besides lean-agent (all = every plugin you have).', { special: ['all'], flat: true, ...S }),
  mk('threads.skills', 'enum', 'lean', 'threads', 'next-session', 'threadlean.ts', 'Skills a thread lists: lean (lean-agent\'s only) or all.', { values: ['lean', 'all'], flat: true }),
  mk('threads.mcp', 'enum', 'all', 'safety', 'next-session', 'threadlean.ts', 'MCP servers a thread may use: all, project (the project\'s only) or none.', { values: ['all', 'project', 'none'], flat: true, ...S }),
  mk('threads.tools', 'list', null, 'safety', 'next-session', 'orchestrate.ts', 'Built-in tools of a thread session (all = the full set; default is a short list).', { special: ['all'], flat: true, ...S }),
  mk('threads.directReads', 'number', 3, 'safety', 'now', 'orchestrate.ts', 'Direct file reads a thread may do per turn before it must use a worker.', n(0, { int: true, flat: true, ...S })),
  mk('threads.workers', 'number', 4, 'safety', 'now', 'orchestrate.ts', 'Workers one thread may run at once.', n(1, { int: true, flat: true, ...S })),
  mk('threadTokens', 'number', 120000, 'threads', 'now', 'threadcontext.ts', 'A thread restarts itself when its context passes this many tokens.', n(10000, { int: true })),
  mk('threadWarnTokens', 'number', 100000, 'threads', 'now', 'threadcontext.ts', 'A thread is told to wrap up when its context passes this many tokens (default 83% of threadTokens).', n(10000, { int: true })),
  mk('threadToolResultChars', 'number', 8000, 'threads', 'now', 'cap.ts', 'Largest tool result a thread keeps whole, in characters (0 = no cut).', n(2000, { int: true, zero: true })),
  mk('attribution', 'boolean', false, 'threads', 'next-session', 'threads.ts', 'Let threads add Claude attribution lines to commits and pull requests.'),
  // ---- workers ----
  mk('workers.briefChars', 'number', 3000, 'workers', 'now', 'orchestrate.ts', 'Longest brief a worker accepts, in characters.', n(1, { int: true, flat: true, ...S })),
  mk('workers.steps', 'number', 24, 'workers', 'now', 'orchestrate.ts', 'Most tool calls one worker may make before it must return what it has.', n(1, { int: true, flat: true, ...S })),
  mk('workers.stepsByJob.lookup', 'number', 10, 'workers', 'now', 'orchestrate.ts', 'Tool calls for a lookup job.', n(1, { int: true, ...S })),
  mk('workers.stepsByJob.edit', 'number', 16, 'workers', 'now', 'orchestrate.ts', 'Tool calls for an edit job.', n(1, { int: true, ...S })),
  mk('workers.stepsByJob.run', 'number', 6, 'workers', 'now', 'orchestrate.ts', 'Tool calls for a run job.', n(1, { int: true, ...S })),
  mk('workers.stepsByJob.check', 'number', 10, 'workers', 'now', 'orchestrate.ts', 'Tool calls for a check job.', n(1, { int: true, ...S })),
  mk('workers.requireJob', 'boolean', false, 'workers', 'now', 'orchestrate.ts', 'Refuse a worker brief whose first line does not name the job.', { flat: true }),
  mk('workers.commit', 'boolean', true, 'safety', 'now', 'orchestrate.ts', 'A worker may commit its own change when the brief says commit.', { flat: true, ...S }),
  mk('workers.answerChars', 'number', 1200, 'workers', 'now', 'answers.ts', 'Characters of a subagent answer that come back into the conversation.', n(100, { int: true, flat: true })),
  mk('agentResultChars', 'number', 6000, 'workers', 'now', 'orchestrate.ts', 'Largest result a subagent keeps whole, in characters.', n(1, { int: true, flat: true })),
  mk('agents.cap', 'number', null, 'safety', 'now', 'guard.ts', 'Most subagents a thread session may start (no cap by default; small workers do not count).', n(1, { int: true, ...S })),
  mk('grants.ttlMinutes', 'number', 120, 'safety', 'now', 'orchestrate.ts', 'Minutes a worker slot is held before it counts as ended.', n(1, { int: true, flat: true, ...S })),
  mk('learn.maxExplorers', 'number', 4, 'workers', 'now', 'delivery.ts', 'Explorers the learn skill may run at once.', n(1, { int: true })),
  mk('ask.model', 'enum', 'haiku', 'workers', 'now', 'threadask.ts', 'Model that answers a thread question put to the desk.', { values: MODELS }),
  mk('ask.effort', 'enum', 'low', 'workers', 'now', 'threadask.ts', 'Effort of the model that answers a thread question put to the desk.', { values: EFFORTS }),
  mk('lean.orchestrate', 'boolean', true, 'safety', 'next-session', ['orchestrate.ts', 'fake.ts'], 'The desk only routes and threads only brief workers (off: threads edit and run things themselves).', { flat: true, ...S }),
  // ---- review ----
  mk('review.model', 'string', 'auto', 'review', 'now', ['reviewtool.ts', 'reviewrisk.ts'], 'Model of the reviewer (auto picks by the risk of the change).'),
  mk('review.perMilestone', 'boolean', true, 'review', 'now', 'reviewtool.ts', 'Review again at every milestone (off: skip the pass between milestones).', S),
  mk('review.minLines', 'number', 60, 'review', 'now', 'reviewtool.ts', 'Changed lines since the last pass below which a milestone review is skipped.', n(0, { int: true, ...S })),
  mk('review.exclude', 'list', [], 'review', 'now', ['reviewtool.ts', 'reviewexclude.ts'], 'Globs of files left out of a review (generated files are always left out).', S),
  mk('review.lessonTokens', 'number', 3200, 'review', 'now', 'reviewlessons.ts', 'Tokens of review lessons a new review is given.', n(1, { int: true })),
  mk('review.lessonMax', 'number', 1500, 'review', 'now', 'reviewlessons.ts', 'Most review lessons kept per project.', n(1, { int: true })),
  mk('review.contextLines', 'number', 0, 'review', 'now', 'reviewtool.ts', 'Lines of context around a changed hunk that still count as part of the change (0 to 20).', { min: 0, max: 20, int: true }),
  mk('review.maxFiles', 'number', 150, 'review', 'now', 'reviewtool.ts', 'Most files a review range may hold before prepare asks you to confirm it (a wrong range is the usual cause).', n(1, { int: true, ...S })),
  mk('review.askAboveUsd', 'number', 5, 'review', 'now', 'budgetcfg.ts', 'A review expected to cost more than this (USD) is not started until you said yes (0 = never ask).', { min: 0, max: 1000, flat: true, ...S }),
  mk('review.maxUsd', 'number', 25, 'review', 'now', 'budgetcfg.ts', 'A review expected to cost more than this (USD) is refused unless you say yes anyway (0 = no limit).', { min: 0, max: 10000, flat: true, ...S }),
  mk('review.preflight', 'boolean', true, 'review', 'now', ['budgetcfg.ts', 'preflight-review.ts'], 'Before any reviewer starts, compare the prepared file count with the forge\'s own count for the PR.', { flat: true, ...S }),
  mk('review.preflightMinFiles', 'number', 20, 'review', 'now', ['budgetcfg.ts', 'preflight-review.ts'], 'The forge count check never stops a review of at most this many prepared files.', { min: 1, max: 100000, int: true, flat: true }),
  mk('review.preflightRatio', 'number', 3, 'review', 'now', ['budgetcfg.ts', 'preflight-review.ts'], 'Prepared files above this many times the forge\'s count stop the review as a wrong range.', { min: 1, max: 100, flat: true }),
  mk('review.lessonsFallback', 'number', 2, 'review', 'now', 'reviewlessons.ts', 'General review lessons offered per topic when nothing else matches it (at most 6 in all; 0 = off).', { min: 0, max: 6, int: true, flat: true }),
  mk('review.prChecks', 'json', null, 'review', 'now', ['reviewtool.ts', 'deskactions.ts', 'prvote.ts'], 'Review-side PR checks: false turns all off, or {"severity": false, "size": false} single ones.', { shape: 'object' }),
  mk('rulesPr.minSessions', 'number', 3, 'review', 'now', 'rulespr.ts', 'Sessions a learned rule must have loaded in before it is proposed upstream.', n(1, { int: true })),
  mk('rulesPr.minDays', 'number', 7, 'review', 'now', 'rulespr.ts', 'Days a learned rule must have been in use before it is proposed upstream.', n(1, { int: true })),
  mk('rulesPr.minGaps', 'number', 2, 'review', 'now', 'rulespr.ts', 'Reports of a missing piece of context before it is proposed as a rule.', n(1, { int: true })),
  mk('rulesPr.windowDays', 'number', 90, 'review', 'now', 'rulespr.ts', 'Days back that rule loads and reports are counted.', n(1, { int: true })),
  // ---- budget ----
  mk('budget.daily', 'number', 25, 'budget', 'now', 'budget.ts', 'Daily spend in USD at which the desk is warned (0 = no alert).', n(0)),
  mk('budget.threadDaily', 'number', 15, 'budget', 'now', 'budget.ts', 'Daily spend of one thread in USD at which the desk is warned (0 = no alert).', n(0)),
  mk('dailyCapUsd.desk', 'number', null, 'budget', 'now', ['budget.ts', 'stats.ts'], 'Daily USD cap for desk sessions; past it requests are refused (none by default).', n(0.01, S)),
  mk('dailyCapUsd.thread', 'number', null, 'budget', 'now', ['budget.ts', 'stats.ts'], 'Daily USD cap for thread sessions; past it requests are refused (none by default).', n(0.01, S)),
  mk('dailyCapUsd.plain', 'number', null, 'budget', 'now', ['budget.ts', 'stats.ts'], 'Daily USD cap for plain sessions; past it requests are refused (none by default).', n(0.01, S)),
  mk('workerCapUsd', 'number', null, 'budget', 'now', ['budget.ts', 'stats.ts'], 'USD one worker may spend before it ends and reports (none by default).', n(0.01, S)),
  mk('workerCaps', 'json', null, 'budget', 'now', 'budget.ts', 'USD cap per worker kind, e.g. {"worker-opus": 4}.', { shape: 'object', ...S }),
  mk('window.throttleAbove', 'number', 70, 'budget', 'now', ['budgetcfg.ts', 'throttle.ts'], 'Percent of the 5 h window above which new agents run on haiku and low-priority threads wait (100 = off).', { min: 1, max: 100, flat: true }),
  mk('window.blockAbove', 'number', 92, 'budget', 'now', ['budgetcfg.ts', 'throttle.ts'], 'Percent of the 5 h window above which no new thread or reviewer starts (priority urgent excepted).', { min: 1, max: 100, flat: true }),
  mk('window.capFiveHourPct', 'number', null, 'budget', 'now', ['budgetcfg.ts', 'throttle.ts'], 'Your own cap in percent of the 5 h window: at it all new work is held until the window resets (none by default).', { min: 1, max: 100, flat: true }),
  mk('window.holdAbove', 'number', 85, 'budget', 'now', 'windows.ts', 'Percent of the usage window above which starting a thread warns and holds.', { min: 1, max: 100 }),
  mk('toolResultChars', 'number', 20000, 'other', 'now', 'cap.ts', 'Largest tool result kept whole, in characters (0 = no cut).', n(2000, { int: true, zero: true })),
  mk('refusals.repeat', 'number', 3, 'other', 'now', 'refusals.ts', 'How often one refusal pattern repeats before the doctor names it.', n(2, { int: true })),
  // ---- pane ----
  mk('pane.theme', 'enum', 'off', 'pane', 'desk-restart', 'look.ts', 'Give the app lean-agent\'s own look (on) or leave it alone (off).', { values: ['on', 'off'] }),
  mk('pane.sort', 'enum', 'active', 'pane', 'now', 'panelist.ts', 'How the desk pane orders its sessions: active (last activity, newest first), needs (needs you first), cost or name. The pane\'s sort chips set it.', { values: ['active', 'needs', 'cost', 'name'], flat: true }),
  mk('pane.maxSessions', 'number', 30, 'pane', 'now', 'panelist.ts', 'Sessions the desk pane lists before one "show more" row (a session with an unread message or something waiting for you is always listed).', { min: 5, max: 500, int: true, flat: true }),
  mk('pane.healthOpen', 'boolean', false, 'pane', 'now', 'panelist.ts', 'Start the pane\'s Health card (findings, fixes, standing approvals) unfolded (true); by default it starts folded and is highlighted when something needs a fix.', { flat: true }),
  // ---- feedback ----
  mk('feedback.destination', 'enum', 'local', 'feedback', 'now', 'feedbackdest.ts', 'Where the feedback export goes: local, folder, github or folder+github.', { values: ['local', 'folder', 'github', 'folder+github'], flat: true }),
  mk('feedback.folder', 'path', null, 'feedback', 'now', 'feedbackdest.ts', 'Folder the feedback export is copied to (for folder and folder+github), e.g. ~/Downloads.', { flat: true }),
  // ---- memory (memory.ts) ----
  mk('memory.maxPerScope', 'number', 12, 'memory', 'now', 'memory.ts', 'Items one memory scope (desk, always, a project, a thread, a task) may hold; an add over it asks you to retire one.', n(1, { int: true })),
  mk('memory.indexTokens', 'number', 400, 'memory', 'now', 'memory.ts', 'Token budget of the standing-orders list every session starts with (the lowest-ranked lines are dropped).', n(50, { int: true })),
  mk('memory.relevantTokens', 'number', 300, 'memory', 'now', 'memory.ts', 'Token budget of the one memory reminder line (at most 3 items) a session gets when it matters.', n(50, { int: true })),
  mk('memory.autoCapture', 'boolean', true, 'memory', 'now', 'memory.ts', 'Store typed "remember / always / never / from now on" and repeated corrections by script (off: only /lean-agent:remember and the tools).'),
  // ---- safety ----
  mk('actions.pendingHours', 'number', 24, 'safety', 'now', 'deskactions.ts', 'Hours a request for a remote write waits for your decision before it expires (0.05 to 720).', { min: 0.05, max: 720, flat: true, ...S }),
  mk('pr.checks', 'json', null, 'safety', 'now', ['prchecks.ts', 'forcepr.ts', 'prvote.ts'], 'PR checks when a thread opens or pushes a PR: false turns all off, or {"guide": false, "size": false, "draft": false, "secrets": false, "force": false} single ones.', { shape: 'object', ...S }),
  mk('actions.holdSeconds', 'number', 30, 'safety', 'now', 'sendhold.ts', 'Seconds a covered reply or comment is held before it is sent (0 = at once).', n(0, S)),
  mk('actions.ownPrDefault', 'boolean', true, 'safety', 'now', 'ownpr.ts', 'A thread owns the pull request it opens: its replies go out without a question.', { flat: true, ...S }),
  mk('actions.ownPrMaxPerDay', 'number', 20, 'safety', 'now', 'ownpr.ts', 'Pull requests a thread may take as its own per day.', { min: 1, max: 1000, int: true, flat: true, ...S }),
  mk('actions.ownWorkItemStates', 'list', ['Reviewing', 'Active', 'In Progress', 'Resolved'], 'safety', 'now', 'ownpr.ts', 'Work item states a thread may move its own work item to.', { flat: true, ...S }),
  mk('actions.maxWritesPerGrant', 'number', 40, 'safety', 'now', 'deskwrites.ts', 'Writes one approval in advance (allow) covers.', { min: 1, max: 1000, int: true, flat: true, ...S }),
  mk('actions.standing', 'json', [], 'safety', 'now', 'deskactions.ts', 'Standing approvals: a list of {project, kinds, statuses} that need no question.', { shape: 'array', flat: true, ...S }),
  mk('private', 'enum', 'on', 'safety', 'now', 'projects.ts', 'Private projects: on keeps them hidden from lists, off shows them.', { values: ['on', 'off'], ...S }),
]

// ---- lookup, in the spellings the readers accept ----
const norm = (k: string) => k.trim()
export const findEntry = (k: string): Entry | undefined => {
  const key = norm(k)
  return REGISTRY.find(e => e.key === key) ?? REGISTRY.find(e => e.aliases?.includes(key))
}
export const entriesOf = (group?: string): Entry[] => (group ? REGISTRY.filter(e => e.group === group) : [...REGISTRY])
export const allSpellings = (e: Entry): string[] => [e.key, ...(e.aliases ?? [])]

function lev(a: string, b: string): number {
  const d: number[] = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]!
    d[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cur = d[j]!
      d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = cur
    }
  }
  return d[b.length]!
}
// the nearest known key for an unknown one (a typo, the wrong nesting, the last word alone); null when nothing is close
export function nearestKey(k: string): string | null {
  const q = norm(k).toLowerCase()
  if (!q) return null
  let best: { key: string; d: number } | null = null
  for (const e of REGISTRY) {
    for (const s of allSpellings(e)) {
      const full = s.toLowerCase()
      const leaf = full.split('.').pop()!
      const d = Math.min(lev(q, full), q.includes('.') ? 99 : lev(q, leaf) + 1, full.endsWith(`.${q}`) ? 1 : 99)
      if (!best || d < best.d) best = { key: e.key, d }
    }
  }
  return best && best.d <= Math.max(3, Math.floor(q.length / 3)) ? best.key : null
}

// ---- the file, read in either spelling ----
export type Cfg = Record<string, unknown>
const isObj = (v: unknown): v is Cfg => !!v && typeof v === 'object' && !Array.isArray(v)
// where a spelling sits in the file: 'flat' (a top-level "a.b" key), 'nested' (a: { b }), or null
export function locate(cfg: Cfg, spelling: string): { style: 'flat' | 'nested'; value: unknown } | null {
  if (spelling in cfg) return { style: 'flat', value: cfg[spelling] }
  let v: unknown = cfg
  for (const p of spelling.split('.')) {
    if (!isObj(v) || !(p in v)) return null
    v = v[p]
  }
  return { style: 'nested', value: v }
}
// the current raw value of an entry (any of its spellings) and the spelling the file uses
export function currentOf(cfg: Cfg, e: Entry): { value: unknown; spelling: string; style: 'flat' | 'nested' } | null {
  for (const s of allSpellings(e)) {
    const l = locate(cfg, s)
    if (l && l.value !== undefined) return { value: l.value, spelling: s, style: l.style }
  }
  return null
}

// ---- values ----
const SECRET = /\b(ghp_|gho_|ghs_|github_pat_|sk-[A-Za-z0-9_-]{16,}|xox[abp]-|AKIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9_-]{20,})|-----BEGIN [A-Z ]*PRIVATE KEY|(password|secret|token)\s*[=:]\s*\S{6,}/i
const CTRL = /[\u0000-\u001f]/
export type Checked = { ok: true; value: unknown } | { ok: false; why: string }
const bad = (why: string): Checked => ({ ok: false, why })

// validate an already-typed value (what the file holds, or what parseValue made of text)
export function checkValue(e: Entry, v: unknown): Checked {
  switch (e.type) {
    case 'boolean':
      return typeof v === 'boolean' ? { ok: true, value: v } : bad('must be true or false')
    case 'number': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return bad('must be a number')
      if (e.int && !Number.isInteger(v)) return bad('must be a whole number')
      if (e.zero && v === 0) return { ok: true, value: v }
      if (e.min !== undefined && v < e.min) return bad(`must be at least ${e.min}${e.zero ? ' (or 0 for off)' : ''}`)
      if (e.max !== undefined && v > e.max) return bad(`must be at most ${e.max}`)
      return { ok: true, value: v }
    }
    case 'enum':
      return typeof v === 'string' && e.values!.includes(v) ? { ok: true, value: v } : bad(`must be one of ${e.values!.join(', ')}`)
    case 'string':
    case 'path': {
      if (typeof v !== 'string' || !v.trim() || CTRL.test(v) || v.length > 300) return bad(e.type === 'path' ? 'must be a folder path like ~/Downloads' : 'must be a short text')
      if (SECRET.test(v)) return bad('looks like a secret: lean_config never stores secrets')
      if (e.type === 'path' && !/^(~|\/)/.test(v.trim())) return bad('must be an absolute path or start with ~ (e.g. ~/Downloads)')
      return { ok: true, value: v.trim() }
    }
    case 'list': {
      if (typeof v === 'string' && e.special?.includes(v)) return { ok: true, value: v }
      if (!Array.isArray(v) || !v.every(x => typeof x === 'string' && x.trim() && !CTRL.test(x) && x.length <= 200)) return bad(`must be a list of names${e.special ? ` (or ${e.special.join(' / ')})` : ''}`)
      if (v.some(x => SECRET.test(x))) return bad('looks like a secret: lean_config never stores secrets')
      return { ok: true, value: v.map(x => x.trim()) }
    }
    case 'json': {
      if (v === false && (e.key === 'pr.checks' || e.key === 'review.prChecks')) return { ok: true, value: v } // false = every check of that side off
      if (e.shape === 'array' ? !Array.isArray(v) : !isObj(v)) return bad(`must be a JSON ${e.shape ?? 'value'}`)
      if (SECRET.test(JSON.stringify(v))) return bad('looks like a secret: lean_config never stores secrets')
      if (e.key === 'workerCaps' && !Object.values(v as Cfg).every(x => typeof x === 'number' && x > 0)) return bad('must map worker names to a USD number above 0')
      if (e.key === 'actions.standing' && !(v as unknown[]).every(x => isObj(x) && typeof x.project === 'string' && Array.isArray(x.kinds))) return bad('every entry needs a project (text) and kinds (a list)')
      return { ok: true, value: v }
    }
  }
}

// text the user typed -> a typed value, then checked
export function parseValue(e: Entry, raw: string): Checked {
  const t = String(raw).trim()
  if (e.type === 'boolean') {
    if (/^(true|on|yes)$/i.test(t)) return checkValue(e, true)
    if (/^(false|off|no)$/i.test(t)) return checkValue(e, false)
    return bad('must be true or false (on / off)')
  }
  if (e.type === 'number') {
    if (e.zero && /^(off|none)$/i.test(t)) return checkValue(e, 0)
    if (t === '' || !Number.isFinite(Number(t))) return bad('must be a number')
    return checkValue(e, Number(t))
  }
  if (e.type === 'enum') return checkValue(e, t.toLowerCase())
  if (e.type === 'list') {
    if (e.special?.includes(t.toLowerCase())) return checkValue(e, t.toLowerCase())
    if (t.startsWith('[')) {
      try {
        return checkValue(e, JSON.parse(t))
      } catch {
        return bad('not valid JSON: use a comma separated list or ["a", "b"]')
      }
    }
    return checkValue(e, t === '' ? [] : t.split(',').map(x => x.trim()))
  }
  if (e.type === 'json') {
    try {
      return checkValue(e, JSON.parse(t))
    } catch {
      return bad('not valid JSON')
    }
  }
  return checkValue(e, t)
}

// a value for display (the `~` stays as typed: it is expanded only where a path is used)
export function show(v: unknown): string {
  if (v === undefined || v === null) return 'not set'
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}
export const defaultText = (e: Entry): string => (e.default === null ? 'none' : show(e.default))
export const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
