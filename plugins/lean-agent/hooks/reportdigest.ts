// What the DESK model receives of a thread's report: a script-made digest, not the full text. The desk only routes, so a long report in its
// conversation is paid for on every later turn. Whatever path delivers it (the direct send, the auto relay, the inbox read at the next
// prompt), the desk gets: the thread id and state, the first `desk.reportChars` characters (default 400) cut at a sentence end, the
// structured parts one line each when known (sha, branch, review verdict: from the thread's snapshot, never from the prose), and the path
// of the full report file. `lean_thread report tN` returns more on demand (`section`, `full: true`). 0 = the full text, as before.
// A question, an approval request and a blocked report are never digested: the user must see them exactly.
import { atomicWrite, homeDir, readJson, threadsDir } from './state'
import type { Host } from './state'
import { readConfig } from './budget'
import { readSnapshot } from './snapshot'
import { greenReview } from './reviews'
import { pruneReports, reportBody, reportFile } from './delivery'
import type { DeskRec } from './delivery'

export const DEFAULT_REPORT_CHARS = 400

export async function reportChars(h: Host): Promise<number> {
  const v = ((await readConfig(h, await homeDir(h))) as any)?.desk?.reportChars
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : DEFAULT_REPORT_CHARS
}

export const flatText = (s: string): string => s.replace(/\s+/g, ' ').trim()

// the first `n` characters, cut at the last sentence end that leaves at least a third of them (else cut at n, with an ellipsis)
export function sentenceCut(flat: string, n: number): string {
  if (flat.length <= n) return flat
  const probe = flat.slice(0, n + 1) // (one more: a full stop at the very end of the n characters still counts when a space follows it)
  let end = -1
  for (const m of probe.matchAll(/[.!?](?=\s)/g)) if (m.index! < n) end = m.index!
  if (end >= n / 3) return probe.slice(0, end + 1)
  return probe.slice(0, n - 1).replace(/[\ud800-\udbff]$/, '').trimEnd() + '…'
}

// a report that is cut: a plain report of any state but blocked (no approval, no action request), longer than `chars`
export const digestable = (r: { kind: 'report' | 'ask'; state?: string; text: string; approval?: string; action?: unknown }, chars: number): boolean =>
  chars > 0 && r.kind === 'report' && r.state !== 'blocked' && !r.approval && !r.action && flatText(r.text).length > chars

export const pointerText = (from: string, file?: string): string => (file ? `(cut: full text ${file}; lean_thread report ${from} full: true, or section: "<heading>")` : `(cut: the full report is in the desk inbox; lean_thread report ${from} full: true)`)

// the structured parts of a thread's state, one line each; none known = none
export async function partsOf(h: Host, home: string, id: string): Promise<string[]> {
  try {
    const snap = await readSnapshot(h, home, id)
    if (!snap) return []
    const t = await readJson<{ project?: string } | null>(h, `${threadsDir(home)}/${id}/thread.json`, null)
    const out: string[] = []
    if (snap.head) out.push(`sha: ${snap.head.slice(0, 10)}`)
    if (snap.branch) out.push(`branch: ${snap.branch}`)
    if (snap.head && t?.project) out.push(`review: ${(await greenReview(h, t.project, snap.head).catch(() => false)) ? 'green' : 'none for this sha'}`)
    return out
  } catch {
    return []
  }
}
export const partLines = (parts: string[]): string => parts.map(l => `\n  ${l}`).join('')

// the inbox read path: the full texts of the reports that are cut are written to their files (unless a file is there), the structured
// parts are read once per thread. undefined = no digest (reportChars 0)
export type Digest = { chars: number; files: Map<string, string>; parts: Map<string, string[]> }
export const rowKey = (r: { ts: number; from: string; kind: string }) => `${r.ts}:${r.from}:${r.kind}`
export async function prepareDigest(h: Host, recs: DeskRec[]): Promise<Digest | undefined> {
  const chars = await reportChars(h)
  const cut = recs.filter(r => digestable(r, chars))
  if (!cut.length) return chars > 0 ? { chars, files: new Map(), parts: new Map() } : undefined
  const home = await homeDir(h)
  const files = new Map<string, string>()
  const parts = new Map<string, string[]>()
  for (const r of cut) {
    if (!/^t\d+$/.test(r.from)) continue
    const path = reportFile(home, r)
    if ((await h.fs.exists(path).catch(() => false)) || (await atomicWrite(h, path, reportBody(r)).then(() => true, () => false))) files.set(rowKey(r), path)
    if (!parts.has(r.from)) parts.set(r.from, await partsOf(h, home, r.from))
  }
  if (files.size) await pruneReports(h, home, [...files.values()].pop()!)
  return { chars, files, parts }
}

// one record as the desk reads it in the digest form (no hints: the caller adds them)
export const digestText = (r: DeskRec, dg: Digest): string => `${sentenceCut(flatText(r.text), dg.chars)} ${pointerText(r.from, dg.files.get(rowKey(r)))}${partLines(dg.parts.get(r.from) ?? [])}`
