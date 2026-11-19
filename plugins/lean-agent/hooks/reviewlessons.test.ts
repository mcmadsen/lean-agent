import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { DEFAULT_TOKENS, REUSE_RULE, MAX_NEAR_HELPERS, importLegacyLessons, learnLessons, lessonLines, lessonStatus, lessonsFor, listLessons, makeLesson, pathsIn, pendingLegacy, readLessons, removeLesson, reviewLessons, topicOf, undoLessons, verifyLessons } from './reviewlessons'
import { threadTool } from './delivery'
import { check, migrate, tidyLegacy } from './doctor'

const L = '/h/.lean-agent'
const STORE = `${L}/proj/review-lessons.jsonl`
const AREAS = ['billing', 'orders', 'search', 'auth', 'export', 'inbox', 'sync', 'reports']

// a synthetic store of 500 lines: 160 helpers (each in its own file of an area) and 340 checklist lines (areas, topics and filler)
function bigStore() {
  const h = fakeHost(null)
  const rows: any[] = []
  let id = 1
  for (let n = 0; n < 160; n++) {
    const area = AREAS[n % AREAS.length]!
    rows.push(makeLesson(id++, 'shared-helpers', `helperFn${n} (src/${area}/helpers/util${n}.ts): does job number ${n} for ${area} records`, { source: 'test', added: '2026-01-01' }))
  }
  for (let n = 0; n < 340; n++) {
    const area = AREAS[n % AREAS.length]!
    const text = n % 4 === 0 ? `In src/${area}/ code, check the retry path of widget${n}Handler before adding a second queue` : n % 4 === 1 ? `Every change to ${area} needs a test for the empty case ${n}` : n % 4 === 2 ? `Do not log the credential field in the ${area} flow, variant ${n}` : `Prefer the shared date parser over a new one in module${n}`
    rows.push(makeLesson(id++, 'review-checklist', text, { source: 'test', added: '2026-01-01' }))
  }
  h.files.set(STORE, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  return h
}

test('pathsIn and topicOf: file paths and folders a line names, the topic from words and paths', () => {
  expect(pathsIn('Before adding X, check `src/lib/dates.ts:42` and the web/ui/ folder, e.g. and/or src/api/')).toEqual(['src/lib/dates.ts', 'web/ui/', 'src/api/'])
  expect(pathsIn('see https://example.com/a/b and 1.2.3 and read/write')).toEqual([])
  expect(topicOf('Never log the password or token')).toBe('security')
  expect(topicOf('add a test with a fixture and a mock')).toBe('tests')
  expect(topicOf('keep it short')).toBe('other')
})

test('selection on a 500-line store: path and symbol matches first, capped, grouped, the general rule always, deterministic and logged', async () => {
  const h = bigStore()
  const diff = ['diff --git a/src/billing/invoice.ts b/src/billing/invoice.ts', '@@ -1,2 +1,4 @@', '+import { x } from "./helpers/util0"', '+export function parseInvoiceDate(s: string) { return helperFn8(s) }'].join('\n')
  const a = await reviewLessons(h.host, 'proj', ['src/billing/invoice.ts'], diff)
  expect(a.total).toBe(500)
  expect(a.text).toContain(REUSE_RULE)
  expect(a.text).toContain('### shared helpers')
  // helper8 (area billing = index 0 of AREAS, n%8===0) is named in the diff; helpers of billing live in src/billing/helpers: near the change
  const ids = a.picked.map(p => p.id)
  expect(a.picked.find(p => p.why.includes('symbol helperFn8'))).toBeTruthy()
  expect(a.picked.some(p => p.why.includes('near the change') && p.family === 'shared-helpers')).toBe(true)
  expect(a.picked.filter(p => p.why === 'near the change').length).toBeLessThanOrEqual(MAX_NEAR_HELPERS)
  expect(a.tokens).toBeLessThanOrEqual(DEFAULT_TOKENS)
  expect(ids.length).toBeLessThan(120) // not the whole store
  // a helper of another area is not offered
  expect(a.text).not.toContain('helperFn1 (')
  // deterministic
  const b = await reviewLessons(h.host, 'proj', ['src/billing/invoice.ts'], diff)
  expect(b.text).toBe(a.text)
  // the log says which lines and why
  const log = h.files.get(`${L}/logs/review-lessons.jsonl`)!.trim().split('\n').map(x => JSON.parse(x))
  expect(log.length).toBe(2)
  expect(log[0].offered.length).toBe(a.picked.length)
  expect(log[0].offered[0].why.length).toBeGreaterThan(0)
  expect(log[0].project).toBe('proj')
})

test('selection: a small budget caps the block, a topic never takes more than its share, keywords of the diff or the goal select', async () => {
  const h = bigStore()
  const small = await reviewLessons(h.host, 'proj', ['src/orders/a.ts'], '', { budget: 300, log: false })
  expect(small.tokens).toBeLessThanOrEqual(300)
  expect(small.text).toContain(REUSE_RULE) // always, even when nothing else fits
  // keywords: a goal about credentials selects the credential lines (topic security) with no path match
  const g = await reviewLessons(h.host, 'proj', [], '', { goal: 'rotate the credential field handling in the login flow', log: false })
  expect(g.picked.length).toBeGreaterThan(0)
  expect(g.text).toContain('### security')
  expect(g.picked.every(p => p.why.length > 0)).toBe(true)
  // nothing relevant: only the general rule (and header)
  const none = await reviewLessons(h.host, 'proj', ['zzz/unrelated.bin'], 'binary', { log: false })
  expect(none.picked).toEqual([])
  expect(none.text).toContain(REUSE_RULE)
  // no store at all: the rule alone, no failure
  const empty = fakeHost(null)
  const e = await reviewLessons(empty.host, 'proj', ['a.ts'], '', { log: false })
  expect(e.total).toBe(0)
  expect(e.text).toContain(REUSE_RULE)
})

test('selection: globs in a lesson match changed paths; a dropped line is never offered', async () => {
  const h = fakeHost(null)
  const a = makeLesson(1, 'review-checklist', 'Changes under the exporter need the schema version bumped', { source: 't', added: '2026-01-01' })
  a.paths = ['src/exporter/**/*.ts']
  const b = makeLesson(2, 'review-checklist', 'Old line about the exporter', { source: 't', added: '2026-01-01' })
  b.paths = ['src/exporter/**']
  b.dropped = '2026-01-02'
  h.files.set(STORE, [a, b].map(x => JSON.stringify(x)).join('\n') + '\n')
  const r = await reviewLessons(h.host, 'proj', ['src/exporter/deep/csv.ts'], '', { log: false })
  expect(r.picked.map(p => p.id)).toEqual([1])
  expect((await reviewLessons(h.host, 'proj', ['src/other/csv.ts'], '', { log: false })).picked).toEqual([])
})

test('learn: near-duplicates are skipped, a helper of a known name updates its line, replace corrects one, undo restores, the cap holds', async () => {
  const h = fakeHost(null)
  h.clock.t = 1_780_000_000_000
  let r = await learnLessons(h.host, 'proj', { checklist: ['Before adding a date parser, check src/lib/dates.ts', 'Before adding a date parser check src/lib/dates.ts please'], helpers: [{ name: 'parseDate', where: 'src/lib/dates.ts', what: 'parses ISO dates' }] })
  expect(r.added.length).toBe(2)
  expect(r.skipped.length).toBe(1)
  r = await learnLessons(h.host, 'proj', { helpers: [{ name: 'parseDate', where: 'src/lib/dates.ts', what: 'parses ISO and RFC dates' }] })
  expect(r.updated.length).toBe(1)
  expect(r.added.length).toBe(0)
  expect((await readLessons(h.host, 'proj')).find(l => l.family === 'shared-helpers')!.text).toContain('ISO and RFC')
  r = await learnLessons(h.host, 'proj', { replace: [{ old: 'Before adding a date parser, check src/lib/dates.ts', new: 'Before adding a date parser, check parseDate in src/lib/dates.ts' }] })
  expect(r.updated.length).toBe(1)
  expect((await listLessons(h.host, 'proj'))).toContain('parseDate in src/lib/dates.ts')
  expect((await undoLessons(h.host, 'proj')).ok).toBe(true) // the replace is undone
  expect((await listLessons(h.host, 'proj'))).not.toContain('parseDate in src/lib')
  expect((await undoLessons(h.host, 'proj')).ok).toBe(true) // the helper update
  expect((await readLessons(h.host, 'proj')).find(l => l.family === 'shared-helpers')!.text).not.toContain('RFC')
  expect((await undoLessons(h.host, 'proj')).ok).toBe(true) // the first batch: both lines gone
  expect(await readLessons(h.host, 'proj')).toEqual([])
  expect((await undoLessons(h.host, 'proj')).ok).toBe(false)
  // the store has its own cap, not the 25-line rule cap
  h.files.set(`${L}/config.json`, JSON.stringify({ review: { lessonMax: 3 } }))
  const many = await learnLessons(h.host, 'proj', { checklist: ['alpha one thing', 'bravo second matter', 'charlie third idea', 'delta fourth point'] })
  expect(many.added.length).toBe(3)
  expect(many.refused.length).toBe(1)
  const big = fakeHost(null)
  big.files.set(`${L}/config.json`, '{}')
  const lines = Array.from({ length: 60 }, (_, n) => `distinct lesson number${n} about subject${n}x${n * 7} and thing${n * 13}y`)
  expect((await learnLessons(big.host, 'proj', { checklist: lines })).added.length).toBe(60) // more than 25
})

test('learn: two helpers of one name in different files are two lines; a line the user removed is not learned again; replace needs a close match', async () => {
  const h = fakeHost(null)
  const r = await learnLessons(h.host, 'proj', { helpers: [{ name: 'parse', where: 'src/a/parse.ts', what: 'parses A input' }, { name: 'parse', where: 'src/b/parse.ts', what: 'parses B input' }] })
  expect(r.added.length).toBe(2)
  expect((await learnLessons(h.host, 'proj', { helpers: [{ name: 'parse', where: 'src/b/parse.ts', what: 'parses B input and trims' }] })).updated.length).toBe(1)
  expect((await readLessons(h.host, 'proj')).filter(l => l.text.includes('parse')).length).toBe(2)
  await learnLessons(h.host, 'proj', { checklist: ['Never log the credential field in the exporter'] })
  await removeLesson(h.host, 'proj', 'credential field')
  const again = await learnLessons(h.host, 'proj', { checklist: ['Never log the credential field in the exporter please'] })
  expect(again.added).toEqual([])
  expect(again.skipped.join()).toContain('removed earlier')
  const rep = await learnLessons(h.host, 'proj', { replace: [{ old: 'something about parse and input', new: 'x' }] })
  expect(rep.updated).toEqual([]) // too far from every line: nothing is overwritten
})

test('remove by number or unique text is soft (undo brings it back); a missing or ambiguous target is refused', async () => {
  const h = fakeHost(null)
  await learnLessons(h.host, 'proj', { checklist: ['alpha first lesson about queues', 'bravo second lesson about queues'] })
  expect((await removeLesson(h.host, 'proj', 'queues')).ok).toBe(false) // two lines
  expect((await removeLesson(h.host, 'proj', 99)).ok).toBe(false)
  expect((await removeLesson(h.host, 'proj', 'alpha')).ok).toBe(true)
  expect((await readLessons(h.host, 'proj')).length).toBe(2) // kept, dropped
  expect((await lessonStatus(h.host, 'proj')).dropped).toBe(1)
  expect(await listLessons(h.host, 'proj')).not.toContain('alpha')
  await undoLessons(h.host, 'proj')
  expect(await listLessons(h.host, 'proj')).toContain('alpha')
})

test('verify flags helper lines whose path and symbol cannot be found; apply drops them (and undo restores)', async () => {
  const h = fakeHost(null)
  await learnLessons(h.host, 'proj', { helpers: [{ name: 'parseDate', where: 'src/lib/dates.ts', what: 'parses dates' }, { name: 'ghostHelper', where: 'src/gone/ghost.ts', what: 'was removed' }] })
  h.git.handler = a => {
    const s = a.join(' ')
    if (s.includes('rev-parse')) return { exitCode: a.includes('HEAD^{commit}') ? 0 : 1, stdout: 'x\n' }
    if (s.includes('ls-tree')) return { exitCode: 0, stdout: 'src/lib/dates.ts\nREADME.md\n' }
    return { exitCode: 1, stdout: '' } // git grep: no symbol anywhere
  }
  const dry = await verifyLessons(h.host, 'proj', '/repo')
  expect(dry.flagged).toBe(1)
  expect(dry.lines.join('\n')).toContain('ghostHelper')
  expect((await readLessons(h.host, 'proj')).every(l => !l.dropped)).toBe(true)
  const done = await verifyLessons(h.host, 'proj', '/repo', true)
  expect(done.flagged).toBe(1)
  expect((await readLessons(h.host, 'proj')).filter(l => l.dropped).map(l => l.text)[0]).toContain('ghostHelper')
  await undoLessons(h.host, 'proj')
  expect((await readLessons(h.host, 'proj')).every(l => !l.dropped)).toBe(true)
})

// ---- the 0.45 layouts -------------------------------------------------------------------------------------------------------------
function legacy045() {
  const h = fakeHost(null)
  h.clock.t = 5_000_000_000_000
  const cards = [
    { id: 'review-checklist', kind: 'note', archived: true, text: 'x\n- OLD archived line that is in a split card now', topic: undefined },
    { id: 'review-checklist-security', kind: 'note', topic: 'security', archived: false, text: 'Review checklist, security part\n- Never log the password field in src/auth/login.ts\n- Check every token compare is constant time' },
    { id: 'review-checklist-other', kind: 'note', topic: 'other', archived: false, text: 'Review checklist, other part\n- Before adding a parser, search for an existing one' },
    { id: 'shared-helpers', kind: 'note', archived: false, text: 'Reuse these\n- normalizePhone (src/lib/phone.ts): normalises phone numbers to E.164\n- cardOnlyHelper (src/lib/card.ts): only in the card, not in the registry' },
    { id: 'db-notes', kind: 'note', title: 'Database notes', archived: false, text: 'use the pool in services/db/pool.ts' },
  ]
  const reg = [
    { id: 1, batch: 'legacy', date: '2025-05-01', cid: 'review-checklist-security', line: '- Never log the password field in src/auth/login.ts' },
    { id: 2, batch: 'b2', date: '2025-06-01', cid: 'review-checklist-security', line: '- Check every token compare is constant time' },
    { id: 3, batch: 'b2', date: '2025-06-01', cid: 'review-checklist-other', line: '- Before adding a parser, search for an existing one' },
    { id: 4, batch: 'b3', date: '2025-07-01', cid: 'shared-helpers', line: '- normalizePhone (src/lib/phone.ts): normalises phone numbers to E.164' },
    { id: 5, batch: 'b3', date: '2025-07-02', cid: 'shared-helpers', line: '- removedHelper (src/lib/gone.ts): removed in 0.45', gone: true },
  ]
  h.files.set(`${L}/projects.json`, JSON.stringify({ proj: { path: '/repo' } }))
  h.files.set(`${L}/library/proj/cards.json`, JSON.stringify(cards))
  h.files.set(`${L}/proj/review-learned.json`, JSON.stringify({ _lessons: reg, '12': { finished_at: 'x' } }))
  h.files.set(`${L}/proj/review-learn-batches.json`, JSON.stringify([{ ts: 't', ops: [{ kind: 'add', id: 'shared-helpers', line: '- x' }] }]))
  h.files.set(`${L}/proj/review-learned-threads.json`, '{"12":["abc"]}')
  h.files.set(`${L}/migrated-1.0.json`, '{}') // an install that already migrated
  return h
}

test('import: the 0.45 layouts are copied to legacy-0.45 (originals stay), live lines imported with ids, dropped ones kept as dropped; a re-run adds nothing', async () => {
  const h = legacy045()
  expect(await pendingLegacy(h.host, 'proj')).toBe(5) // 4 registry lines + the card-only helper; the removed one and the archived card are not live
  const r = await importLegacyLessons(h.host)
  expect(r.retry).toBe(false)
  for (const f of ['cards.json', 'review-learned.json', 'review-learn-batches.json', 'review-learned-threads.json']) {
    expect(h.files.has(`${L}/legacy-0.45/lessons-proj/${f}`)).toBe(true)
  }
  expect(h.files.has(`${L}/library/proj/cards.json`)).toBe(true)
  expect(h.files.has(`${L}/proj/review-learned.json`)).toBe(true)
  const all = await readLessons(h.host, 'proj')
  const liveOnes = all.filter(l => !l.dropped)
  expect(liveOnes.length).toBe(5)
  expect(liveOnes.filter(l => l.family === 'shared-helpers').length).toBe(2)
  expect(all.find(l => l.id === 4)!.paths).toEqual(['src/lib/phone.ts'])
  expect(all.find(l => l.id === 1)!.topic).toBe('security')
  expect(all.find(l => l.id === 1)!.added).toBe('2025-05-01')
  expect(all.filter(l => l.dropped).length).toBe(1)
  expect(all.some(l => l.text.includes('OLD archived'))).toBe(false)
  expect(await pendingLegacy(h.host, 'proj')).toBe(0)
  // idempotent: nothing is rewritten
  const snap = () => JSON.stringify([...h.files.entries()].sort(([a], [b]) => a.localeCompare(b)))
  const before = snap()
  const again = await importLegacyLessons(h.host)
  expect(again.lines).toEqual([])
  expect(snap()).toBe(before) // not one file changed (store, meta, copies)
  // a line the user removed is not brought back by a later import
  await removeLesson(h.host, 'proj', 'constant time')
  await importLegacyLessons(h.host)
  expect(await listLessons(h.host, 'proj')).not.toContain('constant time')
  // the status
  const s = await lessonStatus(h.host, 'proj')
  expect(s.live).toBe(4)
  expect(s.dropped).toBe(2)
  expect(s.pending).toBe(0)
  expect(s.lastImport).toBe(5_000_000_000_000)
  expect((await lessonLines(h.host, 'proj')).join('\n')).toContain('4 live (review-checklist 2, shared-helpers 2), 2 dropped')
})

test('an install already migrated (marker present) gets the import through the versioned tidy step, once; a later new lesson of the old files comes in on the next run', async () => {
  const h = legacy045()
  await h.store.set('tidy.v', 4) // the version before this one
  const lines = (await tidyLegacy(h.host)).join('\n')
  expect(lines).toContain('review lessons of proj: 6 imported from 0.45 (5 live, 1 already removed there')
  expect(h.files.get(`${L}/legacy-0.45/index.md`)).toContain('db-notes | Database notes')
  expect(h.files.get(`${L}/legacy-0.45/index.md`)).not.toContain('review-checklist-security |') // the review cards are lessons, not candidate facts
  expect(await tidyLegacy(h.host)).toEqual([]) // done for this version
  // forced re-run (migrate on a migrated install): nothing new
  expect((await tidyLegacy(h.host, true)).join('\n')).not.toContain('imported')
  // a 0.45 process added one more line to the original file: the next forced run imports exactly that line
  const reg = JSON.parse(h.files.get(`${L}/proj/review-learned.json`)!)
  reg._lessons.push({ id: 6, batch: 'b4', date: '2025-08-01', cid: 'review-checklist-other', line: '- Prefer the shared retry helper' })
  h.files.set(`${L}/proj/review-learned.json`, JSON.stringify(reg))
  expect((await tidyLegacy(h.host, true)).join('\n')).toContain('review lessons of proj: 1 imported')
})

test('migrate on a fresh 0.45 home imports the lessons too; check warns while legacy lessons are not imported', async () => {
  const h = legacy045()
  h.files.delete(`${L}/migrated-1.0.json`)
  h.files.set('/plug/opener/open-desk.sh', '#!/bin/sh\n')
  h.files.set(`${L}/threads.json`, JSON.stringify({ threads: {} }))
  const warn = (await check(h.host, '/plug')).join('\n')
  expect(warn).toContain('FIX  5 0.45 review lesson(s) of proj are not imported')
  const r = await migrate(h.host, '/plug')
  expect(r.lines.join('\n')).toContain('review lessons of proj: 6 imported')
  expect((await readLessons(h.host, 'proj')).filter(l => !l.dropped).length).toBe(5)
  expect((await check(h.host, '/plug')).join('\n')).toContain('proj: review lessons: 5 live')
})

// ---- the tool: lean_review lessons / learn / list / rm / undo / verify --------------------------------------------------------------------
test('lean_review actions: lessons selects by base/head or paths through git, learn adds, list/rm/undo/verify manage', async () => {
  const h = bigStore()
  h.files.set(`${L}/projects.json`, JSON.stringify({ proj: { path: '/repo' } }))
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ project: 'proj' }))
  const seen: string[][] = []
  h.git.handler = a => {
    seen.push(a)
    const s = a.join(' ')
    if (s.includes('rev-parse')) return { exitCode: s.includes('main') || s.includes('HEAD^') ? 0 : 1, stdout: 'x\n' }
    if (s.includes('--name-only')) return { exitCode: 0, stdout: 'src/billing/invoice.ts\n' }
    if (s.includes('diff -U0') || s.includes('diff') && a.includes('-U0')) return { exitCode: 0, stdout: '@@ -1 +1 @@\n+const v = helperFn8(1)\n' }
    return { exitCode: 1, stdout: '' }
  }
  const r = await threadTool(h.host, 't1', 'lean_review', { action: 'lessons', project: 'proj', base: 'main', head: 'feature' })
  expect(r.ok).toBe(true)
  expect(r.text).toContain(REUSE_RULE)
  expect(r.text).toContain('helperFn8')
  expect(r.text).toMatch(/\(\d+ of 500 lessons offered for 1 changed file/)
  expect(seen.some(a => a.includes('main...feature'))).toBe(true)
  // paths only
  const p = await threadTool(h.host, 't1', 'lean_review', { action: 'lessons', project: 'proj', paths: ['src/orders/a.ts'] })
  expect(p.ok).toBe(true)
  // refs are plain refs: an option-looking ref is refused
  expect((await threadTool(h.host, 't1', 'lean_review', { action: 'lessons', project: 'proj', base: '--output=/x', head: 'HEAD' })).ok).toBe(false)
  expect((await lessonsFor(h.host, { project: 'nope' })).ok).toBe(false) // not registered, no repo
  // learn / list / rm / undo
  const l = await threadTool(h.host, 't1', 'lean_review', { action: 'learn', project: 'proj', checklist: ['Brand new unique zebra lesson about giraffes'] })
  expect(l.ok).toBe(true)
  expect(l.text).toContain('added #501')
  expect((await threadTool(h.host, 't1', 'lean_review', { action: 'lessons-list', project: 'proj' })).text).toContain('501. [other] Brand new unique zebra')
  expect((await threadTool(h.host, 't1', 'lean_review', { action: 'lessons-rm', project: 'proj', which: '501' })).ok).toBe(true)
  expect((await threadTool(h.host, 't1', 'lean_review', { action: 'lessons-undo', project: 'proj' })).ok).toBe(true)
  expect((await threadTool(h.host, 't1', 'lean_review', { action: 'lessons-verify', project: 'proj' })).text).toContain('checking against') // the registered project's path is the default repo
  expect((await threadTool(h.host, 't1', 'lean_review', { action: 'lessons-verify', project: 'unregistered' })).ok).toBe(false)
  expect((await threadTool(h.host, 't1', 'lean_review', { action: 'bogus', project: 'proj' })).ok).toBe(false)
  // the record action still needs a sha
  expect((await threadTool(h.host, 't1', 'lean_review', { project: 'proj', green: true })).ok).toBe(false)
})
