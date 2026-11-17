export type MapView = {
  // the latest `lean-agent map --json` snapshot (contract v1), or null
  snap: {
    service: {
      up: boolean
      socket_ms?: number
      cpu_pct?: number
      socket?: string
      desk?: { mode: string; attached: boolean; age?: string; pending?: number }
    }
    inbox: number
    paused?: boolean
    nodes: {
      id: string
      label: string
      state: string
      kind?: string
      parent?: string
      undelivered?: boolean
      activity?: { now?: string | { tool?: string } | null }
    }[]
    plan?: { windows?: { name: string; label: string; pct: number; resets_at?: number | null }[] }
    totals?: { tools_per_min?: number; usd_today?: number }
    moving: { dir: string; node: string; text: string; age_s: number }[]
  } | null
  svg: string
  isDown: boolean
}

// the pane's footer and status line: the last error, the resolved binary, the surface, the last good poll
export type Diag = { state: string; error: string; bin: string; surface: string; lastOk: string }

declare module 'claude-code' {
  interface PluginState {
    'lean-agent-map': {
      view: Shaped<MapView>
      isPaused: Shaped<boolean>
      waiting: Shaped<string>
      diag: Shaped<Diag>
    }
  }
}
