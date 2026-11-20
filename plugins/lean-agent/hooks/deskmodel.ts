// The desk's model and effort pin (sonnet / high, the user's decision; config.json `desk` overrides) against what the session really runs on.
// A desk the app started on an expensive model (opus, fable) is switched to the pin here; when that is not possible the pane says so in a
// red "Needs you" row (view.ts), never silently.
//
// The pin is written to the desk folder's settings.json, but a session the Claude app starts (by hand, or through the
// claude://code/new deep link) may take the app's own model menu instead. What the engine gives a plugin (types: EventCalls):
//   $.session.model()          reads the session's model (a getter; there is no setter)
//   $.config.list() / set()    the `/config` rows, "as if the person did in the menu": a Model row and an Effort row when this build
//                              has them (a choice row with its options; a locked row, an unknown key or a `{ deny }` is a refusal)
//   turn.step                  a hook may rewrite `model` / `effort` of ONE request going down. Not used: it would override the user's
//                              own menu choice at every step and leave the app's model menu showing something else.
// So, once per desk session (at session.start when the model is known then, else at the first request): when the model (or the effort
// row) differs from the pin, the Model / Effort rows are set through `$.config.set`. When that is not possible (no such row, no option
// of that family, locked, denied, throws) nothing is forced: the state is written to ~/.lean-agent/desk/model.json for the pane's top row
// ("the desk runs <model>; pick Sonnet in the app's model menu ...") and a notice. The file is removed when a later request runs on the pin.
// Never in a thread: a thread is started with `--model` / `--effort` on the command line.
import { atomicWrite, homeDir, leanDir, mkdirp, readJson } from './state'
import type { Host } from './state'
import { DESK_FAMILIES, deskChoice, modelFamily } from './models'
import type { Choice } from './models'
import { setNotice } from './notices'

export type DeskModelState = { running: string; pin: Choice; at: number }
export const NOTICE_KEY = 'desk-model' // the pin could not be applied (cleared when a request runs on it)
export const NOTICE_SET = 'desk-model-set' // the mod applied it (one line, until the next session's attempt)
const stateFile = (home: string) => `${leanDir(home)}/desk/model.json`
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

// the one sentence: the pane's top row and the notice
export const deskModelText = (m: DeskModelState): string => `the desk runs ${m.running}; pick ${cap(m.pin.model)} in the app's model menu (lean-agent pins ${m.pin.model} / ${m.pin.effort})`

export async function readDeskModel(h: Host): Promise<DeskModelState | null> {
  const v = await readJson<Partial<DeskModelState> | null>(h, stateFile(await homeDir(h)), null)
  return v && typeof v.running === 'string' && v.pin && typeof v.pin.model === 'string' && typeof v.pin.effort === 'string' ? { running: v.running.slice(0, 80), pin: { model: v.pin.model, effort: v.pin.effort }, at: Number(v.at) || 0 } : null
}
// The record of a switch (kept, unlike model.json): the app started the desk on `from`, lean-agent switched the session to `to` at `at`.
// Doctor reads it so that the spend on `from` before the switch is not reported as a session on an unexpected model.
// `session`/`count`/`denied`/`user`: this session's tally of the app choosing an expensive model again (1.0.20): `count` times the app chose `from`
// and lean-agent put the pin back (a reapply through /config or a refused PreModelSwitch), `user` the model the person chose by hand
// (/model, the picker: never reverted), `blind` that the engine could not tell the app's choice from the app menu's (source "sdk" for both)
export type DeskSwitch = { from: string; to: string; at: number; session?: string; count?: number; user?: string; blind?: boolean }
const switchFile = (home: string) => `${leanDir(home)}/desk/model-set.json`
async function writeSwitch(h: Host, s: DeskSwitch): Promise<void> {
  const home = await homeDir(h)
  await mkdirp(h, `${leanDir(home)}/desk`)
  await atomicWrite(h, switchFile(home), JSON.stringify(s) + '\n')
}
export async function readDeskSwitch(h: Host): Promise<DeskSwitch | null> {
  const v = await readJson<Partial<DeskSwitch> | null>(h, switchFile(await homeDir(h)), null)
  if (!(v && typeof v.from === 'string' && typeof v.to === 'string' && typeof v.at === 'number' && v.at > 0)) return null
  return { from: v.from, to: v.to, at: v.at, ...(typeof v.session === 'string' && v.session ? { session: v.session } : {}), ...(typeof v.count === 'number' && v.count > 0 ? { count: v.count } : {}), ...(typeof v.user === 'string' && v.user ? { user: v.user } : {}), ...(v.blind === true ? { blind: true } : {}) }
}
async function clearState(h: Host): Promise<void> {
  const f = stateFile(await homeDir(h))
  await setNotice(h, NOTICE_KEY, null) // the notice first: a pane load in between never shows it as a stray red line
  if (await h.fs.exists(f).catch(() => false)) await h.process.run(['rm', '-f', f]).catch(() => undefined)
}

// what the mod needs of the engine ($.session.model, $.config.list, $.config.set), each bounded by the caller
export type Engine = {
  configList: () => Promise<unknown>
  configSet: (a: { key: string; value: string }) => Promise<unknown>
  model: () => Promise<unknown>
}
type Row = { key: string; label?: string; kind?: string; value?: unknown; options?: readonly string[]; isLocked?: boolean }
const rowsOf = (v: unknown): Row[] => (Array.isArray(v) ? v.filter((r): r is Row => !!r && typeof r === 'object' && typeof (r as Row).key === 'string') : [])
const isModelRow = (r: Row) => /^model$/i.test(r.key) || /^model$/i.test(r.label ?? '')
const isEffortRow = (r: Row) => /^effort(level)?$/i.test(r.key) || /^effort$/i.test(r.label ?? '')

export type Applied = { model: boolean; effort: boolean; why: string[] }
// Sets the rows that differ. `needModel`: the running model is not the pin's. Each refusal is a reason; nothing throws.
// our own `$.config.set` raises a PreModelSwitch too (source "command"): it is not the person's choice
let selfSwitch = 0
export const selfSwitching = () => selfSwitch > 0
export async function applyPin(eng: Engine, pin: Choice, needModel: boolean): Promise<Applied> {
  selfSwitch++
  try {
    return await applyPinInner(eng, pin, needModel)
  } finally {
    selfSwitch--
  }
}
async function applyPinInner(eng: Engine, pin: Choice, needModel: boolean): Promise<Applied> {
  const out: Applied = { model: false, effort: false, why: [] }
  let rows: Row[]
  try {
    rows = rowsOf(await eng.configList())
  } catch (e) {
    out.why.push(`config.list: ${String((e as Error)?.message ?? e).slice(0, 80)}`)
    return out
  }
  const set = async (what: 'model' | 'effort', r: Row | undefined, want: (o: string) => boolean) => {
    if (!r) return out.why.push(`no ${what} row`)
    if (r.isLocked) return out.why.push(`the ${what} row is locked`)
    const opt = (r.options ?? []).find(o => typeof o === 'string' && want(o))
    if (!opt) return out.why.push(`the ${what} row has no ${pin[what]} option`)
    try {
      const res = (await eng.configSet({ key: r.key, value: opt })) as { deny?: string } | undefined
      if (res?.deny) return out.why.push(`the ${what} row refused: ${String(res.deny).slice(0, 80)}`)
      out[what] = true
    } catch (e) {
      out.why.push(`${what}: ${String((e as Error)?.message ?? e).slice(0, 80)}`)
    }
  }
  // the exact option first (`sonnet`), then the family (`opusplan` or `sonnet[1m]` never beat the plain one)
  if (needModel) { const mr = rows.find(isModelRow); const exact = (mr?.options ?? []).some(o => o === pin.model); await set('model', mr, o => (exact ? o === pin.model : modelFamily(o) === pin.model)) }
  const er = rows.find(isEffortRow)
  if (!er) out.why.push('no effort row')
  else if (String(er.value ?? '').toLowerCase() !== pin.effort) await set('effort', er, o => o.toLowerCase() === pin.effort)
  return out
}

export type CheckResult = { kind: 'match' | 'unknown' | 'set' | 'unsettable'; text?: string; repeat?: boolean }
const times = (n: number) => (n === 2 ? 'twice' : `${n} times`)
// `running`: the model the session (or its request) runs on. `apply`: put the pin back now (the first request of a session, or a later prompt
// whose session model is not the pin again). `session`: the session id; the tally of the app choosing again is kept per session in model-set.json.
// A model the person chose by hand (a PreModelSwitch with source command / picker, noteUserChoice) is never put back. Writes the state / notice.
export async function checkDeskModel(h: Host, eng: Engine | null, running: string, apply: boolean, session = ''): Promise<CheckResult> {
  const pin = await deskChoice(h, await homeDir(h))
  const fam = modelFamily(running)
  if (!DESK_FAMILIES.includes(fam)) return { kind: 'unknown' } // a gateway's own name, or nothing yet: no claim
  const need = fam !== pin.model
  const prev = await readDeskSwitch(h)
  const same = !!session && prev?.session === session
  if (need && same && prev?.user && modelFamily(prev.user) === fam) return { kind: 'match' } // the person chose it: not ours to undo
  let done: Applied | null = null
  if (apply && !same) await setNotice(h, NOTICE_SET, null) // a new session's attempt: the last one's note is old
  if (apply && eng) done = await applyPin(eng, pin, need)
  if (!need) {
    await clearState(h)
    if (done?.effort) {
      const text = `the desk's effort was not ${pin.effort}: lean-agent set it through /config (the app may keep that as your default for new sessions)`
      await setNotice(h, NOTICE_SET, text)
      return { kind: 'set', text }
    }
    return { kind: 'match' }
  }
  if (done?.model) {
    // verified when the engine can say: a row that was written but did not move the model is no success
    const now = eng ? String(await eng.model().catch(() => '')) : ''
    if (!now || modelFamily(now) === pin.model) {
      await clearState(h)
      const n = await noteAppChoice(h, running, pin.model, session)
      // only what was really written is claimed; `$.config.set` is the /config menu's own writer, so the app may keep it as the default
      const eff = done.effort ? ` / ${pin.effort}` : ` (effort not changed: ${done.why.find(w => /effort/.test(w)) ?? 'it already was the pin'})`
      const text = n > 1 ? appChoseText(running, n, pin.model) : `the desk was on ${running} (the app chose it); lean-agent set ${pin.model}${eff} through /config (the app may keep that as your default for new sessions)`
      await setNotice(h, NOTICE_SET, text) // (shown until the next desk session's attempt)
      return { kind: 'set', text, ...(n > 1 ? { repeat: true } : {}) }
    }
  }
  const st: DeskModelState = { running: running.slice(0, 80), pin, at: await h.clock.now() }
  await mkdirp(h, `${leanDir(await homeDir(h))}/desk`)
  await atomicWrite(h, stateFile(await homeDir(h)), JSON.stringify(st) + '\n')
  const text = deskModelText(st)
  await setNotice(h, NOTICE_KEY, text)
  return { kind: 'unsettable', text }
}

// ---- the app choosing again (1.0.20) --------------------------------------------------------------------------------------------
// The engine's PreModelSwitch says who asked: `command` (/model, the /config Model row: also lean-agent's own, see selfSwitching), `picker`
// (the interactive picker), `sdk` (a headless set_model: the Claude app's default AND its model menu alike: not told apart), `auto` (a fallback),
// `resume`. The report is ONE line per session with a count; the tally lives in model-set.json (a session's id), the pane notice carries it.
export const appChoseText = (model: string, n: number, pin: string) => `the app chose ${modelFamily(model) || model} ${times(n)} this session; lean-agent set ${pin} each time`
async function noteAppChoice(h: Host, from: string, to: string, session: string): Promise<number> {
  const prev = await readDeskSwitch(h)
  const same = !!session && prev?.session === session && modelFamily(prev.from) === modelFamily(from)
  const count = (same ? (prev?.count ?? 0) : 0) + 1
  await writeSwitch(h, { from: from.slice(0, 80), to, at: await h.clock.now(), ...(session ? { session } : {}), count, ...(same && prev?.user ? { user: prev.user } : {}), ...(prev?.blind ? { blind: true } : {}) }).catch(() => undefined) // (doctor: today's spend on that model is info, not FIX)
  return count
}
// the person chose `model` by hand: this session keeps it
export async function noteUserChoice(h: Host, model: string, session: string): Promise<void> {
  const prev = await readDeskSwitch(h)
  const same = !!session && prev?.session === session
  await writeSwitch(h, { from: same ? prev!.from : model.slice(0, 80), to: same ? prev!.to : model.slice(0, 80), at: await h.clock.now(), ...(session ? { session } : {}), ...(same && prev?.count ? { count: prev.count } : {}), user: model.slice(0, 80), ...(prev?.blind ? { blind: true } : {}) }).catch(() => undefined)
}

export type SwitchIn = { from_model?: string; to_model?: string; source?: string }
export type SwitchState = { user: string; asked: Set<string>; allowed: Set<string>; denied: number }
export const newSwitchState = (): SwitchState => ({ user: '', asked: new Set(), allowed: new Set(), denied: 0 })
export type SwitchDecision = { decision?: 'ask' | 'deny'; reason?: string; user?: string }
// What to answer a PreModelSwitch on the desk. Nothing (pass) for: our own switch, a model that is not expensive, a switch the person made
// (command / picker: it also ends the pin for the session), a fallback or resume, and a model the person already allowed or chose. The
// app's choice (source sdk) of an expensive model is ASKED once per session and per model (the person's yes, or a menu click they confirm, then
// stands for the session); a later one the person did not allow is denied, with a reason that says how to switch by hand.
export function decideSwitch(e: SwitchIn, pin: Choice, st: SwitchState, expensive: (m: string) => boolean): SwitchDecision {
  const to = String(e.to_model ?? '')
  if (!to || selfSwitching() || !expensive(to) || modelFamily(to) === pin.model) return {}
  if (e.source === 'command' || e.source === 'picker') return { user: to }
  if (e.source !== 'sdk') return {}
  const fam = modelFamily(to)
  if (st.user && modelFamily(st.user) === fam) return {}
  if (st.allowed.has(fam)) return {}
  if (!st.asked.has(fam)) {
    st.asked.add(fam)
    return { decision: 'ask', reason: `lean-agent keeps the desk on ${pin.model} (config desk.model): the app asked for ${to}. Allow it for this session? (/model ${fam} switches by hand)` }
  }
  st.denied++
  return { decision: 'deny', reason: `lean-agent keeps the desk on ${pin.model}; the app asked for ${to} again. Type /model ${fam} to switch by hand.` }
}
// a switch that did run (PostModelSwitch): an app choice the person allowed stands
export function noteSwitched(e: SwitchIn, st: SwitchState): void {
  const to = String(e.to_model ?? '')
  if (to && e.source === 'sdk' && st.asked.has(modelFamily(to))) st.allowed.add(modelFamily(to))
}
// the app's choice was asked about or refused: it counts (the one line per session carries the tally), and the record says the engine could not tell
export async function noteSdkSwitch(h: Host, to: string, session: string, refused: boolean): Promise<void> {
  const pin = await deskChoice(h, await homeDir(h))
  if (!refused) {
    const prev = await readDeskSwitch(h)
    if (prev?.session === session && prev.blind) return
    await writeSwitch(h, { ...(prev?.session === session && session ? prev : { from: to.slice(0, 80), to: pin.model, at: await h.clock.now(), ...(session ? { session } : {}) }), blind: true }).catch(() => undefined)
    return
  }
  const n = await noteAppChoice(h, to, pin.model, session)
  const prev = await readDeskSwitch(h)
  if (prev && !prev.blind) await writeSwitch(h, { ...prev, blind: true }).catch(() => undefined)
  await setNotice(h, NOTICE_SET, appChoseText(to, n, pin.model))
}
