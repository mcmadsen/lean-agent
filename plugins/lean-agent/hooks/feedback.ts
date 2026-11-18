// LEAN-FEEDBACK: the last line of a worker's reply. `missing` goes to the project's gaps.jsonl (paths it names mark
// areas stale after three), `remember` to memory/notes.jsonl, the status to feedback.jsonl for `stats`. An explorer or
// reader also reports `refused` (commands the guard refused, with its text: they go to refusals.jsonl with the running
// version), `unverified` (claims it did not check) and `unreached` (folders it did not cover): counts and the first few
// entries are kept in the feedback row.
import { addGap, pathsIn, slugOk } from './rules'
import { appendJsonl, homeDir, leanDir } from './state'
import type { Host } from './state'

export type Refusal = { command: string; text: string }
export type Feedback = { status: string; used: string[]; unneeded: string[]; missing: string; remember: { type?: string; text: string }[]; refused: Refusal[]; unverified: string[]; unreached: string[] }
const STATUS = new Set(['done', 'partial', 'failed'])
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const CAP = 20 // entries kept per list
const clip = (x: string, n = 300) => x.trim().slice(0, n)
// refused: [{command, text}] (a bare string is the command)
const refusals = (v: unknown): Refusal[] =>
  (Array.isArray(v) ? v : [])
    .map((r: any) => (typeof r === 'string' ? { command: clip(r), text: '' } : r && typeof r.command === 'string' ? { command: clip(r.command), text: typeof r.text === 'string' ? clip(r.text) : '' } : null))
    .filter((r): r is Refusal => !!r && !!r.command)
    .slice(0, CAP)
const list = (v: unknown) => strs(v).map(x => clip(x)).filter(Boolean).slice(0, CAP)

export function parseFeedback(text: string): Feedback | null {
  const all = [...String(text ?? '').matchAll(/^\s*`?LEAN-FEEDBACK\s+(\{.*\})`?\s*$/gm)]
  const last = all[all.length - 1]
  if (!last) return null
  let o: any
  try {
    o = JSON.parse(last[1]!)
  } catch {
    return null
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  const remember = (Array.isArray(o.remember) ? o.remember : [])
    .map((r: any) => (typeof r === 'string' ? { text: r } : r && typeof r.text === 'string' ? { type: typeof r.type === 'string' ? r.type : undefined, text: r.text } : null))
    .filter((r: any) => r && r.text.trim())
  return { status: STATUS.has(o.status) ? o.status : 'partial', used: strs(o.used), unneeded: strs(o.unneeded), missing: typeof o.missing === 'string' ? o.missing.trim() : '', remember, refused: refusals(o.refused), unverified: list(o.unverified), unreached: list(o.unreached) }
}

export type FbCtx = { thread?: string; project?: string; agent?: string; version?: string } // version: the lean-agent code that is running

export async function applyFeedback(h: Host, ctx: FbCtx, fb0: Feedback): Promise<{ gaps: number; remembered: number }> {
  const fb: Feedback = { ...fb0, refused: fb0.refused ?? [], unverified: fb0.unverified ?? [], unreached: fb0.unreached ?? [] }
  const home = await homeDir(h)
  const ts = await h.clock.now()
  await appendJsonl(h, `${leanDir(home)}/feedback.jsonl`, { ts, thread: ctx.thread, agent: ctx.agent?.replace(/^lean-agent:/, ''), project: ctx.project, status: fb.status, missing: !!fb.missing, version: ctx.version, ...(fb.refused.length ? { refused: fb.refused.length } : {}), ...(fb.unverified.length ? { unverified: fb.unverified.length, unverifiedClaims: fb.unverified.slice(0, 5) } : {}), ...(fb.unreached.length ? { unreached: fb.unreached.length, unreachedFolders: fb.unreached.slice(0, 10) } : {}) })
  for (const r of fb.refused) await appendJsonl(h, `${leanDir(home)}/refusals.jsonl`, { ts, thread: ctx.thread, agent: ctx.agent?.replace(/^lean-agent:/, ''), version: ctx.version, command: r.command, text: r.text })
  let gaps = 0
  if (fb.missing) {
    const paths = pathsIn(fb.missing)
    if (slugOk(ctx.project)) {
      for (const p of paths.length ? paths : ['']) {
        await addGap(h, ctx.project, p, fb.missing)
        gaps++
      }
    } else {
      await appendJsonl(h, `${leanDir(home)}/gaps.jsonl`, { ts, path: paths[0] ?? '', area: null, text: fb.missing.slice(0, 300) })
      gaps++
    }
  }
  for (const r of fb.remember) await appendJsonl(h, `${leanDir(home)}/memory/notes.jsonl`, { ts, from: ctx.thread ?? 'worker', project: ctx.project ?? '', type: r.type, text: r.text })
  return { gaps, remembered: fb.remember.length }
}
