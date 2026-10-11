export type Row = { name: string; tokens: number; color: string; kind: 'used' | 'free' | 'buffer' | 'deferred' }
export type Item = { label: string; group: string; tokens: number }
export type Lens = {
  rows: Row[]
  /** Largest single things in the window across memory, MCP, skills, agents. */
  items: Item[]
  /** Messages split by where they came from (tool results by tool, prompts, replies). */
  messages: Item[]
  /** MCP tokens grouped by server. */
  servers: Item[]
  total: number
  max: number
  percent: number
  model: string
  autoCompactAt?: number
  mode: 'api' | 'sub'
  limitPct: number | null
}
export type Tab = 'category' | 'items' | 'whatif' | 'trend'

declare module 'claude-code' {
  interface PluginState {
    'context-lens': { lens: Lens | null; isBandOn: boolean; tab: Tab; history: number[] }
  }
}
