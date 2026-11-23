// `park` clears every pending marker that could start, resume, wake or continue the thread's session (1.0.28; field: a PARKED thread went on working after the mod
// auto-restarted it from a marker written before the park). Every automatic path also checks `state === 'open'` at the moment it acts (autorestart.ts, stall.ts,
// deliver-to-thread.ts, limits.ts, chaser.ts, continuepending.ts, sendhold.ts, threads.ts wake / auto-restart / stall-restart / answer-restart / limit-resume);
// this clears the markers so that a later reopen does not act on them either. Messages stay queued in the inbox (a reopen delivers them). Never throws.
// (Raw paths, no imports of threads.ts / autorestart.ts: threads.ts calls this.)
import { readJson, threadsDir, writeJson } from './state'
import type { Host } from './state'
import { readLimit, writeLimit, handled } from './limits'

export async function clearPendingMarkers(h: Host, home: string, id: string): Promise<void> {
  const dir = `${threadsDir(home)}/${id}`
  try {
    // the restart marker (autorestart.json): the pending checkpoint goes, the history of the last restart stays
    const mk = await readJson<{ pending?: unknown } | null>(h, `${dir}/autorestart.json`, null)
    if (mk && typeof mk === 'object' && mk.pending !== undefined) {
      const { pending: _p, ...rest } = mk
      await writeJson(h, `${dir}/autorestart.json`, rest)
    }
    await writeJson(h, `${dir}/continue-pending.json`, {}) // a "next:" / keep-going continue
    await writeJson(h, `${dir}/delivery.json`, {}) // the watch of a delivered message (no escalation restart for it)
    const lim = await readLimit(h, home, id) // the usage-limit resume record: cancelled, never resumed, not even after a reopen
    if (lim && !handled(lim)) await writeLimit(h, home, id, { ...lim, cancelled: 'parked' })
  } catch {
    /* best effort: the paths above check the state themselves */
  }
}
