// The desk's context limit (1.0.33) and the restart the USER asks for. Synthetic data only.
//  - desk.contextLimit defaults to 200000 (was 60000); the effective limit is never more than 90 % of the model's real window when the engine reports it;
//  - a user restart (the pane's Restart desk button, /lean-agent-restart-desk) ignores the automatic guards (30 min gap, per-day count) and keeps ONE floor: 60 s.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { check } from './doctor'
import { DEFAULT_TOKENS, WINDOW_PCT, configuredDeskTokens, deskLimitText, deskTokens, effectiveLimit, noteWindow, resetDeskCompact, restartingNow, userRestartDesk, windowTokens } from './deskcompact'
import { AUTO_GAP_MS, RESTART_FLOOR_MS, autoGuard, noRestartNote, restartWaitMs } from './deskauto'

const L = '/h/.lean-agent'
function setup() {
  resetDeskCompact()
  const h = fakeHost(null)
  h.clock.t = 10_000_000
  return { h }
}
const deps = (opened: string[] = [], o: { open?: () => Promise<{ ok: boolean; text: string }> } = {}) => ({
  recent: async () => ['keep it short'],
  sid: async () => 'sess-A',
  open: o.open ?? (async () => (opened.push('open'), { ok: true, text: 'Desk opened in the Claude app.' })),
})

test('the desk limit defaults to 200000 (no 60000 left), config desk.contextLimit and the older aliases still win', async () => {
  const { h } = setup()
  expect(DEFAULT_TOKENS).toBe(200_000)
  expect(await configuredDeskTokens(h.host)).toBe(200_000)
  expect(await deskTokens(h.host)).toBe(200_000) // no window known: the configured value as it is
  h.files.set(`${L}/config.json`, JSON.stringify({ desk: { contextLimit: 120_000 } }))
  expect(await deskTokens(h.host)).toBe(120_000)
  h.files.set(`${L}/config.json`, JSON.stringify({ deskTokens: 150_000 })) // the old alias
  expect(await deskTokens(h.host)).toBe(150_000)
  h.files.set(`${L}/config.json`, JSON.stringify({ checkpoint: { deskTokens: 130_000 } })) // the 1.0.6 alias
  expect(await deskTokens(h.host)).toBe(130_000)
  h.files.set(`${L}/config.json`, JSON.stringify({ desk: { contextLimit: 5 } })) // too small: ignored, the default
  expect(await deskTokens(h.host)).toBe(200_000)
})

test('the effective limit is min(configured, 90 % of the real window): a 200k setting on a 200k window is 180k, never beyond the window', async () => {
  expect(WINDOW_PCT).toBe(90)
  expect(effectiveLimit(200_000, 200_000)).toBe(180_000)
  expect(effectiveLimit(150_000, 200_000)).toBe(150_000) // below 90 %: as configured
  expect(effectiveLimit(500_000, 200_000)).toBe(180_000) // a setting beyond the window is cut
  expect(effectiveLimit(200_000, 1_000_000)).toBe(200_000) // a bigger window changes nothing
  expect(effectiveLimit(200_000, 0)).toBe(200_000) // the window is not known (yet)
  const { h } = setup()
  expect(windowTokens()).toBe(0)
  noteWindow(200_000)
  expect(await deskTokens(h.host)).toBe(180_000)
  h.files.set(`${L}/config.json`, JSON.stringify({ desk: { contextLimit: 900_000 } }))
  expect(await deskTokens(h.host)).toBe(180_000) // 900k on a 200k window
  noteWindow('nope') // a figure that is not a number is ignored
  noteWindow(-5)
  expect(windowTokens()).toBe(200_000)
  resetDeskCompact() // a new desk session: its window is read again
  expect(windowTokens()).toBe(0)
})

test('the doctor row says the limit and what the window makes of it: "desk limit 200k (window 200k: effective 180k)"', async () => {
  const { h } = setup()
  expect(await deskLimitText(h.host)).toBe('desk limit 200k') // no window known yet
  expect((await check(h.host, '/plug')).join('\n')).toMatch(/ok {3}desk limit 200k$/m)
  noteWindow(200_000)
  expect(await deskLimitText(h.host)).toBe('desk limit 200k (window 200k: effective 180k)')
  expect((await check(h.host, '/plug')).join('\n')).toContain('ok   desk limit 200k (window 200k: effective 180k)')
  h.files.set(`${L}/config.json`, JSON.stringify({ desk: { contextLimit: 100_000 } }))
  expect(await deskLimitText(h.host)).toBe('desk limit 100k (window 200k)') // the window does not cap it: no "effective"
  noteWindow(1_000_000)
  h.files.set(`${L}/config.json`, JSON.stringify({ desk: { contextLimit: 200_000 } }))
  expect(await deskLimitText(h.host)).toBe('desk limit 200k (window 1000k)')
})

test('a USER restart writes the handover and opens the new desk in one call; it is not counted against the automatic ones and ignores both automatic guards', async () => {
  const { h } = setup()
  // 12 automatic restarts in 24 h, the last 5 min ago: the automatic guard says no ...
  const runs = Array.from({ length: 12 }, (_, n) => ({ at: h.clock.t - 300_000 - n * 60_000, kind: 'context', text: 'context' }))
  h.files.set(`${L}/desk/auto-restarts.json`, JSON.stringify({ runs }))
  expect(await autoGuard(h.host)).not.toBeNull()
  const opened: string[] = []
  const r = await userRestartDesk(h.host, deps(opened)) // ... the user's tap does not ask it
  expect(r.ok).toBe(true)
  expect(opened).toEqual(['open'])
  expect(h.files.get(`${L}/desk/handover.md`)).toContain('# Desk handover') // the handover first
  expect(JSON.parse(h.files.get(`${L}/desk/auto-restarts.json`)!).runs).toHaveLength(12) // not counted as an automatic restart
  expect(restartingNow()).toBe(false)
})

test('the floor: no desk restart of any kind within 60 s of the last one, a countdown in the answer, free again after 60 s', async () => {
  const { h } = setup()
  expect(RESTART_FLOOR_MS).toBe(60_000)
  expect(await restartWaitMs(h.host)).toBe(0) // nothing ran yet
  const opened: string[] = []
  expect((await userRestartDesk(h.host, deps(opened))).ok).toBe(true)
  expect(await restartWaitMs(h.host)).toBe(60_000)
  const again = await userRestartDesk(h.host, deps(opened))
  expect(again).toEqual({ ok: false, text: 'next restart possible in 60 s' })
  expect(opened).toHaveLength(1) // nothing opened, no handover rewritten
  h.clock.t += 45_000
  expect(await restartWaitMs(h.host)).toBe(15_000)
  expect((await userRestartDesk(h.host, deps(opened))).text).toBe('next restart possible in 15 s')
  expect(noRestartNote(1)).toBe('next restart possible in 1 s')
  expect(noRestartNote(14_001)).toBe('next restart possible in 15 s')
  h.clock.t += 15_000
  expect(await restartWaitMs(h.host)).toBe(0)
  expect((await userRestartDesk(h.host, deps(opened))).ok).toBe(true)
  expect(opened).toHaveLength(2)
  // the 30 min gap and the per-day count are NOT the floor: a restart 61 s after the last is fine, whatever the automatic log says
  h.clock.t += 61_000
  expect(AUTO_GAP_MS).toBeGreaterThan(61_000)
  expect((await userRestartDesk(h.host, deps(opened))).ok).toBe(true)
  expect(opened).toHaveLength(3)
})

test('a restart that is in progress blocks a second one ("restarting…" in the pane); a failed open frees it again but the floor stays', async () => {
  const { h } = setup()
  let release: (v: { ok: boolean; text: string }) => void = () => undefined
  let reached = false
  const slow = userRestartDesk(h.host, deps([], { open: () => new Promise(res => ((release = res), (reached = true))) }))
  for (let n = 0; n < 2000 && !reached; n++) await Promise.resolve() // (let the call write its handover and get to the opener)
  expect(reached).toBe(true)
  expect(restartingNow()).toBe(true)
  expect((await userRestartDesk(h.host, deps())).text).toBe('a desk restart is already in progress')
  release({ ok: false, text: 'no app' })
  const done = await slow
  expect(done.ok).toBe(false)
  expect(done.text).toContain('no new desk was opened')
  expect(restartingNow()).toBe(false) // freed
  expect((await userRestartDesk(h.host, deps())).text).toBe('next restart possible in 60 s') // the floor counts the attempt
})
