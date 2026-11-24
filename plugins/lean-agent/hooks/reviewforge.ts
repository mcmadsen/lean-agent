// The forge as ground truth for the range of a PR review (1.0.31), and the sanity check that catches a wrong range. Read-only.
//  - forgeFiles: the PR's own changed file list from GitHub (`gh api .../pulls/<n>/files`). When the git range holds more files than the forge
//    lists, the forge list wins: the review is cut to those files and says so. (Azure DevOps: the first-parent rule of reviewext.ts gives the
//    same range as the PR view; no extra read.)
//  - rangeLooksWrong: more changed files than 20x the files the PR's own commits touch, or than config review.maxFiles (default 150).
import type { Host } from './state'
import type { Range } from './reviewprep'

export const FORGE_RE = /^[\w.-]+\/[\w.-]+$/
export const MAX_FILES = 150
export const OWN_FACTOR = 20

export async function forgeFiles(h: Host, forge: string | undefined, pr: number | undefined): Promise<string[] | null> {
  if (!forge || !FORGE_RE.test(forge) || !pr) return null
  const r = await h.process.run(['gh', 'api', `repos/${forge}/pulls/${pr}/files`, '--paginate', '--jq', '.[].filename'], { timeoutMs: 60_000 }).catch(() => null)
  if (!r || r.exitCode !== 0) return null
  const files = r.stdout.split('\n').map(s => s.trim()).filter(Boolean)
  return files.length ? files : null
}

// the commits of the range and the distinct files they touch on their own (merge commits left out)
export async function ownCommits(h: Host, r: Range): Promise<{ commits: number; files: number } | null> {
  const run = async (...a: string[]) => { const x = await h.process.run(['git', '-C', r.path, ...a], { timeoutMs: 30_000 }).catch(() => null); return x && x.exitCode === 0 ? x.stdout : null }
  const count = await run('rev-list', '--count', '--end-of-options', `${r.mb}..${r.head}`)
  const names = await run('log', '--no-merges', '--name-only', '--pretty=format:', '--end-of-options', `${r.mb}..${r.head}`)
  if (count === null || names === null) return null
  return { commits: Number(count.trim()) || 0, files: new Set(names.split('\n').map(s => s.trim()).filter(Boolean)).size }
}

export function rangeLooksWrong(files: number, own: { files: number } | null, maxFiles = MAX_FILES): boolean {
  if (files > maxFiles) return true
  return !!own && files > OWN_FACTOR * Math.max(1, own.files) && files > 20
}
