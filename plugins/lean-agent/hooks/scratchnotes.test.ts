// Notes before the cap (scratchnotes.ts): the warn line once, the snapshot's and the handover's scratch lists, the hard stop text.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { resetLocks } from './threads'
import { buildSnapshot, snapshotText } from './snapshot'
import { buildHandover } from './handover'
import { stopLine } from './contextstop'
import { HANDOVER_RULE, listText, scratchList, scratchNotes, takeWarn, warnLine, warnReset } from './scratchnotes'

const L = '/h/.lean-agent'
const T1 = `${L}/threads/t1`
const THREAD = { id: 't1', title: 'plan the docs', project: 'app', state: 'open', sid: 's1', created: 1, lastWake: 0, delivered: 0 }
const LIM = { limit: 120_000, warn: 100_000 }

function setup() {
  const h = fakeHost(null)
  h.clock.t = 1_000_000
  h.files.set(`${T1}/thread.json`, JSON.stringify(THREAD))
  h.files.set(`${T1}/brief.md`, 'write the plan\n')
  h.files.set(`${T1}/scratch/notes.md`, '## living doc\nsays: the plan has 4 phases\nstill need: phase 3 owner\n')
  h.files.set(`${T1}/scratch/lookup-a1b2c3.md`, '\n\n# Report 7: the build order\nlong text '.padEnd(2400, 'x'))
  h.files.set(`${T1}/scratch/sub/deep.md`, 'a folder is not listed')
  h.git.handler = () => ({ exitCode: 1, stdout: '' })
  return h
}

test('the warn line: at the warn level ONE line per session, with the numbers and the file; under the level or a second time nothing', () => {
  warnReset()
  expect(takeWarn('s1', 100_000, LIM)).toBeNull() // at the level is not over it
  expect(takeWarn('s1', 101_000, LIM)).toBe('context 101k of 120k: write what you have learned so far to scratch/notes.md now (one short section per source: what it says, what you still need); a restart resumes from it and the scratch files replace re-reading the sources')
  expect(takeWarn('s1', 110_000, LIM)).toBeNull()
  expect(takeWarn('s2', 99_000, LIM)).toBeNull()
  expect(takeWarn('s2', 105_000, LIM)).toBe(warnLine(105_000, 120_000))
  expect(takeWarn('', 110_000, LIM)).toBeNull()
  expect(takeWarn('s3', null, LIM)).toBeNull()
})

test('the scratch folder: files only, notes.md first, size and first non-empty line; the handover rule says not to re-read', async () => {
  const h = setup()
  const list = await scratchList(h.host, T1)
  expect(list.map(f => f.name)).toEqual(['notes.md', 'lookup-a1b2c3.md'])
  expect(list[0]).toMatchObject({ first: '## living doc' })
  expect(list[1]).toMatchObject({ size: 2400, first: '# Report 7: the build order' })
  expect(listText(list)).toBe('- notes.md (68 B): ## living doc\n- lookup-a1b2c3.md (2.4 kB): # Report 7: the build order')
  expect(await scratchNotes(h.host, T1)).toContain('phase 3 owner')
  expect(await scratchList(h.host, `${L}/threads/t9`)).toEqual([])
  expect(HANDOVER_RULE).toContain('do NOT re-read the sources they cover')
})

test('the state snapshot lists the scratch files and the handover carries scratch/notes.md plus the list, with the instruction', async () => {
  const h = setup()
  const snap = await buildSnapshot(h.host, '/h', 't1', { sid: 's1', tokens: 98_000 })
  expect(snap.scratch?.map(f => f.name)).toEqual(['notes.md', 'lookup-a1b2c3.md'])
  expect(snapshotText(snap, 1_000_000)).toContain('scratch files (threads/t1/scratch; they replace re-reading their sources)')
  const ho = await buildHandover(h.host, '/h', THREAD as any, 'Because.', [])
  expect(ho.prompt).toContain(`Your earlier reading is kept: ${HANDOVER_RULE}.`)
  expect(ho.prompt).toContain('## Your scratch notes (end of scratch/notes.md)\n## living doc')
  expect(ho.prompt).toContain('## Scratch files (name, size, first line)\n- notes.md (68 B): ## living doc')
  expect(ho.prompt.indexOf('Your earlier reading is kept')).toBeLessThan(ho.prompt.indexOf('## Your scratch notes'))
  // no scratch folder: nothing of it in the prompt
  const none = fakeHost(null)
  none.files.set(`${T1}/thread.json`, JSON.stringify(THREAD))
  none.git.handler = () => ({ exitCode: 1, stdout: '' })
  expect((await buildHandover(none.host, '/h', THREAD as any, 'Because.', [])).prompt).not.toContain('scratch')
})

test('the handover budget cuts the scratch list before the notes, and the notes before the brief', async () => {
  const h = setup()
  for (let i = 0; i < 20; i++) h.files.set(`${T1}/scratch/r${String(i).padStart(2, '0')}.md`, `# summary ${i} ${'y'.repeat(120)}`)
  h.files.set(`${L}/config.json`, JSON.stringify({ handoverTokens: 500 }))
  const ho = await buildHandover(h.host, '/h', THREAD as any, 'Because.', [])
  const parts = ho.parts!
  expect(parts.find(p => p.name === 'scratchlist')?.cut).toBe(true)
  expect(parts.find(p => p.name === 'scratchnotes')?.body).toContain('phase 3 owner')
  expect(parts.find(p => p.name === 'brief')?.cut).toBeFalsy()
})

test('the hard stop says the same in a few words', () => {
  expect(stopLine(123_000, 120_000)).toContain('your reading stays in scratch/notes.md and the scratch files')
})

// ---- through the engine: the line is in the next tool result, once -------------------------------------------------------------------
test('through the engine: a tool result of a thread at the warn level carries the line once', { timeoutMs: 20_000 }, async ($, on) => {
  warnReset()
  resetLocks()
  const h = fakeHost(on, { orchestrate: true })
  let tokens = 60_000
  on('tool.call', () => ({ result: 'ok' }) as any)
  on('clock.after', () => new Promise(() => {})) // (bounded() races its engine calls against this timer)
  on('session.usage', (() => ({ value: { context: { tokens, window: 200_000, percent: 50 }, rateLimits: [] } })) as any)
  on('session.id', () => ({ value: 'sess-x' }))
  h.files.set(`${T1}/thread.json`, JSON.stringify({ ...THREAD, sid: 'sess-x' }))
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: T1, surface: 'desktop', isInteractive: true } as any)
  const ctx = async () => ((await $.tool.call({ tool: 'mcp__lean-agent__lean_run', command: 'echo hi' } as any)) as any).context?.join('\n') ?? ''
  expect(await ctx()).not.toContain('scratch/notes.md')
  tokens = 104_000
  expect(await ctx()).toContain('context 104k of 120k: write what you have learned so far to scratch/notes.md now')
  expect(await ctx()).not.toContain('scratch/notes.md') // once per session
})
