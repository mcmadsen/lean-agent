// The desk's model and effort pin (opus / high, the user's decision; config.json `desk` overrides) against what the session really runs on.
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
// ("the desk runs <model>; pick Opus in the app's model menu ...") and a notice. The file is removed when a later request runs on the pin.
// Never in a thread: a thread is started with `--model` / `--effort` on the command line.
import { atomicWrite, homeDir, leanDir, mkdirp, readJson } from './state'
import type { Host } from './state'
import { MODELS, deskChoice, modelFamily } from './models'
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
export async function applyPin(eng: Engine, pin: Choice, needModel: boolean): Promise<Applied> {
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

export type CheckResult = { kind: 'match' | 'unknown' | 'set' | 'unsettable'; text?: string }
// `running`: the model the session (or its request) runs on. `apply`: this is the one attempt of the session. Writes the state / notice.
export async function checkDeskModel(h: Host, eng: Engine | null, running: string, apply: boolean): Promise<CheckResult> {
  const pin = await deskChoice(h, await homeDir(h))
  const fam = modelFamily(running)
  if (!(MODELS as readonly string[]).includes(fam)) return { kind: 'unknown' } // a gateway's own name, or nothing yet: no claim
  const need = fam !== pin.model
  let done: Applied | null = null
  if (apply) await setNotice(h, NOTICE_SET, null) // a new session's attempt: the last one's note is old
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
      // only what was really written is claimed; `$.config.set` is the /config menu's own writer, so the app may keep it as the default
      const eff = done.effort ? ` / ${pin.effort}` : ` (effort not changed: ${done.why.find(w => /effort/.test(w)) ?? 'it already was the pin'})`
      const text = `the desk was on ${running} (the app chose it); lean-agent set ${pin.model}${eff} through /config (the app may keep that as your default for new sessions)`
      await setNotice(h, NOTICE_SET, text) // (shown until the next desk session's attempt)
      return { kind: 'set', text }
    }
  }
  const st: DeskModelState = { running: running.slice(0, 80), pin, at: await h.clock.now() }
  await mkdirp(h, `${leanDir(await homeDir(h))}/desk`)
  await atomicWrite(h, stateFile(await homeDir(h)), JSON.stringify(st) + '\n')
  const text = deskModelText(st)
  await setNotice(h, NOTICE_KEY, text)
  return { kind: 'unsettable', text }
}
