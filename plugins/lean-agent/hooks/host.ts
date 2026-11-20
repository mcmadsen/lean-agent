import type { Host } from './state'

type Run = (argv: readonly string[], init?: any) => Promise<any>

// Every process the mod runs has a folder that exists. `$.process.run` defaults its cwd to the SESSION's folder, and a thread that cd'ed
// into a worktree that was removed (or whose folder vanished) makes EVERY spawn fail before the command starts ("posix_spawn 'mkdir'
// ENOENT": Node names the command, not the folder). So: no cwd given = the user's home; a cwd that was given (a repo, a thread folder)
// runs as it did, and when that spawn is refused with ENOENT the folder is looked at: gone = the call REJECTS with "folder <x> is gone"
// (a rejection, as the spawn error was, so every caller's catch and `.catch(() => null)` still reads it as "could not run", never as a
// command's own exit code), anything else is rethrown as it was.
export function safeRun(run: Run, home: () => Promise<string | undefined>, exists: (p: string) => Promise<boolean>): Run {
  return async (argv, init) => {
    const cwd = init?.cwd
    if (typeof cwd === 'string' && cwd) {
      try {
        return await run(argv, init)
      } catch (e) {
        const gone = /ENOENT/.test(String((e as Error)?.message ?? e)) && !(await Promise.resolve().then(() => exists(cwd)).catch(() => true))
        if (gone) throw new Error(`folder ${cwd} is gone`)
        throw e
      }
    }
    const h = await home().catch(() => undefined)
    return run(argv, h ? { ...init, cwd: h } : init)
  }
}

// $ is only ever spelled $.noun.event(...): the helpers get this thin host instead of $ itself
export function hostOf($: any): Host {
  return {
    fs: {
      read: (p: string) => $.fs.read(p),
      write: (p: string, t: string) => $.fs.write(p, t),
      exists: (p: string) => $.fs.exists(p),
      list: (p?: string) => $.fs.list(p),
      stat: (p: string, o?: { resolve?: boolean }) => $.fs.stat(p, o?.resolve ? { resolve: true } : undefined),
    },
    process: {
      run: safeRun(
        (argv, init) => $.process.run(argv, init),
        () => $.env.get('HOME'),
        (p: string) => $.fs.exists(p),
      ),
    },
    env: { get: () => $.env.get('HOME') }, // the only variable the mod reads (the engine wants it as a literal)
    clock: { now: () => $.clock.now(), sleep: (ms: number) => Promise.resolve($.clock.sleep(ms)).then(() => undefined) },
    store: { get: (k: string) => $.store.get(k), set: (k: string, v: unknown) => $.store.set(k, v) },
    ui: { open: (pane: { id: string; title?: string }) => $.ui.open(pane) }, // only openThreadPane / openNewThread use it
  }
}
