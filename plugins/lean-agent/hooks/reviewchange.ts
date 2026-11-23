// A review covers ONLY changed code (1.0.28). A reviewer sometimes reports on a file the PR does not touch, or on a line the change did not add
// or edit. By script: prepare hands the reviewer the changed files with their changed line ranges (changedText); the merge and the record drop
// every finding whose file is not changed, or whose line is outside every changed hunk of the file (3 lines of context each side), and COUNT
// them ("N findings dropped: outside the change (files: a.ts, b.ts)"). A finding with no file is kept only in a cross-file category
// (tests missing, docs, scope, completeness) and says so. Deleted files have no new-side lines: a finding about a deleted file (its removal) stays.
import type { Prep } from './reviewprep'

export const CONTEXT_LINES = 3
export const CROSS_FILE = new Set(['tests', 'docs', 'documentation', 'scope', 'completeness'])
type Row = { path: string; line: number; category: string; text: string }
export type Dropped = { n: number; files: string[] }

const clean = (p: string) => p.trim().replace(/^\.\//, '')
// the changed file a reported path names (exact, or a longer path that ends in it: an absolute path of the checkout), else null
function changedFile(path: string, changed: string[]): string | null {
  const p = clean(path)
  if (!p) return null
  return changed.find(c => c === p) ?? changed.find(c => p.endsWith(`/${c}`)) ?? null
}
// inside the change: the file is changed and (it has no new-side hunk: deleted file, mode change, binary; or no line is named; or the line is in a hunk +-3)
export function insideChange(path: string, line: number, prep: Pick<Prep, 'changed' | 'hunks'>): boolean {
  const c = changedFile(path, prep.changed)
  if (!c) return false
  const ranges = prep.hunks[c]
  if (!ranges?.length || !(line > 0)) return true
  return ranges.some(([a, b]) => line >= a - CONTEXT_LINES && line <= b + CONTEXT_LINES)
}

export function changeScope<T extends Row>(findings: T[], prep: Pick<Prep, 'changed' | 'hunks'>): { kept: T[]; dropped: Dropped; crossFile: number } {
  const kept: T[] = []
  const files = new Set<string>()
  let n = 0
  let crossFile = 0
  for (const f of findings) {
    if (!clean(f.path ?? '')) {
      if (CROSS_FILE.has(f.category)) { // no file: a cross-file finding, kept and said so
        crossFile++
        kept.push(/\[cross-file\]/.test(f.text) ? f : { ...f, text: `${f.text} [cross-file: no file or line]` })
      } else { n++; files.add('(no file)') }
      continue
    }
    if (insideChange(f.path, f.line, prep)) kept.push(f)
    else if (CROSS_FILE.has(f.category) && f.path === 'tests') { crossFile++; kept.push(f) } // (the gate's own "coverage lost" entry names no file)
    else { n++; files.add(clean(f.path)) }
  }
  return { kept, dropped: { n, files: [...files] }, crossFile }
}
export const droppedText = (d: Dropped, max = 8): string =>
  d.n ? `${d.n} finding${d.n === 1 ? '' : 's'} dropped: outside the change (files: ${d.files.slice(0, max).join(', ')}${d.files.length > max ? `, and ${d.files.length - max} more` : ''})` : ''

// what prepare hands the reviewer: the changed files, each with its changed new-side line ranges ("deleted" / "no line ranges" for a file with none)
export function changedText(prep: Pick<Prep, 'changed' | 'hunks'>, max = 60): string {
  const row = (f: string) => {
    const r = prep.hunks[f]
    return `${f}${r?.length ? ` ${r.slice(0, 12).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(',')}${r.length > 12 ? ',...' : ''}` : ' (deleted or no line ranges: the whole file counts)'}`
  }
  const rows = prep.changed.slice(0, max).map(row).join('; ')
  return `CHANGED CODE ONLY. Changed files and their changed line ranges (new side, from the script): ${rows}${prep.changed.length > max ? `; and ${prep.changed.length - max} more` : ''}. Review only what this change adds or changes; existing code is context only. A finding about a file or line outside these ranges (3 lines of context) is dropped by the tool. Read the changed files first, other files only to understand a caller or a definition used in the change.`
}
