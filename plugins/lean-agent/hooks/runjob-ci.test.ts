// lean_run {ci}: the read-only CI check that waits inside the tool (runjob.ts), with canned az / gh JSON. Synthetic ids and names only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { CI_IDS_MAX, ciArgvOk, runCi } from './runjob'
import { resetLocks } from './threads'

const L = '/h/.lean-agent'
const ADO = { host: 'ado', org: 'acme', project: 'Shop App' }
const WHERE = ['--org', 'https://dev.azure.com/acme', '--project', 'Shop App', '--output', 'json']
const run = (id: number, status: string, result = '', extra: Record<string, unknown> = {}) => JSON.stringify({ id, status, ...(result ? { result } : {}), _links: { web: { href: `https://dev.azure.com/acme/Shop%20App/_build/results?buildId=${id}` } }, ...extra })
const ghRun = (status: string, conclusion: string, extra: Record<string, unknown> = {}) => JSON.stringify({ status, conclusion, url: 'https://github.com/acme/shop-api/actions/runs/9', ...extra })

type Reply = { exitCode: number; stdout: string; stderr?: string }
// answers: the n-th call (per command line) gets the n-th reply; the last one repeats
function setup(replies: Record<string, Reply[]>) {
  const h = fakeHost(null)
  resetLocks()
  const seen: Record<string, number> = {}
  h.exec.handler = argv => {
    const key = argv.join(' ')
    const list = Object.entries(replies).find(([k]) => key.includes(k))?.[1]
    if (!list) return { exitCode: 127, stdout: '', stderr: `unexpected ${key}` }
    const i = (seen[key] = (seen[key] ?? -1) + 1)
    return list[Math.min(i, list.length - 1)]!
  }
  let slept = 0
  const host = { ...h.host, clock: { now: async () => h.clock.t, sleep: async (ms: number) => { slept++; h.clock.t += ms } } }
  const calls = () => h.calls.filter(c => ['az', 'gh'].includes(c.argv[0]!)).map(c => c.argv)
  return { h, host, calls, slept: () => slept }
}
const ok = (stdout: string): Reply => ({ exitCode: 0, stdout })

test('a finished Azure DevOps run: one compact result, argv only, no wait', async () => {
  const s = setup({ 'runs show --id 101': [ok(run(101, 'completed', 'succeeded'))] })
  const r = await runCi(s.host, { ...ADO, id: 101 })
  expect(s.calls()).toEqual([['az', 'pipelines', 'runs', 'show', '--id', '101', ...WHERE]])
  expect(r.failed).toBe(false)
  expect(r.timedOut).toBe(false)
  expect(r.text).toContain('all 1 finished')
  expect(r.text).toContain('101: completed / succeeded')
  expect(r.text).toContain('https://dev.azure.com/acme/Shop%20App/_build/results?buildId=101')
  expect(s.slept()).toBe(0)
})

test('a failed run names the failed stage / job / test when the JSON has them, and is an error result', async () => {
  const s = setup({ 'runs show --id 102': [ok(run(102, 'completed', 'failed', { stages: [{ name: 'Build', result: 'succeeded' }, { name: 'Test', result: 'failed' }], jobs: [{ name: 'unit', result: 'failed' }], tests: [{ name: 'digest flakes', outcome: 'Failed' }] }))] })
  const r = await runCi(s.host, { ...ADO, id: 102 })
  expect(r.failed).toBe(true)
  expect(r.text).toContain('102: completed / failed')
  expect(r.text).toContain('failed: stage Test; job unit; test digest flakes')
  expect(r.text).not.toContain('stage Build')
  // GitHub: the failed job and its failed step
  const g = setup({ 'run view 9': [ok(ghRun('completed', 'failure', { jobs: [{ name: 'lint', conclusion: 'success', steps: [] }, { name: 'unit', conclusion: 'failure', steps: [{ name: 'Set up', conclusion: 'success' }, { name: 'Run tests', conclusion: 'failure' }] }] }))] })
  const gr = await runCi(g.host, { host: 'github', repo: 'acme/shop-api', id: 9 })
  expect(g.calls()).toEqual([['gh', 'run', 'view', '9', '--repo', 'acme/shop-api', '--json', 'status,conclusion,jobs,url,name,displayTitle']])
  expect(gr.failed).toBe(true)
  expect(gr.text).toContain('9: completed / failure')
  expect(gr.text).toContain('failed: job unit / Run tests')
  expect(gr.text).not.toContain('lint')
  expect(gr.text).toContain('https://github.com/acme/shop-api/actions/runs/9')
})

test('a run that is still running is polled until it finishes, waiting inside the tool', async () => {
  const s = setup({ 'runs show --id 103': [ok(run(103, 'inProgress')), ok(run(103, 'inProgress')), ok(run(103, 'completed', 'succeeded'))] })
  const r = await runCi(s.host, { ...ADO, id: 103, waitMinutes: 10 })
  expect(s.calls()).toHaveLength(3)
  expect(s.slept()).toBe(2)
  expect(r.timedOut).toBe(false)
  expect(r.failed).toBe(false)
  expect(r.text).toContain('103: completed / succeeded')
  expect(r.text.split('\n')).toHaveLength(2) // the head and ONE line for the run
  // several ids: only the unfinished ones are asked again
  const m = setup({ 'show --id 1 ': [ok(run(1, 'completed', 'succeeded'))], 'show --id 2 ': [ok(run(2, 'inProgress')), ok(run(2, 'completed', 'failed'))] })
  const mr = await runCi(m.host, { ...ADO, ids: [1, 2] })
  expect(m.calls().filter(a => a.includes('1')).length).toBe(1)
  expect(m.calls().filter(a => a[a.indexOf('--id') + 1] === '2')).toHaveLength(2)
  expect(mr.failed).toBe(true)
  expect(mr.text).toContain('1: completed / succeeded')
  expect(mr.text).toContain('2: completed / failed')
})

test('the wait is over: "still running after N min", no error, the run named', async () => {
  const s = setup({ 'runs show --id 104': [ok(run(104, 'inProgress'))] })
  const r = await runCi(s.host, { ...ADO, id: 104, waitMinutes: 2 })
  expect(r.timedOut).toBe(true)
  expect(r.failed).toBe(false)
  expect(r.text).toMatch(/^still running after [12] min/)
  expect(r.text).toContain('104: inProgress [still running]')
  expect(s.slept()).toBeGreaterThanOrEqual(2)
  expect(s.calls().length).toBe(s.slept() + 1)
  // waitMinutes 0 is one check
  const z = setup({ 'runs show --id 104': [ok(run(104, 'inProgress'))] })
  const zr = await runCi(z.host, { ...ADO, id: 104, waitMinutes: 0 })
  expect(z.calls()).toHaveLength(1)
  expect(z.slept()).toBe(0)
  expect(zr.text).toContain('still running after 0 min (no wait asked)')
  // a host that cannot sleep never waits
  const h = fakeHost(null)
  h.exec.handler = () => ok(run(104, 'inProgress'))
  const nr = await runCi(h.host, { ...ADO, id: 104, waitMinutes: 5 })
  expect(nr.timedOut).toBe(true)
})

test('Azure DevOps by branch (no id) lists the latest runs; GitHub by pr and by branch', async () => {
  const s = setup({ 'runs list': [ok(JSON.stringify([JSON.parse(run(21, 'completed', 'failed', { stages: [{ name: 'Test', result: 'failed' }] })), JSON.parse(run(20, 'completed', 'succeeded'))]))] })
  const r = await runCi(s.host, { ...ADO, branch: 'feature/digest' })
  expect(s.calls()).toEqual([['az', 'pipelines', 'runs', 'list', '--branch', 'feature/digest', '--top', '5', '--query-order', 'QueueTimeDesc', ...WHERE]])
  expect(r.failed).toBe(true)
  expect(r.text).toContain('21: completed / failed')
  expect(r.text).toContain('failed: stage Test')
  expect(r.text).toContain('20: completed / succeeded')
  // gh pr checks exits 8 while checks are pending and still prints the JSON
  const pending = JSON.stringify([{ name: 'build', state: 'SUCCESS', bucket: 'pass', link: 'https://github.com/acme/shop-api/actions/runs/5' }, { name: 'lint', state: 'PENDING', bucket: 'pending', link: 'https://github.com/acme/shop-api/actions/runs/6' }])
  const done = JSON.stringify([{ name: 'build', state: 'SUCCESS', bucket: 'pass', link: 'https://github.com/acme/shop-api/actions/runs/5' }, { name: 'lint', state: 'FAILURE', bucket: 'fail', link: 'https://github.com/acme/shop-api/actions/runs/6' }])
  const g = setup({ 'pr checks 42': [{ exitCode: 8, stdout: pending }, { exitCode: 1, stdout: done }] })
  const gr = await runCi(g.host, { host: 'github', repo: 'acme/shop-api', pr: 42, waitMinutes: 5 })
  expect(g.calls()[0]).toEqual(['gh', 'pr', 'checks', '42', '--repo', 'acme/shop-api', '--json', 'name,state,bucket,link,workflow'])
  expect(g.slept()).toBe(1)
  expect(gr.failed).toBe(true)
  expect(gr.text).toContain('build: completed / succeeded')
  expect(gr.text).toContain('lint: completed / failed')
  expect(gr.text).toContain('failed: lint')
  const b = setup({ 'run list': [ok(JSON.stringify([{ databaseId: 31, status: 'completed', conclusion: 'success', url: 'https://github.com/acme/shop-api/actions/runs/31' }]))] })
  const br = await runCi(b.host, { host: 'github', repo: 'acme/shop-api', branch: 'main' })
  expect(b.calls()).toEqual([['gh', 'run', 'list', '--branch', 'main', '--repo', 'acme/shop-api', '--limit', '5', '--json', 'databaseId,status,conclusion,url,name,displayTitle']])
  expect(br.text).toContain('31: completed / success')
})

test('a command that fails or answers nothing readable is reported per run, after three tries, never a hang', async () => {
  const s = setup({ 'runs show --id 105': [{ exitCode: 1, stdout: '', stderr: 'ERROR: Please run az login' }] })
  const r = await runCi(s.host, { ...ADO, id: 105, waitMinutes: 10 })
  expect(s.calls()).toHaveLength(3)
  expect(r.failed).toBe(true)
  expect(r.text).toContain('105: could not read it (ERROR: Please run az login)')
  const ids = setup({ 'show --id 1 ': [ok(run(1, 'completed', 'succeeded'))], 'show --id 2 ': [{ exitCode: 1, stdout: 'not json', stderr: '' }, ok(run(2, 'completed', 'succeeded'))] })
  const ir = await runCi(ids.host, { ...ADO, ids: [1, 2] })
  expect(ir.failed).toBe(false) // one transient error then fine
  expect(ir.text).toContain('2: completed / succeeded')
})

test('a write subcommand is refused by the wall in front of every az / gh call', () => {
  for (const argv of [['az', 'pipelines', 'runs', 'cancel', '--id', '1'], ['az', 'pipelines', 'run', '--name', 'x'], ['az', 'repos', 'pr', 'create'], ['az', 'devops', 'login'], ['gh', 'run', 'rerun', '1'], ['gh', 'run', 'cancel', '1'], ['gh', 'pr', 'merge', '1'], ['gh', 'pr', 'comment', '1'], ['gh', 'api', '-X', 'POST', 'repos/a/b/issues'], ['gh', 'workflow', 'run', 'x'], ['curl', 'https://x'], ['bash', '-c', 'gh run view 1'], []]) {
    expect(() => ciArgvOk(argv), argv.join(' ')).toThrow(/read-only/)
  }
  for (const argv of [['gh', 'run', 'view', '1', '--web'], ['gh', 'pr', 'checks', '1', '--watch'], ['gh', 'run', 'view', '1', '--method', 'POST'], ['az', 'pipelines', 'runs', 'show', '--id', '1', '-X', 'POST']]) expect(() => ciArgvOk(argv), argv.join(' ')).toThrow(/read-only/)
  for (const argv of [['az', 'pipelines', 'runs', 'show', '--id', '1'], ['az', 'pipelines', 'runs', 'list'], ['gh', 'run', 'view', '1'], ['gh', 'run', 'list'], ['gh', 'pr', 'checks', '1']]) expect(() => ciArgvOk(argv)).not.toThrow()
})

test('a bad request runs nothing: write-ish or unknown fields, a bad host, id, org, branch, wait, more than ten ids', async () => {
  const s = setup({ az: [ok('[]')], gh: [ok('[]')] })
  const bad: Record<string, unknown>[] = [
    { ...ADO, id: 1, command: 'az pipelines run' },
    { ...ADO, id: 1, method: 'POST' },
    { host: 'gitlab', id: 1 },
    { ...ADO },
    { ...ADO, id: 0 },
    { ...ADO, id: 'x; rm' },
    { ...ADO, org: 'a/b', id: 1 },
    { ...ADO, project: '../x', id: 1 },
    { ...ADO, branch: '--output', waitMinutes: 1 },
    { ...ADO, branch: 'a..b' },
    { ...ADO, id: 1, waitMinutes: 31 },
    { ...ADO, id: 1, waitMinutes: -1 },
    { ...ADO, id: 1, waitMinutes: '5' },
    { ...ADO, ids: Array.from({ length: CI_IDS_MAX + 1 }, (_v, i) => i + 1) },
    { ...ADO, id: 1, repo: 'acme/x' },
    { host: 'github', id: 1 },
    { host: 'github', repo: 'nope', id: 1 },
    { host: 'github', repo: 'acme/shop-api' },
    { host: 'github', repo: 'acme/shop-api', id: 1, org: 'acme' },
    { host: 'github', repo: 'acme/shop-api; ls', pr: 1 },
    { host: 'github', repo: 'acme/shop-api', pr: 'abc' },
  ]
  for (const c of bad) await expect(runCi(s.host, c), JSON.stringify(c)).rejects.toThrow()
  expect(s.calls()).toHaveLength(0)
  await expect(runCi(s.host, { ...ADO, id: 1, waitMinutes: 30 })).resolves.toBeDefined() // 30 is the top of the range
})

// ---- through the tool: a thread (and its workers) call lean_run {ci}; a bad one is a recorded refusal ------------------------------
test('lean_run {ci} through the engine: a result, an error on a failed run, a refusal for a write subcommand request, and a worker may call it', async ($, on) => {
  const h = fakeHost(on, { orchestrate: true })
  resetLocks()
  h.clock.t = 1_000_000
  h.files.set(`${L}/projects.json`, JSON.stringify({ app: { path: '/r/app' } }))
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', title: 'x', project: 'app', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.claude.handler = (a: string[]) => ({ exitCode: 0, stdout: a[0] === '--version' ? '2.1.327 (Claude Code)\n' : '[]' })
  h.exec.handler = argv => (argv.includes('201') ? ok(run(201, 'completed', 'succeeded')) : ok(run(202, 'completed', 'failed', { stages: [{ name: 'Test', result: 'failed' }] })))
  on('clock.after', () => new Promise(() => {}))
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: [] }))
  ;(on as any)('ui.status', () => ({ value: null }))
  ;(on as any)('clock.every', () => ({ value: { cancel: () => {} } }))
  await $.session.start({ cwd: `${L}/threads/t1`, surface: 'desktop', isInteractive: true } as any)
  const call = (extra: Record<string, unknown>) => $.tool.call({ tool: 'mcp__lean-agent__lean_run', ...extra } as any) as Promise<any>
  const good: any = await call({ ci: { ...ADO, id: 201, waitMinutes: 0 } })
  expect(good.isError).toBeUndefined()
  expect(JSON.stringify(good)).toContain('201: completed / succeeded')
  const failed: any = await call({ ci: { ...ADO, id: 202, waitMinutes: 0 } })
  expect(failed.isError).toBe(true)
  expect(JSON.stringify(failed)).toContain('failed: stage Test')
  const worker: any = await call({ ci: { ...ADO, id: 201, waitMinutes: 0 }, agentId: 'agent-1' })
  expect(JSON.stringify(worker)).toContain('201: completed / succeeded')
  const writes = h.calls.filter(c => ['az', 'gh'].includes(c.argv[0]!))
  const refused: any = await call({ ci: { host: 'github', repo: 'acme/shop-api', id: 1, method: 'POST' } })
  expect(refused.isError).toBe(true)
  expect(JSON.stringify(refused)).toContain('lean_run refused')
  const both: any = await call({ command: 'npm test', ci: { ...ADO, id: 201 } })
  expect(JSON.stringify(both)).toContain('either command or ci')
  expect(h.calls.filter(c => ['az', 'gh'].includes(c.argv[0]!))).toHaveLength(writes.length) // the refused ones ran nothing
  expect(h.files.get(`${L}/refusals.jsonl`) ?? '').toContain('run-refused')
})
