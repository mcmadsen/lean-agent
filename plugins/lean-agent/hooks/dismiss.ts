// `lean_thread dismiss tN` (and the pane's two-press Dismiss on a blocked card): the user acknowledged tN's blocked report. It is recorded in
// the thread's history.jsonl ({kind: 'dismiss', report: <ts of the report>}); the pane's notice and blocked badge go until a NEWER blocked report
// arrives (view.ts compares the report's ts with the newest dismissed one). The report itself stays in the desk inbox, unread rules unchanged.
import type { Host } from './state'
import { appendJsonl, homeDir, readJsonl, threadsDir } from './state'
import { deskState } from './delivery'
import type { DeskRec } from './delivery'

type Out = { ok: boolean; text: string }
const file = (home: string, id: string) => `${threadsDir(home)}/${id}/history.jsonl`

// the ts of the newest report the user dismissed for this thread (0 = none)
export async function dismissedTs(h: Host, home: string, id: string): Promise<number> {
  const rows = await readJsonl<{ kind?: unknown; report?: unknown }>(h, file(home, id)).catch(() => [])
  let best = 0
  for (const r of rows) if (r && r.kind === 'dismiss' && typeof r.report === 'number' && r.report > best) best = r.report
  return best
}

export async function dismissAction(h: Host, i: { tN?: string }): Promise<Out> {
  const id = i.tN ?? ''
  if (!/^t\d+$/.test(id)) return { ok: false, text: 'dismiss needs tN (like t3)' }
  const home = await homeDir(h)
  const recs = await readJsonl<DeskRec>(h, `${deskState(home)}/inbox.jsonl`).catch(() => [])
  const last = [...recs].reverse().find(r => r && r.from === id && (r.kind === 'report' || r.kind === 'ask'))
  if (!last) return { ok: true, text: `${id}: nothing to dismiss (no report from it)` }
  if (last.kind !== 'report' || last.state !== 'blocked') return { ok: true, text: `${id}: nothing to dismiss (its last ${last.kind === 'ask' ? 'message is a question' : `report is ${last.state ?? 'working'}, not blocked`})` }
  if ((await dismissedTs(h, home, id)) >= last.ts) return { ok: true, text: `${id}: that blocked report was already dismissed` }
  await appendJsonl(h, file(home, id), { ts: await h.clock.now(), kind: 'dismiss', report: last.ts })
  return { ok: true, text: `${id}: blocked report acknowledged. The pane's notice and blocked badge are gone until ${id} sends a newer blocked report; the report stays in the inbox.` }
}
