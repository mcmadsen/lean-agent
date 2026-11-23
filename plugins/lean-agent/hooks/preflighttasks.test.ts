// The preflight's open tasks are the thread's own (preflight.ts taskIsAbout / openTasks), not the account's. Synthetic names only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { preflightText, refKeys, significantWords, taskIsAbout } from './preflight'

const L = '/h/.lean-agent'
const git = (a: string[]) => (a.includes('rev-parse') ? { exitCode: 0, stdout: 'fix-orbit-parser\n' } : { exitCode: 1, stdout: '' })

function world(todo: unknown, brief = 'Rework the orbit parser (PR #42)\n') {
  const h = fakeHost(null)
  h.git.handler = git
  h.files.set(`${L}/todo.json`, JSON.stringify(todo))
  h.files.set(`${L}/threads/t9/brief.md`, brief)
  return h
}
const me = { id: 't9', cwd: '/r/app', home: '/h', title: 'orbit parser rework', goal: 'rework the orbit parser and its tests', worktree: '/w/orbit' }

test('400 unrelated tasks and 3 related: only the 3 are listed, the rest is a count, never the rest', async () => {
  const todo = [
    ...Array.from({ length: 400 }, (_, i) => ({ id: i + 1, text: `unrelated chore ${i} about the kitchen budget`, done: false })),
    { id: 501, text: 'reply on the review thread', thread: 't9', done: false }, // carries the thread id
    { id: 502, text: 'delete the old orbit parser fixtures', done: false }, // two significant words of the goal
    { id: 503, text: 'merge after the checks', pr: 'https://host/org/repo/pull/42', done: false }, // the thread's PR
    { id: 504, text: 'orbit parser done already', done: true }, // closed: never listed
  ]
  const t = await preflightText(world(todo).host, me)
  const lines = t.split('\n')
  const at = lines.findIndex(l => l.startsWith('open tasks:'))
  expect(lines.slice(at + 1, at + 4)).toEqual(['- reply on the review thread', '- delete the old orbit parser fixtures', '- merge after the checks'])
  expect(lines[at + 4]).toBe('(400 more tasks not about this thread)')
  expect(t).not.toContain('kitchen')
  expect(t).not.toContain('already')
})

test('at most 5 related tasks are shown, the overflow is a count', async () => {
  const todo = Array.from({ length: 8 }, (_, i) => ({ text: `step ${i} for t9`, done: false }))
  const t = await preflightText(world(todo).host, me)
  expect(t.match(/^- step/gm)).toHaveLength(5)
  expect(t).toContain('(+3 more tasks about this thread)')
  expect(t).not.toContain('not about this thread')
})

test('no task is linked to the thread (or no task source): "none linked to this thread", nothing else', async () => {
  const none = await preflightText(world([{ text: 'buy a lamp', done: false }, { text: 'call the dentist' }]).host, me)
  expect(none).toContain('open tasks: none linked to this thread')
  expect(none).not.toContain('lamp')
  expect(none).not.toContain('more tasks')
  expect(await preflightText(fakeHost(null).host, me)).toContain('open tasks: none linked to this thread')
})

test('what links a task: id (not t850), branch, worktree, work item; one shared word is not enough; stop words never count', () => {
  const c = { id: 't9', title: 'orbit parser rework', goal: 'rework the orbit parser', branch: 'fix-orbit-parser', worktree: '/w/orbit', ref: 'work item #7' }
  expect(taskIsAbout({ text: 'see t9 notes' }, c)).toBe(true)
  expect(taskIsAbout({ text: 'see t850 notes' }, c)).toBe(false)
  expect(taskIsAbout({ text: 'rebase fix-orbit-parser' }, c)).toBe(true)
  expect(taskIsAbout({ text: 'clean /w/orbit' }, c)).toBe(true)
  expect(taskIsAbout({ text: 'close AB#7' }, c)).toBe(true)
  expect(taskIsAbout({ text: 'the orbit of the moon' }, c)).toBe(false)
  expect(taskIsAbout({ text: 'check the update for this task' }, { id: 't1', goal: 'check the update for this task' })).toBe(false)
  expect([...significantWords('Fix the Parser, and 2024 parser tests')].sort()).toEqual(['parser', 'tests'])
  expect([...refKeys('PR #42, /pull/43, AB#7')].sort()).toEqual(['pr:42', 'pr:43', 'wi:7'])
})
