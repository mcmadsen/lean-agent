import { expect, test } from 'claude-code/testing'
import { detectRole } from './role'
import { fakeHost } from './fake'

test('role comes from the real path of the session cwd', async ($, on) => {
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
