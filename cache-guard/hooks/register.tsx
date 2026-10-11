import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Beat, Bust } from '../types'
import { cacheBandDesktop, cachePaneDesktop } from './desktop'
import type { DesktopEl } from './desktop'
import { dur, fit } from './layout'
import { formatLine } from './log'
import type { Field, Level } from './log'
import { MAX_KEEP_MS, PING_LEAD_MS, breakEven, derive, sanitizeGuard, statusText, toastText } from './model'
import type { Guard, View } from './model'
import { addGap, bump, emptyStats, note, sanitizeStats, summarize } from './stats'
import type { Stats } from './stats'
import { cacheBand, cachePane, row } from './terminal'
import type { Acts } from './terminal'

const PLUGIN = 'cache-guard'
const PANE = 'cache-guard'
const touchAtom = atom({ plugin: 'cache-guard', key: 'touch' } as const, null)
const nowAtom = atom({ plugin: 'cache-guard', key: 'now' } as const, 0)
const ttlAtom = atom({ plugin: 'cache-guard', key: 'ttlMs' } as const, 5 * 60_000)
const keepAtom = atom({ plugin: 'cache-guard', key: 'isKeepWarm' } as const, false)
const pingsAtom = atom({ plugin: 'cache-guard', key: 'pings' } as const, 0)
const totalPingsAtom = atom({ plugin: 'cache-guard', key: 'totalPings' } as const, 0)
const pingTokensAtom = atom({ plugin: 'cache-guard', key: 'pingTokens' } as const, 0)
const pingExtraAtom = atom({ plugin: 'cache-guard', key: 'pingExtraTokens' } as const, 0)
const avoidedAtom = atom({ plugin: 'cache-guard', key: 'avoided' } as const, 0)
const bustsAtom = atom({ plugin: 'cache-guard', key: 'busts' } as const, [])
const beatsAtom = atom({ plugin: 'cache-guard', key: 'beats' } as const, [])
const billingAtom = atom({ plugin: 'cache-guard', key: 'billing' } as const, 'api')
const limitAtom = atom({ plugin: 'cache-guard', key: 'limitPct' } as const, null)
const compactedAtom = atom({ plugin: 'cache-guard', key: 'compactedAt' } as const, 0)
const availableAtom = atom({ plugin: 'cache-guard', key: 'isAvailable' } as const, true)
const dismissedAtom = atom({ plugin: 'cache-guard', key: 'dismissedAt' } as const, 0)
const lastTurnAtom = atom({ plugin: 'cache-guard', key: 'lastTurnAt' } as const, 0)
const zeroAtom = atom({ plugin: 'cache-guard', key: 'zeroSteps' } as const, 0)

const STORE_KEY = 'stats'
const FLUSH_MS = 15_000

let isBusy = false
let isPinging = false
let isBandShown = false
let lastEditAt = 0
let warnedAt = -1
let timer: { cancel: () => void } | null = null

// Local metrics, kept in memory and flushed to the mod's own store. Never sent anywhere.
let isTracking = true
let stats: Stats = emptyStats(0)
let isDirty = false
let lastFlushAt = 0
const reported = new Set<string>()

// ---- logging and metrics ---------------------------------------------------------------
/** One content-free line to the debug log. A first error of each kind also reaches the transcript. */
function log($: EngineInterface, level: Level, event: string, fields: Record<string, Field> = {}) {
  $.ui.log(formatLine(PLUGIN, level, event, fields), { to: 'debug' })
  if (level === 'error' && !reported.has(event)) {
    reported.add(event)
    $.ui.log(`${PLUGIN}: ${event} (details in claude --debug)`)
  }
}

function count(key: string, n = 1, ev?: { t: number; k?: string; d?: Record<string, number | string | boolean> }) {
  if (!isTracking) return
  stats = bump(stats, key, n)
  if (ev) stats = note(stats, { t: ev.t, k: ev.k ?? key, d: ev.d })
  isDirty = true
}

async function flush($: EngineInterface, force = false) {
  if (!isTracking || !isDirty) return
  const now = await $.clock.now()
  if (!force && now - lastFlushAt < FLUSH_MS) return
  lastFlushAt = now
  isDirty = false
  await $.store.set(STORE_KEY, stats)
}

// ---- state -----------------------------------------------------------------------------
async function load($: EngineInterface): Promise<Guard> {
  const g = {
    billing: await read($, billingAtom),
    ttlMs: await read($, ttlAtom),
    touch: await read($, touchAtom),
    now: await read($, nowAtom),
    isKeepWarm: await read($, keepAtom),
    pings: await read($, pingsAtom),
    totalPings: await read($, totalPingsAtom),
    pingTokens: await read($, pingTokensAtom),
    pingExtraTokens: await read($, pingExtraAtom),
    avoided: await read($, avoidedAtom),
    busts: await read($, bustsAtom),
    beats: await read($, beatsAtom),
    limitPct: await read($, limitAtom),
    isAvailable: await read($, availableAtom),
    dismissedAt: await read($, dismissedAtom),
    lastTurnAt: await read($, lastTurnAtom),
  }
  const clean = sanitizeGuard(g)
  // A reload from an earlier version leaves state of another shape; say so once.
  if (JSON.stringify(clean.busts) !== JSON.stringify(g.busts) || (g.touch && !clean.touch)) {
    if (!reported.has('state.repaired')) {
      reported.add('state.repaired')
      count('state.repaired')
      log($, 'warn', 'state.repaired', { busts: g.busts.length, touch: g.touch ? 'dropped' : 'none' })
    }
  }
  return clean
}

async function stopKeepWarm($: EngineInterface, reason: 'breakeven' | 'idle' | 'lapsed', why: string) {
  await update($, keepAtom, () => false)
  count(`keep.stop.${reason}`)
  log($, 'info', 'keep.stop', { reason })
  $.ui.toast(`Keep warm turned off: ${why}.`)
}

async function ping($: EngineInterface) {
  isPinging = true
  const t0 = await $.clock.now()
  try {
    const touch = await read($, touchAtom)
    const r = await $.model.fork({ prompt: 'Cache keep-alive. Reply with exactly: .' })
    const ms = (await $.clock.now()) - t0
    if (!('usage' in r)) {
      count('ping.error')
      log($, 'warn', 'ping.none', { reason: r.reason })
      return
    }
    const u = r.usage
    const hit = u.cache_read_input_tokens
    count('ping.in', u.input_tokens + u.cache_creation_input_tokens)
    count('ping.out', u.output_tokens)
    if (!r.isAnswered) {
      count('ping.error')
      log($, 'warn', 'ping.failed', { reason: r.reason, ms, read: hit })
      return
    }
    if (touch && hit >= touch.tokens * 0.5) {
      await update($, touchAtom, () => ({ ...touch, at: t0, tokens: hit }))
      const n = (await read($, pingsAtom)) + 1
      await update($, pingsAtom, () => n)
      await update($, totalPingsAtom, v => v + 1)
      await update($, pingTokensAtom, v => v + hit)
      await update($, pingExtraAtom, v => v + u.input_tokens + u.cache_creation_input_tokens + 5 * u.output_tokens)
      count('ping.ok')
      count('ping.read', hit)
      log($, 'info', 'ping.ok', { read: hit, out: u.output_tokens, in: u.input_tokens, ms, n })
      if (n >= breakEven(touch.model)) {
        await stopKeepWarm($, 'breakeven', `another ping would cost more than the miss it avoids (${n} in a row)`)
      }
    } else {
      count('ping.lapsed', 1, { t: t0, d: { read: hit, need: touch?.tokens ?? 0 } })
      log($, 'warn', 'ping.lapsed', { read: hit, need: touch?.tokens ?? 0, ms })
      await stopKeepWarm($, 'lapsed', 'the cache had already lapsed or the model changed, so a ping would rewrite it')
    }
  } catch (err) {
    count('ping.error')
    log($, 'error', 'ping.threw', { name: err instanceof Error ? err.name : 'unknown' })
  } finally {
    isPinging = false
  }
}

async function tick($: EngineInterface) {
  const g = await load($)
  if (!g.touch) return
  const now = await $.clock.now()
  await update($, nowAtom, () => now)
  const v: View = derive({ ...g, now })
  $.ui.status(statusText(v, g.isKeepWarm))

  if (v.state === 'warn' && !g.isKeepWarm && warnedAt !== g.touch.at) {
    warnedAt = g.touch.at
    count('toast')
    log($, 'debug', 'toast', { left: Math.round(v.leftMs / 1000), tokens: v.tokens })
    $.ui.toast(toastText(v))
  }
  await flush($)
  if (!g.isKeepWarm || isBusy || isPinging || v.leftMs <= 0) return
  if (now - g.lastTurnAt >= MAX_KEEP_MS) {
    await stopKeepWarm($, 'idle', 'two hours without a turn')
    return
  }
  if (v.leftMs <= PING_LEAD_MS) await ping($)
}

export const register: Register = (on, options) => {
  isTracking = (options as Record<string, unknown>)?.metrics !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cache',
      description: 'Cache Guard pane; `warm` toggles keep-warm, `5m`/`1h` sets the TTL, `stats` shows metrics',
    })
    const now = await $.clock.now()
    stats = isTracking ? sanitizeStats(await $.store.get(STORE_KEY), now) : emptyStats(now)
    timer?.cancel()
    timer = $.clock.every(1000, () => void tick($))
    log($, 'info', 'start', { metrics: isTracking })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await flush($, true)
    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    isBusy = true
    return next(e)
  })

  on('prompt.edit', async ($, e, next) => {
    lastEditAt = await $.clock.now()
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (!e.agentId) isBusy = false
    return next(e)
  })

  // Subscription or API billing, read from what the account reports: rate-limit windows exist
  // only on a subscription.
  on('session.measure', async ($, e, next) => {
    const w = e.rateLimits.find(l => l.kind === 'five_hour') ?? e.rateLimits[0]
    const billing = e.rateLimits.length > 0 ? 'sub' : 'api'
    if ((await read($, billingAtom)) !== billing) log($, 'info', 'billing', { mode: billing })
    await update($, billingAtom, () => billing)
    await update($, limitAtom, () => (w ? Math.round(w.percentUsed) : null))
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    const at = await $.clock.now()
    await update($, compactedAtom, () => at)
    log($, 'info', 'compaction', { trigger: e.trigger })
    return r
  })

  // A main-thread response that read or wrote the cache restarts its clock, and one that
  // rewrote most of the prefix is a bust whose cause we can often name.
  on('turn.step', async function* ($, e, next) {
    // The entry's lifetime runs from the START of the request that wrote or read it.
    const startedAt = await $.clock.now()
    const prev = await read($, touchAtom)
    const pingsBefore = await read($, pingsAtom)
    const r = yield* next(e)
    const u = r?.usage
    if (!u || e.agentId) return r

    const cached = u.cache_read_input_tokens + u.cache_creation_input_tokens
    const total = cached + u.input_tokens
    count('steps')
    if (total > 0) {
      const share = u.cache_read_input_tokens / total
      const beat: Beat = share > 0.8 ? 'hit' : share > 0.2 ? 'part' : 'miss'
      count(beat)
      await update($, beatsAtom, v => [...v, beat].slice(-60))
    }
    if (cached === 0) {
      const z = (await read($, zeroAtom)) + 1
      await update($, zeroAtom, () => z)
      if (z >= 3 && !prev) {
        await update($, availableAtom, () => false)
        count('available.flip')
        log($, 'warn', 'unavailable', { steps: z, model: e.model })
      }
      return r
    }
    await update($, zeroAtom, () => 0)
    await update($, availableAtom, () => true)

    const effort = String(e.effort ?? 'default')
    if (prev) {
      const gap = startedAt - prev.at
      const isHit = u.cache_read_input_tokens >= prev.tokens * 0.5
      const isMiss = u.cache_creation_input_tokens >= prev.tokens * 0.5 && u.cache_read_input_tokens < prev.tokens * 0.5
      if (isTracking && (isHit || isMiss) && gap > 0 && e.model === prev.model && effort === prev.effort) {
        stats = addGap(stats, { ms: gap, hit: isHit })
        isDirty = true
      }
      if (isMiss) {
        const ttl = await read($, ttlAtom)
        const compactedAt = await read($, compactedAtom)
        const short = (m: string) => m.replace(/^claude-/, '')
        const [kind, cause, detail] =
          gap > ttl
            ? ['idle', 'idle past TTL', `${dur(gap)} idle`]
            : e.model !== prev.model
              ? ['model', 'model changed', `${short(prev.model)} → ${short(e.model)}`]
              : effort !== prev.effort
                ? ['effort', 'effort changed', `${prev.effort} → ${effort}`]
                : compactedAt > prev.at
                  ? ['compaction', 'compaction', 'after compaction']
                  : ['unknown', 'cause unknown', '']
        const bust: Bust = { at: startedAt, tokens: u.cache_creation_input_tokens, cause: cause!, detail: detail! }
        await update($, bustsAtom, v => [...v, bust].slice(-20))
        count(`bust.${kind}`, 1, { t: startedAt, k: 'bust', d: { kind: kind!, tokens: u.cache_creation_input_tokens, gapMs: gap } })
        log($, 'info', 'bust', { kind, tokens: u.cache_creation_input_tokens, gapMs: gap, prev: prev.tokens })
      } else if (isHit && pingsBefore > 0) {
        await update($, avoidedAtom, v => v + 1)
        count('avoided')
        log($, 'info', 'avoided', { pings: pingsBefore, gapMs: gap })
      }
    }
    await update($, touchAtom, () => ({ at: startedAt, tokens: cached, model: e.model, effort }))
    await update($, lastTurnAtom, () => startedAt)
    await update($, pingsAtom, () => 0)
    return r
  })

  on('command.run', { command: 'cache' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'warm') {
      const isOn = !(await read($, keepAtom))
      await update($, keepAtom, () => isOn)
      await update($, pingsAtom, () => 0)
      if (isOn) count('keep.on')
      log($, 'info', 'keep.toggle', { on: isOn, via: 'command' })
      return { text: isOn ? 'Keep warm on: it pings 30s before expiry, until you turn it off.' : 'Keep warm off.' }
    }
    if (arg === '5m' || arg === '1h') {
      await update($, ttlAtom, () => (arg === '1h' ? 3_600_000 : 300_000))
      count('ttl.set')
      log($, 'info', 'ttl.set', { ttl: arg })
      return { text: `Cache TTL assumed ${arg}.` }
    }
    if (arg === 'stats') {
      const now = await $.clock.now()
      const ttl = await read($, ttlAtom)
      if (!isTracking) return { text: 'Metrics are off (the `metrics` option is false).' }
      return { text: ['Cache Guard metrics (local only, never sent):', ...summarize(stats, ttl, now)].join('\n') }
    }
    if (arg === 'stats reset') {
      stats = emptyStats(await $.clock.now())
      isDirty = true
      await flush($, true)
      return { text: 'Cache Guard metrics reset.' }
    }
    await $.ui.open({ id: PANE, title: 'Cache Guard' })
    return { text: 'Cache Guard opened. `/cache warm` toggles keep warm, `/cache stats` shows metrics.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    try {
      const g = await load($)
      const v = derive(g)
      const touchAt = g.touch?.at ?? 0
      const acts: Acts = {
        warm: async () => {
          const isOn = !(await read($, keepAtom))
          await update($, keepAtom, () => isOn)
          await update($, pingsAtom, () => 0)
          if (isOn) count('keep.on')
          log($, 'info', 'keep.toggle', { on: isOn, via: 'pane' })
        },
        compact: () => {
          count('compact.click')
          log($, 'info', 'compact.click', { via: 'pane', state: v.state })
          void $.session.compact()
        },
        ttl5: () => update($, ttlAtom, () => 300_000),
        ttl1h: () => update($, ttlAtom, () => 3_600_000),
        dismiss: () => update($, dismissedAtom, () => touchAt),
      }
      if (e.surface !== 'terminal') return cachePaneDesktop($.ui.resolve(e) as DesktopEl, v, acts)
      const lines = cachePane(v, Math.max(20, e.props.bodyColumns))
      return <el.Box flexDirection="column">{lines.map((l, i) => row(el, l, acts, `r${i}`))}</el.Box>
    } catch (err) {
      count('render.error')
      log($, 'error', 'render.pane', { name: err instanceof Error ? err.name : 'unknown', msg: err instanceof Error ? err.message : '' })
      return <el.Text dimColor>Cache Guard could not draw. See claude --debug.</el.Text>
    }
  })

  // The band appears only within 60s of expiry or when stale.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    try {
      const g = await load($)
      if (!g.touch || !g.now || e.props.hasSurvey) return next(e)
      const v = derive(g)
      const segs = cacheBand(v, Math.max(20, e.props.bodyColumns))
      // A band that would appear mid-keystroke waits for a two-second typing pause.
      if (segs && !isBandShown && g.now - lastEditAt < 2000) return next(e)
      if (segs && !isBandShown) count('band.shown')
      isBandShown = !!segs
      if (!segs) return next(e)

      const touchAt = g.touch.at
      const acts: Acts = {
        warm: async () => {
          const isOn = !(await read($, keepAtom))
          await update($, keepAtom, () => isOn)
          await update($, pingsAtom, () => 0)
          if (isOn) count('keep.on')
          log($, 'info', 'keep.toggle', { on: isOn, via: 'band' })
        },
        compact: () => {
          count('compact.click')
          log($, 'info', 'compact.click', { via: 'band', state: v.state })
          void $.session.compact()
        },
        dismiss: () => {
          count('band.dismiss')
          return update($, dismissedAtom, () => touchAt)
        },
      }
      if (e.surface !== 'terminal') return cacheBandDesktop($.ui.resolve(e) as DesktopEl, v, acts) ?? next(e)
      return row($.ui.resolve(e), fit(segs, Math.max(20, e.props.bodyColumns)), acts, 'band')
    } catch (err) {
      count('render.error')
      log($, 'error', 'render.band', { name: err instanceof Error ? err.name : 'unknown', msg: err instanceof Error ? err.message : '' })
      return next(e)
    }
  })
}
