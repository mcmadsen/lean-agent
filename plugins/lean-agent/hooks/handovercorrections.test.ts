// The handover's brief is the oldest word: "Corrections since the brief" (every desk message after the start, newest last) sits DIRECTLY after it,
// and a path into another thread's folder is flagged. Synthetic names only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { CORRECTIONS_HEAD, FOREIGN_NOTE, buildHandover, flagForeignPaths, timeText } from './handover'

const L = '/h/.lean-agent'
const T = `${L}/threads/t9`
const THREAD = { id: 't9', title: 'port the inventory', project: 'app', state: 'open', sid: 's1', created: 1000, lastWake: 0, delivered: 0 }
const rows = (...r: Record<string, unknown>[]) => r.map(x => JSON.stringify(x)).join('\n') + '\n'

test('a brief with a path into another thread\'s folder and a later correction: both, in that order, the path flagged', async () => {
  const h = fakeHost(null)
  h.files.set(`${T}/thread.json`, JSON.stringify(THREAD))
  h.files.set(`${T}/brief.md`, `Port the inventory.\nRead the plan copy at ${L}/threads/t12/notes/plan.md and keep going.\nYour own: ${T}/scratch/a.md\n`)
  h.files.set(`${T}/inbox.jsonl`, rows(
    { ts: 500, text: 'before the start: not a correction' },
    { ts: 2000, text: 'The plan copy moved: it is now in your scratch/plan.md.' },
    { ts: 3000, text: 'Use the staging database.', instr: true }, // the text of an earlier restart
    { ts: 4000, text: 'still queued: skip the retry work' },
  ))
  const ho = await buildHandover(h.host, '/h', THREAD as any, 'Because.', [{ ts: 4000, text: 'still queued: skip the retry work' }])
  const p = ho.prompt
  expect(p).toContain(`threads/t12/notes/plan.md ${FOREIGN_NOTE}`)
  expect(p).not.toContain(`threads/t9/scratch/a.md ${FOREIGN_NOTE}`) // the thread's own folder is not flagged
  expect(p).toContain(`## Corrections since the brief\n${CORRECTIONS_HEAD}`)
  expect(CORRECTIONS_HEAD).toBe('These came after the brief and win where they differ:')
  expect(p.indexOf('## Corrections since the brief')).toBeGreaterThan(p.indexOf('threads/t12/notes/plan.md'))
  expect(p.slice(p.indexOf('## Brief') + 1, p.indexOf('## Corrections since the brief'))).not.toContain('\n## ') // directly after the brief
  const c = p.slice(p.indexOf('## Corrections since the brief'))
  const a = c.indexOf('The plan copy moved')
  const b = c.indexOf('(text given to a restart / wake) Use the staging database.')
  const q = c.indexOf('still queued: skip the retry work')
  expect(a).toBeGreaterThan(0)
  expect(b).toBeGreaterThan(a)
  expect(q).toBeGreaterThan(b) // newest last
  expect(c).toContain(`- ${timeText(2000)} The plan copy moved`) // each with its time
  expect(c).not.toContain('before the start')
  expect(p.split('still queued: skip the retry work').length).toBe(2) // once
})

test('flagForeignPaths: only threads/tM/ with M != N; a relative path too; nothing to flag leaves the text alone', () => {
  expect(flagForeignPaths('see threads/t7/x.md.', 't9')).toBe(`see threads/t7/x.md. ${FOREIGN_NOTE}`)
  expect(flagForeignPaths('see ~/.lean-agent/threads/t850/x.md and threads/t9/y.md', 't9')).toBe(`see ~/.lean-agent/threads/t850/x.md ${FOREIGN_NOTE} and threads/t9/y.md`)
  expect(flagForeignPaths('no paths here, threads are fine', 't9')).toBe('no paths here, threads are fine')
})

test('no message after the start: no section; many messages: the newest 30 and a count of the older', async () => {
  const h = fakeHost(null)
  h.files.set(`${T}/thread.json`, JSON.stringify(THREAD))
  expect((await buildHandover(h.host, '/h', THREAD as any, 'Because.', [])).prompt).not.toContain('Corrections since the brief')
  h.files.set(`${T}/inbox.jsonl`, rows(...Array.from({ length: 35 }, (_, i) => ({ ts: 2000 + i, text: `msg ${i}` }))))
  const p = (await buildHandover(h.host, '/h', THREAD as any, 'Because.', [])).prompt
  expect(p).toContain('(5 older messages omitted:')
  expect(p).toContain('msg 34')
  expect(p).not.toContain('msg 4\n')
})
