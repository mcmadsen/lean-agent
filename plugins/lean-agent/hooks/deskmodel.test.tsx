// The desk's model / effort pin against what the session runs on (deskmodel.ts): applied through the engine's `/config` rows when the
// build has them, else a state for the pane's top row and a notice; and the doctor's wording for a desk that spent on another model.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { applyPin, checkDeskModel, deskModelText, readDeskModel } from './deskmodel'
import { check, fix } from './doctor'
import { modelMismatches, modelRows } from './stats'
import { resetLocks } from './threads'
import { resetViewCache } from './view'

const L = '/h/.lean-agent'
const NOON = Date.UTC(2026, 10, 18, 12)
const PIN = { model: 'sonnet', effort: 'high' }
const OPUS = 'claude-opus-5-5'
const modelRow = (o: Record<string, unknown> = {}) => ({ key: 'model', label: 'Model', kind: 'choice', value: 'opus', options: ['default', 'sonnet', 'opus', 'haiku'], ...o })
const effortRow = (o: Record<string, unknown> = {}) => ({ key: 'effort', label: 'Effort', kind: 'choice', value: 'medium', options: ['low', 'medium', 'high'], ...o })

// a scripted engine: the rows, what a write answers, and the model after it (successive answers of $.session.model())
function engine(rows: unknown, o: { deny?: string; throws?: boolean; models?: string[]; listThrows?: boolean } = {}) {
  const sets: { key: string; value: string }[] = []
  const models = [...(o.models ?? [])]
  return {
    sets,
    engine: {
      configList: async () => { if (o.listThrows) throw new Error('no config'); return rows },
      configSet: async (a: { key: string; value: string }) => { sets.push(a); if (o.throws) throw new Error('boom'); return o.deny ? { deny: o.deny } : { value: a.value } },
      model: async () => (models.length > 1 ? models.shift()! : models[0] ?? ''),
    },
  }
}
// most specs here run a SONNET desk pin through config.json `desk` (which wins over the default); the default pin has its own specs below
const SONNET_DESK = JSON.stringify({ desk: { model: 'sonnet', effort: 'high' } })
const world = (conf: string | null = SONNET_DESK) => { const h = fakeHost(null); h.clock.t = NOON; if (conf) h.files.set(`${L}/config.json`, conf); return h }
const notice = (h: any, k: string) => h.files.get(`${L}/notices/${k}.txt`)
const stateFile = `${L}/desk/model.json`

test('a model the app chose is set through the Model and Effort rows once; the notice says so; no pane state is left', async () => {
  const h = world()
  const e = engine([modelRow(), effortRow()], { models: ['claude-sonnet-5-5'] })
  const r = await checkDeskModel(h.host, e.engine, OPUS, true)
  expect(r.kind).toBe('set')
  expect(e.sets).toEqual([{ key: 'model', value: 'sonnet' }, { key: 'effort', value: 'high' }])
  expect(r.text).toBe(`the desk was on ${OPUS} (the app chose it); lean-agent set sonnet / high through /config (the app may keep that as your default for new sessions)`)
  expect(notice(h, 'desk-model-set')).toContain('lean-agent set sonnet / high through /config')
  expect(h.files.has(stateFile)).toBe(false)
  expect(await readDeskModel(h.host)).toBeNull()
  // only what was written is claimed: no Effort row -> the model alone
  const m = world()
  const e2 = engine([modelRow()], { models: ['claude-sonnet-5-5'] })
  const r2 = await checkDeskModel(m.host, e2.engine, OPUS, true)
  expect(r2.kind).toBe('set')
  expect(r2.text).toContain('set sonnet (effort not changed: no effort row) through /config')
  expect(r2.text).not.toContain('sonnet / high')
  // the plain option beats `opusplan`-like names of the same family
  const x = world()
  const e3 = engine([modelRow({ options: ['opusplan', 'sonnet[1m]', 'sonnet', 'opus'] })], { models: ['claude-sonnet-5-5'] })
  await checkDeskModel(x.host, e3.engine, OPUS, true)
  expect(e3.sets[0]).toEqual({ key: 'model', value: 'sonnet' })
  const y = world()
  const e4 = engine([modelRow({ options: ['opusplan', 'sonnet[1m]'] })], { models: ['claude-sonnet-5-5'] })
  await checkDeskModel(y.host, e4.engine, OPUS, true)
  expect(e4.sets[0]).toEqual({ key: 'model', value: 'sonnet[1m]' }) // no exact option: the family
})

test('the DEFAULT desk pin is sonnet / high (the 1.0.10 opus pin is reverted): an opus or fable session is set to Sonnet, or the row says to pick Sonnet; a desk already on Sonnet is left alone; config.json desk.model wins', async () => {
  const SONNET = 'claude-sonnet-5-5'
  const h = world(null) // no config.json: the default
  const e = engine([modelRow(), effortRow()], { models: [SONNET] })
  const r = await checkDeskModel(h.host, e.engine, OPUS, true)
  expect(r.kind).toBe('set')
  expect(e.sets).toEqual([{ key: 'model', value: 'sonnet' }, { key: 'effort', value: 'high' }])
  expect(r.text).toBe(`the desk was on ${OPUS} (the app chose it); lean-agent set sonnet / high through /config (the app may keep that as your default for new sessions)`)
  // another expensive family is switched too (a deny-by-default rule, not a name list)
  const f = world(null)
  const fe = engine([modelRow(), effortRow()], { models: [SONNET] })
  expect((await checkDeskModel(f.host, fe.engine, 'claude-fable-5-2', true)).kind).toBe('set')
  expect(fe.sets[0]).toEqual({ key: 'model', value: 'sonnet' })
  const u = world(null)
  const none = engine([effortRow()])
  const r2 = await checkDeskModel(u.host, none.engine, OPUS, true)
  expect(r2.kind).toBe('unsettable')
  expect(r2.text).toBe("the desk runs claude-opus-5-5; pick Sonnet in the app's model menu (lean-agent pins sonnet / high)")
  expect(notice(u, 'desk-model')).toContain('pick Sonnet in the app')
  const ok = world(null)
  const same = engine([modelRow({ value: 'sonnet' }), effortRow({ value: 'high' })])
  expect((await checkDeskModel(ok.host, same.engine, SONNET, true)).kind).toBe('match')
  expect(same.sets).toEqual([])
  // a config.json desk.model the user set wins over the default: opus configured, an opus session is on the pin
  const c = world(JSON.stringify({ desk: { model: 'opus' } }))
  const cs = engine([modelRow({ value: 'opus' }), effortRow({ value: 'high' })])
  expect((await checkDeskModel(c.host, cs.engine, OPUS, true)).kind).toBe('match')
  expect(cs.sets).toEqual([])
})

test('already on the pin: nothing is written; only an effort that differs is set', async () => {
  const h = world()
  const same = engine([modelRow({ value: 'sonnet' }), effortRow({ value: 'high' })])
  expect((await checkDeskModel(h.host, same.engine, 'claude-sonnet-5-5', true)).kind).toBe('match')
  expect(same.sets).toEqual([])
  const eff = engine([modelRow({ value: 'sonnet' }), effortRow({ value: 'low' })])
  const r = await checkDeskModel(h.host, eff.engine, 'sonnet', true)
  expect(r.kind).toBe('set')
  expect(eff.sets).toEqual([{ key: 'effort', value: 'high' }])
  expect(r.text).toContain("the desk's effort was not high")
  // config.json's desk pin is the pin: opus pinned, opus running, nothing to do
  h.files.set(`${L}/config.json`, JSON.stringify({ desk: { model: 'opus', effort: 'high' } }))
  const ok = engine([modelRow(), effortRow({ value: 'high' })])
  expect((await checkDeskModel(h.host, ok.engine, OPUS, true)).kind).toBe('match')
  expect(ok.sets).toEqual([])
})

test('when the engine cannot set it (no row, locked, denied, throws, no option of that family, no listing, not verified) the pane state and notice say what to pick', async () => {
  const cases: [string, unknown, Record<string, unknown>, RegExp][] = [
    ['no model row', [effortRow()], {}, /no model row/],
    ['locked', [modelRow({ isLocked: true })], {}, /locked/],
    ['no option', [modelRow({ options: ['opus', 'haiku'] })], {}, /no sonnet option/],
    ['denied', [modelRow()], { deny: 'managed by policy' }, /refused: managed by policy/],
    ['throws', [modelRow()], { throws: true }, /model: boom/],
    ['no listing', null, { listThrows: true }, /config.list: no config/],
    ['rows that are no rows', 'nonsense', {}, /no model row/],
  ]
  for (const [name, rows, o, why] of cases) {
    const h = world()
    const e = engine(rows, o as any)
    const a = await applyPin(e.engine, PIN, true)
    expect(a.model, name).toBe(false)
    expect(a.why.join(';'), name).toMatch(why)
    const r = await checkDeskModel(h.host, e.engine, OPUS, true)
    expect(r.kind, name).toBe('unsettable')
    expect(r.text, name).toBe("the desk runs claude-opus-5-5; pick Sonnet in the app's model menu (lean-agent pins sonnet / high)")
    expect(await readDeskModel(h.host), name).toMatchObject({ running: OPUS, pin: PIN })
    expect(notice(h, 'desk-model'), name).toContain('pick Sonnet in the app')
    expect(h.files.has(`${L}/notices/desk-model-set.txt`), name).toBe(false)
  }
  // a write that went through but did not move the model is no success
  const h = world()
  const e = engine([modelRow()], { models: [OPUS] })
  expect((await checkDeskModel(h.host, e.engine, OPUS, true)).kind).toBe('unsettable')
  expect(e.sets).toEqual([{ key: 'model', value: 'sonnet' }])
})

test('after the one attempt a mismatch is only noted (nothing is written to the app again); a request on the pin clears the state; an unknown model claims nothing', async () => {
  const h = world()
  const e = engine([modelRow(), effortRow()])
  const r = await checkDeskModel(h.host, e.engine, OPUS, false)
  expect(r.kind).toBe('unsettable')
  expect(e.sets).toEqual([]) // a later request never fights the user's own change of model
  expect(h.files.has(stateFile)).toBe(true)
  expect(deskModelText((await readDeskModel(h.host))!)).toContain('pick Sonnet')
  expect((await checkDeskModel(h.host, e.engine, 'claude-sonnet-5-5', false)).kind).toBe('match')
  expect(h.files.has(stateFile)).toBe(false)
  expect(notice(h, 'desk-model')).toBeUndefined()
  const u = world()
  expect((await checkDeskModel(u.host, engine([modelRow()]).engine, 'some-gateway-model', true)).kind).toBe('unknown')
  expect((await checkDeskModel(u.host, engine([modelRow()]).engine, '', true)).kind).toBe('unknown')
  expect(u.files.has(stateFile)).toBe(false)
})

test('the pane shows ONE top row for it, and the notice is not listed a second time', async ($, on) => {
  const h = fakeHost(on)
  h.files.set(`${L}/config.json`, SONNET_DESK)
  resetLocks()
  resetViewCache()
  h.files.set(stateFile, JSON.stringify({ running: OPUS, pin: PIN, at: NOON }))
  h.files.set(`${L}/notices/desk-model.txt`, deskModelText({ running: OPUS, pin: PIN as any, at: NOON }) + '\n')
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/h/lean-agent-desk', surface: 'desktop', isInteractive: true } as any)
  const ui = await $.ui.mount({ plugin: 'lean-agent', component: 'Pane', requestId: 'lean-agent', surface: 'desktop', props: { title: 'lean-agent', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as any)
  expect(await ui.find({ type: 'Text', text: "the desk runs claude-opus-5-5; pick Sonnet in the app's model menu (lean-agent pins sonnet / high)" })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /error: the desk runs/ })).toBeFalsy()
  await ui.unmount()
  h.files.delete(stateFile) // (the state and the notice go together when a request runs on the pin)
  h.files.delete(`${L}/notices/desk-model.txt`)
  resetViewCache()
  const ui2 = await $.ui.mount({ plugin: 'lean-agent', component: 'Pane', requestId: 'lean-agent', surface: 'desktop', props: { title: 'lean-agent', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as any)
  expect(await ui2.find({ type: 'Text', text: /the desk runs claude-opus-5-5/ })).toBeFalsy() // no state: no row
  await ui2.unmount()
})

// the desk session through the hooks: the first request of a session on another model is judged (and the state written when the engine
// has no way to set it); a request on the pin clears it
test('the desk\'s first request on another model writes the state when nothing can set it; a threads session never does', async ($, on) => {
  const h = fakeHost(on)
  h.files.set(`${L}/config.json`, SONNET_DESK)
  resetLocks()
  on('turn.step', async function* (_: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: { model: e.model, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as any
  })
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', title: 'x', project: 'p', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/h/lean-agent-desk', surface: 'desktop', isInteractive: true } as any)
  const step = async (model: string, i: number, agentId?: string) => {
    const st = $.turn.step({ turnId: 't', index: i, model, messageCount: 1, ...(agentId ? { agentId } : {}) } as any)
    for (;;) { const n = await st.next(); if (n.done) return n.value }
  }
  await step('claude-sonnet-5-5', 0)
  expect(h.files.has(stateFile)).toBe(false)
  await step('claude-opus-5-5', 1)
  const st = JSON.parse(h.files.get(stateFile) ?? 'null')
  expect(st).toMatchObject({ running: 'claude-opus-5-5', pin: PIN }) // (this test engine has no /config rows to set: the state is the fallback)
  await step('claude-sonnet-5-5', 2)
  expect(h.files.has(stateFile)).toBe(false)
  await step('claude-opus-5-5', 3, 'sub1') // a subagent's own model is nobody's pin
  expect(h.files.has(stateFile)).toBe(false)
})

test('through the hooks: a desk session that starts on another model has the Model and Effort rows set once, and says so at its next prompt', async ($, on) => {
  const h = fakeHost(on)
  h.files.set(`${L}/config.json`, SONNET_DESK)
  resetLocks()
  const sets: any[] = []
  let model = OPUS
  on('session.model', () => ({ value: model }) as any)
  on('config.list', () => ({ value: [modelRow(), effortRow()] }) as any)
  on('config.set', (_: any, e: any) => { sets.push({ key: e.key, value: e.value }); if (e.key === 'model') model = 'claude-sonnet-5-5'; return { value: e.value } as any })
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/h/lean-agent-desk', surface: 'desktop', isInteractive: true } as any)
  expect(sets).toEqual([{ key: 'model', value: 'sonnet' }, { key: 'effort', value: 'high' }])
  expect(notice(h, 'desk-model-set')).toContain('lean-agent set sonnet / high')
  expect(h.files.has(stateFile)).toBe(false)
})

test('a side request on a small model does not move the pin: the session\'s own model is judged, and what the mod set is a dim line, not an error', async ($, on) => {
  const h = fakeHost(on)
  h.files.set(`${L}/config.json`, SONNET_DESK)
  resetLocks()
  resetViewCache()
  const sets: any[] = []
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }) as any) // the session is on the pin
  on('config.list', () => ({ value: [modelRow({ value: 'sonnet' }), effortRow()] }) as any)
  on('config.set', (_: any, e: any) => { sets.push({ key: e.key, value: e.value }); return { value: e.value } as any })
  on('turn.step', async function* (_: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: { model: e.model, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as any
  })
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/h/lean-agent-desk', surface: 'desktop', isInteractive: true } as any)
  expect(sets).toEqual([{ key: 'effort', value: 'high' }]) // only the effort row differed
  const st = $.turn.step({ turnId: 't', index: 0, model: 'claude-haiku-5-5', messageCount: 1 } as any)
  for (;;) { const n = await st.next(); if (n.done) break }
  expect(h.files.has(stateFile)).toBe(false) // a title request on haiku is nobody's pin
  expect(sets).toHaveLength(1)
  expect(notice(h, 'desk-model-set')).toContain("the desk's effort was not high")
  const ui = await $.ui.mount({ plugin: 'lean-agent', component: 'Pane', requestId: 'lean-agent', surface: 'desktop', props: { title: 'lean-agent', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as any)
  expect(await ui.find({ type: 'Text', text: /the desk's effort was not high/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /error: the desk's effort/ })).toBeFalsy()
  await ui.unmount()
})

// ---- the doctor's wording ------------------------------------------------------------------------------------------------------
const desk = (startedAt: number, model = OPUS) => ({ sessionId: 'D', status: 'busy', model, cwd: '/h/lean-agent-desk', startedAt })
function spent(rows: unknown[], pinned?: { at: number; model: string }) {
  const h = world()
  h.files.set(`${L}/ledger.jsonl`, JSON.stringify({ ts: NOON, role: 'desk', model: OPUS, in: 1000, out: 100, cache_read: 5000, cache_write: 200, usd: 0.65 }) + '\n')
  if (pinned) h.files.set(`${L}/desk/pinned.json`, JSON.stringify(pinned))
  h.claude.handler = (a: string[]) => (a[0] === 'agents' ? { exitCode: 0, stdout: JSON.stringify(rows) } : { exitCode: 0, stdout: '' })
  return h
}
const deskLine = async (h: any) => (await modelMismatches(h.host)).find(l => l.startsWith('the desk spent'))

test('doctor: "started before setup pinned the model" only when the live desk session started before the pin was written; else the app chose it', async () => {
  const known = await deskLine(spent([desk(NOON - 7_200_000)], { at: NOON - 3_600_000, model: 'sonnet' }))
  expect(known).toBe('the desk spent $0.65 today on claude-opus-5-5, lean-agent pins sonnet: that session started before setup pinned the model; close it and open the desk again')
  const chose = 'the desk spent $0.65 today on claude-opus-5-5, lean-agent pins sonnet: the app chose another model for this session: pick Sonnet in its model menu'
  expect(await deskLine(spent([desk(NOON - 1_800_000)], { at: NOON - 3_600_000, model: 'sonnet' }))).toBe(chose) // started after the pin
  expect(await deskLine(spent([desk(NOON - 7_200_000)]))).toBe(chose) // no record of when the pin was written
  expect(await deskLine(spent([], { at: NOON - 3_600_000, model: 'sonnet' }))).toBe(chose) // no live desk session to compare with
  expect(await deskLine(spent([desk(0)], { at: NOON - 3_600_000, model: 'sonnet' }))).toBe(chose) // no start time
  expect(await deskLine(spent([desk(NOON - 7_200_000)], { at: NOON - 3_600_000, model: 'opus' }))).toBe(chose) // the record is for another pin
  expect(await deskLine(spent([desk(NOON - 7_200_000, 'claude-sonnet-5-5')], { at: NOON - 3_600_000, model: 'sonnet' }))).toContain('the app chose another model') // it runs the pin now: no "started before"
  expect(await deskLine(spent([desk(NOON - 100, 'claude-sonnet-5-5')]))).toBe(`${chose} (the live desk session runs sonnet now)`) // the spend is of an earlier session
})

test('doctor: spend on the model the app started the desk on is an info note, not FIX, once lean-agent switched the session to the pin', async () => {
  const note = `the app started the desk on ${OPUS}; lean-agent switched it to sonnet ($0.65 spent on ${OPUS} today)`
  // the switch is recorded when the session was really moved (verified), and only then
  const h = spent([desk(NOON - 100, 'claude-sonnet-5-5')])
  expect(await deskLine(h)).toContain('the app chose another model') // no record yet: still FIX
  const e = engine([modelRow(), effortRow()], { models: ['claude-sonnet-5-5'] })
  expect((await checkDeskModel(h.host, e.engine, OPUS, true)).kind).toBe('set')
  expect(JSON.parse(h.files.get(`${L}/desk/model-set.json`)!)).toEqual({ from: OPUS, to: 'sonnet', at: NOON, count: 1 })
  expect(await deskLine(h)).toBeUndefined() // not a FIX row any more
  expect((await modelRows(h.host)).info).toEqual([note])
  expect((await modelRows(h.host)).fix).toEqual([])
  // doctor shows it as a note and says nothing is unexpected
  const rows = await check(h.host, '/p')
  expect(rows).toContain(`note ${note}`)
  expect(rows).toContain('ok   no session on an unexpected model today')
  expect(rows.filter(r => r.startsWith('FIX ')).join('\n')).not.toContain('the desk spent')
  // a switch that did not take (the row was written but the model stayed) leaves no record
  const n = spent([])
  const stuck = engine([modelRow(), effortRow()], { models: [OPUS] })
  expect((await checkDeskModel(n.host, stuck.engine, OPUS, true)).kind).toBe('unsettable')
  expect(n.files.has(`${L}/desk/model-set.json`)).toBe(false)
  expect(await deskLine(n)).toContain('the app chose another model')
  // spend on ANOTHER model than the one switched from stays FIX
  const o = spent([])
  o.files.set(`${L}/desk/model-set.json`, JSON.stringify({ from: 'claude-haiku-5-5', to: 'sonnet', at: NOON - 1000 }))
  expect(await deskLine(o)).toContain('the app chose another model')
  // a record of two days ago does not explain today's spend
  const y = spent([])
  y.files.set(`${L}/desk/model-set.json`, JSON.stringify({ from: OPUS, to: 'sonnet', at: NOON - 2 * 86_400_000 }))
  expect(await deskLine(y)).toContain('the app chose another model')
  // a later session that could not be set (model.json is there) is a FIX again
  const u = spent([])
  u.files.set(`${L}/desk/model-set.json`, JSON.stringify({ from: OPUS, to: 'sonnet', at: NOON - 1000 }))
  u.files.set(stateFile, JSON.stringify({ running: OPUS, pin: PIN, at: NOON }))
  expect(await deskLine(u)).toContain('the app chose another model')
  // the pin changed since (the record is for another pin)
  const p = spent([])
  p.files.set(`${L}/desk/model-set.json`, JSON.stringify({ from: OPUS, to: 'opus', at: NOON - 1000 }))
  expect(await deskLine(p)).toContain('the app chose another model')
})

test('doctor fix: the pin time is recorded only when setup changes the pin', async () => {
  const h = world()
  h.files.set('/h/lean-agent-desk/CLAUDE.md', 'desk')
  h.files.set(`/p/templates/front-desk.md`, 'desk {{lean}}')
  h.files.set(`/p/templates/thread.md`, '# {{id}}')
  h.files.set(`/p/opener/open-desk.sh`, '#!/bin/sh\n')
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  await fix(h.host, '/p').catch(() => undefined)
  const first = JSON.parse(h.files.get(`${L}/desk/pinned.json`) ?? 'null')
  expect(first).toMatchObject({ at: NOON, model: 'sonnet', effort: 'high' })
  h.clock.t = NOON + 5_000
  await fix(h.host, '/p').catch(() => undefined)
  expect(JSON.parse(h.files.get(`${L}/desk/pinned.json`)!).at).toBe(NOON) // unchanged pin: not rewritten
  h.files.set('/h/lean-agent-desk/.claude/settings.json', JSON.stringify({ model: 'opus', effortLevel: 'high' }))
  await fix(h.host, '/p').catch(() => undefined)
  expect(JSON.parse(h.files.get(`${L}/desk/pinned.json`)!).at).toBe(NOON + 5_000) // changed back: written again
})

// ---- the pin holds against the app choosing again (1.0.20) ------------------------------------------------------------------------
import { appChoseText, decideSwitch, newSwitchState, noteSdkSwitch, noteSwitched, noteUserChoice, readDeskSwitch, selfSwitching } from './deskmodel'

const isExp = (m: string) => /opus|fable/.test(m)
const sonnetPin = { model: 'sonnet', effort: 'high' } as any

test('the app choosing opus again and again in one session: the pin goes back each time, ONE line says so the first time, the count follows', async () => {
  const h = world()
  const rows = [modelRow(), effortRow({ value: 'high' })]
  const e = engine(rows, { models: ['claude-sonnet-5-5'] })
  const first = await checkDeskModel(h.host, e.engine, OPUS, true, 's1')
  expect(first.kind).toBe('set')
  expect(first.repeat).toBeUndefined()
  expect(first.text).toContain('the app chose it')
  const second = await checkDeskModel(h.host, e.engine, OPUS, true, 's1')
  expect(second.repeat).toBe(true)
  expect(second.text).toBe('the app chose opus twice this session; lean-agent set sonnet each time')
  const third = await checkDeskModel(h.host, e.engine, OPUS, true, 's1')
  expect(third.text).toBe(appChoseText(OPUS, 3, 'sonnet'))
  expect(third.text).toContain('3 times')
  expect(notice(h, 'desk-model-set')).toContain('3 times') // the notice carries the count, the prompt line was said once
  expect((await readDeskSwitch(h.host))?.count).toBe(3)
  // another session starts over
  const other = await checkDeskModel(h.host, e.engine, OPUS, true, 's2')
  expect(other.repeat).toBeUndefined()
  expect((await readDeskSwitch(h.host))?.count).toBe(1)
})

test('a model the person chose by hand is not put back in that session', async () => {
  const h = world()
  const e = engine([modelRow(), effortRow({ value: 'high' })], { models: ['claude-sonnet-5-5'] })
  await noteUserChoice(h.host, OPUS, 's1')
  const r = await checkDeskModel(h.host, e.engine, OPUS, true, 's1')
  expect(r.kind).toBe('match')
  expect(e.sets).toEqual([])
  const next = await checkDeskModel(h.host, e.engine, OPUS, true, 's2') // a new session: the pin applies again
  expect(next.kind).toBe('set')
})

test('PreModelSwitch: the app\'s expensive model is asked once, then refused; /model and the picker are never touched; our own switch is ignored', () => {
  const st = newSwitchState()
  const ev = (source: string, to = OPUS) => ({ from_model: 'claude-sonnet-5-5', to_model: to, source })
  expect(decideSwitch(ev('command'), sonnetPin, st, isExp)).toEqual({ user: OPUS }) // /model opus: the person's, stands
  expect(decideSwitch(ev('picker'), sonnetPin, st, isExp)).toEqual({ user: OPUS })
  expect(decideSwitch(ev('sdk', 'claude-sonnet-5-5'), sonnetPin, newSwitchState(), isExp)).toEqual({}) // the pin itself
  expect(decideSwitch(ev('sdk', 'claude-haiku-5-5'), sonnetPin, newSwitchState(), isExp)).toEqual({}) // not expensive
  expect(decideSwitch(ev('auto'), sonnetPin, newSwitchState(), isExp)).toEqual({}) // a fallback is not ours to block
  expect(decideSwitch(ev('resume'), sonnetPin, newSwitchState(), isExp)).toEqual({})
  const app = newSwitchState()
  const a = decideSwitch(ev('sdk'), sonnetPin, app, isExp)
  expect(a.decision).toBe('ask')
  expect(a.reason).toContain('/model opus')
  const b = decideSwitch(ev('sdk'), sonnetPin, app, isExp)
  expect(b.decision).toBe('deny')
  expect(b.reason).toContain('/model opus')
  expect(app.denied).toBe(1)
  // the person said yes to the question (the switch ran): it stands for the session
  noteSwitched(ev('sdk'), app)
  expect(decideSwitch(ev('sdk'), sonnetPin, app, isExp)).toEqual({})
  // a model the person chose by hand earlier in the session stands too
  const hand = newSwitchState()
  hand.user = OPUS
  expect(decideSwitch(ev('sdk'), sonnetPin, hand, isExp)).toEqual({})
  expect(selfSwitching()).toBe(false)
})

test('our own config.set is not taken for the person: selfSwitching is on while the pin is written', async () => {
  const h = world()
  let during = false
  const eng = { configList: async () => [modelRow(), effortRow({ value: 'high' })], configSet: async () => { during = during || selfSwitching(); return {} }, model: async () => 'claude-sonnet-5-5' }
  await checkDeskModel(h.host, eng as any, OPUS, true, 's1')
  expect(during).toBe(true)
  expect(selfSwitching()).toBe(false)
})

test('a refused app choice counts into the same one-line tally and the record says the engine cannot tell the app from its menu; the doctor row says so', async () => {
  const h = world()
  await noteSdkSwitch(h.host, OPUS, 's1', false) // asked
  expect((await readDeskSwitch(h.host))?.blind).toBe(true)
  await noteSdkSwitch(h.host, OPUS, 's1', true) // refused
  await noteSdkSwitch(h.host, OPUS, 's1', true)
  const sw = await readDeskSwitch(h.host)
  expect(sw?.count).toBe(2)
  expect(sw?.blind).toBe(true)
  expect(notice(h, 'desk-model-set')).toContain('the app chose opus twice this session; lean-agent set sonnet each time')
  const rows = await modelRows(h.host)
  expect(rows.info.join('\n')).toContain('the app chose opus twice this session; lean-agent set sonnet each time')
  expect(rows.info.join('\n')).toContain('cannot tell the app\'s choice from its model menu')
})
