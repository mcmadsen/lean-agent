// Scripts over models: a script that did a job a model would otherwise read through is kept, audited, and reused.
// A thread PROPOSES a script (the mod copies it into the candidate store and never runs it); a read-only auditor judges it
// (`LEAN-AUDIT` line, recorded by the mod); the mod, not the model, applies the verdict rules; an adopted script moves to
// ~/.lean-agent/scripts/<name>/ (global) or ~/.lean-agent/<project>/scripts/<name>/ and becomes a recipe skill that
// `lean_rules sync` copies into checkouts (rules.ts). Pure helpers over a Host; register.tsx wires them to the engine.
import { appendJsonl, homeDir, leanDir, mkdirp, readJson, readJsonl, threadsDir, writeJson } from './state'
import type { Host } from './state'
import { globRe, slugOk } from './rules'
import { expandRun, hashText, recipeText } from './recipe'
import type { Audit, Auditing, Decision, Meta, Verdict, Version } from './recipe'
import { refreshScriptRules } from './rulelines'
import { withFolderLock } from './folderlock'
import { unifiedDiff } from './textdiff'

export { expandRun, hashText, recipeText }
export type { Audit, Meta, Verdict, Version }

export const SCRIPT_TOOL = 'lean_script'
export const MAX_SCRIPT_BYTES = 256 * 1024
export const scriptsDir = (home: string) => `${leanDir(home)}/scripts`
// folder names the stores use themselves, and the top-level folders of ~/.lean-agent: never a script or project name here
const RESERVED = new Set(['candidates', 'retired'])
const LEAN_DIRS = new Set(['scripts', 'threads', 'worktrees', 'logs', 'memory', 'output', 'desk', 'bin', 'recipes', 'legacy-0.45', 'feedback-drafts', 'handovers', 'global', 'compare', 'feedback-export'])

export type Who = { kind: 'thread'; id: string } | { kind: 'desk' }
export type Out = { ok: boolean; text: string; data?: unknown }
export type Io = { startThread?: (title: string, text: string, project: string) => Promise<Out> }

const err = (text: string): Out => ({ ok: false, text })
// every text field (purpose, inputs, outputs, reasons, changes) is one line without control characters: a newline could add lines
// to the recipe skill or the auditor brief. `str` (names, paths, the run line) only trims: a newline there is refused by its own check.
const one = (s: string) => s.replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim()
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const txt = (v: unknown) => one(str(v))
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(one).filter(Boolean) : typeof v === 'string' && one(v) ? [one(v)] : [])

// One store mutation at a time: in this process by a queue, across sessions (every thread and the desk is its own process) by
// a lock folder (`mkdir` is atomic) whose `at` file holds the holder's token (time:random). A lock older than a minute, or one that
// never got its token (a holder that died between mkdir and write: after ~4 s), is taken over by MOVING it aside (`mv` is atomic: one
// taker wins, the others retry mkdir), and a holder releases only a lock that still carries its own token. A lock left behind by a
// crash therefore blocks mutations for at most a minute. Every mutation reads the meta again inside the lock.
// (the lock itself is folderlock.ts, shared with the rule files)
const withLock = async <T,>(h: Host, f: () => Promise<T>): Promise<T> => withFolderLock(h, `${scriptsDir(await homeDir(h))}/.lock`, f)
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

// What the mod itself sees in the text, whatever the auditor says: network tools and libraries, deleting or moving over files.
// A hit makes the verdict `adapt` at best (the user can still decide with confirm). Not a proof either way: the auditor reads it too.
const RISKY: [RegExp, string][] = [
  [/\b(?:curl|wget|nc|ncat|netcat|telnet|scp|rsync|ssh|sftp|ftp)\b|\b(?:requests|urllib|urllib3|httpx|aiohttp|http\.client|socket|smtplib|ftplib|XMLHttpRequest)\b|\bfetch\s*\(|\bgit\s+(?:push|fetch|pull|clone)\b|\b(?:pip3?|npm|yarn|pnpm|apt(?:-get)?|brew)\s+install\b/, 'uses the network (the mod\'s text scan)'],
  // runs other programs or builds code at run time: whatever it does is out of the scan's sight, so it never adopts on its own
  [/\bsubprocess\b|\bos\.(?:system|popen|exec\w*|spawn\w*)\b|\bPopen\b|\bchild_process\b|\bexecSync\b|\b(?:exec|eval)\s*\(|\b__import__\b|\bimportlib\b|\bFunction\s*\(|\bRuntime\.getRuntime\b|\bcompile\s*\(/, 'runs other programs or builds code at run time (the mod\'s text scan)'],
  // addressed at the auditor instead of doing the job: an instruction to answer adopt is a reason not to adopt on its own
  [/LEAN-AUDIT|\b(?:answer|reply|respond|verdict|return)\b[^\n]{0,40}\badopt\b|\bignore (?:all |any |the |your )?(?:previous|above|prior|earlier) (?:instructions|rules|checks)|\byou (?:must|should) (?:answer|reply|say) /i, 'contains text addressed to the auditor (the mod\'s text scan)'],
  [/\brm\s+-|\bos\.(?:remove|unlink|rmdir)\b|\bshutil\.(?:rmtree|move)\b|\b(?:unlink|rmdir)(?:Sync)?\s*\(|\bfs\.(?:rm|rmSync|unlink|rmdir)\b|\bRemove-Item\b|-delete\b|\bmv\s+-f\b|\.truncate\s*\(/, 'deletes or moves over files (the mod\'s text scan)'],
]
export const riskyText = (text: string): string[] => RISKY.filter(([re]) => re.test(text)).map(([, what]) => what)
// a script that declares only stdout/stderr as outputs but opens a file for writing: its declaration is wrong (not a proof either way
// for a script that declares files: the auditor's list is checked against those)
// (a heuristic, not a proof: a write through a variable mode, a program it starts or code it builds is not seen; those are what the
// "runs other programs" scan above sends to the desk)
const WRITE_API = /\bopen\s*\([^)\n]*,\s*(?:mode\s*=\s*)?['"][^'"]*[wax+][^'"]*['"]|\bopen\s*\([^)\n]*,\s*(?:mode\s*=\s*)?[A-Za-z_]\w*\s*[,)]|\.(?:write_text|write_bytes|touch|mkdir|rename|replace|unlink|symlink_to|hardlink_to)\s*\(|\bos\.(?:rename|replace|makedirs|mkdir|link|symlink|truncate|chmod|chown|utime)\b|\bshutil\.(?:copy\w*|move)\b|\bfs\.(?:writeFile|appendFile|createWriteStream|rename|copyFile|mkdir|symlink|truncate|chmod)(?:Sync)?\b|\b(?:tee|cp|mv|touch|mkdir|install|dd|truncate)\s+\S|\bsed\s+-[A-Za-z]*i\b/
// a shell redirect to a file (not `2>&1`, `>&2`, `> /dev/null`): only looked for in a shell script, where `>` is not a comparison
const SHELL_REDIRECT = /(?<![0-9&<>-])>>?\s*(?!&|\/dev\/null\b)[^\s&|;>]/
const isShell = (run: string) => /^(?:ba|z)?sh$/.test((run.trim().split(/\s+/)[0] ?? '').split('/').pop() ?? '')
export const strayWriteText = (text: string, outputs: string[], run = ''): string[] =>
  outputs.every(o => /^(?:stdout|stderr)$/i.test(o)) && (WRITE_API.test(text) || (isShell(run) && SHELL_REDIRECT.test(text.replace(/^\s*#.*$/gm, '')))) ? ['writes a file although it declares only stdout/stderr (the mod\'s text scan)'] : []

// lean-agent's OWN data (the ledger, reports, rules stats ...): such a script belongs in the mod itself
const OWN = /\.lean-agent\b|\b(?:ledger|feedback|gaps|inbox|questions|answers|goals|scheduled)\.jsonl?\b|\brules-loaded\b|\blearn\.json\b|\bnotes\.jsonl\b/
export const ownData = (...texts: string[]) => texts.some(t => OWN.test(t))

const INTERP = /^(?:python[0-9.]*|node|nodejs|bash|sh|zsh|ruby|perl|deno|bun|tsx|ts-node)$/
// the only flags allowed before {script} in a run line, by interpreter family (inline code and modules are never among them)
const okFlag = (base: string, a: string) => (/^(?:ba|z)?sh$/.test(base) ? /^-[exu]+$/.test(a) : /^python/.test(base) ? /^-(?:u|B|O|OO|s|S|E|I|q)$/.test(a) : a === '--no-warnings')

// the run line shows the command with {script} where the script's path goes: an interpreter first, plain words, <placeholders> for arguments
export function runProblem(run: string): string | null {
  if (!run) return 'run is required: the command with {script} where the script goes, e.g. `python3 {script} <input.jsonl>`'
  if (run.length > 300) return 'run is over 300 characters'
  if (!run.includes('{script}')) return 'run must contain {script} where the script goes, e.g. `python3 {script} <input.jsonl>`'
  const w = run.trim().split(/\s+/)
  if (!INTERP.test(w[0]!)) return 'run must start with a bare interpreter (python3, node, bash, sh, ruby, perl ...), then {script}'
  const k = w.indexOf('{script}')
  if (k < 1 || w.filter(x => x.includes('{script}')).length !== 1) return 'run must contain {script} once, as a word of its own'
  if (w.slice(1, k).some(x => !okFlag(w[0]!, x))) return 'run: between the interpreter and {script} only plain flags (python3 -u -B, bash -e -x) are allowed, never inline code (-c, -e, -m) or modules'
  const rest = run.replace(/<[A-Za-z0-9_. /-]{1,40}>/g, ' ').replace(/\{script\}/g, ' ')
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
  return n === 'meta.json' || n === 'SKILL.md' || n === 'run' || /^v\d+$/.test(n) ? `script-${n}` : n // never a store file or a version folder
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
const readText = async (h: Host, p: string): Promise<string | null> => {
  const t = await h.fs.read(p).catch(() => null)
  return typeof t === 'string' ? t : null
}

// An adopted script is trusted only while its stable copy (`run`) and its current version file are still the audited text.
// A hand edit is never trusted silently: it shows as "edited, unaudited" everywhere until a new audit (update) or a rollback.
export async function integrity(h: Host, dir: string, meta: Meta): Promise<{ ok: boolean; why: string }> {
  if (meta.status !== 'adopted') return { ok: true, why: '' }
  const run = await readText(h, `${dir}/${meta.file}`)
  if (run === null || hashText(run) !== meta.sha256) return { ok: false, why: `${meta.file} differs from the audited version` }
  const cur = meta.versions?.find(v => v.v === meta.current)
  if (cur) {
    const t = await readText(h, `${dir}/${cur.v}/${cur.file}`)
    if (t === null || hashText(t) !== cur.sha256) return { ok: false, why: `${cur.v}/${cur.file} was edited` }
  }
  return { ok: true, why: '' }
}
export type Health = 'ok' | 'needs-update' | 'edited, unaudited'
const healthOf = (meta: Meta, ok: boolean): Health => (!ok ? 'edited, unaudited' : meta.state === 'needs-update' ? 'needs-update' : 'ok')
const refresh = (h: Host, project: string) => refreshScriptRules(h, project).catch(() => undefined) // rule lines and the copy into the checkout
const ver = (m: Meta, v?: string) => m.versions?.find(x => x.v === (v ?? m.current))
const vnum = (v: string) => Number(v.slice(1)) || 0

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
  const purpose = txt(i.purpose)
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
  // a name another project (or the global store) holds is not this thread's to replace: a waiting script of project A is never
  // overwritten by a proposal of project B under the same name
  if (have && have.meta.project !== project) return err(`${name} is already used by ${have.meta.project === 'global' ? 'a global script' : `project ${have.meta.project}`}: use another name`)
  if (have && have.meta.status === 'adopted') return err(`${name} is already adopted: use another name, or retire it first`)
  if (have && have.meta.status !== 'candidate' && have.meta.status !== 'audited' && have.meta.status !== 'rejected') return err(`${name} exists (${have.meta.status})`)
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
// What the thread that started the auditor does when no verdict was recorded for it (its call ran in the background, or the reply said
// "Async agent launched"): the auditor has no lean_script tool, so the thread passes the answer on. The mod checks it like any other.
export const RECORD_AUDIT_TEXT =
  'If no "audited:" line came back for the auditor (it ran in the background, or the engine returned "Async agent launched"), take the fields of its LEAN-AUDIT line from its hand-back and call lean_script record-audit with name, sha, verdict, network, deletes, secrets, generalises (true or false), reads, writes, hardcoded, changes and a one-line reason. The mod applies the same rules to it; do not invent or soften a verdict.'
export function auditBrief(meta: Meta, dir: string): string {
  return [
    `Audit the candidate script "${meta.name}" for lean-agent. Start ONE \`lean-agent:auditor\` subagent (Agent tool) with the block below as its prompt and run_in_background: false. Never run the script yourself.`,
    '--- auditor brief ---',
    `Audit the candidate script ${meta.name}. Folder: ${dir} (the script is ${dir}/${meta.file}; meta.json beside it).`,
    `Script sha256: ${meta.sha256} (put it in the LEAN-AUDIT line as "sha")`,
    `Declared purpose: ${meta.purpose}`,
    `Declared run: ${meta.run}`,
    `Declared inputs: ${meta.inputs.join('; ')}`,
    `Declared outputs: ${meta.outputs.join('; ')}`,
    `Project: ${meta.project}`,
    'Judge by reading; end your reply with the LEAN-AUDIT line your agent definition describes.',
    '--- end ---',
    'The auditor must get that block as its WHOLE prompt, unchanged (the guard refuses any other prompt for it, and the mod ignores a verdict from one). The mod records the verdict from the auditor\'s LEAN-AUDIT line when its Agent call returns in the foreground (pass run_in_background: false; a background call returns before there is a verdict, then use record-audit).',
    RECORD_AUDIT_TEXT,
    'A script is audited once per content: after an adapt, fix it and propose it again.',
  ].join('\n')
}

// The brief block (between the markers) is the one prompt a lean-agent:auditor may be started with: the mod generates it and the thread
// passes it on unchanged. The guard checks the Agent call against the briefs the mod would hand out now; recordAudit checks the reply's
// prompt against the brief of the script it names.
const BRIEF_OPEN = '--- auditor brief ---'
export const briefBlock = (brief: string): string => {
  const a = brief.indexOf(BRIEF_OPEN)
  const b = brief.indexOf('\n--- end ---', a)
  return a < 0 || b < 0 ? '' : brief.slice(a + BRIEF_OPEN.length, b).trim()
}
const briefOf = (f: Found): string => {
  const pend = f.meta.status === 'adopted' ? f.meta.pending : undefined
  return briefBlock(pend ? updateBrief(f.meta, f.dir, pend) : f.meta.status === 'candidate' ? auditBrief(f.meta, f.dir) : '')
}
export async function auditorPromptProblem(h: Host, prompt: string): Promise<string | null> {
  const want = String(prompt ?? '').trim()
  if (want) for (const f of await allScripts(h)) if (briefOf(f) === want) return null
  return 'lean-agent: a lean-agent:auditor is started only with the brief lean_script audit generates, as its whole prompt and unchanged (a brief goes stale when the script is proposed or updated again: ask lean_script audit once more)'
}

// ---- an audit that is under way: started, no verdict yet ------------------------------------------------------------
// The text an audit is about: the candidate, or the pending update of an adopted script.
const subjectSha = (m: Meta): string => (m.status === 'adopted' && m.pending ? m.pending.sha256 : m.sha256)
const verdictFor = (m: Meta): Audit | undefined => (m.status === 'adopted' && m.pending ? m.pending.audit : m.audit)
// started (an auditor call or an audit thread was seen for THIS text) and no verdict stored for it
export const waitingForVerdict = (m: Meta): boolean => !!m.auditing && m.auditing.sha === subjectSha(m) && verdictFor(m)?.sha !== subjectSha(m)

// An auditor Agent call just started (the thread's own call, seen by the mod) with the exact brief of a script: the mod now knows that an
// audit of this text is under way. record-audit needs this record, and `show` says "waiting for the verdict" until the verdict arrives.
export async function markAuditStarted(h: Host, by: string, prompt: string): Promise<boolean> {
  const want = String(prompt ?? '').trim()
  if (!want) return false
  try {
    return await queued(h, async () => {
      for (const x of await allScripts(h)) {
        if (briefOf(x) !== want) continue
        const sha = subjectSha(x.meta)
        const keep = x.meta.auditing?.sha === sha ? x.meta.auditing : undefined
        const ts = await h.clock.now()
        const auditing: Auditing = { ...keep, sha, ts: keep?.ts ?? ts, by, agent: ts }
        await writeJson(h, `${x.dir}/meta.json`, { ...x.meta, auditing })
        return true
      }
      return false
    })
  } catch {
    return false
  }
}

// is the audit thread the desk started for this text still working on it? ('pending' = being started: for two minutes)
const PENDING_MS = 120_000
async function auditRunning(h: Host, a: Auditing): Promise<boolean> {
  if (!a.thread) return false
  const now = await h.clock.now()
  if (a.thread === 'pending') return now - a.ts < PENDING_MS
  if (!/^t\d+$/.test(a.thread)) return false
  const t = await readJson<{ state?: string; finished?: number } | null>(h, `${threadsDir(await homeDir(h))}/${a.thread}/thread.json`, null)
  return !!t && t.state === 'open' && !t.finished
}

export type Reply = { name: string; sha: string; verdict: Verdict | null; reads: string[]; writes: string[]; network: boolean | null; deletes: boolean | null; secrets: boolean | null; hardcoded: string[]; deterministic: boolean; errorsHandled: boolean; generalises: boolean | null; changes: string[]; reason: string }
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
  return { name: str(o.name), sha: str(o.sha).toLowerCase(), verdict, reads: strs(o.reads), writes: strs(o.writes), network: bool(o.network), deletes: bool(o.deletes), secrets: bool(o.secrets), hardcoded: strs(o.hardcoded), deterministic: o.deterministic !== false, errorsHandled: o.errors_handled !== false, generalises: bool(o.generalises), changes: strs(o.changes), reason: txt(o.reason).slice(0, 400) }
}

// an output entry that would cover (nearly) anything is no declaration
// (judged by its literal folders before the first wildcard: an absolute entry needs two of them, a relative or ~ one: `/tmp/out/`,
// `~/reports/*.csv`, `<outdir>/*.csv`; refused: `/`, `/tmp`, `/*`, `/**/*`, `~`, `~/**/*`, `.`, `./**/*`, `*`, anything with `..`)
export function broadOutput(o: string): boolean {
  if (/(?:^|\/)\.\.(?:\/|$)/.test(o) || /^[*?[]/.test(o)) return true
  const star = o.search(/[*?[]/)
  const folders = (star < 0 ? o : o.slice(0, star).replace(/[^/]*$/, '')).split('/').filter(s => s && s !== '.' && s !== '~' && s !== '$HOME')
  return folders.length < (o.startsWith('/') ? 2 : 1)
}
// an output entry covers a written thing: equal, a glob match, or a folder prefix; stdout/stderr are always fine. A `..` never counts.
const covered = (w: string, outputs: string[]) => /^(?:stdout|stderr)$/i.test(w) || (!/(?:^|\/)\.\.(?:\/|$)/.test(w) && outputs.some(o => o === w || (o.endsWith('/') && w.startsWith(o)) || (o.includes('*') && globRe(o).test(w))))

// The verdict rules (the mod, not the model): network, deletes/overwrites, writes outside the declared outputs, hardcoded
// paths/ids/names, a scrub hit or a script that is right only for its original data are never `adopt`; a secret is `reject`.
export function judge(meta: Meta, r: Reply & { verdict: Verdict }, now: { privacy: string[]; secrets: string[]; risky?: string[] }): { verdict: Verdict; blockers: string[] } {
  const blockers: string[] = []
  if (r.network) blockers.push('uses the network')
  if (r.deletes) blockers.push('deletes or overwrites files')
  blockers.push(...(now.risky ?? []))
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
// The subject is a candidate (its script file) or, for an adopted script, its pending update (the new version file): the folder the
// auditor must be pointed at, the sha it must still have, and what the update changes in purpose or run line (never auto-adopted).
// The verdict the mod's rules make of an auditor's answer `r` for the stored text of `f` (its candidate file, or the pending update `pend`).
// Nothing is written. `out` is a refusal: the text changed since the audit started, or the answer is unusable.
type Answered = Reply & { verdict: Verdict; network: boolean; deletes: boolean; secrets: boolean; generalises: boolean } // every answer given
type Evaluated = { out: Out } | { audit: Audit; j: { verdict: Verdict; blockers: string[] }; now: { privacy: string[]; secrets: string[] }; changes: string[]; waits: boolean; ts: number }
async function evaluate(h: Host, f: Found, pend: Version | undefined, r: Answered, by: string, via?: Audit['via']): Promise<Evaluated> {
  const path = pend ? `${f.dir}/${pend.v}/${pend.file}` : `${f.dir}/${f.meta.file}`
  const sha = pend ? pend.sha256 : f.meta.sha256
  const text = await readText(h, path)
  if (text === null || hashText(text) !== sha) return { out: err(`${r.name}: the stored script changed since it was ${pend ? 'sent as an update' : 'proposed'}, so this audit does not apply; ${pend ? 'send the update again' : 'propose it again'}`) }
  const now = scan(text, await homeDir(h))
  // what the update changes in purpose or run line, against what is current NOW (a rollback may have moved current since it was sent)
  const moved = pend ? [...(pend.purpose !== f.meta.purpose ? [`changes the purpose (was: ${f.meta.purpose})`] : []), ...(pend.run !== f.meta.run ? [`changes the run line (was: ${f.meta.run})`] : [])] : []
  // The mod's own proof, whatever the auditor says. A script adopts on its own only when ALL hold: the run line is on the allowlist
  // (runProblem), no secret and no privacy finding, no network and no delete or overwrite (the auditor's answer and the mod's text
  // scan), no write outside its declared outputs (the auditor's list against the declaration; a stdout-only declaration against the
  // text scan), and nothing hardcoded or specific to its first data. Anything else is not adopted automatically.
  const runBad = runProblem(pend ? pend.run : f.meta.run)
  const j = judge(f.meta, r, { ...now, risky: [...riskyText(text), ...strayWriteText(text, f.meta.outputs, pend ? pend.run : f.meta.run), ...riskyText([f.meta.purpose, pend?.purpose ?? '', ...f.meta.inputs, ...f.meta.outputs].join('\n')).filter(x => x.includes('addressed to the auditor')), ...(runBad ? [`its run line is not on the allowlist (${runBad})`] : []), ...moved] })
  const changes = [...r.changes, ...(j.verdict === 'adapt' && r.verdict === 'adopt' ? j.blockers.map(b => `mod: it ${b}`) : [])]
  if (j.verdict === 'adapt' && !changes.length) return { out: err('an adapt verdict needs the concrete changes (changes: [...])') }
  if (j.verdict === 'reject' && !r.reason && !j.blockers.length) return { out: err('a reject verdict needs a reason') }
  // the auditor said adopt but the proof fails: not adapted by the thread, decided by the desk (a privacy finding or a bad run line is
  // never adoptable, not even by the user: that one goes back to the thread as an adapt)
  const waits = r.verdict === 'adopt' && j.verdict === 'adapt' && !now.privacy.length && !runBad
  const ts = await h.clock.now()
  const audit: Audit = { ts, by, sha, claimed: r.verdict, verdict: j.verdict, reads: r.reads, writes: r.writes, network: r.network, deletes: r.deletes, secrets: r.secrets, hardcoded: r.hardcoded, deterministic: r.deterministic, errorsHandled: r.errorsHandled, generalises: r.generalises, changes, blockers: j.blockers, reason: r.reason || (j.verdict === 'reject' ? j.blockers.join('; ') : ''), ...(waits ? { waits: true } : {}), ...(via ? { via } : {}) }
  return { audit, j, now, changes, waits, ts }
}

// `relay`: the verdict is not the engine's reply of the auditor's Agent call but the fields of its LEAN-AUDIT line passed on by a tool call
// (record-audit: a background auditor's hand-back). It is checked like a reply, except that "the auditor got the exact brief" is proven by
// the mod's own record that such a call STARTED for this text (`auditing.agent`), and only the thread that started it, the audit thread
// the desk started for it, or the desk may record it. `by` is a thread id or 'desk'.
async function recordAudit(h: Host, by: string, reply: Reply, prompt: string, relay = false): Promise<Out> {
  const f = await find(h, reply.name)
  if (!f) return err(`no script ${reply.name || '(no name in the audit)'}`)
  // a thread's auditor audits only its own project's scripts and global ones, as propose and update do (an audit may adopt)
  const no = by === 'desk' ? null : await mayTouch(h, { kind: 'thread', id: by }, f.meta)
  if (no) return no
  const pend = f.meta.status === 'adopted' ? f.meta.pending : undefined
  if (f.meta.status !== 'candidate' && !pend) return err(`${reply.name} is ${f.meta.status}${f.meta.status === 'adopted' ? ' with no update waiting' : ''}: only a candidate or an update is audited`)
  const folder = pend ? `${f.dir}/${pend.v}/` : `${f.dir}/`
  const path = pend ? `${f.dir}/${pend.v}/${pend.file}` : `${f.dir}/${f.meta.file}`
  const sha = pend ? pend.sha256 : f.meta.sha256
  const prior = pend ? pend.audit : f.meta.audit
  // the auditor was started with exactly the brief the mod generated for this script (and so names exactly this folder): any other
  // prompt (extra instructions, another text) makes its verdict worthless
  if (relay) {
    const a = f.meta.auditing
    if (!a || a.sha !== sha || !a.agent) return err(`${reply.name}: the mod saw no auditor start with the brief lean_script audit generates for this text (${sha.slice(0, 12)}...), so there is no audit to record a verdict for; ask lean_script audit and start the auditor with that block unchanged first`)
    if (by !== 'desk' && by !== a.by && by !== a.thread) return err(`${reply.name}: only the thread that started the auditor${a.by ? ` (${a.by})` : ''}, its audit thread or the desk records its verdict`)
  } else {
    const expected = briefOf(f)
    if (!expected || String(prompt ?? '').trim() !== expected || !expected.includes(folder)) return err(`${reply.name}: the auditor was not started with exactly the brief lean_script audit generates for this script (${folder}), so its verdict is ignored; ask lean_script audit again and pass that block unchanged`)
  }
  if (prior && prior.sha === sha) return err(`${reply.name} was already audited at this content (${prior.verdict}); ${pend ? 'send a revised update' : 'propose a revised script'} to audit again`)
  // the auditor echoes the sha256 of the text it was given: a reply that read an older text (the script was proposed or updated again
  // while the auditor ran) is never recorded against the newer one
  if (reply.sha.length < 12 || !sha.startsWith(reply.sha)) return err(`${reply.name}: the audit does not carry the sha256 of the stored text (${sha.slice(0, 12)}...), so it may be about an older text; run the auditor again with the current brief`)
  if (reply.verdict === null) return err('audit verdict must be adopt, adapt or reject')
  if (reply.network === null || reply.deletes === null || reply.secrets === null || reply.generalises === null) return err('audit incomplete: network, deletes, secrets and generalises must each be answered true or false')
  const r = reply as Answered
  const ev = await evaluate(h, f, pend, r, by, relay ? 'record-audit' : undefined)
  if ('out' in ev) return ev.out
  const { audit, j, now, changes, ts } = ev
  // A verdict passed on by a tool call is the relaying model's word, not the engine's reply of a real auditor call: it is recorded, and even
  // a clean `adopt` never adopts by itself. It waits for the desk like any adopt the mod's proof did not clear (the user's decide, or the
  // pane's Adopt / Reject).
  const held = relay && j.verdict === 'adopt'
  const waits = ev.waits || held
  if (waits) audit.waits = true
  const why = (j.verdict !== r.verdict ? ` The auditor said ${r.verdict}; the mod's rules say ${j.verdict}: ${j.blockers.join('; ')}.` : '') + (held ? ' A verdict passed on with record-audit never adopts by itself.' : '')
  const said = `audited: ${j.verdict}${j.verdict !== r.verdict ? ` (auditor said ${r.verdict})` : ''}`
  const waitText = `waits for the desk's decision (lean_script decide adopt|reject with the user's yes, or the pane's Adopt / Reject)`
  if (pend) {
    if (j.verdict === 'reject') {
      await h.process.run(['rm', '-rf', `${f.dir}/${pend.v}`])
      await writeJson(h, `${f.dir}/meta.json`, note({ ...f.meta, pending: undefined }, ts, `update ${pend.v} rejected: ${audit.reason}`))
      return { ok: true, text: `${r.name}: the update ${pend.v} is rejected and dropped (${audit.reason}); ${f.meta.current} stays current.${why}` }
    }
    const meta: Meta = note({ ...f.meta, pending: { ...pend, audit } }, ts, `update ${pend.v} ${said}${waits ? ' (waits for the desk)' : ''}`)
    await writeJson(h, `${f.dir}/meta.json`, meta) // the audit is kept first, adopted or not
    if (j.verdict === 'adopt' && !held) return await adoptVersion(h, { meta, dir: f.dir }, 'audit')
    if (waits) return { ok: true, text: `${r.name}: the update ${pend.v} ${waitText}.${why}` }
    return { ok: true, text: `${r.name}: the update ${pend.v} is adapt. Change: ${changes.join('; ')}. Then send the revised update again (lean_script update ${r.name}).${why}` }
  }
  let meta: Meta = note({ ...f.meta, audit, scan: now.privacy }, ts, `${said}${waits ? ' (waits for the desk)' : ''}`)
  if (j.verdict === 'reject') meta = { ...meta, status: 'rejected' }
  if (waits) meta = { ...meta, status: 'audited' }
  await writeJson(h, `${f.dir}/meta.json`, meta) // the audit is kept first, adopted or not
  if (j.verdict === 'adopt' && !held) return await adopt(h, { meta, dir: f.dir }, 'audit')
  if (j.verdict === 'reject') return { ok: true, text: `${r.name}: reject${r.reason ? ` (${r.reason})` : ''}.${why}` }
  if (waits) return { ok: true, text: `${r.name}: audited, the auditor said adopt, but it ${waitText}.${why}` }
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
  // versions: v1/<file> is the audited text; `run` is the stable copy of the current version (rules and skills point at it)
  const orig = f.meta.file
  await mkdirp(h, `${dest}/v1`)
  await h.process.run(['mv', `${dest}/${orig}`, `${dest}/v1/${orig}`])
  await h.fs.write(`${dest}/run`, text)
  const v1: Version = { v: 'v1', file: orig, sha256: f.meta.sha256, author: f.meta.author, ts, purpose: f.meta.purpose, run: f.meta.run, audit: f.meta.audit, decision: f.meta.decision }
  const meta: Meta = note({ ...f.meta, status: 'adopted', adopted: ts, scan: [], file: 'run', current: 'v1', versions: [v1], failures: 0 }, ts, via === 'user' ? 'adopted by the user' : 'adopted after audit')
  await writeJson(h, `${dest}/meta.json`, meta)
  await h.fs.write(`${dest}/SKILL.md`, recipeText(meta, dest))
  await refresh(h, meta.project)
  return { ok: true, text: `${meta.name} adopted (${meta.project === 'global' ? 'global' : meta.project}): ${dest}. It is now the recipe skill lean-agent-script-${meta.name} and a line in the project rules (rules synced). run: ${expandRun(meta, dest)}`, data: { name: meta.name, dir: dest } }
}

// Switch an adopted script to its audited pending version: the version file is already stored; `run` is overwritten with its text,
// `current` and the mirror fields move, the failure counters reset. Rules and skills point at `run`, so they need no edit.
async function adoptVersion(h: Host, f: Found, via: 'audit' | 'user'): Promise<Out> {
  const pend = f.meta.pending
  if (!pend || f.meta.status !== 'adopted') return err(`${f.meta.name} has no update waiting`)
  const text = await readText(h, `${f.dir}/${pend.v}/${pend.file}`)
  if (text === null || hashText(text) !== pend.sha256) return err(`${f.meta.name}: the stored update changed since it was sent; send it again`)
  const now = scan(text, await homeDir(h))
  if (now.secrets.length || now.privacy.length) return err(`${f.meta.name} ${pend.v} cannot be adopted: it ${[...now.secrets, ...now.privacy].join('; ')}`)
  if (!pend.audit || pend.audit.sha !== pend.sha256) return err(`${f.meta.name} ${pend.v} was never audited`)
  const ts = await h.clock.now()
  await h.fs.write(`${f.dir}/${f.meta.file}`, text)
  const entry: Version = { ...pend, changes: pend.changes }
  const meta: Meta = note(
    { ...f.meta, versions: [...(f.meta.versions ?? []), entry], current: pend.v, sha256: pend.sha256, purpose: pend.purpose, run: pend.run, audit: pend.audit, decision: pend.decision, pending: undefined, failures: 0, state: undefined, badWhy: undefined },
    ts,
    via === 'user' ? `${pend.v} adopted by the user` : `${pend.v} adopted after audit`,
  )
  await writeJson(h, `${f.dir}/meta.json`, meta)
  await h.fs.write(`${f.dir}/SKILL.md`, recipeText(meta, f.dir))
  await refresh(h, meta.project)
  const moved = (pend.changes ?? []).length ? ` Note: ${(pend.changes ?? []).join('; ')}.` : ''
  return { ok: true, text: `${meta.name} is now ${pend.v} (rules and skill unchanged: they point at ${f.dir}/run).${moved}`, data: { name: meta.name, dir: f.dir } }
}

// An auditor's Agent reply: when it ends with a LEAN-AUDIT line the mod records the verdict. null = no such line.
// An auditor's verdict is recorded from the reply of its own Agent call (auditFromReply). A call that runs in the background returns
// "Async agent launched" at once and the LEAN-AUDIT line comes later: the thread then records it with record-audit. The call's input is
// never rewritten by a hook (auto mode rejects that), so the foreground is asked for: the brief says "pass run_in_background: false".
export const isAuditorCall = (e: any): boolean => (e?.tool === 'Agent' || e?.tool === 'Task') && /^(lean-agent:)?auditor$/.test(String(e?.subagent_type ?? ''))
// a thread's own Agent call for one of this plugin's types (workers, readers, reviewer, explorer, auditor)
export const isLeanCall = (e: any): boolean => (e?.tool === 'Agent' || e?.tool === 'Task') && /^lean-agent:/.test(String(e?.subagent_type ?? ''))
export const AUDIT_ASYNC_NOTE = '[lean-agent] the auditor was started in the background, so its verdict was NOT recorded yet: when its LEAN-AUDIT line comes back, call lean_script record-audit with its fields (name, sha, verdict, network, deletes, secrets, generalises, reads, writes, hardcoded, changes, reason); the mod checks it like a reply. Next time pass run_in_background: false on the auditor call'

export async function auditFromReply(h: Host, by: string, text: string, prompt: string): Promise<string | null> {
  const r = parseAudit(text)
  if (!r) return null
  try {
    return await queued(h, async () => {
      const o = await recordAudit(h, by, r, prompt)
      return `[lean-agent] ${o.ok ? '' : 'audit refused: '}${o.text}`
    })
  } catch (e) {
    return `[lean-agent] audit refused: ${String((e as Error)?.message ?? e).slice(0, 120)}; run the auditor again`
  }
}

// record-audit (a tool call by the audit thread, the thread that started the auditor, or the desk): the fields of a LEAN-AUDIT line from an
// auditor hand-back that no hook saw (the call ran in the background). Same checks as a reply (stored sha, every flag answered, the mod's
// rules on top), plus: the mod saw an auditor start with the exact brief for this text, and the caller is one of those allowed. A verdict
// that arrives this way is only as trustworthy as the model that passes it on, so it is RECORDED but never adopts by itself: an `adopt` waits
// for the desk's decision (the user's yes in decide, or the pane's Adopt); adapt and reject take effect as for a reply.
async function recordAuditTool(h: Host, who: Who, i: any): Promise<Out> {
  const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
  const verdict: Verdict | null = i?.verdict === 'adopt' || i?.verdict === 'adapt' || i?.verdict === 'reject' ? i.verdict : null
  const name = str(i?.name)
  if (!name) return err('record-audit needs name: the script the auditor judged')
  if (!str(i?.sha)) return err('record-audit needs sha: the Script sha256 from the auditor\'s LEAN-AUDIT line (at least 12 characters)')
  const reply: Reply = { name, sha: str(i.sha).toLowerCase(), verdict, reads: strs(i.reads), writes: strs(i.writes), network: bool(i.network), deletes: bool(i.deletes), secrets: bool(i.secrets), hardcoded: strs(i.hardcoded), deterministic: i.deterministic !== false, errorsHandled: i.errors_handled !== false, generalises: bool(i.generalises), changes: strs(i.changes), reason: txt(i.reason).slice(0, 400) }
  const o = await recordAudit(h, who.kind === 'thread' ? who.id : 'desk', reply, '', true)
  return o.ok ? { ...o, text: `${o.text} (recorded through record-audit)` } : o
}

// ---- decide, retire, list, show ------------------------------------------------------------------------------------
async function decide(h: Host, who: Who, i: any): Promise<Out> {
  if (who.kind !== 'desk') return err('decide is for the desk, and only after the user said so in the chat')
  const value = str(i.verdict)
  if (value !== 'adopt' && value !== 'reject') return err('decide needs verdict: adopt or reject')
  const reason = txt(i.reason).slice(0, 300)
  if (!reason) return err('decide needs reason (why the user decided so)')
  let f = await find(h, str(i.name))
  if (!f) return err(`no script ${str(i.name)}`)
  let pend = f.meta.status === 'adopted' ? f.meta.pending : undefined // for an adopted script the decision is about its waiting update
  if (f.meta.status === 'retired' || (f.meta.status === 'adopted' && !pend)) return err(`${f.meta.name} is ${f.meta.status}${pend === undefined && f.meta.status === 'adopted' ? ' with no update waiting' : ''}: use retire to take an adopted script out, rollback to go back a version`)
  // the decision is about the text the user saw: a caller that names its sha256 (the pane does) is refused when the script was
  // replaced meanwhile (proposed again under the same name, or a newer update)
  const cur = pend ? pend.sha256 : f.meta.sha256
  const seen = str(i.sha)
  if (seen && (seen.length < 12 || !cur.startsWith(seen))) return err(`${f.meta.name} changed since it was looked at (now ${cur.slice(0, 12)}): look at it again before deciding`)
  const ts = await h.clock.now()
  const log = async (extra: object) => appendJsonl(h, `${scriptsDir(await homeDir(h))}/decisions.jsonl`, { ts, name: f!.meta.name, by: 'user', value, reason, prior: pend ? `update ${pend.v}: ${pend.audit?.verdict ?? 'unaudited'}` : verdictOf(f!.meta), ...(pend ? { version: pend.v } : {}), ...extra })
  if (value === 'reject') {
    if (pend) {
      await h.process.run(['rm', '-rf', `${f.dir}/${pend.v}`])
      await writeJson(h, `${f.dir}/meta.json`, note({ ...f.meta, pending: undefined }, ts, `update ${pend.v} rejected by the user: ${reason}`))
    } else await writeJson(h, `${f.dir}/meta.json`, note({ ...f.meta, status: 'rejected', decision: { value, by: 'user', reason, ts } }, ts, `rejected by the user: ${reason}`))
    await log({})
    return { ok: true, text: `${f.meta.name}${pend ? ` update ${pend.v}` : ''} rejected (the user's decision, logged)` }
  }
  let audit = pend ? pend.audit : f.meta.audit
  let fallback = ''
  if (!audit) {
    // no verdict in the store (a background auditor's hand-back was never recorded): the audit thread's last report for this text may carry it
    const fb = await auditFromThreadReport(h, f, pend)
    if (fb) {
      const ev = await evaluate(h, f, pend, fb.reply, fb.thread, 'thread-report')
      if ('out' in ev) return err(`${f.meta.name}${pend ? ` ${pend.v}` : ''}: the audit thread's report could not be used (${ev.out.text})`)
      audit = ev.audit
      fallback = ` (verdict taken from the audit thread's report ${fb.thread})`
      const kept: Meta = pend ? note({ ...f.meta, pending: { ...pend, audit } }, ts, `update ${pend.v}: verdict taken from the audit thread's report`) : note({ ...f.meta, audit, scan: ev.now.privacy }, ts, "verdict taken from the audit thread's report")
      await writeJson(h, `${f.dir}/meta.json`, kept)
      f = { ...f, meta: kept }
      pend = kept.status === 'adopted' ? kept.pending : undefined
    }
  }
  if (!audit) return err(`${f.meta.name}${pend ? ` ${pend.v}` : ''} was never audited${waitingForVerdict(f.meta) ? ' (an audit was started and its verdict has not been recorded: the audit thread records it with lean_script record-audit, or reports it)' : ''}: audit it first (lean_script audit); a verdict can be overridden, a missing one cannot`)
  const text = await readText(h, pend ? `${f.dir}/${pend.v}/${pend.file}` : `${f.dir}/${f.meta.file}`)
  if (text === null) return err(`${f.meta.name}: the stored script is unreadable`)
  const now = scan(text, await homeDir(h))
  if (now.secrets.length || now.privacy.length) return err(`${f.meta.name} cannot be adopted, not even by the user: it ${[...now.secrets, ...now.privacy].join('; ')}. Have a thread fix it and propose it again`)
  if (audit.secrets) return err(`${f.meta.name}: the audit found secrets in it, so it is not adopted, not even by the user. Have a thread remove them and propose it again`)
  const badRun = runProblem(pend ? pend.run : f.meta.run)
  if (badRun) return err(`${f.meta.name}: its run line is not on the allowlist (${badRun}), so it is not adopted, not even by the user. Have a thread fix the run line and propose it again`)
  const over = [...(audit.verdict === 'adopt' && !audit.blockers.length ? [] : [`the audit said ${audit.verdict}`]), ...audit.blockers]
  if (over.length && i.confirm !== true) return err(`adopting ${f.meta.name}${pend ? ` ${pend.v}` : ''} overrides the audit (${over.join('; ')}). Tell the user that, and only if they still want it call decide again with confirm: true`)
  const decision: Decision = { value, by: 'user', reason, ts, ...(over.length ? { overrode: over } : {}) }
  const out = pend ? await adoptVersion(h, { meta: { ...f.meta, pending: { ...pend, decision } }, dir: f.dir }, 'user') : await adopt(h, { meta: { ...f.meta, decision }, dir: f.dir }, 'user')
  if (out.ok) await log({ overrode: over, ...(fallback ? { note: "verdict taken from the audit thread's report" } : {}) })
  return out.ok && fallback ? { ...out, text: `${out.text}${fallback}` } : out
}

// The last report of the audit thread (the one the desk started for this text) that carries a LEAN-AUDIT line for this script and sha, as
// a complete answer: what decide falls back to when no verdict was recorded. null = none.
async function auditFromThreadReport(h: Host, f: Found, pend: Version | undefined): Promise<{ reply: Answered; thread: string } | null> {
  const a = f.meta.auditing
  const sha = pend ? pend.sha256 : f.meta.sha256
  if (!a || a.sha !== sha || !/^t\d+$/.test(a.thread ?? '')) return null
  const rows = await readJsonl<{ from?: string; kind?: string; text?: unknown }>(h, `${leanDir(await homeDir(h))}/desk/inbox.jsonl`)
  for (const r of rows.reverse()) {
    if (r?.from !== a.thread || r.kind !== 'report' || typeof r.text !== 'string') continue
    const p = parseAudit(r.text)
    if (!p || p.verdict === null || p.name !== f.meta.name || p.sha.length < 12 || !sha.startsWith(p.sha)) continue // an older or another report: look further back
    if (p.network === null || p.deletes === null || p.secrets === null || p.generalises === null) continue
    return { reply: p as Answered, thread: a.thread! }
  }
  return null
}

async function retire(h: Host, who: Who, i: any): Promise<Out> {
  const f = await find(h, str(i.name))
  if (!f) return err(`no script ${str(i.name)}`)
  const no = await mayTouch(h, who, f.meta)
  if (no) return no
  const home = await homeDir(h)
  const ts = await h.clock.now()
  const dest = `${scriptsDir(home)}/retired/${f.meta.name}-${ts}`
  await mkdirp(h, `${scriptsDir(home)}/retired`)
  const mv = await h.process.run(['mv', f.dir, dest])
  if (mv.exitCode !== 0) return err(`could not retire ${f.meta.name}`)
  await h.fs.write(`${dest}/meta.json`, JSON.stringify(note({ ...f.meta, status: 'retired' }, ts, `retired by ${who.kind === 'thread' ? who.id : 'the desk'}`), null, 2) + '\n')
  await h.process.run(['rm', '-f', `${dest}/SKILL.md`]) // the recipe skill goes at the next lean_rules sync
  await appendJsonl(h, `${scriptsDir(home)}/decisions.jsonl`, { ts, name: f.meta.name, by: who.kind === 'thread' ? who.id : 'desk', value: 'retire', reason: txt(i.reason).slice(0, 300), prior: f.meta.status })
  await refresh(h, f.meta.project) // its rule line and its skill go with the next sync, done now
  return { ok: true, text: `${f.meta.name} retired (kept in ${dest}); its rule line and skill are removed at the next sync` }
}

// ---- versions: update, rollback, report-bad, diff -------------------------------------------------------------------------
export function updateBrief(meta: Meta, dir: string, pend: Version): string {
  const cur = ver(meta)
  const was = (a: string, b: string) => (a === b ? '' : ` (was: ${a})`)
  return [
    `Audit the UPDATE ${pend.v} of the adopted script "${meta.name}" (current ${meta.current}). Start ONE \`lean-agent:auditor\` subagent (Agent tool) with the block below as its prompt. Never run the script yourself.`,
    '--- auditor brief ---',
    `Audit the update ${pend.v} of script ${meta.name}. Folder: ${dir}/${pend.v}/ (the new script is ${dir}/${pend.v}/${pend.file}).`,
    `Script sha256: ${pend.sha256} (put it in the LEAN-AUDIT line as "sha")`,
    `The change against the current version is ${dir}/${pend.v}/.changes.diff: read it first. Audit ONLY the change plus the checklist: apply every item to the changed lines, and to the rest of the script only where the change touches it, then answer the checklist for the resulting script.`,
    `Declared purpose: ${pend.purpose}${was(cur?.purpose ?? '', pend.purpose)}`,
    `Declared run: ${pend.run}${was(cur?.run ?? '', pend.run)}`,
    `Declared inputs: ${meta.inputs.join('; ')}`,
    `Declared outputs: ${meta.outputs.join('; ')}`,
    `Project: ${meta.project}`,
    'End your reply with the LEAN-AUDIT line your agent definition describes.',
    '--- end ---',
    'The auditor must get that block as its WHOLE prompt, unchanged (the guard refuses any other prompt for it, and the mod ignores a verdict from one). The mod records the verdict from the auditor\'s LEAN-AUDIT line when its Agent call returns in the foreground (a background call returns before there is a verdict).',
    RECORD_AUDIT_TEXT,
    'A changed purpose or run line is shown in the verdict and is never adopted without the desk\'s decision.',
  ].join('\n')
}

// The new text: a file the thread wrote (`path`) or exact `edits` [{find, replace}] on the current version (each `find` must occur once).
async function newText(h: Host, i: any, base: string): Promise<string | Out> { // the new text, or the refusal (an object)
  if (str(i.path)) {
    const path = str(i.path)
    if (!path.startsWith('/') || path.split('/').includes('..')) return err('update needs path: the absolute path of the new script file')
    const st = await h.fs.stat(path).catch(() => null)
    if (!st) return err(`no such file: ${path}`)
    if (st.kind && st.kind !== 'file') return err(`${path} is not a file`)
    const t = await readText(h, path)
    if (t === null || t.includes('\0')) return err(`${path} is not a text file`)
    return t
  }
  if (Array.isArray(i.edits) && i.edits.length) {
    let t = base
    for (const [n, e] of (i.edits as any[]).entries()) {
      const find = typeof e?.find === 'string' ? e.find : ''
      const rep = typeof e?.replace === 'string' ? e.replace : ''
      const at = find ? t.split(find).length - 1 : 0
      if (at !== 1) return err(`edit ${n + 1}: "find" must occur exactly once in the current script (found ${at})`)
      t = t.replace(find, () => rep)
    }
    return t
  }
  return err('update needs path (the new script file) or edits: [{find, replace}] applied to the current version')
}

type Started = Out & { start?: { title: string; brief: string; project: string } }
async function update(h: Host, who: Who, i: any, io: Io): Promise<Started> {
  const f = await find(h, str(i.name))
  if (!f) return err(`no script ${str(i.name)}`)
  const m = f.meta
  if (m.status !== 'adopted') return err(`${m.name} is ${m.status}: only an adopted script is updated (a candidate is proposed again)`)
  const no = await mayTouch(h, who, m)
  if (no) return no
  const cur = ver(m)
  const curText = cur ? await readText(h, `${f.dir}/${cur.v}/${cur.file}`) : null
  if (!cur || curText === null || hashText(curText) !== cur.sha256) return err(`${m.name}: the stored ${m.current} file is missing or was edited, so there is nothing sound to update: roll back to an older version`)
  const made = await newText(h, i, curText)
  if (typeof made !== 'string') return made
  const text = made
  if (text.length > MAX_SCRIPT_BYTES) return err(`the update is over ${MAX_SCRIPT_BYTES / 1024} KiB: a reusable script is small`)
  const found = scan(text, await homeDir(h))
  if (found.secrets.length) return err(`not stored: the update ${found.secrets.join(', ')}. Take it out and send it again`)
  const sha = hashText(text)
  const dup = m.versions?.find(v => v.sha256 === sha)
  if (dup) return err(dup.v === m.current ? `the update is identical to the current version ${m.current}` : `the update is identical to ${dup.v}: use rollback ${m.name} ${dup.v}`)
  const purpose = txt(i.purpose) || m.purpose
  const run = str(i.run) || m.run
  if (purpose.length > 300) return err('purpose is over 300 characters')
  if (run !== m.run) {
    const rp = runProblem(run)
    if (rp) return err(rp)
  }
  const fields = scan(`${purpose}\n${run}`, await homeDir(h))
  if (fields.secrets.length || fields.privacy.length) return err(`purpose or run ${[...fields.secrets, ...fields.privacy].join('; ')}`)
  const changes = [...(purpose !== m.purpose ? [`changes the purpose (was: ${m.purpose})`] : []), ...(run !== m.run ? [`changes the run line (was: ${m.run})`] : [])]
  const ts = await h.clock.now()
  // a version number is never reused (not after a replaced or rejected update either): an auditor still running on an older text
  // names an older folder, which no longer matches
  const n = Math.max(m.nextV ?? 0, ...(m.versions ?? []).map(x => vnum(x.v)), m.pending ? vnum(m.pending.v) : 0) + 1
  const v = `v${n}`
  if (m.pending) await h.process.run(['rm', '-rf', `${f.dir}/${m.pending.v}`]) // a newer update replaces the one still waiting
  await h.fs.write(`${f.dir}/${v}/${cur.file}`, text)
  await h.fs.write(`${f.dir}/${v}/.changes.diff`, unifiedDiff(curText, text, `${cur.v}/${cur.file}`, `${v}/${cur.file}`))
  const pend: Version = { v, file: cur.file, sha256: sha, author: who.kind === 'thread' ? who.id : 'desk', ts, purpose, run, changes }
  const meta: Meta = note({ ...m, pending: pend, nextV: n }, ts, `update ${v} sent by ${pend.author}`)
  await writeJson(h, `${f.dir}/meta.json`, meta)
  const brief = updateBrief(meta, f.dir, pend)
  const head = `${m.name}: update ${v} stored (not run, not current; ${m.current} stays current until it is audited).${changes.length ? ` Shown for the verdict: ${changes.join('; ')}.` : ''}`
  if (who.kind === 'thread') return { ok: true, text: `${head}\n${brief}` }
  if (!io.startThread) return { ok: true, text: `${head}\nRoute this to a thread (lean_thread new) with this brief:\n${brief}` }
  // the thread is started by the caller after the lock is released (its first lean_script call needs the lock)
  return { ok: true, text: head, start: { title: `audit update of script ${m.name}`, brief, project: m.project === 'global' ? '' : m.project } }
}

// a thread changes only its own project's scripts and the global ones (as propose does)
async function mayTouch(h: Host, who: Who, meta: Meta): Promise<Out | null> {
  if (who.kind !== 'thread' || meta.project === 'global') return null
  return (await threadProject(h, await homeDir(h), who.id)) === meta.project ? null : err(`${meta.name} belongs to project ${meta.project}: a thread changes only its own project's scripts and global ones`)
}

async function rollback(h: Host, who: Who, i: any): Promise<Out> {
  const f = await find(h, str(i.name))
  if (!f) return err(`no script ${str(i.name)}`)
  const m = f.meta
  if (m.status !== 'adopted' || !m.versions?.length) return err(`${m.name} is ${m.status}: only an adopted script has versions to go back to`)
  const no = await mayTouch(h, who, m)
  if (no) return no
  const reason = txt(i.reason).slice(0, 300)
  if (who.kind === 'thread' && !reason) return err('a thread gives a reason to roll back (reason: why)')
  const idx = m.versions.findIndex(v => v.v === m.current)
  const target = str(i.version) ? ver(m, str(i.version)) : m.versions[idx - 1]
  if (!target) return err(`${str(i.version) ? `no version ${str(i.version)}` : `${m.name} has no version before ${m.current}`}; versions: ${m.versions.map(v => v.v).join(', ')}`)
  if (!target.audit || target.audit.sha !== target.sha256 || (target.audit.verdict !== 'adopt' && target.decision?.value !== 'adopt')) return err(`${target.v} was never adopted by an audit or by the user, so it is not a version to go back to`)
  const text = await readText(h, `${f.dir}/${target.v}/${target.file}`)
  if (text === null || hashText(text) !== target.sha256) return err(`${target.v}/${target.file} is missing or was edited by hand: it is no longer the audited text`)
  const ts = await h.clock.now()
  await h.fs.write(`${f.dir}/${m.file}`, text)
  if (m.pending) await h.process.run(['rm', '-rf', `${f.dir}/${m.pending.v}`]) // an update that waits was written against the version being left: it is dropped
  const meta: Meta = note({ ...m, current: target.v, sha256: target.sha256, purpose: target.purpose, run: target.run, audit: target.audit, decision: target.decision, failures: 0, state: undefined, badWhy: undefined, pending: undefined, nextV: Math.max(m.nextV ?? 0, ...(m.pending ? [vnum(m.pending.v)] : [])) || undefined }, ts, `rolled back to ${target.v}${target.v === m.current ? ' (restored)' : ` from ${m.current}`} by ${who.kind === 'thread' ? who.id : 'the desk'}${reason ? `: ${reason}` : ''}`)
  await writeJson(h, `${f.dir}/meta.json`, meta)
  await h.fs.write(`${f.dir}/SKILL.md`, recipeText(meta, f.dir))
  await appendJsonl(h, `${scriptsDir(await homeDir(h))}/decisions.jsonl`, { ts, name: m.name, by: who.kind === 'thread' ? who.id : 'desk', value: 'rollback', from: m.current, to: target.v, reason })
  await refresh(h, m.project)
  return { ok: true, text: `${m.name} is back to ${target.v} (${target.v === m.current ? 'restored from its stored version' : `was ${m.current}`}); rules and skill point at the same ${f.dir}/${m.file}` }
}

async function reportBad(h: Host, who: Who, i: any): Promise<Out> {
  if (who.kind !== 'thread') return err('report-bad is for threads that ran the script')
  const f = await find(h, str(i.name))
  if (!f) return err(`no script ${str(i.name)}`)
  if (f.meta.status !== 'adopted') return err(`${f.meta.name} is ${f.meta.status}: only an adopted script is reported`)
  const no = await mayTouch(h, who, f.meta)
  if (no) return no
  const why = txt(i.why).slice(0, 200)
  if (!why) return err('report-bad needs why: what was wrong')
  const ts = await h.clock.now()
  await writeJson(h, `${f.dir}/meta.json`, note({ ...f.meta, failures: (f.meta.failures ?? 0) + 1, state: 'needs-update', badWhy: why }, ts, `reported wrong by ${who.id}: ${why}`))
  await refresh(h, f.meta.project)
  return { ok: true, text: `${f.meta.name} is marked needs-update (${why}). If you can fix it: lean_script update ${f.meta.name} with the fixed file or edits; ${f.meta.current} stays current until the update is audited` }
}

async function diffOf(h: Host, who: Who, i: any): Promise<Out> {
  const f = await find(h, str(i.name))
  if (!f || !(await visible(h, who, f.meta))) return err(`no script ${str(i.name)}`)
  const m = f.meta
  if (m.status !== 'adopted' || !m.versions?.length) return err(`${m.name} is ${m.status}: only an adopted script has versions to compare`)
  const idx = m.versions.findIndex(v => v.v === m.current)
  const all = [...m.versions, ...(m.pending ? [m.pending] : [])]
  const find2 = (v: string) => all.find(x => x.v === v)
  const a = str(i.a) ? find2(str(i.a)) : m.pending ? m.versions[idx] : m.versions[idx - 1]
  const b = str(i.b) ? find2(str(i.b)) : m.pending ?? m.versions[idx]
  if (!a || !b) return err(`give two versions (a, b) that exist: ${all.map(v => v.v).join(', ')}${m.versions.length < 2 && !m.pending ? '; there is only one version' : ''}`)
  const ta = await readText(h, `${f.dir}/${a.v}/${a.file}`)
  const tb = await readText(h, `${f.dir}/${b.v}/${b.file}`)
  if (ta === null || tb === null) return err('a version file is missing')
  const d = unifiedDiff(ta, tb, `${a.v}/${a.file}`, `${b.v}/${b.file}`)
  const lines = d.split('\n')
  return { ok: true, text: d ? (lines.length > 300 ? `${lines.slice(0, 300).join('\n')}\n[... ${lines.length - 300} more lines]` : d) : `${a.v} and ${b.v} are identical` }
}

export async function useCounts(h: Host): Promise<Record<string, number>> {
  const rows = await readJsonl<{ name?: string }>(h, `${scriptsDir(await homeDir(h))}/uses.jsonl`)
  const n: Record<string, number> = {}
  for (const r of rows) if (typeof r.name === 'string') n[r.name] = (n[r.name] ?? 0) + 1
  return n
}

const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
// a thread sees its own project's scripts and the global ones (other projects' names and purposes are not its business, a private
// project's least of all); the desk sees all
async function visible(h: Host, who: Who, meta: Meta): Promise<boolean> {
  return who.kind !== 'thread' || meta.project === 'global' || (await threadProject(h, await homeDir(h), who.id)) === meta.project
}
async function list(h: Host, who: Who): Promise<Out> {
  const all: Found[] = []
  for (const x of await allScripts(h)) if (await visible(h, who, x.meta)) all.push(x)
  all.sort((a, b) => a.meta.name.localeCompare(b.meta.name))
  const uses = await useCounts(h)
  const c = all.filter(x => x.meta.status === 'candidate').length
  const a = all.filter(x => x.meta.status === 'adopted').length
  const rows = []
  for (const x of all) {
    const health = x.meta.status === 'adopted' ? healthOf(x.meta, (await integrity(h, x.dir, x.meta)).ok) : null
    rows.push({ name: x.meta.name, project: x.meta.project, status: x.meta.status, verdict: verdictOf(x.meta), overridden: !!x.meta.decision, uses: uses[x.meta.name] ?? 0, core: !!x.meta.core, purpose: x.meta.purpose, version: x.meta.current ?? null, health, update: x.meta.pending ? x.meta.pending.v : null })
  }
  const bad = rows.filter(r => r.health && r.health !== 'ok').length
  const lines = rows.map(r => `${r.name} · ${r.project} · ${r.status}${r.version ? ` ${r.version}` : ''} · ${r.verdict}${r.overridden ? ' (user decision)' : ''} · ${r.uses} use(s)${r.health && r.health !== 'ok' ? ` · ${r.health.toUpperCase()}` : ''}${r.update ? ` · update ${r.update} waiting` : ''}${r.core ? ' · core candidate' : ''} · ${short(r.purpose, 80)}`)
  const w = all.filter(x => x.meta.status === 'audited').length
  return { ok: true, text: [`Scripts: ${c} candidates, ${a} adopted${w ? `, ${w} audited and waiting for the desk` : ''}${bad ? `, ${bad} need attention (needs-update or edited)` : ''}`, ...lines].join('\n'), data: rows }
}

async function show(h: Host, who: Who, i: any): Promise<Out> {
  const f = await find(h, str(i.name))
  if (!f || !(await visible(h, who, f.meta))) return err(`no script ${str(i.name)}`)
  const uses = (await useCounts(h))[f.meta.name] ?? 0
  const ig = await integrity(h, f.dir, f.meta)
  const versions = (f.meta.versions ?? []).map(v => `${v.v}${v.v === f.meta.current ? ' (current)' : ''} · ${v.sha256.slice(0, 8)} · ${v.author} · ${new Date(v.ts).toISOString().slice(0, 10)} · ${v.decision ? `user: ${v.decision.value}` : (v.audit?.verdict ?? 'unaudited')}${v.changes?.length ? ` · ${v.changes.join('; ')}` : ''}`)
  const extra = f.meta.status === 'adopted' ? { command: expandRun(f.meta, f.dir), health: healthOf(f.meta, ig.ok), ...(ig.ok ? {} : { integrity: ig.why }), versionList: versions, failures: f.meta.failures ?? 0 } : {}
  // (an audit that was started and has no verdict yet is not "unaudited": the verdict is on its way)
  const verdict = waitingForVerdict(f.meta) ? 'audited, waiting for the verdict' : verdictOf(f.meta)
  return { ok: true, text: JSON.stringify({ ...f.meta, dir: f.dir, script: `${f.dir}/${f.meta.file}`, verdict, uses, ...extra }, null, 2), data: f.meta }
}

// scripts the auditor judged adopt that the mod's rules did not adopt on their own: they wait for the desk (candidates in status
// `audited`, and updates whose audit waits). What the pane shows with Adopt / Reject.
export type Waiting = { name: string; project: string; why: string; sha: string; update?: string }
export async function waitingScripts(h: Host): Promise<Waiting[]> {
  const out: Waiting[] = []
  for (const x of await allScripts(h)) {
    const m = x.meta
    const pend = m.status === 'adopted' ? m.pending : undefined
    const a = pend ? pend.audit : m.status === 'audited' ? m.audit : undefined
    if (a?.waits && a.sha === (pend ? pend.sha256 : m.sha256)) out.push({ name: m.name, project: m.project, why: short(a.blockers.join('; ') || a.reason || 'the mod\'s rules', 140), sha: a.sha, ...(pend ? { update: pend.v } : {}) })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export async function scriptCounts(h: Host): Promise<{ candidates: number; adopted: number; needsUpdate: number }> {
  const all = await allScripts(h)
  let needsUpdate = 0
  for (const x of all) if (x.meta.status === 'adopted' && (x.meta.state === 'needs-update' || !(await integrity(h, x.dir, x.meta)).ok)) needsUpdate++
  return { candidates: all.filter(x => x.meta.status === 'candidate').length, adopted: all.filter(x => x.meta.status === 'adopted').length, needsUpdate }
}

// ---- the tool ------------------------------------------------------------------------------------------------------
export const SCRIPT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['propose', 'audit', 'record-audit', 'list', 'show', 'retire', 'decide', 'update', 'rollback', 'report-bad', 'diff'] },
    name: { type: 'string', description: 'script name (letters, digits . _ -)' },
    path: { type: 'string', description: 'propose: absolute path of the script file (copied, never run)' },
    purpose: { type: 'string', description: 'propose: what it does, one sentence' },
    run: { type: 'string', description: 'propose: the command with {script} where the script goes, e.g. `python3 {script} <ledger.jsonl>`' },
    inputs: { type: 'array', items: { type: 'string' }, description: 'propose: what it reads (arguments, files)' },
    outputs: { type: 'array', items: { type: 'string' }, description: 'propose: what it writes ("stdout" if it only prints; any file it writes must be listed)' },
    project: { type: 'string', description: 'propose: project name, or "global" (default: this thread\'s project)' },
    verdict: { type: 'string', enum: ['adopt', 'adapt', 'reject'], description: 'decide (desk): the user\'s decision, adopt or reject; record-audit: the auditor\'s verdict from its LEAN-AUDIT line' },
    reason: { type: 'string', description: 'decide / retire / rollback / record-audit: why (a thread must give one to roll back; record-audit: the auditor\'s one-line reason)' },
    network: { type: 'boolean', description: 'record-audit: the auditor\'s answer, true or false (required)' },
    deletes: { type: 'boolean', description: 'record-audit: the auditor\'s answer, true or false (required)' },
    secrets: { type: 'boolean', description: 'record-audit: the auditor\'s answer, true or false (required)' },
    generalises: { type: 'boolean', description: 'record-audit: the auditor\'s answer, true or false (required)' },
    deterministic: { type: 'boolean', description: 'record-audit: default true' },
    errors_handled: { type: 'boolean', description: 'record-audit: default true' },
    reads: { type: 'array', items: { type: 'string' }, description: 'record-audit: what the auditor says it reads' },
    writes: { type: 'array', items: { type: 'string' }, description: 'record-audit: what the auditor says it writes (checked against the declared outputs)' },
    hardcoded: { type: 'array', items: { type: 'string' }, description: 'record-audit: hardcoded values the auditor found' },
    changes: { type: 'array', items: { type: 'string' }, description: 'record-audit: the concrete changes an adapt verdict asks for' },
    edits: { type: 'array', items: { type: 'object', properties: { find: { type: 'string' }, replace: { type: 'string' } } }, description: 'update: exact replacements on the current version (each find occurs once), instead of a new file' },
    version: { type: 'string', description: 'rollback: the version to go back to, like v1 (default: the one before the current)' },
    a: { type: 'string', description: 'diff: first version (default: the one before current, or current when an update waits)' },
    b: { type: 'string', description: 'diff: second version (default: the update, or current)' },
    why: { type: 'string', description: 'report-bad: what was wrong with the script\'s result' },
    sha: { type: 'string', description: 'decide / record-audit: the sha256 (at least 12 characters) of the text the user looked at, or the auditor was given; refused when the script changed since' },
    confirm: { type: 'boolean', description: 'decide adopt over an audit that said otherwise: only after the user was told and agreed' },
  },
  required: ['action'],
}
export const SCRIPT_SPEC = {
  name: SCRIPT_TOOL,
  description: 'Scripts over models: propose (copy a script you wrote into the candidate store, never run), audit (a read-only auditor judges it; the mod applies the rules; the desk starts one audit thread per text), record-audit (pass on the fields of the auditor\'s LEAN-AUDIT line when its call ran in the background and no verdict was recorded), list, show, diff, retire; update (a new file or edits for an adopted script: audited as a diff, then current), rollback, report-bad (it was wrong); decide (desk, the user overrides a verdict). An adopted script becomes a rule line and a recipe skill (lean-agent-script-<name>) with its stable run command.',
  inputSchema: SCRIPT_SCHEMA,
}

export async function scriptTool(h: Host, who: Who, i: any, io: Io = {}): Promise<Out> {
  try {
    switch (i?.action) {
      case 'propose':
        return await queued(h, () => propose(h, who, i))
      case 'list':
        return await list(h, who)
      case 'show':
        return await show(h, who, i)
      case 'retire':
        return await queued(h, () => retire(h, who, i))
      case 'decide':
        return await queued(h, () => decide(h, who, i))
      case 'update': {
        const u = await queued(h, () => update(h, who, i, io))
        if (!u.start || !io.startThread) return u
        const t = await io.startThread(u.start.title, u.start.brief, u.start.project) // after the lock: the new thread needs it
        return t.ok ? { ok: true, text: `${u.text} The audit started in a thread: ${t.text}` } : t
      }
      case 'rollback':
        return await queued(h, () => rollback(h, who, i))
      case 'report-bad':
        return await queued(h, () => reportBad(h, who, i))
      case 'diff':
        return await diffOf(h, who, i)
      case 'audit': {
        const name = str(i.name)
        const f = await find(h, name)
        if (!f || !(await visible(h, who, f.meta))) return err(`no script ${name || '(name missing)'}`)
        const pend = f.meta.status === 'adopted' ? f.meta.pending : undefined
        if (f.meta.status !== 'candidate' && !pend) return err(`${name} is ${f.meta.status}${f.meta.status === 'adopted' ? ' with no update waiting (lean_script update sends one)' : ''}: only a candidate or an update is audited`)
        const brief = pend ? updateBrief(f.meta, f.dir, pend) : auditBrief(f.meta, f.dir)
        if (who.kind === 'thread') return { ok: true, text: `${brief}\nAudit started; verdict not recorded yet: it is recorded when the auditor returns in the foreground, or when you call lean_script record-audit.` }
        if (!io.startThread) return { ok: true, text: `Route this to a thread (lean_thread new) with this brief:\n${brief}` }
        // one audit thread per text: claim it under the lock (a second audit while one runs starts nothing), then start it outside the lock
        const sha = pend ? pend.sha256 : f.meta.sha256
        const running = await queued(h, async () => {
          const g = await find(h, name)
          if (!g) return 'gone'
          const a = g.meta.auditing
          if (a && a.sha === sha && (await auditRunning(h, a))) return a.thread ?? ''
          await writeJson(h, `${g.dir}/meta.json`, { ...g.meta, auditing: { sha, ts: await h.clock.now(), thread: 'pending' } satisfies Auditing })
          return null
        })
        if (running === 'gone') return err(`no script ${name}`)
        if (running !== null) return { ok: true, text: `audit of ${name} is already ${running === 'pending' ? 'being started' : `running in ${running}`}: no second audit thread was started. Audit started; verdict not recorded yet (lean_script show ${name} says when it arrives)` }
        const t = await io.startThread(`audit script ${name}`, brief, f.meta.project === 'global' ? '' : f.meta.project)
        const id = String((t.data as { id?: unknown } | undefined)?.id ?? '')
        await queued(h, async () => {
          const g = await find(h, name)
          if (!g || g.meta.auditing?.sha !== sha || g.meta.auditing.thread !== 'pending') return
          const { auditing: _drop, ...rest } = g.meta
          await writeJson(h, `${g.dir}/meta.json`, t.ok && /^t\d+$/.test(id) ? { ...g.meta, auditing: { ...g.meta.auditing, thread: id } } : rest) // a thread that did not start leaves nothing claimed
        })
        return t.ok ? { ok: true, text: `audit of ${name} started in a thread: ${t.text}. Audit started; verdict not recorded yet: the audit thread records it (lean_script record-audit, or the mod when its auditor returns in the foreground); lean_script show ${name} says "audited, waiting for the verdict" until then` } : t
      }
      case 'record-audit':
        return await queued(h, () => recordAuditTool(h, who, i))
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
  warned.clear()
  asked.clear()
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
  const base = w[0]?.split('/').pop() ?? '' // the interpreter is the command itself (after env assignments, time, nohup ...), not any word of a line
  if (!INTERP.test(base)) return w[0]?.startsWith('/') ? w[0].replace(/^["']|["']$/g, '') : null
  const args = w.slice(1)
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
type Run = { name: string; project: string; dir: string; meta: Meta }
async function adoptedRuns(h: Host, cmd: string): Promise<Run[]> {
  if (!cmd.includes('/scripts/')) return []
  const home = await homeDir(h)
  const lean = leanDir(home)
  const seen = new Set<string>()
  const out: Run[] = []
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
    if (meta && meta.status === 'adopted' && file === `${dir}/${meta.file}`) out.push({ name, project, dir, meta })
  }
  return out
}

// did a Bash result fail? (an error flag, or the "Exit code N" line the Bash tool prints for a non-zero exit)
export function bashFailed(r: any): boolean {
  if (!r || r.deny !== undefined) return false
  if (r.isError === true) return true
  const t = typeof r.result === 'string' ? r.result : Array.isArray(r.result) ? r.result.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('\n') : ''
  return /(?:^|\n)Exit code [1-9]\d*/.test(t)
}

const warned = new Set<string>() // needs-update nudges given this session, once per script
// A thread's Bash ran an adopted script: count the use; a hand-edited copy is warned about (one line, every run); a failed run is
// counted and the second failure marks the script needs-update; a script that needs an update nudges once per session to propose a fix.
// Returns the lines to add to the tool result, or null.
export async function noteUse(h: Host, cmd: string, thread: string, failed = false): Promise<string | null> {
  const runs = await adoptedRuns(h, cmd)
  if (!runs.length) return null
  const home = await homeDir(h)
  const notes: string[] = []
  for (const r of runs) {
    await appendJsonl(h, `${scriptsDir(home)}/uses.jsonl`, { ts: await h.clock.now(), name: r.name, project: r.project, thread, ...(failed ? { failed: true } : {}) })
    const ig = await integrity(h, r.dir, r.meta)
    if (!ig.ok) notes.push(`[lean-agent] WARNING: ${r.name} was edited by hand since its audit (${ig.why}): unaudited. Trust this run only if you made or reviewed the edit; propose it with lean_script update ${r.name} to have the change audited.`)
    let meta = r.meta
    if (failed) {
      const flagged = await queued(h, async () => {
        const m = await readMeta(h, r.dir)
        if (!m || m.status !== 'adopted') return null
        const n = (m.failures ?? 0) + 1
        const flag = n >= 2 && m.state !== 'needs-update'
        const next = note({ ...m, failures: n, ...(flag ? { state: 'needs-update' as const } : {}) }, await h.clock.now(), `run failed (${n})`)
        await writeJson(h, `${r.dir}/meta.json`, next)
        if (flag) await refresh(h, m.project)
        return { n, flag, next }
      }).catch(() => null)
      if (flagged) {
        meta = flagged.next
        notes.push(`[lean-agent] ${r.name} failed (${flagged.n} failure${flagged.n > 1 ? 's' : ''}${flagged.flag ? '; it is now marked needs-update' : '; two mark it needs-update'}).`)
      }
    }
    if (meta.state === 'needs-update' && !warned.has(r.name)) {
      warned.add(r.name)
      notes.push(`[lean-agent] ${r.name} is marked needs-update (${meta.badWhy ?? `${meta.failures ?? 0} failed run(s)`}): if you can fix it, propose the fix with lean_script update ${r.name} (a new file or edits); it is audited as a diff.`)
    }
  }
  return notes.length ? notes.join('\n') : null
}

// A subagent never runs an adopted script that was edited by hand (it is unaudited); the built-in commands run no script at all.
export async function unauditedRun(h: Host, cmd: string): Promise<string | null> {
  for (const r of await adoptedRuns(h, cmd)) {
    const ig = await integrity(h, r.dir, r.meta)
    if (!ig.ok) return `lean-agent: ${r.name} was edited by hand since its audit (${ig.why}), so it is unaudited and a subagent does not run it; audit it (lean_script update) or roll it back first`
  }
  return null
}

// When a thread reports done: one question per thread and session, never for workers (the caller passes only a thread's own call).
const asked = new Set<string>()
export const DONE_QUESTION = 'Could any step of this task have been a script? If yes: lean_script propose.'
export function doneQuestion(thread: string): string | null {
  if (asked.has(thread)) return null
  asked.add(thread)
  return DONE_QUESTION
}
