// The state snapshot and the preflight pack come from ONE computation of the working tree (snapshot.ts sharedGit): a fresh snapshot (< 60 s) is
// reused, a stale one is recomputed once and written back, and the handover prints one number per file. Synthetic names only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { buildHandover, setPreflight } from './handover'
import { preflightFor } from './preflight'
import { buildSnapshot, readSnapshot, writeSnapshot } from './snapshot'

const L = '/h/.lean-agent'
const T1 = `${L}/threads/t1`
const THREAD = { id: 't1', title: 'fix login', project: 'app', state: 'open', sid: 's1', created: 1, lastWake: 0, delivered: 0 }

function world() {
  const h = fakeHost(null)
  h.clock.t = 1_000_000
  h.files.set(`${T1}/thread.json`, JSON.stringify(THREAD))
  h.files.set(`${T1}/brief.md`, 'fix the login bug\n')
  h.files.set(`${L}/worktrees.json`, JSON.stringify({ a: { path: '/w/app', branch: 'fix-x', thread: 't1' } }))
  const st = { stat: ' src/a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n', status: ' M src/a.ts\n', calls: [] as string[] }
  h.git.handler = a => {
    const cmd = a.slice(2).join(' ')
    st.calls.push(cmd)
    if (cmd === 'rev-parse --abbrev-ref HEAD') return { exitCode: 0, stdout: 'fix-x\n' }
    if (cmd === 'rev-parse HEAD') return { exitCode: 0, stdout: 'abc1234567890def\n' }
    if (cmd === 'status --short') return { exitCode: 0, stdout: st.status }
    if (cmd === 'diff --stat HEAD') return { exitCode: 0, stdout: st.stat }
    if (cmd.startsWith('log -1')) return { exitCode: 0, stdout: 'abc1234 fix the form\n' }
    return { exitCode: 1, stdout: '' }
  }
  return { h, st }
}
const ran = (st: { calls: string[] }, cmd: string) => st.calls.filter(c => c === cmd).length

test('a stale snapshot is recomputed once, written back, and the handover prints one number for the file', async () => {
  const { h, st } = world()
  await writeSnapshot(h.host, '/h', await buildSnapshot(h.host, '/h', 't1', { sid: 's1', tasks: ['ship it'] })) // taken at t = 1_000_000: ' src/a.ts | 2 +-'
  h.clock.t = 1_000_000 + 120_000
  st.stat = ' src/a.ts | 9 +++++++++\n 1 file changed, 9 insertions(+)\n'
  st.calls.length = 0
  setPreflight(preflightFor)
  try {
    const p = (await buildHandover(h.host, '/h', THREAD as any, 'Because.', [])).prompt
    expect(ran(st, 'status --short')).toBe(1) // computed once
    expect(p.split('src/a.ts | 9 +++++++++').length).toBe(2) // one number for the file, the new one
    expect(p).not.toContain('src/a.ts | 2 +-')
    expect(p).toContain('git as of 1970-01-01 00:18:40Z (computed now): commit abc1234, worktree dirty') // the commit, dirty or not, and when
    const back = (await readSnapshot(h.host, '/h', 't1'))!
    expect(back.diffStat).toContain('| 9 +++++++++') // written back
    expect(back.gitAt).toBe(1_120_000)
    expect(back.at).toBe(1_000_000) // the turn-end record keeps its own time
    expect(back.tasks).toEqual([{ text: 'ship it', status: 'pending' }]) // and its other fields
    expect(p).toContain('[pending] ship it')
  } finally {
    setPreflight(null)
  }
})

test('a fresh snapshot (under 60 s) is reused as it is: no git call, "as of" its time, the same numbers in the one place they are printed', async () => {
  const { h, st } = world()
  await writeSnapshot(h.host, '/h', await buildSnapshot(h.host, '/h', 't1', { sid: 's1' }))
  h.clock.t = 1_000_000 + 30_000
  st.stat = ' src/a.ts | 9 +++++++++\n 1 file changed, 9 insertions(+)\n' // the tree moved on, the snapshot is still the answer
  st.calls.length = 0
  setPreflight(preflightFor)
  try {
    const p = (await buildHandover(h.host, '/h', THREAD as any, 'Because.', [])).prompt
    expect(st.calls).toEqual([])
    expect(p).toContain('git as of 1970-01-01 00:16:40Z (from the state snapshot): commit abc1234, worktree dirty')
    expect(p.split('src/a.ts | 2 +-').length).toBe(2)
    expect(p).not.toContain('| 9 +')
    expect(p).toContain('## State at the end of the last turn (state.json)') // the snapshot section stays, without repeating the git lines
    expect(p.split(' M src/a.ts').length).toBe(2)
  } finally {
    setPreflight(null)
  }
})

test('no snapshot: computed once and nothing written; a clean tree is said to be clean; an unreadable one says so', async () => {
  const { h, st } = world()
  st.status = ''
  st.stat = ''
  setPreflight(preflightFor)
  try {
    const p = (await buildHandover(h.host, '/h', THREAD as any, 'Because.', [])).prompt
    expect(p).toContain('commit abc1234, worktree clean')
    expect(p).toContain('status: clean')
    expect(p).toContain('diff vs HEAD: no changes')
    expect(h.files.has(`${T1}/state.json`)).toBe(false)
    h.git.handler = () => ({ exitCode: 1, stdout: '' })
    expect((await buildHandover(h.host, '/h', THREAD as any, 'Because.', [])).prompt).toContain('git state: not readable')
  } finally {
    setPreflight(null)
  }
})
