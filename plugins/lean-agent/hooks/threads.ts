import { writeApproval } from './reviews'
import { deskPush } from './push'
import type { PrInput } from './push'
import { appendJsonl, atomicWrite, homeDir, leanDir, mkdirp, readJson, readJsonl, realPath, threadsDir, writeJson } from './state'
import type { Host } from './state'
import { deskState, goalsLocked, unconsumed, wakeMark } from './delivery'
import type { DeskRec } from './delivery'
import { projectsAction, unknownProject } from './projects'
import { settingsKeys, threadChoice } from './models'
import type { Choice } from './models'
import { addRequest, dropRequests, familyOf, isExpensiveModel, modelAllowed, revokeModelApprovals } from './expensive'
import { actionListText, approveAction, dropActions, dropGrants } from './deskactions'
import { allowWrites, askWrites, dropWriteGrants, revokeWrites, writesListText } from './deskwrites'
import { noteBrief, ownFromGrant, recordPassedPr } from './ownpr'
import { allowSelfEdit, dropSelfEditGrants, revokeSelfEdit, userWordsFor } from './selfedit'
import { deliver } from './deliver'
import { denialRec } from './denial'
import { agentsText } from './guard'
import { ensureGitHooks, gitEnv } from './githooks'
import { threadEnv, writeThreadSettings } from './mcpenv'
import { RESTARTING_TEXT, hardStopped, isRestarting } from './contextstop'
import { INSTR_LEAD, buildHandover, instrBlock, olderVersion, pluginVersion, resumeLead, taskOf } from './handover'
import { ENDED_AT_ONCE, endedAtOnce, isStuck, lastActivity, liveOf, nameProblem, removeSession, requestsOf, sessionName, staleWorking, stallConfig, threadsConfig, truthOf } from './threadstate'
import type { Truth } from './threadstate'
import { priceOf } from './budget'
import { installedVersion, runningOf, threadSkew } from './skew'
import { LIMIT_PROMPT, isLimitRow, readLimit, usable } from './limits'
import { doneSession, finishedText } from './finish'
import { disabledPlugins, fillProfile, loadedLine, loadedText, nameOk, names, profileText, readLoaded, readProfile, removeProfile, resolveLoaded, startUsage, writeLoaded, writeProfile } from './profile'
import type { Loaded } from './profile'
import { slugOk } from './rules'
import { newOrReview } from './reviewkind'
import { dismissAction } from './dismiss'
import { loadView } from './view'
import { threadToolsArgv } from './orchestrate'
import { threadSpendLine } from './stats'
import { baseLine, readBase } from './base'
import { readParts } from './ctxparts'
import { briefLint, freeText, lintRoots } from './briefsize'
import { ctxOf, decide, keepText, notKeepText, overText, readContext, resumedText, threadLimits } from './threadcontext'
import { askText, findText, reportText } from './threadask'
import { holdWarning } from './windows'
import { briefLintLine, isForgeWrite } from './forgewrite'
import { threadSettings as leanThreadSettings } from './leantools'

export const WAKE_GAP_MS = 30_000

export type ThreadState = 'open' | 'parked' | 'closing' | 'closed'
export type Thread = {
  id: string
  title: string
  project: string
  state: ThreadState
  sid: string // the background session's id, empty until started
  sids?: string[] // every session id that was resolved as this thread (mod reload, compaction, resume): the mod appends
  created: number
  lastWake: number // ms of the last start/wake, 0 = never
  delivered: number // inbox.jsonl lines already handed to the session
  model?: string // haiku | sonnet | opus, as started (a resume keeps the session's saved options)
  effort?: string // low | medium | high
  needs?: string[] // MCP servers / plugins this thread asked for on top of its project's profile (profile.ts)
  lastGoal?: string // the goal a close cleared (a reopen's handover names it)
  version?: string // the lean-agent version the DESK saw installed when the session was last started or resumed (what the session really runs is `running`)
  running?: { version: string; sid: string; at: number } // written by the session's own mod at its start: the code it runs (skew.ts runningOf)
  finished?: number // ms the session was finished after a done report (finish.ts): the next send, wake or resume starts a NEW session with the handover
  keep?: boolean // keep mode (threadcontext.ts): after a done report the session is RESUMED for follow-ups until its context passes the limit
  gen?: number // how many sessions this thread has had (1 = the first): the name of the session is "tN · title", "tN · title (2)" ... (threadstate.ts sessionName)
  req0?: number // the thread's request count in the ledger when its session was started or woken: a session that ended its turn at once added at most two
  checkpoints?: number // 1.0.6 only (context checkpoints were removed): still readable, nothing writes it
  lastCheckpoint?: number // 1.0.6 only
}
export type Inbox = { ts: number; text: string; from?: string; instr?: boolean /* the text of a restart / reopen / start / wake / resume: the LAST part of the first prompt (handover.ts) */ }

// ---- `claude agents --json [--all]` -------------------------------------------------------------------------
// Fields used (Claude Code 2.1.x prints an array): sessionId, name, cwd, status ("idle" | "busy" | ...), startedAt (ms),
// kind, pid. Tolerated: a wrapper object ({agents|sessions|items: [...]}), snake_case ids (session_id, id), stray
// non-object entries, damaged JSON (-> []).
// state: what `claude agents` calls the session's state (working | done | stopped | blocked ...); waitingFor: set while the session waits
// for something nobody gave it (a permission prompt); model: the session's model when listed
export type AgentRow = { sid: string; name: string; cwd: string; status: string; startedAt: number; pid: number; id: string; state: string; waitingFor: string; model?: string; kind?: string; archived?: boolean }
// (kind, lower-cased: "background" for a `claude --bg` session; archived: only set when the listing says so)

export function parseAgents(text: string): AgentRow[] {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return []
  }
  const list = Array.isArray(v) ? v : v && typeof v === 'object' ? ((v as any).agents ?? (v as any).sessions ?? (v as any).items) : null
  if (!Array.isArray(list)) return []
  const out: AgentRow[] = []
  for (const r of list) {
    if (!r || typeof r !== 'object') continue
    const sid = String(r.sessionId ?? r.session_id ?? r.id ?? '')
    if (!sid) continue
    out.push({
      sid,
      name: String(r.name ?? ''),
      cwd: String(r.cwd ?? ''),
      status: String(r.status ?? r.state ?? '').toLowerCase(),
      startedAt: Number(r.startedAt ?? r.started_at ?? 0) || 0,
      pid: Number(r.pid) || 0, // a listed process: set while the background process is alive, absent once it exited
      id: String(r.id ?? ''),
      state: String(r.state ?? '').toLowerCase(),
      waitingFor: r.waitingFor == null || r.waitingFor === false ? '' : typeof r.waitingFor === 'string' ? r.waitingFor : JSON.stringify(r.waitingFor).slice(0, 120),
      ...(typeof r.model === 'string' && r.model ? { model: r.model } : {}),
      ...(typeof r.kind === 'string' && r.kind ? { kind: r.kind.toLowerCase() } : {}),
      ...(r.archived === true ? { archived: true } : {}),
    })
  }
  return out
}

// `state` (working | idle | done ...) says what the session is doing, `status` is the older word; threadstate.ts liveOf reads them. Only an
// idle or done session is "no live work": anything else (busy, running, waiting, an unknown word) counts as running, so an uncertain
// session is never resumed (a resume of a running session forks it).
export const isRunning = (r: AgentRow | undefined) => !!r && liveOf(r) === 'working'
// working = busy or reported working: nothing may close, stop or replace it
export const isWorking = (r: AgentRow | undefined) => isRunning(r) || r?.state === 'working'
// waiting on a prompt nobody answers (a background session cannot): the user has to open it in the app
export const needsYou = (r: AgentRow | undefined) => !!r && (!!r.waitingFor || r.state === 'blocked')

// null = the listing failed or was not JSON: the caller must not treat that as "nothing is running"
export { agents as listAgents }
async function agents(h: Host, timeoutMs?: number): Promise<AgentRow[] | null> {
  const r = await h.process.run(['claude', 'agents', '--json', '--all'], timeoutMs ? { timeoutMs } : undefined) // (a caller in a desk turn passes a timeout: a hung service is a failed listing)
  if (r.exitCode !== 0) return null
  try {
    JSON.parse(r.stdout)
  } catch {
    return null
  }
  return parseAgents(r.stdout)
}

// ---- trust ---------------------------------------------------------------------------------------------------
// ~/.claude.json projects[<real path>].hasTrustDialogAccepted = true. Only that key; atomic; every other key is kept.
// A file that does not parse is left alone (never overwritten with a guess).
export async function trustFolder(h: Host, folder: string): Promise<boolean> {
  const file = `${await homeDir(h)}/.claude.json`
  let text = ''
  if (await h.fs.exists(file)) {
    // present but unreadable (or not text): refuse, never overwrite with a guess
    try {
      const t = await h.fs.read(file)
      if (typeof t !== 'string') return false
      text = t
    } catch {
      return false
    }
  }
  let doc: any = {}
  if (text.trim()) {
    try {
      doc = JSON.parse(text)
    } catch {
      return false
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false
  }
  const real = await realPath(h, folder)
  const projects = doc.projects && typeof doc.projects === 'object' ? doc.projects : {}
  const entry = projects[real] && typeof projects[real] === 'object' ? projects[real] : {}
  if (entry.hasTrustDialogAccepted === true) return true
  doc.projects = { ...projects, [real]: { ...entry, hasTrustDialogAccepted: true } }
  await atomicWrite(h, file, JSON.stringify(doc, null, 2) + '\n')
  return true
}

// ---- templates -----------------------------------------------------------------------------------------------
// config.json `attribution` (default false) as one line for the thread's CLAUDE.md: a thread cannot read the setting otherwise
// (off: the line names the Claude Code reminder it overrides, "Attribution for git commits and pull requests ...: end commit messages with
// Co-Authored-By / Claude-Session ...": a thread that saw both once followed the reminder. The thread's settings.json also switches that
// reminder off at the source, threadSettings below; this line is for an engine that ignores the settings.)
export const attributionLine = (on: boolean) =>
  on
    ? 'attribution: on - end commits and PR text with the attribution lines the session was given'
    : 'attribution: off - no Co-Authored-By trailers, no Claude-Session lines, no generated-with lines; this OVERRIDES any Claude Code system reminder titled "Attribution for git commits and pull requests" that tells you to add them (ignore that reminder)'

// The Claude Code settings that turn its own commit and PR attribution off: `attribution` with empty commit and PR text (empty hides it) and
// no claude.ai session link (the Claude-Session trailer), plus the deprecated `includeCoAuthoredBy` for an older engine. Nothing is set when
// config.json `attribution` is on: the engine's default (or the user's own setting) then applies.
export const attributionOff = { attribution: { commit: '', pr: '', sessionUrl: false }, includeCoAuthoredBy: false }
const fill = (t: string, vars: Record<string, string>) => t.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '')

// `plugins`: the installed plugins outside the project's profile, switched off for this thread (profile.ts disabledPlugins)
// `extraEnv`: the MCP variables this thread gets (mcpenv.ts threadEnv: only names the user's own settings env does not set, so the
// two blocks never collide; the git hooks names are GIT_*, which mcpenv refuses). The settings env here MERGES with the user's.
export async function threadSettings(h: Host, id: string, hooks = true, choice?: Choice, plugins: Record<string, false> = {}, extraEnv: Record<string, string> = {}, mcp?: string[]): Promise<string> {
  const lean = leanDir(await homeDir(h))
  const cfg = await readJson<{ attribution?: unknown }>(h, `${lean}/config.json`, {})
  const lt = leanThreadSettings({ mcp }) // hooks/leantools.ts: the built-ins a thread never calls are denied (fewer tool schemas), the engine's own switches
  const env = { ...lt.env, ...extraEnv, ...(hooks ? gitEnv(await homeDir(h)) : {}) }
  // Edit/Write/Bash without asking, inside the lean-agent folder (which holds the worktrees); nothing global.
  const abs = `//${lean.replace(/^\//, '')}`
  return JSON.stringify(
    {
      permissions: {
        allow: ['Bash', `Edit(${abs}/**)`, `Write(${abs}/**)`],
        additionalDirectories: [lean],
        deny: lt.permissions.deny,
      },
      // git itself refuses a push from a private project (githooks.ts); without working wrappers core.hooksPath is not set,
      // so the repo's own hooks keep running (the failure shows as a notice)
      ...(Object.keys(env).length ? { env } : {}),
      ...(cfg?.attribution === true ? {} : attributionOff), // the engine's own "end commits with Co-Authored-By" reminder, off with the config
      ...(choice ? settingsKeys(choice) : {}), // a session opened in the folder from the app matches
      ...(Object.keys(plugins).length ? { enabledPlugins: plugins } : {}),
    },
    null,
    2,
  ) + '\n'
}

async function template(h: Host, root: string, name: string): Promise<string> {
  const t = await h.fs.read(`${root}/templates/${name}`)
  return typeof t === 'string' ? t : ''
}

// the CLAUDE.md a new thread gets (compare builds a throw-away thread-shaped folder with the same text)
// `choice`: the model and effort the session starts with (written into the guide as one line: a thread cannot see its own settings).
// Without one (compare's throw-away folder: no thread.json, the arm's model comes from flags) the line is left out, never guessed.
// `loaded`: what the thread's profile lets it load (null = no profile applies).
export async function threadClaudeMd(h: Host, root: string, id: string, title: string, project: string, choice?: Choice, loaded: Loaded | null = null): Promise<string> {
  const home = await homeDir(h)
  const cfg = await readJson<{ attribution?: unknown }>(h, `${leanDir(home)}/config.json`, {})
  // the <!-- profile --> block of the template (what is loaded and how to ask for more) is only there when a profile applies: a thread
  // of a project without one is told nothing new
  let text = (await template(h, root, 'thread.md')).replace(/<!-- profile -->\n([\s\S]*?)<!-- \/profile -->\n?/, (_m, block: string) => (restricted(loaded) ? block : ''))
  if (!choice) text = text.split('\n').filter(l => !/\{\{(model|effort)\}\}/.test(l)).join('\n')
  return fill(text, { id, title, project, lean: leanDir(home), attribution: attributionLine(cfg?.attribution === true), loaded: loadedLine(loaded), model: choice?.model ?? '', effort: choice?.effort ?? '' })
}

export async function deskClaudeMd(h: Host, root: string): Promise<string> {
  return fill(await template(h, root, 'front-desk.md'), { lean: leanDir(await homeDir(h)) })
}

// ---- the tool ------------------------------------------------------------------------------------------------
export type Input = { action: string; tN?: string; text?: string; message?: string; title?: string; project?: string; model?: string; effort?: string; path?: string; on?: boolean; keep?: boolean; all?: boolean; confirm?: boolean; sha?: string; reason?: string; needs?: string[]; mcp?: string[]; plugins?: string[]; fill?: boolean; pr?: PrInput; id?: string; allowEdit?: string[]; allowCmd?: string[]; force?: boolean; kind?: string; notice?: string; target?: { pr?: number | string; workitem?: number | string }; kinds?: string[]; section?: string; full?: boolean; verbose?: boolean; file?: string; to?: string; name?: string }
export type Out = { ok: boolean; text: string; data?: unknown }

const err = (text: string): Out => ({ ok: false, text })
const tpath = (home: string, id: string) => `${threadsDir(home)}/${id}`
const ID = /^t\d+$/

const locks = new Map<string, Promise<unknown>>()
// One action at a time per thread: two quick sends cannot both pass the 30 s check.
function serial<T>(id: string, f: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve()
  const next = prev.then(f, f)
  locks.set(id, next.catch(() => undefined))
  return next
}
export const resetLocks = () => locks.clear()

async function load(h: Host, home: string, id: string): Promise<Thread | null> {
  const t = await readJson<Thread | null>(h, `${tpath(home, id)}/thread.json`, null)
  return t && t.id === id ? t : null
}
// the session's own mod appends to `sids` and writes `running` from another process: a save keeps whatever is on disk
async function save(h: Host, home: string, t: Thread): Promise<void> {
  const file = `${tpath(home, t.id)}/thread.json`
  const disk = await readJson<{ sids?: unknown; running?: unknown } | null>(h, file, null)
  const ids = [...(Array.isArray(disk?.sids) ? disk!.sids : []), ...(t.sids ?? [])].filter((x): x is string => typeof x === 'string')
  const running = disk?.running && typeof disk.running === 'object' ? { running: disk.running as Thread['running'] } : {}
  await writeJson(h, file, { ...t, ...running, ...(ids.length ? { sids: [...new Set(ids)].slice(-20) } : {}) })
}

// After a start, the new session's mod says which lean-agent code it loaded (thread.json `running`, written at its session start, a few
// seconds after `claude --bg` returned): wait for it a little (a host that cannot sleep never waits) and answer "running X, installed Y"
// when they differ, '' when they are the same or the session did not say yet (`list` shows it later). The session's real version is
// also what the desk then believes it runs (thread.json `version`): a resume of a session that runs older code starts a fresh one.
export const RUNNING_WAIT_MS = 6_000
export const UNREPORTED = 'has not reported which lean-agent version it runs (a session on code older than this feature never does, and that is the stale-plugin case): ask it for nothing newer than it can do; lean_thread list shows the version once it reports'
async function reportedVersion(h: Host, home: string, t: Thread, root: string, installed: string): Promise<string> {
  if (!t.sid) return ''
  let run = ''
  let waitedFully = false
  for (let waited = 0; ; waited += 500) {
    run = runningOf(await readJson<Thread | null>(h, `${tpath(home, t.id)}/thread.json`, null))
    if (run || !h.clock.sleep) break
    if (waited >= RUNNING_WAIT_MS) {
      waitedFully = true
      break
    }
    try {
      await h.clock.sleep(500)
    } catch {
      break
    }
  }
  if (!run) return waitedFully ? UNREPORTED : ''
  const disk = await load(h, home, t.id)
  if (disk && disk.version !== run) {
    t.version = run
    await save(h, home, { ...disk, version: run })
  }
  const inst = (await installedVersion(h, root)) ?? installed
  return threadSkew(run, inst || null)
}
const SKEW_ADVICE = ' - it loaded another plugin version than the installed one: ask it for nothing the running version lacks; the doctor says what to do, then restart it'

async function nextId(h: Host, home: string): Promise<string> {
  let max = 0
  try {
    for (const e of await h.fs.list(threadsDir(home))) {
      const m = /^t(\d{1,9})$/.exec(e.name) // (compare's throw-away folders are t9 + a 13-digit time: never a thread number)
      if (m) max = Math.max(max, Number(m[1]))
    }
  } catch {
    /* no threads yet */
  }
  return `t${max + 1}`
}

// did this answer come from a session that was really started (not a "running" or refusal text)?
const fresh = (r: Out) => r.ok && !!(r.data as { fresh?: boolean } | undefined)?.fresh

// the goals file belongs to the mod; one lock for every writer (delivery.ts goalsLocked). Returns the removed goal's text ('' when it
// had none text), null when there was no goal
async function clearGoal(h: Host, home: string, id: string): Promise<string | null> {
  return goalsLocked(async () => {
    const goals = await readJson<Record<string, { text?: unknown } | null>>(h, `${leanDir(home)}/goals.json`, {})
    if (!goals || !Object.prototype.hasOwnProperty.call(goals, id)) return null
    const text = typeof goals[id]?.text === 'string' ? (goals[id]!.text as string) : ''
    delete goals[id]
    await writeJson(h, `${leanDir(home)}/goals.json`, goals)
    return text
  })
}

function batchPrompt(msgs: Inbox[]): string {
  return msgs.map(m => (m.from ? `[${m.from}] ` : '') + m.text).join('\n\n')
}

// What a call may name for a session: the model and effort, and for an expensive model the reason and the action (expensive.ts)
type Given = { model?: string; effort?: string; reason?: string; action?: string }

// An expensive model (anything but haiku or sonnet) is never started on a call's say-so: the request waits in the pane's "Needs you" for
// the user's Approve (expensive.ts; only a press there approves). null = go on: a cheap model, or an approval for this thread is there.
// The reason is required when the call NAMED the model (the desk chose it); one that is only the thread's recorded or configured model
// gets a stock reason.
const reasonProblem = (model: string, given: Given): string | null =>
  given.model !== undefined && isExpensiveModel(model) && !(given.reason ?? '').trim()
    ? `${familyOf(model)} needs the user's approval and a reason: call again with reason (one line: why sonnet is not enough for this work). Nothing was started.`
    : null
async function holdExpensive(h: Host, t: Thread, model: string, effort: string | undefined, given: Given, action: string): Promise<Out | null> {
  if (!isExpensiveModel(model) || (await modelAllowed(h, t.id, model))) return null
  const family = familyOf(model)
  const bad = reasonProblem(model, given)
  if (bad) return err(bad)
  const asked = given.model !== undefined
  const reason = (given.reason ?? '').trim() || `${t.id} is configured to run on ${model} (not chosen by this call)`
  const req = await addRequest(h, { thread: t.id, model, ...(effort ? { effort } : {}), reason, action, origin: 'tool', asked })
  return {
    ok: true,
    text: `${t.id} NOT ${action === 'resume' ? 'resumed' : 'started'} on ${model}: ${family} needs the user's approval and no session may choose it. ${req.state === 'denied' ? 'The user DENIED it in the pane.' : 'Ask the user to press Approve (or Deny) on its row in the pane\'s "Needs you".'} Reason shown there: ${req.reason}. Until then nothing runs on ${family}. If the user declines, start it on sonnet instead: lean_thread start ${t.id} model sonnet (the pane has the same button). Do not start it on another model yourself.`,
    data: { pending: true },
  }
}

// A call that names no model never inherits an expensive one that is only the thread's RECORDED model and not approved for it: it gets
// sonnet and the reply says so (a model the call names is held by holdExpensive; an approved one is kept). A string = the refusal.
async function pickModel(h: Host, home: string, t: Thread, given: Given): Promise<{ choice: Choice; note: string } | string> {
  const choice = await threadChoice(h, home, given, t)
  if (typeof choice === 'string') return choice
  if (given.model === undefined && t.model && choice.model === t.model && isExpensiveModel(t.model) && !(await modelAllowed(h, t.id, t.model))) {
    return { choice: { ...choice, model: 'sonnet' }, note: `${t.id} was recorded on ${t.model}; started on sonnet (${familyOf(t.model)} needs the user's approval in the pane)` }
  }
  return { choice, note: '' }
}

async function startSession(h: Host, home: string, t: Thread, prompt: string, given: Given = {}, installed = '', root = ''): Promise<Out> {
  const folder = tpath(home, t.id)
  const picked = await pickModel(h, home, t, given)
  if (typeof picked === 'string') return err(picked)
  const { choice, note } = picked
  const held = await holdExpensive(h, t, choice.model, choice.effort, given, given.action === 'new' ? 'new' : given.action === 'reopen' || given.action === 'restart' ? given.action : 'start')
  if (held) return held
  t.model = choice.model
  t.effort = choice.effort
  // before the session exists its mod reads model, effort and needs from thread.json (at its first request): only these three are saved now,
  // the rest of the record (state, sid) is saved when the start worked
  const disk = await load(h, home, t.id)
  if (disk) await save(h, home, { ...disk, model: t.model, effort: t.effort, ...(t.needs ? { needs: t.needs } : {}) })
  const hooks = await ensureGitHooks(h).then(() => true, () => false)
  // the project's profile (plus this thread's needs): plugins outside it are switched off in the thread's settings; its MCP servers
  // outside it are deferred by the thread's own mod, which reads loaded.json (profile.ts). No profile = nothing held back.
  const loaded = await resolveLoaded(h, home, t.project, t.needs ?? [])
  const off = await disabledPlugins(h, loaded.plugins).catch(() => ({}))
  // MCP variables from ~/.lean-agent/mcp-env.json (a command's output or a plain value), run now, kept only in this thread's settings
  // (user-only file); a failure is a line in the reply (names only), never a failed start
  const menv = await threadEnv(h, home).catch(() => ({ env: {} as Record<string, string>, lines: [] as string[] }))
  const hasEnv = Object.keys(menv.env).length > 0
  const kept = await writeThreadSettings(h, `${folder}/.claude/settings.json`, await threadSettings(h, t.id, hooks, choice, off, menv.env, loaded.mcp ?? undefined), hasEnv, hasEnv ? await threadSettings(h, t.id, hooks, choice, off, {}, loaded.mcp ?? undefined) : undefined).catch(async () => {
    await h.fs.write(`${folder}/.claude/settings.json`, await threadSettings(h, t.id, hooks, choice, off)) // never a failed start, never a secret left in a loose file
    return false
  })
  if (hasEnv && !kept) menv.lines = [...menv.lines.filter(l => !l.startsWith('mcp env for this thread')), "mcp env: the thread's settings file could not be made user-only, so its variables were left out"]
  await writeLoaded(h, home, t.id, loaded).catch(() => undefined)
  await startUsage(h, home, t.id).catch(() => undefined)
  // the guide's model line is the one this session starts with (a recorded opus may start on sonnet): written from the choice made now
  if (root) await refreshGuide(h, root, home, t, choice)
  // the session's name: "tN · title", then "(2)", "(3)" for each session that replaces an older one (the sidebar shows two rows otherwise)
  const old = t.sid
  const gen = old ? (t.gen ?? 1) + 1 : t.gen ? t.gen + 1 : 1 // (no old id but a recorded generation: an earlier start whose session id was not found)
  const name = sessionName(t.id, t.title, gen)
  const r = await h.process.run(['claude', '--bg', '-n', name, '--model', choice.model, '--effort', choice.effort, ...(await threadToolsArgv(h)), '--', prompt], { cwd: folder, timeoutMs: 120_000 })
  if (r.exitCode !== 0) return err(`claude --bg failed: ${(r.stderr || r.stdout).slice(0, 300)}`)
  let sid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(r.stdout + '\n' + r.stderr)?.[0] ?? ''
  if (!sid) {
    const rows = ((await agents(h)) ?? []).filter(a => a.cwd === folder || a.name === name)
    rows.sort((a, b) => b.startedAt - a.startedAt)
    sid = rows[0]?.sid ?? ''
  }
  if (t.sid && sid !== t.sid) t.sids = [...(t.sids ?? []), t.sid] // the old session id stays as history; its conversation is never resumed
  t.sid = sid
  t.gen = gen
  t.lastWake = await h.clock.now()
  const req0 = await requestsOf(h, t.id, t.lastWake)
  if (req0 === null) delete t.req0
  else t.req0 = req0
  delete t.finished // a new session is a new piece of work
  if (installed) t.version = installed
  await save(h, home, t)
  await dropRequests(h, t.id, 'tool').catch(() => undefined) // a session started: what a call asked for earlier (an expensive model) is moot
  // one reply line: what was chosen (model/effort, so the desk need not look it up) and, when a profile applies, what the thread loads
  const how = `${choice.model}/${choice.effort}`
  const skew = sid ? await reportedVersion(h, home, t, root, installed) : '' // "running X, installed Y" when the session loaded another plugin version
  const { notes: settled, ended } = sid ? await settle(h, home, t, { sid, old, name }) : { notes: [] as string[], ended: false }
  const started = ended ? ENDED_AT_ONCE : 'started' // loud: the head of the reply says it
  const base = await readBase(h).catch(() => null)
  const lt = (base ? ` · ${baseLine({ ...base, tools: (await threadToolsArgv(h))[1] ?? '' })}` : '') + ` · ${freeText((await threadLimits(h)).limit, base?.parts?.fixed)}` + (note ? ` · ${note}` : '') + (restricted(loaded) ? ` · ${loadedText(loaded)}` : '') + (skew === UNREPORTED ? ` · ${t.id} ${UNREPORTED}` : skew ? ` · ${skew}${SKEW_ADVICE}` : '') + menv.lines.map(l => ` · ${l}`).join('') + settled.map(l => ` · ${l}`).join('')
  return sid ? { ok: true, text: `${t.id} ${started} (${sid}) · ${how}${lt}`, data: { fresh: true, ...(ended ? { ended: true } : {}) } } : { ok: true, text: `${t.id} started · ${how}, but its session id was not found; list will retry${lt}`, data: { fresh: true } }
}

// After a session was started: the name the app lists for it (read back from `claude agents`), the session it replaced taken out of the
// app's list (claude rm, never forced), and whether it already ended its turn (a session that is idle moments after its start made no
// tool call). Lines for the reply; `ended`: the session is not working.
async function settle(h: Host, home: string, t: Thread, o: { sid: string; old: string; name: string }): Promise<{ notes: string[]; ended: boolean }> {
  const notes: string[] = []
  const rows = await agents(h).catch(() => null)
  const row = rows?.find(a => a.sid === o.sid)
  const bad = nameProblem(row, o.name)
  if (bad) notes.push(`the app lists it as "${bad.slice(0, 60)}", not "${o.name}": Claude Code cannot rename a background session (the doctor says more)`)
  const ended = !!row && liveOf(row) !== 'working'
  if (rows && o.old && o.old !== o.sid && (await threadsConfig(h, home)).removeOld) {
    const rm = await removeSession(h, home, { id: t.id, sid: o.old, current: o.sid, row: rows.find(a => a.sid === o.old), log: true }).catch(() => null)
    if (rm?.removed) notes.push("the old session was removed from the app's list (its conversation is kept)")
    else if (rm?.refused) notes.push(`the old session stays in the app's list (claude rm refused: ${rm.refused})`)
  }
  return { notes, ended }
}

// start / reopen with needs: added to what the thread already asked for (kept in thread.json, so a later start keeps them); a string = refusal
function addNeeds(t: Thread, v: unknown): string | null {
  const n = needsOf(v)
  if (typeof n === 'string') return n
  if (n?.length) t.needs = [...new Set([...(t.needs ?? []), ...n])].slice(0, 50)
  return null
}

// a profile applies (some list is an allow-list); otherwise nothing is held back and nothing is said
const restricted = (l: Loaded | null) => !!l && (l.mcp !== null || l.plugins !== null)

// `needs`: plain names of MCP servers or plugins; a string = the refusal
function needsOf(v: unknown): string[] | string | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v) || v.length > 50 || !v.every(nameOk)) return 'needs must be a list of server or plugin names (letters, digits, . _ : @ -), at most 50'
  return names(v)
}

// `allowEdit` / `allowCmd` on `new` are accepted and ignored: workers may read and edit, readers read, and no brief needs a grant for it.
// (They stay in the input so an older desk that still passes them is never refused.)
export const GRANTS_MAX = 20
export function grantsBlock(_i: Pick<Input, 'allowEdit' | 'allowCmd'>): string | { error: string } {
  return ''
}

async function create(h: Host, root: string, home: string, i: Input, installed = ''): Promise<Out> {
  const title = (i.title ?? '').trim()
  if (!title) return err('new needs a title')
  const prArg = (i as { pr?: unknown }).pr
  if (prArg !== undefined && (typeof prArg === 'object' || typeof prArg === 'boolean' || (typeof prArg === 'string' ? !prArg.trim() : typeof prArg !== 'number'))) return err('new: pr is the PR number or URL the thread is started FOR (an object is the push option)')
  const grants = grantsBlock(i)
  if (typeof grants !== 'string') return err(grants.error) // before any folder exists
  const pre = await threadChoice(h, home, i)
  if (typeof pre === 'string') return err(pre) // a bad model/effort stops here, before any folder exists
  const noReason = reasonProblem(pre.model, i) // an expensive model named without a reason: nothing is created
  if (noReason) return err(noReason)
  const project = (i.project ?? '').trim()
  if (project) {
    const bad = await unknownProject(h, project) // before any folder exists
    if (bad) return err(bad)
  }
  const needs = needsOf(i.needs)
  if (typeof needs === 'string') return err(needs)
  const id = await nextId(h, home)
  const dir = tpath(home, id)
  await mkdirp(h, dir)
  const t: Thread = { id, title, project, state: 'open', sid: '', created: await h.clock.now(), lastWake: 0, delivered: 0, ...(needs?.length ? { needs } : {}), ...(i.keep === true ? { keep: true } : {}) }
  await h.fs.write(`${dir}/CLAUDE.md`, await threadClaudeMd(h, root, id, title, t.project, pre, await resolveLoaded(h, home, t.project, t.needs ?? [])))
  const hooks = await ensureGitHooks(h).then(() => true, () => false)
  await h.fs.write(`${dir}/.claude/settings.json`, await threadSettings(h, id, hooks, pre))
  const brief = ((i.text ?? '').trim() || title) + grants
  await h.fs.write(`${dir}/brief.md`, brief + '\n')
  await save(h, home, t)
  await trustFolder(h, dir)
  const r = await startSession(h, home, t, brief, i, installed, root)
  // A PR is the thread's own ONLY when `pr` was passed (or a review thread's review.pr), never because the brief mentions one (ownpr.ts); the reply says which
  const passed = (i as { pr?: unknown }).pr ?? (i as { review?: { pr?: unknown } }).review?.pr
  const own = r.ok && passed !== undefined ? await recordPassedPr(h, id, passed, (i as { pr?: unknown }).pr !== undefined ? 'you passed pr' : 'you started a review for it').catch(() => ({}) as { line?: string; note?: string }) : null
  const mention = r.ok && passed === undefined ? await noteBrief(h, id, brief).catch(() => null) : null
  const more = own?.line ? `${own.line}. Tell the user this in one line` : own?.note ?? mention
  return r.ok ? { ...r, ...(more ? { text: `${r.text}\n${more}` } : {}), data: t } : r
}

// Stop a finished-but-alive session before anything takes its place (a resume, a fresh session). null = it is gone, go on; an Out =
// stop here with that answer. Never stops live work: the listing is read again right before the stop. `limit`: a session blocked by
// the usage limit (state blocked, nothing it waits for) is not live work and may be stopped.
// `own` (the thread's folder): only a session that lives there is stopped (a listing without that folder stops nothing). `force`: a
// restart the user confirmed stops a working session too; the folder check is then always made.
type StopOpts = { limit?: boolean; own?: string; force?: boolean }
async function stopAlive(h: Host, t: Thread, queued: string, did: string, o: StopOpts = {}): Promise<Out | null> {
  const fresh = (await agents(h))?.find(a => a.sid === t.sid) // look again right before stopping: never stop live work
  const stays = queued ? 'messages stay queued' : 'nothing was started'
  if (!fresh) return err(`${t.id}: cannot list sessions (claude agents failed), so it is not ${did}; ${stays}`)
  if (isRunning(fresh) && !o.force && !(o.limit && isLimitRow(fresh))) return { ok: true, text: `${t.id} is running again: ${queued || 'nothing'} queued, no stop, no ${did === 'resumed' ? 'resume' : 'new session'}` }
  if (o.own && fresh.pid > 0 && !(await inFolder(h, fresh.cwd, o.own))) return err(`${t.id}: its session runs outside the thread folder (${fresh.cwd || 'unknown'}): not stopped, not ${did}, ${stays}`)
  const short = fresh.id || t.sid.slice(0, 8)
  if (fresh.pid > 0) {
    const st = await h.process.run(['claude', 'stop', short])
    if (st.exitCode !== 0) return err(`${t.id}: claude stop ${short} failed (${(st.stderr || st.stdout).trim().slice(0, 200)}): not ${did}, ${stays}`)
    let gone = false
    let listed = false
    for (let n = 0; n < 8 && !gone; n++) {
      const l = await agents(h)
      if (l) listed = true
      const cur = l?.find(a => a.sid === t.sid)
      gone = !!l && (!cur || cur.pid === 0)
      if (!gone && n < 7) await h.process.run(['sleep', '1'])
    }
    if (!gone) return err(listed ? `${t.id}: the session is still running after claude stop ${short}: not ${did}, ${stays}` : `${t.id}: could not confirm the stop (claude agents failed): not ${did}, ${stays}`)
  }
  return null
}

// is `cwd` the thread's own folder (the listing may print the real path of a linked home)?
async function inFolder(h: Host, cwd: string, own: string): Promise<boolean> {
  return cwd === own || (!!cwd && (await realPath(h, cwd)) === (await realPath(h, own)))
}

// A NEW session for an existing thread, with a handover built from what lean-agent kept (brief, goal, notes, reports, remembered
// items, queued messages). The old conversation is never resumed; its id stays in `sids`. The thread's own CLAUDE.md is regenerated
// from the current template when lean-agent wrote it, so the fresh session also gets today's rules.
// `restart`: the user asked for it in the pane (or the desk on request), so a working session is stopped too (its current step is lost);
// otherwise a working session is never touched.
async function freshSession(h: Host, root: string, home: string, t: Thread, installed: string, why: string, given: Given, restart = false, limit = false): Promise<Out> {
  // an expensive model without the user's approval is held BEFORE anything is stopped: a restart never loses work for a session that cannot start
  const want = await pickModel(h, home, t, given)
  if (typeof want === 'string') return err(want) // a bad model or effort stops here, before anything is stopped
  const held = await holdExpensive(h, t, want.choice.model, want.choice.effort, given, given.action ?? 'resume')
  if (held) return held
  const listed = t.sid ? await agents(h) : []
  if (!listed) return err(`${t.id}: cannot list sessions (claude agents failed), so no new session is started`)
  const row = t.sid ? listed.find(a => a.sid === t.sid) : undefined
  const u = await unconsumed(h, home, t.id)
  if (isWorking(row) && !restart && !(limit && isLimitRow(row))) {
    const tr = truthOf({ threadState: t.state, row, queued: u.msgs, now: await h.clock.now(), stuckMinutes: (await threadsConfig(h, home)).stuckMinutes })
    return { ok: true, text: isStuck(tr.word) ? `${t.id} is ${tr.text}: no new session started; restart ${t.id} replaces it` : `${t.id} is running: no new session started (stop it from the Claude app first)` }
  }
  if (row && (row.pid > 0 || (restart && isWorking(row)))) {
    const stopped = await stopAlive(h, t, '', 'started fresh', { own: tpath(home, t.id), ...(restart ? { force: true } : {}), ...(limit ? { limit: true } : {}) })
    if (stopped) return stopped
  }
  const waiting = (await hardStopped(h, home, t))?.waiting === true // restarted at the context limit while it waited: the prompt names the open question
  const ho = await buildHandover(h, home, t, why, u.msgs, waiting)
  const r = await startSession(h, home, t, ho.prompt, given, installed, root)
  if (r.ok && u.msgs.length) {
    t.delivered = u.upTo
    await save(h, home, t)
  }
  return fresh(r) ? { ...r, text: `${r.text} · ${restartCost(ho.prompt, t.model ?? given.model ?? 'sonnet')}` } : r
}

// "new session: handover about 3.2k tokens (~$0.01 first turn, estimate); the old session's conversation is not resumed". The estimate:
// the handover prompt at about four characters a token, priced as uncached input of the model the session starts on (the guide and the
// tool listing are not counted)
export function restartCost(prompt: string, model: string): string {
  const tokens = Math.ceil(prompt.length / 4)
  const usd = (tokens * priceOf(model).in) / 1e6
  const n = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)
  return `new session: handover about ${n} tokens (~$${Math.max(0.01, usd).toFixed(2)} first turn, estimate); the old session's conversation is not resumed`
}

// The thread's CLAUDE.md is regenerated from the template at every fresh start when lean-agent wrote it (its model line is the one the
// new session starts with, so a model change never leaves a stale line); a file the user wrote stays.
async function refreshGuide(h: Host, root: string, home: string, t: Thread, choice?: Choice): Promise<void> {
  const file = `${tpath(home, t.id)}/CLAUDE.md`
  try {
    const have = await h.fs.read(file)
    if (typeof have !== 'string' || !have.startsWith('<!-- generated by lean-agent')) return // the user's own file stays
    const want = await threadClaudeMd(h, root, t.id, t.title, t.project, choice, await resolveLoaded(h, home, t.project, t.needs ?? []))
    if (want && want !== have) await h.fs.write(file, want)
  } catch {
    /* no guide yet: nothing to refresh */
  }
}

async function pending(h: Host, home: string, t: Thread): Promise<Inbox[]> {
  return (await unconsumed(h, home, t.id)).msgs
}

// Resume the thread's session with the queued batch, unless it is running (never resume a running session)
// or was woken less than 30 s ago (the batch stays queued for the next wake).
// `limit`: the resume after a usage limit (docs/usage-limit-resume.md): a session blocked by the limit counts as not running, is
// stopped when its process lingers, and the 30 s gap does not apply (the desk's tick marks one resume per reset itself).
// `root` and `current` (the installed plugin version) are only for the fresh session a finished thread gets instead of a resume.
// `explicit`: a wake the user or desk asked for by name (wake, resume): it also wakes an idle session with nothing queued (the prompt
// then is the task) and replaces a STUCK one (queued messages unread for threads.stuckMinutes, no tool call or inbox read) with the
// handover session. A plain send never replaces a stuck session: it says so and leaves the choice to wake or restart.
async function wake(h: Host, home: string, t: Thread, opts: { force?: boolean; explicit?: boolean; lead?: string; installed?: string; limit?: boolean; root?: string; current?: string } = {}): Promise<Out> {
  if (t.state !== 'open') return { ok: true, text: `${t.id} is ${t.state}: message queued, no wake` }
  if (!t.sid) return { ok: true, text: `${t.id} has no session yet: queued; use start` }
  const u = await unconsumed(h, home, t.id) // one read: the messages and the position they end at
  const msgs = u.msgs
  if (!msgs.length && !opts.force && !opts.explicit) return { ok: true, text: `${t.id}: nothing queued` }
  const listed = await agents(h)
  if (!listed) return err(`${t.id}: cannot list sessions (claude agents failed), so it is not resumed; messages stay queued`)
  const row = listed.find(a => a.sid === t.sid)
  const now = await h.clock.now()
  const truth = truthOf({ threadState: t.state, finished: !!t.finished, row, queued: msgs, now, stuckMinutes: (await threadsConfig(h, home)).stuckMinutes })
  const limited = !!opts.limit && isLimitRow(row)
  // A hard-stopped session (contextstop.ts: every tool call refused) can do nothing with a message, so one never queues behind it, whatever the
  // session shows (working, blocked, idle): the same forced stop as the pane's restart, then a fresh session with the message in its first prompt.
  const hs = !opts.limit && !t.finished && row && liveOf(row) !== 'gone' ? await hardStopped(h, home, t) : null
  if (hs) {
    const r = await freshSession(h, opts.root ?? '', home, t, opts.current ?? '', `Its context was ${hs.tokens} tokens (limit ${hs.limit}) and the session was stopped there; this message starts a new session with the handover.`, {}, true)
    return fresh(r) ? { ...r, text: `${t.id} was at its context limit: started a new session with ${msgs.length ? 'your message' : 'the handover'} (old conversation kept read-only). ${r.text}`, data: { ...(r.data as object), resumed: false } } : r
  }
  if (truth.word === 'running' && !limited) return { ok: true, text: `${t.id} is running: ${msgs.length ? `${msgs.length} message(s) queued, it reads them at its next tool call` : 'nothing queued'}`, data: { resumed: false } }
  if (!msgs.length && !opts.force && truth.word !== 'idle' && !isStuck(truth.word)) return { ok: true, text: `${t.id}: nothing queued` }
  // A stuck session that is still WORKING (one long tool call, a subagent wait: it reads nothing meanwhile) is replaced only by an
  // explicit restart (its current step is lost): wake never stops a working session. A stuck session whose turn ended (idle) is replaced by wake.
  const stuckWorking = isStuck(truth.word) && liveOf(row) === 'working'
  if (isStuck(truth.word) && (!(opts.explicit && !t.finished && !opts.limit) || stuckWorking)) return { ok: true, text: `${t.id} is ${truth.text}: ${msgs.length} message(s) queued, ${stuckWorking ? `it still works: restart ${t.id} replaces it (its current step is lost)` : 'wake or restart it'}`, data: { resumed: false } }
  if (!opts.limit && t.lastWake && now - t.lastWake < WAKE_GAP_MS) return { ok: true, text: `${t.id} was woken ${Math.round((now - t.lastWake) / 1000)} s ago: ${msgs.length} message(s) queued, session ${isStuck(truth.word) ? 'stuck' : 'idle'}: wake or restart it if it stays idle` }
  // a stuck session (nothing read for stuckMinutes) is replaced: stopped and a NEW session starts with the handover, queued messages
  // included (never a session that waits on a prompt for the user: truthOf calls that one running)
  if (isStuck(truth.word) && !t.finished) {
    const r = await freshSession(h, opts.root ?? '', home, t, opts.current ?? '', `Its previous session was stuck: ${truth.unread} queued message(s) unread for ${Math.round(truth.oldestMs / 60_000)} min with no tool call.`, {}, true)
    return fresh(r) ? { ...r, text: `${t.id} was ${truth.text}: replaced by a new session with the handover (old conversation kept read-only). ${r.text}`, data: { ...(r.data as object), resumed: false } } : r
  }
  // A session that reported done is over (finish.ts): its conversation is never resumed. Marked finished, or its last report is done
  // and the session is idle (the desk's tick has not stopped it yet): a NEW session starts with the handover, queued messages included.
  // Two rules decide fresh or resume (threadcontext.ts decide): a recorded context over the limit (checked here, at the next message, never
  // mid-turn: this session is idle or done) and the done rule, which keep mode lifts until the context passes the limit. A session with no
  // recorded size of its own is under the limit. A usage-limit resume is mid-turn (the session was blocked inside a turn): no size check.
  const limits = await threadLimits(h)
  const size = opts.limit ? null : (await readContext(h, home, t))?.tokens ?? null
  const isDone = !!t.finished || (!opts.limit && (await doneSession(h, home, t)))
  const dec = decide({ done: isDone, keep: t.keep === true, tokens: size, limit: limits.limit })
  if (dec.act === 'fresh') {
    const over = dec.cause === 'context'
    const why = over ? `Its context was ${size} tokens (limit ${limits.limit}): this message starts a new session with the handover.` : 'Its previous session reported done and was finished; this message starts a new session.'
    const r = await freshSession(h, opts.root ?? '', home, t, opts.current ?? '', why, {})
    if (!fresh(r)) return r
    const head = over ? `${t.id} ${overText(size!, limits.limit)}` : `${t.id} finished earlier: a new session was started with the handover (old conversation kept read-only); ${notKeepText}`
    return { ...r, text: `${head}. ${r.text}`, data: { ...(r.data as object), resumed: false } }
  }
  // a resume continues the model the session was started on, and cannot change it: when that is expensive and not approved for the thread
  // (an older thread, or a model asked for before the rule) a NEW session on sonnet starts with the handover instead (queued messages included)
  if (t.model && isExpensiveModel(t.model) && !(await modelAllowed(h, t.id, t.model))) {
    const was = t.model
    const r = await freshSession(h, opts.root ?? '', home, t, opts.current ?? '', `Its saved model ${was} is not approved for this thread and a resume cannot change a saved model; this is a new session on sonnet.`, {}, false, !!opts.limit)
    return fresh(r) ? { ...r, text: `${t.id} was recorded on ${was}, which needs the user's approval, and a resume cannot change a saved model: a new session was started with the handover (old conversation kept read-only). ${r.text}`, data: { ...(r.data as object), resumed: false } } : r
  }
  // `claude --bg --resume` continues the session itself only once its process has exited; while the process still lives (finished,
  // idle) the same command starts a copy. So a finished-but-alive one is stopped first (never a working one), then resumed.
  if (row && row.pid > 0) {
    // (a working or unknown status was handled above: only a finished or dead session with a lingering process gets here)
    const stopped = await stopAlive(h, t, `${msgs.length} message(s)`, 'resumed', { limit: !!opts.limit })
    if (stopped) return stopped.ok ? { ...stopped, data: { resumed: false } } : stopped
  }
  const upTo = u.upTo
  // the task first: "Resume the work now (task: ...)", then the queued messages (a status check among them is answered with a short
  // lean_report while the work goes on, never as the whole turn)
  const lead = opts.lead ?? resumeLead(await taskOf(h, home, t))
  const prompt = [lead, batchPrompt(msgs), wakeMark(upTo)].filter(Boolean).join('\n\n')
  const r = await h.process.run(['claude', '--bg', '--resume', t.sid, ...(await threadToolsArgv(h)), '--', prompt], { cwd: tpath(home, t.id), timeoutMs: 120_000 })
  if (r.exitCode !== 0) return err(`claude --bg --resume failed: ${(r.stderr || r.stdout).slice(0, 300)}`)
  // safety net: the CLI prints "started a copy as <id>" when it forked after all; the thread follows the copy
  const after = (await agents(h)) ?? []
  const copy = /started a copy as\s+([0-9a-f][0-9a-f-]{5,})/i.exec(`${r.stdout}\n${r.stderr ?? ''}`)?.[1]?.toLowerCase()
  const hits = copy ? after.filter(a => a.sid.toLowerCase() === copy || a.sid.toLowerCase().startsWith(copy)) : []
  const copied = hits.length === 1 ? hits[0]!.sid : copy && copy.length >= 32 ? copy : undefined
  if (copied) t.sid = copied
  t.lastWake = now
  t.delivered = upTo
  if (opts.installed) t.version = opts.installed // the resumed process loads the code installed now
  if (dec.act === 'resume' && dec.why === 'keep') delete t.finished // keep mode switched on after a finish: the session works again
  await save(h, home, t)
  // the name a resumed session keeps is the one it was started with (`--resume` takes no -n): read back, said when it is not the thread's
  const bad = nameProblem(after.find(a => a.sid === t.sid), sessionName(t.id, t.title, t.gen ?? 1))
  const named = bad ? ` · the app lists it as "${bad.slice(0, 60)}": Claude Code cannot rename a background session (the doctor says more)` : ''
  const kept = dec.act === 'resume' && (dec.why === 'keep' || size !== null) ? ` · ${resumedText(dec.why, size, t.model ?? 'sonnet')}` : '' // which rule applied and its estimated cost (said when the size is known or keep mode decided)
  return { ok: true, data: { resumed: true }, text: `${t.id} woken with ${msgs.length} message(s)${copied ? `; the CLI started a copy, the thread now follows session ${copied.slice(0, 8)}` : copy ? `; the CLI started a copy as ${copy}, which ${hits.length > 1 ? 'matches several sessions' : 'is not in the session list yet'}: the thread keeps its old session id, check ${t.id} with lean_thread list` : ''}${named}${kept}` }
}

// the desk's default list: one short line per thread (id, state word, context, today's cost, the first 80 characters of its last report); the long form
// is `verbose: true`. The desk's conversation keeps every reply, so the default stays small (a spec pins the size).
export const LIST_LINE_MAX = 200
const LAST_CHARS = 80
export function listLine(o: { id: string; title?: string; state: string; live?: string; ctx?: string; today?: string; lastText?: string; stale?: boolean; ended?: boolean }): string {
  const word = `${o.state === 'open' ? o.live || 'open' : o.state}${o.stale ? ' (report stale)' : ''}${o.ended ? ' (ended at once)' : ''}`
  const last = o.lastText ? `"${o.lastText.replace(/\s+/g, ' ').trim().slice(0, LAST_CHARS)}"` : `(no report) ${(o.title ?? '').slice(0, 40)}`
  return [`${o.id} ${word}`, o.ctx, o.today?.replace(/ \(.*$/, ''), last].filter(Boolean).join(' · ')
}
async function list(h: Host, home: string, root = '', verbose = false): Promise<Out> {
  const listed = await agents(h)
  const rows = listed ?? []
  const installed = await installedVersion(h, root)
  const now0 = await h.clock.now()
  const stuckMinutes = (await threadsConfig(h, home)).stuckMinutes
  const stall = await stallConfig(h, home)
  const ctxLimits = await threadLimits(h)
  const recs = await readJsonl<DeskRec>(h, `${deskState(home)}/inbox.jsonl`).catch(() => [] as DeskRec[]) // the last report of each thread (a [working] one can be stale)
  const out: unknown[] = []
  let ents: { name: string }[] = []
  try {
    ents = await h.fs.list(threadsDir(home))
  } catch {
    /* none */
  }
  for (const e of ents.filter(x => ID.test(x.name)).sort((a, b) => Number(a.name.slice(1)) - Number(b.name.slice(1)))) {
    const t = await load(h, home, e.name)
    if (!t) continue
    const queued = await pending(h, home, t)
    const q = queued.length
    const row = rows.find(a => a.sid === t.sid)
    // running | idle | stuck | done: from the session's own state and the queue, never from the thread's last report
    const truth: Truth | null = listed && t.state === 'open' && t.sid ? truthOf({ threadState: t.state, finished: !!t.finished, row: t.sid ? row : undefined, queued, now: now0, stuckMinutes, stallMinutes: stall.minutes, activityAt: t.sid && t.state === 'open' ? await lastActivity(h, home, t.id, t.lastWake) : null }) : null
    const mine = recs.filter(r => r && r.from === t.id && (r.kind === 'report' || r.kind === 'ask'))
    const lastRec = mine[mine.length - 1]
    const stale = !!truth && lastRec?.kind === 'report' && staleWorking(lastRec.state, truth.word)
    const finishing = !!truth && truth.word === 'running' && lastRec?.kind === 'report' && lastRec.state === 'done' && row?.status === 'idle' // reported done, only a background worker's notification is pending
    const ended = !!truth && !!t.sid && t.lastWake > 0 && endedAtOnce({ word: truth.word, req0: t.req0, req: typeof t.req0 === 'number' ? await requestsOf(h, t.id, now0) : null, reportsSince: mine.filter(r => r.ts >= t.lastWake).length })
    const lo = await readLoaded(h, home, t.id)
    // the code the thread's session runs (its own mod's report) when it differs from what is installed: "running X, installed Y"
    const ran = t.state === 'closed' ? '' : runningOf(t)
    const skew = threadSkew(ran, installed)
    // a live session that never said which code it runs, a minute after its start: older than the report feature (the stale-plugin case)
    const unreported = t.state === 'open' && !!t.sid && !ran && !!rows.find(a => a.sid === t.sid) && t.lastWake > 0 && (await h.clock.now()) - t.lastWake > 60_000
    const used = await agentsText(h, home, t.id).catch(() => '') // "agents 3/4" when config.json agents.cap is set
    const cv0 = t.state !== 'closed' && t.sid ? await ctxOf(h, home, t, ctxLimits).catch(() => null) : null // "ctx 108k/120k" | "ctx unknown" (threadcontext.ts)
    const restarting = await isRestarting(h, home, t).catch(() => false) // hard-stopped, the mod restarts it: amber, nothing for the user to do
    const cv = cv0 && restarting ? { ...cv0, level: 'warn' as const } : cv0
    out.push({ ...(lastRec && typeof lastRec.text === 'string' ? { lastText: lastRec.text.replace(/\s+/g, ' ').trim().slice(0, LAST_CHARS) } : {}), id: t.id, title: t.title, project: t.project, model: t.model, effort: t.effort, state: t.state, running: isRunning(row), ...(cv ? { ctx: cv.text, ctxLevel: cv.level, ...(cv.tokens !== undefined ? { ctxTokens: cv.tokens } : {}) } : {}), ...(t.keep === true ? { keep: true } : {}), ...(truth ? { live: truth.word, unread: truth.unread, liveText: restarting ? `restarting: ${RESTARTING_TEXT}` : finishing ? 'done (finishing)' : truth.text } : {}), ...(stale ? { stale: true } : {}), ...(ended ? { ended: true } : {}), sid: t.sid, queued: q, ...(used ? { agents: used } : {}), ...(lo && restricted(lo) ? { loaded: loadedText(lo) } : {}), ...(await threadSpendLine(h, t.id).then(l => (l ? { today: l } : {}))), ...(ran ? { codeVersion: ran } : {}), ...(skew ? { skew } : {}), ...(unreported ? { skew: 'version unreported (an older session: ask it for nothing newer than it can do)' } : {}) })
  }
  const text = out.length && !verbose ? (out as any[]).map(listLine).join('\n') : out.length ? (out as any[]).map(o => `${o.id} · ${o.title}${o.project ? ` · ${o.project}` : ''} [${o.state}${o.liveText ? `, ${o.liveText}` : o.queued ? `, ${o.queued} queued` : ''}]${o.model ? ` · ${o.model}/${o.effort}` : ''}${o.agents ? ` · ${o.agents}` : ''}${o.loaded ? ` · ${o.loaded}` : ''}${o.skew ? ` · ${o.skew}` : ''}${o.stale ? ' · its last report [working] is stale: the session is not running' : ''}${o.ended ? ` · ${ENDED_AT_ONCE}` : ''}${o.ctx ? ` · ${o.ctx}${o.ctxLevel === 'over' ? ' (over the limit: the next message starts a new session)' : ''}` : ''}${o.keep ? ' · keep' : ''}`).join('\n') : 'no threads'
  // what waits for the user, as the pane counts it: a dismissed item is not counted (dismiss.ts), and its number is named
  const nv = out.length ? await loadView(h).catch(() => null) : null
  const nd = (nv?.dismissed.length ?? 0) + (nv?.dismissedNotices.length ?? 0)
  const need = nv && (nv.needs.length || nd) ? `\nNeeds you: ${nv.needs.length}${nd ? ` (${nd} dismissed, hidden until a newer one arrives)` : ''}` : ''
  return { ok: true, text: text + need, data: out }
}

// the desk's `profile`: show a project's profile with what its threads used; mcp / plugins set the lists (a list left out stays as it is);
// fill: true adds what the threads used; on: false removes the profile (every thread loads everything again)
async function profileAction(h: Host, home: string, i: Input): Promise<Out> {
  const project = (i.project ?? '').trim()
  if (!slugOk(project)) return err('profile needs project: a registered project name')
  const bad = await unknownProject(h, project)
  if (bad) return err(bad.replace(/ No thread was created\.$/, ''))
  if (i.on === false) return { ok: true, text: (await removeProfile(h, home, project)) ? `${project} profile removed: every thread of it loads everything again` : `${project} has no profile` }
  for (const [k, v] of [['mcp', i.mcp], ['plugins', i.plugins]] as const) if (v !== undefined && (!Array.isArray(v) || v.length > 50 || !v.every(nameOk))) return err(`${k} must be a list of names (letters, digits, . _ : @ -), at most 50`)
  if (i.mcp !== undefined || i.plugins !== undefined) {
    const cur = await readProfile(h, home, project)
    await writeProfile(h, home, project, { mcp: names(i.mcp) ?? cur?.mcp, plugins: names(i.plugins) ?? cur?.plugins }, 'desk')
    return { ok: true, text: `${await profileText(h, home, project)}\nnew threads of ${project} start with it; running ones keep what they started with` }
  }
  if (i.fill === true) return await fillProfile(h, home, project)
  return { ok: true, text: await profileText(h, home, project) }
}

// the desk's conversation keeps every reply: a start / restart / send reply is at most 3 lines (the rest joins the third, cut) unless it failed
export const SHORT_REPLY = new Set(['new', 'start', 'restart', 'reopen', 'resume', 'wake', 'send'])
export const REPLY_LINES = 3
export const REPLY_TAIL_MAX = 300
export function threeLines(text: string): string {
  const lines = text.split('\n').filter(l => l.trim())
  if (lines.length <= REPLY_LINES) return lines.join('\n')
  const rest = lines.slice(REPLY_LINES - 1).join(' · ')
  return [...lines.slice(0, REPLY_LINES - 1), rest.length > REPLY_TAIL_MAX ? `${rest.slice(0, REPLY_TAIL_MAX - 1)}…` : rest].join('\n')
}

// the actions whose `text` (or `message`) is the first instruction of the session they start (queued first, delivered last in its first prompt)
const CARRY = new Set(['restart', 'reopen', 'start', 'wake', 'resume'])

// ---- the fields each action uses (the tool entry refuses the others: a dropped field is a lost instruction) ----------------------------------
const TEXTY = ['text', 'message']
const USES: Record<string, string[]> = {
  new: [...TEXTY, 'title', 'project', 'model', 'effort', 'review', 'pr', 'keep', 'allowEdit', 'allowCmd', 'needs', 'reason'],
  send: TEXTY,
  wake: TEXTY,
  close: [],
  park: [],
  reopen: [...TEXTY, 'model', 'effort', 'reason', 'needs'],
  list: ['verbose'],
  resume: [...TEXTY, 'model', 'effort', 'reason'],
  start: [...TEXTY, 'model', 'effort', 'reason', 'keep', 'needs'],
  restart: [...TEXTY, 'model', 'effort', 'reason'],
  projects: ['all'],
  'project-add': ['project', 'path'],
  'project-remove': ['project'],
  'project-private': ['project', 'on', 'confirm'],
  profile: ['project', 'on', 'mcp', 'plugins', 'fill'],
  'goal-set': TEXTY,
  'goal-clear': [],
  'approve-push': ['sha', 'reason'],
  push: ['sha', 'pr', 'reason'],
  'action-list': [],
  'approve-action': ['id'],
  'allow-writes': ['target', 'kinds'],
  'allow-ask': ['target', 'kinds'],
  'revoke-writes': ['id'],
  'allow-self-edit': [],
  'revoke-self-edit': ['id'],
  deliver: ['file', 'to', 'name'],
  keep: ['on'],
  find: TEXTY,
  ask: TEXTY,
  report: ['section', 'full'],
  dismiss: ['kind', 'notice'],
}
const FIELDS = new Set([...Object.values(USES).flat(), 'action', 'tN'])
const ENGINE_KEYS = new Set(['tool', 'tool_use_id', 'toolUseId', 'tool_name', 'input'])
// null = fine; else the refusal text. Only the TOOL ENTRY calls it (register.tsx): the desk's own timers call leanThread with internal fields.
export function unusedField(e: Record<string, unknown>): string | null {
  const action = typeof e.action === 'string' ? e.action : ''
  const uses = USES[action]
  if (!uses) return null // an unknown action is the tool's own refusal
  for (const [k, v] of Object.entries(e)) {
    if (k === 'action' || k === 'tN' || ENGINE_KEYS.has(k) || v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue
    if (uses.includes(k)) continue
    if (!FIELDS.has(k)) return `lean_thread has no field "${k.slice(0, 40)}"; ${action} takes ${uses.length ? uses.join(', ') : 'only tN'}. Nothing was done`
    const who = Object.entries(USES).filter(([, f]) => f.includes(k)).map(([a]) => a)
    const hint = TEXTY.includes(k) ? `; to tell ${e.tN ?? 'a thread'} something, use send (or restart / reopen / start / wake / resume with ${k}: it is that session's first instruction)` : ''
    return `${action} does not use the field "${k}" (it would be dropped): ${k} is used by ${who.join(', ')}${hint}. Nothing was done; call again without it`
  }
  if (e.text !== undefined && e.message !== undefined && e.text !== e.message && uses.includes('text')) return 'give the text as text or as message, not both (message is an alias of text). Nothing was done'
  return null
}

// find, ask and report answer from the store by script (threadask.ts); `new` and `start` carry the plan-window warning above
// window.holdAbove (windows.ts). Everything else is leanThreadCore.
export async function leanThread(h: Host, root: string, i: Input): Promise<Out> {
  try {
    if (i.action === 'find' || i.action === 'ask' || i.action === 'report') {
      const home = await homeDir(h)
      if (i.action === 'find') return await findText(h, home, i.text ?? '')
      if (!ID.test(i.tN ?? '')) return err(`${i.action} needs tN (like t3)`)
      return i.action === 'ask' ? await askText(h, home, i.tN!, i.text ?? '') : await reportText(h, home, i.tN!, { section: typeof i.section === 'string' ? i.section : undefined, full: i.full === true })
    }
    if (i.message !== undefined && i.text === undefined) i = { ...i, text: i.message } // `message` is an alias of `text`
    // The text given to restart / reopen / start / wake / resume is the first instruction of the session that call starts: it is queued (flagged) before
    // the action, so a start that is held or refused leaves it queued for the next one, and a fresh session gets it as the LAST part of its first
    // prompt (handover.ts). The reply says which happened.
    // size lint (briefsize.ts, script, no refusal): the sources a brief names weigh more than half of the thread's free context (its limit minus its
    // fixed base), or it names many: the reply and the brief say to split it into a READING and a WRITING thread. Before the text is carried.
    let sizeLint = ''
    if ((i.action === 'new' || i.action === 'start' || i.action === 'send') && typeof i.text === 'string' && i.text.trim()) {
      try {
        const home = await homeDir(h)
        const t = ID.test(i.tN ?? '') ? await load(h, home, i.tN!) : null
        const fixed = (t ? (await readParts(h, home, t.id))?.first?.fixed : undefined) ?? (await readBase(h))?.parts?.fixed // (a new thread: the newest session's)
        const l = await briefLint(h, i.text, await lintRoots(h, (t?.project ?? i.project ?? '').trim(), t?.id), { limit: (await threadLimits(h)).limit, fixed })
        if (l) {
          sizeLint = l.line
          i = { ...i, text: `${i.text}\n\n${l.line}` }
        }
      } catch {
        /* no lint: the call goes through as it was */
      }
    }
    let carried: { ts: number; chars: number; id: string; home: string } | null = null
    if (CARRY.has(i.action) && ID.test(i.tN ?? '') && typeof i.text === 'string' && i.text.trim()) {
      const home = await homeDir(h)
      const id = i.tN!
      if (await load(h, home, id)) {
        const text = i.text.trim()
        const ts = await h.clock.now()
        await serial(id, () => appendJsonl(h, `${tpath(home, id)}/inbox.jsonl`, { ts, text, instr: true } satisfies Inbox))
        carried = { ts, chars: text.length, id, home }
        i = { ...i, text: undefined }
      }
    }
    // brief lint (script, no refusal): a `new` / `send` text that asks for a forge write by script (curl / az / gh) cannot be carried out by
    // a thread. One warning line goes to the desk in the reply, and the same line is appended to the brief the thread receives.
    let lint = ''
    if ((i.action === 'new' || i.action === 'send') && typeof i.text === 'string' && isForgeWrite(i.text)) {
      lint = briefLintLine()
      i = { ...i, text: `${i.text}\n\n${lint}` }
    }
    // a thread whose worker was denied (denial.ts) and is told to retry: the user's own recorded words that name it ride along, so the next brief can
    // quote them verbatim as the authority (selfedit.ts userWordsFor; nothing the model writes can stand in for them)
    if (i.action === 'send' && ID.test(i.tN ?? '') && typeof i.text === 'string' && i.text.trim() && (await denialRec(h, i.tN!).catch(() => null))) {
      const words = await userWordsFor(h, i.tN!).catch(() => '')
      if (words) i = { ...i, text: `${i.text}\n\n[lean-agent] The user's own recorded words that name you (quote them verbatim in the next worker brief as the authority for the step): "${words}"` }
    }
    let out = await leanThreadCore(h, root, i)
    if (out.ok && (i.action === 'new' || i.action === 'start')) {
      const warn = await holdWarning(h, await homeDir(h))
      if (warn) out = { ...out, text: `${out.text}\n${warn}` }
    }
    if (carried) {
      const left = (await unconsumed(h, carried.home, carried.id).catch(() => ({ msgs: [] as Inbox[] }))).msgs.some(m => m.instr && m.ts === carried!.ts)
      const why = (data: unknown) => ((data as { pending?: boolean } | undefined)?.pending ? 'the call was held for the user\'s approval' : (out.text.split('\n')[0] ?? '').slice(0, 140))
      out = { ...out, text: left ? `${out.text} · text not delivered: ${why(out.data)}; it is queued (${carried.chars} chars) and the next start carries it` : fresh(out) ? `${out.text} · new session; your text (${carried.chars} chars) is its first instruction` : `${out.text} · your text (${carried.chars} chars) was delivered to the session as its message` }
    }
    const short = out.ok && SHORT_REPLY.has(i.action) ? { ...out, text: threeLines(out.text) } : out // a failure keeps every line it has
    const full = lint && short.ok ? { ...short, text: `${short.text}\n${lint}` } : short // the warnings are appended after the cut: never trimmed away
    return sizeLint && full.ok ? { ...full, text: `${full.text}\n${sizeLint}` } : full
  } catch (e) {
    return err(`${i.action} failed: ${(e as Error)?.message ?? e}`)
  }
}

async function leanThreadCore(h: Host, root: string, i: Input): Promise<Out> {
  try {
    const home = await homeDir(h)
    await ensureGitHooks(h).catch(() => undefined) // every action (resume and wake too) refreshes the private registry
    if (i.action === 'list') return await list(h, home, root, i.verbose === true)
    if (i.action === 'profile') return await profileAction(h, home, i)
    // typed remote writes a thread asked for with lean_report `action` (deskactions.ts): the desk lists them, asks the USER, and sends
    // only a request the user approved; the thread is told the outcome through its inbox
    if (i.action === 'action-list' || i.action === 'approve-action') {
      const tell = (thread: string, text: string): Promise<void> => leanThread(h, root, { action: 'send', tN: thread, text }).then(() => undefined)
      if (i.action === 'action-list') return { ok: true, text: `${await actionListText(h, tell)}${await writesListText(h).catch(() => '')}` }
      const o = await approveAction(h, (i.id ?? '').trim(), tell)
      return o.ok ? { ok: true, text: o.text } : err(o.text)
    }
    // approval in advance (deskwrites.ts): the mod makes the grant only when the user's own recorded words name the target and ask for the work
    // the user's dialog answer as the written yes (deskwrites.ts askWrites / bindOfferAnswers): a signed offer and its canonical question
    if (i.action === 'allow-ask') {
      const o = await askWrites(h, (i.tN ?? '').trim(), i.target, i.kinds)
      return o.ok ? { ok: true, text: o.text, data: { ask: o.ask } } : err(o.text)
    }
    if (i.action === 'allow-writes') {
      const o = await allowWrites(h, (i.tN ?? '').trim(), i.target, i.kinds)
      if (!o.ok) return o.ask ? { ok: false, text: o.text, data: { ask: o.ask } } : err(o.text) // a refusal carries the canonical question the desk can ask at once
      const owns = await ownFromGrant(h, (i.tN ?? '').trim(), o.target).catch(() => null) // the user's words name the target: it is the thread's own (ownpr.ts)
      return { ok: true, text: owns ? `${o.text}. ${owns}` : o.text }
    }
    // the user may let a thread whose worker was denied edit its worktree itself (selfedit.ts): the mod checks the user's recorded words
    if (i.action === 'allow-self-edit') {
      const o = await allowSelfEdit(h, (i.tN ?? '').trim())
      return o.ok ? { ok: true, text: o.text } : err(o.text)
    }
    if (i.action === 'revoke-self-edit') {
      const tn = (i.tN ?? '').trim()
      const o = await revokeSelfEdit(h, i.id ? { id: i.id.trim() } : tn ? { thread: tn } : { all: true }, 'user, by the desk')
      return o.ok ? { ok: true, text: o.text } : err(o.text)
    }
    // a file for the user's Downloads / Desktop / Documents (deliver.ts): the mod copies it from the thread's scratch folder, on the user's words
    if (i.action === 'deliver') {
      const o = await deliver(h, { tN: i.tN, file: i.file, to: i.to, name: i.name })
      return o.ok ? { ok: true, text: o.text } : { ok: false, text: o.text, ...(o.data ? { data: o.data } : {}) }
    }
    if (i.action === 'revoke-writes') {
      const tn = (i.tN ?? '').trim()
      const o = await revokeWrites(h, i.id ? { id: i.id.trim() } : tn ? { thread: tn } : { all: true }, 'user, by the desk')
      return o.ok ? { ok: true, text: o.text } : err(o.text)
    }
    if (/^projects$|^project-(add|remove|private)$/.test(i.action)) {
      const r = await projectsAction(h, i)
      if (i.action !== 'projects') await ensureGitHooks(h).catch(() => undefined) // projects.json changed: the private list follows
      return r
    }
    const installed = await pluginVersion(h, root)
    if (i.action === 'new') return await newOrReview(h, root, i, x => create(h, root, home, x, installed)) // review: {..} starts a kind-review thread (reviewkind.ts)
    if (i.action === 'dismiss') return await dismissAction(h, i) // the user hid an item of the pane (dismiss.ts): tN, tN kind, or notice
    const id = i.tN ?? ''
    if (!ID.test(id)) return err(`${i.action} needs tN (like t3)`)
    return await serial(id, async () => {
      const t = await load(h, home, id)
      if (!t) return err(`no thread ${id}`)
      switch (i.action) {
        case 'send': {
          const text = (i.text ?? '').trim()
          if (!text) return err('send needs text')
          await appendJsonl(h, `${tpath(home, id)}/inbox.jsonl`, { ts: await h.clock.now(), text } satisfies Inbox)
          return await wake(h, home, t, { root, current: installed }) // (a message wake does not stamp the version: only start and an explicit resume do)
        }
        case 'wake':
          return await wake(h, home, t, { root, current: installed, explicit: true })
        case 'resume': {
          // a resume that names an expensive model is held like a start on it (the model itself is the session's saved one)
          if (i.model !== undefined && isExpensiveModel(i.model)) {
            const held = await holdExpensive(h, t, i.model, i.effort ?? t.effort, i, 'resume')
            if (held) return held
          }
          // A session keeps the lean-agent code it started with. When this one ran an older version than the installed one, a resume
          // would continue old behaviour: start a fresh session with a handover instead and say why (an unrecorded version is unknown: resume).
          // (what the session really runs, as its own mod reported it, beats the version the desk saw installed when it started it)
          const ran = runningOf(t) || t.version
          if (t.state === 'open' && t.sid && olderVersion(ran, installed)) {
            const was = ran // (a started session records the installed version over it)
            const r = await freshSession(h, root, home, t, installed, `The previous session ran lean-agent ${was}; ${installed} is installed now, so this is a fresh session instead of a resume.`, i)
            return fresh(r) ? { ...r, text: `${id} started as a new session instead of a resume: the old one ran lean-agent ${was}, ${installed} is installed (old conversation kept read-only). ${r.text}` } : r
          }
          return await wake(h, home, t, { force: true, explicit: true, installed, root, current: installed })
        }
        case 'limit-resume': {
          // only the desk's tick calls this (not in the tool's schema): the session was seen blocked by the usage limit and its reset
          // has passed. Checked again here, inside the lock: an open thread, a record for this very session that no parking cancelled,
          // and the tick's mark for this reset ("resumedFor", set just before this call: a call without it is refused). A thread woken
          // since the mark (lastWake past resumedAt) was resumed by an earlier call for this very mark: never a second one.
          if (t.state !== 'open') return err(`${id} is ${t.state}: not resumed after the usage limit`)
          if (t.finished) return { ok: true, text: `${id} is finished: no usage-limit resume (its next message starts a new session)`, data: { resumed: false } }
          const rec = await readLimit(h, home, id)
          if (!usable(rec, t.sid, await h.clock.now()) || rec.cancelled) return err(`${id}: no usable usage-limit record for its session, nothing resumed`)
          if (rec.resumedFor !== rec.resetAt || typeof rec.resumedAt !== 'number') return err(`${id}: the usage-limit resume was not marked by the desk's check, nothing resumed`)
          if (t.lastWake >= rec.resumedAt) return { ok: true, text: `${id} was already resumed for this usage limit`, data: { resumed: false } }
          return await wake(h, home, t, { force: true, lead: LIMIT_PROMPT, limit: true })
        }
        case 'keep': {
          // `keep tN on|off`: keep mode (threadcontext.ts); without on/off it only says what is set
          const limits = await threadLimits(h)
          if (i.on === undefined) return { ok: true, text: keepText(id, t.keep === true, limits), data: { keep: t.keep === true } }
          if (i.on) t.keep = true
          else delete t.keep
          const disk = (await load(h, home, id)) ?? t
          const { keep: _was, ...rest } = disk
          await save(h, home, { ...rest, ...(i.on ? { keep: true } : {}) })
          return { ok: true, text: keepText(id, i.on, limits), data: { keep: i.on } }
        }
        case 'finish': {
          // only the desk's tick calls this (not in the tool's schema; finish.ts picks the candidates): the thread's last report is done.
          // Checked again here, inside the lock. A session that is still working (a final step after the report) is left alone and
          // looked at again at the next tick; an idle one is stopped (never a session outside the thread folder) and marked finished:
          // the next send, wake or resume starts a NEW session with the handover.
          if (t.state !== 'open') return err(`${id} is ${t.state}: not finished`)
          if (t.finished) return { ok: true, text: `${id} is already finished`, data: { finished: false } }
          if (!t.sid) return { ok: true, text: `${id} has no session`, data: { finished: false } }
          if (t.keep === true) return { ok: true, text: `${id} is in keep mode: its session is kept after a done report`, data: { finished: false } }
          if (!(await doneSession(h, home, t))) return { ok: true, text: `${id}: its last report is not done: nothing finished`, data: { finished: false } }
          const listed = await agents(h)
          if (!listed) return err(`${id}: cannot list sessions (claude agents failed), so it is not finished`)
          const row = listed.find(a => a.sid === t.sid)
          if (isWorking(row)) return { ok: true, text: `${id} reported done but is still working: finished once it is idle`, data: { finished: false } }
          if (row && row.pid > 0) {
            const stopped = await stopAlive(h, t, '', 'finished', { own: tpath(home, id) })
            if (stopped) return { ...stopped, data: { finished: false } }
          }
          t.finished = await h.clock.now()
          await save(h, home, t)
          return { ok: true, text: finishedText(id), data: { finished: true } }
        }
        case 'restart': {
          // the pane's Restart button, or the desk on request: the session is stopped (a working one too: its current step is lost; only
          // a session in the thread's own folder) and a NEW session starts with the handover (brief, goal, notes, reports, queued
          // messages, branch and worktree from the reports; the thread's recorded model and effort)
          if (t.state !== 'open' && t.state !== 'parked') return err(`${id} is ${t.state}: reopen it first`)
          const wasParked = t.state === 'parked' // a parked thread is reopened by the restart itself, in one step
          t.state = 'open'
          const r = await freshSession(h, root, home, t, installed, 'Restarted from the pane.', i, true) // (a model named here is asked for like a start's)
          if (!fresh(r)) {
            if (wasParked) t.state = 'parked' // nothing was saved: it stays parked
            return r
          }
          return { ...r, text: `${id} ${wasParked ? 'was parked: reopened and restarted' : 'restarted'} as a new session (old conversation kept read-only). ${r.text}` }
        }
        case 'stall-restart': // (threads.stallRestart, stall.ts: the same stop and fresh session as the automatic restart at the context limit)
        case 'auto-restart': {
          // the desk's timer (autorestart.ts) at the context limit: the checkpoint was written, the session is idle. A NEW session with the
          // handover; never a parked or closed thread. A working session is left alone unless `force` (the desk's timer after the idle / grace rule:
          // the hard stop already refuses its tool calls, so it is stopped exactly as the pane's restart does and a fresh one takes over).
          if (t.state !== 'open') return err(`${id} is ${t.state}: no automatic restart`)
          const r = await freshSession(h, root, home, t, installed, i.reason ?? (i.action === 'stall-restart' ? 'Its previous session stalled: no tool call or report for a long time; restarted by script.' : 'Its context was over the limit: checkpointed and restarted by script.'), i, i.force === true)
          return fresh(r) ? { ...r, text: `${id} restarted ${i.action === 'stall-restart' ? 'after a stall' : 'at the context limit'} as a new session (old conversation kept read-only). ${r.text}` } : r
        }
        case 'start': {
          if (t.state === 'closed' || t.state === 'closing') return err(`${id} is ${t.state}; reopen it first`)
          const bad = addNeeds(t, i.needs)
          if (bad) return err(bad)
          if (i.keep !== undefined && (t.keep === true) !== (i.keep === true)) {
            // keep mode named on a start is stored at once (also when the start itself turns out to be refused or the session runs)
            const { keep: _was, ...rest } = (await load(h, home, id)) ?? t
            if (i.keep === true) t.keep = true
            else delete t.keep
            await save(h, home, { ...rest, ...(i.keep === true ? { keep: true } : {}) }) // (only the keep flag: needs added above stay unsaved until a session starts)
          }
          const live = t.sid ? await agents(h) : []
          if (!live) return err(`${id}: cannot list sessions (claude agents failed), so it is not started`)
          const srow = t.sid ? live.find(a => a.sid === t.sid) : undefined
          if (t.sid && isRunning(srow)) {
            const tr = truthOf({ threadState: t.state, row: srow, queued: await pending(h, home, t), now: await h.clock.now(), stuckMinutes: (await threadsConfig(h, home)).stuckMinutes })
            return { ok: true, text: isStuck(tr.word) ? `${id} is ${tr.text}: nothing started; it still works: restart ${id} replaces it (its current step is lost)` : `${id} is already running${i.needs?.length ? ' (needs apply to a new session only: nothing was changed)' : ''}` }
          }
          // an idle session whose process is still alive is stopped before a new one takes its place (never a working one, never one outside the thread folder)
          if (srow && !t.finished && srow.pid > 0) {
            const stopped = await stopAlive(h, t, '', 'started fresh', { own: tpath(home, id) })
            if (stopped) return stopped
          }
          if (t.finished) {
            // a finished thread never continues its old conversation: a new session with the handover
            const r = await freshSession(h, root, home, t, installed, 'Its previous session reported done and was finished; it is started again.', i)
            return fresh(r) ? { ...r, text: `${id} finished earlier: started as a new session with the handover (old conversation kept read-only). ${r.text}` } : r
          }
          const brief = (await h.fs.read(`${tpath(home, id)}/brief.md`).catch(() => t.title)) as string
          const u = await unconsumed(h, home, id)
          const msgs = u.msgs
          const prompt = [brief.trim(), msgs.some(m => m.instr) ? INSTR_LEAD : '', batchPrompt(msgs.filter(m => !m.instr)), instrBlock(msgs)].filter(Boolean).join('\n\n') // (the desk's own instructions last)
          const replaces = !!t.sid // a start that replaces an older session is a fresh start: it says what it costs
          const r = await startSession(h, home, t, prompt, i, installed, root)
          if (r.ok && msgs.length) {
            t.delivered = u.upTo
            await save(h, home, t)
          }
          return replaces && fresh(r) ? { ...r, text: `${r.text} · ${restartCost(prompt, t.model ?? 'sonnet')}` } : r
        }
        case 'release': {
          // the pane's "Open tN" (a thread blocked on an `approval`): the user answers Claude Code's permission check in the thread's OWN
          // session, so the app must be able to resume it: the idle process is stopped first (only a session in the thread folder, never
          // one that is working; stopAlive waits until it is gone) and the session id comes back for the deep link. Not offered to models.
          if (t.state !== 'open') return err(`${id} is ${t.state}: reopen it first`)
          if (!t.sid) return err(`${id} has no session to open`)
          const live = await agents(h)
          if (!live) return err(`${id}: cannot list sessions (claude agents failed), so it is not opened`)
          const row = live.find(a => a.sid === t.sid)
          if (isWorking(row)) return err(`${id} is working: not opened (the button is for a thread that stopped and waits for your yes)`)
          if (row?.waitingFor) return err(`${id} waits on a prompt of its own: not stopped (that would drop the prompt); open it from the session list in the Claude app`)
          if (row && row.pid > 0) {
            const stopped = await stopAlive(h, t, '', 'opened', { own: tpath(home, id) })
            if (stopped) return { ok: false, text: stopped.text }
          }
          return { ok: true, text: `${id} is idle`, data: { sid: t.sid } }
        }
        case 'close': {
          // never "closed" while the session may still run: list twice, and if the listing keeps failing stay "closing"
          let live: AgentRow[] | null = null
          if (t.sid) live = (await agents(h)) ?? (await agents(h))
          if (t.sid && !live) {
            t.state = 'closing'
            await save(h, home, t)
            return { ok: false, text: `${id} is closing, not closed: claude agents failed twice, so it may still run. Stop it from the Claude app, then close ${id} again.` }
          }
          t.state = 'closed'
          await revokeModelApprovals(h, id).catch(() => undefined) // an approval ends with the thread (a reopen asks again)
          await dropActions(h, id).catch(() => undefined) // and so does a request for a remote write that was never answered
          await dropGrants(h, id).catch(() => undefined) // and its standing approvals end with it
          await dropWriteGrants(h, id).catch(() => undefined) // and so do the written approvals (deskwrites.ts)
          await dropSelfEditGrants(h, id) // and the user's "let it edit itself" (selfedit.ts)
          const removed = await clearGoal(h, home, id) // a closed thread has no goal for the chaser to watch; its text is kept for a reopen's handover
          if (removed) t.lastGoal = removed
          const cleared = removed !== null
          await save(h, home, t) // nothing else to save: the reports, notes and memory are the record, and the folder is never deleted
          const lrow = (live ?? []).find(a => a.sid === t.sid)
          const head = `${id} closed${cleared ? ', goal cleared' : ''}`
          let outcome = !t.sid ? 'no session was ever started' : !lrow ? 'no session in the list (already removed)' : 'no running session (already stopped)'
          if (t.sid && lrow && (isRunning(lrow) || lrow.pid > 0)) {
            const stopId = lrow.id || t.sid.slice(0, 8)
            const st = await h.process.run(['claude', 'stop', stopId])
            if (st.exitCode !== 0) return { ok: true, text: `${head}, but claude stop ${stopId} failed: ${(st.stderr || st.stdout).trim().slice(0, 200)}. Stop it from the Claude app.` }
            outcome = 'session stopped'
          }
          // Take the stopped session out of the app's list when the CLI can (`claude rm`: it keeps the conversation and never discards
          // unpushed work, because no --discard-unpushed / --force-remove-worktree is ever passed). Only a session that lives in the thread's own
          // folder: `rm` also deletes a worktree the session was started in, and that is never ours to remove.
          const own = tpath(home, id)
          if (t.sid && lrow && (lrow.cwd === own || (!!lrow.cwd && (await realPath(h, lrow.cwd)) === (await realPath(h, own))))) { // (the listing may print the real path of a linked home)
            const rm = await h.process.run(['claude', 'rm', lrow.id || t.sid.slice(0, 8)]).catch(() => null)
            outcome += rm && rm.exitCode === 0 ? ' and removed from the app\'s list (its conversation is kept)' : `; the app keeps stopped sessions in its list${rm ? ` (claude rm: ${(rm.stderr || rm.stdout).trim().replace(/\s+/g, ' ').slice(0, 120) || `exit ${rm.exitCode}`})` : ''}`
          } else if (t.sid && lrow) outcome += "; the app keeps stopped sessions in its list"
          return { ok: true, text: `${head}; ${outcome}` }
        }
        // the goals file belongs to the mod: the desk sets or clears a thread's goal here (a thread uses lean_goal)
        case 'goal-set': {
          const text = (i.text ?? '').trim()
          if (!text) return err('goal-set needs text')
          await goalsLocked(async () => {
            const goals = await readJson<Record<string, unknown>>(h, `${leanDir(home)}/goals.json`, {})
            goals[id] = { text, ts: await h.clock.now() }
            await writeJson(h, `${leanDir(home)}/goals.json`, goals)
          })
          return { ok: true, text: `${id} goal set` }
        }
        case 'goal-clear':
          return { ok: true, text: (await clearGoal(h, home, id)) ? `${id} goal cleared` : `${id} has no goal` }
        case 'approve-push': {
          // the user said yes in the desk chat; only the desk's lean_thread reaches this. One sha, one push, two hours.
          const sha = (i.sha ?? '').trim().toLowerCase()
          if (!t.project) return err(`${id} has no project, so there is nothing to approve a push for`)
          const pj = (await readJson<Record<string, { private?: boolean }>>(h, `${leanDir(home)}/projects.json`, {}))?.[t.project]
          if (pj?.private === true) return err(`${t.project} is a private project: it is never pushed, an approval would never be used. Give the user the manual push command instead`)
          try {
            await writeApproval(h, { project: t.project, sha, thread: id, reason: (i.reason ?? '').trim().slice(0, 200) || undefined })
          } catch (e) {
            return err(String((e as Error)?.message ?? e))
          }
          await appendJsonl(h, `${tpath(home, id)}/history.jsonl`, { ts: await h.clock.now(), kind: 'approve-push', sha, project: t.project, reason: (i.reason ?? '').trim().slice(0, 200) || undefined })
          return { ok: true, text: `approved: one push of ${sha.slice(0, 8)} for ${t.project} by ${id}, valid 2 h, single use` }
        }
        case 'push':
          // the push (and an optional PR) runs here, in the desk, where the user said yes: a thread's own session never saw that yes
          // and its permission check refuses `git push`. Consumes the approval approve-push wrote (push.ts has the checks).
          return await deskPush(h, home, t, i)
        case 'park': {
          t.state = 'parked'
          await save(h, home, t)
          return { ok: true, text: `${id} parked` }
        }
        case 'reopen': {
          if (t.state === 'closing') return err(`${id} is closing, not closed: stop its session from the Claude app, close ${id} again, then reopen`)
          if (t.state !== 'closed') {
            t.state = 'open' // parked: the same session, use resume
            await save(h, home, t)
            return { ok: true, text: `${id} reopened; use resume to wake it${i.needs?.length ? ' (needs apply to a new session only: a resume keeps the session\'s settings; use start or close and reopen)' : ''}` }
          }
          const badNeeds = addNeeds(t, i.needs)
          if (badNeeds) return err(badNeeds)
          // A closed thread is never resumed: a NEW session starts in the same folder (same tN, project, worktree and branch) with a
          // handover built from brief, goal, notes, reports, remembered items and queued messages. A fresh session also runs today's code.
          t.state = 'open'
          const r = await freshSession(h, root, home, t, installed, 'It was closed and has been reopened.', i)
          if (!fresh(r)) {
            t.state = 'closed' // nothing was saved: it stays closed
            return r
          }
          return { ...r, text: `${id} reopened as a new session (old conversation kept read-only). ${r.text}` }
        }
        default:
          return err(`unknown action ${i.action}`)
      }
    })
  } catch (e) {
    return err(`lean_thread failed: ${String((e as Error)?.message ?? e).slice(0, 300)}`)
  }
}
