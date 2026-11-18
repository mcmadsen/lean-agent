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

// A session whose id is a thread's recorded `sid` IS that thread, wherever its working directory is.
export async function roleBySid($: Host, sid: string): Promise<Role | null> {
  if (!sid) return null
  const dir = threadsDir(await homeDir($))
  const hits: string[] = []
  for (const e of await $.fs.list(dir).catch(() => [] as { name: string }[])) {
    if (!/^t\d+$/.test(e.name)) continue
    try {
      const t = JSON.parse(String(await $.fs.read(`${dir}/${e.name}/thread.json`)))
      if (t && typeof t.sid === 'string' && t.sid === sid && t.state !== 'closed') hits.push(e.name) // a closed record keeps its old sid
    } catch {
      /* an unreadable record is not a match */
    }
  }
  return hits.length === 1 ? { kind: 'thread', id: hits[0]! } : null // two records with one sid: no match, the folder decides
}

// The ONE role function. Order: a desk stays the desk; the session id (a thread's sid); the role the session already has (sticky: a desk or
// thread session is never demoted by a cwd change, e.g. a Bash `cd` into the project repo), then the folder (dir, then the
// root when asked). Only plain -> desk/thread happens on a cwd change.
export async function resolveRole($: Host, o: { cwd: string; root?: string; sid?: string; current?: Role; useRoot?: boolean }): Promise<Role> {
  if (o.current && o.current.kind !== 'plain' && o.current.kind !== 'thread') return o.current // a desk is never swapped by a sid match
  const bySid = await roleBySid($, o.sid ?? '')
  if (bySid) return bySid
  if (o.current && o.current.kind !== 'plain') return o.current
  let r = await detectRole($, o.cwd)
  if (r.kind === 'plain' && o.useRoot !== false && o.root && o.root !== o.cwd) r = await detectRole($, o.root)
  return r
}
