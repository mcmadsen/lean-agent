// Standing rules of one thread (threadrules.ts) and `lean_doctor memory` (memorydoctor.ts). Synthetic names and numbers.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { leanThread, listLine, resetLocks, unusedField } from './threads'
import { readItems, resetMemory } from './memory'
import { resetMemorySession } from './memoryindex'
import { memorySection } from './extras'
import { memoryDoctor, memoryRow } from './memorydoctor'
import { memoryTool } from './memorytool'

const SID = '11111111-2222-3333-4444-555555555555'
const ROOT = '/p'
const L = '/h/.lean-agent'

function world() {
  resetLocks()
  resetMemory()
  resetMemorySession()
  const h = fakeHost(null)
  h.files.set(`${L}/config.json`, '{"handover":{"mode":"full"}}')
  h.files.set(`${ROOT}/templates/thread.md`, '# {{id}} {{title}}')
  h.files.set(`${ROOT}/templates/front-desk.md`, 'desk {{lean}}')
  h.files.set(`${ROOT}/.claude-plugin/plugin.json`, JSON.stringify({ version: '1.0.5' }))
  const bg: string[][] = []
  const rows: any[] = []
  h.claude.handler = (a: string[]) => {
    if (a[0] === '--bg' && a.includes('--resume')) return { exitCode: 0, stdout: 'resumed\n' }
    if (a[0] === '--bg') { bg.push(a); return { exitCode: 0, stdout: `started ${SID}\n` } }
    if (a[0] === 'agents') return { exitCode: 0, stdout: JSON.stringify(rows) }
    return { exitCode: 0, stdout: '' }
  }
  const call = (i: any) => leanThread(h.host, ROOT, i.action === 'list' ? { verbose: true, ...i } : i)
  return { h, bg, rows, call }
}
const section = (h: any, id: string) => memorySection(h.host, { kind: 'thread', id })

test('new with rules: stored as the thread\'s standing rules, in its session section, counted in list, never in another thread', async () => {
  const { h, call } = world()
  const r = await call({ action: 'new', title: 'form finder', text: 'build the new form finder', rules: ['keep the living plan doc up to date at all times in ~/Downloads', 'never touch the lockfile by hand'] })
  expect(r.ok).toBe(true)
  expect(r.text).toContain('2 standing rules stored for t1')
  const items = (await readItems(h.host, '/h')).filter(i => i.scope === 'thread:t1')
  expect(items).toMatchObject([{ kind: 'rule', status: 'active', source: 'desk' }, { kind: 'rule', status: 'active' }])
  const s = (await section(h, 't1'))!
  expect(s).toContain('keep the living plan doc up to date')
  expect(s).toContain('never touch the lockfile')
  expect([...h.files.keys()].some(k => /CLAUDE\.md/.test(k) && h.files.get(k)!.includes('living plan doc'))).toBe(false) // never in a guide or rule file
  expect((await call({ action: 'list' })).text).toContain('2 rules')
  expect(listLine({ id: 't1', state: 'open', rules: 1 })).toContain('1 rule ·')
  expect(listLine({ id: 't1', state: 'open', rules: 3 })).toContain('3 rules')
  await call({ action: 'new', title: 'billing', text: 'fix the billing report' })
  expect(await section(h, 't2')).toBeNull() // another thread: nothing
  expect((await call({ action: 'list' })).text.split('\n').find(l => l.startsWith('t2'))).not.toContain('rule')
})

test('a rule that is a secret, too long or too many is refused BEFORE the thread exists', async () => {
  const { h, call } = world()
  for (const rules of [['use token: ghp_abcdefghijklmnopqrstuvwxyz0123'], ['x'.repeat(201)], Array.from({ length: 13 }, (_, n) => `rule number ${n}`), 'not a list' as any]) {
    const r = await call({ action: 'new', title: 'a', text: 'b', rules })
    expect([JSON.stringify(rules).slice(0, 30), r.ok]).toEqual([JSON.stringify(rules).slice(0, 30), false])
  }
  expect([...h.files.keys()].some(k => k.includes('/threads/t1/'))).toBe(false)
  expect(await readItems(h.host, '/h')).toHaveLength(0)
})

test('rule tN <text>: adds with a trigger and an output path; on: false takes one or all off; the thread must exist', async () => {
  const { h, call } = world()
  await call({ action: 'new', title: 'form finder', text: 'build it' })
  const a = await call({ action: 'rule', tN: 't1', text: 'keep the living plan doc up to date', trigger: 'after-commit', output: '/h/Downloads/plan.md' })
  expect(a.ok).toBe(true)
  expect(a.text).toContain('t1 has 1 standing rule')
  expect((await readItems(h.host, '/h'))[0]).toMatchObject({ scope: 'thread:t1', kind: 'rule', trigger: 'after-commit', output: '~/Downloads/plan.md' })
  expect((await section(h, 't1'))!).toContain('[after-commit -> ~/Downloads/plan.md]')
  expect((await call({ action: 'rule', tN: 't1', text: 'keep the living plan doc up to date and short' })).text).toContain('already remembered as m1: updated')
  await call({ action: 'rule', tN: 't1', text: 'never push on a friday' })
  expect((await call({ action: 'list' })).text).toContain('2 rules')
  expect((await call({ action: 'rule', tN: 't1', text: 'never push on a friday', on: false })).text).toContain('1 standing rule off (m2)')
  expect((await call({ action: 'rule', tN: 't1', text: 'm9', on: false })).ok).toBe(false)
  expect((await call({ action: 'rule', tN: 't1', on: false })).text).toContain('1 standing rule off (m1)')
  expect((await call({ action: 'list' })).text).not.toContain('rule')
  expect((await call({ action: 'rule', tN: 't9', text: 'x y z' })).text).toContain('no thread t9')
  expect((await call({ action: 'rule', text: 'x y z' })).ok).toBe(false)
  expect((await call({ action: 'rule', tN: 't1' })).ok).toBe(false)
  expect((await call({ action: 'rule', tN: 't1', text: 'push without asking' })).text).toContain('loosen a safety rule') // the user's own command only
  expect(unusedField({ action: 'rule', tN: 't1', text: 'x', title: 'y' })).toContain('does not use the field "title"')
  expect(unusedField({ action: 'rule', tN: 't1', text: 'x', trigger: 'after-step', output: '~/p.md', on: false })).toBeNull()
  expect(unusedField({ action: 'new', title: 't', rules: ['a'], inherit: 't1' })).toBeNull()
})

test('a rule is editable and removable with lean_memory; it survives a restart (the handover carries it) and reaches only its own thread', async () => {
  const { h, bg, rows, call } = world()
  await call({ action: 'new', title: 'form finder', text: 'build it', rules: ['keep the living plan doc up to date'] })
  expect((await memoryTool(h.host, '/h', { action: 'edit', id: 'm1', text: 'keep the living plan doc up to date in ~/Downloads' })).ok).toBe(true)
  await call({ action: 'close', tN: 't1' })
  rows.length = 0
  const r = await call({ action: 'reopen', tN: 't1' })
  expect(r.ok).toBe(true)
  const prompt = bg[bg.length - 1]!.join('\n')
  expect(prompt).toContain('## Standing orders')
  expect(prompt).toContain('keep the living plan doc up to date in ~/Downloads')
  expect((await memoryTool(h.host, '/h', { action: 'retire', id: 'm1' })).ok).toBe(true)
  expect(await section(h, 't1')).toBeNull()
})

test('a follow-on thread inherits the rules ONLY when the user said so', async () => {
  const { h, call } = world()
  await call({ action: 'new', title: 'form finder', text: 'build it', rules: ['keep the living plan doc up to date', 'never touch the lockfile by hand'] })
  const plain = await call({ action: 'new', title: 'follow on', text: 'next part' })
  expect(plain.ok).toBe(true)
  expect(await section(h, 't2')).toBeNull() // no inherit: nothing
  const no = await call({ action: 'new', title: 'follow on 2', text: 'next part', inherit: 't1' })
  expect(no.ok).toBe(false)
  expect(no.text).toContain("needs the user's own words")
  expect([...h.files.keys()].some(k => k.includes('/threads/t3/'))).toBe(false)
  h.store.set('desk.human.prompts', [{ text: 'start the next part with the same rules as t1', ts: h.clock.t }])
  const yes = await call({ action: 'new', title: 'follow on 3', text: 'next part', inherit: 't1' })
  expect(yes.ok).toBe(true)
  expect(yes.text).toContain('2 inherited from t1 (the user asked)')
  const s = (await section(h, 't3'))!
  expect(s).toContain('living plan doc')
  expect(s).toContain('lockfile')
  expect((await readItems(h.host, '/h')).filter(i => i.scope === 'thread:t1')).toHaveLength(2) // the original keeps its own
  expect(await section(h, 't2')).toBeNull() // and a thread that did not ask never gets them
  const bad = await call({ action: 'new', title: 'x', text: 'y', inherit: 't77' })
  expect(bad.text).toContain('no thread t77')
  expect((await call({ action: 'new', title: 'x', text: 'y', inherit: true })).text).toContain('inherit names the thread')
})

test('lean_doctor memory: per scope items and tokens, what the last session got, over budget flagged', async () => {
  const { h, call } = world()
  expect(await memoryDoctor(h.host, '/h')).toContain('nothing remembered yet')
  expect(await memoryRow(h.host, '/h')).toBeNull()
  await call({ action: 'new', title: 'form finder', text: 'build it', rules: ['keep the living plan doc up to date'] })
  for (const t of ['answer in short sentences', 'run the linter before a commit', 'never force push to main']) await memoryTool(h.host, '/h', { action: 'add', text: t, scope: 'global' })
  await memoryTool(h.host, '/h', { action: 'add', text: 'the staging database resets at night', scope: 'project:form-finder', kind: 'fact' })
  await section(h, 't1') // a session got its index
  const d = await memoryDoctor(h.host, '/h')
  expect(d).toMatch(/^memory: 5 items in 3 scopes/)
  expect(d).toMatch(/global\s+3 items\s+index\s+\d+ tokens\s+on demand\s+0 tokens/)
  expect(d).toMatch(/project:form-finder\s+1 items\s+index\s+0 tokens\s+on demand\s+\d+ tokens/)
  expect(d).toMatch(/thread:t1\s+1 items/)
  expect(d).toContain('what the last sessions got (index + reminders):')
  expect(d).toMatch(/t1\s+index \d+ tokens \(4 lines\), reminders 0/)
  expect(d).toContain('within budget')
  expect((await memoryRow(h.host, '/h'))!).toMatchObject({ ok: true })
  // a scope over its budget is flagged, in the verb and in the check row; so is an open thread's cut view
  h.files.set(`${L}/config.json`, JSON.stringify({ memory: { indexTokens: 60 }, handover: { mode: 'full' } }))
  const over = await memoryDoctor(h.host, '/h')
  expect(over).toContain('OVER BUDGET')
  expect(over).toContain('t1: its index needs')
  expect(over).not.toContain('desk: its index needs') // the desk sees only the habits: they fit
  expect((await memoryRow(h.host, '/h'))!.ok).toBe(true) // (no single scope is over 60)
  await memoryTool(h.host, '/h', { action: 'add', text: 'a long standing order about naming branches after the ticket id and the short slug of the work', scope: 'global' })
  await memoryTool(h.host, '/h', { action: 'add', text: 'another long standing order about writing commit messages in the imperative mood always', scope: 'global' })
  const row = (await memoryRow(h.host, '/h'))!
  expect(row.ok).toBe(false)
  expect(row.text).toContain('global')
  expect(await memoryDoctor(h.host, '/h')).toContain('global alone')
})
