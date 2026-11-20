import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { INTENTS, directUse, intentOf } from './intents'
import { DAY_MS, QUIET_MS, takeTip } from './tips'

const id = (t: string) => intentOf(t)?.id ?? null

test('the table: a request in words maps to its direct command; everything else maps to none', () => {
  expect(id('please review PR 123 for me')).toBe('review')
  expect(id('can you review this branch feature/x')).toBe('review')
  expect(id('review https://github.com/o/r/pull/45')).toBe('review')
  expect(id('open a PR for t3')).toBe('pr')
  expect(id('list the threads')).toBe('list')
  expect(id('how much did I spend today?')).toBe('stats')
  expect(id('what is my budget left')).toBe('budget')
  expect(id('write a handover for t2')).toBe('handover')
  expect(id('learn from the reviews on the last PR')).toBe('review-learn')
  expect(id('start a new thread for the login fix')).toBe('new')
  expect(id('run the doctor')).toBe('doctor')
  expect(id('what is the weather')).toBeNull()
  expect(id('I reviewed it myself yesterday')).toBeNull()
  expect(new Set(INTENTS.map(i => i.id)).size).toBe(INTENTS.length)
  for (const i of INTENTS) expect(i.example.startsWith(i.command)).toBe(true)
})

test('a direct call is recognised, also in the expanded form and under the old name threads', () => {
  expect(directUse('/lean-agent:review 12')).toBe('review')
  expect(directUse('<command-name>/lean-agent:stats</command-name>')).toBe('stats')
  expect(directUse('/lean-agent:threads')).toBe('list')
  expect(directUse('/lean-agent:unknown')).toBeNull()
  expect(directUse('please /lean-agent:review')).toBeNull()
})

test('the tip: one line, once per command per day, never after a direct use for 7 days, one per turn, off by config', async () => {
  const f = fakeHost(null)
  const h = f.host
  const t1 = await takeTip(h, 'review PR 7 please')
  expect(t1).toContain('Tip: do this directly with /lean-agent:review <pr>')
  expect(t1!.split('\n').length).toBe(1)
  expect(await takeTip(h, 'review PR 8 please')).toBeNull() // once a day
  f.clock.t += DAY_MS + 1
  expect(await takeTip(h, 'review PR 9 please')).toContain('/lean-agent:review')
  // one per turn: a request matching two commands gets the first one only
  const both = await takeTip(h, 'list the threads and write a handover for t2')
  expect(both).toContain('/lean-agent:handover')
  expect(both).not.toContain('/lean-agent:list')
  // a direct use silences that command for a week
  await takeTip(h, '/lean-agent:stats 3')
  f.clock.t += DAY_MS * 3
  expect(await takeTip(h, 'how much did it cost today')).toBeNull()
  f.clock.t += QUIET_MS
  expect(await takeTip(h, 'how much did it cost today')).toContain('/lean-agent:stats')
  // relayed reports and system text are not requests; non-text is ignored
  expect(await takeTip(h, '[lean-agent] report from t2 (done): review PR 3 done')).toBeNull()
  expect(await takeTip(h, undefined)).toBeNull()
})

test('config tips: false switches the tips off', async () => {
  const f = fakeHost(null)
  f.files.set('/h/.lean-agent/config.json', JSON.stringify({ tips: false }))
  expect(await takeTip(f.host, 'review PR 7 please')).toBeNull()
  f.files.set('/h/.lean-agent/config.json', JSON.stringify({ tips: true }))
  expect(await takeTip(f.host, 'review PR 7 please')).toContain('Tip:')
})
