// lean_run's reply without noise (1.0.27): for jest / vitest / mocha / node:test / pytest / go test / cargo test / tsc / eslint (and the
// yarn | npm | pnpm wrappers: the runner is recognised by its OUTPUT) the reply is the exit code, the runner's one-line totals, each FAILED
// test with its first error lines (at most 12 lines per failure, at most 5 failures, then "(N more)"), tsc / eslint problems grouped by
// file (first 8); a clean run is ONE line. PASS lines, progress dots, timing and coverage tables and stack frames are dropped. An unknown
// runner keeps the last 15 lines. The whole output stays in the log file the reply names. Pure functions, no model reads the log.
export const MAX_FAILS = 5
export const MAX_FAIL_LINES = 12
export const MAX_PROBLEMS = 8
export const UNKNOWN_TAIL = 15

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const clip = (l: string) => cut(l.replace(/\s+$/, ''), 200)
const frame = (l: string) => /^\s+at\s|^\s*❯\s/.test(l)
// lines of a log that never help: PASS lines, progress dots, coverage / timing table rows
const NOISE = /^\s*(PASS\b|✓|✔|√|ok\s+\d|[.·]+\s*$|[.FEsx]{5,}\s*(\[\s*\d+%\s*\])?\s*$|(Time|Duration|Snapshots|Test Suites|Ran all test suites|Slowest|slowest)\b)|\|.*\||^[-=\s|+]{6,}$/

type Block = { name: string; lines: string[] }
type Problem = { file: string; text: string }
type Digest = { totals: string; fails: Block[]; problems: Problem[] }

// the blocks that start at a `head` line and end at an `end` line or the next head; the same name twice (a runner that repeats its failures
// in a summary) keeps the fuller one; stack frames and repeated lines are dropped
function blocks(lines: string[], head: RegExp, end: RegExp, keep?: (l: string) => boolean): Block[] {
  const map = new Map<string, string[]>()
  const st: { name: string; cur: string[] | null } = { name: '', cur: null }
  const flush = () => {
    if (st.cur && st.name) {
      const old = map.get(st.name)
      if (!old || st.cur.length > old.length) map.set(st.name, st.cur)
    }
    st.cur = null
  }
  for (const l of lines) {
    const m = head.exec(l)
    if (m) {
      flush()
      st.name = cut((m[1] ?? '').trim(), 160)
      st.cur = []
      continue
    }
    if (!st.cur) continue
    if (end.test(l)) {
      flush()
      continue
    }
    if (!l.trim() || frame(l) || (keep && !keep(l))) continue
    const c = clip(l)
    if (st.cur.length < MAX_FAIL_LINES - 1 && st.cur[st.cur.length - 1] !== c) st.cur.push(c)
  }
  flush()
  return [...map].map(([name, ls]) => ({ name, lines: ls }))
}
const last = (re: RegExp, lines: string[]): RegExpExecArray | null => {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = re.exec(lines[i]!)
    if (m) return m
  }
  return null
}

function parse(log: string, lines: string[]): Digest | null {
  const none: Digest = { totals: '', fails: [], problems: [] }
  // jest / vitest
  if (/^\s*Tests:\s/m.test(log) || /^\s*Tests\s+\d.*\(\d+\)/m.test(log)) {
    const jest = lines.some(l => /^\s*● (?!Console)/.test(l))
    return {
      ...none,
      totals: (last(/^\s*(Tests:?\s+.+)$/, lines)?.[1] ?? '').trim(),
      fails: jest
        ? blocks(lines, /^\s*● (?!Console)(.+)$/, /^\s*(PASS|FAIL)\s+\S|^\s*(Test Suites:|Tests:|Snapshots:|Time:|Ran all)/)
        : blocks(lines, /^\s*FAIL\s+(.*>.*)$/, /^\s*(PASS\b|FAIL\s+\S+\s*$|⎯+|Test Files|Tests\s|Duration|Snapshots)/),
    }
  }
  // mocha
  if (/^\s*\d+ (passing|failing)/m.test(log)) {
    const at = lines.findIndex(l => /^\s*\d+ failing/.test(l))
    const totals = lines.filter(l => /^\s*\d+ (passing|failing|pending)/.test(l)).map(l => l.trim().replace(/\s*\(.*\)$/, '')).join(', ')
    return { ...none, totals, fails: at < 0 ? [] : blocks(lines.slice(at + 1), /^\s+\d+\) (.+)$/, /^\u0000$/) }
  }
  // node:test (TAP or the spec reporter)
  if (/^(#|ℹ) (tests|pass|fail) \d+/m.test(log)) {
    const n = (k: string) => last(new RegExp(`^(?:#|ℹ) ${k} (\\d+)`), lines)?.[1]
    return { ...none, totals: ['tests', 'pass', 'fail'].map(k => (n(k) !== undefined ? `${k} ${n(k)}` : '')).filter(Boolean).join(', '), fails: blocks(lines, /^\s*(?:not ok \d+ - |✖ )(?!failing tests)(.+?)(?: \([\d.]+ms\))?$/, /^\s*(ok \d+|✔|#|ℹ)/) }
  }
  // pytest
  if (/^=+ .*\b\d+ (passed|failed|errors?)\b/m.test(log) || /^\d+ (passed|failed|errors?)\b.* in [\d.]+s/m.test(log)) {
    const t = last(/^=*\s*(\d+ (?:failed|passed|errors?|skipped|xfailed|xpassed|warnings?).*?)\s*(?:in [\d.]+s.*?)?\s*=*$/, lines)
    let fails = blocks(lines, /^_{2,} (.+?) _{2,}$/, /^={3,}/, l => /^E\s|^\S+:\d+: /.test(l))
    if (!fails.length) fails = lines.filter(l => /^FAILED /.test(l)).map(l => ({ name: cut(l.slice(7).trim(), 160), lines: [] }))
    return { ...none, totals: (t?.[1] ?? '').trim(), fails }
  }
  // cargo test
  if (/^test result:/m.test(log)) {
    const res = lines.filter(l => /^test result:/.test(l))
    const pick = res.find(l => /FAILED/.test(l)) ?? res[res.length - 1] ?? ''
    return { ...none, totals: pick.replace(/^test result:\s*/, '').replace(/;?\s*finished in .*$/, ''), fails: blocks(lines, /^---- (.+) stdout ----$/, /^(failures:|test result:)/) }
  }
  // go test
  if (/^--- (FAIL|PASS):/m.test(log) || /^(ok|FAIL)\s+\S+\s+(\d|\(cached\)|\[)/m.test(log)) {
    const ok = lines.filter(l => /^ok\s+\S+/.test(l)).length
    const bad = lines.filter(l => /^FAIL\s+\S+\s+(\d|\[)/.test(l)).length
    return { ...none, totals: `go test: ${ok} package(s) ok${bad ? `, ${bad} FAILED` : ''}`, fails: blocks(lines, /^\s*--- FAIL: (\S+)/, /^(--- PASS|FAIL\b|ok\b|PASS\b|=== )/) }
  }
  // tsc
  if (/error TS\d+/.test(log)) {
    const problems: Problem[] = []
    for (const l of lines) {
      const m = /^(.+?)(?:\((\d+),(\d+)\)|:(\d+):(\d+))\s*[:-]\s*error (TS\d+):\s*(.*)$/.exec(l.trim())
      if (m) problems.push({ file: m[1]!, text: `${m[2] ?? m[4]}:${m[3] ?? m[5]} ${m[6]} ${cut(m[7]!, 160)}` })
    }
    const files = new Set(problems.map(p => p.file)).size
    return { ...none, totals: last(/^\s*(Found \d+ errors?.*)$/, lines)?.[1]?.trim() ?? `${problems.length} error(s) in ${files} file(s)`, problems }
  }
  // eslint (stylish)
  if (/^\s+\d+:\d+\s+(error|warning)\s/m.test(log)) {
    const problems: Problem[] = []
    let file = ''
    for (const l of lines) {
      const m = /^\s+(\d+:\d+)\s+(error|warning)\s+(.*?)(?:\s{2,}(\S+))?$/.exec(l)
      if (m) problems.push({ file, text: `${m[1]} ${m[2]} ${cut(m[3]!, 160)}${m[4] ? ` (${m[4]})` : ''}` })
      else if (l.trim() && !/^\s/.test(l) && !/^✖/.test(l)) file = l.trim()
    }
    return { ...none, totals: last(/^\s*(✖ \d+ problems?.*)$/, lines)?.[1]?.trim() ?? `${problems.length} problem(s)`, problems }
  }
  return null
}

const tail = (lines: string[]): string[] => lines.filter(l => !NOISE.test(l)).slice(-UNKNOWN_TAIL).map(l => cut(l.replace(/\s+$/, ''), 300))

// { body: the lines after the exit line; one: true = a clean run, body is one line }
export function digest(log: string, exit: number): { body: string; one: boolean } {
  const lines = log.split('\n')
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop()
  const d = parse(log, lines)
  if (!d) {
    const t = tail(lines)
    return exit === 0 && !t.length ? { body: 'no output', one: true } : { body: t.join('\n'), one: false }
  }
  if (exit === 0) return { body: d.totals || 'clean', one: true }
  const out: string[] = d.totals ? [d.totals] : []
  if (d.fails.length) {
    out.push(`FAILED (${d.fails.length}):`)
    for (const f of d.fails.slice(0, MAX_FAILS)) out.push(f.name, ...f.lines.map(l => `  ${l.trim()}`))
    if (d.fails.length > MAX_FAILS) out.push(`(${d.fails.length - MAX_FAILS} more)`)
  } else if (d.problems.length) {
    let file = '\u0000'
    for (const p of d.problems.slice(0, MAX_PROBLEMS)) {
      if (p.file !== file) out.push(p.file)
      file = p.file
      out.push(`  ${p.text}`)
    }
    if (d.problems.length > MAX_PROBLEMS) out.push(`(${d.problems.length - MAX_PROBLEMS} more)`)
  } else out.push(...tail(lines).filter(l => !d.totals || l.trim() !== d.totals)) // a known runner that failed without a test to name (a crash, a threshold): its last lines
  return { body: out.join('\n'), one: false }
}
