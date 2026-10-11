// Pure model: prices, formulas and the derived view both surfaces draw from.
import type { Beat, Bust, Touch } from '../types'

export const WRITE = 1.25 // cache write multiplier, 5-minute TTL
export const WARN_MS = 60_000 // toast, band and amber digits this long before expiry
export const PING_LEAD_MS = 30_000 // a ping starts this long before expiry
export const MAX_KEEP_MS = 2 * 3_600_000 // keep-warm ends after this long without a turn

/** $/MTok base input and cache-read multiplier, from the Claude API price table. */
export type Price = { base: number; read: number }
export function priceOf(model: string): Price | null {
  if (/fable-5|mythos/.test(model)) return { base: 10, read: 0.025 }
  if (/opus-5-5/.test(model)) return { base: 4, read: 0.05 }
  if (/opus/.test(model)) return { base: 5, read: 0.1 }
  if (/sonnet-5/.test(model)) return { base: 2, read: 0.1 }
  if (/sonnet/.test(model)) return { base: 3, read: 0.1 }
  if (/haiku-5/.test(model)) return { base: 0.1, read: 0.1 }
  if (/haiku/.test(model)) return { base: 1, read: 0.1 }
  return null
}
export const readMult = (model: string): number => priceOf(model)?.read ?? 0.1
/** Pings that cost no more than the one miss they avoid: (write - read) / read. */
export const breakEven = (model: string): number =>
  Math.max(1, Math.floor((WRITE - readMult(model)) / readMult(model) + 1e-9))

export const usd = (v: number): string => `$${v < 0.1 ? v.toFixed(3) : v.toFixed(2)}`
export const shortModel = (m: string): string => m.replace(/^claude-/, '').replace(/-\d{8}$/, '')

export type Billing = 'api' | 'sub'
export type Mode = 'api' | 'sub' | 'unk'
export type State = 'empty' | 'normal' | 'warn' | 'crit' | 'na'

export type Guard = {
  billing: Billing
  ttlMs: number
  touch: Touch | null
  now: number
  isKeepWarm: boolean
  pings: number
  totalPings: number
  pingTokens: number
  pingExtraTokens: number
  avoided: number
  busts: Bust[]
  beats: Beat[]
  limitPct: number | null
  isAvailable: boolean
  dismissedAt: number
  lastTurnAt: number
}

export type View = {
  state: State
  mode: Mode
  model: string
  ttlLabel: string
  tokens: number
  leftMs: number
  /** Seconds left as m:ss; `—:——` before the first cache write. */
  clock: string
  /** Rewrite cost above a hit, and a ping's cost, in dollars (api mode with a known price). */
  miss: number | null
  ping: number | null
  readMult: number
  breakEven: number
  isKeepWarm: boolean
  pings: number
  totalPings: number
  pingTokens: number
  spent: number | null
  net: number | null
  avoided: number
  nextPingMs: number | null
  limitPct: number | null
  busts: Bust[]
  beats: Beat[]
  bustTokens: number
  bustCost: number | null
  /** Dollars a rewritten token costs above a read, when the price is known. */
  missPerToken: number | null
  isDismissed: boolean
  ttlMs: number
  expiredMs: number
}

export function derive(g: Guard): View {
  const t = g.touch
  const model = t?.model ?? ''
  const price = priceOf(model)
  const mode: Mode = g.billing === 'sub' ? 'sub' : price ? 'api' : 'unk'
  const r = readMult(model)
  const tokens = t?.tokens ?? 0
  const leftMs = t ? g.ttlMs - (g.now - t.at) : 0
  const state: State = !g.isAvailable ? 'na' : !t ? 'empty' : leftMs <= 0 ? 'crit' : leftMs <= WARN_MS ? 'warn' : 'normal'
  const dollars = (tok: number): number | null => (price ? (tok / 1e6) * price.base : null)
  const per = (mult: number): number | null => {
    const d = dollars(tokens)
    return d === null ? null : d * mult
  }
  // Reads at the read multiplier, plus what the ping generated and sent uncached.
  const spent = price ? ((g.pingTokens * r + g.pingExtraTokens) / 1e6) * price.base : null
  const miss = per(WRITE - r)
  const net = miss !== null && spent !== null ? g.avoided * miss - spent : null
  const bustTokens = g.busts.reduce((n, b) => n + b.tokens, 0)
  const bustD = dollars(bustTokens)
  return {
    state,
    mode,
    model,
    ttlLabel: g.ttlMs >= 3_600_000 ? '1h' : '5m',
    tokens,
    leftMs,
    clock: t ? mmss(Math.max(0, leftMs)) : '—:——',
    miss,
    ping: per(r),
    readMult: r,
    breakEven: breakEven(model),
    isKeepWarm: g.isKeepWarm,
    pings: g.pings,
    totalPings: g.totalPings,
    pingTokens: g.pingTokens,
    spent,
    net,
    avoided: g.avoided,
    nextPingMs: t && g.isKeepWarm ? Math.max(0, leftMs - PING_LEAD_MS) : null,
    limitPct: g.limitPct,
    busts: g.busts,
    beats: g.beats,
    bustTokens,
    bustCost: bustD === null ? null : bustD * (WRITE - r),
    missPerToken: price ? (price.base / 1e6) * (WRITE - r) : null,
    isDismissed: !!t && g.dismissedAt > 0 && g.dismissedAt === t.at,
    ttlMs: g.ttlMs,
    expiredMs: t ? Math.max(0, g.now - t.at - g.ttlMs) : 0,
  }
}

function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** The fixed-width status line entry. Plain text: the engine draws the status line itself. */
export function statusText(v: View, isKeep: boolean): string {
  // Fixed 11-cell field so the countdown never shifts its neighbours.
  const pad = (s: string): string => s.padEnd(11)
  if (v.state === 'na') return pad('cache n/a')
  if (v.state === 'empty') return pad('cache —:——')
  if (v.state === 'crit') return pad('cache STALE')
  return isKeep ? `${pad(`cache ${v.clock}`).trimEnd()} ↻` : pad(`cache ${v.clock}`)
}

/** Toast copy, shown once per cache window and only while keep-warm is off. */
export function toastText(v: View): string {
  if (v.mode === 'api') {
    return `Cache expires in ${v.clock}. After that, the next turn costs +${usd(v.miss ?? 0)} est. Keep warm pings it for ${usd(v.ping ?? 0)} est. each.`
  }
  return `Cache expires in ${v.clock}. After that, the next turn re-sends the whole prefix at ${WRITE}x. Keep warm re-reads it at ${v.readMult}x each time.`
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

/** State from an earlier version survives a hot reload; keep only what fits the current shape. */
export function sanitizeGuard(g: Guard): Guard {
  const t = g.touch as Partial<Touch> | null
  const touch: Touch | null =
    t && typeof t === 'object' && isNum(t.at) && isNum(t.tokens) && typeof t.model === 'string'
      ? { at: t.at, tokens: t.tokens, model: t.model, effort: typeof t.effort === 'string' ? t.effort : 'default' }
      : null
  const busts = (Array.isArray(g.busts) ? g.busts : [])
    .filter(b => !!b && isNum(b.at) && isNum(b.tokens) && typeof b.cause === 'string')
    .map(b => ({ at: b.at, tokens: b.tokens, cause: b.cause, detail: typeof b.detail === 'string' ? b.detail : '' }))
  const beats = (Array.isArray(g.beats) ? g.beats : []).filter(b => b === 'hit' || b === 'part' || b === 'miss')
  return {
    ...g,
    touch,
    busts,
    beats,
    billing: g.billing === 'sub' ? 'sub' : 'api',
    ttlMs: isNum(g.ttlMs) && g.ttlMs > 0 ? g.ttlMs : 300_000,
    now: isNum(g.now) ? g.now : 0,
    pingExtraTokens: isNum(g.pingExtraTokens) ? g.pingExtraTokens : 0,
    limitPct: isNum(g.limitPct) ? g.limitPct : null,
  }
}
