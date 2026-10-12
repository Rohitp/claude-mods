import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Rule, Ui } from '../types'
import { fit } from './layout'
import {
  DEFAULT_UI,
  JIT_SHOWS,
  activeRows,
  emptyHistory,
  idOf,
  interrupted,
  isRepoPath,
  keyOf,
  liveHint,
  loopRows,
  lineOf,
  loopSize,
  matcherFor,
  matches,
  memoryCandidates,
  missKey,
  priceOf,
  propose,
  refsOf,
  removeLines,
  restoreLines,
  sanitizeEntries,
  sanitizeHistory,
  sanitizeRules,
  sanitizeUi,
  sessionWaste,
  shouldHint,
  tokensOf,
  track,
  turnsPerSession,
  upsertBlock,
  wasLoop,
  wastedTokens,
} from './model'
import type { Cand, Entry, History, MemFile, Proposal } from './model'
import { lessonsBandDesktop, lessonsPaneDesktop } from './desktop'
import type { DesktopEl } from './desktop'
import { lessonsBand, lessonsPane, row, toastText } from './terminal'
import type { Acts, View } from './terminal'

const PLUGIN = 'lessons'
const PANE = 'lessons'
const TITLE = 'Lessons'
const LOCAL_FILE = 'CLAUDE.local.md'
const MEM_NAMES = ['CLAUDE.md', 'CLAUDE.local.md']
const MEM_TTL_MS = 30_000

const uiAtom = atom({ plugin: 'lessons', key: 'ui' } as const, DEFAULT_UI)

// Per session, in memory; a reload starts these over. What was approved lives in the store.
const entries = new Map<string, Entry>()
const shown = new Map<string, number>()
const dismissed = new Set<string>()
const kept = new Set<string>()
const override = new Map<string, string>()
const inflight = new Map<string, { tool: string; input: Record<string, unknown>; turn: number }>()
const usedNow = new Set<string>()
let rules: Rule[] = []
let history: History = emptyHistory()
let projKey = ''
let isLoaded = false
let isLive = true
let billing: 'api' | 'sub' = 'api'
let undo: { kind: 'rule' | 'dismiss' | 'retire' | 'remove' | 'keep'; id: string; rule?: Rule; path?: string; from?: number; lines?: string[] } | null = null
let signature = ''
let mem: { at: number; files: MemFile[]; cands: Cand[]; inUse: Cand[]; tokens: number } | null = null

// ---- small helpers -----------------------------------------------------------------------------
function log($: EngineInterface, event: string, fields: Record<string, string | number | boolean> = {}) {
  const kv = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ')
  $.ui.log(`${PLUGIN} ${event}${kv ? ' ' + kv : ''}`, { to: 'debug' })
}

async function setUi($: EngineInterface, patch: Partial<Ui>) {
  await update($, uiAtom, u => ({ ...sanitizeUi(u), ...patch, rev: sanitizeUi(u).rev + 1 }))
}

/** A change a drawing reads from module memory: redraw the readers. */
async function touch($: EngineInterface) {
  await update($, uiAtom, u => ({ ...sanitizeUi(u), rev: sanitizeUi(u).rev + 1 }))
}

/** Loads the project's rules, history and the session's tracked calls once; every hook calls it, so
 * a hot reload that does not raise `session.start` still comes back with its state. */
async function ensureLoaded($: EngineInterface) {
  if (isLoaded) return
  isLoaded = true
  projKey = idOf(await $.session.root())
  rules = sanitizeRules(await $.store.get(`rules:${projKey}`))
  history = sanitizeHistory(await $.store.get(`history:${projKey}`))
  for (const k of history.kept) kept.add(k)
  const saved = (await $.store.get(`session:${projKey}`)) as { id?: string; entries?: unknown; used?: unknown } | null
  if (saved && saved.id === (await $.session.id())) {
    for (const e2 of sanitizeEntries(saved.entries)) if (!entries.has(e2.sig)) entries.set(e2.sig, e2)
    if (Array.isArray(saved.used)) for (const u of saved.used) if (typeof u === 'string') usedNow.add(u)
  }
  log($, 'loaded', { rules: rules.length, sessions: history.sessions, restored: entries.size })
}

async function save($: EngineInterface) {
  await $.store.set(`rules:${projKey}`, rules)
  await $.store.set(`history:${projKey}`, { ...history, kept: [...kept].slice(-100) })
}

/** The session's tracked calls, kept so a reload or a resume does not start from nothing. */
async function saveSession($: EngineInterface) {
  await $.store.set(`session:${projKey}`, { id: await $.session.id(), entries: [...entries.values()].slice(-200), used: [...usedNow].slice(0, 300) })
}

const localPath = async ($: EngineInterface) => `${await $.session.root()}/${LOCAL_FILE}`

async function readText($: EngineInterface, path: string): Promise<string | null> {
  if (!(await $.fs.exists(path))) return null
  const t = await $.fs.read(path)
  return typeof t === 'string' ? t : null
}

/** Rewrites only the marked block of CLAUDE.local.md; returns the path. */
async function syncFile($: EngineInterface): Promise<string> {
  const path = await localPath($)
  const old = (await readText($, path)) ?? ''
  const always = rules.filter(r => r.mode === 'always').map(r => r.text)
  if (old === '' && always.length === 0) return path
  await $.fs.write(path, upsertBlock(old, always))
  return path
}

// ---- memory ---------------------------------------------------------------------------------------
async function loadMemory($: EngineInterface, force = false) {
  const now = await $.clock.now()
  if (!force && mem && now - mem.at < MEM_TTL_MS) return mem
  const found = await $.fs.ancestors({ names: MEM_NAMES })
  const files: MemFile[] = found.map(f => ({ name: f.name, content: f.content, dir: f.dir }))
  const root = await $.session.root()
  const cwd = await $.session.cwd()
  const missing = new Set<string>()
  let checked = 0
  for (const f of files) {
    for (const ref of refsOf(f.content).paths) {
      if (!isRepoPath(ref) || checked >= 60 || missing.has(missKey(f.dir, ref))) continue
      checked++
      let found = false
      for (const base of [f.dir ?? root, root, cwd]) {
        if (await $.fs.exists(`${base.replace(/\/$/, '')}/${ref}`)) {
          found = true
          break
        }
      }
      if (!found) missing.add(missKey(f.dir, ref))
    }
  }
  const { cands, inUse } = memoryCandidates(files, history.used, history.sessions, missing)
  const tokens = files.reduce((n, f) => n + Math.ceil(f.content.length / 4), 0)
  mem = { at: now, files, cands: cands.filter(c => !kept.has(c.id)), inUse, tokens }
  return mem
}

// ---- view -----------------------------------------------------------------------------------------
async function buildView($: EngineInterface): Promise<View> {
  await ensureLoaded($)
  const ui = sanitizeUi(await read($, uiAtom))
  const turns = await $.session.turns()
  const perSession = Math.max(turns, turnsPerSession(history))
  const taken = new Set(rules.map(r => r.sig))
  const props: Proposal[] = propose(entries, taken, perSession, dismissed).map(p => {
    const t = override.get(p.id)
    if (t === undefined) return p
    // Polished wording changes what the rule costs to carry.
    const tokens = tokensOf(t)
    const carryJit = tokens * Math.min(p.fires, JIT_SHOWS)
    const carryAlways = tokens * Math.max(1, perSession)
    return { ...p, text: t, tokens, carryJit, carryAlways, netJit: p.saved - carryJit, netAlways: p.saved - carryAlways }
  })
  const model = await $.session.model()
  const m = ui.tab === 3 || ui.view === 'remove' ? await loadMemory($) : mem
  let failures = 0
  let corrections = 0
  for (const e of entries.values()) {
    failures += e.errors
    corrections += e.corrections
  }
  let append: View['append'] = null
  if (ui.view === 'always') {
    const p = props.find(x => x.id === ui.id)
    if (p) {
      const path = await localPath($)
      const old = (await readText($, path)) ?? ''
      const texts = [...rules.filter(r => r.mode === 'always').map(r => r.text), p.text]
      const line = lineOf(old, texts, p.text)
      append = { file: LOCAL_FILE, line, prev: upsertBlock(old, texts).split('\n')[Math.max(0, line - 2)] ?? '' }
    }
  }
  let removal: View['removal'] = null
  if (ui.view === 'remove' && m) {
    const c = m.cands.find(x => x.id === ui.id)
    const f = c && m.files.find(x => x.name === c.file)
    if (c && f) removal = { file: c.file, from: c.from, to: c.to, lines: f.content.split('\n').slice(c.from - 1, c.to), tokens: c.tokens }
  }
  return {
    mode: billing,
    price: priceOf(model),
    props,
    active: activeRows(rules, history.sessions),
    loops: loopRows(entries, new Set(props.map(p => p.id))),
    cands: m?.cands ?? [],
    inUse: m?.inUse ?? [],
    memTokens: m?.tokens ?? 0,
    hasMemory: (m?.files.length ?? 0) > 0,
    turns,
    sessions: history.sessions,
    failures,
    corrections,
    trend: [...history.trend, { w: sessionWaste(entries), r: rules.length > 0 }].slice(-10),
    ui,
    openId: ui.open === null ? (props[0]?.id ?? null) : ui.open === '' ? null : ui.open,
    canUndo: undo !== null,
    append,
    removal,
  }
}

// ---- actions --------------------------------------------------------------------------------------
async function accept($: EngineInterface, p: Proposal, mode: 'jit' | 'always'): Promise<string> {
  const now = await $.clock.now()
  const rule: Rule = {
    id: p.id,
    sig: p.sig,
    tool: p.tool,
    text: p.text,
    mode,
    matcher: p.matcher.label,
    tools: p.matcher.tools,
    prefix: p.matcher.prefix,
    line: 0,
    at: now,
    fired: 0,
    recurred: 0,
  }
  let where = "Lessons' local store"
  if (mode === 'always') {
    const path = await localPath($)
    const old = (await readText($, path)) ?? ''
    const texts = [...rules.filter(r => r.mode === 'always').map(r => r.text), p.text]
    rule.line = lineOf(old, texts, p.text)
    rules = [...rules.filter(r => r.id !== rule.id), rule]
    try {
      const written = await syncFile($)
      where = `${LOCAL_FILE}:${rule.line}`
      log($, 'write', { mode, path: written === path ? 'local' : 'other' })
    } catch (err) {
      rules = rules.filter(r => r.id !== rule.id)
      throw err
    }
  } else rules = [...rules.filter(r => r.id !== rule.id), rule]
  await save($)
  undo = { kind: 'rule', id: rule.id, rule }
  mem = null
  return where
}

async function doWrite($: EngineInterface) {
  const ui = sanitizeUi(await read($, uiAtom))
  const p = (await buildView($)).props.find(x => x.id === ui.id)
  if (!p) return setUi($, { view: 'list', msg: 'That proposal is no longer open.' })
  try {
    const where = await accept($, p, ui.view === 'always' ? 'always' : 'jit')
    await setUi($, { view: 'written', msg: `Written to ${where}`, open: null })
  } catch (err) {
    log($, 'error', { where: 'write', msg: String(err).slice(0, 80) })
    await setUi($, { view: 'error', msg: err instanceof Error ? err.message : 'The write failed.' })
  }
}

async function doUndo($: EngineInterface) {
  const u = undo
  if (!u) return
  undo = null
  if (u.kind === 'rule' && u.rule) {
    rules = rules.filter(r => r.id !== u.id)
    if (u.rule.mode === 'always') await syncFile($)
    await save($)
    await setUi($, { view: 'list', tab: 0, open: u.id, msg: '' })
  } else if (u.kind === 'dismiss') {
    dismissed.delete(u.id)
    await setUi($, { view: 'list', tab: 0, open: u.id, msg: '' })
  } else if (u.kind === 'retire' && u.rule) {
    rules = [...rules, u.rule]
    if (u.rule.mode === 'always') await syncFile($)
    await save($)
    await setUi($, { view: 'list', tab: 1, msg: '' })
  } else if (u.kind === 'remove' && u.path && u.lines && u.from) {
    const cur = (await readText($, u.path)) ?? ''
    await $.fs.write(u.path, restoreLines(cur, u.from, u.lines))
    mem = null
    await setUi($, { view: 'list', tab: 3, msg: '' })
  } else if (u.kind === 'keep') {
    kept.delete(u.id)
    await save($)
    await setUi($, { view: 'list', msg: '' })
  }
}

async function doPolish($: EngineInterface) {
  const ui = sanitizeUi(await read($, uiAtom))
  const p = (await buildView($)).props.find(x => x.id === ui.id)
  if (!p) return setUi($, { view: 'list' })
  await setUi($, { view: 'sending' })
  const r = await $.model.complete({
    model: 'haiku',
    system: 'You tighten one rule for a coding agent. Reply with the rewritten rule only, one or two sentences, under 160 characters, keeping every command and path exactly.',
    prompt: `Rule: ${p.text}\nEvidence:\n${p.ev.slice(0, 3).join('\n')}`,
    maxTokens: 120,
  })
  if (r.isAnswered && r.text.trim()) {
    log($, 'polish', { ok: true, out: r.usage.output_tokens })
    await setUi($, { view: 'polished', polished: r.text.trim().slice(0, 200) })
  } else {
    log($, 'polish', { ok: false })
    await setUi($, { view: 'list', msg: "Couldn't polish. Your wording is unchanged." })
  }
}

async function doRemove($: EngineInterface) {
  const v = await buildView($)
  const r = v.removal
  if (!r) return setUi($, { view: 'list' })
  const m = await loadMemory($)
  const f = m.files.find(x => x.name === r.file)
  if (!f) return setUi($, { view: 'list' })
  const found = await $.fs.ancestors({ names: [r.file] })
  const target = found.find(x => x.name === r.file)
  if (!target) return setUi($, { view: 'list' })
  const path = `${target.dir.replace(/\/$/, '')}/${r.file}`
  try {
    const { next, removed } = removeLines(target.content, r.from, r.to)
    await $.fs.write(path, next)
    undo = { kind: 'remove', id: v.ui.id, path, from: r.from, lines: removed }
    mem = null
    log($, 'remove', { lines: removed.length })
    await setUi($, { view: 'list', tab: 3, msg: `Removed ${r.file}:${r.from}${r.to > r.from ? '–' + r.to : ''}. Takes effect next turn.` })
  } catch (err) {
    await setUi($, { view: 'error', msg: err instanceof Error ? err.message : 'The write failed.' })
  }
}

function actionsFor($: EngineInterface, v: View, openPane: () => void): Acts {
  const acts: Acts = {
    review: () => {
      openPane()
      const live = v.loops.find(l => l.live)
      void setUi($, { tab: live ? 2 : 0, open: live ? live.sig : (v.props[0]?.id ?? null), view: 'list', msg: '' })
    },
    later: () => void setUi($, { later: v.props.length }),
    write: () => void doWrite($),
    undo: () => void doUndo($),
    back: () => void setUi($, { view: 'list', msg: '' }),
    next: () => void setUi($, { view: 'list', tab: 0, open: v.props[0]?.id ?? null, msg: '' }),
    send: () => void doPolish($),
    usepol: () => {
      override.set(v.ui.id, v.ui.polished)
      void setUi($, { view: 'list', open: v.ui.id, polished: '' })
    },
    retYes: () => {
      const r = rules.find(x => x.id === v.ui.id)
      if (!r) return void setUi($, { view: 'list' })
      rules = rules.filter(x => x.id !== r.id)
      undo = { kind: 'retire', id: r.id, rule: r }
      void (async () => {
        if (r.mode === 'always') await syncFile($)
        await save($)
        await setUi($, { view: 'list', tab: 1, msg: 'Retired.' })
      })()
    },
    rmYes: () => void doRemove($),
  }
  TAB_IDS.forEach(i => {
    acts[`tab:${i}`] = () => void setUi($, { tab: i, view: 'list', msg: '' })
  })
  for (const p of v.props) {
    acts[`exp:${p.id}`] = () => void setUi($, { open: v.openId === p.id ? '' : p.id })
    acts[`jit:${p.id}`] = () => void setUi($, { view: 'jit', id: p.id, msg: '' })
    acts[`alw:${p.id}`] = () => void setUi($, { view: 'always', id: p.id, msg: '' })
    acts[`pol:${p.id}`] = () => void setUi($, { view: 'polish', id: p.id, msg: '' })
    acts[`dis:${p.id}`] = () => {
      dismissed.add(p.id)
      undo = { kind: 'dismiss', id: p.id }
      void setUi($, { open: null, msg: 'Dismissed.' })
    }
  }
  for (const a of v.active) {
    acts[`ret:${a.id}`] = () => void setUi($, { view: 'retire', id: a.id, msg: '' })
  }
  for (const l of v.loops) {
    acts[`lp:${l.sig}`] = () => void setUi($, { open: v.ui.open === l.sig ? null : l.sig })
    if (l.proposal) {
      const id = l.proposal
      acts[`view:${id}`] = () => void setUi($, { tab: 0, open: id, view: 'list' })
    }
  }
  for (const c of v.cands) {
    acts[`rm:${c.id}`] = () => void setUi($, { view: 'remove', id: c.id, msg: '' })
    acts[`keep:${c.id}`] = () => {
      kept.add(c.id)
      undo = { kind: 'keep', id: c.id }
      void (async () => {
        await save($)
        if (mem) mem = { ...mem, cands: mem.cands.filter(x => x.id !== c.id) }
        await setUi($, { msg: 'Kept. It will not be suggested again.' })
      })()
    }
  }
  return acts
}

const TAB_IDS = [0, 1, 2, 3] as const

// ---- tool tracking --------------------------------------------------------------------------------
async function onCall($: EngineInterface, e: Record<string, unknown> & { tool: string }, ran: { text?: string; isError?: boolean; context?: readonly string[] }, turn: number) {
  const { tool, tool_use_id: _id, consent: _c, agentId: _a, ...input } = e as Record<string, unknown> & { tool: string }
  const text = typeof ran.text === 'string' ? ran.text : ''
  const isError = ran.isError === true
  const entry = track(entries, { tool, input, text, isError, at: await $.clock.now(), turn })

  const key = keyOf(tool, input)
  const first = (key.split(/\s+/)[0] ?? '').replace(/^.*\//, '')
  if (tool.toLowerCase() === 'bash' && first) usedNow.add(first)
  else if (key.includes('/')) {
    const parts = key.replace(/^\.\//, '').split('/')
    for (let i = 1; i <= Math.min(3, parts.length); i++) usedNow.add(parts.slice(0, i).join('/'))
    usedNow.add(key.replace(/^\.\//, ''))
  }

  const notes: string[] = []
  for (const rule of rules) {
    if (!matches({ tools: rule.tools.length ? rule.tools : [rule.tool], prefix: rule.prefix, label: rule.matcher }, tool, key)) continue
    if (isError) rule.recurred++
    const times = shown.get(rule.id) ?? 0
    if (rule.mode === 'jit' && times < JIT_SHOWS && (times === 0 || isError)) {
      shown.set(rule.id, times + 1)
      rule.fired++
      notes.push(`Lessons: ${rule.text}`)
    }
  }
  if (!rules.some(r => r.sig === entry.sig) && isLive && shouldHint(entry)) {
    const wasFirst = entry.hinted === 0
    entry.hinted = Math.max(entry.hinted, entry.sameErr, entry.variants.length)
    const hint = liveHint(entry)
    entry.note = hint
    notes.push(hint)
    log($, 'hint', { tool, wasted: wastedTokens(entry), n: entry.hinted })
    if (wasFirst) {
      const model = await $.session.model()
      $.ui.toast(toastText(`${tool} ${entry.sample}`.slice(0, 48), loopSize(entry), wastedTokens(entry), priceOf(model), billing, entry.paged && entry.errors < entry.count))
    }
  }
  if (notes.length) void save($)

  // Redraw only when what the pane or band shows has changed.
  const sig = `${entries.size}:${[...entries.values()].map(x => `${x.count}.${x.errors}.${x.corrections}.${x.peak}`).join(',')}:${rules.map(r => `${r.fired}.${r.recurred}`).join(',')}`
  if (sig !== signature) {
    signature = sig
    await saveSession($)
    await touch($)
  }
  return notes
}

// ---- module -------------------------------------------------------------------------------------------
export const register: Register = (on, options) => {
  isLive = (options as Record<string, unknown>)?.liveHints !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'lessons',
      description: 'Opens Lessons: proposals, active rules, loops and memory; `accept <id> [always]`, `retire <id>` work without the pane',
    })
    await ensureLoaded($)
    log($, 'start', { rules: rules.length, sessions: history.sessions, live: isLive, restored: entries.size })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await ensureLoaded($)
    try {
      const waste = sessionWaste(entries)
      const used = { ...history.used }
      for (const k of usedNow) used[k] = (used[k] ?? 0) + 1
      history = {
        ...history,
        sessions: history.sessions + 1,
        turns: [...history.turns, await $.session.turns()].slice(-20),
        trend: [...history.trend, { w: waste, r: rules.length > 0 }].slice(-10),
        used,
      }
      await save($)
    } catch (err) {
      log($, 'error', { where: 'session.end', msg: String(err).slice(0, 80) })
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    billing = e.rateLimits.length > 0 ? 'sub' : 'api'
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // An undo lasts until the next turn.
    if (undo !== null) {
      undo = null
      await setUi($, { msg: '', view: sanitizeUi(await read($, uiAtom)).view === 'written' ? 'list' : sanitizeUi(await read($, uiAtom)).view })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.isAborted && inflight.size > 0) {
      for (const c of inflight.values()) interrupted(entries, { tool: c.tool, input: c.input, at: 0, turn: c.turn })
      inflight.clear()
      await saveSession($)
      await touch($)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    await ensureLoaded($)
    let turn = 0
    const id = (e as { tool_use_id?: string }).tool_use_id ?? `${Math.random()}`
    try {
      turn = await $.session.turns()
      const { tool, tool_use_id: _i, consent: _c, agentId: _a, ...input } = e as unknown as Record<string, unknown> & { tool: string }
      inflight.set(id, { tool, input, turn })
    } catch {
      // tracking is best effort
    }
    const ran = await next(e)
    inflight.delete(id)
    if (ran.deny !== undefined) return ran
    try {
      const notes = await onCall($, e as unknown as Record<string, unknown> & { tool: string }, ran, turn)
      if (notes.length === 0) return ran
      return { ...ran, context: [...(ran.context ?? []), ...notes] }
    } catch (err) {
      log($, 'error', { where: 'tool.call', msg: String(err).slice(0, 80) })
      return ran
    }
  }).catch(($, e, next) => (next.called ? next(e) : next(e)))

  on('command.run', { command: 'lessons' }, async ($, e) => {
    await ensureLoaded($)
    const [verb, id, how] = e.args.trim().split(/\s+/)
    if (verb === 'accept' && id) {
      const v = await buildView($)
      const p = v.props.find(x => x.id === id)
      if (!p) return { text: `No open proposal ${id}.` }
      try {
        const where = await accept($, p, how === 'always' ? 'always' : 'jit')
        await touch($)
        return { text: `Accepted ${id}: written to ${where}.` }
      } catch (err) {
        return { text: `Couldn't write: ${err instanceof Error ? err.message : 'failed'}. Nothing changed.` }
      }
    }
    if (verb === 'retire' && id) {
      const r = rules.find(x => x.id === id)
      if (!r) return { text: `No active rule ${id}.` }
      rules = rules.filter(x => x.id !== id)
      if (r.mode === 'always') await syncFile($)
      await save($)
      await touch($)
      return { text: `Retired ${id}.` }
    }
    const v = await buildView($)
    const open = await $.ui.open({ id: PANE, title: TITLE })
    await setUi($, { tab: v.loops.some(l => l.live) ? 2 : 0, open: v.props[0]?.id ?? null, view: 'list', msg: '' })
    const n = v.props.length
    return {
      text: `Lessons: ${n} proposal${n === 1 ? '' : 's'}, ${rules.length} active, ${v.loops.length} loop${v.loops.length === 1 ? '' : 's'} this session.${open.isPlaced ? '' : ' Widen the window to see the pane.'}`,
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    try {
      const v = await buildView($)
      const acts = actionsFor($, v, () => void $.ui.open({ id: PANE, title: TITLE }))
      if (e.surface !== 'terminal') return lessonsPaneDesktop($.ui.resolve(e) as DesktopEl, v, acts)
      const lines = lessonsPane(v, Math.max(20, e.props.bodyColumns))
      return <el.Box flexDirection="column">{lines.map((l, i) => row(el, l, acts, `r${i}`))}</el.Box>
    } catch (err) {
      log($, 'error', { where: 'render.pane', msg: String(err).slice(0, 80) })
      return <el.Text dimColor>Lessons could not draw. See claude --debug.</el.Text>
    }
  })

  // Drawn below whatever the plugins beneath draw: the engine shows one tree per site.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    try {
      const v = await buildView($)
      const w = Math.max(20, e.props.bodyColumns)
      // A docked pane narrows this band; it can still be reviewed while the pane is up.
      const isUp = (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced)
      const acts = actionsFor($, v, () => void $.ui.open({ id: PANE, title: TITLE }))
      if (e.surface !== 'terminal') {
        const own = lessonsBandDesktop($.ui.resolve(e) as DesktopEl, v, acts)
        if (!own) return next(e)
        const dk = $.ui.resolve(e) as DesktopEl
        const underneath = await next(e)
        return (
          <dk.Box flexDirection="column">
            {underneath}
            {own}
          </dk.Box>
        )
      }
      const band = lessonsBand(v, w, w >= 110 || isUp)
      if (!band) return next(e)
      const el = $.ui.resolve(e)
      const below = await next(e)
      return (
        <el.Box flexDirection="column">
          {below}
          {row(el, fit(band, w), acts, 'band')}
        </el.Box>
      )
    } catch (err) {
      log($, 'error', { where: 'render.band', msg: String(err).slice(0, 80) })
      return next(e)
    }
  })
}

export { wasLoop, matcherFor, DEFAULT_UI as _DEFAULT_UI }
