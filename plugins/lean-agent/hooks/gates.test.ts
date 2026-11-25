// @ts-nocheck
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { failLines, ownFiles, runGates } from './gates'

const CFG = '/h/.lean-agent/config.json'
const setup = (cfg: any, files: Record<string, string> = {}, git: Record<string, any> = {}) => {
  const h = fakeHost(null)
  if (cfg) h.files.set(CFG, JSON.stringify(cfg))
  for (const [k, v] of Object.entries(files)) h.files.set(k, v)
  const seen: string[] = []
  h.git.handler = a => {
    const key = a.slice(2).join(' ')
    seen.push(key)
    const hit = Object.entries({ 'rev-parse --abbrev-ref HEAD': { exitCode: 0, stdout: 'feat/x\n' }, 'rev-parse --short HEAD': { exitCode: 0, stdout: 'abc123\n' }, ...git }).find(([k]) => key.startsWith(k))
    return hit ? hit[1] : { exitCode: 0, stdout: '' }
  }
  const ran: string[] = []
  const run = (fail: string[] = [], body = 'boom') => async (g: any) => { ran.push(g.name + ':' + g.cmd); return fail.includes(g.name) ? { exit: 2, body } : { exit: 0, body: '' } }
  return { h, seen, ran, run }
}
const pkg = JSON.stringify({ scripts: { typecheck: 'tsc', lint: 'eslint .', test: 'vitest', build: 'x' } })
const dirty = ' M src/a.ts\0?? .env\0?? k.pem\0R  new.ts\0old.ts\0?? .lean-agent/x\0?? deploy/id_rsa\0?? ok.txt\0'

test('configured gates, nested and flat', { timeoutMs: 20_000 }, async () => {
  for (const cfg of [{ gates: { commands: [{ name: 'types', cmd: 'tsc' }, { name: 'bad/name', cmd: 'x' }, { name: 'unit', cmd: 'vitest' }] } }, { 'gates.commands': [{ name: 'types', cmd: 'tsc' }, { name: 'unit', cmd: 'vitest' }] }]) {
    const t = setup(cfg, { '/w/package.json': pkg })
    const r = await runGates(t.h.host, { command: 'gates', cwd: '/w', home: '/h', run: t.run() })
    expect(r.text).toBe('gates: 2 of 2 pass\nok types\nok unit')
    expect(t.ran).toEqual(['types:tsc', 'unit:vitest'])
  }
})

test('auto detect by lockfile', { timeoutMs: 20_000 }, async () => {
  for (const [lock, pm] of [['/w/pnpm-lock.yaml', 'pnpm'], ['/w/yarn.lock', 'yarn'], [null, 'npm']]) {
    const t = setup(null, { '/w/package.json': pkg, ...(lock ? { [lock]: '' } : {}) })
    await runGates(t.h.host, { command: 'gates', cwd: '/w', home: '/h', run: t.run() })
    expect(t.ran).toEqual([`typecheck:${pm} run typecheck`, `lint:${pm} run lint`, `test:${pm} run test`])
  }
  const off = setup({ gates: { auto: false } }, { '/w/package.json': pkg })
  expect((await runGates(off.h.host, { command: 'gates', cwd: '/w', home: '/h', run: off.run() })).text).toContain('none configured')
})

test('none configured', { timeoutMs: 20_000 }, async () => {
  const t = setup(null)
  const r = await runGates(t.h.host, { command: 'gates', cwd: '/w', home: '/h', run: t.run() })
  expect(r.ok).toBe(false)
  expect(r.text).toContain('gates: none configured')
})

test('fail summary and the 20-line cap', { timeoutMs: 20_000 }, async () => {
  const t = setup({ gates: { commands: [{ name: 'a', cmd: 'ca' }, { name: 'b', cmd: 'cb' }] } })
  const body = Array.from({ length: 30 }, (_, i) => `\u001b[31merror TS${1000 + i}\u001b[0m line ${i}`).join('\n') + '\nfine line'
  const r = await runGates(t.h.host, { command: 'gates', cwd: '/w', home: '/h', run: t.run(['b'], body) })
  const lines = r.text.split('\n')
  expect(lines[0]).toBe('gates: 1 of 2 pass')
  expect(lines[1]).toBe('ok a')
  expect(lines[2]).toBe('FAIL b (exit 2): cb')
  expect(lines).toHaveLength(3 + 20)
  expect(r.text).not.toContain('\u001b')
  expect(r.text).not.toContain('fine line')
  expect(failLines('a\nb\nc', 2)).toEqual(['b', 'c'])
})

const green = { gates: { commands: [{ name: 'a', cmd: 'ca' }], commitOnGreen: true } }
const status = { 'status --porcelain -z': { exitCode: 0, stdout: dirty } }

test('commit when green: own files only, no forbidden flags', { timeoutMs: 20_000 }, async () => {
  const t = setup(green, {}, status)
  const r = await runGates(t.h.host, { command: 'gates commit fix the thing', cwd: '/w', home: '/h', run: t.run() })
  expect(r.text).toContain('committed abc123 on feat/x: 3 file(s)')
  expect(t.seen).toContain('add -- src/a.ts new.ts ok.txt')
  expect(t.seen).toContain('commit -m fix the thing -- src/a.ts new.ts ok.txt')
  const all = t.h.calls.map(c => c.argv.join(' ')).join('\n')
  for (const bad of ['--amend', '--no-verify', 'push', ' -c ', 'user.']) expect(all).not.toContain(bad)
})

test('commit refusals', { timeoutMs: 20_000 }, async () => {
  const fail = setup(green, {}, status)
  expect((await runGates(fail.h.host, { command: 'gates commit m', cwd: '/w', home: '/h', run: fail.run(['a']) })).text).toContain('commit skipped: a gate failed')
  expect(fail.seen.some(s => s.startsWith('commit'))).toBe(false)
  const off = setup({ gates: { commands: [{ name: 'a', cmd: 'ca' }] } }, {}, status)
  expect((await runGates(off.h.host, { command: 'gates commit m', cwd: '/w', home: '/h', run: off.run() })).text).toContain('gates.commitOnGreen is off')
  expect(off.seen).toEqual([])
  const nomsg = setup(green, {}, status)
  expect((await runGates(nomsg.h.host, { command: 'gates commit', cwd: '/w', home: '/h', run: nomsg.run() })).text).toContain('give a message')
  expect(nomsg.seen).toEqual([])
  for (const br of ['main', 'master', 'trunk', 'develop', 'dev', 'HEAD']) {
    const d = setup(green, {}, { ...status, 'rev-parse --abbrev-ref HEAD': { exitCode: 0, stdout: br + '\n' } })
    expect((await runGates(d.h.host, { command: 'gates commit m', cwd: '/w', home: '/h', run: d.run() })).text).toContain('commit refused')
    expect(d.seen.some(s => s.startsWith('commit') || s.startsWith('add'))).toBe(false)
  }
  const none = setup(green, {}, { 'status --porcelain -z': { exitCode: 0, stdout: '?? .env\0' } })
  expect((await runGates(none.h.host, { command: 'gates commit m', cwd: '/w', home: '/h', run: none.run() })).text).toContain('no files to commit')
  const bad = setup(green, {}, { ...status, 'commit': { exitCode: 1, stdout: '', stderr: 'hook failed' } })
  expect((await runGates(bad.h.host, { command: 'gates commit m', cwd: '/w', home: '/h', run: bad.run() })).text).toContain('commit failed; nothing amended')
})

test('porcelain parsing', () => {
  expect(ownFiles(dirty)).toEqual(['src/a.ts', 'new.ts', 'ok.txt'])
})

test('the default runner goes through runSummary (bash)', { timeoutMs: 20_000 }, async () => {
  const t = setup({ gates: { commands: [{ name: 'a', cmd: 'echo hi' }] } })
  t.h.exec.handler = () => ({ exitCode: 0, stdout: '', stderr: '' })
  const r = await runGates(t.h.host, { command: 'gates', cwd: '/w', home: '/h' })
  expect(r.text).toBe('gates: 1 of 1 pass\nok a')
  expect(t.h.calls.some(c => c.argv[0] === 'bash' && c.argv[2].includes('echo hi'))).toBe(true)
})
