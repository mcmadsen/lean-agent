import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { resetLocks } from './threads'

async function threadSession($: any, on: any, hooks: () => void) {
  const h = fakeHost(on)
  hooks() // hooks beneath the plugin must exist before the first $ call
  resetLocks()
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', title: 'x', project: 'proj', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/h/.lean-agent/threads/t1', surface: 'desktop', isInteractive: true } as any)
  return h
}

test('a worker reply with LEAN-FEEDBACK files its missing context and memory', async ($, on) => {
  const h = await threadSession($, on, () => on('tool.call', () => ({ result: 'did it\nLEAN-FEEDBACK {"status":"done","missing":"build flags for src/a/b.ts","remember":["use pnpm"]}' })))
  await $.tool.call({ tool: 'Agent', prompt: 'x' } as any)
  expect(h.files.get('/h/.lean-agent/proj/gaps.jsonl')).toContain('src/a/b.ts')
  expect(h.files.get('/h/.lean-agent/memory/notes.jsonl')).toContain('use pnpm')
})

test('turn.step writes a ledger row and refuses past the daily cap', async ($, on) => {
  const h = await threadSession($, on, () =>
    on('turn.step', async function* (_: any, e: any) {
      return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: { model: 'haiku', input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as any
    }),
  )
  h.files.set('/h/.lean-agent/config.json', JSON.stringify({ dailyCapUsd: { thread: 1 } }))
  const step = async (i: number) => {
    const st = $.turn.step({ turnId: 't', index: i, model: 'haiku', messageCount: 1 } as any)
    for (;;) {
      const n = await st.next()
      if (n.done) return n.value
    }
  }
  const a: any = await step(0)
  expect(a.answer).toBe('ok')
  expect(h.files.get('/h/.lean-agent/ledger.jsonl')).toContain('"usd":1')
  const b: any = await step(1)
  expect(b.answer).toContain('daily $1.00')
})
