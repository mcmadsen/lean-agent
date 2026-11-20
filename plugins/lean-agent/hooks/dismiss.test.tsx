// Dismiss on a blocked card: `lean_thread dismiss tN` records that the user acknowledged THAT report (history.jsonl); the blocked badge and
// the notice go until a NEWER blocked report arrives; the report stays in the inbox. Synthetic ids only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { dismissAction, dismissedTs } from './dismiss'
import { leanThread, resetLocks } from './threads'
import { loadView, resetViewCache } from './view'

const L = '/h/.lean-agent'
const line = (o: unknown) => JSON.stringify(o) + '\n'
const thr = (h: any, id: string) => h.files.set(`${L}/threads/${id}/thread.json`, JSON.stringify({ id, title: `synthetic ${id}`, project: 'proj', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
const inbox = (h: any, ...recs: unknown[]) => h.files.set(`${L}/desk/inbox.jsonl`, (h.files.get(`${L}/desk/inbox.jsonl`) ?? '') + recs.map(line).join(''))
const PANE = { plugin: 'lean-agent', component: 'Pane', requestId: 'lean-agent', surface: 'desktop', props: { title: 'lean-agent', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const

function world(on: any = null) {
  resetLocks()
  resetViewCache()
  const h = fakeHost(on)
  h.claude.handler = (a: string[]) => (a[0] === 'agents' && a[1] === '--json' ? { exitCode: 0, stdout: '[]' } : { exitCode: 0, stdout: '' })
  if (on) {
    on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
    on('store.get', () => ({ value: undefined }))
    on('store.set', () => ({ value: undefined }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
  }
  return h
}

test('dismiss records the acknowledged report; a newer blocked report shows again; the inbox keeps the report; other states say nothing to dismiss', async () => {
  const h = world()
  thr(h, 't3')
  thr(h, 't4')
  inbox(h, { ts: 110, from: 't3', kind: 'report', text: 'waiting for a credential', state: 'blocked' }, { ts: 115, from: 't4', kind: 'report', text: 'on it', state: 'working' })
  expect((await loadView(h.host)).threads.find(t => t.id === 't3')!.blocked).toBe(true)
  expect((await dismissAction(h.host, { tN: 't4' })).text).toContain('not blocked')
  expect((await dismissAction(h.host, { tN: 'nope' })).ok).toBe(false)
  const r = await leanThread(h.host, '/root', { action: 'dismiss', tN: 't3' }) // the one dispatch line in threads.ts
  expect(r.ok).toBe(true)
  expect(r.text).toContain('acknowledged')
  expect(await dismissedTs(h.host, L.replace('/.lean-agent', ''), 't3')).toBe(110)
  expect(h.files.get(`${L}/threads/t3/history.jsonl`)).toContain('"kind":"dismiss"')
  resetViewCache()
  const v = await loadView(h.host)
  expect(v.threads.find(t => t.id === 't3')!.blocked).toBe(false)
  expect(v.needs.some(n => n.thread === 't3')).toBe(false) // the notice is gone
  expect(h.files.get(`${L}/desk/inbox.jsonl`)).toContain('waiting for a credential') // the report stays
  expect((await dismissAction(h.host, { tN: 't3' })).text).toContain('already dismissed') // twice is harmless
  inbox(h, { ts: 200, from: 't3', kind: 'report', text: 'blocked again on the same credential', state: 'blocked' })
  resetViewCache()
  const again = await loadView(h.host)
  expect(again.threads.find(t => t.id === 't3')!.blocked).toBe(true)
  expect(again.needs.some(n => n.thread === 't3' && n.kind === 'blocked')).toBe(true)
})

test('the pane: a blocked card has a two-press Dismiss; after it the card is gone', async ($, on) => {
  const h = world(on)
  await $.session.start({ cwd: '/h/lean-agent-desk', surface: 'desktop', isInteractive: true } as any)
  thr(h, 't3')
  inbox(h, { ts: 110, from: 't3', kind: 'report', text: 'waiting for a credential', state: 'blocked' })
  const ui = await $.ui.mount(PANE as any)
  expect(await ui.find({ type: 'Text', text: /t3 is blocked: waiting for a credential/ })).toBeTruthy()
  await ui.press({ key: 'dismiss-t3' })
  expect(await ui.find({ type: 'Button', text: /Confirm dismiss t3/ })).toBeTruthy() // armed, nothing recorded yet
  expect(h.files.get(`${L}/threads/t3/history.jsonl`)).toBeUndefined()
  await ui.press({ key: 'dismiss-t3' })
  expect(h.files.get(`${L}/threads/t3/history.jsonl`)).toContain('"kind":"dismiss"')
  expect(await ui.find({ type: 'Text', text: /t3 is blocked: waiting for a credential/ })).toBeFalsy()
  await ui.unmount()
})
