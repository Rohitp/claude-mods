import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Beat, Bust } from '../types'

const PANE = 'cache-guard'
const touchAtom = atom({ plugin: 'cache-guard', key: 'touch' } as const, null)
const nowAtom = atom({ plugin: 'cache-guard', key: 'now' } as const, 0)
const ttlAtom = atom({ plugin: 'cache-guard', key: 'ttlMs' } as const, 5 * 60_000)
const keepAtom = atom({ plugin: 'cache-guard', key: 'isKeepWarm' } as const, false)
const pingsAtom = atom({ plugin: 'cache-guard', key: 'pings' } as const, 0)
const totalPingsAtom = atom({ plugin: 'cache-guard', key: 'totalPings' } as const, 0)
const pingTokensAtom = atom({ plugin: 'cache-guard', key: 'pingTokens' } as const, 0)
const bustsAtom = atom({ plugin: 'cache-guard', key: 'busts' } as const, [])
const beatsAtom = atom({ plugin: 'cache-guard', key: 'beats' } as const, [])
const modeAtom = atom({ plugin: 'cache-guard', key: 'mode' } as const, 'api')
const limitAtom = atom({ plugin: 'cache-guard', key: 'limitPct' } as const, null)
const compactedAtom = atom({ plugin: 'cache-guard', key: 'compactedAt' } as const, 0)

const WARN_MS = 60_000 // toast and show the band this long before expiry
const MARGIN_MS = 45_000 // ping this long before expiry
const WRITE = 1.25 // cache write multiplier, 5-minute TTL

// $/MTok base input and cache-read multiplier, from the Claude API price table. Unknown models
// fall back to the 0.1x read multiplier and no dollar figures.
type Price = { base: number; read: number }
function priceOf(model: string): Price | null {
  if (/fable-5|mythos/.test(model)) return { base: 10, read: 0.025 }
  if (/opus-5-5/.test(model)) return { base: 4, read: 0.05 }
  if (/opus/.test(model)) return { base: 5, read: 0.1 }
  if (/sonnet-5/.test(model)) return { base: 2, read: 0.1 }
  if (/sonnet/.test(model)) return { base: 3, read: 0.1 }
  if (/haiku-5/.test(model)) return { base: 0.1, read: 0.1 }
  if (/haiku/.test(model)) return { base: 1, read: 0.1 }
  return null
}
const readMult = (model: string): number => priceOf(model)?.read ?? 0.1
// Pings that cost no more than the one rewrite they avoid: (write - read) / read.
const breakEven = (model: string): number => Math.max(1, Math.floor((WRITE - readMult(model)) / readMult(model)))
const usd = (tokens: number, mult: number, model: string): string | null => {
  const p = priceOf(model)
  if (!p) return null
  const v = (tokens / 1e6) * p.base * mult
  return `$${v < 0.1 ? v.toFixed(3) : v.toFixed(2)}`
}

const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
const mmss = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const clock = (ms: number): string => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

let isBusy = false
let isPinging = false
let warnedAt = -1
let timer: { cancel: () => void } | null = null

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
        await update($, keepAtom, () => false)
        $.ui.toast(`Keep-warm stopped after ${n} pings: another costs more than the rewrite it avoids.`)
      }
    } else {
      await update($, keepAtom, () => false)
      $.ui.toast('Keep-warm off: the cache had already lapsed (or the model changed), so a ping would rewrite it.')
    }
  } finally {
    isPinging = false
  }
}

async function tick($: EngineInterface) {
  const touch = await read($, touchAtom)
  if (!touch) return
  const now = await $.clock.now()
  await update($, nowAtom, () => now)
  const left = (await read($, ttlAtom)) - (now - touch.at)
  $.ui.status(left > 0 ? `cache ${mmss(left)}` : 'cache STALE')

  const isKeep = await read($, keepAtom)
  if (left > 0 && left <= WARN_MS && !isKeep && warnedAt !== touch.at) {
    warnedAt = touch.at
    const cost = usd(touch.tokens, WRITE, touch.model)
    $.ui.toast(`Prompt cache expires in ${mmss(left)}: the next turn rewrites ~${fmt(touch.tokens)} tokens${cost ? ` (~${cost})` : ''}.`)
  }
  if (isKeep && !isBusy && !isPinging && left > 0 && left <= MARGIN_MS) await ping($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cache',
      description: 'Prompt cache pane; `warm` toggles keep-warm, `5m`/`1h` sets the TTL',
    })
    timer?.cancel()
    timer = $.clock.every(1000, () => void tick($))
    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    isBusy = true
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
    await update($, modeAtom, () => (e.rateLimits.length > 0 ? 'sub' : 'api'))
    await update($, limitAtom, () => (w ? w.percentUsed : null))
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
    if (cached > 0) {
      const effort = String(e.effort ?? 'default')
      if (prev && u.cache_creation_input_tokens >= prev.tokens * 0.5 && u.cache_read_input_tokens < prev.tokens * 0.5) {
        const ttl = await read($, ttlAtom)
        const compactedAt = await read($, compactedAtom)
        const cause =
          startedAt - prev.at > ttl
            ? `idle ${mmss(startedAt - prev.at)} > TTL`
            : e.model !== prev.model
              ? `model ${prev.model} -> ${e.model}`
              : effort !== prev.effort
                ? `effort ${prev.effort} -> ${effort}`
                : compactedAt > prev.at
                  ? 'compaction'
                  : 'cause unknown'
        const bust: Bust = { at: startedAt, tokens: u.cache_creation_input_tokens, cause }
        await update($, bustsAtom, v => [...v, bust].slice(-20))
      }
      await update($, touchAtom, () => ({ at: startedAt, tokens: cached, model: e.model, effort }))
      await update($, pingsAtom, () => 0)
    }
    return r
  })

  on('command.run', { command: 'cache' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'warm') {
      const isOn = !(await read($, keepAtom))
      await update($, keepAtom, () => isOn)
      await update($, pingsAtom, () => 0)
      return { text: isOn ? `Keep-warm on: a cache-read ping ${MARGIN_MS / 1000}s before expiry, until it stops paying for itself.` : 'Keep-warm off.' }
    }
    if (arg === '5m' || arg === '1h') {
      await update($, ttlAtom, () => (arg === '1h' ? 3_600_000 : 300_000))
      return { text: `Cache TTL assumed ${arg}.` }
    }
    await $.ui.open({ id: PANE, title: 'Cache' })
    return { text: 'Cache pane opened. `/cache warm` toggles keep-warm.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const touch = await read($, touchAtom)
    if (!touch) return <Text dimColor>No cached response seen yet: send a prompt.</Text>

    const now = (await read($, nowAtom)) || touch.at
    const ttl = await read($, ttlAtom)
    const left = ttl - (now - touch.at)
    const isStale = left <= 0
    const isKeep = await read($, keepAtom)
    const mode = await read($, modeAtom)
    const limit = await read($, limitAtom)
    const pings = await read($, pingsAtom)
    const totalPings = await read($, totalPingsAtom)
    const pingTokens = await read($, pingTokensAtom)
    const beats = await read($, beatsAtom)
    const busts = await read($, bustsAtom)
    const width = Math.max(20, Math.min(60, (e.props.bodyColumns ?? 50) - 4))
    const filled = isStale ? 0 : Math.round((left / ttl) * width)
    const be = breakEven(touch.model)
    const missCost = usd(touch.tokens, WRITE - readMult(touch.model), touch.model)
    const pingCost = usd(touch.tokens, readMult(touch.model), touch.model)
    const spent = usd(pingTokens, readMult(touch.model), touch.model)
    const color = isStale ? 'error' : left <= WARN_MS ? 'warning' : 'success'

    return (
      <Box flexDirection="column">
        <Text>
          <Text color={color}>{isStale ? '● stale' : '● warm'}</Text>{' '}
          <Text bold>{isStale ? `${mmss(-left)} ago` : `${mmss(left)} left`}</Text>
          <Text dimColor>  TTL {ttl === 300_000 ? '5m' : '1h'} assumed · {mode === 'sub' ? 'subscription' : 'API billing'} · {touch.model}</Text>
        </Text>
        <Box>
          <Text color={color}>{'█'.repeat(filled)}</Text>
          <Text dimColor>{'░'.repeat(width - filled)}</Text>
        </Box>
        <Text> </Text>
        <Text>
          Prefix <Text bold>{fmt(touch.tokens)}</Text> tokens
        </Text>
        {mode === 'api' && missCost !== null ? (
          <Text>
            A miss costs <Text bold color="warning">+{missCost}</Text> · a ping costs <Text bold>{pingCost}</Text>
          </Text>
        ) : (
          <Text>
            A miss re-sends {fmt(touch.tokens)} tokens at {WRITE}x · a ping reads them at {readMult(touch.model)}x
            {limit !== null ? ` · 5h window ${limit}%` : ''}
          </Text>
        )}
        <Text dimColor>Break-even: {be} pings ≈ {Math.round((be * 5) / 6) / 10}h of idle (then a miss is cheaper).</Text>
        <Text> </Text>
        <Box>
          <Text>Keep-warm {isKeep ? 'ON ' : 'off'} </Text>
          <Button key="warm" label={isKeep ? 'Turn off' : 'Turn on'} onPress={() => update($, keepAtom, v => !v)} />
          <Text dimColor>
            {'  '}
            {pings}/{be} in a row · {totalPings} this session{spent ? ` ≈ ${spent}` : `, ${fmt(pingTokens)} tokens read`}
          </Text>
        </Box>
        {isStale && (
          <Box>
            <Text color="error">Cache is cold: the next turn rewrites everything anyway. </Text>
            <Button key="compact" label="Compact now" onPress={() => $.session.compact()} />
          </Box>
        )}
        <Text> </Text>
        <Text bold>Recent steps</Text>
        <Text>
          {beats.length === 0
            ? '—'
            : beats.map(b => (b === 'hit' ? '▇' : b === 'part' ? '▄' : '✕')).join('')}
        </Text>
        <Text dimColor>▇ read from cache · ▄ partly · ✕ rewritten</Text>
        <Text> </Text>
        <Text bold>Cache busts</Text>
        {busts.length === 0 && <Text dimColor>None seen.</Text>}
        {busts
          .slice(-6)
          .reverse()
          .map((b, i) => (
            <Text key={`b${i}`}>
              {clock(b.at)} rewrote {fmt(b.tokens)} <Text dimColor>{b.cause}</Text>
            </Text>
          ))}
      </Box>
    )
  })

  // The band appears only when it matters: close to expiry or already stale.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const touch = await read($, touchAtom)
    const now = await read($, nowAtom)
    if (!touch || !now || e.props.hasSurvey) return next(e)

    const left = (await read($, ttlAtom)) - (now - touch.at)
    const isKeep = await read($, keepAtom)
    if (left > WARN_MS && !isKeep) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const isStale = left <= 0
    const mode = await read($, modeAtom)
    const cost = mode === 'api' ? usd(touch.tokens, WRITE - readMult(touch.model), touch.model) : null
    const extra = cost ? ` (+${cost})` : ''
    return (
      <Box>
        <Text color={isStale ? 'error' : 'warning'}>
          {isStale
            ? `cache stale ${mmss(-left)} ago: next prompt re-sends ~${fmt(touch.tokens)} tokens${extra} `
            : `cache ${mmss(left)} left · ~${fmt(touch.tokens)} tokens${extra} `}
        </Text>
        <Text dimColor>{isKeep ? 'keep-warm on ' : ''}</Text>
        <Button
          key="warm"
          label={isKeep ? 'Stop keep-warm' : 'Keep warm'}
          onPress={() => update($, keepAtom, v => !v)}
        />
      </Box>
    )
  })
}
