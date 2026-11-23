// The optional look (look.ts): off by default and then it sets and clears nothing; on (config pane.theme: on) it sets ONCE at the session start with a
// theme Desktop will paint; the clear happens only when the config goes from on to off; lean_doctor says on / off and isDrawn with the reason.
// Everything is synthetic.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { LOOK, UNPAINTED, lookRows, lookStep, readLook, themeWanted } from './look'
import { checkColors } from './make-colors.js'
import { resetLocks } from './threads'
import { resetViewCache } from './view'

const L = '/h/.lean-agent'
const CONFIG = (theme: unknown) => JSON.stringify({ pane: { theme } })

function engine(on: any, answer: { isDrawn: boolean; reason?: string } = { isDrawn: true }) {
  resetLocks()
  resetViewCache()
  const h = fakeHost(on)
  h.claude.handler = (a: string[]) => (a[0] === 'agents' ? { exitCode: 0, stdout: '[]' } : { exitCode: 0, stdout: '' })
  const sets: any[] = []
  const clears: number[] = []
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('theme.set', (_: any, e: any) => {
    sets.push(e)
    return { value: answer.isDrawn ? { isDrawn: true, requestId: 'r1' } : { isDrawn: false, reason: answer.reason ?? 'no client draws themes' } }
  })
  on('theme.clear', () => {
    clears.push(1)
    return { value: { isDrawn: false, reason: 'cleared' } }
  })
  return { h, sets, clears }
}
const start = ($: any) => $.session.start({ cwd: '/h/lean-agent-desk', surface: 'desktop', isInteractive: true } as any)

test('the palette is one the design system paints: makeColors lists nothing that makes Desktop ignore the theme, and the names are all real', () => {
  expect(UNPAINTED).toEqual([])
  // (checkColors also lists the contrast lines that are under the design system's own bar and still paint: only "won't paint" matters)
  expect(checkColors(LOOK.colors).filter(l => l.startsWith("Desktop won't paint"))).toEqual([])
})

test('off by default: a session start sets nothing, clears nothing and writes no record', { timeoutMs: 20_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  expect(w.sets).toHaveLength(0)
  expect(w.clears).toHaveLength(0)
  expect(await readLook(w.h.host)).toBe(null)
  const rows = await lookRows(w.h.host)
  expect(rows).toHaveLength(1)
  expect(rows[0]!.startsWith('ok   pane theme: off')).toBe(true)
})

test('config pane.theme: on sets the look ONCE at the session start; lean_doctor says on and drawn', { timeoutMs: 20_000 }, async ($, on) => {
  const w = engine(on)
  w.h.files.set(`${L}/config.json`, CONFIG('on'))
  await start($)
  expect(w.sets).toHaveLength(1)
  expect(Object.keys(w.sets[0]!)).toEqual(['colors']) // only colors: no backdrop, sound or style
  expect(w.clears).toHaveLength(0)
  const rec = await readLook(w.h.host)
  expect([rec?.on, rec?.isDrawn]).toEqual([true, true])
  expect(await lookRows(w.h.host)).toEqual(['ok   pane theme: on, drawn'])
})

test('config on, but no client draws themes: the doctor row says isDrawn false with the reason', { timeoutMs: 20_000 }, async ($, on) => {
  const w = engine(on, { isDrawn: false, reason: 'the terminal draws no look' })
  w.h.files.set(`${L}/config.json`, CONFIG(true))
  await start($)
  expect(w.sets).toHaveLength(1)
  expect(await lookRows(w.h.host)).toEqual(['note pane theme: on, not drawn: the terminal draws no look'])
})

test('lookStep: only a config that went from on to off clears; never otherwise', async () => {
  const h = fakeHost(null)
  const calls: string[] = []
  const $ = { theme: { set: async () => (calls.push('set'), { isDrawn: true }), clear: async () => (calls.push('clear'), { isDrawn: false }) } }
  expect(await themeWanted(h.host)).toBe(false)
  expect(await lookStep($, h.host)).toBe('untouched') // never on: nothing, even with another plugin's theme standing
  h.files.set(`${L}/config.json`, CONFIG('off'))
  expect(await lookStep($, h.host)).toBe('untouched')
  expect(calls).toEqual([])
  h.files.set(`${L}/config.json`, CONFIG('on'))
  expect(await lookStep($, h.host)).toBe('set')
  expect(calls).toEqual(['set'])
  h.files.set(`${L}/config.json`, CONFIG('off'))
  expect(await lookStep($, h.host)).toBe('cleared') // on to off: the one clear
  expect(await lookStep($, h.host)).toBe('untouched') // and no second one
  expect(calls).toEqual(['set', 'clear'])
  expect((await readLook(h.host))?.on).toBe(false)
  // a refused set is recorded with its reason, the session goes on
  const bad = { theme: { set: async () => { throw new Error('out of range') }, clear: async () => ({}) } }
  h.files.set(`${L}/config.json`, CONFIG('on'))
  expect(await lookStep(bad, h.host)).toBe('set')
  expect((await lookRows(h.host))[0]).toContain('not drawn: the theme was refused: out of range')
})
