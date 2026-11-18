export type Goal = { id: string; ref: string; thread: string; state: 'working' | 'waiting' | 'stuck' | 'quiet'; raw_state?: string; quiet: string; next: string }
export type Answer = { id: string; q: string; a: string; thread: string; age: string; unread: boolean }

// `lean-agent pane --json`
export type PaneData = {
  v: number
  ts: string
  service: { up: boolean; version?: string }
  desk: { mode: string; attached: boolean; active?: string; label?: string; line?: string; pending?: number }
  goals: Goal[]
  answers: Answer[]
  inbox: number
  error?: string
}

// the pane's footer and status line: the last error, the resolved binary, the surface, the last good poll
export type Diag = { state: string; error: string; bin: string; surface: string; lastOk: string }

// the desk pane's own view state (hooks/panestate.ts): folded sections, expanded rows, a pending two-step confirm
export type PaneUi = {
  open: Record<string, boolean>
  more: boolean
  rows: Record<string, boolean>
  confirm: { key: string; until: number } | null
}

declare module 'claude-code' {
  interface PluginState {
    'lean-agent': {
      data: Shaped<PaneData | null>
      diag: Shaped<Diag>
      pane: PaneUi
    }
  }
}
