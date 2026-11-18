// Scripts over models: a script that did a job a model would otherwise read through is kept, audited, and reused.
// A thread PROPOSES a script (the mod copies it into the candidate store and never runs it); a read-only auditor judges it
// (`LEAN-AUDIT` line, recorded by the mod); the mod, not the model, applies the verdict rules; an adopted script moves to
// ~/.lean-agent/scripts/<name>/ (global) or ~/.lean-agent/<project>/scripts/<name>/ and becomes a recipe skill that
// `lean_rules sync` copies into checkouts (rules.ts). Pure helpers over a Host; register.tsx wires them to the engine.
import { appendJsonl, homeDir, leanDir, mkdirp, readJson, readJsonl, threadsDir, writeJson } from './state'
import type { Host } from './state'
import { globRe, slugOk } from './rules'
import { sha256 } from './reviews'

export const SCRIPT_TOOL = 'lean_script'
export const MAX_SCRIPT_BYTES = 256 * 1024
export const scriptsDir = (home: string) => `${leanDir(home)}/scripts`
// folder names the stores use themselves, and the top-level folders of ~/.lean-agent: never a script or project name here
const RESERVED = new Set(['candidates', 'retired'])
const LEAN_DIRS = new Set(['scripts', 'threads', 'worktrees', 'logs', 'memory', 'output', 'desk', 'bin', 'recipes', 'legacy-0.45', 'feedback-drafts', 'handovers', 'global'])

export type Verdict = 'adopt' | 'adapt' | 'reject'
export type Audit = {
  ts: number
  by: string
  sha: string // the stored script the auditor judged
  claimed: Verdict // what the auditor said
  verdict: Verdict // after the mod's rules
  reads: string[]
  writes: string[]
  network: boolean
  deletes: boolean
  secrets: boolean
  hardcoded: string[]
  deterministic: boolean
  errorsHandled: boolean
  generalises: boolean
  changes: string[]
  blockers: string[]
  reason: string
}
export type Meta = {
  name: string
  purpose: string
  run: string // contains {script}
  inputs: string[]
  outputs: string[]
  project: string // a project slug or "global"
  author: string // tN
  created: number
  sha256: string
  file: string
  status: 'candidate' | 'adopted' | 'rejected' | 'retired'
  core?: boolean
  scan?: string[] // privacy findings of the stored text (they block adoption)
  audit?: Audit
  decision?: { value: 'adopt' | 'reject'; by: 'user'; reason: string; ts: number; overrode?: string[] }
  adopted?: number
  history?: { ts: number; what: string }[]
}
export type Who = { kind: 'thread'; id: string } | { kind: 'desk' }
export type Out = { ok: boolean; text: string; data?: unknown }
export type Io = { startThread?: (title: string, text: string, project: string) => Promise<Out> }

const err = (text: string): Out => ({ ok: false, text })
// every text field is one line: a newline in inputs/outputs/purpose could add lines to the recipe skill or the auditor brief
const one = (s: string) => s.replace(/\s+/g, ' ').trim()
const str = (v: unknown) => (typeof v === 'string' ? one(v) : '')
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(one).filter(Boolean) : typeof v === 'string' && one(v) ? [one(v)] : [])
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
export const hashText = (t: string) => hex(sha256(new TextEncoder().encode(t)))

// One store mutation at a time: in this process by a queue, across sessions (every thread and the desk is its own process) by
// a lock folder (`mkdir` is atomic). A lock older than a minute, or one that never got its timestamp, is taken over.
// Every mutation reads the meta again inside the lock.
const LOCK_STALE_MS = 60_000
async function withLock<T>(h: Host, f: () => Promise<T>): Promise<T> {
  const home = await homeDir(h)
  const lock = `${scriptsDir(home)}/.lock`
  await mkdirp(h, scriptsDir(home))
  let got = false
  for (let n = 0; n < 25 && !got; n++) {
    got = (await h.process.run(['mkdir', lock])).exitCode === 0
    if (got) break
    const at = Number(await h.fs.read(`${lock}/at`).catch(() => 0)) || 0
    if ((at && (await h.clock.now()) - at > LOCK_STALE_MS) || (!at && n >= 20)) await h.process.run(['rm', '-rf', lock])
    else await h.process.run(['sleep', '0.2'])
  }
  if (!got) throw new Error('the script store is busy: try again')
  try {
    await h.fs.write(`${lock}/at`, String(await h.clock.now()))
    return await f()
  } finally {
    await h.process.run(['rm', '-rf', lock]).catch(() => undefined)
  }
}
let queue: Promise<unknown> = Promise.resolve()
const queued = <T,>(h: Host, f: () => Promise<T>): Promise<T> => {
  const r = queue.then(() => withLock(h, f), () => withLock(h, f))
  queue = r.catch(() => undefined)
  return r
}

// ---- the privacy and secret scrub (deterministic, no model) --------------------------------------------------------
const SECRETS: [RegExp, string][] = [
  [/AKIA[0-9A-Z]{16}/, 'an access key id'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'a code-host token'],
  [/\bsk-[A-Za-z0-9_-]{20,}/, 'an API key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'a chat token'],
  [/\b(?:password|passwd|secret|token|api[_-]?key)\w*["']?\s*[:=]\s*["'][^"'\s]{8,}["']/i, 'a literal credential assignment'],
  [/\bAuthorization["']?\s*[:=]\s*["']?(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i, 'an authorization header'],
]
// a user's home path (a parameterised one, $HOME or expanduser, has no user name after the /Users or /home folder) and an email address
export function scan(text: string, home = ''): { privacy: string[]; secrets: string[] } {
  const privacy: string[] = []
  const secrets: string[] = []
  if (home.length > 1 && text.includes(`${home}/`)) privacy.push("contains this machine's home path")
  const m = /\/(?:Users|home)\/[A-Za-z0-9._-]+/.exec(text)
  if (m) privacy.push(`hardcoded user path ${m[0]}: use $HOME or an argument`)
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/.test(text)) privacy.push('contains an email address or user@host')
  for (const [re, what] of SECRETS) if (re.test(text)) secrets.push(`contains ${what}`)
  return { privacy, secrets }
}

// lean-agent's OWN data (the ledger, reports, rules stats ...): such a script belongs in the mod itself
const OWN = /\.lean-agent\b|\b(?:ledger|feedback|gaps|inbox|questions|answers|goals|scheduled)\.jsonl?\b|\brules-loaded\b|\blearn\.json\b|\bnotes\.jsonl\b/
export const ownData = (...texts: string[]) => texts.some(t => OWN.test(t))

const INTERP = /^(?:python[0-9.]*|node|nodejs|bash|sh|zsh|ruby|perl|deno|bun|tsx|ts-node)$/
const INLINE = /^-[a-zA-Z]*[cemEp]$/ // an interpreter flag that takes inline code or a module (-c, -e, -m, -p ...)

// the run line shows the command with {script} where the script's path goes: an interpreter first, plain words, <placeholders> for arguments
export function runProblem(run: string): string | null {
  if (!run) return 'run is required: the command with {script} where the script goes, e.g. `python3 {script} <input.jsonl>`'
  if (run.length > 300) return 'run is over 300 characters'
  if (!run.includes('{script}')) return 'run must contain {script} where the script goes, e.g. `python3 {script} <input.jsonl>`'
  const w = run.trim().split(/\s+/)
  if (!INTERP.test(w[0]!)) return 'run must start with a bare interpreter (python3, node, bash, sh, ruby, perl ...), then {script}'
  const k = w.indexOf('{script}')
  if (w.slice(1, k < 0 ? 1 : k).some(x => !/^-[A-Za-z]{1,3}$/.test(x) || INLINE.test(x))) return 'run: only plain flags (-u, -B ...) may sit between the interpreter and {script}, never -c / -e / -m (inline code)'
  const rest = run.replace(/<[A-Za-z0-9_. -]{1,30}>/g, ' ').replace(/\{script\}/g, ' ')
  if (/[;&|`\n\r<>"'\\#~*?!(){}[\]]|\$/.test(rest.slice(w[0]!.length))) return 'run is one plain command: no quotes, ; & | redirects, substitution or expansion (write arguments as <placeholders>)'
  return null
}

// ---- store layout --------------------------------------------------------------------------------------------------
const candDir = (home: string, name: string) => `${scriptsDir(home)}/candidates/${name}`
const adoptedDir = (home: string, project: string, name: string) => (project === 'global' ? `${scriptsDir(home)}/${name}` : `${leanDir(home)}/${project}/scripts/${name}`)
const nameOk = (n: string) => slugOk(n) && n.length <= 48 && !RESERVED.has(n)
const projectOk = (p: string) => p === 'global' || (slugOk(p) && !LEAN_DIRS.has(p) && p.length <= 48 && !/\.(?:jsonl?|md|txt|log)$/.test(p))
// the stored file never takes the name of the store's own files
const fileOk = (f: string) => {
  const n = f.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 64) || 'script'
  return n === 'meta.json' || n === 'SKILL.md' ? `script-${n}` : n
}

type Found = { meta: Meta; dir: string }
async function readMeta(h: Host, dir: string): Promise<Meta | null> {
  const m = await readJson<Meta | null>(h, `${dir}/meta.json`, null)
  return m && typeof m === 'object' && typeof m.name === 'string' && typeof m.sha256 === 'string' ? m : null
}
async function dirsIn(h: Host, dir: string): Promise<string[]> {
  return (await h.fs.list(dir).catch(() => [])).filter(f => f.kind === 'dir').map(f => f.name)
}
// every stored script: candidates, global adopted, and each project's adopted (retired ones are left out)
export async function allScripts(h: Host): Promise<Found[]> {
  const home = await homeDir(h)
  const out: Found[] = []
  const add = async (dir: string) => {
    const meta = await readMeta(h, dir)
    if (meta) out.push({ meta, dir })
  }
  for (const n of await dirsIn(h, `${scriptsDir(home)}/candidates`)) await add(`${scriptsDir(home)}/candidates/${n}`)
  for (const n of (await dirsIn(h, scriptsDir(home))).filter(n => !RESERVED.has(n))) await add(`${scriptsDir(home)}/${n}`)
  for (const p of (await dirsIn(h, leanDir(home))).filter(p => slugOk(p) && !LEAN_DIRS.has(p)))
    for (const n of await dirsIn(h, `${leanDir(home)}/${p}/scripts`)) await add(`${leanDir(home)}/${p}/scripts/${n}`)
  return out
}
async function find(h: Host, name: string): Promise<Found | null> {
  if (!nameOk(name)) return null
  const home = await homeDir(h)
  for (const dir of [candDir(home, name), adoptedDir(home, 'global', name)]) {
    const meta = await readMeta(h, dir)
    if (meta) return { meta, dir }
  }
  for (const p of (await dirsIn(h, leanDir(home))).filter(p => slugOk(p) && !LEAN_DIRS.has(p))) {
    const dir = adoptedDir(home, p, name)
    const meta = await readMeta(h, dir)
    if (meta) return { meta, dir }
  }
  return null
}
const verdictOf = (m: Meta) => m.decision?.value ?? m.audit?.verdict ?? 'unaudited'
const note = (m: Meta, ts: number, what: string) => ({ ...m, history: [...(m.history ?? []), { ts, what }].slice(-30) })
export const expandRun = (meta: Meta, dir: string) => {
  const p = `${dir}/${meta.file}`
  const q = /^[\w./@+-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`
  return meta.run.replace(/\{script\}/g, () => q)
}

// ---- the recipe skill an adopted script becomes ----------------------------------------------------------------------
export function recipeText(meta: Meta, dir: string): string {
  const desc = `Scripts over models: ${meta.purpose}`.replace(/\s+/g, ' ').slice(0, 200)
  return [
    '---',
    `name: lean-agent-script-${meta.name}`,
    `description: ${JSON.stringify(desc)}`,
    '---',
    `# ${meta.name} (adopted script)`,
    '',
    meta.purpose,
    '',
    `- inputs: ${meta.inputs.join('; ')}`,
    `- outputs: ${meta.outputs.join('; ')}`,
    `- run: ${expandRun(meta, dir)}`,
    '',
    'Audited and adopted by lean-agent: run it instead of reading the data with a model, and do not edit it in place. If it is wrong for your data, change a copy and `lean_script` propose it under a new name.',
    '',
  ].join('\n')
}

// ---- propose -------------------------------------------------------------------------------------------------------
const proposed = new Set<string>() // source paths this session proposed (the nudge leaves them alone)

async function threadProject(h: Host, home: string, id: string): Promise<string> {
  return str((await readJson<{ project?: string }>(h, `${threadsDir(home)}/${id}/thread.json`, {})).project)
}

async function propose(h: Host, who: Who, i: any): Promise<Out> {
  if (who.kind !== 'thread') return err('propose is for threads: the desk cannot write scripts (ask a thread)')
  const home = await homeDir(h)
  const name = str(i.name)
  const path = str(i.path)
  if (!nameOk(name)) return err(`propose needs a name: letters, digits . _ - (at most 48), not ${[...RESERVED].join(' or ')}`)
  if (!path.startsWith('/') || path.split('/').includes('..')) return err('propose needs path: the absolute path of the script file')
  const purpose = str(i.purpose).replace(/\s+/g, ' ')
  if (!purpose) return err('propose needs purpose: what the script does, in a sentence')
  if (purpose.length > 300) return err('purpose is over 300 characters')
  const run = str(i.run)
  const rp = runProblem(run)
  if (rp) return err(rp)
  const inputs = strs(i.inputs)
  const outputs = strs(i.outputs)
  if (!inputs.length || !outputs.length) return err('propose needs inputs and outputs (what it reads, what it writes; "stdout" if it only prints)')
  if ([...inputs, ...outputs].some(x => x.length > 300)) return err('an inputs/outputs entry is over 300 characters')
  const own = await threadProject(h, home, who.id)
  const project = str(i.project) || own || 'global'
  if (!projectOk(project)) return err(`project must be a project name or "global" (got ${project})`)
  if (project !== 'global' && project !== own) return err(`project must be this thread's own project${own ? ` (${own})` : ''} or "global"`)
  const broad = outputs.find(broadOutput)
  if (broad) return err(`outputs entry "${broad}" is too broad to declare what the script writes: name the files or a folder of its own`)
  const fields = scan([purpose, run, ...inputs, ...outputs].join('\n'), home)
  if (fields.secrets.length || fields.privacy.length) return err(`purpose, run, inputs or outputs ${[...fields.secrets, ...fields.privacy].join('; ')}: use $HOME or a <placeholder> instead`)
  const st = await h.fs.stat(path).catch(() => null)
  if (!st) return err(`no such file: ${path}`)
  if (st.kind && st.kind !== 'file') return err(`${path} is not a file`)
  if (typeof st.size === 'number' && st.size > MAX_SCRIPT_BYTES) return err(`${path} is over ${MAX_SCRIPT_BYTES / 1024} KiB: a reusable script is small`)
  const text = await h.fs.read(path).catch(() => null)
  if (typeof text !== 'string' || text.includes('\0')) return err(`${path} is not a text file`)
  if (text.length > MAX_SCRIPT_BYTES) return err(`${path} is over ${MAX_SCRIPT_BYTES / 1024} KiB: a reusable script is small`)
  const found = scan(text, home)
  if (found.secrets.length) return err(`not stored: the script ${found.secrets.join(', ')}. Take it out (read it from the environment or an argument) and propose again`)
  const sha = hashText(text)
  const ts = await h.clock.now()
  const all = await allScripts(h)
  const same = all.find(x => x.meta.sha256 === sha && x.meta.name !== name)
  if (same) return err(`this exact script is already ${same.meta.status} as ${same.meta.name}`)
  const have = all.find(x => x.meta.name === name)
  if (have && have.meta.status === 'adopted') return err(`${name} is already adopted: use another name, or retire it first`)
  if (have && have.meta.status !== 'candidate' && have.meta.status !== 'rejected') return err(`${name} exists (${have.meta.status})`)
  if (have && have.meta.sha256 === sha) return { ok: true, text: `${name} is already proposed with this content (${verdictOf(have.meta)}); next: lean_script audit ${name}` }
  const file = fileOk(path.split('/').pop() ?? '')
  const core = ownData(text, purpose, ...inputs, ...outputs)
  const dir = candDir(home, name)
  if (have) await h.process.run(['rm', '-rf', have.dir]) // a revised candidate replaces the old one (its audit no longer applies)
  await h.fs.write(`${dir}/${file}`, text)
  const meta: Meta = { name, purpose, run, inputs, outputs, project, author: who.id, created: ts, sha256: sha, file, status: 'candidate', ...(core ? { core: true } : {}), scan: found.privacy, history: [{ ts, what: have ? `re-proposed by ${who.id}` : `proposed by ${who.id}` }] }
  await writeJson(h, `${dir}/meta.json`, meta)
  proposed.add(path)
  if (core) {
    // about lean-agent's own data: also filed for the maintainers, who can move it into the mod
    await appendJsonl(h, `${leanDir(home)}/feedback.jsonl`, { ts, kind: 'core-candidate', note: 'candidate for lean-agent core', thread: who.id, script: name, purpose, run, sha256: sha })
  }
  const hits = found.privacy.length ? ` The scan found: ${found.privacy.join('; ')}; fix that before it can be adopted.` : ''
  return { ok: true, text: `${name} stored as a candidate (copied, not run; ${project}${core ? '; about lean-agent\'s own data, also filed as a core candidate' : ''}).${hits} Next: lean_script audit ${name}`, data: { name, dir } }
}

// ---- audit ---------------------------------------------------------------------------------------------------------
export function auditBrief(meta: Meta, dir: string): string {
  return [
    `Audit the candidate script "${meta.name}" for lean-agent. Start ONE \`lean-agent:auditor\` subagent (Agent tool) with the block below as its prompt. Never run the script yourself.`,
    '--- auditor brief ---',
    `Audit the candidate script ${meta.name}. Folder: ${dir} (the script is ${dir}/${meta.file}; meta.json beside it).`,
    `Declared purpose: ${meta.purpose}`,
    `Declared run: ${meta.run}`,
    `Declared inputs: ${meta.inputs.join('; ')}`,
    `Declared outputs: ${meta.outputs.join('; ')}`,
    `Project: ${meta.project}`,
    'Judge by reading; end your reply with the LEAN-AUDIT line your agent definition describes.',
    '--- end ---',
    'The mod records the verdict from the auditor\'s LEAN-AUDIT line when its Agent call returns, and only for the folder the prompt names. A script is audited once per content: after an adapt, fix it and propose it again.',
  ].join('\n')
}

export type Reply = { name: string; verdict: Verdict | null; reads: string[]; writes: string[]; network: boolean | null; deletes: boolean | null; secrets: boolean | null; hardcoded: string[]; deterministic: boolean; errorsHandled: boolean; generalises: boolean | null; changes: string[]; reason: string }
export function parseAudit(text: string): Reply | null {
  const all = [...String(text ?? '').matchAll(/^\s*`?LEAN-AUDIT\s+(\{.*\})`?\s*$/gm)]
  const last = all[all.length - 1]
  if (!last) return null
  let o: any
  try {
    o = JSON.parse(last[1]!)
  } catch {
    return null
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
  const verdict: Verdict | null = o.verdict === 'adopt' || o.verdict === 'adapt' || o.verdict === 'reject' ? o.verdict : null
  return { name: str(o.name), verdict, reads: strs(o.reads), writes: strs(o.writes), network: bool(o.network), deletes: bool(o.deletes), secrets: bool(o.secrets), hardcoded: strs(o.hardcoded), deterministic: o.deterministic !== false, errorsHandled: o.errors_handled !== false, generalises: bool(o.generalises), changes: strs(o.changes), reason: str(o.reason).slice(0, 400) }
}

// an output entry that would cover (nearly) anything is no declaration
export const broadOutput = (o: string) => /^(?:~|\$HOME|\.|\/)?\/?\*{0,2}$/.test(o) || /^\*/.test(o) || /(?:^|\/)\.\.(?:\/|$)/.test(o) || /^(?:\/(?:Users|home|root|tmp|var|etc))\/?(?:\*{1,2})?$/.test(o) || o === '~/'
// an output entry covers a written thing: equal, a glob match, or a folder prefix; stdout/stderr are always fine. A `..` never counts.
const covered = (w: string, outputs: string[]) => /^(?:stdout|stderr)$/i.test(w) || (!/(?:^|\/)\.\.(?:\/|$)/.test(w) && outputs.some(o => o === w || (o.endsWith('/') && w.startsWith(o)) || (o.includes('*') && globRe(o).test(w))))

// The verdict rules (the mod, not the model): network, deletes/overwrites, writes outside the declared outputs, hardcoded
// paths/ids/names, a scrub hit or a script that is right only for its original data are never `adopt`; a secret is `reject`.
export function judge(meta: Meta, r: Reply & { verdict: Verdict }, now: { privacy: string[]; secrets: string[] }): { verdict: Verdict; blockers: string[] } {
  const blockers: string[] = []
  if (r.network) blockers.push('uses the network')
  if (r.deletes) blockers.push('deletes or overwrites files')
  const stray = r.writes.filter(w => !covered(w, meta.outputs))
  if (stray.length) blockers.push(`writes outside its declared outputs: ${stray.join(', ')}`)
  if (!r.generalises) blockers.push('is correct only for the original data')
  if (r.hardcoded.length) blockers.push(`hardcoded: ${r.hardcoded.join(', ')}`)
  blockers.push(...now.privacy)
  if (r.secrets || now.secrets.length) return { verdict: 'reject', blockers: [...blockers, 'contains secrets'] }
  return { verdict: r.verdict === 'adopt' && blockers.length ? 'adapt' : r.verdict, blockers }
}

// `prompt` is what the auditor was asked: only a script whose folder it names is audited by this reply, and one sha is audited once
// (a revised script has a new sha). The reply comes from a real auditor Agent call; there is no way to hand the mod a verdict.
async function recordAudit(h: Host, by: string, reply: Reply, prompt: string): Promise<Out> {
  const f = await find(h, reply.name)
  if (!f) return err(`no candidate ${reply.name || '(no name in the audit)'}`)
  if (f.meta.status !== 'candidate') return err(`${reply.name} is ${f.meta.status}: only a candidate is audited`)
  if (!prompt.includes(`${f.dir}/`)) return err(`${reply.name}: the auditor was not pointed at ${f.dir}, so its reply is not an audit of this script; use the brief lean_script audit gives`)
  if (f.meta.audit && f.meta.audit.sha === f.meta.sha256) return err(`${reply.name} was already audited at this content (${f.meta.audit.verdict}); propose a revised script to audit again`)
  if (reply.verdict === null) return err('audit verdict must be adopt, adapt or reject')
  const r = reply as Reply & { verdict: Verdict }
  if (r.network === null || r.deletes === null || r.secrets === null || r.generalises === null) return err('audit incomplete: network, deletes, secrets and generalises must each be answered true or false')
  const text = await h.fs.read(`${f.dir}/${f.meta.file}`).catch(() => null)
  if (typeof text !== 'string' || hashText(text) !== f.meta.sha256) return err(`${r.name}: the stored script changed since it was proposed, so this audit does not apply; propose it again`)
  const now = scan(text, await homeDir(h))
  const j = judge(f.meta, r, now)
  const changes = [...r.changes, ...(j.verdict === 'adapt' && r.verdict === 'adopt' ? j.blockers.map(b => `mod: it ${b}`) : [])]
  if (j.verdict === 'adapt' && !changes.length) return err('an adapt verdict needs the concrete changes (changes: [...])')
  if (j.verdict === 'reject' && !r.reason && !j.blockers.length) return err('a reject verdict needs a reason')
  const ts = await h.clock.now()
  const audit: Audit = { ts, by, sha: f.meta.sha256, claimed: r.verdict, verdict: j.verdict, reads: r.reads, writes: r.writes, network: r.network, deletes: r.deletes, secrets: r.secrets, hardcoded: r.hardcoded, deterministic: r.deterministic, errorsHandled: r.errorsHandled, generalises: r.generalises, changes, blockers: j.blockers, reason: r.reason || (j.verdict === 'reject' ? j.blockers.join('; ') : '') }
  let meta: Meta = note({ ...f.meta, audit, scan: now.privacy }, ts, `audited: ${j.verdict}${j.verdict !== r.verdict ? ` (auditor said ${r.verdict})` : ''}`)
  const why = j.verdict !== r.verdict ? ` The auditor said ${r.verdict}; the mod's rules say ${j.verdict}: ${j.blockers.join('; ')}.` : ''
  if (j.verdict === 'reject') meta = { ...meta, status: 'rejected' }
  await writeJson(h, `${f.dir}/meta.json`, meta) // the audit is kept first, adopted or not
  if (j.verdict === 'adopt') return await adopt(h, { meta, dir: f.dir }, 'audit')
  if (j.verdict === 'reject') return { ok: true, text: `${r.name}: reject${r.reason ? ` (${r.reason})` : ''}.${why}` }
  return { ok: true, text: `${r.name}: adapt. Change: ${changes.join('; ')}. Then propose the revised script again under the same name.${why}` }
}

// Move a candidate to its adopted folder and write its recipe skill. Never for a script that fails the scrub.
async function adopt(h: Host, f: Found, via: 'audit' | 'user'): Promise<Out> {
  const home = await homeDir(h)
  const text = await h.fs.read(`${f.dir}/${f.meta.file}`).catch(() => null)
  if (typeof text !== 'string' || hashText(text) !== f.meta.sha256) return err(`${f.meta.name}: the stored script changed since it was proposed; propose it again`)
  const now = scan(text, home)
  if (now.secrets.length || now.privacy.length) return err(`${f.meta.name} cannot be adopted: it ${[...now.secrets, ...now.privacy].join('; ')}`)
  const dest = adoptedDir(home, f.meta.project, f.meta.name)
  if (await h.fs.exists(dest).catch(() => false)) return err(`${dest} already exists: retire it first`)
  const ts = await h.clock.now()
  await mkdirp(h, dest.replace(/\/[^/]+$/, ''))
  const mv = await h.process.run(['mv', f.dir, dest])
  if (mv.exitCode !== 0) return err(`could not move ${f.meta.name} into ${dest}`)
  const meta: Meta = note({ ...f.meta, status: 'adopted', adopted: ts, scan: [] }, ts, via === 'user' ? 'adopted by the user' : 'adopted after audit')
  await writeJson(h, `${dest}/meta.json`, meta)
  await h.fs.write(`${dest}/SKILL.md`, recipeText(meta, dest))
  return { ok: true, text: `${meta.name} adopted (${meta.project === 'global' ? 'global' : meta.project}): ${dest}. It is now the recipe skill lean-agent-script-${meta.name}; run lean_rules sync to copy it into a checkout. run: ${expandRun(meta, dest)}`, data: { name: meta.name, dir: dest } }
}

// An auditor's Agent reply: when it ends with a LEAN-AUDIT line the mod records the verdict. null = no such line.
export async function auditFromReply(h: Host, by: string, text: string, prompt: string): Promise<string | null> {
  const r = parseAudit(text)
  if (!r) return null
  return queued(h, async () => {
    const o = await recordAudit(h, by, r, prompt)
    return `[lean-agent] ${o.ok ? '' : 'audit refused: '}${o.text}`
  })
}

// ---- decide, retire, list, show ------------------------------------------------------------------------------------
async function decide(h: Host, who: Who, i: any): Promise<Out> {
  if (who.kind !== 'desk') return err('decide is for the desk, and only after the user said so in the chat')
  const value = str(i.verdict)
  if (value !== 'adopt' && value !== 'reject') return err('decide needs verdict: adopt or reject')
  const reason = str(i.reason).slice(0, 300)
  if (!reason) return err('decide needs reason (why the user decided so)')
  const f = await find(h, str(i.name))
  if (!f) return err(`no script ${str(i.name)}`)
  if (f.meta.status === 'adopted' || f.meta.status === 'retired') return err(`${f.meta.name} is ${f.meta.status}: use retire to take an adopted script out`)
  const ts = await h.clock.now()
  const log = async (extra: object) => appendJsonl(h, `${scriptsDir(await homeDir(h))}/decisions.jsonl`, { ts, name: f.meta.name, by: 'user', value, reason, prior: verdictOf(f.meta), ...extra })
  if (value === 'reject') {
    await writeJson(h, `${f.dir}/meta.json`, note({ ...f.meta, status: 'rejected', decision: { value, by: 'user', reason, ts } }, ts, `rejected by the user: ${reason}`))
    await log({})
    return { ok: true, text: `${f.meta.name} rejected (the user's decision, logged)` }
  }
  if (!f.meta.audit) return err(`${f.meta.name} was never audited: audit it first (lean_script audit); a verdict can be overridden, a missing one cannot`)
  const text = await h.fs.read(`${f.dir}/${f.meta.file}`).catch(() => null)
  if (typeof text !== 'string') return err(`${f.meta.name}: the stored script is unreadable`)
  const now = scan(text, await homeDir(h))
  if (now.secrets.length || now.privacy.length) return err(`${f.meta.name} cannot be adopted, not even by the user: it ${[...now.secrets, ...now.privacy].join('; ')}. Have a thread fix it and propose it again`)
  if (f.meta.audit.secrets) return err(`${f.meta.name}: the audit found secrets in it, so it is not adopted, not even by the user. Have a thread remove them and propose it again`)
  const over = [...(f.meta.audit.verdict === 'adopt' && !f.meta.audit.blockers.length ? [] : [`the audit said ${f.meta.audit.verdict}`]), ...f.meta.audit.blockers]
  if (over.length && i.confirm !== true) return err(`adopting ${f.meta.name} overrides the audit (${over.join('; ')}). Tell the user that, and only if they still want it call decide again with confirm: true`)
  const out = await adopt(h, { meta: { ...f.meta, decision: { value, by: 'user', reason, ts, ...(over.length ? { overrode: over } : {}) } }, dir: f.dir }, 'user')
  if (out.ok) await log({ overrode: over })
  return out
}

async function retire(h: Host, who: Who, i: any): Promise<Out> {
  const f = await find(h, str(i.name))
  if (!f) return err(`no script ${str(i.name)}`)
  const home = await homeDir(h)
  const ts = await h.clock.now()
  const dest = `${scriptsDir(home)}/retired/${f.meta.name}-${ts}`
  await mkdirp(h, `${scriptsDir(home)}/retired`)
  const mv = await h.process.run(['mv', f.dir, dest])
  if (mv.exitCode !== 0) return err(`could not retire ${f.meta.name}`)
  await h.fs.write(`${dest}/meta.json`, JSON.stringify(note({ ...f.meta, status: 'retired' }, ts, `retired by ${who.kind === 'thread' ? who.id : 'the desk'}`), null, 2) + '\n')
  await h.process.run(['rm', '-f', `${dest}/SKILL.md`]) // the recipe skill goes at the next lean_rules sync
  await appendJsonl(h, `${scriptsDir(home)}/decisions.jsonl`, { ts, name: f.meta.name, by: who.kind === 'thread' ? who.id : 'desk', value: 'retire', reason: str(i.reason).slice(0, 300), prior: f.meta.status })
  return { ok: true, text: `${f.meta.name} retired (kept in ${dest}); run lean_rules sync to drop its skill from checkouts` }
}

export async function useCounts(h: Host): Promise<Record<string, number>> {
  const rows = await readJsonl<{ name?: string }>(h, `${scriptsDir(await homeDir(h))}/uses.jsonl`)
  const n: Record<string, number> = {}
  for (const r of rows) if (typeof r.name === 'string') n[r.name] = (n[r.name] ?? 0) + 1
  return n
}

const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
async function list(h: Host): Promise<Out> {
  const all = (await allScripts(h)).sort((a, b) => a.meta.name.localeCompare(b.meta.name))
  const uses = await useCounts(h)
  const c = all.filter(x => x.meta.status === 'candidate').length
  const a = all.filter(x => x.meta.status === 'adopted').length
  const rows = all.map(x => ({ name: x.meta.name, project: x.meta.project, status: x.meta.status, verdict: verdictOf(x.meta), overridden: !!x.meta.decision, uses: uses[x.meta.name] ?? 0, core: !!x.meta.core, purpose: x.meta.purpose }))
  const lines = rows.map(r => `${r.name} · ${r.project} · ${r.status} · ${r.verdict}${r.overridden ? ' (user decision)' : ''} · ${r.uses} use(s)${r.core ? ' · core candidate' : ''} · ${short(r.purpose, 80)}`)
  return { ok: true, text: [`Scripts: ${c} candidates, ${a} adopted`, ...lines].join('\n'), data: rows }
}

async function show(h: Host, i: any): Promise<Out> {
  const f = await find(h, str(i.name))
  if (!f) return err(`no script ${str(i.name)}`)
  const uses = (await useCounts(h))[f.meta.name] ?? 0
  return { ok: true, text: JSON.stringify({ ...f.meta, dir: f.dir, script: `${f.dir}/${f.meta.file}`, verdict: verdictOf(f.meta), uses, ...(f.meta.status === 'adopted' ? { command: expandRun(f.meta, f.dir) } : {}) }, null, 2), data: f.meta }
}

export async function scriptCounts(h: Host): Promise<{ candidates: number; adopted: number }> {
  const all = await allScripts(h)
  return { candidates: all.filter(x => x.meta.status === 'candidate').length, adopted: all.filter(x => x.meta.status === 'adopted').length }
}

// ---- the tool ------------------------------------------------------------------------------------------------------
export const SCRIPT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['propose', 'audit', 'list', 'show', 'retire', 'decide'] },
    name: { type: 'string', description: 'script name (letters, digits . _ -)' },
    path: { type: 'string', description: 'propose: absolute path of the script file (copied, never run)' },
    purpose: { type: 'string', description: 'propose: what it does, one sentence' },
    run: { type: 'string', description: 'propose: the command with {script} where the script goes, e.g. `python3 {script} <ledger.jsonl>`' },
    inputs: { type: 'array', items: { type: 'string' }, description: 'propose: what it reads (arguments, files)' },
    outputs: { type: 'array', items: { type: 'string' }, description: 'propose: what it writes ("stdout" if it only prints; any file it writes must be listed)' },
    project: { type: 'string', description: 'propose: project name, or "global" (default: this thread\'s project)' },
    verdict: { type: 'string', enum: ['adopt', 'reject'], description: 'decide (desk): the user\'s decision' },
    reason: { type: 'string', description: 'decide / retire: why' },
    confirm: { type: 'boolean', description: 'decide adopt over an audit that said otherwise: only after the user was told and agreed' },
  },
  required: ['action'],
}
export const SCRIPT_SPEC = {
  name: SCRIPT_TOOL,
  description: 'Scripts over models: propose (copy a script you wrote into the candidate store, never run), audit (a read-only auditor judges it; the mod applies the rules), list, show, retire; decide (desk, the user overrides a verdict). An adopted script becomes a recipe skill (lean-agent-script-<name>) with its run command.',
  inputSchema: SCRIPT_SCHEMA,
}

export async function scriptTool(h: Host, who: Who, i: any, io: Io = {}): Promise<Out> {
  try {
    switch (i?.action) {
      case 'propose':
        return await queued(h, () => propose(h, who, i))
      case 'list':
        return await list(h)
      case 'show':
        return await show(h, i)
      case 'retire':
        return await queued(h, () => retire(h, who, i))
      case 'decide':
        return await queued(h, () => decide(h, who, i))
      case 'audit': {
        const name = str(i.name)
        const f = await find(h, name)
        if (!f) return err(`no script ${name || '(name missing)'}`)
        if (f.meta.status !== 'candidate') return err(`${name} is ${f.meta.status}: only a candidate is audited`)
        const brief = auditBrief(f.meta, f.dir)
        if (who.kind === 'thread') return { ok: true, text: brief }
        if (!io.startThread) return { ok: true, text: `Route this to a thread (lean_thread new) with this brief:\n${brief}` }
        const t = await io.startThread(`audit script ${name}`, brief, f.meta.project === 'global' ? '' : f.meta.project)
        return t.ok ? { ok: true, text: `audit of ${name} started in a thread: ${t.text}` } : t
      }
      default:
        return err(`unknown lean_script action ${String(i?.action)}`)
    }
  } catch (e) {
    return err(`lean_script failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`)
  }
}

// ---- the nudge: a scratch script that ran and was never proposed -------------------------------------------------------
const created = new Set<string>() // files written this session (Write tool, shell redirect, tee)
const ran = new Map<string, { nudged: boolean }>()
const SEG = /&&|\|\||[;|\n]/
export const resetScripts = () => {
  created.clear()
  ran.clear()
  proposed.clear()
}
export const noteWrite = (path: unknown) => {
  if (typeof path === 'string' && path.startsWith('/')) created.add(path)
}
// scratch = a temp root, a `tmp` / `scratchpad` folder under ~/.claude (job and session scratchpads), or the thread's own folder; a repo's own tmp folder is not
const scratch = (p: string, lean: string, thread: string) => /^\/(?:private\/)?(?:tmp|var\/tmp|var\/folders)\//.test(p) || /\/\.claude\/(?:[^/]+\/)*(?:tmp|scratch|scratchpad)\//.test(p) || p.startsWith(`${lean}/threads/${thread}/`)

// -c / -m / -e / -p and --eval are inline code or a module for that interpreter (bash -e or -x is not)
const inlineFlag = (base: string, a: string) =>
  /^(?:ba|z)?sh$/.test(base) ? /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a) : /^python/.test(base) ? /^-[a-zA-Z]*[cm]$/.test(a) : /^-[a-zA-Z]*[eEp]$/.test(a) || a === '--eval' || a === '--print'
// the file a command segment runs: `python3 /abs/file`, `node file`, `bash file ...`, or an absolute path run directly; null = inline code or no file
function runTarget(seg: string): string | null {
  const w = seg.trim().split(/\s+/)
  while (w.length && /^(?:[A-Za-z_]\w*=\S*|env|time|nohup|exec)$/.test(w[0]!)) w.shift()
  const k = w.findIndex(x => INTERP.test(x.split('/').pop() ?? ''))
  if (k < 0) return w[0]?.startsWith('/') ? w[0].replace(/^["']|["']$/g, '') : null
  const base = w[k]!.split('/').pop() ?? ''
  const args = w.slice(k + 1)
  if (args.some(a => inlineFlag(base, a))) return null
  return args.find(a => !a.startsWith('-'))?.replace(/^["']|["']$/g, '') ?? null
}

// A Bash command: files it writes count as created; `python3 /abs/file` (and node, bash, sh ...) of a file created this session
// in a scratch place is remembered for the nudge. Inline code and relative paths are not tracked.
export function noteBash(cmd: string, lean: string, thread: string): void {
  for (const m of cmd.matchAll(/(?:>>?|\btee\s+(?:-a\s+)?)\s*(["']?)(\/[^\s"';&|<>]+)\1/g)) created.add(m[2]!)
  for (const seg of cmd.split(SEG)) {
    const file = runTarget(seg)
    if (file && file.startsWith('/') && created.has(file) && scratch(file, lean, thread) && !ran.has(file)) ran.set(file, { nudged: false })
  }
}

// One short line per file, once, at the next prompt: you ran it and did not propose it.
export async function takeNudges(h: Host): Promise<string | null> {
  const out: string[] = []
  for (const [file, st] of ran) {
    if (st.nudged || proposed.has(file)) continue
    st.nudged = true
    if (!(await h.fs.exists(file).catch(() => false))) continue
    out.push(`[lean-agent] you ran ${file}; if it is reusable, lean_script propose it`)
    if (out.length >= 3) break
  }
  return out.length ? out.join('\n') : null
}

// ---- uses: a Bash run of an adopted script counts ----------------------------------------------------------------------
// (only a command that RUNS the adopted script file counts, not a cat or ls of its folder)
export async function noteUse(h: Host, cmd: string, thread: string): Promise<void> {
  if (!cmd.includes('/scripts/')) return
  const home = await homeDir(h)
  const lean = leanDir(home)
  const seen = new Set<string>()
  for (const seg of cmd.split(SEG)) {
    const file = runTarget(seg)
    if (!file || !file.startsWith(`${lean}/`) || file.includes('..')) continue
    const rel = file.slice(lean.length + 1)
    const m = /^scripts\/([A-Za-z0-9._-]+)\/[^/]+$/.exec(rel) ?? /^([A-Za-z0-9._-]+)\/scripts\/([A-Za-z0-9._-]+)\/[^/]+$/.exec(rel)
    if (!m) continue
    const project = m.length === 3 && m[2] ? m[1]! : 'global'
    const name = m[2] ?? m[1]!
    if (RESERVED.has(name) || (project !== 'global' && LEAN_DIRS.has(project)) || seen.has(`${project}/${name}`)) continue
    seen.add(`${project}/${name}`)
    const dir = adoptedDir(home, project, name)
    const meta = await readMeta(h, dir)
    if (meta && meta.status === 'adopted' && file === `${dir}/${meta.file}`) await appendJsonl(h, `${scriptsDir(home)}/uses.jsonl`, { ts: await h.clock.now(), name, project, thread })
  }
}
