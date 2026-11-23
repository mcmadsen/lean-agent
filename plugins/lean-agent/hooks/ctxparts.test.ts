// The real breakdown of a thread's context (ctxparts.ts, base.ts): the fixed parts by category, the first prompt apart, the text of the replies,
// the table of `lean_doctor overhead tN`, and the recording at turn ends through the engine. Synthetic numbers (the sizes of a field report).
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { resetLocks } from './threads'
import { baseLine, noteBase, readBase, resetBase } from './base'
import { FIX, fixedParts, freeContext, partOf, partsOf, partsTable, readParts, recordParts, requestText } from './ctxparts'
import { ctxText, ctxView } from './threadcontext'

const row = (name: string, tokens: number, kind = 'used', isDeferred = false) => ({ name, tokens, color: 'x', isDeferred, kind })
const BREAKDOWN = {
  categories: [row('System prompt', 5000), row('System tools', 12000, 'deferred', true), row('MCP tools', 7800), row('Memory files', 4400), row('Custom agents', 1600), row('MCP server instructions', 1500), row('Skills', 7900), row('Messages', 66500), row('Free space', 20000, 'free'), row('Autocompact buffer', 9000, 'buffer')],
  skills: { totalSkills: 40, includedSkills: 33, tokens: 7900, skillFrontmatter: [{ name: 'a', source: 'plugin', pluginName: 'lean-agent', tokens: 1400 }, { name: 'b', source: 'userSettings', tokens: 300 }, { name: 'c', source: 'plugin', pluginName: 'other', tokens: 6200 }] },
  mcpTools: [{ name: 'mcp__lean-agent__lean_thread', serverName: 'lean-agent', tokens: 7000, isLoaded: true }, { name: 'mcp__x__y', serverName: 'x', tokens: 800, isLoaded: true }, { name: 'mcp__z__q', serverName: 'z', tokens: 900, isLoaded: false }],
  memoryFiles: [{ path: '/p/CLAUDE.md', type: 'Project', tokens: 3000 }, { path: '/u/CLAUDE.md', type: 'User', tokens: 1400 }],
}

test('the used rows by part: fixed = everything but Messages; free space, the buffer and deferred schemas are not in the window', () => {
  const p = partsOf(BREAKDOWN, true)!
  expect(p).toMatchObject({ system: 5000, tools: 0, mcp: 7800, memory: 4400, agents: 1600, mcpInstr: 1500, skills: 7900, messages: 66500, fixed: 28200, total: 94700, full: true })
  expect(p.skillsListed).toEqual({ total: 40, included: 33, bySource: { 'plugin lean-agent': { n: 1, tokens: 1400 }, userSettings: { n: 1, tokens: 300 }, 'plugin other': { n: 1, tokens: 6200 } } })
  expect(p.mcpServers).toEqual({ 'lean-agent': 7000, x: 800 }) // an unloaded schema is not in the window
  expect(p.memoryFiles).toEqual([{ type: 'Project', tokens: 3000 }, { type: 'User', tokens: 1400 }]) // no path is kept
  expect(partsOf({}, true)).toBeNull()
  expect(partsOf({ categories: [row('Free space', 9, 'free')] }, true)).toBeNull()
  expect(['MCP server instructions', 'MCP tools', 'System tools', 'System prompt', 'Skills', 'Memory files', 'Custom agents', 'Messages', 'Slash commands'].map(partOf)).toEqual(['mcpInstr', 'mcp', 'tools', 'system', 'skills', 'memory', 'agents', 'messages', 'other'])
})

test('the reply says "fixed base F (parts) + first prompt P = first request"; without a breakdown it says "first request" and never "base" or "before any work"', () => {
  const p = partsOf(BREAKDOWN, true)!
  expect(fixedParts(p)).toBe('skills 7.9k, MCP tools 7.8k, system prompt 5k, memory 4.4k, agents 1.6k, MCP instructions 1.5k')
  expect(requestText(53_000, p, '')).toBe('fixed base 28.2k (skills 7.9k, MCP tools 7.8k, system prompt 5k, memory 4.4k, agents 1.6k, MCP instructions 1.5k) + first prompt 24.8k = first request 53k (full built-in tool set; config threads.tools can cut it)')
  const none = requestText(53_000, null, 'Agent,Bash')
  expect(none).toBe('first request 53k tokens (fixed parts + the first prompt; no breakdown recorded yet) (built-in tools: Agent,Bash)')
  expect(none).not.toMatch(/base|before any work/)
  expect(freeContext(120_000, p)).toBe(91_800) // the limit minus the FIXED base
  expect(freeContext(120_000, null)).toBeNull()
})

test('the ctx line shows the fixed part: "ctx 96k/120k (fixed 28k)"', () => {
  const l = { limit: 120_000, warn: 100_000 }
  expect(ctxText(96_000, l, null, 28_200)).toBe('ctx 96k/120k (fixed 28k)')
  expect(ctxText(96_000, l, 3_000, 28_200)).toBe('ctx 96k/120k (fixed 28k), +3k/turn')
  expect(ctxText(96_000, l)).toBe('ctx 96k/120k') // no breakdown recorded: as before
  expect(ctxView({ tokens: 96_000, at: 1, sid: 's' }, l, 28_200)).toMatchObject({ text: 'ctx 96k/120k (fixed 28k)', fixed: 28_200 })
})

test('the table of lean_doctor overhead tN: largest first, each with the line that shrinks it', async () => {
  const h = fakeHost(null)
  const p = partsOf(BREAKDOWN, true)!
  expect(await recordParts(h.host, 't1', 'sess-1', { request: 53_000 })).toBe(true)
  expect(await recordParts(h.host, 't1', 'sess-1', { parts: p })).toBe(true)
  expect(await recordParts(h.host, 't1', 'sess-1', { parts: { ...p, messages: 70_000, full: false } })).toBe(true) // a later turn end: the counted first one stays the fixed base
  const rec = (await readParts(h.host, '/h', 't1'))!
  expect(rec.first?.messages).toBe(66_500)
  expect(rec.last?.messages).toBe(70_000)
  const t = partsTable(rec, 120_000)
  expect(t.split('\n').slice(1, 8).map(l => l.trim().split(':')[0]!.replace(/^\d+\s+/, ''))).toEqual(['messages (now)', 'skills', 'MCP tools', 'system prompt', 'memory', 'agents', 'MCP instructions'])
  expect(t).toContain(FIX.skills)
  expect(t).toContain('fixed 28200 + messages 70000 = 98200 · first request 53000 (first prompt 24800) · free for work 91800 of 120000')
  expect(t).toContain('skills listed: 33 of 40; by source: plugin other 1 (6200)')
  expect(await recordParts(h.host, 't1', 'sess-2', { request: 40_000 })).toBe(true) // a new session starts a new record
  expect((await readParts(h.host, '/h', 't1'))?.first).toBeUndefined()
})

test('noteBase keeps the first request in the thread\'s record; the newest reading + breakdown make the start reply\'s fixed-base line', async () => {
  resetBase()
  const h = fakeHost(null)
  expect(await noteBase(h.host, 't1', 'sess-1', { input_tokens: 3, cache_creation_input_tokens: 52_997 }, '')).toBe(true)
  expect((await readParts(h.host, '/h', 't1'))?.request).toBe(53_000)
  expect(baseLine((await readBase(h.host))!)).toContain('first request 53k tokens')
})

// ---- through the engine: the first turn end counts with `full`, later ones estimate ---------------------------------------------------
test('the thread\'s own mod records the breakdown at its first turn end (full) and at the next one (summary)', { timeoutMs: 20_000 }, async ($, on) => {
  const h = fakeHost(on)
  const asked: string[] = []
  on('clock.after', () => new Promise(() => {}))
  resetLocks()
  resetBase()
  h.files.set('/r/templates/thread.md', '# {{id}}')
  h.files.set('/r/templates/front-desk.md', 'desk {{lean}}')
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', title: 'x', project: '', state: 'open', sid: 'sess-x', created: 1, lastWake: 0, delivered: 0 }))
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('clock.every', (() => ({ value: { cancel() {} } })) as any)
  on('session.cwd', () => ({ value: '/h/.lean-agent/threads/t1' }))
  on('session.root', () => ({ value: '/h/.lean-agent/threads/t1' }))
  on('session.id', () => ({ value: 'sess-x' }))
  on('session.usage', ((_: any, e: any) => { asked.push(JSON.stringify(e)); return { value: { context: { tokens: 90_000, window: 200_000, percent: 45, breakdown: BREAKDOWN }, rateLimits: [] } } }) as any)
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.measure', (_: any, e: any) => ({ changed: e.changed }))
  on('prompt.attachment', (_: any, e: any) => ({ text: e.text }))
  await $.session.start({ cwd: '/h/.lean-agent/threads/t1', surface: 'desktop', isInteractive: true } as any)
  // the model reads the thread's trimmed listing; the engine's breakdown counts every skill it has (7.9k): the record uses what was read
  const listing = ['The following skills are available for use with the Skill tool:', '', '- lean-agent:review: both', '- other:big: ' + 'x'.repeat(30_000), '- lean-agent:doctor: the desk only'].join('\n')
  const read: any = await $.prompt.attachment({ type: 'skill_listing', text: listing, origin: { kind: 'engine' } } as any)
  const carried = Math.round(read.text.length / 4)
  expect(read.text).not.toContain('other:big')
  await $.session.measure({ context: { tokens: 60_000, window: 200_000, percent: 30 }, rateLimits: [], changed: ['context'] } as any)
  await $.session.measure({ context: { tokens: 90_000, window: 200_000, percent: 45 }, rateLimits: [], changed: ['context'] } as any)
  const rec = JSON.parse(h.files.get('/h/.lean-agent/threads/t1/context-parts.json') ?? 'null')
  expect(rec).toMatchObject({ sid: 'sess-x', first: { skills: carried, skillsEngine: 7_900, fixed: 28_200 - 7_900 + carried, messages: 66_500 + 7_900 - carried, total: 94_700, full: true }, last: { fixed: 28_200 - 7_900 + carried } })
  expect(asked.filter(a => a.includes('full')).length).toBe(1) // the counted breakdown once per session
  expect(asked.filter(a => a.includes('summary')).length).toBeGreaterThanOrEqual(1)
})
