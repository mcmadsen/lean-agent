// 1.0.31: no force-push once a PR has comments. A review is anchored to commits: rewriting the branch orphans every comment, so a forced push (--force, --force-with-lease, +refspec)
// to a branch that has an OPEN PR with comments is refused ("push new commits instead"). The forge is asked read-only (gh pr list / az repos pr list + the PR's threads); when it cannot be
// asked (no CLI, no login, another host, no PR) the push goes on as before. The user can say otherwise: config `pr.checks.force: false`, or push by hand.
import { homeDir, leanDir, readJson } from './state'
import type { Host } from './state'
import { checkOn } from './prvote'

export const isForce = (args: string[]): boolean => {
  const flags = args.filter(a => a.startsWith('-') && a.length > 1)
  const rest = args.filter(a => !a.startsWith('-'))
  return flags.some(f => /^--force(-with-lease|-if-includes)?(=.*)?$/.test(f) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(f)) || rest.slice(1).some(a => a.startsWith('+'))
}
type Forge = { kind: 'github'; repo: string } | { kind: 'azure'; org: string; project: string; repo: string }
export function forgeOf(url: string): Forge | null {
  const u = url.trim()
  const gh = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(u)
  if (gh) return { kind: 'github', repo: gh[1]! }
  const dec = (s: string) => decodeURIComponent(s)
  const az = /^https:\/\/(?:[\w.-]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+?)\/?$/.exec(u) ?? /^(?:git@)?ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+?)\/?$/.exec(u)
  if (az) return { kind: 'azure', org: dec(az[1]!), project: dec(az[2]!), repo: dec(az[3]!) }
  const vs = /^https:\/\/([\w-]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/]+?)\/?$/.exec(u)
  return vs ? { kind: 'azure', org: vs[1]!, project: dec(vs[2]!), repo: dec(vs[3]!) } : null
}
const json = (out: string): unknown => {
  try {
    return JSON.parse(out)
  } catch {
    return null
  }
}
const run = async ($: Host, argv: string[], cwd: string): Promise<unknown> => {
  const r = await $.process.run(argv, { cwd, timeoutMs: 30_000 }).catch(() => null)
  return r && r.exitCode === 0 ? json(r.stdout) : null
}
// the open PR of a branch that has comments: { id, comments } or null (none, or it could not be read)
export async function commentedPr($: Host, dir: string, branch: string): Promise<{ id: number; comments: number } | null> {
  const u = await $.process.run(['git', '-C', dir, 'remote', 'get-url', 'origin']).catch(() => null)
  const forge = u && u.exitCode === 0 ? forgeOf(u.stdout) : null
  if (!forge) return null
  if (forge.kind === 'github') {
    const l = await run($, ['gh', 'pr', 'list', '--repo', forge.repo, '--head', branch, '--state', 'open', '--json', 'number,comments,reviews', '--limit', '1'], dir)
    const pr = Array.isArray(l) ? (l[0] as { number?: unknown; comments?: unknown; reviews?: unknown } | undefined) : undefined
    const n = (Array.isArray(pr?.comments) ? pr.comments.length : 0) + (Array.isArray(pr?.reviews) ? pr.reviews.length : 0)
    return pr && typeof pr.number === 'number' && n > 0 ? { id: pr.number, comments: n } : null
  }
  const scope = ['--organization', `https://dev.azure.com/${encodeURIComponent(forge.org)}`, '--project', forge.project]
  const l = await run($, ['az', 'repos', 'pr', 'list', ...scope, '--repository', forge.repo, '--source-branch', branch, '--status', 'active', '--output', 'json'], dir)
  const id = Array.isArray(l) ? (l[0] as { pullRequestId?: unknown } | undefined)?.pullRequestId : undefined
  if (typeof id !== 'number') return null
  const t = await run($, ['az', 'devops', 'invoke', '--area', 'git', '--resource', 'pullRequestThreads', '--route-parameters', `project=${forge.project}`, `repositoryId=${forge.repo}`, `pullRequestId=${id}`, ...scope.slice(0, 2), '--api-version', '7.1', '--output', 'json'], dir)
  const threads = Array.isArray((t as { value?: unknown } | null)?.value) ? ((t as { value: { isDeleted?: unknown; comments?: { commentType?: unknown; isDeleted?: unknown }[] }[] }).value) : []
  const n = threads.filter(x => !x.isDeleted).reduce((s, x) => s + (x.comments ?? []).filter(c => !c.isDeleted && c.commentType !== 'system').length, 0)
  return n > 0 ? { id, comments: n } : null
}
// the refusal text, or null: the branches a forced push would rewrite, each looked up
export async function forcedPrDenial($: Host, branches: string[], dir: string): Promise<string | null> {
  const cfg = await readJson<unknown>($, `${leanDir(await homeDir($))}/config.json`, null).catch(() => null)
  if (!checkOn(cfg, 'pr', 'force')) return null
  for (const b of branches) {
    const pr = await commentedPr($, dir, b)
    if (pr) return `lean-agent: ${b} has an open PR (#${pr.id}) with ${pr.comments} comment${pr.comments === 1 ? '' : 's'}: the review is anchored to commits: push new commits instead (a force-push would orphan it; if the user really wants it, they push by hand or set config pr.checks.force to false).`
  }
  return null
}
