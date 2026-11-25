// The desk pane's session list (1.0.32): ONE list of every thread (open, done and closed), ordered by last activity unless the user picked another
// order, capped with one "show more" row. All of it is script on the state the view already holds: no model call, no polling.
// Settings (hooks/configkeys.ts): pane.sort (default thread) and pane.sortDir (auto | asc | desc; both also remembered in the mod's store, the press that changes one writes both
// places), pane.maxSessions, pane.healthOpen, pane.foldAll. The hidden completed sessions are kept in the store only (pane.hidden).
import { homeDir, leanDir, readJson } from './state'
import type { Host } from './state'
import { stateOf } from './view'
import type { ClosedRow, NeedRow, ThreadRow } from './view'
import { configTool } from './configtool'

export const SORTS = ['thread', 'active', 'needs', 'usage', 'name'] as const
export type SortKey = (typeof SORTS)[number]
export const SORT_LABEL: Record<SortKey, string> = { thread: 'thread', active: 'last active', needs: 'needs you first', usage: 'usage', name: 'name' }
// the key the sort was called before 1.0.33 ("cost", in dollars) still reads as "usage" (usage tokens)
export const sortAlias = (x: unknown): unknown => (x === 'cost' ? 'usage' : x)
// every sort has a direction (1.0.33): the default of each key is the order people expect (the highest thread number, the newest, the most usage first; names A to Z)
export type SortDir = 'asc' | 'desc'
export const SORT_DIRS = ['auto', 'asc', 'desc'] as const
export const DEFAULT_DIR: Record<SortKey, SortDir> = { thread: 'desc', active: 'desc', needs: 'desc', usage: 'desc', name: 'asc' }
export const ARROW: Record<SortDir, string> = { desc: '↓', asc: '↑' }
export const MAX_SESSIONS = 30
export const SORT_STORE = 'pane.sort'
export const SORTDIR_STORE = 'pane.sortDir'
export const HIDDEN_STORE = 'pane.hidden'

// one row of the list: an open thread (t) or a closed one (c)
export type Item = { id: string; title: string; activity: number; cost: number; closed: boolean; needs: boolean; t?: ThreadRow; c?: ClosedRow }

// the states that wait for the user (the same words the widget counts as blocked): they sit on top under "needs you first"
const WAITING_WORDS = ['waiting', 'waiting for answer', 'approval', 'asking', 'blocked', 'stuck', 'stalled']
export const needsUser = (t: ThreadRow, needs: Pick<NeedRow, 'thread'>[] = []): boolean => WAITING_WORDS.includes(stateOf(t).word) || !!t.pending || !!t.noReport /* "idle, no report N min" (endnudge.ts) */ || needs.some(n => n.thread === t.id)
const num = (id: string) => Number(id.replace(/^\D+/, '')) || 0
// the thread number of an id ("t90" is 90); NaN for an id with no number (it sorts last, whatever the direction)
const numOrNaN = (id: string): number => (/\d/.test(id) ? Number(id.replace(/^\D+/, '')) : NaN)

export function itemsOf(threads: ThreadRow[], closed: ClosedRow[], needs: Pick<NeedRow, 'thread'>[] = []): Item[] {
  return [
    ...threads.map((t): Item => ({ id: t.id, title: t.title, activity: t.activity ?? t.recTs ?? 0, cost: t.cost, closed: false, needs: needsUser(t, needs), t })),
    ...closed.map((c): Item => ({ id: c.id, title: c.title, activity: c.activity, cost: c.cost, closed: true, needs: false, c })),
  ]
}

// thread (the default): the highest thread number first (t90 before t89), a thread without a number last; last active: newest first; needs you first: the waiting
// group always on top, each group by last activity; usage: most usage tokens (current window) first; name: A to Z. `dir` flips the order of the key (inside each group for
// needs you first); without it the key's own default is used (DEFAULT_DIR).
export function sortItems(items: Item[], key: SortKey, dir?: SortDir): Item[] {
  const k = (sortAlias(key) as SortKey) in DEFAULT_DIR ? (sortAlias(key) as SortKey) : 'thread'
  const s = (dir ?? DEFAULT_DIR[k]) === 'asc' ? 1 : -1
  const byActive = (a: Item, b: Item) => (a.activity - b.activity || num(a.id) - num(b.id)) * s
  const cmp: Record<SortKey, (a: Item, b: Item) => number> = {
    thread: (a, b) => {
      const x = numOrNaN(a.id)
      const y = numOrNaN(b.id)
      if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) && Number.isNaN(y) ? a.id.localeCompare(b.id) : Number.isNaN(x) ? 1 : -1
      return (x - y) * s
    },
    active: byActive,
    needs: (a, b) => Number(b.needs) - Number(a.needs) || byActive(a, b),
    usage: (a, b) => (a.cost - b.cost) * s || byActive(a, b),
    name: (a, b) => (a.title.toLowerCase().localeCompare(b.title.toLowerCase()) || num(a.id) - num(b.id)) * s,
  }
  return [...items].sort(cmp[k])
}

// ---- hidden sessions (1.0.33): a completed session (done, or closed) the user hid. The mod's store keeps id -> the session's last activity at the time of the press; the card is
// hidden only while it is still completed, nothing is unread and nothing waits for the user, and nothing newer happened (a wake, a restart, a report, a message all move the
// activity). Hiding closes nothing and deletes nothing. ----
export type Hidden = Record<string, number>
export const completed = (i: Item): boolean => i.closed || (!!i.t && i.t.done && !i.t.working && !i.t.needsYou)
// something that must never be hidden away: an unread message, a request or question waiting for the user, a held send
export const mustShow = (i: Item, o: { unread: boolean; held: boolean }): boolean => i.needs || o.unread || o.held || !!i.t?.pending
export const canHide = (i: Item, o: { unread: boolean; held: boolean }): boolean => completed(i) && !mustShow(i, o)
export const isHidden = (i: Item, hidden: Hidden, o: { unread: boolean; held: boolean }): boolean => typeof hidden[i.id] === 'number' && canHide(i, o) && i.activity <= hidden[i.id]!
export async function readHidden(h: Host): Promise<Hidden> {
  const raw: unknown = await h.store.get(HIDDEN_STORE).catch(() => undefined)
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  return Object.fromEntries(Object.entries(o).filter(([k, v]) => /^t\d+$/.test(k) && typeof v === 'number' && Number.isFinite(v))) as Hidden
}
// read-modify-write of the set from a press
export async function saveHidden(h: Host, f: (cur: Hidden) => Hidden): Promise<void> {
  await h.store.set(HIDDEN_STORE, f(await readHidden(h))).catch(() => undefined)
}

// the first `max` rows, plus (in order) every later row `keep` names: a row with an unread message or something waiting for the user is never hidden by the cap
export function capItems(items: Item[], max: number, keep: (i: Item) => boolean): { shown: Item[]; hidden: number } {
  const shown = items.filter((i, n) => n < max || keep(i))
  return { shown, hidden: items.length - shown.length }
}

// the model chip of a folded session card (1.0.35): "sonnet/high", "haiku/low"; the effort abbreviated (low / med / high / xhigh / max), a leading "claude-" dropped; nothing when
// neither is recorded (no "unknown" chip). The unfolded card says both in full.
export const EFFORT_SHORT: Record<string, string> = { low: 'low', medium: 'med', med: 'med', high: 'high', xhigh: 'xhigh', max: 'max' }
export function modelChip(model?: string, effort?: string): string {
  const m = (model ?? '').trim().replace(/^claude-/, '')
  const e = (effort ?? '').trim()
  const es = e ? (EFFORT_SHORT[e.toLowerCase()] ?? e) : ''
  return m && es ? `${m}/${es}` : m || es
}

// "just now", "5 min ago", "3 h ago", "2 d ago"
export function ageText(at: number, now: number): string {
  if (!(at > 0)) return 'no activity yet'
  const m = Math.floor(Math.max(0, now - at) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  if (m < 48 * 60) return `${Math.floor(m / 60)} h ago`
  return `${Math.floor(m / 1440)} d ago`
}

// ---- settings ----
export type PaneConfig = { sort: SortKey; sortDir: SortDir | 'auto'; maxSessions: number; healthOpen: boolean; foldAll: boolean }
export const isSort = (x: unknown): x is SortKey => typeof x === 'string' && (SORTS as readonly string[]).includes(x)
const isDirChoice = (x: unknown): x is SortDir | 'auto' => typeof x === 'string' && (SORT_DIRS as readonly string[]).includes(x)
// the direction in force: the explicit choice (asc / desc), else the key's own default
export const effectiveDir = (c: Pick<PaneConfig, 'sort' | 'sortDir'>): SortDir => (c.sortDir === 'auto' ? DEFAULT_DIR[c.sort] : c.sortDir)
export async function paneConfig(h: Host): Promise<PaneConfig> {
  const cfg = await readJson<Record<string, any> | null>(h, `${leanDir(await homeDir(h))}/config.json`, null).catch(() => null)
  const pick = (k: string) => (cfg?.pane && typeof cfg.pane === 'object' ? cfg.pane[k] : undefined) ?? cfg?.[`pane.${k}`]
  const stored = await h.store.get(SORT_STORE).catch(() => undefined)
  const storedDir = await h.store.get(SORTDIR_STORE).catch(() => undefined)
  const max = Number(pick('maxSessions'))
  const open = pick('healthOpen')
  const fold = pick('foldAll')
  return {
    sort: isSort(sortAlias(pick('sort'))) ? (sortAlias(pick('sort')) as SortKey) : isSort(sortAlias(stored)) ? (sortAlias(stored) as SortKey) : 'thread', // (the config key wins: it is what the user wrote; the store keeps the press when config.json cannot be written; the old "cost" reads as usage)
    sortDir: isDirChoice(pick('sortDir')) ? (pick('sortDir') as SortDir | 'auto') : isDirChoice(storedDir) ? storedDir : 'auto', // (same rule; auto = the default direction of the sort)
    maxSessions: Number.isInteger(max) && max >= 5 && max <= 500 ? max : MAX_SESSIONS,
    healthOpen: open === true || open === 'open',
    foldAll: !(fold === false || fold === 'false'), // (1.0.33: every card starts folded; false brings back the old auto-unfold of a session card with a decision to take)
  }
}
export async function saveSort(h: Host, key: SortKey): Promise<void> {
  await h.store.set(SORT_STORE, key).catch(() => undefined)
  await configTool(h, { action: 'set', key: 'pane.sort', value: key }).catch(() => undefined)
}
// the direction chip (or a tap on the active sort chip): the same two places
export async function saveSortDir(h: Host, dir: SortDir | 'auto'): Promise<void> {
  await h.store.set(SORTDIR_STORE, dir).catch(() => undefined)
  await configTool(h, { action: 'set', key: 'pane.sortDir', value: dir }).catch(() => undefined)
}
