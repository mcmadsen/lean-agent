// Review records (the push gate's input). A record carries an HMAC-SHA256 over project, sha and verdict, keyed with a
// secret that lives ONLY in the mod's own store ($.store, a file outside every project and outside what a session can
// read through the mod's tools): no file a session can read holds the key, so a forged or copied record fails
// verification and no path or glob guard is needed. The writers are the mod tool `lean_review` (delivery.ts) and, for a push the
// user approved in the desk chat, `approve-push` of the desk's lean_thread (threads.ts): a signed, single-use, expiring record.
import { homeDir, leanDir, readJson, writeJson } from './state'
import type { Host } from './state'
import { slugOk } from './rules'

export type Review = { green: boolean; sha: string; project: string; passes?: number; findings?: string[]; ts?: number; sig?: string }
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

// HMAC-SHA256 in plain JS: the hooks sandbox has no crypto.subtle.importKey, and the key never leaves the store
const K = Array.from({ length: 64 }, (_, i) => { let p = 0; for (let n = 2, c = 0; c <= i; n++) if (Array.from({ length: n - 2 }, (_, d) => d + 2).every(d => n % d)) { p = n; c++ } return Math.floor((Math.cbrt(p) % 1) * 2 ** 32) >>> 0 })
export function sha256(m: Uint8Array): Uint8Array {
  const H = [2, 3, 5, 7, 11, 13, 17, 19].map(p => Math.floor((Math.sqrt(p) % 1) * 2 ** 32) >>> 0)
  const len = m.length
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6)
  padded.set(m)
  padded[len] = 0x80
  new DataView(padded.buffer).setUint32(padded.length - 4, (len * 8) >>> 0)
  new DataView(padded.buffer).setUint32(padded.length - 8, Math.floor((len * 8) / 2 ** 32))
  const rot = (x: number, n: number) => (x >>> n) | (x << (32 - n))
  const w = new Uint32Array(64)
  for (let o = 0; o < padded.length; o += 64) {
    const dv = new DataView(padded.buffer, o, 64)
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(i * 4)
    for (let i = 16; i < 64; i++) w[i] = (w[i - 16]! + (rot(w[i - 15]!, 7) ^ rot(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3)) + w[i - 7]! + (rot(w[i - 2]!, 17) ^ rot(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10))) >>> 0
    let [a, b, c, d, e, f, g, h] = H as [number, number, number, number, number, number, number, number]
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) >>> 0
      const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    ;[a, b, c, d, e, f, g, h].forEach((x, i) => (H[i] = (H[i]! + x) >>> 0))
  }
  const out = new Uint8Array(32)
  H.forEach((x, i) => new DataView(out.buffer).setUint32(i * 4, x))
  return out
}
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
  await h.store.set(`approval.used.${exp}.${a.project}.${a.sha}.${a.thread}`, false).catch(() => undefined) // a re-approval starts unused
  return file
}
// Consumption lives in the mod's own store (outside what a session can edit), never in the record: a thread that rewrites the file
// cannot make a used approval valid again. One approval per (project, sha, thread, exp); a re-approval has a new exp.
const usedKey = (r: { project: string; sha: string; thread: string; exp: number }) => `approval.used.${r.exp}.${r.project}.${r.sha}.${r.thread}`
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
