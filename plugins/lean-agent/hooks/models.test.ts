import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { check, fix } from './doctor'
import { mergeModelSettings, readModelSettings, threadChoice } from './models'

const DESK = '/h/lean-agent-desk/.claude/settings.json'

test('setup pins the desk to sonnet / high and keeps every other key of an existing settings file', async () => {
  const h = fakeHost(null)
  h.files.set('/p/opener/open-desk.sh', '#!/bin/sh\n')
  h.files.set(DESK, JSON.stringify({ model: 'opus', theme: 'dark', permissions: { allow: ['Read'] } }))
  const f = await fix(h.host, '/p')
  expect(f.lines.join('\n')).toContain('desk pinned to sonnet / effort high')
  expect(JSON.parse(h.files.get(DESK)!)).toEqual({ model: 'sonnet', effortLevel: 'high', theme: 'dark', permissions: { allow: ['Read'], additionalDirectories: ['/h/.lean-agent'] } })
  const ok = (await check(h.host, '/p')).find(l => l.includes('desk model'))!
  expect(ok.startsWith('ok')).toBe(true)
})

test('setup lets the desk open files in ~/.lean-agent: the folder is merged into permissions.additionalDirectories, user keys and folders stay, a second run changes nothing', async () => {
  const h = fakeHost(null)
  h.files.set('/p/opener/open-desk.sh', '#!/bin/sh\n')
  // no settings file yet: the check flags it, setup writes it
  const before = (await check(h.host, '/p')).find(l => l.includes('open files in ~/.lean-agent'))!
  expect(before.startsWith('FIX')).toBe(true)
  const f = await fix(h.host, '/p')
  expect(f.lines).toContain('desk can open files in ~/.lean-agent')
  expect(JSON.parse(h.files.get(DESK)!).permissions).toEqual({ additionalDirectories: ['/h/.lean-agent'] })
  expect((await check(h.host, '/p')).find(l => l.includes('open files in ~/.lean-agent'))!.startsWith('ok')).toBe(true)
  // the user's own folders, allow list and other keys are kept; the folder is added once
  h.files.set(DESK, JSON.stringify({ model: 'sonnet', effortLevel: 'high', hooks: { x: 1 }, permissions: { allow: ['Read'], deny: ['Bash(rm:*)'], additionalDirectories: ['/data/shared'] } }))
  expect((await check(h.host, '/p')).find(l => l.includes('open files in ~/.lean-agent'))!.startsWith('FIX')).toBe(true)
  await fix(h.host, '/p')
  const once = h.files.get(DESK)!
  expect(JSON.parse(once)).toEqual({ model: 'sonnet', effortLevel: 'high', hooks: { x: 1 }, permissions: { allow: ['Read'], deny: ['Bash(rm:*)'], additionalDirectories: ['/data/shared', '/h/.lean-agent'] } })
  await fix(h.host, '/p')
  expect(h.files.get(DESK)).toBe(once)
  // odd shapes: permissions that is not an object, a list that is not an array
  h.files.set(DESK, JSON.stringify({ model: 'sonnet', effortLevel: 'high', permissions: { additionalDirectories: 'oops' } }))
  await fix(h.host, '/p')
  expect(JSON.parse(h.files.get(DESK)!).permissions.additionalDirectories).toEqual(['/h/.lean-agent'])
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

test('threads.effort from config.json applies; the thread\'s recorded choice beats config; a bad call value is an error', async () => {
  const h = fakeHost(null)
  h.files.set('/h/.lean-agent/config.json', JSON.stringify({ threads: { effort: 'low' } }))
  expect(await threadChoice(h.host, '/h', {})).toEqual({ model: 'sonnet', effort: 'low' })
  expect(await threadChoice(h.host, '/h', {}, { model: 'opus', effort: 'high' })).toEqual({ model: 'opus', effort: 'high' })
  expect(typeof (await threadChoice(h.host, '/h', { effort: 'max' }))).toBe('string')
})

test('check says when the desk settings file does not parse, and merge refuses an array', async () => {
  const h = fakeHost(null)
  h.files.set(DESK, '{ broken')
  expect((await check(h.host, '/p')).find(l => l.includes('does not parse'))).toContain('FIX')
  h.files.set(DESK, '[]')
  expect(await mergeModelSettings(h.host, DESK, { model: 'sonnet', effort: 'high' })).toBe(false)
})
