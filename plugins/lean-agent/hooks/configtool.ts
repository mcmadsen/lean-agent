// `lean_config` (1.0.31): read and change ~/.lean-agent/config.json through the registry (configkeys.ts), never by hand-editing.
//   list [group] | get key | set key value | unset key | validate
// The write is atomic, keeps keys it does not know and the file's nesting style (nested or flat "a.b"), never writes a secret, and says when the
// change applies. A file that is not valid JSON is never overwritten.
// SENSITIVE keys (they loosen a safety rule): changed only when the user's OWN typed words this session name the key (humanprompts.ts, as
// allow-writes does), or when the user pressed Approve on the mod's own question for exactly this change (a signed offer bound to its id, as allow-ask does:
// bindConfigAnswers is called by the desk's AskUserQuestion hook and applies the change itself). Everything else is refused with the way forward.
import { appendJsonl, atomicWrite, homeDir, leanDir } from './state'
import type { Host } from './state'
import { macOf } from './reviews'
import { destination } from './deliver'
import { recentPrompts } from './humanprompts'
import { typedApproval } from './writeinstr'
import { APPLIES_TEXT, DEPRECATED, GROUPS, REGISTRY, allSpellings, checkValue, currentOf, defaultText, deprecatedKey, deprecatedText, entriesOf, findEntry, locate, nearestKey, parseValue, sameValue, show } from './configkeys'
import type { Cfg, Entry } from './configkeys'

export type Asked = { question: string; options: { label: string; description: string }[] }
export type ConfigResult = { ok: boolean; text: string; ask?: Asked }
export type ConfigArgs = { action?: unknown; group?: unknown; key?: unknown; value?: unknown }

const isObj = (v: unknown): v is Cfg => !!v && typeof v === 'object' && !Array.isArray(v)
export const configFile = (home: string) => `${leanDir(home)}/config.json`
const HISTORY = (home: string) => `${leanDir(home)}/config-history.jsonl`
const AT = '~/.lean-agent/config.json'

// ---- the file ----
type Loaded = { cfg: Cfg; raw: string; error?: string }
async function load(h: Host, home: string): Promise<Loaded> {
  const p = configFile(home)
  if (!(await h.fs.exists(p))) return { cfg: {}, raw: '' }
  const raw = String(await h.fs.read(p).catch(() => ''))
  if (!raw.trim()) return { cfg: {}, raw }
  try {
    const v = JSON.parse(raw)
    return isObj(v) ? { cfg: v, raw } : { cfg: {}, raw, error: 'it is not a JSON object' }
  } catch (e) {
    return { cfg: {}, raw, error: `it is not valid JSON (${String((e as Error)?.message ?? e).slice(0, 80)})` }
  }
}
const indentOf = (raw: string): string => /\n([ \t]+)"/.exec(raw)?.[1] ?? '  '
async function save(h: Host, home: string, cfg: Cfg, raw: string): Promise<void> {
  await atomicWrite(h, configFile(home), JSON.stringify(cfg, null, indentOf(raw)) + '\n')
}
const parts = (s: string) => s.split('.')
function setNested(cfg: Cfg, key: string, v: unknown): string | null {
  const p = parts(key)
  let o = cfg
  for (const s of p.slice(0, -1)) {
    if (o[s] === undefined) o[s] = {}
    if (!isObj(o[s])) return `"${s}" in config.json is not an object, so ${key} cannot be put under it: fix that first (lean_config validate)`
    o = o[s] as Cfg
  }
  o[p[p.length - 1]!] = v
  return null
}
function removeSpelling(cfg: Cfg, spelling: string): boolean {
  if (spelling in cfg) {
    delete cfg[spelling]
    return true
  }
  const p = parts(spelling)
  const chain: Cfg[] = [cfg]
  for (const s of p.slice(0, -1)) {
    const next = chain[chain.length - 1]![s]
    if (!isObj(next)) return false
    chain.push(next)
  }
  const last = p[p.length - 1]!
  if (!(last in chain[chain.length - 1]!)) return false
  delete chain[chain.length - 1]![last]
  for (let i = chain.length - 1; i > 0; i--) if (Object.keys(chain[i]!).length === 0) delete chain[i - 1]![p[i - 1]!] // an emptied parent goes too
  return true
}
// where a new value goes: where it already is, else nested, else flat only when the key's reader accepts it and the file already writes flat
function styleFor(cfg: Cfg, e: Entry): 'flat' | 'nested' {
  const cur = currentOf(cfg, e)
  if (cur && (cur.style === 'nested' || e.flat)) return cur.style
  if (!e.flat) return 'nested'
  if (isObj(cfg[parts(e.key)[0]!])) return 'nested'
  return Object.keys(cfg).some(k => k.includes('.')) ? 'flat' : 'nested'
}

// ---- problems of a whole file ----
type Leaf = { path: string; value: unknown; flat: boolean }
const isContainer = (path: string) => REGISTRY.some(e => allSpellings(e).some(s => s.startsWith(`${path}.`))) || Object.keys(DEPRECATED).some(k => k.startsWith(`${path}.`))
function leaves(cfg: Cfg): Leaf[] {
  const out: Leaf[] = []
  const walk = (path: string, v: unknown, flat: boolean) => {
    if (findEntry(path)) out.push({ path, value: v, flat })
    else if (isObj(v) && isContainer(path)) for (const [k, c] of Object.entries(v)) walk(`${path}.${k}`, c, flat)
    else out.push({ path, value: v, flat })
  }
  for (const [k, v] of Object.entries(cfg)) if (!/^(_|\/\/|\$)/.test(k)) walk(k, v, k.includes('.'))
  return out
}
export type Report = { total: number; differ: { key: string; value: unknown }[]; problems: string[]; keys: string[] } // keys: the setting each problem is about, in the same order
export function reportOf(cfg: Cfg): Report {
  const r: Report = { total: 0, differ: [], problems: [], keys: [] }
  for (const l of leaves(cfg)) {
    r.total++
    const e = findEntry(l.path)
    if (!e) {
      const dep = deprecatedKey(l.path)
      if (dep) { // a key of an earlier version (the USD budgets): said as such, enforces nothing, kept until the user removes it
        r.problems.push(`${deprecatedText(dep)} (it enforces nothing and is kept: lean_config unset ${l.path} removes it)`)
        r.keys.push(l.path)
        continue
      }
      const near = nearestKey(l.path)
      // a group name (desk, threads, ...) written as a bare key with a value that is not an object ({}, a text, a number, null, a list): the group holds settings, it is not one
      if (isContainer(l.path)) r.problems.push(`"${l.path}" is a group of settings (${l.path}.<name>) and must hold an object; ${l.value === null ? 'null' : Array.isArray(l.value) ? 'a list' : typeof l.value} is not read (it is kept: lean_config unset ${l.path} removes it)`)
      else r.problems.push(`unknown setting "${l.path}"${near ? `: did you mean ${near}?` : ''} (not read by any 1.0.x version; it is kept: lean_config unset ${l.path} removes it)`)
      r.keys.push(l.path)
      continue
    }
    const c = checkValue(e, l.value)
    if (!c.ok) {
      r.problems.push(`${e.key} ${show(l.value).slice(0, 40)}: ${c.why} (the default is used)`)
      r.keys.push(e.key)
      continue
    }
    if (l.flat && !e.flat) {
      r.problems.push(`${l.path} is written flat, but only the nested form is read for it ("${parts(e.key)[0]}": { ... }): it is ignored`)
      r.keys.push(l.path)
    }
    if (!sameValue(c.value, e.default === null ? undefined : e.default) && !(Array.isArray(e.default) && Array.isArray(c.value) && !c.value.length && !e.default.length)) r.differ.push({ key: e.key, value: c.value })
  }
  return r
}
// the doctor row: null when the file is absent or empty and nothing is wrong
export async function configRow(h: Host): Promise<{ ok: boolean; text: string; fix?: string } | null> {
  const ld = await load(h, await homeDir(h))
  if (ld.error) return { ok: false, text: `config: config.json ${ld.error}`, fix: 'lean_config validate' }
  const r = reportOf(ld.cfg)
  if (!r.total) return null
  const keys = r.differ.map(d => d.key)
  const shown = keys.length > 6 ? `${keys.slice(0, 6).join(', ')} and ${keys.length - 6} more` : keys.join(', ')
  return { ok: !r.problems.length, text: `config: ${r.differ.length} setting${r.differ.length === 1 ? '' : 's'} differ from the defaults${keys.length ? ` (${shown})` : ''}, ${r.problems.length} invalid${r.problems.length ? `: ${[...new Set(r.keys)].slice(0, 8).join(', ')}${new Set(r.keys).size > 8 ? ` and ${new Set(r.keys).size - 8} more` : ''} (lean_config validate)` : ''}` } // the invalid keys are named: the row itself says what to look at
}

// ---- reading ----
const sens = (e: Entry) => (e.sensitive ? ' (sensitive)' : '')
function lineOf(cfg: Cfg, e: Entry): string {
  const cur = currentOf(cfg, e)
  const ok = cur ? checkValue(e, cur.value) : null
  const dflt = defaultText(e)
  const now = !cur ? `${dflt} (default)` : ok && !ok.ok ? `${show(cur.value).slice(0, 40)} INVALID` : `${show(cur.value)}${sameValue(cur.value, e.default) ? ' (default)' : ` * (default ${dflt})`}`
  return `  ${e.key}${sens(e)} = ${now} — ${e.description}`
}
function listText(cfg: Cfg, group: string | undefined): ConfigResult {
  const g = group?.trim().toLowerCase()
  if (g && !GROUPS.includes(g as never)) return { ok: false, text: `unknown group "${g.slice(0, 30)}": ${GROUPS.join(', ')}` }
  const out: string[] = []
  let changed = 0
  for (const name of g ? [g] : GROUPS) {
    const es = entriesOf(name)
    if (!es.length) continue
    out.push(`${name}:`)
    for (const e of es) {
      out.push(lineOf(cfg, e))
      const c = currentOf(cfg, e)
      if (c && !sameValue(c.value, e.default)) changed++
    }
  }
  out.push(`* = differs from the default (${changed} in this list). Change one: lean_config set <key> <value>; back to the default: lean_config unset <key>`)
  return { ok: true, text: out.join('\n') }
}
function getText(cfg: Cfg, e: Entry): string {
  const cur = currentOf(cfg, e)
  const lim = e.type === 'enum' ? `one of ${e.values!.join(', ')}` : e.type === 'number' ? `a ${e.int ? 'whole ' : ''}number${e.min !== undefined ? ` >= ${e.min}` : ''}${e.max !== undefined ? ` <= ${e.max}` : ''}${e.zero ? ' (0 = off)' : ''}` : e.type === 'list' ? `a list${e.special ? ` or ${e.special.join(' / ')}` : ''}` : e.type === 'boolean' ? 'true or false' : e.type === 'path' ? 'a folder path (~ allowed)' : e.type === 'json' ? `JSON ${e.shape ?? ''}`.trim() : 'text'
  return [
    `${e.key}${sens(e)}: ${cur ? show(cur.value) : 'not set'}${cur && cur.spelling !== e.key ? ` (written as ${cur.spelling})` : ''}${cur ? ` (${cur.style} in the file)` : ''}`,
    `default ${defaultText(e)} · ${lim} · group ${e.group} · ${APPLIES_TEXT[e.applies]}`,
    e.description,
    ...(e.sensitive ? ['This setting loosens a safety rule: it changes only on your own typed words (/lean-agent:config ' + e.key + ' <value>) or your Approve on a question.'] : []),
  ].join('\n')
}

// ---- changing: the sensitive gate ----
const OFFERS = 'config.offers'
const OFFER_TTL_MS = 2 * 60 * 60 * 1000
const OFFER_LABELS = ['Approve', 'Not now'] as const
type Offer = { id: string; key: string; op: 'set' | 'unset'; value: unknown; ts: number; exp: number; sig: string }
const oText = (o: Omit<Offer, 'sig'>) => `config-offer\n${o.id}\n${o.key}\n${o.op}\n${JSON.stringify(o.value ?? null)}\n${o.ts}\n${o.exp}`
let oseq = 0
const oCode = async (h: Host, o: Omit<Offer, 'sig'>) => (await macOf(h, `code\n${oText(o)}`, false)).slice(0, 12)
const wordsOf = (e: Entry, o: Pick<Offer, 'op' | 'value'>) => (o.op === 'unset' ? `reset ${e.key} to its default (${defaultText(e)})` : `set ${e.key} to ${show(o.value)}`)
async function offerQuestion(h: Host, o: Offer): Promise<Asked> {
  const e = findEntry(o.key)!
  return {
    question: `Allow lean-agent to ${wordsOf(e, o)} in ${AT}? This loosens a safety rule: ${e.description} [config ${o.id}, check ${await oCode(h, o)}]`,
    options: [
      { label: 'Approve', description: `the mod writes exactly this one change to ${AT} (${APPLIES_TEXT[e.applies]})` },
      { label: 'Not now', description: 'nothing is changed' },
    ],
  }
}
async function offerRows(h: Host, now: number): Promise<Offer[]> {
  const v = await h.store.get(OFFERS).catch(() => null)
  const out: Offer[] = []
  for (const o of Array.isArray(v) ? v : []) {
    if (!o || typeof o.id !== 'string' || typeof o.key !== 'string' || !findEntry(o.key) || (o.op !== 'set' && o.op !== 'unset') || ![o.ts, o.exp].every(Number.isFinite) || typeof o.sig !== 'string' || now > o.exp) continue
    const want = await macOf(h, oText(o), false)
    if (want && want === o.sig) out.push(o)
  }
  return out
}
async function makeOffer(h: Host, key: string, op: 'set' | 'unset', value: unknown): Promise<Offer | null> {
  const now = await h.clock.now()
  const all = await offerRows(h, now)
  const same = all.find(o => o.key === key && o.op === op && sameValue(o.value ?? null, value ?? null))
  if (same) return same
  const base = { id: `c${now}-${++oseq}`, key, op, value: value ?? null, ts: now, exp: now + OFFER_TTL_MS }
  const sig = await macOf(h, oText(base), true)
  if (!sig) return null
  const rec = { ...base, sig }
  await h.store.set(OFFERS, [...all, rec].slice(-5))
  return rec
}
// the user's own typed words this session that name the key (a slash command in the chat box counts, a shell line never reaches the mod)
async function typedQuote(h: Host, e: Entry): Promise<string | null> {
  const prompts = await recentPrompts(h)
  const names = allSpellings(e).map(s => s.toLowerCase())
  const hit = [...prompts].reverse().find(p => {
    const t = p.text.toLowerCase()
    if (!e.key.includes('.') && !/config|setting/.test(t)) return false // a one-word key (private) counts only when the words are about the config
    return names.some(n => new RegExp(`(?<![\\w.-])${n.replace(/\./g, '\\.')}(?![\\w-])`).test(t))
  })
  return hit ? hit.text.replace(/\s+/g, ' ').trim().slice(0, 120) : null
}
const WAYS = (e: Entry, value: string) => `type \`/lean-agent:config ${e.key} ${value}\` in the chat box (never in a shell box, never in a code block), or answer the question I ask you`

// ---- applying one change ----
async function apply(h: Host, home: string, e: Entry, op: 'set' | 'unset', value: unknown, via: string): Promise<ConfigResult> {
  const ld = await load(h, home)
  if (ld.error) return { ok: false, text: `config.json ${ld.error}: not changed (fix the file first: lean_config validate)` }
  const cfg = ld.cfg
  const before = currentOf(cfg, e)
  if (op === 'unset') {
    let any = false
    for (const s of allSpellings(e)) if (removeSpelling(cfg, s)) any = true
    if (!any) return { ok: true, text: `${e.key} is not set: it already uses the default (${defaultText(e)})` }
    await save(h, home, cfg, ld.raw)
    await appendJsonl(h, HISTORY(home), { ts: await h.clock.now(), key: e.key, op, was: before?.value ?? null, via }).catch(() => undefined)
    return { ok: true, text: `${e.key} reset to the default (${defaultText(e)}): removed from ${AT}; ${APPLIES_TEXT[e.applies]}` }
  }
  const style = styleFor(cfg, e)
  if (before && before.style === 'flat' && !e.flat) removeSpelling(cfg, before.spelling) // a flat spelling its reader ignores moves to the nested form
  if (before && before.spelling !== e.key) removeSpelling(cfg, before.spelling)
  if (style === 'flat') {
    cfg[e.key] = value
  } else {
    if (e.key in cfg) delete cfg[e.key]
    const err = setNested(cfg, e.key, value)
    if (err) return { ok: false, text: err }
  }
  await save(h, home, cfg, ld.raw)
  await appendJsonl(h, HISTORY(home), { ts: await h.clock.now(), key: e.key, op, was: before?.value ?? null, now: value, via }).catch(() => undefined)
  const same = before && sameValue(before.value, value)
  return { ok: true, text: `${e.key} ${same ? 'is already' : 'set to'} ${show(value)}${before && !same ? ` (was ${show(before.value)})` : ''}${e.type === 'path' ? ` (${await expandPath(h, home, String(value))})` : ''}: written to ${AT}; ${APPLIES_TEXT[e.applies]}` }
}
async function expandPath(h: Host, home: string, p: string): Promise<string> {
  const d = await destination(h, home, p)
  return 'folder' in d ? d.folder : p.startsWith('~/') ? `${home}/${p.slice(2)}` : p
}
// a path setting must name a folder that exists (and that lean_thread deliver would accept)
async function pathProblem(h: Host, home: string, p: string): Promise<string | null> {
  const d = await destination(h, home, p)
  if (!('folder' in d)) return d.text
  const st = await h.fs.stat(d.folder).catch(() => null)
  if (!st) return `${p} does not exist (${d.folder}): create the folder first`
  return st.kind === 'dir' || st.kind === 'directory' ? null : `${p} is not a folder`
}

// ---- the tool ----
export async function configTool(h: Host, a: ConfigArgs): Promise<ConfigResult> {
  const action = typeof a.action === 'string' ? a.action : ''
  const home = await homeDir(h)
  const key = typeof a.key === 'string' ? a.key.trim() : ''
  const resolve = (): Entry | ConfigResult => {
    if (!key) return { ok: false, text: `${action} needs key (e.g. desk.model)` }
    const e = findEntry(key)
    if (e) return e
    const dep = deprecatedKey(key)
    if (dep) return { ok: false, text: `${deprecatedText(dep)}${action === 'unset' ? '' : ` (it enforces nothing: lean_config unset ${dep} removes it from config.json)`}` }
    const near = nearestKey(key)
    return { ok: false, text: `unknown setting "${key.slice(0, 60)}"${near ? `: did you mean ${near}?` : ''} (lean_config list shows every setting)` }
  }
  if (action === 'validate') {
    const ld = await load(h, home)
    if (ld.error) return { ok: false, text: `config.json ${ld.error}: nothing reads it until it is fixed (open ${AT} and repair the JSON; lean_config never overwrites it)` }
    const r = reportOf(ld.cfg)
    return { ok: !r.problems.length, text: `${AT}: ${r.total} setting${r.total === 1 ? '' : 's'}, ${r.differ.length} differ from the defaults, ${r.problems.length} problem${r.problems.length === 1 ? '' : 's'}${r.problems.length ? `\n- ${r.problems.join('\n- ')}` : ''}` }
  }
  if (action === 'list') {
    const ld = await load(h, home)
    if (ld.error) return { ok: false, text: `config.json ${ld.error}: nothing reads it until it is fixed (lean_config validate)` }
    return listText(ld.cfg, typeof a.group === 'string' ? a.group : undefined)
  }
  if (action === 'get') {
    const e = resolve()
    if (!('type' in e)) return e
    const ld = await load(h, home)
    if (ld.error) return { ok: false, text: `config.json ${ld.error}: nothing reads it until it is fixed (lean_config validate)` }
    return { ok: true, text: getText(ld.cfg, e) }
  }
  if (action !== 'set' && action !== 'unset') return { ok: false, text: 'lean_config: action must be list, get, set, unset or validate' }
  // unset of a key nothing reads (validate named it: "not read by any 1.0.x version"): removed from the file on the user's word, never automatically; only a key validate flags
  if (action === 'unset' && key && !findEntry(key)) {
    const ld = await load(h, home)
    if (ld.error) return { ok: false, text: `config.json ${ld.error}: not changed (fix the file first: lean_config validate)` }
    if (!reportOf(ld.cfg).keys.includes(key) && !(deprecatedKey(key) && locate(ld.cfg, key))) return resolve() as ConfigResult // not in the file as a flagged key: the usual "unknown setting" answer (a deprecated key that is not in the file says it is no longer used)
    const before = locate(ld.cfg, key)?.value ?? null
    removeSpelling(ld.cfg, key)
    await save(h, home, ld.cfg, ld.raw)
    await appendJsonl(h, HISTORY(home), { ts: await h.clock.now(), key, op: 'unset', was: before, via: 'tool (unknown key)' }).catch(() => undefined)
    return { ok: true, text: `${key} removed from ${AT}: ${deprecatedKey(key) ? 'it was no longer used' : 'no version of lean-agent reads it'}` }
  }
  const e = resolve()
  if (!('type' in e)) return e
  let value: unknown
  if (action === 'set') {
    if (a.value === undefined || a.value === null || (typeof a.value === 'string' && a.value.trim() === '' && e.type !== 'list')) return { ok: false, text: `set needs value for ${e.key} (${getText({}, e).split('\n')[1]})` }
    let raw = typeof a.value === 'string' ? a.value : JSON.stringify(a.value)
    if (e.key === 'budget.since' && /^\s*(today|now)\s*$/i.test(raw)) raw = new Date(await h.clock.now()).toISOString().replace(/\.\d+Z$/, 'Z') // "start again from now": the all-time usage restarts at this moment
    const p = typeof a.value === 'string' || raw !== JSON.stringify(a.value) ? parseValue(e, raw) : checkValue(e, a.value)
    if (!p.ok) return { ok: false, text: `${e.key}: ${p.why}. Nothing was changed (${getText({}, e).split('\n')[1]})` }
    value = p.value
    if (e.type === 'path') {
      const why = await pathProblem(h, home, String(value))
      if (why) return { ok: false, text: `${e.key}: ${why}. Nothing was changed` }
    }
  }
  if (e.sensitive) {
    const quote = await typedQuote(h, e)
    if (!quote) {
      const offer = await makeOffer(h, e.key, action, value)
      const ask = offer ? await offerQuestion(h, offer) : undefined
      const shown = action === 'set' ? show(value) : '<value>'
      return {
        ok: false,
        text: `${e.key} loosens a safety rule (${e.description.replace(/\.$/, '')}), so it changes only on your own words: no message you typed this session names it. To proceed: ${WAYS(e, action === 'set' ? shown : 'reset')}${ask ? `; or ask the user with AskUserQuestion, pasted exactly with exactly the options Approve, Not now: ${JSON.stringify(ask.question)}. The mod reads the answer itself and makes the change; never answer for them. Nothing was changed` : '. Nothing was changed'}`,
        ...(ask ? { ask } : {}),
      }
    }
    return apply(h, home, e, action, value, `typed: ${quote}`)
  }
  return apply(h, home, e, action, value, 'tool')
}

// The desk's AskUserQuestion, after the user answered it: an Approve for the CANONICAL question of one live offer makes the change.
type Q = { question?: unknown; options?: unknown; multiSelect?: unknown }
export async function bindConfigAnswers(h: Host, questions: unknown, answers: unknown): Promise<string[]> {
  const qs: Q[] = Array.isArray(questions) ? (questions as Q[]) : []
  const given = answers && typeof answers === 'object' && !Array.isArray(answers) ? (answers as Record<string, unknown>) : null
  const notes: string[] = []
  for (const q of qs) {
    const text = typeof q?.question === 'string' ? q.question : ''
    const m = /\[config (c\d+-\d+), check ([0-9a-f]{12})\]/.exec(text)
    if (!m || !given) continue
    const now = await h.clock.now()
    const o = (await offerRows(h, now)).find(x => x.id === m[1])
    if (!o) {
      notes.push(`the answer to the question about config change ${m[1]} was NOT recorded: no such request, or it expired (2 h): call lean_config again`)
      continue
    }
    const canon = await offerQuestion(h, o)
    const opts = Array.isArray(q.options) ? (q.options as { label?: unknown; description?: unknown }[]) : []
    if (text !== canon.question || opts.length !== canon.options.length || !canon.options.every((c, i) => opts[i]?.label === c.label && opts[i]?.description === c.description) || q.multiSelect === true) {
      notes.push(`the answer to the question about config change ${o.id} was NOT recorded: the question the user saw was not the canonical one (its text and the options Approve / Not now exactly). Ask again with the question from lean_config`)
      continue
    }
    const ans = typeof given[text] === 'string' ? (given[text] as string).trim() : ''
    const drop = async () => h.store.set(OFFERS, (await offerRows(h, now)).filter(x => x.id !== o.id))
    if (ans === 'Not now') {
      await drop()
      notes.push(`the user chose Not now for config change ${o.id}: ${o.key} stays as it is`)
      continue
    }
    if (!(ans === OFFER_LABELS[0] || (ans !== '' && typedApproval(ans).approve))) {
      if (ans) notes.push(`the user typed '${ans.replace(/\s+/g, ' ').slice(0, 80)}': free text is not an Approve for config change ${o.id}; ask again with the choices, or the user can type /lean-agent:config ${o.key} <value>`)
      continue
    }
    await drop()
    const e = findEntry(o.key)!
    const r = await apply(h, await homeDir(h), e, o.op, o.value, 'approved in a dialog')
    notes.push(r.text)
  }
  return notes
}
