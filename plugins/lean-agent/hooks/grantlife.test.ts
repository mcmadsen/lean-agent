import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { decide, parseGrants, recordGrant, releaseAgent, releaseGrant, sweepGrants, workerJob } from './guard'
import { DEFAULTS, orchAgentEnd, orchDecide, orchEnd, orchReset, launchOf } from './orchestrate'
import { ruleOf } from './refusals'
import { resetLocks } from './threads'

const thread = { kind: 'thread', id: 't1' } as any
const HAIKU = 'lean-agent:worker-haiku'
const edit = (p: string) => ({ tool: 'Edit', file_path: p })
const run = (h: any, e: any, agentId?: string, agentType = HAIKU, cwd = '/r') => decide(h.host, { role: thread, cwd, agentType: agentId ? agentType : undefined, agentId }, e)
const jobOf = (h: any, agentId: string) => workerJob(h.host, { role: thread, cwd: '/r', agentType: HAIKU, agentId }) // what the grant record gives a worker (its job)
const grants = (h: any) => JSON.parse(h.files.get('/h/.lean-agent/threads/t1/grants.json') ?? '{}')

function host(orchestrate = false) {
  orchReset()
  const h = fakeHost(null, { orchestrate })
  h.files.set('/real/w/keep', 'x') // makes /real/w a folder
  return h
}

test('a grant lives as long as the subagent: an async launch keeps it, the subagent end releases it, a resumed worker keeps it', async () => {
  const h = host()
  await recordGrant(h.host, thread, 'u1', HAIKU, { job: 'edit' })
  // "Async agent launched ... agentId": the pending grant is bound to that id and stays
  await releaseGrant(h.host, thread, 'u1', { async: true, agentId: 'w1' })
  expect(grants(h).pending).toEqual([])
  expect(Object.keys(grants(h).agents)).toEqual(['w1'])
  expect(await jobOf(h, 'w1')).toBe('edit')
  // the subagent ends: its grant is released; another worker of the same type gets nothing
  await releaseAgent(h.host, thread, 'w1')
  expect(grants(h).agents).toEqual({})
  expect(await jobOf(h, 'w2')).toBeUndefined()
  // the same subagent resumed (SendMessage, same id) takes its grant back
  expect(await jobOf(h, 'w1')).toBe('edit')
})

test('an async launch without an id leaves the grant pending, bound by type as before; a foreground return releases both', async () => {
  const h = host()
  await recordGrant(h.host, thread, 'u1', HAIKU, { job: 'edit' })
  await releaseGrant(h.host, thread, 'u1', { async: true })
  expect(grants(h).pending.length).toBe(1)
  expect(await jobOf(h, 'w1')).toBe('edit') // bound by type now
  await releaseGrant(h.host, thread, 'u1') // a foreground call returned
  expect(grants(h).pending).toEqual([])
  expect(grants(h).agents).toEqual({})
  expect(await jobOf(h, 'w9')).toBeUndefined()
  await recordGrant(h.host, thread, 'u2', HAIKU, { job: 'edit' }) // a call that never bound (nothing acted): removed when it returns
  await releaseGrant(h.host, thread, 'u2')
  expect(grants(h).pending).toEqual([])
})

test('two parallel workers of one type each get their own grant', async () => {
  const h = host()
  h.files.set('/real/v/keep', 'x')
  await recordGrant(h.host, thread, 'u1', HAIKU, { job: 'edit' })
  await recordGrant(h.host, thread, 'u2', HAIKU, { job: 'edit' })
  const a = await jobOf(h, 'wa')
  const b = await jobOf(h, 'wb')
  expect([a, b]).toEqual(['edit', 'edit']) // each bound one (whichever the first to act took)
  expect(Object.keys(grants(h).agents).sort()).toEqual(['wa', 'wb'])
  expect(grants(h).pending).toEqual([])
})

test('stale grants: older than the TTL (default 120 min, config grants.ttlMinutes) and from another session are dropped at session start and on every write', async () => {
  const h = host()
  await recordGrant(h.host, thread, 'u1', HAIKU, { edit: ['/real/w'] }, { sid: 's1' })
  await releaseGrant(h.host, thread, 'u1', { async: true, agentId: 'w1', sid: 's1' })
  await recordGrant(h.host, thread, 'u2', HAIKU, { edit: ['/real/w'] }, { sid: 's1' })
  expect(grants(h).pending.length).toBe(1)
  h.clock.t += 119 * 60_000
  await sweepGrants(h.host, thread, { sid: 's1' })
  expect(grants(h).pending.length).toBe(1)
  expect(Object.keys(grants(h).agents)).toEqual(['w1'])
  h.clock.t += 2 * 60_000 // 121 min
  await sweepGrants(h.host, thread, { sid: 's1' })
  expect(grants(h).pending).toEqual([])
  expect(grants(h).agents).toEqual({})
  // the TTL is configurable; another session's entries go at once
  await recordGrant(h.host, thread, 'u3', HAIKU, { edit: ['/real/w'] }, { sid: 's1' })
  await sweepGrants(h.host, thread, { sid: 's2' })
  expect(grants(h).pending).toEqual([])
  await recordGrant(h.host, thread, 'u4', HAIKU, { edit: ['/real/w'] }, { sid: 's1', ttlMin: 5 })
  h.clock.t += 6 * 60_000
  await recordGrant(h.host, thread, 'u5', HAIKU, { edit: ['/real/w'] }, { sid: 's1', ttlMin: 5 }) // a write prunes
  expect(grants(h).pending.map((g: any) => g.call)).toEqual(['u5'])
})

test('the engine\'s async launch result: record status async_launched with agentId, or the text', () => {
  expect(launchOf({ result: { status: 'async_launched', agentId: 'a7' } }, '')).toEqual({ async: true, agentId: 'a7' })
  expect(launchOf({ result: 'Async agent launched. agentId: a8 output_file: /x' }, 'Async agent launched. agentId: a8 output_file: /x')).toEqual({ async: true, agentId: 'a8' })
  expect(launchOf({ result: 'Async agent launched.' }, 'Async agent launched.')).toEqual({ async: true })
  expect(launchOf({ result: 'did it. agentId: x' }, 'did it. agentId: x')).toEqual({ async: false })
})

test('worker slots and the step budget follow the subagent\'s life, not the Agent call', () => {
  orchReset()
  const c = { ...DEFAULTS, workers: 1, steps: 2 }
  const ctx = { kind: 'thread' as const, home: '/h', threadDir: '/h/.lean-agent/threads/t1' }
  const call = (n: string) => ({ tool: 'Agent', subagent_type: HAIKU, prompt: `job: edit\nstep ${n}` })
  expect(orchDecide(c, ctx, call('1'))).toBeNull()
  orchEnd(ctx, call('1'), { async: true, agentId: 'a1' }) // launched: the slot stays held
  expect(orchDecide(c, ctx, call('2'))).toContain('at most 1 workers')
  const w = { ...ctx, agentType: HAIKU, agentId: 'a1' }
  expect(orchDecide(c, w, { tool: 'Read', file_path: '/x' })).toBeNull()
  expect(orchDecide(c, w, { tool: 'Read', file_path: '/x' })).toBeNull()
  expect(orchDecide(c, w, { tool: 'Read', file_path: '/x' })).not.toBeNull() // step budget (2) used
  orchAgentEnd('a1') // the subagent ended: slot and steps are free
  expect(orchDecide(c, ctx, call('3'))).toBeNull()
  orchEnd(ctx, call('3')) // a foreground call: freed at return
  expect(orchDecide(c, ctx, call('4'))).toBeNull()
  // a subagent that ended before its launch result was seen holds nothing
  orchEnd(ctx, call('4'), { async: false })
  orchAgentEnd('fast')
  expect(orchDecide(c, ctx, call('5'))).toBeNull()
  orchEnd(ctx, call('5'), { async: true, agentId: 'fast' })
  expect(orchDecide(c, ctx, call('6'))).toBeNull()
})

// ---- no grant needed: a worker edits anywhere but lean-agent's own state --------------------------------------------------------
test('a worker edit with no grant line is allowed; lean-agent\'s own state and settings stay refused', async () => {
  const h = host()
  expect(await run(h, edit('/real/w/a.ts'), 'w1')).toBeNull()
  expect(await run(h, edit('/etc/x'), 'w2')).toBeNull() // (the engine's own permission check judges that one)
  expect(await run(h, edit('/h/.lean-agent/config.json'), 'w3')).toContain('lean-agent\'s own state')
  expect(await run(h, edit('/h/.lean-agent/projects.json'), 'w3')).toContain('lean-agent\'s own state')
  expect(await run(h, edit('/h/.lean-agent/threads/t2/thread.json'), 'w3')).toContain('lean-agent\'s own state') // another thread's folder
  expect(await run(h, edit('/h/.lean-agent/threads/t1/grants.json'), 'w3')).toContain('lean-agent\'s own state')
  expect(await run(h, edit('/h/.lean-agent/worktrees/app/src/a.ts'), 'w3')).toBeNull()
  expect(await run(h, edit('/real/w/.claude/settings.json'), 'w3')).toContain('permissions or settings')
})

test('old allow-edit / allow-cmd lines are accepted and ignored: never a refusal, no grant is recorded for them', async () => {
  const h = host(true)
  const agent = { tool: 'Agent', subagent_type: HAIKU, prompt: 'job: edit\nallow-edit: /real/w\nallow-cmd: git log' }
  expect(await run(h, agent)).toBeNull()
  expect(await run(h, edit('/real/other/a.ts'), 'w1')).toBeNull()
})

// ---- through the engine (register.tsx) ----------------------------------------------------------------------------------------
async function session($: any, on: any, reply: (e: any) => any, seen: any[] = []) {
  const h = fakeHost(on, { orchestrate: true })
  on('classic.SubagentStop', () => ({}))
  on('classic.PermissionDenied', () => ({}))
  on('classic.PostToolUseFailure', () => ({}))
  on('tool.call', (_: any, e: any) => (seen.push(e), { result: reply(e) }) as any)
  resetLocks()
  h.files.set('/real/w/keep', 'x')
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', title: 'x', project: 'proj', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/h/.lean-agent/threads/t1', surface: 'desktop', isInteractive: true } as any)
  return h
}
const agentCall = (n: string, extra: any = {}) => ({ tool: 'Agent', subagent_type: HAIKU, prompt: `job: edit\nallow-edit: /real/w\nstep ${n}`, toolUseId: `u${n}`, ...extra }) as any
const workerEdit = (id: string, p = '/real/w/a.ts') => ({ tool: 'Edit', file_path: p, agentId: id, agentType: HAIKU }) as any

test('through the engine: "Async agent launched", then the worker\'s Edit inside the granted root is allowed; the subagent end releases grant and slot', { timeoutMs: 20_000 }, async ($, on) => {
  const h = await session($, on, e => (e.tool === 'Agent' ? `Async agent launched. agentId: w${/step (\d)/.exec(e.prompt)?.[1]}` : 'ok'))
  h.files.set('/h/.lean-agent/config.json', JSON.stringify({ threads: { workers: 1 } }))
  const r: any = await $.tool.call(agentCall('1'))
  expect(r.deny).toBeUndefined()
  expect(grants(h).pending).toEqual([])
  expect(Object.keys(grants(h).agents)).toEqual(['w1'])
  expect(((await $.tool.call(workerEdit('w1'))) as any).deny).toBeUndefined() // the call returned at once, the worker still has its grant
  expect(((await $.tool.call(agentCall('2'))) as any).deny).toContain('at most 1 workers') // and its slot
  await $.classic.SubagentStop({ agent_id: 'w1', agent_type: HAIKU } as any)
  expect(grants(h).agents).toEqual({})
  expect(((await $.tool.call(agentCall('3'))) as any).deny).toBeUndefined() // the slot is free again
  expect(((await $.tool.call(workerEdit('w9'))) as any).deny).toBeUndefined() // a worker needs no grant to edit
  expect(((await $.tool.call(workerEdit('w1'))) as any).deny).toBeUndefined() // a resumed w1 keeps its grant
})

test('through the engine: no tool.call hook changes a call\'s input (auto mode rejects that); a foreground call releases at return', { timeoutMs: 20_000 }, async ($, on) => {
  const seen: any[] = []
  const h = await session($, on, () => 'done', seen)
  const calls = [
    agentCall('1'),
    agentCall('2', { run_in_background: true }),
    agentCall('3', { run_in_background: false }),
    { tool: 'Agent', subagent_type: 'lean-agent:auditor', prompt: 'x' },
    { tool: 'Agent', subagent_type: 'other:thing', prompt: 'x' },
    { tool: 'Read', file_path: '/real/w/a.ts', limit: 10 },
    { tool: 'Edit', file_path: '/real/w/c.ts', old_string: 'a', new_string: 'b' },
    { tool: 'Bash', command: 'ls /real/w' },
    { tool: 'mcp__lean-agent__lean_run', command: 'echo hi' },
    workerEdit('w1'),
  ]
  for (const c of calls) {
    const before = JSON.stringify(c)
    seen.length = 0
    await $.tool.call(c as any)
    for (const s of seen) expect(JSON.stringify({ ...s, tool_use_id: undefined })).toBe(before) // the event handed on is the one received (the engine adds only tool_use_id)
  }
  expect(grants(h).pending).toEqual([])
  expect(grants(h).agents).toEqual({})
})

test('through the engine: a rejected call (error result) consumes no try, no slot and no grant; the identical reissue runs; two real runs refuse the third', { timeoutMs: 20_000 }, async ($, on) => {
  let fail = true
  const h = await session($, on, () => (fail ? { isError: true, content: [{ type: 'text', text: 'rejected before it ran' }] } : 'done'))
  h.files.set('/h/.lean-agent/config.json', JSON.stringify({ threads: { workers: 1 } }))
  const same = () => agentCall('1', { toolUseId: undefined })
  await $.tool.call(same()) // issued, then rejected
  expect(grants(h).pending).toEqual([])
  fail = false
  expect(((await $.tool.call(same())) as any).deny).toBeUndefined() // identical reissue: allowed (and runs; the one slot was freed)
  const second: any = await $.tool.call({ ...same(), prompt: `${same().prompt}\nwhy-sonnet: x` })
  expect(second.deny).toBeUndefined() // second real run, escalated with the line
  expect(((await $.tool.call({ ...same(), prompt: `${same().prompt}\nwhy-sonnet: y` })) as any).deny).toContain('never a third identical try') // two real runs: the third is refused
  expect(grants(h).pending).toEqual([])
})

const denied = (id: string, prompt = 'job: edit\nedit /real/w/c.ts please') => ({ tool_name: 'Agent', tool_use_id: id, reason: 'x', tool_input: { subagent_type: HAIKU, prompt }, session_id: 's', transcript_path: '', cwd: '/h/.lean-agent/threads/t1' }) as any
const refusalRows = (h: any) => (h.files.get('/h/.lean-agent/refusals.jsonl') ?? '').split('\n').filter(Boolean).map((l: string) => JSON.parse(l))

test('through the engine: the permission check denied a worker call: the thread does that one step itself, a row is logged, and no retry is ever answered', { timeoutMs: 20_000 }, async ($, on) => {
  const h = await session($, on, () => 'ok')
  const own = { tool: 'Edit', file_path: '/real/w/c.ts' } as any
  expect(((await $.tool.call(own)) as any).deny).toContain('one step for a small worker') // before the denial: a worker step
  const r: any = await $.classic.PermissionDenied(denied('u9'))
  expect(r?.retry).toBeUndefined() // the event is only recorded: never `retry`, no permission changed
  const a: any = await $.tool.call(own)
  expect(a.deny).toBeUndefined()
  expect((a.context ?? []).join('\n')).toContain('the permission check denied the worker call: do this one step yourself')
  expect(((await $.tool.call({ tool: 'Read', file_path: '/real/w/c.ts', limit: 20 } as any)) as any).deny).toBeUndefined() // a small read there
  expect(((await $.tool.call({ tool: 'Edit', file_path: '/real/elsewhere/c.ts' } as any)) as any).deny).toContain('one step for a small worker') // only the named paths
  expect(((await $.tool.call({ tool: 'Edit', file_path: '/h/.lean-agent/config.json' } as any)) as any).deny).toBeDefined()
  expect(refusalRows(h).filter((x: any) => x.rule === 'delegation-denied').length).toBe(1)
})

test('through the engine: a failed Agent result that says the permission check denied it counts too; our own refusal text and a non-worker call do not', { timeoutMs: 20_000 }, async ($, on) => {
  const h = await session($, on, () => 'ok')
  const own = { tool: 'Edit', file_path: '/real/w/c.ts' } as any
  await $.classic.PostToolUseFailure({ ...denied('u1'), error: 'lean-agent: at most 4 workers at once; the permission check refused (lean-agent 1.0.18)' })
  await $.classic.PostToolUseFailure({ ...denied('u2'), error: 'it failed: file not found' })
  await $.classic.PostToolUseFailure({ ...denied('u3'), tool_name: 'Bash', error: 'denied by the auto mode classifier' })
  expect(((await $.tool.call(own)) as any).deny).toContain('one step for a small worker')
  await $.classic.PostToolUseFailure({ ...denied('u4'), error: 'Permission denied by the auto mode classifier: [Destructive or Unwanted Actions]' })
  expect(((await $.tool.call(own)) as any).deny).toBeUndefined()
  expect(refusalRows(h).filter((x: any) => x.rule === 'delegation-denied').length).toBe(1)
})
