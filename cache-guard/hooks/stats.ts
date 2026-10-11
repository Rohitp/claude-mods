// Local, opt-out metrics kept in the mod's own store. Counters and a short ring of recent events;
// never sent anywhere. They let the mod check its own assumptions (TTL, ping cost).
export type EventData = Record<string, number | string | boolean>
export type Ev = { t: number; k: string; d?: EventData }
export type Gap = { ms: number; hit: boolean }
export type Stats = { since: number; c: Record<string, number>; gaps: Gap[]; recent: Ev[] }

export const emptyStats = (now: number): Stats => ({ since: now, c: {}, gaps: [], recent: [] })

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

export function sanitizeStats(x: unknown, now: number): Stats {
  const s = x as Partial<Stats> | null
  if (!s || typeof s !== 'object' || !s.c || typeof s.c !== 'object') return emptyStats(now)
  const c: Record<string, number> = {}
  for (const [k, v] of Object.entries(s.c)) if (isNum(v)) c[k] = v
  return {
    since: isNum(s.since) ? s.since : now,
    c,
    gaps: (Array.isArray(s.gaps) ? s.gaps : []).filter(g => g && isNum(g.ms) && typeof g.hit === 'boolean').slice(-200),
    recent: (Array.isArray(s.recent) ? s.recent : []).filter(e => e && isNum(e.t) && typeof e.k === 'string').slice(-100),
  }
}

export function bump(s: Stats, key: string, n = 1): Stats {
  return { ...s, c: { ...s.c, [key]: (s.c[key] ?? 0) + n } }
}
export function note(s: Stats, ev: Ev, max = 100): Stats {
  return { ...s, recent: [...s.recent, ev].slice(-max) }
}
export function addGap(s: Stats, gap: Gap, max = 200): Stats {
  return { ...s, gaps: [...s.gaps, gap].slice(-max) }
}

const mins = (ms: number): string => `${(ms / 60000).toFixed(1)}m`

/** What the person reads for `/cache stats`: plain facts, then what they suggest. */
export function summarize(s: Stats, ttlMs: number, now: number): string[] {
  const c = (k: string) => s.c[k] ?? 0
  const steps = c('steps')
  const out: string[] = []
  out.push(`Since ${new Date(s.since).toLocaleString()} (${mins(now - s.since)} ago)`)
  out.push(`Steps ${steps}: ${c('hit')} hit · ${c('part')} partial · ${c('miss')} miss`)
  const busts = ['idle', 'model', 'effort', 'compaction', 'unknown'].map(k => `${k} ${c(`bust.${k}`)}`).join(' · ')
  out.push(`Busts: ${busts}`)
  const pings = c('ping.ok') + c('ping.lapsed') + c('ping.error')
  out.push(`Pings ${pings}: ${c('ping.ok')} ok · ${c('ping.lapsed')} lapsed · ${c('ping.error')} failed`)
  if (pings > 0) {
    out.push(
      `Ping tokens: ${c('ping.read')} read · ${c('ping.in')} uncached in · ${c('ping.out')} out (avg ${Math.round(c('ping.out') / Math.max(1, c('ping.ok')))} out per ping)`,
    )
  }
  out.push(`Misses avoided ${c('avoided')} · keep warm on ${c('keep.on')}× · stopped: break-even ${c('keep.stop.breakeven')}, idle ${c('keep.stop.idle')}, lapsed ${c('keep.stop.lapsed')}`)
  out.push(`Warnings shown ${c('toast')} · bands ${c('band.shown')} · dismissed ${c('band.dismiss')} · compact clicks ${c('compact.click')}`)
  if (c('state.repaired') || c('render.error')) {
    out.push(`Problems: ${c('state.repaired')} repaired state, ${c('render.error')} render errors`)
  }

  // Does the assumed TTL match what the account actually does?
  const hits = s.gaps.filter(g => g.hit)
  const misses = s.gaps.filter(g => !g.hit)
  if (hits.length + misses.length >= 3) {
    const longestHit = Math.max(0, ...hits.map(g => g.ms))
    const shortestMiss = misses.length ? Math.min(...misses.map(g => g.ms)) : Infinity
    out.push(
      `Idle gaps: longest hit ${mins(longestHit)}${Number.isFinite(shortestMiss) ? `, shortest miss ${mins(shortestMiss)}` : ', no idle misses yet'} (assumed TTL ${mins(ttlMs)})`,
    )
    if (longestHit > ttlMs * 1.05) {
      out.push(`A hit after ${mins(longestHit)} idle outlived the assumed TTL: your cache may last longer. Try /cache 1h.`)
    } else if (Number.isFinite(shortestMiss) && shortestMiss < ttlMs * 0.9) {
      out.push(`A miss after ${mins(shortestMiss)} idle is shorter than the assumed TTL: the real TTL may be shorter.`)
    }
  } else {
    out.push('Idle gaps: not enough yet to check the TTL assumption.')
  }
  return out
}
