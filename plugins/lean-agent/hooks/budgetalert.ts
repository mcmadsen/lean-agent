// Budget alerts for the OPTIONAL token caps (1.0.34): the desk is told when the usage of the current 5 h window reaches 80% and 100% of config `budget.windowTokens`,
// and when the usage since `budget.since` reaches 80% and 100% of `budget.allTimeTokens`. Each alert is a desk notice (notices.ts: the pane lists it) and a toast
// (notify.ts reads `budgetEvents`), once per window (the window's reset time; a rolling 5 h counts as one per day) and once per all-time start. At 100% new work is
// also held (throttle.ts windowState: level capped). Nothing is alerted when no cap is set (the default): the window.* percentages are the main control.
// Run from the desk's chaser tick (chaser.ts), a minute apart; a stat and the tail of the ledger each time.
import { setNotice } from './notices'
import { allTimeUsage, tokenCaps, windowUsage } from './usage'
import { budgetLevel, budgetOf, threadTotals } from './budgetthread'
import { fmtTokens } from './formatusage'
import { dayOf } from './ledger'
import { homeDir, readJson, threadsDir } from './state'
import type { Host } from './state'

const KEY = 'budget.alerts'
type State = { scopes: Record<string, string>; fired: string[]; notices: string[]; events: { key: string; text: string }[] }
const empty = (): State => ({ scopes: {}, fired: [], notices: [], events: [] })

async function readState(h: Host): Promise<State> {
  const v = (await h.store.get(KEY).catch(() => undefined)) as Partial<State> | undefined
  const strs = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [])
  if (!v || typeof v !== 'object') return empty()
  const scopes: Record<string, string> = {}
  if (v.scopes && typeof v.scopes === 'object') for (const [k, s] of Object.entries(v.scopes)) if (typeof s === 'string') scopes[k] = s
  return { scopes, fired: strs(v.fired), notices: strs(v.notices), events: Array.isArray(v.events) ? v.events.filter((e): e is { key: string; text: string } => !!e && typeof e.key === 'string' && typeof e.text === 'string') : [] }
}

export const windowText = (used: number, cap: number, level: 80 | 100, top: { id: string; tokens: number }[]): string =>
  `budget ${level}%: ${fmtTokens(used)} of the ${fmtTokens(cap)} usage tokens cap of this 5 h window ${level === 100 ? 'is used: new work is held until the window resets' : 'are used'}.${top.length ? ` Top threads: ${top.slice(0, 3).map(c => `${c.id} ${fmtTokens(c.tokens)}`).join(', ')}.` : ''} (config budget.windowTokens; the window percentages are the main control)`
export const allTimeText = (used: number, cap: number, level: 80 | 100): string =>
  `budget ${level}%: ${fmtTokens(used)} of the ${fmtTokens(cap)} usage tokens cap since the all-time start ${level === 100 ? 'is used: new work is held until you raise it or start again' : 'are used'} (config budget.allTimeTokens; lean_config set budget.since today starts again)`

// One pass. Returns the keys alerted now (`w80`, `w100`, `a80`, `a100`); never throws (an alert that cannot be made is tried again next minute).
export async function checkBudget(h: Host): Promise<string[]> {
  try {
    const caps = await tokenCaps(h)
    const st = await readState(h)
    const fresh: string[] = []
    const alert = async (key: string, notice: string, text: string, scope: string) => {
      st.fired.push(key)
      if (!st.notices.includes(notice)) st.notices.push(notice)
      st.events.push({ key: `budget:${key}:${scope}`, text })
      await setNotice(h, notice, text)
      fresh.push(key)
    }
    for (const [kind, notice] of [['window', 'budget-window'], ['allTime', 'budget-alltime']] as const) {
      const letter = kind === 'window' ? 'w' : 'a'
      const cap = caps.find(c => c.scope === kind)
      if (!cap) {
        if (st.scopes[kind] !== undefined) { // the cap was removed: its notice ends
          await setNotice(h, notice, null)
          delete st.scopes[kind]
          st.fired = st.fired.filter(k => !k.startsWith(`${letter}`) || !/^[wa]\d+@/.test(k))
        }
        continue
      }
      // the period an alert belongs to: the window (its reset time; a rolling 5 h is one per day), or the all-time start
      const wu = kind === 'window' ? await windowUsage(h) : null
      const period = kind === 'window' ? (wu!.rolling ? `rolling-${dayOf(wu!.now)}` : String(wu!.resetsAt)) : String((await allTimeUsage(h)).since)
      if (st.scopes[kind] !== period) { // a new window, or the start moved: the old alerts are over
        await setNotice(h, notice, null)
        st.scopes[kind] = period
        st.fired = st.fired.filter(k => !k.startsWith(`${letter}`) || !/^[wa]\d+@/.test(k))
        st.notices = st.notices.filter(n => n !== notice)
      }
      const frac = cap.used / cap.cap
      const level = frac >= 1 ? 100 : frac >= 0.8 ? 80 : 0
      const fkey = `${letter}${level}@${period}`
      if (level && !st.fired.includes(fkey)) {
        const top = wu ? Object.entries(wu.byThread).map(([id, t]) => ({ id, tokens: t.tokens })).sort((a, b) => b.tokens - a.tokens || a.id.localeCompare(b.id)) : []
        await alert(fkey, notice, kind === 'window' ? windowText(cap.used, cap.cap, level, top) : allTimeText(cap.used, cap.cap, level), period)
        if (level === 100) st.fired.push(`${letter}80@${period}`) // one jump past both levels says the higher one
      }
    }
    st.events = st.events.slice(-40)
    await h.store.set(KEY, st).catch(() => undefined)
    return fresh.map(k => k.replace(/@.*$/, ''))
  } catch {
    return []
  }
}

// the toasts of the alerts, for notify.ts (it shows each key once)
export async function budgetEvents(h: Host): Promise<{ key: string; text: string }[]> {
  try {
    return (await readState(h)).events
  } catch {
    return []
  }
}

// the chaser's addition to a status message for a thread that is over its own soft budget (config threads.softTokens / its own); '' for the others
export async function expensiveNote(h: Host, id: string): Promise<string> {
  try {
    const home = await homeDir(h)
    const t = await readJson<{ budgetTokens?: unknown } | null>(h, `${threadsDir(home)}/${id}/thread.json`, null)
    const b = t ? await budgetOf(h, t) : null
    if (b === null) return ''
    const used = (await threadTotals(h))[id] ?? 0
    return budgetLevel(used, b) === 'over' ? ` You have used ${fmtTokens(used)} usage tokens, over your soft budget of ${fmtTokens(b)}: say what that bought and whether the rest is worth it (park the thread if not).` : ''
  } catch {
    return ''
  }
}
