// ONE folder for the full text of every output the mod cut: ~/.lean-agent/output/ (the line-based Bash squeeze of squeeze.ts and the
// character cap of cap.ts both save there). File names start with the time in ms (`<ms>-...`), so pruning is deterministic from the names
// alone: files older than KEEP_DAYS go, then the oldest past MAX_FILES go. Pruned at most once an hour per process, when something is saved.
import { atomicWrite, homeDir, leanDir, mkdirp } from './state'
import type { Host } from './state'

export const KEEP_DAYS = 7
export const MAX_FILES = 400
const PRUNE_EVERY_MS = 3_600_000
export const outputDir = (home: string) => `${leanDir(home)}/output`

let lastPrune = 0
export const resetOutput = (): void => {
  lastPrune = 0
}

// Save `text` as <ms>-<tag>-<random>.txt; returns the path. Throws when it cannot be written (callers then leave the output uncut).
export async function saveOutput(h: Host, tag: string, text: string): Promise<string> {
  const home = await homeDir(h)
  const dir = outputDir(home)
  const now = await h.clock.now()
  const file = `${dir}/${now}-${tag ? `${tag}-` : ''}${Math.random().toString(36).slice(2, 8)}.txt`
  await mkdirp(h, dir)
  await atomicWrite(h, file, text)
  if (now - lastPrune >= PRUNE_EVERY_MS) {
    lastPrune = now
    await pruneOutput(h, now).catch(() => undefined) // best effort: a prune that fails never loses the saved text
  }
  return file
}

// Files whose name starts `<ms>-`: older than KEEP_DAYS, then the oldest beyond MAX_FILES. Returns the names removed.
export async function pruneOutput(h: Host, now: number): Promise<string[]> {
  const dir = outputDir(await homeDir(h))
  const named = (await h.fs.list(dir).catch(() => [] as { name: string }[]))
    .map(e => ({ name: e.name, ts: Number(/^(\d{10,})-/.exec(e.name)?.[1] ?? NaN) }))
    .filter(e => Number.isFinite(e.ts))
    .sort((a, b) => a.ts - b.ts || a.name.localeCompare(b.name))
  const cut = now - KEEP_DAYS * 86_400_000
  const old = named.filter(e => e.ts < cut)
  const rest = named.filter(e => e.ts >= cut)
  const over = rest.slice(0, Math.max(0, rest.length - MAX_FILES))
  const drop = [...old, ...over].map(e => e.name)
  for (let i = 0; i < drop.length; i += 50) await h.process.run(['rm', '-f', ...drop.slice(i, i + 50).map(n => `${dir}/${n}`)])
  return drop
}
