import { expect, test } from 'claude-code/testing'

import { BLOCK_END, BLOCK_START, describe, isLoop, liveHint, loopSize, propose, shouldHint, track, upsertBlock, wastedTokens } from './hooks/model'
import type { Entry } from './hooks/model'

const bash = (command: string, text: string, isError = false, at = 0) => ({ tool: 'Bash', input: { command }, text, isError, at })
const run = (calls: ReturnType<typeof bash>[]) => {
  const m = new Map<string, Entry>()
  for (const c of calls) track(m, c)
  return m
}

test('pagination variants of one command share a signature', () => {
  expect(describe('Bash', { command: 'grep foo src | head -50' }).sig).toBe(describe('Bash', { command: 'grep foo src | head -200' }).sig)
  expect(describe('Bash', { command: 'git log -n 5' }).sig).toBe(describe('Bash', { command: 'git log -n 50' }).sig)
})

test('the same error three times in a row is a loop', () => {
  const m = run([0, 1, 2].map(i => bash('cat missing.txt', `cat: missing.txt: No such file or directory (${i})`, true)))
  const e = [...m.values()][0]
  expect(isLoop(e)).toBe(true)
  expect(e.category).toBe('file_not_found')
  expect(shouldHint(e)).toBe(true)
})

test('different errors are progress, not a loop', () => {
  const m = run([bash('npm test', 'FAIL a.test', true), bash('npm test', 'FAIL b.test', true), bash('npm test', 'FAIL c.test', true)])
  expect([...m.values()][0].sameErr).toBe(1)
  expect(isLoop([...m.values()][0])).toBe(false)
})

test('re-running a passing command is not a loop', () => {
  const m = run([bash('npm test', 'ok'), bash('npm test', 'ok'), bash('npm test', 'ok'), bash('npm test', 'ok')])
  expect(isLoop([...m.values()][0])).toBe(false)
})

test('re-fetching with growing limits is a loop and its waste is measured', () => {
  const big = 'x'.repeat(4000)
  const m = run([bash('grep foo . | head -50', big), bash('grep foo . | head -100', big), bash('grep foo . | head -200', big)])
  const e = [...m.values()][0]
  expect(loopSize(e)).toBe(3)
  expect(wastedTokens(e)).toBe(2000) // 2 repeats x 1000 tokens
  expect(liveHint(e).includes('different limits')).toBe(true)
})

test('a hint is given once per step, not on every repeat', () => {
  const m = new Map<string, Entry>()
  let hints = 0
  for (let i = 0; i < 7; i++) {
    const e = track(m, bash('foo', 'boom', true))!
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

test('proposals are priced: just in time beats always on for a short rule', () => {
  const m = run([0, 1, 2].map(() => bash('cat nope', 'cat: nope: No such file or directory', true)))
  const [p] = propose(m, new Set(), 40)
  expect(p.kind).toBe('error-loop')
  expect(p.netJit > p.netAlways).toBe(true)
  expect(propose(m, new Set([p.sig]), 40).length).toBe(0)
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
