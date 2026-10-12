// Terminal drawing for Lessons: the band and the side pane, ported from the design's frame
// generator. Every line returned fits its width; actions are named, never wired here.
import { block, cut, flexRow, fit, fkd, ind, len, lr, padL, S, sg, trunc, wrap } from './layout'
import type { Flex, Seg } from './layout'
import type { ActiveRow, Cand, LoopRow, Proposal } from './model'
import type { Ui } from '../types'

export type View = {
  mode: 'api' | 'sub'
  /** $/M tokens for dollar figures; null when the model has no known price. */
  price: number | null
  props: Proposal[]
  active: ActiveRow[]
  loops: LoopRow[]
  cands: Cand[]
  inUse: Cand[]
  /** Tokens per turn of every instruction file. */
  memTokens: number
  hasMemory: boolean
  turns: number
  sessions: number
  failures: number
  corrections: number
  trend: Array<{ w: number; r: boolean }>
  ui: Ui
  /** Something can be undone until the next turn. */
  canUndo: boolean
  /** Where an always-on rule would land, for the confirm view. */
  append: { file: string; line: number; prev: string } | null
  /** The lines a Memory removal would drop, for the confirm view. */
  removal: { file: string; from: number; to: number; lines: string[]; tokens: number } | null
}

export type Acts = Record<string, () => void>

const GL: Record<string, string> = { failure: '✕', loop: '↻', correction: '↩' }
export const TABS = ['Proposals', 'Active', 'Loops', 'Memory'] as const

const usd = (tokens: number, price: number | null): string => {
  if (price === null) return ''
  const v = (Math.abs(tokens) * price) / 1e6
  return v < 0.01 ? '<$0.01' : `${tokens < 0 ? '−' : ''}$${v.toFixed(2)}`
}
const ap = (tokens: number, price: number | null): string => {
  const u = usd(tokens, price)
  return u === '' || u[0] === '<' ? u : `~${u}`
}
const isApi = (v: View) => v.mode === 'api' && v.price !== null
const modeLabel = (v: View) => (v.mode === 'api' ? 'API · est.' : 'subscription · tokens')

/** A button: primary draws the engine's accent button, the rest are plain. */
const Bt = (label: string, act: string, primary = false, dim = false): Seg =>
  S(`[ ${label} ]`, primary ? 'accent b' : dim ? 'dim' : 'fg', { act, primary })
const Sm = (label: string, act: string): Seg => S(`[${label}]`, 'fg', { act })

// ---- band --------------------------------------------------------------------------------------
/** `canReview` is whether the pane can show: the window is wide enough, or it is already up. */
export function lessonsBand(v: View, w: number, canReview = w >= 110): Seg[] | null {
  const live = v.loops.find(l => l.live)
  const top = v.props[0]
  const hidden = !live && (v.props.length === 0 || v.props.length <= v.ui.later)
  if (hidden) return null
  const docked = canReview
  const right = docked ? [Bt('Review', 'review', true), S(' '), Bt('Later', 'later')] : [Bt('Later', 'later')]
  const hint: Flex[] = docked ? [] : [{ p: 7, segs: [S('widen to review', 'dim')] }]
  const lw = w - len(right) - 2
  let items: Flex[]
  if (live) {
    items = [
      { p: 0, segs: [S('lessons', 'dim')] },
      { p: 0, tight: true, segs: [S('loop caught', 'warn b')] },
      { flex: live.kl === 're-fetch loop' ? `${live.call} re-run ${live.n}× with different limits` : `${live.call} failed ${live.n}× with the same error`, min: 18 },
      { p: 0, segs: [S(fkd(live.wasted), 'fg'), S(' wasted est.', 'dim')] },
    ]
    if (isApi(v)) items.push({ p: 9, tight: true, segs: [S(`(${ap(live.wasted, v.price)})`, 'dim')] })
  } else {
    const p = top
    items = [
      { p: 0, segs: [S('lessons', 'dim')] },
      { p: 0, tight: true, segs: [S(String(v.props.length), 'accent b')] },
      { p: 8, tight: true, segs: [S('to review', 'fg')] },
      { flex: `${GL[p.kind]} ${p.text}`, min: 24 },
      { p: 0, segs: [S('net ', 'dim'), S(sg(p.netJit), p.netJit < 0 ? 'warn b' : 'ok b'), S(' est.', 'dim')] },
    ]
    if (isApi(v)) items.push({ p: 9, tight: true, segs: [S(`(${ap(p.netJit, v.price)})`, 'dim')] })
  }
  items.push(...hint)
  return fit(lr(flexRow(items, lw), right, w), w)
}

// ---- pane --------------------------------------------------------------------------------------
function tabsRow(v: View, iw: number): Seg[] {
  const counts = [v.props.length, v.active.length, v.loops.length, v.cands.length]
  const wide = iw >= 50
  const o: Seg[] = []
  TABS.forEach((n, i) => {
    if (i) o.push(S(' '))
    const label = wide || i === v.ui.tab ? `${n} ${counts[i]}` : n
    o.push(i === v.ui.tab ? Bt(label, `tab:${i}`, true) : wide ? Bt(label, `tab:${i}`) : Sm(label, `tab:${i}`))
  })
  return o
}

export function lessonsPane(v: View, iw: number): Seg[][] {
  const out: Seg[][] = [lr([S('Lessons', 'fg b')], [S(modeLabel(v), 'dim')], iw), tabsRow(v, iw), [S('─'.repeat(iw), 'line')]]
  if (v.ui.msg && v.ui.view === 'list') out.push(lr([S(cut(v.ui.msg, iw - 12), 'fg')], v.canUndo ? [Bt('Undo', 'undo')] : [], iw), [])
  const confirm = confirmView(v, iw)
  if (confirm) out.push(...confirm)
  else if (v.ui.tab === 0) out.push(...proposals(v, iw))
  else if (v.ui.tab === 1) out.push(...active(v, iw))
  else if (v.ui.tab === 2) out.push(...loopsTab(v, iw))
  else out.push(...memory(v, iw))
  out.push([], [S('Tab moves · Enter presses · Esc closes', 'dim')])
  return out.map(l => fit(l, iw))
}

function metaLine(v: View, p: Proposal, iw: number): Seg[] {
  const net = [S('net ', 'dim'), S(sg(p.netJit), p.netJit < 0 ? 'warn b' : 'ok b')]
  const parts = (): Seg[][] => [[S(`${p.n}×`, 'fg')], [S('saved ', 'dim'), S(fkd(p.saved), 'fg')], [S('carry ', 'dim'), S(fkd(p.carryJit), 'fg')], net]
  const join = (a: Seg[][], sep: string): Seg[] => {
    const o: Seg[] = []
    a.forEach((x, i) => {
      if (i) o.push(S(sep, 'dim'))
      o.push(...x)
    })
    return o
  }
  const cands = [
    join([...parts(), ...(isApi(v) ? [[S(ap(p.netJit, v.price), 'dim')]] : [])], ' · '),
    join(parts(), ' · '),
    join(parts(), '  '),
    join(parts(), ' '),
  ]
  return cands.find(c => len(c) <= iw - 6) ?? cands[3]
}

function deliver(v: View, p: Proposal, iw: number): Seg[][] {
  const neg = p.netJit < 0
  const num = (c: number, n: number): Seg[] => [S(padL(fkd(c), 7), 'fg'), S(padL(sg(n), 9), n < 0 ? 'warn b' : 'ok b')]
  const o: Seg[][] = []
  o.push(lr([S('    Deliver as', 'fg b')], [S(padL('carry', 7), 'dim'), S(padL('net', 9), 'dim')], iw))
  o.push(lr([S('    '), Bt('Just in time', `jit:${p.id}`, false, neg)], num(p.carryJit, p.netJit), iw))
  o.push(...ind(6, wrap(`${neg ? '' : 'Recommended. '}Shown to the model when ${p.matcher.label} runs: once a session, once more if it fails again.`, iw - 6, 'dim')))
  o.push(lr([S('    '), Bt('Always on', `alw:${p.id}`, false, p.netAlways < 0)], num(p.carryAlways, p.netAlways), iw))
  o.push(...ind(6, wrap('Written to CLAUDE.local.md. Read every turn.', iw - 6, 'dim')))
  if (isApi(v)) o.push(...ind(6, wrap(`net ≈ ${usd(p.netJit, v.price)} / ${usd(p.netAlways, v.price)} per session, est.`, iw - 6, 'dim')))
  if (neg) {
    o.push([])
    o.push(...ind(4, wrap("Costs more than it saves at this session's rate (est.). Dismiss is probably right.", iw - 4, 'warn')))
  }
  return o
}

function proposals(v: View, iw: number): Seg[][] {
  if (v.props.length === 0) return empty(v, iw)
  const b: Seg[][] = [lr([S(`${v.props.length} proposal${v.props.length === 1 ? '' : 's'}`, 'fg b')], iw >= 50 ? [S('tokens per session, est.', 'dim')] : [S('per session', 'dim')], iw)]
  b.push(...wrap('Saved is measured this session. Carry and net are estimates.', iw, 'dim'))
  b.push([S('✕ failure  ↻ loop  ↩ correction', 'dim')], [])
  v.props.forEach((p, i) => {
    const open = p.id === v.ui.open
    const neg = p.netJit < 0
    const head: Seg[] = [Sm(open ? '−' : '+', `exp:${p.id}`), S(' '), S(GL[p.kind], neg ? 'dim' : 'fg'), S(' ')]
    b.push([...head, S(trunc(p.text, iw - len(head)), neg ? 'dim' : 'fg')])
    b.push([S('      '), ...metaLine(v, p, iw)])
    if (open) {
      b.push([])
      b.push(...block(p.text, iw, 4, 'rule'))
      b.push([S('    Evidence', 'fg b'), S(` · ${p.turns ? (p.n > 1 ? 'turns ' : 'turn ') + p.turns : p.kl}`, 'dim')])
      // The same call repeated in one turn reads once, with a count.
      const evs: Array<[string, number]> = []
      for (const e of p.ev) {
        const last = evs[evs.length - 1]
        if (last && last[0] === e) last[1]++
        else evs.push([e, 1])
      }
      evs.slice(0, 3).forEach(([e, n]) => b.push([S('    '), S(cut(n > 1 ? `${e}  ×${n}` : e, iw - 4), 'code')]))
      if (p.n > p.ev.length) b.push([S(`    + ${p.n - p.ev.length} more like these`, 'dim')])
      b.push([])
      b.push(...deliver(v, p, iw))
      b.push([])
      b.push([S('    '), Bt('Dismiss', `dis:${p.id}`), S('  '), Bt('Polish wording', `pol:${p.id}`)])
      b.push(...ind(4, wrap('Only Polish wording sends anything: the rule and its evidence, to the model. Otherwise nothing leaves this machine.', iw - 4, 'dim')))
    }
    if (i < v.props.length - 1) b.push([])
  })
  return b
}

function empty(v: View, iw: number): Seg[][] {
  if (v.turns < 5 && v.failures + v.corrections === 0)
    return [
      [S('Watching this session.', 'fg b')],
      [],
      [S('Proposals appear here when:', 'fg')],
      [S('  ✕ ', 'fg'), S('a tool call fails', 'fg')],
      [S('  ↻ ', 'fg'), S('the same call repeats 3+ times', 'fg')],
      [S('  ↩ ', 'fg'), S('you interrupt or reject something', 'fg')],
      [],
      ...wrap('Nothing is written until you accept it. Lessons runs on this machine; nothing is sent anywhere.', iw, 'dim'),
    ]
  const fired = v.active.reduce((n, a) => n + (a.st === 'ok' ? 1 : 0), 0)
  const o: Seg[][] = [[S('Nothing to learn this session.', 'fg b')], [], [S(`${v.turns} turns · ${v.failures} failures · ${v.loops.length} loops · ${v.corrections} corrections`, 'fg')], []]
  if (v.active.length) o.push([S('● ', 'ok'), S(`${v.active.length} active rule${v.active.length === 1 ? '' : 's'}${fired ? `, ${fired} fired` : ''}, ${v.active.some(a => a.st === 'warn') ? 'some recurred' : 'none recurred'}.`, 'fg')], [])
  o.push(...wrap('The band stays hidden until something is worth a rule.', iw, 'dim'))
  return o
}

const GLY = { ok: '●', warn: '▲', dim: '○' } as const

function active(v: View, iw: number): Seg[][] {
  if (v.active.length === 0) return [[S('No rules yet.', 'fg b')], ...wrap('Accepted rules appear here, with whether the failure came back.', iw, 'dim')]
  const rec = v.active.filter(a => a.st === 'warn').length
  const b: Seg[][] = [[S(`${v.active.length} active`, 'fg b'), ...(rec ? [S(' · ', 'dim'), S(`${rec} recurred`, 'warn')] : [])], []]
  v.active.forEach((a, i) => {
    b.push(lr([S(trunc(a.text, iw - 12), 'fg')], [Bt('Retire', `ret:${a.id}`)], iw))
    b.push([S('  ' + cut(a.where, iw - 2), 'dim')])
    const role = a.st === 'warn' ? 'warn' : a.st === 'ok' ? 'fg' : 'dim'
    wrap(`${a.a} · ${a.b}`, iw - 4, role).forEach((l, j) => b.push([S(j ? '    ' : '  '), ...(j ? [] : [S(GLY[a.st], a.st), S(' ')]), ...l]))
    if (i < v.active.length - 1) b.push([])
  })
  b.push([])
  b.push(...wrap('Recurred means the same failure happened again after the rule was accepted. Retire removes the rule; you can undo it until the next turn.', iw, 'dim'))
  return b
}

function spark(vals: number[], n: number): string[] {
  const mx = Math.max(1, ...vals)
  return vals.map(x => ' ▁▂▃▄▅▆▇█'[Math.max(1, Math.round((x / mx) * 8))].repeat(n))
}

function loopsTab(v: View, iw: number): Seg[][] {
  const tot = v.loops.reduce((a, l) => a + l.wasted, 0)
  if (v.loops.length === 0) {
    const o: Seg[][] = [[S('Nothing wasted this session.', 'fg b')], []]
    return [...o, ...trendBlock(v, iw)]
  }
  const b: Seg[][] = [lr([S('This session', 'fg b')], [S(`${fkd(tot)} wasted`, 'fg'), S(' est.', 'dim'), ...(isApi(v) ? [S(` ${ap(tot, v.price)}`, 'dim')] : [])], iw), []]
  v.loops.forEach(L => {
    const open = L.live || v.ui.open === L.sig
    const head: Seg[] = [Sm(open ? '−' : '+', `lp:${L.sig}`), S(' ↻ ', 'fg')]
    b.push(lr([...head, S(trunc(L.call, iw - len(head) - 13), 'fg')], [S(padL(`${L.n}×`, 4), 'fg'), S(padL(fkd(L.wasted), 7), L.live ? 'warn b' : 'fg')], iw))
    if (L.live) b.push([S(`      ${L.kl} · `, 'dim'), S('live, still counting', 'warn')])
    else if (L.proposal) {
      const long: Seg[] = [S(`      ${L.kl} · became a proposal  `, 'dim'), Bt('View', `view:${L.proposal}`)]
      b.push(len(long) <= iw ? long : [S(`      ${L.kl} · proposal  `, 'dim'), Bt('View', `view:${L.proposal}`)])
    } else b.push([S(`      ${L.kl} · ended`, 'dim')])
    if (open) {
      if (L.err) b.push([S('      '), S(cut(L.err, iw - 6), 'code')])
      if (L.note) {
        b.push([])
        b.push(...ind(6, wrap(`Added to the model's next turn (${Math.ceil(L.note.length / 4)} tokens, not saved):`, iw - 6, 'fg')))
        b.push(...block(L.note, iw, 6, 'note'))
        b.push(...ind(6, wrap('When a different call runs, the loop ends and becomes a proposal.', iw - 6, 'dim')))
      }
    }
    b.push([])
  })
  return [...b, ...trendBlock(v, iw)]
}

function trendBlock(v: View, iw: number): Seg[][] {
  const vals = v.trend.map(t => t.w)
  if (vals.length === 0) return wrap('Waste per session shows here once a few sessions have finished.', iw, 'dim')
  const sw = iw >= 50 ? 3 : 2
  const sk = spark(vals, sw)
  const row: Seg[] = [S('  ')]
  sk.forEach((c, i) => {
    row.push(S(c, i === sk.length - 1 ? 'accent' : v.trend[i].r ? 'ok' : 'dim'))
    row.push(S(' '))
  })
  return [
    lr([S('Waste per session', 'fg b')], [S(`last ${vals.length}`, 'dim')], iw),
    row,
    ...wrap(`${fkd(vals[0])} → ${fkd(vals[vals.length - 1])} (est.). Green: sessions after a rule was accepted.`, iw, 'dim'),
  ]
}

function memory(v: View, iw: number): Seg[][] {
  if (!v.hasMemory) return [[S('No CLAUDE.md files in this repo.', 'fg b')], ...wrap('Instruction files above the working directory show here with what carrying each line costs.', iw, 'dim')]
  const freed = v.cands.reduce((n, c) => n + c.tokens, 0)
  const b: Seg[][] = [
    lr([S('Memory files', 'fg b')], [S(`${fkd(v.memTokens)}/turn total`, 'dim')], iw),
    [S(`${v.cands.length} removal candidate${v.cands.length === 1 ? '' : 's'}`, 'fg'), S(' · ', 'dim'), S(`${fkd(freed)}/turn`, 'fg')],
    [],
  ]
  const item = (c: Cand, cand: boolean) => {
    const loc = `${c.file}:${c.from}  `
    b.push(lr([S(loc, 'dim'), S(trunc(c.text, iw - [...loc].length - 10), 'code')], [S(padL(`${fkd(c.tokens)}/turn`, 9), 'fg')], iw))
    b.push(...ind(2, wrap(`${c.st}: ${c.why} (est.)`, iw - 2, c.st === 'stale' ? 'warn' : c.st === 'in use' ? 'ok' : 'dim')))
    if (cand) {
      const per = c.tokens * Math.max(1, v.turns)
      b.push(lr([S(`  ${fkd(per)}/session`, 'fg'), S(isApi(v) && iw >= 50 ? ` ${ap(per, v.price)}` : '', 'dim')], [Bt('Remove…', `rm:${c.id}`), S(' '), Bt('Keep', `keep:${c.id}`)], iw))
    }
    b.push([])
  }
  v.cands.forEach(c => item(c, true))
  if (v.cands.length === 0) b.push([S('Nothing looks removable.', 'fg')], [])
  if (v.inUse.length) {
    b.push([S('In use', 'fg b')])
    v.inUse.slice(0, 5).forEach(c => item(c, false))
  }
  b.push(...wrap("Lessons can't see whether the model used a line. Stale and never triggered are guesses from activity in this repo.", iw, 'dim'))
  return b
}

// ---- confirm views --------------------------------------------------------------------------------
function confirmView(v: View, iw: number): Seg[][] | null {
  const u = v.ui
  const p = v.props.find(x => x.id === u.id)
  const b: Seg[][] = []
  if ((u.view === 'jit' || u.view === 'always') && p) {
    const j = u.view === 'jit'
    b.push([S('Accept · ', 'dim'), S(j ? 'just in time' : 'always on', 'fg b')], [])
    if (j) {
      b.push([S('Writes to   ', 'dim'), S("Lessons' local store", 'code')])
      b.push([S('            ', 'dim'), S(cut('this machine only, not in the repo', iw - 12), 'dim')])
      b.push([S('Shown when  ', 'dim'), S(p.matcher.label, 'code'), S(' runs', 'dim')], [])
      b.push(...block(p.text, iw, 0, 'rule'))
    } else {
      const a = v.append
      b.push([S('Appends to  ', 'dim'), S(a?.file ?? 'CLAUDE.local.md', 'code'), S(a ? `, line ${a.line}` : '', 'dim')], [])
      const tw = Math.max(8, iw - 4 - 7)
      const raw: Seg[][] = []
      if (a?.prev) raw.push([S(`  ${String(a.line - 1).padEnd(4)}`, 'dim'), S(cut(a.prev, tw), 'dim')])
      wrap(p.text, tw, 'code').forEach((l, i) => raw.push([S(i ? '      ' : `+ ${String(a?.line ?? 1).padEnd(4)}`, 'ok'), ...l]))
      b.push(...block('', iw, 0, 'diff', raw))
    }
    const c = j ? p.carryJit : p.carryAlways
    const n = j ? p.netJit : p.netAlways
    b.push([S('Carry ', 'dim'), S(`${fkd(c)}/session`, 'fg'), S(' · net ', 'dim'), S(sg(n), n < 0 ? 'warn b' : 'ok b'), S(` est.${isApi(v) ? ' ' + ap(n, v.price) : ''}`, 'dim')])
    b.push(...wrap('Nothing leaves this machine.', iw, 'dim'), [])
    b.push([Bt('Write rule', 'write', true), S('  '), Bt('Back', 'back')])
    return b
  }
  if (u.view === 'written') {
    b.push([S('✓ ', 'ok'), S(cut(u.msg || 'Written', iw - 2), 'fg b')], [])
    b.push(...wrap('Active from your next turn. Undo reverses it; it is available until the next turn.', iw, 'fg'), [])
    b.push([Bt('Undo', 'undo'), S('  '), Bt('Next proposal', 'next', true)])
    return b
  }
  if (u.view === 'error') {
    b.push([S('✕ ', 'err'), S("Couldn't write", 'fg b')], [])
    b.push(...wrap(`${u.msg || 'The write failed.'} Nothing changed. The proposal is still here.`, iw, 'fg'), [])
    b.push([Bt('Try again', 'write', true), S('  '), Bt('Back', 'back')])
    return b
  }
  if (u.view === 'polish' && p) {
    const tok = Math.ceil((p.text.length + p.ev.slice(0, 3).join('').length) / 4) + 60
    b.push([S('Polish wording', 'fg b')], [])
    b.push(...wrap(`Sends the rule text and its ${Math.min(3, p.ev.length)} evidence lines to the model to tighten the wording. About ${tok} tokens${isApi(v) ? ` (${usd(tok, v.price)})` : ''}, est. Nothing else from this session is sent.`, iw, 'fg'), [])
    b.push([Bt('Send', 'send', true), S('  '), Bt('Cancel', 'back')])
    return b
  }
  if (u.view === 'sending') return [[S('Polish wording', 'fg b')], [], [S('Asking the model…', 'dim')]]
  if (u.view === 'polished' && p) {
    b.push([S('Polish wording', 'fg b'), S(' · from the model', 'dim')], [])
    b.push(...block(p.text, iw, 0, 'yours'))
    b.push(...block(u.polished, iw, 0, 'polished'))
    b.push([])
    b.push([Bt('Use polished', 'usepol', true), S('  '), Bt('Keep mine', 'back')])
    return b
  }
  if (u.view === 'retire') {
    const a = v.active.find(x => x.id === u.id)
    if (!a) return null
    b.push([S('Retire this rule?', 'fg b')], [])
    b.push(...block(a.text, iw, 0, 'rule'))
    b.push(...wrap(a.where.includes('always on') ? 'The line is removed from CLAUDE.local.md.' : 'It stops being shown to the model.', iw, 'dim'), [])
    b.push([Bt('Retire', 'retYes', true), S('  '), Bt('Keep', 'back')])
    return b
  }
  if (u.view === 'remove' && v.removal) {
    const r = v.removal
    const raw: Seg[][] = r.lines.slice(0, 3).map((l, i) => [S(`− ${String(r.from + i).padEnd(4)}`, 'err'), S(cut(l, iw - 10), 'code')])
    if (r.lines.length > 3) raw.push([S(`  … ${r.lines.length - 3} more lines (${r.from + 3}–${r.to})`, 'dim')])
    b.push([S(`Remove from ${r.file}`, 'fg b')], [])
    b.push(...block('', iw, 0, 'diff', raw))
    b.push([S('Frees ', 'dim'), S(`${fkd(r.tokens)}/turn`, 'fg'), S(' · ', 'dim'), S(`${fkd(r.tokens * Math.max(1, v.turns))}/session`, 'fg'), S(' est.', 'dim')])
    b.push(...wrap("A copy is kept in Lessons' local store so you can undo this until the next turn.", iw, 'dim'), [])
    b.push([Bt(`Remove ${r.lines.length} line${r.lines.length === 1 ? '' : 's'}`, 'rmYes', true), S('  '), Bt('Back', 'back')])
    return b
  }
  return null
}

// ---- toast ---------------------------------------------------------------------------------------
export function toastText(call: string, n: number, wasted: number, price: number | null, mode: 'api' | 'sub', refetch = false): string {
  const w = mode === 'api' && price !== null ? `${fkd(wasted)} wasted, est., ~${usd(wasted, price)}` : `${fkd(wasted)} tokens wasted, est.`
  return `Caught a loop: ${call} ${refetch ? `re-run ${n}× with different limits` : `failed ${n}× with the same error`} (${w}). Added a one-line note to the model's next turn. Details in /lessons.`
}

// ---- row ------------------------------------------------------------------------------------------
type El = { Box: any; Text: any; Button: any }
const noop = () => {}

const styleOf = (s: Seg): Record<string, unknown> => {
  const p: Record<string, unknown> = {}
  if (s.c) p.color = s.c
  else if (s.r === 'accent') p.color = 'claude'
  else if (s.r === 'ok') p.color = 'success'
  else if (s.r === 'warn') p.color = 'warning'
  else if (s.r === 'err') p.color = 'error'
  else if (s.r === 'dim' || s.r === 'line') p.dimColor = true
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
          <Text key={`${key}.${i}`} {...styleOf(s)}>
            {s.t}
          </Text>
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
          <Text key={`${key}.${i}`} {...styleOf(s)}>
            {s.t}
          </Text>
        ),
      )}
    </Box>
  )
}
