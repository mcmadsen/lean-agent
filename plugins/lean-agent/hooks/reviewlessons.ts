// The review LESSON STORE: the learned review checklist ("things human reviewers caught that an automated review missed") and the list of
// existing shared helpers ("reuse these before adding new code with the same job"), per project, outside rules/*.md on purpose: 0.45
// kept hundreds of such lines in two cards (review-checklist, shared-helpers), the rule caps (25 lines / 2000 chars) cannot hold them, and a
// review wants the lines that fit THIS change, not all of them. One JSON line per lesson in ~/.lean-agent/<project>/review-lessons.jsonl.
//   - import: the 0.45 layouts (library/<project>/cards.json, <project>/review-learned.json with its `_lessons` registry, the batch log, the
//     learned-threads list) are copied to legacy-0.45/lessons-<project>/ and their live lines imported once (idempotent, originals stay);
//   - selection (scripts over models): reviewLessons() picks, deterministically and without a model, the lines whose paths/globs match the
//     changed files, whose helper symbol occurs in the diff, or whose keywords occur in the diff / goal, grouped by topic and capped;
//   - learning: learnLessons / removeLesson / undoLessons / verifyLessons keep the store (the 25-line rule cap does not apply: its own cap).
import { appendJsonl, atomicWrite, homeDir, leanDir, mkdirp, readJson, readJsonl } from './state'
import type { Host } from './state'
import { globProblem, globRe, projectDir, slugOk } from './rules'
import { withFolderLock } from './folderlock'
import { readConfig } from './budget'

export type Family = 'review-checklist' | 'shared-helpers'
export const FAMILIES: Family[] = ['review-checklist', 'shared-helpers']
export type Lesson = { id: number; family: Family; topic: string; text: string; paths: string[]; keywords: string[]; source: string; added: string; batch?: string; dropped?: string; droppedWhy?: string }

export const DEFAULT_TOKENS = 3200 // about 4 cards of 800 tokens, what 0.45 offered a review (config.json review.lessonTokens)
export const TOPIC_TOKENS = 800
export const MAX_LESSONS = 1500 // live lines in one project's store (config.json review.lessonMax)
export const MAX_LINE = 400
export const MAX_NEAR_HELPERS = 12
export const MAX_DIFF_CHARS = 60_000
export const REUSE_RULE = 'Before accepting new code that detects, parses or normalises something, search the repo for an existing helper and name it; if one exists, ask for it to be reused instead of a second implementation.'

const LEGACY = 'legacy-0.45'
export const lessonFile = (home: string, project: string) => `${projectDir(home, project)}/review-lessons.jsonl`
const metaFile = (home: string, project: string) => `${projectDir(home, project)}/review-lessons-meta.json`
const batchFile = (home: string, project: string) => `${projectDir(home, project)}/review-lessons-batches.json`
const logFile = (home: string) => `${leanDir(home)}/logs/review-lessons.jsonl`
const lockOf = (home: string, project: string) => `${projectDir(home, project)}/.lessons-lock`
const asObj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as any) : {})
const tok = (s: string) => Math.ceil(s.length / 4)
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

// ---- text -> topic, paths, keywords -------------------------------------------------------------------------------------
// topic: ported from 0.45 (keywords in the line, a regex on a changed path)
const TOPICS: Record<string, [RegExp | null, RegExp | null]> = {
  security: [/\b(security|auth\w*|token|secrets?|password|credential\w*|permission\w*|sanitiz\w*|escap\w*|injection|csrf|xss|encrypt\w*)\b/g, /auth|security|secret|crypt|permission/],
  'cache-sync': [/\b(cache[sd]?|caching|sync\w*|stale|invalidat\w*|refresh\w*|race|locks?|locking|concurren\w*|queues?|retry|retries)\b/g, /cache|sync|queue|lock/],
  tests: [/\b(tests?|specs?|fixtures?|mocks?|assert\w*|coverage|pytest|unittest|jest)\b/g, /(^|\/)(tests?|__tests__|spec)(\/|$)|test_|_test\.|\.spec\.|\.test\./],
  docs: [/\b(docs?|documentation|readme|changelog|comments?|docstrings?|release notes)\b/g, /\.(md|rst|txt)$|(^|\/)docs?\/|readme|changelog/],
  frontend: [/\b(frontend|ui|css|html|components?|react|vue|svelte|dom|styles?|layout|accessib\w*|aria|button|dialogs?|modal|overlay|browser)\b/g, /\.(css|scss|html|jsx|tsx|vue|svelte)$|(^|\/)(ui|frontend|web|components?)\//],
  'build-ci': [/\b(build|ci|pipeline|workflow|docker\w*|deploy\w*|lint\w*|version|release|dependenc\w*|package|install\w*|makefile)\b/g, /(^|\/)(\.github|\.gitlab|ci)\/|dockerfile|makefile|\.ya?ml$|package\.json|requirements|pyproject|\.toml$|\.lock$/],
  api: [/\b(api|endpoints?|routes?|handlers?|requests?|responses?|backend|server|database|db|sql|quer(y|ies)|schema|migrations?|models?|services?|http)\b/g, /(^|\/)(api|server|backend|services?|routes|models|db|migrations)\//],
  other: [null, null],
}
export const TOPIC_NAMES = Object.keys(TOPICS)
export function topicOf(line: string): string {
  const low = line.toLowerCase()
  const paths = pathsIn(line)
  let best = 'other'
  let score = 0
  for (const [t, [kw, pat]] of Object.entries(TOPICS)) {
    if (!kw || !pat) continue
    const s = (low.match(kw) ?? []).length + 2 * paths.filter(p => pat.test(p.toLowerCase())).length
    if (s > score) { best = t; score = s }
  }
  return best
}

const EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|cs|php|swift|json|ya?ml|toml|md|sql|sh|css|scss|html|vue|svelte|c|h|cpp)$/i
const NOT_PATH = new Set(['and/or', 'either/or', 'true/false', 'yes/no', 'read/write', 'input/output', 'client/server', 'on/off', 'in/out', 'get/set', 'e.g', 'i.e', 'etc'])
// file paths and folders a lesson names (backticks, quotes, :line and #L suffixes are stripped)
export function pathsIn(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/[\s,;]+|\s+and\s+/)) {
    const t = raw.replace(/^[`'"([<]+|[`'")\]>.:!?]+$/g, '').replace(/#L?\d.*$/, '').replace(/:\d+(-\d+)?$/, '').replace(/^\.\//, '')
    if (t.length < 3 || t.length > 200 || /^https?:|\/\/|\.\./.test(t) || NOT_PATH.has(t.toLowerCase())) continue
    if (!/^[\w.@*{}\-/]+$/.test(t)) continue
    const segs = t.replace(/\/$/, '').split('/')
    const ok = EXT.test(t) || (segs.length >= 2 && segs.every(s => s.length >= 2 || s === '*') && !/^\d+(\.\d+)*$/.test(t))
    if (ok && !out.includes(t)) out.push(t)
  }
  return out.slice(0, 6)
}

const STOP = new Set('about above after again also always another because been before being between both but can cannot check code could does done each else ensure every first for from have into just like make more most must need never new not now only other over same should since some such than that the their them then there these they this those through too under until use used using very want what when where which while will with without would your are was were has had its it is be to of in on at by an or as if so do no we'.split(' '))
// light stem so "normalising" meets "normalizePhone": ise -> ize, then a plural / -ed / -ing is cut
export const stem = (w: string): string => {
  let s = w.toLowerCase().replace(/is(e|ed|es|ing)$/, m => 'iz' + m.slice(2)).replace(/ization$/, 'ize')
  if (s.length > 4) s = s.replace(/(ing|ed|es|s)$/, '')
  return s
}
const split = (t: string) => t.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_.$-]+/g, ' ')
const wordsOf = (t: string): string[] => (split(t).match(/[A-Za-z][A-Za-z0-9]{2,}/g) ?? []).map(stem).filter(w => w.length >= 3 && !STOP.has(w))
const isStrong = (k: string) => /[A-Z_.\/]/.test(k)
const SYMBOL = /\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b|\b[a-z][a-z0-9]*_[a-z0-9_]+\b/g
// keywords of a lesson: symbols and file names as they are written (strong), plus up to 10 plain word stems (weak, lowercase)
export function keywordsOf(text: string, name = ''): string[] {
  const strong: string[] = []
  const add = (s: string) => { if (s.length >= 3 && !strong.includes(s)) strong.push(s) }
  for (const m of text.matchAll(/`([A-Za-z_$][\w$.]{2,})`/g)) if (isStrong(m[1]!)) add(m[1]!)
  for (const m of text.match(SYMBOL) ?? []) add(m)
  if (name && isStrong(name)) add(name.replace(/\(\)$/, ''))
  for (const p of pathsIn(text)) { const b = p.replace(/\/$/, '').split('/').pop() ?? ''; if (EXT.test(b)) add(b) }
  const weak = [...new Set(wordsOf(text))].sort((a, b) => b.length - a.length || a.localeCompare(b)).slice(0, 10)
  return [...strong.slice(0, 8), ...weak]
}

export const lineOf = (s: string) => s.replace(/^\s*[-*]\s+/, '').replace(/\s+/g, ' ').trim().slice(0, MAX_LINE)
// "name (where): what" is the shape of a helper line
export function helperParts(text: string): { name: string; where: string; what: string } {
  const m = /^(.+?) \((.+)\)(?::\s*(.*))?$/.exec(text)
  return m ? { name: m[1]!.trim(), where: m[2]!.trim(), what: (m[3] ?? '').trim() } : { name: text.split(/[\s(:]/)[0] ?? '', where: '', what: '' }
}
const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const jaccard = (a: Set<string>, b: Set<string>) => { let n = 0; for (const x of a) if (b.has(x)) n++; const u = a.size + b.size - n; return u ? n / u : 0 }
const wset = (t: string) => new Set(t.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])
const similar = (a: string, b: string, cut = 0.6) => jaccard(wset(a), wset(b)) >= cut

// a lesson from a line; paths and keywords are derived (a helper's own `where` is its path)
export function makeLesson(id: number, family: Family, text: string, o: { source: string; added: string; topic?: string; batch?: string }): Lesson {
  const t = lineOf(text)
  const hp = family === 'shared-helpers' ? helperParts(t) : null
  const paths = [...new Set([...(hp ? pathsIn(hp.where) : []), ...pathsIn(t)])].slice(0, 6)
  return { id, family, topic: o.topic && TOPIC_NAMES.includes(o.topic) ? o.topic : topicOf(t), text: t, paths, keywords: keywordsOf(t, hp?.name), source: o.source, added: o.added, ...(o.batch ? { batch: o.batch } : {}) }
}

// ---- the store ----------------------------------------------------------------------------------------------------------
const valid = (l: any): l is Lesson => l && typeof l.id === 'number' && FAMILIES.includes(l.family) && typeof l.text === 'string' && l.text.length > 0
export async function readLessons(h: Host, project: string): Promise<Lesson[]> {
  if (!slugOk(project)) return []
  return (await readJsonl<Lesson>(h, lessonFile(await homeDir(h), project))).filter(valid)
}
const writeLessons = async (h: Host, home: string, project: string, all: Lesson[]) => atomicWrite(h, lessonFile(home, project), all.map(l => JSON.stringify(l)).join('\n') + (all.length ? '\n' : ''))
const live = (all: Lesson[]) => all.filter(l => !l.dropped)
const nextId = (all: Lesson[]) => all.reduce((m, l) => Math.max(m, l.id), 0) + 1

type Meta = { lastImport?: number; imported?: number; from?: string[] }
type Op = { kind: 'add' | 'update' | 'rm'; id: number; old?: Lesson }
export async function lessonCap(h: Host): Promise<{ tokens: number; max: number }> {
  const r = asObj(asObj(await readConfig(h, await homeDir(h)).catch(() => ({}))).review)
  const n = (v: unknown, d: number) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : d)
  return { tokens: n(r.lessonTokens, DEFAULT_TOKENS), max: n(r.lessonMax, MAX_LESSONS) }
}

async function logBatch(h: Host, home: string, project: string, ops: Op[], ts: number) {
  if (!ops.length) return
  const d = await readJson<unknown>(h, batchFile(home, project), [])
  await atomicWrite(h, batchFile(home, project), JSON.stringify([...(Array.isArray(d) ? d : []), { ts, ops }].slice(-30), null, 1) + '\n')
}

// ---- learning: add (near-duplicates skipped, a helper's name updates its line), replace, remove, undo, list -----------------
export type LearnIn = { checklist?: unknown[]; helpers?: unknown[]; replace?: unknown[]; source?: string }
export type LearnOut = { added: string[]; updated: string[]; skipped: string[]; refused: string[] }
const helperLine = (h: any): string => (typeof h === 'string' ? lineOf(h) : h && typeof h === 'object' && String(h.name ?? '').trim() ? lineOf(`${String(h.name).trim()} (${String(h.where ?? '?').trim() || '?'}): ${String(h.what ?? '').trim()}`.replace(/: $/, '')) : '')
export async function learnLessons(h: Host, project: string, inp: LearnIn): Promise<LearnOut> {
  if (!slugOk(project)) throw new Error('review lessons need a project name')
  const home = await homeDir(h)
  const now = await h.clock.now()
  const cap = await lessonCap(h)
  return withFolderLock(h, lockOf(home, project), async () => {
    const all = await readLessons(h, project)
    const out: LearnOut = { added: [], updated: [], skipped: [], refused: [] }
    const ops: Op[] = []
    const source = (inp.source || 'review-learn').slice(0, 60)
    const batch = `${day(now)}-${now}`
    const upd = (l: Lesson, text: string) => {
      ops.push({ kind: 'update', id: l.id, old: { ...l } })
      Object.assign(l, makeLesson(l.id, l.family, text, { source: l.source, added: l.added, batch: l.batch }))
    }
    for (const r of Array.isArray(inp.replace) ? inp.replace : []) {
      const o = lineOf(String(asObj(r).old ?? ''))
      const n = lineOf(String(asObj(r).new ?? ''))
      if (!o || !n) continue
      const hit = live(all).map(l => ({ l, s: jaccard(wset(l.text), wset(o)) })).filter(x => x.s >= 0.5).sort((a, b) => b.s - a.s || a.l.id - b.l.id)[0]
      if (hit) { upd(hit.l, n); out.updated.push(`corrected #${hit.l.id}: ${n}`) } else out.skipped.push(`replace: no line like "${o.slice(0, 60)}"`)
    }
    const add = (family: Family, text: string) => {
      if (!text) return
      if (live(all).length >= cap.max) { out.refused.push(text); return }
      const fresh = makeLesson(nextId(all), family, text, { source, added: day(now), batch })
      all.push(fresh)
      ops.push({ kind: 'add', id: fresh.id })
      out.added.push(`#${fresh.id} ${family}: ${text}`)
    }
    for (const c of Array.isArray(inp.checklist) ? inp.checklist : []) {
      const t = lineOf(String(c ?? ''))
      if (!t) continue
      if (live(all).some(l => similar(l.text, t))) out.skipped.push(`already there: ${t.slice(0, 80)}`)
      else add('review-checklist', t)
    }
    for (const hv of Array.isArray(inp.helpers) ? inp.helpers : []) {
      const t = helperLine(hv)
      if (!t) continue
      const name = helperParts(t).name.toLowerCase()
      const same = live(all).find(l => l.family === 'shared-helpers' && name && helperParts(l.text).name.toLowerCase() === name)
      if (same) {
        if (same.text !== t) { upd(same, t); out.updated.push(`helper #${same.id}: ${t}`) } else out.skipped.push(`unchanged helper: ${name}`)
      } else if (live(all).some(l => l.family === 'shared-helpers' && similar(l.text, t, 0.7))) out.skipped.push(`already there: ${t.slice(0, 80)}`)
      else add('shared-helpers', t)
    }
    if (ops.length) {
      await writeLessons(h, home, project, all)
      await logBatch(h, home, project, ops, now)
    }
    return out
  })
}

// by its number (as `list` prints it) or by a unique piece of its text; soft: the line stays in the file with `dropped` (undo brings it back)
export async function removeLesson(h: Host, project: string, which: string | number, why = 'removed'): Promise<{ ok: boolean; text: string }> {
  const home = await homeDir(h)
  const now = await h.clock.now()
  return withFolderLock(h, lockOf(home, project), async () => {
    const all = await readLessons(h, project)
    const w = String(which).trim()
    const hits = /^\d+$/.test(w) ? live(all).filter(l => l.id === Number(w)) : live(all).filter(l => l.text.toLowerCase().includes(w.toLowerCase()))
    if (hits.length !== 1) return { ok: false, text: hits.length ? `${hits.length} lines contain "${w}": use the number from list` : `no line ${/^\d+$/.test(w) ? '#' : 'contains '}${w}` }
    const l = hits[0]!
    ops_drop(l, day(now), why)
    await writeLessons(h, home, project, all)
    await logBatch(h, home, project, [{ kind: 'rm', id: l.id }], now)
    return { ok: true, text: `removed #${l.id}: ${l.text.slice(0, 120)}` }
  })
}
const ops_drop = (l: Lesson, when: string, why: string) => { l.dropped = when; l.droppedWhy = why }

// undo the last batch: added lines go, corrected lines are restored, removed lines come back
export async function undoLessons(h: Host, project: string): Promise<{ ok: boolean; text: string }> {
  const home = await homeDir(h)
  return withFolderLock(h, lockOf(home, project), async () => {
    const d = await readJson<unknown>(h, batchFile(home, project), [])
    const log = Array.isArray(d) ? d : []
    const batch = log.pop() as { ts: number; ops: Op[] } | undefined
    if (!batch) return { ok: false, text: 'nothing to undo' }
    let all = await readLessons(h, project)
    let n = 0
    for (const op of [...batch.ops].reverse()) {
      const l = all.find(x => x.id === op.id)
      if (op.kind === 'add') { all = all.filter(x => x.id !== op.id); n++ } else if (!l) continue
      else if (op.kind === 'update' && op.old) { Object.assign(l, op.old); n++ } else if (op.kind === 'rm') { delete l.dropped; delete l.droppedWhy; n++ }
    }
    await writeLessons(h, home, project, all)
    await atomicWrite(h, batchFile(home, project), JSON.stringify(log, null, 1) + '\n')
    return { ok: true, text: `undid the last batch (${n} change(s))` }
  })
}

export async function listLessons(h: Host, project: string, family?: string): Promise<string> {
  const rows = live(await readLessons(h, project)).filter(l => !family || l.family === family).sort((a, b) => a.id - b.id)
  return rows.length ? rows.map(l => `${l.id}. [${l.family === 'shared-helpers' ? 'helper' : l.topic}] ${l.text}`).join('\n') : `no review lessons for ${project}`
}

// ---- verify: helper lines whose code path or symbol cannot be found --------------------------------------------------------------
async function git(h: Host, repo: string, ...a: string[]): Promise<string | null> {
  try {
    const r = await h.process.run(['git', '-C', repo, ...a])
    return r.exitCode === 0 ? r.stdout : null
  } catch {
    return null
  }
}
export async function verifyLessons(h: Host, project: string, repo: string, apply = false): Promise<{ lines: string[]; flagged: number }> {
  const home = await homeDir(h)
  const now = await h.clock.now()
  return withFolderLock(h, lockOf(home, project), async () => {
    const refs: string[] = []
    for (const r of ['HEAD', 'origin/HEAD', 'main', 'master']) if ((await git(h, repo, 'rev-parse', '--verify', '--quiet', `${r}^{commit}`)) !== null && !refs.includes(r)) refs.push(r)
    const files = new Map<string, string[]>()
    for (const r of refs) files.set(r, ((await git(h, repo, 'ls-tree', '-r', '--name-only', r)) ?? '').split('\n').filter(Boolean))
    const all = await readLessons(h, project)
    const lines = [`checking against: ${refs.join(', ') || 'nothing (no git ref found)'}`]
    let flagged = 0
    const removed: number[] = []
    if (!refs.length) return { lines: [...lines, 'cannot verify: the repo has no commit'], flagged }
    for (const l of live(all).filter(x => x.family === 'shared-helpers')) {
      const hp = helperParts(l.text)
      let why = ''
      const where = pathsIn(hp.where)
      const hasPath = where.some(p => refs.some(r => files.get(r)!.some(f => f === p || f.endsWith('/' + p) || f.startsWith(p.replace(/\/$/, '') + '/'))))
      if (!hasPath) {
        const names = (hp.name.match(/[A-Za-z_$][\w$]{2,}/g) ?? []).slice(0, 3)
        let sym = false
        for (const r of refs) for (const n of names) if (!sym && (await git(h, repo, 'grep', '-q', '-w', n, r, '--')) !== null) sym = true
        if (!sym) why = `path ${where.join(', ') || '(none)'} and symbol ${names.join(', ') || '(none)'} not found on ${refs.join(', ')}`
      }
      if (/not confirmed/i.test(l.text)) why = 'it says it was not confirmed'
      if (why) {
        flagged++
        lines.push(`${apply ? 'removed' : 'would remove'} #${l.id}: ${l.text.slice(0, 120)}\n    because ${why}`)
        if (apply) { ops_drop(l, day(now), `verify: ${why.slice(0, 100)}`); removed.push(l.id) }
      }
    }
    if (apply && flagged) {
      await writeLessons(h, home, project, all)
      await logBatch(h, home, project, removed.map(id => ({ kind: 'rm' as const, id })), now)
    }
    lines.push(`${flagged} line(s) ${apply ? 'removed' : 'flagged'}${apply || !flagged ? '' : '; nothing changed: remove them with verify apply'}`)
    return { lines, flagged }
  })
}

// ---- selection --------------------------------------------------------------------------------------------------------------------
export type Pick = { id: number; family: Family; topic: string; why: string; score: number }
export type LessonsOut = { text: string; picked: Pick[]; tokens: number; total: number }
const dirName = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
// a folder's neighbours: the same folder, or its parent / child one level away (never the repo root against a deep folder)
function near(lp: string, c: string): boolean {
  const a = dirName(lp.replace(/\/$/, ''))
  const b = dirName(c)
  if (a === b) return true
  if (!a || !b) return false
  if (a.startsWith(b + '/')) return !a.slice(b.length + 1).includes('/')
  if (b.startsWith(a + '/')) return !b.slice(a.length + 1).includes('/')
  return false
}
const clean = (p: string) => p.replace(/^\.?\//, '').replace(/\/+$/, '')
function pathHit(lp: string, changed: string[]): boolean {
  if (/[*?[{]/.test(lp)) {
    if (globProblem(lp)) return false
    const re = globRe(lp)
    const pre = lp.replace(/[*?[{].*$/, '')
    return changed.some(c => re.test(c) || (pre !== '' && c.startsWith(pre)))
  }
  const p = clean(lp)
  return changed.some(c => c === p || c.endsWith('/' + p) || p.endsWith('/' + c) || c.startsWith(p + '/'))
}
// the part of a unified diff that carries the new code (added lines, hunk headers, file headers); any other text is used whole
function newCode(diff: string): string {
  const d = diff.slice(0, MAX_DIFF_CHARS)
  const keep = d.split('\n').filter(l => (l[0] === '+' && !l.startsWith('+++')) || l.startsWith('@@') || l.startsWith('diff --git'))
  return (keep.length ? keep.map(l => (l[0] === '+' ? l.slice(1) : l)).join('\n') : d)
}

const section = (title: string, rows: Lesson[]) => (rows.length ? [`### ${title}`, ...rows.map(l => `- ${l.text}`)] : [])

export async function reviewLessons(h: Host, project: string, changedPaths: string[], diffText: string, opts: number | { budget?: number; goal?: string; log?: boolean } = {}): Promise<LessonsOut> {
  const o = typeof opts === 'number' ? { budget: opts } : opts
  const cfg = await lessonCap(h)
  const budget = Math.max(100, Math.floor(o.budget ?? cfg.tokens))
  const all = live(await readLessons(h, project)).sort((a, b) => a.id - b.id)
  const changed = [...new Set(changedPaths.map(clean).filter(Boolean))].slice(0, 500)
  const code = newCode(diffText || '')
  const tokens = new Set(wordsOf(`${code}\n${changed.join(' ')}\n${o.goal ?? ''}`))
  const idents = new Set((`${code}\n${changed.join(' ')}\n${o.goal ?? ''}`.match(/[A-Za-z_$][\w$.]{2,}/g) ?? []).flatMap(x => [x, ...x.split('.')]))
  const cands: { l: Lesson; score: number; why: string[]; near: boolean }[] = []
  for (const l of all) {
    const why: string[] = []
    let score = 0
    const hp = l.family === 'shared-helpers' ? helperParts(l.text) : null
    const lp = l.paths.filter(p => pathHit(p, changed))
    if (lp.length) { score += 10; why.push(`path ${lp[0]}`) }
    const sym = hp && hp.name.replace(/\(\)$/, '')
    if (sym && sym.length >= 3 && idents.has(sym)) { score += 8; why.push(`symbol ${sym}`) }
    const isNear = !lp.length && l.family === 'shared-helpers' && l.paths.some(p => !/[*?[{]/.test(p) && changed.some(c => near(p, c)))
    if (isNear) { score += 4; why.push('near the change') }
    const strong = l.keywords.filter(k => isStrong(k) && idents.has(k))
    const weak = l.keywords.filter(k => !isStrong(k) && tokens.has(k))
    if (strong.length) { score += 3 * strong.length; why.push(`keyword ${strong.slice(0, 2).join(', ')}`) }
    const weakOk = weak.length >= 3 || (weak.length >= 2 && l.keywords.filter(k => !isStrong(k)).length <= 4)
    if (weakOk) { score += weak.length; why.push(`words ${weak.slice(0, 3).join(', ')}`) }
    const tp = TOPICS[l.topic]?.[1]
    if (!why.length && tp && weak.length >= 1 && changed.some(c => tp.test(c.toLowerCase()))) { score += 2; why.push(`topic ${l.topic} (changed path)`) }
    if (why.length) cands.push({ l, score, why, near: isNear })
  }
  cands.sort((a, b) => b.score - a.score || a.l.id - b.l.id)
  const picked: { l: Lesson; why: string; score: number }[] = []
  const perTopic = new Map<string, number>()
  let used = tok(REUSE_RULE) + 40 // the rule and the header are always in
  let nearN = 0
  for (const c of cands) {
    const key = c.l.family === 'shared-helpers' ? 'helpers' : c.l.topic
    const cost = tok(c.l.text) + 1
    if (used + cost > budget || (perTopic.get(key) ?? 0) + cost > Math.min(TOPIC_TOKENS, budget)) continue
    if (c.near && nearN >= MAX_NEAR_HELPERS) continue
    if (c.near) nearN++
    picked.push({ l: c.l, why: c.why.join('; '), score: c.score })
    perTopic.set(key, (perTopic.get(key) ?? 0) + cost)
    used += cost
  }
  const head = `Learned review checklist for ${project} (what human reviewers caught before; leads, not facts: check each line that applies to this change against the code and say so in the review):`
  const build = () => {
    const helpers = picked.filter(p => p.l.family === 'shared-helpers').map(p => p.l)
    const topics = TOPIC_NAMES.map(t => ({ t, rows: picked.filter(p => p.l.family === 'review-checklist' && p.l.topic === t).map(p => p.l) })).filter(x => x.rows.length)
    return [head, `General: ${REUSE_RULE}`, ...section('shared helpers: reuse these before adding new code with the same job', helpers), ...topics.flatMap(x => section(x.t, x.rows))].join('\n')
  }
  let text = build()
  while (tok(text) > budget && picked.length) { picked.pop(); text = build() } // (headers and section titles are counted here: the lowest-scored line goes first)
  const out: LessonsOut = { text, picked: picked.map(p => ({ id: p.l.id, family: p.l.family, topic: p.l.topic, why: p.why, score: p.score })), tokens: tok(text), total: all.length }
  if (o.log !== false) {
    const home = await homeDir(h)
    await appendJsonl(h, logFile(home), { ts: Math.floor((await h.clock.now()) / 1000), project, changed: changed.length, total: all.length, offered: out.picked.map(p => ({ id: p.id, why: p.why })), tokens: out.tokens, budget }).catch(() => undefined)
  }
  return out
}

// ---- the tool side: changed paths and the diff of a branch, then reviewLessons -----------------------------------------------------
const REF = /^[A-Za-z0-9_][\w./@^~{}:-]*$/
export type LessonsFor = { project: string; repo?: string; base?: string; head?: string; paths?: string[]; goal?: string; budget?: number }
export async function lessonsFor(h: Host, a: LessonsFor): Promise<{ ok: boolean; text: string }> {
  if (!slugOk(a.project)) return { ok: false, text: 'lessons needs a project name' }
  const home = await homeDir(h)
  let repo = a.repo ?? ''
  if (!repo) {
    const projs = asObj(await readJson<unknown>(h, `${leanDir(home)}/projects.json`, {}))
    repo = typeof asObj(projs[a.project]).path === 'string' ? asObj(projs[a.project]).path : ''
  }
  if (!repo.startsWith('/')) return { ok: false, text: `lessons needs repo (an absolute path) or a registered project ${a.project}` }
  if ((a.base && !REF.test(a.base)) || (a.head && !REF.test(a.head))) return { ok: false, text: 'lessons: base and head must be plain refs' }
  const paths = (a.paths ?? []).filter(p => typeof p === 'string' && p && !p.startsWith('-') && !p.split('/').includes('..') && !p.startsWith('/')).slice(0, 200)
  let changed = paths
  let diff = ''
  if (a.base || a.head) {
    let base = a.base
    if (!base) for (const r of ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']) if (!base && (await git(h, repo, 'rev-parse', '--verify', '--quiet', `${r}^{commit}`)) !== null) base = r
    const range = base ? `${base}...${a.head || 'HEAD'}` : a.head || 'HEAD'
    const names = await git(h, repo, 'diff', '--name-only', range)
    if (names === null) return { ok: false, text: `lessons: git diff ${range} failed in ${repo}` }
    changed = [...new Set([...names.split('\n').filter(Boolean), ...paths])]
    diff = ((await git(h, repo, 'diff', '-U0', '--no-color', range)) ?? '').slice(0, MAX_DIFF_CHARS)
  } else if (paths.length) diff = ((await git(h, repo, 'diff', '-U0', '--no-color', 'HEAD', '--', ...paths)) ?? '').slice(0, MAX_DIFF_CHARS)
  const r = await reviewLessons(h, a.project, changed, diff, { budget: a.budget, goal: a.goal })
  const tail = r.total ? `\n(${r.picked.length} of ${r.total} lessons offered for ${changed.length} changed file(s): ${r.picked.map(p => `#${p.id}`).join(' ') || 'none matched'})` : `\n(no learned lessons for ${a.project} yet)`
  return { ok: true, text: r.text + tail }
}

// ---- 0.45 import --------------------------------------------------------------------------------------------------------------------
type Legacy = { family: Family; topic?: string; text: string; id?: number; added: string; batch: string; dropped?: boolean }
const fam = (cid: string): Family | null => (cid === 'shared-helpers' || cid.startsWith('shared-helpers-') ? 'shared-helpers' : cid === 'review-checklist' || cid.startsWith('review-checklist-') ? 'review-checklist' : null)
const topicSuffix = (cid: string): string | undefined => TOPIC_NAMES.find(t => cid.endsWith('-' + t) || new RegExp(`-${t}-\\d+$`).test(cid))
const LEGACY_FILES = ['cards.json', 'review-learned.json', 'review-learn-batches.json', 'review-learned-threads.json']
// every place 0.45 kept this state, per project: library/<p>/cards.json (the cards), <p>/review-learned.json (per-PR entries and the `_lessons`
// registry), <p>/review-learn-batches.json (the op log of `review learn --undo`), <p>/review-learned-threads.json (comment hashes)
const originals = (lean: string, p: string): Record<string, string> => ({ 'cards.json': `${lean}/library/${p}/cards.json`, 'review-learned.json': `${lean}/${p}/review-learned.json`, 'review-learn-batches.json': `${lean}/${p}/review-learn-batches.json`, 'review-learned-threads.json': `${lean}/${p}/review-learned-threads.json` })
const text = async (h: Host, p: string): Promise<string | null> => h.fs.read(p).then(t => (typeof t === 'string' ? t : null)).catch(() => null)

// the lines of one project's 0.45 files (the original, else the copy in legacy-0.45/lessons-<p>/)
async function legacyLessons(h: Host, lean: string, p: string): Promise<{ rows: Legacy[]; found: boolean }> {
  const src = originals(lean, p)
  const read = async (f: string) => { const t = (await text(h, src[f]!)) ?? (await text(h, `${lean}/${LEGACY}/lessons-${p}/${f}`)); if (t === null || !t.trim()) return null; try { return JSON.parse(t) as unknown } catch { return null } }
  const cards = await read('cards.json')
  const learned = asObj(await read('review-learned.json'))
  const rows: Legacy[] = []
  const have = new Set<string>()
  const reg = Array.isArray(learned._lessons) ? learned._lessons : []
  for (const e of reg) {
    const f = fam(String(asObj(e).cid ?? ''))
    const t = lineOf(String(asObj(e).line ?? ''))
    if (!f || !t) continue
    rows.push({ family: f, topic: topicSuffix(String(e.cid)), text: t, id: Number.isInteger(e.id) ? e.id : undefined, added: typeof e.date === 'string' ? e.date.slice(0, 10) : '', batch: String(e.batch ?? 'legacy'), dropped: e.gone === true })
    have.add(norm(t))
  }
  const list: any[] = Array.isArray(cards) ? cards : Array.isArray(asObj(cards).cards) ? asObj(cards).cards : []
  for (const c of list) {
    const f = fam(String(asObj(c).id ?? ''))
    if (!f || c.archived) continue
    for (const line of String(c.text ?? '').split('\n')) {
      if (!line.startsWith('- ')) continue
      const t = lineOf(line)
      if (t && !have.has(norm(t))) { rows.push({ family: f, topic: c.topic && TOPIC_NAMES.includes(c.topic) ? c.topic : topicSuffix(String(c.id)), text: t, added: typeof c.updated === 'string' ? c.updated.slice(0, 10) : '', batch: 'legacy' }); have.add(norm(t)) }
    }
  }
  return { rows, found: cards !== null || Object.keys(learned).length > 0 }
}

// projects with anything of 0.45 here: registered ones, library/<p>/ folders, and copies already in legacy-0.45/
async function legacyProjects(h: Host, lean: string): Promise<string[]> {
  const names = new Set<string>()
  const projs = asObj(await readJson<unknown>(h, `${lean}/projects.json`, {}))
  for (const n of Object.keys(projs)) names.add(n)
  for (const d of await h.fs.list(`${lean}/library`).catch(() => [])) if (d.kind === 'dir') names.add(d.name)
  for (const d of await h.fs.list(`${lean}/${LEGACY}`).catch(() => [])) if (d.kind === 'dir' && d.name.startsWith('lessons-')) names.add(d.name.slice(8))
  return [...names].filter(slugOk).sort()
}

// how many live 0.45 lessons of a project are not in its store (the check and the doctor warn on it)
export async function pendingLegacy(h: Host, project: string): Promise<number> {
  const lean = leanDir(await homeDir(h))
  const store = new Set((await readLessons(h, project)).map(l => norm(l.text)))
  return (await legacyLessons(h, lean, project)).rows.filter(r => !r.dropped && !store.has(norm(r.text))).length
}

export async function importLegacyLessons(h: Host): Promise<{ lines: string[]; retry: boolean }> {
  const home = await homeDir(h)
  const lean = leanDir(home)
  const lines: string[] = []
  let retry = false
  for (const p of await legacyProjects(h, lean)) {
    const copied: string[] = []
    for (const [f, from] of Object.entries(originals(lean, p))) {
      const body = await text(h, from)
      if (body === null) continue
      const to = `${lean}/${LEGACY}/lessons-${p}/${f}`
      if ((await text(h, to)) === body) continue
      try { await atomicWrite(h, to, body); copied.push(f) } catch { retry = true } // (the original is never touched)
    }
    if (copied.length) lines.push(`0.45 review files of ${p} copied to ${LEGACY}/lessons-${p}/: ${copied.join(', ')}`)
    const { rows } = await legacyLessons(h, lean, p)
    if (!rows.length) continue
    const now = await h.clock.now()
    try {
      const out = await withFolderLock(h, lockOf(home, p), async () => {
        const all = await readLessons(h, p)
        const known = new Set(all.map(l => norm(l.text))) // dropped ones count: a line the user removed is not brought back
        const ids = new Set(all.map(l => l.id))
        let added = 0
        let dropped = 0
        for (const r of rows) {
          if (known.has(norm(r.text))) continue
          known.add(norm(r.text))
          const id = r.id !== undefined && !ids.has(r.id) ? r.id : nextId(all)
          ids.add(id)
          const l = makeLesson(id, r.family, r.text, { source: '0.45', added: r.added || day(now), topic: r.topic, batch: r.batch })
          if (r.dropped) { ops_drop(l, r.added || day(now), '0.45: removed there'); dropped++ }
          all.push(l)
          added++
        }
        if (!added) return { added, dropped }
        await writeLessons(h, home, p, all)
        const m = await readJson<Meta>(h, metaFile(home, p), {})
        await atomicWrite(h, metaFile(home, p), JSON.stringify({ lastImport: now, imported: (m.imported ?? 0) + added, from: [...new Set([...(m.from ?? []), ...LEGACY_FILES.filter(f => copied.includes(f) || m.from?.includes(f))])] }, null, 1) + '\n')
        return { added, dropped }
      })
      if (out.added) lines.push(`review lessons of ${p}: ${out.added} imported from 0.45 (${out.added - out.dropped} live${out.dropped ? `, ${out.dropped} already removed there, kept as dropped` : ''}) into review-lessons.jsonl`)
    } catch {
      retry = true
    }
  }
  return { lines, retry }
}

// ---- status (lean_rules check, the doctor) --------------------------------------------------------------------------------------------
export type Status = { exists: boolean; live: number; dropped: number; byFamily: Record<string, number>; lastImport?: number; pending: number; max: number }
export async function lessonStatus(h: Host, project: string): Promise<Status> {
  const home = await homeDir(h)
  const all = await readLessons(h, project)
  const lv = live(all)
  const m = await readJson<Meta>(h, metaFile(home, project), {})
  return { exists: all.length > 0, live: lv.length, dropped: all.length - lv.length, byFamily: Object.fromEntries(FAMILIES.map(f => [f, lv.filter(l => l.family === f).length])), lastImport: m.lastImport, pending: await pendingLegacy(h, project).catch(() => 0), max: (await lessonCap(h)).max }
}
export async function lessonLines(h: Host, project: string): Promise<string[]> {
  const s = await lessonStatus(h, project)
  const out: string[] = []
  if (s.pending) out.push(`WARN: ${s.pending} 0.45 review lesson(s) of ${project} are not imported into the store: run migrate (it copies them to ${LEGACY}/ and imports them; safe to repeat)`)
  if (s.exists) out.push(`review lessons: ${s.live} live (${FAMILIES.map(f => `${f} ${s.byFamily[f]}`).join(', ')}), ${s.dropped} dropped, cap ${s.max}, last import ${s.lastImport ? day(s.lastImport) : 'never'}${s.live >= s.max ? ' OVER THE CAP: no line can be added until some are removed (verify, rm)' : ''}`)
  else if (!s.pending) out.push('review lessons: none yet (review-learn adds them)')
  return out
}
