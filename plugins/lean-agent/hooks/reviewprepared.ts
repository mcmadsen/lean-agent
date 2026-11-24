// The prepared state of a review thread, per (thread, ref): ONE record of the LAST `lean_review prepare` (an id, a time, the head, the range, the file
// and area counts, the forge's own count). A later prepare of the same ref REPLACES it (never adds to it: the 1206-file prepare of a wrong base
// must not keep its 6 areas after the prepare of the real 7-file range); the earlier one is kept as history, marked superseded, and its area
// records are never required. The report gate (reviewevidence.ts) counts the areas of the last prepare only. `reset-prepare` drops it by hand.
// The mod's store, never a file of the session. Two refs of one thread keep their own state.
import type { Host } from './state'
import { noteAreas, areasOf } from './reviewarea'
import { parseExt } from './reviewext'
import { readReview, writeReview } from './reviews'

export type Prepared = { id: string; ts: number; project: string; head: string; mb: string; files: number; lines: number; forgeN: number | null; areas: string[]; superseded?: number /* the time a later prepare or a reset replaced it */ }
type Slot = { last: Prepared | null; older: Prepared[] }
const KEEP_OLDER = 5
const key = (thread: string) => `review.prepared.${thread}`
const isThread = (t: string) => /^t\d+$/.test(t)
const hhmm = (ts: number) => (ts > 0 ? `${new Date(ts).toISOString().slice(11, 16)} UTC` : 'an earlier time')
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
// a review of one pass is one area
export const areaCount = (p: Pick<Prepared, 'areas'>) => Math.max(1, p.areas.length)
export const prepareText = (p: Prepared) => `${p.id} of ${hhmm(p.ts)}: ${plural(areaCount(p), 'area')} / ${plural(p.files, 'file')}`

async function load(h: Host, thread: string): Promise<Record<string, Slot>> {
  const v = await h.store.get(key(thread)).catch(() => undefined)
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Slot>) : {}
}
const save = (h: Host, thread: string, all: Record<string, Slot>) => h.store.set(key(thread), all).catch(() => undefined)

// the area records of a head that an earlier prepare listed move out of the record into `superseded` (history): the next prepare's areas
// (named area-1.. again, but a different partition) start without records. The record's verdicts are cleared with them: it is no review of the new range.
async function supersedeRecords(h: Host, project: string, head: string, prepare: string): Promise<void> {
  const rec = await readReview(h, project, head).catch(() => null)
  if (!rec?.areas || !Object.keys(rec.areas).length) return
  const { areas, ...rest } = rec
  await writeReview(h, { ...rest, verdicts: [], counts: {}, findings: (rec.findings ?? []).filter(s => !/^\[area-\d+\] /.test(s)), scoped: undefined, superseded: [...(rec.superseded ?? []), { at: await h.clock.now(), prepare, areas }] }).catch(() => undefined)
}

// Note a prepare (never an area pass of one: the caller skips `scope`). Returns the sentence that says an earlier prepare was replaced ('' when none).
export async function notePrepare(h: Host, thread: string, ref: string, p: Omit<Prepared, 'id' | 'ts' | 'superseded'>): Promise<string> {
  await noteAreas(h, p.project, p.head, p.areas) // (the older head-keyed list stays equal to the last prepare)
  if (!isThread(thread) || !ref) return ''
  const all = await load(h, thread)
  const slot = all[ref]
  const prev = slot?.last ?? null
  const ts = await h.clock.now()
  const next: Prepared = { ...p, id: `p${Number(/^p(\d+)$/.exec(prev?.id ?? slot?.older?.[0]?.id ?? '')?.[1] ?? 0) + 1}`, ts }
  all[ref] = { last: next, older: prev ? [{ ...prev, superseded: ts }, ...(slot?.older ?? [])].slice(0, KEEP_OLDER) : (slot?.older ?? []) }
  await save(h, thread, all)
  if (!prev) return ''
  if (prev.head === p.head) await supersedeRecords(h, p.project, p.head, prev.id)
  return `replaces the earlier prepare of ${hhmm(prev.ts)}: ${plural(areaCount(prev), 'area')} / ${plural(prev.files, 'file')}; now ${plural(areaCount(next), 'area')} / ${plural(next.files, 'file')} (the earlier areas are no longer required; their records are kept as history)`
}

// the last prepare of this thread for a head (the newest when two refs share one), or null
export async function lastPrepared(h: Host, thread: string, head: string): Promise<Prepared | null> {
  if (!isThread(thread)) return null
  const mine = Object.values(await load(h, thread)).map(s => s?.last).filter((p): p is Prepared => !!p && p.head === head)
  return mine.sort((a, b) => b.ts - a.ts)[0] ?? null
}
// a prepare of this head that was reset or replaced (so the gate can say so instead of falling back to the old head-keyed list)
export async function wasReset(h: Host, thread: string, head: string): Promise<boolean> {
  return isThread(thread) && Object.values(await load(h, thread)).some(s => s?.older?.some(p => p.head === head))
}
// the areas a record of this head must cover: the last prepare's (an older lean-agent's prepare left only the head-keyed list)
export async function requiredAreas(h: Host, thread: string, project: string, head: string): Promise<{ areas: string[]; last: Prepared | null }> {
  const last = await lastPrepared(h, thread, head)
  if (last) return { areas: last.areas, last }
  return { areas: (await wasReset(h, thread, head)) ? [] : await areasOf(h, project, head), last: null }
}

// `reset-prepare`: drop the thread's prepared state of a ref (the ref of the latest prepare when none is named); records stay as history
export async function resetPrepare(h: Host, thread: string, refAsked: string): Promise<string> {
  if (!isThread(thread)) return 'reset-prepare: only a thread has prepared state; nothing to drop'
  const all = await load(h, thread)
  const live = Object.entries(all).filter(([, s]) => s?.last)
  let hit: [string, Slot] | undefined
  if (refAsked) {
    const lc = refAsked.trim().toLowerCase()
    const x = parseExt(refAsked)
    const names = new Set([lc, `pr #${lc.replace(/^#/, '')}`, `branch ${lc}`, `commit ${lc.slice(0, 10)}`, ...(typeof x === 'object' && 'pr' in x ? [`pr #${x.pr}`] : [])])
    hit = live.find(([k]) => names.has(k.toLowerCase()))
  } else hit = live.sort((a, b) => b[1].last!.ts - a[1].last!.ts)[0]
  if (!hit) return `reset-prepare: this thread has no prepared state${refAsked ? ` for ${JSON.stringify(refAsked.slice(0, 80))}` : ''}${live.length ? ` (it has: ${live.map(([k]) => k).join(', ')})` : ''}; nothing was dropped`
  const [ref, slot] = hit
  const was = slot.last!
  const ts = await h.clock.now()
  all[ref] = { last: null, older: [{ ...was, superseded: ts }, ...slot.older].slice(0, KEEP_OLDER) }
  await save(h, thread, all)
  await noteAreas(h, was.project, was.head, [])
  await supersedeRecords(h, was.project, was.head, was.id)
  return `reset-prepare: dropped the prepared state of ${ref} (prepare ${prepareText(was)}, head ${was.head.slice(0, 8)}); its records are kept as history and never required; ${live.length > 1 ? 'the other refs of this thread are untouched; ' : ''}run lean_review prepare again for the real range. Never review files outside the PR to satisfy the record check.`
}

// the done gate's range rule: the last prepare holds more files than the forge lists for the PR
export const rangeWrong = (p: Prepared): boolean => p.forgeN !== null && p.files > p.forgeN
