export type MapView = {
  // the latest `lean-agent map --json` snapshot (contract v1), or null
  snap: {
    service: { up: boolean; socket_ms?: number; cpu_pct?: number }
    inbox: number
    paused?: boolean
    nodes: { id: string; label: string; state: string }[]
    moving: { dir: string; node: string; text: string; age_s: number }[]
  } | null
  svg: string
  isDown: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'lean-agent-map': {
      view: Shaped<MapView>
      isPaused: Shaped<boolean>
      waiting: Shaped<string>
    }
  }
}
