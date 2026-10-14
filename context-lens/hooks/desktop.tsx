// Desktop surface (also VS Code and mobile): themed Box/Text/Button for words, Svg for graphics.
import type { Elements } from 'claude-code'

import { fk, fk1 } from './layout'
import { WRITE, usd, whatIf } from './model'
import type { View } from './model'
import { colorOf, columnsSvg, miniStackSvg, rowBarSvg, stackedBarSvg } from './svg'
import type { PaneState } from './terminal'
import type { Acts } from './terminal'

export type DesktopEl = Pick<Elements['desktop'], 'Box' | 'Text' | 'Button' | 'Svg'>

const TABS = [
  { id: 'category', label: 'Category' },
  { id: 'items', label: 'Items' },
  { id: 'whatif', label: 'What-if' },
  { id: 'trend', label: 'Trend' },
] as const
const role = (v: View): string | undefined => (v.state === 'crit' ? 'error' : v.state === 'warn' ? 'warning' : undefined)
const modeLabel = (v: View): string => (v.mode === 'api' ? 'API billing · est.' : v.mode === 'sub' ? 'Subscription' : 'Prices unknown')

function carryText(v: View): string {
  const l = v.lens!
  if (v.mode === 'api' && v.carry !== null) return `Carrying ${fk(l.total)} costs ~${usd(v.carry)}/turn est.`
  if (v.mode === 'sub') return `Carrying ${fk(l.total)} re-reads at ${v.read}x every turn${l.limitPct !== null ? ` · 5h window ${l.limitPct}%` : ''}`
  return `Carrying ${fk(l.total)} re-reads at ${v.read}x every turn · prices unknown for this model`
}

function tipFor(v: View, name: string, tokens: number): string {
  const l = v.lens!
  const pct = ((tokens / l.window) * 100).toFixed(1)
  const carry =
    v.mode === 'api' && v.carry !== null
      ? `Carrying it: ~${usd((tokens / 1e6) * (v.carry / (l.total / 1e6)))}/turn est.`
      : `Re-read at ${v.read}x every turn`
  return `${name}\n${fk1(tokens)} tokens · ${pct}% of window\n${carry}`
}

export function ctxPaneDesktop(el: DesktopEl, v: View, st: PaneState, acts: Acts) {
  const { Box, Text, Button, Svg } = el
  const l = v.lens
  if (!l || v.state === 'empty') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>No turns yet.</Text>
        <Text dimColor>Send a prompt to start measuring. Categories, items and the trend fill in after the first response.</Text>
      </Box>
    )
  }

  const segs = l.cats.map(c => ({ cat: c, tip: tipFor(v, c.name, c.tokens) }))
  const summary = (
    <Box flexDirection="column" gap={1}>
      <Box justifyContent="space-between">
        <Text>
          <Text bold>{fk(l.total)}</Text> <Text dimColor>of {fk(l.window)} ·</Text>{' '}
          <Text bold color={role(v)}>{v.percent}%</Text>
        </Text>
        <Text dimColor>{v.thresholdPct ? `autocompact at ${v.thresholdPct}%` : ''}</Text>
      </Box>
      <Svg
        key="window-bar"
        source={stackedBarSvg(segs, l.autoCompactAt ? Math.min(1, l.autoCompactAt / Math.max(l.window, l.cats.reduce((n, c) => n + (c.kind === 'deferred' ? 0 : c.tokens), 0))) : null, 360, 16, l.window)}
        alt={`${fk(l.total)} of ${fk(l.window)} used (${v.percent}%): ${l.cats.filter(c => c.kind === 'used').slice(0, 4).map(c => `${c.name} ${fk(c.tokens)}`).join(', ')}`}
        isInteractive
      />
      {v.state !== 'normal' && (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          <Text color={role(v)} bold>
            {v.state === 'crit'
              ? 'Autocompacts next turn'
              : `${v.turnsLeft !== null ? `About ${Math.max(1, Math.round(v.turnsLeft))} turns until autocompact` : 'Past 80% of the window'}`}
          </Text>
          <Text dimColor>Compacting yourself lets you choose what is kept.</Text>
          <Button key="compact" label="Compact now" onPress={acts.compact} />
        </Box>
      )}
      <Box>
        {TABS.map(t => (
          <Button key={`t-${t.id}`} label={t.id === st.tab ? `[ ${t.label} ]` : t.label} onPress={acts[`tab:${t.id}`]} />
        ))}
      </Box>
    </Box>
  )

  if (st.tab === 'items') {
    const isOpen = (k: string) => st.open.includes(k)
    const sum = (a: { tokens: number }[]) => a.reduce((n, x) => n + x.tokens, 0)
    const group = (k: string, name: string, meta: string, tokens: number, kids: { label: string; meta?: string; tokens: number; wi?: string }[]) => (
      <Box key={k} flexDirection="column">
        <Box justifyContent="space-between">
          <Button key={`g-${k}`} label={`${isOpen(k) ? '▾' : '▸'} ${name}${meta ? ` · ${meta}` : ''}`} onPress={acts[`grp:${k}`]} />
          <Text>{fk1(tokens)}</Text>
        </Box>
        {isOpen(k) &&
          kids.map((c, i) => (
            <Box key={`${k}.${i}`} justifyContent="space-between" paddingLeft={2}>
              <Text>{c.label} <Text dimColor>{c.meta ?? ''}</Text></Text>
              <Box gap={2}>
                {c.wi && <Button key={`wi-${k}.${i}`} label="What-if" onPress={acts[`wi:${c.wi}`]} />}
                <Text>{fk1(c.tokens)}</Text>
              </Box>
            </Box>
          ))}
      </Box>
    )
    const msg = sum(l.sources)
    return (
      <Box flexDirection="column" gap={1}>
        {summary}
        {group('mcp', 'MCP tools', `${l.servers.length} servers`, sum(l.servers), l.servers.map(s => ({ label: s.label, meta: `${s.tools} tools${s.deferred > 0 ? ` · ${s.deferred} on demand` : ''}`, tokens: s.tokens, wi: s.tokens > 0 ? `mcp:${s.label}` : undefined })))}
        {group('mem', 'Memory files', `${l.memory.length} files`, sum(l.memory), l.memory.map(m => ({ label: m.label, tokens: m.tokens, wi: `Memory file:${m.label}` })))}
        {group('skl', 'Skills', String(l.skills.length), sum(l.skills), l.skills.slice(0, 8).map(s => ({ label: s.label, tokens: s.tokens })))}
        {group('agt', 'Agents', String(l.agents.length), sum(l.agents), l.agents.map(s => ({ label: s.label, tokens: s.tokens })))}
        {group('msg', 'Messages by source', '', msg, l.sources.map(s => ({ label: s.label, meta: `${Math.round((s.tokens / Math.max(1, msg)) * 100)}%`, tokens: s.tokens })))}
      </Box>
    )
  }

  if (st.tab === 'whatif') {
    const cands = v.candidates
    if (cands.length === 0) {
      return (
        <Box flexDirection="column" gap={1}>
          {summary}
          <Text dimColor>Nothing removable found.</Text>
        </Box>
      )
    }
    const sel = cands.find(c => c.key === st.whatIf) ?? cands[0]!
    const w = whatIf(v, sel)!
    const card = (label: string, value: string, good = false) => (
      <Box key={label} flexDirection="column" borderStyle="round" paddingX={1} minWidth={22}>
        <Text dimColor>{label}</Text>
        <Text bold color={good ? 'success' : undefined}>{value}</Text>
      </Box>
    )
    return (
      <Box flexDirection="column" gap={1}>
        {summary}
        <Text bold>If you removed</Text>
        <Box flexWrap="wrap">
          {cands.slice(0, 8).map(c => (
            <Button key={`c-${c.key}`} label={c.key === sel.key ? `[ ${c.label} ]` : c.label} onPress={acts[`wi:${c.key}`]} />
          ))}
        </Box>
        <Box flexWrap="wrap" gap={1}>
          {card('Frees', `${fk1(w.frees)} · ${w.pctWindow.toFixed(1)}% of window`)}
          {card('Saves per turn', w.savesPerTurn !== null ? `~${usd(w.savesPerTurn)} est.` : `${fk1(w.frees)} fewer cached tokens read`)}
          {card(
            'One-time rebuild',
            w.isCold ? 'nothing extra' : w.rebuild !== null ? `+${usd(w.rebuild)} est.` : `${fk(l.total - sel.tokens)} at ${WRITE}x`,
            w.isCold,
          )}
          {card('Pays back after', w.isCold ? 'immediately' : `~${w.turns} turns est.`, w.isCold)}
        </Box>
        <Text dimColor>
          {w.isCold
            ? `The cache looks cold, so the next turn rebuilds the prefix anyway. Removing ${sel.label} now costs nothing extra.`
            : `The cache is warm, so removing ${sel.label} now forces a one-time rebuild. It's cheapest when the cache is cold or at the start of a session.`}{' '}
          To remove it, disable it in /mcp or your memory settings; this view only estimates.
        </Text>
      </Box>
    )
  }

  if (st.tab === 'trend') {
    const hist = st.history
    return (
      <Box flexDirection="column" gap={1}>
        {summary}
        {hist.length < 2 ? (
          <Text dimColor>Not enough turns yet.</Text>
        ) : (
          <Box flexDirection="column" gap={1}>
            <Svg
              key="trend"
              source={columnsSvg(hist, l.window, v.thresholdPct)}
              alt={`Window fill over the last ${hist.length} turns, now ${v.percent}%`}
              isInteractive
            />
            <Text dimColor>
              ■ messages · ■ overhead {fk(l.overhead)} · - - {v.thresholdPct ?? 92}% autocompact
              {hist.some(p => p.isCompaction) ? ` · ▲ compacted at turn ${hist.find(p => p.isCompaction)!.n}` : ''}
            </Text>
            {v.growth !== null && (
              <Text>
                <Text bold>+{fk(Math.max(0, v.growth))}/turn</Text> <Text dimColor>average, last {Math.min(10, hist.length - 1)} turns</Text>
                {v.turnsLeft !== null && (
                  <Text>
                    {' · '}
                    <Text bold color={role(v)}>{v.turnsLeft < 1 ? 'autocompacts next turn' : `~${Math.round(v.turnsLeft)} turns to autocompact (est.)`}</Text>
                  </Text>
                )}
              </Text>
            )}
          </Box>
        )}
      </Box>
    )
  }

  const rows = l.cats.filter(c => c.kind === 'used' && c.tokens > 0).sort((a, c) => c.tokens - a.tokens)
  return (
    <Box flexDirection="column" gap={1}>
      {summary}
      <Box flexDirection="column">
        {rows.map((c, i) => (
          <Box key={`c${i}`} gap={2} alignItems="center">
            <Svg key={`bar${i}`} source={rowBarSvg(c.tokens / l.window, colorOf(c.name))} alt={`${c.name} ${fk1(c.tokens)}`} width={84} height={6} />
            <Box width={20}><Text>{c.name}</Text></Box>
            <Box width={9} justifyContent="flex-end"><Text>{fk1(c.tokens)}</Text></Box>
            <Text dimColor>{((c.tokens / l.window) * 100).toFixed(1)}%</Text>
          </Box>
        ))}
        {l.cats
          .filter(c => c.kind === 'free' || c.kind === 'buffer')
          .map((c, i) => (
            <Box key={`f${i}`} gap={2}>
              <Box width={84}><Text dimColor> </Text></Box>
              <Box width={20}><Text dimColor>{c.name}</Text></Box>
              <Box width={9} justifyContent="flex-end"><Text dimColor>{fk1(c.tokens)}</Text></Box>
            </Box>
          ))}
      </Box>
      <Text dimColor>{carryText(v)}</Text>
    </Box>
  )
}

/** The one-line summary above the composer: mini bar, percent, top three, carry or window. */
export function ctxBandDesktop(el: DesktopEl, v: View, acts: Acts) {
  const { Box, Text, Button, Svg } = el
  const l = v.lens
  if (!l || v.state === 'empty') {
    return <Text dimColor>ctx — send a prompt to start measuring</Text>
  }
  const top = l.cats.filter(c => c.kind === 'used' && c.tokens > 0).sort((a, b) => b.tokens - a.tokens).slice(0, 3)
  const offer = v.offer
  return (
    <Box flexDirection="column">
      {offer && (
        <Box key="offer" gap={2} alignItems="center">
          <Text bold color="yellow">Compact to free ~{fk(offer.frees)} tokens</Text>
          <Text dimColor>
            {offer.savesPerTurn !== null ? `~${usd(offer.savesPerTurn)} less per turn (est.)` : `${Math.round(offer.pctWindow)}% of the window (est.)`} · keeps a summary; you choose what is kept
          </Text>
          <Button key="compact" label="Compact now" onPress={acts.compact} />
          <Button key="snooze" label="Not now" onPress={acts.snooze} />
        </Box>
      )}
    <Box key="band" gap={2} alignItems="center">
      <Button key="open" label="Context Lens" onPress={acts.open} />
      <Svg key="mini" source={miniStackSvg(l.cats)} alt={`${v.percent}% of the window used`} width={96} height={6} />
      <Text bold color={role(v)}>{v.percent}%</Text>
      <Text dimColor wrap="truncate">
        {v.state === 'crit'
          ? 'autocompacts next turn'
          : v.state === 'warn'
            ? v.turnsLeft !== null ? `~${Math.max(1, Math.round(v.turnsLeft))} turns to autocompact` : 'past 80%'
            : top.map(c => `${c.name} ${fk(c.tokens)}`).join(' · ')}
      </Text>
      <Text dimColor>
        {v.mode === 'api' && v.carry !== null ? `carry ~${usd(v.carry)}/turn est.` : v.mode === 'sub' && l.limitPct !== null ? `5h window ${l.limitPct}%` : ''}
      </Text>
      {v.state !== 'normal' && !offer && <Button key="compact" label="Compact now" onPress={acts.compact} />}
    </Box>
    </Box>
  )
}
