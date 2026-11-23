import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { deskSettings, mergeSettings } from './leantools'
import { check, fix } from './doctor'
import { mergeModelSettings, readModelSettings, threadChoice } from './models'

const DESK = '/h/lean-agent-desk/.claude/settings.json'

test('setup pins the desk to sonnet / high (the 1.0.10 opus pin is reverted) and keeps every other key of an existing settings file', async () => {
  const h = fakeHost(null)
  h.files.set('/p/opener/open-desk.sh', '#!/bin/sh\n')
  h.files.set(DESK, JSON.stringify({ theme: 'dark', permissions: { allow: ['Read'] } }))
  const f = await fix(h.host, '/p')
  expect(f.lines).toContain('desk pinned to sonnet / effort high') // nothing was pinned before: no "was"
  expect(JSON.parse(h.files.get(DESK)!)).toEqual(mergeSettings({ model: 'sonnet', effortLevel: 'high', theme: 'dark', permissions: { allow: ['Read'], additionalDirectories: ['/h/.lean-agent'] } }, deskSettings())) // plus the tools strict mode cannot allow, removed (leantools.ts)
  const ok = (await check(h.host, '/p')).find(l => l.includes('desk model'))!
  expect(ok.startsWith('ok')).toBe(true)
})

test('the opus pin 1.0.10 and 1.0.11 wrote is replaced by sonnet / high by fix and the row says so; the check says fix does it; a desk.model the user set in config.json wins', async () => {
  const h = fakeHost(null)
  h.files.set('/p/opener/open-desk.sh', '#!/bin/sh\n')
  h.files.set(DESK, JSON.stringify({ model: 'opus', effortLevel: 'high', theme: 'dark' }))
  const l = (await check(h.host, '/p')).find(x => x.includes('desk model'))!
  expect(l).toContain('FIX')
  expect(l).toContain('desk model is opus / effort high, want sonnet / high (1.0.10 and 1.0.11 pinned opus: doctor fix replaces it with sonnet)')
  const f = await fix(h.host, '/p')
  expect(f.lines).toContain('desk pinned to sonnet / effort high (was opus / high: updated, 1.0.10 and 1.0.11 pinned opus; the desk is on sonnet again (opus needs your approval in the pane))')
  expect(await readModelSettings(h.host, DESK)).toEqual({ model: 'sonnet', effort: 'high' })
  expect(JSON.parse(h.files.get(DESK)!).theme).toBe('dark')
  expect((await check(h.host, '/p')).find(x => x.includes('desk model'))!.startsWith('ok')).toBe(true)
  // the user's own desk.model in config.json wins: a sonnet file stays sonnet, an opus file follows it
  const c = fakeHost(null)
  c.files.set('/p/opener/open-desk.sh', '#!/bin/sh\n')
  c.files.set('/h/.lean-agent/config.json', JSON.stringify({ desk: { model: 'sonnet' } }))
  c.files.set(DESK, JSON.stringify({ model: 'sonnet', effortLevel: 'high' }))
  expect((await check(c.host, '/p')).find(x => x.includes('desk model'))!.startsWith('ok')).toBe(true)
  const fc = await fix(c.host, '/p')
  expect(fc.lines).toContain('desk pinned to sonnet / effort high')
  expect(await readModelSettings(c.host, DESK)).toEqual({ model: 'sonnet', effort: 'high' })
  c.files.set(DESK, JSON.stringify({ model: 'opus', effortLevel: 'high' }))
  expect((await check(c.host, '/p')).find(x => x.includes('desk model'))).toContain('want sonnet / high (config.json desk)')
  expect((await fix(c.host, '/p')).lines).toContain('desk pinned to sonnet / effort high (was opus / high: updated, config.json desk.model)')
  // the user chose opus for the desk in config.json: that wins, an opus pin is kept and the check is ok
  const u = fakeHost(null)
  u.files.set('/p/opener/open-desk.sh', '#!/bin/sh\n')
  u.files.set('/h/.lean-agent/config.json', JSON.stringify({ desk: { model: 'opus', effort: 'high' } }))
  u.files.set(DESK, JSON.stringify({ model: 'opus', effortLevel: 'high' }))
  expect((await check(u.host, '/p')).find(x => x.includes('desk model'))!.startsWith('ok')).toBe(true)
  expect((await fix(u.host, '/p')).lines).toContain('desk pinned to opus / effort high')
  expect(await readModelSettings(u.host, DESK)).toEqual({ model: 'opus', effort: 'high' })
  // only the effort is configured: the row names no model cause that is not true
  const e = fakeHost(null)
  e.files.set('/p/opener/open-desk.sh', '#!/bin/sh\n')
  e.files.set('/h/.lean-agent/config.json', JSON.stringify({ desk: { effort: 'low' } }))
  e.files.set(DESK, JSON.stringify({ model: 'opus', effortLevel: 'high' }))
  expect((await fix(e.host, '/p')).lines).toContain('desk pinned to sonnet / effort low (was opus / high: updated, 1.0.10 and 1.0.11 pinned opus; the desk is on sonnet again (opus needs your approval in the pane))')
  // a hand-edited model: no cause is named
  const x = fakeHost(null)
  x.files.set('/p/opener/open-desk.sh', '#!/bin/sh\n')
  x.files.set(DESK, JSON.stringify({ model: 'haiku', effortLevel: 'low' }))
  expect((await check(x.host, '/p')).find(r => r.includes('desk model'))).toContain('want sonnet / high (doctor fix updates it)')
  expect((await fix(x.host, '/p')).lines).toContain('desk pinned to sonnet / effort high (was haiku / low: updated, the desk default is sonnet)')
})

test('setup lets the desk open files in ~/.lean-agent: the folder is merged into permissions.additionalDirectories, user keys and folders stay, a second run changes nothing', async () => {
  const h = fakeHost(null)
  h.files.set('/p/opener/open-desk.sh', '#!/bin/sh\n')
  // no settings file yet: the check flags it, setup writes it
  const before = (await check(h.host, '/p')).find(l => l.includes('open files in ~/.lean-agent'))!
  expect(before.startsWith('FIX')).toBe(true)
  const f = await fix(h.host, '/p')
  expect(f.lines).toContain('desk can open files in ~/.lean-agent')
  expect(JSON.parse(h.files.get(DESK)!).permissions).toEqual({ additionalDirectories: ['/h/.lean-agent'], deny: deskSettings().permissions.deny })
  expect((await check(h.host, '/p')).find(l => l.includes('open files in ~/.lean-agent'))!.startsWith('ok')).toBe(true)
  // the user's own folders, allow list and other keys are kept; the folder is added once
  h.files.set(DESK, JSON.stringify({ model: 'sonnet', effortLevel: 'high', hooks: { x: 1 }, permissions: { allow: ['Read'], deny: ['Bash(rm:*)'], additionalDirectories: ['/data/shared'] } }))
  expect((await check(h.host, '/p')).find(l => l.includes('open files in ~/.lean-agent'))!.startsWith('FIX')).toBe(true)
  await fix(h.host, '/p')
  const once = h.files.get(DESK)!
  expect(JSON.parse(once)).toEqual(mergeSettings({ model: 'sonnet', effortLevel: 'high', hooks: { x: 1 }, permissions: { allow: ['Read'], deny: ['Bash(rm:*)'], additionalDirectories: ['/data/shared', '/h/.lean-agent'] } }, deskSettings())) // the user's deny entry stays, the desk's removed tools are added
  await fix(h.host, '/p')
  expect(h.files.get(DESK)).toBe(once)
  // odd shapes: permissions that is not an object, a list that is not an array
  h.files.set(DESK, JSON.stringify({ model: 'sonnet', effortLevel: 'high', permissions: { additionalDirectories: 'oops' } }))
  await fix(h.host, '/p')
  expect(JSON.parse(h.files.get(DESK)!).permissions.additionalDirectories).toEqual(['/h/.lean-agent'])
  h.files.set(DESK, JSON.stringify({ model: 'sonnet', effortLevel: 'high', permissions: null }))
  await fix(h.host, '/p')
  expect(JSON.parse(h.files.get(DESK)!).permissions).toEqual({ additionalDirectories: ['/h/.lean-agent'], deny: deskSettings().permissions.deny })
  h.files.set(DESK, JSON.stringify({ model: 'sonnet', effortLevel: 'high', permissions: { additionalDirectories: [1, null, '/x'] } }))
  await fix(h.host, '/p')
  expect(JSON.parse(h.files.get(DESK)!).permissions.additionalDirectories).toEqual([1, null, '/x', '/h/.lean-agent']) // the user's entries are not judged
})

test('a desk settings file that does not parse is left alone, and setup says so', async () => {
  const h = fakeHost(null)
  h.files.set('/p/opener/open-desk.sh', '#!/bin/sh\n')
  h.files.set(DESK, '{broken')
  const f = await fix(h.host, '/p')
  expect(f.lines.join('\n')).toContain('not added to the desk\'s folders')
  expect(h.files.get(DESK)).toBe('{broken')
  expect((await check(h.host, '/p')).find(l => l.includes('open files in ~/.lean-agent'))!.startsWith('FIX')).toBe(true)
})

test('doctor check reports a missing or different desk model', async () => {
  const h = fakeHost(null)
  expect((await check(h.host, '/p')).find(l => l.includes('desk model'))).toContain('FIX')
  h.files.set(DESK, JSON.stringify({ model: 'haiku', effortLevel: 'high' }))
  const l = (await check(h.host, '/p')).find(x => x.includes('desk model'))!
  expect(l).toContain('FIX')
  expect(l).toContain('haiku')
  expect(l).toContain('want sonnet / high')
})

test('config.json desk.model / desk.effort override the desk default (the user\'s own opus choice for the desk stays); an invalid one is ignored', async () => {
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

test('threads.effort from config.json applies; the thread\'s recorded choice beats config; a bad call value is an error', async () => {
  const h = fakeHost(null)
  h.files.set('/h/.lean-agent/config.json', JSON.stringify({ threads: { effort: 'low' } }))
  expect(await threadChoice(h.host, '/h', {})).toEqual({ model: 'sonnet', effort: 'low' })
  expect(await threadChoice(h.host, '/h', {}, { model: 'opus', effort: 'high' })).toEqual({ model: 'opus', effort: 'high' })
  expect(typeof (await threadChoice(h.host, '/h', { effort: 'max' }))).toBe('string')
})

test('effort by role: an orchestrating thread defaults to medium; the call, a named record and config.json threads.effort win; off means high', async () => {
  const h = fakeHost(null)
  const c = (given: any, rec?: any, orch = true) => threadChoice(h.host, '/h', given, rec, orch).then(x => (typeof x === 'string' ? x : x.effort))
  expect(await c({})).toBe('medium')
  expect(await c({}, undefined, false)).toBe('high') // lean.orchestrate off: the thread edits itself
  expect(await c({ effort: 'high' })).toBe('high') // design / refactoring named by the desk
  expect(await c({}, { effort: 'high' })).toBe('medium') // a recorded default is recomputed (restart, auto restart)
  expect(await c({}, { effort: 'high', effortSet: true })).toBe('high') // a recorded effort a call named stays
  h.files.set('/h/.lean-agent/config.json', JSON.stringify({ threads: { effort: 'low' } }))
  expect(await c({})).toBe('low')
  expect(await c({ effort: 'high' })).toBe('high')
})

test('check says when the desk settings file does not parse, and merge refuses an array', async () => {
  const h = fakeHost(null)
  h.files.set(DESK, '{ broken')
  expect((await check(h.host, '/p')).find(l => l.includes('does not parse'))).toContain('FIX')
  h.files.set(DESK, '[]')
  expect(await mergeModelSettings(h.host, DESK, { model: 'sonnet', effort: 'high' })).toBe(false)
})
