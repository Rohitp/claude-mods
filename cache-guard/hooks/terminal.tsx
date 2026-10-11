// Terminal surface: the cache band and the Cache Guard pane, laid out on the character grid.
import type { Elements } from 'claude-code'

import { S, fit, fk, lr, padL, prio, wrap, dur } from './layout'
import type { Seg } from './layout'
import { WRITE, shortModel, usd } from './model'
import type { View } from './model'

export type Acts = Record<string, () => void>
type El = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

const bracket = (label: string, act: string, hk?: string): Seg => S(`[ ${label} ]`, 'accent b', { act, hk })

const modeLabel = (v: View): string =>
  v.mode === 'api' ? 'API · est.' : v.mode === 'sub' ? 'subscription' : 'prices unknown'

// ---- the one-row band ------------------------------------------------------------------
export function cacheBand(v: View, w: number): Seg[] | null {
  if (v.state === 'normal' || v.state === 'empty' || v.state === 'na' || v.isDismissed) return null

  if (v.isKeepWarm && v.state === 'warn') {
    const items = [
      { p: 0, segs: [S('↻ ', 'accent'), S('Keep warm is on', 'fg'), S(' · pings at 0:30', 'dim')] },
      {
        p: 2,
        segs:
          v.mode === 'api' && v.spent !== null
            ? [S(`${v.totalPings} pings `, 'dim'), S(`${usd(v.spent)} est.`, 'fg')]
            : [S(`${v.totalPings} pings `, 'dim'), S(`${fk(v.pingTokens)} read`, 'fg')],
      },
    ]
    const right = [bracket('Turn off', 'warm')]
    return lr(prio(items, w - right[0]!.t.length - 2), right, w)
  }

  let items: { p: number; segs: Seg[] }[]
  let right: Seg[]
  if (v.state === 'warn') {
    items = [{ p: 0, segs: [S('◔ ', 'warn'), S('Cache expires in ', 'fg'), S(v.clock, 'warn b')] }]
    if (v.mode === 'api') {
      items.push(
        { p: 0, segs: [S('then a miss costs ', 'dim'), S(`+${usd(v.miss ?? 0)} est.`, 'fg')] },
        { p: 3, segs: [S('a ping costs ', 'dim'), S(usd(v.ping ?? 0), 'fg')] },
      )
    } else {
      items.push({ p: 0, segs: [S('then re-sends ', 'dim'), S(`${fk(v.tokens)} at ${WRITE}x`, 'fg')] })
      if (v.limitPct !== null) items.push({ p: 2, segs: [S('5h window ', 'dim'), S(`${v.limitPct}%`, 'fg')] })
    }
    right = [bracket('Keep warm', 'warm')]
  } else {
    items = [{ p: 0, segs: [S('○ ', 'err'), S('Cache is cold', 'fg b')] }]
    if (v.mode === 'api') {
      items.push({
        p: 0,
        segs: [S(`next turn rewrites ${fk(v.tokens)} `, 'dim'), S(`(+${usd(v.miss ?? 0)} est.)`, 'fg')],
      })
    } else {
      items.push({ p: 0, segs: [S('next turn re-sends ', 'dim'), S(`${fk(v.tokens)} at ${WRITE}x`, 'fg')] })
    }
    items.push({ p: 3, segs: [S('cheapest moment to compact', 'dim')] })
    right = [bracket('Compact now', 'compact')]
  }
  const dismiss = S('  dismiss', 'accent', { act: 'dismiss' })
  const rw = right[0]!.t.length
  const full = [...right, dismiss]
  const fw = rw + dismiss.t.length
  const l1 = prio(items, w - fw - 2)
  if (prio(items, 999).length === l1.length && l1.reduce((n, s) => n + [...s.t].length, 0) + fw + 2 <= w) {
    return lr(l1, full, w)
  }
  return lr(prio(items, w - rw - 2), right, w)
}

// ---- the pane --------------------------------------------------------------------------
export function cachePane(v: View, iw: number): Seg[][] {
  return paneLines(v, iw).map(l => fit(l, iw))
}

function paneLines(v: View, iw: number): Seg[][] {
  const b: Seg[][] = []
  const head = lr([S('Cache Guard', 'fg b')], [S(`${modeLabel(v)} · TTL ${v.ttlLabel}`, 'dim')], iw)
  b.push(head, [S('─'.repeat(iw), 'line')])

  const kwLine = (note?: string): Seg[] =>
    lr(
      [
        S('Keep warm  ', 'fg b'),
        v.isKeepWarm ? S('[■ on ]', 'ok b', { act: 'warm', hk: 'k' }) : S('[□ off]', 'dim', { act: 'warm', hk: 'k' }),
      ],
      iw >= 50 ? [S(note ?? 'manual · pings 30s before expiry', 'dim')] : [],
      iw,
    )

  if (v.state === 'empty') {
    b.push([S('◌ ', 'dim'), S('No cache yet', 'fg b')])
    b.push([S('░'.repeat(Math.max(4, iw - 13)), 'free'), S(`  —:—— / ${v.ttlLabel === '1h' ? '60:00' : '5:00'}`, 'dim')])
    b.push([], ...wrap('The first turn writes the cache. The countdown starts when it lands.', iw, 'dim'), [], kwLine('available after the first turn'))
    return b
  }
  if (v.state === 'na') {
    b.push([S('? ', 'dim'), S('Cache data unavailable', 'fg b')], [])
    b.push(
      ...wrap(
        "This provider doesn't report cache reads or writes, so hits, misses and expiry can't be measured. The countdown is hidden rather than guessed.",
        iw,
        'dim',
      ),
      [],
      kwLine('unavailable'),
    )
    return b
  }

  const isWarn = v.state === 'warn'
  const isCold = v.state === 'crit'
  if (isCold) {
    b.push(lr([S('○ ', 'err'), S('Cold', 'fg b'), S(` · expired ${dur(v.expiredMs)} ago`, 'dim')], [], iw))
  } else if (v.isKeepWarm) {
    b.push(lr([S('● ', 'ok'), S('Warm', 'fg b'), S(' · expires in ', 'dim'), S(v.clock, isWarn ? 'warn b' : 'fg b')], [S('↻ keep warm on', 'accent')], iw))
  } else if (isWarn) {
    b.push([S('◔ ', 'warn'), S('Expiring soon', 'fg b'), S(' · expires in ', 'dim'), S(v.clock, 'warn b')])
  } else {
    b.push([S('● ', 'ok'), S('Warm', 'fg b'), S(' · expires in ', 'dim'), S(v.clock, 'fg b')])
  }

  const total = v.ttlLabel === '1h' ? '60:00' : '5:00'
  const n = Math.max(6, iw - 13)
  const f = isCold ? 0 : Math.round((Math.max(0, v.leftMs) / v.ttlMs) * n)
  b.push([
    S('█'.repeat(f), isWarn ? 'warn' : 'ok'),
    S('░'.repeat(n - f), 'free'),
    S(`  ${padL(isCold ? '0:00' : v.clock, 4)} / ${total}`, 'dim'),
  ])
  b.push([S(`${fk(v.tokens)} cached prefix`, 'fg'), S(`  ${shortModel(v.model)}`, 'dim')])

  if (v.mode === 'api') {
    b.push([S('Miss ', 'dim'), S(`+${usd(v.miss ?? 0)}`, 'fg'), S(' · ping ', 'dim'), S(usd(v.ping ?? 0), 'fg'), S(' · est.', 'dim')])
  } else if (v.mode === 'sub') {
    b.push([S(`A miss re-sends it at ${WRITE}x · a ping re-reads it at ${v.readMult}x`, 'dim')])
    if (v.limitPct !== null) b.push([S('5h window ', 'dim'), S(`${v.limitPct}%`, 'fg'), S(' used', 'dim')])
  } else {
    b.push([S(`Miss ${WRITE}x · ping ${v.readMult}x · prices unknown`, 'dim')])
  }

  if (isCold) {
    b.push([])
    b.push(
      ...wrap(
        'Cache is cold — compact now. The next turn rewrites all of it either way; compacting first means you rebuild a smaller prefix instead.',
        iw,
        'fg',
      ),
    )
    b.push([bracket('Compact now', 'compact', 'c'), S('   or just keep working', 'dim')])
  }

  b.push([])
  b.push(kwLine())
  if (v.isKeepWarm) {
    const next = v.nextPingMs === null ? '' : ` · next ping in ${Math.floor(v.nextPingMs / 60000)}:${String(Math.floor((v.nextPingMs % 60000) / 1000)).padStart(2, '0')}`
    b.push(
      v.mode === 'api' && v.spent !== null
        ? [S(`${v.totalPings} pings `, 'fg'), S(`${usd(v.spent)} est.`, 'dim'), S(next, 'dim')]
        : [S(`${v.totalPings} pings `, 'fg'), S(`${fk(v.pingTokens)} read at ${v.readMult}x`, 'dim'), S(next, 'dim')],
    )
    if (v.avoided > 0) {
      b.push(
        v.net !== null && v.miss !== null
          ? [S(`Saved ${v.avoided} miss${v.avoided > 1 ? 'es' : ''} `, 'dim'), S(`+${usd(v.avoided * v.miss)}`, 'fg'), S(' · net ', 'dim'), S(`${v.net >= 0 ? '−' : '+'}${usd(Math.abs(v.net))} est.`, v.net >= 0 ? 'ok' : 'warn')]
          : [S(`Avoided ${v.avoided} miss${v.avoided > 1 ? 'es' : ''} `, 'dim'), S(`(${fk(v.tokens)} at ${WRITE}x)`, 'fg')],
      )
    }
    b.push([S(`Stops by itself after ${v.breakEven} pings in a row, or 2h without a turn.`, 'dim')])
  } else {
    b.push(...wrap(`Off. When on, it pings 30s before expiry while you are away, until you turn it off.`, iw, 'dim'))
    b.push([S('Break-even: ', 'dim'), S(`1 avoided miss = ${v.breakEven} pings`, 'fg')])
  }

  b.push([])
  if (v.beats.length > 0) {
    const k = Math.min(v.beats.length, iw - 7)
    const seq = v.beats.slice(-k)
    const g = { hit: ['●', 'ok'], part: ['◐', 'warn'], miss: ['○', 'err'] } as const
    b.push([S('Steps  ', 'dim'), ...seq.map(x => S(g[x][0], g[x][1]))])
    const cnt = (c: string) => seq.filter(x => x === c).length
    b.push([
      S('       '),
      S('●', 'ok'),
      S(` hit ${cnt('hit')}   `, 'dim'),
      S('◐', 'warn'),
      S(` partial ${cnt('part')}   `, 'dim'),
      S('○', 'err'),
      S(` miss ${cnt('miss')}`, 'dim'),
    ])
    b.push([])
  }

  const bustTotal =
    v.mode === 'api' && v.bustCost !== null
      ? `+${usd(v.bustCost)} est.`
      : `${fk(v.bustTokens)} rewritten`
  b.push(lr([S('Cache busts', 'fg b')], v.busts.length ? [S('session ', 'dim'), S(bustTotal, 'fg')] : [], iw))
  if (v.busts.length === 0) b.push([S('None seen.', 'dim')])
  v.busts
    .slice(-5)
    .reverse()
    .forEach(x => {
      const d = new Date(x.at)
      const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      const cost = v.mode === 'api' ? '' : ''
      b.push(
        lr(
          [S(`${time}  `, 'dim'), S(x.cause, x.cause === 'cause unknown' ? 'dim' : 'fg'), S(iw >= 50 && x.detail ? `  ${x.detail}` : '', 'dim')],
          [S(`${fk(x.tokens)}${cost}`, 'fg')],
          iw,
        ),
      )
    })

  b.push([])
  b.push(
    lr(
      [
        S('TTL ', 'dim'),
        v.ttlLabel === '5m' ? S(' 5m ', 'sel') : S(' 5m ', 'dim', { act: 'ttl5' }),
        v.ttlLabel === '1h' ? S(' 1h ', 'sel') : S(' 1h ', 'dim', { act: 'ttl1h' }),
        S('  assumed', 'dim'),
      ],
      [],
      iw,
    ),
  )
  return b
}

// ---- drawing ---------------------------------------------------------------------------
const styleOf = (s: Seg): Record<string, unknown> => {
  const p: Record<string, unknown> = {}
  if (s.c) p.color = s.c
  else if (s.r === 'accent') p.color = 'claude'
  else if (s.r === 'ok') p.color = 'success'
  else if (s.r === 'warn') p.color = 'warning'
  else if (s.r === 'err') p.color = 'error'
  else if (s.r === 'dim' || s.r === 'line' || s.r === 'free' || s.r === 'buf') p.dimColor = true
  else if (s.r === 'sel') p.inverse = true
  if (s.b) p.bold = true
  return p
}

/** One row. A row holding actions is a Box of siblings; a plain row is one Text of runs. */
export function row(el: El, segs: Seg[], acts: Acts, key: string) {
  const { Box, Text, Button } = el
  if (segs.length === 0) return <Text key={key}> </Text>
  if (!segs.some(s => s.act)) {
    return (
      <Text key={key} wrap="truncate">
        {segs.map((s, i) => (
          <Text key={`${key}.${i}`} {...styleOf(s)}>{s.t}</Text>
        ))}
      </Text>
    )
  }
  return (
    <Box key={key}>
      {segs.map((s, i) =>
        s.act ? (
          <Button key={`${key}.${s.act}`} label={s.t} hotkey={s.hk} onPress={acts[s.act]} />
        ) : (
          <Text key={`${key}.${i}`} {...styleOf(s)}>{s.t}</Text>
        ),
      )}
    </Box>
  )
}
