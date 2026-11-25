import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { check } from './doctor'
import { resetLocks } from './threads'
import { recordHumanPrompt } from './humanprompts'
import { bindConfigAnswers, configRow, configTool } from './configtool'

const FILE = '/h/.lean-agent/config.json'
function setup(conf?: unknown, raw?: string) {
  const h = fakeHost(null, { home: '/h' })
  h.clock.t = Date.UTC(2026, 10, 18, 14, 7)
  if (raw !== undefined) h.files.set(FILE, raw)
  else if (conf !== undefined) h.files.set(FILE, JSON.stringify(conf))
  return h
}
const call = (h: any, a: Record<string, unknown>) => configTool(h.host, a)
const file = (h: any) => JSON.parse(String(h.files.get(FILE) ?? 'null'))
const typed = (h: any, text: string) => recordHumanPrompt(h.host, { text, origin: { kind: 'composer' } })

test('list and get: grouped, current against the default, non-defaults marked, the way to apply said', async () => {
  const h = setup({ desk: { model: 'opus' }, threadTokens: 150000 })
  const all = await call(h, { action: 'list' })
  expect(all.ok).toBe(true)
  expect(all.text).toMatch(/^desk:\n/)
  for (const g of ['desk:', 'threads:', 'workers:', 'review:', 'budget:', 'pane:', 'feedback:', 'safety:', 'other:']) expect(all.text).toMatch(new RegExp(`(^|\\n)${g}\\n`))
  expect(all.text).toContain('desk.model = opus * (default sonnet) — Which model the desk session runs on.')
  expect(all.text).toContain('threadTokens = 150000 * (default 120000)')
  expect(all.text).toContain('desk.autoRestart = false (default)')
  expect(all.text).toContain('lean.orchestrate (sensitive) = true (default)')
  expect(all.text).toContain('(2 in this list)')
  const one = await call(h, { action: 'list', group: 'pane' })
  expect(one.text).toContain('pane.theme = off (default)')
  expect(one.text).not.toContain('desk.model')
  expect((await call(h, { action: 'list', group: 'nope' })).ok).toBe(false)
  const g = await call(h, { action: 'get', key: 'desk.model' })
  expect(g.text).toContain('desk.model: opus (nested in the file)')
  expect(g.text).toContain('default sonnet · one of haiku, sonnet, opus · group desk · takes effect after the desk restarts')
  expect((await call(h, { action: 'get', key: 'lean.orchestrate' })).text).toContain('loosens a safety rule')
  const bad = await call(h, { action: 'get', key: 'desk.autoRestrt' })
  expect(bad).toMatchObject({ ok: false })
  expect(bad.text).toContain('did you mean desk.autoRestart?')
  expect(await call(h, { action: 'bogus' })).toMatchObject({ ok: false })
})

test('set: each type is validated, written nested, and says when it applies; a bad value changes nothing', async () => {
  const h = setup()
  let r = await call(h, { action: 'set', key: 'desk.autoRestart', value: 'off' })
  expect(r.ok).toBe(true)
  expect(r.text).toContain('takes effect now')
  expect(file(h)).toEqual({ desk: { autoRestart: false } })
  r = await call(h, { action: 'set', key: 'threadTokens', value: 150000 })
  expect(r.text).toContain('150000')
  r = await call(h, { action: 'set', key: 'desk.model', value: 'opus' })
  expect(r.text).toContain('after the desk restarts')
  r = await call(h, { action: 'set', key: 'threads.effort', value: 'low' })
  expect(r.text).toContain('from the next session')
  r = await call(h, { action: 'set', key: 'tools.desk.drop', value: 'WebFetch, mcp__*' })
  expect(file(h).tools.desk.drop).toEqual(['WebFetch', 'mcp__*'])
  expect(file(h)).toMatchObject({ desk: { autoRestart: false, model: 'opus' }, threadTokens: 150000, threads: { effort: 'low' } })
  const before = String(h.files.get(FILE))
  for (const [key, value, why] of [['desk.model', 'gpt', 'haiku, sonnet, opus'], ['threadTokens', 500, 'at least 10000'], ['threadTokens', '12.5', 'number'], ['desk.autoRestart', 'perhaps', 'true or false'], ['feedback.destination', 'email', 'local, folder, github, folder+github'], ['review.model', 'x'.repeat(400), 'short text'], ['review.model', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'secret']] as const) {
    const x = await call(h, { action: 'set', key, value })
    expect(x.ok).toBe(false)
    expect(x.text).toContain(why)
  }
  expect((await call(h, { action: 'set', key: 'desk.model' })).ok).toBe(false) // no value
  expect((await call(h, { action: 'set', value: 'x' })).ok).toBe(false) // no key
  expect(String(h.files.get(FILE))).toBe(before)
})

test('set: a path key must name an existing folder; ~ is kept in the file and expanded only for display', async () => {
  const h = setup()
  h.files.set('/h/Downloads/keep.txt', 'x')
  const bad = await call(h, { action: 'set', key: 'feedback.folder', value: '~/Nowhere' })
  expect(bad.ok).toBe(false)
  expect(bad.text).toContain('does not exist')
  expect((await call(h, { action: 'set', key: 'feedback.folder', value: 'Downloads' })).text).toContain('Nothing was changed') // a bare word is not a path
  const ok = await call(h, { action: 'set', key: 'feedback.folder', value: '~/Downloads' })
  expect(ok.ok).toBe(true)
  expect(ok.text).toContain('(/h/Downloads)')
  expect(file(h)).toEqual({ feedback: { folder: '~/Downloads' } })
  expect((await call(h, { action: 'set', key: 'feedback.destination', value: 'folder' })).ok).toBe(true)
  expect(file(h).feedback).toEqual({ folder: '~/Downloads', destination: 'folder' })
})

test('nested vs flat: the file keeps its style; unknown keys, the indent and the final newline are kept', async () => {
  const flat = setup({ 'feedback.destination': 'folder', other: { keep: [1, 2] } })
  await call(flat, { action: 'set', key: 'feedback.destination', value: 'github' })
  expect(file(flat)).toEqual({ 'feedback.destination': 'github', other: { keep: [1, 2] } })
  flat.files.set('/h/Downloads/x', 'x')
  await call(flat, { action: 'set', key: 'feedback.folder', value: '~/Downloads' }) // its reader takes the flat spelling too: the file writes flat
  expect(file(flat)['feedback.folder']).toBe('~/Downloads')
  await call(flat, { action: 'set', key: 'desk.autoRestart', value: 'false' }) // its reader reads the nested form only
  expect(file(flat).desk).toEqual({ autoRestart: false })
  const nested = setup({ feedback: { destination: 'folder' } })
  await call(nested, { action: 'set', key: 'feedback.destination', value: 'local' })
  expect(file(nested)).toEqual({ feedback: { destination: 'local' } })
  const raw = '{\n    "future": { "x": 1 },\n    "desk": { "model": "sonnet" }\n}\n'
  const four = setup(undefined, raw)
  await call(four, { action: 'set', key: 'desk.effort', value: 'low' })
  expect(String(four.files.get(FILE))).toBe('{\n    "future": {\n        "x": 1\n    },\n    "desk": {\n        "model": "sonnet",\n        "effort": "low"\n    }\n}\n')
  const files = [...four.files.keys()].filter(k => k.startsWith('/h/.lean-agent/config.json'))
  expect(files).toEqual([FILE]) // the temp file of the atomic write is gone
})

test('a config.json that is not valid JSON is never overwritten', async () => {
  const h = setup(undefined, '{ "desk": { "model": ')
  const r = await call(h, { action: 'set', key: 'desk.model', value: 'opus' })
  expect(r.ok).toBe(false)
  expect(r.text).toContain('not valid JSON')
  expect(String(h.files.get(FILE))).toBe('{ "desk": { "model": ')
  expect((await call(h, { action: 'validate' })).ok).toBe(false)
})

test('unset: removes the key in whatever spelling, drops an emptied parent, keeps the rest', async () => {
  const h = setup({ desk: { model: 'opus' }, 'feedback.destination': 'local', checkpoint: { deskTokens: 50000 }, keep: 1 })
  const r = await call(h, { action: 'unset', key: 'desk.model' })
  expect(r.text).toContain('reset to the default (sonnet)')
  expect(file(h)).toEqual({ 'feedback.destination': 'local', checkpoint: { deskTokens: 50000 }, keep: 1 })
  await call(h, { action: 'unset', key: 'feedback.destination' })
  await call(h, { action: 'unset', key: 'deskTokens' }) // the alias checkpoint.deskTokens goes too
  expect(file(h)).toEqual({ keep: 1 })
  expect((await call(h, { action: 'unset', key: 'desk.model' })).text).toContain('already uses the default')
})

test('validate: unknown keys get their nearest key, bad values and ignored spellings are named', async () => {
  const clean = setup({ desk: { model: 'opus' }, 'feedback.destination': 'github', future: 1 })
  const c = await call(clean, { action: 'validate' })
  expect(c.text).toContain('1 problem') // `future` is unknown
  expect(c.text).toContain('unknown setting "future"')
  const h = setup({ desk: { autoRestrt: false, model: 'gpt' }, 'threads.autoRestart': false, threadTokens: 'many', workers: { stepsByJob: { lookup: 0 } }, fine: { x: 1 } })
  const r = await call(h, { action: 'validate' })
  expect(r.ok).toBe(false)
  expect(r.text).toContain('unknown setting "desk.autoRestrt": did you mean desk.autoRestart?')
  expect(r.text).toContain('desk.model gpt: must be one of haiku, sonnet, opus')
  expect(r.text).toContain('threads.autoRestart is written flat')
  expect(r.text).toContain('threadTokens many: must be a number')
  expect(r.text).toContain('workers.stepsByJob.lookup 0: must be at least 1')
  expect(r.text).toContain('unknown setting "fine"')
  const ok = await call(setup({ desk: { model: 'opus' } }), { action: 'validate' })
  expect(ok).toMatchObject({ ok: true })
  expect(ok.text).toContain('1 setting, 1 differ from the defaults, 0 problems')
})

test('deprecated USD keys: validate says "no longer used: replaced by budget.windowTokens ..." (not unknown); get / set say the same and change nothing; unset removes them, whatever the spelling; no value is converted', async () => {
  const conf = { dailyCapUsd: { desk: 5, thread: 20 }, workerCapUsd: 2, workerCaps: { 'worker-opus': 4 }, budget: { daily: 25, threadDaily: 'off', windowTokens: 5_000_000 }, threads: { softUsd: 8, hardUsd: 20, softTokens: 1_000_000 }, 'review.maxUsd': 25, review: { askAboveUsd: 5 }, tips: false }
  const h = setup(conf)
  const v = await call(h, { action: 'validate' })
  expect(v.ok).toBe(false)
  expect(v.text).toContain('10 problems')
  expect(v.text).toContain('budget.daily is no longer used: replaced by budget.windowTokens, budget.allTimeTokens, threads.softTokens, threads.hardTokens, review.askAboveTokens, review.maxTokens')
  expect(v.text).toContain('threads.softUsd is no longer used: replaced by threads.softTokens')
  expect(v.text).toContain('review.maxUsd is no longer used: replaced by review.maxTokens')
  expect(v.text).toContain('dailyCapUsd.desk is no longer used')
  expect(v.text).toContain('workerCaps is no longer used')
  expect(v.text).not.toMatch(/unknown setting "(budget|dailyCapUsd|workerCap|threads\.(soft|hard)Usd|review\.(max|askAbove)Usd)/)
  expect(v.text).toContain('lean_config unset budget.daily removes it')
  // get and set on a deprecated key: said, nothing written
  const g = await call(h, { action: 'get', key: 'threads.softUsd' })
  expect(g.ok).toBe(false)
  expect(g.text).toContain('threads.softUsd is no longer used')
  const before = JSON.stringify(file(h))
  const s = await call(h, { action: 'set', key: 'review.maxUsd', value: '40' })
  expect(s.ok).toBe(false)
  expect(s.text).toContain('review.maxUsd is no longer used: replaced by review.maxTokens')
  expect(JSON.stringify(file(h))).toBe(before) // no silent conversion, nothing written
  expect(file(h).review?.maxTokens).toBeUndefined()
  // the doctor row counts them
  expect((await configRow(h.host))!.ok).toBe(false)
  // unset removes each, in any spelling, and keeps the rest
  for (const k of ['budget.daily', 'budget.threadDaily', 'dailyCapUsd.desk', 'dailyCapUsd.thread', 'workerCapUsd', 'workerCaps', 'threads.softUsd', 'threads.hardUsd', 'review.maxUsd', 'review.askAboveUsd']) {
    const u = await call(h, { action: 'unset', key: k })
    expect(u.ok, k).toBe(true)
    expect(u.text, k).toContain('removed from')
  }
  expect(file(h)).toEqual({ budget: { windowTokens: 5_000_000 }, threads: { softTokens: 1_000_000 }, tips: false })
  expect((await call(h, { action: 'validate' })).ok).toBe(true)
  // a deprecated key that is not in the file: said, not "unknown"
  expect((await call(h, { action: 'unset', key: 'threads.softUsd' })).text).toContain('no longer used')
  // the object spelling goes at once
  const o = setup({ dailyCapUsd: { desk: 1 } })
  expect((await call(o, { action: 'unset', key: 'dailyCapUsd' })).ok).toBe(true)
  expect(file(o)).toEqual({})
})

test('budget.since: "today" starts the all-time usage again from this moment; a day or a moment is kept as typed; anything else is refused; lean_doctor budget-reset is the same', async () => {
  const h = setup({})
  const a = await call(h, { action: 'set', key: 'budget.since', value: 'today' })
  expect(a.ok).toBe(true)
  expect(file(h).budget.since).toBe('2026-11-18T14:07:00Z')
  expect((await call(h, { action: 'set', key: 'budget.since', value: '2026-11-01' })).ok).toBe(true)
  expect(file(h).budget.since).toBe('2026-11-01')
  expect((await call(h, { action: 'set', key: 'budget.since', value: 'last week' })).ok).toBe(false)
  expect((await call(h, { action: 'validate' })).ok).toBe(true)
  expect((await call(h, { action: 'unset', key: 'budget.since' })).text).toContain('reset to the default')
})

test('pane.sort: "cost" (the old name) is read as usage; set stores usage', async () => {
  const h = setup({ pane: { sort: 'cost' } })
  expect((await call(h, { action: 'validate' })).ok).toBe(true) // not invalid
  expect((await call(h, { action: 'set', key: 'pane.sort', value: 'cost' })).ok).toBe(true)
  expect(file(h).pane.sort).toBe('usage')
})

test('sensitive: refused with the way forward unless the user typed the key; then it is changed', async () => {
  const h = setup({ lean: { orchestrate: true } })
  const r = await call(h, { action: 'set', key: 'lean.orchestrate', value: 'off' })
  expect(r.ok).toBe(false)
  expect(r.text).toContain('loosens a safety rule')
  expect(r.text).toContain('/lean-agent:config lean.orchestrate false')
  expect(r.text).toContain('AskUserQuestion')
  expect(r.ask?.options.map(o => o.label)).toEqual(['Approve', 'Not now'])
  expect(file(h)).toEqual({ lean: { orchestrate: true } })
  await typed(h, 'please make threads faster') // typed, but it does not name the key
  expect((await call(h, { action: 'set', key: 'lean.orchestrate', value: 'off' })).ok).toBe(false)
  await recordHumanPrompt(h.host, { text: 'set lean.orchestrate to false', origin: { kind: 'sdk' } }) // not a typed prompt of an app session: never recorded
  expect((await call(h, { action: 'set', key: 'lean.orchestrate', value: 'off' })).ok).toBe(false)
  await typed(h, '/lean-agent:config lean.orchestrate off')
  const ok = await call(h, { action: 'set', key: 'lean.orchestrate', value: 'off' })
  expect(ok.ok).toBe(true)
  expect(ok.text).toContain('from the next session')
  expect(file(h)).toEqual({ lean: { orchestrate: false } })
  // the one-word key counts only when the typed words are about the config
  const p = setup()
  await typed(p, 'my private repo is called alpha')
  expect((await call(p, { action: 'set', key: 'private', value: 'off' })).ok).toBe(false)
  await typed(p, 'config private off')
  expect((await call(p, { action: 'set', key: 'private', value: 'off' })).ok).toBe(true)
  // unset of a sensitive key is gated the same way
  const u = setup({ actions: { holdSeconds: 0 } })
  expect((await call(u, { action: 'unset', key: 'actions.holdSeconds' })).ok).toBe(false)
  await typed(u, 'reset actions.holdSeconds please')
  expect((await call(u, { action: 'unset', key: 'actions.holdSeconds' })).ok).toBe(true)
  expect(file(u)).toEqual({})
})

test('sensitive: the user\'s Approve on the mod\'s own question changes it, bound to the request; anything else does not', async () => {
  const h = setup({ actions: { ownPrDefault: true } })
  const r = await call(h, { action: 'set', key: 'actions.ownPrDefault', value: 'false' })
  const q = r.ask!
  expect(q.question).toMatch(/\[config c\d+-\d+, check [0-9a-f]{12}\]$/)
  const questions = [{ question: q.question, options: q.options, multiSelect: false }]
  // a question the model reworded is not the offer
  const worded = [{ question: q.question.replace('Allow', 'Please allow'), options: q.options }]
  expect((await bindConfigAnswers(h.host, worded, { [worded[0]!.question]: 'Approve' }))[0]).toContain('NOT recorded')
  // free text is not an Approve; Not now drops the offer
  expect((await bindConfigAnswers(h.host, questions, { [q.question]: 'what does that change?' }))[0]).toContain('free text')
  expect(file(h)).toEqual({ actions: { ownPrDefault: true } })
  const yes = await bindConfigAnswers(h.host, questions, { [q.question]: 'Approve' })
  expect(yes[0]).toContain('actions.ownPrDefault set to false')
  expect(file(h)).toEqual({ actions: { ownPrDefault: false } })
  expect((await bindConfigAnswers(h.host, questions, { [q.question]: 'Approve' }))[0]).toContain('NOT recorded') // used once
  const again = await call(h, { action: 'set', key: 'actions.ownPrDefault', value: 'true' })
  const q2 = again.ask!
  const no = await bindConfigAnswers(h.host, [{ question: q2.question, options: q2.options }], { [q2.question]: 'Not now' })
  expect(no[0]).toContain('stays as it is')
  expect(file(h)).toEqual({ actions: { ownPrDefault: false } })
  // an answer for an offer of a tampered check code is refused
  const t = await call(h, { action: 'set', key: 'actions.holdSeconds', value: 60 })
  const forged = t.ask!.question.replace(/check [0-9a-f]{12}/, 'check 000000000000')
  expect((await bindConfigAnswers(h.host, [{ question: forged, options: t.ask!.options }], { [forged]: 'Approve' }))[0]).toContain('NOT recorded')
  expect(file(h).actions.holdSeconds).toBeUndefined()
})

test('doctor row: nothing for a default install, the differing keys and the invalid count otherwise', async () => {
  expect(await configRow(setup().host)).toBeNull()
  const ok = (await configRow(setup({ desk: { model: 'opus' }, threadTokens: 150000 }).host))!
  expect(ok).toMatchObject({ ok: true, text: 'config: 2 settings differ from the defaults (desk.model, threadTokens), 0 invalid' })
  const bad = (await configRow(setup({ desk: { model: 'gpt' }, nope: 1 }).host))!
  expect(bad.ok).toBe(false)
  expect(bad.text).toBe('config: 0 settings differ from the defaults, 2 invalid: desk.model, nope (lean_config validate)') // the invalid keys are named
  expect((await configRow(setup(undefined, '{ nope').host))!.ok).toBe(false)
})

test('lean_doctor check: the config row, a FIX naming lean_config validate only when something is invalid', async () => {
  const doc = (conf?: unknown) => {
    const h = setup(conf)
    h.files.set('/p/.claude-plugin/plugin.json', JSON.stringify({ version: '1.0.4' }))
    h.claude.handler = (a: string[]) => ({ exitCode: 0, stdout: a[0] === '--version' ? '2.1.327 (Claude Code)\n' : '' })
    return check(h.host, '/p')
  }
  expect((await doc()).some(r => r.includes('config:'))).toBe(false)
  const ok = (await doc({ desk: { model: 'opus' }, threads: { autoRestart: false } })).find(r => r.includes('config:'))!
  expect(ok).toMatch(/^ok\s+config: 2 settings differ from the defaults \(desk\.model, threads\.autoRestart\), 0 invalid$/)
  const bad = (await doc({ desk: { model: 'gpt' } })).find(r => r.includes('config:'))!
  expect(bad).toMatch(/^FIX\s+config: 0 settings differ from the defaults, 1 invalid: desk\.model \(lean_config validate\)$/)
})

// ---- the tool through the engine: desk only ----
async function start($: any, on: any, dir: string) {
  const h = fakeHost(on)
  on('clock.after', () => new Promise(() => {}))
  resetLocks()
  h.files.set('/p/templates/thread.md', '# {{id}}')
  h.files.set('/p/templates/front-desk.md', 'desk {{lean}}')
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', title: 'x', project: 'proj', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  const reg: any[] = []
  on('tool.register', (_: any, e: any) => { reg.push(e); return { value: { tool: `mcp__lean-agent__${e.name}` } } })
  on('clock.every', () => ({ value: { cancel() {} } }))
  on('session.cwd', () => ({ value: dir }))
  on('session.root', () => ({ value: dir }))
  on('session.id', () => ({ value: 'sess-x' }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('prompt.submit', (_: any, e: any) => e)
  await $.session.start({ cwd: dir, surface: 'desktop', isInteractive: true } as any)
  return { h, reg }
}
const CALL = { tool: 'mcp__lean-agent__lean_config', action: 'set', key: 'desk.model', value: 'opus' } as any

test('lean_config is a desk tool: registered on the desk with a short spec, and it works there', { timeoutMs: 20_000 }, async ($, on) => {
  const desk = await start($, on, '/h/lean-agent-desk')
  expect(desk.reg.map(x => x.name)).toContain('lean_config')
  const spec = desk.reg.find(x => x.name === 'lean_config')
  expect(JSON.stringify(spec).length).toBeLessThan(800) // a short spec: the desk's tool budget does not grow
  const got: any = await $.tool.call({ ...CALL, action: 'get', key: 'desk.model' })
  expect(JSON.stringify(got)).toContain('default sonnet')
  const set: any = await $.tool.call(CALL)
  expect(JSON.stringify(set)).toContain('after the desk restarts')
  expect(JSON.parse(String(desk.h.files.get(FILE)))).toMatchObject({ desk: { model: 'opus' } }) // (the fake host's own file holds lean.orchestrate false)
})

test('lean_config is not registered in a thread session (a worker runs inside one) and is refused there, nothing changed', { timeoutMs: 20_000 }, async ($, on) => {
  const thread = await start($, on, '/h/.lean-agent/threads/t1')
  expect(thread.reg.map(x => x.name)).not.toContain('lean_config')
  const r: any = await $.tool.call(CALL)
  expect(JSON.stringify(r)).toContain('needs a desk session')
  expect(String(thread.h.files.get(FILE))).toBe('{"lean":{"orchestrate":false}}') // (the fake host's own file, untouched)
})
