// Window-aware throttling (throttle.ts, budgettick.ts, the guard's window rule, the desk's new/start gate): a 5h window at 74% and at 93%, the user's cap in percent,
// priority low parked and resumed by script. Synthetic numbers; the plan data is the windows.json the sessions' mods write (a real rateLimits reading is not testable here).
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { decide } from './guard'
import { levelFor, newWorkGate, reviewWindowGate, throttleLine, windowState } from './throttle'
import { windowParkTick } from './budgettick'
import { leanThread } from './threads'

const L = '/h/.lean-agent'
const HOUR = 3_600_000
const win = (h: ReturnType<typeof fakeHost>, five: number, resetsIn = 2 * HOUR) =>
  h.files.set(`${L}/desk/windows.json`, JSON.stringify({ v: 1, at: h.clock.t, windows: [{ kind: 'five_hour', percentUsed: five, resetsAt: h.clock.t + resetsIn }, { kind: 'seven_day', percentUsed: 46, resetsAt: h.clock.t + 3 * 86_400_000 }] }))
const cfg = (h: ReturnType<typeof fakeHost>, o: unknown) => h.files.set(`${L}/config.json`, JSON.stringify(o))
const agent = (o: Record<string, unknown>) => ({ tool: 'Agent', prompt: 'do it', description: 'a step', ...o })
const ROOT = '/plug'
function guarded() {
  const h = fakeHost(null)
  for (const [n, m] of [['worker-sonnet', 'sonnet'], ['worker-haiku', 'haiku'], ['reviewer', 'sonnet']]) h.files.set(`${ROOT}/agents/${n}.md`, `---\nname: ${n}\nmodel: ${m}\n---\nbody\n`)
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', project: 'shop' }))
  const run = (e: any, id = 't1') => decide(h.host, { role: { kind: 'thread', id }, cwd: '/r/app', root: ROOT }, e)
  return { h, run }
}

test('levelFor: above 70 throttled, above 92 blocked, the cap holds AT it; nothing measured is ok', () => {
  expect(levelFor(null, 70, 92, null)).toBe('ok')
  expect(levelFor(70, 70, 92, null)).toBe('ok')
  expect(levelFor(74, 70, 92, null)).toBe('throttled')
  expect(levelFor(93, 70, 92, null)).toBe('blocked')
  expect(levelFor(60, 70, 92, 60)).toBe('capped')
  expect(levelFor(59, 70, 92, 60)).toBe('ok')
})

test('windowState: defaults, config keys (nested or flat), a window that reset counts as nothing measured', async () => {
  const h = fakeHost(null)
  expect((await windowState(h.host)).level).toBe('ok') // no windows.json
  win(h, 74)
  expect(await windowState(h.host)).toMatchObject({ pct: 74, level: 'throttled', throttleAbove: 70, blockAbove: 92, cap: null })
  cfg(h, { window: { throttleAbove: 80 } })
  expect((await windowState(h.host)).level).toBe('ok')
  cfg(h, { 'window.capFiveHourPct': 70, 'window.throttleAbove': 90 })
  expect(await windowState(h.host)).toMatchObject({ level: 'capped', cap: 70 })
  cfg(h, {})
  win(h, 93, -1) // reset one ms ago
  expect(await windowState(h.host)).toMatchObject({ pct: null, level: 'ok' })
})

test('guard at 74%: a sonnet Agent call is refused with the exact words, haiku (type or override) goes through; urgent does not lift the haiku rule', async () => {
  const { h, run } = guarded()
  expect(await run(agent({ subagent_type: 'lean-agent:worker-sonnet' }))).toBeNull() // under the line
  win(h, 74)
  const why = (await run(agent({ subagent_type: 'lean-agent:worker-sonnet' })))!
  expect(why).toContain('5h window at 74%: haiku only; ask the user to lift it')
  expect(await run(agent({ subagent_type: 'lean-agent:reviewer' }))).toContain('haiku only')
  expect(await run(agent({ subagent_type: 'lean-agent:worker-haiku' }))).toBeNull()
  expect(await run(agent({ subagent_type: 'lean-agent:reviewer', model: 'haiku' }))).toBeNull()
  expect(await run(agent({ subagent_type: 'general-purpose' }))).toContain('haiku only') // the session's own model is not haiku
  expect(await run({ tool: 'Read', file_path: '/r/app/a.ts' })).not.toContain('haiku only') // only Agent calls
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', project: 'shop', priority: 'urgent' }))
  expect(await run(agent({ subagent_type: 'lean-agent:worker-sonnet' }))).toContain('haiku only')
  cfg(h, { window: { throttleAbove: 100 } }) // the user lifted it
  expect(await run(agent({ subagent_type: 'lean-agent:worker-sonnet' }))).toBeNull()
})

test('guard at 93%: no new fan-out at all except priority urgent; at the user cap all of it is held, urgent too', async () => {
  const { h, run } = guarded()
  win(h, 93)
  const blocked = (await run(agent({ subagent_type: 'lean-agent:worker-haiku' })))!
  expect(blocked).toContain('5h window at 93%')
  expect(blocked).toContain('no new agent or reviewer fan-out')
  expect(await run(agent({ subagent_type: 'lean-agent:reviewer', model: 'haiku' }))).toContain('no new agent or reviewer fan-out')
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', project: 'shop', priority: 'urgent' }))
  expect(await run(agent({ subagent_type: 'lean-agent:worker-haiku' }))).toBeNull() // urgent: haiku still goes
  cfg(h, { window: { capFiveHourPct: 90 } })
  expect(await run(agent({ subagent_type: 'lean-agent:worker-haiku' }))).toContain('your cap of 90%')
})

test('desk new / start: low priority refused above the throttle line, others warned, 93% blocks all but urgent, the cap holds everything and names the reset', async () => {
  const h = fakeHost(null)
  expect(await newWorkGate(h.host, 'low')).toEqual({})
  win(h, 74)
  expect((await newWorkGate(h.host, 'low')).refuse).toContain('priority low')
  expect((await newWorkGate(h.host, 'normal')).warn).toContain('WARNING 5h window at 74%: throttled')
  win(h, 93)
  expect((await newWorkGate(h.host, 'normal')).refuse).toContain('above window.blockAbove 92%')
  expect(await newWorkGate(h.host, 'urgent')).toMatchObject({ warn: expect.stringContaining('93%') })
  cfg(h, { window: { capFiveHourPct: 85 } })
  const held = (await newWorkGate(h.host, 'urgent')).refuse!
  expect(held).toContain('cap of 85%')
  expect(held).toContain('resets')
  // the same through lean_thread: the call is refused before anything is created
  const r = await leanThread(h.host, '/plug', { action: 'new', title: 'x', project: 'shop', text: 'brief' })
  expect(r.ok).toBe(false)
  expect(r.text).toContain('not started')
  expect(await leanThread(h.host, '/plug', { action: 'new', title: 'x', priority: 'soon' as any })).toMatchObject({ ok: false })
  expect(h.files.has(`${L}/threads/t1/thread.json`)).toBe(false)
})

test('lean_thread list and the throttle line carry the 5h percent and "throttled"', async () => {
  const h = fakeHost(null)
  expect(await throttleLine(h.host)).toBe('')
  win(h, 74)
  expect(await throttleLine(h.host)).toContain('5h window 74%: throttled above 70%')
  const list = await leanThread(h.host, '/plug', { action: 'list' })
  expect(list.text).toContain('5h window 74%: throttled')
  win(h, 40)
  expect(await throttleLine(h.host)).toBe('5h window 40%: under the throttle line 70%')
})

test('windowParkTick: low priority open threads are parked by script above the line, resumed when the window drops or resets; the user\'s parks stay; one notice each way', async () => {
  const h = fakeHost(null)
  const th = (id: string, o: Record<string, unknown>) => h.files.set(`${L}/threads/${id}/thread.json`, JSON.stringify({ id, title: id, project: 'shop', sid: 's', ...o }))
  th('t1', { state: 'open', priority: 'low' })
  th('t2', { state: 'open' })
  th('t3', { state: 'parked', priority: 'low' }) // the user's park
  th('t4', { state: 'open', priority: 'urgent' })
  const calls: string[] = []
  const deps = { thread: async (i: { action: string; tN: string }) => {
    calls.push(`${i.action} ${i.tN}`)
    const f = `${L}/threads/${i.tN}/thread.json`
    const t = JSON.parse(h.files.get(f)!)
    if (i.action === 'window-park') h.files.set(f, JSON.stringify({ ...t, state: 'parked', windowParked: true }))
    else h.files.set(f, JSON.stringify({ ...t, state: 'open', windowParked: undefined }))
    return { ok: true, text: i.action }
  } }
  expect(await windowParkTick(h.host, deps)).toEqual([]) // nothing measured
  win(h, 74)
  const down = await windowParkTick(h.host, deps)
  expect(calls).toEqual(['window-park t1'])
  expect(down).toHaveLength(1)
  expect(down[0]).toContain('parked t1 (priority low)')
  expect(await windowParkTick(h.host, deps)).toEqual([]) // once
  expect(calls).toHaveLength(1)
  win(h, 55)
  const up = await windowParkTick(h.host, deps)
  expect(calls).toEqual(['window-park t1', 'window-resume t1'])
  expect(up[0]).toContain('resumed t1')
  win(h, 93, -1) // a reset window
  expect(await windowParkTick(h.host, deps)).toEqual([])
})

test('lean_review prepare in a hot window: throttled says haiku only, blocked and capped start no reviewer (urgent excepted at block)', async () => {
  const h = fakeHost(null)
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', project: 'shop' }))
  h.files.set(`${L}/threads/t2/thread.json`, JSON.stringify({ id: 't2', project: 'shop', priority: 'urgent' }))
  expect(await reviewWindowGate(h.host, 't1')).toEqual({})
  win(h, 74)
  expect((await reviewWindowGate(h.host, 't1')).note).toContain('model "haiku"')
  win(h, 93)
  expect((await reviewWindowGate(h.host, 't1')).stop).toContain('no reviewer fan-out starts until the window resets')
  expect((await reviewWindowGate(h.host, 't2')).stop).toBeUndefined()
  cfg(h, { window: { capFiveHourPct: 90 } })
  expect((await reviewWindowGate(h.host, 't2')).stop).toContain('your cap of 90%')
})
