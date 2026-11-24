// A config.json that a 1.0.30 user wrote by hand (every form its README documents) is NOT reported invalid by the 1.0.31 registry:
// `lean_config validate` and the doctor row ("N invalid") list only what is really wrong, and the doctor row names the keys.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { check } from './doctor'
import { resetLocks } from './threads'
import { reportOf } from './configtool'
import { configRow } from './configtool'
import { checkValue, findEntry } from './configkeys'

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

test('a 1.0.30-era config has no invalid setting (aliases, nested and flat forms, object values, false for the check groups)', () => {
  expect(reportOf(V30 as any).problems).toEqual([])
})

test('"off" (and false, a numeric string, a negative or 0) turns a budget alert off, as 1.0.30 read it: not invalid', () => {
  for (const v of ['off', 'none', 'OFF', false, '30', 0, -1, 25]) expect(reportOf({ budget: { daily: v, threadDaily: v } } as any).problems).toEqual([])
  const bad = reportOf({ budget: { daily: 'soon', threadDaily: {} } } as any).problems
  expect(bad).toHaveLength(2) // junk is still reported
  expect(checkValue(findEntry('budget.daily')!, 'off')).toEqual({ ok: true, value: 'off' })
})

test('the doctor row names every invalid key', async () => {
  resetLocks()
  const h = fakeHost(null, { home: '/h' })
  h.files.set('/h/.lean-agent/config.json', JSON.stringify({ pane: { theme: 'on' }, threads: { model: 3 }, window: { holdAbove: 'x' }, nope: { x: 1 }, 'desk.autoRelay': 'yes' }))
  const row = await configRow(h.host)
  expect(row!.text).toContain('4 invalid: threads.model, window.holdAbove, nope, desk.autoRelay (lean_config validate)')
  void check
})
