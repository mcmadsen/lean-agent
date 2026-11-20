import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { PER_TICK, eventsOf, notifyConfig, notifyTick } from './notify'
import { paneRole } from './pane'
import { resetViewCache } from './view'
import type { NeedRow, ThreadRow } from './view'

const L = '/h/.lean-agent'
const line = (o: unknown) => JSON.stringify(o) + '\n'
const thr = (h: any, id: string, o: Record<string, unknown> = {}) => h.files.set(`${L}/threads/${id}/thread.json`, JSON.stringify({ id, title: `synthetic ${id}`, project: 'proj', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0, ...o }))
const inbox = (h: any, ...recs: unknown[]) => h.files.set(`${L}/desk/inbox.jsonl`, (h.files.get(`${L}/desk/inbox.jsonl`) ?? '') + recs.map(line).join(''))

function world() {
  resetViewCache()
  const h = fakeHost(null)
  const agents: any[] = []
  let agentsFail = false
  h.claude.handler = (a: string[]) => (a[0] === 'agents' ? (agentsFail ? { exitCode: 2, stdout: '' } : { exitCode: 0, stdout: JSON.stringify(agents) }) : { exitCode: 0, stdout: '' })
  thr(h, 't1')
  thr(h, 't2')
  const toasts: string[] = []
  const tick = async () => {
    resetViewCache()
    return notifyTick(h.host, t => toasts.push(t))
  }
  return { h, toasts, tick, agents, failAgents: (b: boolean) => { agentsFail = b } }
}

const th = (o: Partial<ThreadRow>): ThreadRow => ({ id: 't1', title: 'x', state: 'open', run: 'idle', last: '', resumable: false, working: false, done: false, asking: false, blocked: false, needsYou: false, lastReport: '', review: 'none', cost: 0, ready: false, recTs: 5, ...o })
const need = (o: Partial<NeedRow>): NeedRow => ({ key: 'k', kind: 'blocked', text: 'x', notify: true, ...o })

test('events: the needs that notify, a done report once, and a ready-to-push report is one event, not two', () => {
  const ev = eventsOf({
    needs: [need({ key: 'a', kind: 'approval', thread: 't1', text: 't1 needs your yes in its own session: run it' }), need({ key: 's', kind: 'script', notify: false, text: 'a script waits' }), need({ key: 'p', kind: 'push', thread: 't3', text: 't3 is ready to push (abc1234 on feat/x, review green): ask the desk to push' })],
    threads: [th({ id: 't2', done: true, title: 'finished one', recTs: 9 }), th({ id: 't3', done: true, ready: true, recTs: 10 }), th({ id: 't4', done: true, state: 'parked', recTs: 11 })],
  })
  expect(ev.map(e => e.key)).toEqual(['a', 'p', 'done:t2:9'])
  expect(ev[0]!.text).toBe('needs your yes: t1 needs your yes in its own session: run it')
  expect(ev[2]!.text).toBe('t2 done: finished one')
})

test('the first pass records what is there and toasts nothing; a new event toasts once, however many ticks follow', async () => {
  const w = world()
  inbox(w.h, { ts: 100, from: 't1', kind: 'report', text: 'all merged', state: 'done' })
  expect(await w.tick()).toEqual([]) // the install must not announce old reports
  expect(w.h.files.has(`${L}/desk/notify-seen.json`)).toBe(true)
  expect(await w.tick()).toEqual([])
  inbox(w.h, { ts: 200, from: 't2', kind: 'report', text: 'tests done', state: 'done' })
  expect(await w.tick()).toEqual(['t2 done: synthetic t2'])
  expect(await w.tick()).toEqual([])
  expect(w.toasts).toEqual(['t2 done: synthetic t2'])
})

test('a question, an approval and a blocked thread each toast once; a new blocked report is a new event, the same one is not', async () => {
  const w = world()
  await w.tick() // first pass
  w.h.files.set(`${L}/questions.jsonl`, line({ ts: 300, from: 't2', question: 'which cache?' }))
  expect(await w.tick()).toEqual(['question: t2 asks: which cache?'])
  inbox(w.h, { ts: 400, from: 't1', kind: 'report', text: 'cannot go on', state: 'blocked', approval: 'git push origin synthetic-branch' })
  expect(await w.tick()).toEqual(['needs your yes: t1 needs your yes in its own session: git push origin synthetic-branch'])
  inbox(w.h, { ts: 500, from: 't2', kind: 'report', text: 'waiting on a credential', state: 'blocked' })
  expect(await w.tick()).toEqual(['blocked: t2 is blocked: waiting on a credential'])
  expect(await w.tick()).toEqual([]) // nothing changed
  inbox(w.h, { ts: 600, from: 't2', kind: 'report', text: 'working again', state: 'working' }, { ts: 700, from: 't2', kind: 'report', text: 'blocked on something else', state: 'blocked' })
  expect(await w.tick()).toEqual(['blocked: t2 is blocked: blocked on something else']) // a later blocked report: its own event
  expect(w.toasts).toHaveLength(4)
})

test('a thread that waits on a prompt, resumes and waits again is two events; a failed listing in between is not one', async () => {
  const w = world()
  const SID = '11111111-2222-3333-4444-555555555555'
  thr(w.h, 't1', { sid: SID })
  const row = (waiting: boolean) => ({ sessionId: SID, name: 'x', cwd: '/x', status: 'busy', state: 'working', startedAt: 1, ...(waiting ? { waitingFor: 'permission prompt' } : {}) })
  await w.tick() // first pass
  w.agents.push(row(true))
  expect(await w.tick()).toEqual(['blocked: t1 waits on a prompt in its own session'])
  expect(await w.tick()).toEqual([]) // still the same wait
  w.failAgents(true) // `claude agents` fails for a tick: the wait is not over, so it is not announced again
  expect(await w.tick()).toEqual([])
  w.failAgents(false)
  expect(await w.tick()).toEqual([])
  w.agents[0] = row(false) // answered: the event is over
  expect(await w.tick()).toEqual([])
  w.agents[0] = row(true) // the next prompt
  expect(await w.tick()).toEqual(['blocked: t1 waits on a prompt in its own session'])
  expect(w.toasts).toHaveLength(2)
})

test('config notify.toast false: no toast, and what happened meanwhile is not announced when it is turned on again; sound does nothing', async () => {
  const w = world()
  await w.tick()
  w.h.files.set(`${L}/config.json`, JSON.stringify({ notify: { toast: false, sound: true } }))
  expect(await notifyConfig(w.h.host)).toEqual({ toast: false, sound: true })
  inbox(w.h, { ts: 100, from: 't1', kind: 'report', text: 'done while off', state: 'done' })
  expect(await w.tick()).toEqual([])
  w.h.files.set(`${L}/config.json`, JSON.stringify({ notify: { toast: true } }))
  expect(await notifyConfig(w.h.host)).toEqual({ toast: true, sound: false })
  expect(await w.tick()).toEqual([]) // recorded while off
  inbox(w.h, { ts: 200, from: 't2', kind: 'report', text: 'done while on', state: 'done' })
  expect(await w.tick()).toEqual(['t2 done: synthetic t2'])
  w.h.files.delete(`${L}/config.json`)
  expect(await notifyConfig(w.h.host)).toEqual({ toast: true, sound: false }) // the default: toasts on, no sound
})

test(`more than ${PER_TICK} events in one pass: ${PER_TICK} toasts and one summary line`, async () => {
  const w = world()
  await w.tick()
  for (const n of [3, 4, 5, 6, 7]) thr(w.h, `t${n}`)
  inbox(w.h, ...[1, 2, 3, 4, 5].map(n => ({ ts: 100 + n, from: `t${n + 2}`, kind: 'report', text: 'finished', state: 'done' })))
  const out = await w.tick()
  expect(out).toHaveLength(PER_TICK + 1)
  expect(out[PER_TICK]).toBe(`+${5 - PER_TICK} more: see the lean-agent pane`)
})

test('the desk starts the pass at once (it only records) and every 15 s; a due toast goes to $.ui.toast; the cancels stop both timers', async () => {
  const w = world()
  const every: { ms: number; fn: () => unknown; cancelled: boolean }[] = []
  const shown: string[] = []
  const $: any = {
    ui: { open: async () => undefined, invalidate: () => undefined, toast: (t: string) => shown.push(t) },
    clock: { now: () => w.h.host.clock.now(), every: (ms: number, fn: () => unknown) => { const t = { ms, fn, cancelled: false }; every.push(t); return { cancel: () => { t.cancelled = true } } } },
    fs: w.h.host.fs,
    process: w.h.host.process,
    env: { get: () => w.h.host.env.get('HOME') },
    store: w.h.host.store,
  }
  inbox(w.h, { ts: 100, from: 't1', kind: 'report', text: 'old news', state: 'done' })
  const cancels = await paneRole($, { kind: 'desk' })
  await new Promise(r => (globalThis as any).setTimeout(r, 50)) // the first pass is not awaited by the start: let it finish
  expect(every.map(t => t.ms)).toEqual([5_000, 15_000])
  expect(shown).toEqual([]) // the first pass only recorded
  inbox(w.h, { ts: 200, from: 't2', kind: 'report', text: 'new news', state: 'done' })
  resetViewCache()
  await every[1]!.fn()
  expect(shown).toEqual(['t2 done: synthetic t2'])
  await every[1]!.fn()
  expect(shown).toHaveLength(1)
  for (const c of cancels) c()
  expect(every.every(t => t.cancelled)).toBe(true)
  // a thread gets its status line and no toast timer
  const thread: any = { ...$, ui: { ...$.ui, status: () => undefined }, clock: { ...$.clock, every: (ms: number) => { every.push({ ms, fn: () => undefined, cancelled: false }); return { cancel() {} } } } }
  const before = every.length
  await paneRole(thread, { kind: 'thread', id: 't1' })
  expect(every.slice(before).map(t => t.ms)).toEqual([5_000])
})

test('a broken seen file or an unreadable view never throws; the next tick tries again', async () => {
  const w = world()
  w.h.files.set(`${L}/desk/notify-seen.json`, '{not json')
  expect(await w.tick()).toEqual([]) // unreadable counts as "no file": a first pass
  w.h.host.env.get = async () => undefined // no HOME
  expect(await notifyTick(w.h.host, () => undefined)).toEqual([])
})
