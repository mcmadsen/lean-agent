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
const OLD_LIMITS = { threadTokens: 120_000, threads: { softCheckpointTokens: 80_000 } }
const THREAD = { id: 't1', title: 'plan the docs', project: 'app', state: 'open', sid: 's1', created: 1, lastWake: 0, delivered: 0 }
const LIM = { limit: 120_000, warn: 100_000 }

function setup() {
  const h = fakeHost(null)
  h.clock.t = 1_000_000
  h.files.set(`${L}/config.json`, '{"handover":{"mode":"full"}}') // (these specs read the full prompt; core is the default since 1.0.27)
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
  expect(takeWarn('s1', 101_000, LIM)).toBe('ctx 101k of 120k (soft limit 100k): at your next natural boundary (a finished step, before a new area) write what you learned to scratch/notes.md, then call lean_run checkpoint {next: <the next step>}: the mod restarts you at once and you continue with it. Never end your turn asking the desk or the user for a restart') // 1.0.29: the line names the checkpoint call; 1.0.31: and the soft limit and the natural boundary
  expect(takeWarn('s1', 107_000, LIM)).toBeNull() // under 90% of the limit (108k)
  expect(takeWarn('s1', 110_000, LIM)).toBe(warnLine(110_000, 120_000, 100_000)) // 1.0.27: and once more at 90%
  expect(takeWarn('s1', 115_000, LIM)).toBeNull()
  expect(takeWarn('s4', 112_000, LIM)).toBe(warnLine(112_000, 120_000, 100_000)) // both levels passed at once: one line
  expect(takeWarn('s4', 113_000, LIM)).toBeNull()
  expect(takeWarn('s2', 99_000, LIM)).toBeNull()
  expect(takeWarn('s2', 105_000, LIM)).toBe(warnLine(105_000, 120_000, 100_000))
  expect(warnLine(105_000, 120_000)).toBe('ctx 105k of 120k: write what you learned to scratch/notes.md, then call lean_run checkpoint {next: <the next step>}: the mod restarts you at once and you continue with it. Never end your turn asking the desk or the user for a restart') // (no soft limit named: the 1.0.29 wording)
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
  expect(ho.prompt).toContain('## Other notes and scratch files: read these before re-reading sources (newest first; path, size, first line)\n- scratch/lookup-a1b2c3.md (2.4 kB): # Report 7: the build order') // (scratch/notes.md has its own section: not listed twice)
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
  h.files.set(`${L}/config.json`, JSON.stringify({ handoverTokens: 500, handover: { mode: 'full' } }))
  const ho = await buildHandover(h.host, '/h', THREAD as any, 'Because.', [])
  const parts = ho.parts!
  const list = parts.find(p => p.name === 'scratchlist')!.body // (at most 6 files in all: scratch/notes.md has its own section, 5 are listed at most, the rest is one line)
  expect(list.split('\n').filter(l => l.startsWith('- scratch/')).length).toBeLessThanOrEqual(5)
  expect(list).toContain('(+16 older, not listed: scratch/r')
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
  h.files.set(`${L}/config.json`, JSON.stringify(OLD_LIMITS)) // (1.0.35: the default limit is 200k; these specs keep the 120k / 80k pair they were written for)
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: T1, surface: 'desktop', isInteractive: true } as any)
  const ctx = async () => ((await $.tool.call({ tool: 'Read', file_path: `${T1}/brief.md`, limit: 10 } as any)) as any).context?.join('\n') ?? '' // (the thread's own folder: always allowed)
  expect(await ctx()).not.toContain('scratch/notes.md')
  tokens = 104_000
  expect(await ctx()).toContain('ctx 104k of 120k (soft limit 80k): at your next natural boundary (a finished step, before a new area) write what you learned to scratch/notes.md, then call lean_run checkpoint')
  expect(await ctx()).not.toContain('scratch/notes.md') // once per session at the warn level
  tokens = 110_000
  expect(await ctx()).toContain('ctx 110k of 120k (soft limit 80k): at your next natural boundary (a finished step, before a new area) write what you learned') // and again at 90% of the limit
  expect(await ctx()).not.toContain('scratch/notes.md')
})

test('1.0.28: one result that jumps over the warn level inside a turn (two reviewer passes, a diff) carries the line at once, once; a jump that went unseen is said at the next call', { timeoutMs: 20_000 }, async ($, on) => {
  warnReset()
  resetLocks()
  const h = fakeHost(on, { orchestrate: true })
  let tokens = 40_000
  let answer = 'ok'
  on('tool.call', () => ({ result: answer }) as any)
  on('clock.after', () => new Promise(() => {}))
  on('session.usage', (() => ({ value: { context: { tokens, window: 200_000, percent: 50 }, rateLimits: [] } })) as any) // (the engine's figure does not hold the result being returned)
  on('session.id', () => ({ value: 'sess-y' }))
  h.files.set(`${T1}/thread.json`, JSON.stringify({ ...THREAD, sid: 'sess-y' }))
  h.files.set(`${L}/config.json`, JSON.stringify(OLD_LIMITS))
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: T1, surface: 'desktop', isInteractive: true } as any)
  const ctx = async () => ((await $.tool.call({ tool: 'Read', file_path: `${T1}/brief.md`, limit: 10 } as any)) as any).context?.join('\n') ?? ''
  expect(await ctx()).not.toContain('scratch/notes.md')
  answer = 'x'.repeat(400_000) // about 100k tokens in one result: 40k + 100k is over the warn level (100k) and 90% of the limit before the engine counts it
  expect(await ctx()).toContain('write what you learned to scratch/notes.md, then call lean_run checkpoint')
  answer = 'ok'
  tokens = 118_000 // the engine now holds it, over the 90% level too
  expect(await ctx()).not.toContain('scratch/notes.md') // the line was said once; both levels were part of it (one line when both are passed at once)
})

test('1.0.28: a jump nobody saw (the last call of a turn, the engine figure alone) is said by the next turn\'s first result', { timeoutMs: 20_000 }, async ($, on) => {
  warnReset()
  resetLocks()
  const h = fakeHost(on, { orchestrate: true })
  let tokens = 40_000
  on('tool.call', () => ({ result: 'ok' }) as any)
  on('clock.after', () => new Promise(() => {}))
  on('session.usage', (() => ({ value: { context: { tokens, window: 200_000, percent: 50 }, rateLimits: [] } })) as any)
  on('session.id', () => ({ value: 'sess-z' }))
  h.files.set(`${T1}/thread.json`, JSON.stringify({ ...THREAD, sid: 'sess-z' }))
  h.files.set(`${L}/config.json`, JSON.stringify(OLD_LIMITS))
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: T1, surface: 'desktop', isInteractive: true } as any)
  const ctx = async () => ((await $.tool.call({ tool: 'Read', file_path: `${T1}/brief.md`, limit: 10 } as any)) as any).context?.join('\n') ?? ''
  expect(await ctx()).not.toContain('scratch/notes.md')
  tokens = 118_000 // from under the warn level to over 90% of the limit between two calls: both levels at once, one line
  expect(await ctx()).toContain('ctx 118k of 120k (soft limit 80k): at your next natural boundary (a finished step, before a new area) write what you learned')
  expect(await ctx()).not.toContain('scratch/notes.md')
})
