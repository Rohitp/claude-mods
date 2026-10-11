import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Beat, Bust } from '../types'
import { fit, mmss, dur } from './layout'
import { MAX_KEEP_MS, PING_LEAD_MS, WARN_MS, breakEven, derive, readMult, statusText, toastText } from './model'
import type { Guard, View } from './model'
import { cacheBandDesktop, cachePaneDesktop } from './desktop'
import type { DesktopEl } from './desktop'
import { cacheBand, cachePane, row } from './terminal'
import type { Acts } from './terminal'

const PANE = 'cache-guard'
const touchAtom = atom({ plugin: 'cache-guard', key: 'touch' } as const, null)
const nowAtom = atom({ plugin: 'cache-guard', key: 'now' } as const, 0)
const ttlAtom = atom({ plugin: 'cache-guard', key: 'ttlMs' } as const, 5 * 60_000)
const keepAtom = atom({ plugin: 'cache-guard', key: 'isKeepWarm' } as const, false)
const pingsAtom = atom({ plugin: 'cache-guard', key: 'pings' } as const, 0)
const totalPingsAtom = atom({ plugin: 'cache-guard', key: 'totalPings' } as const, 0)
const pingTokensAtom = atom({ plugin: 'cache-guard', key: 'pingTokens' } as const, 0)
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

let isBusy = false
let isPinging = false
let isBandShown = false
let lastEditAt = 0
let warnedAt = -1
let timer: { cancel: () => void } | null = null

async function load($: EngineInterface): Promise<Guard> {
  return {
    billing: await read($, billingAtom),
    ttlMs: await read($, ttlAtom),
    touch: await read($, touchAtom),
    now: await read($, nowAtom),
    isKeepWarm: await read($, keepAtom),
    pings: await read($, pingsAtom),
    totalPings: await read($, totalPingsAtom),
    pingTokens: await read($, pingTokensAtom),
    avoided: await read($, avoidedAtom),
    busts: await read($, bustsAtom),
    beats: await read($, beatsAtom),
    limitPct: await read($, limitAtom),
    isAvailable: await read($, availableAtom),
    dismissedAt: await read($, dismissedAtom),
    lastTurnAt: await read($, lastTurnAtom),
  }
}

async function stopKeepWarm($: EngineInterface, why: string) {
  await update($, keepAtom, () => false)
  $.ui.toast(`Keep warm turned off: ${why}.`)
}

async function ping($: EngineInterface) {
  isPinging = true
  try {
    const touch = await read($, touchAtom)
    const startedAt = await $.clock.now()
    const r = await $.model.fork({ prompt: 'Cache keep-alive. Reply with exactly: .' })
    const hit = 'usage' in r ? r.usage.cache_read_input_tokens : 0
    if (touch && hit >= touch.tokens * 0.5) {
      await update($, touchAtom, () => ({ ...touch, at: startedAt, tokens: hit }))
      const n = (await read($, pingsAtom)) + 1
      await update($, pingsAtom, () => n)
      await update($, totalPingsAtom, v => v + 1)
      await update($, pingTokensAtom, v => v + hit)
      if (n >= breakEven(touch.model)) {
        await stopKeepWarm($, `another ping would cost more than the miss it avoids (${n} in a row)`)
      }
    } else {
      await stopKeepWarm($, 'the cache had already lapsed or the model changed, so a ping would rewrite it')
    }
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
    $.ui.toast(toastText(v))
  }
  if (!g.isKeepWarm || isBusy || isPinging || v.leftMs <= 0) return
  if (now - g.lastTurnAt >= MAX_KEEP_MS) {
    await stopKeepWarm($, 'two hours without a turn')
    return
  }
  if (v.leftMs <= PING_LEAD_MS) await ping($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cache',
      description: 'Cache Guard pane; `warm` toggles keep-warm, `5m`/`1h` sets the TTL',
    })
    timer?.cancel()
    timer = $.clock.every(1000, () => void tick($))
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
    await update($, billingAtom, () => (e.rateLimits.length > 0 ? 'sub' : 'api'))
    await update($, limitAtom, () => (w ? Math.round(w.percentUsed) : null))
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    const at = await $.clock.now()
    await update($, compactedAtom, () => at)
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
    if (total > 0) {
      const share = u.cache_read_input_tokens / total
      const beat: Beat = share > 0.8 ? 'hit' : share > 0.2 ? 'part' : 'miss'
      await update($, beatsAtom, v => [...v, beat].slice(-60))
    }
    if (cached === 0) {
      const z = (await read($, zeroAtom)) + 1
      await update($, zeroAtom, () => z)
      if (z >= 3 && !prev) await update($, availableAtom, () => false)
      return r
    }
    await update($, zeroAtom, () => 0)
    await update($, availableAtom, () => true)

    const effort = String(e.effort ?? 'default')
    if (prev && u.cache_creation_input_tokens >= prev.tokens * 0.5 && u.cache_read_input_tokens < prev.tokens * 0.5) {
      const ttl = await read($, ttlAtom)
      const compactedAt = await read($, compactedAtom)
      const short = (m: string) => m.replace(/^claude-/, '')
      const [cause, detail] =
        startedAt - prev.at > ttl
          ? ['idle past TTL', `${dur(startedAt - prev.at)} idle`]
          : e.model !== prev.model
            ? ['model changed', `${short(prev.model)} → ${short(e.model)}`]
            : effort !== prev.effort
              ? ['effort changed', `${prev.effort} → ${effort}`]
              : compactedAt > prev.at
                ? ['compaction', 'after compaction']
                : ['cause unknown', '']
      const bust: Bust = { at: startedAt, tokens: u.cache_creation_input_tokens, cause: cause!, detail: detail! }
      await update($, bustsAtom, v => [...v, bust].slice(-20))
    } else if (prev && pingsBefore > 0 && u.cache_read_input_tokens >= prev.tokens * 0.5) {
      await update($, avoidedAtom, v => v + 1)
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
      return { text: isOn ? 'Keep warm on: it pings 30s before expiry, until you turn it off.' : 'Keep warm off.' }
    }
    if (arg === '5m' || arg === '1h') {
      await update($, ttlAtom, () => (arg === '1h' ? 3_600_000 : 300_000))
      return { text: `Cache TTL assumed ${arg}.` }
    }
    await $.ui.open({ id: PANE, title: 'Cache Guard' })
    return { text: 'Cache Guard opened. `/cache warm` toggles keep warm.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    const g = await load($)
    const v = derive(g)
    const touchAt = g.touch?.at ?? 0
    const acts: Acts = {
      warm: () => update($, keepAtom, isOn => !isOn),
      compact: () => void $.session.compact(),
      ttl5: () => update($, ttlAtom, () => 300_000),
      ttl1h: () => update($, ttlAtom, () => 3_600_000),
      dismiss: () => update($, dismissedAtom, () => touchAt),
    }
    if (e.surface !== 'terminal') return cachePaneDesktop($.ui.resolve(e) as DesktopEl, v, acts)
    const lines = cachePane(v, Math.max(20, e.props.bodyColumns))
    return <el.Box flexDirection="column">{lines.map((l, i) => row(el, l, acts, `r${i}`))}</el.Box>
  })

  // The band appears only within 60s of expiry or when stale.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const g = await load($)
    if (!g.touch || !g.now || e.props.hasSurvey) return next(e)
    const v = derive(g)
    const segs = cacheBand(v, Math.max(20, e.props.bodyColumns))
    // A band that would appear mid-keystroke waits for a two-second typing pause.
    if (segs && !isBandShown && g.now - lastEditAt < 2000) return next(e)
    isBandShown = !!segs
    if (!segs) return next(e)

    const touchAt = g.touch.at
    const acts: Acts = {
      warm: () => update($, keepAtom, isOn => !isOn),
      compact: () => void $.session.compact(),
      dismiss: () => update($, dismissedAtom, () => touchAt),
    }
    if (e.surface !== 'terminal') return cacheBandDesktop($.ui.resolve(e) as DesktopEl, v, acts) ?? next(e)
    return row($.ui.resolve(e), fit(segs, Math.max(20, e.props.bodyColumns)), acts, 'band')
  })
}
