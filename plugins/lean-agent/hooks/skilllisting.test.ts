import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { resetLocks } from './threads'
import { trimListing } from './skilltrim'

const ORIGIN = { kind: 'engine' } as const
const LIST = [
  'The following skills are available for use with the Skill tool:',
  '',
  '- lean-agent:thread: Start, message, wake',
  '- anthropic-skills:pdf: Use this skill whenever the user wants to do anything',
  '  with PDF files, wrapped over two lines',
  '- lean-agent:pr: Open, inspect and update pull requests',
  '- `other:one`: backticked name',
  '* other:two: star bullet',
].join('\n')

test('trimListing handles the plain, backticked and star-bullet shapes and says why it did not trim', () => {
  expect(trimListing(LIST).text).toBe(['The following skills are available for use with the Skill tool:', '', '- lean-agent:thread: Start, message, wake', '- lean-agent:pr: Open, inspect and update pull requests'].join('\n'))
  expect(trimListing(LIST).reason).toBe('trimmed 5 -> 2')
  expect(trimListing('nothing like a list')).toEqual({ text: null, reason: 'format not recognised (no skill lines)' })
  expect(trimListing('- other:big: x').text).toBeNull()
  expect(trimListing('- lean-agent:a: x\n- lean-agent:b: y').reason).toBe('already only lean-agent skills (2)')
})

// the mod's own state is read the way a user does: through the doctor's check output
const stat = async ($: any) => {
  const r: any = await $.tool.call({ tool: 'mcp__lean-agent__lean_doctor', action: 'check' } as any)
  return String(r?.result ?? r?.text ?? r)
}

function desk(on: any, cwd = '/h/lean-agent-desk') {
  resetLocks()
  const h = fakeHost(on)
  on('prompt.attachment', (_: any, e: any) => ({ text: e.text })) // the engine's own answer: the text as it rendered it
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  return { h, start: ($: any) => $.session.start({ cwd, surface: 'desktop', isInteractive: true } as any) }
}

test('the desk trims a skill_listing attachment, records it, and shows it in the doctor check', async ($, on) => {
  const { start } = desk(on)
  await start($)
  const r: any = await $.prompt.attachment({ type: 'skill_listing', text: LIST, origin: ORIGIN } as any)
  expect(r.text).toContain('lean-agent:thread')
  expect(r.text).not.toContain('anthropic-skills')
  const out = await stat($)
  expect(out).toContain('desk skill listing: trimmed 5 -> 2 (skill_listing)')
  expect(out).toContain('attachments: skill_listing')
  expect(out).not.toContain('PDF') // names and counts only
})

test('a renamed listing type that holds "skill" is trimmed too; an unknown format is left untouched and says so', async ($, on) => {
  const { start } = desk(on)
  await start($)
  const a: any = await $.prompt.attachment({ type: 'available_skills', text: LIST, origin: ORIGIN } as any)
  expect(a.text).not.toContain('anthropic-skills')
  const odd = 'skills: lean-agent:thread, other:big'
  const b: any = await $.prompt.attachment({ type: 'skill_listing', text: odd, origin: ORIGIN } as any)
  expect(b.text).toBe(odd)
  expect(await stat($)).toContain('desk skill listing: format not recognised (no skill lines) (skill_listing)')
})

test('a plain session is never trimmed; other attachments pass', async ($, on) => {
  const { start } = desk(on, '/h/elsewhere')
  await start($)
  const r: any = await $.prompt.attachment({ type: 'skill_listing', text: LIST, origin: ORIGIN } as any)
  expect(r.text).toBe(LIST)
  const o: any = await $.prompt.attachment({ type: 'todo_reminder', text: 'remember', origin: ORIGIN } as any)
  expect(o.text).toBe('remember')
})

test('no attachment seen yet is said plainly', async ($, on) => {
  const { start } = desk(on)
  await start($)
  expect(await stat($)).toContain('desk skill listing: no skill_listing attachment seen')
})

test('an MCP-instructions attachment is left out on the desk only', async ($, on) => {
  const { start } = desk(on)
  await start($)
  const r: any = await $.prompt.attachment({ type: 'mcp_instructions_delta', text: 'server says...', origin: ORIGIN } as any)
  expect(r.text).toBeNull()
})

test('a desk role asks the engine for the cached listing, sections and descriptions again', async ($, on) => {
  const asked: string[] = []
  on('ui.invalidate', (_: any, e: any) => { asked.push(e.event ?? e.name ?? JSON.stringify(e)); return { value: undefined } })
  const { start } = desk(on)
  await start($)
  const all = asked.join(' ')
  for (const ev of ['tool.list', 'prompt.attachment', 'prompt.section', 'tool.describe']) expect(all).toContain(ev)
})
