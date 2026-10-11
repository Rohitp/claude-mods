import { expect, test } from 'claude-code/testing'

import { len } from './hooks/layout'
import { derive, statusText, toastText } from './hooks/model'
import type { Guard } from './hooks/model'
import { cacheBand, cachePane } from './hooks/terminal'

const base: Guard = {
  billing: 'api',
  ttlMs: 300_000,
  touch: { at: 1_000, tokens: 412_000, model: 'claude-opus-5-5', effort: 'medium' },
  now: 253_000, // 48s left
  isKeepWarm: false,
  pings: 0,
  totalPings: 0,
  pingTokens: 0,
  pingExtraTokens: 0,
  avoided: 0,
  busts: [],
  steps: [
    { n: 1, beat: 'hit', read: 400000, wrote: 0, note: '' },
    { n: 2, beat: 'hit', read: 410000, wrote: 0, note: '' },
    { n: 3, beat: 'part', read: 214000, wrote: 174000, note: '' },
    { n: 4, beat: 'miss', read: 0, wrote: 384000, note: 'model changed' },
  ],
  limitPct: 37,
  isAvailable: true,
  dismissedAt: 0,
  lastTurnAt: 0,
}
const text = (segs: { t: string }[]) => segs.map(s => s.t).join('')

test('cost model: miss, ping and break-even on Opus 5.5', () => {
  const v = derive(base)
  expect(v.state).toBe('warn')
  expect(Math.round((v.miss ?? 0) * 100) / 100).toBe(1.98)
  expect(Math.round((v.ping ?? 0) * 1000) / 1000).toBe(0.082)
  expect(v.breakEven).toBe(24)
  expect(v.clock).toBe('0:48')
})

test('state thresholds', () => {
  expect(derive({ ...base, now: 1_000 }).state).toBe('normal')
  expect(derive({ ...base, now: 242_000 }).state).toBe('warn')
  expect(derive({ ...base, now: 302_000 }).state).toBe('crit')
  expect(derive({ ...base, touch: null }).state).toBe('empty')
  expect(derive({ ...base, isAvailable: false }).state).toBe('na')
})

test('cache band fits every width and keeps what must never drop', () => {
  for (const w of [144, 110, 80, 64, 48]) {
    const warn = cacheBand(derive(base), w)!
    expect(len(warn) <= w).toBe(true)
    expect(text(warn).includes('Cache expires in')).toBe(true)
    expect(warn.some(s => s.act === 'warm')).toBe(true)

    const cold = cacheBand(derive({ ...base, now: 401_000 }), w)!
    expect(len(cold) <= w).toBe(true)
    expect(text(cold).includes('Cache is cold')).toBe(true)
    expect(cold.some(s => s.act === 'compact')).toBe(true)
  }
})

test('no band when normal, empty, unavailable or dismissed', () => {
  expect(cacheBand(derive({ ...base, now: 1_000 }), 110)).toBe(null)
  expect(cacheBand(derive({ ...base, touch: null }), 110)).toBe(null)
  expect(cacheBand(derive(base), 110) === null).toBe(false)
  expect(cacheBand(derive({ ...base, touch: { ...base.touch!, at: 5 }, dismissedAt: 5, now: 252_000 }), 110)).toBe(null)
})

test('subscription and unknown model never show dollars', () => {
  const sub = derive({ ...base, billing: 'sub' })
  const unk = derive({ ...base, touch: { ...base.touch!, model: 'some-new-model' } })
  for (const v of [sub, unk]) {
    for (const w of [144, 80]) {
      expect(text(cacheBand(v, w)!).includes('$')).toBe(false)
    }
    expect(cachePane(v, 46).map(text).join('\n').includes('$')).toBe(false)
    expect(toastText(v).includes('$')).toBe(false)
  }
  expect(sub.mode).toBe('sub')
  expect(unk.mode).toBe('unk')
})

test('status line entry is fixed width in every state', () => {
  const lens = [
    statusText(derive({ ...base, now: 1_000 }), false),
    statusText(derive(base), false),
    statusText(derive({ ...base, now: 401_000 }), false),
    statusText(derive({ ...base, touch: null }), false),
    statusText(derive({ ...base, isAvailable: false }), false),
  ].map(s => [...s].length)
  expect(new Set(lens).size).toBe(1)
  expect(statusText(derive({ ...base, now: 1_000 }), true).endsWith('↻')).toBe(true)
})

test('pane lines never exceed the inner width', () => {
  for (const iw of [30, 42, 56]) {
    for (const g of [base, { ...base, now: 401_000 }, { ...base, isKeepWarm: true, totalPings: 3, pingTokens: 1_200_000, avoided: 1 }]) {
      for (const line of cachePane(derive(g), iw)) {
        if (len(line) > iw) throw new Error(`iw ${iw}: ${len(line)} cells: ${text(line)}`)
      }
    }
  }
})

// ---- desktop trees ---------------------------------------------------------------------
import { cacheBandDesktop, cachePaneDesktop } from './hooks/desktop'
import { miniBarSvg, ringSvg, stepsSvg } from './hooks/svg'

type Node = { tag: string; props: Record<string, unknown>; kids: unknown[] } | string | number | false | null | undefined
const el = { Box: 'Box', Text: 'Text', Button: 'Button', Svg: 'Svg' } as never
const flat = (n: Node | Node[]): string => {
  if (n === null || n === undefined || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(flat).join(' ')
  const own = n.tag === 'Button' ? String(n.props.label ?? '') : n.tag === 'Svg' ? `[svg:${n.props.alt}]` : ''
  return `${own} ${(n.kids as Node[]).map(flat).join(' ')}`
}
const find = (n: Node, tag: string, out: { props: Record<string, unknown> }[] = []) => {
  if (n && typeof n === 'object' && !Array.isArray(n)) {
    if (n.tag === tag) out.push(n)
    ;(n.kids as Node[]).forEach(k => (Array.isArray(k) ? k.forEach(x => find(x as Node, tag, out)) : find(k, tag, out)))
  }
  return out
}
const acts = { warm: () => {}, compact: () => {}, ttl5: () => {}, ttl1h: () => {}, dismiss: () => {} }

test('desktop pane: states, modes and actions', () => {
  const warn = cachePaneDesktop(el, derive(base), acts) as Node
  const out = flat(warn)
  expect(out.includes('Expiring soon')).toBe(true)
  expect(out.includes('+$1.98 est.')).toBe(true)
  expect(find(warn, 'Svg').length >= 2).toBe(true)

  const cold = cachePaneDesktop(el, derive({ ...base, now: 401_000 }), acts) as Node
  expect(flat(cold).includes('Compact now')).toBe(true)

  for (const g of [{ ...base, billing: 'sub' as const }, { ...base, touch: { ...base.touch!, model: 'some-new-model' } }]) {
    const out2 = flat(cachePaneDesktop(el, derive(g), acts) as Node)
    expect(out2.includes('$')).toBe(false)
  }
  expect(flat(cachePaneDesktop(el, derive({ ...base, touch: null }), acts) as Node).includes('No cache yet')).toBe(true)
})

test('desktop band appears only when it matters', () => {
  expect(cacheBandDesktop(el, derive({ ...base, now: 1_000 }), acts)).toBe(null)
  expect(flat(cacheBandDesktop(el, derive(base), acts) as Node).includes('Keep warm')).toBe(true)
  expect(flat(cacheBandDesktop(el, derive({ ...base, now: 401_000 }), acts) as Node).includes('Compact now')).toBe(true)
})

test('svg builders emit one well-formed document each', () => {
  const docs = [
    ringSvg(0.5, 0.49, '#3f9a4a'),
    ringSvg(0, 0, '#d4503f'),
    stepsSvg([{ beat: 'hit', tip: 'a & b <c>' }, { beat: 'part', tip: 'x' }, { beat: 'miss', tip: 'y' }]),
    miniBarSvg(0.3, '#d08f12'),
  ]
  for (const d of docs) {
    expect(d.startsWith('<svg')).toBe(true)
    expect(d.endsWith('</svg>')).toBe(true)
    expect((d.match(/<svg/g) ?? []).length).toBe(1)
    expect(d.includes('<c>')).toBe(false)
  }
})

import { sanitizeGuard } from './hooks/model'

test('state from the previous version is repaired, not rendered raw', () => {
  const oldBust = { at: 1, tokens: 5, cause: 'idle' } as never
  const g = sanitizeGuard({ ...base, busts: [oldBust, null as never], steps: [{ beat: 'hit' } as never, { beat: 'x' } as never], touch: { at: 'x' } as never })
  expect(g.touch).toBe(null)
  expect(g.busts.length).toBe(1)
  expect(g.busts[0]!.detail).toBe('')
  expect(g.steps.length).toBe(1)
  expect(g.steps[0]!.read).toBe(0)
  expect(derive(g).state).toBe('empty')
})

// ---- logging and local metrics ---------------------------------------------------------
import { formatLine } from './hooks/log'
import { addGap, bump, emptyStats, note, sanitizeStats, summarize } from './hooks/stats'

test('log lines are single-line key=value with no free text', () => {
  const l = formatLine('cache-guard', 'warn', 'ping.lapsed', { read: 0, need: 205000, why: 'a b\nc', none: null, ok: true, ms: 12.3456 })
  expect(l.includes('\n')).toBe(false)
  expect(l).toBe('cache-guard warn ping.lapsed read=0 need=205000 why=a_b_c none=- ok=true ms=12.346')
  expect(formatLine('p', 'info', 'e', { s: 'x'.repeat(200) }).length < 120).toBe(true)
})

test('stats: counters, ring bounds and repair of foreign state', () => {
  let s = emptyStats(1000)
  for (let i = 0; i < 150; i++) s = note(bump(s, 'steps'), { t: i, k: 'x' }, 100)
  expect(s.c.steps).toBe(150)
  expect(s.recent.length).toBe(100)
  for (let i = 0; i < 250; i++) s = addGap(s, { ms: i, hit: true })
  expect(s.gaps.length).toBe(200)
  const bad = sanitizeStats({ since: 'x', c: { a: 1, b: 'no' }, gaps: [{ ms: 1, hit: true }, 5], recent: [null] }, 7)
  expect(bad.since).toBe(7)
  expect(bad.c).toEqual({ a: 1 })
  expect(bad.gaps.length).toBe(1)
  expect(bad.recent.length).toBe(0)
  expect(sanitizeStats(undefined, 3).since).toBe(3)
})

test('stats summary checks the TTL assumption from observed idle gaps', () => {
  const MIN = 60_000
  let s = emptyStats(0)
  for (const [ms, hit] of [[2 * MIN, true], [8 * MIN, true], [3 * MIN, true]] as const) s = addGap(s, { ms, hit })
  const longer = summarize(s, 5 * MIN, 10 * MIN).join('\n')
  expect(longer.includes('outlived the assumed TTL')).toBe(true)
  expect(longer.includes('/cache 1h')).toBe(true)

  let t = emptyStats(0)
  for (const [ms, hit] of [[1 * MIN, true], [2 * MIN, false], [1.5 * MIN, true]] as const) t = addGap(t, { ms, hit })
  expect(summarize(t, 5 * MIN, 10 * MIN).join('\n').includes('real TTL may be shorter')).toBe(true)
  expect(summarize(emptyStats(0), 5 * MIN, 1).join('\n').includes('not enough yet')).toBe(true)
})

test('ping cost includes what the ping generated, not only the read', () => {
  const v = derive({ ...base, totalPings: 1, pingTokens: 400_000, pingExtraTokens: 5 * 30 })
  const readOnly = (400_000 / 1e6) * 4 * 0.05
  expect(Math.round((v.spent ?? 0) * 100000) / 100000).toBe(Math.round((readOnly + (150 / 1e6) * 4) * 100000) / 100000)
})
