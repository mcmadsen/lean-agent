import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { readJsonl } from './state'
import { threadTool } from './delivery'
import type { DeskRec } from './delivery'
import { holdSilentEnd, openItemOf, restartWaiting } from './waitrestart'
import { lastActivity, readWaiting, truthOf } from './threadstate'
import { stateOf } from './view'

const H = '/h' // the home the functions take
const HOME = `${H}/.lean-agent`
const T1 = `${HOME}/threads/t1`
const INBOX = `${HOME}/desk/inbox.jsonl`
const jl = (rows: unknown[]) => rows.map(r => JSON.stringify(r)).join('\n') + '\n'
const ASK: DeskRec = { ts: 500, from: 't1', kind: 'ask', text: 'Use postgres or sqlite for the cache?' }

test('restart while waiting with an open item: the item goes back to the desk by script, the prompt says the desk has it open and asks for ONE waiting report', async () => {
  const h = fakeHost(null)
  h.files.set(INBOX, jl([ASK]))
  const lead = await restartWaiting(h.host, H, 't1', [ASK], true)
  expect(lead).toContain("You were waiting for the desk's answer to 500-t1-ask: Use postgres or sqlite for the cache?. The desk has it open.")
  expect(lead).toContain('write ONE report with state `waiting`')
  expect(lead).toContain("'restarted at the context limit; still waiting on 500-t1-ask'")
  expect(lead).not.toContain('do nothing')
  const rows = await readJsonl<Record<string, unknown>>(h.host, INBOX)
  expect(rows[1]).toMatchObject({ kind: 'ask', mod: true, requeued: '500-t1-ask', since: 500 })
  expect(String(rows[1]!.text)).toContain('still waits for your answer')
  expect((await readJsonl<{ question: string }>(h.host, `${HOME}/questions.jsonl`)).map(q => q.question)).toEqual(['Use postgres or sqlite for the cache?']) // a question the list lost is back
  expect(await readWaiting(h.host, H, 't1')).toMatchObject({ since: 500, restarted: 1_000_000 })
  // a preview writes nothing
  const h2 = fakeHost(null)
  expect(await restartWaiting(h2.host, H, 't1', [ASK], true, false)).toContain('500-t1-ask')
  expect(h2.files.get(INBOX)).toBeUndefined()
})

test('restart while waiting with NO open item in the store (a prose request from before the catch): the prompt says to re-send it now; a working thread gets no lead', async () => {
  const h = fakeHost(null)
  const prose: DeskRec = { ts: 700, from: 't1', kind: 'report', state: 'working', text: 'Review recorded. One batch of PR comments for approval; nothing is posted until you approve.' }
  expect(openItemOf([prose], 't1').item).toBeNull()
  const lead = await restartWaiting(h.host, H, 't1', [prose], false)
  expect(lead).toContain('the desk has NO open item for it')
  expect(lead).toContain('Re-send the request now with lean_ask (a question) or lean_report with `action` (a write needing approval)')
  expect(lead).toContain('One batch of PR comments for approval')
  expect(await restartWaiting(fakeHost(null).host, H, 't1', [{ ts: 800, from: 't1', kind: 'report', state: 'working', text: 'Ran the specs; 40 pass. Next the docs.' }], false)).toBeNull()
})

test('a restarted thread reports `waiting` once; without a report the mod writes it; the word stays waiting from the original time, never idle', async () => {
  const h = fakeHost(null)
  h.files.set(INBOX, jl([ASK]))
  await restartWaiting(h.host, H, 't1', [ASK], true)
  // the new session read its handover (activity after the question) and ended its turn silently
  h.clock.t = 1_300_000
  h.files.set(`${T1}/activity.json`, JSON.stringify({ at: 1_290_000, kind: 'tool' }))
  const row = { sid: 's', name: '', cwd: T1, status: 'idle', state: 'idle', startedAt: 1, pid: 42, id: 'a', waitingFor: '' } as any
  const before = truthOf({ threadState: 'open', row, queued: [], now: h.clock.t, activityAt: await lastActivity(h.host, H, 't1'), waitingSince: 500 })
  expect(before.word).not.toBe('waiting') // no hold yet: the session did something after the question
  expect(await holdSilentEnd(h.host, H, 't1')).toBe(true)
  expect(await holdSilentEnd(h.host, H, 't1')).toBe(false) // once
  const rows = await readJsonl<Record<string, unknown>>(h.host, INBOX)
  expect(rows[rows.length - 1]).toMatchObject({ kind: 'report', state: 'waiting', mod: true })
  const w = await readWaiting(h.host, H, 't1')
  const after = truthOf({ threadState: 'open', row, queued: [], now: h.clock.t, activityAt: await lastActivity(h.host, H, 't1'), waitingSince: w!.since })
  expect(after.word).toBe('waiting')
  expect(after.text).toContain('waiting on the desk since')
  expect(stateOf({ run: 'idle', live: 'waiting' } as any)).toEqual({ word: 'waiting for answer', color: 'warning' }) // amber, never idle or done
  // its own `waiting` report: no second question, since kept, held set; a later restart still finds the original open item
  const h2 = fakeHost(null)
  h2.files.set(INBOX, jl([ASK]))
  await restartWaiting(h2.host, H, 't1', [ASK], true)
  h2.clock.t = 1_400_000
  const r = await threadTool(h2.host, 't1', 'lean_report', { text: 'restarted at the context limit; still waiting on 500-t1-ask', state: 'waiting' })
  expect(r.ok).toBe(true)
  expect(await readWaiting(h2.host, H, 't1')).toMatchObject({ since: 500, held: 1_400_000, restarted: 1_000_000 })
  expect(await holdSilentEnd(h2.host, H, 't1')).toBe(false) // it reported: the mod adds nothing
  const recs = await readJsonl<DeskRec>(h2.host, INBOX)
  expect(openItemOf(recs, 't1').item?.id).toBe('500-t1-ask') // the waiting report is not the open item
  expect(h2.files.get(`${HOME}/questions.jsonl`)).toContain('Use postgres') // (from the first restart); the waiting report made no new one
  expect((await readJsonl(h2.host, `${HOME}/questions.jsonl`)).length).toBe(1)
})
