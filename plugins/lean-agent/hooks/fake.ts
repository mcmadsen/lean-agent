// @ts-nocheck
// A fake host for the specs: an in-memory file system and a scripted process table, answering the engine's
// ops beneath the plugin. Not used by the mod itself.
export type Call = { argv: string[]; cwd?: string; stdin?: string }

export function fakeHost(on: any, opts: { home?: string } = {}) {
  const home = opts.home ?? '/h'
  const files = new Map<string, string>()
  const links = new Map<string, string>()
  const calls: Call[] = []
  const writes: string[] = []
  const git = { handler: (_a: string[], _c: Call): { exitCode: number; stdout: string; stderr?: string } => ({ exitCode: 1, stdout: '' }) }
  const claude = { handler: (_a: string[], _c: Call): { exitCode: number; stdout: string; stderr?: string } => ({ exitCode: 0, stdout: '' }) }
  const res = (p: string) => links.get(p) ?? p
  const dirs = () => {
    const d = new Set<string>(['/'])
    for (const k of [...files.keys(), ...links.values()]) for (let i = k.indexOf('/', 1); i > 0; i = k.indexOf('/', i + 1)) d.add(k.slice(0, i))
    return d
  }

  const store = new Map<string, unknown>()
  const clock = { t: 1_000_000 }
  const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' })
  const impl = {
    env: (name: string) => (name === 'HOME' ? home : undefined),
    read: (path: string) => { const t = files.get(res(path)); if (t === undefined) throw new Error('ENOENT ' + path); return t },
    write: (path: string, text: string) => { writes.push(path); files.set(path, text) },
    exists: (path: string) => files.has(res(path)) || dirs().has(res(path)),
    stat: (path: string) => {
      const p = res(path)
      if (!files.has(p) && !dirs().has(p) && !links.has(path)) throw new Error('ENOENT ' + path)
      return { kind: files.has(p) ? 'file' : 'dir', size: 0, mtimeMs: 0, isLink: links.has(path), realPath: p }
    },
    list: (path: string) => {
      const base = res(path).replace(/\/$/, '') + '/'
      const names = new Map<string, string>()
      for (const k of files.keys()) if (k.startsWith(base)) { const rest = k.slice(base.length); names.set(rest.split('/')[0], rest.includes('/') ? 'dir' : 'file') }
      return [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false }))
    },
    run: (argv: readonly string[], init?: any) => {
      const call: Call = { argv: [...argv], cwd: init?.cwd, stdin: init?.stdin }
      calls.push(call)
      const [c, ...rest] = argv
      const a = c === 'mv' ? rest.filter(y => !y.startsWith('-')) : rest
      if (c === 'mv') { const s = files.get(a[0]); if (s === undefined) { const ks = [...files.keys()].filter(k => k.startsWith(a[0] + '/')); if (!ks.length) return { exitCode: 1, stdout: '', stderr: 'no such file' }; for (const k of ks) { files.set(a[1] + k.slice(a[0].length), files.get(k)!); files.delete(k) } return ok() } files.set(a[1], s); files.delete(a[0]); return ok() }
      if (c === 'rm') { for (const x of a.filter(y => !y.startsWith('-'))) for (const k of [...files.keys()]) if (k === x || k.startsWith(x + '/')) files.delete(k); return ok() }
      if (c === 'mkdir' || c === 'chmod' || c === 'systemctl' || c === 'launchctl') return ok()
      if (c === 'shasum') { let x = 5381; for (const ch of call.stdin ?? '') x = ((x * 33) ^ ch.charCodeAt(0)) >>> 0; return ok(x.toString(16).padStart(8, '0').repeat(8) + '  -') }
      if (c === 'openssl') return ok('ab'.repeat(32))
      if (c === 'id') return ok('501')
      if (c === 'uname') return ok('Darwin')
      if (c === 'wc') { const t = files.get(a[a.length - 1]); return t === undefined ? { exitCode: 1, stdout: '', stderr: 'no such file' } : ok(new TextEncoder().encode(t).length + ' ' + a[a.length - 1]) }
      if (c === 'tee') { const p = a[a.length - 1]; files.set(p, (files.get(p) ?? '') + (call.stdin ?? '')); return ok(call.stdin) }
      if (c === 'claude') { const r = claude.handler(a, call); return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr ?? '' } }
      if (c === 'git') { const r = git.handler(a, call); return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr ?? '' } }
      return { exitCode: 127, stdout: '', stderr: 'unknown ' + c }
    },
  }
  // the mod's helpers take this directly (they never go through the engine)
  const host: any = {
    env: { get: async (n: string) => impl.env(n) },
    fs: { read: async (p: string) => impl.read(p), write: async (p: string, t: string) => impl.write(p, t), exists: async (p: string) => impl.exists(p), list: async (p: string) => impl.list(p), stat: async (p: string) => impl.stat(p) },
    process: { run: async (argv: string[], init?: any) => impl.run(argv, init) },
    clock: { now: async () => clock.t },
    store: { get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => { store.set(k, v) } },
  }
  // and the engine's ops, for specs that go through a registered tool
  if (on) {
    on('env.get', (_: any, e: any) => ({ value: impl.env(e.name) }))
    on('fs.read', (_: any, e: any) => ({ value: impl.read(e.path) }))
    on('fs.write', (_: any, e: any) => { impl.write(e.path, e.text); return { value: undefined } })
    on('fs.exists', (_: any, e: any) => ({ value: impl.exists(e.path) }))
    on('fs.stat', (_: any, e: any) => ({ value: impl.stat(e.path) }))
    on('fs.list', (_: any, e: any) => ({ value: impl.list(e.path) }))
    on('process.run', (_: any, e: any) => ({ value: impl.run(e.argv, e.init) }))
  }
  if (on) on('clock.now', () => ({ value: clock.t }))
  return { host, store, files, links, calls, writes, claude, git, clock, home, claudeCalls: () => calls.filter(c => c.argv[0] === 'claude').map(c => c.argv.slice(1)) }
}

