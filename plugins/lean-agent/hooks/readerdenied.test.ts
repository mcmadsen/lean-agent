// A reader the permission check denied (orchestrate.ts, register.tsx noteDenied): the engine's reason category, ONE retry with a narrower brief,
// then counted slices of at most 200 lines; the 11th slice says it is the most expensive way. Through the engine, synthetic paths.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { resetLocks } from './threads'
import { SLICES_NOTE, orchReset, readerCategory, readerDeniedHint } from './orchestrate'

const READER = 'lean-agent:reader-haiku'
const WORKER = 'lean-agent:worker-haiku'
const REASON = 'Permission denied by the auto mode classifier: [Destructive or Unwanted Actions]'

async function session($: any, on: any) {
  orchReset()
  const h = fakeHost(on, { orchestrate: true })
  on('classic.SubagentStop', () => ({}))
  on('classic.PermissionDenied', () => ({}))
  on('classic.PostToolUseFailure', () => ({}))
  on('tool.call', () => ({ result: 'ok' }) as any)
  on('clock.after', () => new Promise(() => {})) // (bounded() races its engine calls against this timer)
  resetLocks()
  h.files.set('/real/w/keep', 'x')
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', title: 'x', project: 'proj', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/h/.lean-agent/threads/t1', surface: 'desktop', isInteractive: true } as any)
  return h
}
const denied = (id: string, type: string, prompt: string, reason = REASON) => ({ tool_name: 'Agent', tool_use_id: id, reason, tool_input: { subagent_type: type, prompt }, session_id: 's', transcript_path: '', cwd: '/h/.lean-agent/threads/t1' }) as any
const read = (n: number, limit: number | null = 100) => ({ tool: 'Read', file_path: `/real/w/long${n}.md`, ...(limit === null ? {} : { limit }) }) as any
const ctx = (r: any) => (r?.context ?? []).join('\n')
const rows = (h: any) => (h.files.get('/h/.lean-agent/refusals.jsonl') ?? '').split('\n').filter(Boolean).map((l: string) => JSON.parse(l))

test('the reason category is the one the engine printed: the [bracket], else its first words', () => {
  expect(readerCategory(REASON)).toBe('Destructive or Unwanted Actions')
  expect(readerCategory('blocked by a rule about reads outside the project, with a very long explanation that goes on and on and on and on and on')).toHaveLength(80)
  expect(readerCategory(undefined)).toBe('no reason given')
})

test('through the engine: a denied reader gives the category and the narrower-retry hint once, on the next tool result; the retry is not refused', { timeoutMs: 20_000 }, async ($, on) => {
  const h = await session($, on)
  const r: any = await $.classic.PermissionDenied(denied('u1', READER, 'job: lookup\nwhere is x'))
  expect(r?.retry).toBeUndefined()
  const a: any = await $.tool.call({ tool: 'Bash', command: 'git -C /real/w status' } as any)
  expect(ctx(a)).toContain(readerDeniedHint('Destructive or Unwanted Actions'))
  expect(ctx(a)).toContain('retry once with one file, one question')
  expect(ctx(a)).toContain('read in slices of 200 lines and write each finding to scratch/notes.md')
  expect(ctx(await $.tool.call({ tool: 'Bash', command: 'git -C /real/w log -1' } as any))).not.toContain('retry once') // said once
  const again: any = await $.tool.call({ tool: 'Agent', subagent_type: READER, prompt: 'job: lookup\none file, one question' } as any)
  expect(again.deny).toBeUndefined() // the narrower retry runs
  expect(rows(h).filter((x: any) => x.rule === 'delegation-denied').length).toBe(1)
  expect(rows(h)[0].text).toContain('reader call')
})

test('through the engine: a lookup job given to a worker type counts as a reader; a failed Agent result that says so counts too', { timeoutMs: 20_000 }, async ($, on) => {
  await session($, on)
  await $.classic.PostToolUseFailure({ ...denied('u2', WORKER, 'job: lookup\nread the history doc'), error: 'denied by the auto mode classifier: [Excessive Resource Use]' })
  const a: any = await $.tool.call({ tool: 'Bash', command: 'git -C /real/w status' } as any)
  expect(ctx(a)).toContain('the reader was denied (Excessive Resource Use)')
})

test('through the engine: the fallback reads are slices of <= 200 lines, counted; no cap per turn after a denial; the 11th carries the warning once', { timeoutMs: 20_000 }, async ($, on) => {
  await session($, on)
  for (let i = 0; i < 3; i++) expect(((await $.tool.call(read(i))) as any).deny).toBeUndefined()
  expect(((await $.tool.call(read(3))) as any).deny).toContain('direct reads per turn used') // before a denial: the cap holds
  await $.classic.PermissionDenied(denied('u3', READER, 'job: lookup\nwhere is y'))
  expect(((await $.tool.call(read(4, 400))) as any).deny).toContain('limit <= 200') // never a whole long file
  expect(((await $.tool.call(read(5, null))) as any).deny).toContain('limit <= 200')
  const notes: string[] = []
  for (let i = 0; i < 12; i++) {
    const r: any = await $.tool.call(read(10 + i))
    expect(r.deny).toBeUndefined()
    if (ctx(r).includes(SLICES_NOTE)) notes.push(`slice ${i + 1}`)
  }
  expect(notes).toEqual(['slice 11']) // after 10 slices the next one says it, once
  expect(((await $.tool.call({ tool: 'Edit', file_path: '/real/w/a.ts' } as any)) as any).deny).toContain('one step for a small worker') // a denied reader opens no edit
})

test('through the engine: a denied EDIT worker keeps its own hint ("do the step yourself") and no reader hint', { timeoutMs: 20_000 }, async ($, on) => {
  await session($, on)
  await $.classic.PermissionDenied(denied('u4', WORKER, 'job: edit\nedit /real/w/c.ts please'))
  const a: any = await $.tool.call({ tool: 'Edit', file_path: '/real/w/c.ts' } as any)
  expect(ctx(a)).toContain('do the step yourself')
  expect(ctx(a)).not.toContain('retry ONCE')
})
