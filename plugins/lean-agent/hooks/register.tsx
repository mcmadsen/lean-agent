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
import { leanDir, readJson, threadsDir } from './state'
import { chase } from './chaser'
import { check, fix, migrate } from './doctor'
import { squeezeResult, trimTools } from './squeeze'
import { readConfig } from './budget'
import { hostOf } from './host'
import { parseGrants, recordGrant, releaseGrant } from './guard'
import { memorySection, recordAnswer, runSchedule, writeCompactNotes } from './extras'

export { hostOf }

let notified = 0
let grantSeq = 0
export const resetModState = () => {
  notified = 0
  spent.clear()
  role = { kind: 'plain' }
  cwd = ''
}
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
async function feedbackOf(host: Host, e: any, r: any): Promise<void> {
  if (e.agentId || (e.tool !== 'Agent' && e.tool !== 'Task') || r?.deny !== undefined) return
  const texts = (v: any): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(texts) : v && typeof v === 'object' ? Object.values(v).flatMap(texts) : [])
  const fb = parseFeedback(texts(r?.result).join('\n'))
  if (!fb) return
  let project: string | undefined
  if (role.kind === 'thread') project = (await readJson<{ project?: string }>(host, `${threadsDir(await homeDir(host))}/${role.id}/thread.json`, {})).project
  await applyFeedback(host, { thread: role.kind === 'thread' ? role.id : undefined, project, agent: String(e.subagent_type ?? e.agent ?? '') || undefined }, fb)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // $ is only ever spelled $.noun.event(...): the helpers get this thin host instead of $ itself
    const host = hostOf($)
    resetModState()
    role = await detectRole(host, e.cwd)
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
          const host2 = hostOf($)
          await sweep(host2, id => leanThread(host2, $.plugin.root, { action: 'wake', tN: id }))
          const n = (await unreadReports(host2)).recs.length
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
          const host2 = hostOf($)
          await chase(host2, (id, text) => leanThread(host2, $.plugin.root, { action: 'send', tN: id, text }))
        } catch {
          /* the next tick tries again */
        }
      })
      // scheduled sends: due lines of scheduled.jsonl go to their thread while the desk runs
      $.clock.every(30_000, async () => {
        try {
          const host2 = hostOf($)
          await runSchedule(host2, (id, text) => leanThread(host2, $.plugin.root, { action: 'send', tN: id, text }))
        } catch {
          /* the next tick tries again */
        }
      })
      // the desk folder's CLAUDE.md is generated: written only when it changed
      try {
        const want = await deskClaudeMd(host, $.plugin.root)
        const file = `${deskDir(await homeDir(host))}/CLAUDE.md`
        const have = await host.fs.read(file).catch(() => null)
        if (want && have !== want) await atomicWrite(host, file, want)
      } catch {
        /* a desk without its CLAUDE.md still has the skill and the tool */
      }
    }
    await paneStart($, role).catch(() => undefined)
    if (role.kind === 'thread') {
      // learned rules: copied into the project's checkout (registered in projects.json), and told when they went stale;
      // a thread's own worktree gets its copy from the worktree skill (lean_rules sync)
      try {
        const th = await readJson<{ project?: string }>(host, `${threadsDir(await homeDir(host))}/${role.id}/thread.json`, {})
        const projs = await readJson<Record<string, { path?: string }>>(host, `${leanDir(await homeDir(host))}/projects.json`, {})
        const repo = th.project ? projs?.[th.project]?.path : undefined
        if (th.project && typeof repo === 'string' && repo.startsWith('/')) {
          await syncRules(host, th.project, repo)
          const stale = await checkStale(host, th.project, repo)
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
    const host = hostOf($)
    const type = e.agentId ? await agentType($, e.agentId) : undefined
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

  registerPane(on)

  // the tool pool per role: config.json `tools.<role>.drop` (globs); lean-agent's own tools stay
  on('tool.list', async ($, e: any, next) => {
    const list: any[] = await next(e)
    try {
      const host = hostOf($)
      const cfg: any = await readConfig(host, await homeDir(host))
      return trimTools(list, role.kind, cfg.tools)
    } catch {
      return list
    }
  })

  // a long Bash result is squeezed after the call; the full text is saved under ~/.lean-agent/output/
  on('tool.call', { tool: 'Bash' }, async ($, e: any, next) => squeezeResult(hostOf($), await next(e)))

  on('tool.call', { tool: `mcp__lean-agent__${TOOL}` }, async ($, e: any) => {
    const host = hostOf($)
    const out = await leanThread(host, $.plugin.root, e)
    if (out.ok && e.action === 'send' && typeof e.tN === 'string' && typeof e.text === 'string') await recordAnswer(host, e.tN, e.text).catch(() => undefined)
    return { result: out.text, ...(out.ok ? {} : { isError: true as const }) } as any
  })

  on('tool.call', { tool: `mcp__lean-agent__${DOCTOR}` }, async ($, e: any) => {
    if (role.kind !== 'desk') return { result: 'lean-agent: the doctor runs in the desk', isError: true } as any
    const host = hostOf($)
    try {
      if (e.action === 'check') return { result: (await check(host, $.plugin.root)).join('\n') } as any
      if (e.action === 'fix') return { result: (await fix(host, $.plugin.root)).lines.join('\n') } as any
      if (e.action === 'migrate') return { result: (await migrate(host, $.plugin.root)).lines.join('\n') } as any
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
    const host = hostOf($)
    const why = await decide(host, { role, cwd, agentType: await agentType($, e.agentId), agentId: e.agentId }, e)
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
    let extra: string | null = null
    try {
      if (role.kind === 'thread') extra = (await consumeWake(host, role.id, e.text)) ? null : await takeBatch(host, role.id)
      else if (role.kind === 'desk') extra = await takeReports(host)
    } catch {
      /* the prompt goes through without it */
    }
    return next(extra ? { ...e, context: [...(e.context ?? []), extra] } : e)
  })
}
