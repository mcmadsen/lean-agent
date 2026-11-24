// The automatic desk restart (deskcompact.ts autoRestartDesk, deskauto.ts), on a fake host: the four reasons, each blocking condition, the loop guard,
// `open -g` on macOS, the toast, the new desk's first notice (the same as a button-started desk's plus one line), and the old desk retiring.
// The live Claude app cannot be started in the spec container: the real opener and the app are NOT exercised here. Synthetic data only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { AUTO_GAP_MS, GUARD_NOTICE, deskStartLines, handoverDigest, isRetiredNow, retiredInfo, retiredLine } from './deskauto'
import { autoRestartDesk, resetDeskCompact, restartDesk, serveHandover, servedBody } from './deskcompact'
import { notifyTick } from './notify'
import { oldDeskStep, resetOldDesk } from './olddesk'
import { newSessionLink, openDesk, openerArgv } from './setup'
import { resetViewCache } from './view'

const L = '/h/.lean-agent'
const DESK = '/h/lean-agent-desk'
const LINK = newSessionLink(DESK)
const SKEW = 'lean-agent code 1.0.27 is running but 1.0.28 is installed: start a new session (threads: close and Start)'
const MIN = 60_000

function world() {
  resetDeskCompact()
  resetOldDesk()
  const h = fakeHost(null)
  h.clock.t = 50_000_000
  h.files.set('/h/.lean-agent/config.json', JSON.stringify({ desk: { contextLimit: 100_000 } })) // (the default is 60k since 1.0.31; these cases are written against 100k)
  h.files.set(`${DESK}/CLAUDE.md`, 'desk')
  h.files.set(`${L}/desk.json`, JSON.stringify({ sid: 'desk-a' }))
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', title: 'parser work', project: 'demo', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  const seen = { restarts: 0, toasts: [] as string[], status: [] as string[] }
  const restart = async () => {
    seen.restarts++
    return { ok: true, text: 'opened' }
  }
  const base = (o: Record<string, unknown> = {}) => ({ tokens: 10_000, sid: 'desk-a', busy: false, inApp: true, restart, status: (t: string) => void seen.status.push(t), notify: (t: string) => void seen.toasts.push(t), ...o })
  const run = (o: Record<string, unknown> = {}) => autoRestartDesk(h.host, base(o) as any)
  return { h, seen, run }
}
const startRec = (h: any) => JSON.parse(h.files.get(`${L}/desk/auto-started.json`) ?? '{}')
const modelState = (session: string, tries: number) => JSON.stringify({ running: 'claude-opus-x', pin: { model: 'sonnet', effort: 'high' }, at: 1, why: 'no Model row', session, tries })

test('the opener on macOS opens the link without the focus (open -g); the other systems keep their argv', async () => {
  expect(openerArgv('mac', LINK, true)).toEqual(['open', '-g', LINK])
  expect(openerArgv('mac', LINK)).toEqual(['open', LINK])
  expect(openerArgv('linux', LINK, true)).toEqual(['xdg-open', LINK])
  expect(openerArgv('windows', LINK, true)).toEqual(['rundll32', 'url.dll,FileProtocolHandler', LINK])
  const { h } = world()
  expect((await openDesk(h.host, 'desktop', true)).ok).toBe(true)
  expect(h.calls.filter(c => c.argv[0] === 'open').pop()!.argv).toEqual(['open', '-g', LINK])
  expect((await openDesk(h.host, 'desktop')).ok).toBe(true) // the button: the app comes to the front
  expect(h.calls.filter(c => c.argv[0] === 'open').pop()!.argv).toEqual(['open', LINK])
})

test('reason: the context at 95% of its limit or over (default 100k); below it nothing; the toast says what and why', async () => {
  const { run, seen } = world()
  expect(await run({ tokens: 94_999 })).toBe('none')
  expect(await run({ tokens: 95_000 })).toBe('restarted')
  expect(seen.restarts).toBe(1)
  expect(seen.toasts).toEqual(['desk restarted automatically: context 95k'])
})

test('reason: lean-agent was updated and this desk runs the older code; the same update does not restart twice', async () => {
  const { h, run, seen } = world()
  expect(await run({ skew: null })).toBe('none')
  expect(await run({ skew: SKEW })).toBe('restarted')
  expect(seen.toasts).toEqual(['desk restarted automatically: lean-agent updated: running 1.0.27, installed 1.0.28'])
  expect(startRec(h).reason).toBe('lean-agent updated: running 1.0.27, installed 1.0.28')
  h.clock.t += 31 * MIN
  resetDeskCompact()
  expect(await run({ skew: SKEW })).toBe('none') // the new desk still reports the same skew: a loop, only the button
  expect(await run({ skew: SKEW.replace('1.0.28', '1.0.29') })).toBe('restarted') // a newer install is a new reason
})

test('reason: the model pin failed twice in this session (not once, not another session, not again for the same cause)', async () => {
  const { h, run, seen } = world()
  h.files.set(`${L}/desk/model.json`, modelState('desk-a', 1))
  expect(await run()).toBe('none')
  h.files.set(`${L}/desk/model.json`, modelState('desk-z', 5))
  expect(await run()).toBe('none')
  h.files.set(`${L}/desk/model.json`, modelState('desk-a', 2))
  expect(await run()).toBe('restarted')
  expect(seen.toasts[0]).toBe('desk restarted automatically: the model pin could not be applied (2 tries)')
  h.clock.t += 31 * MIN
  resetDeskCompact()
  expect(await run()).toBe('none') // the new desk would fail the same way
})

test('reason: the desk lost its tools (the mod\'s send was refused: no SendMessage tool)', async () => {
  const { run, seen } = world()
  expect(await run({ toolsLost: null })).toBe('none')
  expect(await run({ toolsLost: 'this session has no SendMessage tool (messaging between sessions and agents is not on here)' })).toBe('restarted')
  expect(seen.toasts[0]).toMatch(/^desk restarted automatically: the desk lost its tools \(this session has no SendMessage tool/)
})

test('blocked: config off, a turn running, the desk not in the app, a thread question open (not over 120%), a newer desk; each leaves the desk alone', async () => {
  const { h, run, seen } = world()
  const over = { tokens: 110_000 }
  expect(await run({ ...over, busy: true })).toBe('busy')
  expect(await run({ ...over, inApp: false })).toBe('app')
  h.files.set(`${L}/questions.jsonl`, `${JSON.stringify({ from: 't1', question: 'which db?' })}\n`)
  expect(await run(over)).toBe('question')
  expect(await run({ skew: SKEW })).toBe('question') // (any reason waits for the user's open question)
  h.files.set(`${L}/desk.json`, JSON.stringify({ sid: 'desk-b' }))
  expect(await run({ tokens: 150_000 })).toBe('retired') // an old desk never starts another
  h.files.set(`${L}/desk.json`, JSON.stringify({ sid: 'desk-a' }))
  h.files.set(`${L}/config.json`, JSON.stringify({ desk: { autoRestart: false } }))
  expect(await run({ tokens: 150_000 })).toBe('off')
  expect(seen.restarts).toBe(0)
  h.files.set(`${L}/config.json`, '{}')
  expect(await run({ tokens: 120_000 })).toBe('restarted') // the handover carries the question: far over the limit it goes on
  expect(seen.restarts).toBe(1)
})

test('the loop guard: 30 minutes between automatic restarts and fewer than desk.autoRestartPerDay (default 12) in 24 h; then ONE notice and the amber line', async () => {
  const { h, run, seen } = world()
  const over = { tokens: 100_000 }
  expect(await run(over)).toBe('restarted')
  h.clock.t += 10 * MIN
  resetDeskCompact()
  expect(await run(over)).toBe('guard')
  expect(seen.status.at(-1)).toMatch(/not automatic: the last automatic desk restart was 10 min ago/)
  const notice = `${L}/notices/${GUARD_NOTICE}.txt`
  expect(h.files.get(notice)).toMatch(/context 100k.*not automatically/)
  h.files.delete(notice)
  expect(await run(over)).toBe('guard')
  expect(h.files.has(notice)).toBe(false) // said once for this restart: not again
  expect(seen.status).toHaveLength(2) // (the amber line stays put)
  expect(seen.restarts).toBe(1)
  // 12 in a day (the default), 31 minutes apart: the 13th waits for the button; the notice is gone after a restart that went
  for (let n = 2; n <= 12; n++) {
    h.clock.t += AUTO_GAP_MS + MIN
    resetDeskCompact()
    expect(await run(over)).toBe('restarted')
  }
  expect(h.files.has(notice)).toBe(false)
  h.clock.t += AUTO_GAP_MS + MIN
  resetDeskCompact()
  expect(await run(over)).toBe('guard')
  expect(seen.status.at(-1)).toMatch(/12 automatic desk restarts in the last 24 h/)
  expect(h.files.has(notice)).toBe(true)
  expect(seen.restarts).toBe(12)
  h.clock.t += 24 * 3_600_000
  resetDeskCompact()
  expect(await run(over)).toBe('restarted') // a day later the count is down
})

test('desk.autoRestartPerDay sets the daily cap (the 30-minute gap stays); a bad value falls back to 12', async () => {
  const { h, run, seen } = world()
  h.files.set('/h/.lean-agent/config.json', JSON.stringify({ desk: { contextLimit: 100_000, autoRestartPerDay: 2 } }))
  const over = { tokens: 100_000 }
  expect(await run(over)).toBe('restarted')
  h.clock.t += AUTO_GAP_MS + MIN
  resetDeskCompact()
  expect(await run(over)).toBe('restarted')
  h.clock.t += AUTO_GAP_MS + MIN
  resetDeskCompact()
  expect(await run(over)).toBe('guard')
  expect(seen.status.at(-1)).toMatch(/2 automatic desk restarts in the last 24 h \(the limit is 2/)
  h.files.set('/h/.lean-agent/config.json', JSON.stringify({ desk: { contextLimit: 100_000, autoRestartPerDay: 'many' } }))
  resetDeskCompact()
  expect(await run(over)).toBe('restarted') // the default 12 applies again
})

test('a restart that fails (the opener) is a notice, writes no record for the new desk and is not counted; once per desk session otherwise', async () => {
  const { h, run, seen } = world()
  expect(await run({ tokens: 120_000, restart: async () => ({ ok: false, text: 'the Claude app is not running' }) })).toBe('failed')
  expect(h.files.get(`${L}/notices/desk-autorestart.txt`)).toMatch(/could not open a new one by itself: the Claude app is not running/)
  expect(startRec(h).cancelled).toBe(true)
  expect(await run({ tokens: 120_000 })).toBe('restarted') // (no guard: the failed one did not count)
  expect(await run({ tokens: 120_000 })).toBe('already')
  expect(seen.restarts).toBe(1)
})

// ---- the real restart path: handover, `open -g`, old-desk.json, and the new desk's start --------------------------------------------------
async function viaScript(h: any, o: Record<string, unknown> = {}) {
  return autoRestartDesk(h.host, {
    tokens: 104_000,
    sid: 'desk-a',
    busy: false,
    inApp: true,
    restart: () => restartDesk(h.host, { recent: async () => ['keep the pane short'], sid: async () => 'desk-a', open: () => openDesk(h.host, 'desktop', true) }),
    ...o,
  } as any)
}
async function newDeskStart(h: any, sid: string) {
  h.files.set(`${L}/desk.json`, JSON.stringify({ sid }))
  const served = await serveHandover(h.host, sid)
  const old = await oldDeskStep(h.host, sid, 'start').catch(() => null)
  return deskStartLines(h.host, sid, { served, body: servedBody(), oldDesk: old })
}

test('the script restart writes the handover, opens the link with open -g, records the old desk; the new desk\'s start says when and why and lists what the handover holds', async () => {
  const { h } = world()
  h.files.set(`${L}/questions.jsonl`, `${JSON.stringify({ from: 't1', question: 'which database should the parser use?' })}\n`)
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  expect(await viaScript(h, { tokens: 130_000 })).toBe('restarted')
  expect(h.calls.filter(c => c.argv[0] === 'open').map(c => c.argv)).toEqual([['open', '-g', LINK]])
  expect(h.files.get(`${L}/desk/handover.md`)).toMatch(/written-by-session desk-a -->\s*$/)
  expect(JSON.parse(h.files.get(`${L}/desk/old-desk.json`)!).sid).toBe('desk-a')
  const lines = await newDeskStart(h, 'desk-b')
  expect(lines[0]).toMatch(/^a desk handover \(written .*\) from an earlier desk session is waiting in /)
  expect(lines.find(l => /started automatically/.test(l))).toMatch(/^this desk was started automatically at \d\d:\d\d UTC because context 130k; the handover was read$/)
  const digest = lines.find(l => /^the handover lists/.test(l))!
  expect(digest).toContain('1 open question(s)')
  expect(digest).toContain('t1: which database should the parser use?')
  expect(digest).toContain('1 open thread(s)')
  expect(lines.some(l => /old desk session .* archive it in the Claude app/.test(l))).toBe(true)
  expect(JSON.parse(h.files.get(`${L}/desk.json`)!).startedSid).toBe('desk-b') // the old desk's one line can say when
  // a later start of the same desk (a resume) says nothing about it again
  expect((await newDeskStart(h, 'desk-b')).some(l => /started automatically/.test(l))).toBe(false)
})

test('a desk started by the button and one started by the script behave the same at start (the script adds only its one line)', async () => {
  const a = world()
  a.h.files.set(`${L}/questions.jsonl`, `${JSON.stringify({ from: 't1', question: 'which database should the parser use?' })}\n`)
  a.h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  expect(await viaScript(a.h, { tokens: 130_000 })).toBe('restarted') // (a thread question is open: over 120% the handover carries it)
  const auto = await newDeskStart(a.h, 'desk-b')
  const b = world()
  b.h.files.set(`${L}/questions.jsonl`, `${JSON.stringify({ from: 't1', question: 'which database should the parser use?' })}\n`)
  b.h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  expect((await restartDesk(b.h.host, { recent: async () => ['keep the pane short'], sid: async () => 'desk-a', open: () => openDesk(b.h.host, 'desktop') })).ok).toBe(true) // the button
  expect(b.h.calls.filter(c => c.argv[0] === 'open').map(c => c.argv)).toEqual([['open', LINK]]) // (the button's window comes to the front)
  const button = await newDeskStart(b.h, 'desk-b')
  expect(button.some(l => /started automatically/.test(l))).toBe(false)
  expect(auto.filter(l => !/started automatically/.test(l))).toEqual(button)
  expect(handoverDigest('# x\n\n## Unanswered thread questions\nnone\n\n## Open threads (x)\n| id |\n|---|\n| t1 | a | b | open | c | d |\n')).toBe('the handover lists 1 open thread(s)')
})

test('the old desk retires itself: desk.json names another session; its prompt line, timers\' check and toasts', async () => {
  const { h } = world()
  resetViewCache()
  h.claude.handler = (a: string[]) => ({ exitCode: 0, stdout: a[0] === 'agents' ? '[]' : '' })
  expect(await retiredInfo(h.host, 'desk-a')).toBeNull() // the current desk
  expect(await retiredInfo(h.host, '')).toBeNull() // unknown id: never retired by guess
  h.files.set(`${L}/desk.json`, JSON.stringify({ sid: 'desk-b', startedSid: 'desk-b', startedAt: Date.parse('2026-03-02T09:41:00Z') }))
  const info = await retiredInfo(h.host, 'desk-a')
  expect(info).toEqual({ startedAt: Date.parse('2026-03-02T09:41:00Z') })
  expect(isRetiredNow()).toBe(true)
  expect(retiredLine(info!)).toContain('"this desk was replaced by a newer one (started 09:41 UTC): use the newer session"')
  expect(retiredLine({ startedAt: 0 })).toContain('(started earlier)')
  // toasts of the budget alerts and reports are acts too: none, and nothing written, while retired
  expect(await notifyTick(h.host, () => undefined)).toEqual([])
  expect(h.files.has(`${L}/desk/notify-seen.json`)).toBe(false)
  expect(await retiredInfo(h.host, 'desk-b')).toBeNull()
  expect(isRetiredNow()).toBe(false)
  await notifyTick(h.host, () => undefined)
  expect(h.files.has(`${L}/desk/notify-seen.json`)).toBe(true)
})
