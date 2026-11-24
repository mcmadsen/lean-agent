// A PR too large for one review is reviewed BY AREA (1.0.28). A review thread on a PR of about 1150 files read the whole prepare text, two reviewer
// passes and their findings into its own context and passed its cap. Now `lean_review prepare` on a diff of more than 300 changed files (generated
// files excluded) or 20000 changed lines returns COUNTS ONLY and a script-built partition into at most 6 areas (by folder, balanced by changed
// lines); the thread reviews one area per pass (`scope: "area-N"` on prepare and record), each area's record is a record that is never green, and its
// final report lists the area verdicts. The partition is a pure function of the diff, so record rebuilds the same one. Data and scripts only.
import { perFileStats } from './reviewprep'
import type { Prep } from './reviewprep'
import { isTestPath } from './reviewprep'
import type { Host } from './state'

export const BIG_FILES = 300
export const BIG_LINES = 20_000
export const MAX_AREAS = 6
export const TOP_RISKY = 10
export type Stat = { path: string; add: number; del: number }
export const tooLarge = (stats: Stat[]): boolean => stats.length > BIG_FILES || stats.reduce((n, s) => n + s.add + s.del, 0) > BIG_LINES
const lines = (s: Stat) => s.add + s.del
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.')

// a group of files by folder: `key` is the folder ('.' for the root); exact: only the files directly in it (deeper folders are groups of their own)
type Group = { key: string; exact: boolean; files: Stat[]; lines: number }
const keyAt = (p: string, depth: number): string => {
  const d = dirOf(p)
  return d === '.' ? '.' : d.split('/').slice(0, depth).join('/')
}
function groupsOf(files: Stat[], depth: number, limit: number): Group[] {
  const by = new Map<string, Stat[]>()
  for (const f of files) by.set(keyAt(f.path, depth), [...(by.get(keyAt(f.path, depth)) ?? []), f])
  const out: Group[] = []
  for (const [key, fs] of by) {
    const total = fs.reduce((n, s) => n + lines(s), 0)
    const deeper = fs.some(f => dirOf(f.path) !== key && dirOf(f.path) !== '.')
    if (total > limit && deeper && depth < 8) {
      const direct = fs.filter(f => dirOf(f.path) === key)
      const rest = fs.filter(f => dirOf(f.path) !== key)
      if (direct.length) out.push({ key, exact: true, files: direct, lines: direct.reduce((n, s) => n + lines(s), 0) })
      out.push(...groupsOf(rest, depth + 1, limit))
    } else out.push({ key, exact: false, files: fs, lines: total })
  }
  return out
}

export type Area = { name: string; files: number; lines: number; keys: { key: string; exact: boolean }[] }
// at most MAX_AREAS areas, folders kept whole where they fit, balanced by changed lines (the heaviest group goes to the lightest area)
export function partition(stats: Stat[], max = MAX_AREAS): Area[] {
  if (!stats.length) return []
  const total = stats.reduce((n, s) => n + lines(s), 0)
  const groups = groupsOf(stats, 1, Math.max(1, Math.ceil(total / max))).sort((a, b) => b.lines - a.lines || a.key.localeCompare(b.key))
  const bins: { files: number; lines: number; keys: { key: string; exact: boolean }[] }[] = Array.from({ length: Math.min(max, groups.length) }, () => ({ files: 0, lines: 0, keys: [] }))
  for (const g of groups) {
    const bin = bins.reduce((m, b) => (b.lines < m.lines ? b : m), bins[0]!)
    bin.files += g.files.length
    bin.lines += g.lines
    bin.keys.push({ key: g.key, exact: g.exact })
  }
  return bins.sort((a, b) => b.lines - a.lines).map((b, i) => ({ name: `area-${i + 1}`, files: b.files, lines: b.lines, keys: b.keys.sort((x, y) => x.key.localeCompare(y.key)) }))
}
// does a changed path belong to an area (the longest folder key that matches decides, so a folder split into groups is never counted twice)
export function inArea(path: string, area: Area, all: Area[]): boolean {
  let best = ''
  let owner = ''
  for (const a of all) {
    for (const k of a.keys) {
      const hit = k.key === '.' ? !path.includes('/') : k.exact ? dirOf(path) === k.key : path.startsWith(`${k.key}/`)
      if (hit && (k.key.length > best.length || (k.key.length === best.length && k.exact))) {
        best = k.key
        owner = a.name
      }
    }
  }
  return owner === area.name
}
export const areaOf = (areas: Area[], name: string): Area | undefined => areas.find(a => a.name === name.trim().toLowerCase())
export const keyLabel = (k: { key: string; exact: boolean }) => (k.key === '.' ? '(root files)' : `${k.key}/${k.exact ? '(files directly in it)' : ''}`)
// git pathspecs that cover an area (a superset when a folder is shared with another area: the area's files are the ones named in the list)
export const pathspecs = (a: Area): string[] => a.keys.map(k => (k.key === '.' ? ':(glob)*' : k.exact ? `:(glob)${k.key}/*` : `${k.key}/`))

// the changed files that score highest on size, new symbols, export changes and names that carry risk (by script)
const RISK_NAME = /auth|secur|crypt|secret|token|passw|permiss|migrat|schema|payment|billing|session|acl|sandbox|\.sql$/i
export function riskiest(stats: Stat[], prep: Pick<Prep, 'symbols' | 'exports'>, n = TOP_RISKY): Stat[] {
  const score = (s: Stat) => {
    const base = lines(s) + 25 * prep.symbols.filter(x => x.path === s.path).length + 40 * prep.exports.filter(x => x.path === s.path).length + (RISK_NAME.test(s.path) ? 200 : 0)
    return isTestPath(s.path) ? Math.round(base / 3) : base
  }
  return [...stats].sort((a, b) => score(b) - score(a) || a.path.localeCompare(b.path)).slice(0, n)
}

// the diff text and the lists restricted to an area
export function keepSections(diff: string, keep: (path: string) => boolean): string {
  const parts = diff.split(/^(?=diff --git )/m)
  return parts.filter(p => { const m = /^diff --git a\/.+? b\/(.+)$/m.exec(p); return !m || keep(m[1]!) }).join('')
}
export function scopedPrep(p: Prep, keep: (path: string) => boolean, diff: string): Prep {
  const hunks: Prep['hunks'] = {}
  for (const [k, v] of Object.entries(p.hunks)) if (keep(k)) hunks[k] = v
  return { ...p, files: p.files.filter(keep), symbols: p.symbols.filter(x => keep(x.path)), tests: p.tests.filter(x => keep(x.path)), renamed: p.renamed.filter(x => keep(x.path)), params: p.params.filter(x => keep(x.path)), state: p.state.filter(x => keep(x.path)), exports: p.exports.filter(x => keep(x.path)), changed: p.changed.filter(keep), hunks, lines: perFileStats(diff).reduce((n, s) => n + s.add + s.del, 0) }
}

// ---- the text a too-large prepare returns: counts only -------------------------------------------------------------------------
const topLevel = (stats: Stat[]) => {
  const m = new Map<string, { files: number; lines: number }>()
  for (const s of stats) {
    const k = s.path.includes('/') ? s.path.slice(0, s.path.indexOf('/')) : '(root)'
    const c = m.get(k) ?? { files: 0, lines: 0 }
    m.set(k, { files: c.files + 1, lines: c.lines + lines(s) })
  }
  return [...m.entries()].sort((a, b) => b[1].lines - a[1].lines || a[0].localeCompare(b[0]))
}
export function bigText(stats: Stat[], prep: Pick<Prep, 'symbols' | 'exports'>, areas: Area[], limits = { files: BIG_FILES, lines: BIG_LINES }): string {
  const total = stats.reduce((n, s) => n + lines(s), 0)
  const top = topLevel(stats)
  return [
    `PR TOO LARGE: ${stats.length} changed files, ${total} changed lines (generated files left out; one review takes at most ${limits.files} files and ${limits.lines} lines).`,
    `By top-level area: ${top.slice(0, 12).map(([k, c]) => `${k} ${c.files} files/${c.lines} lines`).join('; ')}${top.length > 12 ? `; and ${top.length - 12} more` : ''}.`,
    `The 10 riskiest files (size, new symbols, export changes, risky names): ${riskiest(stats, prep).map(s => `${s.path} +${s.add}/-${s.del}`).join('; ')}.`,
    'this PR is too large for one review: review it by area. One area per pass: lean_review prepare with `scope: "area-N"` (same ref and level), the reviewer pass over that area only, lean_review record with the same `scope` (an area record is never green and is an external-style record). Do the areas one after the other, keep each result short, and list every area\'s verdict in your final report.',
    `Areas (script-built from the ${stats.length} changed files only, ${total} changed lines, balanced by changed lines, at most ${MAX_AREAS}; a folder's files the PR does not change are in no area and are not reviewed):`,
    ...areas.map(a => `- ${a.name}: ${a.files} changed files, ${a.lines} changed lines: ${a.keys.map(keyLabel).join(', ')}`),
  ].join('\n')
}

// ---- the mod's memory of the areas a thread must still review (the report gate) -----------------------------------------------------
const key = (project: string) => `review.areas.${project}`
export async function noteAreas(h: Host, project: string, sha: string, names: string[]): Promise<void> {
  const v = await h.store.get(key(project)).catch(() => undefined)
  const all: Record<string, { names: string[]; ts: number }> = v && typeof v === 'object' && !Array.isArray(v) ? (v as never) : {}
  all[sha] = { names, ts: await h.clock.now() }
  const keep = Object.entries(all).sort((a, b) => (b[1]?.ts ?? 0) - (a[1]?.ts ?? 0)).slice(0, 10)
  await h.store.set(key(project), Object.fromEntries(keep)).catch(() => undefined)
}
export async function areasOf(h: Host, project: string, sha: string): Promise<string[]> {
  const v = (await h.store.get(key(project)).catch(() => undefined)) as Record<string, { names?: unknown }> | undefined
  const n = v && typeof v === 'object' ? v[sha]?.names : undefined
  return Array.isArray(n) ? n.filter((x): x is string => typeof x === 'string') : []
}

// ---- a compact answer: counts by severity, the top findings, the path of the full list ----------------------------------------------
const SEV = ['blocker', 'major', 'minor', 'nit']
export type Row = { severity?: string; path?: string; line?: number; text?: string }
export const TOP_FINDINGS = 10
export function countsText(rows: Row[]): string {
  const c = new Map<string, number>()
  for (const r of rows) c.set(r.severity || 'unknown', (c.get(r.severity || 'unknown') ?? 0) + 1)
  return [...c.entries()].sort((a, b) => (SEV.indexOf(a[0]) < 0 ? 9 : SEV.indexOf(a[0])) - (SEV.indexOf(b[0]) < 0 ? 9 : SEV.indexOf(b[0]))).map(([k, n]) => `${n} ${k}`).join(', ')
}
export function topRows(rows: Row[], n = TOP_FINDINGS): string[] {
  const rank = (s?: string) => (SEV.includes(s ?? '') ? SEV.indexOf(s!) : 1)
  return [...rows].sort((a, b) => rank(a.severity) - rank(b.severity)).slice(0, n).map(r => `- ${r.severity || 'unknown'} ${r.path || '?'}${r.line ? `:${r.line}` : ''} ${String(r.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)}`)
}
