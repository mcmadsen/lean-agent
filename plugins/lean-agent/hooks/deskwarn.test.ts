// 1.0.33: the desk is never restarted, compacted or stopped by itself (desk.autoRestart false, the default); above its limit it simply goes on. The limit is a warning level:
// the handover is kept ready (script only), ONE toast says it at the first crossing, nothing repeats. desk.autoRestart true brings the old automatic path back. Everything is synthetic.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { REGISTRY, findEntry } from './configkeys'
import { autoRestartDesk, deskAutoOn, deskTick, handoverFile, limitLineOnce, resetDeskCompact } from './deskcompact'
import type { DeskDeps } from './deskcompact'

const L = '/h/.lean-agent'
const LIMIT = 100_000

function world(cfg?: unknown) {
  resetDeskCompact()
  const h = fakeHost(null)
  h.clock.t = 10_000_000
  h.files.set(`${L}/config.json`, JSON.stringify(cfg ?? { desk: { contextLimit: LIMIT } }))
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', title: 'parser work', project: 'demo', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  const seen = { compact: 0, status: [] as string[], notes: 0, reset: 0, toasts: [] as string[], restarts: 0 }
  const deps = (tokens: number): DeskDeps => ({
    tokens: async () => tokens,
    busy: () => false,
    compact: async () => {
      seen.compact++
      return { messages: [] }
    },
    notes: async () => void seen.notes++,
    recent: async () => ['keep the pane short'],
    sid: () => 'desk-sess-1',
    status: t => void seen.status.push(t),
    reset: () => void seen.reset++,
    notify: t => void seen.toasts.push(t),
  })
  const auto = (tokens: number) => autoRestartDesk(h.host, { tokens, sid: 'desk-sess-1', inApp: true, restart: async () => ({ ok: (seen.restarts++, true), text: 'opened' }) })
  return { h, seen, deps, auto }
}

test('default: at 1x, 2x and 5x the limit nothing restarts, compacts or stops the desk: no restart call, no compaction, no status line, no "end your turn" line; the handover is kept ready', async () => {
  const w = world()
  expect(await deskAutoOn(w.h.host)).toBe(false)
  for (const mult of [1, 2, 5]) {
    const tokens = LIMIT * mult
    expect(await deskTick(w.h.host, w.deps(tokens))).toBe('soon')
    expect(await w.auto(tokens)).toBe('off')
    expect(limitLineOnce()).toBeNull() // no line in the desk's next prompt
  }
  expect(w.seen.restarts).toBe(0)
  expect(w.seen.compact).toBe(0)
  expect(w.seen.status).toEqual([])
  expect(w.seen.notes).toBe(0)
  expect(w.h.files.get(handoverFile('/h'))).toContain('# Desk handover') // (script only: the click is instant)
  expect([...w.h.files.keys()].some(k => /auto-restarts|auto-started|desk-autorestart/.test(k))).toBe(false) // no record of an automatic restart, no guard notice
  // the other reasons are off too: an update, a pin that cannot be applied, lost tools
  expect(await autoRestartDesk(w.h.host, { tokens: 1000, sid: 'desk-sess-1', inApp: true, skew: 'code 1.0.1 is running but 1.0.2 is installed', toolsLost: 'no SendMessage tool', restart: async () => ({ ok: (w.seen.restarts++, true), text: 'opened' }) })).toBe('off')
  expect(w.seen.restarts).toBe(0)
})

test('default: ONE toast when the context first crosses the limit, not at every tick; below the limit it is quiet, a new climb says it again', async () => {
  const w = world()
  await deskTick(w.h.host, w.deps(85_000)) // 80 %: the handover is ready, nothing is said
  expect(w.seen.toasts).toEqual([])
  expect(w.h.files.has(handoverFile('/h'))).toBe(true)
  w.h.files.delete(handoverFile('/h'))
  await deskTick(w.h.host, w.deps(104_000))
  expect(w.seen.toasts).toEqual(['desk 104k of 100k: above its limit, press Restart desk when it suits you'])
  expect(w.h.files.has(handoverFile('/h'))).toBe(true) // written again at the limit (once)
  for (const t of [110_000, 150_000, 500_000]) await deskTick(w.h.host, w.deps(t))
  expect(w.seen.toasts).toHaveLength(1)
  await deskTick(w.h.host, w.deps(20_000)) // a restart (or a compaction): below again
  await deskTick(w.h.host, w.deps(101_000))
  expect(w.seen.toasts).toHaveLength(2)
})

test('desk.autoRestart true restores the old automatic path: compaction at the limit and the restart at 95 % (one spec; the rest of the old path is in deskauto.test.ts and deskstages.test.ts)', async () => {
  const w = world({ desk: { contextLimit: LIMIT, autoRestart: true } })
  expect(await deskAutoOn(w.h.host)).toBe(true)
  expect(await deskTick(w.h.host, w.deps(104_000))).toBe('compacted')
  expect(w.seen.compact).toBe(1)
  expect(w.seen.toasts).toEqual([]) // (the warn-mode toast is not part of the old path)
  expect(await w.auto(120_000)).toBe('restarted')
  expect(w.seen.restarts).toBe(1)
})

test('the old keys are kept: desk.autoRestartPerDay (and the grace of the automatic path) still accepted, said to be used only with desk.autoRestart true; the registry default of desk.autoRestart is false', () => {
  expect(findEntry('desk.autoRestart')?.default).toBe(false)
  expect(findEntry('desk.autoRestartPerDay')?.description).toMatch(/^Only used with desk\.autoRestart true/)
  expect(REGISTRY.some(e => e.key === 'desk.autoRestartPerDay')).toBe(true)
})
