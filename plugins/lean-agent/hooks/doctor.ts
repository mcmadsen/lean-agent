// Doctor and 0.45 -> 1.0 migration: the login opener install, the desk folder, trust by real path, and the one-time
// conversion of the old state. Every step is idempotent; `migrate` writes ~/.lean-agent/migrated-1.0.json last.
import { appendJsonl, atomicWrite, deskDir, homeDir, leanDir, mkdirp, readJson, readJsonl, realPath, threadsDir, writeJson } from './state'
import type { Host } from './state'
import { trustFolder } from './threads'
import { setNotice } from './notices'

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
  const trusted = await trustFolder(h, deskDir(home))
  lines.push(trusted ? 'desk folder trusted (real path)' : '~/.claude.json does not parse: desk folder not trusted, accept the dialog once')
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
  row(await h.fs.exists(deskDir(home)), 'desk folder ~/lean-agent-desk')
  const real = await realPath(h, deskDir(home))
  let doc: Record<string, any> = {}
  try {
    doc = asObj(JSON.parse((await text(h, `${home}/.claude.json`)) || '{}'))
  } catch {
    /* unreadable: reported as not trusted */
  }
  row(asObj(asObj(doc.projects)[real]).hasTrustDialogAccepted === true, 'desk folder trusted')
  const sh = await text(h, `${leanDir(home)}/bin/open-desk.sh`)
  row(sh !== null && sh === (await text(h, `${root}/opener/open-desk.sh`)), 'opener script current')
  if ((await run(h, ['uname', '-s'])).out === 'Darwin') row(await h.fs.exists(`${home}/Library/LaunchAgents/${DESK_LABEL}.plist`), 'launch agent installed')
  if ((await run(h, ['uname', '-s'])).out !== 'Darwin') out.push('FIX  lean-agent 1.0 needs Claude Desktop (macOS)')
  const log = ((await text(h, `${leanDir(home)}/logs/opener.log`)) || '').trim().split('\n').pop()
  out.push(`last opener run: ${log || 'never'}`)
  row(await h.fs.exists(`${leanDir(home)}/migrated-1.0.json`) || !(await legacyPresent(h, home)), 'state is 1.0 (no 0.45 leftovers)')
  return out
}

async function legacyPresent(h: Host, home: string): Promise<boolean> {
  const lean = leanDir(home)
  for (const f of ['threads.json', 'service.json', 'my-questions.json']) if (await h.fs.exists(`${lean}/${f}`)) return true
  return false
}

// ---- migrate --------------------------------------------------------------------------------------------------
export type Migrated = { done: boolean; already?: boolean; lines: string[] }
export async function migrate(h: Host, root: string): Promise<Migrated> {
  const home = await homeDir(h)
  const lean = leanDir(home)
  const flag = `${lean}/migrated-1.0.json`
  if (await h.fs.exists(flag)) {
    await setNotice(h, 'migrate', null)
    return { done: true, already: true, lines: ['already migrated'] }
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

  // legacy files and the old service
  const old = ['service.json', 'up.json', 'desk.json', 'windows.json', 'session-cap.json']
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
  if (!found.length && (migrated || !(await legacyPresent(h, home)))) {
    await setNotice(h, 'migrate', null)
    return { found, lines: [] }
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
