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

export type DeliverIn = { tN?: string; file?: string; to?: string; name?: string }
export async function deliver(h: Host, i: DeliverIn): Promise<{ ok: boolean; text: string; data?: unknown }> {
  const thread = (i.tN ?? '').trim()
  if (!threadOk(thread)) return { ok: false, text: 'deliver needs tN (the thread that made the file)' }
  const home = await homeDir(h)
  if (!(await h.fs.exists(`${threadsDir(home)}/${thread}/thread.json`).catch(() => false))) return { ok: false, text: `no thread ${thread}` }
  const file = (i.file ?? '').trim()
  if (!file.startsWith('/')) return { ok: false, text: 'deliver needs file: an absolute path inside the thread\'s scratch folder, its worktree or the desk reports folder' }
  // the file: a real file, on its real path inside an allowed root
  const real = await realPath(h, norm(file))
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
