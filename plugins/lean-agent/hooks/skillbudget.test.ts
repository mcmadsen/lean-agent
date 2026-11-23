// The skills listing a session carries on EVERY request (1.0.26): only the lean-agent skills the role uses, and a trim that no multi-line or
// annotated entry can switch off. The listing BUDGETS (thread <= 1.5k tokens, desk <= 2.5k, chars / 4) and the SKILL_ROLES table against the
// skills' front matter are pinned in skills-contract.mjs (plain node: a spec cannot read the skill files).
import { expect, test } from 'claude-code/testing'
import { SKILL_ROLES, offeredTo, trimListing } from './skilltrim'

test('the table: skills for a thread, desk-only ones and commands; an unknown lean-agent skill is never hidden', () => {
  expect(offeredTo('thread', 'lean-agent:review')).toBe(true)
  expect(offeredTo('thread', 'lean-agent:doctor')).toBe(false)
  expect(offeredTo('thread', 'lean-agent:new')).toBe(false) // a command: the desk's
  expect(offeredTo('desk', 'lean-agent:worktree')).toBe(false)
  expect(offeredTo('desk', 'lean-agent:new')).toBe(true)
  expect(offeredTo('thread', 'lean-agent:some-new-skill')).toBe(true)
  expect(offeredTo('thread', 'other:review')).toBe(false)
  expect(Object.keys(SKILL_ROLES).length).toBeGreaterThanOrEqual(24)
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
})

test('the old shape still works: the default keeps every lean-agent skill and drops the rest, wrapped descriptions with it', () => {
  const list = ['- lean-agent:thread: a', '- other:big: b', '  wrapped', '- lean-agent:pr: c'].join('\n')
  expect(trimListing(list).text).toBe(['- lean-agent:thread: a', '- lean-agent:pr: c'].join('\n'))
  expect(trimListing('- lean-agent:a: x\n- lean-agent:b: y').reason).toBe('already only lean-agent skills (2)')
})
