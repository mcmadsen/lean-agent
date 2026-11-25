import { expect, test } from 'claude-code/testing'
import { APPLIES_TEXT, EFFORTS, GROUPS, MODELS, REGISTRY, checkValue, currentOf, findEntry, nearestKey, parseValue } from './configkeys'
import { EFFORTS as E2, MODELS as M2 } from './models'
import { FEEDBACK_DESTS } from './feedbackdest'

// (the source scan and the README comparison need files: scripts/config-table.mjs --check, run by hooks/skills-contract.test.sh)

test('registry: every key has a one-line description, a valid group and applies, and a default that passes its own check', async () => {
  const seen = new Set<string>()
  for (const e of REGISTRY) {
    expect(seen.has(e.key)).toBe(false)
    seen.add(e.key)
    expect(e.description.trim().length).toBeGreaterThan(10)
    expect(e.description).not.toContain('\n')
    expect(GROUPS).toContain(e.group)
    expect(Object.keys(APPLIES_TEXT)).toContain(e.applies)
    expect((Array.isArray(e.src) ? e.src : [e.src]).length).toBeGreaterThan(0)
    if (e.default !== null) expect(checkValue(e, e.default).ok).toBe(true)
  }
  expect(REGISTRY.length).toBeGreaterThan(70)
})

test('registry: the values it lists are the ones the code accepts', async () => {
  expect([...MODELS]).toEqual([...M2])
  expect([...EFFORTS]).toEqual([...E2])
  expect(findEntry('feedback.destination')!.values).toEqual([...FEEDBACK_DESTS])
})

test('registry: the examples of the request are there, with the right type and sensitivity', async () => {
  for (const [k, t] of [['feedback.destination', 'enum'], ['desk.autoRestart', 'boolean'], ['threads.autoRestart', 'boolean'], ['threadTokens', 'number'], ['budget.windowTokens', 'number'], ['budget.since', 'string'], ['budget.weights', 'json'], ['stats.showUsd', 'boolean'], ['pane.theme', 'enum'], ['lean.orchestrate', 'boolean'], ['actions.holdSeconds', 'number'], ['workers.steps', 'number'], ['feedback.folder', 'path']] as const) {
    expect(findEntry(k)?.type).toBe(t)
  }
  for (const k of ['lean.orchestrate', 'actions.holdSeconds', 'actions.ownPrDefault', 'actions.standing', 'threads.plugins', 'threads.mcp', 'workers.commit', 'private', 'review.maxTokens', 'review.askAboveTokens']) expect(findEntry(k)?.sensitive).toBe(true)
  for (const k of ['desk.model', 'threadTokens', 'budget.windowTokens', 'threads.softTokens', 'pane.theme', 'feedback.destination', 'tips']) expect(findEntry(k)?.sensitive).toBeUndefined()
  expect(findEntry('checkpoint.deskTokens')?.key).toBe('desk.contextLimit') // an alias the reader still accepts
  expect(findEntry('deskTokens')?.key).toBe('desk.contextLimit')
})

test('values: each type parses text and rejects what the readers would ignore', async () => {
  const b = findEntry('desk.autoRestart')!
  expect(parseValue(b, 'off')).toEqual({ ok: true, value: false })
  expect(parseValue(b, 'True')).toEqual({ ok: true, value: true })
  expect(parseValue(b, 'maybe').ok).toBe(false)
  const n = findEntry('threadTokens')!
  expect(parseValue(n, '150000')).toEqual({ ok: true, value: 150000 })
  expect(parseValue(n, '5000')).toMatchObject({ ok: false })
  expect(parseValue(n, 'many')).toMatchObject({ ok: false })
  expect(parseValue(n, '120000.5')).toMatchObject({ ok: false }) // whole numbers only
  const z = findEntry('toolResultChars')!
  expect(parseValue(z, '0')).toEqual({ ok: true, value: 0 }) // 0 = off
  expect(parseValue(z, 'off')).toEqual({ ok: true, value: 0 })
  expect(parseValue(z, '1500').ok).toBe(false)
  const e = findEntry('desk.model')!
  expect(parseValue(e, 'Opus')).toEqual({ ok: true, value: 'opus' })
  expect(parseValue(e, 'gpt')).toMatchObject({ ok: false, why: expect.stringContaining('haiku, sonnet, opus') })
  const p = findEntry('feedback.folder')!
  expect(parseValue(p, '~/Downloads')).toEqual({ ok: true, value: '~/Downloads' })
  expect(parseValue(p, 'Downloads').ok).toBe(false)
  expect(parseValue(p, '~/x ghp_abcdefghijklmnopqrstuvwxyz0123456789').ok).toBe(false) // never a secret
  const l = findEntry('review.exclude')!
  expect(parseValue(l, 'a/**, b/*.gen.ts')).toEqual({ ok: true, value: ['a/**', 'b/*.gen.ts'] })
  expect(parseValue(l, '["x"]')).toEqual({ ok: true, value: ['x'] })
  expect(parseValue(findEntry('threads.plugins')!, 'ALL')).toEqual({ ok: true, value: 'all' })
  expect(parseValue(findEntry('actions.standing')!, '[{"project":"alpha","kinds":["gh-pr-comment"]}]').ok).toBe(true)
  expect(parseValue(findEntry('actions.standing')!, '[{"project":1}]').ok).toBe(false)
  expect(parseValue(findEntry('budget.weights')!, '{"output": 4}').ok).toBe(true)
  expect(parseValue(findEntry('budget.weights')!, '{"output": -1}').ok).toBe(false)
  expect(parseValue(findEntry('budget.weights')!, '{"cache": 1}').ok).toBe(false)
  expect(parseValue(findEntry('budget.since')!, '2026-11-25')).toEqual({ ok: true, value: '2026-11-25' })
  expect(parseValue(findEntry('budget.since')!, '2026-11-25T09:14:00Z').ok).toBe(true)
  expect(parseValue(findEntry('budget.since')!, '2026-13-45').ok).toBe(false)
  expect(parseValue(findEntry('budget.since')!, 'yesterday').ok).toBe(false)
  expect(parseValue(findEntry('budget.windowTokens')!, '5000000')).toEqual({ ok: true, value: 5_000_000 })
  expect(parseValue(findEntry('budget.windowTokens')!, '0').ok).toBe(false) // none = unset it
  // pane.sort: "cost" is the old name of "usage": accepted, stored as usage
  expect(parseValue(findEntry('pane.sort')!, 'cost')).toEqual({ ok: true, value: 'usage' })
  expect(parseValue(findEntry('pane.sort')!, 'usage')).toEqual({ ok: true, value: 'usage' })
  expect(checkValue(findEntry('pane.sort')!, 'cost')).toEqual({ ok: true, value: 'usage' })
  expect(parseValue(findEntry('pane.sort')!, 'dollars').ok).toBe(false)
})

test('lookup: nested and flat spellings are read the same; an unknown key gets its nearest known key', async () => {
  const e = findEntry('feedback.destination')!
  expect(currentOf({ feedback: { destination: 'folder' } }, e)).toMatchObject({ value: 'folder', style: 'nested' })
  expect(currentOf({ 'feedback.destination': 'github' }, e)).toMatchObject({ value: 'github', style: 'flat' })
  expect(currentOf({}, e)).toBeNull()
  expect(currentOf({ checkpoint: { deskTokens: 50000 } }, findEntry('desk.contextLimit')!)).toMatchObject({ value: 50000, spelling: 'checkpoint.deskTokens' })
  expect(nearestKey('desk.autoRestrt')).toBe('desk.autoRestart')
  expect(nearestKey('autoRestart')).toMatch(/autoRestart$/)
  expect(nearestKey('threads.autorestart')).toBe('threads.autoRestart')
  expect(nearestKey('zzzzzzzzzzzzzzzz')).toBeNull()
})
