// 1.0.35 feedback drafts are OLD reports (draftnote.ts): the version a draft was written against, the banner when it differs from the installed one, "OLD:" past 3 releases,
// "possibly fixed in 1.0.N" from the CHANGELOG, an unknown version, and the places that show it (the export, deliver of a draft, save-draft). Synthetic text only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { VERSION_LINE, cmpVer, draftBanner, draftVersion, parseChangelog, parseVer, releasesBehind, stampVersion, titleWords } from './draftnote'
import { exportFeedback } from './feedbackexport'
import { deliver, saveDraft } from './deliver'
import { resetLocks } from './threads'

const CHECK = 'this may be fixed already, check README/CHANGELOG or the current skill before relying on it'
const LOG = parseChangelog(['# Changelog', '', '## 1.0.34', '- tool results are cut', '', '## 1.0.33', '- review-learn reads the host from the origin URL, so Azure DevOps pull requests are read too', '', '## 1.0.32', '- a closed thread is reopened', '', '## 1.0.31', '- x', '', '## 1.0.30', '- y', '', '## 1.0.29', '- z'].join('\n'))

test('version parse: the draft\'s own text (a Plugin version line, an export environment line) or unknown; compare by major, minor, patch', () => {
  expect(parseVer('lean-agent 1.0.34')).toEqual([1, 0, 34])
  expect(parseVer('none')).toBeNull()
  expect(draftVersion('# t\n\nPlugin version: lean-agent 1.0.20\nSteps')).toEqual([1, 0, 20])
  expect(draftVersion('- Plugin version: 1.0.7')).toEqual([1, 0, 7])
  expect(draftVersion('## Environment\n- lean-agent running: 1.0.19; installed: 1.0.19')).toEqual([1, 0, 19])
  expect(draftVersion('# t\nno version here')).toBeNull()
  expect(cmpVer([1, 0, 9], [1, 0, 10])).toBeLessThan(0)
  expect(cmpVer([1, 1, 0], [1, 0, 99])).toBeGreaterThan(0)
  expect(VERSION_LINE.test('x\nPlugin version: lean-agent 1.0.1')).toBe(true)
})

test('a banner when the versions differ, none when they are equal, "unknown" when the text names none', () => {
  const text = '# Menu hides the setting\n\nPlugin version: lean-agent 1.0.33\nsteps'
  expect(draftBanner({ text, title: 'Menu hides the setting', installed: '1.0.34' })).toBe(`written against 1.0.33, installed 1.0.34: ${CHECK}`)
  expect(draftBanner({ text, title: 'Menu hides the setting', installed: '1.0.33' })).toBe('')
  expect(draftBanner({ text: '# a\nno version', title: 'a', installed: '1.0.34' })).toBe(`written against an unknown version, installed 1.0.34: ${CHECK}`)
  expect(draftBanner({ text, title: 'x', installed: 'unknown' })).toBe('') // an unknown installed version compares with nothing
})

test('OLD: first when the draft is more than 3 releases behind (by the CHANGELOG headings, else by the patch number, else when the minor differs)', () => {
  const t = (v: string) => `# a\nPlugin version: lean-agent ${v}`
  expect(draftBanner({ text: t('1.0.31'), title: 'a', installed: '1.0.34', log: LOG })).toMatch(/^written against 1\.0\.31/) // 3 releases: not old yet
  expect(draftBanner({ text: t('1.0.30'), title: 'a', installed: '1.0.34', log: LOG })).toMatch(/^OLD: written against 1\.0\.30, installed 1\.0\.34/)
  expect(releasesBehind([1, 0, 30], [1, 0, 34], LOG)).toBe(4)
  expect(releasesBehind([1, 0, 30], [1, 0, 34], [])).toBe(4) // no CHANGELOG: the patch number
  expect(releasesBehind([1, 0, 30], [1, 1, 2], [])).toBe(99)
  expect(draftBanner({ text: t('1.0.20'), title: 'a', installed: '1.0.34' })).toMatch(/^OLD: /)
})

test('possibly fixed in 1.0.N: a CHANGELOG section newer than the draft with at least 2 words of its title; none for one word or an older section', () => {
  const text = '# review-learn only handles GitHub pull requests\nPlugin version: lean-agent 1.0.20'
  const b = draftBanner({ text, title: 'review-learn only handles GitHub pull requests', installed: '1.0.34', log: LOG })
  expect(b).toContain('OLD: written against 1.0.20, installed 1.0.34')
  expect(b).toContain('possibly fixed in 1.0.33: review-learn reads the host from the origin URL, so Azure DevOps pull requests are read too')
  expect(draftBanner({ text, title: 'GitHub', installed: '1.0.34', log: LOG })).not.toContain('possibly fixed') // one word is not enough
  // a section that is not newer than the draft is not a fix of it
  expect(draftBanner({ text: '# review-learn handles pull requests\nPlugin version: lean-agent 1.0.33', title: 'review-learn handles pull requests', installed: '1.0.34', log: LOG })).not.toContain('possibly fixed')
  expect(titleWords('The review-learn skill only handles GitHub')).toEqual(['review', 'learn', 'skill', 'only', 'handles', 'github'].filter(w => w !== 'only'))
})

test('stampVersion puts a "Plugin version" line under the title, once', () => {
  expect(stampVersion('# Title\nbody', '1.0.34')).toBe('# Title\n\nPlugin version: lean-agent 1.0.34\nbody')
  expect(stampVersion('# Title\nPlugin version: lean-agent 1.0.1\nbody', '1.0.34')).toBe('# Title\nPlugin version: lean-agent 1.0.1\nbody')
  expect(stampVersion('# Title', null)).toContain('Plugin version: lean-agent unknown')
})

const ROOT = '/p'
function world(version = '1.0.34', changelog = true) {
  resetLocks()
  const h = fakeHost(null)
  h.files.set(`${ROOT}/.claude-plugin/plugin.json`, JSON.stringify({ version }))
  if (changelog) h.files.set(`${ROOT}/CHANGELOG.md`, ['# Changelog', '', '## 1.0.34', '- a', '', '## 1.0.33', '- review-learn reads the host from the origin URL, so Azure DevOps pull requests are read too', '', '## 1.0.32', '- b', '', '## 1.0.31', '- c', '', '## 1.0.30', '- d'].join('\n'))
  h.claude.handler = (a: string[]) => ({ exitCode: 0, stdout: a[0] === '--version' ? '2.1.327 (Claude Code)\n' : '' })
  h.files.set('/h/.lean-agent/projects.json', '{}')
  return h
}

test('the export lists each draft with its version line and banner; an equal version has no banner; a draft without a version says unknown', { timeoutMs: 20_000 }, async () => {
  const h = world()
  h.files.set('/h/.lean-agent/feedback-drafts/2026-11-20-review-learn.md', '# review-learn only handles GitHub pull requests\n\nPlugin version: lean-agent 1.0.20\n\nSteps: run it on an Azure repo.\n')
  h.files.set('/h/.lean-agent/feedback-drafts/2026-11-24-current.md', '# the pane is blank on start\n\nPlugin version: lean-agent 1.0.34\n\nSteps: open it.\n')
  h.files.set('/h/.lean-agent/feedback-drafts/2026-11-25-nover.md', '# a draft with no version line\n\nSteps: x.\n')
  const r = await exportFeedback(h.host, ROOT, { version: '1.0.34' })
  expect(r.ok, r.text).toBe(true)
  const t = h.files.get(r.path!)!
  const sec = (title: string) => t.slice(t.indexOf(`### ${title}`), t.indexOf('###', t.indexOf(`### ${title}`) + 4))
  const old = sec('review-learn only handles GitHub pull requests')
  expect(old).toContain('> OLD: written against 1.0.20, installed 1.0.34')
  expect(old).toContain('possibly fixed in 1.0.33')
  expect(old).not.toContain('Plugin version: lean-agent 1.0.20\n> ') // the draft has its own version line: not added again
  const cur = sec('the pane is blank on start')
  expect(cur).not.toContain('> ')
  const none = sec('a draft with no version line')
  expect(none).toContain('> Plugin version: lean-agent unknown')
  expect(none).toContain('> written against an unknown version, installed 1.0.34')
})

test('deliver of a draft says "Draft note: ..." when its version differs from the installed one', { timeoutMs: 20_000 }, async () => {
  const h = world()
  h.files.set('/h/.lean-agent/config.json', JSON.stringify({ feedback: { destination: 'folder', folder: '~/Downloads' } }))
  h.files.set('/h/Downloads/.keep', '')
  h.files.set('/h/.lean-agent/feedback-drafts/2026-11-20-a.md', '# review-learn only handles GitHub pull requests\nPlugin version: lean-agent 1.0.20\n')
  h.exec.handler = argv => {
    if (argv[0] !== 'cp') return { exitCode: 127, stdout: '', stderr: 'unknown' }
    h.files.set(argv[argv.length - 1]!, h.files.get(argv[argv.length - 2]!)!)
    return { exitCode: 0, stdout: '' }
  }
  const r = await deliver(h.host, { file: '/h/.lean-agent/feedback-drafts/2026-11-20-a.md', root: ROOT })
  expect(r.ok, r.text).toBe(true)
  expect(r.text).toContain('Draft note: OLD: written against 1.0.20, installed 1.0.34')
  expect(r.text).toContain('possibly fixed in 1.0.33')
  h.files.set('/h/.lean-agent/feedback-drafts/2026-11-25-b.md', '# fresh\nPlugin version: lean-agent 1.0.34\n')
  expect((await deliver(h.host, { file: '/h/.lean-agent/feedback-drafts/2026-11-25-b.md', root: ROOT })).text).not.toContain('Draft note')
})

test('save-draft stamps the installed plugin version under the title when the text has none', { timeoutMs: 20_000 }, async () => {
  const h = world()
  h.files.set('/h/.lean-agent/config.json', JSON.stringify({ feedback: { destination: 'folder', folder: '~/Downloads' } }))
  h.files.set('/h/Downloads/.keep', '')
  expect((await saveDraft(h.host, { text: '# The menu hides it\nsteps', name: 'menu.md', root: ROOT })).ok).toBe(true)
  expect(h.files.get('/h/Downloads/menu.md')).toBe('# The menu hides it\n\nPlugin version: lean-agent 1.0.34\nsteps\n')
  expect((await saveDraft(h.host, { text: '# Own\nPlugin version: lean-agent 1.0.2\nx', name: 'own.md', root: ROOT })).ok).toBe(true)
  expect(h.files.get('/h/Downloads/own.md')).toBe('# Own\nPlugin version: lean-agent 1.0.2\nx\n')
})
