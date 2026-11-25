// The text of usage tokens (1.0.33), pure: the pane header, the thread cards, `lean_thread list` and the doctor all call these, so the words are said once.
// A number shows as 950, 9.5k, 48k, 2.1M, 1.2G; "tokens" always means the weighted usage tokens (usage.ts: input + 1.25 cache write + 0.1 cache read + 5 output).
// No imports on purpose (the pane imports it).

export function fmtTokens(n: number): string {
  const v = Number.isFinite(n) ? Math.max(0, n) : 0
  const one = (x: number, unit: string) => {
    const r = Math.round(x * 10) / 10
    return `${Number.isInteger(r) ? r : r.toFixed(1)}${unit}`
  }
  if (v >= 1e9 || Math.round(v / 1e6) >= 1000) return one(v / 1e9, 'G')
  if (v >= 1e6 || Math.round(v / 1e3) >= 1000) return one(v / 1e6, 'M')
  if (v >= 1e4) return `${Math.round(v / 1e3)}k`
  if (v >= 1e3) return one(v / 1e3, 'k')
  return String(Math.round(v))
}

export type UsageHead = { windowTokens: number; windowPct: number | null; weekPct: number | null; rolling?: boolean }
const pct = (n: number | null | undefined): string => (typeof n === 'number' && Number.isFinite(n) ? `${Math.round(n)}%` : '')

// the unfolded pane header: "window 1.2M tokens (1%) · 7d 65%"; a rolling 5 h says so ("last 5h 1.2M tokens"); "usage n/a" when nothing is known
export function headerText(s: UsageHead | null | undefined): string {
  if (!s) return 'usage n/a'
  const p = pct(s.windowPct)
  const w = `${s.rolling ? 'last 5h' : 'window'} ${fmtTokens(s.windowTokens)} tokens${p ? ` (${p})` : ''}`
  const d = pct(s.weekPct)
  return d ? `${w} · 7d ${d}` : w
}
// the folded header line: the window's token number only ("1.2M tokens"; the pane adds its own "window 61%" next to it, a rolling 5 h says so)
export const foldedText = (s: UsageHead | null | undefined): string => (s ? `${s.rolling ? 'last 5h ' : ''}${fmtTokens(s.windowTokens)} tokens` : 'usage n/a')
// the compact line for the minimised pane and a thread's status line
export const deskText = (s: UsageHead | null | undefined): string => (s ? `${s.rolling ? 'last 5h' : 'window'} ${fmtTokens(s.windowTokens)} tokens` : 'usage n/a')

export type CardUsage = { tokens: number; over?: boolean; reviews?: number; restarts?: number; main?: number; workers?: number }
// "48k" for a card chip, "48k!" when the thread is over its soft budget
export const cardBadge = (c: Pick<CardUsage, 'tokens' | 'over'>): string => `${fmtTokens(c.tokens)}${c.over ? '!' : ''}`
// "window 48k tokens (reviews 12k, restarts 3k)": the card, the list and the thread pane say the same line; a part at zero is left out. withSplit (the thread pane):
// "window 48k tokens (main 20k · workers 16k · reviews 12k, restarts 3k)"
export function cardText(c: CardUsage, withSplit = false, scope = 'window'): string {
  const split = withSplit && (c.main !== undefined || c.workers !== undefined) ? `main ${fmtTokens(c.main ?? 0)} · workers ${fmtTokens(c.workers ?? 0)} · reviews ${fmtTokens(c.reviews ?? 0)}` : c.reviews ? `reviews ${fmtTokens(c.reviews)}` : ''
  const p = [split, c.restarts ? `restarts ${fmtTokens(c.restarts)}` : ''].filter(Boolean)
  return `${scope} ${fmtTokens(c.tokens)} tokens${c.over ? '!' : ''}${p.length ? ` (${p.join(', ')})` : ''}`
}
// a closed card: just the number
export const closedText = (tokens: number): string => `window ${fmtTokens(tokens)} tokens`

// "6.4k/8k" next to a thread's context: its lifetime usage against its soft budget
export const budgetText = (used: number, budget: number): string => `${fmtTokens(used)}/${fmtTokens(budget)}`

// "48k", "48 000", "1.5M", "2m" typed by a person -> tokens; null when it is not a number of tokens (a bare number is tokens, k / m / g multiply)
export function parseTokenCount(text: unknown): number | null {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*([kmg]?)\s*(?:tokens?)?\s*$/i.exec(String(text ?? '').replace(/(\d)[\s_](\d{3})\b/g, '$1$2'))
  if (!m) return null
  const mult = { '': 1, k: 1e3, m: 1e6, g: 1e9 }[m[2]!.toLowerCase() as '' | 'k' | 'm' | 'g']
  const n = Math.round(Number(m[1]!.replace(',', '.')) * mult)
  return Number.isFinite(n) ? n : null
}
