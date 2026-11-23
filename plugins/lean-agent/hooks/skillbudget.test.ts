// The skills listing a session carries on EVERY request (1.0.26): only the lean-agent skills the role uses, short descriptions, and a trim that
// no multi-line entry can switch off. The budgets are chars/4 of the listing lines (`- lean-agent:<name>: <description>`), pinned per role.
import { expect, test } from 'claude-code/testing'
import { readFileSync, readdirSync } from 'node:fs'
import { SKILL_ROLES, offeredTo, trimListing } from './skilltrim'

const PLUGIN = decodeURIComponent(new URL('..', (import.meta as any).url).pathname).replace(/\/$/, '')
export const BUDGET = { thread: 1500, desk: 2500 } // tokens, chars / 4

type Entry = { name: string; description: string; roles: string[] }
function entries(): Entry[] {
  const out: Entry[] = []
  for (const d of readdirSync(`${PLUGIN}/skills`)) {
    const text = readFileSync(`${PLUGIN}/skills/${d}/SKILL.md`, 'utf8')
    const head = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? ''
    out.push({ name: /^name:\s*(\S+)/m.exec(head)?.[1] ?? d, description: /^description:\s*(.+)$/m.exec(head)?.[1] ?? '', roles: (/^roles:\s*(.+)$/m.exec(head)?.[1] ?? '').split(',').map(x => x.trim()).filter(Boolean) })
  }
  for (const f of readdirSync(`${PLUGIN}/commands`)) {
    const head = /^---\n([\s\S]*?)\n---/.exec(readFileSync(`${PLUGIN}/commands/${f}`, 'utf8'))?.[1] ?? ''
    out.push({ name: f.replace(/\.md$/, ''), description: /^description:\s*(.+)$/m.exec(head)?.[1] ?? '', roles: ['desk'] })
  }
  return out
}
const listing = (role: 'desk' | 'thread') => entries().filter(e => offeredTo(role, `lean-agent:${e.name}`)).map(e => `- lean-agent:${e.name}: ${e.description}`).join('\n')

test('SKILL_ROLES is the front matter: every skill and command is in the table with the roles of its SKILL.md', () => {
  const want: Record<string, string[]> = {}
  for (const e of entries()) want[e.name] = e.roles
  expect(Object.keys(SKILL_ROLES).sort()).toEqual(Object.keys(want).sort())
  for (const [n, r] of Object.entries(want)) expect([n, [...SKILL_ROLES[n]!].sort()]).toEqual([n, [...r].sort()])
})

test('the listing of a thread is <= 1.5k tokens and the desk\'s <= 2.5k (chars/4), a thread\'s without the desk-only skills', () => {
  const t = listing('thread')
  const d = listing('desk')
  console.log(`skills listing: thread ${Math.round(t.length / 4)} tokens (${t.split('\n').length} entries), desk ${Math.round(d.length / 4)} tokens (${d.split('\n').length} entries)`)
  expect(t.length / 4).toBeLessThanOrEqual(BUDGET.thread)
  expect(d.length / 4).toBeLessThanOrEqual(BUDGET.desk)
  expect(t).not.toContain('lean-agent:doctor')
  expect(t).not.toContain('lean-agent:new')
  expect(d).not.toContain('lean-agent:worktree')
  for (const e of entries()) expect([e.name, e.description.length <= 260]).toEqual([e.name, true]) // one short sentence or two; the details live in the skill
})

const MIXED = [
  'The following skills are available for use with the Skill tool:',
  '',
  '- session-start-hook (startup-hook-skill): an entry with an annotation',
  '- lean-agent:doctor: desk only',
  '- lean-agent:review: both',
  '- claude-api: a long description',
  'TRIGGER: an unindented continuation line',
  'SKIP only when another provider is named.',
  '- anthropic-skills:pdf: after the multi-line entry',
  '  an indented one',
  '- lean-agent:worktree: thread only',
  '',
  '- a bullet after the listing: kept',
].join('\n')

test('a multi-line or annotated entry does not end the filtering: every other plugin\'s skill after it goes too; the role keeps only its own', () => {
  const t = trimListing(MIXED, n => offeredTo('thread', n))
  expect(t.text).toBe(['The following skills are available for use with the Skill tool:', '', '- lean-agent:review: both', '- lean-agent:worktree: thread only', '', '- a bullet after the listing: kept'].join('\n'))
  expect(t.reason).toBe('trimmed 6 -> 2')
  const d = trimListing(MIXED, n => offeredTo('desk', n))
  expect(d.text).toContain('lean-agent:doctor')
  expect(d.text).not.toContain('worktree')
  expect(d.text).not.toContain('TRIGGER')
  expect(d.text).not.toContain('claude-api')
  expect(offeredTo('thread', 'lean-agent:some-new-skill')).toBe(true) // a skill the table does not know is never hidden
  expect(offeredTo('thread', 'other:review')).toBe(false)
})
