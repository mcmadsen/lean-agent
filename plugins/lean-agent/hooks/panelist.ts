// The desk pane's session list (1.0.32): ONE list of every thread (open, done and closed), ordered by last activity unless the user picked another
// order, capped with one "show more" row. All of it is script on the state the view already holds: no model call, no polling.
// Settings (hooks/configkeys.ts): pane.sort (also remembered in the mod's store, the press that changes it writes both), pane.maxSessions, pane.healthOpen.
import { homeDir, leanDir, readJson } from './state'
import type { Host } from './state'
import { stateOf } from './view'
import type { ClosedRow, NeedRow, ThreadRow } from './view'
import { configTool } from './configtool'

export const SORTS = ['active', 'needs', 'cost', 'name'] as const
export type SortKey = (typeof SORTS)[number]
export const SORT_LABEL: Record<SortKey, string> = { active: 'last active', needs: 'needs you first', cost: 'cost', name: 'name' }
export const MAX_SESSIONS = 30
export const SORT_STORE = 'pane.sort'

// one row of the list: an open thread (t) or a closed one (c)
export type Item = { id: string; title: string; activity: number; cost: number; closed: boolean; needs: boolean; t?: ThreadRow; c?: ClosedRow }

// the states that wait for the user (the same words the widget counts as blocked): they sit on top under "needs you first"
const WAITING_WORDS = ['waiting', 'waiting for answer', 'approval', 'asking', 'blocked', 'stuck', 'stalled']
export const needsUser = (t: ThreadRow, needs: Pick<NeedRow, 'thread'>[] = []): boolean => WAITING_WORDS.includes(stateOf(t).word) || !!t.pending || needs.some(n => n.thread === t.id)
const num = (id: string) => Number(id.replace(/^\D+/, '')) || 0

export function itemsOf(threads: ThreadRow[], closed: ClosedRow[], needs: Pick<NeedRow, 'thread'>[] = []): Item[] {
  return [
    ...threads.map((t): Item => ({ id: t.id, title: t.title, activity: t.activity ?? t.recTs ?? 0, cost: t.cost, closed: false, needs: needsUser(t, needs), t })),
    ...closed.map((c): Item => ({ id: c.id, title: c.title, activity: c.activity, cost: c.cost, closed: true, needs: false, c })),
  ]
}

// last active: newest first (the default); needs you first: the waiting group on top, each group by last activity; cost: dearest first; name: A to Z
export function sortItems(items: Item[], key: SortKey): Item[] {
  const byActive = (a: Item, b: Item) => b.activity - a.activity || num(b.id) - num(a.id)
  const cmp: Record<SortKey, (a: Item, b: Item) => number> = {
    active: byActive,
    needs: (a, b) => Number(b.needs) - Number(a.needs) || byActive(a, b),
    cost: (a, b) => b.cost - a.cost || byActive(a, b),
    name: (a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()) || num(a.id) - num(b.id),
  }
  return [...items].sort(cmp[key])
}

// the first `max` rows, plus (in order) every later row `keep` names: a row with an unread message or something waiting for the user is never hidden by the cap
export function capItems(items: Item[], max: number, keep: (i: Item) => boolean): { shown: Item[]; hidden: number } {
  const shown = items.filter((i, n) => n < max || keep(i))
  return { shown, hidden: items.length - shown.length }
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
export type PaneConfig = { sort: SortKey; maxSessions: number; healthOpen: boolean }
export const isSort = (x: unknown): x is SortKey => typeof x === 'string' && (SORTS as readonly string[]).includes(x)
export async function paneConfig(h: Host): Promise<PaneConfig> {
  const cfg = await readJson<Record<string, any> | null>(h, `${leanDir(await homeDir(h))}/config.json`, null).catch(() => null)
  const pick = (k: string) => (cfg?.pane && typeof cfg.pane === 'object' ? cfg.pane[k] : undefined) ?? cfg?.[`pane.${k}`]
  const stored = await h.store.get(SORT_STORE).catch(() => undefined)
  const max = Number(pick('maxSessions'))
  const open = pick('healthOpen')
  return {
    sort: isSort(pick('sort')) ? (pick('sort') as SortKey) : isSort(stored) ? stored : 'active', // (the config key wins: it is what the user wrote; the store keeps the press when config.json cannot be written)
    maxSessions: Number.isInteger(max) && max >= 5 && max <= 500 ? max : MAX_SESSIONS,
    healthOpen: open === true || open === 'open',
  }
}
export async function saveSort(h: Host, key: SortKey): Promise<void> {
  await h.store.set(SORT_STORE, key).catch(() => undefined)
  await configTool(h, { action: 'set', key: 'pane.sort', value: key }).catch(() => undefined)
}
