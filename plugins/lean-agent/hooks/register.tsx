import type { Register } from 'claude-code'

import { recordSid, resolveRole, roleReport } from './role'
import type { Role } from './role'
import { deskClaudeMd, leanThread, listAgents } from './threads'
import { limitFromUsage, limitTick, readLimit, sameReset, writeLimit } from './limits'
import { ensureGitHooks } from './githooks'
import { atomicWrite, deskDir, homeDir } from './state'
import type { Host } from './state'
import { BUSY_MAX_MS, THREAD_TOOLS, consumeWake, markDelivered, recordDeskSid, relayReports, sweep, takeBatch, takeReports, threadTool, unreadReports } from './delivery'
import { decide } from './guard'
import { VERSION, dropSetupCheck, paneRole, registerPane, resetPaneState } from './pane'
import { overBudget, record } from './budget'
import { applyFeedback, parseFeedback } from './feedback'
import { capLine, checkStale, logRuleLoad, rulesUpdateCheck } from './rules'
import { markNative, projectRule, resetContext, resetRuleLoader, ruleContext } from './ruleload'
import { leanDir, readJson, threadsDir } from './state'
import { chase } from './chaser'
import { autoMigrate, check, guardParents, migrate } from './doctor'
import { mcpRows, setSettingsEnv } from './mcpenv'
import { bounded, setupFix, setupText } from './setup'
import { squeezeResult, trimTools } from './squeeze'
import { readConfig } from './budget'
import { hostOf } from './host'
import { resetSkillStat, isMcpInstructions, isSkillAttachment, noteAttachment, noteSection, skillsSeen, trimListing } from './skilltrim'
import { parseGrants, recordGrant, releaseGrant } from './guard'
import { memorySection, recordAnswer, runSchedule, writeCompactNotes } from './extras'
import { resetSkew, setRunning, skewNote } from './skew'
import { statsText } from './stats'
import { compare } from './compare'
import { announceRotation, rotateLedger } from './ledger'
import { takeNotice } from './notices'
import { SCRIPT_SPEC, SCRIPT_TOOL, auditFromReply, bashFailed, doneQuestion, noteBash, noteUse, noteWrite, resetScripts, scriptTool, takeNudges } from './scripts'
import { syncWithScripts } from './rulelines'
import { exportFeedback, logRefusal } from './feedbackexport'
import { contextSize, deskTick, enter, forgetContext, hasUsage, isPush, noteReported, noteUsage, resetCheckpoints, sweepCheckpoints, takeAsk, turnEnded, turnStarted } from './checkpoint'
import { deferOutside, noteToolUse, readLoaded } from './profile'
import type { Loaded } from './profile'

setRunning(VERSION) // the code in this session; skew.ts compares it with what is installed

export { hostOf }

let notified = 0
let grantSeq = 0
let busySince = 0 // ms the desk's main turn started (0 = idle): the report relay never starts a turn over a running one
let lastRelay = 0
export const resetModState = () => {
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
  resetSkillStat()
  resetSkew()
  skew = null
  resetScripts()
  resetCheckpoints()
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
const DOCTOR_SCHEMA = { type: 'object', properties: { action: { type: 'string', enum: ['check', 'fix', 'migrate', 'stats', 'compare', 'export', 'mcp-env'] }, name: { type: 'string', description: 'mcp-env: the variable name (e.g. DD_MCP_DOMAIN); never a secret' }, value: { type: 'string', description: 'mcp-env: its NON-secret value (a site or domain); without name and value the action lists the MCP servers that need one' }, replace: { type: 'boolean', description: 'mcp-env: true ONLY when the user asked to change a value that is already set' }, days: { type: 'number', description: 'stats: days back (default 7, max 90)' }, project: { type: 'string', description: "stats: only this project's rules; compare: the registered project" }, mode: { type: 'string', enum: ['overhead', 'history'], description: 'compare: overhead (default, cheap) or history' }, notes: { type: 'string', description: 'export: free text for a Notes section at the top' } }, required: ['action'] }
const TOOL = 'lean_thread'
const SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['new', 'send', 'wake', 'close', 'park', 'reopen', 'list', 'resume', 'start', 'projects', 'project-add', 'project-remove', 'project-private', 'profile', 'goal-set', 'goal-clear', 'approve-push'] },
    tN: { type: 'string', description: 'thread id, like t3 (every action except new, list and project-*)' },
    text: { type: 'string', description: 'new: the brief; send: the message; goal-set: the goal line' },
    title: { type: 'string', description: 'new: short title' },
    project: { type: 'string', description: 'new / project-*: a registered project (see projects)' },
    sha: { type: 'string', description: 'approve-push: the full commit sha the user approved pushing (only after the user said so in the chat)' },
    reason: { type: 'string', description: 'approve-push: why, in a few words' },
    model: { type: 'string', enum: ['haiku', 'sonnet', 'opus'], description: 'new/start: default sonnet' },
    effort: { type: 'string', enum: ['low', 'medium', 'high'], description: 'new/start: default high' },
    path: { type: 'string', description: 'project-add: folder (must exist)' },
    on: { type: 'boolean', description: 'project-private: true or false; profile: false removes the project profile' },
    needs: { type: 'array', items: { type: 'string' }, description: 'new/start/reopen: MCP servers or plugins this thread needs on top of its project profile (e.g. ["azure-devops"]); this thread only. Everything else stays deferred' },
    mcp: { type: 'array', items: { type: 'string' }, description: 'profile: the MCP servers the project loads (allow-list; others are deferred, still found by ToolSearch)' },
    plugins: { type: 'array', items: { type: 'string' }, description: 'profile: the plugins the project loads (allow-list; skill-only plugins outside it are off)' },
    fill: { type: 'boolean', description: 'profile: add the servers and plugins the project\'s threads actually used' },
    all: { type: 'boolean', description: 'projects: include private ones hidden by the private switch' },
    confirm: { type: 'boolean', description: 'project-private off: only after the user agreed' },
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

// is any subagent of this session still listed as pending or running (checkpoints never start over one)? An unreadable list counts as running.
const agentsIdle = ($: any) => async (): Promise<boolean> => {
  const l = await $.agent.list()
  return !(Array.isArray(l) ? l : []).some((a: any) => a?.status === 'pending' || a?.status === 'running')
}

// a worker's reply ends with LEAN-FEEDBACK: gaps and memory go to the files, the thread's own turn is unchanged
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
async function registerOnce($: any, spec: any): Promise<void> {
  if (registered.has(spec.name)) return
  await $.tool.register(spec as any)
  registered.add(spec.name)
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
      // (lean_profile is used once per learn run: behind ToolSearch, so it adds nothing to a thread's first turn)
      for (const t of THREAD_TOOLS) await registerOnce($, { ...t, isDeferred: t.name === 'lean_profile' })
      await registerOnce($, { ...SCRIPT_SPEC, isDeferred: false })
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
          'Manage lean-agent threads (background sessions): new, send, wake, close, park, reopen, list, resume, start (new/start/reopen take needs: MCP servers or plugins that thread needs on top of its project profile); and projects: projects (list), project-add, project-remove (unregister only), project-private, profile (a project\'s MCP/plugin allow-list: show, set mcp/plugins, fill from usage, on: false removes); goals: goal-set, goal-clear (tN). A send to a running thread is only queued; an idle one is woken once.',
        inputSchema: SCHEMA,
        isDeferred: false,
      } as any)
      await registerOnce($, {
        name: DOCTOR,
        description: 'lean-agent doctor: check (read-only report), fix (desk folder, login opener, trust), migrate (0.45 state -> 1.0, closes old threads; idempotent), stats (spend by model/role/agent/thread, caps, rule loads, feedback: computed here, never read the ledger yourself), compare (what a session costs at start: clean vs thread vs desk, from a few one-turn runs; project required; mode history lists saved reports), export (write ONE anonymised feedback file, print its path; never posts), mcp-env (an MCP server needs a variable such as a site: with name + a NON-secret value it writes the env block of ~/.claude/settings.json so every session gets it; secret-looking names are refused; without them it lists the servers that need one).',
        inputSchema: DOCTOR_SCHEMA,
        isDeferred: false,
      } as any)
      await registerOnce($, { ...SCRIPT_SPEC, isDeferred: false })
    })
    await step('desk timers', async () => {
      every($, 10_000, 'desk', async host2 => {
        await ensureGitHooks(host2).catch(() => undefined) // watch: projects.json may change behind the mod's back
        // a thread that checkpointed (context grew large) continues in a fresh session; before the wake sweep, which would resume the old one
        await sweepCheckpoints(host2, id => leanThread(host2, $.plugin.root, { action: 'checkpoint', tN: id })).catch(() => undefined)
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
      // the desk's own context: idle and over config checkpoint.deskTokens it compacts itself (fixed instructions); when that is not
      // possible it writes desk/handover.md and says so in the status line (checkpoint.ts)
      every($, 30_000, 'desk', async host2 => {
        const now = await host2.clock.now()
        const user = async (): Promise<string[]> => {
          const m: any = await $.session.messages({ last: 40 })
          return (Array.isArray(m) ? m : []).filter((x: any) => x?.role === 'user' && typeof x.text === 'string' && x.text.trim() && !x.text.startsWith('[lean-agent]')).slice(-6).map((x: any) => x.text as string)
        }
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
          recent: user,
          status: text => $.ui.status(text),
          reset: forgetContext,
        })
        if (out !== 'quiet') $.ui.log(`lean-agent: desk context: ${out}`, { to: 'debug' })
      })
      // scheduled sends: due lines of scheduled.jsonl go to their thread while the desk runs
      every($, 30_000, 'desk', async host2 => void (await runSchedule(host2, (id, text) => leanThread(host2, $.plugin.root, { action: 'send', tN: id, text }))))
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
    if (r.kind === 'thread') await recordSid(host, r.id, lastSid).catch(() => false)
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // $ is only ever spelled $.noun.event(...): the helpers get this thin host instead of $ itself
    const host = hostOf($)
    resetModState()
    const root = await bounded($, Promise.resolve($.session.root()), 'session.root').catch(() => '')
    const ctx = await serial(() => settle($, host, e.cwd, typeof root === 'string' ? root : ''))
    await showSkew($)
    // the ledger grows with every model request: a past month (or a file that starts with a 0.45 row) is renamed away, never rewritten
    let rotated: string[] = []
    await soft($, 'ledger rotation', async () => { rotated = await rotateLedger(host) })
    if (rotated.length) await announceRotation(host, rotated) // any session may rotate: the notice is what the desk reads
    if (role.kind === 'desk') {
      // the desk's next prompt says so once, whichever session did it (the pane lists the notice until then)
      const said = await takeNotice(host, 'ledger-rotation')
      if (said) pending.push(`[lean-agent] ${said}`)
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
    await $.command.register({ name: 'lean-agent-feedback', description: 'Write ONE anonymised feedback export file and print its path (never posts); optional notes as the argument' }).catch(() => undefined)
    await $.command.register({ name: 'lean-agent-setup', description: 'Set up or repair lean-agent (desk folder, login opener, trust); no model turn needed' }).catch(() => undefined)
    // what the role setup has to say (stale or over-cap rules): `session.start` carries no context, so it goes with the first prompt
    if (ctx.length) pending.push(...ctx)
    return next(e)
  })

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
    await redetect($)
    if (role.kind === 'thread' && !e.agentId) await turnStarted(hostOf($), role.id).catch(() => undefined) // work after a ready checkpoint withdraws it
    await showSkew($)
    return next(e)
  })
  on('turn.complete', async ($, e: any, next) => {
    if (!e.agentId) busySince = 0
    // a thread's turn that died on an API error: if a rate-limit window is spent, keep its reset for the desk's resume
    if (role.kind === 'thread' && !e.agentId && e.reason === 'error') await noteLimit($, role.id).catch(() => undefined)
    // a thread that was told to checkpoint: the turn's end is the moment the desk may start its fresh session (or one reminder turn)
    if (role.kind === 'thread' && !e.agentId) {
      const id = role.id
      await turnEnded(hostOf($), id, { reason: e.reason, sid: lastSid, submit: text => $.prompt.submit({ text }), idle: agentsIdle($) }).catch(() => undefined)
    }
    return next(e)
  })

  // every model request: refuse past a cap, then price its usage into ledger.jsonl
  on('turn.step', async function* ($, e: any, next) {
    const host = hostOf($)
    const type = e.agentId ? await agentType($, e.agentId, e) : undefined
    const why = await overBudget(host, role.kind, e.agentId ? { type, spent: spent.get(e.agentId) ?? 0 } : null).catch(() => null)
    if (why) return { turnId: e.turnId, index: e.index, answer: why, toolUses: [], stopReason: 'end_turn', usage: null } as any
    const r: any = yield* next(e)
    if (!e.agentId) noteUsage(r?.usage) // the main loop's context size, for the checkpoints (checkpoint.ts)
    try {
      const row = await record(host, { role: role.kind, tN: role.kind === 'thread' ? role.id : undefined, agentId: e.agentId, agent: type, ...(role.kind === 'thread' ? { effort: started.effort, tmodel: started.model } : {}) }, r?.usage?.model ?? e.model, r?.usage)
      if (row && e.agentId) spent.set(e.agentId, (spent.get(e.agentId) ?? 0) + row.usd)
    } catch {
      /* a ledger write that fails never stops the turn */
    }
    return r
  })

  registerPane(on, () => role)

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
    if (role.kind !== 'desk') {
      skillsSeen(type, `not the desk (role ${role.kind}): untouched`)
      return r
    }
    const t = trimListing(r.text)
    skillsSeen(type, t.reason)
    return t.text === null ? r : { ...r, text: t.text }
  }).catch(($, e: any, next) => next(e))

  // a build may list skills in the Skill tool's description instead: same filter, same safety rule
  on('tool.describe', { tool: 'Skill' }, async ($, e: any, next) => {
    const r: any = await next(e)
    if (role.kind !== 'desk' || typeof r?.description !== 'string') return r
    const t = trimListing(r.description)
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

  on('tool.call', { tool: `mcp__lean-agent__${TOOL}` }, async ($, e: any) => {
    if (role.kind !== 'desk') await redetect($, undefined, true)
    if (role.kind !== 'desk') return { result: await roleReport(hostOf($), { tool: e.tool.replace('mcp__lean-agent__', ''), need: 'desk', role, startDir, sid: lastSid }), isError: true } as any
    const host = hostOf($)
    // a session reads its parent folders' CLAUDE.md BEFORE the mod runs: a stale guide above the threads is cleared before a start
    if (['new', 'start', 'reopen', 'resume', 'wake', 'send'].includes(String(e.action))) await guardParents(host).catch(() => [])
    const out = await leanThread(host, $.plugin.root, e)
    await ensureGitHooks(host).catch(() => undefined)
    if (out.ok && e.action === 'send' && typeof e.tN === 'string' && typeof e.text === 'string') await recordAnswer(host, e.tN, e.text).catch(() => undefined)
    return { result: out.text, ...(out.ok ? {} : { isError: true as const }) } as any
  })

  // scripts over models: thread and desk (propose is a thread's, decide the desk's; scripts.ts checks per action)
  on('tool.call', { tool: `mcp__lean-agent__${SCRIPT_TOOL}` }, async ($, e: any) => {
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
    if (role.kind === 'thread' && r?.deny === undefined) noteWrite(e.file_path)
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

  on('tool.call', { tool: `mcp__lean-agent__${DOCTOR}` }, async ($, e: any) => {
    if (role.kind !== 'desk') await redetect($, undefined, true)
    if (role.kind !== 'desk') return { result: await roleReport(hostOf($), { tool: 'lean_doctor', need: 'desk', role, startDir, sid: lastSid }), isError: true } as any
    const host = hostOf($)
    try {
      await ensureGitHooks(host).catch(() => undefined)
      if (e.action === 'check') return { result: (await check(host, $.plugin.root)).join('\n') } as any
      if (e.action === 'fix') {
        const o = await setupFix(host, $.plugin.root)
        dropSetupCheck()
        return { result: setupText(o, true) } as any
      }
      if (e.action === 'migrate') return { result: (await migrate(host, $.plugin.root)).lines.join('\n') } as any
      if (e.action === 'stats') return { result: await statsText(host, { days: e.days, project: typeof e.project === 'string' && e.project ? e.project : undefined }) } as any
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
      return { result: 'doctor: action must be check, fix, migrate, stats, compare, export or mcp-env', isError: true } as any
    } catch (err) {
      return { result: `doctor failed: ${String((err as Error)?.message ?? err)}`, isError: true } as any
    }
  })

  for (const t of THREAD_TOOLS) {
    on('tool.call', { tool: `mcp__lean-agent__${t.name}` }, async ($, e: any) => {
      if (role.kind !== 'thread') await redetect($, undefined, true) // a stale role never refuses: look once more (session id, folder)
      if (role.kind !== 'thread') return { result: await roleReport(hostOf($), { tool: t.name, need: 'thread', role, startDir, sid: lastSid }), isError: true } as any
      // lean_compare needs the plugin root (the thread-shaped folder's CLAUDE.md, --plugin-dir for a dev copy): answered here
      const out = t.name === 'lean_compare'
        ? await compare(hostOf($), $.plugin.root, { project: str(e.project) || str((await readJson<{ project?: string }>(hostOf($), `${threadsDir(await homeDir(hostOf($)))}/${role.id}/thread.json`, {})).project), mode: str(e.mode) || 'task', task: typeof e.task === 'string' ? e.task : '', model: str(e.model) || undefined, maxUsd: typeof e.maxUsd === 'number' ? e.maxUsd : undefined }, 'thread')
        // every other tool: a done / blocked report and every question also goes straight to the desk's session (the inbox keeps it either way)
        : await threadTool(hostOf($), role.id, t.name, e, (sid, text) => $.session.send({ to: { sessionId: sid }, text }))
      await ensureGitHooks(hostOf($)).catch(() => undefined) // lean_* tools may change projects.json
      // a thread that reports done is asked once per session whether a step could have been a script (never a worker's call)
      const ask = t.name === 'lean_report' && out.ok && e.state === 'done' && !e.agentId ? doneQuestion(role.id) : null
      // a checkpoint report: the mod notes it (the turn's end makes it ready for the desk) and tells the thread to stop
      const ck = t.name === 'lean_report' && out.ok && e.state === 'checkpoint' && !e.agentId ? await noteReported(hostOf($), role.id).catch(() => '') : ''
      return { result: [out.text, ask, ck].filter(Boolean).join('\n'), ...(out.ok ? {} : { isError: true as const }) } as any
    })
  }

  // desk: a thread's direct message (this plugin's own `$.session.send`) arrived, so its inbox row is delivered and the next prompt
  // does not hand it over again. Everything is passed on unchanged.
  on('session.receive', async ($, e: any, next) => {
    if (role.kind === 'desk' && e?.origin?.plugin === 'lean-agent' && typeof e.text === 'string') await markDelivered(hostOf($), e.text).catch(() => false)
    return next(e)
  }).catch(($, e: any, next) => next(e))

  // every tool: guards first (fail closed), then delivery of queued messages to a busy session
  on('tool.call', async ($, e: any, next) => {
    const host = hostOf($)
    const atype = await agentType($, e.agentId, e)
    const why = await decide(host, { role, cwd, agentType: atype, agentId: e.agentId, version: VERSION }, e)
    if (why) {
      await logRefusal(host, { text: why, agent: atype, tool: e.tool, thread: role.kind === 'thread' ? role.id : undefined, version: VERSION }).catch(() => undefined) // for the feedback export
      return { deny: why } as any
    }
    // the thread's grants for the worker it spawns: recorded while the Agent call runs, removed when it returns
    const g = role.kind === 'thread' && !e.agentId && (e.tool === 'Agent' || e.tool === 'Task') ? parseGrants(e.prompt) : null
    const gcall = g && (g.edit?.length || g.cmds?.length) ? String(e.toolUseId ?? `g${++grantSeq}`) : ''
    if (gcall) await recordGrant(host, role, gcall, typeof e.subagent_type === 'string' ? e.subagent_type : undefined, g!)
    // a main-loop subagent or push in flight: no checkpoint instruction comes while it runs
    const left = role.kind === 'thread' && !e.agentId ? ((e.tool === 'Agent' || e.tool === 'Task') ? enter('agent') : e.tool === 'Bash' && isPush(e.command) ? enter('push') : null) : null
    let r: any
    try {
      r = await next(e)
    } finally {
      left?.()
      if (gcall) await releaseGrant(host, role, gcall).catch(() => undefined)
    }
    await feedbackOf(host, e, r).catch(() => undefined)
    // a script auditor's LEAN-AUDIT line: the mod records the verdict (and tells the thread what the rules made of it)
    if (role.kind === 'thread' && !e.agentId && (e.tool === 'Agent' || e.tool === 'Task') && r?.deny === undefined && /^(lean-agent:)?auditor$/.test(String(e.subagent_type ?? ''))) {
      const said = await auditFromReply(host, role.id, texts(r?.result).join('\n'), String(e.prompt ?? '')).catch(() => null)
      if (said) r = { ...r, context: [...(r.context ?? []), said] }
    }
    // the thread's usage counter: which MCP servers and skills it really called (names and counts, never arguments); a worker's
    // call counts for the thread. This is what a project profile is learned from.
    if (role.kind === 'thread' && r?.deny === undefined) await noteToolUse(host, role.id, String(e.tool ?? ''), e).catch(() => false)
    // learned rules for a thread and its subagents: the engine loads them only beneath the session root, so the mod appends the rules
    // whose `paths:` match the files this call touches, once per context (ruleload.ts)
    if (role.kind === 'thread' && r?.deny === undefined) {
      try {
        const text = await ruleContext(host, { session: lastSid, agent: typeof e.agentId === 'string' ? e.agentId : '', thread: role.id }, String(e.tool ?? ''), e, { threadProject: await threadProject(host), engineRoot: seenRoot })
        if (text) r = { ...r, context: [...(r?.context ?? []), text] }
      } catch {
        /* rules are optional: the tool result goes through unchanged */
      }
    }
    // (below, for the main loop only: the desk's batch, then the checkpoint instruction: one order, each at most once per call)
    if (e.agentId || r?.deny !== undefined) return r
    const lines: string[] = []
    try {
      const batch = role.kind === 'thread' ? await takeBatch(host, role.id) : role.kind === 'desk' ? await takeReports(host) : null
      if (batch) lines.push(batch)
    } catch {
      /* delivery is retried at the next call */
    }
    try {
      // the context is over config checkpoint.threadTokens: ONE instruction, at this tool boundary
      // (not on the result of lean_report / lean_ask: a thread that just reported done or blocked, or asked the desk, is not told to
      // checkpoint in the same breath: it would restart a finished thread; the next boundary carries it)
      const ask = role.kind === 'thread' && !/lean_(report|ask)$/.test(String(e.tool ?? '')) ? await takeAsk(host, role.id, agentsIdle($)) : null
      if (ask) lines.push(ask)
    } catch {
      /* asked again at the next call */
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
    let extra: string | null = pending.length ? pending.splice(0).join('\n') : null
    try {
      let more: string | null = null
      if (role.kind === 'thread') more = (await consumeWake(host, role.id, e.text)) ? null : await takeBatch(host, role.id)
      else if (role.kind === 'desk') more = await takeReports(host)
      if (more) extra = extra ? `${extra}\n${more}` : more
      const nudge = role.kind === 'thread' ? await takeNudges(host) : null
      if (nudge) extra = extra ? `${extra}\n${nudge}` : nudge
      const ckAsk = role.kind === 'thread' ? await takeAsk(host, role.id, agentsIdle($)) : null // (a wake prompt over a large context is a boundary too)
      if (ckAsk) extra = extra ? `${extra}\n${ckAsk}` : ckAsk
    } catch {
      /* the prompt goes through without it */
    }
    return next(extra ? { ...e, context: [...(e.context ?? []), extra] } : e)
  })
}
