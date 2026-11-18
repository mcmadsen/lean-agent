// Doctor and 0.45 -> 1.0 migration: the login opener install, the desk folder, trust by real path, and the one-time
// conversion of the old state. Every step is idempotent; `migrate` writes ~/.lean-agent/migrated-1.0.json last.
import { appendJsonl, atomicWrite, deskDir, homeDir, leanDir, mkdirp, readJson, readJsonl, realPath, threadsDir, writeJson } from './state'
import type { Host } from './state'
import { trustFolder } from './threads'
import { withFolderLock } from './folderlock'
import { deskChoice, mergeModelSettings, readModelSettings } from './models'
import { setNotice } from './notices'
import { worktreeProjects } from './projects'
import { seenNames, skillStat } from './skilltrim'
import { compareVersions, installedVersion, running, skewText } from './skew'
import { modelMismatches } from './stats'

export const OLD_LABEL = 'com.lean-agent.up'
export const DESK_LABEL = 'com.lean-agent.desk'
const LEGACY = 'legacy-0.45'
const ISO = (ms: number) => new Date(ms).toISOString().slice(0, 10)

export const plist = () => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${DESK_LABEL}</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string>
    <string>exec "$HOME/.lean-agent/bin/open-desk.sh"</string></array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/tmp/lean-agent-desk.log</string>
  <key>StandardErrorPath</key><string>/tmp/lean-agent-desk.log</string>
</dict></plist>
`

async function run(h: Host, argv: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const r = await h.process.run(argv)
    return { ok: r.exitCode === 0, out: (r.stdout || '').trim() }
  } catch {
    return { ok: false, out: '' }
  }
}
const text = async (h: Host, p: string) => {
  try {
    const t = await h.fs.read(p)
    return typeof t === 'string' ? t : null
  } catch {
    return null
  }
}
const asObj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as any) : {})

// ---- install: desk folder, opener script, launch agent, trust ---------------------------------------------------
export type FixOut = { lines: string[] }
export async function fix(h: Host, root: string): Promise<FixOut> {
  const home = await homeDir(h)
  const lines: string[] = []
  await mkdirp(h, deskDir(home))
  lines.push('desk folder ready')
  const sh = await text(h, `${root}/opener/open-desk.sh`)
  if (sh === null) lines.push('opener script missing from the plugin: reinstall lean-agent')
  else {
    const dst = `${leanDir(home)}/bin/open-desk.sh`
    if ((await text(h, dst)) !== sh) await atomicWrite(h, dst, sh)
    await run(h, ['chmod', '755', dst])
    lines.push('opener script installed')
  }
  const mac = (await run(h, ['uname', '-s'])).out === 'Darwin'
  if (mac) {
    const file = `${home}/Library/LaunchAgents/${DESK_LABEL}.plist`
    if ((await text(h, file)) !== plist()) {
      await mkdirp(h, `${home}/Library/LaunchAgents`)
      await atomicWrite(h, file, plist())
      const uid = (await run(h, ['id', '-u'])).out
      if (uid) {
        await run(h, ['launchctl', 'bootout', `gui/${uid}/${DESK_LABEL}`])
        const b = await run(h, ['launchctl', 'bootstrap', `gui/${uid}`, file])
        lines.push(b.ok ? 'login opener loaded' : 'login opener written; it loads at next login')
      }
    } else lines.push('login opener already in place')
  } else lines.push('not macOS: no login opener (Claude Desktop is macOS/Windows only)')
  const want = await deskChoice(h, home)
  const pinned = await mergeModelSettings(h, `${deskDir(home)}/.claude/settings.json`, want)
  lines.push(pinned ? `desk pinned to ${want.model} / effort ${want.effort}` : 'desk .claude/settings.json does not parse: model not pinned, fix the file by hand')
  const trusted = await trustFolder(h, deskDir(home))
  lines.push(trusted ? 'desk folder trusted (real path)' : '~/.claude.json does not parse: desk folder not trusted, accept the dialog once')
  lines.push(...(await guardParents(h).catch(() => [] as string[]))) // a stale 0.45 guide above the thread folders moves aside
  try {
    for (const d of await h.fs.list(threadsDir(home))) if (d.kind === 'dir') await trustFolder(h, `${threadsDir(home)}/${d.name}`)
  } catch {
    /* no threads yet */
  }
  return { lines }
}

// ---- check ----------------------------------------------------------------------------------------------------
export async function check(h: Host, root: string): Promise<string[]> {
  const home = await homeDir(h)
  const out: string[] = []
  const row = (ok: boolean, what: string) => out.push(`${ok ? 'ok  ' : 'FIX '} ${what}`)
  const v = await run(h, ['claude', '--version'])
  row(v.ok, v.ok ? `claude ${v.out}` : 'claude is not on PATH')
  if (running.version) {
    const inst = await installedVersion(h, root)
    if (inst && compareVersions(inst, running.version) > 0) row(false, skewText(running.version, inst))
    else out.push(`ok   lean-agent code ${running.version}${inst ? ' = installed' : ' (installed version could not be read)'}`)
  }
  row(await h.fs.exists(deskDir(home)), 'desk folder ~/lean-agent-desk')
  const real = await realPath(h, deskDir(home))
  let doc: Record<string, any> = {}
  try {
    doc = asObj(JSON.parse((await text(h, `${home}/.claude.json`)) || '{}'))
  } catch {
    /* unreadable: reported as not trusted */
  }
  row(asObj(asObj(doc.projects)[real]).hasTrustDialogAccepted === true, 'desk folder trusted')
  const want = await deskChoice(h, home)
  const have = await readModelSettings(h, `${deskDir(home)}/.claude/settings.json`)
  const same = have?.model === want.model && have?.effort === want.effort
  const exists = await h.fs.exists(`${deskDir(home)}/.claude/settings.json`)
  row(same, same ? `desk model ${want.model} / effort ${want.effort}` : exists && have === null ? 'desk .claude/settings.json does not parse: fix the file by hand' : `desk model is ${have?.model ?? 'not set'} / effort ${have?.effort ?? 'not set'}, want ${want.model} / ${want.effort}`)
  const odd = await modelMismatches(h).catch(() => [] as string[])
  for (const m of odd) row(false, m)
  if (!odd.length) out.push('ok   no session on an unexpected model today')
  const sh = await text(h, `${leanDir(home)}/bin/open-desk.sh`)
  row(sh !== null && sh === (await text(h, `${root}/opener/open-desk.sh`)), 'opener script current')
  const mac = (await run(h, ['uname', '-s'])).out === 'Darwin'
  if (mac) row(await h.fs.exists(`${home}/Library/LaunchAgents/${DESK_LABEL}.plist`), 'launch agent installed')
  if (!mac) out.push('FIX  lean-agent 1.0 needs Claude Desktop (macOS)')
  const log = ((await text(h, `${leanDir(home)}/logs/opener.log`)) || '').trim().split('\n').pop()
  out.push(`last opener run: ${log || 'never'}`)
  row(await h.fs.exists(`${leanDir(home)}/migrated-1.0.json`) || !(await legacyPresent(h, home)), 'state is 1.0 (no 0.45 leftovers)')
  const alien = await foreignGuides(h)
  row(!alien.length, alien.length ? `CLAUDE.md that mentions lean-agent and 1.0 did not write (a thread or the desk may load it as memory; run fix to move one above the threads, or move a per-thread one by hand): ${alien.join(', ')}` : 'no foreign CLAUDE.md under ~/.lean-agent')
  const wtp = await worktreeProjects(h).catch(() => [])
  if (wtp.length) for (const w of wtp) out.push(`FIX  project ${w.name} (${w.path}) is a git worktree${w.of ? ` of ${w.of}` : ''} (${w.why}), not a project: unregister it with lean_thread project-remove ${w.name} (no file is deleted)`)
  else out.push('ok   no project entry is a git worktree')
  out.push(`desk skill listing: ${skillStat()}`)
  out.push(`seen this session - ${seenNames()}`)
  return out
}

async function legacyPresent(h: Host, home: string): Promise<boolean> {
  const lean = leanDir(home)
  for (const f of ['threads.json', 'service.json', 'my-questions.json']) if (await h.fs.exists(`${lean}/${f}`)) return true
  return false
}

// ---- versioned tidy: runs once per TIDY_VERSION for everyone (0.45 or already on 1.0.x), and again on `migrate` ------------------
// 0.45 left guide files that a thread or the desk loads as a PARENT-folder memory file and that tell it to use the removed
// `lean-agent` CLI, and current-thread.json (written by the 0.45 CLI; nothing in 1.0 reads it). They move to legacy-0.45/ (an
// earlier backup of the same name is kept: the new one gets a timestamp). Only a CLAUDE.md that 1.0 did not write (no GENERATED
// first lines) AND that mentions lean-agent is touched: a user's own notes stay. The version done lives in the mod's store.
export const TIDY_VERSION = 3 // 2: legacy-0.45/index.md; 3: parent guide re-check (guardParents)
const GENERATED = /generated by (the )?lean-agent/
// a CLAUDE.md 1.0 did not write that mentions lean-agent
const isForeign = (body: string | null): body is string => body !== null && !GENERATED.test(body.split('\n').slice(0, 3).join('\n')) && /lean-agent/i.test(body)
// What the 0.45 guide says of itself (its title, or the commands of the removed CLI). guardParents, which runs at every start, moves
// only such a file: a user's own memory file that merely mentions lean-agent stays where it is.
const OLD_GUIDE = /orchestrator guide|(?:^|[`$] ?|\n)\s*lean-agent (?:run|new|update|sync|doctor|worktree|todo|schedule|service|logs)\b|`lean-agent [a-z]+/i
const isOldGuide = (body: string | null): body is string => isForeign(body) && OLD_GUIDE.test(body)
// The one short file 1.0 keeps at the top of the thread folders: a stale guide that comes back is then noticed (it replaces nothing of
// the thread's own CLAUDE.md, which is generated per thread). About 40 tokens, loaded by every thread as parent memory.
export const GUARD_TEXT = '<!-- generated by lean-agent: thread folders take their instructions from their own CLAUDE.md; edits are overwritten -->\nOnly the CLAUDE.md in your own folder is your guide; any other lean-agent guide above it is stale: ignore it.\n'
// CLAUDE.md files above a thread's or a worktree's folder (loaded as parent memory), at the top of ~/.lean-agent, under each
// project folder, and each thread's own; the ones 1.0 did not write and that mention lean-agent
export async function foreignGuides(h: Host): Promise<string[]> {
  const home = await homeDir(h)
  const lean = leanDir(home)
  const cand = [`${lean}/CLAUDE.md`, `${threadsDir(home)}/CLAUDE.md`, `${lean}/worktrees/CLAUDE.md`]
  const dirs = (p: string) => h.fs.list(p).catch(() => [] as { name: string; kind: string }[])
  for (const t of await dirs(threadsDir(home))) if (t.kind === 'dir') cand.push(`${threadsDir(home)}/${t.name}/CLAUDE.md`)
  for (const p of await dirs(`${lean}/worktrees`)) if (p.kind === 'dir') cand.push(`${lean}/worktrees/${p.name}/CLAUDE.md`)
  for (const p of await dirs(lean)) if (p.kind === 'dir' && !['threads', 'worktrees', 'desk', 'legacy-0.45', 'memory', 'logs', 'githooks', 'bin'].includes(p.name)) cand.push(`${lean}/${p.name}/CLAUDE.md`)
  const out: string[] = []
  for (const f of cand) {
    if (isForeign(await text(h, f))) out.push(f)
  }
  return out
}

// `mv` to legacy-0.45/ (an earlier backup of the same name is kept: the new one gets a timestamp); the name moved, or null
async function moveAside(h: Host, f: string): Promise<string | null> {
  const lean = leanDir(await homeDir(h))
  const leg = `${lean}/${LEGACY}`
  await mkdirp(h, leg)
  let name = f.slice(lean.length + 1).replace(/\//g, '__')
  if (await h.fs.exists(`${leg}/${name}`)) name += `.${await h.clock.now()}`
  return (await run(h, ['mv', f, `${leg}/${name}`])).ok ? name : null
}

// NOT version gated, cheap, run at every session start of any role, before a thread is started by the desk and by `fix`: the parent
// CLAUDE.md files a thread folder inherits (a session reads them BEFORE the mod's session.start, so this must also run before the start)
// that 1.0 did not write move to legacy-0.45/, and the tiny guard file takes the threads folder's place. A user's own file that does
// not mention lean-agent is never touched.
export async function guardParents(h: Host): Promise<string[]> {
  const home = await homeDir(h)
  const lean = leanDir(home)
  const lines: string[] = []
  const moved: string[] = []
  for (const f of [`${lean}/CLAUDE.md`, `${threadsDir(home)}/CLAUDE.md`, `${lean}/worktrees/CLAUDE.md`]) {
    if (!isOldGuide(await text(h, f))) continue // (one read: a missing file is null)
    // two sessions starting together: the move is made under a lock and the file looked at again inside it
    const name = await withFolderLock(h, `${lean}/.guard-lock`, async () => (isOldGuide(await text(h, f)) ? moveAside(h, f) : null)).catch(() => null)
    if (name) { moved.push(name); lines.push(`stale 0.45 guide moved to ${LEGACY}: ${name}`) }
  }
  if (moved.length) {
    const done = await readJson<{ v?: number; moved?: string[] }>(h, `${lean}/tidy.json`, {})
    await writeJson(h, `${lean}/tidy.json`, { v: TIDY_VERSION, moved: [...(Array.isArray(done.moved) ? done.moved : []), ...moved] })
  }
  const guard = `${threadsDir(home)}/CLAUDE.md`
  const have = await text(h, guard)
  // written when absent (and the threads folder exists, or a stale file just left it), or when it is 1.0's own older text; a user's own file stays
  if (have === null ? moved.length > 0 || (await h.fs.exists(threadsDir(home)).catch(() => false)) : have !== GUARD_TEXT && GENERATED.test(have.split('\n').slice(0, 3).join('\n'))) await atomicWrite(h, guard, GUARD_TEXT)
  return lines
}
// ---- legacy-0.45/index.md: one line per old card (title, size, area guess) so `learn` can pick candidate facts ----------------
const MAX_CARDS = 400
const MAX_CARD_BYTES = 65_536
const wordsOf = (t: string) => t.replace(/[|\n\r]/g, ' ').replace(/\s+/g, ' ').trim()
// the card's own title: a JSON `title`/`name`, else the first Markdown heading or first line; the file name when nothing reads
function cardTitle(file: string, body: string): { title: string; area: string } {
  let title = ''
  let area = ''
  try {
    const j = JSON.parse(body)
    if (j && typeof j === 'object' && !Array.isArray(j)) {
      title = String(j.title ?? j.name ?? j.topic ?? '')
      area = String(j.area ?? j.scope ?? (Array.isArray(j.paths) ? j.paths[0] : j.paths ?? j.path ?? '') ?? '')
    }
  } catch {
    /* not JSON: Markdown */
  }
  if (!title) title = /^#+\s*(.+)$/m.exec(body)?.[1] ?? body.split('\n').find(l => l.trim()) ?? ''
  if (!area) area = /(?:^|[\s`(])((?:[\w.@-]+\/)+[\w.@-]+\.\w+|(?:[\w.@-]+\/){2,})/.exec(body)?.[1] ?? '' // the first file path (or a deep folder) the card names; prose like and/or is no area
  const first = area.replace(/^\.?\//, '').split('/')[0] ?? ''
  return { title: wordsOf(title).slice(0, 80) || file.replace(/\.[^.]+$/, ''), area: first && !first.includes('*') ? first : '?' }
}
// Writes legacy-0.45/index.md from the cards-<project>/ folders there; returns a line for the migration/tidy report ('' = no cards).
export async function legacyIndex(h: Host): Promise<string> {
  const home = await homeDir(h)
  const leg = `${leanDir(home)}/${LEGACY}`
  const rows: string[] = []
  let n = 0
  for (const d of (await h.fs.list(leg).catch(() => [])).filter(x => x.kind === 'dir' && x.name.startsWith('cards-')).sort((a, b) => a.name.localeCompare(b.name))) {
    const project = d.name.slice(6)
    const cards: string[] = []
    for (const f of (await h.fs.list(`${leg}/${d.name}`).catch(() => [])).filter(x => x.kind === 'file').sort((a, b) => a.name.localeCompare(b.name))) {
      if (++n > MAX_CARDS) break
      const size = Number((await h.fs.stat(`${leg}/${d.name}/${f.name}`).catch(() => null))?.size) || 0
      const body = size > MAX_CARD_BYTES ? '' : ((await text(h, `${leg}/${d.name}/${f.name}`)) ?? '') // a huge card is listed by name, not read
      const c = cardTitle(f.name, body)
      cards.push(`- ${f.name} | ${c.title} | ${size || new TextEncoder().encode(body).length} bytes | area? ${c.area}`)
    }
    if (cards.length) rows.push(`## ${project}`, `Folder: ~/.lean-agent/${LEGACY}/${d.name}/`, ...cards, '')
  }
  if (!rows.length) return ''
  const head = ['# 0.45 cards (read-only archive)', '', 'Candidate facts for the learn skill, not rules: read the ones for the area you are learning, check every claim against the code,', 'drop hashes, PR/branch status, sizes, counts, dates, diaries and file:line cites. One line per card: file | title | size | area guess.', '']
  const md = [...head, ...rows].join('\n')
  if ((await text(h, `${leg}/index.md`)) !== md) await atomicWrite(h, `${leg}/index.md`, md)
  return `legacy cards indexed in ${LEGACY}/index.md (${Math.min(n, MAX_CARDS)} card(s))`
}

export async function tidyLegacy(h: Host, force = false): Promise<string[]> {
  const home = await homeDir(h)
  const lean = leanDir(home)
  if (!force && (await h.store.get('tidy.v').catch(() => undefined)) === TIDY_VERSION) return []
  const lines: string[] = []
  const leg = `${lean}/${LEGACY}`
  const done = await readJson<{ v?: number; moved?: string[] }>(h, `${lean}/tidy.json`, {})
  const moved: string[] = []
  const targets = [...(await foreignGuides(h)).filter(f => !/\/threads\/t\d+\/CLAUDE\.md$/.test(f)), ...((await h.fs.exists(`${lean}/current-thread.json`)) ? [`${lean}/current-thread.json`] : [])]
  for (const f of targets) {
    const name = await moveAside(h, f)
    if (name) moved.push(name)
  }
  if (moved.length) {
    lines.push(`0.45 leftovers moved to ${LEGACY}: ${moved.join(', ')}`)
    await writeJson(h, `${lean}/tidy.json`, { v: TIDY_VERSION, moved: [...(Array.isArray(done.moved) ? done.moved : []), ...moved] })
  }
  const idx = await legacyIndex(h).catch(() => '') // for everyone, also for people migrated before 1.0.6
  if (idx) lines.push(idx)
  if (moved.length === targets.length) await h.store.set('tidy.v', TIDY_VERSION).catch(() => undefined) // a failed move is tried again at the next start
  return lines
}

// ---- migrate --------------------------------------------------------------------------------------------------
export type Migrated = { done: boolean; already?: boolean; lines: string[] }
export async function migrate(h: Host, root: string): Promise<Migrated> {
  const home = await homeDir(h)
  const lean = leanDir(home)
  const flag = `${lean}/migrated-1.0.json`
  if (await h.fs.exists(flag)) {
    await setNotice(h, 'migrate', null)
    return { done: true, already: true, lines: ['already migrated', ...(await tidyLegacy(h, true).catch(() => [] as string[]))] }
  }
  const lines: string[] = []
  const leg = `${lean}/${LEGACY}`
  await mkdirp(h, leg)
  const now = await h.clock.now()
  const move = async (from: string, name: string) => {
    if (!(await h.fs.exists(from))) return false
    const r = await run(h, ['mv', '-f', from, `${leg}/${name}`])
    return r.ok
  }
  const names = await h.fs.list(lean).catch(() => [] as { name: string; kind: string }[])

  // goals: open, thread-less ones only (a goal belongs to its thread, and every 0.45 thread is closed below)
  const g0 = asObj(await readJson<unknown>(h, `${lean}/goals.json`, {}))
  if (Array.isArray(g0.items)) {
    await writeJson(h, `${leg}/goals.json`, g0)
    const goals: Record<string, { text: string; ts: number }> = {}
    const OPEN = ['active', 'waiting-user', 'stuck', 'blocked']
    for (const g of g0.items as any[]) {
      if (!g || !OPEN.includes(g.state) || g.thread) continue
      const text0 = String(g.next || g.ref || '').trim()
      if (text0) goals[`g${String(g.id ?? Object.keys(goals).length + 1).replace(/^\D+/, '')}`] = { text: text0, ts: now }
    }
    await writeJson(h, `${lean}/goals.json`, goals)
    lines.push(`goals: ${Object.keys(goals).length} open kept, old file archived`)
  }

  // questions to the user: open ones addressed to the desk
  const q0 = asObj(await readJson<unknown>(h, `${lean}/my-questions.json`, {}))
  if (Array.isArray(q0.items)) {
    const have = (await readJsonl<{ question?: string }>(h, `${lean}/questions.jsonl`)).map(r => r.question)
    let n = 0
    for (const q of q0.items as any[]) {
      if (!q || q.status !== 'open' || q.target !== 'main' || !String(q.text || '').trim() || have.includes(String(q.text))) continue
      await appendJsonl(h, `${lean}/questions.jsonl`, { ts: Math.round(Number(q.ts) * (Number(q.ts) < 1e12 ? 1000 : 1)) || now, from: 'main', question: String(q.text), options: [], answered: false })
      // 0.45 questions to 'main' have no thread to answer them: they are closed here, in answers.jsonl, at migration
      const id = (await readJsonl(h, `${lean}/questions.jsonl`)).length
      await appendJsonl(h, `${lean}/answers.jsonl`, { ts: now, q: id, thread: 'main', text: 'closed at migration from 0.45' })
      n++
    }
    await move(`${lean}/my-questions.json`, 'my-questions.json')
    lines.push(`questions: ${n} migrated (closed: no thread to answer)`)
  }
  await move(`${lean}/waiting.json`, 'waiting.json')

  // threads: all closed (user decision). Nothing is converted; a readable summary stays in the legacy folder.
  const t0 = asObj(await readJson<unknown>(h, `${lean}/threads.json`, {}))
  const ts = Object.values(asObj(t0.threads)).filter((t: any) => t && t.id && t.id !== 'main')
  if (ts.length) {
    const md = ['# 0.45 threads closed by the 1.0 migration', '', ...ts.map((t: any) => `- ${t.id} ${String(t.title || '')} (created ${String(t.created || '').slice(0, 10)})${(t.notes || []).length ? ': ' + String((t.notes as string[]).slice(-1)[0]).slice(0, 200) : ''}`)]
    await atomicWrite(h, `${leg}/closed-threads.md`, md.join('\n') + '\n')
  }
  await move(`${lean}/threads.json`, 'threads.json')
  lines.push(`threads: ${ts.length} old thread(s) closed, none carried over`)

  // recipes -> <project>/skills/<name>/SKILL.md ; cards -> legacy (learn <project> rebuilds them as rules)
  let skills = 0
  const learn: string[] = []
  for (const f of await h.fs.list(`${lean}/recipes`).catch(() => [])) {
    const m = /^([A-Za-z0-9._-]+)\.json$/.exec(f.name)
    if (!m) continue
    const store = asObj(await readJson<unknown>(h, `${lean}/recipes/${f.name}`, {}))
    for (const [name, r0] of Object.entries(store)) {
      const r = asObj(r0)
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || !String(r.task || '').trim()) continue
      const tools = r.read_only ? '\nallowed-tools: Read, Grep, Glob' : ''
      const body = `---\nname: ${name}\ndescription: ${String(r.why || name).replace(/\s+/g, ' ').slice(0, 200)}\nmodel: ${String(r.model || 'sonnet')}${tools}\n---\n\n${String(r.task).trim()}\n`
      await atomicWrite(h, `${lean}/${m[1]}/skills/${name}/SKILL.md`, body)
      skills++
    }
  }
  if (await h.fs.exists(`${lean}/recipes`)) await move(`${lean}/recipes`, 'recipes')
  for (const d of names) {
    if (d.kind !== 'dir' || [LEGACY, 'threads', 'desk', 'bin', 'logs', 'memory', 'recipes'].includes(d.name)) continue
    if (await h.fs.exists(`${lean}/${d.name}/cards`)) {
      await move(`${lean}/${d.name}/cards`, `cards-${d.name}`)
      learn.push(d.name)
    }
  }
  lines.push(`recipes: ${skills} converted to skills`)
  if (learn.length) lines.push(`cards moved to ${LEGACY}; run the learn skill for: ${learn.join(', ')}`)
  const idx = await legacyIndex(h).catch(() => '')
  if (idx) lines.push(idx)

  // legacy files and the old service
  const old = ['service.json', 'up.json', 'desk.json', 'windows.json', 'session-cap.json', 'current-thread.json']
  for (const d of names) if (d.kind === 'file' && (old.includes(d.name) || d.name.endsWith('.lock') || /^(self-)?update/.test(d.name))) await move(`${lean}/${d.name}`, d.name)
  const plistOld = `${home}/Library/LaunchAgents/${OLD_LABEL}.plist`
  if (await h.fs.exists(plistOld)) {
    const uid = (await run(h, ['id', '-u'])).out
    if (uid) await run(h, ['launchctl', 'bootout', `gui/${uid}/${OLD_LABEL}`])
    await move(plistOld, `${OLD_LABEL}.plist`)
    lines.push('old com.lean-agent.up service unloaded and its plist archived')
  }
  // Linux: the 0.45 systemd user unit is switched off and archived (1.0 is macOS-only); tolerant when systemctl is absent
  const unit = `${home}/.config/systemd/user/lean-agent.service`
  if (await h.fs.exists(unit)) {
    const off = await run(h, ['systemctl', '--user', 'disable', '--now', 'lean-agent.service'])
    await move(unit, 'lean-agent.service')
    lines.push(off.ok ? 'old lean-agent.service (systemd user unit) disabled and archived' : 'old lean-agent.service archived; systemctl --user disable --now failed or is missing: stop it by hand if it still runs')
  }
  for (const p of [`${home}/.local/bin/lean-agent`, '/opt/homebrew/bin/lean-agent', '/usr/local/bin/lean-agent']) {
    if (!(await h.fs.exists(p))) continue
    const real = await realPath(h, p)
    const body = (await text(h, p)) || ''
    if (/\/lean-agent\//.test(real) || /lean_agent|lean-agent/.test(body)) {
      if ((await run(h, ['rm', '-f', p])).ok) lines.push(`removed the old lean-agent command shim (${p.replace(home, '~')}); 1.0 has no CLI`)
    }
  }

  lines.push(...(await tidyLegacy(h, true).catch(() => [] as string[])))
  const f = await fix(h, root)
  lines.push(...f.lines)
  await writeJson(h, flag, { at: now, date: ISO(now), threadsClosed: ts.length, learn })
  await setNotice(h, 'migrate', null)
  return { done: true, lines }
}

// ---- automatic cleanup of leftover 0.45 state (first session.start of the 1.0 mod, any local session) --------------
// `claude plugin update` removes the 0.45 files, but the KeepAlive launch agent / Restart=always unit stays registered and would
// crash-loop against the removed shim. So the old service is unloaded FIRST (tolerant), then the idempotent migrate runs;
// if that fails the user gets a notice (pane + status line). Everything is logged to ~/.lean-agent/logs/migrate.jsonl.
export const MIGRATE_NOTICE = 'lean-agent 1.0: run migrate in the desk'
export async function leftover45(h: Host): Promise<string[]> {
  const home = await homeDir(h)
  const found: string[] = []
  if (await h.fs.exists(`${home}/Library/LaunchAgents/${OLD_LABEL}.plist`)) found.push('launch agent')
  if (await h.fs.exists(`${home}/.config/systemd/user/lean-agent.service`)) found.push('systemd unit')
  if (await h.fs.exists(`${leanDir(home)}/up.json`)) found.push('up.json')
  for (const p of [`${home}/.local/bin/lean-agent`, '/opt/homebrew/bin/lean-agent', '/usr/local/bin/lean-agent'])
    if (await h.fs.exists(p)) {
      const body = (await text(h, p)) || ''
      if (/lean_agent|lean-agent/.test(body) || /\/lean-agent\//.test(await realPath(h, p))) found.push('command shim')
    }
  return found
}

export async function autoMigrate(h: Host, root: string): Promise<{ found: string[]; lines: string[] }> {
  const home = await homeDir(h)
  const lean = leanDir(home)
  const found = await leftover45(h)
  const migrated = await h.fs.exists(`${lean}/migrated-1.0.json`)
  const guard = () => guardParents(h).catch(() => [] as string[]) // every start, outside the tidy.v gate
  if (!found.length && (migrated || !(await legacyPresent(h, home)))) {
    await setNotice(h, 'migrate', null)
    const t = await tidyLegacy(h).catch(() => [] as string[]) // for everyone, also on 1.0.x
    return { found, lines: [...t, ...(await guard())] }
  }
  const lines: string[] = []
  if (found.includes('launch agent')) {
    const uid = (await run(h, ['id', '-u'])).out
    const r = uid ? await run(h, ['launchctl', 'bootout', `gui/${uid}/${OLD_LABEL}`]) : { ok: false }
    lines.push(r.ok ? 'old launch agent unloaded' : 'old launch agent: launchctl bootout failed or it was not loaded')
  }
  if (found.includes('systemd unit')) {
    const r = await run(h, ['systemctl', '--user', 'disable', '--now', 'lean-agent.service'])
    lines.push(r.ok ? 'old systemd unit disabled' : 'old systemd unit: systemctl --user disable --now failed')
  }
  lines.push(...(await tidyLegacy(h).catch(() => [] as string[]))) // after the old service is unloaded
  lines.push(...(await guard()))
  let error = ''
  try {
    const m = await migrate(h, root)
    lines.push(...m.lines)
    await setNotice(h, 'migrate', null)
  } catch (e) {
    error = String((e as Error)?.message ?? e).slice(0, 200)
    await setNotice(h, 'migrate', MIGRATE_NOTICE)
  }
  await appendJsonl(h, `${lean}/logs/migrate.jsonl`, { ts: await h.clock.now(), found, lines, error }).catch(() => undefined)
  return { found, lines }
}
