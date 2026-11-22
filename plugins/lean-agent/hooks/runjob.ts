// lean_run (execution model): a test / build command runs with its whole output in a file; the thread gets the exit code, the failing
// test names and the last 40 lines, never the stream. Computed by script, no model reads the log.
import { dirOf, leanDir, mkdirp } from './state'
import type { Host } from './state'
import { analyze } from './shell'

export const RUN_TIMEOUT_MS = 600_000
export type RunResult = { exit: number; failing: string[]; tail: string; file: string }

const FAIL = /^\s*(FAIL|✗|✖|not ok|FAILED|● )|\bfailed\b.*test|\btest.*\bfailed\b/i
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

// pure: the failing test names (at most 20, unique, trimmed) and the last 40 lines of a log
export function summarize(log: string): { failing: string[]; tail: string } {
  const lines = log.split('\n')
  const failing: string[] = []
  for (const l of lines) {
    if (!FAIL.test(l)) continue
    const t = cut(l.trim(), 160)
    if (!failing.includes(t)) failing.push(t)
    if (failing.length >= 20) break
  }
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop()
  return { failing, tail: lines.slice(-40).map(l => cut(l, 300)).join('\n') }
}

export async function runSummary(h: Host, a: { command: string; cwd?: string; home: string }): Promise<RunResult> {
  const command = a.command.trim()
  if (!command) throw new Error('no command')
  const v = analyze(command)
  if (v.push || v.write) throw new Error('lean_run runs test and build commands only (no push, no forge writes)')
  const file = `${leanDir(a.home)}/runs/${await h.clock.now()}.log`
  await mkdirp(h, dirOf(file))
  const run = `${a.cwd ? `cd ${q(a.cwd)} && ` : ''}( ${command} ) > ${q(file)} 2>&1`
  const r = await h.process.run(['bash', '-c', run], { timeoutMs: RUN_TIMEOUT_MS }) // a watch mode or a dev server ends instead of hanging the thread
  let log = ''
  try {
    log = String((await h.fs.read(file)) ?? '')
  } catch {
    log = r.stdout + r.stderr
  }
  return { exit: r.exitCode, ...summarize(log), file }
}

// ---- the read-only CI check: `lean_run {ci: {...}}` waits INSIDE the tool (a script polls, no model turn per check) -------------------------
// argv only (never a shell), built from a fixed table of read-only subcommands: az pipelines runs show / list, gh run view / list, gh pr checks.
export const CI_WAIT_MAX = 30 // minutes
export const CI_POLL_MS = 45_000 // between two polls (30-60 s)
export const CI_IDS_MAX = 10
const CI_ALLOW = [['az', 'pipelines', 'runs', 'show'], ['az', 'pipelines', 'runs', 'list'], ['gh', 'run', 'view'], ['gh', 'run', 'list'], ['gh', 'pr', 'checks']]
const CI_WRITE_ARGS = new Set(['--method', '-X', '--input', '--body', '--body-file', '-f', '-F', '--field', '--raw-field', '--web', '-w', '--watch', '--fail-fast'])
export type CiRequest = { host?: unknown; org?: unknown; project?: unknown; repo?: unknown; id?: unknown; ids?: unknown; branch?: unknown; pr?: unknown; waitMinutes?: unknown }
export type CiRun = { id: string; status: string; result: string; failed: string[]; url: string; note?: string; done: boolean; errors: number }
export type CiResult = { text: string; failed: boolean; timedOut: boolean; runs: CiRun[] }

// the one wall in front of every az / gh call of the CI check: a read-only subcommand of the table, no write-ish flag
export function ciArgvOk(argv: readonly string[]): void {
  const ok = CI_ALLOW.some(p => p.every((w, i) => argv[i] === w))
  if (!ok) throw new Error(`ci runs only read-only commands (${CI_ALLOW.map(p => p.join(' ')).join(', ')}); refused: ${argv.slice(0, 4).join(' ').slice(0, 80)}`)
  for (const a of argv.slice(1)) if (CI_WRITE_ARGS.has(a)) throw new Error(`ci runs only read-only commands: the argument ${a} is refused`)
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,99}$/
const GH_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}$/
const BRANCH = /^[A-Za-z0-9_.][A-Za-z0-9._\/-]{0,199}$/
const whole = (v: unknown): number | null => {
  const n = typeof v === 'string' && /^\d{1,12}$/.test(v.trim()) ? Number(v.trim()) : v
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n < 1e12 ? n : null
}
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

type Plan = { host: 'ado' | 'github'; ids: number[]; pr: number | null; branch: string; wait: number; list: (id: number | null) => string[] }
function ciPlan(c: CiRequest): Plan {
  const keys = new Set(['host', 'org', 'project', 'repo', 'id', 'ids', 'branch', 'pr', 'waitMinutes'])
  for (const k of Object.keys(c)) if (!keys.has(k)) throw new Error(`ci: unknown field "${k.slice(0, 30)}" (host, org, project, repo, id or ids, branch, pr, waitMinutes)`)
  const host = c.host === 'ado' || c.host === 'github' ? c.host : null
  if (!host) throw new Error('ci.host must be "ado" or "github"')
  const wait = c.waitMinutes === undefined ? 10 : typeof c.waitMinutes === 'number' && Number.isFinite(c.waitMinutes) && c.waitMinutes >= 0 && c.waitMinutes <= CI_WAIT_MAX ? c.waitMinutes : null
  if (wait === null) throw new Error(`ci.waitMinutes must be a number from 0 to ${CI_WAIT_MAX}`)
  const raw = c.ids !== undefined ? c.ids : c.id !== undefined ? [c.id] : []
  if (!Array.isArray(raw) || raw.length > CI_IDS_MAX) throw new Error(`ci.ids is a list of at most ${CI_IDS_MAX} run numbers`)
  const ids = raw.map(whole)
  if (ids.some(i => i === null)) throw new Error('ci run ids are positive whole numbers')
  const branch = str(c.branch)
  if (branch && (!BRANCH.test(branch) || branch.includes('..'))) throw new Error('ci.branch is a plain branch name')
  const pr = c.pr === undefined ? null : whole(c.pr)
  if (c.pr !== undefined && pr === null) throw new Error('ci.pr is a pull request number')
  if (host === 'ado') {
    const org = str(c.org)
    const project = str(c.project)
    if (!NAME.test(org) || !NAME.test(project)) throw new Error('ci host ado needs org and project (names)')
    if (!ids.length && !branch) throw new Error('ci host ado needs a run id (id or ids) or a branch to list its latest runs')
    if (pr !== null || c.repo !== undefined) throw new Error('ci host ado takes org, project and id/ids or branch (no repo or pr)')
    const where = ['--org', `https://dev.azure.com/${encodeURIComponent(org)}`, '--project', project, '--output', 'json']
    return { host, ids: ids as number[], pr, branch, wait, list: id => (id !== null ? ['az', 'pipelines', 'runs', 'show', '--id', String(id), ...where] : ['az', 'pipelines', 'runs', 'list', '--branch', branch, '--top', '5', '--query-order', 'QueueTimeDesc', ...where]) }
  }
  const repo = str(c.repo)
  if (!GH_REPO.test(repo)) throw new Error('ci host github needs repo as owner/name')
  if (c.org !== undefined || c.project !== undefined) throw new Error('ci host github takes repo and id/ids, pr or branch (no org or project)')
  if (!ids.length && pr === null && !branch) throw new Error('ci host github needs a run id (id or ids), a pr number or a branch')
  const fields = 'status,conclusion,jobs,url,name,displayTitle'
  return {
    host,
    ids: ids as number[],
    pr,
    branch,
    wait,
    list: id => (id !== null ? ['gh', 'run', 'view', String(id), '--repo', repo, '--json', fields] : pr !== null ? ['gh', 'pr', 'checks', String(pr), '--repo', repo, '--json', 'name,state,bucket,link,workflow'] : ['gh', 'run', 'list', '--branch', branch, '--repo', repo, '--limit', '5', '--json', 'databaseId,status,conclusion,url,name,displayTitle']),
  }
}

const FAILED = /^(failed|failure|canceled|cancelled|timed_out|timedout|error|startup_failure|partiallysucceeded)$/i
const lc = (v: unknown): string => (typeof v === 'string' ? v : '')
// failed stage / job / step / test names the JSON carries (at most 8): github `jobs[].steps[]`, az `stages` / `jobs` / `records`
function failedNames(o: Record<string, unknown>): string[] {
  const out: string[] = []
  const add = (s: string) => {
    if (s && out.length < 8 && !out.includes(s)) out.push(cut(s, 120))
  }
  for (const key of ['stages', 'jobs', 'records', 'tests']) {
    const list = Array.isArray(o[key]) ? (o[key] as Record<string, unknown>[]) : []
    for (const j of list) {
      if (!j || typeof j !== 'object') continue
      const bad = FAILED.test(lc(j.conclusion) || lc(j.result) || lc(j.outcome) || lc(j.state))
      if (!bad) continue
      const name = lc(j.name)
      const steps = Array.isArray(j.steps) ? (j.steps as Record<string, unknown>[]).filter(s => s && FAILED.test(lc(s.conclusion) || lc(s.result))) : []
      if (steps.length) for (const s of steps) add(`${key === 'stages' ? 'stage' : 'job'} ${name} / ${lc(s.name)}`)
      else add(`${key === 'stages' ? 'stage' : key === 'tests' ? 'test' : key === 'records' ? lc(j.type) || 'record' : 'job'} ${name}`)
    }
  }
  return out
}
const urlOf = (o: Record<string, unknown>): string => {
  const links = o._links as { web?: { href?: unknown } } | undefined
  return [links?.web?.href, o.url, o.link].find((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u)) ?? ''
}
function toRun(o: Record<string, unknown>, pr: boolean): CiRun {
  if (pr) {
    const bucket = lc(o.bucket)
    const done = !!bucket && bucket !== 'pending'
    return { id: lc(o.name) || '?', status: done ? 'completed' : 'inProgress', result: bucket === 'pass' ? 'succeeded' : bucket === 'fail' ? 'failed' : bucket || lc(o.state).toLowerCase(), failed: bucket === 'fail' ? [lc(o.name)] : [], url: urlOf(o), done, errors: 0 }
  }
  const status = lc(o.status) || 'unknown'
  const result = lc(o.result) || lc(o.conclusion)
  const done = status === 'completed'
  const id = o.id ?? o.databaseId
  return { id: typeof id === 'number' || typeof id === 'string' ? String(id) : '?', status, result, failed: done ? failedNames(o) : [], url: urlOf(o), done, errors: 0 }
}

export async function runCi(h: Host, c: CiRequest): Promise<CiResult> {
  const p = ciPlan(c)
  const call = async (argv: string[]): Promise<unknown> => {
    ciArgvOk(argv)
    const r = await h.process.run(argv, { timeoutMs: 60_000 }).catch((e: unknown) => ({ exitCode: 127, stdout: '', stderr: String((e as Error)?.message ?? e) }))
    // gh pr checks exits non-zero for failing or pending checks and still prints the JSON
    try {
      return JSON.parse(r.stdout)
    } catch {
      throw new Error((r.stderr || r.stdout || `exit ${r.exitCode}`).replace(/\s+/g, ' ').trim().slice(0, 200))
    }
  }
  const start = await h.clock.now()
  const deadline = start + p.wait * 60_000
  const runs = new Map<string, CiRun>()
  const order: string[] = []
  const put = (r: CiRun) => {
    if (!runs.has(r.id)) order.push(r.id)
    runs.set(r.id, r)
  }
  const ids: (number | null)[] = p.ids.length ? p.ids : [null]
  const err = (key: string, e: unknown): void => {
    const old = runs.get(key)
    const errors = (old?.errors ?? 0) + 1
    put({ id: key, status: 'unknown', result: '', failed: [], url: '', note: String((e as Error)?.message ?? e).slice(0, 200), done: errors >= 3, errors })
  }
  const poll = async (): Promise<void> => {
    for (const id of ids) {
      const key = id === null ? (p.pr !== null ? `pr ${p.pr}` : `branch ${p.branch}`) : String(id)
      if (id !== null && runs.get(key)?.done) continue
      try {
        const out = await call(p.list(id))
        if (id !== null) {
          if (!out || typeof out !== 'object' || Array.isArray(out)) throw new Error('no run in the answer')
          put({ ...toRun(out as Record<string, unknown>, false), id: key })
        } else {
          const list = (Array.isArray(out) ? out : []).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
          if (!list.length) throw new Error(p.pr !== null ? 'no checks found for that pull request' : `no runs found for branch ${p.branch}`)
          runs.delete(key)
          for (const x of list) put(toRun(x, p.pr !== null))
        }
      } catch (e) {
        err(key, e)
      }
    }
  }
  let timedOut = false
  for (;;) {
    await poll()
    if ([...runs.values()].every(r => r.done)) break
    const now = await h.clock.now()
    if (!h.clock.sleep || now + CI_POLL_MS > deadline) {
      timedOut = true
      break
    }
    await h.clock.sleep(CI_POLL_MS)
  }
  const list = order.map(k => runs.get(k)!).filter(Boolean)
  const mins = Math.max(0, Math.round(((await h.clock.now()) - start) / 60_000))
  return { ...ciText(list, timedOut, p.wait, mins), runs: list }
}

function ciText(list: CiRun[], timedOut: boolean, wait: number, mins: number): Omit<CiResult, 'runs'> {
  const bad = (r: CiRun) => r.done && (r.errors > 0 || FAILED.test(r.result))
  const lines = list.map(r => {
    const state = r.errors > 0 ? `could not read it (${r.note ?? 'error'})` : `${r.status}${r.result ? ` / ${r.result}` : ''}`
    const flag = !r.done ? ' [still running]' : ''
    return [`${r.id}: ${state}${flag}`, r.failed.length ? `failed: ${r.failed.join('; ')}` : '', r.url].filter(Boolean).join(' · ')
  })
  const running = list.filter(r => !r.done)
  const head = timedOut ? `still running after ${mins} min${wait === 0 ? ' (no wait asked)' : ` (asked to wait ${wait})`}: ${running.map(r => r.id).join(', ')}` : `all ${list.length} finished${mins ? ` after ${mins} min` : ''}`
  return { text: [head, ...lines].join('\n'), failed: list.some(bad), timedOut }
}

export function runText(r: RunResult): string {
  return [`exit ${r.exit}`, r.failing.length ? `failing:\n${r.failing.map(x => `  ${x}`).join('\n')}` : 'failing: none found', 'last 40 lines:', r.tail, `full log: ${r.file}`].join('\n')
}
