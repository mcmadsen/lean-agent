import type { Host } from './state'

type Run = (argv: readonly string[], init?: any) => Promise<any>

// Every process the mod runs has a folder that exists. `$.process.run` defaults its cwd to the SESSION's folder, and a thread that cd'ed
// into a worktree that was removed (or whose folder vanished) makes EVERY spawn fail before the command starts ("posix_spawn 'mkdir'
// ENOENT": Node names the command, not the folder). So: no cwd given = the user's home; a cwd that was given (a repo, a thread folder) is
// checked first and answered as a failed run that says "folder <x> is gone", never a spawn error.
export function safeRun(run: Run, home: () => Promise<string | undefined>, exists: (p: string) => Promise<boolean>): Run {
  return async (argv, init) => {
    const cwd = init?.cwd
    if (typeof cwd === 'string' && cwd) {
      if (!(await Promise.resolve(exists(cwd)).catch(() => true))) return { exitCode: 1, stdout: '', stderr: `folder ${cwd} is gone` } // (a failing check lets the spawn decide)
      return run(argv, init)
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
    clock: { now: () => $.clock.now() },
    store: { get: (k: string) => $.store.get(k), set: (k: string, v: unknown) => $.store.set(k, v) },
  }
}
