// The pane's growth per turn (threadcontext.ts, context.json history) and `lean_doctor context tN`'s top sources (contextstat.ts). Synthetic data only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { ctxView, growthPerTurn, limitsOf, readContext, recordContext, HIST_MAX } from './threadcontext'
import { contextStat, sourcesText, topSources } from './contextstat'

const L = limitsOf(null)
const T1 = { id: 't1', sid: 'sess-x' }

test('growth per turn: the mean of the steps up over the kept turn-end samples; a compaction drop is left out; fewer than two steps is no figure', () => {
  const h = (...t: number[]) => t.map((tokens, i) => ({ at: i, tokens }))
  expect(growthPerTurn(h(80_000, 84_000, 88_000, 92_000, 96_000))).toBe(4_000)
  expect(growthPerTurn(h(80_000, 84_000, 30_000, 36_000))).toBe(5_000)
  expect(growthPerTurn(h(80_000, 84_000))).toBeNull()
  expect(growthPerTurn(h(80_000, 80_100, 80_200))).toBeNull()
  expect(growthPerTurn(undefined)).toBeNull()
  expect(ctxView({ tokens: 96_000, at: 1, sid: 's', hist: h(88_000, 92_000, 96_000) }, L).text).toBe('ctx 96k/120k, +4k/turn')
  expect(ctxView({ tokens: 96_000, at: 1, sid: 's' }, L).text).toBe('ctx 96k/120k')
})

test('context.json keeps the last 20 turn-end samples of the session; a mid-turn write keeps them; another session starts again', async () => {
  const h = fakeHost(null)
  h.clock.t = 1_000
  for (let i = 0; i < 25; i++) {
    h.clock.t += 1_000
    await recordContext(h.host, 't1', 'sess-x', 50_000 + i * 2_000, { sample: true })
  }
  await recordContext(h.host, 't1', 'sess-x', 99_000) // a mid-turn measure: the size only
  const r = (await readContext(h.host, '/h', T1))!
  expect(r.tokens).toBe(99_000)
  expect(r.hist).toHaveLength(HIST_MAX)
  expect(r.hist![HIST_MAX - 1]!.tokens).toBe(50_000 + 24 * 2_000)
  expect(ctxView(r, L).text).toBe('ctx 99k/120k, +2k/turn')
  await recordContext(h.host, 't1', 'sess-y', 10_000, { sample: true })
  expect(JSON.parse(h.files.get('/h/.lean-agent/threads/t1/context.json') as string).hist).toHaveLength(1)
})

test('lean_doctor context tN names the top three sources with one fix each', () => {
  const recs = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Agent' }, { type: 'tool_use', id: 'b', name: 'Bash' }, { type: 'tool_use', id: 'c', name: 'Read' }, { type: 'tool_use', id: 'd', name: 'Grep' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x'.repeat(80_000) }, { type: 'tool_result', tool_use_id: 'b', content: 'x'.repeat(40_000) }, { type: 'tool_result', tool_use_id: 'c', content: 'x'.repeat(20_000) }, { type: 'tool_result', tool_use_id: 'd', content: 'x'.repeat(4_000) }] } },
  ]
  const s = contextStat(recs)
  expect(topSources(s).map(t => t.tool)).toEqual(['Agent', 'Bash', 'Read'])
  const t = sourcesText(s)
  expect(t).toMatch(/1\. Agent: 20\.0k in 1 result\(s\) \(\d+%\) - fix: worker results/)
  expect(t).toMatch(/2\. Bash: .* - fix: pipe long output/)
  expect(t).toMatch(/3\. Read: .* - fix: read with offset and limit/)
  expect(t).not.toContain('Grep')
})
