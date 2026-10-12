import { expect, test } from 'claude-code/testing'

import { len } from './hooks/layout'
import type { Seg } from './hooks/layout'
import {
  BLOCK_END,
  BLOCK_START,
  activeRows,
  describe,
  interrupted,
  isLoop,
  liveHint,
  loopRows,
  loopSize,
  matcherFor,
  matches,
  memoryCandidates,
  missKey,
  propose,
  removeLines,
  restoreLines,
  sanitizeHistory,
  sanitizeRules,
  sanitizeUi,
  shouldHint,
  track,
  upsertBlock,
  wastedTokens,
} from './hooks/model'
import type { Entry } from './hooks/model'
import { lessonsBandDesktop, lessonsPaneDesktop } from './hooks/desktop'
import { trendSvg } from './hooks/svg'
import { lessonsBand, lessonsPane, toastText } from './hooks/terminal'
import type { View } from './hooks/terminal'

const bash = (command: string, text: string, isError = false, turn = 1) => ({ tool: 'Bash', input: { command }, text, isError, at: 0, turn })
const run = (calls: ReturnType<typeof bash>[]) => {
  const m = new Map<string, Entry>()
  for (const c of calls) track(m, c)
  return m
}
const only = (m: Map<string, Entry>) => [...m.values()][0]

// ---- detection ---------------------------------------------------------------------------------
test('pagination variants of one command share a signature', () => {
  expect(describe('Bash', { command: 'grep foo src | head -50' }).sig).toBe(describe('Bash', { command: 'grep foo src | head -200' }).sig)
  expect(describe('Bash', { command: 'git log -n 5' }).sig).toBe(describe('Bash', { command: 'git log -n 50' }).sig)
})

test('the same error three times in a row is a loop', () => {
  const m = run([0, 1, 2].map(i => bash('cat missing.txt', `cat: missing.txt: No such file or directory (${i})`, true, 10 + i)))
  const e = only(m)
  expect(isLoop(e)).toBe(true)
  expect(e.category).toBe('file_not_found')
  expect(shouldHint(e)).toBe(true)
  expect(e.turns.join(',')).toBe('10,11,12')
})

test('different errors are progress, not a loop', () => {
  const m = run([bash('npm test', 'FAIL a.test', true), bash('npm test', 'FAIL b.test', true), bash('npm test', 'FAIL c.test', true)])
  expect(only(m).sameErr).toBe(1)
  expect(isLoop(only(m))).toBe(false)
})

test('re-running a passing command is not a loop', () => {
  const m = run([bash('npm test', 'ok'), bash('npm test', 'ok'), bash('npm test', 'ok'), bash('npm test', 'ok')])
  expect(isLoop(only(m))).toBe(false)
})

test('re-fetching with growing limits is a loop and its waste is measured', () => {
  const big = 'x'.repeat(4000)
  const m = run([bash('grep foo . | head -50', big), bash('grep foo . | head -100', big), bash('grep foo . | head -200', big)])
  const e = only(m)
  expect(loopSize(e)).toBe(3)
  expect(wastedTokens(e)).toBe(2000) // 2 repeats x 1000 tokens
  expect(liveHint(e).includes('different limits')).toBe(true)
})

test('a loop stays a loop after it ends, so it can become a proposal', () => {
  const m = run([0, 1, 2].map(() => bash('cat nope', 'cat: nope: No such file or directory', true)))
  track(m, bash('cat nope', 'fine'))
  const e = only(m)
  expect(loopSize(e)).toBe(0)
  expect(isLoop(e)).toBe(true)
  expect(loopRows(m, new Set()).length).toBe(1)
  expect(loopRows(m, new Set())[0].live).toBe(false)
})

test('a hint is given once per step, not on every repeat', () => {
  const m = new Map<string, Entry>()
  let hints = 0
  for (let i = 0; i < 7; i++) {
    const e = track(m, bash('foo', 'boom', true))
    if (shouldHint(e)) {
      hints++
      e.hinted = loopSize(e)
    }
  }
  expect(hints).toBe(2) // at 3 and 6
})

test('an edit resets what was learned about reading that file', () => {
  const m = new Map<string, Entry>()
  track(m, { tool: 'Read', input: { file_path: 'a.ts' }, text: 'x', isError: false, at: 0 })
  expect(m.has('read:a.ts')).toBe(true)
  track(m, { tool: 'Edit', input: { file_path: 'a.ts' }, text: 'ok', isError: false, at: 1 })
  expect(m.has('read:a.ts')).toBe(false)
})

test('rejections and interruptions become corrections with their own evidence', () => {
  const m = new Map<string, Entry>()
  track(m, { tool: 'Edit', input: { file_path: 'src/gen/types.ts' }, text: "The user doesn't want to proceed with this tool use.", isError: true, at: 0, turn: 8 })
  interrupted(m, { tool: 'Edit', input: { file_path: 'src/gen/client.ts' }, at: 0, turn: 21 })
  const props = propose(m, new Set(), 60)
  expect(props.length).toBe(2)
  expect(props.every(p => p.kind === 'correction')).toBe(true)
  expect(props.some(p => p.ev[0].includes('you rejected'))).toBe(true)
  expect(props.some(p => p.ev[0].includes('you interrupted'))).toBe(true)
})

test('two failures are a proposal; one is not', () => {
  expect(propose(run([bash('cat a', 'No such file or directory', true)]), new Set(), 60).length).toBe(0)
  const p = propose(run([bash('cat a', 'No such file or directory', true), bash('cat b', 'x'), bash('cat a', 'No such file or directory', true)]), new Set(), 60)
  expect(p.length).toBe(1)
  expect(p[0].kind).toBe('failure')
})

// ---- price -------------------------------------------------------------------------------------
test('a rule is priced: just in time beats always on for a short rule', () => {
  const m = run([0, 1, 2].map(() => bash('cat nope', 'cat: nope: No such file or directory', true)))
  const [p] = propose(m, new Set(), 40)
  expect(p.kind).toBe('loop')
  expect(p.netJit > p.netAlways).toBe(true)
  expect(p.carryAlways).toBe(p.tokens * 40)
  expect(propose(m, new Set([p.sig]), 40).length).toBe(0)
})

test('a just-in-time rule is shown at most twice, so matching many calls does not multiply its cost', () => {
  const m = new Map<string, Entry>()
  interrupted(m, { tool: 'Edit', input: { file_path: 'src/lib/a.ts' }, at: 0, turn: 3 })
  for (let i = 0; i < 70; i++) track(m, { tool: 'Read', input: { file_path: `src/lib/f${i}.ts` }, text: 'ok', isError: false, at: 0 })
  const [p] = propose(m, new Set(), 60)
  expect(p.fires).toBe(70)
  expect(p.carryJit).toBe(p.tokens * 2)
  expect(p.carryAlways > p.carryJit).toBe(true)
})

test('matchers: a command prefix and a directory', () => {
  const t = matcherFor(only(run([bash('pnpm test 2>&1 | head -c 60', 'x'.repeat(10))])))
  expect(t.label).toBe('Bash(pnpm test*)')
  expect(matches(t, 'Bash', 'pnpm test --reporter=dot')).toBe(true)
  expect(matches(t, 'Bash', 'pnpm build')).toBe(false)
  const m = new Map<string, Entry>()
  const f = track(m, { tool: 'Read', input: { file_path: 'src/lib/db.ts' }, text: 'ENOENT', isError: true, at: 0 })
  const fm = matcherFor(f)
  expect(fm.label).toBe('Read|Edit(src/lib/*)')
  expect(matches(fm, 'Edit', 'src/lib/other.ts')).toBe(true)
  expect(matches(fm, 'Read', 'src/api/x.ts')).toBe(false)
})

// ---- memory ------------------------------------------------------------------------------------
test('memory: stale paths, never-triggered commands, and what is in use', () => {
  const files = [{ name: 'CLAUDE.md', content: '# Notes\n- Run `make lint` before committing.\n- Types live in `src/old/types.ts`.\n- Use `pnpm` for installs.\n- plain prose line' }]
  const { cands, inUse } = memoryCandidates(files, { pnpm: 9 }, 12, new Set([missKey(undefined, 'src/old/types.ts')]))
  expect(cands.map(c => c.st).sort().join()).toBe('never triggered,stale')
  expect(inUse.length).toBe(1)
  expect(inUse[0].why).toBe('relevant in 9 of 12 sessions')
})

test('memory: our own block is never a removal candidate', () => {
  const files = [{ name: 'CLAUDE.local.md', content: `${BLOCK_START}\n- \`make lint\` failed.\n${BLOCK_END}` }]
  expect(memoryCandidates(files, {}, 12, new Set()).cands.length).toBe(0)
})

test('removing lines and restoring them is lossless', () => {
  const src = 'a\nb\nc\nd'
  const { next, removed } = removeLines(src, 2, 3)
  expect(next).toBe('a\nd')
  expect(restoreLines(next, 2, removed)).toBe(src)
})

test('the file block is replaced in place and removed when empty', () => {
  const base = '# Notes\n\nkeep me\n'
  const one = upsertBlock(base, ['rule a'])
  expect(one.includes(BLOCK_START) && one.includes('- rule a')).toBe(true)
  const two = upsertBlock(one, ['rule b'])
  expect(two.includes('rule a')).toBe(false)
  expect(two.split(BLOCK_END).length).toBe(2)
  expect(upsertBlock(two, [])).toBe(base)
})

test('persisted state from another shape is repaired, not trusted', () => {
  expect(sanitizeRules([{ id: 1 }, { id: 'a', sig: 's', text: 't' }]).length).toBe(1)
  expect(sanitizeRules('nope').length).toBe(0)
  expect(sanitizeHistory({ sessions: 'x', trend: [{ w: 1 }, 7], used: { a: 2, b: 'z' } }).trend.length).toBe(1)
  expect(sanitizeUi({ tab: 9, view: 'bogus', open: 3 }).tab).toBe(0)
  expect(sanitizeUi({ tab: 9, view: 'bogus', open: 3 }).view).toBe('list')
})

// ---- drawing -----------------------------------------------------------------------------------
const loopCalls = () => [0, 1, 2].map(i => bash('pnpm build', `error TS2307: Cannot find module '@/lib/db' (${i})`, true, 30 + i))
const view = (over: Partial<View> = {}): View => {
  const m = run([...loopCalls(), ...[0, 1].map(() => bash('cat src/lib/db.ts', 'No such file or directory', true))])
  const props = propose(m, new Set(), 60)
  return {
    mode: 'api',
    price: 4,
    props,
    active: activeRows(
      [
        { id: 'r1', sig: 's', tool: 'Bash', text: 'Run tests with `pnpm test -- --reporter=dot`.', mode: 'jit', matcher: 'Bash(pnpm test*)', tools: ['Bash'], prefix: 'pnpm test', line: 0, at: 0, fired: 7, recurred: 0 },
        { id: 'r2', sig: 't', tool: 'Bash', text: 'Use pnpm, never npm.', mode: 'always', matcher: '', tools: [], prefix: '', line: 12, at: 0, fired: 0, recurred: 1 },
      ],
      12,
    ),
    loops: loopRows(m, new Set(props.map(p => p.id))),
    cands: [{ id: 'c1', file: 'CLAUDE.md', from: 15, to: 31, text: '## API style guide', tokens: 640, st: 'stale', why: 'matching files edited in 2 of 12 sessions' }],
    inUse: [],
    memTokens: 2100,
    hasMemory: true,
    turns: 42,
    sessions: 12,
    failures: 5,
    corrections: 0,
    trend: [{ w: 41000, r: false }, { w: 38000, r: false }, { w: 28700, r: true }],
    ui: { tab: 0, open: null, view: 'list', id: '', polished: '', msg: '', later: 0, rev: 0 },
    openId: props[0]?.id ?? null,
    canUndo: false,
    append: { file: 'CLAUDE.local.md', line: 13, prev: 'Use pnpm, never npm.' },
    removal: { file: 'CLAUDE.md', from: 15, to: 31, lines: ['## API style guide', 'Use kebab-case.'], tokens: 640 },
    ...over,
  }
}
const widest = (lines: Seg[][]) => Math.max(0, ...lines.map(len))

test('band: one row at every width, no Review below 110, never empty when pending', () => {
  for (const w of [144, 110, 100, 80]) {
    const b = lessonsBand(view(), w)
    expect(b !== null).toBe(true)
    expect(len(b as Seg[]) <= w).toBe(true)
    const acts = (b as Seg[]).filter(s => s.act).map(s => s.act)
    expect(acts.includes('later')).toBe(true)
    expect(acts.includes('review')).toBe(w >= 110)
  }
})

test('band: hidden when nothing is pending or the person said Later', () => {
  expect(lessonsBand(view({ props: [], loops: [] }), 120)).toBe(null)
  const v = view()
  expect(lessonsBand({ ...v, loops: [], ui: { ...v.ui, later: v.props.length } }, 120)).toBe(null)
})

test('band: a live loop shows in the warning role and wins over proposals', () => {
  const v = view()
  const b = lessonsBand(v, 144) as Seg[]
  expect(b.some(s => s.t === 'loop caught' && s.r === 'warn')).toBe(true)
})

test('pane: every tab and every confirm view fits its width in both billing modes', () => {
  const views = ['list', 'jit', 'always', 'written', 'error', 'polish', 'sending', 'polished', 'remove', 'retire'] as const
  for (const mode of ['api', 'sub'] as const) {
    for (const iw of [42, 56]) {
      for (const tab of [0, 1, 2, 3] as const) {
        const v = view({ mode })
        const open = v.props[0]?.id ?? null
        for (const vw of tab === 0 ? views : (['list'] as const)) {
          const id = vw === 'remove' ? 'c1' : vw === 'retire' ? 'r1' : (v.props[0]?.id ?? '')
          const lines = lessonsPane({ ...v, ui: { ...v.ui, tab, view: vw, id, open, polished: 'A tighter rule.', msg: 'Written to CLAUDE.local.md:13' } }, iw)
          expect(widest(lines) <= iw).toBe(true)
        }
      }
    }
  }
})

test('pane: subscription mode never shows dollars', () => {
  const v = view({ mode: 'sub' })
  const text = lessonsPane({ ...v, ui: { ...v.ui, open: v.props[0].id } }, 56).map(l => l.map(s => s.t).join('')).join('\n')
  expect(text.includes('$')).toBe(false)
  expect(text.includes('subscription · tokens')).toBe(true)
})

test('pane: a negative net dims the row and says dismiss', () => {
  const v = view()
  const neg = { ...v.props[0], netJit: -500, netAlways: -900 }
  const text = lessonsPane({ ...v, props: [neg], ui: { ...v.ui, open: neg.id } }, 56).map(l => l.map(s => s.t).join('')).join('\n')
  expect(text.includes('Dismiss is probably right')).toBe(true)
  expect(text.includes('−500')).toBe(true)
})

test('pane: tabs and buttons are named actions', () => {
  const v = view()
  const lines = lessonsPane({ ...v, ui: { ...v.ui, open: v.props[0].id } }, 56)
  const acts = lines.flat().filter(s => s.act).map(s => s.act as string)
  for (const a of ['tab:0', 'tab:1', 'tab:2', 'tab:3', `exp:${v.props[0].id}`, `jit:${v.props[0].id}`, `alw:${v.props[0].id}`, `dis:${v.props[0].id}`, `pol:${v.props[0].id}`]) expect(acts.includes(a)).toBe(true)
})

test('the top proposal is open by default and says why', () => {
  const v = view()
  const text = lessonsPane(v, 56).map(l => l.map(s => s.t).join('')).join('\n')
  expect(text.includes('Why')).toBe(true)
  expect(text.includes('failed 3 times in a row')).toBe(true)
  const none = lessonsPane({ ...v, openId: null }, 56).map(l => l.map(s => s.t).join('')).join('\n')
  expect(none.includes('Deliver as')).toBe(false)
})

test('toast is one plain sentence', () => {
  const t = toastText('Bash pnpm build', 3, 4100, 4, 'api')
  expect(t.includes('\n')).toBe(false)
  expect(t.includes('4.1k wasted')).toBe(true)
})

// ---- desktop -----------------------------------------------------------------------------------
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

test('desktop pane draws every tab and confirm view in both modes, dollars only on API', () => {
  const views = ['list', 'jit', 'always', 'written', 'error', 'polish', 'sending', 'polished', 'remove', 'retire'] as const
  for (const mode of ['api', 'sub'] as const) {
    const v = view({ mode })
    for (const tab of [0, 1, 2, 3] as const) {
      for (const vw of tab === 0 ? views : (['list'] as const)) {
        const id = vw === 'remove' ? 'c1' : vw === 'retire' ? 'r1' : v.props[0].id
        const out = flat(lessonsPaneDesktop(el, { ...v, ui: { ...v.ui, tab, view: vw, id, open: v.props[0].id, polished: 'Tighter.' } }, acts) as Node)
        expect(out.length > 40).toBe(true)
        if (mode === 'sub') expect(out.includes('$')).toBe(false)
      }
    }
  }
})

test('desktop band: hidden when quiet, Review and Later when pending', () => {
  expect(lessonsBandDesktop(el, view({ props: [], loops: [] }), acts)).toBe(null)
  const out = flat(lessonsBandDesktop(el, view(), acts) as Node)
  expect(out.includes('Review') && out.includes('Later')).toBe(true)
})

test('trend svg is one well-formed document with a tooltip per dot', () => {
  const svg = trendSvg([{ w: 10, r: false }, { w: 5, r: true }], ['a & b', '<c>'])
  expect(svg.startsWith('<svg') && svg.endsWith('</svg>')).toBe(true)
  expect(svg.split('<title>').length - 1).toBe(2)
  expect(svg.includes('a &amp; b')).toBe(true)
})
