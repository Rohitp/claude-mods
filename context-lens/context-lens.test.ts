import { expect, test } from 'claude-code/testing'

import { len } from './hooks/layout'
import { derive, whatIf } from './hooks/model'
import { ctxBand, ctxPane } from './hooks/terminal'
import type { PaneState } from './hooks/terminal'
import type { Lens, Point } from './types'

const K = 1000
const lens = (total: number, billing: 'api' | 'sub' = 'api', model = 'claude-opus-5-5'): Lens => {
  const messages = total - 87 * K
  return {
    cats: [
      { name: 'System prompt', tokens: 3.1 * K, color: 'inactive', kind: 'used' },
      { name: 'System tools', tokens: 14.2 * K, color: 'permission', kind: 'used' },
      { name: 'MCP tools', tokens: 38.6 * K, color: 'success', kind: 'used' },
      { name: 'Memory files', tokens: 21.4 * K, color: 'warning', kind: 'used' },
      { name: 'Skills', tokens: 6.8 * K, color: 'suggestion', kind: 'used' },
      { name: 'Custom agents', tokens: 2.9 * K, color: 'planMode', kind: 'used' },
      { name: 'Messages', tokens: messages, color: 'claude', kind: 'used' },
      { name: 'Free space', tokens: 1000 * K - total - 80 * K, color: 'subtle', kind: 'free' },
      { name: 'Autocompact buffer', tokens: 80 * K, color: 'subtle', kind: 'buffer' },
    ],
    total,
    max: 1000 * K,
    window: 1000 * K,
    model,
    autoCompactAt: 920 * K,
    servers: [
      { label: 'github', tokens: 18.4 * K, tools: 31 },
      { label: 'linear', tokens: 9.7 * K, tools: 14 },
    ],
    memory: [{ label: 'docs/CLAUDE.md', tokens: 11.8 * K }],
    skills: [{ label: 'review', tokens: 2 * K }],
    agents: [{ label: 'Explore', tokens: 1 * K }],
    sources: [
      { label: 'Read results', tokens: messages * 0.5 },
      { label: 'Bash results', tokens: messages * 0.5 },
    ],
    overhead: 87 * K,
    billing,
    limitPct: 37,
  }
}
const hist = (from: number, to: number, n = 20): Point[] =>
  Array.from({ length: n }, (_, i) => ({ total: from + ((to - from) * i) / (n - 1), overhead: 87 * K, isCompaction: false }))
const text = (segs: { t: string }[]) => segs.map(s => s.t).join('')
const st = (tab: PaneState['tab'], history: Point[] = []): PaneState => ({ tab, open: ['mcp', 'mem', 'msg'], whatIf: '', history })

test('state thresholds from percent and growth', () => {
  expect(derive(lens(412 * K), hist(380 * K, 412 * K), 0, 0).state).toBe('normal')
  expect(derive(lens(842 * K), hist(790 * K, 842 * K), 0, 0).state).toBe('warn')
  expect(derive(lens(921 * K), hist(870 * K, 921 * K), 0, 0).state).toBe('crit')
  expect(derive(null, [], 0, 0).state).toBe('empty')
})

test('what-if reproduces the design example on Opus 5.5', () => {
  const v = derive(lens(412 * K), hist(380 * K, 412 * K), 0, 0)
  const w = whatIf(v, v.candidates[0]!)!
  expect(v.candidates[0]!.label).toBe('github')
  expect(Math.round((w.rebuild ?? 0) * 100) / 100).toBe(1.89)
  expect(Math.round((w.savesPerTurn ?? 0) * 1000) / 1000).toBe(0.004)
  expect(w.turns).toBe(510)
})

test('what-if is free when the cache is cold', () => {
  const v = derive(lens(412 * K), hist(380 * K, 412 * K), 10 * 60_000, 1)
  expect(v.isCold).toBe(true)
  expect(whatIf(v, v.candidates[0]!)!.turns).toBe(0)
})

test('context band fits every width and never drops the percent', () => {
  for (const total of [412 * K, 842 * K, 921 * K]) {
    for (const w of [144, 110, 80, 64, 48]) {
      const v = derive(lens(total), hist(total - 40 * K, total), 0, 0)
      const band = ctxBand(v, w)
      expect(len(band) <= w).toBe(true)
      expect(text(band).includes('%')).toBe(true)
      if (v.state !== 'normal') expect(band.some(s => s.act === 'compact')).toBe(true)
    }
  }
})

test('first run says what to do', () => {
  expect(text(ctxBand(derive(null, [], 0, 0), 110)).includes('send a prompt to start measuring')).toBe(true)
})

test('subscription and unknown model never show dollars', () => {
  for (const l of [lens(412 * K, 'sub'), lens(412 * K, 'api', 'some-new-model')]) {
    const v = derive(l, hist(380 * K, 412 * K), 0, 0)
    expect(text(ctxBand(v, 144)).includes('$')).toBe(false)
    for (const tab of ['category', 'items', 'whatif', 'trend'] as const) {
      const out = ctxPane(v, st(tab, hist(380 * K, 412 * K)), 46).map(text).join('\n')
      expect(out.includes('$')).toBe(false)
    }
  }
})

test('pane lines never exceed the inner width on any tab', () => {
  for (const iw of [30, 42, 56]) {
    for (const total of [412 * K, 921 * K]) {
      const v = derive(lens(total), hist(total - 60 * K, total), 0, 0)
      for (const tab of ['category', 'items', 'whatif', 'trend'] as const) {
        for (const line of ctxPane(v, st(tab, hist(total - 60 * K, total)), iw)) {
          if (len(line) > iw) throw new Error(`${tab} iw ${iw}: ${len(line)} cells: ${text(line)}`)
        }
      }
    }
  }
})

test('trend marks a compaction and reports growth', () => {
  const h = [...hist(300 * K, 420 * K, 14), { total: 90 * K, overhead: 87 * K, isCompaction: true }, ...hist(100 * K, 160 * K, 6)]
  const v = derive(lens(160 * K), h, 0, 0)
  const out = ctxPane(v, st('trend', h), 56).map(text).join('\n')
  expect(out.includes('▲ compacted')).toBe(true)
  expect(out.includes('/turn')).toBe(true)
})

// ---- desktop trees ---------------------------------------------------------------------
import { ctxBandDesktop, ctxPaneDesktop } from './hooks/desktop'
import { columnsSvg, miniStackSvg, rowBarSvg, stackedBarSvg } from './hooks/svg'

type Node = { tag: string; props: Record<string, unknown>; kids: unknown[] } | string | number | false | null | undefined
const el = { Box: 'Box', Text: 'Text', Button: 'Button', Svg: 'Svg' } as never
const flat = (n: Node | Node[]): string => {
  if (n === null || n === undefined || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(flat).join(' ')
  const own = n.tag === 'Button' ? String(n.props.label ?? '') : n.tag === 'Svg' ? `[svg:${n.props.alt}]` : ''
  return `${own} ${(n.kids as Node[]).map(flat).join(' ')}`
}
const acts = new Proxy({} as Record<string, () => void>, { get: () => () => {} })

test('desktop pane renders every tab in every billing mode without dollars when it should not', () => {
  const h = hist(300 * K, 842 * K)
  for (const l of [lens(842 * K), lens(842 * K, 'sub'), lens(842 * K, 'api', 'some-new-model')]) {
    const v = derive(l, h, 0, 0)
    for (const tab of ['category', 'items', 'whatif', 'trend'] as const) {
      const out = flat(ctxPaneDesktop(el, v, { tab, open: ['mcp', 'mem', 'msg'], whatIf: '', history: h }, acts) as Node)
      expect(out.length > 20).toBe(true)
      if (v.mode !== 'api') expect(out.includes('$')).toBe(false)
    }
  }
})

test('desktop band shows the alert action only when it matters', () => {
  const h = hist(300 * K, 842 * K)
  expect(flat(ctxBandDesktop(el, derive(lens(412 * K), h, 0, 0), acts) as Node).includes('Compact now')).toBe(false)
  expect(flat(ctxBandDesktop(el, derive(lens(842 * K), h, 0, 0), acts) as Node).includes('Compact now')).toBe(true)
  expect(flat(ctxBandDesktop(el, derive(null, [], 0, 0), acts) as Node).includes('send a prompt')).toBe(true)
})

test('svg builders emit one well-formed document each', () => {
  const l = lens(412 * K)
  const docs = [
    stackedBarSvg(l.cats.map(c => ({ cat: c, tip: `${c.name} & <x>` })), 0.92),
    miniStackSvg(l.cats),
    rowBarSvg(0.4, '#2fa392'),
    columnsSvg(hist(100 * K, 400 * K), 1000 * K, 92),
  ]
  for (const d of docs) {
    expect(d.startsWith('<svg')).toBe(true)
    expect(d.endsWith('</svg>')).toBe(true)
    expect((d.match(/<svg/g) ?? []).length).toBe(1)
    expect(d.includes('<x>')).toBe(false)
  }
})

// ---- state surviving a hot reload from an earlier version -------------------------------
import { sanitizeHistory, sanitizeLens } from './hooks/model'

test('state from the previous version is ignored, not rendered', () => {
  const old = { rows: [], items: [], messages: [], servers: [], total: 400 * K, max: 1000 * K, percent: 40, model: 'm', mode: 'api', limitPct: null }
  expect(sanitizeLens(old)).toBe(null)
  expect(sanitizeLens(lens(412 * K)) === null).toBe(false)
  expect(sanitizeHistory([40, 41, 42])).toEqual([])
  expect(sanitizeHistory([{ total: 1, overhead: 1, isCompaction: false }, 7]).length).toBe(1)
  // and the whole view degrades to first-run rather than throwing
  expect(derive(sanitizeLens(old), sanitizeHistory([40, 41]), 0, 0).state).toBe('empty')
})
