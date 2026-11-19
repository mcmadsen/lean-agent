// The strict review's enforcement (0.45's enforce_review_rules, ported): lean-agent's own rules on top of the reviewer's JSON.
// A script, not a model, decides whether a record may be green:
//   - every new symbol the diff defines needs a `reuse` entry; every edited test a `coverage` entry; every second-opinion candidate an answer;
//   - a `duplicate` verdict with an existing candidate outside the change is a major duplication finding; duplication, scope and
//     platform findings are at least major; a sibling that needs the same fix is a major scope finding;
//   - an unintended user-facing change, a side effect no longer done, lost coverage and a goal-blocking gap are major findings;
//   - "optional / follow-up / pre-existing" is minor; a finding the reviewer did not verify becomes a check, not a major;
//   - on a re-review a NEW major about code that did not change since the last review is minor (that is how it converges);
//   - declined findings (below) are left out last, whoever raised them, and never flip a verdict on their own.
import type { Host } from './state'
import { appendJsonl, homeDir, leanDir, readJsonl } from './state'
import { jaccard, words } from './reviewprep'
import type { Prep } from './reviewprep'

export const SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const
export const CATEGORIES = ['completeness', 'correctness', 'duplication', 'scope', 'platform', 'tests', 'security', 'compatibility', 'performance', 'style']
export const AT_LEAST_MAJOR = new Set(['duplication', 'scope', 'platform'])
export const VERDICTS = ['approve', 'changes-requested', 'needs-checks']
const CODE_FILE = /\.(tsx?|jsx?|mjs|cjs|py|go|rs|cs|java|kt|swift|scala|rb|php|c|cc|cpp|h|hpp|vue|svelte)$/i // a new file of these needs a reuse entry even with no symbol found
export type Finding = { n: number; severity: string; category: string; path: string; line: number; text: string; fix: string; symbol?: string; auto?: boolean }
export type Entry = Record<string, unknown>
export type Result = {
  verdict: string
  goal: string
  findings: Finding[]
  gaps: Entry[]
  fixed: number[] // a re-review: the numbers of the earlier open findings that are fixed now
  user_facing: Entry[]
  risks: Entry[]
  removed_effects: Entry[]
  checks: { what: string; why: string }[]
  reuse: { symbol: string; candidate: string; verdict: string; why: string }[]
  coverage: { test: string; protected: string; status: string }[]
  siblings: Entry[]
  searches: Entry[]
  unverified: string[]
}
export type Decline = { ts?: number; project?: string; branch?: string; all?: boolean; kind?: string; symbol?: string; path?: string; text?: string; why: string }

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')
const objs = (v: unknown): Entry[] => (Array.isArray(v) ? v.filter((x): x is Entry => !!x && typeof x === 'object' && !Array.isArray(x)) : [])
const truthy = (v: unknown) => /^(true|yes|1)$/i.test(String(v).trim())
const falsy = (v: unknown) => /^(false|no|0|unintended)$/i.test(String(v).trim())
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const hasName = (text: string, name: string) => !!name && new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`).test(text)
const base = (p: string) => p.split('/').pop() ?? p

export function normalize(raw: unknown): Result {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  let n = 0
  const findings = objs(r.findings).map((f): Finding => {
    const sev = str(f.severity).toLowerCase()
    return {
      n: Number.isFinite(Number(f.n)) && Number(f.n) > 0 ? Number(f.n) : ++n,
      severity: (SEVERITIES as readonly string[]).includes(sev) ? sev : 'major', // an unknown word ("critical", "high") never fails open
      category: str(f.category).toLowerCase(),
      path: str(f.path) || str(f.file),
      line: Number(f.line) > 0 ? Number(f.line) : 0,
      text: str(f.text) || str(f.issue),
      fix: str(f.fix) || str(f.suggestion),
      ...(str(f.symbol) ? { symbol: str(f.symbol) } : {}),
    }
  })
  return {
    verdict: VERDICTS.includes(str(r.verdict).toLowerCase()) ? str(r.verdict).toLowerCase() : '', // anything else counts as missing
    goal: str(r.goal),
    findings,
    fixed: Array.isArray(r.fixed) ? r.fixed.map(Number).filter(n => Number.isInteger(n) && n > 0) : [],
    gaps: objs(r.gaps),
    user_facing: objs(r.user_facing),
    risks: objs(r.risks),
    removed_effects: objs(r.removed_effects),
    checks: objs(r.checks).map(c => ({ what: str(c.what), why: str(c.why) })).filter(c => c.what),
    reuse: objs(r.reuse).map(e => ({ symbol: str(e.symbol), candidate: str(e.candidate) || (Array.isArray(e.candidates) ? e.candidates.map(str).join(', ') : ''), verdict: str(e.verdict).toLowerCase(), why: str(e.why) })).filter(e => e.symbol),
    coverage: objs(r.coverage).map(e => ({ test: str(e.test), protected: str(e.protected), status: str(e.status || e.verdict).toLowerCase() })).filter(e => e.test),
    siblings: objs(r.siblings),
    searches: objs(r.searches),
    unverified: Array.isArray(r.unverified) ? r.unverified.map(str).filter(Boolean) : [],
  }
}

// ---- declines: a finding the user decided not to fix, kept per project -------------------------------------------------
export const declinesFile = (home: string, project: string) => `${leanDir(home)}/${project}/review-declines.jsonl`
export async function addDecline(h: Host, project: string, d: Decline): Promise<Decline> {
  const rec: Decline = { ts: await h.clock.now(), project, ...(d.all ? { all: true } : { branch: d.branch }), ...(d.kind ? { kind: d.kind.toLowerCase() } : {}), ...(d.symbol ? { symbol: d.symbol } : {}), ...(d.path ? { path: d.path } : {}), ...(d.text ? { text: d.text.slice(0, 300) } : {}), why: d.why }
  await appendJsonl(h, declinesFile(await homeDir(h), project), rec)
  return rec
}
// the declines that apply to a branch (all-branch ones always)
export async function declinesFor(h: Host, project: string, branch: string): Promise<Decline[]> {
  const rows = await readJsonl<Decline>(h, declinesFile(await homeDir(h), project))
  return rows.filter(d => d && typeof d.why === 'string' && (d.all === true || (!!branch && d.branch === branch)))
}
// the same kind and symbol (a stable key, whatever the number, line or wording), else the same file and a similar text
export function isDeclined(f: Finding, ds: Decline[]): boolean {
  for (const d of ds) {
    if (d.kind && f.category && d.kind !== f.category) continue
    if (d.symbol) { if (hasName(`${f.path} ${f.text} ${f.fix} ${f.symbol ?? ''}`, d.symbol)) return true; continue }
    if (d.path && f.path && base(d.path) !== base(f.path)) continue
    if ((d.path || d.text) && jaccard(words(f.text), words(d.text ?? '')) >= 0.35) return true
  }
  return false
}
export const declinesText = (ds: Decline[]): string =>
  ds.length ? `Declined by the user (decided, do not raise a matching finding again; they never change your verdict for you):\n${ds.map(d => `- ${d.kind || 'any kind'}${d.symbol ? ` ${d.symbol}` : ''}${d.path ? ` (${d.path})` : ''}${d.text ? `: ${d.text.slice(0, 120)}` : ''} (why: ${d.why})`).join('\n')}` : ''

// ---- enforcement -------------------------------------------------------------------------------------------------------------
const OPTIONAL = /\b(\(optional\)|optional:|optionally,|(as|in) a (separate )?follow-?up|follow-?up (pr|change|ticket|task|work)|not required (for|in) this|nice[- ]to[- ]have|could be done later|pre-?existing (issue|duplication|pattern|code)|already (duplicated|repeated) (in|across)|out of scope for this (pr|change))/i
// first person only: "the signature is not verified" is a finding about the code, not a gap in the review
const UNVERIFIED = /\bI (did not|didn't|could not|couldn't|cannot|can't) (confirm|verify|check|see)\b|^\s*unverified\b|\bunverified:/i
const sameFile = (a: string, b: string) => { const x = a.replace(/^\.\//, ''); const y = b.replace(/^\.\//, ''); return !!x && !!y && (x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`)) }
// a line inside (or within 5 lines of) a hunk of the delta, in a file the delta touches
const nearDelta = (f: { path: string; line: number }, d: Prep) => { const file = d.changed.find(c => sameFile(c, f.path)); return !!file && (d.hunks[file] ?? []).some(([a, b]) => f.line >= a - 5 && f.line <= b + 5) }
const inChanged = (path: string, line: number, hunks: Prep['hunks']) => !!path && !!line && (hunks[path] ?? []).some(([a, b]) => line >= a && line <= b)
const candInChange = (cand: string, hunks: Prep['hunks']) => { const m = /([^\s:]+):(\d+)/.exec(cand); return !!m && inChanged(m[1]!.replace(/^\.\//, ''), Number(m[2]), hunks) }
const label = (f: Finding) => `[${f.severity}/${f.category || '?'}] ${f.path}${f.line ? `:${f.line}` : ''} ${f.text}`.slice(0, 220)

export type Context = {
  prep: Prep // the whole range from the merge base: what must be covered
  delta?: Prep | null // since the last reviewed sha (a re-review)
  earlier?: { open: Finding[]; reuse: Result['reuse']; coverage: Result['coverage'] } | null
  declines: Decline[]
  second?: { symbol: string; candidate?: string }[] // the second opinion's candidates: each must be answered
}
export type Verdict = { green: boolean; reasons: string[]; open: Finding[]; declined: Finding[]; checks: Result['checks']; reuse: Result['reuse']; coverage: Result['coverage']; notes: string[] }

export function enforce(res: Result, ctx: Context): Verdict {
  const notes: string[] = []
  const checks = [...res.checks]
  const hunks = ctx.prep.hunks
  const mention = (f: Finding, names: string[]) => names.some(n => n && hasName(`${f.path} ${f.text} ${f.fix}`, n))
  let findings = res.findings.map(f => ({ ...f }))

  for (const f of [...findings]) { // unverified goes to checks; optional is minor
    if ((f.severity === 'blocker' || f.severity === 'major') && UNVERIFIED.test(f.text)) {
      findings = findings.filter(x => x !== f)
      checks.push({ what: `unverified -> run a read-only check: ${f.path}: ${f.text.slice(0, 200)}`, why: 'the reviewer did not verify it' })
      notes.push(`an unverified ${f.severity} became a check (${f.path})`)
    } else if ((f.severity === 'blocker' || f.severity === 'major') && OPTIONAL.test(`${f.text} ${f.fix}`) && f.category !== 'completeness') {
      f.severity = 'minor'
      notes.push(`lowered to minor, the reviewer calls it optional/follow-up/pre-existing (${f.path})`)
    }
  }
  const add = (f: Omit<Finding, 'n' | 'auto'>) => findings.push({ ...f, n: 0, auto: true })

  // reuse: merge the earlier rounds' entries with this round's (this round wins), then check every new symbol
  const merged = new Map<string, Result['reuse'][number]>()
  for (const e of [...(ctx.earlier?.reuse ?? []), ...res.reuse]) merged.set(norm(e.symbol), e)
  const reuse = [...merged.values()]
  for (const r of res.reuse) {
    if (r.verdict !== 'duplicate') continue
    const cands = r.candidate.split(/[,;]\s*/).filter(c => c && !candInChange(c, hunks))
    if (!cands.length) continue
    const sym = r.symbol.split(' (')[0]!
    const names = [sym, ...cands.map(c => c.split(':')[0]!)]
    // a finding of any category that names the symbol stops the automatic one (a small copy the reviewer wrote up as a minor style finding stays minor)
    if (!findings.some(f => mention(f, names))) add({ severity: 'major', category: 'duplication', path: ctx.prep.symbols.find(s => s.name === sym)?.path ?? sym, line: 0, text: `${sym} duplicates existing code: ${cands.join(', ').slice(0, 200)}`, fix: `reuse the existing code instead${r.why ? `: ${r.why}` : ''}` })
  }
  const reasons: string[] = []
  const entryFor = (name: string) => reuse.find(e => hasName(e.symbol, name))
  const missingReuse = ctx.prep.symbols.filter(s => !entryFor(s.name))
  if (missingReuse.length) reasons.push(`reuse not checked for ${missingReuse.length} new symbol(s): ${missingReuse.slice(0, 10).map(s => `${s.name} (${s.path})`).join(', ')}: every new symbol needs a reuse entry (with a search)`)
  // a new code file in which no symbol was found (helpers that are not exported, a script) still needs an entry, named by its path or file name
  const bareFiles = ctx.prep.files.filter(f => CODE_FILE.test(f) && !ctx.prep.symbols.some(s => s.path === f) && !reuse.some(e => e.symbol.includes(f) || e.symbol.includes(base(f))))
  if (bareFiles.length) reasons.push(`reuse not checked for ${bareFiles.length} new file(s) with no symbol found: ${bareFiles.slice(0, 10).join(', ')}: give each a reuse entry (symbol = the file name) after searching for existing code that does its job`)
  for (const s of ctx.second ?? []) {
    const e = reuse.find(x => hasName(x.symbol, s.symbol))
    if (!e) reasons.push(`second opinion: ${s.symbol}${s.candidate ? ` (candidate ${s.candidate})` : ''} was not confirmed or rejected: answer it with a reuse entry`)
    else if (e.verdict === 'justified-new' && e.why.length < 40) reasons.push(`second opinion: ${s.symbol} marked justified-new without saying why the candidate ${s.candidate ?? ''} cannot be reused`)
  }
  for (const e of reuse) {
    if (e.verdict === 'justified-new' && e.candidate && e.why.length < 40 && !(ctx.second ?? []).some(s => hasName(e.symbol, s.symbol))) {
      checks.push({ what: `justify or fix: ${e.symbol} is justified-new next to ${e.candidate} without saying why that cannot be reused`, why: 'a new abstraction next to an existing one needs a reason' })
    }
  }

  // coverage
  const cmerged = new Map<string, Result['coverage'][number]>()
  for (const e of [...(ctx.earlier?.coverage ?? []), ...res.coverage]) cmerged.set(norm(e.test), e)
  const coverage = [...cmerged.values()]
  const missingCov = ctx.prep.tests.filter(t => !coverage.some(c => norm(c.test).includes(norm(t.test).slice(0, 40))))
  if (missingCov.length) reasons.push(`coverage not checked for ${missingCov.length} edited test(s): ${missingCov.slice(0, 8).map(t => `${t.path}: '${t.test}' (${t.why})`).join('; ')}: every edited test needs a coverage entry (what it protected, still covered / lost / intentional)`)
  const lost = coverage.filter(c => c.status === 'lost')
  if (lost.length && !findings.some(f => f.category === 'tests' && (f.severity === 'blocker' || f.severity === 'major'))) add({ severity: 'major', category: 'tests', path: 'tests', line: 0, text: `coverage lost: ${lost.slice(0, 6).map(c => `'${c.test}' protected ${c.protected || '?'}`).join('; ')}`, fix: 'add tests for these back, or say why they no longer apply' })

  // design findings are at least major
  for (const f of findings) if (AT_LEAST_MAJOR.has(f.category) && (f.severity === 'minor' || f.severity === 'nit')) { f.severity = 'major'; notes.push(`${f.category} finding raised to major (${f.path})`) }
  for (const s of res.siblings) {
    if (!truthy(s.needs_fix)) continue
    const what = str(s.checked)
    if (!findings.some(f => (f.category === 'scope' || f.category === 'platform') && (mention(f, [what]) || f.severity === 'major'))) add({ severity: 'major', category: 'scope', path: what.split(/\s+/)[0] ?? '?', line: 0, text: `a sibling shares the problem and the change does not fix it: ${what.slice(0, 160)}`, fix: 'fix the siblings too, or say why they differ' })
  }
  for (const u of res.user_facing) {
    if (!falsy(u.intended)) continue
    if (findings.some(f => hasName(f.text, str(u.what).slice(0, 40)))) continue
    const [file, line] = str(u.where).split(':')
    add({ severity: 'major', category: 'compatibility', path: file || '?', line: Number(line) || 0, text: `unintended user-facing change: ${str(u.what).slice(0, 100)}: ${str(u.before).slice(0, 80)} -> ${str(u.after).slice(0, 80)}`, fix: 'revert it, or confirm it is intended (the goal, PR description or work item names it)' })
  }
  for (const e of res.removed_effects) {
    if (!falsy(e.still_done) || truthy(e.intended)) continue
    const [file, line] = str(e.where).split(':')
    add({ severity: 'major', category: 'correctness', path: file || '?', line: Number(line) || 0, text: `removed side effect: ${str(e.effect).slice(0, 140)} is no longer done on every path`, fix: 'do it on the new path too, or confirm it is intended' })
  }
  for (const g of res.gaps) {
    if (truthy(g.blocks_goal) && !str(g.scoped_out) && !findings.some(f => f.category === 'completeness' && base(f.path) === base(str(g.path)))) {
      add({ severity: 'major', category: 'completeness', path: str(g.path) || '?', line: Number(g.line) || 0, text: `the change does not deliver: ${str(g.what).slice(0, 200)}`, fix: 'deliver it, or have the user confirm it is out of scope (decline it)' })
    }
  }
  for (const r of res.risks) {
    const c = str(r.check)
    if (c && !checks.some(x => x.what.includes(c.slice(0, 60)))) checks.push({ what: c, why: `risk: ${str(r.risk).slice(0, 80)} (who: ${str(r.who).slice(0, 60)}, likelihood ${str(r.likelihood) || '?'}, impact ${str(r.impact) || '?'})` })
  }

  // re-review: a NEW blocker/major about code that did not change since the last review is minor (earlier open ones keep theirs)
  if (ctx.delta) {
    const earlier = (ctx.earlier?.open ?? []).map(f => words(f.text))
    for (const f of findings) {
      if (f.auto || (f.severity !== 'blocker' && f.severity !== 'major')) continue
      if (earlier.some(e => jaccard(words(f.text), e) >= 0.3)) continue
      // only a finding with a known file and line, away from everything the delta touched (never line 0, never an unmatched path spelling)
      if (f.path && f.line > 0 && !nearDelta(f, ctx.delta)) { f.severity = 'minor'; notes.push(`new on re-review, about code that did not change since the last review: minor (${f.path}:${f.line})`) }
    }
  }
  // an earlier open blocker/major does not just vanish: the reviewer lists it again or says it is fixed (`fixed`: its number)
  for (const ef of ctx.earlier?.open ?? []) {
    if (ef.severity !== 'blocker' && ef.severity !== 'major') continue
    if (isDeclined(ef, ctx.declines) || res.fixed.includes(ef.n) || res.findings.some(f => jaccard(words(f.text), words(ef.text)) >= 0.3)) continue
    reasons.push(`earlier ${ef.severity} #${ef.n} (${label(ef).slice(0, 120)}) is neither listed again nor in "fixed": say whether it is fixed`)
  }

  // declines last, so nothing re-adds a declined finding
  const declined = findings.filter(f => isDeclined(f, ctx.declines))
  const open = findings.filter(f => !declined.includes(f))
  if (declined.length) notes.push(`${declined.length} declined finding(s) left out`)
  open.forEach((f, i) => { f.n = i + 1 })
  const blocking = open.filter(f => f.severity === 'blocker' || f.severity === 'major')
  for (const f of blocking) reasons.push(`open ${f.severity}: ${label(f)}`)
  if (res.verdict === 'needs-checks') reasons.push(`the reviewer needs checks run first (${checks.slice(0, 3).map(c => c.what.slice(0, 80)).join('; ') || 'none listed'}): run them, then review again`)
  if (res.verdict === 'changes-requested' && !blocking.length && !declined.length) reasons.push('the reviewer said changes-requested but lists no blocker or major finding: ask it to name them')
  if (!res.verdict) reasons.push('the reviewer result has no verdict (missing or unparsable JSON block)')
  return { green: reasons.length === 0, reasons, open, declined, checks, reuse, coverage, notes }
}

export const findingLine = (f: Finding) => `${f.n}. ${label(f)}${f.fix ? ` -> ${f.fix.slice(0, 160)}` : ''}`
