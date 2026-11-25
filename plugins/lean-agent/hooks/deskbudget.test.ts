// The cheaper desk (1.0.31): the restart limit config desk.contextLimit (default 60000) and the desk handover trimmed to the open items, the thread table and an index
// (handover.mode core, the default) against the full form. The sizes are printed (chars / 4 = tokens) for the README.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { DEFAULT_TOKENS, deskHandover, deskTokens } from './deskcompact'

const L = '/h/.lean-agent'

test('the desk limit: desk.contextLimit (nested or flat) wins over the older deskTokens, default 200000 (1.0.33), a bad value is ignored', async () => {
  const h = fakeHost(null)
  expect(DEFAULT_TOKENS).toBe(200_000)
  expect(await deskTokens(h.host)).toBe(200_000)
  h.files.set(`${L}/config.json`, JSON.stringify({ deskTokens: 90_000 }))
  expect(await deskTokens(h.host)).toBe(90_000) // an explicit older key still counts
  h.files.set(`${L}/config.json`, JSON.stringify({ deskTokens: 90_000, desk: { contextLimit: 50_000 } }))
  expect(await deskTokens(h.host)).toBe(50_000)
  h.files.set(`${L}/config.json`, JSON.stringify({ 'desk.contextLimit': 70_000 }))
  expect(await deskTokens(h.host)).toBe(70_000)
  h.files.set(`${L}/config.json`, JSON.stringify({ desk: { contextLimit: 'lots' } }))
  expect(await deskTokens(h.host)).toBe(200_000)
  h.files.set(`${L}/config.json`, JSON.stringify({ desk: { contextLimit: 5_000 } }))
  expect(await deskTokens(h.host)).toBe(200_000)
})

function busyDesk() {
  const h = fakeHost(null)
  const goals: Record<string, { text: string }> = {}
  const inbox: string[] = []
  for (let i = 1; i <= 12; i++) {
    const id = `t${i}`
    h.files.set(`${L}/threads/${id}/thread.json`, JSON.stringify({ id, title: `Work item number ${i}: rework the shop checkout totals and the invoice export`, project: 'shop-app', state: i % 5 === 0 ? 'parked' : 'open', sid: `s${i}`, created: 1, lastWake: 1, delivered: 0 }))
    goals[id] = { text: `Goal of ${id}: bring the invoice export to the new totals, keep the old column order, add a migration test and a rollback note for the finance team` }
    inbox.push(JSON.stringify({ ts: 100 + i, from: id, kind: 'report', state: 'working', text: `Step ${i} done: changed the totals module and its tests, 41 passing; next the export step that reads the rounding mode from the settings and writes it to the file header for the finance team` }))
  }
  h.files.set(`${L}/goals.json`, JSON.stringify(goals))
  h.files.set(`${L}/desk/inbox.jsonl`, inbox.join('\n') + '\n')
  h.files.set(`${L}/memory/notes.jsonl`, Array.from({ length: 7 }, (_, i) => JSON.stringify({ ts: i, text: `remember ${i}` })).join('\n') + '\n')
  const recent = Array.from({ length: 6 }, (_, i) => `the user's message number ${i}: please keep the invoice export column order and tell me before any push, I prefer short answers`)
  return { h, recent }
}

test('desk handover core: open items, the thread table and an index; the goals section and the user\'s last words stay in their files; far smaller than full', async () => {
  const { h, recent } = busyDesk()
  const core = await deskHandover(h.host, 58_000, recent, 'dsk1', 'core')
  const full = await deskHandover(h.host, 58_000, recent, 'dsk1', 'full')
  expect(core).toContain('## Open items\nnone: no unanswered question, pending request, pending approval or grant')
  expect(core).toContain('## Open threads')
  expect(core).toContain('| t1 |')
  expect(core).toContain('## Index (pull what you need')
  expect(core).toContain('remembered items: 7')
  expect(core).toContain('goals: 12 set')
  expect(core).not.toContain('## Goals')
  expect(core).not.toContain("the user's message number 0")
  expect(core).toContain('<!-- lean-agent: written-by-session dsk1 -->') // the writer stays the last line
  expect(core.trimEnd().endsWith('<!-- lean-agent: written-by-session dsk1 -->')).toBe(true)
  expect(full).toContain('## Goals')
  expect(full).toContain("the user's message number 0")
  const tok = (s: string) => Math.round(s.length / 4)
  ;(globalThis as any).console?.log(`desk handover, 12 threads (10 open): full ${tok(full)} tokens, core ${tok(core)} tokens (${Math.round((1 - core.length / full.length) * 100)}% smaller)`)
  expect(core.length).toBeLessThan(full.length * 0.7)
})

test('handover.mode full in config.json gives the full desk handover; core is the default', async () => {
  const { h, recent } = busyDesk()
  expect(await deskHandover(h.host, 0, recent)).toContain('## Index')
  h.files.set(`${L}/config.json`, JSON.stringify({ handover: { mode: 'full' } }))
  const full = await deskHandover(h.host, 0, recent)
  expect(full).toContain('## Goals')
  expect(full).not.toContain('## Index')
})
