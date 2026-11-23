// `lean_doctor context` for the DESK (contextstat.ts deskStat): what its Messages consist of, from a synthetic transcript. Never any text.
import { expect, test } from 'claude-code/testing'
import { deskStat, deskText, SRC_DESK, SRC_OTHER, SRC_REPORTS, SRC_USER } from './contextstat'

const use = (id: string, name: string, input: unknown, usage?: unknown) => ({ type: 'assistant', timestamp: '2026-01-01T10:00:00Z', message: { model: 'm', ...(usage ? { usage } : {}), content: [{ type: 'tool_use', id, name, input }] } })
const res = (id: string, text: string, timestamp = '2026-01-01T10:00:01Z') => ({ type: 'user', timestamp, message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } })
const prompt = (text: string, timestamp = '2026-01-01T09:00:00Z') => ({ type: 'user', timestamp, message: { content: text } })
const say = (text: string, usage?: unknown) => ({ type: 'assistant', timestamp: '2026-01-01T10:00:02Z', message: { content: [{ type: 'text', text }], ...(usage ? { usage } : {}) } })

const RECS = [
  prompt('x'.repeat(4000)), // the user's long paste: 1000 tokens
  use('a', 'mcp__lean-agent__lean_thread', { action: 'list' }, { input_tokens: 10, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 0 }),
  res('a', 'y'.repeat(8000)), // 2000
  say('z'.repeat(400)), // 100
  prompt('[lean-agent] t3 done: ' + 'r'.repeat(3978), '2026-01-01T11:00:00Z'), // a delivered report: 1000
  use('b', 'mcp__lean-agent__lean_doctor', { action: 'check' }),
  res('b', 'd'.repeat(2000)), // 500
  use('c', 'Bash', { command: 'ls' }),
  res('c', 'o'.repeat(400)), // 100
  use('d', 'mcp__lean-agent__lean_thread', { action: 'send', tN: 't3', text: 'hi' }),
  res('d', 's'.repeat(200)), // 50
  say('done', { input_tokens: 5, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 0 }),
]

test('desk context: tokens by source, lean_thread replies by action, lean_doctor replies, other tool results, prompts, own answers', () => {
  const s = deskStat(RECS)
  expect(s.by[SRC_USER]!.tokens).toBe(1000)
  expect(s.by[SRC_REPORTS]).toEqual({ items: 1, tokens: 1000 })
  expect(s.by['lean_thread list replies']).toEqual({ items: 1, tokens: 2000 })
  expect(s.by['lean_thread send replies']!.tokens).toBe(50)
  expect(s.by['lean_doctor check replies']!.tokens).toBe(500)
  expect(s.by[SRC_OTHER]!.tokens).toBe(100)
  expect(s.by[SRC_DESK]!.tokens).toBeGreaterThan(100) // the answers and the tool calls' own text
  expect(s.turns).toBe(2) // the paste and the delivered report each started a turn
})

test('desk context: the ten largest items carry kind and time, never their text; growth per turn', () => {
  const s = deskStat(RECS)
  expect(s.top[0]).toEqual({ kind: 'lean_thread list replies', tokens: 2000, at: '2026-01-01T10:00:01Z' })
  expect(s.top.length).toBeLessThanOrEqual(10)
  expect(s.perTurn).toBeGreaterThan(0)
  expect(s.sizeFirst).toBe(20_010)
  expect(s.sizeLast).toBe(30_005)
  const text = deskText(s, 'desk.jsonl ')
  expect(text).toContain('lean_thread replies together')
  expect(text).toContain('ten largest items')
  expect(text).toContain('growth per turn')
  expect(text).not.toContain('rrrr') // no item text is ever printed
  expect(text).not.toContain('yyyy')
  expect(deskText(deskStat([]))).toContain('none')
})

test('desk context: a damaged or sidechain record is skipped, a report arriving as an attachment counts as a delivered report', () => {
  const s = deskStat([null, { type: 'user' }, { type: 'user', isSidechain: true, message: { content: 'q'.repeat(4000) } }, { type: 'attachment', attachment: { content: '[lean-agent] t1 done: ' + 'a'.repeat(78) } }])
  expect(s.by[SRC_USER]).toBeUndefined()
  expect(s.by[SRC_REPORTS]!.tokens).toBe(25)
})
