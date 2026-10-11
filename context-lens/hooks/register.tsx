import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Cat, Lens, Named, Point, Server, Tab } from '../types'
import { fit } from './layout'
import { ctxBandDesktop, ctxPaneDesktop } from './desktop'
import type { DesktopEl } from './desktop'
import { formatLine } from './log'
import type { Field, Level } from './log'
import { derive, sanitizeHistory, sanitizeLens } from './model'
import { bump, emptyStats, note, sanitizeStats, summarize } from './stats'
import type { Stats } from './stats'
import type { View } from './model'
import { ctxBand, ctxPane, row } from './terminal'
import type { Acts } from './terminal'

const PANE = 'context-lens'
const lensAtom = atom({ plugin: 'context-lens', key: 'lens' } as const, null)
const bandAtom = atom({ plugin: 'context-lens', key: 'isBandOn' } as const, true)
const tabAtom = atom({ plugin: 'context-lens', key: 'tab' } as const, 'category')
const historyAtom = atom({ plugin: 'context-lens', key: 'history' } as const, [])
const whatIfAtom = atom({ plugin: 'context-lens', key: 'whatIf' } as const, '')
const openAtom = atom({ plugin: 'context-lens', key: 'open' } as const, ['mcp', 'mem', 'msg'])
const lastTurnAtom = atom({ plugin: 'context-lens', key: 'lastTurnAt' } as const, 0)
const nowAtom = atom({ plugin: 'context-lens', key: 'now' } as const, 0)

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
    for (const r of m.toolResults ?? []) add(toolOf.get(r.tool_use_id) ?? 'Other results', r.text.length)
  }
  const all = [...sums.entries()].map(([k, chars]) => ({ k, est: Math.ceil(chars / 4) }))
  const sum = all.reduce((a, x) => a + x.est, 0)
  const scale = target > 0 && sum > 0 ? target / sum : 1
  const list = all
    .map(x => ({ label: x.k, tokens: Math.round(x.est * scale) }))
    .filter(x => x.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
  return { list, scale: target > 0 && sum > 0 ? target / sum : 0 }
}

async function measure($: EngineInterface): Promise<Lens | null> {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const b = usage.context.breakdown
  if (!b) return null

  const cats: Cat[] = b.categories.map(c => ({ name: c.name, tokens: c.tokens, color: c.color, kind: c.kind }))
  const msgRow = cats.find(c => c.kind === 'used' && /message/i.test(c.name))
  const byServer = new Map<string, { tokens: number; tools: number }>()
  for (const t of b.mcpTools) {
    if (!t.isLoaded) continue
    const s = byServer.get(t.serverName) ?? { tokens: 0, tools: 0 }
    byServer.set(t.serverName, { tokens: s.tokens + t.tokens, tools: s.tools + 1 })
  }
  const servers: Server[] = [...byServer.entries()]
    .map(([label, s]) => ({ label, tokens: s.tokens, tools: s.tools }))
    .sort((x, y) => y.tokens - x.tokens)
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
  await update($, historyAtom, (old: unknown) => {
    const h = sanitizeHistory(old)
    const prev = h[h.length - 1]
    const point: Point = {
      total: lens.total,
      overhead: lens.overhead,
      isCompaction: !!prev && lens.total < prev.total * 0.7,
    }
    if (point.isCompaction) {
      count('compaction')
      log($, 'info', 'compaction', { from: prev?.total ?? 0, to: lens.total })
    }
    return [...h, point].slice(-60)
  })
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
  return derive(lens, h, now, await read($, lastTurnAtom))
}

async function tickNow($: EngineInterface) {
  const now = await $.clock.now()
  await update($, nowAtom, () => now)
  await flush($)
}

let timer: { cancel: () => void } | null = null

export const register: Register = (on, options) => {
  isTracking = (options as Record<string, unknown>)?.metrics !== false

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
    if (e.args.trim() === 'band') {
      const isOn = !(await read($, bandAtom))
      await update($, bandAtom, () => isOn)
      return { text: isOn ? 'Context band on.' : 'Context band off.' }
    }
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Context Lens' })
    return { text: 'Context Lens opened. `/ctx band` toggles the one-line band.' }
  })

  // After every turn. The summary breakdown is a local estimate and costs no request.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) await refresh($)
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
      if (e.surface !== 'terminal') return ctxPaneDesktop($.ui.resolve(e) as DesktopEl, v, st, acts)
      const lines = ctxPane(v, st, Math.max(20, e.props.bodyColumns))
      return <el.Box flexDirection="column">{lines.map((l, i) => row(el, l, acts, `r${i}`))}</el.Box>
    } catch (err) {
      count('render.error')
      log($, 'error', 'render.pane', { name: err instanceof Error ? err.name : 'unknown', msg: err instanceof Error ? err.message : '' })
      return <el.Text dimColor>Context Lens could not draw. See claude --debug.</el.Text>
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, bandAtom))) return next(e)
    try {
      const el = $.ui.resolve(e)
      const v = await view($)
      const acts: Acts = {
        open: () => void $.ui.open({ id: PANE, title: 'Context Lens' }),
        compact: () => {
          count('compact.click')
          log($, 'info', 'compact.click', { via: 'band', state: v.state })
          void $.session.compact()
        },
      }
      if (e.surface !== 'terminal') return ctxBandDesktop($.ui.resolve(e) as DesktopEl, v, acts)
      return row(el, fit(ctxBand(v, Math.max(20, e.props.bodyColumns)), Math.max(20, e.props.bodyColumns)), acts, 'band')
    } catch (err) {
      count('render.error')
      log($, 'error', 'render.band', { name: err instanceof Error ? err.name : 'unknown', msg: err instanceof Error ? err.message : '' })
      return next(e)
    }
  })
}
