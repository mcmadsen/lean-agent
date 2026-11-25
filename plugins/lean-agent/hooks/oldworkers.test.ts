// A restarted session never waits for what the previous session started (oldworkers.ts, 1.0.35): the checkpoint continue text and the handover. Synthetic ids and names only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { resetActivity } from './threadstate'
import { checkpointTick, requestCheckpoint, restartInstruction } from './checkpoint'
import { buildHandover } from './handover'
import { GENERIC_NOTE, continueText, oldWorkersNote, readWorkers, waitsForWorker, writeWorkers } from './oldworkers'
import { liveWorkers, orchEnd, orchReset } from './orchestrate'

const S1 = '11111111-2222-3333-4444-555555555555'
const L = '/h/.lean-agent'
const T1 = `${L}/threads/t1`
const T0 = 10_000_000
const row = (o: Record<string, unknown> = {}) => ({ sid: S1, name: '', cwd: T1, status: 'idle', state: 'idle', startedAt: 1, pid: 42, id: 'abcd1234', waitingFor: '', ...o }) as any
const W = { id: 'a7f3c91d02b4e5f60', type: 'worker-haiku' }
const WAIT = 'Wait for worker a7f3c91d02b4e5f60 to finish the parser edit, then run the specs'

function setup(files: Record<string, string> = {}) {
  resetActivity()
  const h = fakeHost(null)
  h.clock.t = T0
  h.files.set(`${T1}/thread.json`, JSON.stringify({ id: 't1', title: 'fix login', project: 'app', state: 'open', sid: S1, created: 1, lastWake: T0 - 3_600_000, delivered: 0 }))
  h.files.set(`${T1}/brief.md`, 'fix the login bug\n')
  for (const [k, v] of Object.entries(files)) h.files.set(k, v)
  return h
}

test('waitsForWorker: waiting for a worker, agent, background job or monitor; a plain step is not', () => {
  for (const t of [WAIT, 'wait for the background job to finish', 'waiting on the monitor', 'until the subagent returns, do nothing', 'the worker finishes, then merge', 'Await the agent result', 'hold off until the build is done']) expect([t, waitsForWorker(t)]).toEqual([t, true])
  for (const t of ['run the parser specs for step 4, then open the draft PR', 'wait, no: rename the file first', 'start a worker for the docs', 'read notes.md', '', undefined]) expect([t, waitsForWorker(t)]).toEqual([t, false])
})

test('the note names the worker, says it cannot report, and gives the two ways out: its result file or a new worker', () => {
  const dir = '/h/.lean-agent/threads/t1'
  const n = oldWorkersNote([W], dir)
  expect(n).toBe(`worker a7f3c91d02b4e5f60 (worker-haiku) belonged to the previous session and cannot report to you: read its result file if it left one (${dir}/scratch/*-4e5f60.md) or redo that step with a new worker; never wait for it.`)
  expect(oldWorkersNote([], dir)).toBe('')
  expect(oldWorkersNote(undefined, dir)).toBe('')
  expect(oldWorkersNote([W, { id: 'b1' }], dir)).toContain('worker a7f3c91d02b4e5f60 (worker-haiku), worker b1 belonged to the previous session')
})

test('the continue text: plain when nothing is running or waited for; with the note when the old session had a running worker or the step waits for one', () => {
  const dir = '/h/.lean-agent/threads/t1'
  expect(continueText('run the parser specs', [], dir)).toBe('Continue now with: run the parser specs')
  expect(restartInstruction('run the parser specs')).toBe('Continue now with: run the parser specs') // the old call shape
  const t = continueText(WAIT, [W], dir)
  expect(t).toContain(`Your previous session's next step was: ${WAIT}`)
  expect(t).toContain('belonged to the previous session and cannot report to you')
  expect(t).not.toContain('Continue now with:') // it does not tell the new session to wait
  expect(continueText(WAIT, [], dir)).toContain(GENERIC_NOTE) // the step waits, no worker was known: the generic words
  expect(continueText('run the specs', [W], dir)).toContain('belonged to the previous session') // a running worker the step does not mention
})

test('liveWorkers: a background launch holds a slot with its type until the subagent ends; another thread\'s are not listed', () => {
  orchReset()
  orchEnd({ kind: 'thread', home: '/h', threadDir: T1, cwd: '/r' }, { tool: 'Agent', subagent_type: 'lean-agent:worker-haiku' }, { async: true, agentId: 'agent-1' })
  orchEnd({ kind: 'thread', home: '/h', threadDir: `${L}/threads/t2`, cwd: '/r' }, { tool: 'Agent', subagent_type: 'lean-agent:worker-haiku' }, { async: true, agentId: 'agent-2' })
  expect(liveWorkers(T1)).toEqual([{ id: 'agent-1', type: 'worker-haiku' }])
  expect(liveWorkers(`${L}/threads/t9`)).toEqual([])
  orchReset()
})

test('workers.json is believed only for the session that wrote it', async () => {
  const h = setup()
  await writeWorkers(h.host, 't1', S1, [W])
  expect(await readWorkers(h.host, '/h', 't1', S1)).toEqual([W])
  expect(await readWorkers(h.host, '/h', 't1', 'another-session')).toEqual([])
  await writeWorkers(h.host, 't1', S1, [])
  expect(await readWorkers(h.host, '/h', 't1', S1)).toEqual([])
})

test('a checkpoint made while a worker of the old session ran: the restart text tells the new session it cannot wait for it', async () => {
  const h = setup({ [`${T1}/scratch/notes.md`]: '## a\nx' })
  await writeWorkers(h.host, 't1', S1, [W])
  const r = await requestCheckpoint(h.host, 't1', { sid: S1, next: WAIT, source: 'call', tokens: 85_000 })
  expect(r.ok).toBe(true)
  expect(JSON.parse(h.files.get(`${T1}/checkpoint.json`)!).workers).toEqual([W])
  h.clock.t = T0 + 11_000
  const calls: unknown[][] = []
  const notes = await checkpointTick(h.host, { agents: async () => [row()], restart: async (...a: unknown[]) => (calls.push(a), { ok: true, text: 'x', data: { fresh: true } }) })
  expect(notes).toHaveLength(1)
  const text = String(calls[0]![3])
  expect(text).toContain(`Your previous session's next step was: ${WAIT}`)
  expect(text).toContain('worker a7f3c91d02b4e5f60 (worker-haiku) belonged to the previous session and cannot report to you')
  expect(text).toContain('redo that step with a new worker')
  expect(text).not.toMatch(/^Continue now with: Wait/)
})

test('a checkpoint whose step waits for a worker nobody recorded gets the generic words; without workers or a wait the text is as before', async () => {
  const h = setup({ [`${T1}/scratch/notes.md`]: '## a\nx' })
  await requestCheckpoint(h.host, 't1', { sid: S1, next: 'wait for the background job to finish, then merge', source: 'call', tokens: 85_000 })
  h.clock.t = T0 + 11_000
  const calls: unknown[][] = []
  const deps = { agents: async () => [row()], restart: async (...a: unknown[]) => (calls.push(a), { ok: true, text: 'x', data: { fresh: true } }) }
  await checkpointTick(h.host, deps)
  expect(String(calls[0]![3])).toContain(GENERIC_NOTE)
  const h2 = setup({ [`${T1}/scratch/notes.md`]: '## a\nx' })
  await requestCheckpoint(h2.host, 't1', { sid: S1, next: 'run the parser specs', source: 'call', tokens: 85_000 })
  h2.clock.t = T0 + 11_000
  const c2: unknown[][] = []
  await checkpointTick(h2.host, { ...deps, restart: async (...a: unknown[]) => (c2.push(a), { ok: true, text: 'x', data: { fresh: true } }) })
  expect(c2[0]![3]).toBe('Continue now with: run the parser specs')
})

test('a handover of a thread whose session had a running worker (the limit restart, a stall restart, a restart from the pane) says the worker cannot report', async () => {
  const h = setup()
  await writeWorkers(h.host, 't1', S1, [W])
  const t = JSON.parse(h.files.get(`${T1}/thread.json`)!)
  for (const mode of ['core', 'full'] as const) {
    const ho = await buildHandover(h.host, '/h', t, 'Its previous session stalled.', [], false, mode)
    expect(ho.prompt, mode).toContain('worker a7f3c91d02b4e5f60 (worker-haiku) belonged to the previous session and cannot report to you')
    expect(ho.prompt, mode).toContain('never wait for it')
  }
  await writeWorkers(h.host, 't1', S1, [])
  expect((await buildHandover(h.host, '/h', t, 'x', [], false, 'core')).prompt).not.toContain('belonged to the previous session')
  await writeWorkers(h.host, 't1', 'another-session', [W]) // a record of another session: not this one's
  expect((await buildHandover(h.host, '/h', t, 'x', [], false, 'core')).prompt).not.toContain('belonged to the previous session')
})
