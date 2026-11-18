import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { CHASE_TEXT, chase } from './chaser'
import { greenReview, writeReview } from './reviews'
import { decide } from './guard'

const HOUR = 60 * 60_000
function setup() {
  const h = fakeHost(null)
  h.clock.t = 10 * HOUR
  h.files.set('/h/.lean-agent/goals.json', JSON.stringify({ t1: { text: 'a', ts: 1 }, t2: { text: 'b', ts: 9 * HOUR + 1 }, t3: { text: 'c', ts: 1 }, t4: { text: 'd', ts: 1 } }))
  for (const [id, state] of [['t1', 'open'], ['t2', 'open'], ['t3', 'open'], ['t4', 'closed']]) h.files.set(`/h/.lean-agent/threads/${id}/thread.json`, JSON.stringify({ id, state, sid: 's' + id }))
  h.files.set('/h/.lean-agent/desk/inbox.jsonl', JSON.stringify({ ts: 1, from: 't3', kind: 'ask', text: 'q?' }) + '\n')
  return h
}

test('chaser pings a stale open thread once; fresh, asking and closed ones are left alone', async () => {
  const h = setup()
  const sent: [string, string][] = []
  expect(await chase(h.host, async (id, t) => void sent.push([id, t]))).toEqual(['t1'])
  expect(sent).toEqual([['t1', CHASE_TEXT]])
  expect(await chase(h.host, async (id, t) => void sent.push([id, t]))).toEqual([])
  h.clock.t += 2 * HOUR
  expect(await chase(h.host, async () => undefined)).toContain('t1')
})

test('a green review record unlocks the push guard for that sha only', async () => {
  const h = fakeHost(null)
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ proj: { path: '/w/proj' } }))
  const sha = 'a'.repeat(40)
  h.git.handler = a => ({ exitCode: 0, stdout: a.includes('rev-parse') ? sha + '\n' : '' })
  const ctx = { role: { kind: 'plain' } as any, cwd: '/w/proj' }
  const push = { tool: 'Bash', command: 'git push origin main' }
  expect(await decide(h.host, ctx, push)).toContain('no green review')
  await writeReview(h.host, { green: false, sha, project: 'proj' })
  expect(await decide(h.host, ctx, push)).toContain('no green review')
  await writeReview(h.host, { green: true, sha, project: 'proj', passes: 2 })
  expect(await decide(h.host, ctx, push)).toBeNull()
  h.git.handler = a => ({ exitCode: 0, stdout: a.includes('rev-parse') ? 'b'.repeat(40) + '\n' : '' })
  expect(await decide(h.host, ctx, push)).toContain('no green review')
  await expect(writeReview(h.host, { green: true, sha: 'zz', project: 'proj' })).rejects.toThrow()
})
