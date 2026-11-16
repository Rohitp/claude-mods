import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BandMode, Card, Cat, Lens, Named, Point, Server, Tab } from '../types'
import { fit } from './layout'
import { ctxBandDesktop, ctxPaneDesktop } from './desktop'
import type { DesktopEl } from './desktop'
import { formatLine } from './log'
import type { Field, Level } from './log'
import { BIG_RESULT, cardFor, crossesCold, derive, sanitizeHistory, sanitizeLens, shouldShowBand, spinnerNote } from './model'
import { ctxCard, withResultNote } from './card'
import type { CardEl } from './card'
import { bump, emptyStats, note, sanitizeStats, summarize } from './stats'
import type { Stats } from './stats'
import type { View } from './model'
import { ctxBand, ctxPane, row } from './terminal'
import type { Acts } from './terminal'

const PANE = 'context-lens'
const lensAtom = atom({ plugin: 'context-lens', key: 'lens' } as const, null)
const bandAtom = atom({ plugin: 'context-lens', key: 'band' } as const, 'auto' as BandMode)
const bigAtom = atom({ plugin: 'context-lens', key: 'bigResults' } as const, {} as Record<string, number>)
const cardsAtom = atom({ plugin: 'context-lens', key: 'cards' } as const, [] as Card[])
const cardLevelAtom = atom({ plugin: 'context-lens', key: 'cardLevel' } as const, 0)
const tabAtom = atom({ plugin: 'context-lens', key: 'tab' } as const, 'category')
const historyAtom = atom({ plugin: 'context-lens', key: 'history' } as const, [])
const whatIfAtom = atom({ plugin: 'context-lens', key: 'whatIf' } as const, '')
const openAtom = atom({ plugin: 'context-lens', key: 'open' } as const, ['mcp', 'mem', 'msg'])
const lastTurnAtom = atom({ plugin: 'context-lens', key: 'lastTurnAt' } as const, 0)
const nowAtom = atom({ plugin: 'context-lens', key: 'now' } as const, 0)
const snoozeAtom = atom({ plugin: 'context-lens', key: 'snoozeAt' } as const, 0)

const TABS: Tab[] = ['category', 'items', 'whatif', 'trend']
const GROUPS = ['mcp', 'mem', 'skl', 'agt', 'msg']
const base = (path: string): string => path.split('/').slice(-2).join('/')

const PLUGIN = 'context-lens'
const STORE_KEY = 'stats'
const FLUSH_MS = 15_000

// Local metrics, kept in memory and flushed to the mod's own store. Never sent anywhere.
let isTracking = true
let stats: Stats = emptyStats(0)
let isDirty = false
let lastFlushAt = 0
const reported = new Set<string>()

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

// Where the Messages tokens came from. Estimated from text length, then scaled so the groups
// add up to the breakdown's own Messages row.
async function messageSources($: EngineInterface, target: number): Promise<{ list: Named[]; scale: number }> {
  const rows = await $.session.messages()
  const toolOf = new Map<string, string>()
  const sums = new Map<string, number>()
  const perResult: [string, number][] = []
  const add = (k: string, chars: number) => sums.set(k, (sums.get(k) ?? 0) + chars)
  const label = (tool: string): string => {
    const m = /^mcp__(.+?)__/.exec(tool)
    return m ? 'MCP-server results' : /^(Read|Grep|Glob)$/.test(tool) ? 'Read results' : /^Bash/.test(tool) ? 'Bash results' : `${tool} results`
  }
  for (const m of rows) {
    add(m.role === 'user' ? 'Your prompts' : 'Assistant text', m.text.length)
    for (const u of m.toolUses ?? []) {
      toolOf.set(u.tool_use_id, label(u.tool))
      add('Tool-call inputs', JSON.stringify(u.input ?? {}).length)
    }
    for (const r of m.toolResults ?? []) {
      add(toolOf.get(r.tool_use_id) ?? 'Other results', r.text.length)
      perResult.push([r.tool_use_id, r.text.length])
    }
  }
  const all = [...sums.entries()].map(([k, chars]) => ({ k, est: Math.ceil(chars / 4) }))
  const sum = all.reduce((a, x) => a + x.est, 0)
  const scale = target > 0 && sum > 0 ? target / sum : 1
  const list = all
    .map(x => ({ label: x.k, tokens: Math.round(x.est * scale) }))
    .filter(x => x.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
  bigResults = {}
  for (const [id, chars] of perResult) {
    const tokens = Math.round(Math.ceil(chars / 4) * scale)
    if (tokens >= BIG_RESULT) bigResults[id] = tokens
  }
  return { list, scale: target > 0 && sum > 0 ? target / sum : 0 }
}

// Big tool results found by the last measure, written to state by refresh.
let bigResults: Record<string, number> = {}

async function measure($: EngineInterface): Promise<Lens | null> {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const b = usage.context.breakdown
  if (!b) return null

  const cats: Cat[] = b.categories.map(c => ({ name: c.name, tokens: c.tokens, color: c.color, kind: c.kind }))
  const msgRow = cats.find(c => c.kind === 'used' && /message/i.test(c.name))
  const byServer = new Map<string, { tokens: number; tools: number; deferred: number }>()
  for (const t of b.mcpTools) {
    const s = byServer.get(t.serverName) ?? { tokens: 0, tools: 0, deferred: 0 }
    byServer.set(t.serverName, {
      tokens: s.tokens + (t.isLoaded ? t.tokens : 0),
      tools: s.tools + 1,
      deferred: s.deferred + (t.isLoaded ? 0 : 1),
    })
  }
  const servers: Server[] = [...byServer.entries()]
    .map(([label, s]) => ({ label, tokens: s.tokens, tools: s.tools, deferred: s.deferred }))
    .sort((x, y) => y.tokens - x.tokens || y.tools - x.tools)
  const w = usage.rateLimits.find(l => l.kind === 'five_hour') ?? usage.rateLimits[0]
  const total = b.totalTokens
  const src = await messageSources($, msgRow?.tokens ?? 0)
  // How far the text-length estimate was from the engine's own Messages figure (x1000, a counter).
  if (src.scale > 0) {
    count('est.n')
    count('est.scale', Math.round(src.scale * 1000))
  }

  return {
    cats,
    total,
    max: b.rawMaxTokens,
    window: usage.context.window || b.rawMaxTokens,
    model: b.model,
    autoCompactAt: b.autoCompactThreshold ?? null,
    servers,
    memory: b.memoryFiles.map(f => ({ label: base(f.path), tokens: f.tokens })).sort((x, y) => y.tokens - x.tokens),
    skills: (b.skills?.skillFrontmatter ?? []).map(s => ({ label: s.name, tokens: s.tokens })).sort((x, y) => y.tokens - x.tokens),
    agents: b.agents.map(a => ({ label: a.agentType, tokens: a.tokens })).sort((x, y) => y.tokens - x.tokens),
    sources: src.list,
    overhead: Math.max(0, total - (msgRow?.tokens ?? 0)),
    billing: usage.rateLimits.length > 0 ? 'sub' : 'api',
    limitPct: w ? Math.round(w.percentUsed) : null,
  }
}

async function refresh($: EngineInterface) {
  const t0 = await $.clock.now()
  let lens: Lens | null = null
  try {
    lens = await measure($)
  } catch (err) {
    count('measure.error')
    log($, 'error', 'measure.threw', { name: err instanceof Error ? err.name : 'unknown' })
    return
  }
  if (!lens) {
    count('measure.empty')
    log($, 'debug', 'measure.empty')
    return
  }
  const ms = (await $.clock.now()) - t0
  count('measure.ok')
  count('measure.ms', ms)
  log($, 'debug', 'measure', { total: lens.total, window: lens.window, model: lens.model, billing: lens.billing, ms })
  await update($, lensAtom, () => lens)
  const big = bigResults
  // Results keep their ids across turns; the newest 200 are plenty for what is on screen.
  await update($, bigAtom, old => Object.fromEntries(Object.entries({ ...(old ?? {}), ...big }).slice(-200)))
  let compacted = false
  await update($, historyAtom, (old: unknown) => {
    const h = sanitizeHistory(old)
    const prev = h[h.length - 1]
    const point: Point = {
      total: lens.total,
      overhead: lens.overhead,
      isCompaction: !!prev && lens.total < prev.total * 0.7,
      n: (prev?.n ?? 0) + 1,
    }
    if (point.isCompaction) {
      compacted = true
      void update($, snoozeAtom, () => 0)
      count('compaction')
      log($, 'info', 'compaction', { from: prev?.total ?? 0, to: lens.total })
    }
    return [...h, point].slice(-60)
  })
  if (compacted) {
    await update($, cardLevelAtom, () => 0)
    await update($, cardsAtom, cs => (cs ?? []).map(c => (c.status === 'open' ? { ...c, status: 'compacted' as const } : c)))
  }
}

/** Places a card in the transcript the first time the context crosses each level. */
async function placeCard($: EngineInterface) {
  const v = await view($)
  const placed = await read($, cardLevelAtom)
  const cards = await read($, cardsAtom)
  const card = cardFor(v, placed, `ctx-${cards.length + 1}`)
  if (!card) return
  await update($, cardLevelAtom, () => card.level)
  await update($, cardsAtom, cs => [...(cs ?? []), card].slice(-20))
  try {
    await $.ui.place({ id: card.id })
    count(`card.${card.level}`)
    log($, 'info', 'card.place', { level: card.level, percent: card.percent })
  } catch (err) {
    log($, 'error', 'card.place', { name: err instanceof Error ? err.name : 'unknown' })
  }
}

async function view($: EngineInterface): Promise<View> {
  const rawLens = await read($, lensAtom)
  const lens = sanitizeLens(rawLens)
  if (rawLens && !lens && !reported.has('state.repaired')) {
    reported.add('state.repaired')
    count('state.repaired')
    log($, 'warn', 'state.repaired', { what: 'lens' })
  }
  const h = sanitizeHistory(await read($, historyAtom))
  const now = (await read($, nowAtom)) || (await $.clock.now())
  return derive(lens, h, now, await read($, lastTurnAtom), await read($, snoozeAtom))
}

async function tickNow($: EngineInterface) {
  const now = await $.clock.now()
  const before = await read($, nowAtom)
  // Writing the atom redraws the pane and band; only do it when the cold flag can change.
  if (!before || crossesCold(before, now, await read($, lastTurnAtom))) await update($, nowAtom, () => now)
  await flush($)
}

let timer: { cancel: () => void } | null = null

/** Opens the pane unasked when the `openOnStart` option says so. A reload finds it already up
 *  and leaves it alone; the engine keeps an unasked pane undrawn where it would not be a
 *  sidebar (a narrow terminal), so this never takes over the screen. */
async function openAtStart($: EngineInterface, how: 'widget' | 'pane'): Promise<void> {
  try {
    if ((await $.ui.panes()).some(p => p.id === PANE)) return
    const r = await $.ui.open({ id: PANE, title: 'Context Lens', ...(how === 'widget' ? { placement: 'widget' as const } : {}) })
    log($, 'info', 'open.start', { how, placed: r.isPlaced })
  } catch (err) {
    log($, 'error', 'open.start', { name: err instanceof Error ? err.name : 'unknown' })
  }
}

export const register: Register = (on, options) => {
  isTracking = (options as Record<string, unknown>)?.metrics !== false
  const openOnStart = (options as Record<string, unknown>)?.openOnStart

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'ctx', description: 'Context Lens: what fills the window; `band` toggles the band, `stats` shows metrics' })
    stats = isTracking ? sanitizeStats(await $.store.get(STORE_KEY), await $.clock.now()) : emptyStats(await $.clock.now())
    log($, 'info', 'start', { metrics: isTracking })
    timer?.cancel()
    timer = $.clock.every(10_000, () => void tickNow($))
    // A reload keeps the old state; measure again so the band is current at once.
    try {
      await refresh($)
    } catch {
      // no response in the live window yet
    }
    if (openOnStart === 'widget' || openOnStart === 'pane') await openAtStart($, openOnStart)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await flush($, true)
    return next(e)
  })

  on('command.run', { command: 'ctx' }, async ($, e) => {
    if (e.args.trim() === 'stats') {
      if (!isTracking) return { text: 'Metrics are off (the `metrics` option is false).' }
      return { text: ['Context Lens metrics (local only, never sent):', ...summarize(stats, await $.clock.now())].join('\n') }
    }
    if (e.args.trim() === 'stats reset') {
      stats = emptyStats(await $.clock.now())
      isDirty = true
      await flush($, true)
      return { text: 'Context Lens metrics reset.' }
    }
    const bandArg = /^band(?:\s+(on|off|auto))?$/.exec(e.args.trim())
    if (bandArg) {
      const now = await read($, bandAtom)
      const mode: BandMode = (bandArg[1] as BandMode | undefined) ?? (now === 'on' ? 'auto' : 'on')
      await update($, bandAtom, () => mode)
      return {
        text:
          mode === 'on' ? 'Context band always on. `/ctx band auto` shows it only near autocompact.'
          : mode === 'off' ? 'Context band off. `/ctx band auto` brings it back near autocompact.'
          : 'Context band shows only near autocompact. `/ctx band on` keeps it up.',
      }
    }
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Context Lens' })
    return { text: 'Context Lens opened. `/ctx band on|off|auto` sets when the one-line band shows.' }
  })

  // After every turn. The summary breakdown is a local estimate and costs no request.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      await refresh($)
      await placeCard($)
    }
    return next(e)
  })

  // Judges whether the cache is cold for the What-if copy.
  on('turn.step', async function* ($, e, next) {
    const at = await $.clock.now()
    const r = yield* next(e)
    if (!e.agentId) await update($, lastTurnAtom, () => at)
    return r
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    try {
      const v = await view($)
      const acts: Acts = {
        open: () => void $.ui.open({ id: PANE, title: 'Context Lens' }),
        compact: () => {
          count('compact.click')
          log($, 'info', 'compact.click', { via: 'pane', state: v.state })
          void $.session.compact()
        },
        snooze: () => {
          count('offer.snooze')
          log($, 'info', 'offer.snooze', { via: 'pane', total: v.lens?.total ?? 0 })
          return update($, snoozeAtom, () => v.lens?.total ?? 0)
        },
        keep: () => update($, whatIfAtom, () => ''),
      }
      for (const t of TABS) {
        acts[`tab:${t}`] = () => {
          count(`tab.${t}`)
          return update($, tabAtom, () => t)
        }
      }
      for (const g of GROUPS) {
        acts[`grp:${g}`] = () => update($, openAtom, o => (o.includes(g) ? o.filter(x => x !== g) : [...o, g]))
      }
      for (const c of v.candidates) {
        acts[`wi:${c.key}`] = async () => {
          count('whatif.pick')
          await update($, whatIfAtom, () => c.key)
          await update($, tabAtom, () => 'whatif')
        }
      }
      const st = {
        tab: await read($, tabAtom),
        open: await read($, openAtom),
        whatIf: await read($, whatIfAtom),
        history: sanitizeHistory(await read($, historyAtom)),
      }
      if (e.surface !== 'terminal') return ctxPaneDesktop($.ui.resolve(e) as DesktopEl, v, st, acts, e.props.placement)
      const lines = ctxPane(v, st, Math.max(20, e.props.bodyColumns))
      return <el.Box flexDirection="column">{lines.map((l, i) => row(el, l, acts, `r${i}`))}</el.Box>
    } catch (err) {
      count('render.error')
      log($, 'error', 'render.pane', { name: err instanceof Error ? err.name : 'unknown', msg: err instanceof Error ? err.message : '' })
      return <el.Text dimColor>Context Lens could not draw. See claude --debug.</el.Text>
    }
  })

  // Drawn below whatever the plugins beneath draw (the cache band), because the engine shows
  // one tree per site.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    try {
      const el = $.ui.resolve(e)
      const v = await view($)
      if (!shouldShowBand(await read($, bandAtom), v)) return next(e)
      const acts: Acts = {
        open: () => void $.ui.open({ id: PANE, title: 'Context Lens' }),
        compact: () => {
          count('compact.click')
          log($, 'info', 'compact.click', { via: 'band', state: v.state })
          void $.session.compact()
        },
        snooze: () => {
          count('offer.snooze')
          log($, 'info', 'offer.snooze', { total: v.lens?.total ?? 0 })
          return update($, snoozeAtom, () => v.lens?.total ?? 0)
        },
        hide: async () => {
          count('band.hide')
          await update($, bandAtom, () => 'off' as const)
          $.ui.toast('Context band off. /ctx band auto brings it back near autocompact.')
        },
      }
      const below = await next(e)
      const own =
        e.surface !== 'terminal'
          ? ctxBandDesktop($.ui.resolve(e) as DesktopEl, v, acts)
          : row(el, fit(ctxBand(v, Math.max(20, e.props.bodyColumns)), Math.max(20, e.props.bodyColumns)), acts, 'band')
      return <el.Box flexDirection="column">{below}{own}</el.Box>
    } catch (err) {
      count('render.error')
      log($, 'error', 'render.band', { name: err instanceof Error ? err.name : 'unknown', msg: err instanceof Error ? err.message : '' })
      return next(e)
    }
  })

  // The card placed when the context crossed a level. Only the newest card still asks.
  on('ui.render', { component: 'Placed' }, async ($, e, next) => {
    if (e.props.plugin !== PLUGIN) return next(e)
    const el = $.ui.resolve(e)
    try {
      const cards = await read($, cardsAtom)
      const c = cards.find(x => x.id === e.props.id)
      if (!c) return next(e)
      const isLive = c.id === cards[cards.length - 1]?.id
      const v = await view($)
      const acts: Acts = {
        compact: () => {
          count('compact.click')
          log($, 'info', 'compact.click', { via: 'card', level: c.level })
          void $.session.compact()
        },
        snooze: async () => {
          count('card.snooze')
          await update($, cardsAtom, cs => (cs ?? []).map(x => (x.id === c.id ? { ...x, status: 'snoozed' as const } : x)))
          await update($, snoozeAtom, () => v.lens?.total ?? c.total)
        },
      }
      return ctxCard(el as CardEl, c, isLive, acts)
    } catch (err) {
      count('render.error')
      log($, 'error', 'render.card', { name: err instanceof Error ? err.name : 'unknown' })
      return next(e)
    }
  })

  // How full the context is, on the working line, once it matters.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    try {
      const note = spinnerNote(await view($))
      if (!note) return next(e)
      return next({ ...e, props: { ...e.props, suffix: `${e.props.suffix}${note}` } })
    } catch {
      return next(e)
    }
  })

  // Reads, searches and listings fold into one group line; the note goes under it, summed.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.props.isExpanded) return next(e)
    const big = await read($, bigAtom)
    const hits = e.props.calls.map(c => (c.tool_use_id ? big[c.tool_use_id] ?? 0 : 0)).filter(t => t > 0)
    if (hits.length === 0) return next(e)
    const lens = sanitizeLens(await read($, lensAtom))
    const row = await next(e)
    if (!lens) return row
    return withResultNote($.ui.resolve(e) as CardEl, row, hits.reduce((a, b) => a + b, 0), lens.window, hits.length)
  })

  // What a big tool result added, under its row.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const big = await read($, bigAtom)
    const tokens = big[e.props.tool_use_id]
    if (!tokens || e.props.isRunning) return next(e)
    const lens = sanitizeLens(await read($, lensAtom))
    const row = await next(e)
    if (!lens) return row
    return withResultNote($.ui.resolve(e) as CardEl, row, tokens, lens.window)
  })
}
