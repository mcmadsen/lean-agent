import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { memorySection, openQuestions, recordAnswer, runSchedule, writeCompactNotes } from './extras'
import { threadTool } from './delivery'

const L = '/h/.lean-agent'
const j = (h: any, p: string, o: unknown) => h.files.set(`${L}/${p}`, typeof o === 'string' ? o : JSON.stringify(o))
const jl = (h: any, rows: unknown[]) => rows.map(r => JSON.stringify(r)).join('\n') + '\n'

test('memory section: the standing orders a thread may see (its own, its project\'s, the user\'s), nothing for plain', async () => {
  const h = fakeHost(null)
  j(h, 'threads/t1/thread.json', { id: 't1', project: 'app' })
  const it = (id: string, scope: string, text: string) => ({ id, scope, kind: 'rule', text, created: 1, source: 'desk', uses: 0, lastUsed: 0, status: 'active' })
  j(h, 'memory/items.json', { next: 5, items: [it('m1', 'project:app', 'tests need docker'), it('m2', 'project:other', 'not mine'), it('m3', 'global', 'global habit'), it('m4', 'thread:t9', 'another thread')] })
  const s = (await memorySection(h.host, { kind: 'thread', id: 't1' }))!
  expect(s).toContain('tests need docker')
  expect(s).toContain('global habit')
  expect(s).not.toContain('not mine')
  expect(s).not.toContain('another thread')
  expect(await memorySection(h.host, { kind: 'desk' })).toContain('global habit') // the desk gets its own and the user's habits
  expect(await memorySection(h.host, { kind: 'desk' })).not.toContain('tests need docker')
  expect(await memorySection(h.host, { kind: 'plain' })).toBeNull()
})

test('compaction writes notes.md for a thread and for the desk', async () => {
  const h = fakeHost(null)
  j(h, 'goals.json', { t1: { text: 'ship it', ts: 1 } })
  await writeCompactNotes(h.host, { kind: 'thread', id: 't1' }, [{ role: 'user', content: 'do the thing' }, { role: 'assistant', content: [{ type: 'text', text: 'working on it' }] }])
  const n = h.files.get(`${L}/threads/t1/notes.md`)!
  expect(n).toContain('Goal: ship it')
  expect(n).toContain('assistant: working on it')
  await writeCompactNotes(h.host, { kind: 'desk' }, [{ role: 'user', content: 'hi' }])
  expect(h.files.get(`${L}/desk/notes.md`)).toContain('user: hi')
  await writeCompactNotes(h.host, { kind: 'plain' }, [{ role: 'user', content: 'x' }])
  expect(h.writes.some(w => w.includes('plain'))).toBe(false)
})

test('answers are recorded against open question ids, oldest first, once', async () => {
  const h = fakeHost(null)
  j(h, 'questions.jsonl', jl(h, [{ from: 't1', question: 'a?' }, { from: 't2', question: 'b?' }, { from: 't1', question: 'c?' }]))
  expect(await recordAnswer(h.host, 't1', 'yes')).toBe(1)
  expect(await recordAnswer(h.host, 't1', 'no')).toBe(3)
  expect(await recordAnswer(h.host, 't1', 'more')).toBeNull()
  expect(await recordAnswer(h.host, 't9', 'x')).toBeNull()
  expect((await openQuestions(h.host)).map(q => q.q)).toEqual([2])
})

test('schedule: a due line is sent once, a future one waits', async () => {
  const h = fakeHost(null)
  h.clock.t = 10_000
  j(h, 'scheduled.jsonl', jl(h, [{ at: 5_000, tN: 't1', text: 'now' }, { at: 99_000, tN: 't2', text: 'later' }, { at: 1, tN: 'bad', text: 'x' }]))
  const sent: string[] = []
  const send = async (id: string, text: string) => void sent.push(`${id}:${text}`)
  expect(await runSchedule(h.host, send)).toEqual(['t1'])
  expect(await runSchedule(h.host, send)).toEqual([])
  h.clock.t = 100_000
  expect(await runSchedule(h.host, send)).toEqual(['t2'])
  expect(sent).toEqual(['t1:now', 't2:later'])
})

test('lean_review is the only writer of a signed record; bad input is refused', async () => {
  const h = fakeHost(null)
  j(h, 'threads/t1/thread.json', { id: 't1', project: 'app' })
  const sha = 'a'.repeat(40)
  const r = await threadTool(h.host, 't1', 'lean_review', { sha, green: false, passes: 2 })
  expect(r.ok).toBe(true)
  expect(JSON.parse(h.files.get(`${L}/app/reviews/${sha}.json`)!).sig).toMatch(/^[0-9a-f]{64}$/)
  expect((await threadTool(h.host, 't1', 'lean_review', { sha, green: true, passes: 2 })).ok).toBe(false) // green needs the reviewer's JSON (reviewgate.test.ts)
  expect((await threadTool(h.host, 't1', 'lean_review', { sha: 'zz', green: true })).ok).toBe(false)
})
