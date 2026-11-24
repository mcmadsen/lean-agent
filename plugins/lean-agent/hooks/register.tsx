import type { Register } from 'claude-code'

import { recordRunning, recordSid, resolveRole, roleReport } from './role'
import type { Role } from './role'
import { deskClaudeMd, leanThread, listAgents, unusedField } from './threads'
import { limitFromUsage, limitTick, readLimit, sameReset, writeLimit } from './limits'
import { ensureGitHooks } from './githooks'
import { atomicWrite, deskDir, homeDir } from './state'
import type { Host } from './state'
import { BUSY_MAX_MS, DEFERRED_THREAD_TOOLS, THREAD_TOOLS, consumeWake, markDelivered, recordDeskSid, relayReports, sweep, takeBatch, takeReports, threadTool, unreadReports } from './delivery'
import { decide, workerJob } from './guard'
import { bindAnswers, resetActions, runPrChanges, runStanding, sweepExpired, withdrawByWords } from './deskactions'
import { noteRun, runPrGuide } from './prchecks'
import { holdLines, holdsTick } from './sendhold'
import { recordHumanPrompt } from './humanprompts'
import { auditStanding, bindOfferAnswers, revokeByWords, runGranted } from './deskwrites'
import { ownFromGrant } from './ownpr'
import { bindConfigAnswers, configTool } from './configtool'
import { missingWhat, refusalsText, ruleOf, workerLines } from './refusals'
import { noteCall, resetApprovals } from './approvals'
import { VERSION, dropSetupCheck, paneRole, registerPane, resetPaneState } from './pane'
import { lookStep } from './look'
import { overBudget, record } from './budget'
import { applyFeedback, parseFeedback } from './feedback'
import { capLine, checkStale, logRuleLoad, rulesUpdateCheck } from './rules'
import { markNative, projectRule, resetContext, resetRuleLoader, ruleContext } from './ruleload'
import { leanDir, readJson, threadsDir } from './state'
import { chase } from './chaser'
import { autoMigrate, check, checkReply, guardParents, guardTick, migrate } from './doctor'
import { mcpRows, setSettingsEnv } from './mcpenv'
import { bounded, openDesk, setupFix, setupText } from './setup'
import { checkDeskModel, decideSwitch, deskModelStatus, forgetUserChoice, newSwitchState, noteSdkSwitch, noteSwitched, noteUserChoice } from './deskmodel'
import { DESK_FAMILIES, deskChoice, modelFamily } from './models'
import { isExpensiveModel } from './expensive'
import type { Engine } from './deskmodel'
import { squeezeResult, trimTools } from './squeeze'
import { readConfig } from './budget'
import { hostOf } from './host'
import { resetSkillStat, isMcpInstructions, isSkillAttachment, noteAttachment, noteCarried, noteSection, offeredTo, skillsCarried, skillsSeen, trimListing } from './skilltrim'
import { deepReal, hasGrants, parseGrants, pathsOf, recordGrant, releaseAgent, releaseGrant, sweepGrants } from './guard'
import { jobOf, jobResult, retryCount } from './jobs'
import { recordWorkerCall } from './workerruns'
import { overheadReport } from './overhead'
import { threadSkillsLean } from './threadlean'
import { overheadProbe } from './probe'
import { memorySection, recordAnswer, runSchedule, writeCompactNotes } from './extras'
import { resetSkew, setRunning, skewNote } from './skew'
import { statsText } from './stats'
import { compare } from './compare'
import { announceRotation, rotateLedger } from './ledger'
import { takeNotice } from './notices'
import { AUDIT_ASYNC_NOTE, SCRIPT_SPEC, SCRIPT_TOOL, auditFromReply, bashFailed, isAuditorCall, isLeanCall, markAuditStarted, doneQuestion, noteBash, noteUse, noteWrite, resetScripts, scriptTool, takeNudges } from './scripts'
import { syncWithScripts } from './rulelines'
import { exportFeedback } from './feedbackexport'
import { logMissingTool, logRefusal } from './feedback'
import { autoRestartDesk, contextSize, deskTick, deskTurnEnded, forgetContext, hasUsage, limitLineOnce, noteUsage, recentUser, resetDeskCompact, restartDesk, serveHandover, servedBody, sessionId } from './deskcompact'
import { deskStartLines, retiredInfo, retiredLine } from './deskauto'
import { dismissOldDesk, oldDeskStep, resetOldDesk } from './olddesk'
import { reviewReport } from './reviewevidence'
import { saveReviewerBlock } from './reviewsave'
import { takeTip } from './tips'
import { finishedText, resetFinish, sweepFinished } from './finish'
import { capResult, capTo, resetCap } from './cap'
import { bindSelfEditAnswers, selfEditRoots, revokeSelfEditByWords } from './selfedit'
import { bindDeliverAnswers } from './deliver'
import { clearDenied, fallbackUsed, isSmall, launchOf, loadOrch, noteDelegationDenied, noteReaderDenied, orchAgentEnd, orchEnd, orchRan, orchTurnStart, readerCategory, takeDeniedHint, takeSliceNote, takeStepNote } from './orchestrate'
import { broadBrief, classifierDenial, denialKind, isLeanAgentType, noteDenialRec, worktreeRoots } from './denial'
import type { OCtx } from './orchestrate'
import { runCi, runSummary, runText } from './runjob'
import { runGet } from './forgeget'
import { contextReport, sessionBreakdown } from './contextstat'
import { briefHint } from './briefsize'
import { pullText } from './pull'
import { MEMORY_SPEC, memoryTool } from './memorytool'
import { memoryOnPrompt } from './memoryprompt'
import { relevantOnPrompt, triggerOnTool } from './memoryindex'
import { memoryDoctor } from './memorydoctor'
import { deferOutside, noteToolUse, readLoaded } from './profile'
import type { Loaded } from './profile'
import { drawThreadPane, resetThreadPanes, threadOfPane } from './threadpane'
import { resetRequestCache, touchActivity } from './threadstate'
import { NEW_THREAD_PANE, drawNewThread, resetNewThread } from './newthread'
import { recordContext, threadLimits, threadLimitsFor } from './threadcontext'
import { stallLines, stallTick } from './stall'
import { autoRestartTick, hardStop, threadTurnEnd } from './autorestart'
import { deliveryTick, directUnavailable, setThreadSender } from './deliver-to-thread'
import { announcedNext, continueTick, noteTurnEnd } from './continuepending'
import { STOP_RULE, notePending, stopGate } from './contextstop'
import { attachParts, noteBase } from './base'
import { partsOf, recordParts } from './ctxparts'
import { takeWarn, warnedAlready } from './scratchnotes'
import { threadToolsArgv } from './orchestrate'
import { ANSWER_RULE, answersEnd, loadAnswerChars, noteAgentCall, startAgent, stopAnswer } from './answers'
import { handoverReport, setPreflight } from './handover'
import { preflightFor } from './preflight'
import { currentTasks, noteEdited, noteTasks, resetEdited, takeEdited } from './snapshot'
import { asksRestart, checkpointTick, noteWarn, requestCheckpoint } from './checkpoint'
import { recordWindows, windowTick } from './windows'
import { softBudgetTick, softCheckpointTick, windowParkTick } from './budgettick'

setPreflight(preflightFor) // handover.ts includes the preflight pack (hooks/preflight.ts); a hooks module cannot import() lazily
setRunning(VERSION) // the code in this session; skew.ts compares it with what is installed

export { hostOf }

let notified = 0
let grantSeq = 0
let busySince = 0 // ms the desk's main turn started (0 = idle): the report relay never starts a turn over a running one
let lastRelay = 0
let deskModelTried = false // the desk's model / effort pin is applied at most once per session (deskmodel.ts)
let deskModelSeen = '' // the model last judged: a check runs again only when it changes
let switchState = newSwitchState() // this session's PreModelSwitch decisions (deskmodel.ts decideSwitch)
let promptSeen = false // the desk session's first user prompt has been checked: a model switch from then on can be the person's own
let modSession = String(Date.now()) // a session key when the engine gave no session id
const deskSession = () => lastSid || modSession
export const resetModState = () => {
  deskModelTried = false
  deskModelSeen = ''
  switchState = newSwitchState()
  promptSeen = false
  modSession = String(Date.now())
  notified = 0
  busySince = 0
  lastRelay = 0
  spent.clear()
  shown.clear()
  stopTimers()
  role = { kind: 'plain' }
  startDir = ''
  lastSid = ''
  applied = ''
  attempted = ''
  done.clear()
  noticed.clear()
  pending = []
  chain = Promise.resolve()
  seen = ''
  seenRoot = ''
  registered.clear()
  cwd = ''
  loaded = null
  started = {}
  projectOfThread = undefined
  rulesSection = null
  resetRuleLoader()
  resetPaneState()
  resetThreadPanes()
  resetNewThread()
  resetSkillStat()
  resetSkew()
  skew = null
  resetScripts()
  resetDeskCompact()
  resetOldDesk()
  resetFinish()
  resetCap()
  resetApprovals()
  resetActions()
  resetRequestCache()
}
let loaded: Loaded | null = null // a thread's profile (profile.ts): the MCP servers outside it are deferred; null = nothing held back
let started: { model?: string; effort?: string } = {} // a thread's model and effort as it was started (thread.json): written into its ledger rows
let rulesSection: string | null = null // the thread's `_project.md`, a session section of prompt.compose (set at the role's setup)
let projectOfThread: string | undefined // the thread's project (thread.json), read once per session; '' = none
async function threadProject(host: Host): Promise<string> {
  if (role.kind !== 'thread') return '' // not cached: the role may still be settling
  if (projectOfThread === undefined) projectOfThread = str((await readJson<{ project?: string }>(host, `${threadsDir(await homeDir(host))}/${role.id}/thread.json`, {})).project)
  return projectOfThread
}
let skew: string | null = null // the version-skew sentence of this session, or null
let role: Role = { kind: 'plain' }
let tries = 0
let attempted = '' // the role key whose steps `done` lists
const done = new Set<string>()
let applied = '' // the role applyRole last set up ('' = none yet, or a step failed and wants a retry)
let startDir = '' // the folder the session first resolved from, for refusal texts
let lastSid = ''
let seenRoot = '' // the root the role was last decided with
let seen = '' // the directories the role was last decided from
let timers: Array<() => void> = []
const registered = new Set<string>()
let chain: Promise<unknown> = Promise.resolve()
const noticed = new Set<string>() // threads whose stale-rules notice was given this session
let pending: string[] = [] // notices a later role change found, handed over at the next prompt
const roleKey = (r: Role) => (r.kind === 'thread' ? `thread:${r.id}` : r.kind)
const stopTimers = () => {
  for (const c of timers.splice(0)) {
    try {
      c()
    } catch {
      /* already stopped */
    }
  }
}
export const currentRole = () => role

const DOCTOR = 'lean_doctor'
const DOCTOR_SCHEMA = { type: 'object', properties: { action: { type: 'string', enum: ['check', 'fix', 'migrate', 'stats', 'compare', 'export', 'mcp-env', 'dismiss-old-desk', 'refusals', 'context', 'overhead', 'handover', 'memory'] }, session: { type: 'string', description: 'overhead, context: a session id or thread id tN (its recorded context by part, largest first, with what shrinks each); context desk: what the desk\'s own conversation consists of (by source, the ten largest items, growth per turn); overhead: "probe" or "probe tN" runs a few one-word haiku calls (about 5 cents)' }, name: { type: 'string', description: 'mcp-env: the variable name, never a secret; handover: the thread id' }, value: { type: 'string', description: 'mcp-env: its NON-secret value; without name and value it lists the servers that need one' }, replace: { type: 'boolean', description: 'mcp-env: true ONLY when the user asked to change a value that is set' }, days: { type: 'number', description: 'stats, refusals: days back (default 7)' }, project: { type: 'string', description: 'stats, compare: the registered project' }, mode: { type: 'string', enum: ['overhead', 'history'], description: 'compare: overhead (default) or history' }, notes: { type: 'string', description: 'export: free text for a Notes section' } }, required: ['action'] }
// settings (configtool.ts, the config skill): the desk's only way to change ~/.lean-agent/config.json; a thread or worker never has it
const CONFIG = 'lean_config'
const CONFIG_SPEC = { name: CONFIG, description: 'Settings (config skill): list [group], get, set, unset, validate. A safety-loosening key changes only on the user\'s typed words.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'get', 'set', 'unset', 'validate'] }, group: { type: 'string', description: 'list: one group' }, key: { type: 'string', description: 'get, set, unset: dotted key' }, value: { type: ['string', 'number', 'boolean', 'array'], description: 'set: the new value' } }, required: ['action'] } }
// execution model (orchestrate.ts): a test / build run whose output goes to a file; the thread gets exit code, failing tests, last 40 lines
const RUN = 'lean_run'
const RUN_SPEC = { name: RUN, description: 'Run a test or build command in the project: the output goes to a file, you get the exit code, the totals and the failures (a clean run is one line). Use it instead of Bash for tests and builds.', inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'the test / build command' }, context: { type: 'boolean', description: 'INSTEAD of command: what fills your context (sources by size, biggest results, one fix)' }, pull: { type: 'string', enum: ['brief', 'reports', 'notes', 'snapshot', 'preflight', 'memory'], description: 'INSTEAD of command: read a part of your restart store; no section = a list or headings' }, section: { type: 'string', description: 'pull: reports "<n>" or a word; notes / brief a heading; snapshot "status,tasks"; preflight / memory words' }, checkpoint: { type: 'object', description: 'INSTEAD of command: restart yourself at once (context near the cap): after writing scratch/notes.md, {next: "<the next step, 1-3 sentences>"}; end your turn; a fresh session continues', properties: { next: { type: 'string' } }, required: ['next'] }, cwd: { type: 'string', description: 'absolute folder (default: the thread\'s folder)' }, ci: { type: 'object', description: 'INSTEAD of command: a read-only CI check that waits inside the tool. {host: "ado", org, project, id | ids | branch, waitMinutes} or {host: "github", repo, id | ids | pr | branch, waitMinutes}; waitMinutes 0-30 (default 10)', properties: { host: { type: 'string', enum: ['ado', 'github'] }, org: { type: 'string' }, project: { type: 'string' }, repo: { type: 'string' }, id: { type: 'number' }, ids: { type: 'array', items: { type: 'number' } }, branch: { type: 'string' }, pr: { type: 'number' }, waitMinutes: { type: 'number' } }, required: ['host'] }, get: { type: 'object', description: 'INSTEAD of command: a forge READ by the mod (GET only). {host: "ado", org, project, path | repo, pr, threads: true} or {host: "github", path}; select = dotted field paths to keep', properties: { host: { type: 'string', enum: ['ado', 'github'] }, org: { type: 'string' }, project: { type: 'string' }, repo: { type: 'string' }, pr: { type: 'number' }, threads: { type: 'boolean' }, path: { type: 'string' }, query: { type: 'object' }, select: { type: 'array', items: { type: 'string' } } }, required: ['host'] }, 'pr-guide': { type: ['boolean', 'object'], description: 'INSTEAD of command: this repo\'s PR guidelines; {title, body} lints a PR text', properties: { title: { type: 'string' }, body: { type: 'string' } } }, 'pr-changes': { type: 'object', description: 'INSTEAD of command: a PR\'s changed files with line ranges, no checkout. {forge: "ado"|"github", org, project, repo, pr, iteration?}', properties: { forge: { type: 'string', enum: ['ado', 'github'] }, org: { type: 'string' }, project: { type: 'string' }, repo: { type: 'string' }, pr: { type: 'number' }, iteration: { type: 'number' } }, required: ['forge', 'pr'] } }, required: [] } }
const TOOL = 'lean_thread'
const MEMORY = 'lean_memory' // the desk's memory tool (memorytool.ts); a thread has lean_remember
const SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['new', 'send', 'wake', 'close', 'park', 'reopen', 'list', 'resume', 'start', 'projects', 'project-add', 'project-remove', 'project-private', 'profile', 'goal-set', 'goal-clear', 'approve-push', 'push', 'action-list', 'approve-action', 'allow-writes', 'allow-ask', 'revoke-writes', 'allow-self-edit', 'revoke-self-edit', 'deliver', 'restart', 'keep', 'keep-going', 'action-cancel', 'withdraw-action', 'find', 'ask', 'report', 'messages', 'dismiss', 'rule', 'set', 'limit', 'budget'] },
    priority: { type: 'string', enum: ['low', 'normal', 'urgent'], description: 'new: low waits and is parked while the 5h window is hot; urgent starts even above the block line' },
    tN: { type: 'string', description: 'thread id like t3 (every action except new, list, project-*)' },
    message: { type: 'string', description: 'alias of text' },
    text: { type: 'string', description: 'new: the brief; send: the message; restart / reopen / start / wake / resume: NEW instructions for the session this call starts (last part of its first prompt, they win over the handover; never a separate send); goal-set: the goal; find: words; ask: the question' },
    title: { type: 'string', description: 'new: short title' },
    project: { type: 'string', description: 'new, project-*: a registered project' },
    id: { type: 'string', description: 'approve-action: the id from action-list, only after the USER chose Approve for exactly that request' },
    target: { type: 'object', description: 'allow-writes: the PR (number or URL) or work item (id) the USER named in their own words; the mod refuses without their recorded words. Never a target the user did not write', properties: { pr: { type: ['number', 'string'] }, workitem: { type: ['number', 'string'] } } },
    file: { type: 'string', description: 'deliver: absolute path of a file in the thread\'s scratch folder, a worktree or the desk reports folder' },
    to: { type: 'string', description: 'deliver: Downloads | Desktop | Documents | a folder under the user\'s home (the mod copies only on the user\'s recorded words, else it returns the question to ask)' },
    name: { type: 'string', description: 'deliver: optional file name (never overwrites)' },
    kinds: { type: 'array', items: { type: 'string' }, description: 'allow-writes: narrower list (PR: reply, status, comment, link; work item: comment, update; {workitem: "new"}: create)' },
    section: { type: 'string', description: 'report tN: one section of its last report (a heading or part of one), instead of the digest' },
    full: { type: 'boolean', description: 'report tN: the whole last report (reports reach you as a short digest)' },
    verbose: { type: 'boolean', description: 'list: the long form (default: one short line per thread)' },
    sha: { type: 'string', description: 'approve-push, push: the full sha the user approved, naming this sha and branch' },
    reason: { type: 'string', description: 'approve-push: why. An expensive model (opus): why sonnet is not enough (required; the request waits for the user\'s Approve)' },
    review: { type: 'object', description: 'new: start a review thread: exactly one of pr, branch, sha (+ base); needs project', properties: { pr: { type: ['number', 'string'] }, branch: { type: 'string' }, sha: { type: 'string' }, base: { type: 'string' } } },
    pr: { type: ['object', 'number', 'string'], description: 'new, set: the PR number or URL the thread is started FOR (new: it then owns it; set: "none" clears). push: open a pull request {title, body?, base?, draft?} after the push', properties: { title: { type: 'string' }, body: { type: 'string' }, base: { type: 'string' }, draft: { type: 'boolean' } } },
    model: { type: 'string', enum: ['haiku', 'sonnet', 'opus'], description: 'default sonnet. Never choose opus yourself: only when the user asked, with a reason' },
    effort: { type: 'string', enum: ['low', 'medium', 'high'], description: 'new/start: default high' },
    path: { type: 'string', description: 'project-add: folder (must exist)' },
    on: { type: 'boolean', description: 'project-private, keep, keep-going: true or false; profile: false removes the profile' },
    keep: { type: 'boolean', description: 'new/start: keep mode (follow-ups resume the session until its context passes the limit)' },
    keepGoing: { type: 'boolean', description: 'new/start: the standing order "keep going, no asks"' },
    rules: { type: 'array', items: { type: 'string' }, description: 'new: standing rules of THIS thread (200 characters each): in its first prompt and every restart; see action rule' },
    inherit: { type: ['string', 'boolean'], description: 'new: "tN" (or true with tN): carry that thread\'s rules over, ONLY when the user said so in their own words' },
    workitem: { type: ['number', 'string'], description: 'new, set: the task\'s work item (id or URL; set: "none" clears). The mod also takes WI / PR numbers from the brief and the user\'s prompt and says so' },
    continues: { type: 'string', description: 'new: "tN", the thread this one follows: it inherits its work item and PR (rules only with inherit)' },
    force: { type: 'boolean', description: 'new: a thread for a work item that has one; ONLY when the user said "new thread"' },
    trigger: { type: 'string', description: 'rule: after-commit | after-step | before-push | on-pr-open' },
    output: { type: 'string', description: 'rule: the path the thread updates at the trigger (~/...)' },
    allowEdit: { type: 'array', items: { type: 'string' }, description: 'ignored' },
    allowCmd: { type: 'array', items: { type: 'string' }, description: 'ignored' },
    needs: { type: 'array', items: { type: 'string' }, description: 'new/start/reopen: MCP servers or plugins this thread needs beyond its project profile' },
    mcp: { type: 'array', items: { type: 'string' }, description: 'profile: MCP servers the project loads' },
    plugins: { type: 'array', items: { type: 'string' }, description: 'profile: plugins the project loads' },
    fill: { type: 'boolean', description: 'profile: add what the threads used' },
    all: { type: 'boolean', description: 'projects: include private ones' },
    confirm: { type: 'boolean', description: 'project-private off: only after the user agreed' },
    kind: { type: 'string', description: 'dismiss tN: the Needs-you item (question | prompt | approval | blocked | stalled | restart | ready | model | action); only after the USER said to' },
    notice: { type: 'string', description: 'dismiss: a top-of-pane notice id, or all; only after the USER said to' },
  },
  required: ['action'],
}


let cwd = ''
// AgentInfo (`$.agent.list()`) names the spawned type `type` (`lean-agent:worker-sonnet`); the other spellings are tolerated,
// then the event's own agent_type. Nothing found = UNRESOLVED: the guard treats it as a reader with no grants (fail closed).
export const UNRESOLVED = 'unresolved'
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
export const typeOfAgent = (list: any[], id: string, ev?: any): string => {
  const a = (Array.isArray(list) ? list : []).find(x => x?.id === id || x?.agentId === id)
  return str(a?.type) || str(a?.subagentType) || str(a?.agentType) || str(a?.agent_type) || str(ev?.agentType) || str(ev?.agent_type) || UNRESOLVED
}
const shown = new Set<string>()
async function agentType($: any, id?: string, ev?: any): Promise<string | undefined> {
  if (!id) return undefined
  let l: any[] = []
  try {
    l = (await $.agent.list()) as any[]
  } catch {
    /* an unreadable list leaves the type unresolved */
  }
  const t = typeOfAgent(l, id, ev)
  if (!shown.has(`${id}\0${t}`)) {
    shown.size > 500 && shown.clear()
    shown.add(`${id}\0${t}`) // once per agent: the fields the guard sees, names only (debug log, for a report)
    const a: any = (Array.isArray(l) ? l : []).find(x => x?.id === id || x?.agentId === id)
    try {
      $.ui.log(`lean-agent: agent fields ${JSON.stringify({ resolved: t, id, listed: !!a, type: a?.type, subagentType: a?.subagentType, agentType: a?.agentType, name: a?.name, keys: a ? Object.keys(a) : [], event: Object.keys(ev ?? {}), event_agent_type: ev?.agent_type ?? ev?.agentType })}`, { to: 'debug' })
    } catch {
      /* no debug log */
    }
  }
  return t
}

const spent = new Map<string, number>() // usd per subagent id, this session

let inTurn = false // a main-thread turn is running: the snapshot and the restart checkpoint are written at its END only, never in the middle
let turnStartedAt = 0
let lastEnd = '' // the turn end last handled (tokens@time): session.measure and turn.complete both reach it, once is enough
let lastTokens: number | null = null // the context size of the last session.measure of this thread

// The hard stop at the context limit (contextstop.ts): set at a turn end over the limit or by the tool.call check; cleared when the size is
// under the limit again (compaction) or the limit was raised. `stopCheck` answers every tool call of the thread's own main loop.
let stopped: { sid: string; tokens: number; limit: number } | null = null
let mainCalls = 0
const STOP_EVERY = 10 // tool calls between two size checks of a running turn
const stopChecked = new WeakMap<object, { deny: string } | null>() // one call can pass two of the tool.call handlers: it is judged (and counted, logged) once
async function stopCheck($: any, e: any): Promise<{ deny: string } | null> {
  if (role.kind !== 'thread' || e?.agentId) return null
  if (e && typeof e === 'object' && stopChecked.has(e)) return stopChecked.get(e)!
  const r = await stopCheckOnce($, e)
  if (e && typeof e === 'object') stopChecked.set(e, r)
  return r
}
async function stopCheckOnce($: any, e: any): Promise<{ deny: string } | null> {
  const id = role.kind === 'thread' ? role.id : ''
  try {
    const host = hostOf($)
    if (!stopped && ++mainCalls % STOP_EVERY === 0) {
      const tokens = Number((await bounded($, Promise.resolve($.session.usage()), 'session.usage').catch(() => null))?.context?.tokens)
      const limit = (await threadLimitsFor(host, id)).limit
      if (Number.isFinite(tokens) && tokens >= limit) {
        const sid = lastSid || String(await bounded($, Promise.resolve($.session.id()), 'session.id').catch(() => ''))
        lastTokens = tokens
        stopped = { sid, tokens, limit }
        await hardStop(host, id, { sid, tokens, limit, since: turnStartedAt, tasks: currentTasks() })
      }
    }
    if (!stopped) return null
    const limit = (await threadLimitsFor(host, id)).limit
    if (stopped.tokens < limit) {
      stopped = null // the limit was raised above the size
      return null
    }
    const st = { ...stopped, tokens: lastTokens ?? stopped.tokens, limit }
    const r = await stopGate(host, id, st, e)
    if (r) await logRefusal(host, { role: 'thread', rule: STOP_RULE, text: r.deny, tool: String(e.tool ?? ''), thread: id, version: VERSION })
    return r
  } catch {
    return null // a failing check never blocks a tool
  }
}

// A thread's turn end, by script (no model turn): the context size record, the plan-window snapshot, the state snapshot and, over the
// context limit with work left, the checkpoint the desk's timer restarts from (autorestart.ts). Observes only; every failure is silent.
// No engine call of its own (session.measure hands it the figures it already read): turn.complete uses the last measured size.
// The context breakdown of a turn end (ctxparts.ts): `full` (the token-count API per tool and memory file) once per session at its first turn end,
// `summary` (local estimates, no request) at every later one; recorded in the thread's folder. A failed full count is tried once more.
// The warn line (scratchnotes.ts): the current size is the engine's own figure (`$.session.usage()` costs nothing), asked until the line was said.
async function warnNote($: any, host: Host, addedChars = 0): Promise<string | null> {
  try {
    if (role.kind !== 'thread' || stopped) return null
    const sid = lastSid || String(await bounded($, Promise.resolve($.session.id()), 'session.id').catch(() => ''))
    if (!sid || warnedAlready(sid)) return null
    const u = Number((await bounded($, Promise.resolve($.session.usage()), 'session.usage').catch(() => null))?.context?.tokens)
    const base = Number.isFinite(u) ? u : lastTokens
    // the engine's figure does not hold THIS result yet: one result that jumps over the warn level (two reviewer passes, a diff) says so in its own reply
    const tokens = typeof base === 'number' ? base + Math.ceil(Math.max(0, addedChars) / 4) : base
    const limits = await threadLimitsFor(host, role.id)
    const line = takeWarn(sid, tokens, limits) // at the warn level and again at 90% of the limit
    if (!line) return null
    if (role.kind === 'thread') await noteWarn(host, role.id, sid) // the time of the warn line: the checkpoint wants notes newer than it
    const what = await sessionBreakdown(host, await homeDir(host), sid, tokens, limits.limit) // what fills it, by script from the transcript (1.0.27)
    return what ? `${line}. What fills it: ${what}` : line
  } catch {
    return null
  }
}
const partsTries = new Map<string, number>()
const partsFull = new Set<string>()
async function noteParts($: any, host: Host, id: string, sid: string): Promise<void> {
  try {
    if (!sid) return
    const first = !partsFull.has(sid) && (partsTries.get(sid) ?? 0) < 2
    if (first) partsTries.set(sid, (partsTries.get(sid) ?? 0) + 1)
    const ask = async (d: 'full' | 'summary') => partsOf((await bounded($, Promise.resolve($.session.usage({ breakdown: d })), 'session.usage breakdown', 20_000).catch(() => null))?.context?.breakdown, d === 'full')
    let p = first ? await ask('full') : null
    if (p) { if (partsFull.size >= 200) partsFull.clear(); partsFull.add(sid) }
    p ??= await ask('summary')
    if (!p) return
    // the engine counts every skill it has; the model reads the listing the mod rewrote: the fixed part uses what was really carried
    // (the Messages row is the real total minus the estimates, so it grows by the same amount)
    const read = skillsCarried()
    if (read > 0 && p.skills > read) {
      const d = p.skills - read
      p = { ...p, skills: read, fixed: p.fixed - d, messages: p.messages + d, skillsEngine: p.skills }
    }
    await recordParts(host, id, sid, { parts: p })
    if (p.full) await attachParts(host, id, p) // the start reply's "fixed base" reads it from base.json
  } catch {
    /* no breakdown: the first request stays "first request" */
  }
}
// The last assistant text of the turn that just ended, when NOTHING came after it (no tool call): the final message of the transcript tail is an assistant text.
// null = unknown or a tool call came last (continuepending.ts then records no "next:" continue).
async function lastTextOf($: any): Promise<string | null> {
  try {
    const m: any = await bounded($, Promise.resolve($.session.messages({ last: 3 })), 'session.messages', 5_000)
    const last = Array.isArray(m) ? m[m.length - 1] : null
    return last && last.role === 'assistant' && typeof last.text === 'string' && last.text.trim() ? last.text : null
  } catch {
    return null
  }
}
async function threadEnd(host: Host, id: string, tokensIn: unknown, sid: string, after?: () => Promise<void>, text?: () => Promise<string | null>): Promise<void> {
  try {
    const tokens = typeof tokensIn === 'number' && Number.isFinite(tokensIn) ? tokensIn : null
    const key = `${sid}:${tokens}@${Math.floor((await host.clock.now()) / 5_000)}`
    if (lastEnd === key) return
    lastEnd = key
    const out = await threadTurnEnd(host, id, { sid, tokens, since: turnStartedAt, tasks: currentTasks() })
    if (out.stop !== undefined) stopped = out.stop ? { sid, ...out.stop } : null // at or over the limit: the hard stop applies from now on
    await noteTurnEnd(host, id, { sid, since: turnStartedAt, lastText: text ? await text() : null, tasks: currentTasks() }) // an open task / "next:" at the end of a turn / keep-going: the desk's timer continues it by script
    if (after) await after() // (last: the breakdown may take a few seconds, the state and the stop must not wait for it)
  } catch {
    /* the next turn end tries again */
  }
}

// the desk's 10 s tick (exported for the specs): finished threads, queued messages, unread reports
export async function deskSweep($: any, host2: Host): Promise<void> {
  await ensureGitHooks(host2).catch(() => undefined) // watch: projects.json may change behind the mod's back
  // a thread whose last report is done and whose turn has ended is finished as a session (its process stopped; the next message
  // starts a new session with the handover); before the wake sweep, which would otherwise find it idle
  for (const id of await sweepFinished(host2, id => leanThread(host2, $.plugin.root, { action: 'finish', tN: id })).catch(() => [] as string[])) $.ui.notify(finishedText(id), { key: `lean-finished-${id}` })
  await sweep(host2, id => leanThread(host2, $.plugin.root, { action: 'wake', tN: id }))
  const n = (await unreadReports(host2)).recs.length
  if (n && n !== notified) $.ui.notify(`${n} unread report(s) from threads`, { key: 'lean-reports' })
  notified = n
  // an idle desk gets ONE turn for a question or a done/blocked report (config desk.autoRelay, default on)
  if (n && (await readConfig(host2, await homeDir(host2))).desk?.autoRelay !== false) {
    const now = await host2.clock.now()
    const busy = busySince > 0 && now - busySince < BUSY_MAX_MS
    const sent = await relayReports(host2, { busy, last: lastRelay, submit: text => $.prompt.submit({ text }) })
    if (sent) lastRelay = now
  }
}

// one desk compaction attempt (the 30 s timer, and the end of a desk turn after a veto or failure)
async function compactDesk($: any, host2: Host): Promise<string> {
  const now = await host2.clock.now()
  const out = await deskTick(host2, {
    // (the engine's own figure only before this session's first request: right after a compaction it may still be the old one)
    tokens: async () => contextSize() || (hasUsage() ? 0 : Number((await $.session.usage())?.context?.tokens) || 0),
    busy: () => busySince > 0 && now - busySince < BUSY_MAX_MS,
    compact: async instructions => $.session.compact({ instructions }), // (an engine without it, or a turn that started, rejects: the handover file)
    // (the engine runs every session.compact hook but the calling plugin's own, checked live: the notes are written here)
    notes: async () => {
      const m: any = await $.session.messages({ last: 6 })
      await writeCompactNotes(host2, role, Array.isArray(m) ? m : [])
    },
    recent: () => recentUser($),
    sid: () => lastSid,
    status: text => $.ui.status(text),
    reset: forgetContext,
  })
  if (out !== 'quiet') $.ui.log(`lean-agent: desk context: ${out}`, { to: 'debug' })
  return out
}

// a worker's reply ends with LEAN-FEEDBACK: gaps and memory go to the files, the thread's own turn is unchanged
// a failed tool call that says the tool is not available to this session or worker (refusals.ts missingWhat): recorded as kind missing-tool
async function noteMissingTool(host: Host, gctx: any, rname: string, e: any, text: string): Promise<void> {
  const what = missingWhat(String(e.tool ?? ''), text)
  if (!what) return
  const job = e.agentId ? await workerJob(host, gctx) : undefined
  await logMissingTool(host, { role: rname, what, job, thread: role.kind === 'thread' ? role.id : undefined, agent: gctx.agentType, version: VERSION })
}
// the answer lines of a worker that stopped at its limit: `split:`, `missing:`, `refused:` (the job type is the one in the brief)
async function noteWorkerLines(host: Host, thread: string, agent: string | undefined, e: any, text: string): Promise<void> {
  const job = jobOf(e.prompt) ?? undefined
  for (const l of workerLines(text)) await logMissingTool(host, { role: 'worker', what: l, job, thread, agent, version: VERSION })
}
const texts = (v: any): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(texts) : v && typeof v === 'object' ? Object.values(v).flatMap(texts) : [])
async function feedbackOf(host: Host, e: any, r: any): Promise<void> {
  if (e.agentId || (e.tool !== 'Agent' && e.tool !== 'Task') || r?.deny !== undefined) return
  const fb = parseFeedback(texts(r?.result).join('\n'))
  if (!fb) return
  let project: string | undefined
  if (role.kind === 'thread') project = (await readJson<{ project?: string }>(host, `${threadsDir(await homeDir(host))}/${role.id}/thread.json`, {})).project
  await applyFeedback(host, { thread: role.kind === 'thread' ? role.id : undefined, project, agent: String(e.subagent_type ?? e.agent ?? '') || undefined, version: VERSION }, fb)
}

// one failing step is reported (status line + debug log) and never stops the next one
// (a step that hangs is given up after 5 s and counts as failed; the queue goes on)
async function soft($: any, label: string, fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await bounded($, Promise.resolve().then(fn), label)
    return true
  } catch (err) {
    const msg = `lean-agent: ${label} failed: ${String((err as Error)?.message ?? err).slice(0, 120)}`
    try {
      $.ui.status(msg)
    } catch {
      /* no status line */
    }
    try {
      $.ui.log(msg, { to: 'debug' })
    } catch {
      /* no debug log */
    }
    return false
  }
}

// the engine replaces a tool registered again under the same name, so a repeat is harmless; `registered` only saves the call
// the specs this session registered (lean_doctor overhead measures them: what a request carries for lean-agent's own tools)
const seenSpecs = new Map<string, any>()
async function registerOnce($: any, spec: any): Promise<void> {
  if (registered.has(spec.name)) return
  await $.tool.register(spec as any)
  registered.add(spec.name)
  seenSpecs.set(spec.name, spec)
}

// thread side of the usage-limit resume: the exhausted rate-limit windows give the reset (limitFromUsage); the record is kept as it is
// when it is already there for the same reset (it may carry the "already resumed" mark)
async function noteLimit($: any, id: string): Promise<void> {
  const host = hostOf($)
  const now = await host.clock.now()
  const resetAt = limitFromUsage(await $.session.usage(), now)
  if (!resetAt || !lastSid) return
  const home = await homeDir(host)
  const old = await readLimit(host, home, id)
  if (old && sameReset(resetAt, old.resetAt)) {
    // the same reset, whatever the seconds: its "already resumed" mark stays (only a changed session id is followed)
    if (old.sid !== lastSid) await writeLimit(host, home, id, { ...old, sid: lastSid })
    return
  }
  await writeLimit(host, home, id, { resetAt, seenAt: now, source: 'mod', sid: lastSid })
}

// every timer asks the CURRENT role, so a stray tick after a role change does nothing
function every($: any, ms: number, want: Role['kind'], fn: (host: Host) => Promise<void>): void {
  const t = $.clock.every(ms, async () => {
    if (role.kind !== want) return
    try {
      if (want === 'desk' && (await retiredInfo(hostOf($), lastSid))) return // a newer desk took over (desk.json names it): this one's relays, chaser, restarts, stall and budget alerts stop (deskauto.ts)
      await fn(hostOf($))
    } catch {
      /* the next tick tries again */
    }
  })
  if (t?.cancel) timers.push(() => t.cancel())
}

// All role-dependent setup, idempotent: the same role again does nothing; a changed role stops the old role's
// timers and sets the new one up. Tools registered for an earlier role stay (their handlers refuse by role).
// Returns session context lines (stale learned rules).
export async function applyRole($: any, host: Host, newRole: Role): Promise<string[]> {
  const key = roleKey(newRole)
  role = newRole
  if (key === applied) return []
  if (key !== attempted) {
    stopTimers()
    notified = 0
    attempted = key
    tries = 0
    done.clear()
  }
  applied = key
  const ctx: string[] = []
  let ok = true
  // a step that succeeded for this role is never repeated; a failed one is retried at the next check
  const step = async (label: string, fn: () => Promise<unknown>) => {
    if (done.has(label)) return
    if (await soft($, label, fn)) done.add(label)
    else ok = false
  }
  if (newRole.kind === 'thread') {
    const tid = newRole.id
    await step('thread tools', async () => {
      // (lean_profile, lean_rules, lean_compare and lean_worktree are used in one kind of run only: behind ToolSearch, so they add nothing to a thread's first turn)
      for (const t of THREAD_TOOLS) await registerOnce($, { ...t, isDeferred: DEFERRED_THREAD_TOOLS.has(t.name) })
      await registerOnce($, { ...SCRIPT_SPEC, isDeferred: false })
      await registerOnce($, { ...RUN_SPEC, isDeferred: false } as any)
    })
    // what this thread was started with: its profile (tool.describe defers the MCP servers outside it), model and effort (ledger rows)
    await step('thread profile', async () => {
      const home = await homeDir(host)
      loaded = await readLoaded(host, home, tid)
      const t = await readJson<{ model?: unknown; effort?: unknown }>(host, `${threadsDir(home)}/${tid}/thread.json`, {})
      started = { ...(typeof t.model === 'string' ? { model: t.model } : {}), ...(typeof t.effort === 'string' ? { effort: t.effort } : {}) }
    })
  } else {
    loaded = null
    started = {}
  }
  await step('0.45 migration check', () => autoMigrate(host, $.plugin.root)) // leftover 0.45 service: unloaded at once, then the idempotent migrate
  if (newRole.kind === 'desk' || newRole.kind === 'thread') await step('git hooks', () => ensureGitHooks(host))
  if (newRole.kind === 'desk') {
    await step('desk tools', async () => {
      await registerOnce($, {
        name: TOOL,
        description:
          'Manage lean-agent threads (the thread skill has the flow): new, send, wake, close, park, reopen, list, resume, start, restart (only on the user\'s request), keep, keep-going (tN on|off: when the user says "keep going / no asks"); action-cancel (id: a reply held 30 s before sending); withdraw-action (id, text = the user\'s reason: a request still waiting leaves unsent and its thread is told; use it when the user rejected the idea in chat); projects (list), project-add, project-remove, project-private, profile; goal-set, goal-clear; approve-push (tN + full sha, only after the user said yes to that sha and branch) then push (the desk pushes, optional pr {title}; a thread never pushes); action-list then approve-action (id, after the user\'s Approve): the desk sends a thread\'s remote write; allow-writes / revoke-writes (approval in advance, only on the user\'s own recorded words) and allow-ask (tN, target: returns the question to ask with AskUserQuestion: their Allow answer is the written yes); allow-self-edit / revoke-self-edit (tN: a thread whose worker call the classifier denied may edit its own worktree, only on the user\'s recorded words naming it); deliver (tN, file, to Downloads | Desktop | Documents | a folder, name?: a file for the user\'s folder); rule (tN, text, on? false = off, trigger?, output?: a standing rule of ONE thread, kept across restarts; `new` takes `rules`); find, ask, report, messages (tN: the last messages sent to it with state queued / delivered / consumed and age, no model), dismiss. A send answers with the message id and state ("m3: queued, not read yet"); a send to a running thread is only queued, read at its next tool call, and the mod wakes or restarts it by script when it stays unread (never send the same text again).',
        inputSchema: SCHEMA,
        isDeferred: false,
      } as any)
      await registerOnce($, {
        name: DOCTOR,
        description: 'lean-agent doctor (the doctor skill): check (read-only), fix, migrate, stats (computed here, never read the ledger yourself), compare, export (one anonymised feedback file; never posts), mcp-env (a NON-secret variable of an MCP server), dismiss-old-desk, refusals, context, overhead, handover, memory (per scope: items, tokens, what the last sessions got, over budget).',
        inputSchema: DOCTOR_SCHEMA,
        isDeferred: false,
      } as any)
      await registerOnce($, { ...SCRIPT_SPEC, isDeferred: false })
      await registerOnce($, { ...CONFIG_SPEC, isDeferred: false })
      await registerOnce($, { ...MEMORY_SPEC, isDeferred: false } as any)
    })
    await step('desk timers', async () => {
      setThreadSender((sid, text) => $.session.send({ to: { sessionId: sid }, text })) // desk -> thread, direct (deliver-to-thread.ts)
      // (same 10 s timer: the sweep, then) a message sent straight to a thread's session that started no turn within threads.answerWaitSeconds: the thread is
      // restarted by script with the message (one notice); an open question unanswered for threads.waitReminderMinutes comes back once (deliver-to-thread.ts)
      every($, 10_000, 'desk', async host2 => {
        await deskSweep($, host2).catch(() => undefined)
        const notes = await deliveryTick(host2, { agents: async () => (await listAgents(host2)) as any, restart: (id, why, rewind) => leanThread(host2, $.plugin.root, { action: 'answer-restart', tN: id, reason: why, rewind }) })
        for (const n of notes) {
          if (n.toast) $.ui.notify(n.text, { key: `lean-delivery-${n.id}` })
          pending.push(`[lean-agent] ${n.text}`)
        }
      })
      // a turn that ended with "next: ..." (or any turn end of a keep-going thread) is continued by script after threads.continueSeconds (continuepending.ts)
      every($, 10_000, 'desk', async host2 => {
        const notes = await continueTick(host2, { agents: async () => (await listAgents(host2)) as any, send: (id, text) => leanThread(host2, $.plugin.root, { action: 'send', tN: id, text }) })
        for (const n of notes) {
          $.ui.notify(n.text, { key: `lean-continue-${n.id}` })
          pending.push(`[lean-agent] ${n.text}`)
        }
      })
      // a covered reply held for actions.holdSeconds (sendhold.ts): sent when its window ends or the user pressed Send now; a thread that is no longer open sends nothing
      every($, 5_000, 'desk', async host2 => {
        const notes = await holdsTick(host2, { run: async id => (await runStanding(host2, id)) ?? (await runGranted(host2, id)), tell: (thread, text) => leanThread(host2, $.plugin.root, { action: 'send', tN: thread, text }).then(() => undefined) })
        for (const n of notes) {
          $.ui.notify(n.text, { key: `lean-hold-${n.id}` })
          pending.push(`[lean-agent] ${n.text}`)
        }
      })
      // the chaser: a goal untouched for an hour gets one status message to its open thread
      every($, 60_000, 'desk', async host2 => void (await chase(host2, (id, text) => leanThread(host2, $.plugin.root, { action: 'send', tN: id, text }))))
      // usage limit: a thread blocked by it is resumed once, two minutes after the reset (docs/usage-limit-resume.md; config desk.autoResume)
      every($, 60_000, 'desk', async host2 => {
        const did = await limitTick(host2, {
          agents: async () => (await listAgents(host2)) as any,
          logs: async row => {
            const r = await host2.process.run(['claude', 'logs', row.id || row.sid.slice(0, 8)], { timeoutMs: 20_000 })
            return r.exitCode === 0 ? r.stdout.slice(-20_000) : null
          },
          resume: id => leanThread(host2, $.plugin.root, { action: 'limit-resume', tN: id }),
        })
        for (const line of did) $.ui.log(`lean-agent: ${line}`, { to: 'debug' })
      })
      // the desk's own context: idle and over config deskTokens (default 100000; the handover is written from 80%) it compacts itself (fixed instructions); a veto or a
      // failure is recorded with its reason and tried again when the turn ends; when it is not possible the mod writes desk/handover.md
      // and says so in the status line (deskcompact.ts)
      every($, 30_000, 'desk', async host2 => void (await compactDesk($, host2)))
      // a stale parent guide that reappears while the desk runs: stat only, guardParents runs when something changed
      every($, 30_000, 'desk', async host2 => {
        for (const line of await guardTick(host2)) $.ui.log(`lean-agent: ${line}`, { to: 'debug' })
      })
      // scheduled sends: due lines of scheduled.jsonl go to their thread while the desk runs
      every($, 30_000, 'desk', async host2 => void (await runSchedule(host2, (id, text) => leanThread(host2, $.plugin.root, { action: 'send', tN: id, text }))))
      // a thread over its context limit (checkpointed at its turn end, autorestart.ts) is restarted by script once its session has been idle
      // 20 s: a notice for the desk's next prompt and a toast, no desk model turn (config threads.autoRestart, default on)
      every($, 30_000, 'desk', async host2 => {
        const notes = await autoRestartTick(host2, { agents: async () => (await listAgents(host2)) as any, restart: (id, why, force) => leanThread(host2, $.plugin.root, { action: 'auto-restart', tN: id, reason: why, force }) })
        for (const n of notes) {
          $.ui.notify(n.text, { key: `lean-autorestart-${n.id}` })
          pending.push(`[lean-agent] ${n.text}`)
        }
      })
      // a thread that called lean_run {checkpoint} (or announced / asked for a restart) is restarted by script 10 s after its turn ended, with its `next` as the
      // last instruction of the fresh session (checkpoint.ts): one desk line, no desk model turn
      every($, 10_000, 'desk', async host2 => {
        const notes = await checkpointTick(host2, { agents: async () => (await listAgents(host2)) as any, restart: (id, why, force, text) => leanThread(host2, $.plugin.root, { action: 'auto-restart', tN: id, reason: why, force, text }) })
        for (const n of notes) {
          $.ui.notify(n.text, { key: `lean-checkpoint-${n.id}` })
          pending.push(`[lean-agent] ${n.text}`)
        }
      })
      // a thread whose session is alive and working but made no tool call and no report for threads.stallMinutes (stall.ts): ONE notice + toast per
      // stall; threads.stallRestart restarts it by script
      every($, 30_000, 'desk', async host2 => {
        const notes = await stallTick(host2, { agents: async () => (await listAgents(host2)) as any, restart: (id, why) => leanThread(host2, $.plugin.root, { action: 'stall-restart', tN: id, reason: why, force: true }) })
        for (const n of notes) {
          $.ui.notify(n.text, { key: `lean-stall-${n.id}` })
          pending.push(`[lean-agent] ${n.text}`)
        }
      })
      // the plan windows (desk/windows.json, written by the sessions' mods): a notice at 80 % and at 90 %, once per window, naming the
      // threads working now (windows.ts)
      every($, 60_000, 'desk', async host2 => {
        const lines = await windowTick(host2, {
          working: async () => {
            const home = await homeDir(host2)
            const rows = (await listAgents(host2)) ?? []
            const ids = (await host2.fs.list(threadsDir(home)).catch(() => [] as { name: string }[])).map(x => x.name).filter(n => /^t\d+$/.test(n))
            const out: string[] = []
            for (const id of ids) {
              const t = await readJson<{ sid?: string } | null>(host2, `${threadsDir(home)}/${id}/thread.json`, null)
              const row = t?.sid ? rows.find(a => a.sid === t.sid) : undefined
              if (row && row.state === 'working') out.push(id)
            }
            return out
          },
        })
        for (const text of lines) {
          $.ui.notify(text, { key: `lean-window-${text.slice(0, 2)}` })
          pending.push(`[lean-agent] ${text}`)
        }
      })
      // budget and window awareness (budgettick.ts): threads with priority low are parked while the 5h window is hot and resumed when it is not; one notice each way
      every($, 60_000, 'desk', async host2 => {
        const run = { thread: (i: { action: string; tN: string; reason?: string; force?: boolean; text?: string }) => leanThread(host2, $.plugin.root, i) }
        const notes = [...(await windowParkTick(host2, run)), ...(await softCheckpointTick(host2, { ...run, agents: async () => (await listAgents(host2)) as any })), ...(await softBudgetTick(host2, run))]
        for (const text of notes) {
          $.ui.notify(text, { key: `lean-budget-${text.slice(0, 24)}` })
          pending.push(`[lean-agent] ${text}`)
        }
      })
    })
    // the desk folder's CLAUDE.md is generated: written only when it changed
    await step('desk CLAUDE.md', async () => {
      const want = await deskClaudeMd(host, $.plugin.root)
      const file = `${deskDir(await homeDir(host))}/CLAUDE.md`
      const have = await host.fs.read(file).catch(() => null)
      if (want && have !== want) await atomicWrite(host, file, want)
    })
  }
  await step('pane', async () => {
    for (const c of await paneRole($, newRole)) timers.push(c)
  })
  if (newRole.kind === 'thread') {
    // learned rules: copied into the project's checkout (registered in projects.json), and told when they went stale;
    // a thread's own worktree gets its copy from the worktree skill (lean_rules sync)
    let th: { project?: string } = {}
    try {
      th = await readJson<{ project?: string }>(host, `${threadsDir(await homeDir(host))}/${newRole.id}/thread.json`, {})
      // the engine loads a project's rules only beneath the session's root, which is the thread folder: the mod hands over `_project.md`
      // now (a prompt section, not the session.start event: that one has no `context` and the engine ignores what is put on it) and the
      // path rules on the first read of a matching file (ruleload.ts). It reads the store, so it needs neither the sync nor a git call.
      if (th.project) {
        const proj = await projectRule(host, { session: lastSid, agent: '', thread: newRole.id }, th.project, 'session.start')
        if (proj) rulesSection = proj
      }
    } catch {
      /* rules are optional */
    }
    try {
      const projs = await readJson<Record<string, { path?: string }>>(host, `${leanDir(await homeDir(host))}/projects.json`, {})
      const repo = th.project ? projs?.[th.project]?.path : undefined
      if (th.project && typeof repo === 'string' && repo.startsWith('/')) {
        // the learned rules, the adopted scripts' rule lines and recipe skills, into the checkout AND every worktree of the project (a plain
        // `git worktree add` one too); what the caps touched is told, not dropped silently
        const synced = await syncWithScripts(host, th.project, repo, true)
        const notes: string[] = []
        const cap = capLine(synced)
        if (cap) notes.push(cap)
        const stale = await checkStale(host, th.project, repo)
        notes.push(...stale)
        if (notes.length && !noticed.has(newRole.id)) {
          noticed.add(newRole.id)
          ctx.push(`[lean-agent] ${notes.join('; ')}`)
        }
      }
    } catch {
      /* rules are optional */
    }
  }
  // the tool pool depends on the role (the desk's is trimmed): ask the engine for it again
  await step('tool pool refresh', async () => void $.ui.invalidate('tool.list')) // once per role; retried if it failed
  // the engine caches the skill listing and sections: one built before the role was known (a pre-started spare session) is asked again
  await step('prompt refresh', async () => {
    for (const ev of ['prompt.attachment', 'prompt.section', 'tool.describe']) $.ui.invalidate(ev)
  })
  // a failed step is tried again at the next check, three times at most per role (then it waits for a role change)
  if (!ok && ++tries < 3) applied = ''
  return ctx
}

// Decide the role from the session's directories and apply it. A failed detection leaves the role as it is.
async function settle($: any, host: Host, dir: string, root: string, useRoot = true): Promise<string[]> {
  let r: Role | null = null
  const ok = await soft($, 'role detection', async () => {
    const sid = await bounded($, Promise.resolve($.session.id()), 'session.id').catch(() => '')
    lastSid = typeof sid === 'string' ? sid : ''
    if (!startDir) startDir = dir
    r = await resolveRole(host, { cwd: dir, root, sid: lastSid, current: role, useRoot })
    if (r.kind === 'thread') {
      await recordSid(host, r.id, lastSid).catch(() => false)
      await recordRunning(host, r.id, lastSid, VERSION).catch(() => false) // which code this session runs, for the desk (skew.ts runningOf)
    }
    if (r.kind === 'desk' && lastSid) await recordDeskSid(host, lastSid).catch(() => undefined) // threads send their reports straight to it
  })
  if (ok) {
    seen = `${dir}\n${root}`
    seenRoot = root // a failed detection is tried again at the next check
    cwd = dir
  }
  return applyRole($, host, r ?? role)
}

// Re-check the directory (CwdChanged, turn.start, prompt.submit): nothing happens unless it changed.
// All role changes run one after the other.
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn)
  chain = run.catch(() => undefined)
  return run
}

function redetect($: any, hint?: string, force = false): Promise<unknown> {
  return serial(async () => {
    const dir = hint ?? (await bounded($, Promise.resolve($.session.cwd()), 'session.cwd').catch(() => ''))
    const root = await bounded($, Promise.resolve($.session.root()), 'session.root').catch(() => '')
    if (!dir && !root) return
    const d = typeof dir === 'string' && dir ? dir : String(root)
    const rt = typeof root === 'string' ? root : ''
    if (!force && applied && seen === `${d}\n${rt}`) return
    pending.push(...(await settle($, hostOf($), d, rt, !hint && rt !== seenRoot))) // an event's own directory beats a root that may not have moved yet
  }).catch(() => undefined)
}

// The desk runs on `running`: the pin is applied once per session (session.start when the model is known, else the first request), and
// a later change of model is only noted (state for the pane's top row). Never throws; the text, when there is one, goes to the next prompt.
// (async: a call that throws before it returns a promise is a rejection too)
const engineOf = ($: any): Engine => ({
  configList: async () => bounded($, Promise.resolve($.config.list()), 'config.list'),
  configSet: async a => bounded($, Promise.resolve($.config.set(a)), 'config.set'),
  model: async () => bounded($, Promise.resolve($.session.model()), 'session.model'),
})
// The session's own model is what is judged (a request may be a side request on a small model, a title or a summary); the request's
// model only stands in when the session cannot say.
async function deskModelCheck($: any, fromRequest = '', again = false): Promise<void> {
  try {
    const sm = String((await engineOf($).model().catch(() => '')) ?? '')
    const running = DESK_FAMILIES.includes(modelFamily(sm)) ? sm : fromRequest
    if (!running) return
    // a later prompt whose session model is not the pin again (the app chose it once more) puts the pin back BEFORE the turn runs
    const host = hostOf($)
    const apply = !deskModelTried || (again && modelFamily(running) !== (await deskChoice(host, await homeDir(host))).model)
    if (!apply && running === deskModelSeen) return
    deskModelTried = true
    deskModelSeen = running
    const r = await checkDeskModel(host, engineOf($), running, apply, deskSession(), again ? 'prompt' : 'start')
    if (r.text && !r.repeat) pending.push(`[lean-agent] ${r.text}`) // said once per session; the pane notice carries the count
  } catch {
    /* a model check that fails changes nothing */
  }
}

// the tool pool for a role, the CURRENT one unless given (a test's `$` cannot raise tool.list)
export async function poolFor<T extends { name: string }>(host: Host, tools: T[], kind: Role['kind'] = role.kind): Promise<T[]> {
  const cfg: any = await readConfig(host, await homeDir(host))
  return trimTools(tools, kind, cfg.tools)
}

// Running code older (or newer) than the installed plugin: a status line now and at every turn (a pane tick may have replaced
// it), one prompt line in prompt.compose. A failed look changes nothing.
async function showSkew($: any): Promise<void> {
  try {
    skew = await skewNote(hostOf($), String($.plugin.root), VERSION)
    if (skew) $.ui.status(skew)
  } catch {
    /* no status line, or the manifest could not be read */
  }
}

// (see the hooks in register: classic.PermissionDenied and classic.PostToolUseFailure)
// (the matcher is denial.ts classifierDenial: the engine's real text "Permission for this action was denied by the Claude Code auto mode classifier.
// Reason: [<category>]. ...", any category, any lean-agent type; our own refusals never count. Three ways in: the PermissionDenied event, a failed Agent
// result, and the Agent call's own error RESULT in tool.call: the 1.0.18 fallback saw only the first two, only for worker-*, only with an absolute path
// in the brief, and then refused the thread's own worktree because lean state was "protected".)
async function noteDenied($: any, role: any, cwd: string, deniedSeen: Set<string>, e: any, via: string, text = ''): Promise<void> {
  if (role.kind !== 'thread' || e?.agent_id || e?.agentId) return
  const input = e?.tool_input
  if ((e?.tool_name !== 'Agent' && e?.tool_name !== 'Task') || !input || typeof input !== 'object' || !isLeanAgentType(input.subagent_type)) return
  const id = String(e?.tool_use_id ?? '')
  if (id && deniedSeen.has(id)) return
  if (id) { if (deniedSeen.size >= 200) deniedSeen.clear(); deniedSeen.add(id) }
  const host = hostOf($)
  const prompt = String(input.prompt ?? '')
  const category = [text, String(e?.reason ?? ''), String(e?.error ?? '')].map(t => classifierDenial(t)?.category).find(c => c && c !== 'unspecified') ?? 'unspecified' // the text of THIS event first
  const stype = String(input.subagent_type ?? '')
  const kind = /^(lean-agent:)?worker-/.test(stype) && jobOf(prompt) === 'lookup' ? 'reader' : denialKind(stype) // a lookup is read-only whoever does it
  if (kind === 'reader') {
    // a denied reader is no reason to read everything oneself (orchestrate.ts): the engine's reason category, ONE retry with a narrower brief, then slices
    noteReaderDenied(`${threadsDir(await homeDir(host))}/${role.id}`, category === 'unspecified' ? readerCategory(via === 'PermissionDenied' ? e?.reason : e?.error) : category)
  }
  const roots: string[] = []
  if (kind !== 'reader') {
    for (const r of pathsOf(prompt)) roots.push(await deepReal(host, r, cwd).catch(() => r), ...(r.startsWith('/') ? [r] : []))
    roots.push(...(await worktreeRoots(host, role.id, prompt).catch(() => [])))
  }
  const key = `${threadsDir(await homeDir(host))}/${role.id}`
  const broad = broadBrief(prompt)
  const recorded = noteDelegationDenied(key, roots, { category, kind, broad })
  await noteDenialRec(host, role.id, { category, kind, agent: String(input.subagent_type ?? ''), roots: roots.slice(0, 12), ...(broad ? { broad } : {}) }).catch(() => undefined)
  await logRefusal(host, { role: 'thread', rule: 'delegation-denied', text: `delegation-denied: the permission check denied the ${kind === 'reader' ? 'reader' : 'worker'} call (${via}; reason ${category})${kind === 'reader' ? '; the thread was told to retry once or read in slices' : recorded ? '; the thread\'s own edit in its worktrees and the paths its brief named is allowed now' : '; no worktree or path to allow'}${broad ? `; ${broad}` : ''}`, agent: String(input.subagent_type ?? ''), tool: String(e.tool_name), thread: role.id, version: VERSION })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // $ is only ever spelled $.noun.event(...): the helpers get this thin host instead of $ itself
    const host = hostOf($)
    resetModState()
    clearDenied() // a denied worker call allows the thread's own edits for the rest of THIS session only
    const root = await bounded($, Promise.resolve($.session.root()), 'session.root').catch(() => '')
    const ctx = await serial(() => settle($, host, e.cwd, typeof root === 'string' ? root : ''))
    await showSkew($)
    // the optional look (config pane.theme: on; off by default and then nothing is touched): sent once per session start (look.ts)
    await soft($, 'look', async () => { await lookStep($, host) })
    // the ledger grows with every model request: a past month (or a file that starts with a 0.45 row) is renamed away, never rewritten
    let rotated: string[] = []
    await soft($, 'ledger rotation', async () => { rotated = await rotateLedger(host) })
    if (role.kind === 'thread') await sweepGrants(host, role, { sid: lastSid || undefined, ttlMin: (await loadOrch(host).catch(() => undefined))?.grantTtlMin }).catch(() => undefined) // stale grants (older than grants.ttlMinutes, other session) go
    if (rotated.length) await announceRotation(host, rotated) // any session may rotate: the notice is what the desk reads
    if (role.kind === 'desk') {
      // a standing approval that rests on no press of yours is revoked and flagged (FIX row); a request nobody decided in time leaves unsent and says so (deskactions.ts)
      await soft($, 'standing audit', async () => { await auditStanding(host) })
      await soft($, 'request expiry', async () => { await sweepExpired(host, (thread, text) => leanThread(host, $.plugin.root, { action: 'send', tN: thread, text }).then(() => undefined)) })
      // the desk's next prompt says so once, whichever session did it (the pane lists the notice until then)
      const said = await takeNotice(host, 'ledger-rotation')
      if (said) pending.push(`[lean-agent] ${said}`)
      // a handover left by the previous desk session is served now: renamed (a later desk must not find it as a fresh one), and named in the first prompt
      // (the button's new desk and the script's new desk start the same way: deskauto.ts deskStartLines adds only "started automatically at <time> because <reason>")
      // a desk left behind by a restart: the new desk's first notice names it once (olddesk.ts); the pane's one line and the doctor row stay until it is archived
      await soft($, 'desk handover', async () => {
        const served = await serveHandover(host, lastSid)
        const old = await oldDeskStep(host, lastSid, 'start').catch(() => null)
        pending.push(...(await deskStartLines(host, lastSid, { served, body: servedBody(), oldDesk: old })).map(l => `[lean-agent] ${l}`))
      })
    }
    // the desk's model and effort pin, when the session's model is already known (else the first request does it)
    if (role.kind === 'desk') {
      promptSeen = false
      await forgetUserChoice(host, deskSession()).catch(() => undefined) // a by-hand choice is kept for one session, never across a restart
      await deskModelCheck($)
    }
    // once per plugin version (desk): learned rules past a size cap, and the 0.45 `rules: off` key nothing reads
    if (role.kind === 'desk') {
      await soft($, 'rules check', async () => {
        const said = await rulesUpdateCheck(host, VERSION)
        if (said.length) pending.push(`[lean-agent] ${said.join('; ')}`)
      })
    }
    // the command is role-free: registered once here
    await $.command.register({ name: 'lean-agent', description: 'Open the lean-agent pane (setup, desk, threads)' }).catch(() => undefined)
    await $.command.register({ name: 'lean-agent-feedback', description: 'Write ONE anonymised feedback export file and print its path; then copy it to the configured folder or ask the user to approve a GitHub issue (config.json feedback.destination); never posts without the Approve card; optional notes as the argument' }).catch(() => undefined)
    await $.command.register({ name: 'lean-agent-restart-desk', description: 'Desk only: write the desk handover and open a new desk session that reads it' }).catch(() => undefined)
    await $.command.register({ name: 'lean-agent-setup', description: 'Set up or repair lean-agent (desk folder, login opener, trust); no model turn needed' }).catch(() => undefined)
    // what the role setup has to say (stale or over-cap rules): `session.start` carries no context, so it goes with the first prompt
    if (ctx.length) pending.push(...ctx)
    return next(e)
  })

  // a subagent ended (also a background one, long after its Agent call returned): its grant and worker slot are released
  on('classic.SubagentStop', async ($, e: any, next) => {
    const id = typeof e?.agent_id === 'string' ? e.agent_id : typeof e?.agentId === 'string' ? e.agentId : ''
    if (id && role.kind === 'thread') {
      const host = hostOf($)
      // a long final answer: sent back ONCE to write its findings to the file and answer with the path (answers.ts); the subagent goes on,
      // so nothing is released yet. A second long answer is let through and counted.
      try {
        const type = String(e?.agent_type ?? e?.agentType ?? '')
        const dir = `${threadsDir(await homeDir(host))}/${role.id}`
        const v = stopAnswer(dir, id, type, e?.last_assistant_message ?? e?.result, await loadAnswerChars(host))
        if (v?.block) return { ...(await next(e)), block: v.block } as any
        if (v?.tooLong) await logRefusal(host, { role: 'worker', rule: ANSWER_RULE, text: `${ANSWER_RULE}: a second answer of ${v.tooLong.chars} characters, let through`, agent: type, tool: 'SubagentStop', thread: role.id, version: VERSION })
      } catch {
        /* the stop goes through as before */
      }
      answersEnd(id)
      orchAgentEnd(id)
      // a worker that ended after the context limit stopped the thread: its result goes into the snapshot's pending list (by script, never acted on)
      if (stopped && typeof (e?.last_assistant_message ?? e?.result) === 'string') await notePending(host, role.id, stopped.sid, { agent: String(e?.agent_type ?? id), text: String(e.last_assistant_message ?? e.result) }).catch(() => false)
      await releaseAgent(host, role, id, { sid: lastSid || undefined, ttlMin: (await loadOrch(host).catch(() => undefined))?.grantTtlMin }).catch(() => undefined)
    }
    return next(e)
  }).catch(($, e: any, next) => next(e))

  // a subagent started: the thread's folder names the file its findings go to (answers.ts). The Agent call's input is never changed; the
  // engine's SubagentStart answer carries the line as context for the subagent.
  on('classic.SubagentStart', async ($, e: any, next) => {
    const r: any = await next(e)
    if (role.kind !== 'thread') return r
    try {
      const host = hostOf($)
      const line = startAgent(`${threadsDir(await homeDir(host))}/${role.id}`, String(e?.agent_id ?? e?.agentId ?? ''), String(e?.agent_type ?? e?.agentType ?? ''))
      if (line) return { ...r, additionalContext: [...(r?.additionalContext ?? []), line] }
    } catch {
      /* the subagent starts without the line; its agent definition says the same */
    }
    return r
  }).catch(($, e: any, next) => next(e))

  // the permission check (the auto mode classifier, a rule) denied a thread's worker Agent call: our guard is a token policy, not a safety
  // boundary, so it must not become a dead end. Recorded on the engine's own evidence only: the PermissionDenied event, or a failed Agent
  // result whose text says the permission check / auto mode classifier denied it. From then on the thread's own edit of the paths that call
  // named in its brief is allowed (orchestrate.ts; the engine's permission check still judges each edit). Never `retry`, no permission changed.
  const deniedSeen = new Set<string>()
  // The desk's model pin against the app choosing again (deskmodel.ts decideSwitch): the app's choice of an expensive model is asked about once per
  // session and then refused, a switch the person made by hand (/model, the picker) is never touched. The decision is the engine's documented
  // PreModelSwitch answer; the engine's `source` cannot tell the app's default from its model menu (both "sdk"), hence the one question.
  on('classic.PreModelSwitch', async ($, e: any, next) => {
    const r: any = await next(e)
    if (role.kind !== 'desk') return r
    const host = hostOf($)
    const d = decideSwitch(e, await deskChoice(host, await homeDir(host)), switchState, isExpensiveModel, promptSeen)
    if (d.user) await noteUserChoice(host, d.user, deskSession())
    if (d.user) switchState.user = d.user
    if (!d.decision) return r
    // The engine cannot tell the app's own choice from the person's click in the app's model menu (both "sdk"), so a switch is only asked about
    // or refused when the user opted in (config desk.blockAppModel: true). Default: let it pass; the pin is put back before the next turn runs.
    const block = ((await readConfig(host, await homeDir(host))) as any)?.desk?.blockAppModel === true
    await noteSdkSwitch(host, String(e?.to_model ?? ''), deskSession(), block && d.decision === 'deny')
    if (!block) return r
    return { ...r, permissionDecision: d.decision, permissionDecisionReason: d.reason }
  }).catch(($, e: any, next) => next(e))
  on('classic.PostModelSwitch', async ($, e: any, next) => {
    if (role.kind === 'desk') noteSwitched(e, switchState)
    return next(e)
  }).catch(($, e: any, next) => next(e))
  on('classic.PermissionDenied', async ($, e: any, next) => {
    await noteDenied($, role, cwd, deniedSeen, e, 'PermissionDenied', String(e?.reason ?? e?.message ?? '')).catch(() => undefined)
    return next(e) // never `retry`
  }).catch(($, e: any, next) => next(e))
  on('classic.PostToolUseFailure', async ($, e: any, next) => {
    const msg = String(e?.error ?? '')
    if (!e?.is_interrupt && classifierDenial(msg)) await noteDenied($, role, cwd, deniedSeen, e, 'failed Agent result', msg).catch(() => undefined) // our own refusals are never evidence (denial.ts)
    return next(e)
  }).catch(($, e: any, next) => next(e))

  // the app moves a pre-started session from a spare folder into the user's folder: the role is decided again
  on('classic.CwdChanged', async ($, e: any, next) => {
    await redetect($, typeof e?.new_cwd === 'string' ? e.new_cwd : undefined)
    return next(e)
  })
  // a lean-agent rule was loaded into context: counted for `stats` (the shell hook in hooks.json logs the same event;
  // rulesStats counts a load seen by both once)
  on('classic.InstructionsLoaded', async ($, e: any, next) => {
    await logRuleLoad(hostOf($), e).catch(() => false)
    if (typeof e?.file_path === 'string') await markNative(hostOf($), e.file_path).catch(() => undefined) // the engine did it: the mod loader will not repeat it
    return next(e)
  })
  // fallback when the hook is not delivered: a cheap compare of the session's directory
  on('turn.start', async ($, e: any, next) => {
    if (!e.agentId) busySince = (await $.clock.now()) || 1
    if (!e.agentId && role.kind === 'thread') orchTurnStart(`${threadsDir(await homeDir(hostOf($)))}/${role.id}`) // the direct reads of a turn (threads.directReads) start at 0
    if (!e.agentId) {
      inTurn = true
      turnStartedAt = busySince
      resetEdited()
    }
    await redetect($)
    await showSkew($)
    if (!e.agentId && role.kind === 'desk') {
      // the old desk's state is kept up (settled when archived); its reminder is the pane's one line, not a line in every turn (olddesk.ts)
      if (!(await retiredInfo(hostOf($), lastSid))) await oldDeskStep(hostOf($), lastSid, 'turn').catch(() => null)
    }
    return next(e)
  })
  on('turn.complete', async ($, e: any, next) => {
    if (!e.agentId) busySince = 0
    if (!e.agentId) inTurn = false
    if (role.kind === 'thread' && !e.agentId && lastSid) {
      const tid = role.id
      await threadEnd(hostOf($), tid, lastTokens, lastSid, () => noteParts($, hostOf($), tid, lastSid), () => lastTextOf($))
    }
    // a thread's turn that died on an API error: if a rate-limit window is spent, keep its reset for the desk's resume
    if (role.kind === 'thread' && !e.agentId && e.reason === 'error') await noteLimit($, role.id).catch(() => undefined)
    // the desk's turn ended: a compaction that was vetoed or failed is tried again at the next desk tick (within 30 s), not 10 minutes
    // later (deskcompact.ts)
    if (role.kind === 'desk' && !e.agentId) {
      deskTurnEnded()
      // config desk.autoRestart (default true): the mod opens the new desk itself, without taking the focus, when the context is over its limit, lean-agent
      // was updated, the model pin failed twice or the desk lost its tools, and nothing blocks it (deskcompact.ts autoRestartDesk)
      const host = hostOf($)
      void (async () => {
        const inApp = await $.session.surfaces().then((ss: readonly string[]) => ss.some(x => x !== 'terminal')).catch(() => false)
        const out = await autoRestartDesk(host, {
          tokens: contextSize(),
          sid: lastSid,
          busy: inTurn,
          inApp,
          skew: await skewNote(host, String($.plugin.root), VERSION).catch(() => null),
          toolsLost: directUnavailable(),
          restart: () => restartDesk(host, { recent: () => recentUser($), sid: () => sessionId($), open: () => openDesk(host, 'desktop', true) }),
          status: text => $.ui.status(text),
          notify: text => $.ui.notify(text, { key: 'lean-desk-autorestart' }),
        })
        if (out !== 'none' && out !== 'off') $.ui.log(`lean-agent: desk auto restart: ${out}`, { to: 'debug' })
      })().catch(() => undefined)
    }
    return next(e)
  })

  // a thread's context size at the end of each main-thread turn (the engine raises session.measure after every turn in which a figure moved,
  // `e.context` is `$.session.usage()`'s context): written to the thread's folder for the desk's restart-at-next-message rule
  // (threadcontext.ts). Observes only; a failed write is no failure (a session with no record is treated as under the limit).
  on('session.measure', async ($, e: any, next) => {
    // the plan windows (rateLimits) are part of the same reading: any session snapshots them to desk/windows.json (windows.ts), also
    // mid-turn. The event carries `$.session.usage()`'s figures; only a thread without a context figure on the event asks usage() itself.
    let usage: any = e
    if (role.kind === 'thread' && typeof e?.context?.tokens !== 'number') usage = await bounded($, Promise.resolve($.session.usage()), 'session.usage').catch(() => null)
    try {
      await recordWindows(hostOf($), usage)
    } catch {
      /* the next reading writes it */
    }
    if (role.kind === 'thread') {
      const id = role.id
      try {
        const host = hostOf($)
        const tokens = usage?.context?.tokens
        const sid = lastSid || String(await bounded($, Promise.resolve($.session.id()), 'session.id').catch(() => ''))
        await recordContext(host, id, sid, tokens)
        lastTokens = typeof tokens === 'number' ? tokens : null
        // the state snapshot and the restart checkpoint belong to a turn END: a measure in the middle of a turn only records the size
        if (!inTurn) await threadEnd(host, id, tokens, sid, () => noteParts($, host, id, sid), () => lastTextOf($))
      } catch {
        /* the size stays unknown */
      }
    }
    return next(e)
  })

  // every model request: refuse past a cap, then price its usage into ledger.jsonl
  on('turn.step', async function* ($, e: any, next) {
    const host = hostOf($)
    const type = e.agentId ? await agentType($, e.agentId, e) : undefined
    const why = await overBudget(host, role.kind, e.agentId ? { type, spent: spent.get(e.agentId) ?? 0 } : null).catch(() => null)
    if (why) return { turnId: e.turnId, index: e.index, answer: why, toolUses: [], stopReason: 'end_turn', usage: null } as any
    if (!e.agentId && role.kind === 'desk' && typeof e.model === 'string') await deskModelCheck($, e.model) // the pin: once per session, then only a change is noted
    const r: any = yield* next(e)
    if (!e.agentId && role.kind === 'desk') noteUsage(r?.usage) // the desk's context size, for its compaction (deskcompact.ts)
    try {
      const fresh = role.kind === 'thread' && !e.agentId && !!lastSid && (await noteBase(host, role.id, lastSid, r?.usage, (await threadToolsArgv(host))[1] ?? '')) // the first request of the session: its real base, and its cost is the session's start (a restart's price)
      const row = await record(host, { role: role.kind, tN: role.kind === 'thread' ? role.id : undefined, agentId: e.agentId, agent: type, ...(role.kind === 'thread' ? { effort: started.effort, tmodel: started.model } : {}), ...(fresh ? { fresh: true as const } : {}) }, r?.usage?.model ?? e.model, r?.usage)
      if (row && e.agentId) spent.set(e.agentId, (spent.get(e.agentId) ?? 0) + row.usd)
    } catch {
      /* a ledger write that fails never stops the turn */
    }
    return r
  })

  registerPane(on, () => role)

  // the desk pane's two companions, opened by its buttons (threadpane.tsx, newthread.tsx): one pane per thread and the new-thread form;
  // any other pane id goes on to the hook that draws it
  on('ui.render', { component: 'Pane' }, async ($, e: any, next) => {
    const tid = threadOfPane(e?.requestId)
    if (tid) return drawThreadPane($, e, tid, () => role)
    if (e?.requestId === NEW_THREAD_PANE) return drawNewThread($, e, () => role)
    return next(e)
  })

  // the tool pool per role: the desk's is cut to what strict mode can allow; config.json `tools.<role>.drop` (globs) on top;
  // lean-agent's own tools stay. Reads the CURRENT role, so a session that becomes the desk later is trimmed from then on.
  on('tool.list', async ($, e: any, next) => {
    const listed: any = await next(e)
    if (Array.isArray(listed)) return await poolFor(hostOf($), listed) // an engine that answers a bare list
    if (!Array.isArray(listed?.value)) return listed
    return { ...listed, value: await poolFor(hostOf($), listed.value) }
  }).catch(($, e: any, next) => next(e))

  // the desk reads only lean-agent's skills: another plugin's skill listing is dead weight there. Every attachment type is
  // noted by name (never its text); a skill listing is trimmed on the desk, whatever it is called, and what happened is recorded.
  on('prompt.attachment', async ($, e: any, next) => {
    const r: any = await next(e)
    const type = String(e?.type ?? '')
    noteAttachment(type)
    if (typeof r?.text !== 'string') return r
    if (role.kind === 'desk' && isMcpInstructions(type)) {
      return { ...r, text: null } // (not the skill stat: that one is the listing's alone)
    }
    if (!isSkillAttachment(type)) return r
    if (role.kind !== 'desk' && !(await threadSkillsLean(hostOf($), role.kind))) {
      skillsSeen(type, `not the desk (role ${role.kind}): untouched`)
      noteCarried(r.text)
      return r
    }
    const t = trimListing(r.text, n => offeredTo(role.kind === 'thread' ? 'thread' : 'desk', n))
    skillsSeen(type, t.reason)
    noteCarried(t.text ?? r.text) // what the model reads: the context breakdown's skills figure is corrected to it (noteParts)
    return t.text === null ? r : { ...r, text: t.text }
  }).catch(($, e: any, next) => next(e))

  // a build may list skills in the Skill tool's description instead: same filter, same safety rule
  on('tool.describe', { tool: 'Skill' }, async ($, e: any, next) => {
    const r: any = await next(e)
    if ((role.kind !== 'desk' && !(await threadSkillsLean(hostOf($), role.kind))) || typeof r?.description !== 'string') return r
    const t = trimListing(r.description, n => offeredTo(role.kind === 'thread' ? 'thread' : 'desk', n))
    if (t.text === null) return r
    skillsSeen('Skill tool description', t.reason)
    return { ...r, description: t.text, breakPromptCache: true }
  }).catch(($, e: any, next) => next(e))

  // a thread's profile (profile.ts): an MCP server outside it is DEFERRED, never removed: its tools stay findable through ToolSearch
  // (a thread that unexpectedly needs one still gets it). lean-agent's own server and every other tool are untouched.
  on('tool.describe', async ($, e: any, next) => {
    const r: any = await next(e)
    if (role.kind !== 'thread' || !r || typeof r !== 'object' || !deferOutside(loaded, String(e?.tool ?? ''))) return r
    return { ...r, isDeferred: true }
  }).catch(($, e: any, next) => next(e))

  // system-prompt sections: noted by id; an MCP-instructions section is left out on the desk
  on('prompt.section', async ($, e: any, next) => {
    const r: any = await next(e)
    const name = String(e?.name ?? '')
    noteSection(name)
    if (role.kind === 'desk' && isMcpInstructions(name) && typeof r?.text === 'string') return { ...r, text: null, breakPromptCache: true }
    return r
  }).catch(($, e: any, next) => next(e))

  // the desk never spawns subagents (no Agent tool in its pool): the agent listing is dead weight there
  on('agent.offer', async ($, e: any, next) => {
    if (role.kind === 'desk') return { isOffered: false }
    return next(e)
  }).catch(($, e: any, next) => next(e))

  // a long Bash result is squeezed after the call; the full text is saved under ~/.lean-agent/output/
  on('tool.call', { tool: 'Bash' }, async ($, e: any, next) => squeezeResult(hostOf($), await next(e)))

  // The desk asks the USER about a thread's remote write (deskactions.ts). The user's answer is read here, from the tool's own RESULT (the
  // engine's AskUserQuestion output: `answers`, question text -> the label chosen): nothing a model writes can stand in for it. Answers
  // in the INPUT are the model's, so a call that carries any is refused. An answer is recorded only for a question that names one pending
  // request with its id, check code and exact text (bindAnswers). Everything else about the call is untouched.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e: any, next) => {
    if (role.kind !== 'desk' || e.agentId) return next(e)
    const given = (v: unknown) => !!v && typeof v === 'object' && Object.keys(v as object).length > 0
    if (given(e.answers) || given(e.annotations)) return { deny: 'lean-agent: answers belong to the user: a desk never fills them in' } as any
    const r: any = await next(e)
    if (r?.deny !== undefined || r?.isError) return r
    const host = hostOf($)
    setThreadSender((sid, text) => $.session.send({ to: { sessionId: sid }, text }))
    try {
      const notes = await bindAnswers(host, e.questions, r?.result?.answers, (thread, text) => leanThread(host, $.plugin.root, { action: 'send', tN: thread, text }).then(() => undefined))
      // the same for the other two human answers: "Let tN edit its worktree itself" (selfedit.ts) and "Save <file> to <folder>?" (deliver.ts)
      notes.push(...(await bindSelfEditAnswers(host, e.questions, r?.result?.answers).catch(() => [])), ...(await bindDeliverAnswers(host, e.questions, r?.result?.answers).catch(() => [])))
      notes.push(...(await bindConfigAnswers(host, e.questions, r?.result?.answers).catch(() => []))) // an Approve of lean_config's own question for a safety-loosening setting (configtool.ts)
      // and an Allow to a grant offer (deskwrites.ts bindOfferAnswers): the user's dialog answer is the written yes; the PR or work item it names becomes the thread's own
      const offer = await bindOfferAnswers(host, e.questions, r?.result?.answers).catch(() => ({ notes: [] as string[], granted: [] as { thread: string; target: undefined }[] }))
      notes.push(...offer.notes)
      for (const g of offer.granted) {
        const line = await ownFromGrant(host, g.thread, g.target).catch(() => null)
        if (line) notes.push(line)
      }
      if (notes.length) return { ...r, context: [...(r.context ?? []), ...notes.map(n => `[lean-agent] ${n}`)] }
    } catch {
      /* the answer is simply not recorded: the pane's Approve / Deny on the card is the other way */
    }
    return r
  })

  on('tool.call', { tool: `mcp__lean-agent__${TOOL}` as const }, async ($, e: any) => {
    if (role.kind !== 'desk') await redetect($, undefined, true)
    if (role.kind !== 'desk') return { result: await roleReport(hostOf($), { tool: e.tool.replace('mcp__lean-agent__', ''), need: 'desk', role, startDir, sid: lastSid }), isError: true } as any
    const host = hostOf($)
    setThreadSender((sid, text) => $.session.send({ to: { sessionId: sid }, text }))
    // a session reads its parent folders' CLAUDE.md BEFORE the mod runs: a stale guide above the threads is cleared before a start
    if (['new', 'start', 'reopen', 'resume', 'wake', 'send', 'restart'].includes(String(e.action))) await guardParents(host).catch(() => [])
    const unused = unusedField(e) // a field the action does not use is refused by name, never dropped silently
    if (unused) return { result: unused, isError: true } as any
    const out = await leanThread(host, $.plugin.root, e)
    await ensureGitHooks(host).catch(() => undefined)
    const sentText = typeof e.text === 'string' ? e.text : typeof e.message === 'string' ? e.message : ''
    if (out.ok && e.action === 'send' && typeof e.tN === 'string' && sentText) await recordAnswer(host, e.tN, sentText).catch(() => undefined)
    return { result: out.text, ...(out.ok ? {} : { isError: true as const }) } as any
  })

  // the user's memory (memory.ts): the desk's tool; scripts decide the scope, refuse secrets and long texts, merge duplicates, cap each scope
  on('tool.call', { tool: `mcp__lean-agent__${MEMORY}` as const }, async ($, e: any) => {
    if (role.kind !== 'desk') await redetect($, undefined, true)
    if (role.kind !== 'desk') return { result: await roleReport(hostOf($), { tool: MEMORY, need: 'desk', role, startDir, sid: lastSid }), isError: true } as any
    const host = hostOf($)
    const out = await memoryTool(host, await homeDir(host), e).catch(err => ({ ok: false, text: `lean_memory failed: ${String((err as Error)?.message ?? err)}` }))
    return { result: out.text, ...(out.ok ? {} : { isError: true as const }) } as any
  })

  // scripts over models: thread and desk (propose is a thread's, decide the desk's; scripts.ts checks per action)
  on('tool.call', { tool: `mcp__lean-agent__${SCRIPT_TOOL}` as const }, async ($, e: any) => {
    const halted = await stopCheck($, e)
    if (halted) return { result: halted.deny, isError: true } as any
    if (role.kind !== 'thread' && role.kind !== 'desk') await redetect($, undefined, true)
    const r = role
    if (r.kind !== 'thread' && r.kind !== 'desk') return { result: await roleReport(hostOf($), { tool: SCRIPT_TOOL, need: 'thread', role: r, startDir, sid: lastSid }), isError: true } as any
    const host = hostOf($)
    const out = await scriptTool(host, r.kind === 'thread' ? { kind: 'thread', id: r.id } : { kind: 'desk' }, e, { startThread: (title, text, project) => leanThread(host, $.plugin.root, { action: 'new', title, text, project }) })
    return { result: out.text, ...(out.ok ? {} : { isError: true as const }) } as any
  })

  // what a thread writes and runs: a scratch script that ran without a proposal is nudged once (prompt.submit); a run of an adopted script counts
  on('tool.call', { tool: 'Write' }, async ($, e: any, next) => {
    const r: any = await next(e)
    if (role.kind === 'thread' && r?.deny === undefined) {
      noteWrite(e.file_path)
      noteEdited(e.file_path) // the snapshot lists the files edited this turn
    }
    return r
  })
  on('tool.call', { tool: 'Edit' }, async ($, e: any, next) => {
    const r: any = await next(e)
    if (role.kind === 'thread' && r?.deny === undefined) noteEdited(e.file_path)
    return r
  })
  // the task list for the state snapshot (snapshot.ts): what the thread wrote with its task tools
  on('tool.call', { tool: 'TodoWrite' }, async ($, e: any, next) => {
    const r: any = await next(e)
    if (role.kind === 'thread' && r?.deny === undefined) noteTasks('TodoWrite', e)
    return r
  })
  on('tool.call', { tool: 'TaskCreate' }, async ($, e: any, next) => {
    const r: any = await next(e)
    if (role.kind === 'thread' && r?.deny === undefined) noteTasks('TaskCreate', e)
    return r
  })
  on('tool.call', { tool: 'TaskUpdate' }, async ($, e: any, next) => {
    const r: any = await next(e)
    if (role.kind === 'thread' && r?.deny === undefined) noteTasks('TaskUpdate', e)
    return r
  })
  on('tool.call', { tool: 'Bash' }, async ($, e: any, next) => {
    let r: any = await next(e)
    const rl = role
    if (rl.kind === 'thread' && r?.deny === undefined && typeof e.command === 'string') {
      try {
        const host = hostOf($)
        noteBash(e.command, leanDir(await homeDir(host)), rl.id)
        // an adopted script ran: counted; a failed run is counted toward needs-update, an edited copy is warned about
        const said = await noteUse(host, e.command, rl.id, bashFailed(r))
        if (said) r = { ...r, context: [...(r.context ?? []), said] }
      } catch {
        /* tracking never stops a command */
      }
    }
    return r
  })

  on('tool.call', { tool: `mcp__lean-agent__${CONFIG}` as const }, async ($, e: any) => {
    if (role.kind !== 'desk') await redetect($, undefined, true)
    if (role.kind !== 'desk') return { result: await roleReport(hostOf($), { tool: CONFIG, need: 'desk', role, startDir, sid: lastSid }), isError: true } as any // a thread or worker never changes settings
    try {
      const o = await configTool(hostOf($), e)
      return { result: o.text, ...(o.ok ? {} : { isError: true as const }) } as any
    } catch (err) {
      return { result: `lean_config: ${String((err as Error)?.message ?? err).slice(0, 200)}`, isError: true } as any
    }
  })

  on('tool.call', { tool: `mcp__lean-agent__${DOCTOR}` as const }, async ($, e: any) => {
    const halted = await stopCheck($, e)
    if (halted) return { result: halted.deny, isError: true } as any
    if (role.kind !== 'desk') await redetect($, undefined, true)
    if (role.kind !== 'desk') return { result: await roleReport(hostOf($), { tool: 'lean_doctor', need: 'desk', role, startDir, sid: lastSid }), isError: true } as any
    const host = hostOf($)
    try {
      await ensureGitHooks(host).catch(() => undefined)
      if (e.action === 'check') return { result: checkReply(await check(host, $.plugin.root), e.verbose === true) } as any
      if (e.action === 'fix') {
        const o = await setupFix(host, $.plugin.root)
        dropSetupCheck()
        // the session's own model too: the pin goes back when it runs another and no by-hand choice is on record for this session
        await deskModelCheck($, '', true)
        const live = await deskModelStatus(host).catch(() => null)
        return { result: setupText(o, true) + (live ? `\ndesk session model: ${live.text}` : '') } as any
      }
      if (e.action === 'migrate') return { result: (await migrate(host, $.plugin.root)).lines.join('\n') } as any
      if (e.action === 'stats') return { result: await statsText(host, { days: e.days, project: typeof e.project === 'string' && e.project ? e.project : undefined }) } as any
      if (e.action === 'handover') {
        const id = typeof e.name === 'string' ? e.name.trim() : ''
        if (!/^t\d+$/.test(id)) return { result: 'handover needs name: a thread id like t3', isError: true } as any
        return { result: await handoverReport(host, await homeDir(host), id) } as any
      }
      if (e.action === 'memory') return { result: await memoryDoctor(host, await homeDir(host)) } as any // per scope: items, tokens, what the last sessions got, over budget (memorydoctor.ts)
      if (e.action === 'compare') {
        const out = await compare(host, $.plugin.root, { project: typeof e.project === 'string' ? e.project : undefined, mode: typeof e.mode === 'string' ? e.mode : undefined }, 'desk')
        return { result: out.text, ...(out.ok ? {} : { isError: true as const }) } as any
      }
      if (e.action === 'export') {
        const o = await exportFeedback(host, $.plugin.root, { notes: typeof e.notes === 'string' ? e.notes : undefined, version: VERSION })
        return { result: o.text, ...(o.ok ? {} : { isError: true as const }) } as any
      }
      if (e.action === 'mcp-env') {
        const home = await homeDir(host)
        if (e.name === undefined && e.value === undefined) {
          const rows = await mcpRows(host, home)
          return { result: rows.length ? rows.join('\n') : 'no MCP server config references an unset variable' } as any
        }
        const o = await setSettingsEnv(host, home, e.name, e.value, e.replace === true)
        if (o.ok) dropSetupCheck()
        return { result: o.text, ...(o.ok ? {} : { isError: true as const }) } as any // the reply never contains the value
      }
      if (e.action === 'overhead' && /^probe\b/.test(String(e.session ?? ''))) return { result: await overheadProbe(host, String($.plugin.root), String(e.session)) } as any
      if (e.action === 'overhead') return { result: await overheadReport(host, String($.plugin.root), { session: typeof e.session === 'string' && e.session ? e.session : undefined, home: await homeDir(host), tools: { desk: [...seenSpecs.values()], thread: [...THREAD_TOOLS, SCRIPT_SPEC, RUN_SPEC] } }) } as any
      if (e.action === 'context') return { result: await contextReport(host, await homeDir(host), typeof e.session === 'string' && e.session ? e.session : undefined) } as any
      if (e.action === 'dismiss-old-desk') {
        const o = await dismissOldDesk(host)
        return { result: o.text, ...(o.ok ? {} : { isError: true as const }) } as any
      }
      if (e.action === 'refusals') return { result: await refusalsText(host, typeof e.days === 'number' ? e.days : undefined) } as any
      return { result: 'doctor: action must be check, fix, migrate, stats, compare, export, mcp-env, dismiss-old-desk or refusals', isError: true } as any
    } catch (err) {
      return { result: `doctor failed: ${String((err as Error)?.message ?? err)}`, isError: true } as any
    }
  })

  on('tool.call', { tool: `mcp__lean-agent__${RUN}` as const }, async ($, e: any) => {
    const halted = await stopCheck($, e)
    if (halted) return { result: halted.deny, isError: true } as any
    if (role.kind !== 'thread') await redetect($, undefined, true)
    if (role.kind !== 'thread') return { result: await roleReport(hostOf($), { tool: RUN, need: 'thread', role, startDir, sid: lastSid }), isError: true } as any
    if (e.context === true && !e.agentId) {
      // what fills this thread's context (the same line as the warn line, contextstat.ts), by script from its own transcript
      const u = Number((await bounded($, Promise.resolve($.session.usage()), 'session.usage').catch(() => null))?.context?.tokens)
      const sid = lastSid || String(await bounded($, Promise.resolve($.session.id()), 'session.id').catch(() => ''))
      const text = await sessionBreakdown(hostOf($), await homeDir(hostOf($)), sid, Number.isFinite(u) ? u : lastTokens, (await threadLimits(hostOf($))).limit)
      return { result: text || 'no transcript found for this session yet' } as any
    }
    if (e.checkpoint !== undefined && !e.agentId) {
      // the thread restarts itself (checkpoint.ts): snapshot, notes check, marker; the desk's timer starts the fresh session with `next` as its last instruction
      const c = e.checkpoint && typeof e.checkpoint === 'object' && !Array.isArray(e.checkpoint) ? e.checkpoint : {}
      const sid = lastSid || String(await bounded($, Promise.resolve($.session.id()), 'session.id').catch(() => ''))
      const u = Number((await bounded($, Promise.resolve($.session.usage()), 'session.usage').catch(() => null))?.context?.tokens)
      const r = await requestCheckpoint(hostOf($), role.id, { sid, next: String(c.next ?? ''), source: 'call', tokens: Number.isFinite(u) ? u : lastTokens ?? undefined, snapshot: { edited: takeEdited(), tasks: currentTasks() } })
      return { result: r.text, ...(r.ok ? {} : { isError: true as const }) } as any
    }
    if (e.pull !== undefined && !e.agentId) {
      // the pull list of a core restart prompt (pull.ts): a section of the reports / notes / brief / snapshot / preflight, never the whole store
      return { result: await pullText(hostOf($), await homeDir(hostOf($)), role.id, String(e.pull), typeof e.section === 'string' ? e.section : '') } as any
    }
    if (e.ci !== undefined) {
      // the read-only CI check (a thread and its workers): argv-only az / gh reads, waits inside the tool
      try {
        if (String(e.command ?? '').trim()) throw new Error('give either command or ci, not both')
        if (!e.ci || typeof e.ci !== 'object' || Array.isArray(e.ci)) throw new Error('ci is an object {host, ...}')
        const r = await runCi(hostOf($), e.ci)
        return { result: r.text, ...(r.failed ? { isError: true as const } : {}) } as any
      } catch (err) {
        const why = `lean_run refused: ${String((err as Error)?.message ?? err)}`
        await logRefusal(hostOf($), { role: 'thread', rule: 'run-refused', text: why, tool: RUN, thread: role.id, version: VERSION })
        return { result: why, isError: true } as any
      }
    }
    if (e.get !== undefined) {
      // a forge READ by the mod (a thread and its workers): GET only, the Azure token on curl's stdin, never in a shell
      try {
        if (String(e.command ?? '').trim() || e.ci !== undefined) throw new Error('give one of command, ci or get')
        if (!e.get || typeof e.get !== 'object' || Array.isArray(e.get)) throw new Error('get is an object {host, ...}')
        const r = await runGet(hostOf($), e.get)
        return { result: r.text } as any
      } catch (err) {
        const why = `lean_run refused: ${String((err as Error)?.message ?? err)}`
        await logRefusal(hostOf($), { role: 'thread', rule: 'run-refused', text: why, tool: RUN, thread: role.id, version: VERSION })
        return { result: why, isError: true } as any
      }
    }
    if (e['pr-guide'] !== undefined && e['pr-guide'] !== false) {
      // the repo's PR guidelines (template, title pattern, owners) by script, and the lint of a PR text: read-only (prguide.ts, prchecks.ts)
      try {
        if (String(e.command ?? '').trim() || e.ci !== undefined || e.get !== undefined) throw new Error('give one of command, ci, get, pr-guide or pr-changes')
        return { result: await runPrGuide(hostOf($), role.id, e['pr-guide'], e.cwd) } as any
      } catch (err) {
        const why = `lean_run refused: ${String((err as Error)?.message ?? err)}`
        await logRefusal(hostOf($), { role: 'thread', rule: 'run-refused', text: why, tool: RUN, thread: role.id, version: VERSION })
        return { result: why, isError: true } as any
      }
    }
    if (e['pr-changes'] !== undefined) {
      // the changed files of a PR with their added / removed line ranges, by script from the forge's own diff (no checkout, no git ref)
      try {
        if (String(e.command ?? '').trim() || e.ci !== undefined || e.get !== undefined) throw new Error('give one of command, ci, get or pr-changes')
        return { result: await runPrChanges(hostOf($), role.id, e['pr-changes']) } as any
      } catch (err) {
        const why = `lean_run refused: ${String((err as Error)?.message ?? err)}`
        await logRefusal(hostOf($), { role: 'thread', rule: 'run-refused', text: why, tool: RUN, thread: role.id, version: VERSION })
        return { result: why, isError: true } as any
      }
    }
    if (e.agentId) return { result: "lean_run is the thread's own tool: a worker runs its one step with its own tools", isError: true } as any
    try {
      const home = await homeDir(hostOf($))
      const r = await runSummary(hostOf($), { command: String(e.command ?? ''), cwd: typeof e.cwd === 'string' && e.cwd ? e.cwd : undefined, home })
      await noteRun(hostOf($), role.id, typeof e.cwd === 'string' ? e.cwd : '', r.exit, r.body.split('\n')[0] ?? '') // the commit this run was on (a PR without a green run opens as a draft)
      return { result: runText(r), ...(r.exit === 0 ? {} : { isError: true as const }) } as any
    } catch (err) {
      const why = `lean_run refused: ${String((err as Error)?.message ?? err)}`
      await logRefusal(hostOf($), { role: 'thread', rule: 'run-refused', text: why, tool: RUN, thread: role.id, version: VERSION })
      return { result: why, isError: true } as any
    }
  })

  for (const t of THREAD_TOOLS) {
    on('tool.call', { tool: `mcp__lean-agent__${t.name}` as const }, async ($, e: any) => {
      if (role.kind === 'thread') await touchActivity(hostOf($), await homeDir(hostOf($)), role.id, t.name === 'lean_report' ? 'report' : 'tool', t.name === 'lean_report')
      const halted = await stopCheck($, e)
      if (halted) return { result: halted.deny, isError: true } as any
      if (role.kind !== 'thread') await redetect($, undefined, true) // a stale role never refuses: look once more (session id, folder)
      if (role.kind !== 'thread') return { result: await roleReport(hostOf($), { tool: t.name, need: 'thread', role, startDir, sid: lastSid }), isError: true } as any
      // a review thread's done report needs a lean_review record of the sha it reviewed; the evidence is appended from the store (reviewevidence.ts)
      const gate = t.name === 'lean_report' && typeof e.text === 'string' && !e.agentId ? await reviewReport(hostOf($), role.id, String(e.state ?? ''), e.text).catch(() => null) : null
      if (gate && !gate.ok) {
        await logRefusal(hostOf($), { role: 'thread', rule: 'review-report-gate', text: gate.text.split('\n')[0]!.slice(0, 200), tool: t.name, thread: role.id, version: VERSION })
        return { result: gate.text, isError: true } as any
      }
      const gated = gate ? { ...e, text: gate.text } : e
      // lean_compare needs the plugin root (the thread-shaped folder's CLAUDE.md, --plugin-dir for a dev copy): answered here
      const out = t.name === 'lean_compare'
        ? await compare(hostOf($), $.plugin.root, { project: str(e.project) || str((await readJson<{ project?: string }>(hostOf($), `${threadsDir(await homeDir(hostOf($)))}/${role.id}/thread.json`, {})).project), mode: str(e.mode) || 'task', task: typeof e.task === 'string' ? e.task : '', model: str(e.model) || undefined, maxUsd: typeof e.maxUsd === 'number' ? e.maxUsd : undefined }, 'thread', role.id)
        // every other tool: a done / blocked report and every question also goes straight to the desk's session (the inbox keeps it either way)
        : await threadTool(hostOf($), role.id, t.name, gated, (sid, text) => $.session.send({ to: { sessionId: sid }, text }))
      await ensureGitHooks(hostOf($)).catch(() => undefined) // lean_* tools may change projects.json
      // a thread that reports done is asked once per session whether a step could have been a script (never a worker's call)
      const ask = t.name === 'lean_report' && out.ok && e.state === 'done' && !e.agentId ? doneQuestion(role.id) : null
      // a report that asks the desk for a restart is one: the mod makes the checkpoint restart itself (checkpoint.ts; the desk gets one line when it is done)
      let cp = ''
      if (t.name === 'lean_report' && out.ok && !e.agentId && e.state !== 'done' && e.state !== 'blocked' && asksRestart(e.text) && !String(e.text).trim().endsWith('?')) {
        const sid = lastSid || String(await bounded($, Promise.resolve($.session.id()), 'session.id').catch(() => ''))
        const r = await requestCheckpoint(hostOf($), role.id, { sid, next: announcedNext(String(e.text)) ?? 'continue your task from scratch/notes.md and your last report', source: 'report', tokens: lastTokens ?? undefined, snapshot: { edited: takeEdited(), tasks: currentTasks() } })
        cp = r.text
      }
      return { result: [out.text, ask, cp].filter(Boolean).join('\n'), ...(out.ok ? {} : { isError: true as const }) } as any
    })
  }

  // desk: a thread's direct message (this plugin's own `$.session.send`) arrived, so its inbox row is delivered and the next prompt
  // does not hand it over again. Everything is passed on unchanged.
  on('session.receive', async ($, e: any, next) => {
    if (role.kind === 'desk' && e?.origin?.plugin === 'lean-agent' && typeof e.text === 'string') await markDelivered(hostOf($), e.text).catch(() => false)
    // thread: the desk's direct message arrived (deliver-to-thread.ts): its inbox lines are handed over (the mark in the text), and the arrival is activity
    // (the desk's check "did it start a turn?" reads activity.json)
    if (role.kind === 'thread' && typeof e?.text === 'string' && e.text.startsWith('[lean-agent] message from the desk')) {
      const host = hostOf($)
      await consumeWake(host, role.id, e.text).catch(() => false)
      await touchActivity(host, await homeDir(host), role.id, 'prompt', true)
    }
    return next(e)
  }).catch(($, e: any, next) => next(e))

  // every tool: guards first (fail closed), then delivery of queued messages to a busy session
  on('tool.call', async ($, e: any, next) => {
    const host = hostOf($)
    if (role.kind === 'thread') await touchActivity(host, await homeDir(host), role.id, e.agentId ? 'worker' : 'tool') // the stall watchdog's clock (stall.ts): the thread's or a worker's tool call
    const halted = await stopCheck($, e)
    if (halted) return { deny: halted.deny } as any
    const atype = await agentType($, e.agentId, e)
    const gctx = { role, cwd, agentType: atype, agentId: e.agentId, version: VERSION, root: String($.plugin.root ?? '') }
    const rname = atype || e.agentId ? 'worker' : role.kind // the role field of every refusal / missing-tool record
    const why = await decide(host, gctx, e)
    if (why) {
      await logRefusal(host, { role: rname, rule: ruleOf(why, atype ?? ''), text: why, agent: atype, tool: e.tool, thread: role.kind === 'thread' ? role.id : undefined, version: VERSION }) // for the feedback export (feedback.ts: the one writer)
      return { deny: why } as any
    }
    const octx: OCtx | null = role.kind === 'plain' ? null : { kind: role.kind, agentType: atype, agentId: e.agentId, home: await homeDir(host), threadDir: role.kind === 'thread' ? `${threadsDir(await homeDir(host))}/${role.id}` : undefined, cwd }
    // the thread's own work let through by a fallback: after a denied worker call (`delegation-denied`) or under the user's grant (`self-edit-grant`): counted
    if (octx && role.kind === 'thread' && !e.agentId && ['Edit', 'Write', 'NotebookEdit', 'Read', 'Grep', 'Glob'].includes(String(e.tool))) {
      const via = fallbackUsed({ ...octx, selfEdit: await selfEditRoots(host, role.id).catch(() => []) }, e)
      if (via === 'self-edit-grant') await logRefusal(host, { role: 'thread', rule: via, text: `${via}: the thread's own ${e.tool} inside a worktree the user let it edit itself; the permission check still judges it`, tool: e.tool, thread: role.id, version: VERSION }).catch(() => undefined) // (the denied fallback is one row per denial, written when it was denied)
    }
    // the thread's grants for the worker it spawns: recorded when the Agent call starts, bound to the subagent, released when the SUBAGENT ends
    // (a background launch returns at once; a foreground call is released at return)
    const g = role.kind === 'thread' && !e.agentId && (e.tool === 'Agent' || e.tool === 'Task') ? parseGrants(e.prompt) : null
    const gcall = g && hasGrants(g) ? String(e.toolUseId ?? `g${++grantSeq}`) : ''
    if (role.kind === 'thread' && !e.agentId && (e.tool === 'Agent' || e.tool === 'Task') && typeof e.subagent_type === 'string') noteAgentCall(`${threadsDir(await homeDir(host))}/${role.id}`, e.subagent_type, jobOf(e.prompt)) // pairs with the SubagentStart that follows (answers.ts)
    const gopts = { sid: lastSid || undefined, ttlMin: (await loadOrch(host).catch(() => undefined))?.grantTtlMin }
    if (gcall) {
      try {
        await recordGrant(host, role, gcall, typeof e.subagent_type === 'string' ? e.subagent_type : undefined, g!, gopts)
      } catch (err) {
        if (octx) orchEnd(octx, e) // the slot the guard counted is free again: the call never ran
        throw err
      }
    }
    // a call's input is NEVER changed here (auto mode rejects a call whose input a hook changed after it reviewed it): the foreground is
    // asked for in the agent descriptions and the briefs (run_in_background: false); a background worker's result is cut when it arrives
    const audited = role.kind === 'thread' && !e.agentId && isAuditorCall(e)
    let r: any
    let launch: { async: boolean; agentId?: string } | undefined
    try {
      r = await next(e)
      launch = e.tool === 'Agent' || e.tool === 'Task' ? launchOf(r, texts(r?.result).join('\n')) : undefined
    } catch (err) {
      await noteMissingTool(host, gctx, rname, e, String((err as Error)?.message ?? err)) // a tool the session or worker does not have
      if (role.kind === 'thread' && !e.agentId && (e.tool === 'Agent' || e.tool === 'Task') && classifierDenial(String((err as Error)?.message ?? err))) await noteDenied($, role, cwd, deniedSeen, { tool_name: e.tool, tool_use_id: e.toolUseId, tool_input: { subagent_type: e.subagent_type, prompt: e.prompt } }, 'Agent call error', String((err as Error)?.message ?? err)).catch(() => undefined)
      throw err
    } finally {
      if (gcall) await releaseGrant(host, role, gcall, { ...gopts, async: launch?.async, agentId: launch?.agentId }).catch(() => undefined)
      if (octx) orchEnd(octx, e, launch) // a worker's slot (threads.workers) is free again, a background worker's when it ends
    }
    // the worker RAN (a real result, or a background launch accepted): one try of this brief is used; a denied, rejected or errored call uses none
    if (octx && !e.agentId && r?.deny === undefined && !r?.isError && !r?.result?.isError) {
      // the run record (workerruns.ts: stats by tier and job, the haiku record of a project); written before orchRan counts this try
      if (role.kind === 'thread' && isSmall(typeof e.subagent_type === 'string' ? e.subagent_type : '') && !launch?.async) await recordWorkerCall(host, { thread: role.id, project: await threadProject(host).catch(() => ''), agent: String(e.subagent_type), job: jobOf(e.prompt), text: texts(r?.result).join('\n'), retried: retryCount(role.id, e.prompt) >= 1 }).catch(() => undefined)
      orchRan(octx, e)
    }
    if (r?.isError || r?.result?.isError) await noteMissingTool(host, gctx, rname, e, texts(r?.result).join(' ')) // the tool failure: not available / not connected
    // the classifier's denial arrives as the Agent call's own error result: the thread's own work in its worktrees is allowed from now on (denial.ts)
    if (role.kind === 'thread' && !e.agentId && (e.tool === 'Agent' || e.tool === 'Task') && (r?.isError || r?.result?.isError)) {
      const said = texts(r?.result).join('\n')
      if (classifierDenial(said)) await noteDenied($, role, cwd, deniedSeen, { tool_name: e.tool, tool_use_id: e.toolUseId, tool_input: { subagent_type: e.subagent_type, prompt: e.prompt } }, 'Agent call result', said).catch(() => undefined)
    }
    if (role.kind === 'thread' && !e.agentId && (e.tool === 'Agent' || e.tool === 'Task') && r?.deny === undefined) await noteWorkerLines(host, role.id, atype, e, texts(r?.result).join('\n')) // `split:` / `missing:` / `refused:` answers
    // the reviewer's JSON block is saved to scratch/review-<area>-<pass>.json before anything cuts the result: a restart of the thread keeps it (reviewsave.ts)
    if (role.kind === 'thread' && !e.agentId && (e.tool === 'Agent' || e.tool === 'Task') && /(^|:)reviewer$/.test(String(e.subagent_type ?? '')) && r?.deny === undefined && !launch?.async) await saveReviewerBlock(host, role.id, String(e.prompt ?? ''), texts(r?.result).join('\n')).catch(() => undefined)
    await feedbackOf(host, e, r).catch(() => undefined)
    // a worker brief over 1500 characters while the thread has notes / scratch files: one soft hint, point at the file (briefsize.ts)
    if (role.kind === 'thread' && !e.agentId && (e.tool === 'Agent' || e.tool === 'Task') && r?.deny === undefined && octx?.threadDir && isSmall(typeof e.subagent_type === 'string' ? e.subagent_type : '')) {
      const hint = await briefHint(host, String(e.prompt ?? ''), octx.threadDir).catch(() => null)
      if (hint) r = { ...r, context: [...(r?.context ?? []), hint] }
    }
    // execution model: the desk's results and a worker's Agent result are cut (head + tail, the full text a file), config deskToolResultChars / agentResultChars
    if (octx && r?.deny === undefined && !e.agentId && !launch?.async) { // (an async launch has no report to cut yet)
      const oc = await loadOrch(host).catch(() => ({ on: false, deskChars: 0, agentChars: 0 }))
      if (oc.on && role.kind === 'desk') r = await capTo(host, 'desk', r, oc.deskChars).catch(() => r)
      else if (oc.on && role.kind === 'thread' && (e.tool === 'Agent' || e.tool === 'Task') && isSmall(typeof e.subagent_type === 'string' ? e.subagent_type : '')) {
        const untrimmed = r
        r = jobResult(r, jobOf(e.prompt)) // the result is cut to its job's schema (jobs.ts), then to agentChars
        if (r !== untrimmed) await logRefusal(host, { role: 'worker', rule: 'result-trimmed', text: `worker result outside the ${jobOf(e.prompt)} schema, trimmed`, agent: atype ?? String(e.subagent_type ?? ''), tool: e.tool, thread: role.id, version: VERSION }) // counted in the feedback export
        r = await capTo(host, role.id, r, oc.agentChars).catch(() => r)
      }
    }
    // an oversized Bash or MCP result of a thread's main loop is cut before it enters the conversation (cap.ts); the full text is a file
    // (a worker's MCP result too: it is the worker's context that it would fill)
    if (role.kind === 'thread' && (!e.agentId || String(e.tool ?? '').startsWith('mcp__')) && r?.deny === undefined) r = await capResult(host, role.id, String(e.tool ?? ''), r, { worker: !!e.agentId, command: typeof e.command === 'string' ? e.command : undefined }).catch(() => r)
    // a script auditor's LEAN-AUDIT line: the mod records the verdict (and tells the thread what the rules made of it)
    if (audited && role.kind === 'thread' && r?.deny === undefined) {
      const reply = texts(r?.result).join('\n')
      await markAuditStarted(host, role.id, String(e.prompt ?? '')).catch(() => false) // the call went through (not denied): an audit of this text is under way (record-audit needs it)
      const said = await auditFromReply(host, role.id, reply, String(e.prompt ?? '')).catch(() => null)
      // (a call that came back as "Async agent launched": say that no verdict was recorded yet)
      const lost = !said && /async agent launched/i.test(reply) ? AUDIT_ASYNC_NOTE : ''
      const notes = [...(said ? [said] : []), ...(lost ? [lost] : [])]
      if (notes.length) r = { ...r, context: [...(r.context ?? []), ...notes] }
    }
    // the thread's usage counter: which MCP servers and skills it really called (names and counts, never arguments); a worker's
    // call counts for the thread. This is what a project profile is learned from.
    if (role.kind === 'thread' && r?.deny === undefined) await noteToolUse(host, role.id, String(e.tool ?? ''), e).catch(() => false)
    // a thread that reported blocked with an approval and now calls a tool has carried on: its "needs your yes" card ends (approvals.ts)
    if (role.kind === 'thread' && !e.agentId) await noteCall(host, role.id, String(e.tool ?? '')).catch(() => false)
    // learned rules for a thread and its subagents: the engine loads them only beneath the session root, so the mod appends the rules
    // whose `paths:` match the files this call touches, once per context (ruleload.ts)
    if (role.kind === 'thread' && r?.deny === undefined) {
      try {
        const text = await ruleContext(host, { session: lastSid, agent: typeof e.agentId === 'string' ? e.agentId : '', thread: role.id }, String(e.tool ?? ''), e, { threadProject: await threadProject(host), engineRoot: seenRoot, cwd: typeof e.cwd === 'string' && e.cwd ? e.cwd : cwd, repoCounts: /^(lean-agent:)?reviewer$/.test(atype ?? '') })
        if (text) r = { ...r, context: [...(r?.context ?? []), text] }
      } catch {
        /* rules are optional: the tool result goes through unchanged */
      }
    }
    // a small worker at 75% of its step budget: its next tool result says how many calls are left (orchestrate.ts takeStepNote)
    if (e.agentId && r?.deny === undefined && isSmall(atype)) {
      const left = takeStepNote(e.agentId)
      if (left) r = { ...r, context: [...(r?.context ?? []), left] }
    }
    // (below, for the main loop only: the queued messages / reports)
    if (e.agentId || r?.deny !== undefined) return r
    const lines: string[] = []
    try {
      const batch = role.kind === 'thread' ? await takeBatch(host, role.id) : role.kind === 'desk' ? await takeReports(host) : null
      if (batch) lines.push(batch)
      const hint = octx?.threadDir ? takeDeniedHint(octx.threadDir) : null // a worker call was denied by the permission check: said once
      if (hint) lines.push(hint)
      const slices = octx?.threadDir ? takeSliceNote(octx.threadDir) : null // the 11th fallback slice of a denied reader: "you are reading a long source yourself"
      if (slices) lines.push(slices)
      const warn = await warnNote($, host, texts(r?.result).join('').length) // the context is at the warn level: ONE line per session, "write what you have learned to scratch/notes.md" (scratchnotes.ts)
      if (warn) lines.push(warn)
      // a rule with a trigger (a commit, a finished step, a push, a PR opened): one line with its output path, at most one per turn (memoryindex.ts)
      const trig = (r as any)?.isError === true ? null : await triggerOnTool(host, role, String(e.tool ?? ''), e).catch(() => null)
      if (trig) lines.push(trig)
    } catch {
      /* delivery is retried at the next call */
    }
    return lines.length ? { ...r, context: [...(r.context ?? []), ...lines] } : r
  }).catch(($, e: any, next) => (next.called ? next(e) : { deny: 'lean-agent guard failed' }))

  // memory: the project's saved facts as a short session section for a thread and its workers
  on('prompt.compose', async ($, e: any, next) => {
    const r: any = await next(e)
    try {
      const text = await memorySection(hostOf($), role)
      const sections = [...(text ? [{ id: 'lean-agent:memory', text, scope: 'session' }] : []), ...(role.kind === 'thread' && rulesSection ? [{ id: 'lean-agent:rules', text: rulesSection, scope: 'session' }] : []), ...(skew ? [{ id: 'lean-agent:skew', text: `[lean-agent] ${skew}`, scope: 'session' }] : [])]
      if (sections.length && r?.sections) return { ...r, sections: [...r.sections, ...sections] }
    } catch {
      /* the prompt goes out without it */
    }
    return r
  })

  // handoff notes before a compaction (threads and desk), so Resume/Start can rebuild from notes.md
  on('session.compact', async ($, e: any, next) => {
    try {
      if (!e.agentId) await writeCompactNotes(hostOf($), role, e.messages ?? [])
    } catch {
      /* compaction goes on without notes */
    }
    const res: any = await next(e)
    const went = !(res && res.skip !== undefined) // the compaction went ahead (a veto or skip says so on the result)
    if (!e.agentId && went) forgetContext() // compacted: the context size is read again at the next request
    // the rule text a thread was given is summarised away: it may be given again (its `_project.md` is a prompt section and stays);
    // only when the compaction really went ahead (a skipped one keeps the text in context: giving it again would be a duplicate)
    if (role.kind === 'thread' && went) await resetContext(hostOf($), typeof e.agentId === 'string' ? e.agentId : '', await threadProject(hostOf($)).catch(() => '')).catch(() => undefined)
    return res
  })

  on('prompt.submit', async ($, e: any, next) => {
    const host = hostOf($)
    await redetect($)
    // a desk that a newer one replaced (desk.json names the other session) answers with one line and acts on nothing: no pin, no reports taken (deskauto.ts)
    if (role.kind === 'desk' && !e.agentId) {
      const gone = await retiredInfo(host, lastSid)
      if (gone) return next({ ...e, context: [...(e.context ?? []), retiredLine(gone)] })
    }
    if (role.kind === 'desk') {
      await deskModelCheck($, '', true) // the pin holds before the turn runs (deskmodel.ts)
      promptSeen = true // a switch after this point (command / picker) is the person's own and is kept for the session
      // the user's own typed words (the engine's origin 'composer' / 'bridge', never an injected prompt): what an advance accept rests on (humanprompts.ts)
      // (and the user's own "stop writes" / "revoke" takes the written approvals back, deskwrites.ts)
      const inApp = await $.session.surfaces().then((ss: readonly string[]) => ss.some(x => x !== 'terminal')).catch(() => false) // the desktop app's typed turn is origin 'sdk'
      if (!e.agentId && (await recordHumanPrompt(host, e, inApp).catch(() => false))) { await revokeByWords(host, e.text).catch(() => undefined); await withdrawByWords(host, e.text, (thread, text) => leanThread(host, $.plugin.root, { action: 'send', tN: thread, text }).then(() => undefined)).catch(() => undefined); await revokeSelfEditByWords(host, e.text).catch(() => undefined) }
    }
    // the user's own typed words that are a standing order (memorycapture.ts): remembered by script, one notice line; a candidate is shown once
    if ((role.kind === 'desk' || role.kind === 'thread') && !e.agentId) {
      const inApp = await $.session.surfaces().then((ss: readonly string[]) => ss.some(x => x !== 'terminal')).catch(() => false)
      pending.push(...(await memoryOnPrompt(host, e, role, inApp).catch(() => [] as string[])))
    }
    let extra: string | null = pending.length ? pending.splice(0).join('\n') : null
    try {
      let more: string | null = null
      if (role.kind === 'thread') await touchActivity(host, await homeDir(host), role.id, 'prompt', true)
      if (role.kind === 'thread') more = (await consumeWake(host, role.id, e.text)) ? null : await takeBatch(host, role.id)
      else if (role.kind === 'desk') {
        more = await takeReports(host)
        const stalled = await stallLines(host).catch(() => null) // a thread that stalled: one reminder line per desk turn while it lasts
        if (stalled) more = more ? `${more}\n${stalled}` : stalled
        const held = await holdLines(host).catch(() => null) // a covered reply waiting in its hold window (the exact text), a send held by a newer instruction (sendhold.ts)
        if (held) more = more ? `${more}\n${held}` : held
        const lim = limitLineOnce() // the desk reached its limit: its reply starts with one line saying so, once (deskcompact.ts)
        if (lim) more = more ? `${more}\n${lim}` : lim
        const tip = await takeTip(host, e.text).catch(() => null) // a coaching tip: the table in intents.ts decides, at most one line, never blocks
        if (tip) more = more ? `${more}\n${tip}` : tip
      }
      if (more) extra = extra ? `${extra}\n${more}` : more
      // memory by script (memoryindex.ts): a keyword trigger, and at most 3 items that match this prompt or brief and are not in the standing orders
      if ((role.kind === 'desk' || role.kind === 'thread') && !e.agentId) {
        const rel = await relevantOnPrompt(host, role, `${e.text ?? ''}\n${more ?? ''}`).catch(() => null)
        if (rel) extra = extra ? `${extra}\n${rel}` : rel
      }
      const nudge = role.kind === 'thread' ? await takeNudges(host) : null
      if (nudge) extra = extra ? `${extra}\n${nudge}` : nudge
    } catch {
      /* the prompt goes through without it */
    }
    return next(extra ? { ...e, context: [...(e.context ?? []), extra] } : e)
  })
}
