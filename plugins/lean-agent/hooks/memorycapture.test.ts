// Automatic capture from the user's typed prompts (memorycapture.ts) and the tools over the store (memorytool.ts).
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { readItems, resetMemory } from './memory'
import type { Ctx } from './memory'
import { candidateLines, captureTyped, classify } from './memorycapture'
import { memoryTool, memoryPull, rememberTool } from './memorytool'
import { threadTool } from './delivery'

const L = '/h/.lean-agent'
const DESK: Ctx = { role: 'desk', projects: ['form-finder'] }
const T1: Ctx = { role: 'thread', id: 't1', project: 'form-finder' }
const typed = (text: string, kind = 'composer') => ({ text, origin: { kind } })
const fresh = () => {
  resetMemory()
  const h = fakeHost(null)
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', project: 'form-finder', state: 'open' }))
  return h
}

test('explicit words are stored at once as user-typed, with a one-line notice and the undo', async () => {
  const h = fresh()
  const lines = await captureTyped(h.host, '/h', typed('Thanks. From now on answer in short sentences.'), DESK)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('remembered: From now on answer in short sentences. (undo: lean_memory retire m1)')
  expect(await readItems(h.host, '/h')).toMatchObject([{ id: 'm1', scope: 'global', source: 'user-typed', status: 'active', kind: 'rule' }])
  for (const [n, t] of [['remember', 'remember that tests live in the spec folder'], ['going forward', 'going forward use tabs'], ['dont again', "don't open a PR on a Friday again"], ['never', 'never touch the lockfile by hand']] as const) {
    expect([n, (await captureTyped(h.host, '/h', typed(t), { ...DESK, projects: ['form-finder'] })).length > 0]).toEqual([n, true])
  }
})

test('the desk asks "this thread, this project or always?" only when it cannot tell', async () => {
  const h = fresh()
  const lines = await captureTyped(h.host, '/h', typed('remember that the staging database resets at night'), DESK)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('for this thread, this project or always?')
  expect(await readItems(h.host, '/h')).toHaveLength(0)
  expect(await captureTyped(h.host, '/h', typed('remember that the form finder uses the staging database'), DESK)).toEqual([expect.stringContaining('remembered')])
  expect((await readItems(h.host, '/h'))[0]!.scope).toBe('project:form-finder')
})

test('inside a thread the scope is the thread; the undo goes through the desk', async () => {
  const h = fresh()
  const lines = await captureTyped(h.host, '/h', typed('always keep the plan doc current'), T1)
  expect(lines[0]).toContain('undo: ask the desk to lean_memory retire m1')
  expect((await readItems(h.host, '/h'))[0]!.scope).toBe('thread:t1')
})

test('a soft correction is a candidate, shown once, then confirmed or dropped', async () => {
  const h = fresh()
  expect(await captureTyped(h.host, '/h', typed('No, I said use the staging branch for the form work.'), DESK)).toEqual([]) // nothing said yet
  expect(await readItems(h.host, '/h')).toMatchObject([{ status: 'candidate', kind: 'correction', source: 'user-typed', scope: 'desk' }])
  const once = await candidateLines(h.host, '/h', DESK)
  expect(once).toHaveLength(1)
  expect(once[0]).toContain('memory candidate m1')
  expect(once[0]).toContain('lean_memory confirm m1')
  expect(once[0]).toContain('lean_memory retire m1')
  expect(await candidateLines(h.host, '/h', DESK)).toEqual([]) // once
  expect((await memoryTool(h.host, '/h', { action: 'confirm', id: 'm1' })).ok).toBe(true)
  expect((await readItems(h.host, '/h'))[0]!.status).toBe('active')
})

test('a candidate of one thread is shown in that thread, not in another', async () => {
  const h = fresh()
  await captureTyped(h.host, '/h', typed("that's wrong, the form lives in src"), T1)
  expect(await candidateLines(h.host, '/h', { role: 'thread', id: 't2', project: 'other' })).toEqual([])
  expect(await candidateLines(h.host, '/h', T1)).toHaveLength(1)
})

test('a rule that loosens a safety rule is never auto-captured: a candidate and a clear line', async () => {
  const h = fresh()
  const lines = await captureTyped(h.host, '/h', typed('remember: from now on push without asking'), DESK)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('would loosen a safety rule')
  expect(lines[0]).toContain('/lean-agent:remember')
  expect(await readItems(h.host, '/h')).toMatchObject([{ status: 'candidate', scope: 'global' }])
  expect(await candidateLines(h.host, '/h', DESK)).toEqual([]) // said already: not shown again
  // the user's typed command is the explicit word: stored active
  const cmd = await captureTyped(h.host, '/h', typed('/lean-agent:remember never ask me before you comment on a PR'), DESK)
  expect(cmd[0]).toContain('remembered:')
  expect((await readItems(h.host, '/h')).find(i => i.id === 'm2')).toMatchObject({ status: 'active', scope: 'global' })
})

test('only the user\'s typed words count: other origins, meta prompts and no origin store nothing', async () => {
  const h = fresh()
  for (const e of [typed('always use tabs', 'plugin'), typed('always use tabs', 'scheduled-trigger'), typed('always use tabs', 'peer'), { text: 'always use tabs' }, { text: 'always use tabs', origin: { kind: 'composer' }, isMeta: true }]) expect(await captureTyped(h.host, '/h', e, DESK)).toEqual([])
  expect(await captureTyped(h.host, '/h', typed('always use tabs', 'sdk'), DESK)).toEqual([]) // an sdk turn counts only inside an app
  expect(await captureTyped(h.host, '/h', typed('always use tabs', 'sdk'), DESK, true)).toHaveLength(1)
  expect(await captureTyped(h.host, '/h', typed('always use spaces', 'bridge'), DESK)).toHaveLength(1) // Remote Control
  expect(await readItems(h.host, '/h')).toHaveLength(2)
})

test('questions, narration and other slash commands are not captured', () => {
  expect(classify('do you always run the linter?').explicit).toEqual([])
  expect(classify('I never saw that before.').explicit).toEqual([])
  expect(classify('you always do that').explicit).toEqual([])
  expect(classify('/lean-agent:allow always push to PR 4711').explicit).toEqual([])
  expect(classify('you should always run the linter.').explicit).toEqual(['you should always run the linter.'])
  expect(classify('/lean-agent:remember use tabs').command).toBe('use tabs')
  expect(classify('/remember use tabs').command).toBe('use tabs')
})

test('a secret, a text over 200 characters and a duplicate are said in one line, nothing unsafe is stored', async () => {
  const h = fresh()
  const secret = await captureTyped(h.host, '/h', typed('remember the key is sk-abcdefghijklmnop1234567890'), DESK)
  expect(secret[0]).toContain('looks like a secret')
  expect(secret[0]).not.toContain('sk-abc')
  const long = await captureTyped(h.host, '/h', typed(`always ${'word '.repeat(50)}done`), DESK)
  expect(long[0]).toContain('limit is 200')
  expect(await readItems(h.host, '/h')).toHaveLength(0)
  await captureTyped(h.host, '/h', typed('always run the linter before a commit'), DESK)
  expect((await captureTyped(h.host, '/h', typed('always run the linter before a commit please'), DESK))[0]).toContain('already remembered as m1: updated')
})

test('config memory.autoCapture: false turns the capture off', async () => {
  const h = fresh()
  h.files.set(`${L}/config.json`, JSON.stringify({ memory: { autoCapture: false } }))
  expect(await captureTyped(h.host, '/h', typed('always use tabs'), DESK)).toEqual([])
})

test('the desk tool: add asks for the scope when it cannot tell, edit and retire work; a thread tool is for itself', async () => {
  const h = fresh()
  const ask = await memoryTool(h.host, '/h', { action: 'add', text: 'the staging database resets at night' })
  expect(ask.ok).toBe(false)
  expect(ask.text).toContain('for this thread, this project or always?')
  expect((await memoryTool(h.host, '/h', { action: 'add', text: 'the staging database resets at night', scope: 'project:form-finder', kind: 'fact' })).text).toContain('remembered as m1 (project:form-finder, fact)')
  expect((await memoryTool(h.host, '/h', { action: 'edit', id: 'm1', text: 'the staging database resets at three' })).ok).toBe(true)
  expect(await memoryTool(h.host, '/h', { action: 'list' })).toMatchObject({ ok: true, text: expect.stringContaining('resets at three') })
  expect((await memoryTool(h.host, '/h', { action: 'retire', id: 'm1' })).ok).toBe(true)
  expect((await memoryTool(h.host, '/h', { action: 'zap' })).ok).toBe(false)
  // lean_remember: this thread by default, its project with the legacy field, extended with trigger and output
  const r = await rememberTool(h.host, '/h', 't1', { text: 'keep the plan doc current', trigger: 'after-commit', output: '/h/Downloads/plan.md' })
  expect(r.text).toContain('(thread:t1, rule, after-commit)')
  expect((await rememberTool(h.host, '/h', 't1', { text: 'tests need docker', project: 'form-finder' })).text).toContain('project:form-finder')
  expect((await rememberTool(h.host, '/h', 't1', { text: 'use tabs everywhere', scope: 'global' })).ok).toBe(false)
  expect((await readItems(h.host, '/h')).find(i => i.id === 'm2')).toMatchObject({ output: '~/Downloads/plan.md', trigger: 'after-commit', source: 'thread' })
  expect(await memoryPull(h.host, '/h', 't1', '')).toContain('keep the plan doc current')
  expect(await memoryPull(h.host, '/h', 't1', 'docker')).toContain('tests need docker')
  // the engine's tool entry
  expect((await threadTool(h.host, 't1', 'lean_remember', { text: 'uses pnpm' })).text).toContain('remembered as m4')
})
