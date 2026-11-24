// WHERE THE FEEDBACK EXPORT GOES (1.0.31): config.json `feedback`, nested or flat ("feedback.destination"):
//   destination: "local" (default: ~/.lean-agent/feedback-export only) | "folder" | "github" | "folder+github"
//   folder:      a path, `~` expanded (e.g. "~/Downloads"), used by "folder" and "folder+github"
// The export file is anonymised first; only that text is ever copied or posted. Posting is never automatic (gh-issue-create is a typed desk
// action the user approves, deskactions.ts). Pure reading and path logic here; the copy is `cp -n` by argv, like `lean_thread deliver`.
import { homeDir, realPath, readJson, leanDir } from './state'
import type { Host } from './state'
import { destination, eperm, freeName } from './deliver'
import { DESK_THREAD, FEEDBACK_REPO, addActionRequest } from './deskactions'

export const FEEDBACK_DESTS = ['local', 'folder', 'github', 'folder+github'] as const
export type FeedbackDest = (typeof FEEDBACK_DESTS)[number]
export type FeedbackCfg = { dest: FeedbackDest; folder: string; set: boolean /* config.json has a `feedback` setting */; problems: string[] }

const pick = (cfg: any, key: string): unknown => {
  if (!cfg || typeof cfg !== 'object') return undefined
  if (key in cfg) return cfg[key]
  let v: any = cfg
  for (const p of key.split('.')) v = v && typeof v === 'object' ? v[p] : undefined
  return v
}
export const wantsFolder = (d: FeedbackDest): boolean => d === 'folder' || d === 'folder+github'
export const wantsGithub = (d: FeedbackDest): boolean => d === 'github' || d === 'folder+github'

// the setting, validated: a bad value never stops an export, it falls back to the safe side (local) and is reported as a problem
export async function feedbackConfig(h: Host, home: string): Promise<FeedbackCfg> {
  const cfg = await readJson<any>(h, `${leanDir(home)}/config.json`, {})
  const rawDest = pick(cfg, 'feedback.destination')
  const rawFolder = pick(cfg, 'feedback.folder')
  const problems: string[] = []
  let dest: FeedbackDest = 'local'
  if (rawDest !== undefined) {
    if (typeof rawDest === 'string' && (FEEDBACK_DESTS as readonly string[]).includes(rawDest.trim())) dest = rawDest.trim() as FeedbackDest
    else problems.push(`config.json feedback.destination ${JSON.stringify(rawDest).slice(0, 40)} is not one of ${FEEDBACK_DESTS.join(', ')}: using local (fix: lean_config set feedback.destination <word>)`)
  }
  let folder = ''
  if (rawFolder !== undefined) {
    if (typeof rawFolder === 'string' && rawFolder.trim() && !/[\u0000-\u001f]/.test(rawFolder)) folder = rawFolder.trim()
    else problems.push(`config.json feedback.folder must be a path like ~/Downloads (got ${JSON.stringify(rawFolder).slice(0, 40)}; fix: lean_config set feedback.folder ~/Downloads)`)
  }
  if (wantsFolder(dest) && !folder && !problems.some(p => p.includes('feedback.folder'))) problems.push(`config.json feedback.destination is ${dest} but feedback.folder is not set: exports stay local (fix: lean_config set feedback.folder ~/Downloads)`)
  return { dest, folder, set: rawDest !== undefined || rawFolder !== undefined, problems }
}

// the destination in words: the pane footer, the command text, the doctor row
export const destText = (c: Pick<FeedbackCfg, 'dest' | 'folder'>): string => {
  const f = c.folder || 'the folder (not set)'
  return c.dest === 'local' ? 'exports to ~/.lean-agent/feedback-export' : c.dest === 'folder' ? `exports to ${f}` : c.dest === 'github' ? 'exports, then asks to post to GitHub' : `exports to ${f}, then asks to post to GitHub`
}
// the doctor row: shown once the user set anything or something is wrong (a default install adds no row)
export async function feedbackRow(h: Host): Promise<{ ok: boolean; text: string } | null> {
  const c = await feedbackConfig(h, await homeDir(h))
  if (!c.set && !c.problems.length) return null
  return c.problems.length ? { ok: false, text: `feedback export: ${c.problems.join('; ')}` } : { ok: true, text: `feedback export ${destText(c)}` }
}

// gh installed and logged in? null = ready, else the reason. (`gh auth status` reads; it never writes anything)
export async function ghProblem(h: Host): Promise<string | null> {
  const r = await h.process.run(['gh', 'auth', 'status', '--hostname', 'github.com'], { timeoutMs: 30_000 }).catch(() => null)
  if (!r || r.exitCode === 127) return 'gh is not installed (https://cli.github.com)'
  return r.exitCode === 0 ? null : 'gh is not logged in to github.com (run: gh auth login)'
}

// ONE typed desk request (gh-issue-create) with the exact title and the anonymised body: posting is a remote write to a PUBLIC repo, so it never
// goes out here; the user's Approve (the pane's card, or the desk's question) is bound to the request id and the mod runs `gh issue create`.
export async function offerPost(h: Host, o: { title: string; body: string; fallbackTitle: string }): Promise<{ ok: true; id: string } | { ok: false; why: string }> {
  const why = await ghProblem(h)
  if (why) return { ok: false, why }
  const clean = (t: string) => t.replace(/\s+/g, ' ').replace(/^[^A-Za-z0-9]+/, '').trim().slice(0, 120)
  for (const title of [clean(o.title), o.fallbackTitle]) {
    if (!title) continue
    const r = await addActionRequest(h, DESK_THREAD, { kind: 'gh-issue-create', params: { repo: FEEDBACK_REPO, title, body: o.body }, why: 'feedback export' })
    if (r.ok && r.request) return { ok: true, id: r.request.id }
    if (title === o.fallbackTitle) return { ok: false, why: r.text.slice(0, 200) }
  }
  return { ok: false, why: 'no title' }
}

// copy the anonymised export (already written at `src`) into the configured folder, under `name`, never over an existing file (name-2, name-3 ...)
// { path } on success; { why } is the reason the folder could not be used (the caller then says where the local copy is)
export async function copyToFolder(h: Host, home: string, folder: string, src: string, name: string): Promise<{ path: string } | { why: string }> {
  if (!folder) return { why: 'feedback.folder is not set' }
  const dest = await destination(h, home, folder)
  if (!('folder' in dest)) return { why: `folder ${folder} is refused: ${dest.text}` }
  const real = await realPath(h, dest.folder)
  const st = await h.fs.stat(real).catch(() => null)
  if (!st) return { why: `folder ${folder} does not exist` }
  if (st.kind !== 'dir' && st.kind !== 'directory') return { why: `${folder} is not a folder` }
  const final = await freeName(h, dest.folder, name)
  if (!final) return { why: `${folder} already holds ${name} and 98 numbered copies` }
  const to = `${dest.folder}/${final}`
  const r = await h.process.run(['cp', '-n', '--', src, to], { timeoutMs: 60_000 }).catch((e: unknown) => ({ exitCode: 1, stdout: '', stderr: String((e as Error)?.message ?? e) }))
  if (r.exitCode !== 0) {
    const bad = String(r.stderr ?? '')
    return { why: /operation not permitted|permission denied|EPERM|EACCES/i.test(bad) ? `folder ${folder} is not writable (${eperm(folder)})` : `copy to ${folder} failed: ${bad.trim().slice(0, 120) || `exit ${r.exitCode}`}` }
  }
  return { path: to }
}
