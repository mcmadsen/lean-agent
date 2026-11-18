import { appendJsonl, atomicWrite, homeDir, leanDir, mkdirp, readJson, readJsonl, realPath, threadsDir, writeJson } from './state'
import type { Host } from './state'
import { unconsumed, wakeMark } from './delivery'
import { projectsAction, unknownProject } from './projects'
import { settingsKeys, threadChoice } from './models'
import type { Choice } from './models'
import { ensureGitHooks, gitEnv } from './githooks'

export const WAKE_GAP_MS = 30_000

export type ThreadState = 'open' | 'parked' | 'closing' | 'closed'
export type Thread = {
  id: string
  title: string
  project: string
  state: ThreadState
  sid: string // the background session's id, empty until started
  created: number
  lastWake: number // ms of the last start/wake, 0 = never
  delivered: number // inbox.jsonl lines already handed to the session
  model?: string // haiku | sonnet | opus, as started (a resume keeps the session's saved options)
  effort?: string // low | medium | high
}
export type Inbox = { ts: number; text: string; from?: string }

// ---- `claude agents --json [--all]` -------------------------------------------------------------------------
// Fields used (Claude Code 2.1.x prints an array): sessionId, name, cwd, status ("idle" | "busy" | ...), startedAt (ms),
// kind, pid. Tolerated: a wrapper object ({agents|sessions|items: [...]}), snake_case ids (session_id, id), stray
// non-object entries, damaged JSON (-> []).
export type AgentRow = { sid: string; name: string; cwd: string; status: string; startedAt: number; pid: number; id: string }

export function parseAgents(text: string): AgentRow[] {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return []
  }
  const list = Array.isArray(v) ? v : v && typeof v === 'object' ? ((v as any).agents ?? (v as any).sessions ?? (v as any).items) : null
  if (!Array.isArray(list)) return []
  const out: AgentRow[] = []
  for (const r of list) {
    if (!r || typeof r !== 'object') continue
    const sid = String(r.sessionId ?? r.session_id ?? r.id ?? '')
    if (!sid) continue
    out.push({
      sid,
      name: String(r.name ?? ''),
      cwd: String(r.cwd ?? ''),
      status: String(r.status ?? r.state ?? '').toLowerCase(),
      startedAt: Number(r.startedAt ?? r.started_at ?? 0) || 0,
      pid: Number(r.pid) || 0, // a listed process: set while the background process is alive, absent once it exited
      id: String(r.id ?? ''),
    })
  }
  return out
}

// Only these mean "no live work": anything else (busy, running, waiting, an unknown word) counts as running,
// so an uncertain session is never resumed (a resume of a running session forks it).
const IDLE = new Set(['idle', 'done', 'completed', 'complete', 'finished', 'stopped', 'exited', 'failed', 'error', 'dead'])
export const isRunning = (r: AgentRow | undefined) => !!r && !IDLE.has(r.status)

// null = the listing failed or was not JSON: the caller must not treat that as "nothing is running"
async function agents(h: Host): Promise<AgentRow[] | null> {
  const r = await h.process.run(['claude', 'agents', '--json', '--all'])
  if (r.exitCode !== 0) return null
  try {
    JSON.parse(r.stdout)
  } catch {
    return null
  }
  return parseAgents(r.stdout)
}

// ---- trust ---------------------------------------------------------------------------------------------------
// ~/.claude.json projects[<real path>].hasTrustDialogAccepted = true. Only that key; atomic; every other key is kept.
// A file that does not parse is left alone (never overwritten with a guess).
export async function trustFolder(h: Host, folder: string): Promise<boolean> {
  const file = `${await homeDir(h)}/.claude.json`
  let text = ''
  if (await h.fs.exists(file)) {
    // present but unreadable (or not text): refuse, never overwrite with a guess
    try {
      const t = await h.fs.read(file)
      if (typeof t !== 'string') return false
      text = t
    } catch {
      return false
    }
  }
  let doc: any = {}
  if (text.trim()) {
    try {
      doc = JSON.parse(text)
    } catch {
      return false
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false
  }
  const real = await realPath(h, folder)
  const projects = doc.projects && typeof doc.projects === 'object' ? doc.projects : {}
  const entry = projects[real] && typeof projects[real] === 'object' ? projects[real] : {}
  if (entry.hasTrustDialogAccepted === true) return true
  doc.projects = { ...projects, [real]: { ...entry, hasTrustDialogAccepted: true } }
  await atomicWrite(h, file, JSON.stringify(doc, null, 2) + '\n')
  return true
}

// ---- templates -----------------------------------------------------------------------------------------------
const fill = (t: string, vars: Record<string, string>) => t.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '')

export async function threadSettings(h: Host, id: string, hooks = true, choice?: Choice): Promise<string> {
  const lean = leanDir(await homeDir(h))
  // Edit/Write/Bash without asking, inside the lean-agent folder (which holds the worktrees); nothing global.
  const abs = `//${lean.replace(/^\//, '')}`
  return JSON.stringify(
    {
      permissions: {
        allow: ['Bash', `Edit(${abs}/**)`, `Write(${abs}/**)`],
        additionalDirectories: [lean],
      },
      // git itself refuses a push from a private project (githooks.ts); without working wrappers core.hooksPath is not set,
      // so the repo's own hooks keep running (the failure shows as a notice)
      ...(hooks ? { env: gitEnv(await homeDir(h)) } : {}),
      ...(choice ? settingsKeys(choice) : {}), // a session opened in the folder from the app matches
    },
    null,
    2,
  ) + '\n'
}

async function template(h: Host, root: string, name: string): Promise<string> {
  const t = await h.fs.read(`${root}/templates/${name}`)
  return typeof t === 'string' ? t : ''
}

export async function deskClaudeMd(h: Host, root: string): Promise<string> {
  return fill(await template(h, root, 'front-desk.md'), { lean: leanDir(await homeDir(h)) })
}

// ---- the tool ------------------------------------------------------------------------------------------------
export type Input = { action: string; tN?: string; text?: string; title?: string; project?: string; model?: string; effort?: string; path?: string; on?: boolean; all?: boolean; confirm?: boolean }
export type Out = { ok: boolean; text: string; data?: unknown }

const err = (text: string): Out => ({ ok: false, text })
const tpath = (home: string, id: string) => `${threadsDir(home)}/${id}`
const ID = /^t\d+$/

const locks = new Map<string, Promise<unknown>>()
// One action at a time per thread: two quick sends cannot both pass the 30 s check.
function serial<T>(id: string, f: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve()
  const next = prev.then(f, f)
  locks.set(id, next.catch(() => undefined))
  return next
}
export const resetLocks = () => locks.clear()

async function load(h: Host, home: string, id: string): Promise<Thread | null> {
  const t = await readJson<Thread | null>(h, `${tpath(home, id)}/thread.json`, null)
  return t && t.id === id ? t : null
}
const save = (h: Host, home: string, t: Thread) => writeJson(h, `${tpath(home, t.id)}/thread.json`, t)

async function nextId(h: Host, home: string): Promise<string> {
  let max = 0
  try {
    for (const e of await h.fs.list(threadsDir(home))) {
      const m = /^t(\d+)$/.exec(e.name)
      if (m) max = Math.max(max, Number(m[1]))
    }
  } catch {
    /* no threads yet */
  }
  return `t${max + 1}`
}

const label = (t: Thread) => `${t.id} · ${t.title}`

function batchPrompt(msgs: Inbox[]): string {
  return msgs.map(m => (m.from ? `[${m.from}] ` : '') + m.text).join('\n\n')
}

async function startSession(h: Host, home: string, t: Thread, prompt: string, given: { model?: string; effort?: string } = {}): Promise<Out> {
  const folder = tpath(home, t.id)
  const choice = await threadChoice(h, home, given, t)
  if (typeof choice === 'string') return err(choice)
  t.model = choice.model
  t.effort = choice.effort
  const hooks = await ensureGitHooks(h).then(() => true, () => false)
  await h.fs.write(`${folder}/.claude/settings.json`, await threadSettings(h, t.id, hooks, choice))
  const r = await h.process.run(['claude', '--bg', '-n', label(t), '--model', choice.model, '--effort', choice.effort, '--', prompt], { cwd: folder, timeoutMs: 120_000 })
  if (r.exitCode !== 0) return err(`claude --bg failed: ${(r.stderr || r.stdout).slice(0, 300)}`)
  let sid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(r.stdout + '\n' + r.stderr)?.[0] ?? ''
  if (!sid) {
    const rows = ((await agents(h)) ?? []).filter(a => a.cwd === folder || a.name === label(t))
    rows.sort((a, b) => b.startedAt - a.startedAt)
    sid = rows[0]?.sid ?? ''
  }
  t.sid = sid
  t.lastWake = await h.clock.now()
  await save(h, home, t)
  return sid ? { ok: true, text: `${t.id} started (${sid})` } : { ok: true, text: `${t.id} started, but its session id was not found; list will retry` }
}

async function create(h: Host, root: string, home: string, i: Input): Promise<Out> {
  const title = (i.title ?? '').trim()
  if (!title) return err('new needs a title')
  const pre = await threadChoice(h, home, i)
  if (typeof pre === 'string') return err(pre) // a bad model/effort stops here, before any folder exists
  const project = (i.project ?? '').trim()
  if (project) {
    const bad = await unknownProject(h, project) // before any folder exists
    if (bad) return err(bad)
  }
  const id = await nextId(h, home)
  const dir = tpath(home, id)
  await mkdirp(h, dir)
  const t: Thread = { id, title, project, state: 'open', sid: '', created: await h.clock.now(), lastWake: 0, delivered: 0 }
  const vars = { id, title, project: t.project, lean: leanDir(home) }
  await h.fs.write(`${dir}/CLAUDE.md`, fill(await template(h, root, 'thread.md'), vars))
  const hooks = await ensureGitHooks(h).then(() => true, () => false)
  await h.fs.write(`${dir}/.claude/settings.json`, await threadSettings(h, id, hooks, pre))
  const brief = (i.text ?? '').trim() || title
  await h.fs.write(`${dir}/brief.md`, brief + '\n')
  await save(h, home, t)
  await trustFolder(h, dir)
  const r = await startSession(h, home, t, brief, i)
  return r.ok ? { ...r, data: t } : r
}

async function pending(h: Host, home: string, t: Thread): Promise<Inbox[]> {
  return (await unconsumed(h, home, t.id)).msgs
}

// Resume the thread's session with the queued batch, unless it is running (never resume a running session)
// or was woken less than 30 s ago (the batch stays queued for the next wake).
async function wake(h: Host, home: string, t: Thread, opts: { force?: boolean; lead?: string } = {}): Promise<Out> {
  if (t.state !== 'open') return { ok: true, text: `${t.id} is ${t.state}: message queued, no wake` }
  if (!t.sid) return { ok: true, text: `${t.id} has no session yet: queued; use start` }
  const u = await unconsumed(h, home, t.id) // one read: the messages and the position they end at
  const msgs = u.msgs
  if (!msgs.length && !opts.force) return { ok: true, text: `${t.id}: nothing queued` }
  const listed = await agents(h)
  if (!listed) return err(`${t.id}: cannot list sessions (claude agents failed), so it is not resumed; messages stay queued`)
  const row = listed.find(a => a.sid === t.sid)
  if (isRunning(row)) return { ok: true, text: `${t.id} is running: ${msgs.length} message(s) queued, it reads them itself` }
  const now = await h.clock.now()
  if (t.lastWake && now - t.lastWake < WAKE_GAP_MS) return { ok: true, text: `${t.id} was woken ${Math.round((now - t.lastWake) / 1000)} s ago: queued for the next wake` }
  // `claude --bg --resume` continues the session itself only once its process has exited; while the process still lives (finished,
  // idle) the same command starts a copy. So a finished-but-alive one is stopped first (never a working one), then resumed.
  if (row && row.pid > 0) {
    // (a working or unknown status was handled above: only a finished or dead session with a lingering process gets here)
    const fresh = (await agents(h))?.find(a => a.sid === t.sid) // look again right before stopping: never stop live work
    if (!fresh) return err(`${t.id}: cannot list sessions (claude agents failed), so it is not resumed; messages stay queued`)
    if (isRunning(fresh)) return { ok: true, text: `${t.id} is running again: ${msgs.length} message(s) queued, no stop, no resume` }
    const short = fresh.id || t.sid.slice(0, 8)
    if (fresh.pid > 0) {
      const st = await h.process.run(['claude', 'stop', short])
      if (st.exitCode !== 0) return err(`${t.id}: claude stop ${short} failed (${(st.stderr || st.stdout).trim().slice(0, 200)}): not resumed, messages stay queued`)
      let gone = false
      let listed = false
      for (let n = 0; n < 8 && !gone; n++) {
        const l = await agents(h)
        if (l) listed = true
        const cur = l?.find(a => a.sid === t.sid)
        gone = !!l && (!cur || cur.pid === 0)
        if (!gone && n < 7) await h.process.run(['sleep', '1'])
      }
      if (!gone) return err(listed ? `${t.id}: the session is still running after claude stop ${short}: not resumed, messages stay queued` : `${t.id}: could not confirm the stop (claude agents failed): not resumed, messages stay queued`)
    }
  }
  const upTo = u.upTo
  const prompt = [opts.lead, batchPrompt(msgs), wakeMark(upTo)].filter(Boolean).join('\n\n')
  const r = await h.process.run(['claude', '--bg', '--resume', t.sid, '--', prompt], { cwd: tpath(home, t.id), timeoutMs: 120_000 })
  if (r.exitCode !== 0) return err(`claude --bg --resume failed: ${(r.stderr || r.stdout).slice(0, 300)}`)
  // safety net: the CLI prints "started a copy as <id>" when it forked after all; the thread follows the copy
  const after = (await agents(h)) ?? []
  const copy = /started a copy as\s+([0-9a-f][0-9a-f-]{5,})/i.exec(`${r.stdout}\n${r.stderr ?? ''}`)?.[1]?.toLowerCase()
  const hits = copy ? after.filter(a => a.sid.toLowerCase() === copy || a.sid.toLowerCase().startsWith(copy)) : []
  const copied = hits.length === 1 ? hits[0]!.sid : copy && copy.length >= 32 ? copy : undefined
  if (copied) t.sid = copied
  t.lastWake = now
  t.delivered = upTo
  await save(h, home, t)
  return { ok: true, text: `${t.id} woken with ${msgs.length} message(s)${copied ? `; the CLI started a copy, the thread now follows session ${copied.slice(0, 8)}` : copy ? `; the CLI started a copy as ${copy}, which ${hits.length > 1 ? 'matches several sessions' : 'is not in the session list yet'}: the thread keeps its old session id, check ${t.id} with threads` : ''}` }
}

async function list(h: Host, home: string): Promise<Out> {
  const rows = (await agents(h)) ?? []
  const out: unknown[] = []
  let ents: { name: string }[] = []
  try {
    ents = await h.fs.list(threadsDir(home))
  } catch {
    /* none */
  }
  for (const e of ents.filter(x => ID.test(x.name)).sort((a, b) => Number(a.name.slice(1)) - Number(b.name.slice(1)))) {
    const t = await load(h, home, e.name)
    if (!t) continue
    const q = (await pending(h, home, t)).length
    out.push({ id: t.id, title: t.title, project: t.project, model: t.model, effort: t.effort, state: t.state, running: isRunning(rows.find(a => a.sid === t.sid)), sid: t.sid, queued: q })
  }
  const text = out.length ? (out as any[]).map(o => `${o.id} · ${o.title}${o.project ? ` · ${o.project}` : ''} [${o.state}${o.running ? ', running' : ''}${o.queued ? `, ${o.queued} queued` : ''}]${o.model ? ` · ${o.model}/${o.effort}` : ''}`).join('\n') : 'no threads'
  return { ok: true, text, data: out }
}

export async function leanThread(h: Host, root: string, i: Input): Promise<Out> {
  try {
    const home = await homeDir(h)
    await ensureGitHooks(h).catch(() => undefined) // every action (resume and wake too) refreshes the private registry
    if (i.action === 'list') return await list(h, home)
    if (/^projects$|^project-(add|remove|private)$/.test(i.action)) {
      const r = await projectsAction(h, i)
      if (i.action !== 'projects') await ensureGitHooks(h).catch(() => undefined) // projects.json changed: the private list follows
      return r
    }
    if (i.action === 'new') return await create(h, root, home, i)
    const id = i.tN ?? ''
    if (!ID.test(id)) return err(`${i.action} needs tN (like t3)`)
    return await serial(id, async () => {
      const t = await load(h, home, id)
      if (!t) return err(`no thread ${id}`)
      switch (i.action) {
        case 'send': {
          const text = (i.text ?? '').trim()
          if (!text) return err('send needs text')
          await appendJsonl(h, `${tpath(home, id)}/inbox.jsonl`, { ts: await h.clock.now(), text } satisfies Inbox)
          return await wake(h, home, t)
        }
        case 'wake':
          return await wake(h, home, t)
        case 'resume':
          return await wake(h, home, t, { force: true, lead: 'Continue where you left off.' })
        case 'start': {
          if (t.state === 'closed' || t.state === 'closing') return err(`${id} is ${t.state}; reopen it first`)
          const live = t.sid ? await agents(h) : []
          if (!live) return err(`${id}: cannot list sessions (claude agents failed), so it is not started`)
          if (t.sid && isRunning(live.find(a => a.sid === t.sid))) return { ok: true, text: `${id} is already running` }
          const brief = (await h.fs.read(`${tpath(home, id)}/brief.md`).catch(() => t.title)) as string
          const u = await unconsumed(h, home, id)
          const msgs = u.msgs
          const r = await startSession(h, home, t, [brief.trim(), batchPrompt(msgs)].filter(Boolean).join('\n\n'), i)
          if (r.ok && msgs.length) {
            t.delivered = u.upTo
            await save(h, home, t)
          }
          return r
        }
        case 'close': {
          // never "closed" while the session may still run: list twice, and if the listing keeps failing stay "closing"
          let live: AgentRow[] | null = null
          if (t.sid) live = (await agents(h)) ?? (await agents(h))
          if (t.sid && !live) {
            t.state = 'closing'
            await save(h, home, t)
            return { ok: false, text: `${id} is closing, not closed: claude agents failed twice, so it may still run. Stop it from the Claude app, then close ${id} again.` }
          }
          t.state = 'closed'
          await save(h, home, t)
          const lrow = (live ?? []).find(a => a.sid === t.sid)
          if (t.sid && lrow && (isRunning(lrow) || lrow.pid > 0)) {
            const stopId = lrow.id || t.sid.slice(0, 8)
            const st = await h.process.run(['claude', 'stop', stopId])
            if (st.exitCode !== 0) return { ok: true, text: `${id} closed, but claude stop ${stopId} failed: ${(st.stderr || st.stdout).trim().slice(0, 200)}. Stop it from the Claude app.` }
          }
          return { ok: true, text: `${id} closed` }
        }
        // the goals file belongs to the mod: the desk sets or clears a thread's goal here (a thread uses lean_goal)
        case 'goal-set': {
          const text = (i.text ?? '').trim()
          if (!text) return err('goal-set needs text')
          const goals = await readJson<Record<string, unknown>>(h, `${leanDir(home)}/goals.json`, {})
          goals[id] = { text, ts: await h.clock.now() }
          await writeJson(h, `${leanDir(home)}/goals.json`, goals)
          return { ok: true, text: `${id} goal set` }
        }
        case 'goal-clear': {
          const goals = await readJson<Record<string, unknown>>(h, `${leanDir(home)}/goals.json`, {})
          if (!Object.prototype.hasOwnProperty.call(goals, id)) return { ok: true, text: `${id} has no goal` }
          delete goals[id]
          await writeJson(h, `${leanDir(home)}/goals.json`, goals)
          return { ok: true, text: `${id} goal cleared` }
        }
        case 'park':
          t.state = 'parked'
          await save(h, home, t)
          return { ok: true, text: `${id} parked` }
        case 'reopen':
          t.state = 'open'
          await save(h, home, t)
          return { ok: true, text: `${id} reopened; use resume to wake it` }
        default:
          return err(`unknown action ${i.action}`)
      }
    })
  } catch (e) {
    return err(`lean_thread failed: ${String((e as Error)?.message ?? e).slice(0, 300)}`)
  }
}
