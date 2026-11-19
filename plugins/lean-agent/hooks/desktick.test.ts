// The desk's 10 s tick (register.tsx deskSweep) finishes threads that reported done. deskSweep only needs the host and three things of the
// engine handle (plugin.root, ui.notify, prompt.submit), so the specs hand it a stand-in handle.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { deskSweep } from './register'
import { resetLocks } from './threads'
import { resetFinish } from './finish'

const SID = '11111111-2222-3333-4444-555555555555'
const L = '/h/.lean-agent'
const T1 = `${L}/threads/t1`

function desk(rows: any[]) {
  const h = fakeHost(null)
  resetLocks()
  resetFinish()
  h.clock.t = 10_000_000
  h.files.set(`${T1}/thread.json`, JSON.stringify({ id: 't1', title: 'fix login', project: 'app', state: 'open', sid: SID, created: 1, lastWake: 0, delivered: 0 }))
  h.files.set(`${L}/desk/inbox.jsonl`, JSON.stringify({ ts: 5_000_000, from: 't1', kind: 'report', state: 'done', text: 'branch b, last commit abc1234' }) + '\n')
  h.claude.handler = (a: string[]) => {
    if (a[0] === 'agents' && a[1] === '--json') return { exitCode: 0, stdout: JSON.stringify(rows) }
    if (a[0] === 'stop') {
      for (const r of rows) r.pid = 0
      return { exitCode: 0, stdout: '' }
    }
    if (a[0] === '--bg') return { exitCode: 0, stdout: 'started 99999999-8888-7777-6666-555555555555\n' }
    return { exitCode: 0, stdout: '' }
  }
  const notices: string[] = []
  const $: any = { plugin: { root: '/p' }, ui: { notify: (t: string) => void notices.push(t) }, prompt: { submit: async () => undefined } }
  return { h, notices, $ }
}
const state = (h: any) => JSON.parse(h.files.get(`${T1}/thread.json`)!)

test('the desk tick stops an idle thread that reported done, marks it finished and says so', async () => {
  const { h, notices, $ } = desk([{ sessionId: SID, name: 't1 · fix login', cwd: T1, status: 'idle', startedAt: 1, pid: 42, id: 'abcd1234' }])
  await deskSweep($, h.host)
  expect(h.claudeCalls().filter(a => a[0] === 'stop')).toEqual([['stop', 'abcd1234']])
  expect(typeof state(h).finished).toBe('number')
  expect(notices.join('\n')).toContain('t1 finished: next message starts a new session')
  // the next tick has nothing left to do
  await deskSweep($, h.host)
  expect(h.claudeCalls().filter(a => a[0] === 'stop').length).toBe(1)
})

test('the desk tick leaves a thread that reported done but still works, and finishes it once it is idle', async () => {
  const rows = [{ sessionId: SID, name: 't1 · fix login', cwd: T1, status: 'busy', state: 'working', startedAt: 1, pid: 42, id: 'abcd1234' }]
  const { h, notices, $ } = desk(rows)
  await deskSweep($, h.host)
  expect(h.claudeCalls().some(a => a[0] === 'stop')).toBe(false)
  expect(state(h).finished).toBeUndefined()
  expect(notices.join('\n')).not.toContain('finished')
  Object.assign(rows[0]!, { status: 'idle', state: 'done' })
  await deskSweep($, h.host)
  expect(h.claudeCalls().filter(a => a[0] === 'stop').length).toBe(1)
  expect(state(h).finished).toBeGreaterThan(0)
})

test('a queued message for a finished thread starts a new session from the same tick, never a resume', async () => {
  const { h, $ } = desk([{ sessionId: SID, name: 't1 · fix login', cwd: T1, status: 'idle', startedAt: 1, pid: 42, id: 'abcd1234' }])
  h.files.set(`${T1}/inbox.jsonl`, JSON.stringify({ ts: 1, text: 'one more thing' }) + '\n')
  await deskSweep($, h.host)
  const bg = h.claudeCalls().filter(a => a[0] === '--bg')
  expect(bg.length).toBe(1)
  expect(bg[0]!.includes('--resume')).toBe(false)
  expect(bg[0]![bg[0]!.length - 1]).toContain('one more thing')
})
