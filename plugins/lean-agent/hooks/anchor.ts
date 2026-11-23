// The anchor check for inline PR review comments, by script (no model): a comment may sit only on a line the PR adds or changes (side right) or removes
// (side left), checked against the PR's own diff READ at request time and again at send time, never from the thread's memory. Also the lint of
// review-comment TEXT (a pure disclaimer is refused, so a thread cannot post it).
//
// Pure functions (hunk parsing, the check) plus `verifyAnchors`, which reads through an injected `Reader` (deskactions.ts builds one over `gh api` and the
// az bearer token on curl's stdin; a spec passes canned JSON). Nothing here writes, and no token is ever seen here.
export type Range = [number, number]
export type Lines = { right: Range[]; left: Range[] }
export type PrFile = { path: string; status: 'added' | 'modified' | 'deleted' | 'renamed' | 'binary' | 'unknown'; right: Range[]; left: Range[] }
export type Anchor = { host: 'github' | 'azure'; org: string; project: string; repo: string; pr: number; file: string; line: number; endLine?: number; side: 'right' | 'left' }
export type Reader = {
  gh: (path: string, paginate?: boolean) => Promise<unknown | null> // `gh api <path>`: the parsed JSON (pages joined into one array), or null on any failure
  az: (method: 'GET' | 'POST', url: string, body?: unknown) => Promise<unknown | null> // Azure DevOps REST with the bearer token: parsed JSON or null
}

// ---- unified-diff hunks ----------------------------------------------------------------------------------------------------------------------
const add = (r: Range[], n: number): void => {
  const last = r[r.length - 1]
  if (last && last[1] === n - 1) last[1] = n
  else r.push([n, n])
}
// the NEW-file lines a patch adds or changes (right) and the OLD-file lines it removes (left). `patch` is the text from the first "@@" on (the file headers may be
// present: they are skipped); a hunk ends by its own line counts, so a removed line that reads "-- x" is never mistaken for a header.
export function parsePatch(patch: string): Lines {
  const out: Lines = { right: [], left: [] }
  const lines = patch.replace(/\r\n?/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]!)
    if (!m) continue
    let o = Number(m[1])
    let n = Number(m[3])
    let oLeft = m[2] === undefined ? 1 : Number(m[2])
    let nLeft = m[4] === undefined ? 1 : Number(m[4])
    while ((oLeft > 0 || nLeft > 0) && i + 1 < lines.length) {
      const l = lines[++i]!
      const c = l[0]
      if (c === '\\') continue // "\ No newline at end of file"
      if (c === '+') {
        add(out.right, n++)
        nLeft--
      } else if (c === '-') {
        add(out.left, o++)
        oLeft--
      } else {
        o++
        n++
        oLeft--
        nLeft--
      }
    }
  }
  return out
}
export const inRanges = (r: Range[], n: number): boolean => r.some(([a, b]) => n >= a && n <= b)
export const formatRanges = (r: Range[]): string => (r.length ? r.map(([a, b]) => (a === b ? String(a) : `${a}-${b}`)).join(', ') : 'none')
const fromBlocks = (blocks: Range[][]): Range[] => blocks.flat().sort((a, b) => a[0] - b[0]).reduce<Range[]>((acc, [a, b]) => {
  for (let n = a; n <= b; n++) add(acc, n)
  return acc
}, [])

// GitHub `pulls/<n>/files` entry -> PrFile. No patch with changes means GitHub left it out (too large): the lines cannot be known.
export function fileFromGithub(f: unknown): PrFile | null {
  const o = f && typeof f === 'object' ? (f as Record<string, unknown>) : null
  if (!o || typeof o.filename !== 'string' || !o.filename) return null
  const status = o.status === 'removed' ? 'deleted' : o.status === 'added' ? 'added' : o.status === 'renamed' ? 'renamed' : 'modified'
  if (typeof o.patch === 'string') return { path: o.filename, status, ...parsePatch(o.patch) }
  const changes = typeof o.changes === 'number' ? o.changes : 0
  return { path: o.filename, status: changes > 0 ? 'unknown' : status === 'renamed' ? 'renamed' : 'binary', right: [], left: [] }
}

// ---- the check -------------------------------------------------------------------------------------------------------------------------------
export const CANNOT_VERIFY = 'could not verify the anchor: not sent'
const at = (a: Pick<Anchor, 'file' | 'line' | 'endLine'>): string => `${a.file}:${a.line}${a.endLine && a.endLine !== a.line ? `-${a.endLine}` : ''}`
// null = the line is one the PR changes; else the refusal, word for word
export function checkAnchor(thread: string, files: Map<string, PrFile>, a: Pick<Anchor, 'file' | 'line' | 'endLine' | 'side'>): string | null {
  const f = files.get(a.file)
  const head = `${thread} asked for ${at(a)}`
  if (!f) return `${head}: the PR does not change that file`
  if (f.status === 'unknown') return CANNOT_VERIFY
  if (f.status === 'binary') return `${head}: that file has no text lines the PR changes (binary or no content change)`
  if (a.side === 'right' && f.status === 'deleted') return `${head}: the PR deletes that file (only a comment on a removed line, side left, is possible)`
  const ranges = a.side === 'left' ? f.left : f.right
  if (inRanges(ranges, a.line) && inRanges(ranges, a.endLine ?? a.line)) return null
  return `${head}: the PR does not ${a.side === 'left' ? 'remove' : 'change'} that line (${a.side === 'left' ? 'removed' : 'changed'} ranges: ${formatRanges(ranges)})`
}

// ---- reading the PR --------------------------------------------------------------------------------------------------------------------------
const enc = encodeURIComponent
const strip = (p: string): string => p.replace(/^\/+/, '')
type Loaded = { files: (path: string) => Promise<PrFile | null>; head?: string }
const arr = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : null)
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)

async function loadGithub(r: Reader, a: Anchor): Promise<Loaded | null> {
  const raw = arr(await r.gh(`repos/${a.repo}/pulls/${a.pr}/files?per_page=100`, true))
  const sha = (rec(rec(await r.gh(`repos/${a.repo}/pulls/${a.pr}`))?.head)?.sha ?? '') as unknown
  if (!raw || typeof sha !== 'string' || !/^[0-9a-f]{7,64}$/i.test(sha)) return null
  const map = new Map<string, PrFile>()
  for (const f of raw) {
    const p = fileFromGithub(f)
    if (p) map.set(p.path, p)
  }
  return { files: async path => map.get(path) ?? null, head: sha }
}
const changeKind = (t: unknown): 'none' | 'add' | 'delete' | 'edit' => {
  const s = typeof t === 'number' ? ['none', 'add', 'delete', 'edit'][t] : typeof t === 'string' ? t.toLowerCase() : ''
  return s === 'add' || s === 'delete' || s === 'edit' ? s : 'none'
}
async function loadAzure(r: Reader, a: Anchor): Promise<Loaded | null> {
  const repo = `https://dev.azure.com/${enc(a.org)}/${enc(a.project)}/_apis/git/repositories/${enc(a.repo)}`
  const iters = arr(rec(await r.az('GET', `${repo}/pullRequests/${a.pr}/iterations?api-version=7.1`))?.value)
  const last = iters?.map(rec).filter((x): x is Record<string, unknown> => !!x && typeof x.id === 'number').sort((x, y) => (y.id as number) - (x.id as number))[0]
  const source = rec(last?.sourceRefCommit)?.commitId
  const common = rec(last?.commonRefCommit)?.commitId
  if (!last || typeof source !== 'string' || typeof common !== 'string') return null
  const ch = rec(await r.az('GET', `${repo}/pullRequests/${a.pr}/iterations/${last.id}/changes?$top=2000&api-version=7.1`))
  const entries = arr(ch?.changeEntries)
  if (!entries) return null
  const truncated = Number(ch?.nextSkip ?? 0) > 0 || Number(ch?.nextTop ?? 0) > 0
  const known = new Map<string, { type: string; original: string }>()
  for (const e of entries) {
    const o = rec(e)
    const item = rec(o?.item)
    if (!o || !item || typeof item.path !== 'string' || item.isFolder === true) continue
    known.set(strip(item.path), { type: String(o.changeType ?? '').toLowerCase(), original: typeof o.originalPath === 'string' ? o.originalPath : item.path })
  }
  const memo = new Map<string, Promise<PrFile | null>>()
  const one = async (path: string): Promise<PrFile | null> => {
    const k = known.get(path)
    if (!k) return truncated ? { path, status: 'unknown', right: [], left: [] } : null // a listing cut short cannot say the file is not in the PR
    const status = k.type.includes('delete') ? 'deleted' : k.type.includes('add') ? 'added' : k.type.includes('rename') ? 'renamed' : 'modified'
    const d = rec(await r.az('POST', `${repo}/filediffs?api-version=7.1-preview.1`, { fileDiffParams: [{ path: `/${path}`, originalPath: k.original }], baseVersionCommit: common, targetVersionCommit: source }))
    const blocks = arr(rec(arr(d?.value)?.[0])?.lineDiffBlocks) ?? arr(d?.lineDiffBlocks)
    if (!blocks) return { path, status: 'unknown', right: [], left: [] }
    const right: Range[][] = []
    const left: Range[][] = []
    for (const b of blocks) {
      const o = rec(b)
      if (!o) continue
      const kind = changeKind(o.changeType)
      const m = [Number(o.modifiedLineNumberStart), Number(o.modifiedLinesCount)]
      const l = [Number(o.originalLineNumberStart), Number(o.originalLinesCount)]
      if ((kind === 'add' || kind === 'edit') && m[0]! > 0 && m[1]! > 0) right.push([[m[0]!, m[0]! + m[1]! - 1]])
      if ((kind === 'delete' || kind === 'edit') && l[0]! > 0 && l[1]! > 0) left.push([[l[0]!, l[0]! + l[1]! - 1]])
    }
    return { path, status, right: fromBlocks(right), left: fromBlocks(left) }
  }
  return { files: path => memo.get(path) ?? (memo.set(path, one(path)), memo.get(path)!) }
}

// Reads the diff of every distinct PR the anchors name (once each) and checks every anchor. refusals[i] is null for an anchor that stands; `heads` is the
// PR head commit of each GitHub PR (the commit an inline GitHub comment must name). An unreadable diff refuses its anchors as CANNOT_VERIFY.
export const prKey = (a: Pick<Anchor, 'host' | 'org' | 'project' | 'repo' | 'pr'>): string => `${a.host}/${a.org}/${a.project}/${a.repo}#${a.pr}`
export async function verifyAnchors(r: Reader, thread: string, anchors: Anchor[]): Promise<{ refusals: (string | null)[]; heads: Record<string, string> }> {
  const loaded = new Map<string, Promise<Loaded | null>>()
  const heads: Record<string, string> = {}
  const refusals: (string | null)[] = []
  for (const a of anchors) {
    const k = prKey(a)
    if (!loaded.has(k)) loaded.set(k, (a.host === 'github' ? loadGithub(r, a) : loadAzure(r, a)).catch(() => null))
    const l = await loaded.get(k)!
    if (!l) {
      refusals.push(CANNOT_VERIFY)
      continue
    }
    if (l.head) heads[k] = l.head
    const f = await l.files(a.file).catch(() => ({ path: a.file, status: 'unknown', right: [], left: [] }) as PrFile)
    refusals.push(checkAnchor(thread, f ? new Map([[a.file, f]]) : new Map(), a))
  }
  return { refusals, heads }
}

// ---- the lint of review-comment TEXT ---------------------------------------------------------------------------------------------------------
// A comment that only says what the reviewer did not do ("partial coverage", "no tests run", "I could not verify", "not reviewed") or only approves ("LGTM")
// tells a reader nothing to act on: refused with the reason, the thread keeps it for its own report to the user. One real sentence anywhere lets the text through.
const DISCLAIMER: RegExp[] = [
  /\b(partial|limited|incomplete|best[- ]effort) (review )?coverage\b/,
  /\bcoverage (is |was )?(partial|limited|incomplete)\b/,
  /\b(this|the|my) review (is|was) (only |just )?(partial|limited|incomplete|not exhaustive)\b/,
  /\bno tests? (were |was )?(run|ran|executed)\b/,
  /\b(i|we) (could not|couldn'?t|cannot|can'?t|did not|didn'?t|have not|haven'?t|was unable to|were unable to|am unable to) (fully |completely )?(verify|confirm|check|validate|review|run|execute|test)\b/,
]
// "not reviewed" and the like count only as a short sentence on its own (a real finding may say "the handler did not check for null")
const SHORT_DISCLAIMER = /\bnot (fully |completely |been )?(reviewed|verified|checked|tested)\b/
const APPROVAL = /^(lgtm|looks good( to me)?|ship it|approved?|\+1)$/
export function lintReviewText(body: string): string | null {
  const plain = body.toLowerCase().replace(/[*_`>#~]/g, ' ').replace(/\s+/g, ' ').trim()
  const parts = plain.split(/(?<=[.!?;])\s+|\n+/).map(s => s.replace(/^[-\s]+|[\s.!]+$/g, '')).filter(Boolean)
  if (!parts.length) return null
  if (parts.every(s => APPROVAL.test(s) || DISCLAIMER.some(re => re.test(s)) || (s.split(' ').length <= 6 && SHORT_DISCLAIMER.test(s)))) {
    return parts.length === 1 && APPROVAL.test(parts[0]!)
      ? 'the comment is only an approval phrase (LGTM): it adds nothing a reader can act on; keep it for your report to the user, not as a PR comment'
      : 'the comment is only a disclaimer (partial coverage, tests not run, could not verify, not reviewed): a PR comment states one issue found; put what you did not check in your report to the user'
  }
  return null
}
