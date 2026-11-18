import type { Register } from 'claude-code'

import { detectRole } from './role'
import type { Role } from './role'
import { deskClaudeMd, leanThread } from './threads'
import { atomicWrite, deskDir, homeDir } from './state'
import type { Host } from './state'
import { THREAD_TOOLS, consumeWake, sweep, takeBatch, takeReports, threadTool, unreadReports } from './delivery'
import { decide } from './guard'
import { paneStart, registerPane } from './pane'

let notified = 0
let role: Role = { kind: 'plain' }
export const currentRole = () => role

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
    return next(e)
  })

  registerPane(on)

  on('tool.call', { tool: `mcp__lean-agent__${TOOL}` }, async ($, e: any) => {
    const h = hostOf($)
    const out = await leanThread(h, $.plugin.root, e)
    return { result: out.text, ...(out.ok ? {} : { isError: true as const }) } as any
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
