// 1.0.31: the PR best practices a script can check before a PR is created (no model, nothing sent): the repo's guidelines (prguide.ts), the size of the change, a secrets scan of
// the diff, and whether the commit has a recorded green test run (else the PR is proposed as a draft). Each has a switch: config.json `pr.checks` (false = all off, or {guide|size|draft|secrets: false}).
import { homeDir, leanDir, readJson, threadsDir } from './state'
import type { Host } from './state'
import { checkOn } from './prvote'
import { guideOf, guideText, lintPr } from './prguide'

export const SIZE_LINES = 400
export const SIZE_FILES = 15
export const sizeNote = (files: number, lines: number): string | null => (files > SIZE_FILES || lines > SIZE_LINES ? `large PR: consider splitting; ${files} files / ${lines} lines` : null)
// lockfiles, minified bundles, snapshots and fixtures are not hand-written change
const GENERATED = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock|Gemfile\.lock|composer\.lock)$|\.min\.(js|css)$|\.snap$|(^|\/)(__snapshots__|fixtures|golden)\//
export function numstatTotals(out: string): { files: number; lines: number } {
  let files = 0
  let lines = 0
  for (const row of out.split('\n')) {
    const [a, d, ...p] = row.split('\t')
    const path = p.join('\t')
    if (!path || GENERATED.test(path)) continue
    files++
    lines += (Number(a) || 0) + (Number(d) || 0)
  }
  return { files, lines }
}

// ---- secrets in the added lines of the diff ----------------------------------------------------------------------------------------------------
export type SecretHit = { file: string; line: number; what: string }
const FAKE = /example|changeme|change_me|your[_-]|xxxx|dummy|placeholder|sample|\bfake\b|<|\$\{|\{\{|%\(|\*{3,}/i
const SECRET_PATTERNS: { what: string; re: RegExp; check?: (m: string) => boolean }[] = [
  { what: 'a private key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
  { what: 'an AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { what: 'a GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/ },
  { what: 'a Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { what: 'a Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { what: 'a Stripe live key', re: /\b[sr]k_live_[0-9A-Za-z]{20,}\b/ },
  { what: 'a connection string with a password', re: /\b(?:Server|Data Source|Host)=[^;\n]+;[^\n]*\b(?:Password|Pwd)=[^;\s'"]{3,}/i, check: m => !FAKE.test(m) },
  { what: 'a storage account key', re: /\bAccountKey=[A-Za-z0-9+/=]{40,}/ },
  { what: 'a URL with a password in it', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:[^\s@'"/]{3,}@[^\s'"]+/i, check: m => !FAKE.test(m) && !/:\/\/[^:]+:(password|pass|secret|pwd)@/i.test(m) },
  { what: 'a hard-coded secret', re: /\b(?:api[_-]?key|secret|token|passwd|password|client[_-]?secret)\b["']?\s*[:=]\s*["'][A-Za-z0-9/+_=-]{20,}["']/i, check: m => !FAKE.test(m) },
]
const ALLOW = /lean-agent:\s*allow-secret|pragma:\s*allowlist\s*secret/i
// `git diff -U0` text: only the lines the change ADDS are read; the place is file:line of the new version
export function scanDiff(diff: string): SecretHit[] {
  const hits: SecretHit[] = []
  let file = ''
  let n = 0
  for (const row of diff.replace(/\r\n?/g, '\n').split('\n')) {
    if (row.startsWith('+++ ')) {
      file = row.startsWith('+++ b/') ? row.slice(6) : ''
      continue
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row)
    if (h) {
      n = Number(h[1])
      continue
    }
    if (!file || !row.startsWith('+') || row.startsWith('+++')) continue
    const text = row.slice(1)
    if (!ALLOW.test(text)) for (const p of SECRET_PATTERNS) if (p.re.test(text) && (!p.check || p.check(p.re.exec(text)![0]))) hits.push({ file, line: n, what: p.what })
    n++
  }
  return hits.slice(0, 20)
}

// ---- recorded test runs (lean_run) ------------------------------------------------------------------------------------------------------------
export type RunNote = { ts: number; sha: string; exit: number; line: string }
const runsKey = (thread: string) => `prchecks.runs.${thread}`
const git = async (h: Host, dir: string, ...a: string[]): Promise<string | null> => {
  const r = await h.process.run(['git', '-C', dir, ...a], { timeoutMs: 30_000 }).catch(() => null)
  return r && r.exitCode === 0 ? r.stdout : null
}
// called after every lean_run command: the commit it ran on (when cwd is a checkout), the exit code and the first line of the summary
export async function noteRun(h: Host, thread: string, cwd: string, exit: number, line: string): Promise<void> {
  try {
    const sha = cwd ? ((await git(h, cwd, 'rev-parse', 'HEAD')) ?? '').trim() : ''
    if (!/^[0-9a-f]{40,64}$/.test(sha)) return
    const old = ((await h.store.get(runsKey(thread))) as RunNote[] | null) ?? []
    await h.store.set(runsKey(thread), [...old.filter(r => r && typeof r.sha === 'string').slice(-9), { ts: await h.clock.now(), sha, exit, line: line.replace(/\s+/g, ' ').trim().slice(0, 160) }])
  } catch {
    /* a note that cannot be written never fails the run */
  }
}
export async function greenRun(h: Host, thread: string, sha: string): Promise<RunNote | null> {
  const all = ((await h.store.get(runsKey(thread)).catch(() => null)) as RunNote[] | null) ?? []
  return [...all].reverse().find(r => r && r.sha === sha && r.exit === 0) ?? null
}

// ---- the checks before a PR is created ---------------------------------------------------------------------------------------------------------
export type CreateIn = { dir: string; project: string; thread: string; sha: string; remote: string; base: string; title: string; body: string; draft: boolean | undefined }
export type CreateOut = { ok: false; text: string } | { ok: true; draft: boolean; notes: string[] }
export async function createChecks(h: Host, a: CreateIn): Promise<CreateOut> {
  const cfg = await readJson<unknown>(h, `${leanDir(await homeDir(h))}/config.json`, null).catch(() => null)
  const notes: string[] = []
  const green = await greenRun(h, a.thread, a.sha)
  if (checkOn(cfg, 'pr', 'guide')) {
    const { guide } = await guideOf(h, a.project, a.dir)
    const missing = lintPr(guide, { title: a.title, body: a.body }, { evidence: green?.line })
    if (missing.length) return { ok: false, text: `the PR text does not follow this repo's guidelines, so nothing was pushed (the approval is kept): ${missing.join('; ')}.\n${guideText(guide)}\nFix the title and the description (lean_run {pr-guide: {title, body}} checks them) and report again.` }
  }
  const range = async (...extra: string[]): Promise<string | null> => (await git(h, a.dir, 'diff', ...extra, `${a.remote}/${a.base}...${a.sha}`)) ?? (await git(h, a.dir, 'diff', ...extra, `${a.base}...${a.sha}`))
  if (checkOn(cfg, 'pr', 'size')) {
    const t = numstatTotals((await range('--numstat')) ?? '')
    const n = sizeNote(t.files, t.lines)
    if (n) notes.push(n)
  }
  if (checkOn(cfg, 'pr', 'secrets')) {
    const diff = await range('-U0', '--no-color')
    if (diff === null) notes.push('the diff could not be read: it was not scanned for secrets')
    else {
      const hits = scanDiff(diff)
      if (hits.length) return { ok: false, text: `the diff holds what looks like a secret, so nothing was pushed (the approval is kept): ${hits.map(x => `${x.file}:${x.line} (${x.what})`).join('; ')}. Remove it (and rotate it if it was ever real); a false alarm: put "lean-agent: allow-secret" on that line.` } }
  }
  let draft = a.draft === true
  if (a.draft === undefined && checkOn(cfg, 'pr', 'draft') && !green) {
    draft = true
    notes.push(`opened as a DRAFT: no green test run is recorded for ${a.sha.slice(0, 8)} (lean_run); say draft: false to open it as ready`)
  }
  return { ok: true, draft, notes }
}

// `lean_run {pr-guide: true | {title, body}}`: the repo's guidelines, and the lint of a PR text when one is given (no push, no forge)
export async function runPrGuide(h: Host, thread: string, input: unknown, cwd: unknown): Promise<string> {
  const home = await homeDir(h)
  const t = await readJson<{ project?: string }>(h, `${threadsDir(home)}/${thread}/thread.json`, {}).catch(() => ({}) as { project?: string })
  let dir = typeof cwd === 'string' && cwd.startsWith('/') ? cwd : ''
  if (!dir) {
    const reg = await readJson<Record<string, { path?: unknown; thread?: unknown }>>(h, `${leanDir(home)}/worktrees.json`, {}).catch(() => ({}))
    const mine = Object.values(reg ?? {}).filter(w => w && w.thread === thread && typeof w.path === 'string')
    dir = mine.length ? String(mine[mine.length - 1]!.path) : ''
  }
  if (!dir) throw new Error('pr-guide needs the repository folder: pass cwd (the worktree) or register the worktree first')
  const { guide, cached } = await guideOf(h, t.project || dir, dir)
  const lines = [guideText(guide, cached)]
  const o = input && typeof input === 'object' && !Array.isArray(input) ? (input as { title?: unknown; body?: unknown }) : null
  if (o) {
    const head = ((await git(h, dir, 'rev-parse', 'HEAD')) ?? '').trim()
    const green = head ? await greenRun(h, thread, head) : null
    const missing = lintPr(guide, { title: typeof o.title === 'string' ? o.title : '', body: typeof o.body === 'string' ? o.body : '' }, { evidence: green?.line })
    lines.push(missing.length ? `lint: refused:\n- ${missing.join('\n- ')}` : 'lint: the title and the description follow the guidelines')
  }
  const green = ((await git(h, dir, 'rev-parse', 'HEAD')) ?? '').trim()
  const run = green ? await greenRun(h, thread, green) : null
  lines.push(run ? `last green run on this commit: ${run.line}` : 'no green test run is recorded for this commit: run the tests with lean_run (a PR without one opens as a draft)')
  return lines.join('\n')
}
