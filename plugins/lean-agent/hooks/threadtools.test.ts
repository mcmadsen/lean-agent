// The built-in tool list of a thread session (orchestrate.ts threadToolsArgv, threads.ts start / resume) and the measured base (base.ts).
// Synthetic ids, names and paths only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { leanThread, resetLocks } from './threads'
import { resetFinish } from './finish'
import { resetThreadCache } from './threaddetail'
import { threadToolsArgv } from './orchestrate'
import { baseLine, noteBase, readBase, resetBase } from './base'
import { overheadReport } from './overhead'

const SID = '11111111-2222-3333-4444-555555555555'
const NEW = '99999999-8888-7777-6666-555555555555'
const ROOT = '/p'
const L = '/h/.lean-agent'
const T1 = `${L}/threads/t1`

function setup(config: unknown, orchestrate = true) {
  resetLocks()
  resetFinish()
  resetThreadCache()
  resetBase()
  const h = fakeHost(null, { orchestrate })
  h.clock.t = 10_000_000
  h.files.set(`${ROOT}/templates/thread.md`, '# {{id}} {{title}}')
  h.files.set(`${ROOT}/templates/front-desk.md`, 'desk {{lean}}')
  h.files.set(`${T1}/thread.json`, JSON.stringify({ id: 't1', title: 'fix login', project: 'app', state: 'open', sid: SID, created: 1, lastWake: 0, delivered: 0, model: 'sonnet', effort: 'medium' }))
  h.files.set(`${T1}/brief.md`, 'fix the login bug\n')
  h.files.set(`${T1}/inbox.jsonl`, JSON.stringify({ ts: 9_990_000, text: 'one more thing' }) + '\n')
  if (config !== undefined) h.files.set(`${L}/config.json`, JSON.stringify(config))
  const rows = [{ sessionId: SID, name: 't1 · fix login', cwd: T1, status: 'idle', startedAt: 1, pid: 42, id: 'abcd1234' }]
  h.claude.handler = (a: string[]) => {
    if (a[0] === 'stop') for (const r of rows) r.pid = 0 // the process is gone after a stop
    return a[0] === '--bg' ? { exitCode: 0, stdout: `started ${NEW}\n` } : a[0] === 'agents' && a[1] === '--json' ? { exitCode: 0, stdout: JSON.stringify(rows) } : { exitCode: 0, stdout: '' }
  }
  return h
}
const bg = (h: any) => h.claudeCalls().filter((x: string[]) => x[0] === '--bg')

test('no threads.tools: the default list (what an orchestrating thread and its workers need) is passed with --tools', async () => {
  const h = setup({})
  await leanThread(h.host, ROOT, { action: 'auto-restart', tN: 't1', reason: 'context' })
  expect(bg(h)).toHaveLength(1)
  const argv = bg(h)[0]
  expect(argv[argv.indexOf('--tools') + 1]).toBe('Agent,Bash,Read,Edit,Write,Grep,Glob,Skill,SendMessage,TaskStop,ToolSearch,WebFetch,WebSearch')
  expect(argv.indexOf('--tools')).toBeLessThan(argv.indexOf('--'))
})

test('threads.tools: the list goes before the `--` and the prompt on a fresh start, an auto restart and a resume', async () => {
  const cfg = { threads: { tools: ['Agent', 'Bash', 'Read', 'Skill', 'SendMessage', 'TaskStop', 'Edit', 'Write', 'Grep', 'Glob'] } }
  const h = setup(cfg)
  await leanThread(h.host, ROOT, { action: 'auto-restart', tN: 't1', reason: 'context' })
  const start = bg(h)[0]!
  const i = start.indexOf('--tools')
  expect(start[i + 1]).toBe('Agent,Bash,Read,Skill,SendMessage,TaskStop,Edit,Write,Grep,Glob')
  expect(i).toBeLessThan(start.indexOf('--')) // before the prompt: the flag is variadic
  expect(start.slice(start.indexOf('--') + 1)).toHaveLength(1) // only the prompt follows
  const w = setup(cfg)
  const r = await leanThread(w.host, ROOT, { action: 'wake', tN: 't1' })
  expect(r.ok).toBe(true)
  const resume = bg(w).find((x: string[]) => x.includes('--resume'))!
  expect(resume[resume.indexOf('--tools') + 1]).toBe('Agent,Bash,Read,Skill,SendMessage,TaskStop,Edit,Write,Grep,Glob')
  expect(resume.indexOf('--tools')).toBeLessThan(resume.indexOf('--'))
})

test('threads.tools: junk is dropped, an empty list is no flag, and lean.orchestrate false uses the full set', async () => {
  expect(await threadToolsArgv(setup({ threads: { tools: ['Read', 'Read', 'Bash; rm', '', 5, 'Agent'] } }).host)).toEqual(['--tools', 'Read,Agent'])
  expect(await threadToolsArgv(setup({ threads: { tools: [] } }).host)).toEqual([])
  expect(await threadToolsArgv(setup({ threads: { tools: 'Read' } }).host)).toEqual([])
  expect(await threadToolsArgv(setup({ threads: { tools: ['Read'] } }, false).host)).toEqual([]) // orchestrate off (the spec host default)
  expect(await threadToolsArgv(setup({ lean: { orchestrate: false }, threads: { tools: ['Read'] } }).host)).toEqual([])
})

test('the measured base: written once per session from the first request, shown by lean_doctor overhead and the start reply', async () => {
  const h = setup({})
  expect(await noteBase(h.host, 't1', SID, { input_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 47_130 }, '')).toBe(true)
  expect(await noteBase(h.host, 't1', SID, { input_tokens: 3, cache_read_input_tokens: 60_000 }, '')).toBe(false) // later requests do not change it
  const b = (await readBase(h.host))!
  expect(b).toMatchObject({ tokens: 47_133, thread: 't1' })
  // no breakdown yet: the number is the first request (fixed parts + first prompt), never "base" or "before any work"
  expect(baseLine(b)).toBe('first request 47.1k tokens (fixed parts + the first prompt; no breakdown recorded yet) (full built-in tool set; config threads.tools can cut it)')
  expect(await overheadReport(h.host, ROOT, { home: '/h', transcript: [] })).toContain('newest thread session measured by the mod: first request 47.1k tokens')
  const r = await leanThread(h.host, ROOT, { action: 'auto-restart', tN: 't1', reason: 'context' })
  expect(r.text).toContain('first request 47.1k tokens')
  expect(r.text).not.toContain('before any work')
})
