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

// the USD of each reviewer pass found in the ledger text for `project`, newest passes last (`project` of a row = its thread's project)
export async function reviewerPassCosts(h: Host, project: string, text: string): Promise<number[]> {
  const home = await homeDir(h)
  const passes = new Map<string, { ts: number; usd: number }>()
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
    const cur = passes.get(key) ?? { ts: r.ts, usd: 0 }
    cur.usd += r.usd
    cur.ts = Math.max(cur.ts, r.ts)
    passes.set(key, cur)
  }
  return [...passes.values()].sort((a, b) => a.ts - b.ts).slice(-MAX_PASSES).map(p => p.usd)
}

export type Expected = { usd: number; passes: number; basis: string; samples: number }
export async function expectedReviewCost(h: Host, project: string, passes: number): Promise<Expected> {
  let text = ''
  try {
    const file = `${leanDir(await homeDir(h))}/${LEDGER}`
    const size = await fileSize(h, file)
    if (size !== null) text = await readFrom(h, file, Math.max(0, size - TAIL_BYTES)) // the newest part only (the first line of a tail may be cut: skipped as damaged)
  } catch {
    /* no ledger: the default */
  }
  const costs = (await reviewerPassCosts(h, project, text).catch(() => [])).filter(x => x > 0)
  const per = costs.length ? median(costs) : DEFAULT_PASS_USD
  return { usd: per * passes, passes, samples: costs.length, basis: costs.length ? `median of ${costs.length} earlier reviewer pass${costs.length === 1 ? '' : 'es'} on this project` : `default $${DEFAULT_PASS_USD.toFixed(2)} a pass, no earlier reviewer pass on this project in the ledger` }
}

// "expected review cost ~$1.20 (2 passes, sonnet; median of 5 earlier reviewer passes on this project)"
export const expectedText = (e: Expected, model: string): string => `expected review cost ~$${e.usd.toFixed(2)} (${e.passes} pass${e.passes === 1 ? '' : 'es'}, ${model}; ${e.basis})`
