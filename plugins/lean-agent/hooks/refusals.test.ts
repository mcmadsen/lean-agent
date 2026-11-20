// Avoidable blocks (refusals.ts and the grants of `lean_thread new`): the guard's refusals grouped by pattern with a one-line fix, the doctor
// row that appears when one repeats, and the grants named up front. Everything is synthetic.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { groupRefusals, patternOf, refusalsText, topRefusalsRow } from './refusals'
import { GRANTS_MAX, grantsBlock, leanThread, resetLocks } from './threads'
import { check } from './doctor'
import { logRefusal } from './feedbackexport'

const L = '/h/.lean-agent'
const DAY = 86_400_000
const REFUSED = (prog: string, why: string, agent = 'lean-agent:reviewer') => `lean-agent: refused: ${prog} (${why}); ${agent} may run only its built-in read-only commands (git, rg, grep, find, ls) and the commands the thread granted (allow-cmd) (lean-agent 1.0.14)`
const EDIT = (p: string) => `lean-agent: ${p} is outside the paths the thread granted this worker (allow-edit): stop and report this path to the thread (do not edit it another way); the thread adds it to allow-edit and briefs you again (lean-agent 1.0.14)`

async function rows(h: ReturnType<typeof fakeHost>, list: [string, string][], n = 1) {
  for (const [text, agent] of list) for (let k = 0; k < n; k++) await logRefusal(h.host, { text, agent, tool: 'Bash', thread: 't3', version: '1.0.14' })
}

test('a refusal text becomes a pattern with a one-line fix: the program and the reason, a worker path, the desk, the old wording', () => {
  const cd = patternOf(REFUSED('cd', 'redirect, ;, &&, ||, substitution, glob, & or another shell form is not allowed'), 'reviewer')
  expect(cd.label).toContain('`cd`')
  expect(cd.fix).toContain('git -C')
  const flag = patternOf(REFUSED('rg', 'a flag that writes or runs a program, a path outside the allowed folders, or a missing operand / -n'), 'reviewer')
  expect(flag.fix).toContain('a reader does not write')
  const other = patternOf(REFUSED('make', 'not a built-in read-only command'), 'reader-sonnet')
  expect(other.fix).toContain('reader-haiku')
  expect(other.fix).toContain('reader-haiku')
  const e = patternOf(EDIT('/r/app/.claude/skills/x/SKILL.md'), 'worker-sonnet')
  expect(e.key).toBe('edit:/r/app/.claude/skills/x')
  expect(e.fix).toContain('no grant needed')
  expect(patternOf('lean-agent strict mode: route this to a thread (thread skill): Read only under ~/.lean-agent (lean-agent 1.0.9)', 'session').key).toBe('desk-strict')
  expect(patternOf('lean-agent: lean-agent:reviewer may run only its built-in read-only git commands and the commands the thread granted (allow-cmd) (lean-agent 1.0.8)', 'reviewer').key).toBe('cmd-old:reviewer')
  expect(patternOf('lean-agent: subagent cap reached: 4 subagents already started', 'session').key).toBe('cap')
  expect(patternOf('lean-agent: opus needs the user\'s approval: report it and stop.', 'session').key).toBe('model:opus')
  expect(patternOf('something new that nobody has seen', 'session').fix).toContain('read the refusal text')
  // the version tail never splits a pattern
  expect(patternOf(REFUSED('cd', 'x'), 'reviewer').key).toBe(patternOf(REFUSED('cd', 'x').replace('1.0.14', '1.0.9'), 'reviewer').key)
})

test('lean_doctor refusals groups the guard rows by pattern with counts, most frequent first; worker rows and old rows are left out', async () => {
  const h = fakeHost(null)
  await rows(h, [[REFUSED('cd', 'redirect, ;, &&, ||, substitution, glob, & or another shell form is not allowed'), 'lean-agent:reviewer']], 4)
  await rows(h, [[REFUSED('cd', 'redirect, ;, &&, ||, substitution, glob, & or another shell form is not allowed', 'lean-agent:reader-sonnet'), 'lean-agent:reader-sonnet']], 2)
  await rows(h, [[EDIT('/r/app/.claude/skills/a/SKILL.md'), 'lean-agent:worker-sonnet'], [EDIT('/r/app/.claude/skills/a/OTHER.md'), 'lean-agent:worker-sonnet']])
  h.files.set(`${L}/refusals.jsonl`, `${h.files.get(`${L}/refusals.jsonl`)}${JSON.stringify({ ts: h.clock.t, src: 'worker', command: 'make', text: 'refused', agent: 'reader-sonnet' })}\n${JSON.stringify({ ts: h.clock.t - 30 * DAY, src: 'guard', text: REFUSED('zz', 'old'), agent: 'reviewer' })}\n`)
  const g = await groupRefusals(h.host, 7)
  expect(g.total).toBe(8)
  expect(g.groups.map(x => x.n)).toEqual([4, 2, 2])
  expect(g.groups[0]!.label).toMatch(/^reviewer refused `cd` \(redirect/)
  expect(g.groups[1]!.label).toMatch(/^reader-sonnet refused `cd`/)
  expect(g.groups[2]!.label).toBe("a worker's edit outside its grant (older wording): /r/app/.claude/skills/a") // two files of one folder are one pattern
  const text = await refusalsText(h.host)
  expect(text).toContain('8 guard refusal(s) in the last 7 day(s), 3 pattern(s)')
  expect(text).toContain('(x4) REPEATS reviewer refused `cd`')
  expect(text).toContain('(x2) a worker')
  expect(text).not.toContain('(x2) REPEATS') // below the default 3
  expect(text).toContain('fix: ')
  expect(await refusalsText(fakeHost(null).host)).toBe('no guard refusal in the last 7 day(s)')
  // a longer window brings the old row back
  expect((await groupRefusals(h.host, 60)).total).toBe(9)
})

test('the doctor says "top refusals" only when a pattern repeats (config refusals.repeat, default 3)', async () => {
  const h = fakeHost(null)
  await rows(h, [[REFUSED('rg', 'a flag that writes or runs a program'), 'lean-agent:reviewer']], 2)
  expect(await topRefusalsRow(h.host)).toBeNull()
  expect((await check(h.host, '/p')).join('\n')).toContain('ok   no guard refusal pattern repeats')
  await rows(h, [[REFUSED('rg', 'a flag that writes or runs a program'), 'lean-agent:reviewer']], 1)
  const row = await topRefusalsRow(h.host)
  expect(row).toContain('note top refusals')
  expect(row).toContain('(x3) reviewer refused `rg`')
  expect(row).toContain('lean_doctor refusals')
  const lines = await check(h.host, '/p')
  expect(lines.some(l => l.startsWith('note top refusals'))).toBe(true)
  expect(lines.some(l => l.startsWith('FIX') && l.includes('refusal'))).toBe(false) // advice, not a failure
  h.files.set(`${L}/config.json`, JSON.stringify({ refusals: { repeat: 5 } }))
  expect(await topRefusalsRow(h.host)).toBeNull()
  h.files.set(`${L}/config.json`, JSON.stringify({ refusals: { repeat: 2 } }))
  expect(await topRefusalsRow(h.host)).toContain('(x3)')
  h.files.set(`${L}/config.json`, JSON.stringify({ refusals: { repeat: 'x' } })) // a bad value is the default
  expect(await topRefusalsRow(h.host)).toContain('(x3)')
})

// ---- grants up front --------------------------------------------------------------------------------------------------------------
function setup() {
  resetLocks()
  const h = fakeHost(null)
  h.files.set('/p/templates/thread.md', '# {{id}} {{title}}')
  h.files.set('/p/templates/front-desk.md', 'desk {{lean}}')
  h.claude.handler = (a: string[]) => (a[0] === '--bg' ? { exitCode: 0, stdout: 'started 11111111-2222-3333-4444-555555555555\n' } : a[0] === 'agents' ? { exitCode: 0, stdout: '[]' } : { exitCode: 0, stdout: '' })
  return h
}

test('lean_thread new accepts allowEdit and allowCmd and ignores them: the brief is exactly what it was, nothing is refused', async () => {
  const h = setup()
  const r = await leanThread(h.host, '/p', { action: 'new', title: 'skills change', text: 'update the skill file', allowEdit: ['/r/app/.claude/skills/x/SKILL.md', 'rel/path'], allowCmd: ['git -C /h/wt/app-t1 log --stat'] } as any)
  expect(r.ok, r.text).toBe(true)
  expect(h.files.get(`${L}/threads/t1/brief.md`)).toBe('update the skill file\n')
  const prompt = h.claudeCalls().find(a => a[0] === '--bg')!.slice(-1)[0]!
  expect(prompt).not.toContain('allow-edit')
  expect(grantsBlock({ allowEdit: ['/a/b'] })).toBe('')
})
