// The doctor's rows for thread sessions: leftover stopped sessions of threads that have a newer session ("stale thread sessions", removed by
// `doctor fix` with `claude rm`, never forced) and sessions the app lists under another name than the thread's "tN · title".
import { homeDir, readJson, threadsDir } from './state'
import type { Host } from './state'
import { listAgents } from './threads'
import type { AgentRow, Thread } from './threads'
import { RENAME_NOTE, inThreadFolder, liveOf, nameProblem, removeSession, sessionName, threadsConfig } from './threadstate'

type Found = { threads: Thread[]; rows: AgentRow[] | null; stale: { id: string; sid: string; row: AgentRow }[] }

// a session id in a thread's `sids` that is not its current one, listed by `claude agents --all`, stopped (no live process, not working)
async function find(h: Host, home: string): Promise<Found> {
  const threads: Thread[] = []
  try {
    for (const e of await h.fs.list(threadsDir(home))) {
      if (!/^t\d+$/.test(e.name)) continue
      const t = await readJson<Thread | null>(h, `${threadsDir(home)}/${e.name}/thread.json`, null)
      if (t && t.id === e.name) threads.push(t)
    }
  } catch {
    /* no threads yet */
  }
  const rows = await listAgents(h).catch(() => null)
  const stale: Found['stale'] = []
  if (!rows) return { threads, rows, stale }
  const current = new Set(threads.map(t => t.sid).filter(Boolean)) // never a session some thread runs now
  for (const t of threads) {
    if (!t.sid) continue // no newer session: nothing replaced anything
    for (const sid of new Set(t.sids ?? [])) {
      if (typeof sid !== 'string' || sid === t.sid || current.has(sid)) continue
      const row = rows.find(a => a.sid === sid)
      if (row && row.pid === 0 && liveOf(row) !== 'working' && (await inThreadFolder(h, home, t.id, row.cwd))) stale.push({ id: t.id, sid, row }) // (a session elsewhere is never ours to remove)
    }
  }
  return { threads, rows, stale }
}

export async function threadSessionRows(h: Host): Promise<string[]> {
  const home = await homeDir(h)
  const { threads, rows, stale } = await find(h, home)
  const out: string[] = []
  if (!rows) return ['note stale thread sessions: not checked (claude agents could not be listed)']
  const keep = !(await threadsConfig(h, home)).removeOld
  if (stale.length) {
    const by = new Map<string, number>()
    for (const s of stale) by.set(s.id, (by.get(s.id) ?? 0) + 1)
    out.push(`${keep ? 'note' : 'FIX '} stale thread sessions: ${stale.length} stopped session(s) of threads that have a newer session stay in the app's list (${[...by].map(([id, n]) => `${id}: ${n}`).join(', ')})${keep ? '; threads.removeOld is false, so they are kept (lean_config unset threads.removeOld removes them next time)' : '; doctor fix removes them with claude rm (their conversations are kept, nothing is forced; a refusal is left as it is)'}`)
  } else out.push('ok   no stale thread sessions')
  // the app lists a session under the name it was started with; a resume cannot give it another (no command renames a background session)
  const odd = threads.filter(t => t.state === 'open' && t.sid).flatMap(t => {
    const bad = nameProblem(rows.find(a => a.sid === t.sid), sessionName(t.id, t.title, t.gen ?? 1))
    return bad ? [`${t.id}: "${bad.slice(0, 40)}"`] : []
  })
  if (odd.length) out.push(`note ${odd.length} thread session(s) are listed in the app under another name than "tN · title" (${odd.slice(0, 5).join(', ')}${odd.length > 5 ? `, ${odd.length - 5} more` : ''}): ${RENAME_NOTE}`)
  return out
}

// `doctor fix`: claude rm for each stale session, without --discard-unpushed and --force-remove-worktree; a refusal is logged and left
export async function removeStaleSessions(h: Host): Promise<string[]> {
  const home = await homeDir(h)
  if (!(await threadsConfig(h, home)).removeOld) return []
  const { stale, rows } = await find(h, home)
  const lines: string[] = []
  for (const s of stale) {
    const t = await readJson<Thread | null>(h, `${threadsDir(home)}/${s.id}/thread.json`, null)
    const r = await removeSession(h, home, { id: s.id, sid: s.sid, current: t?.sid ?? '', row: rows?.find(a => a.sid === s.sid), log: true })
    lines.push(r.removed ? `stale thread session ${s.id} ${s.row.id || s.sid.slice(0, 8)} removed from the app's list (its conversation is kept)` : `stale thread session ${s.id} ${s.row.id || s.sid.slice(0, 8)} left in the app's list (${r.refused ? `claude rm refused: ${r.refused}` : r.skipped})`)
  }
  return lines
}
