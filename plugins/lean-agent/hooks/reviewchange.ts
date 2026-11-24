// A review covers ONLY changed code (1.0.28, tightened in 1.0.31). A reviewer sometimes reports on a file the PR does not touch, on a line the
// change did not add or edit, or about something ABSENT ("no rate limiting on the anonymous endpoint": a file the PR never opened). By script:
// prepare hands the reviewer the changed hunks with their new-side line numbers (changedText); the merge and the record drop every finding that
// is not ANCHORED on a changed line: no file, a file the PR does not change, no line, a line outside every changed hunk (config
// review.contextLines extra lines each side, default 0), or an absence finding that cites no changed line. They are COUNTED ("N findings dropped:
// outside the change (files: a.ts, b.ts)") and the files that are not in the PR are named. A cross-file category (tests, docs, scope,
// completeness) is kept only when it names a changed file. Deleted files have no new-side lines: a finding about a deleted file (its removal)
// stays. A removal is reported at the line where it was cut (a deletion-only hunk marks that spot), or at the added line that replaces it.
import type { Prep } from './reviewprep'

export const CONTEXT_LINES = 0
export const MIN_FILTER_VERSION = '1.0.29'
export const CROSS_FILE = new Set(['tests', 'docs', 'documentation', 'scope', 'completeness'])
const ABSENCE = /\b(no|none|missing|lacks?|lacking|without|absent|absence|unprotected|unvalidated|unbounded|not (?:covered|validated|checked|rate[- ]?limited|tested|handled|protected|enforced|authenticated|documented))\b/i
export const isAbsence = (text: string): boolean => ABSENCE.test(text)
type Row = { path: string; line: number; category: string; text: string }
export type Dropped = { n: number; files: string[]; notInPr?: string[] }

// config review.contextLines: a whole number of lines of context around each changed hunk (0..20); anything else is the default
export const contextOf = (v: unknown): number => {
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 20 ? n : CONTEXT_LINES
}

const clean = (p: string) => p.trim().replace(/^\.\//, '')
// the changed file a reported path names (exact, or a longer path that ends in it: an absolute path of the checkout), else null
function changedFile(path: string, changed: string[]): string | null {
  const p = clean(path)
  if (!p) return null
  return changed.find(c => c === p) ?? changed.find(c => p.endsWith(`/${c}`)) ?? null
}
// inside the change: the file is changed and (it has no new-side hunk: deleted file, mode change, binary; or the named line is in a hunk +-context)
export function insideChange(path: string, line: number, prep: Pick<Prep, 'changed' | 'hunks'>, context = CONTEXT_LINES): boolean {
  const c = changedFile(path, prep.changed)
  if (!c) return false
  const ranges = prep.hunks[c]
  if (!ranges?.length) return true
  return line > 0 && ranges.some(([a, b]) => line >= a - context && line <= b + context)
}

export function changeScope<T extends Row>(findings: T[], prep: Pick<Prep, 'changed' | 'hunks'>, context = CONTEXT_LINES): { kept: T[]; dropped: Dropped & { notInPr: string[] }; crossFile: number } {
  const kept: T[] = []
  const files = new Set<string>()
  const notInPr = new Set<string>()
  let n = 0
  let crossFile = 0
  const drop = (label: string, outside?: string) => { n++; files.add(label); if (outside) notInPr.add(outside) }
  for (const f of findings) {
    const p = clean(f.path ?? '')
    if (!p) { drop('(no file)'); continue } // never kept: a finding with no file is about no changed line
    const c = changedFile(p, prep.changed)
    if (!c) { drop(p, p); continue }
    const ranges = prep.hunks[c]
    if (!ranges?.length) { kept.push(f); continue } // a deleted file (or one with no line ranges): its removal
    const cross = CROSS_FILE.has(f.category)
    if (!(f.line > 0)) {
      // no line: kept only for tests/docs/scope/completeness that name this changed file, and never when it says something is absent
      if (cross && !(isAbsence(f.text) && f.category !== 'tests' && f.category !== 'docs' && f.category !== 'documentation')) {
        crossFile++
        kept.push(/\[cross-file\]/.test(f.text) ? f : { ...f, text: `${f.text} [cross-file: names ${c}, no line]` })
      } else drop(`${p} (no line)`)
      continue
    }
    if (ranges.some(([a, b]) => f.line >= a - context && f.line <= b + context)) kept.push(f)
    else drop(p)
  }
  return { kept, dropped: { n, files: [...files], notInPr: [...notInPr] }, crossFile }
}
export const droppedText = (d: Dropped, max = 8): string =>
  d.n ? `${d.n} finding${d.n === 1 ? '' : 's'} dropped: outside the change (files: ${d.files.slice(0, max).join(', ')}${d.files.length > max ? `, and ${d.files.length - max} more` : ''})` : ''

// the part of a record the user sees: how much was reviewed and what the filter dropped (written by the mod, not by the thread)
export type Scoped = { files: number; lines: number; dropped: number; droppedFiles: string[]; notInPr: string[]; version?: string; byArea?: Record<string, { files: number; lines: number; dropped: number; droppedFiles: string[]; notInPr: string[] }> }
export function scopedOf(prep: Pick<Prep, 'changed' | 'lines'>, d: Dropped, version = ''): Scoped {
  return { files: prep.changed.length, lines: prep.lines, dropped: d.n, droppedFiles: d.files.slice(0, 40), notInPr: (d.notInPr ?? []).slice(0, 40), ...(version ? { version } : {}) }
}
export function scopeLine(s: Scoped, max = 8): string {
  const head = `reviewed ${s.files} changed file${s.files === 1 ? '' : 's'} (${s.lines} lines); ${s.dropped} finding${s.dropped === 1 ? '' : 's'} dropped${s.dropped ? `: outside the change (files: ${s.droppedFiles.slice(0, max).join(', ')}${s.droppedFiles.length > max ? `, and ${s.droppedFiles.length - max} more` : ''})` : ''}`
  const out = s.notInPr.length ? `\nthe reviewer reported on files that are not in the PR: ${s.notInPr.slice(0, max).join(', ')}${s.notInPr.length > max ? `, and ${s.notInPr.length - max} more` : ''} (dropped)` : ''
  return `${head}${out}${s.version ? `\nthis thread ran lean-agent ${s.version}` : ''}`
}

// the changed hunks of a (-U0) diff with new-side line numbers: "### path", then "<line>: <added text>" and "-: <removed text>" (no number)
export const HUNK_BUDGET = 24_000
export function hunkText(diff: string): string {
  const out: string[] = []
  let n = 0
  let inHunk = false
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff --git ')) { inHunk = false; const m = / b\/(.+)$/.exec(l); if (m) out.push(`### ${m[1]}`); continue }
    const hm = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l)
    if (hm) { inHunk = true; n = Number(hm[1]); continue }
    if (!inHunk) continue
    if (l.startsWith('+')) { out.push(`${n}: ${l.slice(1)}`); n++ } else if (l.startsWith('-')) out.push(`-: ${l.slice(1)}`)
    else if (l.startsWith(' ')) n++
  }
  return out.join('\n')
}

// what prepare hands the reviewer: the rule, the changed files with their changed new-side line ranges, and (within the size budget) the hunks
export function changedText(prep: Pick<Prep, 'changed' | 'hunks' | 'lines'>, opts: { diff?: string; context?: number; max?: number; budget?: number } = {}): string {
  const max = opts.max ?? 60
  const context = opts.context ?? CONTEXT_LINES
  const row = (f: string) => {
    const r = prep.hunks[f]
    return `${f}${r?.length ? ` ${r.slice(0, 12).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(',')}${r.length > 12 ? ',...' : ''}` : ' (deleted or no line ranges: the whole file counts)'}`
  }
  const rows = prep.changed.slice(0, max).map(row).join('; ')
  const rule = `CHANGED CODE ONLY (${prep.changed.length} changed file${prep.changed.length === 1 ? '' : 's'}, ${prep.lines} changed lines, from the script). Report only on lines in these ranges; read other files only to understand them, never to report on them; every finding is file:line of a listed range${context ? ` (or within ${context} lines of it)` : ''} plus a one-line reason. A finding with no file and changed line, about a file or line outside the ranges, or about something that is absent (no rate limiting, missing validation, not covered) without a changed line to name, is dropped by the tool and counted. A problem the change makes worse in an unchanged file is reported ON THE CHANGED LINE that causes it.`
  const files = `Changed files and their changed line ranges (new side): ${rows}${prep.changed.length > max ? `; and ${prep.changed.length - max} more` : ''}.`
  const hunks = opts.diff ? hunkText(opts.diff) : ''
  const tail = !hunks
    ? 'Read the changed files first (git diff of the range, one file at a time), other files only to understand a caller or a definition used in the change.'
    : hunks.length <= (opts.budget ?? HUNK_BUDGET)
      ? `The changed hunks (new-side line number: added or edited line; "-:" a removed line, no number). This is the whole change: read other files only to understand it.\n${hunks}`
      : 'The hunks are over the size budget for this brief: read only these ranges (git diff of the range, one file at a time), other files only to understand a caller or a definition used in the change.'
  return `${rule}\n${files}\n${tail}`
}
