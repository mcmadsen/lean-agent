import { deskDir, homeDir, realPath, threadsDir } from './state'
import type { Host } from './state'

export type Role = { kind: 'desk' } | { kind: 'thread'; id: string } | { kind: 'plain' }

const inside = (p: string, root: string) => p === root || p.startsWith(root + '/')

// The role of a session, from its working directory by real path: the desk folder is the desk,
// ~/.lean-agent/threads/tN (or below it) is thread tN, anything else is plain.
export async function detectRole($: Host, cwd: string): Promise<Role> {
  const home = await realPath($, await homeDir($))
  const real = await realPath($, cwd)
  if (inside(real, deskDir(home))) return { kind: 'desk' }
  const t = threadsDir(home)
  if (real.startsWith(t + '/')) {
    const id = real.slice(t.length + 1).split('/')[0] ?? ''
    if (/^t\d+$/.test(id)) return { kind: 'thread', id }
  }
  return { kind: 'plain' }
}
