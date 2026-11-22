// "Open tN": a thread blocked on an `approval` (the command or action Claude Code's permission check denied in ITS session) is opened
// in the app for the user's yes: its idle process is stopped first, then the resume deep link goes to the system opener.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { leanThread, resetLocks } from './threads'
import { openThreadSession, resumeLink } from './setup'
import { approvalHint, threadTool } from './delivery'
import { loadView, resetViewCache } from './view'

const SID = '11111111-2222-3333-4444-555555555555'
const FOLDER = '/h/.lean-agent/threads/t1'
const ACTION = 'work-item update --id 4821 --state Done'
const LINK = `claude://resume?session=${SID}`
const PANE = {
  plugin: 'lean-agent',
  component: 'Pane',
  requestId: 'lean-agent',
  surface: 'desktop',
  props: { title: 'lean-agent', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const
const row = (o: Record<string, unknown> = {}) => ({ sessionId: SID, id: SID.slice(0, 8), name: 't1 · x', cwd: FOLDER, startedAt: 1, status: 'idle', state: 'done', pid: 42, ...o })

// t1 reported blocked with an approval; its session is `rows[0]`; `claude stop` takes the process away; every step is logged in order
function world(rows: any[], on: any = null, last: Record<string, unknown> = { state: 'blocked', approval: ACTION }) {
  resetLocks()
  resetViewCache()
  const h = fakeHost(on)
  const order: string[] = []
  const state = { rows, stopExit: 0 }
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', title: 'one', project: 'p', state: 'open', sid: SID, created: 1, lastWake: 0, delivered: 0 }))
  h.files.set('/h/.lean-agent/desk/inbox.jsonl', JSON.stringify({ ts: 5, from: 't1', kind: 'report', text: 'the permission check denied the update', ...last }) + '\n')
  h.claude.handler = (a: string[]) => {
    if (a[0] === 'agents') return { exitCode: 0, stdout: JSON.stringify(state.rows) }
    if (a[0] === 'stop') {
      order.push('stop')
      if (state.stopExit) return { exitCode: state.stopExit, stdout: '', stderr: 'cannot stop' }
      for (const r of state.rows) { delete r.pid; r.state = 'stopped'; delete r.status }
      return { exitCode: 0, stdout: 'stopped' }
    }
    return { exitCode: 0, stdout: '' }
  }
  h.opener.handler = (a: string[]) => { order.push(`open ${a[a.length - 1]}`); return { exitCode: 0, stdout: '' } }
  const open = (surface = 'desktop') => openThreadSession(h.host, 't1', () => leanThread(h.host, '/p', { action: 'release', tN: 't1' }), surface)
  return { h, order, state, open }
}

test('lean_report: `approval` is kept only on a blocked report (trimmed, one line, cut); the desk line says to press Open and not to do it', async () => {
  const h = fakeHost(null)
  h.files.set('/h/.lean-agent/desk.json', JSON.stringify({ sid: 'desk-sid' }))
  const sent: string[] = []
  const send = async (_sid: string, text: string) => { sent.push(text); return { isDelivered: true } }
  const rows = () => (h.files.get('/h/.lean-agent/desk/inbox.jsonl') ?? '').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  await threadTool(h.host, 't1', 'lean_report', { text: 'denied', state: 'blocked', approval: `  ${ACTION}\n  --note ${'x'.repeat(400)} ` }, send)
  await threadTool(h.host, 't2', 'lean_report', { text: 'denied', state: 'working', approval: ACTION }, send)
  await threadTool(h.host, 't3', 'lean_report', { text: 'denied', state: 'blocked' }, send)
  const [a, b, c] = rows()
  expect(a.approval).toMatch(/^work-item update --id 4821 --state Done --note x+$/)
  expect(a.approval.length).toBe(300)
  await threadTool(h.host, 't4', 'lean_report', { text: 'denied', state: 'blocked', approval: `run \u001b[31mthis\u0007 now` }, send)
  expect(rows()[3].approval).toBe('run [31mthis now') // control characters never reach the pane or the desk prompt
  expect(b.approval).toBeUndefined() // a working report cannot wait for the user's yes
  expect(c.approval).toBeUndefined()
  expect(sent[0]).toContain("[needs the user's yes in t1's own session:")
  expect(sent[0]).toContain('press "Open t1" in the pane')
  expect(sent[0]).toContain('do not run it yourself')
  expect(sent[0]).toContain('do not ask it with AskUserQuestion and do not send a yes') // the desk never relays the yes
  expect(sent).toHaveLength(3) // t2 was a working report: not sent at once
  expect(sent[1]).not.toContain('needs the user')
  expect(approvalHint({ ts: 1, from: 't9', kind: 'report', state: 'done', text: 'x', approval: 'y' })).toBe('') // only blocked
})

test('the pane view: a blocked report with an approval is the thread\'s approval; a later record or a closed thread clears it', async () => {
  const w = world([row()])
  expect((await loadView(w.h.host)).threads.find(t => t.id === 't1')?.approval).toBe(ACTION)
  w.h.files.set('/h/.lean-agent/desk/inbox.jsonl', (w.h.files.get('/h/.lean-agent/desk/inbox.jsonl') ?? '') + JSON.stringify({ ts: 9, from: 't1', kind: 'report', state: 'working', text: 'went on' }) + '\n')
  resetViewCache()
  expect((await loadView(w.h.host)).threads.find(t => t.id === 't1')?.approval).toBeUndefined()
  const d = world([row()], null, { state: 'done', approval: ACTION })
  expect((await loadView(d.h.host)).threads.find(t => t.id === 't1')?.approval).toBeUndefined() // not blocked
})

test('the resume link carries the session id, encoded', () => {
  expect(resumeLink(SID)).toBe(LINK)
  expect(resumeLink('a b&c')).toBe('claude://resume?session=a%20b%26c')
})

test('Open tN: the idle process is stopped and gone first, then the resume link goes to `open` as argv (macOS)', async () => {
  const w = world([row()])
  const r = await w.open()
  expect(r.ok).toBe(true)
  expect(r.text).toContain('t1 opened in the Claude app')
  expect(w.order).toEqual(['stop', `open ${LINK}`]) // the stop comes first
  expect(w.h.calls.filter((c: any) => c.argv[0] === 'open').map((c: any) => c.argv)).toEqual([['open', LINK]])
  expect(w.h.claudeCalls()).toContainEqual(['stop', SID.slice(0, 8)])
})

test('Open tN: the reply cannot claim the right session opened: it says what to do if a new desk did, the session\'s name and `claude attach <id>`', async () => {
  const w = world([row()])
  const r = await w.open()
  expect(r.text).toContain('if a new desk opened instead, close it')
  expect(r.text).toContain("in the app's session list as 't1 · one'")
  expect(r.text).toContain(`claude attach ${SID}`)
  expect(r.text).not.toMatch(/the right session (is|was) (shown|opened)/)
})

test('Open tN: a session that already stopped is not stopped again; Linux uses xdg-open, Windows rundll32', async () => {
  const w = world([row({ pid: undefined, status: undefined, state: 'stopped' })])
  expect((await w.open()).ok).toBe(true)
  expect(w.order).toEqual([`open ${LINK}`])
  w.h.os.name = 'Linux'
  expect((await w.open()).ok).toBe(true)
  expect(w.h.calls.filter((c: any) => c.argv[0] === 'xdg-open').map((c: any) => c.argv)).toEqual([['xdg-open', LINK]])
  w.h.os.name = 'MINGW64_NT-10.0'
  expect((await w.open()).ok).toBe(true)
  expect(w.h.calls.some((c: any) => c.argv[0] === 'rundll32' && c.argv[2] === LINK)).toBe(true)
})

test('Open tN refuses, and stops and opens nothing: a working session, a session outside the thread folder, a stop that fails, an unreadable listing', async () => {
  for (const [name, rows, text] of [
    ['busy', [row({ status: 'busy' })], /t1 is working: not opened/],
    ['reported working', [row({ state: 'working' })], /t1 is working: not opened/],
    ['outside the folder', [row({ cwd: '/h/elsewhere' })], /runs outside the thread folder/],
  ] as const) {
    const w = world(rows as any)
    const r = await w.open()
    expect(r.ok, name).toBe(false)
    expect(r.text, name).toMatch(text)
    expect(w.order, name).toEqual([])
  }
  const p = world([row({ waitingFor: 'a permission prompt' })]) // waiting on a prompt of its own: stopping it would drop the prompt
  const pr = await p.open()
  expect(pr.ok).toBe(false)
  expect(pr.text).toContain('waits on a prompt of its own')
  expect(p.order).toEqual([])
  const f = world([row()])
  f.state.stopExit = 1
  const r = await f.open()
  expect(r.ok).toBe(false)
  expect(r.text).toContain('claude stop')
  expect(f.order).toEqual(['stop']) // no link after a failed stop
  const u = world([row()])
  u.h.claude.handler = (a: string[]) => (a[0] === 'agents' ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: '' })
  expect((await u.open()).ok).toBe(false)
  expect(u.h.calls.some((c: any) => c.argv[0] === 'open')).toBe(false)
})

test('Open tN: the opener fails -> its first line and the way by hand; the app is not running -> nothing is stopped; a thread without a session or a closed one is refused', async () => {
  const w = world([row()])
  w.h.opener.handler = (a: string[]) => { w.order.push(`open ${a[a.length - 1]}`); return { exitCode: 1, stdout: '', stderr: 'no app\nsecond line' } }
  const r = await w.open()
  expect(r.ok).toBe(false)
  expect(r.text).toBe('Could not open the Claude app: no app; open t1 from the session list in the Claude app by hand')
  const n = world([row()])
  n.h.app.running = false
  const r2 = await n.open('terminal')
  expect(r2).toEqual({ ok: false, text: 'The Claude app is not running: open it, then press Open t1 again.' })
  expect(n.order).toEqual([]) // the idle process is still there
  const none = world([row()])
  none.h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', title: 'one', project: 'p', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  expect((await none.open()).text).toContain('no session')
  const closed = world([row()])
  closed.h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', title: 'one', project: 'p', state: 'closed', sid: SID, created: 1, lastWake: 0, delivered: 0 }))
  expect((await closed.open()).text).toContain('reopen it first')
})

const inDesk = ($: any) => $.session.start({ cwd: '/h/lean-agent-desk', surface: 'desktop', isInteractive: true } as any)

test('the pane row "tN needs your yes in its own session: <action>" has an Open tN button; the press stops the process, then opens the link; a failure is said in the notice', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world([row()], on)
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  expect(await ui.find({ type: 'Text', text: new RegExp(`t1 needs your yes in its own session: ${ACTION}`) })).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: 'Open t1' })).toBeTruthy()
  await ui.press({ key: 'open-t1' })
  expect(w.order).toEqual(['stop', `open ${LINK}`])
  expect(await ui.find({ type: 'Text', text: /t1 opened in the Claude app/ })).toBeTruthy()
  // the opener fails: the notice says so
  w.state.rows = [row()]
  w.h.opener.handler = () => ({ exitCode: 1, stdout: '', stderr: 'no app' })
  await ui.press({ key: 'open-t1' })
  expect(await ui.find({ type: 'Text', text: /Could not open the Claude app: no app; open t1 from the session list/ })).toBeTruthy()
  await ui.unmount()
})

test('a thread that is working again has no yes-row (the blocked report is stale), so no button either', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world([row({ status: 'busy' })], on)
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  expect(await ui.find({ type: 'Text', text: /t1 needs your yes in its own session/ })).toBeFalsy()
  expect(await ui.find({ type: 'Button', text: 'Open t1' })).toBeFalsy()
  expect(w.order).toEqual([])
  await ui.unmount()
})

test('a blocked thread without an approval has no yes-row and no Open button', { timeoutMs: 20_000 }, async ($, on) => {
  const q = world([row()], on, { state: 'blocked' })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  expect(await ui.find({ type: 'Text', text: /needs your yes in its own session/ })).toBeFalsy()
  expect(await ui.find({ type: 'Button', text: 'Open t1' })).toBeFalsy()
  expect(q.order).toEqual([])
  await ui.unmount()
})
