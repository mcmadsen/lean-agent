// The thread's own notes are found where it kept them (notes.md, notes/*.md, scratch/*.md), and "no goal" is never said of a thread with a brief
// (threadnotes.ts, handover.ts). Synthetic names only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { buildHandover, handoverReport } from './handover'
import { lookupNotes } from './threadnotes'

const L = '/h/.lean-agent'
const T = `${L}/threads/t9`
const THREAD = { id: 't9', title: 'port the inventory', project: 'app', state: 'open', sid: 's1', created: 1, lastWake: 0, delivered: 0 }

function world() {
  const h = fakeHost(null)
  h.files.set(`${T}/thread.json`, JSON.stringify(THREAD))
  h.files.set(`${T}/brief.md`, '# Port the inventory to the new store\nmore detail\n')
  h.git.handler = () => ({ exitCode: 1, stdout: '' })
  return h
}

test('files in notes/ and scratch/ (not notes.md) are found: progress.md carries its text, the others are listed by name with the read-first line', async () => {
  const h = world()
  h.files.set(`${T}/notes/progress.md`, '# Progress\nphase 1 done, phase 2 needs the owner list\n')
  h.files.set(`${T}/notes/plan-extract.md`, '# Plan extract\nthe four phases\n')
  h.files.set(`${T}/scratch/legacy-inventory.md`, '# Legacy inventory\n212 tables, 9 unused\n')
  h.files.set(`${T}/scratch/not-markdown.txt`, 'ignored')
  const ho = await buildHandover(h.host, '/h', THREAD as any, 'Because.', [])
  const p = ho.prompt
  expect(p).toContain('## Your notes (end of notes/progress.md)\n# Progress\nphase 1 done')
  expect(p).toContain('## Other notes and scratch files: read these before re-reading sources (newest first; path, size, first line)\n- notes/plan-extract.md (')
  expect(p).toContain('- scratch/legacy-inventory.md (')
  expect(p).toContain(': # Legacy inventory')
  expect(p).not.toContain('not-markdown')
  expect(p).not.toContain('212 tables') // by name and first line, not the text
  expect(p).toContain('Your earlier reading is kept:')
  expect(ho.missing!.join(';')).not.toContain('no notes')
  expect(ho.missing!.join(';')).not.toContain('no goal')
  expect(ho.notes).toMatchObject({ content: ['notes/progress.md'], listed: ['notes/plan-extract.md', 'scratch/legacy-inventory.md'], left: [] })
})

test('no goal set: the goal is the first line of the brief; no goal and no brief says so; a set goal wins', async () => {
  const h = world()
  const goalOf = async () => (await buildHandover(h.host, '/h', THREAD as any, 'Because.', [])).prompt
  expect(await goalOf()).toContain('## Goal\ngoal: Port the inventory to the new store')
  h.files.set(`${L}/goals.json`, JSON.stringify({ t9: { text: 'finish phase 2' } }))
  const p = await goalOf()
  expect(p).toContain('## Goal\nfinish phase 2')
  expect(p).not.toContain('goal: Port the inventory')
  const bare = fakeHost(null)
  bare.files.set(`${T}/thread.json`, JSON.stringify(THREAD))
  bare.git.handler = () => ({ exitCode: 1, stdout: '' })
  expect((await buildHandover(bare.host, '/h', THREAD as any, 'Because.', [])).missing!.join(';')).toContain('no goal')
})

test('lean_doctor handover: lists the notes files it used and those it found but left out, with the reason (budget)', async () => {
  const h = world()
  h.files.set(`${T}/notes.md`, '# Notes\nthe state\n')
  for (let i = 0; i < 9; i++) h.files.set(`${T}/scratch/r${i}.md`, `# summary ${i}\ntext`)
  const lookup = await lookupNotes(h.host, T)
  expect(lookup.content.map(f => f.path)).toEqual(['notes.md'])
  expect(lookup.listed).toHaveLength(5) // at most 6 files in all
  expect(lookup.left.map(f => f.path)).toEqual(['scratch/r5.md', 'scratch/r6.md', 'scratch/r7.md', 'scratch/r8.md'])
  const text = await handoverReport(h.host, '/h', 't9')
  expect(text.split('\n')[0]).toMatch(/^handover for t9: about \d+ tokens: brief [1-9]\d*, corrections 0, notes [1-9]\d*, snapshot 0, preflight 0$/) // each part's size
  expect(text).toContain('notes used: notes.md; by name (read these before re-reading sources): scratch/r0.md, scratch/r1.md, scratch/r2.md, scratch/r3.md, scratch/r4.md')
  expect(text).toContain('notes found but left out: scratch/r5.md (budget: only the newest 6 notes files are listed')
  expect(text).toContain('scratch/r8.md (budget')
  // the order of the files: newest first (the host reports no mtimes: `ls -1td` orders them; here r8 is the newest)
  h.exec.handler = argv => (argv[0] === 'ls' && argv[1] === '-1td' ? { exitCode: 0, stdout: [...argv.slice(2)].sort((a, b) => (a.endsWith('/r8.md') ? -1 : b.endsWith('/r8.md') ? 1 : 0)).join('\n') + '\n' } : { exitCode: 1, stdout: '' })
  const again = await lookupNotes(h.host, T)
  expect(again.listed.map(f => f.path)).toEqual(['scratch/r8.md', 'scratch/r0.md', 'scratch/r1.md', 'scratch/r2.md', 'scratch/r3.md'])
})
