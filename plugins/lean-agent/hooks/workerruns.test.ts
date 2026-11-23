// Worker runs by tier and job (workerruns.ts): the stats section from a synthetic ledger, the saving estimate, the haiku record, the run record of an Agent call.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { agentIdIn, haikuRecordText, readRuns, recordWorkerCall, runOk, tierJobLines, tierJobSection } from './workerruns'
import type { Run } from './workerruns'
import type { Norm } from './ledger'
import { orchReset } from './orchestrate'
import { decide } from './guard'

const L = '/h/.lean-agent'
type R = Norm & { agentId?: string }
// a request row: tokens in / out / cache read / cache write, the cost as the ledger priced it
const req = (agent: string, agentId: string | undefined, usd: number, o: Partial<R> = {}): R => ({ ts: 1, role: 'thread', tN: 't1', agent, model: agent.endsWith('haiku') ? 'haiku' : 'sonnet', in: 1000, out: 600, cr: 24_000, cw: 0, usd, legacy: false, ...(agentId ? { agentId } : {}), ...o })
const run = (agent: string, job: string, agentId: string | undefined, o: Partial<Run> = {}): Run => ({ ts: 1, tN: 't1', project: 'app', agent, job, ...(agentId ? { agentId } : {}), retry: false, budget: false, ok: true, ...o })

test('by worker tier and job: runs, requests, cost, cost per run, second tries and step budgets; the thread\'s own session; the haiku saving estimate', () => {
  const runs = [run('worker-sonnet', 'edit', 'a1'), run('worker-sonnet', 'edit', 'a2', { retry: true }), run('worker-sonnet', 'edit', 'a3', { budget: true, ok: false }), run('worker-sonnet', 'edit', 'a4'), run('worker-haiku', 'edit', 'h1'), run('worker-haiku', 'lookup', 'h2'), run('worker-haiku', 'lookup', undefined)]
  const rows = [
    req('worker-sonnet', 'a1', 0.3), req('worker-sonnet', 'a1', 0.3), req('worker-sonnet', 'a2', 0.4), req('worker-sonnet', 'a3', 0.5), req('worker-sonnet', 'a4', 0.3),
    req('worker-haiku', 'h1', 0.05), req('worker-haiku', 'h2', 0.02),
    req('reviewer', 'r1', 0.8), req('reviewer', 'r1', 0.04), req('reviewer', 'r2', 0.5),
    req('main', undefined, 1, { in: 3000, cr: 75_000 }), req('main', undefined, 2, { in: 3000, cr: 81_000 }), req('main', undefined, 5, { tN: 't2', in: 1000, cr: 1000 }),
  ]
  const out = tierJobLines(runs, rows, 7)
  expect(out[0]).toContain('by worker tier and job (7d')
  expect(out).toContain('  worker-sonnet · edit: 4 runs · 5 req · $1.80 · $0.45/run · second try 25% · step budget hit 25%') // 0.6 + 0.4 + 0.5 + 0.3
  expect(out).toContain('  worker-haiku · edit: 1 run · 1 req · $0.05 · $0.05/run · second try 0% · step budget hit 0%')
  expect(out).toContain('  worker-haiku · lookup: 2 runs · 1 req · $0.02 · $0.02/run · second try 0% · step budget hit 0% (cost known for 1 of 2)')
  expect(out).toContain('  reviewer · check: 2 runs · 3 req · $1.34 · $0.67/run')
  // the thread's own session: requests, average context (input + cache), cost
  expect(out).toContain('thread main session (requests · avg context · cost):')
  expect(out).toContain('  t2: 1 requests · avg context 2k · $5.00') // dearest first
  expect(out).toContain('  t1: 2 requests · avg context 81k · $3.00')
  // the estimate: the SAME tokens at haiku's prices (in $1, out $5, cache read $0.10 per million), and the haiku share of successful edit runs
  const tokens = (5 * (1000 * 1 + 600 * 5 + 24_000 * 0.1)) / 1e6 // five requests of the four sonnet edit runs: $0.032
  expect(tokens.toFixed(2)).toBe('0.03')
  const est = out.find(l => l.includes('edit runs on sonnet cost'))!
  expect(est).toBe('4 edit runs on sonnet cost $1.80; the same on haiku would be about $0.03 (haiku share of successful edit runs: 25%)') // 1 of the 4 successful (a3 hit its budget)
})

test('no run recorded yet: the section says so and still lists the thread sessions', () => {
  const out = tierJobLines([], [req('main', undefined, 1)], 3)
  expect(out[1]).toContain('no worker run recorded yet')
  expect(out.join('\n')).toContain('t1: 1 requests')
})

test('run success: a failing result, a partial status or a used-up budget is no success; a lookup has no result line', () => {
  expect(runOk('files: a\nresult: pass\nnote: x', 'edit', false)).toBe(true)
  expect(runOk('files: a\nresult: fail\nnote: tests red', 'edit', false)).toBe(false)
  expect(runOk('answer:\nfoo\nrefs: a:1', 'lookup', false)).toBe(true)
  expect(runOk('result: pass\nLEAN-FEEDBACK {"status": "partial"}', 'run', false)).toBe(false)
  expect(runOk('result: pass', 'check', true)).toBe(false)
  expect(agentIdIn('result: pass\nagentId: a1b2c3d4e5 (use SendMessage)')).toBe('a1b2c3d4e5')
  expect(agentIdIn('no id here')).toBeUndefined()
})

test('haiku first, measured: at least 5 successful haiku runs of the job in this project and >= 80% success; else no text', () => {
  const ok = (n: number, job = 'edit', project = 'app') => Array.from({ length: n }, () => run('worker-haiku', job, undefined, { project }))
  const bad = (n: number) => Array.from({ length: n }, () => run('worker-haiku', 'edit', undefined, { ok: false }))
  expect(haikuRecordText([...ok(6), ...bad(1)], 'app', 'edit')).toBe('haiku succeeded 6 of 7 times on edit here: try haiku with a narrower brief first')
  expect(haikuRecordText([...ok(4)], 'app', 'edit')).toBe('') // fewer than 5 successes
  expect(haikuRecordText([...ok(5), ...bad(2)], 'app', 'edit')).toBe('') // 5 of 7 = 71%
  expect(haikuRecordText([...ok(5), ...bad(1)], 'app', 'edit')).toContain('5 of 6') // 83%
  expect(haikuRecordText(ok(9, 'lookup'), 'app', 'edit')).toBe('') // another job type
  expect(haikuRecordText(ok(9, 'edit', 'other'), 'app', 'edit')).toBe('') // another project
  expect(haikuRecordText([...ok(9), run('worker-sonnet', 'edit', undefined)], 'app', 'edit')).toContain('9 of 9')
})

test('the why-sonnet refusal names the haiku record of the project for that job type; no new refusal, no text without a record', async () => {
  orchReset()
  const h = fakeHost(null, { orchestrate: true })
  h.files.set(`${L}/projects.json`, JSON.stringify({ app: { path: '/r/app' } }))
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', project: 'app' }))
  const rec = (n: number, ok: boolean, job: string) => Array.from({ length: n }, (_, i) => JSON.stringify({ ts: 1, tN: 't1', project: 'app', agent: 'worker-haiku', job, agentId: `${job}${ok}${i}`, retry: false, budget: false, ok })).join('\n') + '\n'
  h.files.set(`${L}/runs.jsonl`, rec(6, true, 'edit') + rec(1, false, 'edit') + rec(2, true, 'run'))
  const call = (agent: string, prompt: string) => decide(h.host, { role: { kind: 'thread', id: 't1' }, cwd: '/r/app' }, { tool: 'Agent', subagent_type: `lean-agent:${agent}`, prompt })
  const refused = await call('worker-sonnet', 'job: edit\nrename foo to bar in a.ts')
  expect(refused).toContain('haiku by default')
  expect(refused).toContain('haiku succeeded 6 of 7 times on edit here: try haiku with a narrower brief first')
  expect(await call('worker-sonnet', 'job: run\nrun the tests')).not.toContain('haiku succeeded') // 2 successes only
  expect(await call('worker-sonnet', 'job: lookup\nfind foo')).not.toContain('haiku succeeded') // no record of that job
  expect(await call('worker-sonnet', 'job: edit\nwhy-sonnet: needs reasoning about the lock order\nrename foo')).toBeNull() // the old rule: a reason lets it through
  expect(await call('worker-haiku', 'job: edit\nrename foo to bar in b.ts')).toBeNull()
})

test('an Agent call to a worker is one run record; the section (lean_doctor stats) reads it with the ledger', async () => {
  orchReset()
  const h = fakeHost(null)
  const now = await h.host.clock.now()
  await recordWorkerCall(h.host, { thread: 't1', project: 'app', agent: 'lean-agent:worker-sonnet', job: 'edit', text: 'files: a.ts\ndiffstat: 1 file changed\nsha: abc1234\nresult: pass\nnote: ok\nagentId: w42abcd', retried: false })
  await recordWorkerCall(h.host, { thread: 't1', project: 'app', agent: 'lean-agent:worker-haiku', job: 'edit', text: 'result: fail\nnote: red', retried: true })
  const runs = await readRuns(h.host)
  expect(runs).toHaveLength(2)
  expect(runs[0]).toMatchObject({ tN: 't1', project: 'app', agent: 'worker-sonnet', job: 'edit', agentId: 'w42abcd', retry: false, budget: false, ok: true })
  expect(runs[1]).toMatchObject({ agent: 'worker-haiku', retry: true, ok: false })
  h.files.set(`${L}/ledger.jsonl`, [{ ts: now, role: 'thread', tN: 't1', agent: 'lean-agent:worker-sonnet', agentId: 'w42abcd', model: 'sonnet', in: 1000, out: 600, cache_read: 24_000, usd: 0.3 }].map(r => JSON.stringify(r)).join('\n') + '\n')
  const sec = await tierJobSection(h.host, now + 1000, 7)
  expect(sec.some(l => l.startsWith('  worker-sonnet · edit: 1 run · 1 req · $0.30'))).toBe(true)
  expect(sec.some(l => l.includes('worker-haiku · edit: 1 run · 0 req · $0.00 · cost unknown'))).toBe(true)
})
