// Execution model (orchestrate.ts, runjob.ts, preflight.ts, contextstat.ts, cap.ts capTo): every rule allowed / refused, budgets, config off, exemptions.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { decide } from './guard'
import { DESK_ROUTE, SPLIT, THREAD_STEP, bashOk, orchConfig, orchDecide, orchEnd, orchReset, orchTurnStart, tried, triedWords } from './orchestrate'
import { capTo } from './cap'
import { RUN_TIMEOUT_MS, runSummary, runText } from './runjob'
import { digest } from './rundigest'
import { preflightFor, preflightText } from './preflight'
import { buildHandover, setPreflight } from './handover'
import { bucketOf, contextStat, contextText } from './contextstat'

const HOME = '/h'
const TDIR = '/h/.lean-agent/threads/t1'
const C = orchConfig({})
const th = { kind: 'thread', home: HOME, threadDir: TDIR, cwd: '/r/app' } as const
const worker = { kind: 'thread', home: HOME, threadDir: TDIR, cwd: '/r/app', agentType: 'lean-agent:worker-haiku', agentId: 'w1' } as const
const call = (ctx: any, e: any, c = C) => orchDecide(c, ctx, e)
let seqN = 0 // a fresh brief each time: an identical brief is a retry (jobs.ts retryDenial)

test('config: defaults, nested and flat keys, junk falls back, false switches the model off', () => {
  expect(C).toEqual({ on: true, deskChars: 6000, agentChars: 6000, directReads: 3, workers: 4, briefChars: 3000, steps: 24, stepsByJob: {}, requireJob: false, grantTtlMin: 120, commit: true })
  const c =orchConfig({ lean: { orchestrate: false }, deskToolResultChars: 3000, threads: { directReads: 1, workers: 2 }, workers: { briefChars: 500, steps: 5 }, agentResultChars: 4000 })
  expect(c).toEqual({ on: false, deskChars: 3000, agentChars: 4000, directReads: 1, workers: 2, briefChars: 500, steps: 5, stepsByJob: {}, requireJob: false, grantTtlMin: 120, commit: true })
  expect(orchConfig({ 'lean.orchestrate': false }).on).toBe(false)
  expect([orchConfig({ workers: { commit: false } }).commit, orchConfig({ 'workers.commit': false }).commit, orchConfig({}).commit]).toEqual([false, false, true])
  expect(orchConfig({ workers: { steps: 'x' }, threads: { workers: -1 } })).toEqual(C)
  expect(orchConfig({ threads: { directReads: 0 } }).directReads).toBe(0)
})

test('desk: Agent is refused with the routing line; everything else is left to the desk guard', () => {
  const desk = { kind: 'desk', home: HOME } as const
  expect(call(desk, { tool: 'Agent' })).toBe(DESK_ROUTE)
  expect(call(desk, { tool: 'Task' })).toBe(DESK_ROUTE)
  expect(call(desk, { tool: 'mcp__lean-agent__lean_thread' })).toBeNull()
})

test('thread: lean tools, git, task tools and its own folder files are allowed', () => {
  orchReset()
  for (const e of [{ tool: 'mcp__lean-agent__lean_report' }, { tool: 'mcp__lean-agent__lean_run' }, { tool: 'TodoWrite' }, { tool: 'Skill' }, { tool: 'ToolSearch' }]) expect(call(th, e)).toBeNull()
  expect(call(th, { tool: 'Write', file_path: `${TDIR}/notes.md` })).toBeNull()
  expect(call(th, { tool: 'Edit', file_path: '/h/.lean-agent/memory/x.md' })).toBeNull()
  for (const command of ['git status --short', 'git log --oneline -5', 'git diff --stat', 'git add -A', 'git commit -m "a b"', 'git worktree list', 'git -C /r/app status', 'git add . && git commit -m x', 'lean-agent pane --json', 'ls /h/.lean-agent/threads', 'grep -n foo /h/.lean-agent/x.md'])
    expect([command, call(th, { tool: 'Bash', command })]).toEqual([command, null])
})

test('thread: its own Edit / Write on project files, greps, searches and other commands are refused with the one-step line', () => {
  orchReset()
  // lean-agent's own state is not a way round the model: worktrees (a worker's step), the settings, grants and review records
  for (const f of ['/h/.lean-agent/worktrees/app/src/a.ts', '/h/.lean-agent/config.json', '/h/.lean-agent/projects.json', '/h/.lean-agent/app/reviews/abc.json']) {
    expect([f, call(th, { tool: 'Write', file_path: f })]).toEqual([f, THREAD_STEP + tried(`Write ${f.includes('worktrees') ? 'worktree' : 'lean state'}`)])
    expect([f, call(th, { tool: 'Grep', path: f })]).toEqual([f, THREAD_STEP + tried(`Grep ${f.includes('worktrees') ? 'worktree' : 'lean state'}`)])
  }
  const proj = { ...th, projects: ['/r/app'] }
  expect(call(proj, { tool: 'Edit', file_path: '/r/app/src/a.ts' })).toBe(THREAD_STEP + tried('Edit project'))
  expect(call(th, { tool: 'Edit', file_path: '/r/app/src/a.ts' })).toBe(THREAD_STEP + tried('Edit other'))
  expect(call(proj, { tool: 'Write', file_path: '/r/app/src/a.ts' })).toBe(THREAD_STEP + tried('Write project'))
  expect(call(th, { tool: 'Write', file_path: '/h/.lean-agent/../x' })).toBe(THREAD_STEP + tried('Write other'))
  expect(call(proj, { tool: 'Grep', pattern: 'x' })).toBe(THREAD_STEP + tried('Grep project')) // no path: the session folder
  expect(call(proj, { tool: 'Glob', pattern: '*.ts', path: '/r/app' })).toBe(THREAD_STEP + tried('Glob project'))
  expect(call(proj, { tool: 'Read', file_path: '/r/app/src/a.ts' })).toContain(tried('Read project')) // (the path itself is never in the text)
  expect(call(proj, { tool: 'Read', file_path: '/r/app/src/a.ts' })).not.toContain('a.ts')
  for (const command of ['npm test', 'sed -n 1,5p /r/app/a.ts', 'git diff', 'git diff src/a.ts', 'cat /r/app/a.ts', 'grep -rn foo src', 'ls', 'git status; rm -rf x', 'node x.js'])
    expect([command, typeof call(th, { tool: 'Bash', command })]).toEqual([command, 'string'])
  expect(call(th, { tool: 'Bash', command: 'npm test' })).toContain('lean_run')
})

test('thread: a Bash refusal says what was tried (program and subcommand only) and how to do it instead', () => {
  const r = (command: string) => String(call(th, { tool: 'Bash', command }))
  expect(r('npm test')).toContain(tried('npm test'))
  expect(r('npm test')).toContain('lean_run')
  expect(call(th, { tool: 'Bash', command: 'az pipelines run --name x' })).toBeNull() // az is judged by the other guards: allowed here
  expect(r('git -C /r/app checkout main')).toContain(tried('git checkout')) // outside its own worktrees
  expect(r('git -C /r/app checkout main')).toContain('git switch')
  expect(r('cd /x && npm test')).toContain(tried('cd')) // (the folder is never named)
  expect(r('cd /x && npm test')).toContain('never cd')
  expect(r('make deploy')).toContain(tried('make')) // a make target is not recorded
  expect(r('node x.js')).toContain(tried('node'))
  expect(r('git -C /r/app checkout main')).not.toContain('/r/app') // (the folder is never named)
  expect(triedWords(['git', '-C', '/r/app', 'stash', 'pop'])).toBe('git stash')
  expect(triedWords(['/usr/bin/pytest', '-q'])).toBe('pytest')
})

test('thread: wider direct commands: read-only forge queries and piped filters, script listing, git work in its OWN worktrees, rm in its scratch folder', () => {
  orchReset()
  const ok = (command: string) => bashOk(th, command)
  // forge reads and a filter pipe; filters read stdin only
  for (const c of ['gh pr view 12 --json state', 'gh pr checks 12', 'az repos pr list --status active', 'az pipelines runs list --top 3 -o json | jq ".[0].status"', 'gh pr list --json number | head -5', 'git log --oneline | wc -l', 'az devops project show | grep -i name', 'gh run list | sort -u | uniq -c'])
    expect([c, ok(c)]).toEqual([c, true])
  // a filter with a file operand, an output file, or a first segment that is not allowed stays refused
  for (const c of ['gh pr list | jq . /r/app/x.json', 'gh pr list | sort -o /r/app/out', 'npm test | head', 'cat /r/app/a.ts | head', 'gh pr list | grep -r foo', 'gh pr list | tee /r/app/x', 'gh pr list | jq -f /r/app/f.jq'])
    expect([c, ok(c)]).toEqual([c, false])
  // script listing, never a run
  for (const c of ['npm run', 'pnpm run --list', 'yarn run', 'bun run', 'npm pkg get scripts']) expect([c, ok(c)]).toEqual([c, true])
  for (const c of ['npm run build', 'npm test', 'pnpm install', 'yarn build', 'bun test', 'npm pkg set x=1']) expect([c, ok(c)]).toEqual([c, false])
  // git in its own worktree: branch work, stash, fast-forward pull / merge, rebase onto a ref, cherry-pick; never in a project's main checkout, never with -c
  const wt = '/h/.lean-agent/worktrees/app'
  for (const c of [`git -C ${wt} checkout -b fix/x`, `git -C ${wt} checkout -b fix/x origin/main`, `git -C ${wt} switch main`, `git -C ${wt} stash`, `git -C ${wt} stash pop`, `git -C ${wt} stash push -u`, `git -C ${wt} fetch origin`, `git -C ${wt} pull --ff-only`, `git -C ${wt} pull --ff-only origin main`, `git -C ${wt} merge --ff-only origin/main`, `git -C ${wt} rebase origin/main`, `git -C ${wt} rebase --continue`, `git -C ${wt} cherry-pick abc123`, `git -C ${wt} cherry-pick -x abc123 def456`, `git -C ${wt} branch -m new`])
    expect([c, ok(c)]).toEqual([c, true])
  for (const c of ['git -C /r/app checkout -b fix/x', 'git -C /r/app stash', 'git -C /r/app pull --ff-only', `git -C ${wt} checkout main`, `git -C ${wt} checkout -- src/a.ts`, `git -C ${wt} pull`, `git -C ${wt} pull --rebase`, `git -C ${wt} merge origin/main`, `git -C ${wt} rebase -i main`, `git -C ${wt} rebase --exec x main`, `git -C ${wt} cherry-pick`, `git -c core.editor=x -C ${wt} rebase main`, `git -C ${wt} reset --hard`, `git -C ${wt} restore a.ts`, `git -C ${wt} clean -fd`, `git -C ${wt} checkout -b ../x`])
    expect([c, ok(c)]).toEqual([c, false])
  expect(bashOk({ ...th, cwd: wt }, 'git stash')).toBe(true) // no -C: the session folder is its own worktree
  expect(bashOk({ ...th, cwd: '/r/app' }, 'git stash')).toBe(false)
  // scratch: mkdir -p and rm inside the thread's own scratch folder only
  for (const c of [`mkdir -p ${TDIR}/scratch/a`, `rm ${TDIR}/scratch/a.txt`, `rm -rf ${TDIR}/scratch/a`, `rm -f ${TDIR}/scratch/a ${TDIR}/scratch/b`]) expect([c, ok(c)]).toEqual([c, true])
  for (const c of [`rm ${TDIR}/notes.md`, `rm -rf ${TDIR}`, `rm ${TDIR}/scratch/../notes.md`, 'rm -rf /r/app/x', `rm /h/.lean-agent/threads/t2/scratch/a`, 'rm -rf scratch', `rm ${TDIR}/scratch/a /r/app/x`, `rm -i ${TDIR}/scratch/a`, 'rm'])
    expect([c, ok(c)]).toEqual([c, false])
})

test('thread: at most threads.directReads small direct reads per turn (<= 200 lines), lean home reads are free, a new turn resets', () => {
  orchReset()
  const read = (extra: any = { limit: 100 }) => call(th, { tool: 'Read', file_path: '/r/app/a.ts', ...extra })
  expect(read()).toBeNull()
  expect(read({ limit: 200 })).toBeNull()
  expect(read()).toBeNull()
  expect(read()).toContain(THREAD_STEP) // the 4th
  expect(call(th, { tool: 'Read', file_path: '/h/.lean-agent/threads/t1/brief.md' })).toBeNull()
  orchTurnStart(TDIR)
  expect(read()).toBeNull()
  orchReset()
  expect(read({})).toContain('limit') // no limit: refused
  expect(read({ limit: 201 })).toContain('limit')
  expect(call(th, { tool: 'Read', file_path: '/r/app/a.ts', limit: 10 }, orchConfig({ threads: { directReads: 0 } }))).toContain(THREAD_STEP)
})

test('Agent: sonnet needs why-sonnet, opus is left to the approval, briefs are capped, a worker never spawns workers', () => {
  orchReset()
  const ag = (sub: string, prompt = `do one thing ${++seqN}`) => call(th, { tool: 'Agent', subagent_type: sub, prompt })
  expect(ag('lean-agent:worker-haiku')).toBeNull()
  orchEnd(th, { tool: 'Agent', subagent_type: 'lean-agent:worker-haiku' })
  expect(ag('lean-agent:reader-haiku')).toBeNull()
  orchEnd(th, { tool: 'Agent', subagent_type: 'lean-agent:reader-haiku' })
  expect(ag('lean-agent:worker-sonnet')).toContain('why-sonnet')
  expect(ag('lean-agent:reader-sonnet')).toContain('why-sonnet')
  expect(ag('lean-agent:worker-sonnet', 'fix it\nwhy-sonnet: the haiku worker failed this step once')).toBeNull()
  orchEnd(th, { tool: 'Agent', subagent_type: 'lean-agent:worker-sonnet' })
  expect(ag('lean-agent:worker-opus')).toBeNull() // the 1.0.12 approval judges it (guard.ts expensiveDenial)
  orchEnd(th, { tool: 'Agent', subagent_type: 'lean-agent:worker-opus' })
  expect(ag('lean-agent:reviewer', 'x'.repeat(5000))).toBeNull() // not a small worker: no brief cap here
  expect(ag('lean-agent:worker-haiku', 'x'.repeat(3001))).toContain('3000')
  expect(ag('lean-agent:worker-haiku', 'x'.repeat(3001))).toContain('one step per job: the brief is 3001 chars, at most 3000 (workers.briefChars)')
  expect(ag('lean-agent:worker-haiku', 'x'.repeat(2674))).toBeNull() // the longest brief of the field data (1502 .. 2674) now fits
  orchEnd(th, { tool: 'Agent', subagent_type: 'lean-agent:worker-haiku' })
  expect(ag('lean-agent:worker-haiku', 'x'.repeat(3000))).toBeNull()
  orchEnd(th, { tool: 'Agent', subagent_type: 'lean-agent:worker-haiku' })
  expect(call(worker, { tool: 'Agent', subagent_type: 'lean-agent:worker-haiku', prompt: 'x' })).toContain('never spawns')
  expect(call({ ...th, agentType: 'lean-agent:reader-sonnet', agentId: 'r1' }, { tool: 'Task' })).toContain('never spawns')
})

test('Agent: at most threads.workers at once; a finished worker frees its slot; slots are per thread', () => {
  orchReset()
  const ag = (ctx: any = th) => call(ctx, { tool: 'Agent', subagent_type: 'lean-agent:worker-haiku', prompt: `x${++seqN}` })
  for (let i = 0; i < 4; i++) expect(ag()).toBeNull()
  expect(ag()).toContain('at most 4')
  expect(ag({ ...th, threadDir: '/h/.lean-agent/threads/t2' })).toBeNull()
  orchEnd(th, { tool: 'Agent', subagent_type: 'lean-agent:worker-haiku' })
  expect(ag()).toBeNull()
  for (let i = 0; i < 10; i++) orchEnd(th, { tool: 'Agent', subagent_type: 'lean-agent:worker-haiku' }) // never below 0
  expect(ag()).toBeNull()
  orchEnd(th, { tool: 'Read' }) // not an Agent call: ignored
  expect(call(th, { tool: 'Agent', subagent_type: 'lean-agent:worker-haiku', prompt: 'y1' }, orchConfig({ threads: { workers: 1 } }))).toContain('at most 1')
})

test('worker: a tool-call budget (workers.steps); at the budget the call is refused with the split line; counts are per worker', () => {
  orchReset()
  const c = orchConfig({ workers: { steps: 3 } })
  for (let i = 0; i < 3; i++) expect(call(worker, { tool: 'Read' }, c)).toBeNull()
  expect(call(worker, { tool: 'Read' }, c)).toBe(SPLIT)
  expect(call(worker, { tool: 'Bash', command: 'ls' }, c)).toBe(SPLIT)
  expect(call({ ...worker, agentId: 'w2' }, { tool: 'Read' }, c)).toBeNull()
  // the reviewer has the budget of a check job (never above workers.steps, here 3: see the reviewer spec below); other agents have none
  const rev = { ...worker, agentType: 'lean-agent:reviewer', agentId: 'v1' }
  for (let i = 0; i < 3; i++) expect(call(rev, { tool: 'Read' }, c)).toBeNull()
  expect(call(rev, { tool: 'Read' }, c)).toContain("the reviewer's budget (3 tool calls")
  const ex = { ...worker, agentType: 'lean-agent:explorer', agentId: 'x1' }
  for (let i = 0; i < 40; i++) expect(call(ex, { tool: 'Read' }, c)).toBeNull()
})

test('config off: every rule is off (today)', () => {
  orchReset()
  const off = orchConfig({ lean: { orchestrate: false } })
  expect(call(th, { tool: 'Edit', file_path: '/r/app/a.ts' }, off)).toBeNull()
  expect(call(th, { tool: 'Bash', command: 'npm test' }, off)).toBeNull()
  expect(call({ kind: 'desk', home: HOME }, { tool: 'Agent' }, off)).toBeNull()
  expect(call(th, { tool: 'Agent', subagent_type: 'lean-agent:worker-sonnet', prompt: 'x'.repeat(9000) }, off)).toBeNull()
  for (let i = 0; i < 50; i++) expect(call(worker, { tool: 'Read' }, off)).toBeNull()
})

test('guard: the rules run inside decide; the desk refusal is the routing line, and config off restores the old text', async () => {
  orchReset()
  const h = fakeHost(null, { orchestrate: true })
  const run = (role: any, e: any, agentType?: string) => decide(h.host, { role, cwd: '/r/app', agentType, agentId: agentType ? 'a1' : undefined }, e)
  expect(await run({ kind: 'desk' }, { tool: 'Edit', file_path: '/r/x' })).toBe(DESK_ROUTE)
  expect(await run({ kind: 'desk' }, { tool: 'Read', file_path: '/etc/passwd' })).toBe(DESK_ROUTE)
  expect(await run({ kind: 'desk' }, { tool: 'Read', file_path: '/h/.lean-agent/goals.json' })).toBeNull()
  expect(await run({ kind: 'thread', id: 't1' }, { tool: 'Edit', file_path: '/r/app/a.ts' })).toBe(THREAD_STEP + tried('Edit other')) // (no registered project here)
  expect(await run({ kind: 'thread', id: 't1' }, { tool: 'Edit', file_path: '/h/.lean-agent/threads/t1/n.md' })).toBeNull()
  expect(await run({ kind: 'plain' }, { tool: 'Edit', file_path: '/r/app/a.ts' })).toBeNull()
  h.files.set('/h/.lean-agent/config.json', JSON.stringify({ lean: { orchestrate: false } }))
  expect(await run({ kind: 'desk' }, { tool: 'Edit', file_path: '/r/x' })).toContain('strict mode')
  expect(await run({ kind: 'thread', id: 't1' }, { tool: 'Edit', file_path: '/r/app/a.ts' })).toBeNull()
  // the environment switches it off too, whatever the file says
  const envOff = fakeHost(null) // (the fake host sets LEAN_ORCHESTRATE=0 unless a spec opts in)
  expect(await decide(envOff.host, { role: { kind: 'thread', id: 't1' }, cwd: '/r/app' }, { tool: 'Edit', file_path: '/r/app/a.ts' })).toBeNull()
})

test('guard: small workers are exempt from the user subagent cap (agents.cap); other agents still count', async () => {
  orchReset()
  const h = fakeHost(null, { orchestrate: true })
  h.files.set('/h/.lean-agent/config.json', JSON.stringify({ agents: { cap: 1 } }))
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ sid: 's1' }))
  const role = { kind: 'thread', id: 't1' } as const
  const ag = (sub: string) => decide(h.host, { role, cwd: '/r/app' }, { tool: 'Agent', subagent_type: sub, prompt: `x${++seqN}` })
  expect(await ag('lean-agent:explorer')).toBeNull() // the one counted subagent
  expect(await ag('lean-agent:explorer')).toContain('subagent cap reached')
  expect((await ag('lean-agent:explorer')) ?? '').toContain('lean-agent:worker-* / reader-*')
  for (let i = 0; i < 3; i++) {
    expect(await ag('lean-agent:worker-haiku')).toBeNull()
    orchEnd({ kind: 'thread', home: '/h', threadDir: '/h/.lean-agent/threads/t1' }, { tool: 'Agent', subagent_type: 'lean-agent:worker-haiku' })
  }
})

test('capTo: any tool result over the limit keeps head and tail, the full text is a file; short results and limit 0 are untouched', async () => {
  const h = fakeHost(null)
  const text = Array.from({ length: 400 }, (_, i) => `line ${i} `.padEnd(60, '.')).join('\n')
  const r: any = { result: [{ type: 'text', text }] }
  const out = await capTo(h.host, 'desk', r, 6000)
  expect(out.result[0].text.length).toBeLessThan(7000)
  expect(out.result[0].text).toContain('line 0 ')
  expect(out.result[0].text).toContain('line 399 ')
  expect(out.result[0].text).toContain('the full text is in')
  expect([...h.files.keys()].some(k => k.startsWith('/h/.lean-agent/output/'))).toBe(true)
  expect(await capTo(h.host, 'desk', r, 0)).toBe(r)
  const small: any = { result: 'short' }
  expect(await capTo(h.host, 'desk', small, 6000)).toBe(small)
  const err: any = { result: text, isError: true }
  expect(await capTo(h.host, 'desk', err, 100)).toBe(err)
  const bash: any = { result: { stdout: text, stderr: '', interrupted: false } }
  const b = await capTo(h.host, 't1', bash, 6000)
  expect(b.result.stdout.length).toBeLessThan(7000)
  expect(b.result.interrupted).toBe(false)
})

test('the reviewer has the budget of a check job (10 tool calls, workers.stepsByJob.check) and is told what to do at the end', () => {
  orchReset()
  const rv = { ...worker, agentType: 'lean-agent:reviewer', agentId: 'rv1' }
  const bash = { tool: 'Bash', command: 'git -C /r/app diff main...abc' }
  for (let n = 1; n <= 10; n++) expect(call(rv, bash), `call ${n}`).toBeNull()
  const over = call(rv, bash)
  expect(over).toContain("the reviewer's budget (10 tool calls")
  expect(over).toContain('write the json block')
  expect(call({ ...rv, agentId: 'rv2' }, bash, orchConfig({ workers: { stepsByJob: { check: 3 } } }))).toBeNull()
  const small = orchConfig({ workers: { stepsByJob: { check: 2 } } })
  expect([call({ ...rv, agentId: 'rv3' }, bash, small), call({ ...rv, agentId: 'rv3' }, bash, small), call({ ...rv, agentId: 'rv3' }, bash, small)].map(x => x === null)).toEqual([true, true, false])
  // another subagent type (explorer, auditor) is not counted by this rule
  const ex = { ...worker, agentType: 'lean-agent:explorer', agentId: 'ex1' }
  for (let n = 1; n <= 30; n++) expect(call(ex, bash)).toBeNull()
})

test('lean_run: an unknown runner keeps the last 15 lines; runSummary runs the command with its output in a file', async () => {
  const log = [...Array.from({ length: 100 }, (_, i) => `ok ${i}`), 'FAIL  a.test.ts > adds', '✗ b fails', 'FAIL  a.test.ts > adds', ...Array.from({ length: 50 }, (_, i) => `tail ${i}`)].join('\n')
  const s = digest(log, 1)
  expect(s.body.split('\n')).toHaveLength(15)
  expect(s.body).toContain('tail 49')

  const h = fakeHost(null)
  h.exec.handler = (argv: string[]) => {
    const file = /> '([^']+)' 2>&1/.exec(argv[2] ?? '')?.[1]
    if (file) h.files.set(file, log)
    return { exitCode: 1, stdout: '' }
  }
  const r = await runSummary(h.host, { command: 'npm test', cwd: '/r/app', home: '/h' })
  expect(r.exit).toBe(1)
  expect(r.file).toMatch(/^\/h\/\.lean-agent\/runs\/\d+\.log$/)
  expect(h.calls.at(-1)!.argv.slice(0, 2)).toEqual(['bash', '-c'])
  expect(h.calls.at(-1)!.timeoutMs).toBe(RUN_TIMEOUT_MS) // a watch mode or a dev server ends instead of hanging the thread
  expect(h.calls.at(-1)!.argv[2]).toContain("cd '/r/app' && ( npm test )")
  const t = runText(r)
  expect(t).toContain('exit 1')
  expect(t).toContain('tail 49')
  expect(t).toContain('full log:')
  expect(t).not.toContain('ok 0')
  await expect(runSummary(h.host, { command: 'git push origin main', home: '/h' })).rejects.toThrow('no push')
  await expect(runSummary(h.host, { command: '  ', home: '/h' })).rejects.toThrow('no command')
})

test('preflight: branch, HEAD, status, diff, last report, tasks, ref; a failing part prints n/a and never throws', async () => {
  const h = fakeHost(null)
  h.git.handler = (a: string[]) => {
    if (a.includes('rev-parse')) return { exitCode: 0, stdout: 'fix-x\n' }
    if (a.includes('log')) return { exitCode: 0, stdout: 'abc1234 add the thing\n' }
    if (a.includes('status')) return { exitCode: 0, stdout: ' M a.ts\n?? b.ts\n' }
    if (a.includes('diff')) return { exitCode: 0, stdout: ' a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n' }
    return { exitCode: 1, stdout: '' }
  }
  h.files.set('/h/.lean-agent/desk/inbox.jsonl', [{ from: 't1', kind: 'report', text: 'first\nlast line one' }, { from: 't2', kind: 'report', text: 'other' }].map(x => JSON.stringify(x)).join('\n') + '\n')
  h.files.set('/h/.lean-agent/todo.json', JSON.stringify([{ text: 'open one', done: false, thread: 't1' }, { text: 'closed', done: true, thread: 't1' }]))
  h.files.set('/h/.lean-agent/threads/t1/brief.md', 'Fix the bug from PR #42 please\n')
  const t = await preflightText(h.host, { id: 't1', cwd: '/r/app', home: '/h' })
  expect(t).toContain('branch: fix-x')
  expect(t).toContain('HEAD: abc1234 add the thing')
  expect(t).toContain('status: 2 changed')
  expect(t).toContain('1 file changed')
  expect(t).toContain('last report: last line one')
  expect(t).toContain('- open one')
  expect(t).not.toContain('closed')
  expect(t).toContain('PR #42')
  expect(t.split('\n').length).toBeLessThanOrEqual(40)
  const bare = fakeHost(null)
  const n = await preflightText(bare.host, { id: 't9', cwd: '/nope', home: '/h' })
  expect(n).toContain('branch: n/a')
  expect(n).toContain('last report: n/a')
  expect(n).toContain('PR / work item: n/a')
})

test('contextstat: tokens by tool and size bucket, top results, delegated against direct, haiku share', () => {
  const use = (id: string, name: string) => ({ type: 'assistant', message: { model: 'claude-sonnet', usage: { output_tokens: 100, input_tokens: 0 }, content: [{ type: 'tool_use', id, name, input: {} }] } })
  const res = (id: string, chars: number) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(chars) }] } })
  const recs = [use('1', 'Read'), res('1', 400), use('2', 'Bash'), res('2', 40_000), use('3', 'Agent'), res('3', 0), use('4', 'Agent'), res('4', 8000), { type: 'assistant', message: { model: 'claude-haiku-5', usage: { output_tokens: 300 }, content: [] } }]
  const s = contextStat(recs)
  expect(s.byTool.Read).toEqual({ calls: 1, tokens: 100 })
  expect(s.byTool.Bash!.tokens).toBe(10_000)
  expect(s.byTool.Agent!.calls).toBe(2)
  expect(s.delegated).toBe(2000)
  expect(s.direct).toBe(10_100)
  expect(s.top[0]).toMatchObject({ tool: 'Bash', tokens: 10_000 })
  expect(s.buckets).toEqual({ '<1k': 2, '1-5k': 1, '5-20k': 1, '>20k': 0 })
  expect(Math.abs(s.haikuShare - 300 / 700)).toBeLessThan(1e-9)
  expect(bucketOf(25_000)).toBe('>20k')
  const many = contextStat(Array.from({ length: 30 }, (_, i) => [use(`a${i}`, 'Read'), res(`a${i}`, 100 + i)]).flat())
  expect(many.top).toHaveLength(10)
  expect(contextStat([]).haikuShare).toBe(0)
  expect(contextText(s)).toContain('delegated (Agent results)')
  expect(contextText(s)).toContain('haiku share of model tokens: 43%')
})

// ---- wiring of the other 1.0.15 changes under the orchestrate rules ------------------------------------------------------------------------
test('a thread (a review thread too) keeps what the store-as-memory, review and MCP changes need: lean_thread find/ask/report/dismiss, lean_run, lean_review, reviewer passes, read-only git', () => {
  orchReset()
  for (const tool of ['lean_thread', 'lean_run', 'lean_review', 'lean_report', 'lean_ask', 'lean_doctor']) expect(call(th, { tool: `mcp__lean-agent__${tool}` })).toBeNull()
  // the review skill: git rev-parse / branch / diff --stat, then the reviewer agent with its allow-cmd lines (it is not a small worker: no brief limit, no why-sonnet)
  for (const command of ['git rev-parse HEAD', 'git branch --show-current', 'git -C /r/app diff main...HEAD --stat', 'git -C /r/app log --oneline -3']) expect(call(th, { tool: 'Bash', command })).toBeNull()
  const longPrompt = 'review this diff\nallow-cmd: git -C /r/app diff main...HEAD\n' + 'x'.repeat(4000)
  expect(call(th, { tool: 'Agent', subagent_type: 'lean-agent:reviewer', prompt: longPrompt, model: 'sonnet' })).toBeNull()
  expect(call(th, { tool: 'Agent', subagent_type: 'lean-agent:reviewer', prompt: longPrompt, model: 'sonnet' })).toBeNull() // the second-opinion pass: the same prompt again is not a retry of a worker job
  expect(call({ ...th, agentType: 'lean-agent:reviewer', agentId: 'r1' }, { tool: 'Bash', command: 'git -C /r/app diff main...HEAD' })).toBeNull() // the reviewer's own calls are not step-budgeted
  // an MCP reader worker: granted through the brief, counted like any worker
  expect(call(th, { tool: 'Agent', subagent_type: 'lean-agent:reader-mcp', prompt: 'job: lookup\nallow-mcp: datadog\nlatest error rate?' })).toBeNull()
  expect(call({ ...worker, agentType: 'lean-agent:reader-mcp' }, { tool: 'mcp__datadog__query' })).toBeNull()
})

test('the preflight pack is in the handover once connected (setPreflight(preflightFor) in register.tsx): the thread\'s project checkout is read, nothing explores', async () => {
  const h = fakeHost(null)
  h.files.set('/h/.lean-agent/config.json', '{"handover":{"mode":"full"}}') // (the full prompt carries the preflight section; core only lists it)
  h.git.handler = (a: string[]) => (a.includes('rev-parse') ? { exitCode: 0, stdout: 'fix-x\n' } : { exitCode: 1, stdout: '' })
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ app: { path: '/r/app' } }))
  const t: any = { id: 't1', title: 'x', project: 'app', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }
  setPreflight(null)
  expect((await buildHandover(h.host, '/h', t, 'restart', [])).prompt).not.toContain('branch: fix-x')
  setPreflight(preflightFor)
  try {
    const ho = await buildHandover(h.host, '/h', t, 'restart', [])
    expect(ho.prompt).toContain('## Preflight')
    expect(ho.prompt).toContain('branch: fix-x')
  } finally {
    setPreflight(null)
  }
})
