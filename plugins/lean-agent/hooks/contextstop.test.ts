// The hard stop at the context limit (contextstop.ts, autorestart.ts hardStop, register.tsx stopCheck). Synthetic ids, names and paths only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { resetLocks } from './threads'
import { hardStop, threadTurnEnd } from './autorestart'
import { isNotice, notePending, readStop, stopGate, stopLine } from './contextstop'
import { buildSnapshot, snapshotText } from './snapshot'

const S1 = '11111111-2222-3333-4444-555555555555'
const L = '/h/.lean-agent'
const T1 = `${L}/threads/t1`
const INBOX = `${L}/desk/inbox.jsonl`
const rec = (o: Record<string, unknown>) => JSON.stringify(o) + '\n'
const inbox = (h: any) => (h.files.get(INBOX) ?? '').split('\n').filter(Boolean).map((l: string) => JSON.parse(l))
const st = { sid: S1, tokens: 123_000, limit: 120_000 }

function setup() {
  resetLocks()
  const h = fakeHost(null)
  h.clock.t = 1_000_000
  h.files.set(`${T1}/thread.json`, JSON.stringify({ id: 't1', title: 'x', project: 'app', state: 'open', sid: S1, created: 1, lastWake: 0, delivered: 0 }))
  return h
}

test('over the limit: ONE record per session, the snapshot, and never a second record for the same session (also across turn ends and the mid-turn check)', async () => {
  const h = setup()
  expect(await hardStop(h.host, 't1', { sid: S1, tokens: 123_000, limit: 120_000, since: 0 })).toBe('checkpoint') // the tool.call check, mid-turn
  expect((await threadTurnEnd(h.host, 't1', { sid: S1, tokens: 130_000, since: 0 })).action).toBe('none') // the turn end after it
  expect(await hardStop(h.host, 't1', { sid: S1, tokens: 137_000, limit: 120_000, since: 0 })).toBe('none')
  const r = inbox(h)
  expect(r).toHaveLength(1)
  expect(r[0]).toMatchObject({ from: 't1', kind: 'report', state: 'checkpoint', mod: true, text: 'context 123k over the limit 120k: state saved, restart me' })
  expect(JSON.parse(h.files.get(`${T1}/state.json`)!).tokens).toBe(130_000)
  expect(await readStop(h.host, L.replace('/.lean-agent', ''), 't1', S1)).toMatchObject({ tokens: 123_000, limit: 120_000 })
  // a NEW session over the limit is a new stop (and gets its own record)
  expect(await hardStop(h.host, 't1', { sid: 'other', tokens: 125_000, limit: 120_000, since: 0 })).toBe('checkpoint')
  expect(inbox(h)).toHaveLength(2)
})

test('the gate: every tool but lean_report is refused with the one line; a checkpoint notice is accepted once, then answered with the stop line', async () => {
  const h = setup()
  await hardStop(h.host, 't1', { sid: S1, tokens: 123_000, limit: 120_000, since: 0 })
  const line = 'context limit reached (123k of 120k): your state is saved. End your turn now; a fresh session continues from the handover (your reading stays in scratch/notes.md and the scratch files). Do not start workers or report again.'
  expect(stopLine(123_000, 120_000)).toBe(line)
  for (const tool of ['Bash', 'Read', 'Edit', 'Agent', 'mcp__lean-agent__lean_run', 'mcp__lean-agent__lean_ask']) expect(await stopGate(h.host, 't1', st, { tool })).toEqual({ deny: line })
  const rep = { tool: 'mcp__lean-agent__lean_report' }
  expect(await stopGate(h.host, 't1', st, { ...rep, text: 'branch fix-x, 3 commits, tests green', state: 'working' })).toBeNull()
  expect(await stopGate(h.host, 't1', st, { ...rep, text: 'done: branch fix-x pushed', state: 'done' })).toBeNull()
  expect(await stopGate(h.host, 't1', st, { ...rep, text: 'Checkpoint at 123k, context over the limit', state: 'working' })).toBeNull() // once
  expect(await stopGate(h.host, 't1', st, { ...rep, text: 'checkpointed again at 130k', state: 'working' })).toEqual({ deny: line })
  expect(isNotice('context size 96k of 120k', 'working')).toBe(true)
  expect(isNotice('context size 96k of 120k', 'blocked')).toBe(false)
  expect(isNotice('fixed the login redirect; tests pass', 'working')).toBe(false)
})

test('exempt: a session whose last report is a question or blocked may still ask and report a notice; done is not exempt', async () => {
  for (const last of [{ kind: 'ask' }, { kind: 'report', state: 'blocked' }]) {
    const h = setup()
    h.files.set(INBOX, rec({ ts: 500, from: 't1', text: 'which db?', ...last }))
    await hardStop(h.host, 't1', { sid: S1, tokens: 123_000, limit: 120_000, since: 400 })
    expect(inbox(h)).toHaveLength(1) // (stopped, but no restart record: the next message starts fresh)
    expect(await stopGate(h.host, 't1', st, { tool: 'mcp__lean-agent__lean_ask' })).toBeNull()
    for (let i = 0; i < 2; i++) expect(await stopGate(h.host, 't1', st, { tool: 'mcp__lean-agent__lean_report', text: 'checkpoint: context over the limit', state: 'working' })).toBeNull()
    expect(await stopGate(h.host, 't1', st, { tool: 'Bash' })).toMatchObject({ deny: expect.stringContaining('context limit reached') })
  }
  const d = setup()
  d.files.set(INBOX, rec({ ts: 500, from: 't1', kind: 'report', state: 'done', text: 'x' }))
  expect(await stopGate(d.host, 't1', st, { tool: 'mcp__lean-agent__lean_ask' })).toMatchObject({ deny: expect.any(String) })
})

test('workers that finish after the stop: their results are kept for the next session (pending results in the snapshot and the handover text)', async () => {
  const h = setup()
  await hardStop(h.host, 't1', { sid: S1, tokens: 123_000, limit: 120_000, since: 0 })
  expect(await notePending(h.host, 't1', S1, { agent: 'worker-haiku', text: 'edited a.ts, tests pass' })).toBe(true)
  expect(await notePending(h.host, 't1', 'other', { agent: 'worker-haiku', text: 'x' })).toBe(false)
  await threadTurnEnd(h.host, 't1', { sid: S1, tokens: 124_000, since: 0 })
  const snap = JSON.parse(h.files.get(`${T1}/state.json`)!)
  expect(snap.pending).toEqual([{ agent: 'worker-haiku', text: 'edited a.ts, tests pass' }])
  expect(snapshotText(await buildSnapshot(h.host, '/h', 't1', { pending: snap.pending }), 1_000_000)).toContain('pending results')
})

// ---- the thread's own mod ----
function modSession($: any, on: any, usage: { tokens: number }) {
  const h = fakeHost(on)
  on('clock.after', () => new Promise(() => {}))
  resetLocks()
  h.files.set(`/p/templates/thread.md`, '# {{id}}')
  h.files.set(`/p/templates/front-desk.md`, 'desk {{lean}}')
  h.files.set(`${T1}/thread.json`, JSON.stringify({ id: 't1', title: 'x', project: '', state: 'open', sid: 'sess-x', created: 1, lastWake: 0, delivered: 0 }))
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('clock.every', (() => ({ value: { cancel() {} } })) as any)
  on('session.cwd', () => ({ value: T1 }))
  on('session.root', () => ({ value: T1 }))
  on('session.id', () => ({ value: 'sess-x' }))
  on('session.usage', () => ({ value: { context: { tokens: usage.tokens, window: 200_000, percent: 60 }, rateLimits: [] } }) as any)
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.measure', (_: any, e: any) => ({ changed: e.changed }))
  on('tool.call', () => ({ result: 'ran' }) as any) // the engine's own tool, beneath the mod
  return h
}
const refused = async (h: any) => (h.files.get(`${L}/refusals.jsonl`) ?? '').split('\n').filter(Boolean).map((l: string) => JSON.parse(l)).filter((r: any) => r.rule === 'context-limit')

test('mod: a turn end over the limit stops the thread: one record, Bash and Agent refused (refusal rule context-limit), lean_report still goes through', { timeoutMs: 20_000 }, async ($, on) => {
  const h = modSession($, on, { tokens: 123_000 })
  await $.session.start({ cwd: T1, surface: 'desktop', isInteractive: true } as any)
  await $.session.measure({ context: { tokens: 123_000, window: 200_000, percent: 61 }, rateLimits: [], changed: ['context'] } as any)
  expect(inbox(h)).toHaveLength(1)
  const b: any = await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  expect(JSON.stringify(b)).toContain('context limit reached (123k of 120k)')
  expect(JSON.stringify(await $.tool.call({ tool: 'Agent', subagent_type: 'lean-agent:worker-haiku', prompt: 'job: edit\nx' } as any))).toContain('context limit reached')
  const r: any = await $.tool.call({ tool: 'mcp__lean-agent__lean_report', text: 'branch fix-x, tests green, next: docs', state: 'working' } as any)
  expect(JSON.stringify(r)).toContain('reported to the desk')
  expect((await refused(h)).length).toBe(2)
  expect(inbox(h).filter((x: any) => x.mod)).toHaveLength(1)
})

test('mod: a long turn is checked every 10 tool calls through session.usage(), and the stop applies from then on', { timeoutMs: 20_000 }, async ($, on) => {
  const usage = { tokens: 90_000 }
  const h = modSession($, on, usage)
  await $.session.start({ cwd: T1, surface: 'desktop', isInteractive: true } as any)
  for (let i = 0; i < 9; i++) expect(JSON.stringify(await $.tool.call({ tool: 'Read', file_path: '/x/a.ts' } as any))).not.toContain('context limit')
  usage.tokens = 121_000
  expect(JSON.stringify(await $.tool.call({ tool: 'Read', file_path: '/x/a.ts' } as any))).toContain('context limit reached (121k of 120k)') // the 10th call
  expect(JSON.stringify(await $.tool.call({ tool: 'Read', file_path: '/x/b.ts' } as any))).toContain('context limit reached')
  expect(inbox(h)).toHaveLength(1)
  expect(inbox(h)[0].text).toBe('context 121k over the limit 120k: state saved, restart me')
})

test('hard stop: the 2nd, 3rd... turn end over the limit writes no further record, and every tool call but lean_report is refused each time', async () => {
  for (const sid of [S1, '']) {
    const h = setup()
    let action = ''
    for (const tokens of [121_000, 140_000, 175_000, 202_000]) {
      const out = await threadTurnEnd(h.host, 't1', { sid, tokens, since: 0 })
      expect(out.stop).toEqual({ tokens, limit: 120_000 })
      if (!action) action = out.action
      else expect(out.action).toBe('none')
      const gate = { sid: S1, tokens, limit: 120_000 }
      for (const tool of ['Bash', 'Read', 'Write', 'Edit', 'Agent', 'mcp__lean-agent__lean_run', 'mcp__lean-agent__lean_thread', 'mcp__lean-agent__lean_ask']) expect(await stopGate(h.host, 't1', gate, { tool })).toEqual({ deny: stopLine(tokens, 120_000) })
      expect(await stopGate(h.host, 't1', gate, { tool: 'mcp__lean-agent__lean_report', text: 'branch fix-x, 3 commits, tests green', state: 'working' })).toBeNull()
    }
    expect(action).toBe('checkpoint')
    expect(inbox(h)).toHaveLength(1) // one record for four turn ends
    expect(inbox(h)[0].text).toBe('context 121k over the limit 120k: state saved, restart me')
  }
})
