import { writeApproval } from './reviews'
import { appendJsonl, atomicWrite, homeDir, leanDir, mkdirp, readJson, readJsonl, realPath, threadsDir, writeJson } from './state'
import type { Host } from './state'
import { goalsLocked, unconsumed, wakeMark } from './delivery'
import { projectsAction, unknownProject } from './projects'
import { settingsKeys, threadChoice } from './models'
import type { Choice } from './models'
import { ensureGitHooks, gitEnv } from './githooks'
import { threadEnv, writeThreadSettings } from './mcpenv'
import { buildHandover, olderVersion, pluginVersion } from './handover'
import { LIMIT_PROMPT, isLimitRow, readLimit, usable } from './limits'
import { doneSession, finishedText } from './finish'
import { disabledPlugins, fillProfile, loadedLine, loadedText, nameOk, names, profileText, readLoaded, readProfile, removeProfile, resolveLoaded, startUsage, writeLoaded, writeProfile } from './profile'
import type { Loaded } from './profile'
import { slugOk } from './rules'

export const WAKE_GAP_MS = 30_000

export type ThreadState = 'open' | 'parked' | 'closing' | 'closed'
export type Thread = {
  id: string
  title: string
  project: string
  state: ThreadState
  sid: string // the background session's id, empty until started
  sids?: string[] // every session id that was resolved as this thread (mod reload, compaction, resume): the mod appends
  created: number
  lastWake: number // ms of the last start/wake, 0 = never
  delivered: number // inbox.jsonl lines already handed to the session
  model?: string // haiku | sonnet | opus, as started (a resume keeps the session's saved options)
  effort?: string // low | medium | high
  needs?: string[] // MCP servers / plugins this thread asked for on top of its project's profile (profile.ts)
  lastGoal?: string // the goal a close cleared (a reopen's handover names it)
  version?: string // the lean-agent version installed when the session was last started or resumed (a session runs the code it started with)
  finished?: number // ms the session was finished after a done report (finish.ts): the next send, wake or resume starts a NEW session with the handover
  checkpoints?: number // 1.0.6 only (context checkpoints were removed): still readable, nothing writes it
  lastCheckpoint?: number // 1.0.6 only
}
export type Inbox = { ts: number; text: string; from?: string }

// ---- `claude agents --json [--all]` -------------------------------------------------------------------------
// Fields used (Claude Code 2.1.x prints an array): sessionId, name, cwd, status ("idle" | "busy" | ...), startedAt (ms),
// kind, pid. Tolerated: a wrapper object ({agents|sessions|items: [...]}), snake_case ids (session_id, id), stray
// non-object entries, damaged JSON (-> []).
// state: what `claude agents` calls the session's state (working | done | stopped | blocked ...); waitingFor: set while the session waits
// for something nobody gave it (a permission prompt); model: the session's model when listed
export type AgentRow = { sid: string; name: string; cwd: string; status: string; startedAt: number; pid: number; id: string; state: string; waitingFor: string; model?: string }

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
      state: String(r.state ?? '').toLowerCase(),
      waitingFor: r.waitingFor == null || r.waitingFor === false ? '' : typeof r.waitingFor === 'string' ? r.waitingFor : JSON.stringify(r.waitingFor).slice(0, 120),
      ...(typeof r.model === 'string' && r.model ? { model: r.model } : {}),
    })
  }
  return out
}

// Only these mean "no live work": anything else (busy, running, waiting, an unknown word) counts as running,
// so an uncertain session is never resumed (a resume of a running session forks it).
const IDLE = new Set(['idle', 'done', 'completed', 'complete', 'finished', 'stopped', 'exited', 'failed', 'error', 'dead'])
export const isRunning = (r: AgentRow | undefined) => !!r && !IDLE.has(r.status)
// working = busy or reported working: nothing may close, stop or replace it
export const isWorking = (r: AgentRow | undefined) => isRunning(r) || r?.state === 'working'
// waiting on a prompt nobody answers (a background session cannot): the user has to open it in the app
export const needsYou = (r: AgentRow | undefined) => !!r && (!!r.waitingFor || r.state === 'blocked')

// null = the listing failed or was not JSON: the caller must not treat that as "nothing is running"
export { agents as listAgents }
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
// config.json `attribution` (default false) as one line for the thread's CLAUDE.md: a thread cannot read the setting otherwise
export const attributionLine = (on: boolean) => (on ? 'attribution: on - end commits and PR text with the attribution lines the session was given' : 'attribution: off - no Co-Authored-By trailers, no generated-with lines')
const fill = (t: string, vars: Record<string, string>) => t.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '')

// `plugins`: the installed plugins outside the project's profile, switched off for this thread (profile.ts disabledPlugins)
// `extraEnv`: the MCP variables this thread gets (mcpenv.ts threadEnv: only names the user's own settings env does not set, so the
// two blocks never collide; the git hooks names are GIT_*, which mcpenv refuses). The settings env here MERGES with the user's.
export async function threadSettings(h: Host, id: string, hooks = true, choice?: Choice, plugins: Record<string, false> = {}, extraEnv: Record<string, string> = {}): Promise<string> {
  const lean = leanDir(await homeDir(h))
  const env = { ...extraEnv, ...(hooks ? gitEnv(await homeDir(h)) : {}) }
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
      ...(Object.keys(env).length ? { env } : {}),
      ...(choice ? settingsKeys(choice) : {}), // a session opened in the folder from the app matches
      ...(Object.keys(plugins).length ? { enabledPlugins: plugins } : {}),
    },
    null,
    2,
  ) + '\n'
}

async function template(h: Host, root: string, name: string): Promise<string> {
  const t = await h.fs.read(`${root}/templates/${name}`)
  return typeof t === 'string' ? t : ''
}

// the CLAUDE.md a new thread gets (compare builds a throw-away thread-shaped folder with the same text)
// `choice`: the model and effort the session starts with (written into the guide as one line: a thread cannot see its own settings).
// Without one (compare's throw-away folder: no thread.json, the arm's model comes from flags) the line is left out, never guessed.
// `loaded`: what the thread's profile lets it load (null = no profile applies).
export async function threadClaudeMd(h: Host, root: string, id: string, title: string, project: string, choice?: Choice, loaded: Loaded | null = null): Promise<string> {
  const home = await homeDir(h)
  const cfg = await readJson<{ attribution?: unknown }>(h, `${leanDir(home)}/config.json`, {})
  // the <!-- profile --> block of the template (what is loaded and how to ask for more) is only there when a profile applies: a thread
  // of a project without one is told nothing new
  let text = (await template(h, root, 'thread.md')).replace(/<!-- profile -->\n([\s\S]*?)<!-- \/profile -->\n?/, (_m, block: string) => (restricted(loaded) ? block : ''))
  if (!choice) text = text.split('\n').filter(l => !/\{\{(model|effort)\}\}/.test(l)).join('\n')
  return fill(text, { id, title, project, lean: leanDir(home), attribution: attributionLine(cfg?.attribution === true), loaded: loadedLine(loaded), model: choice?.model ?? '', effort: choice?.effort ?? '' })
}

export async function deskClaudeMd(h: Host, root: string): Promise<string> {
  return fill(await template(h, root, 'front-desk.md'), { lean: leanDir(await homeDir(h)) })
}

// ---- the tool ------------------------------------------------------------------------------------------------
export type Input = { action: string; tN?: string; text?: string; title?: string; project?: string; model?: string; effort?: string; path?: string; on?: boolean; all?: boolean; confirm?: boolean; sha?: string; reason?: string; needs?: string[]; mcp?: string[]; plugins?: string[]; fill?: boolean }
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
// the session's own mod appends to `sids` from another process: a save keeps whatever ids are on disk
async function save(h: Host, home: string, t: Thread): Promise<void> {
  const file = `${tpath(home, t.id)}/thread.json`
  const disk = await readJson<{ sids?: unknown } | null>(h, file, null)
  const ids = [...(Array.isArray(disk?.sids) ? disk!.sids : []), ...(t.sids ?? [])].filter((x): x is string => typeof x === 'string')
  await writeJson(h, file, ids.length ? { ...t, sids: [...new Set(ids)].slice(-20) } : t)
}

async function nextId(h: Host, home: string): Promise<string> {
  let max = 0
  try {
    for (const e of await h.fs.list(threadsDir(home))) {
      const m = /^t(\d{1,9})$/.exec(e.name) // (compare's throw-away folders are t9 + a 13-digit time: never a thread number)
      if (m) max = Math.max(max, Number(m[1]))
    }
  } catch {
    /* no threads yet */
  }
  return `t${max + 1}`
}

const label = (t: Thread) => `${t.id} · ${t.title}`
// did this answer come from a session that was really started (not a "running" or refusal text)?
const fresh = (r: Out) => r.ok && !!(r.data as { fresh?: boolean } | undefined)?.fresh

// the goals file belongs to the mod; one lock for every writer (delivery.ts goalsLocked). Returns the removed goal's text ('' when it
// had none text), null when there was no goal
async function clearGoal(h: Host, home: string, id: string): Promise<string | null> {
  return goalsLocked(async () => {
    const goals = await readJson<Record<string, { text?: unknown } | null>>(h, `${leanDir(home)}/goals.json`, {})
    if (!goals || !Object.prototype.hasOwnProperty.call(goals, id)) return null
    const text = typeof goals[id]?.text === 'string' ? (goals[id]!.text as string) : ''
    delete goals[id]
    await writeJson(h, `${leanDir(home)}/goals.json`, goals)
    return text
  })
}

function batchPrompt(msgs: Inbox[]): string {
  return msgs.map(m => (m.from ? `[${m.from}] ` : '') + m.text).join('\n\n')
}

async function startSession(h: Host, home: string, t: Thread, prompt: string, given: { model?: string; effort?: string } = {}, installed = ''): Promise<Out> {
  const folder = tpath(home, t.id)
  const choice = await threadChoice(h, home, given, t)
  if (typeof choice === 'string') return err(choice)
  t.model = choice.model
  t.effort = choice.effort
  // before the session exists its mod reads model, effort and needs from thread.json (at its first request): only these three are saved now,
  // the rest of the record (state, sid) is saved when the start worked
  const disk = await load(h, home, t.id)
  if (disk) await save(h, home, { ...disk, model: t.model, effort: t.effort, ...(t.needs ? { needs: t.needs } : {}) })
  const hooks = await ensureGitHooks(h).then(() => true, () => false)
  // the project's profile (plus this thread's needs): plugins outside it are switched off in the thread's settings; its MCP servers
  // outside it are deferred by the thread's own mod, which reads loaded.json (profile.ts). No profile = nothing held back.
  const loaded = await resolveLoaded(h, home, t.project, t.needs ?? [])
  const off = await disabledPlugins(h, loaded.plugins).catch(() => ({}))
  // MCP variables from ~/.lean-agent/mcp-env.json (a command's output or a plain value), run now, kept only in this thread's settings
  // (user-only file); a failure is a line in the reply (names only), never a failed start
  const menv = await threadEnv(h, home).catch(() => ({ env: {} as Record<string, string>, lines: [] as string[] }))
  const hasEnv = Object.keys(menv.env).length > 0
  const kept = await writeThreadSettings(h, `${folder}/.claude/settings.json`, await threadSettings(h, t.id, hooks, choice, off, menv.env), hasEnv, hasEnv ? await threadSettings(h, t.id, hooks, choice, off) : undefined).catch(async () => {
    await h.fs.write(`${folder}/.claude/settings.json`, await threadSettings(h, t.id, hooks, choice, off)) // never a failed start, never a secret left in a loose file
    return false
  })
  if (hasEnv && !kept) menv.lines = [...menv.lines.filter(l => !l.startsWith('mcp env for this thread')), "mcp env: the thread's settings file could not be made user-only, so its variables were left out"]
  await writeLoaded(h, home, t.id, loaded).catch(() => undefined)
  await startUsage(h, home, t.id).catch(() => undefined)
  const r = await h.process.run(['claude', '--bg', '-n', label(t), '--model', choice.model, '--effort', choice.effort, '--', prompt], { cwd: folder, timeoutMs: 120_000 })
  if (r.exitCode !== 0) return err(`claude --bg failed: ${(r.stderr || r.stdout).slice(0, 300)}`)
  let sid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(r.stdout + '\n' + r.stderr)?.[0] ?? ''
  if (!sid) {
    const rows = ((await agents(h)) ?? []).filter(a => a.cwd === folder || a.name === label(t))
    rows.sort((a, b) => b.startedAt - a.startedAt)
    sid = rows[0]?.sid ?? ''
  }
  if (t.sid && sid !== t.sid) t.sids = [...(t.sids ?? []), t.sid] // the old session id stays as history; its conversation is never resumed
  t.sid = sid
  t.lastWake = await h.clock.now()
  delete t.finished // a new session is a new piece of work
  if (installed) t.version = installed
  await save(h, home, t)
  // one reply line: what was chosen (model/effort, so the desk need not look it up) and, when a profile applies, what the thread loads
  const how = `${choice.model}/${choice.effort}`
  const lt = (restricted(loaded) ? ` · ${loadedText(loaded)}` : '') + menv.lines.map(l => ` · ${l}`).join('')
  return sid ? { ok: true, text: `${t.id} started (${sid}) · ${how}${lt}`, data: { fresh: true } } : { ok: true, text: `${t.id} started · ${how}, but its session id was not found; list will retry${lt}`, data: { fresh: true } }
}

// start / reopen with needs: added to what the thread already asked for (kept in thread.json, so a later start keeps them); a string = refusal
function addNeeds(t: Thread, v: unknown): string | null {
  const n = needsOf(v)
  if (typeof n === 'string') return n
  if (n?.length) t.needs = [...new Set([...(t.needs ?? []), ...n])].slice(0, 50)
  return null
}

// a profile applies (some list is an allow-list); otherwise nothing is held back and nothing is said
const restricted = (l: Loaded | null) => !!l && (l.mcp !== null || l.plugins !== null)

// `needs`: plain names of MCP servers or plugins; a string = the refusal
function needsOf(v: unknown): string[] | string | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v) || v.length > 50 || !v.every(nameOk)) return 'needs must be a list of server or plugin names (letters, digits, . _ : @ -), at most 50'
  return names(v)
}

async function create(h: Host, root: string, home: string, i: Input, installed = ''): Promise<Out> {
  const title = (i.title ?? '').trim()
  if (!title) return err('new needs a title')
  const pre = await threadChoice(h, home, i)
  if (typeof pre === 'string') return err(pre) // a bad model/effort stops here, before any folder exists
  const project = (i.project ?? '').trim()
  if (project) {
    const bad = await unknownProject(h, project) // before any folder exists
    if (bad) return err(bad)
  }
  const needs = needsOf(i.needs)
  if (typeof needs === 'string') return err(needs)
  const id = await nextId(h, home)
  const dir = tpath(home, id)
  await mkdirp(h, dir)
  const t: Thread = { id, title, project, state: 'open', sid: '', created: await h.clock.now(), lastWake: 0, delivered: 0, ...(needs?.length ? { needs } : {}) }
  await h.fs.write(`${dir}/CLAUDE.md`, await threadClaudeMd(h, root, id, title, t.project, pre, await resolveLoaded(h, home, t.project, t.needs ?? [])))
  const hooks = await ensureGitHooks(h).then(() => true, () => false)
  await h.fs.write(`${dir}/.claude/settings.json`, await threadSettings(h, id, hooks, pre))
  const brief = (i.text ?? '').trim() || title
  await h.fs.write(`${dir}/brief.md`, brief + '\n')
  await save(h, home, t)
  await trustFolder(h, dir)
  const r = await startSession(h, home, t, brief, i, installed)
  return r.ok ? { ...r, data: t } : r
}

// Stop a finished-but-alive session before anything takes its place (a resume, a fresh session). null = it is gone, go on; an Out =
// stop here with that answer. Never stops live work: the listing is read again right before the stop. `limit`: a session blocked by
// the usage limit (state blocked, nothing it waits for) is not live work and may be stopped.
// `own` (the thread's folder): only a session that lives there is stopped (a listing without that folder stops nothing). `force`: a
// restart the user confirmed stops a working session too; the folder check is then always made.
type StopOpts = { limit?: boolean; own?: string; force?: boolean }
async function stopAlive(h: Host, t: Thread, queued: string, did: string, o: StopOpts = {}): Promise<Out | null> {
  const fresh = (await agents(h))?.find(a => a.sid === t.sid) // look again right before stopping: never stop live work
  const stays = queued ? 'messages stay queued' : 'nothing was started'
  if (!fresh) return err(`${t.id}: cannot list sessions (claude agents failed), so it is not ${did}; ${stays}`)
  if (isRunning(fresh) && !o.force && !(o.limit && isLimitRow(fresh))) return { ok: true, text: `${t.id} is running again: ${queued || 'nothing'} queued, no stop, no ${did === 'resumed' ? 'resume' : 'new session'}` }
  if (o.own && fresh.pid > 0 && !(await inFolder(h, fresh.cwd, o.own))) return err(`${t.id}: its session runs outside the thread folder (${fresh.cwd || 'unknown'}): not stopped, not ${did}, ${stays}`)
  const short = fresh.id || t.sid.slice(0, 8)
  if (fresh.pid > 0) {
    const st = await h.process.run(['claude', 'stop', short])
    if (st.exitCode !== 0) return err(`${t.id}: claude stop ${short} failed (${(st.stderr || st.stdout).trim().slice(0, 200)}): not ${did}, ${stays}`)
    let gone = false
    let listed = false
    for (let n = 0; n < 8 && !gone; n++) {
      const l = await agents(h)
      if (l) listed = true
      const cur = l?.find(a => a.sid === t.sid)
      gone = !!l && (!cur || cur.pid === 0)
      if (!gone && n < 7) await h.process.run(['sleep', '1'])
    }
    if (!gone) return err(listed ? `${t.id}: the session is still running after claude stop ${short}: not ${did}, ${stays}` : `${t.id}: could not confirm the stop (claude agents failed): not ${did}, ${stays}`)
  }
  return null
}

// is `cwd` the thread's own folder (the listing may print the real path of a linked home)?
async function inFolder(h: Host, cwd: string, own: string): Promise<boolean> {
  return cwd === own || (!!cwd && (await realPath(h, cwd)) === (await realPath(h, own)))
}

// A NEW session for an existing thread, with a handover built from what lean-agent kept (brief, goal, notes, reports, remembered
// items, queued messages). The old conversation is never resumed; its id stays in `sids`. The thread's own CLAUDE.md is regenerated
// from the current template when lean-agent wrote it, so the fresh session also gets today's rules.
// `restart`: the user asked for it in the pane (or the desk on request), so a working session is stopped too (its current step is lost);
// otherwise a working session is never touched.
async function freshSession(h: Host, root: string, home: string, t: Thread, installed: string, why: string, given: { model?: string; effort?: string }, restart = false): Promise<Out> {
  const listed = t.sid ? await agents(h) : []
  if (!listed) return err(`${t.id}: cannot list sessions (claude agents failed), so no new session is started`)
  const row = t.sid ? listed.find(a => a.sid === t.sid) : undefined
  if (isWorking(row) && !restart) return { ok: true, text: `${t.id} is running: no new session started (stop it from the Claude app first)` }
  if (row && (row.pid > 0 || (restart && isWorking(row)))) {
    const stopped = await stopAlive(h, t, '', 'started fresh', { own: tpath(home, t.id), ...(restart ? { force: true } : {}) })
    if (stopped) return stopped
  }
  await refreshGuide(h, root, home, t, given)
  const u = await unconsumed(h, home, t.id)
  const ho = await buildHandover(h, home, t, why, u.msgs)
  const r = await startSession(h, home, t, ho.prompt, given, installed)
  if (r.ok && u.msgs.length) {
    t.delivered = u.upTo
    await save(h, home, t)
  }
  return r
}

async function refreshGuide(h: Host, root: string, home: string, t: Thread, given: { model?: string; effort?: string } = {}): Promise<void> {
  const file = `${tpath(home, t.id)}/CLAUDE.md`
  try {
    const have = await h.fs.read(file)
    if (typeof have !== 'string' || !have.startsWith('<!-- generated by lean-agent')) return // the user's own file stays
    const choice = await threadChoice(h, home, given, t) // the one the new session starts with (startSession picks it the same way)
    const want = await threadClaudeMd(h, root, t.id, t.title, t.project, typeof choice === 'string' ? undefined : choice, await resolveLoaded(h, home, t.project, t.needs ?? []))
    if (want && want !== have) await h.fs.write(file, want)
  } catch {
    /* no guide yet: nothing to refresh */
  }
}

async function pending(h: Host, home: string, t: Thread): Promise<Inbox[]> {
  return (await unconsumed(h, home, t.id)).msgs
}

// Resume the thread's session with the queued batch, unless it is running (never resume a running session)
// or was woken less than 30 s ago (the batch stays queued for the next wake).
// `limit`: the resume after a usage limit (docs/usage-limit-resume.md): a session blocked by the limit counts as not running, is
// stopped when its process lingers, and the 30 s gap does not apply (the desk's tick marks one resume per reset itself).
// `root` and `current` (the installed plugin version) are only for the fresh session a finished thread gets instead of a resume.
async function wake(h: Host, home: string, t: Thread, opts: { force?: boolean; lead?: string; installed?: string; limit?: boolean; root?: string; current?: string } = {}): Promise<Out> {
  if (t.state !== 'open') return { ok: true, text: `${t.id} is ${t.state}: message queued, no wake` }
  if (!t.sid) return { ok: true, text: `${t.id} has no session yet: queued; use start` }
  const u = await unconsumed(h, home, t.id) // one read: the messages and the position they end at
  const msgs = u.msgs
  if (!msgs.length && !opts.force) return { ok: true, text: `${t.id}: nothing queued` }
  const listed = await agents(h)
  if (!listed) return err(`${t.id}: cannot list sessions (claude agents failed), so it is not resumed; messages stay queued`)
  const row = listed.find(a => a.sid === t.sid)
  if (isRunning(row) && !(opts.limit && isLimitRow(row))) return { ok: true, text: `${t.id} is running: ${msgs.length} message(s) queued, it reads them itself`, data: { resumed: false } }
  const now = await h.clock.now()
  if (!opts.limit && t.lastWake && now - t.lastWake < WAKE_GAP_MS) return { ok: true, text: `${t.id} was woken ${Math.round((now - t.lastWake) / 1000)} s ago: queued for the next wake` }
  // A session that reported done is over (finish.ts): its conversation is never resumed. Marked finished, or its last report is done
  // and the session is idle (the desk's tick has not stopped it yet): a NEW session starts with the handover, queued messages included.
  if (t.finished || (!opts.limit && (await doneSession(h, home, t)))) {
    const r = await freshSession(h, opts.root ?? '', home, t, opts.current ?? '', 'Its previous session reported done and was finished; this message starts a new session.', {})
    return fresh(r) ? { ...r, text: `${t.id} finished earlier: a new session was started with the handover (old conversation kept read-only). ${r.text}`, data: { ...(r.data as object), resumed: false } } : r
  }
  // `claude --bg --resume` continues the session itself only once its process has exited; while the process still lives (finished,
  // idle) the same command starts a copy. So a finished-but-alive one is stopped first (never a working one), then resumed.
  if (row && row.pid > 0) {
    // (a working or unknown status was handled above: only a finished or dead session with a lingering process gets here)
    const stopped = await stopAlive(h, t, `${msgs.length} message(s)`, 'resumed', { limit: !!opts.limit })
    if (stopped) return stopped.ok ? { ...stopped, data: { resumed: false } } : stopped
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
  if (opts.installed) t.version = opts.installed // the resumed process loads the code installed now
  await save(h, home, t)
  return { ok: true, data: { resumed: true }, text: `${t.id} woken with ${msgs.length} message(s)${copied ? `; the CLI started a copy, the thread now follows session ${copied.slice(0, 8)}` : copy ? `; the CLI started a copy as ${copy}, which ${hits.length > 1 ? 'matches several sessions' : 'is not in the session list yet'}: the thread keeps its old session id, check ${t.id} with threads` : ''}` }
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
    const lo = await readLoaded(h, home, t.id)
    out.push({ id: t.id, title: t.title, project: t.project, model: t.model, effort: t.effort, state: t.state, running: isRunning(rows.find(a => a.sid === t.sid)), sid: t.sid, queued: q, ...(lo && restricted(lo) ? { loaded: loadedText(lo) } : {}) })
  }
  const text = out.length ? (out as any[]).map(o => `${o.id} · ${o.title}${o.project ? ` · ${o.project}` : ''} [${o.state}${o.running ? ', running' : ''}${o.queued ? `, ${o.queued} queued` : ''}]${o.model ? ` · ${o.model}/${o.effort}` : ''}${o.loaded ? ` · ${o.loaded}` : ''}`).join('\n') : 'no threads'
  return { ok: true, text, data: out }
}

// the desk's `profile`: show a project's profile with what its threads used; mcp / plugins set the lists (a list left out stays as it is);
// fill: true adds what the threads used; on: false removes the profile (every thread loads everything again)
async function profileAction(h: Host, home: string, i: Input): Promise<Out> {
  const project = (i.project ?? '').trim()
  if (!slugOk(project)) return err('profile needs project: a registered project name')
  const bad = await unknownProject(h, project)
  if (bad) return err(bad.replace(/ No thread was created\.$/, ''))
  if (i.on === false) return { ok: true, text: (await removeProfile(h, home, project)) ? `${project} profile removed: every thread of it loads everything again` : `${project} has no profile` }
  for (const [k, v] of [['mcp', i.mcp], ['plugins', i.plugins]] as const) if (v !== undefined && (!Array.isArray(v) || v.length > 50 || !v.every(nameOk))) return err(`${k} must be a list of names (letters, digits, . _ : @ -), at most 50`)
  if (i.mcp !== undefined || i.plugins !== undefined) {
    const cur = await readProfile(h, home, project)
    await writeProfile(h, home, project, { mcp: names(i.mcp) ?? cur?.mcp, plugins: names(i.plugins) ?? cur?.plugins }, 'desk')
    return { ok: true, text: `${await profileText(h, home, project)}\nnew threads of ${project} start with it; running ones keep what they started with` }
  }
  if (i.fill === true) return await fillProfile(h, home, project)
  return { ok: true, text: await profileText(h, home, project) }
}

export async function leanThread(h: Host, root: string, i: Input): Promise<Out> {
  try {
    const home = await homeDir(h)
    await ensureGitHooks(h).catch(() => undefined) // every action (resume and wake too) refreshes the private registry
    if (i.action === 'list') return await list(h, home)
    if (i.action === 'profile') return await profileAction(h, home, i)
    if (/^projects$|^project-(add|remove|private)$/.test(i.action)) {
      const r = await projectsAction(h, i)
      if (i.action !== 'projects') await ensureGitHooks(h).catch(() => undefined) // projects.json changed: the private list follows
      return r
    }
    const installed = await pluginVersion(h, root)
    if (i.action === 'new') return await create(h, root, home, i, installed)
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
          return await wake(h, home, t, { root, current: installed }) // (a message wake does not stamp the version: only start and an explicit resume do)
        }
        case 'wake':
          return await wake(h, home, t, { root, current: installed })
        case 'resume': {
          // A session keeps the lean-agent code it started with. When this one ran an older version than the installed one, a resume
          // would continue old behaviour: start a fresh session with a handover instead and say why (an unrecorded version is unknown: resume).
          if (t.state === 'open' && t.sid && olderVersion(t.version, installed)) {
            const was = t.version // (a started session records the installed version over it)
            const r = await freshSession(h, root, home, t, installed, `The previous session ran lean-agent ${was}; ${installed} is installed now, so this is a fresh session instead of a resume.`, i)
            return fresh(r) ? { ...r, text: `${id} started as a new session instead of a resume: the old one ran lean-agent ${was}, ${installed} is installed (old conversation kept read-only). ${r.text}` } : r
          }
          return await wake(h, home, t, { force: true, lead: 'Continue where you left off.', installed, root, current: installed })
        }
        case 'limit-resume': {
          // only the desk's tick calls this (not in the tool's schema): the session was seen blocked by the usage limit and its reset
          // has passed. Checked again here, inside the lock: an open thread, a record for this very session that no parking cancelled,
          // and the tick's mark for this reset ("resumedFor", set just before this call: a call without it is refused). A thread woken
          // since the mark (lastWake past resumedAt) was resumed by an earlier call for this very mark: never a second one.
          if (t.state !== 'open') return err(`${id} is ${t.state}: not resumed after the usage limit`)
          if (t.finished) return { ok: true, text: `${id} is finished: no usage-limit resume (its next message starts a new session)`, data: { resumed: false } }
          const rec = await readLimit(h, home, id)
          if (!usable(rec, t.sid, await h.clock.now()) || rec.cancelled) return err(`${id}: no usable usage-limit record for its session, nothing resumed`)
          if (rec.resumedFor !== rec.resetAt || typeof rec.resumedAt !== 'number') return err(`${id}: the usage-limit resume was not marked by the desk's check, nothing resumed`)
          if (t.lastWake >= rec.resumedAt) return { ok: true, text: `${id} was already resumed for this usage limit`, data: { resumed: false } }
          return await wake(h, home, t, { force: true, lead: LIMIT_PROMPT, limit: true })
        }
        case 'finish': {
          // only the desk's tick calls this (not in the tool's schema; finish.ts picks the candidates): the thread's last report is done.
          // Checked again here, inside the lock. A session that is still working (a final step after the report) is left alone and
          // looked at again at the next tick; an idle one is stopped (never a session outside the thread folder) and marked finished:
          // the next send, wake or resume starts a NEW session with the handover.
          if (t.state !== 'open') return err(`${id} is ${t.state}: not finished`)
          if (t.finished) return { ok: true, text: `${id} is already finished`, data: { finished: false } }
          if (!t.sid) return { ok: true, text: `${id} has no session`, data: { finished: false } }
          if (!(await doneSession(h, home, t))) return { ok: true, text: `${id}: its last report is not done: nothing finished`, data: { finished: false } }
          const listed = await agents(h)
          if (!listed) return err(`${id}: cannot list sessions (claude agents failed), so it is not finished`)
          const row = listed.find(a => a.sid === t.sid)
          if (isWorking(row)) return { ok: true, text: `${id} reported done but is still working: finished once it is idle`, data: { finished: false } }
          if (row && row.pid > 0) {
            const stopped = await stopAlive(h, t, '', 'finished', { own: tpath(home, id) })
            if (stopped) return { ...stopped, data: { finished: false } }
          }
          t.finished = await h.clock.now()
          await save(h, home, t)
          return { ok: true, text: finishedText(id), data: { finished: true } }
        }
        case 'restart': {
          // the pane's Restart button, or the desk on request: the session is stopped (a working one too: its current step is lost; only
          // a session in the thread's own folder) and a NEW session starts with the handover (brief, goal, notes, reports, queued
          // messages, branch and worktree from the reports; the thread's recorded model and effort)
          if (t.state !== 'open') return err(`${id} is ${t.state}: reopen it first`)
          const r = await freshSession(h, root, home, t, installed, 'Restarted from the pane.', {}, true)
          return fresh(r) ? { ...r, text: `${id} restarted as a new session (old conversation kept read-only). ${r.text}` } : r
        }
        case 'start': {
          if (t.state === 'closed' || t.state === 'closing') return err(`${id} is ${t.state}; reopen it first`)
          const bad = addNeeds(t, i.needs)
          if (bad) return err(bad)
          const live = t.sid ? await agents(h) : []
          if (!live) return err(`${id}: cannot list sessions (claude agents failed), so it is not started`)
          if (t.sid && isRunning(live.find(a => a.sid === t.sid))) return { ok: true, text: `${id} is already running${i.needs?.length ? ' (needs apply to a new session only: nothing was changed)' : ''}` }
          if (t.finished) {
            // a finished thread never continues its old conversation: a new session with the handover
            const r = await freshSession(h, root, home, t, installed, 'Its previous session reported done and was finished; it is started again.', i)
            return fresh(r) ? { ...r, text: `${id} finished earlier: started as a new session with the handover (old conversation kept read-only). ${r.text}` } : r
          }
          const brief = (await h.fs.read(`${tpath(home, id)}/brief.md`).catch(() => t.title)) as string
          const u = await unconsumed(h, home, id)
          const msgs = u.msgs
          const r = await startSession(h, home, t, [brief.trim(), batchPrompt(msgs)].filter(Boolean).join('\n\n'), i, installed)
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
          const removed = await clearGoal(h, home, id) // a closed thread has no goal for the chaser to watch; its text is kept for a reopen's handover
          if (removed) t.lastGoal = removed
          const cleared = removed !== null
          await save(h, home, t) // nothing else to save: the reports, notes and memory are the record, and the folder is never deleted
          const lrow = (live ?? []).find(a => a.sid === t.sid)
          const head = `${id} closed${cleared ? ', goal cleared' : ''}`
          let outcome = !t.sid ? 'no session was ever started' : !lrow ? 'no session in the list (already removed)' : 'no running session (already stopped)'
          if (t.sid && lrow && (isRunning(lrow) || lrow.pid > 0)) {
            const stopId = lrow.id || t.sid.slice(0, 8)
            const st = await h.process.run(['claude', 'stop', stopId])
            if (st.exitCode !== 0) return { ok: true, text: `${head}, but claude stop ${stopId} failed: ${(st.stderr || st.stdout).trim().slice(0, 200)}. Stop it from the Claude app.` }
            outcome = 'session stopped'
          }
          // Take the stopped session out of the app's list when the CLI can (`claude rm`: it keeps the conversation and never discards
          // unpushed work, because no --discard-unpushed / --force-remove-worktree is ever passed). Only a session that lives in the thread's own
          // folder: `rm` also deletes a worktree the session was started in, and that is never ours to remove.
          const own = tpath(home, id)
          if (t.sid && lrow && (lrow.cwd === own || (!!lrow.cwd && (await realPath(h, lrow.cwd)) === (await realPath(h, own))))) { // (the listing may print the real path of a linked home)
            const rm = await h.process.run(['claude', 'rm', lrow.id || t.sid.slice(0, 8)]).catch(() => null)
            outcome += rm && rm.exitCode === 0 ? ' and removed from the app\'s list (its conversation is kept)' : `; the app keeps stopped sessions in its list${rm ? ` (claude rm: ${(rm.stderr || rm.stdout).trim().replace(/\s+/g, ' ').slice(0, 120) || `exit ${rm.exitCode}`})` : ''}`
          } else if (t.sid && lrow) outcome += "; the app keeps stopped sessions in its list"
          return { ok: true, text: `${head}; ${outcome}` }
        }
        // the goals file belongs to the mod: the desk sets or clears a thread's goal here (a thread uses lean_goal)
        case 'goal-set': {
          const text = (i.text ?? '').trim()
          if (!text) return err('goal-set needs text')
          await goalsLocked(async () => {
            const goals = await readJson<Record<string, unknown>>(h, `${leanDir(home)}/goals.json`, {})
            goals[id] = { text, ts: await h.clock.now() }
            await writeJson(h, `${leanDir(home)}/goals.json`, goals)
          })
          return { ok: true, text: `${id} goal set` }
        }
        case 'goal-clear':
          return { ok: true, text: (await clearGoal(h, home, id)) ? `${id} goal cleared` : `${id} has no goal` }
        case 'approve-push': {
          // the user said yes in the desk chat; only the desk's lean_thread reaches this. One sha, one push, two hours.
          const sha = (i.sha ?? '').trim().toLowerCase()
          if (!t.project) return err(`${id} has no project, so there is nothing to approve a push for`)
          const pj = (await readJson<Record<string, { private?: boolean }>>(h, `${leanDir(home)}/projects.json`, {}))?.[t.project]
          if (pj?.private === true) return err(`${t.project} is a private project: it is never pushed, an approval would never be used. Give the user the manual push command instead`)
          try {
            await writeApproval(h, { project: t.project, sha, thread: id, reason: (i.reason ?? '').trim().slice(0, 200) || undefined })
          } catch (e) {
            return err(String((e as Error)?.message ?? e))
          }
          await appendJsonl(h, `${tpath(home, id)}/history.jsonl`, { ts: await h.clock.now(), kind: 'approve-push', sha, project: t.project, reason: (i.reason ?? '').trim().slice(0, 200) || undefined })
          return { ok: true, text: `approved: one push of ${sha.slice(0, 8)} for ${t.project} by ${id}, valid 2 h, single use` }
        }
        case 'park': {
          t.state = 'parked'
          await save(h, home, t)
          return { ok: true, text: `${id} parked` }
        }
        case 'reopen': {
          if (t.state === 'closing') return err(`${id} is closing, not closed: stop its session from the Claude app, close ${id} again, then reopen`)
          if (t.state !== 'closed') {
            t.state = 'open' // parked: the same session, use resume
            await save(h, home, t)
            return { ok: true, text: `${id} reopened; use resume to wake it${i.needs?.length ? ' (needs apply to a new session only: a resume keeps the session\'s settings; use start or close and reopen)' : ''}` }
          }
          const badNeeds = addNeeds(t, i.needs)
          if (badNeeds) return err(badNeeds)
          // A closed thread is never resumed: a NEW session starts in the same folder (same tN, project, worktree and branch) with a
          // handover built from brief, goal, notes, reports, remembered items and queued messages. A fresh session also runs today's code.
          t.state = 'open'
          const r = await freshSession(h, root, home, t, installed, 'It was closed and has been reopened.', i)
          if (!fresh(r)) {
            t.state = 'closed' // nothing was saved: it stays closed
            return r
          }
          return { ...r, text: `${id} reopened as a new session (old conversation kept read-only). ${r.text}` }
        }
        default:
          return err(`unknown action ${i.action}`)
      }
    })
  } catch (e) {
    return err(`lean_thread failed: ${String((e as Error)?.message ?? e).slice(0, 300)}`)
  }
}
