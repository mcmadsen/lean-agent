// The rules PR (lean_rules actions pr-plan and retire-upstreamed): what lean-agent learned about a project, turned into a plan for the
// project's OWN Claude files (CLAUDE.md files and .claude/rules/*.md) so the whole team gets it and the always-loaded text shrinks.
// Scripts over models: every count, match and estimate here is computed without a model; the thread that runs the rules-pr skill only
// writes the edits and the PR text from the plan. Read-only on the repo (git ls-files / grep / show), writes only
// ~/.lean-agent/<project>/rules-pr/ (the plan, as JSON and as text) and, for retire-upstreamed with apply, the project's own store.
//   - repo files: every CLAUDE.md / CLAUDE.local.md and .claude/rules/**.md, tracked or not (local ones count for tokens, are never
//     matched against and never proposed for change); loads every session (root CLAUDE.md, .claude/CLAUDE.md, a rule without `paths:`)
//     or only in an area (a nested CLAUDE.md, a rule with `paths:`); tokens = characters / 4, the estimate the rule caps use;
//   - lean-agent's side: the learned rules with their load log, the review lessons with the offer log, the workers' missing context;
//   - computed: duplicates, always-loaded sections that name one folder (moves), upstream candidates, stale lines, recurring missing
//     context with no rule, and the tokens per session before and after.
import { atomicWrite, homeDir, leanDir, readJson, readJsonl } from './state'
import type { Host } from './state'
import { RULES_LOG, SCRIPTS_BLOCK, bodyOf, checkoutsOf, globProblem, globRe, looksMechanical, pathsIn, pathsOf, projectDir, recordLearn, slugOk, tokensOf, withRulesLock } from './rules'
import type { Learn } from './rules'
import { fileSize } from './ledger'
import { readConfig } from './budget'
import { jaccard, readLessons, removeLesson, repoOf, verifyLessons, wordsOf, wset } from './reviewlessons'
import type { Lesson } from './reviewlessons'

export const MIN_SESSIONS = 3 // a lean rule is an upstream candidate after this many distinct sessions ...
export const MIN_DAYS = 7 // ... spread over at least this many days between its first and its last load
export const MIN_GAPS = 2 // a missing-context cluster is recurring from this many distinct reports
export const WINDOW_DAYS = 90 // loads, offers and reports older than this are not counted
export const DUP_SIM = 0.6 // word overlap (Jaccard) of two lines that say the same thing, lean-agent text against the repo's
export const REPO_DUP_SIM = 0.8 // stricter between two repo lines: "keep every team instruction's meaning"
export const RETIRE_SHARE = 0.8 // a lean rule or lesson whose lines are this much in the repo files is retired by retire-upstreamed
export const MIN_WORDS = 4 // shorter lines are never compared
export const MIN_MOVE_TOKENS = 30 // a section smaller than this is not worth a file of its own
export const MAX_COVER = 0.6 // a folder holding more of the repo than this is no area: nothing is gained by moving a section to it
export const RULE_FILE_TOKENS = 12 // the frontmatter of a new rule file
export const MAX_SYMBOL_CHECKS = 150
export const MAX_GLOB_CHECKS = 60
export const MAX_LINES = 4000
export const MAX_VERIFY_HELPERS = 150
export const MAX_OUT = 6000 // characters of the summary the tool answers with (the files hold the rest)

export const estTokens = (t: string) => Math.ceil(t.length / 4)
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const DAY_MS = 86_400_000
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// ---- types of the plan ------------------------------------------------------------------------------------------------------
export type RepoFile = { path: string; kind: 'claude' | 'local' | 'rule'; tracked: boolean; tokens: number; load: 'always' | 'scoped'; paths: string[]; proposable: boolean }
export type Move = { file: string; heading: string; from: number; to: number; tokens: number; target: string; paths: string[]; why: 'heading' | 'body'; merge: boolean }
export type Upstream = { rule: string; target: string; paths: string[]; text: string; tokens: number; loads: number; sessions: number; spanDays: number; first: string; last: string; triggers: string[]; merge: boolean; dropped: { duplicate: number; stale: number; unsafe: number }; unsafe: string[] }
export type Stale = { file: string; line: number; text: string; missing: string[]; checked: number; action: 'remove' | 'review' }
export type RepoDup = { file: string; line: number; text: string; sameAs: string; sim: number }
export type LeanDup = { source: string; text: string; file: string; line: number; sim: number }
export type Cluster = { count: number; keywords: string[]; samples: string[]; paths: string[]; last: string; covered: boolean; mechanical: boolean }
export type Plan = {
  version: 1
  project: string
  date: string
  repo: string
  ref: string | null
  thresholds: { minSessions: number; minDays: number; minGaps: number; windowDays: number }
  files: RepoFile[]
  lean: { rules: { name: string; tokens: number; paths: string[]; loads: number; sessions: number; spanDays: number; first: string; last: string; triggers: string[]; dupShare: number; lines: number }[]; loadsVerified: boolean; lessons: { live: number; offered: number; top: { id: number; offered: number; last: string }[]; stale: number[]; usedRecorded: false } }
  moves: Move[]
  upstream: Upstream[]
  duplicates: { leanVsRepo: LeanDup[]; repoVsRepo: RepoDup[] }
  retire: { rules: string[]; lessons: number[] }
  stale: Stale[]
  missing: { clusters: Cluster[]; reports: number; recurring: number }
  tokens: { alwaysBefore: number; alwaysAfter: number; scopedBefore: number; scopedAfter: number; moved: number; removed: number; added: number; leanTwice: number }
  notes: string[]
}

// ---- the repo: files and reads (the working tree, or a ref for the merged state) -------------------------------------------------
type Repo = { root: string; ref: string | null; all: string[]; set: Set<string>; tracked: Set<string>; warn: string[]; read: (p: string) => Promise<string | null> }
const run = async (h: Host, cwd: string, argv: string[]): Promise<{ code: number; out: string }> => {
  try {
    const r = await h.process.run(argv, { cwd, timeoutMs: 30_000 })
    return { code: r.exitCode, out: r.stdout }
  } catch {
    return { code: -1, out: '' }
  }
}
const names = (s: string) => s.split('\0').filter(Boolean) // git -z: a name with a non-ASCII character is not quoted
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const dirName = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
export const isClaudeFile = (p: string): boolean => {
  if (p.startsWith('.git/') || p.startsWith('node_modules/') || p.includes('/node_modules/') || p.startsWith('.claude/rules/lean-agent/')) return false // (the synced copies of lean-agent's own rules are not the team's)
  const b = base(p)
  return b === 'CLAUDE.md' || b === 'CLAUDE.local.md' || (p.startsWith('.claude/rules/') && p.endsWith('.md'))
}

// a Repo, or the reason there is none (a string): an incomplete listing is never used (an empty file list would make every path "gone")
export async function openRepo(h: Host, root: string, ref?: string): Promise<Repo | string> {
  const dir = root.replace(/(.)\/+$/, '$1')
  if (ref) {
    if (!/^[A-Za-z0-9_][\w./@^~{}:-]*$/.test(ref)) return `${ref} is not a plain git ref`
    const t = await run(h, dir, ['git', 'ls-tree', '-r', '-z', '--name-only', ref])
    if (t.code !== 0) return `git ls-tree ${ref} failed in ${dir} (no such ref, or not a git checkout)`
    const all = names(t.out)
    return { root: dir, ref, all, set: new Set(all), tracked: new Set(all), warn: [], read: async p => { const r = await run(h, dir, ['git', 'show', `${ref}:${p}`]); return r.code === 0 ? r.out : null } }
  }
  const tr = await run(h, dir, ['git', 'ls-files', '-z', '--cached'])
  if (tr.code !== 0) return `${dir} is not a git checkout (git ls-files failed)`
  const tracked = new Set(names(tr.out))
  const oth = await run(h, dir, ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  if (oth.code !== 0) return `git ls-files --others failed in ${dir}: the file list is incomplete, so nothing is judged from it`
  const all = new Set(names(oth.out))
  const warn: string[] = []
  // CLAUDE.local.md is gitignored by design: it still loads, so it counts
  const ign = await run(h, dir, ['git', 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', '*CLAUDE.local.md'])
  if (ign.code === 0) for (const p of names(ign.out)) all.add(p)
  else warn.push('the ignored files could not be listed: a CLAUDE.local.md is not counted in the tokens')
  return { root: dir, ref: null, all: [...all].sort(), set: all, tracked, warn, read: async p => h.fs.read(`${dir}/${p}`).then(String).catch(() => null) }
}

// ---- reading a Claude file: lines, sections ------------------------------------------------------------------------------------------------
type Ln = { n: number; raw: string; kind: 'skip' | 'fence' | 'heading' | 'text' | 'blank'; level: number; title: string }
export function scan(text: string): Ln[] {
  const raw = text.split('\n')
  const out: Ln[] = []
  let k = 0
  let fm = 0
  if (raw[0]?.trim() === '---') {
    const end = raw.findIndex((l, i) => i > 0 && l.trim() === '---')
    if (end > 0) fm = end + 1
  }
  let fence = ''
  let comment = false
  for (; k < raw.length; k++) {
    const r = raw[k]!
    const n = k + 1
    const t = r.trim()
    const mk = (kind: Ln['kind'], level = 0, title = ''): Ln => ({ n, raw: r, kind, level, title })
    if (k < fm) { out.push(mk('skip')); continue }
    if (comment) { if (t.includes('-->')) comment = false; out.push(mk('skip')); continue }
    if (!fence && t.startsWith('<!--')) { if (!t.includes('-->')) comment = true; out.push(mk('skip')); continue }
    const f = /^(```+|~~~+)/.exec(t)
    if (fence) { if (f && f[1]!.startsWith(fence[0]!) && f[1]!.length >= fence.length) fence = ''; out.push(mk('fence')); continue }
    if (f) { fence = f[1]!; out.push(mk('fence')); continue }
    const hm = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(t)
    if (hm) { out.push(mk('heading', hm[1]!.length, hm[2]!)); continue }
    out.push(mk(t ? 'text' : 'blank'))
  }
  return out
}
// a content line: text outside code and comments, the list marker and table pipes removed; the lines a comparison is worth running on
export const clean = (s: string) => s.trim().replace(/^>\s*/, '').replace(/^(?:[-*+]|\d+[.)])\s+/, '').replace(/^\|/, '').replace(/\|$/, '').replace(/\s*\|\s*/g, ' ').trim()
export type Content = { n: number; text: string; words: Set<string> }
export function contentOf(text: string): Content[] {
  const out: Content[] = []
  for (const l of scan(text)) {
    if (l.kind !== 'text') continue
    const c = clean(l.raw)
    if (/^[-:\s|]+$/.test(c)) continue
    const words = wset(c)
    if (words.size >= MIN_WORDS) out.push({ n: l.n, text: c, words })
  }
  return out.slice(0, MAX_LINES)
}
export type Section = { level: number; title: string; from: number; to: number; text: string; tokens: number; children: boolean }
export function sectionsOf(text: string): Section[] {
  const ls = scan(text)
  const heads = ls.filter(l => l.kind === 'heading')
  return heads.map((h, i) => {
    const next = heads.slice(i + 1).find(x => x.level <= h.level)
    const to = next ? next.n - 1 : ls.length
    const body = ls.slice(h.n - 1, to).map(l => l.raw).join('\n').replace(/\s+$/, '')
    return { level: h.level, title: h.title, from: h.n, to, text: body, tokens: estTokens(body), children: heads.slice(i + 1).some(x => x.n <= to && x.level > h.level) }
  })
}

// ---- scope: does a section name a folder? ----------------------------------------------------------------------------------------------------
// the folders a text names (a folder, a file's folder, the fixed part of a glob), only those the repo has; `*` alone is no scope
function scopeDirs(text: string, repo: { set: Set<string>; dirs: Set<string> }): string[] {
  const out: string[] = []
  const toks = new Set<string>()
  const norm = (s: string) => s.replace(/^\.\//, '').replace(/[.,;:)]+$/, '').replace(/\/+$/, '') // `services/billing/` and `services/billing` are one name
  for (const t of pathsIn(text.replace(/`/g, ' '))) toks.add(norm(t))
  for (const m of text.matchAll(/`([^`\n\s]+)`/g)) if (m[1]!.includes('/')) toks.add(norm(m[1]!))
  for (const t of toks) {
    if (!t || t.startsWith('/') || t.startsWith('~') || t.includes('..')) continue
    if (/[*?[{]/.test(t)) {
      if (globProblem(t)) continue
      const fixed = t.replace(/[*?[{].*$/, '')
      const d = fixed.endsWith('/') ? fixed.slice(0, -1) : dirName(fixed)
      if (d && repo.dirs.has(d)) out.push(d)
    } else {
      const d = t.replace(/\/+$/, '')
      if (repo.dirs.has(d)) out.push(d)
      else if (repo.set.has(d) && dirName(d)) out.push(dirName(d))
    }
  }
  return out // (one entry per distinct name the text uses: a section naming one folder three ways counts three)
}
const under = (d: string, scope: string) => d === scope || d.startsWith(`${scope}/`)
function commonDir(dirs: string[]): string {
  if (!dirs.length) return ''
  const segs = dirs.map(d => d.split('/'))
  const first = segs[0]!
  let n = 0
  while (n < first.length && segs.every(s => s[n] === first[n])) n++
  return first.slice(0, n).join('/')
}
const slugOf = (scope: string) => scope.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'area'

// ---- the load log (rule loads), the same file rulesStats counts --------------------------------------------------------------------------
const LOG_TAIL_BYTES = 3_000_000
async function readLog<T>(h: Host, path: string): Promise<T[]> {
  const rows = await readJsonl<T>(h, path)
  if (rows.length) return rows
  const size = await fileSize(h, path) // (a log past 4 MiB cannot be read whole: its newest part is)
  if (!size) return []
  const from = Math.max(1, size - LOG_TAIL_BYTES + 1)
  const r = await h.process.run(['tail', '-c', `+${from}`, path]).catch(() => null)
  if (!r || r.exitCode !== 0) return []
  const out: T[] = []
  for (const l of r.stdout.split('\n').slice(from > 1 ? 1 : 0)) {
    try { if (l.trim()) out.push(JSON.parse(l) as T) } catch { /* a torn line */ }
  }
  return out
}
export type Use = { loads: number; sessions: number; first: number; last: number; spanDays: number; triggers: string[] }
export async function ruleUsage(h: Host, project: string, since: number): Promise<{ byRule: Record<string, Use>; rows: number }> {
  const home = await homeDir(h)
  type Row = { ts?: number; rule?: string; project?: string; session?: string; agent?: string; sha?: string; e?: { file_path?: string; load_reason?: string; trigger_file_path?: string; session_id?: string } }
  const log = await readLog<Row>(h, RULES_LOG(home))
  const repo = (await readJson<Record<string, { path?: string }>>(h, `${leanDir(home)}/projects.json`, {}))?.[project]?.path
  const roots = typeof repo === 'string' && repo.startsWith('/') ? await checkoutsOf(h, project, repo).catch(() => [repo]) : null
  const seen = new Set<string>()
  const acc = new Map<string, { loads: number; sessions: Set<string>; first: number; last: number; trig: Map<string, number> }>()
  let rows = 0
  const add = (rule: string, ts: number, session: string, trigger: string) => {
    if (ts * 1000 < since) return
    let a = acc.get(rule)
    if (!a) acc.set(rule, (a = { loads: 0, sessions: new Set(), first: Infinity, last: 0, trig: new Map() }))
    a.loads++
    a.sessions.add(session || `day:${day(ts * 1000)}`) // (a load with no session id counts once per day: never more sessions than the log proves)
    a.first = Math.min(a.first, ts * 1000)
    a.last = Math.max(a.last, ts * 1000)
    if (trigger) a.trig.set(trigger, (a.trig.get(trigger) ?? 0) + 1)
    rows++
  }
  for (const r of log) {
    const ts = typeof r.ts === 'number' ? r.ts : 0
    if (typeof r.rule === 'string' && typeof r.project === 'string') {
      if (r.project !== project) continue
      const key = `${r.rule}\0${r.sha ?? ''}\0${r.session ?? ''}\0${r.agent ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      add(r.rule, ts, r.session ?? '', '')
      continue
    }
    const f = r.e?.file_path ?? ''
    const i = f.indexOf('/rules/lean-agent/')
    if (i < 0) continue
    const root = roots ? roots.find(p => f.startsWith(`${p}/.claude/rules/lean-agent/`)) : undefined
    if (roots && !root) continue
    const key = `${f}\0${r.e?.load_reason ?? ''}\0${r.e?.trigger_file_path ?? ''}\0${r.ts ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    const trig = (r.e?.trigger_file_path ?? '').replace(`${root ?? ''}/`, '')
    add(f.slice(i + 18), ts, r.e?.session_id ?? '', trig && !trig.startsWith('/') ? trig : '')
  }
  const byRule: Record<string, Use> = {}
  for (const [k, a] of acc) byRule[k] = { loads: a.loads, sessions: a.sessions.size, first: a.first, last: a.last, spanDays: Math.floor((a.last - a.first) / DAY_MS), triggers: [...a.trig].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, 5).map(x => x[0]) }
  return { byRule, rows }
}

// ---- the matching of lines -------------------------------------------------------------------------------------------------------------------------
// what the team may never be handed: lean-agent's own names, ids, costs and the user's paths
const UNSAFE: [RegExp, string][] = [
  [/\blean[_-]agent\b|\blean_[a-z]+\b|\bLEAN-(?:FEEDBACK|AUDIT)\b/i, 'names lean-agent'],
  [/\.lean-agent|~\/|\/(?:Users|home|root)\/[^\s`'")]+/, 'a personal path'],
  [/\b(?:thread|worker)\s+t\d+\b|\bthreads\/t\d+|\bt\d+\s+(?:done|reported)\b/i, 'a thread id'],
  [/\$\s?\d|\b\d+(?:\.\d+)?\s*USD\b/i, 'a cost'],
  [/[\w.+-]+@[\w-]+\.[\w.]+/, 'an email address'],
  [/(?:^|[^\w&])#\d{2,}\b/, 'a PR or ticket number'],
]
export const unsafeWhy = (s: string): string => UNSAFE.find(([re]) => re.test(s))?.[1] ?? ''

// Do two lines say the same thing? Words are not enough: "use 2 spaces" and "use 4 spaces", "run X" and "never run X" share every word of 3+
// letters. So the numbers and the negating words (not, never, no, only, avoid ...) of the two lines must be the same, and a line is a
// duplicate of another only when it is (nearly) all inside it: the line that would be removed never holds anything the kept one lacks.
export type Q = { words: Set<string>; text: string }
const NEG = /\b(?:not|never|no|don'?t|doesn'?t|cannot|can'?t|avoid|without|unless|except|only|must|always)\b/gi
const signature = (t: string) => `${[...new Set(t.match(/\d+/g) ?? [])].sort().join(',')}|${[...new Set((t.toLowerCase().match(NEG) ?? []).map(x => x.replace(/'/g, '')))].sort().join(',')}`
type Pool = { items: Q[]; idx: Map<string, number[]> }
function poolOf(items: Q[]): Pool {
  const idx = new Map<string, number[]>()
  items.forEach((p, i) => { for (const w of p.words) { const a = idx.get(w); if (a) a.push(i); else idx.set(w, [i]) } })
  return { items, idx }
}
// the line of `pool` that `q` repeats (word overlap through an index of the words: no pass over every pair), or null
function best(q: Q, pool: Pool): { i: number; sim: number } | null {
  const hits = new Map<number, number>()
  for (const w of q.words) for (const i of pool.idx.get(w) ?? []) hits.set(i, (hits.get(i) ?? 0) + 1)
  const sig = signature(q.text)
  let hit: { i: number; sim: number } | null = null
  for (const [i, n] of hits) {
    const p = pool.items[i]!
    const j = n / (q.words.size + p.words.size - n || 1)
    const inside = q.words.size >= 5 && n / q.words.size >= 0.9 // q is (nearly) all in p
    const sim = inside ? Math.max(j, 0.9) : j
    if (sim < DUP_SIM || signature(p.text) !== sig) continue
    if (!hit || sim > hit.sim || (sim === hit.sim && i < hit.i)) hit = { i, sim }
  }
  return hit
}

// ---- staleness: names a line mentions that the repo does not have ----------------------------------------------------------------------------------
type Exists = (k: { kind: string; text: string }, dir: string) => Promise<boolean | null>
// one checker (and one budget of greps) for all the texts of a plan; a path counts as found at the repo root or beside the file that names it
function existsIn(h: Host, repo: Repo, dirs: Set<string>): Exists {
  const cache = new Map<string, boolean | null>()
  const basenames = new Set(repo.all.map(base))
  let symbols = 0
  let globs = 0
  const grep = async (name: string): Promise<boolean | null> => {
    if (symbols >= MAX_SYMBOL_CHECKS) return null
    symbols++
    const args = ['git', 'grep', '-F', '-w', '-q', '-e', name, ...(repo.ref ? [repo.ref] : ['--untracked', '--exclude-standard']), '--', '.', ...['*CLAUDE.md', '*CLAUDE.local.md', '.claude/rules'].map(x => `:(exclude)${x}`)] // (the Claude files themselves are never a hit)
    const r = await run(h, repo.root, args)
    return r.code === 0 ? true : r.code === 1 ? false : null
  }
  return async (k, dir) => {
    const key = `${k.kind}\0${k.text}\0${k.kind === 'path' ? dir : ''}`
    if (cache.has(key)) return cache.get(key)!
    let res: boolean | null = null
    if (k.kind === 'path') {
      const t = k.text.replace(/\/+$/, '')
      const near = (p: string) => repo.set.has(p) || dirs.has(p) || (dir !== '' && (repo.set.has(`${dir}/${p}`) || dirs.has(`${dir}/${p}`)))
      if (/[*?[{]/.test(t)) {
        if (globProblem(t) || globs >= MAX_GLOB_CHECKS) res = null
        else { globs++; const re = globRe(t); const rd = dir ? globRe(`${dir}/${t}`) : re; res = repo.all.some(f => re.test(f) || rd.test(f)) }
      } else if (t.includes('/')) res = near(t)
      else res = basenames.has(t) || dirs.has(t) ? true : await grep(t) // `Config.load` looks like a file name but may be a symbol
    } else res = await grep(k.text)
    cache.set(key, res)
    return res
  }
}
async function staleOf(exists: Exists, files: { path: string; text: string }[]): Promise<Stale[]> {
  const out: Stale[] = []
  for (const f of files) {
    const dir = dirName(f.path)
    for (const l of scan(f.text)) {
      if (l.kind !== 'text') continue
      const toks = tokensOf(l.raw).filter(t => t.kind !== 'number').slice(0, 8)
      if (!toks.length) continue
      const gone: string[] = []
      let symbolGone = false
      let checked = 0
      for (const t of toks) {
        const e = await exists(t, dir)
        if (e === null) continue
        checked++
        if (e === false) { gone.push(t.text); if (t.kind === 'symbol') symbolGone = true }
      }
      if (!gone.length) continue
      // remove only when every checked name is gone, at least two, and one of them is a symbol a grep of the whole repo did not find: a path
      // alone may be generated or ignored (dist/, .env), so that is a line for a person to judge
      out.push({ file: f.path, line: l.n, text: clip(clean(l.raw), 200), missing: gone, checked, action: gone.length === checked && gone.length >= 2 && symbolGone ? 'remove' : 'review' })
    }
  }
  return out
}

// ---- missing context: the workers' LEAN-FEEDBACK `missing`, clustered by words --------------------------------------------------------------------
type Gap = { ts?: number; path?: string; area?: string | null; text?: string }
export function clusterGaps(gaps: Gap[], minGaps: number): { clusters: { count: number; keywords: string[]; samples: string[]; paths: string[]; last: number; words: Set<string> }[]; reports: number } {
  const byText = new Map<string, { text: string; words: Set<string>; ts: number; paths: Set<string> }>()
  for (const g of [...gaps].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))) {
    const text = String(g.text ?? '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    const same = byText.get(text.toLowerCase())
    if (same) { if (g.path) same.paths.add(g.path); continue } // (one report names several paths: one row each)
    byText.set(text.toLowerCase(), { text, words: new Set(wordsOf(text)), ts: g.ts ?? 0, paths: new Set(g.path ? [g.path] : []) })
  }
  const items = [...byText.values()]
  const cl: { first: Set<string>; items: typeof items }[] = []
  for (const it of items) {
    let hit: (typeof cl)[number] | null = null
    let sim = 0.4
    for (const c of cl) { const s = jaccard(c.first, it.words); if (s >= sim) { sim = s; hit = c } }
    if (hit) hit.items.push(it)
    else cl.push({ first: it.words, items: [it] })
  }
  const clusters = cl.filter(c => c.items.length >= minGaps).map(c => {
    const freq = new Map<string, number>()
    for (const it of c.items) for (const w of it.words) freq.set(w, (freq.get(w) ?? 0) + 1)
    const keywords = [...freq].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6).map(x => x[0])
    return { count: c.items.length, keywords, samples: c.items.slice(0, 3).map(i => clip(i.text, 200)), paths: [...new Set(c.items.flatMap(i => [...i.paths]))].sort().slice(0, 5), last: Math.max(...c.items.map(i => i.ts)), words: new Set(keywords) }
  })
  clusters.sort((a, b) => b.count - a.count || a.keywords.join(' ').localeCompare(b.keywords.join(' ')))
  return { clusters, reports: items.length }
}

// ---- the plan ------------------------------------------------------------------------------------------------------------------------------------
type Cfg = { rulesPr?: { minSessions?: number; minDays?: number; minGaps?: number; windowDays?: number } }
export type PlanIn = { repo?: string; ref?: string; minSessions?: number; minDays?: number; minGaps?: number; windowDays?: number }
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d)

const dirs0 = (repo: Repo): Set<string> => {
  const dirs = new Set<string>()
  for (const f of repo.all) for (let d = dirName(f); d && !dirs.has(d); d = dirName(d)) dirs.add(d)
  return dirs
}

type LeanRule = { name: string; text: string; paths: string[]; content: Content[]; tokens: number }
async function leanRules(h: Host, project: string): Promise<LeanRule[]> {
  const pdir = `${projectDir(await homeDir(h), project)}/rules`
  const out: LeanRule[] = []
  for (const f of (await h.fs.list(pdir).catch(() => [])).filter(x => x.kind === 'file' && x.name.endsWith('.md')).sort((a, b) => a.name.localeCompare(b.name))) {
    const t = String(await h.fs.read(`${pdir}/${f.name}`).catch(() => ''))
    const body = bodyOf(t).replace(SCRIPTS_BLOCK, '') // the adopted scripts' lines name lean_script: never the team's
    out.push({ name: f.name, text: body, paths: pathsOf(t), content: contentOf(body), tokens: estTokens(body.trim()) })
  }
  return out
}

export async function buildPlan(h: Host, project: string, i: PlanIn = {}): Promise<{ ok: true; plan: Plan } | { ok: false; text: string }> {
  if (!slugOk(project)) return { ok: false, text: 'pr-plan needs a project name' }
  const home = await homeDir(h)
  const now = await h.clock.now()
  const cfg = ((await readConfig(h, home).catch(() => ({}))) as Cfg).rulesPr ?? {}
  const th = { minSessions: num(i.minSessions, num(cfg.minSessions, MIN_SESSIONS)), minDays: num(i.minDays, num(cfg.minDays, MIN_DAYS)), minGaps: num(i.minGaps, num(cfg.minGaps, MIN_GAPS)), windowDays: num(i.windowDays, num(cfg.windowDays, WINDOW_DAYS)) }
  const root = i.repo || (await repoOf(h, project))
  if (!root.startsWith('/')) return { ok: false, text: `pr-plan needs repo (an absolute path) or a registered project ${project}` }
  const repo = await openRepo(h, root, i.ref)
  if (typeof repo === 'string') return { ok: false, text: `pr-plan: ${repo}` }
  const notes: string[] = [...repo.warn]
  const since = now - th.windowDays * DAY_MS
  const dirs = dirs0(repo)
  const exists = existsIn(h, repo, dirs) // one budget of greps for the repo's lines and the lean rules' lines

  // 1. the repo's Claude files
  const texts: { path: string; text: string; file: RepoFile }[] = []
  for (const p of repo.all.filter(isClaudeFile)) {
    const text = await repo.read(p)
    if (text === null) { notes.push(`${p}: could not be read, left out`); continue }
    const b = base(p)
    const kind: RepoFile['kind'] = b === 'CLAUDE.local.md' ? 'local' : p.startsWith('.claude/rules/') ? 'rule' : 'claude'
    const d = dirName(p)
    const paths = kind === 'rule' ? pathsOf(text) : kind === 'claude' && d !== '' && d !== '.claude' ? [`${d}/**`] : []
    const load: RepoFile['load'] = kind === 'rule' ? (paths.length ? 'scoped' : 'always') : d === '' || d === '.claude' ? 'always' : 'scoped'
    texts.push({ path: p, text, file: { path: p, kind, tracked: repo.tracked.has(p), tokens: estTokens(text), load, paths, proposable: kind !== 'local' && repo.tracked.has(p) } }) // (an untracked file counts for tokens but a PR cannot change it)
  }
  const order = (f: RepoFile) => (f.load === 'always' ? 0 : 1) + (f.path === 'CLAUDE.md' ? -1 : 0) // the root CLAUDE.md first, then what loads every session, then the areas
  texts.sort((a, b) => order(a.file) - order(b.file) || a.path.localeCompare(b.path))
  const files = texts.map(t => t.file)
  const team = texts.filter(t => t.file.proposable) // what the team shares (committed, not local): the only text a line can be "already there" in, and the only text a PR edits
  const teamLines = team.flatMap(t => contentOf(t.text).map(c => ({ ...c, file: t.path })))
  const teamPool = poolOf(teamLines)
  if (!files.length) notes.push('the repo has no CLAUDE.md or .claude/rules file yet: every upstream rule would be a new file')

  // 2. lean-agent's rules, their loads, the lessons
  const rules = await leanRules(h, project)
  const usage = await ruleUsage(h, project, since)
  const lessonsAll = (await readLessons(h, project)).filter(l => !l.dropped)
  const lessonDup: { l: Lesson; sim: number; at: (typeof teamLines)[number] }[] = []
  for (const l of lessonsAll) {
    const w = wset(l.text)
    if (w.size < MIN_WORDS) continue
    const b = best({ words: w, text: l.text }, teamPool)
    if (b) lessonDup.push({ l, sim: b.sim, at: teamLines[b.i]! })
  }
  const lessonStale: number[] = []
  // the lesson verify logic (helper lines whose path and symbol are gone); it greps once per helper, so a big store is skipped, not waited for
  if (lessonsAll.filter(l => l.family === 'shared-helpers').length <= MAX_VERIFY_HELPERS) {
    const vl = await verifyLessons(h, project, repo.root, false).catch(() => ({ lines: [] as string[], flagged: 0 }))
    for (const l of vl.lines) { const m = /^would remove #(\d+):/.exec(l); if (m) lessonStale.push(Number(m[1])) }
  } else notes.push(`more than ${MAX_VERIFY_HELPERS} helper lessons: their staleness was not checked here (lean_review lessons-verify does it)`)
  const offers = (await readLog<{ ts?: number; project?: string; offered?: { id?: number }[] }>(h, `${leanDir(home)}/logs/review-lessons.jsonl`)).filter(r => r.project === project && (r.ts ?? 0) * 1000 >= since)
  const offered = new Map<number, { n: number; last: number }>()
  for (const r of offers) for (const o of r.offered ?? []) if (typeof o.id === 'number') { const x = offered.get(o.id) ?? { n: 0, last: 0 }; x.n++; x.last = Math.max(x.last, (r.ts ?? 0) * 1000); offered.set(o.id, x) }

  // 3. (a) lean text already in the repo files
  const leanDups: LeanDup[] = []
  const dupShare = new Map<string, number>()
  const unmatched = new Map<string, Content[]>()
  for (const r of rules) {
    let n = 0
    const rest: Content[] = []
    for (const c of r.content) {
      const b = best(c, teamPool)
      if (b) { n++; leanDups.push({ source: `rule ${r.name}`, text: clip(c.text, 160), file: teamLines[b.i]!.file, line: teamLines[b.i]!.n, sim: +b.sim.toFixed(2) }) } else rest.push(c)
    }
    dupShare.set(r.name, r.content.length ? +(n / r.content.length).toFixed(2) : 0)
    unmatched.set(r.name, rest)
  }
  for (const d of lessonDup) leanDups.push({ source: `lesson #${d.l.id}`, text: clip(d.l.text, 160), file: d.at.file, line: d.at.n, sim: +d.sim.toFixed(2) })
  const retire = { rules: rules.filter(r => r.content.length && (dupShare.get(r.name) ?? 0) >= RETIRE_SHARE).map(r => r.name), lessons: lessonDup.map(d => d.l.id) }

  // 4. (b) always-loaded sections that are about one folder
  const moves: Move[] = []
  const total = repo.all.length || 1
  const tree = { set: repo.set, dirs }
  const targetPaths = new Map<string, string[] | null>() // a target that exists: its `paths:` (a move only joins a file with the same scope)
  for (const t of team) {
    if (t.file.load !== 'always') continue
    let until = 0
    for (const s of sectionsOf(t.text)) {
      if (s.from <= until || (s.level === 1 && s.children) || s.tokens < MIN_MOVE_TOKENS) continue // (a level-1 title with sections under it is the file's title, its sections are judged one by one)
      if (/^\s*@\S/m.test(s.text) || /\]\((?!https?:|mailto:|#|\/)/.test(s.text)) continue // an @import or a relative link means something else from another folder
      const head = scopeDirs(s.title, tree)
      const body = scopeDirs(s.text, tree)
      let scope = ''
      let why: Move['why'] = 'body'
      if (head.length) {
        const c = commonDir(head)
        if (c && body.filter(d => under(d, c)).length / Math.max(1, body.length) >= 0.7) { scope = c; why = 'heading' }
      } else if (body.length >= 3) scope = commonDir(body) // three names, all in one folder: a passing mention of two is not an area
      if (!scope || repo.all.filter(f => under(f, scope)).length / total > MAX_COVER) continue
      const target = `.claude/rules/${slugOf(scope)}.md`
      const wanted = [`${scope}/**`]
      if (repo.set.has(target) && !targetPaths.has(target)) targetPaths.set(target, pathsOf((await repo.read(target)) ?? ''))
      const have = targetPaths.get(target)
      if (have !== undefined && JSON.stringify(have) !== JSON.stringify(wanted)) { notes.push(`"${s.title}" in ${t.path} names ${scope}/ but ${target} exists with ${have && have.length ? `paths ${have.join(', ')}` : 'no paths (it loads every session)'}: not moved`); continue }
      until = s.to
      moves.push({ file: t.path, heading: s.title, from: s.from, to: s.to, tokens: s.tokens, target, paths: wanted, why, merge: have !== undefined })
    }
  }
  const inMoved = (f: string, n: number) => moves.find(m => m.file === f && n >= m.from && n <= m.to)

  // 5. (d) stale lines of the files a PR may change
  const stale = await staleOf(exists, team.map(t => ({ path: t.path, text: t.text })))
  const staleRemoved = new Set(stale.filter(s => s.action === 'remove').map(s => `${s.file}:${s.line}`))

  // 6. repo lines said twice. `team` is ordered widest first, so the later file never loads in more sessions than the earlier one: the later
  // copy goes, and only when the earlier one reaches every session (or has the very same paths); two different areas each keep their own line.
  // The copy that stays must itself stay: not in a section this plan moves, not a line it removes as stale.
  const repoDups: RepoDup[] = []
  const contents = team.map(t => contentOf(t.text))
  const pools = contents.map(poolOf)
  for (let a = 1; a < team.length; a++) {
    for (const c of contents[a]!) {
      for (let b = 0; b < a; b++) {
        const other = team[b]!.file
        if (other.load !== 'always' && JSON.stringify(other.paths) !== JSON.stringify(team[a]!.file.paths)) continue
        const hit = best(c, pools[b]!)
        if (!hit || hit.sim < REPO_DUP_SIM) continue
        const kept = contents[b]![hit.i]!
        if (inMoved(other.path, kept.n) || staleRemoved.has(`${other.path}:${kept.n}`)) continue
        repoDups.push({ file: team[a]!.path, line: c.n, text: clip(c.text, 160), sameAs: `${other.path}:${kept.n}`, sim: +hit.sim.toFixed(2) })
        break
      }
    }
  }

  // 7. (c) upstream candidates
  const upstream: Upstream[] = []
  const lean: Plan['lean']['rules'] = []
  for (const r of rules) {
    const u = usage.byRule[r.name]
    lean.push({ name: r.name, tokens: r.tokens, paths: r.paths, loads: u?.loads ?? 0, sessions: u?.sessions ?? 0, spanDays: u?.spanDays ?? 0, first: u ? day(u.first) : '', last: u ? day(u.last) : '', triggers: u?.triggers ?? [], dupShare: dupShare.get(r.name) ?? 0, lines: r.content.length })
  }
  // a lean line whose names are all gone is not carried into the repo (the stale check of the repo's own lines, run on the rule texts)
  const leanGone = new Set((await staleOf(exists, rules.map(r => ({ path: r.name, text: r.text })))).filter(s => s.action === 'remove').map(s => `${s.file}:${s.line}`))
  for (const r of rules) {
    const u = usage.byRule[r.name]
    if (!u || u.sessions < th.minSessions || u.spanDays < th.minDays) continue
    if (retire.rules.includes(r.name) || (dupShare.get(r.name) ?? 0) >= 0.5) continue
    const dropped = { duplicate: r.content.length - (unmatched.get(r.name) ?? []).length, stale: 0, unsafe: 0 }
    const unsafe: string[] = []
    const keep = new Set<number>()
    for (const c of unmatched.get(r.name) ?? []) {
      if (leanGone.has(`${r.name}:${c.n}`)) { dropped.stale++; continue }
      const why = unsafeWhy(c.text)
      if (why) { dropped.unsafe++; unsafe.push(`${clip(c.text, 80)} (${why})`); continue }
      keep.add(c.n)
    }
    if (!keep.size) continue
    // the rule's own lines, with its headings, minus what was dropped (a dropped content line is any not in `keep`); every other line is
    // checked too (a heading, a short line, a line of a code block): one that names lean-agent never reaches a team file, and a code
    // block with such a line goes whole
    const all = new Set(r.content.map(c => c.n))
    const lines: string[] = []
    let fence: { at: number; bad: boolean } | null = null
    for (const l of scan(r.text)) {
      if (l.kind === 'skip') continue
      if (l.kind === 'text' && all.has(l.n) && !keep.has(l.n)) continue
      const why = l.kind === 'text' && all.has(l.n) ? '' : unsafeWhy(l.raw)
      if (l.kind === 'fence') {
        if (!fence) fence = { at: lines.length, bad: false }
        lines.push(l.raw)
        if (why) fence.bad = true
        if (/^\s*(```|~~~)\s*$/.test(l.raw) && lines.length - fence.at > 1) { // the closing fence
          if (fence.bad) { dropped.unsafe++; unsafe.push(`a code block (${unsafeWhy(lines.slice(fence.at).join('\n'))})`); lines.length = fence.at }
          fence = null
        }
        continue
      }
      if (why) { dropped.unsafe++; unsafe.push(`${clip(l.raw.trim(), 80)} (${why})`); continue }
      lines.push(l.raw)
    }
    const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
    const isProject = r.name === '_project.md'
    const target = r.paths.length && !isProject ? `.claude/rules/${r.name}` : 'CLAUDE.md' // a rule with no `paths:` would load every session: it joins the root CLAUDE.md
    upstream.push({ rule: r.name, target, paths: r.paths, text, tokens: estTokens(text), loads: u.loads, sessions: u.sessions, spanDays: u.spanDays, first: day(u.first), last: day(u.last), triggers: u.triggers, merge: repo.set.has(target), dropped, unsafe })
  }

  // 8. (e) recurring missing context with no rule
  const gaps = (await readJsonl<Gap>(h, `${projectDir(home, project)}/gaps.jsonl`)).filter(g => (g.ts ?? now) >= since)
  const cl = clusterGaps(gaps, th.minGaps)
  // covered: one line of the repo files or the lean rules holds most of the cluster's words
  const pool = [...teamLines, ...rules.flatMap(r => r.content)].map(p => new Set(wordsOf(p.text)))
  const clusters: Cluster[] = cl.clusters.map(c => {
    const kw = [...c.words]
    const covered = kw.length >= 2 && pool.some(p => kw.filter(w => p.has(w)).length / kw.length >= 0.6)
    return { count: c.count, keywords: c.keywords, samples: c.samples, paths: c.paths, last: day(c.last), covered, mechanical: c.samples.some(looksMechanical) }
  })

  // 9. (f) tokens per session
  const lineTokens = (n: number, t: (typeof texts)[number]) => { const l = t.text.split('\n')[n - 1]; return l ? estTokens(l) + 1 : 0 }
  const fileOf = new Map(texts.map(t => [t.path, t]))
  const removals = [...repoDups.map(d => ({ file: d.file, line: d.line })), ...stale.filter(s => s.action === 'remove').map(s => ({ file: s.file, line: s.line }))]
  const uniq = [...new Map(removals.map(r => [`${r.file}:${r.line}`, r])).values()]
  let removedAlways = 0
  let removedScoped = 0
  let removedInMoved = 0
  for (const r of uniq) {
    const t = fileOf.get(r.file)
    if (!t) continue
    const n = lineTokens(r.line, t)
    const m = inMoved(r.file, r.line)
    if (m) removedInMoved += n
    else if (t.file.load === 'always') removedAlways += n
    else removedScoped += n
  }
  const movedGross = moves.reduce((s, m) => s + m.tokens, 0) // leaves the always-loaded files whole (its removed lines go with it)
  const newFiles = new Set(moves.filter(m => !m.merge).map(m => m.target)).size
  const addAlways = upstream.filter(u => !u.paths.length).reduce((s, u) => s + u.tokens, 0)
  const addScoped = upstream.filter(u => u.paths.length).reduce((s, u) => s + u.tokens + (u.merge ? 0 : RULE_FILE_TOKENS), 0)
  const fileCost = newFiles * RULE_FILE_TOKENS
  const alwaysBefore = files.filter(f => f.load === 'always').reduce((s, f) => s + f.tokens, 0)
  const scopedBefore = files.filter(f => f.load === 'scoped').reduce((s, f) => s + f.tokens, 0)
  const leanTwice = rules.filter(r => retire.rules.includes(r.name)).reduce((s, r) => s + r.tokens, 0)

  const plan: Plan = {
    version: 1, project, date: day(now), repo: repo.root, ref: repo.ref, thresholds: th, files,
    lean: { rules: lean, loadsVerified: usage.rows > 0, lessons: { live: lessonsAll.length, offered: offers.length, top: [...offered].sort((a, b) => b[1].n - a[1].n || a[0] - b[0]).slice(0, 10).map(([id, x]) => ({ id, offered: x.n, last: day(x.last) })), stale: lessonStale, usedRecorded: false } },
    moves, upstream, duplicates: { leanVsRepo: leanDups, repoVsRepo: repoDups }, retire, stale,
    missing: { clusters: clusters.filter(c => !c.covered), reports: cl.reports, recurring: clusters.length },
    tokens: { alwaysBefore, alwaysAfter: alwaysBefore - removedAlways - movedGross + addAlways, scopedBefore, scopedAfter: scopedBefore - removedScoped + addScoped + movedGross - removedInMoved + fileCost, moved: movedGross, removed: removedAlways + removedScoped + removedInMoved, added: addAlways + addScoped + fileCost, leanTwice },
    notes,
  }
  if (!usage.rows) notes.push(`no rule load of ${project} recorded in the last ${th.windowDays} days: no upstream candidate (loading is unverified)`)
  if (!lessonsAll.length) notes.push('no review lessons for this project')
  else notes.push('review lessons: how often a line was offered to a review is recorded; whether it was used is not')
  if (cl.reports && !plan.missing.clusters.length) notes.push('no recurring missing-context cluster without a rule')
  return { ok: true, plan }
}

// ---- the readable summary ----------------------------------------------------------------------------------------------------------------------------
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
export function renderPlan(p: Plan): string {
  const t = p.tokens
  const o: string[] = [`# Claude files plan for ${p.project} (${p.date})`, '', `Checkout: ${p.repo}${p.ref ? ` at ${p.ref}` : ''}. Every number below is computed, none is a model's guess (tokens = characters / 4).`, '']
  o.push('## Tokens per session (always loaded) and in areas', '', '| | before | after |', '|---|---|---|', `| always loaded | ${k(t.alwaysBefore)} | ${k(t.alwaysAfter)} (${t.alwaysAfter - t.alwaysBefore >= 0 ? '+' : ''}${t.alwaysAfter - t.alwaysBefore}) |`, `| path-scoped (all areas together) | ${k(t.scopedBefore)} | ${k(t.scopedAfter)} |`, '')
  o.push(`Moved out of always-loaded files: ${t.moved} tokens; removed lines: ${t.removed}; added: ${t.added}. Lean-agent rules loaded in addition to text the repo already has: ${t.leanTwice} tokens.`, '')
  o.push('## Repo files', '', '| file | loads | tokens | tracked | paths |', '|---|---|---|---|---|', ...p.files.map(f => `| ${f.path}${f.proposable ? '' : ' (local: never changed)'} | ${f.load === 'always' ? 'every session' : 'in an area'} | ${f.tokens} | ${f.tracked ? 'yes' : 'no'} | ${f.paths.join(', ') || '-'} |`), '')
  o.push(`## Sections to move into path rules (${p.moves.length})`, '', ...(p.moves.length ? p.moves.map(m => `- ${m.file}:${m.from}-${m.to} "${m.heading}" (${m.tokens} tokens, named by its ${m.why}) -> ${m.target}${m.merge ? ' (exists: add to it)' : ''}, paths: ${m.paths.join(', ')}`) : ['- none']), '')
  o.push(`## Lean-agent rules to add (${p.upstream.length}; at least ${p.thresholds.minSessions} sessions over ${p.thresholds.minDays} days, not already in the repo)`, '', ...(p.upstream.length ? p.upstream.map(u => `- ${u.rule} -> ${u.target}${u.merge ? ' (exists: merge)' : ''}${u.paths.length ? `, paths: ${u.paths.join(', ')}` : ' (always loaded)'}: ${u.loads} loads in ${u.sessions} sessions, ${u.first}..${u.last} (${u.spanDays} days)${u.triggers.length ? `, triggered by ${u.triggers.join(', ')}` : ''}; ${u.tokens} tokens; left out: ${u.dropped.duplicate} already in the repo, ${u.dropped.stale} stale, ${u.dropped.unsafe} not for a team file`) : ['- none']), '')
  o.push(`## Stale lines (${p.stale.length})`, '', ...(p.stale.length ? p.stale.map(s => `- ${s.file}:${s.line} [${s.action}] not found: ${s.missing.join(', ')} | ${s.text}`) : ['- none']), '')
  o.push(`## Lines said twice in the repo files (${p.duplicates.repoVsRepo.length})`, '', ...(p.duplicates.repoVsRepo.length ? p.duplicates.repoVsRepo.map(d => `- ${d.file}:${d.line} = ${d.sameAs} (${d.sim}) | ${d.text}`) : ['- none']), '')
  o.push(`## Lean-agent text already in the repo files (${p.duplicates.leanVsRepo.length}); fully duplicated, to retire: ${p.retire.rules.join(', ') || 'no rule'}${p.retire.lessons.length ? `, lessons ${p.retire.lessons.map(x => `#${x}`).join(' ')}` : ''}`, '', ...p.duplicates.leanVsRepo.slice(0, 20).map(d => `- ${d.source} = ${d.file}:${d.line} (${d.sim}) | ${d.text}`), '')
  o.push(`## Recurring missing context with no rule (${p.missing.clusters.length} of ${p.missing.recurring} recurring clusters, ${p.missing.reports} distinct reports)`, '', ...(p.missing.clusters.length ? p.missing.clusters.map(c => `- ${c.count}x [${c.keywords.join(' ')}]${c.paths.length ? ` paths: ${c.paths.join(', ')}` : ''}${c.mechanical ? ' (mechanical: a script, not a rule)' : ''}: ${c.samples[0]}`) : ['- none']), '')
  o.push('## Review lessons', '', `${p.lean.lessons.live} live; offered to reviews ${p.lean.lessons.offered} times in the window; ${p.lean.lessons.stale.length} flagged stale by verify (${p.lean.lessons.stale.map(x => `#${x}`).join(' ') || 'none'}). Whether a lesson was used is not recorded.`, '')
  if (p.notes.length) o.push('## Notes', '', ...p.notes.map(n => `- ${n}`), '')
  return o.join('\n')
}

export async function prPlanTool(h: Host, project: string, i: PlanIn): Promise<{ ok: boolean; text: string }> {
  const r = await buildPlan(h, project, i)
  if (!r.ok) return { ok: false, text: r.text }
  const home = await homeDir(h)
  const dir = `${projectDir(home, project)}/rules-pr`
  const stem0 = `${dir}/plan-${r.plan.date}`
  const md = renderPlan(r.plan)
  await atomicWrite(h, `${stem0}.json`, JSON.stringify(r.plan, null, 2) + '\n')
  await atomicWrite(h, `${stem0}.md`, md + '\n')
  const worth = r.plan.moves.length + r.plan.upstream.length + r.plan.stale.filter(s => s.action === 'remove').length + r.plan.duplicates.repoVsRepo.length
  const head = `plan written: ${stem0}.json (the plan) and ${stem0}.md (this text). ${worth ? `${worth} change(s) proposed.` : 'NOTHING to propose: do not open a PR.'}`
  const body = md.length > MAX_OUT ? `${md.slice(0, MAX_OUT)}\n… (cut: the .md file has the rest)` : md
  return { ok: true, text: `${head}\n\n${body}` }
}

// ---- retire-upstreamed: lean text that now lives in the repo files stops loading from ~/.lean-agent --------------------------------------------------
// the content lines of the team's own COMMITTED files (never the local one, never an untracked draft), the root CLAUDE.md first so a line
// said twice is credited to it
async function teamContent(repo: Repo): Promise<{ lines: (Content & { file: string })[]; pool: Pool }> {
  const lines: (Content & { file: string })[] = []
  const paths = repo.all.filter(p => isClaudeFile(p) && base(p) !== 'CLAUDE.local.md' && repo.tracked.has(p)).sort((a, b) => Number(b === 'CLAUDE.md') - Number(a === 'CLAUDE.md') || a.localeCompare(b))
  for (const p of paths) for (const c of contentOf((await repo.read(p)) ?? '')) lines.push({ ...c, file: p })
  return { lines, pool: poolOf(lines) }
}

export async function dupSummary(h: Host, project: string): Promise<string[]> {
  const repoPath = await repoOf(h, project)
  if (!repoPath.startsWith('/')) return []
  const repo = await openRepo(h, repoPath)
  if (typeof repo === 'string') return []
  const { lines: team, pool } = await teamContent(repo)
  if (!team.length) return []
  const out: string[] = []
  for (const r of await leanRules(h, project)) {
    if (!r.content.length) continue
    const n = r.content.filter(c => best(c, pool)).length
    if (n / r.content.length >= 0.5) out.push(`rule ${r.name}: ${n} of ${r.content.length} lines are already in the repo's Claude files${n / r.content.length >= RETIRE_SHARE ? ': it loads twice, retire it (lean_rules retire-upstreamed)' : ''}`)
  }
  const dups = (await readLessons(h, project)).filter(l => !l.dropped && wset(l.text).size >= MIN_WORDS && best({ words: wset(l.text), text: l.text }, pool))
  if (dups.length) out.push(`review lessons: ${dups.length} line(s) are already in the repo's Claude files (${dups.slice(0, 6).map(l => `#${l.id}`).join(' ')}${dups.length > 6 ? ' ...' : ''}): lean_rules retire-upstreamed`)
  return out
}

export async function retireUpstreamed(h: Host, project: string, i: { repo?: string; ref?: string; apply?: boolean }): Promise<{ ok: boolean; text: string }> {
  if (!slugOk(project)) return { ok: false, text: 'retire-upstreamed needs a project name' }
  const home = await homeDir(h)
  const root = i.repo || (await repoOf(h, project))
  if (!root.startsWith('/')) return { ok: false, text: `retire-upstreamed needs repo (an absolute path) or a registered project ${project}` }
  // apply works only from a ref: the text that counts is what was merged, never a file that is untracked or edited in a working tree
  if (i.apply && !i.ref) return { ok: false, text: 'retire-upstreamed apply needs ref (the merged branch, e.g. origin/main): only text that is committed there may retire a rule. Run it without apply to see what would go.' }
  const repo = await openRepo(h, root, i.ref)
  if (typeof repo === 'string') return { ok: false, text: `retire-upstreamed: ${repo}` }
  const { lines: team, pool } = await teamContent(repo)
  const out: string[] = [`checked against ${repo.root}${repo.ref ? ` at ${repo.ref}` : ' (its tracked files as they are on disk: pass ref, e.g. origin/main, to check the merged state; apply needs it)'}: ${team.length} content lines in the team's committed Claude files`]
  if (!team.length) return { ok: true, text: `${out[0]}; nothing to retire` }
  const pdir = projectDir(home, project)
  const now = await h.clock.now()
  const backup = `${pdir}/rules-pr/retired/${day(now)}-${Math.floor(now / 1000)}` // (a second run on the same day never overwrites the first backup)
  const rules = (await leanRules(h, project)).filter(r => r.content.length)
  const gone: { r: LeanRule; at: string }[] = []
  for (const r of rules) {
    const hits = r.content.map(c => ({ c, b: best(c, pool) }))
    const n = hits.filter(x => x.b).length
    if (n / r.content.length >= RETIRE_SHARE) {
      gone.push({ r, at: [...new Set(hits.filter(x => x.b).map(x => team[x.b!.i]!.file))].join(', ') })
      const left = hits.filter(x => !x.b).map(x => x.c.text)
      if (left.length) out.push(`  rule ${r.name}: ${left.length} line(s) are NOT in the repo and go with it: ${left.map(t => `"${clip(t, 70)}"`).join('; ')}`)
    } else if (n) out.push(`keep rule ${r.name}: ${n} of ${r.content.length} lines are in the repo (under ${Math.round(RETIRE_SHARE * 100)}%)`)
  }
  const lessons = (await readLessons(h, project)).filter(l => !l.dropped && wset(l.text).size >= MIN_WORDS).map(l => ({ l, b: best({ words: wset(l.text), text: l.text }, pool) })).filter(x => x.b)
  for (const g of gone) out.push(`${i.apply ? 'retired' : 'would retire'} rule ${g.r.name}: its text is in ${g.at}`)
  for (const x of lessons) out.push(`${i.apply ? 'retired' : 'would retire'} lesson #${x.l.id}: in ${team[x.b!.i]!.file}`)
  if (!gone.length && !lessons.length) return { ok: true, text: `${out.join('\n')}\nnothing to retire` }
  if (!i.apply) return { ok: true, text: `${out.join('\n')}\nnothing changed: run again with apply: true and ref to retire them (kept in ${backup}/)` }
  await withRulesLock(h, project, async () => {
    for (const g of gone) {
      const file = `${pdir}/rules/${g.r.name}`
      const text = await h.fs.read(file).then(String).catch(() => null)
      if (text === null) continue
      await atomicWrite(h, `${backup}/rules/${g.r.name}`, text)
      await h.process.run(['rm', '-f', file])
      const area = g.r.name.replace(/\.md$/, '')
      if (area !== '_project') {
        // learn must not write it again: the area is "covered by" the repo file now (no rule file, never stale)
        const l = await readJson<Learn>(h, `${pdir}/learn.json`, { sha: '', areas: {} })
        const a = l.areas?.[area]
        await recordLearn(h, project, area, { globs: a?.globs ?? g.r.paths, sha: a?.sha ?? l.sha ?? '', lines: 0, coveredBy: g.at.split(', ')[0] })
      }
    }
  })
  if (lessons.length) {
    await atomicWrite(h, `${backup}/lessons.json`, JSON.stringify(lessons.map(x => x.l), null, 2) + '\n')
    for (const x of lessons) await removeLesson(h, project, x.l.id, 'upstreamed') // soft: the line stays in the store marked dropped (reason upstreamed: learning does not add it again)
  }
  out.push(`backup: ${backup}/ (rules as they were, lessons as JSON). Run lean_rules sync with all: true to remove the copies from the checkouts.${gone.some(g => g.r.name === '_project.md') ? ' _project.md was retired: learn may write a new one.' : ''}`)
  return { ok: true, text: out.join('\n') }
}
