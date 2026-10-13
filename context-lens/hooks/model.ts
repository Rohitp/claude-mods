// Pure model: prices, formulas and the view both surfaces draw from.
import type { Lens, Named, Point } from '../types'

export const WRITE = 1.25
export const WARN_PCT = 80
export const COLD_MS = 300_000 // the default 5-minute cache TTL

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
export const usd = (v: number): string => `$${v < 0.01 ? v.toFixed(3) : v.toFixed(2)}`

export type Mode = 'api' | 'sub' | 'unk'
export type State = 'empty' | 'normal' | 'warn' | 'crit'

export type Candidate = { key: string; label: string; kind: string; tokens: number }

export type WhatIf = {
  item: Candidate
  frees: number
  pctWindow: number
  savesPerTurn: number | null
  rebuild: number | null
  /** Turns until the rebuild is paid back, rounded to ten; 0 when the cache is cold. */
  turns: number
  isCold: boolean
}

/** What compacting yourself would free, offered once the window is filling. Estimates. */
export type Offer = {
  frees: number
  pctWindow: number
  /** Dollars less per turn afterwards, on API billing with a known price. */
  savesPerTurn: number | null
}

/** Messages shrink to a summary, taken as a tenth of them within 2k to 20k tokens. */
export function offerOf(l: Lens, mode: Mode, read: number): Offer | null {
  const messages = Math.max(0, l.total - l.overhead)
  const summary = Math.min(20_000, Math.max(2_000, messages * 0.1))
  const frees = Math.round(messages - summary)
  if (frees < 5_000) return null
  const price = priceOf(l.model)
  return {
    frees,
    pctWindow: (frees / l.window) * 100,
    savesPerTurn: price && mode === 'api' ? (frees / 1e6) * price.base * read : null,
  }
}

/** Dismissed offers stay quiet until the context has grown by this much since. */
export const SNOOZE_GROWTH = 1.1

export type View = {
  lens: Lens | null
  state: State
  mode: Mode
  percent: number
  /** The compaction threshold as a percent of the window. */
  thresholdPct: number | null
  growth: number | null
  turnsLeft: number | null
  read: number
  carry: number | null
  rewrite: number | null
  isCold: boolean
  candidates: Candidate[]
  /** Set while the state is warn or crit and the offer is not snoozed. */
  offer: Offer | null
}

export function growthPerTurn(h: Point[]): number | null {
  if (h.length < 4) return null
  const n = h.length - 1
  const back = Math.min(10, n)
  const g = (h[n]!.total - h[n - back]!.total) / back
  return Number.isFinite(g) ? g : null
}

/** `snoozeAt` is the context size when the offer was last dismissed, 0 for never. */
export function derive(lens: Lens | null, h: Point[], now: number, lastTurnAt: number, snoozeAt = 0): View {
  const price = lens ? priceOf(lens.model) : null
  const mode: Mode = !lens ? 'api' : lens.billing === 'sub' ? 'sub' : price ? 'api' : 'unk'
  const read = price?.read ?? 0.1
  const isCold = lastTurnAt > 0 && now - lastTurnAt > COLD_MS
  if (!lens || lens.total <= 0) {
    return { lens, state: 'empty', mode, percent: 0, thresholdPct: null, growth: null, turnsLeft: null, read, carry: null, rewrite: null, isCold, candidates: [], offer: null }
  }
  const percent = Math.round((lens.total / lens.window) * 100)
  const thresholdPct = lens.autoCompactAt ? Math.round((lens.autoCompactAt / lens.window) * 100) : null
  const growth = growthPerTurn(h)
  const left = lens.autoCompactAt && growth && growth > 0 ? (lens.autoCompactAt - lens.total) / growth : null
  const state: State =
    left !== null && left < 1 ? 'crit' : lens.autoCompactAt && lens.total >= lens.autoCompactAt ? 'crit' : percent >= WARN_PCT ? 'warn' : 'normal'
  const dollars = (tok: number, mult: number): number | null => (price ? (tok / 1e6) * price.base * mult : null)
  const named = (kind: string, a: Named[]): Candidate[] => a.map(x => ({ key: `${kind}:${x.label}`, label: x.label, kind, tokens: x.tokens }))
  const candidates = [
    ...lens.servers.map(s => ({ key: `mcp:${s.label}`, label: s.label, kind: 'MCP server', tokens: s.tokens })),
    ...named('Memory file', lens.memory),
  ]
    .filter(c => c.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
  const isSnoozed = snoozeAt > 0 && lens.total < snoozeAt * SNOOZE_GROWTH
  const offer = state !== 'normal' && !isSnoozed ? offerOf(lens, mode, read) : null
  return {
    lens,
    state,
    mode,
    percent,
    thresholdPct,
    growth,
    turnsLeft: left,
    read,
    carry: dollars(lens.total, read),
    rewrite: dollars(lens.total, WRITE - read),
    isCold,
    candidates,
    offer,
  }
}

/** The one-time rebuild and pay-back for removing `c`. Tools sit at the front of the prompt, so
 *  removing anything rebuilds the cached prefix once. */
export function whatIf(v: View, c: Candidate): WhatIf | null {
  const l = v.lens
  if (!l) return null
  const price = priceOf(l.model)
  const rebuildTokens = (l.total - c.tokens) * (WRITE - v.read)
  const saveTokens = c.tokens * v.read
  const per = price && v.mode === 'api' ? (c.tokens / 1e6) * price.base * v.read : null
  const rebuild = price && v.mode === 'api' ? (rebuildTokens / 1e6) * price.base : null
  const turns = v.isCold ? 0 : Math.max(10, Math.round(rebuildTokens / Math.max(1, saveTokens) / 10) * 10)
  return { item: c, frees: c.tokens, pctWindow: (c.tokens / l.window) * 100, savesPerTurn: per, rebuild, turns, isCold: v.isCold }
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

/** State from an earlier version survives a hot reload; accept only the current shape. */
export function sanitizeLens(x: unknown): Lens | null {
  const l = x as Partial<Lens> | null
  if (!l || typeof l !== 'object') return null
  const ok =
    Array.isArray(l.cats) &&
    Array.isArray(l.servers) &&
    Array.isArray(l.memory) &&
    Array.isArray(l.skills) &&
    Array.isArray(l.agents) &&
    Array.isArray(l.sources) &&
    isNum(l.total) &&
    isNum(l.window) &&
    isNum(l.max) &&
    typeof l.model === 'string'
  return ok ? (l as Lens) : null
}

export function sanitizeHistory(x: unknown): Point[] {
  if (!Array.isArray(x)) return []
  const ok = x.filter((p): p is Point => !!p && typeof p === 'object' && isNum((p as Point).total) && isNum((p as Point).overhead))
  // Points from an earlier version carry no turn number; number them by position.
  return ok.map((p, i) => ({ ...p, isCompaction: !!p.isCompaction, n: isNum(p.n) ? p.n : i + 1 }))
}
