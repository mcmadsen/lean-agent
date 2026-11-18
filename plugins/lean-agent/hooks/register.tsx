import type { Register } from 'claude-code'

import { recordSid, resolveRole, roleReport } from './role'
import type { Role } from './role'
import { deskClaudeMd, leanThread } from './threads'
import { ensureGitHooks } from './githooks'
import { atomicWrite, deskDir, homeDir } from './state'
import type { Host } from './state'
import { BUSY_MAX_MS, THREAD_TOOLS, consumeWake, relayReports, sweep, takeBatch, takeReports, threadTool, unreadReports } from './delivery'
import { decide } from './guard'
import { dropSetupCheck, paneRole, registerPane, resetPaneState } from './pane'
import { overBudget, record } from './budget'
import { applyFeedback, parseFeedback } from './feedback'
import { checkStale, syncRules } from './rules'
import { leanDir, readJson, threadsDir } from './state'
import { chase } from './chaser'
import { autoMigrate, check, migrate } from './doctor'
import { bounded, setupFix, setupText } from './setup'
import { squeezeResult, trimTools } from './squeeze'
import { readConfig } from './budget'
import { hostOf } from './host'
import { resetSkillStat, isMcpInstructions, isSkillAttachment, noteAttachment, noteSection, skillsSeen, trimListing } from './skilltrim'
import { parseGrants, recordGrant, releaseGrant } from './guard'
import { memorySection, recordAnswer, runSchedule, writeCompactNotes } from './extras'

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
  resetPaneState()
  resetSkillStat()
}
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
const DOCTOR_SCHEMA = { type: 'object', properties: { action: { type: 'string', enum: ['check', 'fix', 'migrate'] } }, required: ['action'] }
const TOOL = 'lean_thread'
const SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['new', 'send', 'wake', 'close', 'park', 'reopen', 'list', 'resume', 'start', 'projects', 'project-add', 'project-remove', 'project-private', 'goal-set', 'goal-clear', 'approve-push'] },
    tN: { type: 'string', description: 'thread id, like t3 (every action except new, list and project-*)' },
    text: { type: 'string', description: 'new: the brief; send: the message; goal-set: the goal line' },
    title: { type: 'string', description: 'new: short title' },
    project: { type: 'string', description: 'new / project-*: a registered project (see projects)' },
    sha: { type: 'string', description: 'approve-push: the full commit sha the user approved pushing (only after the user said so in the chat)' },
    reason: { type: 'string', description: 'approve-push: why, in a few words' },
    model: { type: 'string', enum: ['haiku', 'sonnet', 'opus'], description: 'new/start: default sonnet' },
    effort: { type: 'string', enum: ['low', 'medium', 'high'], description: 'new/start: default high' },
    path: { type: 'string', description: 'project-add: folder (must exist)' },
    on: { type: 'boolean', description: 'project-private: true or false' },
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

// a worker's reply ends with LEAN-FEEDBACK: gaps and memory go to the files, the thread's own turn is unchanged
async function feedbackOf(host: Host, e: any, r: any): Promise<void> {
  if (e.agentId || (e.tool !== 'Agent' && e.tool !== 'Task') || r?.deny !== undefined) return
  const texts = (v: any): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(texts) : v && typeof v === 'object' ? Object.values(v).flatMap(texts) : [])
  const fb = parseFeedback(texts(r?.result).join('\n'))
  if (!fb) return
  let project: string | undefined
  if (role.kind === 'thread') project = (await readJson<{ project?: string }>(host, `${threadsDir(await homeDir(host))}/${role.id}/thread.json`, {})).project
  await applyFeedback(host, { thread: role.kind === 'thread' ? role.id : undefined, project, agent: String(e.subagent_type ?? e.agent ?? '') || undefined }, fb)
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
    await step('thread tools', async () => {
      for (const t of THREAD_TOOLS) await registerOnce($, { ...t, isDeferred: false })
    })
  }
  await step('0.45 migration check', () => autoMigrate(host, $.plugin.root)) // leftover 0.45 service: unloaded at once, then the idempotent migrate
  if (newRole.kind === 'desk' || newRole.kind === 'thread') await step('git hooks', () => ensureGitHooks(host))
  if (newRole.kind === 'desk') {
    await step('desk tools', async () => {
      await registerOnce($, {
        name: TOOL,
        description:
          'Manage lean-agent threads (background sessions): new, send, wake, close, park, reopen, list, resume, start; and projects: projects (list), project-add, project-remove (unregister only), project-private; goals: goal-set, goal-clear (tN). A send to a running thread is only queued; an idle one is woken once.',
        inputSchema: SCHEMA,
        isDeferred: false,
      } as any)
      await registerOnce($, {
        name: DOCTOR,
        description: 'lean-agent doctor: check (read-only report), fix (desk folder, login opener, trust), migrate (0.45 state -> 1.0, closes old threads; idempotent).',
        inputSchema: DOCTOR_SCHEMA,
        isDeferred: false,
      } as any)
    })
    await step('desk timers', async () => {
      every($, 10_000, 'desk', async host2 => {
        await ensureGitHooks(host2).catch(() => undefined) // watch: projects.json may change behind the mod's back
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
    try {
      const th = await readJson<{ project?: string }>(host, `${threadsDir(await homeDir(host))}/${newRole.id}/thread.json`, {})
      const projs = await readJson<Record<string, { path?: string }>>(host, `${leanDir(await homeDir(host))}/projects.json`, {})
      const repo = th.project ? projs?.[th.project]?.path : undefined
      if (th.project && typeof repo === 'string' && repo.startsWith('/')) {
        await syncRules(host, th.project, repo)
        const stale = await checkStale(host, th.project, repo)
        if (stale.length && !noticed.has(newRole.id)) {
          noticed.add(newRole.id)
          ctx.push(`[lean-agent] ${stale.join('; ')}`)
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // $ is only ever spelled $.noun.event(...): the helpers get this thin host instead of $ itself
    const host = hostOf($)
    resetModState()
    const root = await bounded($, Promise.resolve($.session.root()), 'session.root').catch(() => '')
    const ctx = await serial(() => settle($, host, e.cwd, typeof root === 'string' ? root : ''))
    // the command is role-free: registered once here
    await $.command.register({ name: 'lean-agent', description: 'Open the lean-agent pane (setup, desk, threads)' }).catch(() => undefined)
    await $.command.register({ name: 'lean-agent-setup', description: 'Set up or repair lean-agent (desk folder, login opener, trust); no model turn needed' }).catch(() => undefined)
    if (ctx.length) return next({ ...e, context: [...((e as any).context ?? []), ...ctx] } as any)
    return next(e)
  })

  // the app moves a pre-started session from a spare folder into the user's folder: the role is decided again
  on('classic.CwdChanged', async ($, e: any, next) => {
    await redetect($, typeof e?.new_cwd === 'string' ? e.new_cwd : undefined)
    return next(e)
  })
  // fallback when the hook is not delivered: a cheap compare of the session's directory
  on('turn.start', async ($, e: any, next) => {
    if (!e.agentId) busySince = (await $.clock.now()) || 1
    await redetect($)
    return next(e)
  })
  on('turn.complete', async ($, e: any, next) => {
    if (!e.agentId) busySince = 0
    return next(e)
  })

  // every model request: refuse past a cap, then price its usage into ledger.jsonl
  on('turn.step', async function* ($, e: any, next) {
    const host = hostOf($)
    const type = e.agentId ? await agentType($, e.agentId, e) : undefined
    const why = await overBudget(host, role.kind, e.agentId ? { type, spent: spent.get(e.agentId) ?? 0 } : null).catch(() => null)
    if (why) return { turnId: e.turnId, index: e.index, answer: why, toolUses: [], stopReason: 'end_turn', usage: null } as any
    const r: any = yield* next(e)
    try {
      const row = await record(host, { role: role.kind, tN: role.kind === 'thread' ? role.id : undefined, agentId: e.agentId, agent: type }, r?.usage?.model ?? e.model, r?.usage)
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
    const out = await leanThread(host, $.plugin.root, e)
    await ensureGitHooks(host).catch(() => undefined)
    if (out.ok && e.action === 'send' && typeof e.tN === 'string' && typeof e.text === 'string') await recordAnswer(host, e.tN, e.text).catch(() => undefined)
    return { result: out.text, ...(out.ok ? {} : { isError: true as const }) } as any
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
      return { result: 'doctor: action must be check, fix or migrate', isError: true } as any
    } catch (err) {
      return { result: `doctor failed: ${String((err as Error)?.message ?? err)}`, isError: true } as any
    }
  })

  for (const t of THREAD_TOOLS) {
    on('tool.call', { tool: `mcp__lean-agent__${t.name}` }, async ($, e: any) => {
      if (role.kind !== 'thread') await redetect($, undefined, true) // a stale role never refuses: look once more (session id, folder)
      if (role.kind !== 'thread') return { result: await roleReport(hostOf($), { tool: t.name, need: 'thread', role, startDir, sid: lastSid }), isError: true } as any
      const out = await threadTool(hostOf($), role.id, t.name, e)
      await ensureGitHooks(hostOf($)).catch(() => undefined) // lean_* tools may change projects.json
      return { result: out.text, ...(out.ok ? {} : { isError: true as const }) } as any
    })
  }

  // every tool: guards first (fail closed), then delivery of queued messages to a busy session
  on('tool.call', async ($, e: any, next) => {
    const host = hostOf($)
    const why = await decide(host, { role, cwd, agentType: await agentType($, e.agentId, e), agentId: e.agentId }, e)
    if (why) return { deny: why } as any
    // the thread's grants for the worker it spawns: recorded while the Agent call runs, removed when it returns
    const g = role.kind === 'thread' && !e.agentId && (e.tool === 'Agent' || e.tool === 'Task') ? parseGrants(e.prompt) : null
    const gcall = g && (g.edit?.length || g.cmds?.length) ? String(e.toolUseId ?? `g${++grantSeq}`) : ''
    if (gcall) await recordGrant(host, role, gcall, typeof e.subagent_type === 'string' ? e.subagent_type : undefined, g!)
    let r: any
    try {
      r = await next(e)
    } finally {
      if (gcall) await releaseGrant(host, role, gcall).catch(() => undefined)
    }
    await feedbackOf(host, e, r).catch(() => undefined)
    if (e.agentId || r?.deny !== undefined) return r
    try {
      const batch = role.kind === 'thread' ? await takeBatch(host, role.id) : role.kind === 'desk' ? await takeReports(host) : null
      if (batch) return { ...r, context: [...(r.context ?? []), batch] }
    } catch {
      /* delivery is retried at the next call */
    }
    return r
  }).catch(($, e: any, next) => (next.called ? next(e) : { deny: 'lean-agent guard failed' }))

  // memory: the project's saved facts as a short session section for a thread and its workers
  on('prompt.compose', async ($, e: any, next) => {
    const r: any = await next(e)
    try {
      const text = await memorySection(hostOf($), role)
      if (text && r?.sections) return { ...r, sections: [...r.sections, { id: 'lean-agent:memory', text, scope: 'session' }] }
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
    return next(e)
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
    } catch {
      /* the prompt goes through without it */
    }
    return next(extra ? { ...e, context: [...(e.context ?? []), extra] } : e)
  })
}
