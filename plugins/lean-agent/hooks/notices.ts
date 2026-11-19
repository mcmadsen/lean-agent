// Notices for the user, one file per key under ~/.lean-agent/notices/: the desk pane lists them as errors, a thread's
// status line counts them. Best effort: a notice that cannot be written must never break the caller.
import { homeDir, leanDir, mkdirp } from './state'
import type { Host } from './state'

const dirOf = (home: string) => `${leanDir(home)}/notices`

export async function setNotice(h: Host, key: string, text: string | null): Promise<void> {
  try {
    const f = `${dirOf(await homeDir(h))}/${key.replace(/[^\w.-]/g, '_')}.txt`
    if (text === null) {
      if (await h.fs.exists(f)) await h.process.run(['rm', '-f', f])
      return
    }
    await mkdirp(h, dirOf(await homeDir(h)))
    await h.fs.write(f, text.slice(0, 300) + '\n')
  } catch {
    /* best effort */
  }
}

// The text of one notice, and the notice is removed (what the desk is told once: another session may have written it)
export async function takeNotice(h: Host, key: string): Promise<string | null> {
  try {
    const f = `${dirOf(await homeDir(h))}/${key.replace(/[^\w.-]/g, '_')}.txt`
    const t = await h.fs.read(f).catch(() => '')
    if (typeof t !== 'string' || !t.trim()) return null
    await h.process.run(['rm', '-f', f])
    return t.trim()
  } catch {
    return null
  }
}

// The text of one notice, left where it is
export async function peekNotice(h: Host, key: string): Promise<string | null> {
  try {
    const t = await h.fs.read(`${dirOf(await homeDir(h))}/${key.replace(/[^\w.-]/g, '_')}.txt`).catch(() => '')
    return typeof t === 'string' && t.trim() ? t.trim() : null
  } catch {
    return null
  }
}

export async function readNotices(h: Host): Promise<string[]> {
  try {
    const d = dirOf(await homeDir(h))
    const out: string[] = []
    for (const e of await h.fs.list(d).catch(() => [])) {
      if (e.kind === 'dir' || !e.name.endsWith('.txt')) continue
      const t = await h.fs.read(`${d}/${e.name}`).catch(() => '')
      if (typeof t === 'string' && t.trim()) out.push(t.trim())
    }
    return out
  } catch {
    return []
  }
}
