export type Cat = { name: string; tokens: number; color: string; kind: 'used' | 'free' | 'buffer' | 'deferred' }
export type Named = { label: string; tokens: number }
/** `tokens` counts only loaded tool schemas; `deferred` tools are fetched on demand. */
export type Server = { label: string; tokens: number; tools: number; deferred: number }
export type Lens = {
  cats: Cat[]
  /** Tokens in use, over the compaction window `max`; `window` is the model's own. */
  total: number
  max: number
  window: number
  model: string
  autoCompactAt: number | null
  servers: Server[]
  memory: Named[]
  skills: Named[]
  agents: Named[]
  /** Messages split by where they came from, scaled to the Messages row. */
  sources: Named[]
  /** Everything in the window that is not Messages. */
  overhead: number
  billing: 'api' | 'sub'
  limitPct: number | null
}
export type Point = { total: number; overhead: number; isCompaction: boolean; /** Turn number, counted from the first measurement. */ n: number }
export type Tab = 'category' | 'items' | 'whatif' | 'trend'

declare module 'claude-code' {
  interface PluginState {
    'context-lens': {
      lens: Lens | null
      isBandOn: boolean
      tab: Tab
      history: Point[]
      /** Label of the item the What-if tab is about; '' means the largest. */
      whatIf: string
      /** Items-tab groups that are open. */
      open: string[]
      /** Start of the last main-thread request, to judge whether the cache is cold. */
      lastTurnAt: number
      now: number
      /** Context size when the compact offer was dismissed; 0 when it has not been. */
      snoozeAt: number
    }
  }
}
