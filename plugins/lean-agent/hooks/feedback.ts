// LEAN-FEEDBACK: the last line of a worker's reply. `missing` goes to the project's gaps.jsonl (paths it names mark
// areas stale after three), `remember` to memory/notes.jsonl, the status to feedback.jsonl for `stats`. An explorer or
// reader also reports `refused` (commands the guard refused, with its text: they go to refusals.jsonl with the running
// version; the guard's own refusals are written there too, appendRefusal), `unverified` (claims it did not check) and `unreached` (folders it did not cover): counts and the first few
// entries are kept in the feedback row.
import { addGap, pathsIn, slugOk } from './rules'
import { appendJsonl, homeDir, leanDir } from './state'
import { running } from './skew'
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

// The ONE writer of refusals.jsonl (~/.lean-agent/refusals.jsonl). Two kinds of row, told apart by `src`: "guard" is a refusal the
// mod itself saw (register.tsx, every denied tool call: text, agent type, tool, thread, running version); "worker" is a refusal a
// worker REPORTED in its LEAN-FEEDBACK (the command and the text it quotes). The feedback export counts the guard rows as the
// refusals and takes the worker rows for the `refused` texts, so one refusal is never counted twice.
// `what`: WHAT was tried, taken from the ` [tried: ...]` tag the guard's text ends with (orchestrate.ts tried(): a program and subcommand, or a
// tool and the KIND of a path, never an argument or a path) so the next export groups refusals by it.
export type RefusalRow = { src: 'guard' | 'worker'; text: string; agent?: string; tool?: string; thread?: string; version?: string; command?: string; role?: string; rule?: string; kind?: 'refusal' | 'missing-tool'; server?: string; job?: string; what?: string }
export const triedOf = (text: string): string | undefined => /\[tried: ([^\]\n]{1,60})\]/.exec(String(text ?? ''))?.[1]?.trim() || undefined
export async function appendRefusal(h: Host, row: RefusalRow): Promise<void> {
  const home = await homeDir(h)
  const what = row.what ?? triedOf(row.text) // (before the text is cut: the tag may sit at its end)
  const clean = Object.fromEntries(Object.entries({ ts: await h.clock.now(), ...row, text: String(row.text ?? '').slice(0, 300), agent: row.agent?.replace(/^lean-agent:/, ''), what }).filter(([, v]) => v !== undefined))
  await appendJsonl(h, `${leanDir(home)}/refusals.jsonl`, clean)
}

// The ONE entry for every refusal the mod makes (a guard refusal, a refused tool call, a refused action, a trimmed result, a gate): one row,
// one format: role (desk | thread | worker | ...), rule id (refusals.ts ruleOf, or the id the caller gives), short text, running version. It
// lands in refusals.jsonl, which the feedback export lists under "Guard refusals" and `lean_doctor refusals` groups. Never throws.
export type RefusalRec = { role?: string; rule?: string; text: string; tool?: string; agent?: string; thread?: string; version?: string }
export const logRefusal = (h: Host, rec: RefusalRec): Promise<void> =>
  appendRefusal(h, { src: 'guard', kind: 'refusal', ...rec, role: rec.role ?? (rec.agent ? 'worker' : 'session'), rule: rec.rule ?? 'guard', version: rec.version || running.version || undefined }).catch(() => undefined)

// A tool a session or worker needed and did not have (the call failed because it is not available, an MCP server is not connected, a worker
// answered `split:` / `missing:` / `refused:`): one row of kind missing-tool, in the same file. `what` is the tool or the server; grouped
// (with counts) under "Missing tools" in the feedback export and in `lean_doctor refusals`.
export type MissingRec = { role: string; what: string; job?: string; text?: string; thread?: string; agent?: string; version?: string }
export const logMissingTool = (h: Host, rec: MissingRec): Promise<void> =>
  appendRefusal(h, { src: 'guard', kind: 'missing-tool', role: rec.role, tool: rec.what.slice(0, 120), ...(rec.job ? { job: rec.job } : {}), thread: rec.thread, agent: rec.agent, text: rec.text ?? `missing tool: ${rec.what}`, version: rec.version || running.version || undefined }).catch(() => undefined)

export async function applyFeedback(h: Host, ctx: FbCtx, fb0: Feedback): Promise<{ gaps: number; remembered: number }> {
  const fb: Feedback = { ...fb0, refused: fb0.refused ?? [], unverified: fb0.unverified ?? [], unreached: fb0.unreached ?? [] }
  const home = await homeDir(h)
  const ts = await h.clock.now()
  await appendJsonl(h, `${leanDir(home)}/feedback.jsonl`, { ts, thread: ctx.thread, agent: ctx.agent?.replace(/^lean-agent:/, ''), project: ctx.project, status: fb.status, missing: !!fb.missing, version: ctx.version, ...(fb.refused.length ? { refused: fb.refused.length } : {}), ...(fb.unverified.length ? { unverified: fb.unverified.length, unverifiedClaims: fb.unverified.slice(0, 5) } : {}), ...(fb.unreached.length ? { unreached: fb.unreached.length, unreachedFolders: fb.unreached.slice(0, 10) } : {}) })
  for (const r of fb.refused) await appendRefusal(h, { src: 'worker', thread: ctx.thread, agent: ctx.agent, version: ctx.version, command: r.command, text: r.text })
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
