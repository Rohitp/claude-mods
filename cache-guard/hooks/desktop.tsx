// Desktop surface (also VS Code and mobile): themed Box/Text/Button for words, Svg for graphics.
import type { Elements } from 'claude-code'

import { dur, fk } from './layout'
import { WRITE, shortModel, usd } from './model'
import type { View } from './model'
import { COLORS, miniBarSvg, ringSvg, stepsSvg } from './svg'
import type { Acts } from './terminal'

export type DesktopEl = Pick<Elements['desktop'], 'Box' | 'Text' | 'Button' | 'Svg'>
type El = DesktopEl

const clock = (ms: number): string => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const roleColor = (v: View): string => (v.state === 'crit' ? 'error' : v.state === 'warn' ? 'warning' : 'success')
const hex = (v: View): string => (v.state === 'crit' ? COLORS.err : v.state === 'warn' ? COLORS.warn : COLORS.ok)
const modeLabel = (v: View): string =>
  v.mode === 'api' ? 'API billing · est.' : v.mode === 'sub' ? 'Subscription' : 'Prices unknown'

/** "A miss costs +$1.98 est." in API mode, tokens and multipliers otherwise. */
function missLine(v: View): string {
  if (v.mode === 'api') return `A miss costs +${usd(v.miss ?? 0)} est. · a ping costs ${usd(v.ping ?? 0)}`
  if (v.mode === 'sub') {
    return `A miss re-sends ${fk(v.tokens)} at ${WRITE}x · a ping re-reads it at ${v.readMult}x${v.limitPct !== null ? ` · 5h window ${v.limitPct}%` : ''}`
  }
  return `Miss ${WRITE}x · ping ${v.readMult}x · prices unknown for this model`
}

export function cachePaneDesktop(el: El, v: View, acts: Acts) {
  const { Box, Text, Button, Svg } = el

  if (v.state === 'empty' || v.state === 'na') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>{v.state === 'na' ? 'Cache data unavailable' : 'No cache yet'}</Text>
        <Text dimColor>
          {v.state === 'na'
            ? "This provider doesn't report cache reads or writes, so hits, misses and expiry can't be measured. The countdown is hidden rather than guessed."
            : 'The first turn writes the cache. The countdown starts when it lands.'}
        </Text>
      </Box>
    )
  }

  const isCold = v.state === 'crit'
  const frac = isCold ? 0 : v.leftMs / v.ttlMs
  const next = isCold ? 0 : Math.max(0, (v.leftMs - 1000) / v.ttlMs)
  const title = isCold ? 'Cold' : v.state === 'warn' ? 'Expiring soon' : 'Warm'
  const total = v.ttlLabel === '1h' ? '60:00' : '5:00'

  const steps = v.beats.slice(-24)
  const dots = steps.map((b, i) => ({
    beat: b,
    tip: `Step ${v.beats.length - steps.length + i + 1} · ${b === 'hit' ? 'read from cache' : b === 'part' ? 'partly read' : 'rewritten'}`,
  }))
  const cnt = (b: string) => steps.filter(x => x === b).length

  return (
    <Box flexDirection="column" gap={1}>
      <Box gap={2} alignItems="center">
        <Svg
          source={ringSvg(frac, next, hex(v))}
          alt={isCold ? 'Cache cold' : `Cache ${title.toLowerCase()}, ${v.clock} of ${total} left`}
          width={88}
          height={88}
        />
        <Box flexDirection="column">
          <Text bold color={roleColor(v)}>{isCold ? 'Cold' : v.clock}</Text>
          <Text dimColor>{isCold ? `expired ${dur(v.expiredMs)} ago` : `of ${total}`}</Text>
          <Text>{title}{v.isKeepWarm && !isCold ? ' · keep warm on' : ''}</Text>
        </Box>
      </Box>
      <Text dimColor>TTL {v.ttlLabel} assumed · {modeLabel(v)} · {shortModel(v.model)}</Text>
      <Box>
        <Button key="ttl5" label={v.ttlLabel === '5m' ? '[ 5m ]' : '5m'} onPress={acts.ttl5} />
        <Button key="ttl1h" label={v.ttlLabel === '1h' ? '[ 1h ]' : '1h'} onPress={acts.ttl1h} />
      </Box>

      <Box flexDirection="column">
        <Text><Text bold>{fk(v.tokens)}</Text> cached prefix</Text>
        <Text dimColor>{missLine(v)}</Text>
      </Box>

      {isCold && (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          <Text bold color="error">Cache is cold — compact now</Text>
          <Text>The next turn rewrites all of it either way; compacting first means you rebuild a smaller prefix instead.</Text>
          <Box>
            <Button key="compact" label="Compact now" onPress={acts.compact} />
            <Button key="dismiss" label="Keep working" onPress={acts.dismiss} />
          </Box>
        </Box>
      )}

      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Box justifyContent="space-between">
          <Text bold>Keep warm</Text>
          <Button key="warm" label={v.isKeepWarm ? 'On · turn off' : 'Off · turn on'} onPress={acts.warm} />
        </Box>
        <Text dimColor>
          {v.isKeepWarm
            ? `Pings 30s before expiry while you are away. Stops by itself after ${v.breakEven} pings in a row or 2h without a turn.`
            : `Manual. When on, it pings 30s before expiry while you are away, until you turn it off. Break-even: 1 avoided miss = ${v.breakEven} pings.`}
        </Text>
        {v.isKeepWarm && (
          <Box gap={3}>
            <Text>Pings <Text bold>{v.totalPings}</Text></Text>
            <Text>
              Spent{' '}
              <Text bold>{v.spent !== null && v.mode === 'api' ? `${usd(v.spent)} est.` : `${fk(v.pingTokens)} read`}</Text>
            </Text>
            <Text>
              Next ping{' '}
              <Text bold>
                {v.nextPingMs === null ? '—' : `${Math.floor(v.nextPingMs / 60000)}:${String(Math.floor((v.nextPingMs % 60000) / 1000)).padStart(2, '0')}`}
              </Text>
            </Text>
          </Box>
        )}
        {v.isKeepWarm && v.avoided > 0 && v.net !== null && v.miss !== null && (
          <Text dimColor>
            Saved {v.avoided} miss{v.avoided > 1 ? 'es' : ''} +{usd(v.avoided * v.miss)} · net {v.net >= 0 ? '−' : '+'}{usd(Math.abs(v.net))} est.
          </Text>
        )}
      </Box>

      {steps.length > 0 && (
        <Box flexDirection="column">
          <Text bold>Recent steps</Text>
          <Svg
            source={stepsSvg(dots)}
            alt={`${cnt('hit')} hits, ${cnt('part')} partial, ${cnt('miss')} misses in the last ${steps.length} steps`}
            isInteractive
          />
          <Text dimColor>● read from cache · ◐ partly · ○ rewritten  ({cnt('hit')} / {cnt('part')} / {cnt('miss')})</Text>
        </Box>
      )}

      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Text bold>Cache busts</Text>
          {v.busts.length > 0 && (
            <Text dimColor>
              session {v.mode === 'api' && v.bustCost !== null ? `+${usd(v.bustCost)} est.` : `${fk(v.bustTokens)} rewritten`}
            </Text>
          )}
        </Box>
        {v.busts.length === 0 && <Text dimColor>None seen.</Text>}
        {v.busts
          .slice(-6)
          .reverse()
          .map((b, i) => (
            <Box key={`b${i}`} gap={2}>
              <Text dimColor>{clock(b.at)}</Text>
              <Text italic={b.cause === 'cause unknown'} dimColor={b.cause === 'cause unknown'}>{b.cause}</Text>
              <Text dimColor>{b.detail}</Text>
              <Text>
                {v.mode === 'api' && v.missPerToken !== null ? `+${usd(b.tokens * v.missPerToken)}` : `${fk(b.tokens)} × ${WRITE}`}
              </Text>
            </Box>
          ))}
      </Box>
    </Box>
  )
}

/** The band above the composer: only within 60s of expiry or when stale. */
export function cacheBandDesktop(el: El, v: View, acts: Acts) {
  const { Box, Text, Button, Svg } = el
  if (v.state === 'normal' || v.state === 'empty' || v.state === 'na' || v.isDismissed) return null
  const isCold = v.state === 'crit'
  const body = isCold
    ? v.mode === 'api'
      ? `The next turn rewrites ${fk(v.tokens)} (+${usd(v.miss ?? 0)} est.). This is the cheapest moment to compact.`
      : `The next turn re-sends ${fk(v.tokens)} at ${WRITE}x. This is the cheapest moment to compact.`
    : v.isKeepWarm
      ? `Keep warm is on · pings at 0:30 · ${v.totalPings} pings`
      : v.mode === 'api'
        ? `Then a miss costs +${usd(v.miss ?? 0)} est. A ping costs ${usd(v.ping ?? 0)}.`
        : `Then the next turn re-sends ${fk(v.tokens)} at ${WRITE}x.`
  return (
    <Box gap={2} alignItems="center" borderStyle="round" paddingX={1}>
      <Svg
        source={miniBarSvg(isCold ? 0 : v.leftMs / 60000, hex(v), 48, 6)}
        alt={isCold ? 'Cache cold' : `Cache expires in ${v.clock}`}
        width={48}
        height={6}
      />
      <Text bold color={roleColor(v)}>{isCold ? 'Cache is cold' : `Cache expires in ${v.clock}`}</Text>
      <Text dimColor wrap="truncate">{body}</Text>
      {isCold ? (
        <Button key="compact" label="Compact now" onPress={acts.compact} />
      ) : (
        <Button key="warm" label={v.isKeepWarm ? 'Turn off keep warm' : 'Keep warm'} onPress={acts.warm} />
      )}
      <Button key="dismiss" label="Dismiss" onPress={acts.dismiss} />
    </Box>
  )
}
