import type { Register } from 'claude-code'

import { detectRole } from './role'
import type { Role } from './role'
import { deskClaudeMd, leanThread } from './threads'
import { atomicWrite, deskDir, homeDir } from './state'
import type { Host } from './state'
import { THREAD_TOOLS, consumeWake, sweep, takeBatch, takeReports, threadTool, unreadReports } from './delivery'
import { decide } from './guard'
import { paneStart, registerPane } from './pane'
import { overBudget, record } from './budget'
import { applyFeedback, parseFeedback } from './feedback'
import { checkStale, syncRules } from './rules'
import { readJson, threadsDir } from './state'
import { chase } from './chaser'
import { check, fix, migrate } from './doctor'
import { squeezeResult, trimTools } from './squeeze'
import { readConfig } from './budget'

let notified = 0
let role: Role = { kind: 'plain' }
export const currentRole = () => role

const DOCTOR = 'lean_doctor'
const DOCTOR_SCHEMA = { type: 'object', properties: { action: { type: 'string', enum: ['check', 'fix', 'migrate'] } }, required: ['action'] }
const TOOL = 'lean_thread'
const SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['new', 'send', 'wake', 'close', 'park', 'reopen', 'list', 'resume', 'start'] },
    tN: { type: 'string', description: 'thread id, like t3 (every action except new and list)' },
    text: { type: 'string', description: 'new: the brief; send: the message' },
    title: { type: 'string', description: 'new: short title' },
    project: { type: 'string', description: 'new: project name' },
  },
  required: ['action'],
}


// $ is only ever spelled $.noun.event(...): the helpers get this thin host instead of $ itself
export function hostOf($: any): Host {
  return {
    fs: {
      read: (p: string) => $.fs.read(p),
      write: (p: string, t: string) => $.fs.write(p, t),
      exists: (p: string) => $.fs.exists(p),
      list: (p?: string) => $.fs.list(p),
      stat: (p: string, o?: { resolve?: boolean }) => $.fs.stat(p, o?.resolve ? { resolve: true } : undefined),
    },
    process: { run: (argv: readonly string[], init?: any) => $.process.run(argv, init) },
    env: { get: () => $.env.get('HOME') }, // the only variable the mod reads (the engine wants it as a literal)
    clock: { now: () => $.clock.now() },
  }
}

let cwd = ''
async function agentType($: any, id?: string): Promise<string | undefined> {
  if (!id) return undefined
  try {
    const l = await $.agent.list()
    return (l as any[]).find(a => a.id === id)?.subagentType ?? 'unknown'
  } catch {
    return 'unknown' // a subagent of unknown type gets no special grant
  }
}

const spent = new Map<string, number>() // usd per subagent id, this session

// a worker's reply ends with LEAN-FEEDBACK: gaps and memory go to the files, the thread's own turn is unchanged
async function feedbackOf(h: Host, e: any, r: any): Promise<void> {
  if (e.agentId || (e.tool !== 'Agent' && e.tool !== 'Task') || r?.deny !== undefined) return
  const texts = (v: any): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(texts) : v && typeof v === 'object' ? Object.values(v).flatMap(texts) : [])
  const fb = parseFeedback(texts(r?.result).join('\n'))
  if (!fb) return
  let project: string | undefined
  if (role.kind === 'thread') project = (await readJson<{ project?: string }>(h, `${threadsDir(await homeDir(h))}/${role.id}/thread.json`, {})).project
  await applyFeedback(h, { thread: role.kind === 'thread' ? role.id : undefined, project, agent: String(e.subagent_type ?? e.agent ?? '') || undefined }, fb)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // $ is only ever spelled $.noun.event(...): the helpers get this thin host instead of $ itself
    const h = hostOf($)
    role = await detectRole(h, e.cwd)
    cwd = e.cwd
    if (role.kind === 'thread') {
      for (const t of THREAD_TOOLS) await $.tool.register({ ...t, isDeferred: false } as any)
    }
    if (role.kind === 'desk') {
      await $.tool.register({
        name: TOOL,
        description:
          'Manage lean-agent threads (background sessions): new, send, wake, close, park, reopen, list, resume, start. A send to a running thread is only queued; an idle one is woken once.',
        inputSchema: SCHEMA,
        isDeferred: false,
      })
      await $.tool.register({
        name: DOCTOR,
        description: 'lean-agent doctor: check (read-only report), fix (desk folder, login opener, trust), migrate (0.45 state -> 1.0, closes old threads; idempotent).',
        inputSchema: DOCTOR_SCHEMA,
        isDeferred: false,
      })
      const timer = $.clock.every(10_000, async () => {
        try {
          const h2 = hostOf($)
          await sweep(h2, id => leanThread(h2, $.plugin.root, { action: 'wake', tN: id }))
          const n = (await unreadReports(h2)).recs.length
          if (n && n !== notified) $.ui.notify(`${n} unread report(s) from threads`, { key: 'lean-reports' })
          notified = n
        } catch {
          /* the next tick tries again */
        }
      })
      void timer
      // the chaser: a goal untouched for an hour gets one status message to its open thread
      $.clock.every(60_000, async () => {
        try {
          const h2 = hostOf($)
          await chase(h2, (id, text) => leanThread(h2, $.plugin.root, { action: 'send', tN: id, text }))
        } catch {
          /* the next tick tries again */
        }
      })
      // the desk folder's CLAUDE.md is generated: written only when it changed
      try {
        const want = await deskClaudeMd(h, $.plugin.root)
        const file = `${deskDir(await homeDir(h))}/CLAUDE.md`
        const have = await h.fs.read(file).catch(() => null)
        if (want && have !== want) await atomicWrite(h, file, want)
      } catch {
        /* a desk without its CLAUDE.md still has the skill and the tool */
      }
    }
    await paneStart($, role).catch(() => undefined)
    if (role.kind === 'thread') {
      // learned rules: copy into this folder (a worktree is its own checkout) and say when they went stale
      try {
        const th = await readJson<{ project?: string }>(h, `${threadsDir(await homeDir(h))}/${role.id}/thread.json`, {})
        if (th.project) {
          await syncRules(h, th.project, e.cwd)
          const stale = await checkStale(h, th.project, e.cwd)
          if (stale.length) return next({ ...e, context: [...((e as any).context ?? []), `[lean-agent] ${stale.join('; ')}`] } as any)
        }
      } catch {
        /* rules are optional */
      }
    }
    return next(e)
  })

  // every model request: refuse past a cap, then price its usage into ledger.jsonl
  on('turn.step', async function* ($, e: any, next) {
    const h = hostOf($)
    const type = e.agentId ? await agentType($, e.agentId) : undefined
    const why = await overBudget(h, role.kind, e.agentId ? { type, spent: spent.get(e.agentId) ?? 0 } : null).catch(() => null)
    if (why) return { turnId: e.turnId, index: e.index, answer: why, toolUses: [], stopReason: 'end_turn', usage: null } as any
    const r: any = yield* next(e)
    try {
      const row = await record(h, { role: role.kind, tN: role.kind === 'thread' ? role.id : undefined, agentId: e.agentId, agent: type }, r?.usage?.model ?? e.model, r?.usage)
      if (row && e.agentId) spent.set(e.agentId, (spent.get(e.agentId) ?? 0) + row.usd)
    } catch {
      /* a ledger write that fails never stops the turn */
    }
    return r
  })

  registerPane(on)

  // the tool pool per role: config.json `tools.<role>.drop` (globs); lean-agent's own tools stay
  on('tool.list', async ($, e: any, next) => {
    const list: any[] = await next(e)
    try {
      const h = hostOf($)
      const cfg: any = await readConfig(h, await homeDir(h))
      return trimTools(list, role.kind, cfg.tools)
    } catch {
      return list
    }
  })

  // a long Bash result is squeezed after the call; the full text is saved under ~/.lean-agent/output/
  on('tool.call', { tool: 'Bash' }, async ($, e: any, next) => squeezeResult(hostOf($), await next(e)))

  on('tool.call', { tool: `mcp__lean-agent__${TOOL}` }, async ($, e: any) => {
    const h = hostOf($)
    const out = await leanThread(h, $.plugin.root, e)
    return { result: out.text, ...(out.ok ? {} : { isError: true as const }) } as any
  })

  on('tool.call', { tool: `mcp__lean-agent__${DOCTOR}` }, async ($, e: any) => {
    if (role.kind !== 'desk') return { result: 'lean-agent: the doctor runs in the desk', isError: true } as any
    const h = hostOf($)
    try {
      if (e.action === 'check') return { result: (await check(h, $.plugin.root)).join('\n') } as any
      if (e.action === 'fix') return { result: (await fix(h, $.plugin.root)).lines.join('\n') } as any
      if (e.action === 'migrate') return { result: (await migrate(h, $.plugin.root)).lines.join('\n') } as any
      return { result: 'doctor: action must be check, fix or migrate', isError: true } as any
    } catch (err) {
      return { result: `doctor failed: ${String((err as Error)?.message ?? err)}`, isError: true } as any
    }
  })

  for (const t of THREAD_TOOLS) {
    on('tool.call', { tool: `mcp__lean-agent__${t.name}` }, async ($, e: any) => {
      if (role.kind !== 'thread') return { result: 'lean-agent: only a thread can use this tool', isError: true } as any
      const out = await threadTool(hostOf($), role.id, t.name, e)
      return { result: out.text, ...(out.ok ? {} : { isError: true as const }) } as any
    })
  }

  // every tool: guards first (fail closed), then delivery of queued messages to a busy session
  on('tool.call', async ($, e: any, next) => {
    const h = hostOf($)
    const why = await decide(h, { role, cwd, agentType: await agentType($, e.agentId) }, e)
    if (why) return { deny: why } as any
    const r: any = await next(e)
    await feedbackOf(h, e, r).catch(() => undefined)
    if (e.agentId || r?.deny !== undefined) return r
    try {
      const batch = role.kind === 'thread' ? await takeBatch(h, role.id) : role.kind === 'desk' ? await takeReports(h) : null
      if (batch) return { ...r, context: [...(r.context ?? []), batch] }
    } catch {
      /* delivery is retried at the next call */
    }
    return r
  }).catch(($, e: any, next) => (next.called ? next(e) : { deny: 'lean-agent guard failed' }))

  on('prompt.submit', async ($, e: any, next) => {
    const h = hostOf($)
    let extra: string | null = null
    try {
      if (role.kind === 'thread') extra = (await consumeWake(h, role.id, e.text)) ? null : await takeBatch(h, role.id)
      else if (role.kind === 'desk') extra = await takeReports(h)
    } catch {
      /* the prompt goes through without it */
    }
    return next(extra ? { ...e, context: [...(e.context ?? []), extra] } : e)
  })
}
