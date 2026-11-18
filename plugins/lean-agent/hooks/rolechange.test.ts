import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { resetLocks } from './threads'
import { poolFor } from './register'
import { DESK_TOOLS } from './guard'
import { leanSkillsOnly, trimTools } from './squeeze'
import { typeOfAgent } from './register'

// A session the app pre-started in a spare folder, then moved into the user's folder.
async function start($: any, on: any, first: string) {
  const h = fakeHost(on)
  on('clock.after', () => new Promise(() => {})) // a step's timeout never fires here
  resetLocks()
  h.files.set('/p/templates/thread.md', '# {{id}}')
  h.files.set('/p/templates/front-desk.md', 'desk {{lean}}')
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', title: 'x', project: 'proj', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  const reg: string[] = []
  const timers: number[] = []
  let dir = first
  on('tool.register', (_: any, e: any) => { reg.push(e.name); return { value: { tool: `mcp__lean-agent__${e.name}` } } })
  on('clock.every', (_: any, e: any) => { timers.push(e.ms); return { value: { cancel() {} } } })
  on('session.cwd', () => ({ value: dir }))
  on('session.root', () => ({ value: dir }))
  let sid = 'sess-x'
  on('session.id', () => ({ value: sid }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('classic.CwdChanged', () => ({}))
  on('prompt.submit', (_: any, e: any) => e)
  await $.session.start({ cwd: first, surface: 'desktop', isInteractive: true } as any)
  const move = async (to: string) => {
    const old = dir
    dir = to
    await $.classic.CwdChanged({ old_cwd: old, new_cwd: to } as any)
  }
  return { h, reg, timers, move, set: (to: string) => { dir = to }, setSid: (x: string) => { sid = x } }
}

const SPARE = '/h/.claude/spares/spare-abc'
const deskTools = (reg: string[]) => reg.filter(n => n === 'lean_doctor' || n === 'lean_thread').sort()

test('a session started in a spare folder gets the desk tools once it moves to the desk folder', async ($, on) => {
  const s = await start($, on, SPARE)
  expect(deskTools(s.reg)).toEqual([])
  expect(s.timers).toEqual([])
  await s.move('/h/lean-agent-desk')
  expect(deskTools(s.reg)).toEqual(['lean_doctor', 'lean_thread'])
  expect(s.timers.filter(m => m === 10_000 || m === 60_000 || m === 30_000).sort()).toEqual([10_000, 30_000, 60_000, 60_000]) // reports/sweep, schedule, chaser, usage-limit resume
  const r: any = await $.tool.call({ tool: 'mcp__lean-agent__lean_thread', action: 'list' } as any)
  expect(JSON.stringify(r)).toContain('t1')
})

test('moving to the desk folder twice registers and starts everything once', async ($, on) => {
  const s = await start($, on, SPARE)
  await s.move('/h/lean-agent-desk')
  const tools = s.reg.length
  const timers = s.timers.length
  await s.move('/h/lean-agent-desk/sub')
  await s.move('/h/lean-agent-desk')
  expect(s.reg.length).toBe(tools)
  expect(s.timers.length).toBe(timers)
})

test('the lazy check at prompt.submit finds the new folder when the hook never came', async ($, on) => {
  const s = await start($, on, SPARE)
  s.set('/h/lean-agent-desk')
  await $.prompt.submit({ text: 'hi' } as any)
  expect(deskTools(s.reg)).toEqual(['lean_doctor', 'lean_thread'])
})

test('a session moved from a spare folder into a thread folder gets the thread tools', async ($, on) => {
  const s = await start($, on, SPARE)
  expect(s.reg).toEqual([])
  await s.move('/h/.lean-agent/threads/t1')
  expect(s.reg.length).toBeGreaterThan(0)
  expect(deskTools(s.reg)).toEqual([])
  const n = s.reg.length
  await s.move('/h/.lean-agent/threads/t1')
  expect(s.reg.length).toBe(n)
})

test('a desk session that moves elsewhere stays the desk: its tools work and strict mode stays on', async ($, on) => {
  const s = await start($, on, '/h/lean-agent-desk')
  await s.move('/h/code/proj')
  const r: any = await $.tool.call({ tool: 'mcp__lean-agent__lean_thread', action: 'list' } as any)
  expect(JSON.stringify(r)).not.toContain('needs a desk session')
  const d: any = await $.tool.call({ tool: 'Write', file_path: '/h/code/proj/x', content: 'x' } as any)
  expect(JSON.stringify(d)).toContain('deny') // the desk's allow-list still applies
  await s.move('/h/lean-agent-desk')
  expect(JSON.stringify(await $.tool.call({ tool: 'mcp__lean-agent__lean_thread', action: 'list' } as any))).not.toContain('needs a desk session')
})

test('a plain session refuses the desk tool, re-resolving once first', async ($, on) => {
  const s = await start($, on, SPARE)
  const r: any = await $.tool.call({ tool: 'mcp__lean-agent__lean_thread', action: 'list' } as any)
  expect(JSON.stringify(r)).toContain('needs a desk session')
  s.set('/h/lean-agent-desk') // no CwdChanged came: the refusal path looks again and finds the desk
  expect(JSON.stringify(await $.tool.call({ tool: 'mcp__lean-agent__lean_thread', action: 'list' } as any))).not.toContain('needs a desk session')
})

test('a failing migration does not stop the desk tools from registering', async ($, on) => {
  const h = fakeHost(on)
  resetLocks()
  h.claude.handler = () => { throw new Error('boom') }
  const reg: string[] = []
  on('tool.register', (_: any, e: any) => { reg.push(e.name); return { value: { tool: `mcp__lean-agent__${e.name}` } } })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/h/lean-agent-desk', surface: 'desktop', isInteractive: true } as any)
  expect(deskTools(reg)).toEqual(['lean_doctor', 'lean_thread'])
})

// ---- the desk's tool pool ----------------------------------------------------------------------------------------
const POOL = [
  'Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'Agent', 'WebFetch', 'Skill', 'ToolSearch', 'TodoWrite', 'AskUserQuestion',
  'mcp__other__big_a', 'mcp__other__big_b', 'mcp__lean-agent__lean_thread', 'mcp__lean-agent__lean_doctor',
].map(name => ({ name, description: '', mcp: name.startsWith('mcp__') }))

const NAMES = async (h: any, kind: 'desk' | 'thread' | 'plain') => (await poolFor(h.host, POOL, kind)).map(t => t.name).sort()

test('the desk tool pool is cut to what strict mode can allow; thread and plain pools are untouched', async () => {
  const h = fakeHost(null)
  expect(await NAMES(h, 'desk')).toEqual(
    ['AskUserQuestion', 'Bash', 'Glob', 'Grep', 'Read', 'Skill', 'TodoWrite', 'ToolSearch', 'mcp__lean-agent__lean_doctor', 'mcp__lean-agent__lean_thread'].sort(),
  )
  expect(await NAMES(h, 'thread')).toHaveLength(POOL.length)
  expect(await NAMES(h, 'plain')).toHaveLength(POOL.length)
})

test('config tools.desk.drop applies on top of the desk cut', async () => {
  const h = fakeHost(null)
  h.files.set('/h/.lean-agent/config.json', JSON.stringify({ tools: { desk: { drop: ['TodoWrite', 'mcp__lean-agent__lean_doctor'] } } }))
  const n = await NAMES(h, 'desk')
  expect(n).not.toContain('TodoWrite')
  expect(n).toContain('mcp__lean-agent__lean_doctor') // lean-agent's own tools are never dropped
  expect(n).not.toContain('Edit')
})

test('a tool strict mode allows is never trimmed from the desk pool', async () => {
  const tools = [...DESK_TOOLS, 'mcp__lean-agent__lean_anything', 'Edit', 'mcp__x__y'].map(name => ({ name }))
  const kept = trimTools(tools, 'desk', undefined).map(t => t.name)
  for (const name of DESK_TOOLS) expect(kept).toContain(name)
  expect(kept).toContain('mcp__lean-agent__lean_anything')
  expect(kept).not.toContain('Edit')
  expect(kept).not.toContain('mcp__x__y')
})

test('the desk keeps only lean-agent skills in the skill listing; other roles and odd formats are untouched', async () => {
  const text = ['Skills:', '- lean-agent:thread: route work', '- other:big: a long', '  wrapped line', '- lean-agent:pr: prs'].join('\n')
  expect(leanSkillsOnly(text)).toBe(['Skills:', '- lean-agent:thread: route work', '- lean-agent:pr: prs'].join('\n'))
  expect(leanSkillsOnly('- other:big: x')).toBeNull()
  expect(leanSkillsOnly('no list here')).toBeNull()
})

test('a hung step is given up after its timeout and the rest of the setup still runs', async ($, on) => {
  const h = fakeHost(on)
  resetLocks()
  const reg: string[] = []
  on('tool.register', (_: any, e: any) => { reg.push(e.name); return { value: { tool: `mcp__lean-agent__${e.name}` } } })
  on('session.root', () => new Promise(() => {})) // never answers
  on('clock.after', () => new Promise(r => (globalThis as any).setTimeout(() => r({ value: undefined }), 50)))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/h/lean-agent-desk', surface: 'desktop', isInteractive: true } as any)
  expect(deskTools(reg)).toEqual(['lean_doctor', 'lean_thread'])
})

test('a second session.start in the same process registers by name again, never twice under one name', async ($, on) => {
  const s = await start($, on, '/h/lean-agent-desk')
  await $.session.start({ cwd: '/h/lean-agent-desk', surface: 'desktop', isInteractive: true } as any)
  // the engine replaces a tool registered under the same name: two registrations of a name are one tool
  expect(new Set(s.reg).size).toBe(2)
  expect(s.reg.length).toBe(4)
})

// the AgentInfo the engine really returned for a lean-agent:explorer spawn (live run, claude 2.1.327): `type` carries the
// prefixed name; there is no subagentType / agentType / name; the turn.step event has no agent_type
const LIVE_INFO = { id: 'a245c6a231f79a1d8', description: 'git ls-files', type: 'lean-agent:explorer', status: 'running', kind: 'local_agent', taskStatus: 'running', label: 'x', startTime: 1, cwd: '/c', model: 'haiku', contextWindowSize: 1, effort: 'low', tokenCount: 0, tokenSamples: [], cost: 0, hasRow: true }
test('the live AgentInfo shape resolves to the prefixed type; an unreadable one is unresolved (fail closed)', () => {
  expect(typeOfAgent([LIVE_INFO], 'a245c6a231f79a1d8')).toBe('lean-agent:explorer')
  expect(typeOfAgent([{ id: 'a1', agentType: 'lean-agent:reviewer' }], 'a1')).toBe('lean-agent:reviewer')
  expect(typeOfAgent([], 'a1', { agent_type: 'lean-agent:reader-haiku' })).toBe('lean-agent:reader-haiku')
  for (const bad of [[], [{ id: 'a1' }], [{ id: 'a1', type: '' }], [{ id: 'a1', type: 5 }], null as any]) expect(typeOfAgent(bad, 'a1')).toBe('unresolved')
})

test('the spawned agent type is read from AgentInfo.type (prefixed), not only subagentType', () => {
  const list = [{ id: 'a1', type: 'lean-agent:worker-sonnet' }, { id: 'a2', subagentType: 'general-purpose' }]
  expect(typeOfAgent(list, 'a1')).toBe('lean-agent:worker-sonnet')
  expect(typeOfAgent(list, 'a2')).toBe('general-purpose')
  expect(typeOfAgent(list, 'zz')).toBe('unresolved')
})

// ---- a thread keeps its role (a Bash `cd` into the repo moves the session cwd) ---------------------------------------
const callRules = ($: any) => $.tool.call({ tool: 'mcp__lean-agent__lean_rules', action: 'stats', project: 'proj' } as any)
const callReport = ($: any) => $.tool.call({ tool: 'mcp__lean-agent__lean_report', text: 'hi' } as any)
const refused = (r: any) => JSON.stringify(r).includes('needs a thread session')

test('a thread session that cd\'s into the repo is still a thread (lean_rules and lean_report work), and cd back too', async ($, on) => {
  const s = await start($, on, '/h/.lean-agent/threads/t1')
  expect(refused(await callRules($))).toBe(false)
  await s.move('/h/code/proj')
  expect(refused(await callRules($))).toBe(false)
  expect(refused(await callReport($))).toBe(false)
  s.set('/h/code/proj/src') // a cd the hook never reported
  await $.prompt.submit({ text: 'hi' } as any) // the lazy re-detection must not demote
  await $.turn.start({} as any).catch(() => undefined)
  expect(refused(await callRules($))).toBe(false)
  await s.move('/h/.lean-agent/threads/t1')
  expect(refused(await callRules($))).toBe(false)
})

test('a plain session that moves into a thread folder is promoted, then keeps the role when it leaves', async ($, on) => {
  const s = await start($, on, '/h/code/proj')
  expect(refused(await callRules($))).toBe(true)
  await s.move('/h/.lean-agent/threads/t1')
  expect(refused(await callRules($))).toBe(false)
  await s.move('/h/code/proj')
  expect(refused(await callRules($))).toBe(false)
})

test('a session whose id is a thread\'s sid is that thread from any directory', async ($, on) => {
  const s = await start($, on, '/h/code/proj')
  s.h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', title: 'x', project: 'proj', state: 'open', sid: 'sess-thread-1', created: 1, lastWake: 0, delivered: 0 }))
  expect(refused(await callRules($))).toBe(true) // another sid: plain
  s.setSid('sess-thread-1')
  expect(refused(await callRules($))).toBe(false) // the refusal path resolves by sid first
  await s.move('/h/code/other')
  expect(refused(await callReport($))).toBe(false)
})

const rec = (id: string, sid: string, state = 'open') => JSON.stringify({ id, title: 'x', project: 'proj', state, sid, created: 1, lastWake: 0, delivered: 0 })
test('a sid match never demotes a desk', async ($, on) => {
  const d = await start($, on, '/h/lean-agent-desk')
  d.h.files.set('/h/.lean-agent/threads/t1/thread.json', rec('t1', 'sess-x'))
  await d.move('/h/code/proj')
  expect(JSON.stringify(await $.tool.call({ tool: 'mcp__lean-agent__lean_thread', action: 'list' } as any))).not.toContain('needs a desk session')
})

test('a sid match ignores closed records, and two records with one sid match nobody', async ($, on) => {
  const p = await start($, on, '/h/code/proj')
  p.h.files.set('/h/.lean-agent/threads/t1/thread.json', rec('t1', 'sess-x', 'closed'))
  expect(refused(await callRules($))).toBe(true)
  p.h.files.set('/h/.lean-agent/threads/t1/thread.json', rec('t1', 'sess-x'))
  p.h.files.set('/h/.lean-agent/threads/t2/thread.json', rec('t2', 'sess-x'))
  expect(refused(await callRules($))).toBe(true)
})

test('a session first resolved as a thread records its id in thread.json sids (sid stays); a later start from another folder resolves by it', async ($, on) => {
  const s = await start($, on, '/h/.lean-agent/threads/t1')
  const rec = JSON.parse(String(s.h.files.get('/h/.lean-agent/threads/t1/thread.json')))
  expect(rec.sids).toEqual(['sess-x'])
  expect(rec.sid).toBe('')
  expect(rec.title).toBe('x') // the rest of the record is kept
  await $.session.start({ cwd: '/h/code/proj', surface: 'desktop', isInteractive: true } as any) // mod reload / resume elsewhere
  expect(refused(await callRules($))).toBe(false)
  expect(JSON.parse(String(s.h.files.get('/h/.lean-agent/threads/t1/thread.json'))).sids).toEqual(['sess-x']) // no duplicate
})

test('a sid another thread already holds is never recorded for a second thread', async ($, on) => {
  const s = await start($, on, '/h/code/proj')
  s.h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', title: 'x', project: '', state: 'open', sid: 'sess-x', created: 1, lastWake: 0, delivered: 0 }))
  s.h.files.set('/h/.lean-agent/threads/t2/thread.json', JSON.stringify({ id: 't2', title: 'y', project: '', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  await s.move('/h/.lean-agent/threads/t2') // a plain session that holds t1's id walks into t2's folder: it IS t1 (by id), t2 gets nothing
  expect(JSON.parse(String(s.h.files.get('/h/.lean-agent/threads/t2/thread.json'))).sids).toBeUndefined()
})

test('a refusal names the tool, the role, where the session started and what its id matched', async ($, on) => {
  await start($, on, '/h/code/proj')
  const t = JSON.stringify(await callReport($))
  expect(t).toContain('lean-agent: lean_report needs a thread session; this session is plain (started in /h/code/proj, session id not in any thread.json)')
  const d = JSON.stringify(await $.tool.call({ tool: 'mcp__lean-agent__lean_thread', action: 'list' } as any))
  expect(d).toContain('lean_thread needs a desk session; this session is plain')
})

test('the refusal text tells ambiguous and closed session ids apart', async ($, on) => {
  const s = await start($, on, '/h/code/proj')
  const rec = (id: string, state: string) => JSON.stringify({ id, title: 'x', project: '', state, sid: 'sess-x', created: 1, lastWake: 0, delivered: 0 })
  s.h.files.set('/h/.lean-agent/threads/t1/thread.json', rec('t1', 'closed'))
  expect(JSON.stringify(await callReport($))).toContain('belongs to thread t1, which is closed')
  s.h.files.set('/h/.lean-agent/threads/t2/thread.json', rec('t2', 'open'))
  s.h.files.set('/h/.lean-agent/threads/t3/thread.json', rec('t3', 'open'))
  expect(JSON.stringify(await callReport($))).toContain('is in several thread.json files (t1, t2, t3)')
})
