// lean_run (execution model): a test / build command runs with its whole output in a file; the thread gets the exit code, the failing
// test names and the last 40 lines, never the stream. Computed by script, no model reads the log.
import { dirOf, leanDir, mkdirp } from './state'
import type { Host } from './state'
import { analyze } from './shell'

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
  const r = await h.process.run(['bash', '-c', run])
  let log = ''
  try {
    log = String((await h.fs.read(file)) ?? '')
  } catch {
    log = r.stdout + r.stderr
  }
  return { exit: r.exitCode, ...summarize(log), file }
}

export function runText(r: RunResult): string {
  return [`exit ${r.exit}`, r.failing.length ? `failing:\n${r.failing.map(x => `  ${x}`).join('\n')}` : 'failing: none found', 'last 40 lines:', r.tail, `full log: ${r.file}`].join('\n')
}
