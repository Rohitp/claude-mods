// Local, opt-out metrics kept in the mod's own store. Counters and a short ring of recent events;
// never sent anywhere. They let the mod report how good its own estimates are.
export type EventData = Record<string, number | string | boolean>
export type Ev = { t: number; k: string; d?: EventData }
export type Stats = { since: number; c: Record<string, number>; recent: Ev[] }

export const emptyStats = (now: number): Stats => ({ since: now, c: {}, recent: [] })
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

export function sanitizeStats(x: unknown, now: number): Stats {
  const s = x as Partial<Stats> | null
  if (!s || typeof s !== 'object' || !s.c || typeof s.c !== 'object') return emptyStats(now)
  const c: Record<string, number> = {}
  for (const [k, v] of Object.entries(s.c)) if (isNum(v)) c[k] = v
  return {
    since: isNum(s.since) ? s.since : now,
    c,
    recent: (Array.isArray(s.recent) ? s.recent : []).filter(e => e && isNum(e.t) && typeof e.k === 'string').slice(-100),
  }
}

export const bump = (s: Stats, key: string, n = 1): Stats => ({ ...s, c: { ...s.c, [key]: (s.c[key] ?? 0) + n } })
export const note = (s: Stats, ev: Ev, max = 100): Stats => ({ ...s, recent: [...s.recent, ev].slice(-max) })

/** What the person reads for `/ctx stats`. */
export function summarize(s: Stats, now: number): string[] {
  const c = (k: string) => s.c[k] ?? 0
  const out: string[] = []
  out.push(`Since ${new Date(s.since).toLocaleString()} (${((now - s.since) / 60000).toFixed(1)}m ago)`)
  const n = c('measure.ok')
  out.push(`Measurements ${n} ok · ${c('measure.empty')} empty · ${c('measure.error')} failed${n ? ` (avg ${Math.round(c('measure.ms') / n)} ms)` : ''}`)
  if (c('est.n') > 0) {
    const avg = c('est.scale') / 1000 / c('est.n')
    out.push(
      `Message-source estimate vs the engine's Messages figure: ×${avg.toFixed(2)} on average over ${c('est.n')} measurements (1.00 = exact; scaled to match either way)`,
    )
  }
  out.push(`Compactions seen ${c('compaction')} · compact clicks ${c('compact.click')}`)
  out.push(`Views: ${['category', 'items', 'whatif', 'trend'].map(t => `${t} ${c(`tab.${t}`)}`).join(' · ')} · what-if picks ${c('whatif.pick')}`)
  if (c('state.repaired') || c('render.error')) out.push(`Problems: ${c('state.repaired')} repaired state, ${c('render.error')} render errors`)
  return out
}
