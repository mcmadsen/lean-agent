import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { decide, parseGrants, recordGrant, releaseAgent, releaseGrant, sweepGrants } from './guard'
import { DEFAULTS, GRANT_LOST, noteGrantRoots, orchAgentEnd, orchDecide, orchEnd, orchReset, launchOf } from './orchestrate'
import { ruleOf } from './refusals'
import { resetLocks } from './threads'

const thread = { kind: 'thread', id: 't1' } as any
const HAIKU = 'lean-agent:worker-haiku'
const edit = (p: string) => ({ tool: 'Edit', file_path: p })
const run = (h: any, e: any, agentId?: string, agentType = HAIKU, cwd = '/r') => decide(h.host, { role: thread, cwd, agentType: agentId ? agentType : undefined, agentId }, e)
const grants = (h: any) => JSON.parse(h.files.get('/h/.lean-agent/threads/t1/grants.json') ?? '{}')

function host(orchestrate = false) {
  orchReset()
  const h = fakeHost(null, { orchestrate })
  h.files.set('/real/w/keep', 'x') // makes /real/w a folder
  return h
}

test('a grant lives as long as the subagent: an async launch keeps it, the subagent end releases it, a resumed worker keeps it', async () => {
  const h = host()
  await recordGrant(h.host, thread, 'u1', HAIKU, { edit: ['/real/w'] })
  // "Async agent launched ... agentId": the pending grant is bound to that id and stays
  await releaseGrant(h.host, thread, 'u1', { async: true, agentId: 'w1' })
  expect(grants(h).pending).toEqual([])
  expect(Object.keys(grants(h).agents)).toEqual(['w1'])
  expect(await run(h, edit('/real/w/a.ts'), 'w1')).toBeNull()
  // the subagent ends: its grant is released; another worker of the same type gets nothing
  await releaseAgent(h.host, thread, 'w1')
  expect(grants(h).agents).toEqual({})
  expect(await run(h, edit('/real/w/a.ts'), 'w2')).toContain('no grant is recorded')
  // the same subagent resumed (SendMessage, same id) takes its grant back
  expect(await run(h, edit('/real/w/a.ts'), 'w1')).toBeNull()
})

test('an async launch without an id leaves the grant pending, bound by type as before; a foreground return releases both', async () => {
  const h = host()
  await recordGrant(h.host, thread, 'u1', HAIKU, { edit: ['/real/w'] })
  await releaseGrant(h.host, thread, 'u1', { async: true })
  expect(grants(h).pending.length).toBe(1)
  expect(await run(h, edit('/real/w/a.ts'), 'w1')).toBeNull() // bound by type now
  await releaseGrant(h.host, thread, 'u1') // a foreground call returned
  expect(grants(h).pending).toEqual([])
  expect(grants(h).agents).toEqual({})
  expect(await run(h, edit('/real/w/a.ts'), 'w9')).toContain('no grant is recorded')
  await recordGrant(h.host, thread, 'u2', HAIKU, { edit: ['/real/w'] }) // a call that never bound (nothing acted): removed when it returns
  await releaseGrant(h.host, thread, 'u2')
  expect(grants(h).pending).toEqual([])
})

test('two parallel workers of one type each get their own grant', async () => {
  const h = host()
  h.files.set('/real/v/keep', 'x')
  await recordGrant(h.host, thread, 'u1', HAIKU, { edit: ['/real/w'] })
  await recordGrant(h.host, thread, 'u2', HAIKU, { edit: ['/real/v'] })
  const a = await run(h, edit('/real/w/a.ts'), 'wa')
  const b = await run(h, edit('/real/v/b.ts'), 'wb')
  expect([a, b].filter(x => x === null).length).toBe(2) // each bound one (whichever the first to act took)
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

// ---- paths: both sides of the check are resolved the same way ---------------------------------------------------------------
test('path match: symlinked parent, doubled / trailing slashes and dots, ~, not-yet-existing files', async () => {
  const h = host()
  h.links.set('/tmp/w', '/real/w') // /tmp -> /private/tmp on macOS
  const ok = async (root: string, p: string) => {
    resetLocks()
    h.files.delete('/h/.lean-agent/threads/t1/grants.json')
    await recordGrant(h.host, thread, 'u' + root + p, HAIKU, { edit: [root] })
    return run(h, edit(p), 'w' + root + p)
  }
  expect(await ok('/tmp/w', '/real/w/x.ts')).toBeNull() // granted through the link, edited by its real path
  expect(await ok('/real/w', '/tmp/w/x.ts')).toBeNull() // the other way round
  expect(await ok('/real/w/', '/real//w/./sub/../x.ts')).toBeNull() // trailing slash, doubled slash, dots
  expect(await ok('/real/w', '/real/w/new/deep/x.ts')).toBeNull() // not-yet-existing folders under a granted one
  h.files.set('/h/proj/keep', 'x')
  expect(await ok('~/proj', '/h/proj/a.ts')).toBeNull() // ~ expanded (the home of the host)
  expect(parseGrants('allow-edit: ~/proj, /real/w').edit).toEqual(['~/proj', '/real/w'])
  expect(await ok('/real/w', '/real/wx/a.ts')).toContain('not within the granted roots') // a prefix is not a parent
})

test('path match: a file grant is that file only, a directory grant everything below it; a link inside never escapes', async () => {
  const h = host()
  h.files.set('/real/w/one.ts', 'x')
  const file = async (p: string) => {
    h.files.delete('/h/.lean-agent/threads/t1/grants.json')
    await recordGrant(h.host, thread, 'f' + p, HAIKU, { edit: ['/real/w/one.ts'] })
    return run(h, edit(p), 'v' + p)
  }
  expect(await file('/real/w/one.ts')).toBeNull()
  expect(await file('/real/w/two.ts')).toContain('not within the granted roots')
  expect(await file('/real/w/one.tsx')).toContain('not within the granted roots')
  expect(await file('/real/w/one.ts/x')).toContain('not within the granted roots')
  // a granted file that does not exist yet
  h.files.delete('/h/.lean-agent/threads/t1/grants.json')
  await recordGrant(h.host, thread, 'n', HAIKU, { edit: ['/real/w/brand-new.ts'] })
  expect(await run(h, edit('/real/w/brand-new.ts'), 'vn')).toBeNull()
  // a link inside a granted folder that points out is refused: the real path decides
  h.links.set('/real/w/out', '/etc')
  h.files.set('/etc/passwd', 'x')
  h.files.delete('/h/.lean-agent/threads/t1/grants.json')
  await recordGrant(h.host, thread, 'd', HAIKU, { edit: ['/real/w'] })
  expect(await run(h, edit('/real/w/out/passwd'), 'vd')).toContain('not within the granted roots')
})

test('path match: case-insensitive file systems match paths that differ only by case when the path exists; case-sensitive ones do not', async () => {
  const h = host()
  h.files.set('/w/proj/keep', 'x')
  await recordGrant(h.host, thread, 'c1', HAIKU, { edit: ['/w/proj'] })
  // case-sensitive (the fake): /w/Proj does not exist
  expect(await run(h, edit('/w/Proj/a.ts'), 'w1')).toContain('not within the granted roots')
  // macOS: the same folder answers to either spelling, and stat keeps the spelling it was given
  const ci = { ...h.host, fs: { ...h.host.fs, stat: async (p: string, o?: any) => ({ ...(await h.host.fs.stat(p.toLowerCase(), o)), realPath: p }) } }
  expect(await decide(ci as any, { role: thread, cwd: '/r', agentType: HAIKU, agentId: 'w1' }, edit('/w/Proj/a.ts'))).toBeNull()
  expect(await decide(ci as any, { role: thread, cwd: '/r', agentType: HAIKU, agentId: 'w1' }, edit('/w/Other/a.ts'))).toContain('not within the granted roots')
})

test('the refusal says which it is: no grant recorded, or the path is not within the roots; each has its own refusal rule', async () => {
  const h = host()
  const none = (await run(h, edit('/real/w/a.ts'), 'w1')) as string
  expect(none).toContain('no grant is recorded for this worker (granted on the call: none found)')
  expect(ruleOf(none)).toBe('grant-missing')
  await recordGrant(h.host, thread, 'u1', HAIKU, { edit: ['/real/w'] })
  const mism = (await run(h, edit('/etc/x'), 'w2')) as string
  expect(mism).toContain('the path /etc/x is not within the granted roots: /real/w')
  expect(ruleOf(mism)).toBe('grant-mismatch')
  expect(mism.split('\n').length).toBe(1)
})

// ---- the grants did not arrive: fail fast, then the thread does it itself ------------------------------------------------------
test('after 2 refused worker edits inside a granted root the next refusal and the next Agent call say so, and the thread edits under its roots itself', async () => {
  const h = host(true)
  const tdir = '/h/.lean-agent/threads/t1'
  noteGrantRoots(tdir, ['/real/w'])
  const first = await run(h, edit('/real/w/a.ts'), 'w1')
  const second = await run(h, edit('/real/w/b.ts'), 'w2')
  expect(first).toContain('no grant is recorded')
  expect(second).toContain('no grant is recorded')
  const third = (await run(h, edit('/real/w/c.ts'), 'w3')) as string
  expect(third).toContain(GRANT_LOST)
  expect(ruleOf(third)).toBe('grant-lost')
  // the thread's next worker Agent call says it once, then the calls go on
  const agent = { tool: 'Agent', subagent_type: HAIKU, prompt: 'job: edit\nallow-edit: /real/w' }
  expect(await run(h, agent)).toContain(GRANT_LOST)
  expect(await run(h, agent)).toBeNull()
  // the thread's own edit under a root it granted is allowed for the rest of the session; elsewhere it is not
  expect(await run(h, edit('/real/w/c.ts'))).toBeNull()
  expect(await run(h, edit('/real/elsewhere/c.ts'))).not.toBeNull()
  expect(await run(h, edit('/h/.lean-agent/config.json'))).not.toBeNull()
})

test('a worker edit that is allowed resets the count: grants that arrive never trigger the fallback', async () => {
  const h = host(true)
  noteGrantRoots('/h/.lean-agent/threads/t1', ['/real/w'])
  expect(await run(h, edit('/real/w/a.ts'), 'w1')).toContain('no grant is recorded')
  expect(await run(h, edit('/real/w/a.ts'), 'w2')).toContain('no grant is recorded')
  await recordGrant(h.host, thread, 'u1', HAIKU, { edit: ['/real/w'] })
  expect(await run(h, edit('/real/w/a.ts'), 'w3')).toBeNull()
  expect(await run(h, edit('/real/w/a.ts'), 'w4')).toContain('no grant is recorded') // not the fail-fast text
  expect(await run(h, edit('/real/w/a.ts'))).not.toBeNull() // the thread's own edit is still a worker step
})

// ---- through the engine (register.tsx) ----------------------------------------------------------------------------------------
async function session($: any, on: any, reply: (e: any) => any, seen: any[] = []) {
  const h = fakeHost(on, { orchestrate: true })
  on('classic.SubagentStop', () => ({}))
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

test('through the engine: "Async agent launched", then the worker\'s Edit inside the granted root is allowed; the subagent end releases grant and slot', async ($, on) => {
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
  expect(((await $.tool.call(workerEdit('w9'))) as any).deny).toContain('no grant is recorded') // nothing left for a stranger
  expect(((await $.tool.call(workerEdit('w1'))) as any).deny).toBeUndefined() // a resumed w1 keeps its grant
})

test('through the engine: a thread\'s lean-agent Agent call is handed on in the foreground (undefined or true), a foreground call releases at return', async ($, on) => {
  const seen: any[] = []
  const h = await session($, on, () => 'done', seen)
  await $.tool.call(agentCall('1'))
  await $.tool.call(agentCall('2', { run_in_background: true }))
  await $.tool.call(agentCall('3', { run_in_background: false }))
  await $.tool.call({ tool: 'Agent', subagent_type: 'other:thing', prompt: 'x' } as any)
  expect(seen.map(e => e.run_in_background)).toEqual([false, false, false, undefined])
  expect(grants(h).pending).toEqual([])
  expect(grants(h).agents).toEqual({})
})

test('through the engine: the fail-fast fallback is logged as a grant-lost refusal row and the thread edits under its roots', async ($, on) => {
  const h = await session($, on, () => 'ok')
  await $.tool.call(agentCall('1')) // roots noted; the call returned (foreground) so the grant is gone
  for (const w of ['w1', 'w2']) expect(((await $.tool.call(workerEdit(w))) as any).deny).toContain('no grant is recorded')
  expect(((await $.tool.call(workerEdit('w3'))) as any).deny).toContain('grants are not reaching workers')
  expect(((await $.tool.call(agentCall('2'))) as any).deny).toContain('do this edit yourself now')
  const own: any = await $.tool.call({ tool: 'Edit', file_path: '/real/w/c.ts' } as any)
  expect(own.deny).toBeUndefined()
  const rows = (h.files.get('/h/.lean-agent/refusals.jsonl') ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l))
  expect(rows.filter(r => r.rule === 'grant-lost').length).toBe(3) // the refusal text, the Agent call's refusal and the fallback edit
  expect(rows.filter(r => r.rule === 'grant-missing').length).toBe(2)
})
