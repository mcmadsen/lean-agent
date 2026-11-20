// External review: a ref of someone else's work (a PR number or URL, a branch, a sha) read READ-ONLY. Nothing touches the user's
// working tree or the project's refs: the mod fetches the ref and the base from the project's origin into its own scratch repository
// (a bare repo under the lean-agent folder), resolves both to shas at once, and the review reads that scratch repo with `git -C`.
// The record of such a review has mode "external" and never counts for the push gate (reviewtool.ts says so in its answer).
import type { Host } from './state'
import { homeDir, leanDir, mkdirp } from './state'
import { projectPath, refOk } from './reviewprep'

export type ExtRef = { pr: number } | { ref: string }
export type External = { path: string; base: string; head: string; label: string }

const SHA = /^[0-9a-f]{40,64}$/
// '12', '#12', a PR URL (GitHub .../pull/12, Azure DevOps .../pullrequest/12), a branch or a sha
export function parseExt(raw: string): (ExtRef & { repo?: string }) | string {
  const s = raw.trim()
  if (!s) return 'ref is empty'
  const n = /^#?(\d{1,7})$/.exec(s)
  if (n) return { pr: Number(n[1]) }
  if (/^https?:\/\//i.test(s)) {
    const m = /^https?:\/\/[^/\s]+\/(.+?)\/(?:pull|pullrequest)\/(\d{1,7})(?:[/?#].*)?$/i.exec(s)
    if (!m) return `${JSON.stringify(s.slice(0, 120))} is not a pull request URL (.../pull/<n> or .../pullrequest/<n>)`
    return { pr: Number(m[2]), repo: m[1]!.split('/').pop()!.toLowerCase() }
  }
  if (!refOk(s)) return `${JSON.stringify((s as string).slice(0, 80))} is not a plain ref (PR number or URL, branch, tag or sha)`
  return { ref: s }
}

const repoName = (url: string) => (url.replace(/\/+$/, '').replace(/\.git$/i, '').split(/[/:]/).pop() ?? '').toLowerCase()
const extKey = (project: string) => `review.ext.${project}`

export async function fetchExternal(h: Host, project: string, rawRef: string, baseIn?: string): Promise<External | string> {
  const parsed = parseExt(rawRef)
  if (typeof parsed === 'string') return parsed
  if (baseIn && !refOk(baseIn)) return 'base must be a plain ref (branch, tag or sha)'
  const path = await projectPath(h, project)
  if (!path) return `unknown project ${JSON.stringify(project)}`
  const run = async (argv: string[], ms = 120_000) => { const r = await h.process.run(argv, { timeoutMs: ms }).catch(() => null); return r && r.exitCode === 0 ? r.stdout.trim() : null }
  const url = await run(['git', '-C', path, 'remote', 'get-url', 'origin'], 15_000)
  if (!url) return `${project} has no origin remote to read the review target from`
  if ('repo' in parsed && parsed.repo && parsed.repo !== repoName(url)) return `that URL is for ${parsed.repo}, but the origin of ${project} is ${repoName(url)}: pass the project the URL belongs to`
  const scratch = `${leanDir(await homeDir(h))}/scratch/ext-${project}`
  await mkdirp(h, scratch).catch(() => undefined)
  // refs of THIS call (two reviews of one project at once must not read each other's head)
  const stamp = `${await h.clock.now()}-${Math.random().toString(36).slice(2, 8)}`
  const HEADREF = `refs/ext/head-${stamp}`
  const BASEREF = `refs/ext/base-${stamp}`
  if ((await run(['git', '-C', scratch, 'init', '--bare', '-q'], 15_000)) === null) return `could not prepare the scratch repository ${scratch}`
  const fetch = (src: string, dst: string) => run(['git', '-C', scratch, 'fetch', '--no-tags', '-q', '--force', '--', url, `${src}:${dst}`])
  const sha = async (r: string) => run(['git', '-C', scratch, 'rev-parse', '--verify', '--end-of-options', `${r}^{commit}`], 15_000)
  // the head: a PR's head ref (else its merge ref), a branch, or a sha
  let head: string | null = null
  let label = ''
  if ('pr' in parsed) {
    label = `PR #${parsed.pr}`
    for (const src of [`refs/pull/${parsed.pr}/head`, `refs/pull/${parsed.pr}/merge`]) if ((await fetch(src, HEADREF)) !== null && (head = await sha(HEADREF))) break
  } else if (SHA.test(parsed.ref)) {
    label = `commit ${parsed.ref.slice(0, 10)}`
    if ((await fetch(parsed.ref, HEADREF)) !== null) head = await sha(HEADREF)
  } else {
    label = `branch ${parsed.ref}`
    if ((await fetch(`refs/heads/${parsed.ref}`, HEADREF)) !== null || (await fetch(`refs/tags/${parsed.ref}`, HEADREF)) !== null) head = await sha(HEADREF)
  }
  if (!head) return `cannot read ${label || rawRef} from the origin of ${project} (not there, or git could not reach it): nothing was computed`
  let base: string | null = null
  for (const c of baseIn ? [baseIn] : ['main', 'master', 'develop']) {
    if ((await fetch(`refs/heads/${c}`, BASEREF)) !== null && (base = await sha(BASEREF))) break
  }
  if (!base) return `cannot read the base ${baseIn || '(main, master, develop)'} from the origin of ${project}: pass base`
  return { path: scratch, base, head, label }
}

// what record (mode external) needs to find again: the scratch repo and the base of a prepared head sha (the mod's store; newest 20)
type Entry = { path: string; base: string; label: string; ts: number }
export async function noteExternal(h: Host, project: string, x: External): Promise<void> {
  const v = await h.store.get(extKey(project)).catch(() => undefined)
  const all: Record<string, Entry> = v && typeof v === 'object' && !Array.isArray(v) ? (v as any) : {}
  all[x.head] = { path: x.path, base: x.base, label: x.label, ts: await h.clock.now() }
  const keep = Object.entries(all).sort((a, b) => (b[1]?.ts ?? 0) - (a[1]?.ts ?? 0)).slice(0, 20)
  await h.store.set(extKey(project), Object.fromEntries(keep)).catch(() => undefined)
}
export async function externalOf(h: Host, project: string, sha: string): Promise<External | null> {
  const v = (await h.store.get(extKey(project)).catch(() => undefined)) as Record<string, Entry> | undefined
  const e = v && typeof v === 'object' ? v[sha] : undefined
  return e && typeof e.path === 'string' && typeof e.base === 'string' ? { path: e.path, base: e.base, head: sha, label: String(e.label ?? '') } : null
}
