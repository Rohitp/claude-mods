import { expect, test } from 'claude-code/testing'

import { len } from './hooks/layout'
import { cardFor, crossesCold, derive, levelOf, resultNote, sanitizeHistory, sanitizeLens, shouldShowBand, spinnerNote, whatIf } from './hooks/model'
import { ctxBand, ctxPane } from './hooks/terminal'
import type { PaneState } from './hooks/terminal'
import { miniStackSvg, rowBarSvg, sparkSvg, stackedBarSvg, trendTopPct } from './hooks/svg'
import type { Lens, Point } from './types'
import { ctxBandDesktop, ctxPaneDesktop } from './hooks/desktop'
import { formatLine } from './hooks/log'
import { bump, emptyStats, note, sanitizeStats, summarize } from './hooks/stats'
import { ctxCard } from './hooks/card'

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

// An element as both test runners build it: `props` is absent when none were given.
type Node = { type: string; props?: Record<string, unknown>; children: unknown[] } | string | number | false | null | undefined
const el = { Box: 'Box', Text: 'Text', Button: 'Button', Svg: 'Svg' } as never
const flat = (n: Node | Node[]): string => {
  if (n === null || n === undefined || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(flat).join(' ')
  const pr = n.props ?? {}
  const own = n.type === 'Button' ? String(pr.label ?? '') : n.type === 'Svg' ? `[svg:${pr.alt}]` : ''
  return `${own} ${((n.children ?? []) as Node[]).map(flat).join(' ')}`
}
const acts = new Proxy({} as Record<string, () => void>, { get: () => () => {} })

test('desktop pane renders in every billing mode, with and without a what-if, without dollars when it should not', () => {
  const h = hist(300 * K, 842 * K)
  for (const l of [lens(842 * K), lens(842 * K, 'sub'), lens(842 * K, 'api', 'some-new-model')]) {
    const v = derive(l, h, 0, 0)
    for (const whatIf of ['', 'mcp:github']) {
      const out = flat(ctxPaneDesktop(el, v, { tab: 'category', open: [], whatIf, history: h }, acts) as Node)
      expect(out.includes("WHAT'S USING IT")).toBe(true)
      if (v.mode !== 'api') expect(out.includes('$')).toBe(false)
    }
  }
})

test('desktop pane: one list, no tabs, and a group opens to its items', () => {
  const h = hist(300 * K, 412 * K)
  const v = derive(lens(412 * K), h, 0, 0)
  const closed = flat(ctxPaneDesktop(el, v, st('category', h), acts) as Node)
  expect(closed.includes('What-if')).toBe(false)
  expect(closed.includes('Trend')).toBe(false)
  expect(closed.includes('MCP tools')).toBe(true)
  const shut = flat(ctxPaneDesktop(el, v, { ...st('category', h), open: [] }, acts) as Node)
  expect(shut.includes('github')).toBe(false)
  expect(closed.includes('github')).toBe(true)
  expect(closed.includes('/ turn')).toBe(true)
})

test('desktop pane: near autocompact it leads with what compacting frees', () => {
  const h = hist(300 * K, 842 * K)
  const out = flat(ctxPaneDesktop(el, derive(lens(842 * K), h, 0, 0), st('category', h), acts) as Node)
  expect(out.includes('frees about')).toBe(true)
  expect(out.includes('Not now')).toBe(true)
  expect(out.indexOf('frees about') < out.indexOf("WHAT'S USING IT")).toBe(true)
  const calm = flat(ctxPaneDesktop(el, derive(lens(412 * K), h, 0, 0), st('category', h), acts) as Node)
  expect(calm.includes('Not now')).toBe(false)
})

test('desktop pane: the what-if opens inside its row and its group, and says what is left', () => {
  const h = hist(300 * K, 412 * K)
  const v = derive(lens(412 * K), h, 0, 0)
  const out = flat(ctxPaneDesktop(el, v, { tab: 'category', open: [], whatIf: 'mcp:github', history: h }, acts) as Node)
  expect(out.includes('without it')).toBe(true)
  expect(out.includes('Pays back')).toBe(true)
  expect(out.includes('Keep it')).toBe(true)
  expect(out.indexOf('github') < out.indexOf('Pays back')).toBe(true)
  expect(out.indexOf('Pays back') < out.indexOf('linear')).toBe(true)
})

test('desktop widget is the short form', () => {
  const h = hist(300 * K, 412 * K)
  const out = flat(ctxPaneDesktop(el, derive(lens(412 * K), h, 0, 0), st('category', h), acts, 'widget') as Node)
  expect(out.includes('41%')).toBe(true)
  expect(out.includes("WHAT'S USING IT")).toBe(false)
  const hot = flat(ctxPaneDesktop(el, derive(lens(842 * K), h, 0, 0), st('category', h), acts, 'widget') as Node)
  expect(hot.includes('Compact now')).toBe(true)
})

test('the band can be hidden from itself on both surfaces', () => {
  const h = hist(300 * K, 412 * K)
  for (const total of [412 * K, 842 * K]) {
    const v = derive(lens(total), h, 0, 0)
    for (const w of [60, 120]) {
      const segs = ctxBand(v, w)
      expect(segs.some(s => s.act === 'hide' && s.t.includes('×'))).toBe(true)
    }
    expect(flat(ctxBandDesktop(el, v, acts) as Node).includes('Hide')).toBe(true)
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
    sparkSvg(hist(100 * K, 400 * K)),
  ]
  for (const d of docs) {
    expect(d.startsWith('<svg')).toBe(true)
    expect(d.endsWith('</svg>')).toBe(true)
    expect((d.match(/<svg/g) ?? []).length).toBe(1)
    expect(d.includes('<x>')).toBe(false)
  }
})

// ---- state surviving a hot reload from an earlier version -------------------------------

test('state from the previous version is ignored, not rendered', () => {
  const old = { rows: [], items: [], messages: [], servers: [], total: 400 * K, max: 1000 * K, percent: 40, model: 'm', mode: 'api', limitPct: null }
  expect(sanitizeLens(old)).toBe(null)
  expect(sanitizeLens(lens(412 * K)) === null).toBe(false)
  expect(sanitizeHistory([40, 41, 42])).toEqual([])
  expect(sanitizeHistory([{ total: 1, overhead: 1, isCompaction: false }, 7]).length).toBe(1)
  // and the whole view degrades to first-run rather than throwing
  expect(derive(sanitizeLens(old), sanitizeHistory([40, 41]), 0, 0).state).toBe('empty')
})

// ---- logging and local metrics ---------------------------------------------------------

test('log lines are single-line key=value with no free text', () => {
  const l = formatLine('context-lens', 'info', 'measure', { total: 412000, model: 'claude opus', ok: true, ms: 8.12345 })
  expect(l).toBe('context-lens info measure total=412000 model=claude_opus ok=true ms=8.123')
})

test('stats: counters, ring bounds, repair and summary', () => {
  let s = emptyStats(1000)
  for (let i = 0; i < 130; i++) s = note(bump(s, 'measure.ok'), { t: i, k: 'm' }, 100)
  s = bump(bump(s, 'est.n', 2), 'est.scale', 1000 + 1100)
  expect(s.recent.length).toBe(100)
  const out = summarize(s, 120_000).join('\n')
  expect(out.includes('130 ok')).toBe(true)
  expect(out.includes('×1.05')).toBe(true)
  expect(sanitizeStats({ c: { a: 'x', b: 2 }, recent: [null, { t: 1, k: 'a' }] }, 9).c).toEqual({ b: 2 })
  expect(sanitizeStats(42, 9).since).toBe(9)
})

test('compact offer states what it frees and stays quiet when dismissed', () => {
  const h = hist(300 * K, 842 * K)
  const v = derive(lens(842 * K), h, 0, 0)
  expect(v.offer !== null).toBe(true)
  expect(v.offer!.frees > 100 * K).toBe(true)
  expect(v.offer!.savesPerTurn !== null).toBe(true)
  expect(derive(lens(412 * K), hist(380 * K, 412 * K), 0, 0).offer).toBe(null)
  // dismissed at 842k: quiet until the context has grown by 10%
  expect(derive(lens(850 * K), h, 0, 0, 842 * K).offer).toBe(null)
  expect(derive(lens(930 * K), h, 0, 0, 842 * K).offer !== null).toBe(true)
})

// ---- in-the-moment flow -----------------------------------------------------------------

test('a card is placed once per level crossed: 80%, 90%, then autocompact', () => {
  const h = hist(300 * K, 842 * K)
  const at = (t: number) => derive(lens(t), hist(300 * K, t), 0, 0)
  expect(levelOf(at(412 * K))).toBe(0)
  expect(cardFor(at(412 * K), 0, 'c1')).toBe(null)
  const c1 = cardFor(at(842 * K), 0, 'c1')!
  expect(c1.level).toBe(1)
  expect(cardFor(at(850 * K), 1, 'c2')).toBe(null)
  expect(cardFor(derive(lens(905 * K), hist(880 * K, 905 * K), 0, 0), 1, 'c2')!.level).toBe(2)
  expect(cardFor(derive(lens(925 * K), h, 0, 0), 2, 'c3')!.level).toBe(3)
  expect(c1.frees > 100 * K).toBe(true)
})

test('the card asks while it is the newest and open, then says what happened', () => {
  const c = cardFor(derive(lens(842 * K), hist(300 * K, 842 * K), 0, 0), 0, 'c1')!
  const live = flat(ctxCard(el, c, true, acts) as Node)
  expect(live.includes('Compact now')).toBe(true)
  expect(live.includes('Not now')).toBe(true)
  expect(live.includes('frees about')).toBe(true)
  expect(flat(ctxCard(el, { ...c, status: 'snoozed' }, true, acts) as Node).includes("hear again at 90%")).toBe(true)
  expect(flat(ctxCard(el, { ...c, status: 'compacted' }, false, acts) as Node).includes('Compacted since')).toBe(true)
  expect(flat(ctxCard(el, c, false, acts) as Node).includes('Compact now')).toBe(false)
  const sub = cardFor(derive(lens(842 * K, 'sub'), hist(300 * K, 842 * K), 0, 0), 0, 'c1')!
  expect(flat(ctxCard(el, sub, true, acts) as Node).includes('$')).toBe(false)
})

test('the band shows in auto mode only when there is something to do', () => {
  const calm = derive(lens(412 * K), hist(380 * K, 412 * K), 0, 0)
  const hot = derive(lens(842 * K), hist(300 * K, 842 * K), 0, 0)
  expect(shouldShowBand('auto', calm)).toBe(false)
  expect(shouldShowBand('auto', hot)).toBe(true)
  expect(shouldShowBand('on', calm)).toBe(true)
  expect(shouldShowBand('off', hot)).toBe(false)
})

test('the working line names the fill from 70%, and big results get a line', () => {
  expect(spinnerNote(derive(lens(412 * K), hist(380 * K, 412 * K), 0, 0))).toBe(null)
  expect(spinnerNote(derive(lens(760 * K), hist(700 * K, 760 * K), 0, 0))).toBe(' · 76% context')
  expect(resultNote(38_400, 1000 * K)).toBe('+38k context · 3.8% of window')
  expect(resultNote(52_000, 1000 * K, 2)).toBe('+52k context from 2 results · 5.2% of window')
})

test('the window bar covers the window, so the largest category is not drawn full', () => {
  const cats = [{ name: 'Messages', tokens: 400 * K, color: '', kind: 'used' as const }]
  const svg = stackedBarSvg(cats.map(c => ({ cat: c, tip: '' })), null, 360, 16, 1000 * K)
  const w = Number(/<rect class="s"[^>]* width="([\d.]+)"/.exec(svg)![1])
  expect(w > 100 && w < 160).toBe(true)
  const row = Number(/<rect width="([\d.]+)" height="6" rx="3" fill="#/.exec(rowBarSvg(0.4, '#d9784a'))![1])
  expect(row < 84).toBe(true)
})

test('a clock tick redraws only when the cold flag flips', () => {
  expect(crossesCold(1_000, 11_000, 500)).toBe(false)
  expect(crossesCold(290_000, 310_000, 0)).toBe(false)
  expect(crossesCold(290_000, 310_000, 5_000)).toBe(true)
})

// ---- trend scale ------------------------------------------------------------------------

const low = (n = 2): Point[] => Array.from({ length: n }, (_, i) => ({ total: (28 + 2 * i) * K, overhead: 25 * K, isCompaction: false }))

test('trend scale tops out just above the fullest turn', () => {
  expect(trendTopPct(low(), 1000 * K)).toBe(5)
  expect(trendTopPct(hist(300 * K, 400 * K), 1000 * K)).toBe(50)
  expect(trendTopPct(hist(700 * K, 850 * K), 1000 * K)).toBe(100)
})

test('terminal trend scales rows to the data and points up to autocompact when it is off scale', () => {
  const v = derive(lens(100 * K), low(4), 0, 0)
  const rows = ctxPane(v, st('trend', low(4)), 56).map(text)
  expect(rows.some(r => r.startsWith('  5% ┤'))).toBe(true)
  expect(rows.filter(r => r.includes('┤') && r.includes('█')).length > 3).toBe(true)
  expect(rows.some(r => r.includes('↑ autocompact at 92%'))).toBe(true)
})
