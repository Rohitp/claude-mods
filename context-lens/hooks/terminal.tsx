// Terminal surface: the Context Lens band and pane, laid out on the character grid.
import type { Elements } from 'claude-code'

import { S, fit, fk, fk1, hbar, lr, padL, padR, prio, wrap } from './layout'
import type { Item, Seg } from './layout'
import { WRITE, usd, whatIf } from './model'
import { PALETTE, colorOf } from './svg'
import type { View } from './model'
import type { Cat, Point, Tab } from '../types'

export type Acts = Record<string, () => void>
type El = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

const bracket = (label: string, act: string): Seg => S(`[ ${label} ]`, 'accent b', { act, primary: true })

const SHORT: Record<string, string> = {
  'MCP tools': 'MCP',
  'Memory files': 'Memory',
  'System tools': 'Tools',
  'System prompt': 'System',
  'Custom agents': 'Agents',
}
const short = (n: string): string => SHORT[n] ?? n
const clip = (t: string, n: number): string => ([...t].length > n ? `${[...t].slice(0, n - 1).join('')}…` : t)
const roleOf = (v: View): string => (v.state === 'warn' ? 'warn' : v.state === 'crit' ? 'err' : 'fg')

// ---- stacked bar -----------------------------------------------------------------------
/** `n` cells split by largest remainder: used categories in their colours, then free, then buffer. */
export function bar(cats: Cat[], n: number): Seg[] {
  const parts = cats
    .filter(c => c.kind !== 'deferred' && c.tokens > 0)
    .map(c => ({ v: c.tokens, ch: c.kind === 'free' ? '░' : c.kind === 'buffer' ? '▒' : '█', c: c.kind === 'used' ? colorOf(c.name) : undefined, r: c.kind === 'free' ? 'free' : c.kind === 'buffer' ? 'buf' : undefined }))
  const sum = parts.reduce((a, p) => a + p.v, 0)
  if (sum <= 0 || n <= 0) return [S('░'.repeat(Math.max(0, n)), 'free')]
  const raw = parts.map(p => (p.v / sum) * n)
  const fl = raw.map(Math.floor)
  const rem = n - fl.reduce((a, b) => a + b, 0)
  raw
    .map((x, i) => [x - Math.floor(x), i] as const)
    .sort((a, b) => b[0] - a[0])
    .slice(0, rem)
    .forEach(([, i]) => {
      fl[i] = fl[i]! + 1
    })
  return parts
    .map((p, i) => ({ ...S(p.ch.repeat(fl[i]!), p.r ?? 'fg'), c: p.c }))
    .filter(s => s.t)
}

// ---- the one-row band ------------------------------------------------------------------
export function ctxBand(v: View, w: number): Seg[] {
  const l = v.lens
  if (!l || v.state === 'empty') {
    return [S('ctx ', 'dim'), S('▕' + '░'.repeat(8) + '▏', 'free'), S(' — send a prompt to start measuring', 'dim')]
  }
  const bw = w >= 130 ? 20 : w >= 100 ? 14 : 8
  const used = l.cats.filter(c => c.kind === 'used' && c.tokens > 0).sort((a, b) => b.tokens - a.tokens)
  const top = (i: number): Item | null => {
    const c = used[i]
    return c ? { p: [3, 5, 7][i]!, segs: [S('■ ', 'fg', { c: colorOf(c.name) }), S(`${short(c.name)} `, 'fg'), S(fk(c.tokens), 'dim')] } : null
  }
  const items: Item[] = [
    { p: 0, segs: [S('ctx', 'dim')] },
    { p: 2, tight: true, segs: [S('▕', 'dim'), ...bar(l.cats, bw), S('▏', 'dim')] },
    { p: 0, tight: true, segs: [S(`${v.percent}%`, `${roleOf(v)} b`)] },
  ]
  if (v.state === 'warn') {
    items.push({ p: 0, segs: [S(v.turnsLeft !== null ? `~${Math.max(1, Math.round(v.turnsLeft))} turns to autocompact` : 'past 80%', 'warn')] })
  }
  if (v.state === 'crit') items.push({ p: 0, segs: [S('autocompacts next turn', 'err')] })
  items.push({ p: 6, segs: [S(`${fk(l.total)}/${fk(l.window)}`, 'dim')] })
  for (let i = 0; i < 3; i++) {
    const t = top(i)
    if (t) items.push(t)
  }
  items.push({
    p: 4,
    segs:
      v.mode === 'api' && v.carry !== null
        ? [S('carry ', 'dim'), S(`~${usd(v.carry)}/turn`, 'fg'), S(' est.', 'dim')]
        : v.mode === 'sub'
          ? l.limitPct !== null
            ? [S('5h window ', 'dim'), S(`${l.limitPct}%`, 'fg')]
            : [S(`re-read at ${v.read}x each turn`, 'dim')]
          : [S(`carry ${fk(l.total)}/turn · prices unknown`, 'dim')],
  })
  if (v.state === 'normal' && v.thresholdPct) items.push({ p: 9, segs: [S(`compacts at ${v.thresholdPct}%`, 'dim')] })

  const right: Seg[] =
    v.state === 'normal' || v.offer ? (w >= 100 ? [S('lens', 'accent', { act: 'open' })] : []) : [bracket('Compact now', 'compact')]
  const rw = right.reduce((n, s) => n + [...s.t].length, 0)
  const left = prio(items, w - rw - 2)
  return right.length ? lr(left, right, w) : left
}

/** The offer row above the band: what compacting frees, what it saves, and an easy no. */
export function ctxOffer(v: View, w: number): Seg[] | null {
  const o = v.offer
  if (!o) return null
  const right: Seg[] = [bracket('Compact now', 'compact'), S(' '), S('[ Not now ]', 'dim', { act: 'snooze' })]
  const rw = right.reduce((n, s) => n + [...s.t].length, 0)
  const items: Item[] = [
    { p: 0, segs: [S(`Compact to free ~${fk(o.frees)} tokens`, 'warn b'), S(' est.', 'dim')] },
    { p: 3, segs: [S(o.savesPerTurn !== null ? `~${usd(o.savesPerTurn)} less per turn` : `${Math.round(o.pctWindow)}% of the window`, 'fg')] },
    { p: 5, segs: [S('keeps a summary; you choose what is kept', 'dim')] },
  ]
  return lr(prio(items, w - rw - 2), right, w)
}

// ---- the pane --------------------------------------------------------------------------
export type PaneState = { tab: Tab; open: string[]; whatIf: string; history: Point[] }
const TABS: { id: Tab; label: string }[] = [
  { id: 'category', label: 'Category' },
  { id: 'items', label: 'Items' },
  { id: 'whatif', label: 'What-if' },
  { id: 'trend', label: 'Trend' },
]
const modeLabel = (v: View): string => (v.mode === 'api' ? 'API · est.' : v.mode === 'sub' ? 'subscription' : 'prices unknown')

function carryLines(v: View): Seg[][] {
  const l = v.lens!
  if (v.mode === 'api' && v.carry !== null) {
    return [[S('Carrying ', 'dim'), S(fk(l.total), 'fg'), S(' costs ', 'dim'), S(`~${usd(v.carry)}/turn`, 'fg'), S(' est.', 'dim')]]
  }
  if (v.mode === 'sub') {
    const o = [[S('Carrying ', 'dim'), S(fk(l.total), 'fg'), S(` re-reads at ${v.read}x every turn`, 'dim')]]
    if (l.limitPct !== null) o.push([S('5h window ', 'dim'), S(`${l.limitPct}%`, 'fg'), S(' used', 'dim')])
    return o
  }
  return [
    [S('Carrying ', 'dim'), S(fk(l.total), 'fg'), S(` re-reads at ${v.read}x every turn`, 'dim')],
    [S('Prices unknown for this model · tokens only', 'dim')],
  ]
}

export function ctxPane(v: View, st: PaneState, iw: number): Seg[][] {
  return paneLines(v, st, iw).map(x => fit(x, iw))
}

function paneLines(v: View, st: PaneState, iw: number): Seg[][] {
  const l = v.lens
  const b: Seg[][] = []
  const tabs: Seg[] = []
  TABS.forEach(t =>
    tabs.push(
      t.id === st.tab
        ? S(`[ ${t.label} ]`, 'accent b', { act: `tab:${t.id}`, primary: true })
        : S(` ${t.label} `, 'fg', { act: `tab:${t.id}` }),
    ),
  )
  b.push(lr([S('Context Lens', 'fg b')], [S(modeLabel(v), 'dim')], iw))
  b.push(tabs, [S('─'.repeat(iw), 'line')])

  if (!l || v.state === 'empty') {
    b.push([S('0 of —', 'dim')], [S('░'.repeat(iw), 'free')], [], [S('No turns yet.', 'fg b')])
    b.push(...wrap('Send a prompt to start measuring. Categories, items and the trend fill in after the first response.', iw, 'dim'))
    return b
  }

  b.push(
    lr(
      [S(fk(l.total), 'fg b'), S(` of ${fk(l.window)}  `, 'dim'), S(`${v.percent}%`, `${roleOf(v)} b`)],
      v.thresholdPct ? [S(`autocompact at ${v.thresholdPct}%`, 'dim')] : [],
      iw,
    ),
  )
  b.push(bar(l.cats, iw), [])

  if (st.tab === 'category') {
    const rows = l.cats.filter(c => c.kind === 'used' && c.tokens > 0).sort((a, c) => c.tokens - a.tokens)
    const mx = rows[0]?.tokens ?? 1
    const nW = Math.max(12, Math.min(24, iw - 4 - 8 - 7 - 1 - 10))
    const bw = iw - 4 - nW - 8 - 7 - 1
    rows.forEach((c, i) => {
      const row: Seg[] = [S(' ■ ', 'fg', { c: colorOf(c.name) }), S(padR(clip(short(c.name), nW), nW), i === 0 ? 'fg b' : 'fg'), S(padL(fk1(c.tokens), 8), 'fg'), S(padL(`${((c.tokens / l.window) * 100).toFixed(1)}%`, 7), 'dim')]
      if (bw >= 6) row.push(S(' '), { ...S(hbar(c.tokens / mx, bw), 'fg'), c: colorOf(c.name) })
      b.push(row)
    })
    for (const c of l.cats.filter(c => c.kind === 'free' || c.kind === 'buffer')) {
      b.push([S(c.kind === 'free' ? '  ░ ' : '  ▒ ', c.kind === 'free' ? 'free' : 'buf'), S(padR(c.kind === 'buffer' && iw < 50 ? 'Autocompact buf' : c.name, nW), 'dim'), S(padL(fk1(c.tokens), 8), 'dim')])
    }
    b.push([])
    if (v.state !== 'normal') {
      b.push(
        ...wrap(
          v.state === 'warn'
            ? `${v.turnsLeft !== null ? `About ${Math.max(1, Math.round(v.turnsLeft))} turns until autocompact at this pace. ` : ''}Compacting yourself lets you choose what is kept.`
            : 'Autocompact runs on the next turn. Compact now to choose what is kept.',
          iw,
          'fg',
        ),
      )
      b.push([bracket('Compact now', 'compact')], [])
    }
    b.push(...carryLines(v))
  }

  if (st.tab === 'items') {
    const isOpen = (k: string) => st.open.includes(k)
    const head = (k: string, name: string, meta: string, tokens: number): Seg[] =>
      lr([S(`${isOpen(k) ? '▾' : '▸'} ${name}`, 'fg b', { act: `grp:${k}` }), S(meta ? `  ${meta}` : '', 'dim')], [S(fk1(tokens), 'fg')], iw)
    const child = (label: string, meta: string, tokens: number, key?: string): Seg[] =>
      lr([S(`    ${label}`, 'fg'), S(meta ? `  ${meta}` : '', 'dim')], [S(key ? 'what-if ' : '', 'accent', key ? { act: `wi:${key}` } : {}), S(fk1(tokens), 'fg')], iw)
    const sum = (a: { tokens: number }[]) => a.reduce((n, x) => n + x.tokens, 0)
    b.push(head('mcp', 'MCP tools', `${l.servers.length} server${l.servers.length === 1 ? '' : 's'}`, sum(l.servers)))
    if (isOpen('mcp')) {
      l.servers.forEach(s =>
        b.push(child(s.label, `${s.tools} tools${s.deferred > 0 ? ` · ${s.deferred} on demand` : ''}`, s.tokens, s.tokens > 0 ? `mcp:${s.label}` : undefined)),
      )
    }
    b.push(head('mem', 'Memory files', `${l.memory.length} file${l.memory.length === 1 ? '' : 's'}`, sum(l.memory)))
    if (isOpen('mem')) l.memory.forEach(m => b.push(child(m.label, '', m.tokens, `Memory file:${m.label}`)))
    b.push(head('skl', 'Skills', String(l.skills.length), sum(l.skills)))
    if (isOpen('skl')) l.skills.slice(0, 8).forEach(s => b.push(child(s.label, '', s.tokens)))
    b.push(head('agt', 'Agents', String(l.agents.length), sum(l.agents)))
    if (isOpen('agt')) l.agents.forEach(s => b.push(child(s.label, '', s.tokens)))
    const msg = sum(l.sources)
    b.push(head('msg', 'Messages by source', '', msg))
    if (isOpen('msg')) l.sources.forEach(s => b.push(child(s.label, `${Math.round((s.tokens / Math.max(1, msg)) * 100)}%`, s.tokens)))
  }

  if (st.tab === 'whatif') {
    const cands = v.candidates
    if (cands.length === 0) {
      b.push([S('Nothing removable found.', 'dim')])
      return b
    }
    const idx = Math.max(0, cands.findIndex(c => c.key === st.whatIf))
    const c = cands[idx]!
    const w = whatIf(v, c)!
    const kv = (k: string, segs: Seg[]): Seg[] => [S(padR(k, 18), 'dim'), ...segs]
    const prev = cands[(idx + cands.length - 1) % cands.length]!
    const next = cands[(idx + 1) % cands.length]!
    b.push(
      lr(
        [S('Remove  ', 'dim'), S('‹ ', 'accent', { act: `wi:${prev.key}` }), S(c.label, 'fg b'), S(` · ${c.kind}`, 'dim'), S(' ›', 'accent', { act: `wi:${next.key}` })],
        [],
        iw,
      ),
    )
    b.push([])
    b.push(kv('Frees', [S(fk1(w.frees), 'fg b'), S(` · ${w.pctWindow.toFixed(1)}% of window`, 'dim')]))
    b.push(
      kv(
        'Saves per turn',
        w.savesPerTurn !== null
          ? [S(`~${usd(w.savesPerTurn)}`, 'fg'), S(' est.', 'dim')]
          : [S(fk1(w.frees), 'fg'), S(' fewer cached tokens read', 'dim')],
      ),
    )
    b.push(
      kv(
        'One-time rebuild',
        w.isCold
          ? [S('nothing extra', 'ok'), S(' · cache is cold', 'dim')]
          : w.rebuild !== null
            ? [S(`+${usd(w.rebuild)}`, 'fg'), S(' est.', 'dim')]
            : [S(`${fk(l.total - c.tokens)} at ${WRITE}x`, 'fg')],
      ),
    )
    b.push(kv('Pays back after', w.isCold ? [S('immediately', 'ok b')] : [S(`~${w.turns} turns`, 'fg b'), S(' est.', 'dim')]))
    b.push([])
    b.push(
      ...wrap(
        w.isCold
          ? `The cache looks cold, so the next turn rebuilds the prefix anyway. Removing ${c.label} now costs nothing extra.`
          : `The cache is warm, so removing ${c.label} now forces a one-time rebuild. It's cheapest when the cache is cold or at the start of a session.`,
        iw,
        'fg',
      ),
    )
    b.push([], ...wrap('To remove it, disable it in /mcp or your memory settings; this view only estimates.', iw, 'dim'))
    if (iw >= 40 && cands.length > 1) {
      b.push([])
      b.push(lr([S('Other candidates', 'fg b')], [S(padL('frees', 7), 'dim'), S(padL('pays back', 12), 'dim')], iw))
      cands
        .filter(x => x.key !== c.key)
        .slice(0, 3)
        .forEach(x => {
          const o = whatIf(v, x)!
          b.push(lr([S(`  ${x.label}`, 'fg', { act: `wi:${x.key}` })], [S(padL(fk1(x.tokens), 7), 'fg'), S(padL(o.isCold ? 'now' : `~${o.turns}`, 12), 'dim')], iw))
        })
    }
  }

  if (st.tab === 'trend') {
    const series = st.history
    if (series.length < 2) {
      b.push([S('Not enough turns yet.', 'dim')])
      return b
    }
    const n = Math.min(series.length, iw - 6)
    const pts = series.slice(series.length - n)
    const H = 8
    const msgC = PALETTE.messages
    const ovC = PALETTE.mcp
    const thr = v.thresholdPct ?? 92
    for (let r = 0; r < H; r++) {
      const hi = 100 - (100 / H) * r
      const lo = hi - 100 / H
      const row: Seg[] = [S(r === 0 ? '100% ' : r === 4 ? ' 50% ' : r === 7 ? '  0% ' : '     ', 'dim'), S('┤', 'line')]
      pts.forEach(p => {
        const val = (p.total / l.window) * 100
        const ov = (p.overhead / l.window) * 100
        const isThr = thr <= hi && thr > lo
        if (val >= hi) row.push({ ...S('█', 'fg'), c: (hi + lo) / 2 <= ov ? ovC : msgC })
        else if (val > lo) {
          const ix = Math.floor(((val - lo) / (100 / H)) * 8)
          row.push(ix > 0 ? { ...S(' ▁▂▃▄▅▆▇'[ix]!, 'fg'), c: val - lo <= Math.max(0, ov - lo) ? ovC : msgC } : isThr ? S('┄', 'warn') : S(' '))
        } else row.push(isThr ? S('┄', 'warn') : S(' '))
      })
      b.push(row)
    }
    b.push([S(`     └${'─'.repeat(n)}`, 'line')])
    const comp = pts.findIndex(p => p.isCompaction)
    if (comp >= 0) b.push([S(`${' '.repeat(6 + comp)}▲ compacted at turn ${pts[comp]!.n}`, 'dim')])
    b.push([S('█', 'fg', { c: msgC }), S(' messages  ', 'dim'), S('█', 'fg', { c: ovC }), S(` overhead ${fk(l.overhead)}  `, 'dim'), S('┄', 'warn'), S(` ${thr}%`, 'dim')])
    b.push([])
    if (v.growth !== null) {
      b.push([S(`+${fk(Math.max(0, v.growth))}/turn`, 'fg b'), S(` average, last ${Math.min(10, series.length - 1)} turns`, 'dim')])
      if (v.turnsLeft !== null) {
        b.push(
          v.turnsLeft < 1
            ? [S('Autocompacts next turn', v.state === 'crit' ? 'err b' : 'fg b'), S(' at this pace', 'dim')]
            : [S(`~${Math.round(v.turnsLeft)} turns`, `${roleOf(v)} b`), S(' to autocompact (est.)', 'dim')],
        )
      }
    }
    const first = pts[0]!.total
    b.push(
      v.mode === 'api' && v.carry !== null
        ? [S('Carry cost grew ', 'dim'), S(`~${usd((first / l.total) * v.carry)} → ~${usd(v.carry)}/turn`, 'fg'), S(' est.', 'dim')]
        : [S('Cached re-read grew ', 'dim'), S(`${fk(first)} → ${fk(l.total)}/turn`, 'fg')],
    )
  }
  b.push([], [S('Click a tab, or Tab then Enter. Esc closes.', 'dim')])
  return b
}

// ---- drawing ---------------------------------------------------------------------------
const noop = (): void => {}
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
          s.primary ? (
            <Button key={`${key}.${i}`} label={s.t.slice(2, -2)} variant="primary" onPress={acts[s.act] ?? noop} />
          ) : (
            <Button key={`${key}.${i}`} label={s.t} plain onPress={acts[s.act] ?? noop} />
          )
        ) : (
          <Text key={`${key}.${i}`} {...styleOf(s)}>{s.t}</Text>
        ),
      )}
    </Box>
  )
}
