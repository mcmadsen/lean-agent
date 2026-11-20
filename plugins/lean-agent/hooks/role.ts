import { deskDir, homeDir, readJson, realPath, threadsDir, writeJson } from './state'
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
export async function sidHolders($: Host, sid: string): Promise<{ id: string; state: string }[]> {
  if (!sid) return []
  const dir = threadsDir(await homeDir($))
  const hits: { id: string; state: string }[] = []
  for (const e of await $.fs.list(dir).catch(() => [] as { name: string }[])) {
    if (!/^t\d+$/.test(e.name)) continue
    try {
      const t = JSON.parse(String(await $.fs.read(`${dir}/${e.name}/thread.json`)))
      if (t && (t.sid === sid || (Array.isArray(t.sids) && t.sids.includes(sid)))) hits.push({ id: e.name, state: String(t.state ?? '') })
    } catch {
      /* an unreadable record is not a match */
    }
  }
  return hits
}
export async function roleBySid($: Host, sid: string): Promise<Role | null> {
  const open = (await sidHolders($, sid)).filter(x => x.state !== 'closed') // a closed record keeps its old sid
  return open.length === 1 ? { kind: 'thread', id: open[0]!.id } : null // two records with one sid: no match, the folder decides
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

// When a session is first resolved as thread tN, its id goes into thread.json `sids` (`sid` stays as the desk wrote it), so a
// later session.start from ANY folder (mod reload, compaction, resume) resolves it by id. Never steals an id another thread holds.
export async function recordSid($: Host, id: string, sid: string): Promise<boolean> {
  if (!sid || !/^t\d+$/.test(id)) return false
  const file = `${threadsDir(await homeDir($))}/${id}/thread.json`
  const t = await readJson<Record<string, any> | null>($, file, null)
  if (!t || typeof t !== 'object' || t.id !== id || t.state === 'closed') return false
  if (t.sid === sid || (Array.isArray(t.sids) && t.sids.includes(sid))) return true
  const other = await roleBySid($, sid)
  if (other && other.kind === 'thread' && other.id !== id) return false
  const fresh = await readJson<Record<string, any> | null>($, file, null) // the desk may have saved meanwhile: write onto the latest record
  if (!fresh || fresh.id !== id || fresh.state === 'closed') return false
  await writeJson($, file, { ...fresh, sids: [...new Set([...(Array.isArray(fresh.sids) ? fresh.sids : []), sid])].slice(-20) })
  return true
}

// The thread's session says which lean-agent code it runs (its own VERSION), once per session: thread.json `running` {version, sid, at}.
// The desk reads it (list, the start reply, the doctor) and shows "running X, installed Y" when they differ (skew.ts runningOf).
// Written onto the latest record (the desk saves too); a closed thread's record is left alone. true = the record says it now.
export async function recordRunning($: Host, id: string, sid: string, version: string): Promise<boolean> {
  if (!sid || !version || !/^t\d+$/.test(id)) return false
  const file = `${threadsDir(await homeDir($))}/${id}/thread.json`
  const t = await readJson<Record<string, any> | null>($, file, null)
  if (!t || typeof t !== 'object' || t.id !== id || t.state === 'closed') return false
  if (t.running?.version === version && t.running?.sid === sid) return true
  const fresh = await readJson<Record<string, any> | null>($, file, null)
  if (!fresh || fresh.id !== id || fresh.state === 'closed') return false
  await writeJson($, file, { ...fresh, running: { version, sid, at: await $.clock.now() } })
  return true
}

// why a role-bound tool refuses: the role, where the session started, what its id matched
export async function roleReport($: Host, o: { tool: string; need: 'thread' | 'desk'; role: Role; startDir: string; sid: string }): Promise<string> {
  const have = o.role.kind === 'thread' ? `thread ${o.role.id}` : o.role.kind
  const holders = o.sid ? await sidHolders($, o.sid).catch(() => []) : []
  const idText = !o.sid ? 'session id unknown' : holders.length === 0 ? 'session id not in any thread.json' : holders.length > 1 ? `session id is in several thread.json files (${holders.map(x => x.id).join(', ')}), so it decides nothing` : holders[0]!.state === 'closed' ? `session id belongs to thread ${holders[0]!.id}, which is closed` : `session id belongs to thread ${holders[0]!.id}`
  return `lean-agent: ${o.tool} needs a ${o.need} session; this session is ${have} (started in ${o.startDir || 'an unknown folder'}, ${idText})`
}
