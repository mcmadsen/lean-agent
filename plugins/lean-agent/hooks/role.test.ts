import { expect, test } from 'claude-code/testing'
import { detectRole, recordSid, resolveRole } from './role'
import { fakeHost } from './fake'

const rec = (id: string, sid: string, state = 'open') => JSON.stringify({ id, title: 'x', project: 'proj', state, sid, created: 1, lastWake: 0, delivered: 0 })

test('an unknown session id in a thread folder is that thread, never a desk; its id is then recorded in sids', { timeoutMs: 20_000 }, async ($, on) => {
  const h = fakeHost(on)
  h.files.set('/h/.lean-agent/threads/t1/thread.json', rec('t1', 'sess-old'))
  const o = { cwd: '/h/.lean-agent/threads/t1', sid: 'sess-copy-with-a-new-id' }
  expect(await resolveRole(h.host, o)).toEqual({ kind: 'thread', id: 't1' })
  expect(await resolveRole(h.host, { ...o, cwd: '/h/.lean-agent/threads/t1/wt/x' })).toEqual({ kind: 'thread', id: 't1' })
  expect(await resolveRole(h.host, { ...o, sid: '' })).toEqual({ kind: 'thread', id: 't1' }) // no id at all: the folder still decides
  expect(await recordSid(h.host, 't1', o.sid)).toBe(true)
  expect(JSON.parse(String(h.files.get('/h/.lean-agent/threads/t1/thread.json'))).sids).toEqual(['sess-copy-with-a-new-id'])
  // from then on the copy is found by its id from any folder
  expect(await resolveRole(h.host, { cwd: '/h/code/proj', sid: o.sid })).toEqual({ kind: 'thread', id: 't1' })
})

test('the desk folder is the desk, whatever the session id; a thread folder is never the desk', { timeoutMs: 20_000 }, async ($, on) => {
  const h = fakeHost(on)
  h.files.set('/h/.lean-agent/threads/t1/thread.json', rec('t1', 'sess-t1'))
  expect(await resolveRole(h.host, { cwd: '/h/lean-agent-desk', sid: 'sess-unknown' })).toEqual({ kind: 'desk' })
  expect(await resolveRole(h.host, { cwd: '/h/lean-agent-desk', sid: 'sess-t1' })).toEqual({ kind: 'desk' }) // folder first
  expect(await resolveRole(h.host, { cwd: '/h/.lean-agent/threads/t1', sid: 'sess-unknown' })).toEqual({ kind: 'thread', id: 't1' })
  expect(await resolveRole(h.host, { cwd: '/h/code/proj', sid: 'sess-unknown' })).toEqual({ kind: 'plain' })
  // a desk session stays the desk when it walks into a thread folder; a thread stays its thread
  expect(await resolveRole(h.host, { cwd: '/h/.lean-agent/threads/t1', sid: 'sess-unknown', current: { kind: 'desk' } })).toEqual({ kind: 'desk' })
  expect(await resolveRole(h.host, { cwd: '/h/lean-agent-desk', sid: 'sess-t1', current: { kind: 'thread', id: 't1' } })).toEqual({ kind: 'thread', id: 't1' })
})

test('an id another open thread holds beats the thread folder it walked into', { timeoutMs: 20_000 }, async ($, on) => {
  const h = fakeHost(on)
  h.files.set('/h/.lean-agent/threads/t1/thread.json', rec('t1', 'sess-t1'))
  h.files.set('/h/.lean-agent/threads/t2/thread.json', rec('t2', ''))
  expect(await resolveRole(h.host, { cwd: '/h/.lean-agent/threads/t2', sid: 'sess-t1' })).toEqual({ kind: 'thread', id: 't1' })
  h.files.set('/h/.lean-agent/threads/t1/thread.json', rec('t1', 'sess-t1', 'closed')) // a closed record's id decides nothing
  expect(await resolveRole(h.host, { cwd: '/h/.lean-agent/threads/t2', sid: 'sess-t1' })).toEqual({ kind: 'thread', id: 't2' })
})

test('role comes from the real path of the session cwd', { timeoutMs: 20_000 }, async ($, on) => {
  const h = fakeHost(on)
  h.links.set('/link/desk', '/h/lean-agent-desk')
  h.links.set('/link/t7', '/h/.lean-agent/threads/t7')
  const r = (p: string) => detectRole(h.host, p)
  expect(await r('/h/lean-agent-desk')).toEqual({ kind: 'desk' })
  expect(await r('/link/desk')).toEqual({ kind: 'desk' })
  expect(await r('/h/.lean-agent/threads/t3')).toEqual({ kind: 'thread', id: 't3' })
  expect(await r('/link/t7')).toEqual({ kind: 'thread', id: 't7' })
  expect(await r('/h/.lean-agent/threads/t3/wt/x')).toEqual({ kind: 'thread', id: 't3' })
  expect(await r('/h/.lean-agent/threads/notes')).toEqual({ kind: 'plain' })
  expect(await r('/h/lean-agent-desk2')).toEqual({ kind: 'plain' })
  expect(await r('/h/code/proj')).toEqual({ kind: 'plain' })
})
