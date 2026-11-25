// Job types (jobs.ts): the job line, step budgets by job, the retry rule per (thread, job hash), the return schemas, and the guard wiring.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { decide, parseGrants, recordGrant } from './guard'
import { PARTS, STEPS_BY_JOB, jobHash, jobOf, jobResult, retryDenial, retryRan, retryReset, stepBudget, stepNote, trimJobResult } from './jobs'
import { orchConfig, orchDecide, orchEnd, orchRan, orchReset, takeStepNote } from './orchestrate'

const TDIR = '/h/.lean-agent/threads/t1'
const th = { kind: 'thread', home: '/h', threadDir: TDIR, cwd: '/r/app' } as const
const worker = (job?: string, id = 'w1') => ({ kind: 'thread', home: '/h', threadDir: TDIR, cwd: '/r/app', agentType: 'lean-agent:worker-haiku', agentId: id, job }) as const
const FB = 'LEAN-FEEDBACK {"status": "done", "missing": "", "remember": []}'

test('the job is named by the first non-blank line of the brief; anything else is no job', () => {
  expect(jobOf('job: lookup\nfind x')).toBe('lookup')
  expect(jobOf('\n  Job: EDIT  \nallow-edit: /a')).toBe('edit')
  expect(jobOf('job: run')).toBe('run')
  expect(jobOf('job: check')).toBe('check')
  expect(jobOf('find x\njob: lookup')).toBeNull() // not the first line
  expect(jobOf('job: deploy')).toBeNull()
  expect(jobOf('job: lookup now')).toBeNull()
  expect(jobOf(undefined)).toBeNull()
})

test('step budgets: lookup 12, edit 20, run 6, check 12 (1.0.34: +25%); config per job; workers.steps (24) is the ceiling; no job = the ceiling', () => {
  expect(STEPS_BY_JOB).toEqual({ lookup: 12, edit: 20, run: 6, check: 12 })
  expect(orchConfig({}).steps).toBe(24)
  expect(stepBudget('lookup', 24)).toBe(12)
  expect(stepBudget('edit', 24)).toBe(20)
  expect(stepBudget('run', 24)).toBe(6)
  expect(stepBudget('check', 24)).toBe(12)
  expect(stepBudget('edit', 6)).toBe(6) // the ceiling wins
  expect(stepBudget('edit', 24, { edit: 18 })).toBe(18)
  expect(stepBudget('edit', 10, { edit: 12 })).toBe(10)
  expect(stepBudget('edit', 24, { edit: 40 })).toBe(24)
  expect(stepBudget('lookup', 24, { lookup: 0 })).toBe(12) // junk: the built-in
  expect(stepBudget(undefined, 24)).toBe(24)
  expect(stepBudget('nonsense', 24)).toBe(24)
  expect(orchConfig({ workers: { stepsByJob: { run: 2, edit: 'x', lookup: 4.9, other: 3 } } }).stepsByJob).toEqual({ run: 2, lookup: 4 })
  expect(orchConfig({ workers: { requireJob: true } }).requireJob).toBe(true)
})

test('guard: a worker is refused at its job budget with the schema line; a job-less worker keeps workers.steps', () => {
  orchReset()
  const c = orchConfig({})
  for (let i = 0; i < 6; i++) expect(orchDecide(c, worker('run', 'r1'), { tool: 'Bash' })).toBeNull()
  const refused = orchDecide(c, worker('run', 'r1'), { tool: 'Bash' })
  expect(refused).toContain('step budget of a run job (6 tool calls)')
  expect(refused).toContain('run schema')
  for (let i = 0; i < 12; i++) expect(orchDecide(c, worker('lookup', 'l1'), { tool: 'Read' })).toBeNull()
  expect(orchDecide(c, worker('lookup', 'l1'), { tool: 'Read' })).toContain('lookup job (12')
  for (let i = 0; i < 20; i++) expect(orchDecide(c, worker('edit', 'e1'), { tool: 'Read' })).toBeNull()
  expect(orchDecide(c, worker('edit', 'e1'), { tool: 'Read' })).toContain('edit job (20')
  for (let i = 0; i < 12; i++) expect(orchDecide(c, worker('check', 'c1'), { tool: 'Read' })).toBeNull()
  expect(orchDecide(c, worker('check', 'c1'), { tool: 'Read' })).toContain('check job (12')
  for (let i = 0; i < 24; i++) expect(orchDecide(c, worker(undefined, 'n1'), { tool: 'Read' })).toBeNull()
  expect(orchDecide(c, worker(undefined, 'n1'), { tool: 'Read' })).toContain('split')
  const low = orchConfig({ workers: { steps: 2 } }) // the ceiling is below the job budget: the general refusal
  expect(orchDecide(low, worker('edit', 'e2'), { tool: 'Read' })).toBeNull()
  expect(orchDecide(low, worker('edit', 'e2'), { tool: 'Read' })).toBeNull()
  expect(orchDecide(low, worker('edit', 'e2'), { tool: 'Read' })).toContain('split')
})

test('at 75% of the budget the worker\'s next tool result carries "N tool calls left: finish and answer"; the refusal stays at the budget', () => {
  orchReset()
  const c = orchConfig({})
  const lines: (string | null)[] = []
  for (let i = 1; i <= 20; i++) {
    expect(orchDecide(c, worker('edit', 'e9'), { tool: 'Read' })).toBeNull()
    lines.push(takeStepNote('e9'))
  }
  expect(lines.slice(0, 14).every(l => l === null)).toBe(true) // calls 1..14
  expect(lines[14]).toBe('5 tool calls left: finish and answer') // call 15 = 75% of 20
  expect(lines.slice(15, 18)).toEqual([null, null, null])
  expect(lines[18]).toBe('1 tool call left: finish and answer')
  expect(lines[19]).toBeNull() // the last allowed call: nothing is left to say
  expect(orchDecide(c, worker('edit', 'e9'), { tool: 'Read' })).toContain('edit job (20')
  expect(takeStepNote('e9')).toBeNull()
  expect(takeStepNote('e9')).toBeNull() // said once per call
  expect(stepNote(5, 6)).toBe('1 tool call left: finish and answer') // run job: 75% of 6 is call 5
  expect(stepNote(8, 10)).toBe('2 tool calls left: finish and answer')
  expect(stepNote(3, 4)).toBe('1 tool call left: finish and answer')
  expect(stepNote(1, 1)).toBeNull()
})

test('the job type of the brief reaches the worker through its grant record (parseGrants, recordGrant)', async () => {
  expect(parseGrants('job: edit\nallow-edit: /a').job).toBe('edit')
  expect(parseGrants('find x').job).toBeUndefined()
  const h = fakeHost(null, { orchestrate: true })
  const role = { kind: 'thread', id: 't1' } as const
  await recordGrant(h.host, role, 'c1', 'lean-agent:worker-haiku', parseGrants('job: run\nnpm test'))
  const ctx = { role, cwd: '/r/app', agentType: 'lean-agent:worker-haiku', agentId: 'wq' }
  orchReset()
  for (let i = 0; i < 6; i++) expect(await decide(h.host, ctx, { tool: 'Bash', command: 'ls /r/app' })).toBeNull()
  expect(await decide(h.host, ctx, { tool: 'Bash', command: 'ls /r/app' })).toContain('run job')
})

test('retries: counted only when a worker ran (retryRan): the second identical brief needs why-sonnet, the third is refused; a changed brief starts again; threads are separate', () => {
  retryReset()
  const brief = 'job: lookup\nwhere is X defined'
  expect(retryDenial('t1', brief)).toBeNull()
  expect(retryDenial('t1', brief)).toBeNull() // checking again counts nothing (an issued call that never ran uses no try)
  retryRan('t1', brief)
  expect(retryDenial('t1', brief)).toContain('change the brief')
  expect(retryDenial('t1', `${brief}\nwhy-sonnet: haiku found nothing`)).toBeNull() // the second, escalated
  retryRan('t1', `${brief}\nwhy-sonnet: haiku found nothing`)
  const third = retryDenial('t1', `${brief}\nwhy-sonnet: again`)
  expect(third).toContain('split the job differently or report blocked')
  expect(retryDenial('t1', brief)).toContain('split the job differently')
  expect(retryDenial('t1', 'job: lookup\nwhere is Y defined')).toBeNull()
  expect(retryDenial('t2', brief)).toBeNull()
  expect(jobHash('a  b\nwhy-sonnet: z')).toBe(jobHash('A b'))
  expect(jobHash('a b')).not.toBe(jobHash('a c'))
})

test('Agent calls through the guard: a call that never ran takes no try and (once ended) no slot; requireJob refuses a brief without a job line', () => {
  orchReset()
  const c = orchConfig({ threads: { workers: 1 } })
  const sub = (s: string) => ({ tool: 'Agent', subagent_type: s })
  const ag = (prompt: string, s = 'lean-agent:worker-haiku', cfg = c) => orchDecide(cfg, th, { ...sub(s), prompt })
  const ran = (prompt: string, s = 'lean-agent:worker-haiku') => { orchRan(th, { ...sub(s), prompt }); orchEnd(th, sub(s)) }
  expect(ag('job: lookup\nq')).toBeNull()
  orchEnd(th, sub('lean-agent:worker-haiku')) // rejected before it ran: ended, not counted
  expect(ag('job: lookup\nq')).toBeNull() // the identical reissue is allowed
  ran('job: lookup\nq') // it ran
  expect(ag('job: lookup\nq')).toContain('already ran once')
  expect(ag('job: lookup\nq\nwhy-sonnet: haiku missed it', 'lean-agent:worker-sonnet')).toBeNull() // the escalation: sonnet, same brief
  ran('job: lookup\nq\nwhy-sonnet: haiku missed it', 'lean-agent:worker-sonnet')
  expect(ag('job: lookup\nq\nwhy-sonnet: x', 'lean-agent:worker-sonnet')).toContain('report blocked')
  expect(ag('job: lookup\nq2')).toBeNull() // the refusals above did not hold the one slot
  orchEnd(th, sub('lean-agent:worker-haiku'))
  const strict = orchConfig({ workers: { requireJob: true } })
  expect(ag('find x', 'lean-agent:reader-haiku', strict)).toContain('job: lookup|edit|run|check')
  expect(ag('job: check\nrun x', 'lean-agent:reader-haiku', strict)).toBeNull()
})

test('lookup schema: answer (<= 20 lines) + refs; a conforming result is untouched, the rest is trimmed and marked', () => {
  const ok = `answer:\nX is defined in a.ts\nrefs: a.ts:10, b.ts:3\n${FB}`
  expect(trimJobResult('lookup', ok)).toEqual({ text: ok, trimmed: false })
  const long = Array.from({ length: 40 }, (_, i) => `line ${i + 1} see c.ts:${i + 1}`).join('\n')
  const t = trimJobResult('lookup', `${long}\n${FB}`)
  expect(t.trimmed).toBe(true)
  expect(t.text).toContain('line 20')
  expect(t.text).not.toContain('line 21')
  expect(t.text).toContain('refs: c.ts:1, c.ts:2')
  expect(t.text).toContain(`[lean-agent: result outside the lookup schema, trimmed to ${PARTS.lookup}]`)
  expect(t.text.trimEnd().endsWith(FB)).toBe(true) // the feedback line stays last
  expect(trimJobResult('lookup', 'nothing found').text).toContain('refs: none')
})

test('edit schema: files, diffstat, pass|fail, one-line note', () => {
  const ok = 'files: a.ts, b.ts\ndiffstat: 2 files changed, 5 insertions(+), 1 deletion(-)\nresult: pass\nnote: renamed foo to bar'
  expect(trimJobResult('edit', ok).trimmed).toBe(false)
  const t = trimJobResult('edit', 'Done! I renamed foo to bar everywhere.\nfiles:\n- a.ts\n- b.ts\n 2 files changed, 5 insertions(+), 1 deletion(-)\nAll tests pass.\nmore chatter\nmore chatter')
  expect(t.trimmed).toBe(true)
  expect(t.text).toContain('files: a.ts, b.ts')
  expect(t.text).toContain('diffstat: 2 files changed')
  expect(t.text).toContain('result: pass')
  expect(t.text).toContain('note: Done! I renamed foo to bar everywhere.')
  expect(t.text.split('\n').filter(l => !l.startsWith('[lean-agent')).length).toBe(4)
  expect(trimJobResult('edit', `could not\n${FB.replace('done', 'failed')}`).text).toContain('result: fail')
})

test('edit schema carries the worker\'s own commit: sha + diffstat, no sha line when it did not commit', () => {
  const sha = 'files: a.ts, b.ts\ndiffstat: 2 files changed, 5 insertions(+), 1 deletion(-)\nsha: 3f9c2ab\nresult: pass\nnote: committed'
  expect(trimJobResult('edit', sha).trimmed).toBe(false) // already in the schema
  const t = trimJobResult('edit', `Done.\nfiles: a.ts\n 1 file changed, 2 insertions(+)\nsha: 3F9C2AB1 (branch fix-x)\nresult: pass\nnote: ok\nextra chatter\nmore`)
  expect(t.text).toContain('sha: 3f9c2ab1\n')
  expect(t.text).not.toContain('branch fix-x')
  const none = trimJobResult('edit', 'files: a.ts\ndiffstat: 1 file changed\nresult: fail\nnote: test failed, no commit\nmore\nmore')
  expect(none.text).not.toContain('sha:') // a failing test means no commit and no sha line
  expect(PARTS.edit).toContain('sha')
})

test('run and check schema: pass|fail and at most 20 lines', () => {
  expect(trimJobResult('run', 'result: pass\nall 12 ok').trimmed).toBe(false)
  const noisy = ['FAIL a.test.ts', ...Array.from({ length: 60 }, (_, i) => `log ${i}`)].join('\n')
  const t = trimJobResult('check', noisy)
  expect(t.trimmed).toBe(true)
  expect(t.text).toContain('result: fail')
  expect(t.text).toContain('log 18')
  expect(t.text).not.toContain('log 19')
  expect(t.text).toContain('check schema')
  expect(trimJobResult('run', 'ok, everything passed').text.startsWith('result: pass')).toBe(true)
})

test('jobResult trims the first text block of an Agent result, keeps its shape, and leaves errors, denials and job-less briefs alone', () => {
  const verbose = Array.from({ length: 30 }, (_, i) => `row ${i}`).join('\n')
  const r = { result: { content: [{ type: 'text', text: verbose }, { type: 'text', text: 'agentId: a1' }] } }
  const out = jobResult(r, 'run')
  expect(out.result.content[0].text).toContain('result:')
  expect(out.result.content[0].text.split('\n').length).toBeLessThan(26)
  expect(out.result.content[1].text).toBe('agentId: a1')
  expect(jobResult(r, null)).toBe(r)
  const err = { result: 'boom', isError: true }
  expect(jobResult(err, 'run')).toBe(err)
  const deny = { deny: 'no' }
  expect(jobResult(deny, 'run')).toBe(deny)
  expect(jobResult({ result: `answer:\nx\nrefs: a:1` }, 'lookup').result).toBe('answer:\nx\nrefs: a:1')
  expect(typeof jobResult({ result: 'plain text only' }, 'lookup').result).toBe('string')
})
