// The desk's own limit in stages (deskcompact.ts): 100k default; from 80% the handover is written and the pane says "restart the desk soon"; at the limit the
// desk's next reply starts with one line saying so (once); desk.autoRestart opens the new desk itself at the end of the turn; the handover is script-built
// and at most 3k tokens. Synthetic data only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { HANDOVER_MAX_CHARS, autoRestartDesk, deskHandover, deskTick, handoverFile, limitLineOnce, resetDeskCompact, soonAt, soonText } from './deskcompact'

const L = '/h/.lean-agent'

function deps(tokens: number, o: { compact?: () => Promise<unknown> } = {}) {
  const seen = { status: [] as string[], compact: 0 }
  return {
    seen,
    d: {
      tokens: async () => tokens,
      busy: () => false,
      compact: async () => {
        seen.compact++
        return o.compact ? o.compact() : { messages: [] }
      },
      notes: async () => undefined,
      recent: async () => ['keep the pane short'],
      sid: () => 'desk-sess-1',
      status: (t: string) => void seen.status.push(t),
      reset: () => undefined,
    },
  }
}
const headless = async () => {
  throw new Error('lean-agent: $.session.compact: not available in a headless (-p / SDK) session yet')
}

function world() {
  resetDeskCompact()
  const h = fakeHost(null)
  h.clock.t = 10_000_000
  h.files.set(`${L}/config.json`, JSON.stringify({ desk: { contextLimit: 100_000, autoRestart: true }, handover: { mode: 'full' } })) // (1.0.33: the opted-in path; the default is deskwarn.test.ts) (60k and the core handover are the defaults since 1.0.31; these cases are written against 100k and the full form)
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', title: 'parser work', project: 'demo', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  return h
}

test('from 80% of the limit the handover is written once (naming the desk session) and nothing is compacted; below 80% nothing is written', async () => {
  const h = world()
  expect(soonAt(100_000)).toBe(80_000)
  expect(await deskTick(h.host, deps(70_000).d)).toBe('quiet')
  expect(h.files.has(handoverFile('/h'))).toBe(false)
  const a = deps(85_000)
  expect(await deskTick(h.host, a.d)).toBe('soon')
  expect(a.seen.compact).toBe(0)
  const text = h.files.get(handoverFile('/h'))!
  expect(text).toContain('# Desk handover')
  expect(text).toMatch(/<!-- lean-agent: written-by-session desk-sess-1 -->\s*$/)
  h.files.delete(handoverFile('/h'))
  expect(await deskTick(h.host, a.d)).toBe('soon')
  expect(h.files.has(handoverFile('/h'))).toBe(false) // once, not at every tick
  expect(limitLineOnce()).toBeNull() // not at the limit yet
  // down again below 80% (a restart, a compaction): the next climb writes it again
  await deskTick(h.host, deps(10_000).d)
  expect(await deskTick(h.host, deps(90_000).d)).toBe('soon')
  expect(h.files.has(handoverFile('/h'))).toBe(true)
})

test('the pane line: amber text from 80% ("desk context N k of L k: restart the desk soon (the handover is ready)"), none below', () => {
  expect(soonText(79_000, 100_000)).toBe('')
  expect(soonText(85_000, 100_000)).toBe('desk context 85k of 100k: restart the desk soon (the handover is ready)')
  expect(soonText(104_000, 100_000)).toBe('desk context 104k of 100k: restart the desk now (the handover is ready)')
  expect(soonText(5, 0)).toBe('')
})

test("at the limit the handover is written and the desk's next reply starts with one line saying so, once", async () => {
  const h = world()
  const a = deps(104_000, { compact: headless })
  expect(await deskTick(h.host, a.d)).toBe('fallback') // the app cannot compact the desk
  expect(h.files.has(handoverFile('/h'))).toBe(true)
  const line = limitLineOnce()!
  expect(line).toContain('Start your next reply with this one line')
  expect(line).toContain('Desk context 104k of 100k: press Restart desk')
  expect(limitLineOnce()).toBeNull() // once
  await deskTick(h.host, a.d)
  expect(limitLineOnce()).toBeNull() // still over: not said again
  // below the limit and over it again (a new climb): said again
  await deskTick(h.host, deps(10_000).d)
  await deskTick(h.host, deps(110_000, { compact: headless }).d)
  expect(limitLineOnce()).toContain('110k of 100k')
})

test('desk.autoRestart: opt-in (1.0.33: off by default, see deskwarn.test.ts); over the limit and with no question open it opens the new desk once; an open question waits; a failure is a notice', async () => {
  const h = world()
  let opened = 0
  const restart = async () => ({ ok: true, text: `opened ${++opened}` })
  h.files.set(`${L}/config.json`, JSON.stringify({ desk: { autoRestart: false } }))
  expect(await autoRestartDesk(h.host, { tokens: 120_000, restart })).toBe('off')
  h.files.set(`${L}/config.json`, JSON.stringify({ desk: { contextLimit: 100_000 } }))
  expect(await autoRestartDesk(h.host, { tokens: 120_000, restart })).toBe('off') // (nothing configured: off)
  h.files.set(`${L}/config.json`, JSON.stringify({ desk: { contextLimit: 100_000, autoRestart: true } }))
  expect(await autoRestartDesk(h.host, { tokens: 70_000, restart })).toBe('none')
  h.files.set(`${L}/questions.jsonl`, `${JSON.stringify({ from: 't1', question: 'which db?' })}\n`)
  expect(await autoRestartDesk(h.host, { tokens: 110_000, restart })).toBe('question')
  expect(opened).toBe(0)
  h.files.set(`${L}/answers.jsonl`, `${JSON.stringify({ q: 1 })}\n`)
  expect(await autoRestartDesk(h.host, { tokens: 120_000, restart })).toBe('restarted')
  expect(await autoRestartDesk(h.host, { tokens: 120_000, restart })).toBe('already')
  expect(opened).toBe(1)
  // a failure leaves a notice and is tried again at the next turn end
  h.clock.t += 31 * 60_000 // (the loop guard: 30 minutes after the last automatic restart)
  resetDeskCompact()
  expect(await autoRestartDesk(h.host, { tokens: 120_000, restart: async () => ({ ok: false, text: 'the Claude app is not running' }) })).toBe('failed')
  expect([...h.files.entries()].some(([k, v]) => /desk-autorestart/.test(k) && /not running/.test(String(v)))).toBe(true)
  expect(await autoRestartDesk(h.host, { tokens: 120_000, restart })).toBe('restarted')
  expect([...h.files.entries()].some(([k]) => /desk-autorestart/.test(k))).toBe(false) // the notice is gone
})

test('the desk handover carries open questions, pending requests, grants and what each open thread is doing, and stays within 3k tokens', async () => {
  const h = world()
  h.files.set(`${L}/questions.jsonl`, `${JSON.stringify({ from: 't1', question: 'which database should the parser use?' })}\n`)
  h.files.set(`${L}/goals.json`, JSON.stringify({ t1: { text: 'make the parser accept the new header form', ts: 1 } }))
  h.files.set(`${L}/threads/t1/state.json`, JSON.stringify({ v: 1, id: 't1', at: 1, sid: 's', dir: '/w', branch: 'fix-x', head: 'abcdef1234', status: [], diffStat: '', edited: [], tasks: [{ text: 'writing the header spec', status: 'in_progress' }], lastReport: null, questions: [], tokens: null }))
  h.files.set(`${L}/desk/inbox.jsonl`, `${JSON.stringify({ ts: 1, from: 't1', kind: 'report', state: 'working', text: 'half way through the parser' })}\n`)
  const text = await deskHandover(h.host, 85_000, ['keep the pane short'], 'desk-sess-1')
  expect(text).toContain('## Unanswered thread questions\n- t1: which database should the parser use?')
  expect(text).toContain('## Pending requests')
  expect(text).toContain('## Grants in force')
  expect(text).toContain('| t1 | parser work | demo | open | writing the header spec |') // what it is doing now: its current task
  expect(text).toContain('[working] half way through the parser')
  expect(text).toContain('make the parser accept the new header form')
  expect(text.length).toBeLessThan(HANDOVER_MAX_CHARS)
  expect(text).toMatch(/<!-- lean-agent: written-by-session desk-sess-1 -->\n$/)
  // many threads with long titles and reports: built again with half the widths, then cut; the writer's line stays last
  const recs: string[] = []
  for (let n = 1; n <= 80; n++) {
    h.files.set(`${L}/threads/t${n}/thread.json`, JSON.stringify({ id: `t${n}`, title: `title ${'x'.repeat(200)}`, project: 'demo', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
    recs.push(JSON.stringify({ ts: n, from: `t${n}`, kind: 'report', state: 'working', text: 'r'.repeat(500) }))
  }
  h.files.set(`${L}/desk/inbox.jsonl`, `${recs.join('\n')}\n`)
  const big = await deskHandover(h.host, 85_000, ['a'.repeat(300), 'b'.repeat(300)], 'desk-sess-1')
  expect(big.length).toBeLessThanOrEqual(HANDOVER_MAX_CHARS)
  expect(big).toMatch(/<!-- lean-agent: written-by-session desk-sess-1 -->\n$/)
  expect(big).toContain('## Unanswered thread questions\n- t1: which database') // the parts that matter come first and survive the cut
})
