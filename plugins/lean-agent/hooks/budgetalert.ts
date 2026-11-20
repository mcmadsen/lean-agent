// Budget alerts by default: the desk is told when the day's spend reaches 50% and 80% of config `budget.daily` (default 25 USD, "off" allowed)
// and when one thread passes `budget.threadDaily` (default 20 USD). Each alert is a desk notice (notices.ts: the pane lists it) and a toast
// (notify.ts reads `budgetEvents`), once per day per level / per thread. These are warnings: a request is only ever refused by
// dailyCapUsd (budget.ts overBudget). Run from the desk's chaser tick (chaser.ts), a minute apart; a stat and the tail of the ledger each time.
import { budgetLimits } from './budget'
import { setNotice } from './notices'
import { spendNumbers, threadCostsToday } from './stats'
import type { ThreadCost } from './stats'
import { dayOf } from './ledger'
import type { Host } from './state'

const KEY = 'budget.alerts'
type State = { day: string; fired: string[]; notices: string[]; events: { key: string; text: string }[] }
const empty = (day: string): State => ({ day, fired: [], notices: [], events: [] })
const usd = (n: number) => `$${n.toFixed(2)}`
const tag = (c: ThreadCost) => (c.model ? ` ${c.model.replace(/^claude-/, '')}${c.effort ? `/${c.effort}` : ''}` : '')

async function readState(h: Host, day: string): Promise<State> {
  const v = (await h.store.get(KEY).catch(() => undefined)) as Partial<State> | undefined
  const strs = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [])
  if (!v || typeof v !== 'object' || v.day !== day) return empty(day)
  return { day, fired: strs(v.fired), notices: strs(v.notices), events: Array.isArray(v.events) ? v.events.filter((e): e is { key: string; text: string } => !!e && typeof e.key === 'string' && typeof e.text === 'string') : [] }
}

export const dailyText = (today: number, limit: number, level: 50 | 80, top: ThreadCost[]): string =>
  `budget ${level}%: ${usd(today)} of the ${usd(limit)} daily budget is spent today.${top.length ? ` Top threads: ${top.slice(0, 3).map(c => `${c.id} ${usd(c.usd)}${tag(c)}`).join(', ')}.` : ''} (config budget.daily, "off" turns it off)`
export const threadText = (c: ThreadCost, limit: number): string =>
  `budget: ${c.id} has spent ${usd(c.usd)} today, over its ${usd(limit)} daily alert${tag(c) ? ` (${tag(c).trim()})` : ''}. Ask what it is doing, or park it. (config budget.threadDaily)`

// One pass. Returns the keys alerted now (`d50`, `d80`, `tN`); never throws (an alert that cannot be made is tried again next minute).
export async function checkBudget(h: Host): Promise<string[]> {
  try {
    const now = await h.clock.now()
    const day = dayOf(now)
    let st = await readState(h, day)
    const stored = (await h.store.get(KEY).catch(() => undefined)) as Partial<State> | undefined
    if (stored && typeof stored === 'object' && stored.day && stored.day !== day) {
      for (const k of Array.isArray(stored.notices) ? stored.notices : []) if (typeof k === 'string') await setNotice(h, k, null) // yesterday's alerts are over
      st = empty(day)
    }
    const lim = await budgetLimits(h)
    if (lim.daily === null && lim.thread === null) {
      await h.store.set(KEY, st).catch(() => undefined)
      return []
    }
    const spend = await spendNumbers(h)
    if (!spend) return []
    const costs = await threadCostsToday(h, spend)
    const top = Object.values(costs).sort((a, b) => b.usd - a.usd || a.id.localeCompare(b.id))
    const fresh: string[] = []
    const alert = async (key: string, notice: string, text: string, lower: string[] = []) => {
      st.fired.push(key, ...lower.filter(l => !st.fired.includes(l)))
      if (!st.notices.includes(notice)) st.notices.push(notice)
      st.events.push({ key: `budget:${key}:${day}`, text })
      await setNotice(h, notice, text)
      fresh.push(key)
    }
    if (lim.daily !== null) {
      const pct = spend.today / lim.daily
      const level = pct >= 0.8 ? 80 : pct >= 0.5 ? 50 : 0
      if (level && !st.fired.includes(`d${level}`)) await alert(`d${level}`, 'budget-daily', dailyText(spend.today, lim.daily, level, top), level === 80 ? ['d50'] : []) // one jump past both levels says the higher one
    }
    if (lim.thread !== null) {
      for (const c of top) if (c.usd >= lim.thread && !st.fired.includes(c.id)) await alert(c.id, `budget-${c.id}`, threadText(c, lim.thread))
    }
    await h.store.set(KEY, st).catch(() => undefined)
    return fresh
  } catch {
    return []
  }
}

// the toasts of today's alerts, for notify.ts (it shows each key once)
export async function budgetEvents(h: Host): Promise<{ key: string; text: string }[]> {
  try {
    return (await readState(h, dayOf(await h.clock.now()))).events
  } catch {
    return []
  }
}

// the chaser's addition to a status message for a thread that is over its daily alert; '' for the others
export async function expensiveNote(h: Host, id: string): Promise<string> {
  try {
    const c = (await threadCostsToday(h))[id]
    return c?.over ? ` You have spent ${usd(c.usd)} today, over the daily alert: say what that spend bought and whether the rest is worth it (park the thread if not).` : ''
  } catch {
    return ''
  }
}
