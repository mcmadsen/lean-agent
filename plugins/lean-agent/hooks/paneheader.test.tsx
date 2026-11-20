// The pane header: "lean-agent is not set up" + Set up only while the setup itself is missing; what else the doctor found is
// "Doctor: N findings (F fix, I info)". Synthetic data only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { resetViewCache } from './view'
import { resetLocks } from './threads'
import { infoOf, missingOf } from './setup'

const PANE = { plugin: 'lean-agent', component: 'Pane', requestId: 'lean-agent', surface: 'terminal', props: { title: 'lean-agent', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const
const ROOT = decodeURIComponent(new URL('..', (import.meta as any).url).pathname).replace(/\/$/, '')

test('missingOf keeps only the setup rows; infoOf the note rows', () => {
  const rows = ['desk folder ~/lean-agent-desk', 'desk folder trusted', 'opener script current', 'launch agent installed', 'thread t2 runs 1.0.1, installed 1.0.2: restart it', 'a lean_report from t3 could not be written', 'worktrees.json has 1 stale entry']
  expect(missingOf(rows)).toEqual(rows.slice(0, 4))
  expect(infoOf(['ok   x', 'note opus was 40% of spend', 'FIX  y', 'note  another'])).toEqual(['opus was 40% of spend', 'another'])
  expect(missingOf([])).toEqual([])
})

test('a set-up home with a doctor finding shows "Doctor: 1 finding (1 fix, 0 info)" and Run fix, never "not set up"', async ($, on) => {
  resetLocks()
  resetViewCache()
  const h = fakeHost(on)
  h.files.set(`${ROOT}/opener/open-desk.sh`, '#!/bin/sh\necho open\n')
  h.files.set(`${ROOT}/templates/front-desk.md`, 'desk {{lean}}')
  h.files.set(`${ROOT}/templates/thread.md`, '# {{id}}')
  h.claude.handler = (a: string[]) => ({ exitCode: 0, stdout: a[0] === '--version' ? '2.0.0' : a[0] === 'agents' ? '[]' : '' })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('command.run', () => ({}))
  await $.session.start({ cwd: '/h/.claude/spares/spare-abc', surface: 'desktop', isInteractive: true } as any)
  let ui = await $.ui.mount(PANE as any)
  expect(await ui.find({ type: 'Text', text: /lean-agent is not set up/ })).toBeTruthy() // fresh home: really missing
  await ui.press({ key: 'setup' })
  await ui.unmount()
  // the setup is done; a thread's report could not be written: a finding, not a missing setup
  h.files.set('/h/.lean-agent/report-failure.json', JSON.stringify({ t9: { ts: 1_000_000, thread: 't9', error: 'ENOENT synthetic', text: 'synthetic text' } }))
  h.clock.t += 31_000 // the pane remembers a check for 30 s: this one is older (the pane runs in the engine's own instance of the mod)
  ui = await $.ui.mount(PANE as any)
  expect(await ui.find({ type: 'Text', text: /lean-agent is not set up/ })).toBeFalsy()
  expect(await ui.find({ type: 'Button', text: /Set up lean-agent/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /Doctor: \d+ findings? \(\d+ fix, \d+ info\)/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: /Run fix/ })).toBeTruthy()
  await ui.unmount()
})
