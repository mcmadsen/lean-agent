import type { Host } from './state'

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
    process: { run: (argv: readonly string[], init?: any) => $.process.run(argv, init) },
    env: { get: () => $.env.get('HOME') }, // the only variable the mod reads (the engine wants it as a literal)
    clock: { now: () => $.clock.now() },
  }
}
