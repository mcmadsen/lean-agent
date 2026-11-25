// lean_run "gates" (1.0.35): the project's gates (type check, tests, lint) run by the mod, no model call, so a worker or thread does not spend
// its turns on them. `gates` runs them; `gates commit <message>` also commits the worker's own files when all are green and gates.commitOnGreen
// is on. Each gate runs through runSummary (runjob.ts): its refusals and timeouts apply. Argv only for git; never --amend, --no-verify, push.
import { leanDir, homeDir, readJson } from './state'
import type { Host } from './state'
import { runSummary } from './runjob'

export type Gate = { name: string; cmd: string }
export type GateRun = (g: Gate, cwd: string) => Promise<{ exit: number; body: string }>
export const GATES_RE = /^gates(?:\s+(commit)(?:\s+([\s\S]*))?)?\s*$/
const NAME_RE = /^[\w][\w .-]{0,39}$/
const MAX_GATES = 8
const MAX_MSG = 2000
const PROTECTED = new Set(['main', 'master', 'trunk', 'develop', 'dev'])

// a key of config.json: nested ("gates": { "auto" }) or flat ("gates.auto")
const pick = (cfg: any, key: string): unknown => {
  if (!cfg || typeof cfg !== 'object') return undefined
  if (key in cfg) return cfg[key]
  let v: any = cfg
  for (const p of key.split('.')) v = v && typeof v === 'object' ? v[p] : undefined
  return v
}

export async function gatesConfig(h: Host, home: string, cwd: string): Promise<{ gates: Gate[]; commitOnGreen: boolean }> {
  const cfg = await readJson<any>(h, `${leanDir(home)}/config.json`, {})
  const list = pick(cfg, 'gates.commands')
  let gates: Gate[] = []
  if (Array.isArray(list)) {
    for (const g of list) if (g && typeof g === 'object' && typeof g.name === 'string' && NAME_RE.test(g.name) && typeof g.cmd === 'string' && g.cmd.trim() && g.cmd.length <= 500) gates.push({ name: g.name, cmd: g.cmd.trim() })
    gates = gates.slice(0, MAX_GATES)
  }
  if (!gates.length && pick(cfg, 'gates.auto') !== false) gates = await autoGates(h, cwd)
  return { gates, commitOnGreen: pick(cfg, 'gates.commitOnGreen') === true }
}

async function autoGates(h: Host, cwd: string): Promise<Gate[]> {
  let scripts: any = {}
  try {
    scripts = JSON.parse(String(await h.fs.read(`${cwd}/package.json`))).scripts ?? {}
  } catch {
    return []
  }
  const pm = (await h.fs.exists(`${cwd}/pnpm-lock.yaml`)) ? 'pnpm' : (await h.fs.exists(`${cwd}/yarn.lock`)) ? 'yarn' : 'npm'
  return ['typecheck', 'lint', 'test'].filter(s => scripts && typeof scripts[s] === 'string').map(s => ({ name: s, cmd: `${pm} run ${s}` }))
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
export function failLines(body: string, n = 20): string[] {
  const lines = body.replace(ANSI, '').split('\n').map(l => l.trimEnd()).filter(l => l.trim())
  const hit = lines.filter(l => /error|fail|✖|TS\d{4}/i.test(l))
  return (hit.length ? hit : lines.slice(-n)).slice(0, n)
}

const SECRET = /(^|\/)(\.env[^/]*|[^/]*\.pem|[^/]*\.key|id_rsa[^/]*)$/
export function ownFiles(porcelainZ: string): string[] {
  const parts = porcelainZ.split('\0')
  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!
    if (p.length < 4) continue
    const xy = p.slice(0, 2)
    const path = p.slice(3)
    if (/[RC]/.test(xy)) i++ // a rename / copy: the next entry is its origin
    if (SECRET.test(path) || /(^|\/)\.lean-agent(\/|$)/.test(path)) continue
    out.push(path)
  }
  return out
}

async function commitOwn(h: Host, cwd: string, msg: string): Promise<string> {
  const git = (...a: string[]) => h.process.run(['git', '-C', cwd, ...a], { timeoutMs: 60_000 })
  const failed = 'commit failed; nothing amended'
  try {
    const br = await git('rev-parse', '--abbrev-ref', 'HEAD')
    const name = br.stdout.trim()
    if (br.exitCode !== 0 || !name) return `${failed}: no branch`
    if (name === 'HEAD') return 'commit refused: detached HEAD'
    if (PROTECTED.has(name)) return `commit refused: ${name} is a default branch; work on your own branch`
    const st = await git('status', '--porcelain', '-z')
    if (st.exitCode !== 0) return `${failed}: git status failed`
    const files = ownFiles(st.stdout)
    if (!files.length) return 'commit skipped: no files to commit'
    const add = await git('add', '--', ...files)
    if (add.exitCode !== 0) return `${failed}: git add failed`
    const c = await git('commit', '-m', msg, '--', ...files)
    if (c.exitCode !== 0) return `${failed}: ${(c.stderr || c.stdout).trim().split('\n')[0] ?? ''}`.slice(0, 300)
    const sha = (await git('rev-parse', '--short', 'HEAD')).stdout.trim()
    return `committed ${sha} on ${name}: ${files.length} file(s)`
  } catch (err) {
    return `${failed}: ${String((err as Error)?.message ?? err).slice(0, 200)}`
  }
}

export async function runGates(h: Host, a: { command: string; cwd?: string; home?: string; run?: GateRun }): Promise<{ text: string; ok: boolean }> {
  const m = GATES_RE.exec(a.command.trim())
  if (!m) throw new Error('gates: use "gates" or "gates commit <message>"')
  const cwd = a.cwd || '.'
  const home = a.home ?? (await homeDir(h))
  const msg = (m[2] ?? '').trim()
  if (m[1] && msg.length > MAX_MSG) throw new Error(`gates commit: the message is over ${MAX_MSG} characters`)
  const { gates, commitOnGreen } = await gatesConfig(h, home, cwd)
  if (!gates.length) return { text: 'gates: none configured (set gates.commands, or add typecheck / lint / test scripts to package.json)', ok: false }
  const run: GateRun = a.run ?? (async g => {
    const r = await runSummary(h, { command: g.cmd, cwd: a.cwd, home })
    return { exit: r.exit, body: r.body }
  })
  const out: string[] = []
  let pass = 0
  for (const g of gates) {
    let r: { exit: number; body: string }
    try {
      r = await run(g, cwd)
    } catch (err) {
      r = { exit: 1, body: `refused: ${String((err as Error)?.message ?? err)}` }
    }
    if (r.exit === 0) {
      pass++
      out.push(`ok ${g.name}`)
    } else out.push(`FAIL ${g.name} (exit ${r.exit}): ${g.cmd}`, ...failLines(r.body).map(l => `  ${l}`))
  }
  const ok = pass === gates.length
  let text = `gates: ${pass} of ${gates.length} pass\n${out.join('\n')}`
  if (m[1]) {
    if (!ok) text += '\ncommit skipped: a gate failed'
    else if (!commitOnGreen) text += '\ncommit refused: gates.commitOnGreen is off (set it true in config.json to let "gates commit" commit)'
    else if (!msg) text += '\ncommit refused: give a message: gates commit <message>'
    else text += `\n${await commitOwn(h, cwd, msg)}`
  }
  return { text, ok }
}
