// FILES FOR THE USER'S FOLDERS (Downloads / Desktop / Documents / a folder under their home). A thread never writes outside its worktree and its
// scratch/ folder (a worker gets EPERM on ~/Downloads on macOS, a hook refuses the rest): it writes the deliverable to scratch/ and asks the desk, and
// the MOD copies it: `lean_thread deliver` {tN, file, to, name?}.
//   * file: inside that thread's scratch folder, one of its registered worktrees, or the desk's reports folder (checked on the real paths).
//   * to: Downloads | Desktop | Documents | an absolute folder under the user's home (never a hidden folder, never lean-agent's own state).
//   * allowed ONLY when a recorded human prompt of the last 24 h (humanprompts.ts) names the destination (the folder word, or the typed absolute folder)
//     or says "save" / "put it in"; otherwise the desk asks with AskUserQuestion (the canonical question below) and the human's answer is read from the
//     tool's own result (bindDeliverAnswers): the answer allows that one copy.
//   * the copy: argv, no shell; never overwrites (name-2, name-3 ...); on EPERM the exact macOS text.
import { homeDir, leanDir, realPath, threadsDir } from './state'
import type { Host } from './state'
import { logHistory, threadOk } from './deskactions'
import { recentPrompts } from './humanprompts'
import { readRegistry } from './worktreereg'
import { feedbackConfig, wantsFolder } from './feedbackdest'
import { VERSION_LINE, draftBanner, readChangelog, stampVersion } from './draftnote'
import { readJson } from './state'

// the installed plugin version ('' when unknown): what a draft is compared with (draftnote.ts)
const installedOf = async (h: Host, root: string | undefined): Promise<string> => (root ? String((await readJson<{ version?: string }>(h, `${root}/.claude-plugin/plugin.json`, {}).catch(() => ({}) as { version?: string })).version ?? '') : '')

export const FOLDERS = ['Downloads', 'Desktop', 'Documents']
const OK_KEY = (k: string) => `deliver.ok.${k}`
const PENDING = 'deliver.pending'
const OK_TTL_MS = 30 * 60 * 1000
export const eperm = (folder: string): string => `macOS blocks the Claude app from ${folder}: System Settings > Privacy & Security > Files and Folders (or Full Disk Access): allow the Claude app, then retry`

const norm = (p: string): string => {
  const out: string[] = []
  for (const s of p.split('/')) {
    if (!s || s === '.') continue
    if (s === '..') out.pop()
    else out.push(s)
  }
  return '/' + out.join('/')
}
const under = (p: string, root: string) => p === root || p.startsWith(root + '/')
const baseName = (p: string) => p.split('/').pop() ?? ''
const hex = (s: string): string => {
  let x = 5381
  for (const ch of s) x = ((x * 33) ^ ch.charCodeAt(0)) >>> 0
  return x.toString(16)
}

// the destination folder: a standard word or an absolute folder under home; { folder: the path, label: what the user sees } or a refusal
export async function destination(h: Host, home: string, to: string): Promise<{ folder: string; label: string } | { text: string }> {
  const t = to.trim()
  const word = FOLDERS.find(f => f.toLowerCase() === t.replace(/^~\//, '').replace(/\/+$/, '').toLowerCase())
  if (word) return { folder: `${home}/${word}`, label: word }
  if (!t.startsWith('/') && !t.startsWith('~/')) return { text: `to is Downloads, Desktop, Documents or an absolute folder under your home (got ${t.slice(0, 80) || 'nothing'})` }
  const abs = norm(t.startsWith('~/') ? `${home}/${t.slice(2)}` : t)
  if (!under(abs, home) || abs === home) return { text: `${abs} is not a folder under the user's home: refused` }
  const rel = abs.slice(home.length + 1).split('/')
  if (rel.some(s => s.startsWith('.')) || under(abs, leanDir(home))) return { text: `${abs} is a hidden folder or lean-agent's own state: refused` }
  return { folder: abs, label: abs }
}
const safeName = (n: string): string | null => {
  const s = n.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return s && s.length <= 120 && !/[/\\]/.test(s) && !s.startsWith('.') && s !== '..' ? s : null
}
export async function freeName(h: Host, folder: string, name: string): Promise<string | null> {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 1; n <= 99; n++) {
    const cand = n === 1 ? name : `${stem}-${n}${ext}`
    if (!(await h.fs.exists(`${folder}/${cand}`).catch(() => true))) return cand
  }
  return null
}

// the canonical question and options (the desk asks exactly this; bindDeliverAnswers checks it)
export const SAVE_LABEL = 'Save it'
export const NO_LABEL = 'Do not save'
export const deliverQuestion = (thread: string, name: string, label: string): { question: string; options: { label: string; description: string }[] } => ({
  question: `Save ${name} (from ${thread}) to ${label}?`,
  options: [
    { label: SAVE_LABEL, description: `The mod copies ${name} into ${label}; an existing file is never overwritten` },
    { label: NO_LABEL, description: 'Nothing is copied' },
  ],
})
const keyOf = (thread: string, file: string, folder: string) => hex(`${thread}\n${file}\n${folder}`)

// ---- a FEEDBACK DRAFT for the configured feedback folder (1.0.33; field: "no way for the desk to copy feedback drafts to the user's folder when threads do not work") --------------------------------
// No thread is needed: `deliver` {file} (tN left out, or any tN) copies ONE file the mod itself wrote (~/.lean-agent/feedback-drafts, ~/.lean-agent/feedback-export), or a thread's scratch file named as
// a draft with `to` left out, into config feedback.folder, when feedback.destination includes folder (the user chose that folder once in the config: no question per copy). The same guards as every
// delivery: one file a call, never overwritten (a taken name gets -2, -3 ...), the target inside feedback.folder only (a plain file name, real paths compared: no .. and no symlink out of it), the folder
// under the user's home and not hidden or lean-agent's own state, and at most DRAFT_MAX bytes.
export const DRAFT_MAX = 256 * 1024
const mine = (home: string, real: string): boolean => under(real, `${leanDir(home)}/feedback-drafts`) || under(real, `${leanDir(home)}/feedback-export`)
// the configured feedback folder, checked: { dest, folderReal, label } or a refusal text (shared by the copy of a draft and by save-draft)
async function feedbackTarget(h: Host, home: string, to: string | undefined, what: string): Promise<{ dest: { folder: string; label: string }; folderReal: string; label: string } | { text: string }> {
  const c = await feedbackConfig(h, home)
  if (!wantsFolder(c.dest)) return { text: `feedback.destination is ${c.dest}: a feedback draft is ${what} only when it includes folder (lean_config set feedback.destination folder, and feedback.folder <path>). Nothing was ${what}` }
  if (!c.folder) return { text: `feedback.folder is not set (lean_config set feedback.folder ~/Downloads). Nothing was ${what}` }
  if (to && to.trim() && to.trim().toLowerCase() !== 'feedback') {
    const asked = await destination(h, home, to)
    const conf = await destination(h, home, c.folder)
    if (!('folder' in asked) || !('folder' in conf) || asked.folder !== conf.folder) return { text: `a feedback draft goes only to feedback.folder (${c.folder}); to: ${to.slice(0, 80)} is another folder: leave to out. Nothing was ${what}` }
  }
  const dest = await destination(h, home, c.folder)
  if (!('folder' in dest)) return { text: `feedback.folder ${c.folder} is refused: ${dest.text}. Nothing was ${what}` }
  const folderReal = await realPath(h, dest.folder)
  const homeReal = await realPath(h, home)
  if (!under(folderReal, homeReal) || folderReal === homeReal || under(folderReal, await realPath(h, leanDir(home)))) return { text: `feedback.folder ${c.folder} resolves outside the user's home or into lean-agent's own state (${folderReal}): refused. Nothing was ${what}` }
  const fst = await h.fs.stat(folderReal).catch(() => null)
  if (!fst) return { text: `feedback.folder ${c.folder} does not exist. Nothing was ${what}` }
  if (fst.kind !== 'dir' && fst.kind !== 'directory') return { text: `feedback.folder ${c.folder} is not a folder. Nothing was ${what}` }
  return { dest, folderReal, label: c.folder }
}
async function deliverDraft(h: Host, home: string, thread: string, real: string, i: DeliverIn): Promise<{ ok: boolean; text: string }> {
  const tg = await feedbackTarget(h, home, i.to, 'copied')
  if ('text' in tg) return { ok: false, text: tg.text }
  const { dest, folderReal } = tg
  const c = { folder: tg.label }
  const st = await h.fs.stat(real).catch(() => null)
  if (!st || st.kind !== 'file') return { ok: false, text: `${real} is not a file` }
  if (typeof st.size === 'number' && st.size > DRAFT_MAX) return { ok: false, text: `${baseName(real)} is ${st.size} bytes: a feedback draft is at most ${DRAFT_MAX} bytes. Nothing was copied` }
  const name = safeName(i.name ?? baseName(real))
  if (!name) return { ok: false, text: 'name must be a plain file name (no slash, not hidden)' }
  const final = await freeName(h, dest.folder, name)
  if (!final) return { ok: false, text: `${c.folder} already holds ${name} and 98 numbered copies: refused` }
  const target = `${folderReal}/${final}`
  if (!under(target, folderReal) || dirName(target) !== folderReal) return { ok: false, text: 'the target is not inside feedback.folder: refused. Nothing was copied' }
  const r = await h.process.run(['cp', '-n', '--', real, target], { timeoutMs: 60_000 }).catch((e: unknown) => ({ exitCode: 1, stdout: '', stderr: String((e as Error)?.message ?? e) }))
  if (r.exitCode !== 0) {
    const bad = String(r.stderr ?? '')
    return { ok: false, text: /operation not permitted|permission denied|EPERM|EACCES/i.test(bad) ? eperm(c.folder) : `copy to ${c.folder} failed: ${bad.trim().slice(0, 160) || `exit ${r.exitCode}`}` }
  }
  await logHistory(h, thread || 't0', { kind: 'delivered', file: real, to: target, by: 'config feedback.folder' })
  // 1.0.35: a draft is an old report: when it was written against another version than the installed one, the reply says so (draftnote.ts)
  const text = String(await h.fs.read(real).catch(() => ''))
  const inst = await installedOf(h, i.root)
  const note = inst ? draftBanner({ text, title: (text.split('\n').find(l => l.trim()) ?? '').replace(/^#+\s*/, ''), installed: inst, log: await readChangelog(h, i.root!) }) : ''
  return { ok: true, text: `copied ${baseName(real)} to ${target}${final !== name ? ` (${name} existed: nothing was overwritten)` : ''}. Tell the user the full path in one line${note ? `. Draft note: ${note}` : ''}` }
}
const dirName = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf('/')))

// 1.0.35 `lean_thread save-draft` {text, name?}: the DESK writes a draft (text it composed) into feedback.folder without a thread (a thread costs a 49k first request for one small file).
// The same guards as the copy of a draft: needs feedback.destination folder + feedback.folder (the user's one-time choice), ONE file a call, never overwritten (-2, -3 ...), inside the folder only
// (a plain name from a safe pattern, real paths compared), the folder under the user's home and not hidden or lean-agent's own state, at most DRAFT_MAX bytes, a .md or .txt file.
const DRAFT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.(md|txt)$/
export async function saveDraft(h: Host, i: { text?: string; name?: string; to?: string; root?: string }): Promise<{ ok: boolean; text: string }> {
  const home = await homeDir(h)
  // a draft the mod saves carries the plugin version it was written against (draftnote.ts): a "Plugin version: lean-agent X" line under its title when it has none
  const inst = await installedOf(h, i.root)
  const body = typeof i.text === 'string' ? (inst && !VERSION_LINE.test(i.text) && i.text.trim() ? stampVersion(i.text, inst) : i.text) : ''
  if (!body.trim()) return { ok: false, text: 'save-draft needs text: the draft to write. Nothing was saved' }
  const bytes = new TextEncoder().encode(body).length
  if (bytes > DRAFT_MAX) return { ok: false, text: `the draft is ${bytes} bytes: a feedback draft is at most ${DRAFT_MAX} bytes. Nothing was saved` }
  const name = (i.name ?? '').trim() || 'feedback-draft.md'
  if (!DRAFT_NAME.test(name) || name.includes('..')) return { ok: false, text: 'name must be a plain file name of letters, digits, . _ - ending in .md or .txt (no slash, not hidden, no ..). Nothing was saved' }
  const tg = await feedbackTarget(h, home, i.to, 'saved')
  if ('text' in tg) return { ok: false, text: tg.text }
  const final = await freeName(h, tg.dest.folder, name)
  if (!final) return { ok: false, text: `${tg.label} already holds ${name} and 98 numbered copies: refused` }
  const target = `${tg.folderReal}/${final}`
  if (!under(target, tg.folderReal) || dirName(target) !== tg.folderReal) return { ok: false, text: 'the target is not inside feedback.folder: refused. Nothing was saved' }
  try {
    await h.fs.write(target, body.endsWith('\n') ? body : `${body}\n`)
  } catch (e) {
    const bad = String((e as Error)?.message ?? e)
    return { ok: false, text: /operation not permitted|permission denied|EPERM|EACCES/i.test(bad) ? eperm(tg.label) : `saving to ${tg.label} failed: ${bad.slice(0, 160)}` }
  }
  await logHistory(h, 't0', { kind: 'delivered', file: '(text from the desk)', to: target, by: 'config feedback.folder' })
  return { ok: true, text: `saved ${bytes} bytes as ${target}${final !== name ? ` (${name} existed: nothing was overwritten)` : ''}. Tell the user the full path in one line` }
}

export type DeliverIn = { tN?: string; file?: string; to?: string; name?: string; root?: string /* the plugin folder: the installed version and the CHANGELOG for the draft banner (draftnote.ts) */ }
export async function deliver(h: Host, i: DeliverIn): Promise<{ ok: boolean; text: string; data?: unknown }> {
  const thread = (i.tN ?? '').trim()
  const home = await homeDir(h)
  const file0 = (i.file ?? '').trim()
  // no thread (or the desk's t0): only a feedback draft the mod itself wrote can be delivered, and it needs no working thread
  if (!thread || thread === 't0') {
    if (!file0.startsWith('/') || /[\n\r]/.test(file0)) return { ok: false, text: 'deliver needs file: ONE absolute path (a feedback draft under ~/.lean-agent/feedback-drafts or feedback-export when no tN is given)' }
    const realFile = await realPath(h, norm(file0))
    if (!mine(home, realFile) && !mine(await realPath(h, home), realFile)) return { ok: false, text: 'deliver needs tN (the thread that made the file); without one only a feedback draft (~/.lean-agent/feedback-drafts, feedback-export) is delivered' }
    return deliverDraft(h, home, '', realFile, i)
  }
  if (!threadOk(thread)) return { ok: false, text: 'deliver needs tN (the thread that made the file)' }
  if (!(await h.fs.exists(`${threadsDir(home)}/${thread}/thread.json`).catch(() => false))) return { ok: false, text: `no thread ${thread}` }
  const file = file0
  if (!file.startsWith('/')) return { ok: false, text: 'deliver needs file: an absolute path inside the thread\'s scratch folder, its worktree or the desk reports folder' }
  // the file: a real file, on its real path inside an allowed root
  const real = await realPath(h, norm(file))
  // a feedback draft the mod wrote, or a scratch file of this thread named as a draft with `to` left out: the feedback folder (above)
  if (mine(home, real) || (!(i.to ?? '').trim() && /draft/i.test(baseName(real)) && under(real, norm(`${threadsDir(home)}/${thread}/scratch`)))) return deliverDraft(h, home, thread, real, i)
  const st = await h.fs.stat(real).catch(() => null)
  if (!st || st.kind !== 'file') return { ok: false, text: `${file} is not a file` }
  const { reg } = await readRegistry(h, home).catch(() => ({ reg: {} as Record<string, { path?: unknown; thread?: unknown }> }))
  const roots = [`${threadsDir(home)}/${thread}/scratch`, `${leanDir(home)}/desk/reports`, ...Object.values(reg).filter(e => e && e.thread === thread && typeof e.path === 'string' && (e.path as string).startsWith('/')).map(e => String(e.path))]
  let inside = false
  for (const r of roots) if (under(real, norm(r)) || under(real, await realPath(h, norm(r)))) inside = true
  if (!inside) return { ok: false, text: `${file} is outside ${thread}'s scratch folder, its worktrees and the desk reports folder: refused (write the deliverable to ${threadsDir(home)}/${thread}/scratch/ first)` }
  const dest = await destination(h, home, i.to ?? '')
  if (!('folder' in dest)) return { ok: false, text: dest.text }
  if (!(await h.fs.exists(dest.folder).catch(() => false))) return { ok: false, text: `${dest.label} does not exist` }
  const name = safeName(i.name ?? baseName(real))
  if (!name) return { ok: false, text: 'name must be a plain file name (no slash, not hidden)' }
  // the user's written instruction (a recorded human prompt of the last 24 h), or their answer to the canonical question
  const words = [...(await recentPrompts(h))].reverse().find(p => (FOLDERS.includes(dest.label) ? new RegExp(`(?<![\\w-])${dest.label}(?![\\w-])`, 'i').test(p.text) : p.text.includes(dest.folder) || p.text.includes(dest.folder.replace(home, '~'))) || /(?<![\w-])(save|put it in)(?![\w-])/i.test(p.text))
  const key = keyOf(thread, real, dest.folder)
  const okAt = Number(await h.store.get(OK_KEY(key)).catch(() => 0))
  const answered = okAt > 0 && (await h.clock.now()) - okAt <= OK_TTL_MS
  if (!words && !answered) {
    const q = deliverQuestion(thread, name, dest.label)
    const prev = await h.store.get(PENDING).catch(() => null)
    await h.store.set(PENDING, [...(Array.isArray(prev) ? prev : []).filter((p: any) => !(p?.thread === thread && p?.file === real && p?.to === (i.to ?? ''))), { thread, file: real, to: i.to ?? '', ...(i.name ? { name: i.name } : {}) }].slice(-5)).catch(() => undefined) // what the desk asked about: the answer is bound to it
    return { ok: false, text: `no written instruction from the user names ${dest.label} (or says "save" / "put it in"): ask with AskUserQuestion, question ${JSON.stringify(q.question)}, options exactly: ${q.options.map(o => `${o.label}: ${o.description}`).join(' | ')}. Then call deliver again. Nothing was copied`, data: { ask: q } }
  }
  const final = await freeName(h, dest.folder, name)
  if (!final) return { ok: false, text: `${dest.label} already holds ${name} and 98 numbered copies: refused` }
  const to = `${dest.folder}/${final}`
  const r = await h.process.run(['cp', '-n', '--', real, to], { timeoutMs: 60_000 }).catch((e: unknown) => ({ exitCode: 1, stdout: '', stderr: String((e as Error)?.message ?? e) }))
  if (r.exitCode !== 0) {
    const bad = String(r.stderr ?? '')
    return { ok: false, text: /operation not permitted|permission denied|EPERM|EACCES/i.test(bad) ? eperm(dest.label) : `copy to ${dest.label} failed: ${bad.trim().slice(0, 160) || `exit ${r.exitCode}`}` }
  }
  await h.store.set(OK_KEY(key), null).catch(() => undefined)
  await logHistory(h, thread, { kind: 'delivered', file: real, to, by: words ? 'your written words' : 'your answer', ...(words ? { quote: words.text.replace(/\s+/g, ' ').slice(0, 120) } : {}) })
  return { ok: true, text: `copied ${baseName(real)} to ${to}${final !== name ? ` (${name} existed: nothing was overwritten)` : ''}${words ? ` (your words: "${words.text.replace(/\s+/g, ' ').slice(0, 80)}")` : ''}. Tell the user the full path in one line` }
}

type Q = { question?: unknown; options?: unknown; multiSelect?: unknown }
// the desk's AskUserQuestion after the user answered it (the tool's own RESULT): the canonical question of a file that exists, the label "Save it" =
// that ONE copy is allowed for 30 minutes. Returns the lines for the desk.
export async function bindDeliverAnswers(h: Host, questions: unknown, answers: unknown): Promise<string[]> {
  const raw = await h.store.get(PENDING).catch(() => null)
  const pending = (Array.isArray(raw) ? raw : []).filter((p: any) => p && threadOk(p.thread) && typeof p.file === 'string' && typeof p.to === 'string') as { thread: string; file: string; to: string; name?: string }[]
  if (!pending.length) return []
  const qs: Q[] = Array.isArray(questions) ? (questions as Q[]) : []
  const given = answers && typeof answers === 'object' && !Array.isArray(answers) ? (answers as Record<string, unknown>) : null
  const notes: string[] = []
  const home = await homeDir(h)
  for (const q of qs) {
    const text = typeof q?.question === 'string' ? q.question : ''
    if (!/^Save .+ \(from t\d{1,9}\) to .+\?$/.test(text)) continue
    for (const p of pending) {
      const dest = await destination(h, home, p.to)
      const name = safeName(p.name ?? baseName(p.file))
      if (!('folder' in dest) || !name) continue
      const canon = deliverQuestion(p.thread, name, dest.label)
      const opts = Array.isArray(q.options) ? (q.options as { label?: unknown; description?: unknown }[]) : []
      if (text !== canon.question || q.multiSelect === true || opts.length !== canon.options.length || !canon.options.every((c, n) => opts[n]?.label === c.label && opts[n]?.description === c.description)) continue
      const a = given && typeof given[text] === 'string' ? (given[text] as string).trim() : ''
      if (a === SAVE_LABEL) {
        await h.store.set(OK_KEY(keyOf(p.thread, await realPath(h, norm(p.file)), dest.folder)), await h.clock.now())
        notes.push(`the user chose to save ${name} to ${dest.label}: call lean_thread deliver again with the same tN, file, to and name`)
      } else if (a === NO_LABEL) notes.push(`the user chose not to save ${name} to ${dest.label}: nothing is copied`)
    }
  }
  return notes
}
