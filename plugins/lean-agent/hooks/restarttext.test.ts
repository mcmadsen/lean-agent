// 1.0.24: the text given to restart / reopen / start / wake / resume reaches the session it starts; what the desk sent since the last report is in the handover
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { INSTR_HEAD, INSTR_LEAD, buildHandover } from './handover'
import { leanThread, resetLocks, unusedField } from './threads'

const SID = '11111111-2222-3333-4444-555555555555'
const ROOT = '/p'
const L = '/h/.lean-agent'
const T1 = `${L}/threads/t1`

function world() {
  resetLocks()
  const h = fakeHost(null)
  h.files.set(`${ROOT}/templates/thread.md`, '# {{id}} {{title}}')
  h.files.set(`${ROOT}/templates/front-desk.md`, 'desk {{lean}}')
  const state = { rows: [] as any[] }
  h.claude.handler = (a: string[]) => {
    if (a[0] === '--bg') return { exitCode: 0, stdout: `started ${SID}\n` }
    if (a[0] === 'agents' && a[1] === '--json') return { exitCode: 0, stdout: JSON.stringify(state.rows) }
    if (a[0] === 'stop') {
      state.rows = []
      return { exitCode: 0, stdout: '' }
    }
    return { exitCode: 0, stdout: '' }
  }
  const call = (i: any) => leanThread(h.host, ROOT, i)
  const bg = () => h.claudeCalls().filter(a => a[0] === '--bg')
  const prompt = () => bg().at(-1)!.at(-1)!
  const thread = (o: Record<string, unknown> = {}) => h.files.set(`${T1}/thread.json`, JSON.stringify({ id: 't1', title: 'a', project: '', state: 'open', sid: SID, created: 1, lastWake: 0, delivered: 0, model: 'sonnet', effort: 'high', ...o }))
  const running = () => (state.rows = [{ sessionId: SID, name: 't1 · a', cwd: T1, status: 'busy', state: 'working', startedAt: 1, pid: 4242 }])
  return { h, state, call, bg, prompt, thread, running }
}
const NEW = 'The user says: use the staging database from now on; the cache bug was fixed by t7 an hour ago. Skip the retry work.'

test('restart with text: the new session\'s prompt ENDS with it, under the heading, the first line points at it, and the reply says so (message is an alias)', async () => {
  const w = world()
  w.thread()
  w.running()
  const r = await w.call({ action: 'restart', tN: 't1', text: NEW })
  expect(r.ok, r.text).toBe(true)
  expect(r.text).toContain('restarted as a new session')
  expect(r.text).toContain(`new session; your text (${NEW.length} chars) is its first instruction`)
  const p = w.prompt()
  expect(p.endsWith(`${INSTR_HEAD}\n${NEW}`)).toBe(true)
  expect(INSTR_HEAD).toBe('New instructions from the desk (newer than the handover above; they win where they differ):')
  expect(p.split('\n')[0]).toContain(INSTR_LEAD) // the task-first line points at it
  expect(p.split('\n')[0]).toContain('Resume the work now')
  expect(p.split(INSTR_HEAD).length).toBe(2)
  // delivered: nothing is left queued for the next session
  expect(JSON.parse(w.h.files.get(`${T1}/thread.json`)!).delivered).toBeGreaterThan(0)
  // the alias
  const m = world()
  m.thread()
  m.running()
  const r2 = await m.call({ action: 'restart', tN: 't1', message: 'use message' })
  expect(r2.text).toContain('your text (11 chars) is its first instruction')
  expect(m.prompt().endsWith(`${INSTR_HEAD}\nuse message`)).toBe(true)
  // no text: no heading, no pointer
  const n = world()
  n.thread()
  n.running()
  await n.call({ action: 'restart', tN: 't1' })
  expect(n.prompt()).not.toContain(INSTR_HEAD)
  expect(n.prompt()).not.toContain(INSTR_LEAD)
})

test('a start that is held (an expensive model needs the user\'s Approve) says "text not delivered", keeps the text queued, and the next start carries it', async () => {
  const w = world()
  w.thread()
  w.running()
  const held = await w.call({ action: 'restart', tN: 't1', model: 'opus', reason: 'a cross-module change', text: NEW })
  expect(held.text).toContain('NOT started on opus')
  expect(held.text).toContain('text not delivered: the call was held for the user\'s approval')
  expect(held.text).toContain('the next start carries it')
  expect(w.bg()).toHaveLength(0)
  expect(w.h.files.get(`${T1}/inbox.jsonl`)).toContain('"instr":true')
  expect(w.h.files.get(`${T1}/inbox.jsonl`)).toContain('staging database')
  // the next start (on sonnet) carries it as the last part of its first prompt
  const next = await w.call({ action: 'restart', tN: 't1', model: 'sonnet' })
  expect(next.ok, next.text).toBe(true)
  expect(w.prompt().endsWith(`${INSTR_HEAD}\n${NEW}`)).toBe(true)
  // a thread that is closed: wake only queues; the text waits for the reopen
  const c = world()
  c.thread({ state: 'closed' })
  const q = await c.call({ action: 'wake', tN: 't1', text: 'wake text' })
  expect(q.text).toContain('text not delivered')
  const re = await c.call({ action: 'reopen', tN: 't1' })
  expect(re.ok, re.text).toBe(true)
  expect(c.prompt().endsWith(`${INSTR_HEAD}\nwake text`)).toBe(true)
})

test('lean_thread refuses a field the action does not use, naming it and where it belongs; the text may be text or message, not both', () => {
  const u = (e: Record<string, unknown>) => unusedField({ tool: 'mcp__lean-agent__lean_thread', ...e })
  expect(u({ action: 'close', tN: 't1', text: 'hello' })).toContain('close does not use the field "text"')
  expect(u({ action: 'close', tN: 't1', text: 'hello' })).toContain('use send')
  expect(u({ action: 'restart', tN: 't1', title: 'x' })).toContain('title is used by new')
  expect(u({ action: 'wake', tN: 't1', model: 'sonnet' })).toContain('model is used by new, set, reopen, resume, start, restart')
  expect(u({ action: 'send', tN: 't1', banana: 1 })).toContain('lean_thread has no field "banana"')
  expect(u({ action: 'send', tN: 't1', text: 'a', message: 'b' })).toContain('not both')
  // what is used passes; empty values are not fields
  expect(u({ action: 'restart', tN: 't1', text: 'x', model: 'sonnet', effort: 'high', reason: 'r' })).toBeNull()
  expect(u({ action: 'restart', tN: 't1', message: 'x' })).toBeNull()
  expect(u({ action: 'send', tN: 't1', text: 'x', title: '', needs: [] })).toBeNull()
  expect(u({ action: 'new', title: 't', text: 'b', project: 'app', keep: true, allowEdit: ['/a/b/c'] })).toBeNull()
  expect(u({ action: 'approve-action', id: 'a1-1' })).toBeNull()
  expect(u({ action: 'dismiss', tN: 't1', kind: 'action' })).toBeNull()
  expect(u({ action: 'list' })).toBeNull()
})

test('the handover holds what the desk sent since the last report (queued, delivered to an ended session, results of its actions), newest last', async () => {
  const w = world()
  w.thread({ delivered: 1 })
  w.h.files.set(`${L}/desk/inbox.jsonl`, JSON.stringify({ ts: 1000, from: 't1', kind: 'report', state: 'blocked', text: 'waiting for the PR check' }) + '\n')
  const rows = [
    { ts: 500, text: 'old message before the report' },
    { ts: 2000, text: 'The cache bug is fixed by t7.' },
    { ts: 2500, text: 'The user approved your request a1-1 and the desk sent it (ado-pr-thread-status): thread 7 set to fixed. Carry on.' },
    { ts: 3000, text: 'still queued: skip the retry work' },
  ]
  w.h.files.set(`${T1}/inbox.jsonl`, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  const t = JSON.parse(w.h.files.get(`${T1}/thread.json`)!)
  const ho = await buildHandover(w.h.host, '/h', t, 'test', [rows[3]!])
  const p = ho.prompt
  // one section right after the brief, every message since the thread's start (also those before its last report), newest last, each once
  expect(p).toContain('## Corrections since the brief\nThese came after the brief and win where they differ:')
  const c = p.slice(p.indexOf('## Corrections since the brief'))
  const at = (s: string) => c.indexOf(s)
  expect(at('old message before the report')).toBeGreaterThan(0)
  expect(at('The cache bug is fixed by t7.')).toBeGreaterThan(at('old message'))
  expect(at('thread 7 set to fixed')).toBeGreaterThan(at('The cache bug'))
  expect(at('still queued: skip the retry work')).toBeGreaterThan(at('thread 7 set to fixed'))
  expect(p.split('still queued: skip the retry work').length).toBe(2)
  expect(p.slice(p.indexOf('## Brief') + 1, p.indexOf('## Corrections since the brief'))).not.toContain('\n## ') // DIRECTLY after the brief
  // a message that was queued WITH text for a restart is the instruction block (whole, last); the section only points at it
  const ho2 = await buildHandover(w.h.host, '/h', t, 'test', [{ ts: 4000, text: 'do X now', instr: true }])
  expect(ho2.prompt.endsWith(`${INSTR_HEAD}\ndo X now`)).toBe(true)
  expect(ho2.prompt.split('do X now').length).toBe(2)
  expect(ho2.prompt).toContain('(the text given to this start: at the END of this prompt)')
  // no message: no section
  const none = world()
  none.thread()
  expect((await buildHandover(none.h.host, '/h', JSON.parse(none.h.files.get(`${T1}/thread.json`)!), 'test', [])).prompt).not.toContain('Corrections since the brief')
})
