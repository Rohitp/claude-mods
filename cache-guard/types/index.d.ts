export type Touch = { at: number; tokens: number; model: string; effort: string }
export type Bust = { at: number; tokens: number; cause: string; detail: string }
export type Beat = 'hit' | 'part' | 'miss'
/** One main-thread request: what it read, what it rewrote, and why if it was a bust. */
export type Step = { n: number; beat: Beat; read: number; wrote: number; note: string }

declare module 'claude-code' {
  interface PluginState {
    'cache-guard': {
      /** The last main-thread request that wrote or read the cache, stamped at its start. */
      touch: Touch | null
      now: number
      ttlMs: number
      isKeepWarm: boolean
      /** Pings in the current idle stretch. */
      pings: number
      totalPings: number
      pingTokens: number
      /** Ping output and uncached input, in input-token equivalents (output counts 5x). */
      pingExtraTokens: number
      /** Idle stretches a ping chain carried to a cache hit. */
      avoided: number
      busts: Bust[]
      steps: Step[]
      billing: 'api' | 'sub'
      limitPct: number | null
      compactedAt: number
      /** False once main-thread steps keep reporting no cache tokens at all. */
      isAvailable: boolean
      /** `touch.at` of the cache window whose band the person dismissed. */
      dismissedAt: number
      /** Start of the last real (non-ping) main-thread request. */
      lastTurnAt: number
      zeroSteps: number
    }
  }
}
