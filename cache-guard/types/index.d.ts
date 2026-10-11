export type Touch = { at: number; tokens: number; model: string; effort: string }
export type Bust = { at: number; tokens: number; cause: string }
export type Beat = 'hit' | 'part' | 'miss'

declare module 'claude-code' {
  interface PluginState {
    'cache-guard': {
      touch: Touch | null
      now: number
      ttlMs: number
      isKeepWarm: boolean
      pings: number
      totalPings: number
      pingTokens: number
      busts: Bust[]
      beats: Beat[]
      mode: 'api' | 'sub'
      limitPct: number | null
      compactedAt: number
    }
  }
}
