// 1.0.25 the user's own typed prompts (humanprompts.ts): only a prompt the engine stamped as the person's is recorded, for 24 h
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { PROMPT_MAX, isHumanPrompt, recentPrompts, recordHumanPrompt } from './humanprompts'

const HOUR = 3_600_000

test('the person\'s Enter (composer) and the Remote Control bridge are recorded', { timeoutMs: 20_000 }, async () => {
  const h = fakeHost(null)
  expect(await recordHumanPrompt(h.host, { text: 'fix the comments on PR 42', wait: false, origin: { kind: 'composer' } })).toBe(true)
  expect(await recordHumanPrompt(h.host, { text: 'and answer the threads', wait: false, origin: { kind: 'bridge' } })).toBe(true)
  expect((await recentPrompts(h.host)).map(p => p.text)).toEqual(['fix the comments on PR 42', 'and answer the threads'])
})

test('an injected prompt is never recorded: a plugin\'s relay, a schedule, a peer, a task notification, a channel, isMeta, unclassified', { timeoutMs: 20_000 }, async () => {
  const h = fakeHost(null)
  const kinds: Record<string, unknown>[] = [{ kind: 'plugin', name: 'lean-agent' }, { kind: 'plugin', name: 'x', asUser: true }, { kind: 'scheduled-trigger' }, { kind: 'peer' }, { kind: 'peer-send-message' }, { kind: 'projects-relay' }, { kind: 'task-notification' }, { kind: 'channel', server: 's' }, { kind: 'sdk' }, { kind: 'coordinator' }, { kind: 'auto-continuation' }, { kind: 'unclassified' }, { kind: 'slack-ping' }]
  for (const origin of kinds) expect(await recordHumanPrompt(h.host, { text: 'fix the comments on PR 42', wait: false, origin })).toBe(false)
  expect(await recordHumanPrompt(h.host, { text: 'fix the comments on PR 42', wait: false, isMeta: true, origin: { kind: 'composer' } })).toBe(false)
  expect(await recordHumanPrompt(h.host, { text: '', origin: { kind: 'composer' } })).toBe(false)
  expect(await recentPrompts(h.host)).toEqual([])
})

test('an event without origin is never typed; the SDK host turn counts only in an app session; a long (pasted) prompt is not recorded', { timeoutMs: 20_000 }, async () => {
  expect(isHumanPrompt({ text: 'fix PR 42 comments' })).toBe(false)
  expect(isHumanPrompt({ text: 'fix PR 42 comments' }, true)).toBe(false)
  expect(isHumanPrompt({ text: 'fix PR 42 comments', origin: { kind: 'sdk' } })).toBe(false) // claude -p from a shell
  expect(isHumanPrompt({ text: 'fix PR 42 comments', origin: { kind: 'sdk' } }, true)).toBe(true) // typed in the desktop app
  expect(isHumanPrompt({ text: 'fix PR 42 comments', origin: { kind: 'plugin' } }, true)).toBe(false)
  expect(isHumanPrompt({ text: 'fix PR 42 comments', isMeta: true })).toBe(false)
  expect(isHumanPrompt({ text: 'x'.repeat(PROMPT_MAX + 1), origin: { kind: 'composer' } })).toBe(false)
})

test('a prompt older than 24 h is gone, and only the last 30 are kept', { timeoutMs: 20_000 }, async () => {
  const h = fakeHost(null)
  await recordHumanPrompt(h.host, { text: 'old one', origin: { kind: 'composer' } })
  h.clock.t += 25 * HOUR
  expect(await recentPrompts(h.host)).toEqual([])
  for (let i = 0; i < 35; i++) await recordHumanPrompt(h.host, { text: `p${i}`, origin: { kind: 'composer' } })
  const all = await recentPrompts(h.host)
  expect(all).toHaveLength(30)
  expect(all[0]!.text).toBe('p5')
})
