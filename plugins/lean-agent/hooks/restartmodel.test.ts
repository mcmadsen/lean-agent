// The model / effort of each session start (thread.json `restarts`, at most 20) and the unfolded card's "last restart: sonnet/high" (restartmodel.ts).
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { MAX_RESTARTS, lastRestartLine, noteRestart } from './restartmodel'
import { loadThreadDetail } from './threaddetail'
import { leanThread, resetLocks } from './threads'

const R = (model: string, effort: string, ts = 1) => ({ model, effort, ts })

test('noteRestart appends, drops junk, caps at 20 and always keeps the first start', () => {
  expect(noteRestart(undefined, R('sonnet', 'medium'))).toEqual([R('sonnet', 'medium')])
  expect(noteRestart([R('haiku', 'low'), { model: 1 }, null, 'x'], R('sonnet', 'high', 2))).toEqual([R('haiku', 'low'), R('sonnet', 'high', 2)])
  let l: any[] = []
  for (let i = 1; i <= 30; i++) l = noteRestart(l, R(i === 1 ? 'haiku' : 'sonnet', 'medium', i))
  expect(l).toHaveLength(MAX_RESTARTS)
  expect(l[0]).toEqual(R('haiku', 'medium', 1)) // the first start stays
  expect(l.at(-1)).toEqual(R('sonnet', 'medium', 30))
  expect(l[1]!.ts).toBe(12) // the 19 newest follow it
})

test('the card line: only when the last restart differs from the first start or from the current model; never for a thread that was only started', () => {
  expect(lastRestartLine({ model: 'sonnet', effort: 'medium' })).toBe('')
  expect(lastRestartLine({ model: 'sonnet', effort: 'medium', restarts: [R('sonnet', 'medium')] })).toBe('')
  expect(lastRestartLine({ model: 'sonnet', effort: 'medium', restarts: [R('sonnet', 'medium'), R('sonnet', 'medium', 2)] })).toBe('') // restarted on the same
  expect(lastRestartLine({ model: 'sonnet', effort: 'high', restarts: [R('sonnet', 'medium'), R('sonnet', 'high', 2)] })).toBe('last restart: sonnet/high') // another effort than the first
  expect(lastRestartLine({ model: 'sonnet', effort: 'high', restarts: [R('haiku', 'low'), R('sonnet', 'high', 2)] })).toBe('last restart: sonnet/high')
  expect(lastRestartLine({ model: 'opus', effort: 'high', restarts: [R('sonnet', 'high'), R('sonnet', 'high', 2)] })).toBe('last restart: sonnet/high') // the current model is another one
  expect(lastRestartLine({ model: 'sonnet', effort: 'high', restarts: [R('sonnet', 'high'), R('haiku', 'low', 2), R('sonnet', 'high', 3)] })).toBe('') // back on the first
})

test('a start and a restart record their model and effort in thread.json; the detail carries the line only when it differs', async () => {
  resetLocks()
  const h = fakeHost(null)
  const T = '/h/.lean-agent/threads/t1'
  h.files.set(`${T}/thread.json`, JSON.stringify({ id: 't1', title: 'x', project: 'app', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ app: { path: '/r/app' } }))
  h.files.set('/p/templates/thread.md', '# {{id}}')
  let n = 0
  h.claude.handler = (argv: string[]) => (argv.includes('agents') ? { exitCode: 0, stdout: '[]' } : { exitCode: 0, stdout: `started 1111111${++n}-aaaa-bbbb-cccc-dddddddddddd` })
  const s = await leanThread(h.host, '/p', { action: 'start', tN: 't1', model: 'haiku', effort: 'low' } as any)
  expect(s.ok).toBe(true)
  const t1 = JSON.parse(h.files.get(`${T}/thread.json`)!)
  expect(t1.restarts).toEqual([{ model: 'haiku', effort: 'low', ts: t1.lastWake }])
  expect((await loadThreadDetail(h.host, 't1'))?.lastRestart).toBeUndefined() // only the first start
  h.clock.t += 1000
  const r = await leanThread(h.host, '/p', { action: 'restart', tN: 't1', model: 'sonnet', effort: 'high' } as any)
  expect(r.ok).toBe(true)
  const t2 = JSON.parse(h.files.get(`${T}/thread.json`)!)
  expect(t2.restarts.map((x: any) => `${x.model}/${x.effort}`)).toEqual(['haiku/low', 'sonnet/high'])
  expect((await loadThreadDetail(h.host, 't1'))?.lastRestart).toBe('last restart: sonnet/high') // differs from the first start
})
