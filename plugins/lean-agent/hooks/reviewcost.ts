// What a review is expected to cost, from the usage ledger: the median cost of the reviewer passes earlier threads of this project ran
// (one pass = every request of one reviewer subagent), else a stated default. No model decides this; the text is for the thread and the user
// to see BEFORE the reviewer agents are started (four reviewer passes at one checkpoint were $13.89 of one day).
import { homeDir, leanDir, readJson, threadsDir } from './state'
import type { Host } from './state'
import { LEDGER, fileSize, readFrom } from './ledger'

export const DEFAULT_PASS_USD = 1.5 // a sonnet pass over a normal diff, when the project has no history
const TAIL_BYTES = 3_000_000 // the newest part of ledger.jsonl is enough for a median
const MAX_PASSES = 40

export function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

// one reviewer pass of the ledger: ts0 = its first request, ts = its last
export type Pass = { tN: string; ts0: number; ts: number; usd: number; requests: number }
// every reviewer pass found in the ledger text for `project`, newest passes last (`project` of a row = its thread's project)
export async function reviewerPasses(h: Host, project: string, text: string): Promise<Pass[]> {
  const home = await homeDir(h)
  const passes = new Map<string, Pass>()
  const projectOf = new Map<string, string>()
  for (const line of text.split('\n')) {
    if (!line.includes('reviewer')) continue
    let r: any
    try {
      r = JSON.parse(line)
    } catch {
      continue // a cut first line of the tail, or a damaged one
    }
    if (!r || typeof r !== 'object' || typeof r.usd !== 'number' || typeof r.ts !== 'number') continue
    if (String(r.agent ?? '').replace(/^lean-agent:/, '') !== 'reviewer' || typeof r.tN !== 'string' || !/^t\d+$/.test(r.tN)) continue
    let p = projectOf.get(r.tN)
    if (p === undefined) {
      p = String((await readJson<{ project?: unknown }>(h, `${threadsDir(home)}/${r.tN}/thread.json`, {}))?.project ?? '')
      projectOf.set(r.tN, p)
    }
    if (p !== project) continue
    if (typeof r.agentId !== 'string' || !r.agentId) continue // a row that names no subagent cannot be told apart as a pass: it would count as one each
    const key = `${r.tN}/${r.agentId}`
    const cur = passes.get(key) ?? { tN: r.tN, ts0: r.ts, ts: r.ts, usd: 0, requests: 0 }
    cur.usd += r.usd
    cur.requests++
    cur.ts = Math.max(cur.ts, r.ts)
    cur.ts0 = Math.min(cur.ts0, r.ts)
    passes.set(key, cur)
  }
  return [...passes.values()].sort((a, b) => a.ts - b.ts).slice(-MAX_PASSES)
}
// the USD of each reviewer pass (kept for callers that only want the money)
export const reviewerPassCosts = async (h: Host, project: string, text: string): Promise<number[]> => (await reviewerPasses(h, project, text)).map(p => p.usd)

// What each prepare of a project asked for, in the mod's store (a session cannot write it): when, which sha, which level. The ledger rows carry no
// sha and no level, so a pass belongs to the last prepare that was made before its first request.
export type PrepNote = { ts: number; sha: string; level: string }
const notesKey = (project: string) => `review.log.${project}`
const NOTES_KEEP = 60
export async function readPrepNotes(h: Host, project: string): Promise<PrepNote[]> {
  const v = await h.store.get(notesKey(project)).catch(() => undefined)
  return Array.isArray(v) ? v.filter((n): n is PrepNote => !!n && typeof n.ts === 'number' && typeof n.sha === 'string' && typeof n.level === 'string') : []
}
export async function addPrepNote(h: Host, project: string, n: PrepNote): Promise<void> {
  await h.store.set(notesKey(project), [...(await readPrepNotes(h, project)), n].slice(-NOTES_KEEP)).catch(() => undefined)
}
const levelAt = (p: Pass, notes: PrepNote[]): string | undefined => notes.filter(n => n.ts <= p.ts0).sort((a, b) => b.ts - a.ts)[0]?.level

export async function ledgerTail(h: Host): Promise<string> {
  try {
    const file = `${leanDir(await homeDir(h))}/${LEDGER}`
    const size = await fileSize(h, file)
    if (size !== null) return await readFrom(h, file, Math.max(0, size - TAIL_BYTES)) // the newest part only (the first line of a tail may be cut: skipped as damaged)
  } catch {
    /* no ledger: the default */
  }
  return ''
}

// `level`: a light pass is cheaper than a full one, so the median is over the earlier passes of THAT level (known from the prepare notes) once at
// least two are known; otherwise over all of them (a pass from before the notes has no level)
export type Expected = { usd: number; passes: number; basis: string; samples: number }
export async function expectedReviewCost(h: Host, project: string, passes: number, level?: string): Promise<Expected> {
  const all = (await reviewerPasses(h, project, await ledgerTail(h)).catch(() => [])).filter(p => p.usd > 0)
  const notes = level ? await readPrepNotes(h, project) : []
  const same = level ? all.filter(p => levelAt(p, notes) === level) : []
  const use = same.length >= 2 ? same : all
  const kind = use === same && level ? ` ${level}` : ''
  const per = use.length ? median(use.map(p => p.usd)) : DEFAULT_PASS_USD
  return { usd: per * passes, passes, samples: use.length, basis: use.length ? `median of ${use.length} earlier${kind} reviewer pass${use.length === 1 ? '' : 'es'} on this project` : `default $${DEFAULT_PASS_USD.toFixed(2)} a pass, no earlier reviewer pass on this project in the ledger` }
}

// "review cost for 3f9c2ab41d02: $0.84 over 2 passes, 41 requests": the reviewer passes of `thread` that ran for this sha (from its first prepare
// until the prepare of another sha), or '' when none ran
export async function reviewCostLine(h: Host, project: string, thread: string, sha: string): Promise<string> {
  const notes = await readPrepNotes(h, project)
  const same = (a: string) => sha.length >= 7 && (a.startsWith(sha) || sha.startsWith(a)) // a record may name the sha abbreviated
  const mine = notes.filter(n => same(n.sha))
  if (!mine.length) return ''
  const start = Math.min(...mine.map(n => n.ts))
  const end = Math.min(Infinity, ...notes.filter(n => !same(n.sha) && n.ts > start).map(n => n.ts))
  const ps = (await reviewerPasses(h, project, await ledgerTail(h)).catch(() => [])).filter(p => (!thread || p.tN === thread) && p.ts0 >= start && p.ts0 < end)
  if (!ps.length) return ''
  const usd = ps.reduce((s, p) => s + p.usd, 0)
  const reqs = ps.reduce((s, p) => s + p.requests, 0)
  return `review cost for ${sha.slice(0, 12)}: $${usd.toFixed(2)} over ${ps.length} pass${ps.length === 1 ? '' : 'es'}, ${reqs} request${reqs === 1 ? '' : 's'}`
}

// "expected review cost ~$1.20 (2 passes, sonnet; median of 5 earlier reviewer passes on this project)"
export const expectedText = (e: Expected, model: string): string => `expected review cost ~$${e.usd.toFixed(2)} (${e.passes} pass${e.passes === 1 ? '' : 'es'}, ${model}; ${e.basis})`
