import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { check, fix } from './doctor'
import { mergeModelSettings, readModelSettings } from './models'

const DESK = '/h/lean-agent-desk/.claude/settings.json'

test('setup pins the desk to sonnet / high and keeps every other key of an existing settings file', async () => {
  const h = fakeHost(null)
  h.files.set('/p/opener/open-desk.sh', '#!/bin/sh\n')
  h.files.set(DESK, JSON.stringify({ model: 'opus', theme: 'dark', permissions: { allow: ['Read'] } }))
  const f = await fix(h.host, '/p')
  expect(f.lines.join('\n')).toContain('desk pinned to sonnet / effort high')
  expect(JSON.parse(h.files.get(DESK)!)).toEqual({ model: 'sonnet', effortLevel: 'high', theme: 'dark', permissions: { allow: ['Read'] } })
  const ok = (await check(h.host, '/p')).find(l => l.includes('desk model'))!
  expect(ok.startsWith('ok')).toBe(true)
})

test('doctor check reports a missing or different desk model', async () => {
  const h = fakeHost(null)
  expect((await check(h.host, '/p')).find(l => l.includes('desk model'))).toContain('FIX')
  h.files.set(DESK, JSON.stringify({ model: 'opus', effortLevel: 'high' }))
  const l = (await check(h.host, '/p')).find(x => x.includes('desk model'))!
  expect(l).toContain('FIX')
  expect(l).toContain('opus')
})

test('config.json desk.model / desk.effort override the desk default; an invalid one is ignored', async () => {
  const h = fakeHost(null)
  h.files.set('/p/opener/open-desk.sh', '#!/bin/sh\n')
  h.files.set('/h/.lean-agent/config.json', JSON.stringify({ desk: { model: 'opus', effort: 'bogus' } }))
  await fix(h.host, '/p')
  expect(await readModelSettings(h.host, DESK)).toEqual({ model: 'opus', effort: 'high' })
})

test('a settings file that does not parse is never overwritten', async () => {
  const h = fakeHost(null)
  h.files.set(DESK, '{ broken')
  expect(await mergeModelSettings(h.host, DESK, { model: 'sonnet', effort: 'high' })).toBe(false)
  expect(h.files.get(DESK)).toBe('{ broken')
})
