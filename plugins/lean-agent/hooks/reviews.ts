// Review records (the push gate's input). A record carries an HMAC-SHA256 over project, sha and verdict, keyed with a
// secret that lives ONLY in the mod's own store ($.store, a file outside every project and outside what a session can
// read through the mod's tools): no file a session can read holds the key, so a forged or copied record fails
// verification and no path or glob guard is needed. The writers are the mod tool `lean_review` (delivery.ts) and, for a push the
// user approved in the desk chat, `approve-push` of the desk's lean_thread (threads.ts): a signed, single-use, expiring record.
import { homeDir, leanDir, readJson, writeJson } from './state'
import type { Host } from './state'
import { slugOk } from './rules'
import { sha256 } from './sha'

// level / mode / verdicts / counts are display data for the evidence a review thread's report carries (reviewevidence.ts); only project, sha
// and green are signed. mode 'external': a review of someone else's branch or PR (reviewext.ts): never green, never counts for the push gate.
export type Review = { green: boolean; sha: string; project: string; passes?: number; findings?: string[]; base?: string; branch?: string; model?: string; level?: 'light' | 'full'; mode?: 'external'; verdicts?: string[]; counts?: Record<string, number>; areas?: Record<string, { verdict: string; open: number; counts?: Record<string, number>; ts?: number }> /* a PR reviewed by area (reviewarea.ts): one entry per area record */; scoped?: import('./reviewchange').Scoped /* 1.0.31: changed files and lines reviewed, findings dropped outside the change, the lean-agent version the thread ran */; superseded?: { at: number; prepare: string; areas: NonNullable<Review['areas']> }[] /* area records of an earlier prepare that a later prepare replaced: history only, never required (reviewprepared.ts) */; ts?: number; sig?: string }
export const reviewFile = (home: string, project: string, sha: string) => `${leanDir(home)}/${project}/reviews/${sha}.json`
const KEY = 'review.key'
const LEGACY = (home: string) => `${leanDir(home)}/review.key`

const hex = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b as ArrayBuffer), x => x.toString(16).padStart(2, '0')).join('')

async function secret(h: Host, create: boolean): Promise<string> {
  const k = await h.store.get(KEY).catch(() => undefined)
  if (typeof k === 'string' && k.length >= 32) return k
  if (!create) return ''
  const bytes = new Uint8Array(32)
  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') throw new Error('lean-agent: no secure random source, cannot create the review key')
  crypto.getRandomValues(bytes)
  const fresh = hex(bytes)
  await h.store.set(KEY, fresh)
  return fresh
}

// a key file from an older version is readable by sessions: rotate (delete it; every record it signed is void)
async function dropLegacy(h: Host, home: string) {
  if (await h.fs.exists(LEGACY(home)).catch(() => false)) await h.process.run(['rm', '-f', LEGACY(home)]).catch(() => undefined)
}

// HMAC-SHA256 (the sha256 itself is in sha.ts): the key never leaves the store
export { sha256 }
export function hmac(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const k = new Uint8Array(64)
  k.set(key.length > 64 ? sha256(key) : key)
  const cat = (p: number, x: Uint8Array) => { const o = new Uint8Array(64 + x.length); for (let i = 0; i < 64; i++) o[i] = k[i]! ^ p; o.set(x, 64); return o }
  return sha256(cat(0x5c, sha256(cat(0x36, msg))))
}
async function sign(key: string, project: string, sha: string, green: boolean): Promise<string> {
  const enc = new TextEncoder()
  return hex(hmac(enc.encode(key), enc.encode(`${project}\n${sha}\n${green}`)))
}

// A MAC over a caller's own message with the same store key (the first line of the message names what it is for, so a signature of one
// kind is never valid for another): the model approvals (expensive.ts) are signed with it. '' = no key yet and none to be created.
export async function macOf(h: Host, message: string, create: boolean): Promise<string> {
  const key = await secret(h, create)
  if (!key) return ''
  const enc = new TextEncoder()
  return hex(hmac(enc.encode(key), enc.encode(message)))
}

export async function writeReview(h: Host, r: Review): Promise<string> {
  if (!/^[0-9a-f]{7,64}$/.test(r.sha)) throw new Error('review needs a full commit sha')
  if (!slugOk(r.project)) throw new Error('review needs a project name')
  const home = await homeDir(h)
  await dropLegacy(h, home)
  const key = await secret(h, true)
  const green = r.green === true
  const sig = await sign(key, r.project, r.sha, green)
  const file = reviewFile(home, r.project, r.sha)
  await writeJson(h, file, { ...r, green, ts: await h.clock.now(), sig })
  return file
}

// the record of a sha when its HMAC matches its own green flag (a forged or hand-edited green/not-green flag is no record), else null
export async function readReview(h: Host, project: string, sha: string): Promise<Review | null> {
  if (!/^[0-9a-f]{7,64}$/.test(sha) || !slugOk(project)) return null
  const rec = await readJson<Partial<Review> | null>(h, reviewFile(await homeDir(h), project, sha), null)
  if (!rec || typeof rec.sig !== 'string' || !rec.sig || rec.sha !== sha || rec.project !== project) return null
  const key = await secret(h, false)
  if (!key) return null
  const want = await sign(key, project, sha, rec.green === true)
  return rec.sig === want ? (rec as Review) : null
}

// true only for a green record whose HMAC matches
export async function greenReview(h: Host, project: string, sha: string): Promise<boolean> {
  const home = await homeDir(h)
  const rec = await readJson<Partial<Review> | null>(h, reviewFile(home, project, sha), null)
  if (!rec || rec.green !== true || typeof rec.sig !== 'string' || !rec.sig) return false
  const key = await secret(h, false)
  if (!key) return false
  const want = await sign(key, project, sha, true)
  return rec.sig.length === want.length && rec.sig === want
}

// ---- push approval: the user's yes for ONE sha, given in the desk (a thread has no tool that writes it) ----------------
export const APPROVAL_TTL_MS = 2 * 60 * 60 * 1000
export type Approval = { project: string; sha: string; thread: string; reason?: string; ts: number; exp: number; sig: string }
export const approvalFile = (home: string, project: string, sha: string) => `${leanDir(home)}/${project}/approvals/${sha}.json`
const signApproval = async (key: string, project: string, sha: string, thread: string, exp: number): Promise<string> => {
  const enc = new TextEncoder()
  return hex(hmac(enc.encode(key), enc.encode(`approve-push\n${project}\n${sha}\n${thread}\n${exp}`)))
}
export async function writeApproval(h: Host, a: { project: string; sha: string; thread: string; reason?: string }): Promise<string> {
  if (!/^[0-9a-f]{40,64}$/.test(a.sha)) throw new Error('approve-push needs the full commit sha (git rev-parse <ref>)')
  if (!slugOk(a.project)) throw new Error('approve-push needs a project name')
  if (!/^t\d+$/.test(a.thread)) throw new Error('approve-push needs a thread id')
  const home = await homeDir(h)
  const key = await secret(h, true)
  const ts = await h.clock.now()
  const exp = ts + APPROVAL_TTL_MS
  const file = approvalFile(home, a.project, a.sha)
  await writeJson(h, file, { ...a, ts, exp, sig: await signApproval(key, a.project, a.sha, a.thread, exp) } satisfies Approval)
  await h.store.set(`approval.used.${exp}.${a.project}.${a.sha}.${a.thread}`, false) // a re-approval starts unused (a failure surfaces: no approval is reported that could never be used)
  return file
}
// Consumption lives in the mod's own store (outside what a session can edit), never in the record: a thread that rewrites the file
// cannot make a used approval valid again. One approval per (project, sha, thread, exp); a re-approval has a new exp.
const usedKey = (r: { project: string; sha: string; thread: string; exp: number }) => `approval.used.${r.exp}.${r.project}.${r.sha}.${r.thread}`
// (in one process: each session has its own mod, so two sessions could both read `unused`; an approval is bound to one thread, which keeps that window narrow)
let gate: Promise<unknown> = Promise.resolve()
const exclusive = <T>(f: () => Promise<T>): Promise<T> => { const r = gate.then(f, f); gate = r.catch(() => undefined); return r }
async function validApproval(h: Host, project: string, sha: string, thread: string): Promise<Approval | null> {
  const home = await homeDir(h)
  const rec = await readJson<Partial<Approval> | null>(h, approvalFile(home, project, sha), null)
  if (!rec || typeof rec.sig !== 'string' || typeof rec.exp !== 'number' || rec.project !== project || rec.sha !== sha || rec.thread !== thread || !thread) return null
  if ((await h.clock.now()) > rec.exp) return null
  const key = await secret(h, false)
  if (!key || rec.sig !== (await signApproval(key, project, sha, thread, rec.exp))) return null
  if ((await h.store.get(usedKey(rec as Approval)).catch(() => true)) !== false) return null // used, unknown or unreadable: not valid
  return rec as Approval
}
// peek: is there an unused, valid approval (nothing is consumed)
export const hasApproval = (h: Host, project: string, sha: string, thread: string): Promise<boolean> => validApproval(h, project, sha, thread).then(r => !!r)
// take: consume it, once, atomically
export const takeApproval = (h: Host, project: string, sha: string, thread: string): Promise<boolean> =>
  exclusive(async () => {
    const rec = await validApproval(h, project, sha, thread)
    if (!rec) return false
    await h.store.set(usedKey(rec), true)
    return true
  })
