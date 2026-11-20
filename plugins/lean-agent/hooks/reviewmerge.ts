// Two independent reviewer passes, merged (0.45's `review --runs 2`, ported). A high-risk diff (reviewrisk.ts requiredRuns) is reviewed by
// TWO sonnet runs that never see each other's answer; this module turns their two JSON blocks into one:
//   - findings are matched by category, file and wording; a finding both runs raised ends with ` [2/2]`, one only a run raised with
//     ` [1/2]`; the UNION counts, so a major only one run found still blocks (that is the point of a second pass);
//   - the stricter entry wins everywhere else (reuse verdicts, lost coverage, changes-requested over approve);
//   - an earlier finding is "fixed" only when both runs say so.
// The merged block carries `runs: 2`. It is believed as the merged block only when its digest was remembered here by the merge action
// (the mod's own store: a session cannot write it), so a single block with `runs: 2` typed in by hand does not pass for two runs.
import type { Entry, Finding, Result } from './reviewgate'
import { jaccard, words } from './reviewprep'
import { sha256 } from './sha'
import type { Host } from './state'

const SEVERITY = ['blocker', 'major', 'minor', 'nit']
const rank = (s: string) => (SEVERITY.includes(s) ? SEVERITY.indexOf(s) : 1) // an unknown word counts as major, as in reviewgate.ts
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const stripDot = (p: string) => p.replace(/^\.\//, '')
const sameFile = (a: string, b: string) => {
  const x = stripDot(a)
  const y = stripDot(b)
  return !!x && !!y && (x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`))
}
export const MATCH_WITH_PATH = 0.35
export const MATCH_NO_PATH = 0.5

export function sameFinding(a: Finding, b: Finding): boolean {
  if (a.category !== b.category) return false
  const j = jaccard(words(a.text), words(b.text))
  return a.path && b.path ? sameFile(a.path, b.path) && j >= MATCH_WITH_PATH : j >= MATCH_NO_PATH
}

const mark = (text: string, m: string) => (/ \[\d\/2\]$/.test(text) ? text : `${text} ${m}`)
const longer = (a: string, b: string) => (b.length > a.length ? b : a)

// stable text of a value (keys sorted) for deduplication and the digest
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map(k => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v) ?? 'null'
}
const union = (a: Entry[], b: Entry[]): Entry[] => {
  const seen = new Set<string>()
  return [...a, ...b].filter(e => {
    const k = stable(e)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

const REUSE_ORDER = ['duplicate', 'extends-existing', 'wraps-existing', 'justified-new']
const reuseRank = (v: string) => (REUSE_ORDER.includes(v) ? REUSE_ORDER.indexOf(v) : REUSE_ORDER.length)

export type Merged = Result & { runs: 2 }
export type MergeInfo = { both: number; only: number }

export function mergeRuns(a: Result, b: Result): { result: Merged; info: MergeInfo } {
  const used = new Set<number>()
  const out: Finding[] = []
  let both = 0
  for (const f of a.findings) {
    let best = -1
    let bestJ = -1
    b.findings.forEach((g, i) => {
      if (used.has(i) || !sameFinding(f, g)) return
      const j = jaccard(words(f.text), words(g.text))
      if (j > bestJ) {
        best = i
        bestJ = j
      }
    })
    if (best < 0) {
      out.push({ ...f, text: mark(f.text, '[1/2]') })
      continue
    }
    used.add(best)
    both++
    const g = b.findings[best]!
    const lines = [f.line, g.line].filter(n => n > 0)
    out.push({
      ...f,
      severity: rank(g.severity) < rank(f.severity) ? g.severity : f.severity, // the higher of the two
      path: f.path || g.path,
      line: lines.length ? Math.min(...lines) : 0,
      text: mark(longer(f.text, g.text), '[2/2]'),
      fix: longer(f.fix, g.fix),
      ...(f.symbol || g.symbol ? { symbol: f.symbol || g.symbol } : {}),
    })
  }
  b.findings.forEach((g, i) => {
    if (!used.has(i)) out.push({ ...g, text: mark(g.text, '[1/2]') })
  })
  const findings = out.map((f, i) => ({ ...f, n: i + 1 }))

  const reuse = new Map<string, Result['reuse'][number]>()
  for (const e of [...a.reuse, ...b.reuse]) {
    const k = norm(e.symbol)
    const cur = reuse.get(k)
    if (!cur) reuse.set(k, e)
    else {
      const win = reuseRank(e.verdict) < reuseRank(cur.verdict) ? e : cur
      reuse.set(k, { ...win, candidate: win.candidate || (win === e ? cur : e).candidate, why: longer(cur.why, e.why) })
    }
  }
  const coverage = new Map<string, Result['coverage'][number]>()
  for (const e of [...a.coverage, ...b.coverage]) {
    const k = norm(e.test)
    const cur = coverage.get(k)
    if (!cur) coverage.set(k, e)
    else coverage.set(k, { ...(e.status === 'lost' || cur.status !== 'lost' ? { ...cur, ...e } : cur), protected: longer(cur.protected, e.protected) })
  }
  const checks = new Map<string, { what: string; why: string }>()
  for (const c of [...a.checks, ...b.checks]) if (!checks.has(norm(c.what))) checks.set(norm(c.what), c)

  const verdict = a.verdict === 'changes-requested' || b.verdict === 'changes-requested' ? 'changes-requested' : a.verdict === 'needs-checks' || b.verdict === 'needs-checks' ? 'needs-checks' : a.verdict && b.verdict ? 'approve' : '' // a run without a verdict leaves none: the gate says so
  const result: Merged = {
    runs: 2,
    verdict,
    goal: a.goal || b.goal,
    findings,
    fixed: a.fixed.filter(n => b.fixed.includes(n)),
    gaps: union(a.gaps, b.gaps),
    user_facing: union(a.user_facing, b.user_facing),
    risks: union(a.risks, b.risks),
    removed_effects: union(a.removed_effects, b.removed_effects),
    checks: [...checks.values()],
    reuse: [...reuse.values()],
    coverage: [...coverage.values()],
    siblings: union(a.siblings, b.siblings),
    searches: union(a.searches, b.searches),
    unverified: [...new Set([...a.unverified, ...b.unverified])],
  }
  return { result, info: { both, only: findings.length - both } }
}

// two blocks that are the same JSON are one pass twice, not two independent passes
export const sameBlocks = (a: unknown, b: unknown): boolean => stable(a) === stable(b)

// ---- the merged block's identity (the mod's own store) ----------------------------------------------------------------------
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
export const digestOf = (block: unknown): string => hex(sha256(new TextEncoder().encode(stable(block))))
const KEEP = 20
const key = (project: string) => `review.merged.${project}`
const listOf = async (h: Host, project: string): Promise<string[]> => {
  const v = await h.store.get(key(project)).catch(() => null)
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}
export async function rememberMerged(h: Host, project: string, digest: string): Promise<void> {
  await h.store.set(key(project), [...(await listOf(h, project)).filter(x => x !== digest), digest].slice(-KEEP))
}
export async function wasMerged(h: Host, project: string, digest: string): Promise<boolean> {
  return (await listOf(h, project)).includes(digest)
}
