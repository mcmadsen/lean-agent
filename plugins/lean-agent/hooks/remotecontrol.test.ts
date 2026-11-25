// config threads.remoteControl (1.0.33): auto passes nothing (the user's own Claude Code setting decides), on starts a NEW thread with `--remote-control <session name>`. The CLI exposes no field that says
// a background session registered, so nothing here claims it (README "Remote Control"). A start the CLI refuses names the setting. Synthetic ids only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { leanThread, remoteControlArgv, resetLocks } from './threads'
import { findEntry } from './configkeys'

const SID = '11111111-2222-3333-4444-555555555555'
const ROOT = '/p'
function setup(config: unknown = {}, bg: { exitCode: number; stdout: string; stderr?: string } = { exitCode: 0, stdout: `started ${SID}\n` }) {
  resetLocks()
  const h = fakeHost(null)
  h.files.set('/h/.lean-agent/config.json', JSON.stringify(config))
  h.files.set(`${ROOT}/templates/thread.md`, 'guide')
  h.files.set(`${ROOT}/templates/front-desk.md`, 'desk {{lean}}')
  h.claude.handler = (a: string[]) => (a[0] === '--bg' ? bg : a[0] === 'agents' && a[1] === '--json' ? { exitCode: 0, stdout: '[]' } : { exitCode: 0, stdout: '' })
  return h
}
const started = (h: ReturnType<typeof setup>) => h.claudeCalls().find(a => a[0] === '--bg')!

test('the key is registered: enum auto | on, default auto', () => {
  const e = findEntry('threads.remoteControl')!
  expect(e.default).toBe('auto')
  expect(e.values).toEqual(['auto', 'on'])
})

test('auto (the default): no --remote-control argument; on: --remote-control with the session name', async () => {
  const off = setup()
  expect((await leanThread(off.host, ROOT, { action: 'new', title: 'typo', text: 'fix the typo in a.md' })).ok).toBe(true)
  expect(started(off)).not.toContain('--remote-control')
  const on = setup({ threads: { remoteControl: 'on' } })
  expect((await leanThread(on.host, ROOT, { action: 'new', title: 'typo', text: 'fix the typo in a.md' })).ok).toBe(true)
  const a = started(on)
  const at = a.indexOf('--remote-control')
  expect(at).toBeGreaterThan(0)
  expect(a[at + 1]).toBe(a[a.indexOf('-n') + 1]) // named like the thread's own session
  expect(a[at + 2]!.startsWith('-')).toBe(true) // the next token is a flag: the optional name is exactly the one given
  expect(a.indexOf('--')).toBeGreaterThan(at) // the prompt still follows the bare --
})

test('remoteControlArgv: only the exact value on; flat spelling, junk and a missing key pass nothing', async () => {
  const host = (c: unknown) => setup(c).host
  expect(await remoteControlArgv(host({ threads: { remoteControl: 'on' } }), 't1 · x')).toEqual(['--remote-control', 't1 · x'])
  expect(await remoteControlArgv(host({ 'threads.remoteControl': 'on' }), 'n')).toEqual(['--remote-control', 'n'])
  for (const c of [{}, { threads: { remoteControl: 'auto' } }, { threads: { remoteControl: 'yes' } }, { threads: { remoteControl: true } }]) expect(await remoteControlArgv(host(c), 'n')).toEqual([])
})

test('a start the CLI refuses with the flag on says which setting passed it; with auto the text is the plain failure', async () => {
  const on = setup({ threads: { remoteControl: 'on' } }, { exitCode: 2, stdout: '', stderr: 'error: unknown option' })
  const r = await leanThread(on.host, ROOT, { action: 'new', title: 'typo', text: 'fix the typo in a.md' })
  expect(r.ok).toBe(false)
  expect(r.text).toContain('claude --bg failed: error: unknown option')
  expect(r.text).toContain('threads.remoteControl is on')
  const off = setup({}, { exitCode: 2, stdout: '', stderr: 'error: unknown option' })
  expect((await leanThread(off.host, ROOT, { action: 'new', title: 'typo', text: 'fix the typo in a.md' })).text).not.toContain('remoteControl')
})
