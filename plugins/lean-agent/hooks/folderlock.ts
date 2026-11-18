// A cross-process lock by folder: threads and the desk are separate processes sharing ~/.lean-agent, so a read-modify-write of a shared
// file (the script store, a project's rule files) holds a lock folder (`mkdir` is atomic) whose `at` file holds the holder's token
// (time:random). In this process the holders also queue per lock path, so they never spin on the folder. A lock older than a minute,
// or one that never got its token (a holder that died between mkdir and write: after ~4 s), is taken over by MOVING it aside (`mv` is
// atomic: one taker wins, the others retry mkdir), and a holder releases only a lock that still carries its own token. A lock left
// behind by a crash therefore blocks for at most a minute.
import { mkdirp } from './state'
import type { Host } from './state'

export const LOCK_STALE_MS = 60_000
const chains = new Map<string, Promise<unknown>>()

async function hold<T>(h: Host, lock: string, f: () => Promise<T>): Promise<T> {
  await mkdirp(h, lock.replace(/\/[^/]+$/, ''))
  const token = `${await h.clock.now()}:${Math.floor(Math.random() * 1e9).toString(36)}`
  let got = false
  for (let n = 0; n < 25 && !got; n++) {
    got = (await h.process.run(['mkdir', lock])).exitCode === 0
    if (got) break
    const raw = String(await h.fs.read(`${lock}/at`).catch(() => ''))
    const at = Number(raw.split(':')[0]) || 0
    if (at ? (await h.clock.now()) - at > LOCK_STALE_MS : n >= 20) {
      // look again right before moving: another waiter may already have taken the dead lock over and a new holder written its own
      // token meanwhile; moving that one would break a live lock
      if (String(await h.fs.read(`${lock}/at`).catch(() => '')) !== raw) continue
      const aside = `${lock}.stale-${token.replace(':', '-')}`
      await h.process.run(['mv', lock, aside])
      await h.process.run(['rm', '-rf', aside])
    } else await h.process.run(['sleep', '0.2'])
  }
  if (!got) throw new Error('the store is busy: try again')
  try {
    await h.fs.write(`${lock}/at`, token)
    return await f()
  } finally {
    const mine = String(await h.fs.read(`${lock}/at`).catch(() => '')) === token
    if (mine) await h.process.run(['rm', '-rf', lock]).catch(() => undefined)
  }
}

export function withFolderLock<T>(h: Host, lock: string, f: () => Promise<T>): Promise<T> {
  const prev = chains.get(lock) ?? Promise.resolve()
  const run = prev.then(() => hold(h, lock, f), () => hold(h, lock, f))
  chains.set(lock, run.catch(() => undefined))
  return run
}
export const resetFolderLocks = () => chains.clear()
