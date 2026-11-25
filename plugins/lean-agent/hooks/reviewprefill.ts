// What a refused lean_review record tells the thread (by script, no model): the exact entry formats and a prefilled JSON of the
// "fixed" numbers (earlier findings the record did not list again) and the coverage entries (edited / removed / deleted tests),
// so the thread only confirms or edits it instead of starting a reader agent to find the finding text and the format.
import type { Finding } from './reviewgate'
import type { TestEdit } from './reviewprep'

const CAP = 20
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 3)}...` : s)

// the default status of a test edit: a removed or deleted test is intentional, changed assertions are still covered, skipped / focused is lost
export function coverageStatus(why: string): string {
  if (/skipped|focused/.test(why)) return 'lost'
  if (/assertions changed/.test(why)) return 'still covered'
  return 'intentional'
}

export const coverageEntry = (t: TestEdit) => ({ test: `${t.path}: ${t.test}`, protected: t.why === 'file deleted' ? 'the deleted test file' : t.why === 'renamed or removed' ? 'a removed test' : t.why === 'assertions changed' ? 'its changed assertions' : `its ${t.why} test`, status: coverageStatus(t.why) })

export function prefillText(unlisted: Finding[], uncovered: TestEdit[]): string {
  if (!unlisted.length && !uncovered.length) return ''
  const lines: string[] = ['How to answer (confirm or edit the JSON below; it was read from the diff and the stored findings, a script, not a model):']
  const fixed = unlisted.slice(0, CAP)
  const cov = uncovered.slice(0, CAP)
  if (fixed.length) {
    lines.push('"fixed": [numbers of earlier findings that are fixed now]. List a finding again in "findings" if it is NOT fixed. Earlier findings:')
    for (const f of fixed) lines.push(`  #${f.n} ${f.severity} ${f.path}${f.line ? `:${f.line}` : ''} ${clip(f.text, 140)}`)
    if (unlisted.length > fixed.length) lines.push(`  (+${unlisted.length - fixed.length} more earlier findings, not shown: record again after this)`)
  }
  if (cov.length) {
    lines.push('"coverage": [{"test": "<path>: <title>", "protected": "<what it checked>", "status": "still covered" | "lost" | "intentional"}]. "lost" raises a major tests finding. Tests:')
    for (const t of cov) lines.push(`  ${t.path}: '${clip(t.test, 80)}' (${t.why})`)
    if (uncovered.length > cov.length) lines.push(`  (+${uncovered.length - cov.length} more edited tests, not shown: record again after this)`)
  }
  const json: Record<string, unknown> = {}
  if (fixed.length) json.fixed = fixed.map(f => f.n)
  if (cov.length) json.coverage = cov.map(coverageEntry)
  lines.push('Prefilled (add it to the reviewer JSON; a changed status or "protected" is yours to edit; take a number out of "fixed" if that finding is NOT fixed):', JSON.stringify(json))
  return lines.join('\n')
}
