// The dismissed-items store behind the pane's Dismiss buttons and `lean_thread dismiss`: one generic mechanism, no case per card.
// A dismissal is a row {ts, kind: 'dismiss', by: 'user', what: <kind>, id: <the item's own id or timestamp>, text} in the thread's history.jsonl
// (the desk's for a desk-level item). The view hides the item with that (thread or "desk", kind, id) and shows the next one of the same kind
// (a newer question, a new prompt wait, a newer blocked report: each has another id). The underlying record is never touched.
import type { Host } from './state'
import { appendJsonl, readJsonl, threadsDir } from './state'
import { deskState } from './delivery'

export const DKINDS = ['question', 'prompt', 'approval', 'blocked', 'stalled', 'restart', 'ready', 'script', 'context', 'model', 'action', 'deskmodel', 'olddesk', 'notice'] as const
export type DKind = (typeof DKINDS)[number]
export type DItem = { thread: string; kind: DKind; id: string }
export const dkey = (i: DItem) => `${i.thread}|${i.kind}|${i.id}`
const histFile = (home: string, who: string) => (who === 'desk' ? `${deskState(home)}/history.jsonl` : `${threadsDir(home)}/${who}/history.jsonl`)
type Row = { kind?: unknown; what?: unknown; id?: unknown; report?: unknown }

// every dismissed (thread|kind|id) of these owners ("desk" and thread ids)
export async function dismissedKeys(h: Host, home: string, who: Iterable<string>): Promise<Set<string>> {
  const out = new Set<string>()
  for (const w of new Set(who)) {
    for (const r of await readJsonl<Row>(h, histFile(home, w)).catch(() => [] as Row[])) {
      if (!r || r.kind !== 'dismiss') continue
      if (typeof r.what === 'string' && (typeof r.id === 'string' || typeof r.id === 'number')) out.add(`${w}|${r.what}|${r.id}`)
      else if (typeof r.report === 'number') out.add(`${w}|blocked|${r.report}`) // (1.0.15 rows)
    }
  }
  return out
}

// who / when / what is in the row; a blocked report's ts is also kept as `report` (the badge compares it, see dismissedTs)
export async function recordDismiss(h: Host, home: string, i: DItem, text: string): Promise<void> {
  const report = i.kind === 'blocked' && /^\d+$/.test(i.id) ? { report: Number(i.id) } : {}
  await appendJsonl(h, histFile(home, i.thread), { ts: await h.clock.now(), kind: 'dismiss', by: 'user', what: i.kind, id: i.id, text: text.replace(/\s+/g, ' ').slice(0, 200), ...report })
}

// the ts of the newest blocked report the user dismissed for this thread (0 = none)
export async function dismissedTs(h: Host, home: string, id: string): Promise<number> {
  const rows = await readJsonl<Row>(h, histFile(home, id)).catch(() => [] as Row[])
  let best = 0
  for (const r of rows) if (r && r.kind === 'dismiss' && typeof r.report === 'number' && r.report > best) best = r.report
  return best
}
