// The review's deterministic inputs (0.45's new_symbols / change_focus, ported): what a reviewer should look at, found from the
// diff by a script and never by a model. Language-agnostic heuristics (TS/JS, Python, Go, Rust, C#, Java, Kotlin, Swift):
//   - new symbols and files (a symbol that already existed at the base is an edit, not new),
//   - tests the change edits so that their assertions change (renamed, flipped, deleted, skipped),
//   - new parameters with defaults, new module-level state,
//   - exported symbols the change changes (signature), moves or removes.
// `analyzeDiff` is pure over the diff text and a base-file reader; `prepare` (below) runs git for it. Heuristics miss and over-report
// on purpose in the safe direction: a list is a floor the reviewer extends, and every entry only asks for one table row.
import type { Host } from './state'
import { homeDir, leanDir, readJson } from './state'
import { slugOk } from './rules'
import { dropSections, generatedFiles } from './reviewexclude'
import type { Excluded } from './reviewexclude'

export type Sym = { name: string; path: string; line: number }
export type TestEdit = { path: string; test: string; why: string }
export type ExportChange = { name: string; path: string; line: number; kind: 'removed' | 'changed' | 'moved' }
export type Prep = {
  files: string[] // new non-test files
  symbols: Sym[] // new symbols outside tests
  tests: TestEdit[] // edited tests whose assertions change (need a coverage entry)
  renamed: { path: string; from: string; to: string }[] // tests only renamed (same body): no coverage entry needed
  params: { name: string; default: string; path: string; line: number }[]
  state: Sym[]
  exports: ExportChange[]
  changed: string[] // every file the diff touches
  lines: number // added + removed lines
  hunks: Record<string, [number, number][]> // new-side line ranges the diff adds or edits, per file
  truncated?: boolean
  excluded?: Excluded // generated files left out of everything above (reviewexclude.ts)
}

export const TEST_PATH_RE = /(^|\/)(tests?|__tests__|specs?|e2e)(\/|$)|[._-](test|spec)s?\.\w+$|_test\.go$|(^|\/)test_[^/]*$|(^|\/)src\/(test|androidTest|integrationTest)\//i
const TEST_CLASS_RE = /[A-Za-z](Tests?|Spec)\.(kt|java|cs|swift|scala)$/ // case-sensitive: Latest.kt is not a test
export const isTestPath = (p: string) => TEST_PATH_RE.test(p) || TEST_CLASS_RE.test(p)
// config and data files: a `key = [` there is not module state
const DATA_FILE = /\.(toml|ini|ya?ml|json|md|env|cfg|conf|txt|csv|lock)$/i

const SYMBOL_RES: RegExp[] = [
  /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:const|let)\s+(use[A-Z][\w$]*|[\w$]*(?:Store|Context|Provider|Manager|Registry|Service))\s*[=:]/,
  /^\s*(?:async\s+)?def\s+([A-Za-z]\w*)/, // Python (a leading underscore is private)
  /^\s*class\s+([A-Za-z_]\w*)/,
  /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, // Go
  /^\s*pub(?:\(crate\))?\s+(?:async\s+)?(?:fn|struct|enum|trait)\s+(\w+)/, // Rust
  /^\s*(?:public|internal|protected)\s+(?:(?:static|sealed|abstract|partial|async|override|virtual|final)\s+)*(?:class|interface|record|struct|enum)\s+(\w+)/, // C#, Java
  /^\s*(?:public|internal|protected)\s+(?:(?:static|async|override|virtual|final|abstract|synchronized)\s+)*(?!new\b|return\b)[\w<>[\],.?]+\s+([A-Za-z]\w*)\s*\(/, // C#, Java methods
  /^\s*(?:(?:public|internal|protected|open|abstract|data|sealed|suspend|inline|override|enum|annotation|const)\s+)*(?:fun|class|interface|object)\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(\w+)/, // Kotlin (private is not new surface)
  /^\s*(?:(?:public|open|internal|static|final|override|mutating|@\w+)\s+)*(?:func|struct|enum|protocol|actor)\s+(\w+)/, // Swift
]
export const symbolOf = (body: string): string | null => {
  for (const re of SYMBOL_RES) {
    const m = re.exec(body)
    if (m) return m[1]!
  }
  return null
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function existedBefore(base: string, name: string): boolean {
  if (!base) return false
  const n = esc(name)
  return new RegExp(`\\b(?:function\\*?|const|let|var|class|interface|type|enum|def|func|fun|fn|struct|trait|record|object|protocol|actor)\\s+(?:\\([^)]*\\)\\s*)?${n}\\b`).test(base)
    || new RegExp(`^\\s*(?:(?:public|internal|protected|private|static|final|abstract|override|async|virtual)\\s+)+[\\w<>[\\],.?]+\\s+${n}\\s*\\(`, 'm').test(base)
}

// ---- tests ------------------------------------------------------------------------------------------------------------
const TITLE_RES: RegExp[] = [
  /^\s*(?:it|test|specify)(?:\.(?:only|skip|each\([^)]*\)))?\s*\(\s*(['"`])(.+?)\1/, // group 2
  /^\s*(?:async\s+)?def\s+(test_\w+)/,
  /^func\s+(Test\w+)/,
  /^\s*(?:public\s+)?(?:async\s+)?(?:suspend\s+)?(?:fun|void|Task)\s+(`[^`]+`|test\w*|\w+Test\w*|should\w+)\s*\(/, // Kotlin, Java, C#
  /^\s*func\s+(test\w+)\s*\(/, // Swift XCTest
  /^\s*(?:public\s+)?(?:async\s+)?\w+\s+(\w+Test\w*)\s*\(/,
  /^\s*public\s+(?:async\s+)?(?:Task|void)\s+(\w+)\s*\(/, // C#/Java: a public test-class method (a [Fact] or @Test method has no marker in its own line)
]
export function testTitle(body: string): string | null {
  for (const re of TITLE_RES) {
    const m = re.exec(body)
    if (m) return (m[2] ?? m[1])!.replace(/^`|`$/g, '')
  }
  return null
}
const ASSERT_RE = /\b(?:expect|assert\w*|should|toBe|toEqual|toHaveBeenCalled\w*|toMatch\w*|XCT\w+|verify|require)\b|\bAssert\.|#expect/i
const SKIP_RE = /\b(?:it|test|describe)\.skip\b|\bx(?:it|describe)\s*\(|@(?:pytest\.mark\.)?skip|@Disabled|@Ignore\b|\[Ignore\]|\[Fact\([^)]*Skip|t\.Skip\(|XCTSkip/
const FOCUS_RE = /\b(?:it|test|describe)\.only\b|\bf(?:it|describe)\s*\(/ // turns every other test in the file off

export const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [])
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let n = 0
  for (const x of a) if (b.has(x)) n++
  return n / (a.size + b.size - n)
}

// ---- parameters with defaults -----------------------------------------------------------------------------------------
const NOT_CALL = /^(?:if|for|foreach|while|switch|catch|return|else|do|await|new|typeof|throw|assert|expect|using|try|lock|synchronized)$/
const HEADS: RegExp[] = [
  /\bfunction\*?\s*[\w$]*\s*(?:<[^>]*>)?\s*\(/,
  /\bdef\s+\w+\s*\(/,
  /\bfun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?\w+\s*\(/,
  /\bfunc\s+(?:\([^)]*\)\s*)?\w+\s*(?:<[^>]*>)?\s*\(/,
  /\bfn\s+\w+\s*(?:<[^>]*>)?\s*\(/,
  /(?:^|[\s,(])[\w$]+\s*(?::\s*[^=]+)?=\s*(?:async\s*)?\(/, // arrow function: a = (x = 1) =>, only with => on the line (checked below)
  /^\s*(?:(?:public|private|internal|protected|static|override|async|virtual|abstract|final|open|export|readonly)\s+)+[\w<>[\]?.,]+\s+[\w$]+\s*(?:<[^>]*>)?\s*\(/, // C#, Java, TS with a return type
  /^\s*(?:(?:public|private|protected|static|async|override|readonly)\s+)*[\w$]+\s*\(/, // method shorthand: only with a { after the parameters (checked below)
]
// the parameter texts of a function DEFINED on this line (balanced parentheses, split at top-level commas); [] when it is not a definition
export function paramList(line: string): string[] {
  for (const [i, re] of HEADS.entries()) {
    const m = re.exec(line)
    if (!m) continue
    const first = /[\w$]+/.exec(m[0])?.[0] ?? ''
    if (i === 5 && !/=>/.test(line)) continue
    if (i === 7 && (NOT_CALL.test(first) || !/\)\s*(?::\s*[^{=]+)?\{\s*$/.test(line))) continue
    let depth = 1
    let buf = ''
    const parts: string[] = []
    for (let k = m.index + m[0].length; k < line.length && depth; k++) {
      const c = line[k]!
      if ('([{'.includes(c)) depth++
      else if (')]}'.includes(c)) depth--
      if (!depth) break
      if (c === ',' && depth === 1) { parts.push(buf); buf = '' } else buf += c
    }
    if (buf.trim()) parts.push(buf)
    return parts
  }
  return []
}
// `a = 1`, `a: Int = 3`, `int a = 3`, `_ a: Int = 3`  ->  { name, default }
export function defaultOf(part: string): { name: string; default: string } | null {
  const p = part.trim()
  if (!p || /^(?:\.\.\.|[{[(])/.test(p)) return null
  const eq = /(?<![=!<>])=(?![=>])/.exec(p)
  if (!eq) return null
  const left = p.slice(0, eq.index).replace(/\s+$/, '')
  const dflt = p.slice(eq.index + 1).trim()
  if (!dflt) return null
  const name = (left.includes(':') ? left.slice(0, left.indexOf(':')) : left).trim().split(/\s+/).pop()?.replace(/\?$/, '') ?? ''
  return /^[A-Za-z_$][\w$]*$/.test(name) ? { name, default: dflt } : null
}

// ---- module-level state -----------------------------------------------------------------------------------------------
const STATE_TOP = /^(?:export\s+)?(?:let|var)\s+([A-Za-z_$][\w$]*)|^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:new\s+(?:Map|Set|WeakMap|Array)\b|\[|\{)|^([a-z_]\w*)\s*(?::\s*[\w[\], ]+)?=\s*(?:\[|\{|None\b|set\(|dict\(|0\b)|^(?:private\s+|internal\s+|fileprivate\s+)?(?:lateinit\s+)?var\s+([A-Za-z_]\w*)/
const STATE_STATIC = /^\s*(?:(?:public|private|internal|protected)\s+)?static\s+(?!readonly\b|final\b|class\b)(?:volatile\s+)?[\w<>,[\]?. ]+?\s+(\w+)\s*(?:=|;)/

const fileOf = (l: string, pre: string) => (l.startsWith(`${pre} a/`) || l.startsWith(`${pre} b/`) ? l.slice(6) : null)

// `readBase(path)`: the file's text at the merge base ('' when it did not exist or cannot be read)
export async function analyzeDiff(diff: string, readBase: (path: string) => Promise<string>, newFiles: Set<string> = new Set()): Promise<Prep> {
  const out: Prep = { files: [], symbols: [], tests: [], renamed: [], params: [], state: [], exports: [], changed: [], lines: 0, hunks: {} }
  const cands: Sym[] = [] // new-symbol candidates, checked against the base afterwards
  const stateCands: Sym[] = []
  const removedSyms: Sym[] = []
  const addedSyms = new Map<string, Set<string>>() // name -> files that define it on a + line
  const tests = new Map<string, Map<string, string>>() // path -> title -> why
  const removedTitles = new Map<string, string[]>()
  const addedTitles = new Map<string, Set<string>>()
  const oldAsserts = new Map<string, number[]>()
  const hunks: { file: string; rem: string[]; add: string[] }[] = []
  const params = new Map<string, Prep['params'][number]>()
  const changed = new Set<string>()
  let oldP: string | null = null
  let newP: string | null = null
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  const note = (path: string, t: string, why: string) => { const m = tests.get(path) ?? new Map<string, string>(); tests.set(path, m); if (!m.has(t) || why === 'skipped' || why === 'focused') m.set(t, why) }
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) { inHunk = false; oldP = null; newP = null; continue }
    if (!inHunk && line.startsWith('--- ')) { oldP = fileOf(line, '---'); continue }
    if (!inHunk && line.startsWith('+++ ')) { newP = fileOf(line, '+++'); if (newP) changed.add(newP); else if (oldP) changed.add(oldP); continue }
    const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))?/.exec(line)
    if (hm) {
      inHunk = true
      oldLine = Number(hm[1])
      newLine = Number(hm[2])
      hunks.push({ file: newP ?? oldP ?? '', rem: [], add: [] })
      const n = hm[3] === undefined ? 1 : Number(hm[3])
      // a deletion-only hunk (+N,0) still marks the spot where lines were removed
      if (newP) (out.hunks[newP] ??= []).push(n > 0 ? [newLine, newLine + n - 1] : [Math.max(1, newLine), newLine + 1])
      continue
    }
    if (!inHunk) continue
    const c = line[0]
    if (c === ' ') { oldLine++; newLine++; continue }
    if (c === '-') {
      out.lines++
      const body = line.slice(1)
      hunks[hunks.length - 1]?.rem.push(body)
      const f = oldP
      if (f && isTestPath(f)) {
        const t = testTitle(body)
        if (t) removedTitles.set(f, [...(removedTitles.get(f) ?? []), t])
        if (ASSERT_RE.test(body)) oldAsserts.set(f, [...(oldAsserts.get(f) ?? []), oldLine])
      } else if (f) {
        const name = symbolOf(body)
        if (name && name.length > 2) removedSyms.push({ name, path: f, line: oldLine })
      }
      oldLine++
    } else if (c === '+') {
      out.lines++
      const body = line.slice(1)
      hunks[hunks.length - 1]?.add.push(body)
      const f = newP
      if (f && isTestPath(f)) {
        const t = testTitle(body)
        if (t) addedTitles.set(f, (addedTitles.get(f) ?? new Set()).add(t))
        if (SKIP_RE.test(body)) note(f, (t ?? body.trim()).slice(0, 80), 'skipped')
        else if (FOCUS_RE.test(body)) note(f, (t ?? body.trim()).slice(0, 80), 'focused')
      } else if (f) {
        const name = symbolOf(body)
        if (name && name.length > 2) {
          cands.push({ name, path: f, line: newLine })
          addedSyms.set(name, (addedSyms.get(name) ?? new Set()).add(f))
        }
        const removedHere = (hunks[hunks.length - 1]?.rem ?? []).join('\n')
        for (const part of paramList(body)) {
          const d = defaultOf(part)
          if (d && !removedHere.includes(part.trim())) params.set(`${d.name}=${d.default}@${f}`, { ...d, path: f, line: newLine })
        }
        const sm = DATA_FILE.test(f) ? null : STATE_TOP.exec(body)
        const name2 = sm ? sm.slice(1).find(Boolean) : DATA_FILE.test(f) ? undefined : STATE_STATIC.exec(body)?.[1]
        if (name2 && (sm ? !/^\s/.test(body) : true)) stateCands.push({ name: name2, path: f, line: newLine })
      }
      newLine++
    }
  }
  const cache = new Map<string, Promise<string>>()
  const base = (p: string) => { let r = cache.get(p); if (!r) { r = readBase(p).catch(() => ''); cache.set(p, r) } return r }
  // new symbols: not defined at the base; a new file's symbols are all new
  const seen = new Set<string>()
  for (const s of cands) {
    const key = `${s.name}\0${s.path}`
    if (seen.has(key)) continue
    seen.add(key)
    if (newFiles.has(s.path) || !existedBefore(await base(s.path), s.name)) out.symbols.push(s)
  }
  for (const s of stateCands) {
    if (out.state.some(x => x.name === s.name && x.path === s.path)) continue
    if (newFiles.has(s.path) || !new RegExp(`(?:^|\\s)${esc(s.name)}\\s*[:=;]`, 'm').test(await base(s.path))) out.state.push(s)
  }
  out.files = [...newFiles].filter(f => !isTestPath(f)).sort()
  out.params = [...params.values()]
  // exported symbols the change touches: still defined in the same file (signature changed), defined in another file (moved), or gone
  const gone = new Set<string>()
  for (const r of removedSyms) {
    const k = `${r.name}\0${r.path}`
    if (gone.has(k)) continue
    gone.add(k)
    const where = addedSyms.get(r.name)
    out.exports.push({ ...r, kind: where?.has(r.path) ? 'changed' : where ? 'moved' : 'removed' })
  }
  // tests: removed titles with no counterpart (and not a pure rename), then the tests that owned a removed assertion line
  for (const h of hunks) {
    if (h.file && isTestPath(h.file) && h.rem.length === 1 && h.add.length === 1) {
      const a = testTitle(h.rem[0]!)
      const b = testTitle(h.add[0]!)
      if (a && b && a !== b && jaccard(words(a), words(b)) >= 0.5) out.renamed.push({ path: h.file, from: a, to: b })
    }
  }
  const isRenamed = (p: string, t: string) => out.renamed.some(r => r.path === p && r.from === t)
  for (const [f, ts] of removedTitles) for (const t of ts) if (!addedTitles.get(f)?.has(t) && !isRenamed(f, t)) note(f, t, 'renamed or removed')
  for (const [f, ls] of oldAsserts) {
    const text = await base(f)
    if (!text) continue
    const starts: { at: number; title: string }[] = []
    text.split('\n').forEach((l, i) => { const t = testTitle(l); if (t) starts.push({ at: i + 1, title: t }) })
    for (const ln of ls) {
      let owner: string | null = null
      for (const s of starts) if (s.at <= ln) owner = s.title
      if (owner) note(f, owner, 'assertions changed')
    }
  }
  // a rename whose assertions also changed still needs a coverage entry; a pure rename does not
  out.renamed = out.renamed.filter(r => tests.get(r.path)?.get(r.from) !== 'assertions changed')
  for (const [path, m] of tests) for (const [test, why] of m) out.tests.push({ path, test, why })
  out.changed = [...changed].sort()
  return out
}

const CAP = { files: 20, symbols: 30, tests: 25, params: 15, state: 15, exports: 20, renamed: 15 }
export function capPrep(p: Prep): Prep {
  return { ...p, files: p.files.slice(0, CAP.files), symbols: p.symbols.slice(0, CAP.symbols), tests: p.tests.slice(0, CAP.tests), params: p.params.slice(0, CAP.params), state: p.state.slice(0, CAP.state), exports: p.exports.slice(0, CAP.exports), renamed: p.renamed.slice(0, CAP.renamed) }
}

// added / removed lines per file of a unified diff, by script (the reviewer is handed these so it does not run `git diff --stat` and explore)
export function perFileStats(diff: string): { path: string; add: number; del: number }[] {
  const out: { path: string; add: number; del: number }[] = []
  let cur: { path: string; add: number; del: number } | null = null
  let inHunk = false
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff --git ')) {
      const m = / b\/(.+)$/.exec(l)
      cur = m ? { path: m[1]!, add: 0, del: 0 } : null
      if (cur) out.push(cur)
      inHunk = false
    } else if (l.startsWith('@@')) inHunk = true
    else if (cur && inHunk) {
      if (l.startsWith('+')) cur.add++
      else if (l.startsWith('-')) cur.del++
    }
  }
  return out
}
// the reviewer's reading plan: one line, the changed files with their counts, and the rule that keeps it from exploring
export function statsText(diff: string, steps: number, max = 40): string {
  const st = perFileStats(diff)
  if (!st.length) return ''
  const rows = st.slice(0, max).map(s => `${s.path} +${s.add}/-${s.del}`).join('; ')
  return `Changed files (${st.length}, added/removed lines, from the script): ${rows}${st.length > max ? `; and ${st.length - max} more` : ''}.\nRead each changed file once, diff hunks only (git diff of the range for that file), then only the surrounding lines a finding needs; do not explore. You have ${steps} tool calls (the reviewer's budget); write the json block when "N tool calls left" appears.`
}

// the lists as the reviewer's brief reads them
export function prepText(p: Prep): string {
  const parts: string[] = []
  const list = (title: string, rows: string[]) => { if (rows.length) parts.push(`${title}\n${rows.map(r => `- ${r}`).join('\n')}`) }
  list('New files and symbols (pass 3: every one needs a `reuse` entry and at least one search):', [...p.files.map(f => `new file ${f}`), ...p.symbols.map(s => `${s.name} (${s.path}:${s.line})`)])
  list('Tests whose assertions this change edits (pass 5: every one needs a `coverage` entry: what did it protect, is that still protected elsewhere, or removed on purpose?):', p.tests.map(t => `${t.path}: '${t.test}' (${t.why})`))
  list('Tests only renamed (same body, no coverage entry needed):', p.renamed.map(r => `${r.path}: '${r.from}' -> '${r.to}'`))
  list('New parameters with defaults (pass 6: do production callers always pass it?):', p.params.map(x => `${x.name} = ${x.default} (${x.path}:${x.line})`))
  list('New module-level state (pass 6: do the specs reset it?):', p.state.map(s => `${s.name} (${s.path}:${s.line})`))
  list('Exported symbols the change changes, moves or removes (pass 2: search their callers):', p.exports.map(e => `${e.name} ${e.kind} (${e.path}:${e.line})`))
  return parts.join('\n') || 'No new symbols, edited tests, defaults, state or export changes were found by the script (still check new code).'
}

// ---- git: the diff of a project's range ---------------------------------------------------------------------------------
const REF = /^[A-Za-z0-9_][A-Za-z0-9._/@^~+-]*$/
export const refOk = (r: unknown): r is string => typeof r === 'string' && REF.test(r) && !r.includes('..')
export const MAX_DIFF_CHARS = 4_000_000

export async function projectPath(h: Host, project: string): Promise<string | null> {
  if (!slugOk(project)) return null
  const projs = await readJson<Record<string, { path?: unknown }>>(h, `${leanDir(await homeDir(h))}/projects.json`, {})
  const p = projs?.[project]?.path
  return typeof p === 'string' && p.startsWith('/') ? p : null
}

export type Range = { path: string; base: string; head: string; mb: string }
// resolve the range with git: head defaults to HEAD, base to the project's default branch; the merge base is what the diff starts from
// `pathIn`: the checkout to read (the calling thread's own worktree); default the project's registered path
export async function resolveRange(h: Host, project: string, baseIn: string | undefined, headIn: string | undefined, pathIn?: string): Promise<Range | string> {
  const path = pathIn ?? (await projectPath(h, project))
  if (!path) return `unknown project ${JSON.stringify(project)}`
  const git = async (...a: string[]) => { const r = await h.process.run(['git', '-C', path, ...a], { timeoutMs: 30_000 }).catch(() => null); return r && r.exitCode === 0 ? r.stdout.trim() : null }
  const sha = (r: string) => git('rev-parse', '--verify', '--end-of-options', `${r}^{commit}`)
  if ((headIn && !refOk(headIn)) || (baseIn && !refOk(baseIn))) return 'base and head must be plain refs (branch, tag or sha)'
  const head = await sha(headIn || 'HEAD')
  if (!head) return `cannot resolve head ${headIn || 'HEAD'}`
  let base: string | null = null
  if (baseIn) base = await sha(baseIn)
  else {
    const dflt = (await git('symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'))?.replace('refs/remotes/', '')
    for (const c of [dflt, 'origin/main', 'origin/master', 'main', 'master', 'develop']) if (c && (base = await sha(c))) break
  }
  if (!base) return `cannot resolve base ${baseIn || '(no default branch found)'}: pass base`
  const mb = (await git('merge-base', base, head)) || base
  return { path, base, head, mb }
}

// the prep of `from`..`r.head` (default: the whole range from the merge base), with the diff text the risk classifier reads
// `failed`: git did not answer (an error or a timeout): an empty prep from that is NOT "nothing to check", so a green must be refused
// `exclude`: config.json review.exclude globs; generated files (reviewexclude.ts) are cut from the diff, the file lists and the line count
export async function prepare(h: Host, r: Range, from: string = r.mb, exclude: string[] = []): Promise<{ prep: Prep; diff: string; failed: boolean }> {
  // fixed options: the user's diff.noprefix / diff.external / core.quotePath settings must not change what the parser reads
  const GIT = ['-c', 'core.quotePath=false', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false']
  const git = async (...a: string[]): Promise<string | null> => { const x = await h.process.run(['git', '-C', r.path, ...GIT, ...a], { timeoutMs: 60_000 }).catch(() => null); return x && x.exitCode === 0 ? x.stdout : null }
  const raw = await git('diff', '-U0', '--no-color', '--no-renames', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '--end-of-options', from, r.head)
  const names = await git('diff', '--name-status', '--no-renames', '--end-of-options', from, r.head)
  const all = (names ?? '').split('\n').map(l => l.split('\t')).filter(p => p[1])
  // a re-review's delta may not hold a .gitattributes an earlier round added: ask the whole range (merge base..head) too
  const rangeNames = from === r.mb ? null : await git('diff', '--name-only', '--no-renames', '--end-of-options', r.mb, r.head)
  const attrChanged = rangeNames === null ? from !== r.mb : rangeNames.split('\n').some(n => n.slice(n.lastIndexOf('/') + 1) === '.gitattributes') // (git did not answer: the rule is left out)
  const gen = await generatedFiles(h, r.path, all.map(p => p[1]!), exclude, attrChanged)
  const cut = dropSections(raw ?? '', new Set(gen.files.keys()))
  let diff = cut.diff
  const truncated = diff.length > MAX_DIFF_CHARS
  if (truncated) diff = diff.slice(0, MAX_DIFF_CHARS)
  const newFiles = new Set<string>()
  for (const [st, f] of all) if (st?.startsWith('A') && f && !gen.files.has(f)) newFiles.add(f)
  const p = await analyzeDiff(diff, async f => (await git('show', `${from}:${f}`)) ?? '', newFiles)
  // the biggest excluded files first: those are the ones worth keeping out of the reviewer's own `git diff`
  const files = [...gen.files.keys()].sort((a, b) => (cut.per.get(b) ?? 0) - (cut.per.get(a) ?? 0) || a.localeCompare(b))
  if (files.length) p.excluded = { files, lines: cut.lines, ...(gen.attrFailed ? { attrFailed: true } : {}), ...(gen.attrSkipped ? { attrSkipped: true } : {}) }
  return { prep: truncated ? { ...p, truncated } : p, diff, failed: raw === null || names === null }
}
