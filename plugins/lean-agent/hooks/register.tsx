import type { Register } from 'claude-code'

import { detectRole } from './role'
import type { Role } from './role'
import { deskClaudeMd, leanThread } from './threads'
import { atomicWrite, deskDir, homeDir } from './state'
import type { Host } from './state'

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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // $ is only ever spelled $.noun.event(...): the helpers get this thin host instead of $ itself
    const h: Host = {
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
    role = await detectRole(h, e.cwd)
    if (role.kind === 'desk') {
      await $.tool.register({
        name: TOOL,
        description:
          'Manage lean-agent threads (background sessions): new, send, wake, close, park, reopen, list, resume, start. A send to a running thread is only queued; an idle one is woken once.',
        inputSchema: SCHEMA,
        isDeferred: false,
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
    return next(e)
  })

  on('tool.call', { tool: `mcp__lean-agent__${TOOL}` }, async ($, e: any) => {
    const h: Host = {
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
    const out = await leanThread(h, $.plugin.root, e)
    return { result: out.text, ...(out.ok ? {} : { isError: true as const }) } as any
  })
}
