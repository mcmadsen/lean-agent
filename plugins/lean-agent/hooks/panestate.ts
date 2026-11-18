// The pane's own view state (which sections are folded, which rows are expanded, a pending two-step confirm). It lives in the
// engine's `$.state` (declared in types/index.d.ts as PluginState['lean-agent'].pane), so it survives redraws and mod reloads and is
// kept per session. A build without `$.state` keeps it in this module instead (lost on a reload, never an error).
export type PaneUi = {
  open: Record<string, boolean> // section name -> unfolded (absent = the section's default)
  more: boolean // Answers: show all rows, not just the newest few
  rows: Record<string, boolean> // `a<n>` an answer row expanded; `g<tN>` an answer group unfolded
  confirm: { key: string; until: number } | null // a first press of Close / Close all done waits for its second
}
export const EMPTY_UI: PaneUi = { open: {}, more: false, rows: {}, confirm: null }
export const CONFIRM_MS = 10_000

let mirror: PaneUi = EMPTY_UI
export const resetPaneUi = () => {
  mirror = EMPTY_UI
}

const clean = (v: unknown): PaneUi => {
  const o = v && typeof v === 'object' ? (v as Partial<PaneUi>) : {}
  const rec = (x: unknown): Record<string, boolean> => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as object).filter(([, b]) => typeof b === 'boolean')) : {})
  const c = o.confirm
  return { open: rec(o.open), more: o.more === true, rows: rec(o.rows), confirm: c && typeof c.key === 'string' && Number.isFinite(c.until) ? { key: c.key, until: c.until } : null }
}

// `plugin` and `key` are literals in source, as the engine wants them
export async function readUi($: any): Promise<PaneUi> {
  try {
    const r = await $.state.get({ plugin: 'lean-agent', key: 'pane' } as const)
    return clean(r?.value)
  } catch {
    return mirror
  }
}

// read-modify-write from a press handler (never from a render: the engine refuses a write while drawing); retried once if another
// press wrote in between
export async function patchUi($: any, f: (u: PaneUi) => PaneUi): Promise<PaneUi> {
  for (let n = 0; n < 3; n++) {
    try {
      const r = await $.state.get({ plugin: 'lean-agent', key: 'pane' } as const)
      const next = clean(f(clean(r?.value)))
      const w = await $.state.set({ plugin: 'lean-agent', key: 'pane' } as const, next, { ifVersion: r?.version })
      mirror = next
      if (w?.isSet !== false) return next
    } catch {
      mirror = clean(f(mirror))
      return mirror
    }
  }
  return mirror
}

export const isOpen = (u: PaneUi, name: string, dflt: boolean) => u.open[name] ?? dflt
export const confirming = (u: PaneUi, key: string, now: number) => !!u.confirm && u.confirm.key === key && now < u.confirm.until
