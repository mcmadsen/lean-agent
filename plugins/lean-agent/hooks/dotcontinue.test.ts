// "." to continue after a desk restart (dotcontinue.ts): the marker, the rewrite, the notice texts, and the same through the hooks of a live desk.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { DOT_HINT, DOT_PROMPT, armDot, dotEnabled, dotStep } from './dotcontinue'
import { DESK_RESTARTED, deskHandover, resetDeskCompact, restartDesk } from './deskcompact'
import { resetLocks } from './threads'
import { resetViewCache } from './view'

const L = '/h/.lean-agent'
const typed = (text: string, o: Record<string, unknown> = {}) => ({ text, origin: { kind: 'composer' }, ...o })

test('"." with a pending handover is rewritten once; a second "." is not', async () => {
  const h = fakeHost(null)
  await armDot(h.host, 'S1', 'a desk handover is waiting')
  expect(DOT_PROMPT).toBe('Continue from the handover: read it, resume the open work, and tell me in 3 lines what is open.')
  expect(await dotStep(h.host, typed('.'), 'S1')).toBe(DOT_PROMPT)
  expect(await dotStep(h.host, typed('.'), 'S1')).toBeNull() // consumed: a later "." means nothing special
})

test('"." is trimmed; only exactly "." counts', async () => {
  const h = fakeHost(null)
  await armDot(h.host, 'S1', 'served')
  expect(await dotStep(h.host, typed('  .\n'), 'S1')).toBe(DOT_PROMPT)
  for (const t of ['..', '. .', '.x', '。', '…']) {
    await armDot(h.host, 'S1', 'served')
    expect(await dotStep(h.host, typed(t), 'S1'), t).toBeNull()
  }
})

test('"." without a handover is passed through unchanged (no handover served, or none armed at all)', async () => {
  const h = fakeHost(null)
  expect(await dotStep(h.host, typed('.'), 'S1')).toBeNull() // nothing armed
  await armDot(h.host, 'S1', null) // a desk start with no handover to serve
  expect(await dotStep(h.host, typed('.'), 'S1')).toBeNull()
})

test('another text is unchanged and also consumes the marker', async () => {
  const h = fakeHost(null)
  await armDot(h.host, 'S1', 'served')
  expect(await dotStep(h.host, typed('what is open?'), 'S1')).toBeNull()
  expect(await dotStep(h.host, typed('.'), 'S1')).toBeNull() // the first message was the other text
})

test('the marker belongs to its session; an injected prompt (a relayed report, a wake) and a subagent turn neither rewrite nor consume it', async () => {
  const h = fakeHost(null)
  await armDot(h.host, 'S1', 'served')
  expect(await dotStep(h.host, typed('.'), 'S2')).toBeNull() // another desk session
  expect(await dotStep(h.host, { text: '.', origin: { kind: 'plugin' } }, 'S1')).toBeNull() // a plugin's own prompt.submit
  expect(await dotStep(h.host, { text: '.', isMeta: true }, 'S1')).toBeNull()
  expect(await dotStep(h.host, typed('.', { agentId: 'a1' }), 'S1')).toBeNull()
  expect(await dotStep(h.host, typed('.'), 'S1')).toBe(DOT_PROMPT) // still pending for the user's own first message
  // an engine that stamps no origin: the message counts as the user's
  await armDot(h.host, 'S1', 'served')
  expect(await dotStep(h.host, { text: '.' }, 'S1')).toBe(DOT_PROMPT)
})

test('desk.dotContinue false: "." goes through unchanged (and the marker is consumed)', async () => {
  const h = fakeHost(null)
  h.files.set(`${L}/config.json`, JSON.stringify({ desk: { dotContinue: false } }))
  expect(await dotEnabled(h.host)).toBe(false)
  await armDot(h.host, 'S1', 'served')
  expect(await dotStep(h.host, typed('.'), 'S1')).toBeNull()
  h.files.set(`${L}/config.json`, JSON.stringify({ 'desk.dotContinue': 'false' }))
  expect(await dotEnabled(h.host)).toBe(false)
  h.files.delete(`${L}/config.json`)
  expect(await dotEnabled(h.host)).toBe(true) // the default
})

test('the notices say "type . to continue": the handover first line (full and core) and the restart answer; with the key off they do not', { timeoutMs: 20_000 }, async () => {
  resetDeskCompact()
  const h = fakeHost(null)
  h.clock.t = 10_000_000
  for (const mode of ['core', 'full'] as const) {
    const first = (await deskHandover(h.host, 250_000, [], 'S1', mode)).split('\n')[0]!
    expect(first).toMatch(/^# Desk handover \(written \S+, context 250k.*\) - type \. to continue$/)
    expect(first).toContain(DOT_HINT)
  }
  const r = await restartDesk(h.host, { recent: async () => [], sid: async () => 'S1', open: async () => ({ ok: true, text: 'opened' }) })
  expect(r.ok).toBe(true)
  expect(r.text.startsWith(`${DESK_RESTARTED}. In the new desk type . to continue. `)).toBe(true)
  expect(r.text.slice(0, 200)).toContain('type . to continue') // (the pane cuts its notice at 200 characters)
  expect((h.files.get(`${L}/desk/handover.md`) ?? '').split('\n')[0]).toContain('type . to continue')
  h.files.set(`${L}/config.json`, JSON.stringify({ desk: { dotContinue: false } }))
  expect((await deskHandover(h.host, 250_000, [], 'S1')).split('\n')[0]).not.toContain('type . to continue')
})

// ---- through the hooks of a live desk: the new desk serves the handover at its start, its first typed "." is what the model gets ----
async function liveDesk($: any, on: any, handover: string | null, sid = 'S2') {
  const h = fakeHost(on)
  resetLocks()
  resetViewCache()
  const seen: any[] = []
  on('session.id', () => ({ value: sid }) as any)
  on('prompt.submit', (_: any, e: any) => { seen.push(e); return e })
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  if (handover !== null) h.files.set(`${L}/desk/handover.md`, handover)
  await $.session.start({ cwd: '/h/lean-agent-desk', surface: 'desktop', isInteractive: true } as any)
  return { h, seen }
}
const HANDOVER = '# Desk handover (written 2026-11-01T10:00:00.000Z, context 250k, core) - type . to continue\n\nbody\n\n<!-- lean-agent: written-by-session S1 -->\n'

test('through the hooks: the first "." of a fresh desk that served a handover reaches the model as the fixed instruction; the second does not', { timeoutMs: 20_000 }, async ($, on) => {
  const { seen } = await liveDesk($, on, HANDOVER)
  await $.prompt.submit({ text: '.', origin: { kind: 'composer' } } as any)
  expect(seen.at(-1).text).toBe(DOT_PROMPT)
  await $.prompt.submit({ text: '.', origin: { kind: 'composer' } } as any)
  expect(seen.at(-1).text).toBe('.')
})

test('through the hooks: a first message that is other text goes unchanged and a later "." is unchanged too; no handover served: "." unchanged', { timeoutMs: 20_000 }, async ($, on) => {
  const a = await liveDesk($, on, HANDOVER)
  await $.prompt.submit({ text: 'what is open?', origin: { kind: 'composer' } } as any)
  expect(a.seen.at(-1).text).toBe('what is open?')
  await $.prompt.submit({ text: '.', origin: { kind: 'composer' } } as any)
  expect(a.seen.at(-1).text).toBe('.')
})

test('through the hooks: a desk start with no handover to serve leaves "." alone', { timeoutMs: 20_000 }, async ($, on) => {
  const { seen } = await liveDesk($, on, null)
  await $.prompt.submit({ text: '.', origin: { kind: 'composer' } } as any)
  expect(seen.at(-1).text).toBe('.')
})
