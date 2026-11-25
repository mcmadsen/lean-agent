// 1.0.35: a thread's model or effort changes by `lean_thread set tN model haiku` / `set tN effort low` (no new field: set already took workitem and pr).
// The change is STORED on the thread (nextModel / nextEffort) and applied by ONE restart from the handover (threads.ts auto-restart) when its session next goes idle:
//   modelChangeTick (the desk's timer): an open thread with a stored change, a live session that is idle (never a working one, never one on a prompt) for
//   IDLE_MS, at most one try per 10 minutes. `restart tN` applies it at once (a fresh session reads the stored change: threads.ts withPending).
// Nothing here calls a model. A session that is gone needs nothing from the tick: its next start reads the stored change.
import { threadsDir, readJson } from './state'
import type { Host } from './state'
import { liveOf } from './threadstate'
import type { AgentRow, Thread } from './threads'

export const IDLE_MS = 20_000
export const RETRY_MS = 10 * 60_000
export type ModelNotice = { id: string; text: string }
export type ModelDeps = { agents: () => Promise<AgentRow[] | null | undefined>; restart: (id: string, why: string) => Promise<{ ok: boolean; text: string; data?: unknown }> }
const IDLE = (id: string) => `modelnext.idle.${id}` // ms the session was first seen idle with a change stored
const TRIED = (id: string) => `modelnext.tried.${id}` // ms of the last try

// "model sonnet -> haiku at next restart" (the list's row), or '' when nothing is stored
export function pendingChange(t: Pick<Thread, 'model' | 'effort' | 'nextModel' | 'nextEffort'>): string {
  const parts: string[] = []
  if (t.nextModel) parts.push(`model ${t.model ?? 'sonnet'} -> ${t.nextModel}`)
  if (t.nextEffort) parts.push(`effort ${t.effort ?? 'high'} -> ${t.nextEffort}`)
  return parts.length ? `${parts.join(', ')} at next restart` : ''
}

export async function modelChangeTick(h: Host, home: string, deps: ModelDeps): Promise<ModelNotice[]> {
  const out: ModelNotice[] = []
  const ents = await h.fs.list(threadsDir(home)).catch(() => [] as { name: string }[])
  let rows: AgentRow[] | null | undefined
  for (const id of ents.map(e => e.name).filter(n => /^t\d+$/.test(n))) {
    const t = await readJson<Thread | null>(h, `${threadsDir(home)}/${id}/thread.json`, null)
    if (!t || t.state !== 'open' || !(t.nextModel || t.nextEffort) || !t.sid) {
      await h.store.set(IDLE(id), null)
      continue
    }
    rows ??= await deps.agents()
    if (!rows) return out
    const row = rows.find(a => a.sid === t.sid)
    const now = await h.clock.now()
    if (!row || liveOf(row) !== 'idle' || row.waitingFor) {
      await h.store.set(IDLE(id), null) // gone (its next start reads the change), working, or on a prompt: nothing to do now
      continue
    }
    const since = Number(await h.store.get(IDLE(id)).catch(() => 0)) || 0
    if (!since) {
      await h.store.set(IDLE(id), now)
      continue
    }
    if (now - since < IDLE_MS) continue
    const tried = Number(await h.store.get(TRIED(id)).catch(() => 0)) || 0
    if (tried && now - tried < RETRY_MS) continue
    await h.store.set(TRIED(id), now)
    const what = pendingChange(t)
    const r = await deps.restart(id, `The user changed its settings (${what.replace(' at next restart', '')}): restarted from the handover once, as soon as it was idle.`)
    await h.store.set(IDLE(id), null)
    out.push({ id, text: r.ok && (r.data as { fresh?: boolean } | undefined)?.fresh ? `${id}: ${what.replace(' at next restart', '')}: applied by one restart from the handover (it was idle)` : `${id}: ${what}: not applied yet (${r.text.slice(0, 160)}); it is tried again in 10 minutes, or say restart ${id}` })
  }
  return out
}
