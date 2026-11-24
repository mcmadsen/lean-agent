// Review pre-flight, by script (1.0.31): before any reviewer is started, the prepared file count is compared with the number of files the FORGE lists for the PR
// (GitHub pulls/<n>/files, Azure DevOps iteration changes: anchor.ts forgeFileCount). A range that went wrong (a merge base that is far too old, a
// first-parent walk into main) prepares hundreds of files for a PR of ten; one reviewer pass over that costs real money, four are a day's budget.
// Works with or without the range sanity refusal of reviewprep.ts: this is the independent forge-side check. The PR is the one `ref` names (a number or a URL) or
// the thread's own recorded PR; without a PR (a plain branch) there is nothing to compare and the check says nothing. An unreadable forge never blocks.
import { homeDir, readJson, threadsDir } from './state'
import type { Host } from './state'
import { forgeFileCount } from './anchor'
import type { Anchor, Reader } from './anchor'
import { parseExt } from './reviewext'
import { projectPath } from './reviewprep'
import { parseOrigin } from './prhost'
import { cfgBool, cfgNum } from './budgetcfg'
import { forgeReader } from './forgereader'

type Target = Pick<Anchor, 'host' | 'org' | 'project' | 'repo' | 'pr'>

async function targetOf(h: Host, project: string, thread: string, ref: string): Promise<Target | null> {
  const parsed = ref ? parseExt(ref) : null
  if (parsed && typeof parsed !== 'string' && 'pr' in parsed) {
    const path = await projectPath(h, project)
    const r = path ? await h.process.run(['git', '-C', path, 'remote', 'get-url', 'origin'], { timeoutMs: 15_000 }).catch(() => null) : null
    const o = r && r.exitCode === 0 ? parseOrigin(r.stdout.trim()) : null
    if (!o || o.kind === 'other') return null
    return o.kind === 'github' ? { host: 'github', org: o.owner, project: '', repo: `${o.owner}/${o.repo}`, pr: parsed.pr } : { host: 'azure', org: o.org, project: o.project, repo: o.repo, pr: parsed.pr }
  }
  if (ref || !/^t\d+$/.test(thread)) return null // a branch or a sha names no PR
  const pr = (await readJson<{ pr?: { host?: string; org?: string; project?: string; repo?: string; id?: number } }>(h, `${threadsDir(await homeDir(h))}/${thread}/thread.json`, {}).catch(() => null))?.pr
  if (!pr || typeof pr.id !== 'number' || typeof pr.repo !== 'string' || typeof pr.org !== 'string') return null
  return pr.host === 'github' ? { host: 'github', org: pr.org, project: '', repo: `${pr.org}/${pr.repo}`, pr: pr.id } : { host: 'azure', org: pr.org, project: String(pr.project ?? ''), repo: pr.repo, pr: pr.id }
}

// the pure part: a refusal text, or null
export function mismatch(prepared: number, forge: number, minFiles: number, ratio: number): string | null {
  if (prepared <= Math.max(minFiles, ratio * forge)) return null
  return `prepared ${prepared} files, the forge lists ${forge}: wrong range; not starting reviewers`
}

// null = go on; a string = stop with it (prepare's reply). `reader`: a spec passes canned forge answers.
export async function forgeCountStop(h: Host, project: string, thread: string, ref: string, prepared: number, reader?: Reader): Promise<string | null> {
  if (!(await cfgBool(h, 'review.preflight'))) return null
  const minFiles = (await cfgNum(h, 'review.preflightMinFiles')) ?? 20
  if (prepared <= minFiles) return null // (cheap: no forge read for a small diff)
  const t = await targetOf(h, project, thread, ref).catch(() => null)
  if (!t) return null
  const r = reader ?? forgeReader(h)
  const c = await forgeFileCount(r, t).catch(() => null)
  if (!c || c.truncated) return null // an unreadable or cut-short list proves nothing
  const m = mismatch(prepared, c.files, minFiles, (await cfgNum(h, 'review.preflightRatio')) ?? 3)
  return m ? `prepare: ${m} (PR ${t.pr}; config review.preflight false turns this check off)` : null
}
