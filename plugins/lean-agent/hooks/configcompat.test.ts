// A config.json that a 1.0.30 user wrote by hand (every form its README documents) is NOT reported invalid by the 1.0.31 registry:
// `lean_config validate` and the doctor row ("N invalid") list only what is really wrong, and the doctor row names the keys.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { check } from './doctor'
import { resetLocks } from './threads'
import { reportOf } from './configtool'
import { configRow } from './configtool'
import { findEntry } from './configkeys'

// the forms of the 1.0.30 README: nested objects, flat top-level keys, "off" for the alerts, the old deskTokens, a per-role tool drop list
const V30 = {
  dailyCapUsd: { desk: 5, thread: 20 },
  workerCapUsd: 2,
  workerCaps: { 'lean-agent:worker-opus': 4 },
  budget: { daily: 25, threadDaily: 15 },
  desk: { autoRelay: false, autoResume: false },
  threads: { removeOld: false, model: 'sonnet', effort: 'high', stuckMinutes: 10 },
  notify: { toast: true, sound: false },
  tips: false,
  actions: { maxWritesPerGrant: 40 },
  pane: { theme: 'on' },
  tools: { desk: { drop: ['mcp__x__y'] } },
  workers: { stepsByJob: { lookup: 5, edit: 12 }, steps: 24 },
  rulesPr: { minSessions: 3, minDays: 7 },
  review: { lessonTokens: 600, model: 'opus', exclude: ['**/*.snap'], prChecks: false },
  pr: { checks: { severity: false } },
  toolResultChars: 30000,
  deskTokens: 200000,
  checkpoint: { deskTokens: 150000 },
  threadTokens: 160000,
  threadWarnTokens: 133000,
  handover: { mode: 'core' },
  'lean.orchestrate': true,
}

test('a 1.0.30-era config has no invalid setting except its USD budgets, which are "no longer used" (aliases, nested and flat forms, object values, false for the check groups)', () => {
  const r = reportOf(V30 as any)
  expect(r.keys.sort()).toEqual(['budget.daily', 'budget.threadDaily', 'dailyCapUsd.desk', 'dailyCapUsd.thread', 'workerCapUsd', 'workerCaps'])
  for (const p of r.problems) {
    expect(p).toContain('is no longer used: replaced by budget.windowTokens')
    expect(p).not.toContain('unknown setting') // known and deprecated, not "unknown"
    expect(p).toContain('enforces nothing')
  }
  const rest: Record<string, unknown> = { ...V30 }
  for (const k of ['dailyCapUsd', 'workerCapUsd', 'workerCaps', 'budget']) delete rest[k]
  expect(reportOf(rest as any).problems).toEqual([]) // the rest of the file is read as before
})

test('every USD key of 1.0.33 is deprecated in any spelling (nested, flat, object, "off", numbers): never invalid in a new way, never unknown, never enforced', () => {
  const all = ['budget.daily', 'budget.threadDaily', 'dailyCapUsd.desk', 'dailyCapUsd.thread', 'dailyCapUsd.plain', 'workerCapUsd', 'workerCaps', 'threads.softUsd', 'threads.hardUsd', 'review.askAboveUsd', 'review.maxUsd']
  for (const k of all) {
    expect(findEntry(k)).toBeUndefined() // out of the registry's active list
    for (const v of ['off', false, 0, -1, 25, '30', { x: 1 }]) {
      const flat = reportOf({ [k]: v } as any)
      expect(flat.keys, `${k} flat ${JSON.stringify(v)}`).toEqual(k === 'workerCaps' && typeof v === 'object' ? ['workerCaps'] : [k])
      expect(flat.problems[0], k).toContain(`${k} is no longer used: replaced by `)
    }
  }
  const nested = reportOf({ threads: { softUsd: 8, hardUsd: 20 }, review: { askAboveUsd: 5, maxUsd: 25 }, dailyCapUsd: { desk: 5, plain: 1 } } as any)
  expect(nested.keys.sort()).toEqual(['dailyCapUsd.desk', 'dailyCapUsd.plain', 'review.askAboveUsd', 'review.maxUsd', 'threads.hardUsd', 'threads.softUsd'])
  expect(nested.problems.find(p => p.startsWith('threads.softUsd'))).toContain('replaced by threads.softTokens')
  expect(nested.problems.find(p => p.startsWith('review.maxUsd'))).toContain('replaced by review.maxTokens')
  expect(reportOf({ budget: { daily: 'soon', threadDaily: {} } } as any).problems).toHaveLength(2) // (still said, as deprecated)
  expect(reportOf({ budget: { windowTokens: 5_000_000, since: '2026-11-25', weights: { output: 4 } }, threads: { softTokens: 2_000_000 } } as any).problems).toEqual([])
})

test('the doctor row names every invalid key', async () => {
  resetLocks()
  const h = fakeHost(null, { home: '/h' })
  h.files.set('/h/.lean-agent/config.json', JSON.stringify({ pane: { theme: 'on' }, threads: { model: 3 }, window: { holdAbove: 'x' }, nope: { x: 1 }, 'desk.autoRelay': 'yes' }))
  const row = await configRow(h.host)
  expect(row!.text).toContain('4 invalid: threads.model, window.holdAbove, nope, desk.autoRelay (lean_config validate)')
  void check
})
