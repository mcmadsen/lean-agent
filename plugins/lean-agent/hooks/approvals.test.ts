// The "needs your yes" card of a thread whose action the permission check denied (approvals.ts): it exists only while the thread is really
// blocked. Everything is synthetic. The pane's Open tN press is in openthread.test.tsx.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { approvalLive, liveApproval, noteCall, notePending, resetApprovals, resumedAt } from './approvals'
import { threadTool } from './delivery'
import { loadView, needsOf, resetViewCache } from './view'
import { loadThreadDetail, resetThreadCache } from './threaddetail'
import { resetLocks } from './threads'

const SID = '11111111-2222-3333-4444-555555555555'
const ACTION = 'work-item update --id 4821 --state Done'
const REPORT = 'mcp__lean-agent__lean_report'
const row = (o: Record<string, unknown> = {}) => ({ sessionId: SID, id: SID.slice(0, 8), name: 't1 · x', cwd: '/h/.lean-agent/threads/t1', startedAt: 1, status: 'idle', state: 'done', pid: 42, ...o })

// t1 reported blocked with an approval at ts 5; its session row is `rows[0]`
function world(rows: any[] | null) {
  resetLocks()
  resetViewCache()
  resetThreadCache()
  resetApprovals()
  const h = fakeHost(null)
  const state = { rows }
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', title: 'one', project: 'p', state: 'open', sid: SID, created: 1, lastWake: 0, delivered: 0 }))
  h.files.set('/h/.lean-agent/desk/inbox.jsonl', JSON.stringify({ ts: 5, from: 't1', kind: 'report', text: 'the permission check denied the update', state: 'blocked', approval: ACTION }) + '\n')
  h.claude.handler = (a: string[]) => (a[0] === 'agents' ? (state.rows ? { exitCode: 0, stdout: JSON.stringify(state.rows) } : { exitCode: 1, stdout: '', stderr: 'no listing' }) : { exitCode: 0, stdout: '' })
  const approval = async () => (await loadView(h.host)).threads.find(t => t.id === 't1')?.approval
  return { h, state, approval }
}

// ---- the rule ------------------------------------------------------------------------------------------------------------------
test('approvalLive: the card needs a text, a session that is not working, and no tool call since the report', () => {
  expect(approvalLive(ACTION, 5, { working: false, resumedAt: 0 })).toBe(ACTION)
  expect(approvalLive(ACTION, 5, { working: true, resumedAt: 0 })).toBe('') // it carried on: the old row said "(it is working: wait)"
  expect(approvalLive(ACTION, 5, { working: false, resumedAt: 9 })).toBe('') // a tool call after the report
  expect(approvalLive(ACTION, 5, { working: false, resumedAt: 5 })).toBe('')
  expect(approvalLive(ACTION, 5, { working: false, resumedAt: 4 })).toBe(ACTION) // a call from before the report is no sign
  expect(approvalLive('', 5, { working: false, resumedAt: 0 })).toBe('')
})

test('noteCall: the first tool call after a blocked report ends the card; a reply to the desk does not; one store read per session', async () => {
  const { h } = world([row()])
  expect(await noteCall(h.host, 't1', 'Bash')).toBe(false) // nothing pending
  await notePending(h.host, 't1', 5)
  expect(await noteCall(h.host, 't1', REPORT)).toBe(false)
  expect(await noteCall(h.host, 't1', 'mcp__lean-agent__lean_ask')).toBe(false)
  expect(await resumedAt(h.host, 't1')).toBe(0)
  h.clock.t = 7777
  expect(await noteCall(h.host, 't1', 'Edit')).toBe(true)
  expect(await resumedAt(h.host, 't1')).toBe(7777)
  expect(await noteCall(h.host, 't1', 'Edit')).toBe(false) // only the first one
  expect(await h.host.store.get('approval.pending.t1')).toBeNull()
  // a new session (the user opened it) reads what is pending once, however many calls follow
  resetApprovals()
  await h.host.store.set('approval.pending.t1', 9000)
  let reads = 0
  const get = h.host.store.get
  h.host.store.get = async (k: string) => (reads++, get(k))
  expect(await noteCall(h.host, 't1', 'Bash')).toBe(true)
  expect(await noteCall(h.host, 't1', 'Bash')).toBe(false)
  expect(await noteCall(h.host, 't1', 'Read')).toBe(false)
  expect(reads).toBe(1)
})

test('noteCall: another thread, a bad id and a new session (the user opened it) are handled; a later report starts a new card', async () => {
  const { h } = world([row()])
  await notePending(h.host, 't1', 5)
  expect(await noteCall(h.host, 't2', 'Bash')).toBe(false) // t2 has nothing pending, and t1's stays
  expect(await h.host.store.get('approval.pending.t1')).toBe(5)
  expect(await noteCall(h.host, '../t1', 'Bash')).toBe(false)
  await notePending(h.host, 'x', 9)
  expect(await h.host.store.get('approval.pending.x')).toBeUndefined()
  resetApprovals() // a new process (Open tN resumes the session): the pending report is read from the store, once
  h.clock.t = 50
  expect(await noteCall(h.host, 't1', 'Bash')).toBe(true)
  await notePending(h.host, 't1', 100) // it blocked again
  expect(await liveApproval(h.host, 't1', ACTION, 100, false)).toBe(ACTION) // the earlier call (50) predates this report
  h.clock.t = 120
  expect(await noteCall(h.host, 't1', 'Bash')).toBe(true)
  expect(await liveApproval(h.host, 't1', ACTION, 100, false)).toBe('')
})

// ---- the pane and the detail ----------------------------------------------------------------------------------------------------
test('the pane: an idle blocked thread has the card; working, or a tool call since the report, ends it; an unreadable listing keeps it', async () => {
  const w = world([row()])
  expect(await w.approval()).toBe(ACTION)
  expect(needsOf(await loadView(w.h.host)).filter(n => n.kind === 'approval')).toHaveLength(1)
  w.state.rows = [row({ status: 'busy', state: 'working' })]
  resetViewCache()
  expect(await w.approval()).toBeUndefined() // it carried on
  expect(needsOf(await loadView(w.h.host)).filter(n => n.kind === 'approval')).toHaveLength(0)
  w.state.rows = [row()] // idle again, no later desk record, but it made a tool call after the report
  resetViewCache()
  expect(await w.approval()).toBe(ACTION)
  await notePending(w.h.host, 't1', 5)
  w.h.clock.t = 900
  await noteCall(w.h.host, 't1', 'Bash')
  resetViewCache()
  expect(await w.approval()).toBeUndefined()
  const u = world(null) // `claude agents` failed: not known to be working, so a real approval is never hidden on a guess
  expect(await u.approval()).toBe(ACTION)
})

test('the thread detail follows the same rule', async () => {
  const w = world([row()])
  expect((await loadThreadDetail(w.h.host, 't1'))!.approval).toBe(ACTION)
  w.state.rows = [row({ status: 'busy', state: 'working' })]
  resetThreadCache()
  expect((await loadThreadDetail(w.h.host, 't1'))!.approval).toBe('')
  w.state.rows = [row()]
  await notePending(w.h.host, 't1', 5)
  w.h.clock.t = 900
  await noteCall(w.h.host, 't1', 'Bash')
  resetThreadCache()
  expect((await loadThreadDetail(w.h.host, 't1'))!.approval).toBe('')
})

// ---- the report ----------------------------------------------------------------------------------------------------------------
test('lean_report: a blocked report with an approval notes it as pending; a working or approval-less one does not; the pending note is no decision', async () => {
  const w = world([row()])
  w.h.files.set('/h/.lean-agent/desk.json', JSON.stringify({ sid: 'desk-sid' }))
  const send = async () => ({ isDelivered: true })
  await threadTool(w.h.host, 't1', 'lean_report', { text: 'x', state: 'working', approval: ACTION }, send)
  await threadTool(w.h.host, 't1', 'lean_report', { text: 'x', state: 'blocked' }, send)
  expect(await w.h.host.store.get('approval.pending.t1')).toBeUndefined()
  w.h.clock.t = 321
  await threadTool(w.h.host, 't1', 'lean_report', { text: 'denied', state: 'blocked', approval: ACTION }, send)
  expect(await w.h.host.store.get('approval.pending.t1')).toBe(321)
  // nothing in the store allows or denies a call: no grant, no decision, only the display note
  expect([...w.h.store.keys()].filter(k => k.startsWith('approval.'))).toEqual(['approval.pending.t1'])
})
