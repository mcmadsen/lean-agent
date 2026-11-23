// 1.0.28 a pending request does not block the thread: the report goes out as `working` (no red state), the row wears a "waiting for your Approve" badge, the
// Needs-you card carries the request, a later plain report does not hide it, and the result arrives as a message.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { addActionRequest, answerAction, listActions, resetActions } from './deskactions'
import { threadTool } from './delivery'
import { needsOf, pendingText } from './view'
import type { ThreadRow } from './view'
import { resetLocks } from './threads'

const L = '/h/.lean-agent'
const REPLY = { org: 'acme', project: 'Shop App', repo: 'shop-api', pr: 42, thread: 7, body: 'Fixed in the next commit.' }
const row = (over: Partial<ThreadRow>): ThreadRow => ({ id: 't5', title: 'x', state: 'open', run: 'running', last: '', resumable: true, working: true, done: false, asking: false, blocked: false, needsYou: false, lastReport: '', review: 'none' as any, cost: 0, ready: false, recTs: 1, ...over }) as ThreadRow

test('a report with an action stays working: the desk row says working, the card carries the request, the badge names it, and a later report does not hide it', { timeoutMs: 20_000 }, async () => {
  const h = fakeHost(null)
  resetLocks()
  resetActions()
  h.files.set(`${L}/threads/t5/thread.json`, JSON.stringify({ id: 't5', title: 'x', project: 'app', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.files.set(`${L}/desk.json`, JSON.stringify({ sid: 'desk-sid-1' }))
  const sent: string[] = []
  for (const state of ['blocked', 'working']) {
    const r = await threadTool(h.host, 't5', 'lean_report', { state, text: 'I need to reply to a PR thread', action: { kind: 'ado-pr-reply', params: { ...REPLY, body: `${REPLY.body} (${state})` }, why: 'close it' } }, async (_s, t) => {
      sent.push(t)
      return { isDelivered: true }
    })
    expect(r.ok, r.text).toBe(true)
    expect(r.text).toContain('Carry on with the other steps that do not need it')
  }
  const rows = (h.files.get(`${L}/desk/inbox.jsonl`) ?? '').trim().split('\n').map(l => JSON.parse(l))
  expect(rows.map(r => r.state)).toEqual(['working', 'working']) // never blocked
  expect(sent.join('\n')).toContain('AskUserQuestion') // the desk still asks the user at once
  const list = await listActions(h.host)
  expect(list).toHaveLength(2)
  // the pane: no blocked row, the card is there, the badge names the request
  const t = row({ pending: pendingText(list[0]!, 2) })
  const needs = needsOf({ threads: [t], openQuestions: [], scripts: { candidates: 0, adopted: 0, needsUpdate: 0, waiting: [] }, desk: { context: 0, limit: 0 } as any, actionRequests: list })
  expect(needs.map(n => n.kind)).toEqual(['action', 'action'])
  expect(t.pending).toMatch(/^waiting for your Approve: reply to PR thread 7 on PR 42 \(\+1\)$/)
  // a later plain report from the thread does not clear the requests: they stay until answered
  await threadTool(h.host, 't5', 'lean_report', { state: 'working', text: 'queued the run; tidied the notes' })
  expect(await listActions(h.host)).toHaveLength(2)
  // the answer arrives as a message and the thread continues
  const told: string[] = []
  await answerAction(h.host, list[0]!.id, 'deny', 'pane', async (_t, text) => void told.push(text))
  expect(told[0]).toContain('denied')
  expect((await listActions(h.host)).map(r => r.id)).toEqual([list[1]!.id])
})

test('a done report cannot carry an action', async () => {
  const h = fakeHost(null)
  resetLocks()
  resetActions()
  const r = await threadTool(h.host, 't5', 'lean_report', { state: 'done', text: 'x', action: { kind: 'ado-pr-reply', params: REPLY } })
  expect(r.ok).toBe(false)
  expect((await addActionRequest(h.host, 't5', { kind: 'ado-pr-reply', params: REPLY })).ok).toBe(true) // (nothing was left half made)
})
