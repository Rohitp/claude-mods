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
  avoided: 0,
  busts: [],
  beats: ['hit', 'hit', 'part', 'miss'],
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
