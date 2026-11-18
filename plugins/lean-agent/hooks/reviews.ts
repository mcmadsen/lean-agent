// Review records (the push gate's input). A record is signed with a per-install secret (~/.lean-agent/review.key)
// that only the mod reads: threads can write files, but the guard denies every Write/Edit/Bash/Read that touches
// the reviews folder or the key, and a record without a valid signature is not trusted. The only writer is the mod
// tool `lean_review` (delivery.ts), which calls writeReview.
import { homeDir, leanDir, readJson, writeJson, atomicWrite } from './state'
import type { Host } from './state'
import { slugOk } from './rules'

export type Review = { green: boolean; sha: string; project: string; passes?: number; findings?: string[]; ts?: number; sig?: string }
export const keyFile = (home: string) => `${leanDir(home)}/review.key`
export const reviewFile = (home: string, project: string, sha: string) => `${leanDir(home)}/${project}/reviews/${sha}.json`

async function secret(h: Host, home: string, create: boolean): Promise<string> {
  try {
    const t = await h.fs.read(keyFile(home))
    if (typeof t === 'string' && t.trim().length >= 32) return t.trim()
  } catch {
    /* none yet */
  }
  if (!create) return ''
  const r = await h.process.run(['openssl', 'rand', '-hex', '32']).catch(() => null)
  let k = r && r.exitCode === 0 ? r.stdout.trim() : ''
  if (k.length < 32) k = Array.from({ length: 4 }, () => Math.random().toString(16).slice(2).padEnd(16, '0')).join('')
  await atomicWrite(h, keyFile(home), k + '\n')
  await h.process.run(['chmod', '600', keyFile(home)]).catch(() => undefined)
  return k
}

async function sign(h: Host, key: string, project: string, sha: string, green: boolean): Promise<string> {
  const r = await h.process.run(['shasum', '-a', '256'], { stdin: `${key}\n${project}\n${sha}\n${green}\n` })
  return r.exitCode === 0 ? r.stdout.trim().split(/\s+/)[0] ?? '' : ''
}

export async function writeReview(h: Host, r: Review): Promise<string> {
  if (!/^[0-9a-f]{7,64}$/.test(r.sha)) throw new Error('review needs a full commit sha')
  if (!slugOk(r.project)) throw new Error('review needs a project name')
  const home = await homeDir(h)
  const key = await secret(h, home, true)
  const green = r.green === true
  const sig = await sign(h, key, r.project, r.sha, green)
  if (!sig) throw new Error('cannot sign the review (shasum failed)')
  const file = reviewFile(home, r.project, r.sha)
  await writeJson(h, file, { ...r, green, ts: await h.clock.now(), sig })
  return file
}

// true only for a green record whose signature matches
export async function greenReview(h: Host, project: string, sha: string): Promise<boolean> {
  const home = await homeDir(h)
  const rec = await readJson<Partial<Review> | null>(h, reviewFile(home, project, sha), null)
  if (!rec || rec.green !== true || typeof rec.sig !== 'string' || !rec.sig) return false
  const key = await secret(h, home, false)
  if (!key) return false
  return rec.sig === (await sign(h, key, project, sha, true))
}
