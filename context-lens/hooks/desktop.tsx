// Desktop surface (also VS Code and mobile): themed Box/Text/Button for words, Svg for graphics.
import type { Elements } from 'claude-code'

import { fk, fk1 } from './layout'
import { usd, whatIf } from './model'
import type { View } from './model'
import { colorOf, miniStackSvg, sparkSvg, stackedBarSvg, swatchSvg } from './svg'
import type { PaneState } from './terminal'
import type { Acts } from './terminal'

export type DesktopEl = Pick<Elements['desktop'], 'Box' | 'Text' | 'Button' | 'Svg'>

const role = (v: View): string | undefined => (v.state === 'crit' ? 'error' : v.state === 'warn' ? 'warning' : undefined)
const modeLabel = (v: View): string => (v.mode === 'api' ? 'API billing · est.' : v.mode === 'sub' ? 'Subscription · tokens' : 'Prices unknown · tokens')

function carryText(v: View): string {
  const l = v.lens!
  if (v.mode === 'api' && v.carry !== null) return `Carrying ${fk(l.total)} costs ~${usd(v.carry)}/turn est.`
  if (v.mode === 'sub') return `Each turn re-reads ${fk(l.total)}${l.limitPct !== null ? ` · 5h window ${l.limitPct}%` : ''}`
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

/** Where a category's items come from, and the key its row opens under. */
const GROUP_OF: Record<string, string> = { Messages: 'msg', 'MCP tools': 'mcp', 'Memory files': 'mem', Skills: 'skl', 'Custom agents': 'agt', Agents: 'agt' }

type Kid = { label: string; meta?: string; tokens: number; wi?: string }

function kidsOf(v: View, g: string): Kid[] {
  const l = v.lens!
  if (g === 'msg') return l.sources.map(s => ({ label: s.label, tokens: s.tokens }))
  if (g === 'mcp') return l.servers.map(s => ({ label: s.label, meta: `${s.tools} tools${s.deferred > 0 ? ` · ${s.deferred} on demand` : ''}`, tokens: s.tokens, wi: s.tokens > 0 ? `mcp:${s.label}` : undefined }))
  if (g === 'mem') return l.memory.map(m => ({ label: m.label, tokens: m.tokens, wi: `Memory file:${m.label}` }))
  if (g === 'skl') return l.skills.slice(0, 12).map(s => ({ label: s.label, tokens: s.tokens }))
  if (g === 'agt') return l.agents.map(s => ({ label: s.label, tokens: s.tokens }))
  return []
}

const countOf = (v: View, g: string): string => {
  const l = v.lens!
  if (g === 'mcp') return `${l.servers.length} ${l.servers.length === 1 ? 'server' : 'servers'}`
  if (g === 'mem') return `${l.memory.length} ${l.memory.length === 1 ? 'file' : 'files'}`
  if (g === 'skl') return String(l.skills.length)
  if (g === 'agt') return String(l.agents.length)
  return ''
}

const pctOf = (tokens: number, window: number): string => `${((tokens / window) * 100).toFixed(1)}%`

/** How far off autocompact is, in turns when growth is known, else in tokens. */
function headroom(v: View): { main: string; sub: string } {
  const l = v.lens!
  const at = v.thresholdPct !== null ? `autocompact at ${v.thresholdPct}%` : 'no autocompact'
  if (v.state === 'crit') return { main: 'next turn', sub: at }
  if (v.turnsLeft !== null) return { main: `~${Math.max(1, Math.round(v.turnsLeft))} turns left`, sub: `before ${at}` }
  if (l.autoCompactAt) return { main: `${fk(Math.max(0, l.autoCompactAt - l.total))} free`, sub: at }
  return { main: '', sub: at }
}

/** The near-autocompact block: what compacting now frees, with Compact now and Not now. */
function pressure(el: DesktopEl, v: View, acts: Acts) {
  const { Box, Text, Button } = el
  const o = v.offer
  if (!o) return null
  const title =
    v.state === 'crit'
      ? 'Autocompacts next turn'
      : v.turnsLeft !== null
        ? `Autocompacts in about ${Math.max(1, Math.round(v.turnsLeft))} turns`
        : `Past ${v.percent >= 90 ? 90 : 80}% of the window`
  const saves = o.savesPerTurn !== null ? ` That is ~${usd(o.savesPerTurn)} less per turn (est.).` : ''
  return (
    <Box key="pressure" flexDirection="column" gap={1} borderStyle="round" borderColor="warning" paddingX={2} paddingY={1}>
      <Text weight="semibold" color="warning">{title}</Text>
      <Text>
        Compacting now, at a point you choose, keeps a summary and frees about <Text weight="semibold">{fk(o.frees)}</Text>.{saves}
      </Text>
      <Box gap={1}>
        <Button key="p-compact" label="Compact now" variant="primary" onPress={acts.compact!} />
        <Button key="p-snooze" label="Not now" variant="secondary" onPress={acts.snooze!} />
      </Box>
    </Box>
  )
}

/** The small form the desktop app shows for a minimized pane. */
function widget(el: DesktopEl, v: View, acts: Acts) {
  const { Box, Text, Button, Svg } = el
  const l = v.lens!
  const room = headroom(v)
  const top = l.cats.filter(c => c.kind === 'used' && c.tokens > 0).sort((a, b) => b.tokens - a.tokens).slice(0, 2)
  return (
    <Box flexDirection="column" gap={1}>
      <Box alignItems="center" gap={1}>
        <Text size="heading" weight="semibold" color={role(v)}>{v.percent}%</Text>
        <Text dimColor>{fk(l.total)} of {fk(l.window)}</Text>
        <Box flexGrow={1} />
        <Text weight="medium" color={role(v)}>{room.main}</Text>
      </Box>
      <Svg key="w-bar" source={windowBar(v)} alt={barAlt(v)} />
      {v.offer ? (
        <Box alignItems="center" gap={1}>
          <Text color="warning" wrap="truncate-end">Compacting frees ~{fk(v.offer.frees)}</Text>
          <Box flexGrow={1} />
          <Button key="w-compact" label="Compact now" variant="primary" onPress={acts.compact!} />
        </Box>
      ) : (
        <Box alignItems="center" gap={2}>
          {top.map(c => (
            <Box key={`w-${c.name}`} alignItems="center" gap={1}>
              <Svg key={`w-sw-${c.name}`} source={swatchSvg(colorOf(c.name))} alt="" width={8} height={8} />
              <Text size="footnote">{c.name} {fk(c.tokens)}</Text>
            </Box>
          ))}
          {v.growth !== null && <Text size="footnote" dimColor>+{fk(Math.max(0, v.growth))}/turn</Text>}
        </Box>
      )}
    </Box>
  )
}

const barSegs = (v: View) => v.lens!.cats.map(c => ({ cat: c, tip: tipFor(v, c.name, c.tokens) }))
function windowBar(v: View): string {
  const l = v.lens!
  const fill = l.cats.reduce((n, c) => n + (c.kind === 'deferred' ? 0 : c.tokens), 0)
  return stackedBarSvg(barSegs(v), l.autoCompactAt ? Math.min(1, l.autoCompactAt / Math.max(l.window, fill)) : null, 320, 10, l.window)
}
const barAlt = (v: View): string => {
  const l = v.lens!
  return `${fk(l.total)} of ${fk(l.window)} used (${v.percent}%): ${l.cats.filter(c => c.kind === 'used').slice(0, 4).map(c => `${c.name} ${fk(c.tokens)}`).join(', ')}`
}

export function ctxPaneDesktop(el: DesktopEl, v: View, st: PaneState, acts: Acts, placement?: string) {
  const { Box, Text, Button, Svg } = el
  const l = v.lens
  if (!l || v.state === 'empty') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text weight="semibold">No turns yet</Text>
        <Text dimColor>Send a prompt to start measuring. What fills the window shows up after the first response.</Text>
      </Box>
    )
  }
  if (placement === 'widget') return widget(el, v, acts)

  const room = headroom(v)
  const sel = st.whatIf ? v.candidates.find(c => c.key === st.whatIf) ?? null : null
  const w = sel ? whatIf(v, sel) : null
  const hist = st.history

  const summary = (
    <Box key="summary" flexDirection="column" gap={1}>
      <Box alignItems="flex-end" gap={1}>
        <Text size="title" weight="semibold" color={role(v)}>{v.percent}%</Text>
        <Text dimColor>{fk(l.total)} of {fk(l.window)}</Text>
        <Box flexGrow={1} />
        <Box flexDirection="column" alignItems="flex-end">
          {w ? (
            <Text weight="medium" color="success">→ {Math.round(((l.total - w.frees) / l.window) * 100)}% without it</Text>
          ) : (
            <Text weight="medium" color={role(v)}>{room.main}</Text>
          )}
          <Text size="caption" dimColor>{room.sub}</Text>
        </Box>
      </Box>
      <Svg key="window-bar" source={windowBar(v)} alt={barAlt(v)} isInteractive />
      {hist.length >= 2 && (
        <Box alignItems="flex-end" gap={2}>
          <Svg key="spark" source={sparkSvg(hist)} alt={`Window fill over the last ${Math.min(12, hist.length)} turns`} isInteractive />
          <Box flexGrow={1} />
          <Box flexDirection="column" alignItems="flex-end">
            <Text weight="medium">{v.growth !== null ? `+${fk(Math.max(0, v.growth))} / turn` : `${hist.length} turns`}</Text>
            <Text size="caption" dimColor>{v.growth !== null ? `last ${Math.min(10, hist.length - 1)} turns` : 'growth after 4 turns'}</Text>
          </Box>
        </Box>
      )}
    </Box>
  )

  const whatIfCard = (key: string) => {
    if (!sel || !w || sel.key !== key) return null
    const isMcp = sel.kind === 'MCP server'
    const stat = (label: string, value: string, note: string, good = false) => (
      <Box key={`s-${label}`} flexDirection="column" flexGrow={1}>
        <Text size="caption" dimColor>{label}</Text>
        <Text weight="semibold" color={good ? 'success' : undefined}>{value}</Text>
        <Text size="caption" dimColor>{note}</Text>
      </Box>
    )
    return (
      <Box key={`wi-${key}`} flexDirection="column" gap={1} borderStyle="round" borderColor="success" paddingX={2} paddingY={1}>
        <Box gap={2}>
          {stat('Frees', fk1(w.frees), w.savesPerTurn !== null ? `~${usd(w.savesPerTurn)} / turn est.` : 'every turn')}
          {stat('One-time cost', w.isCold ? 'nothing' : w.rebuild !== null ? `+${usd(w.rebuild)}` : fk(l.total - sel.tokens), w.isCold ? 'cache is cold' : 'cache rebuild', w.isCold)}
          {stat('Pays back', w.isCold ? 'now' : `~${w.turns} turns`, 'est.', w.isCold)}
        </Box>
        <Text dimColor>
          {w.isCold
            ? `The cache is cold, so removing ${sel.label} now costs nothing extra.`
            : `Removing ${sel.label} now forces a one-time rebuild. It's cheapest at the start of a session, when the cache is cold.`}{' '}
          {isMcp ? 'Turn it off in /mcp.' : 'Edit or remove the file to drop it.'} This panel never removes anything itself.
        </Text>
        <Box>
          <Button key="wi-keep" label="Keep it" variant="secondary" onPress={acts.keep!} />
        </Box>
      </Box>
    )
  }

  const rows = l.cats.filter(c => c.kind === 'used' && c.tokens > 0).sort((a, b) => b.tokens - a.tokens)
  const selGroup = sel ? (sel.kind === 'MCP server' ? 'mcp' : 'mem') : null
  const list = rows.map(c => {
    const g = GROUP_OF[c.name]
    const kids = g ? kidsOf(v, g) : []
    const isOpen = !!g && kids.length > 0 && (st.open.includes(g) || selGroup === g)
    const meta = g ? countOf(v, g) : ''
    return (
      <Box key={`row-${c.name}`} flexDirection="column">
        <Box alignItems="center" gap={1}>
          <Svg key={`sw-${c.name}`} source={swatchSvg(colorOf(c.name))} alt="" width={8} height={8} />
          {g && kids.length > 0 ? (
            <Button key={`g-${c.name}`} plain label={`${c.name} ${isOpen ? '▾' : '▸'}`} onPress={acts[`grp:${g}`]!} />
          ) : (
            <Text>{c.name}</Text>
          )}
          {meta && <Text size="caption" dimColor>{meta}</Text>}
          <Box flexGrow={1} />
          <Text mono tabular>{fk(c.tokens)}</Text>
          <Box width={6} justifyContent="flex-end"><Text size="footnote" dimColor tabular>{pctOf(c.tokens, l.window)}</Text></Box>
        </Box>
        {isOpen && (
          <Box flexDirection="column" paddingLeft={3}>
            {kids.map((k, i) => (
              <Box key={`k-${g}-${i}`} flexDirection="column">
                <Box alignItems="center" gap={1}>
                  {k.wi && acts[`wi:${k.wi}`] ? (
                    <Button key={`kb-${g}-${i}`} plain label={k.label} onPress={acts[`wi:${k.wi}`]!} />
                  ) : (
                    <Text>{k.label}</Text>
                  )}
                  {k.meta && <Text size="caption" dimColor>{k.meta}</Text>}
                  <Box flexGrow={1} />
                  <Text mono tabular dimColor>{fk(k.tokens)}</Text>
                  <Box width={6} justifyContent="flex-end"><Text size="footnote" dimColor tabular>{pctOf(k.tokens, l.window)}</Text></Box>
                </Box>
                {k.wi && whatIfCard(k.wi)}
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  })

  const free = l.cats.find(c => c.kind === 'free')
  const buffer = l.cats.find(c => c.kind === 'buffer')
  const deferred = l.cats.filter(c => c.kind === 'deferred' && c.tokens > 0)
  const top = v.candidates[0]
  return (
    <Box flexDirection="column" gap={2}>
      <Text size="caption" dimColor>{modeLabel(v)}</Text>
      {pressure(el, v, acts)}
      {summary}
      <Box flexDirection="column" gap={1}>
        <Box alignItems="center">
          <Text size="caption" weight="semibold" dimColor>WHAT'S USING IT</Text>
          <Box flexGrow={1} />
          {!sel && top && <Button key="drop" plain label="What can I drop?" onPress={acts[`wi:${top.key}`]!} />}
        </Box>
        {list}
        <Text size="caption" dimColor>
          {[free ? `Free ${fk(free.tokens)}` : '', buffer ? `autocompact buffer ${fk(buffer.tokens)}` : ''].filter(Boolean).join(' · ')}
        </Text>
        {deferred.length > 0 && (
          <Text size="caption" dimColor>
            Loaded only when used: {deferred.map(c => `${fk(c.tokens)} ${c.name.replace(/ \(deferred\)$/, '')}`).join(' · ')}
          </Text>
        )}
      </Box>
      <Box alignItems="center" gap={1}>
        <Text dimColor>{carryText(v)}</Text>
        <Box flexGrow={1} />
        {!v.offer && <Button key="compact" label="Compact now" variant="secondary" onPress={acts.compact!} />}
      </Box>
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
  return (
    <Box flexDirection="column">
    <Box key="band" gap={2} alignItems="center">
      <Button key="open" label="Context Lens" onPress={acts.open!} />
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
      {v.state !== 'normal' && <Button key="compact" label="Compact now" onPress={acts.compact!} />}
      <Button key="hide" plain dimColor label="Hide" onPress={acts.hide!} />
    </Box>
    </Box>
  )
}
