// Pure model: call signatures, loops, corrections, priced proposals, memory candidates.
// No engine access, so every number the panes show is testable.
import type { Rule, Seen } from '../types'

export type Category =
  | 'file_not_found'
  | 'command_not_found'
  | 'permission_denied'
  | 'timeout'
  | 'no_matches'
  | 'user_rejected'
  | 'syntax_error'
  | 'exit_code'
  | 'unknown'

export type Entry = {
  tool: string
  sig: string
  sample: string
  count: number
  errors: number
  /** Consecutive failures with the same (digit-collapsed) error text. */
  sameErr: number
  lastErr: string
  /** First line of the last failure as it was written, for display. */
  errLine: string
  category: Category | null
  /** Distinct raw spellings seen, capped. */
  variants: string[]
  /** A pagination or limit fragment was stripped from at least one spelling. */
  paged: boolean
  bytes: number
  inBytes: number
  /** Largest loop this call ever made. */
  peak: number
  /** The person rejected or interrupted this call. */
  corrections: number
  /** Loop size at which the model was last nudged. */
  hinted: number
  /** The note shown to the model for this loop, verbatim. */
  note: string
  ev: string[]
  turns: number[]
  firstAt: number
  lastAt: number
}

export type Call = { tool: string; input: Record<string, unknown>; text: string; isError: boolean; at: number; turn?: number }

export const LOOP_MIN = 3
const HINT_AT = [3, 6, 10]
const MAX_VARIANTS = 8
const MAX_EV = 6
const BYTES_PER_TOKEN = 4
export const RULE_CAP = 160
/** A just-in-time rule is shown once a session, and once more if the call fails again. */
export const JIT_SHOWS = 2

const PAGE =
  /\|\s*(?:head|tail)\s+-n?\s*\d+|\s-n\s*\d+|--max-count[= ]\d+|--lines[= ]\d+|\bhead\s+-\d+|\b(?:limit|offset)[= ]\d+|\bLIMIT\s+\d+|\bOFFSET\s+\d+/gi

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** What identifies a call, spelled so that limit/offset variants of one command collapse. */
export function describe(tool: string, input: Record<string, unknown>): { sig: string; sample: string; raw: string; paged: boolean } {
  const t = tool.toLowerCase()
  if (t === 'bash') {
    const cmd = str(input.command)
    const stripped = cmd.replace(PAGE, '')
    const sig = 'bash:' + stripped.replace(/\b\d+\b/g, '#').replace(/\s+/g, ' ').trim().slice(0, 200)
    return { sig, sample: cmd.replace(/\s+/g, ' ').trim().slice(0, 100), raw: cmd, paged: stripped !== cmd }
  }
  if (t === 'read' || t === 'edit' || t === 'write' || t === 'multiedit') {
    const p = str(input.file_path)
    return { sig: `${t}:${p}`, sample: p, raw: JSON.stringify(input).slice(0, 300), paged: false }
  }
  if (t === 'grep' || t === 'glob') {
    const sample = `${str(input.pattern)} in ${str(input.path) || '.'}`
    return { sig: `${t}:${str(input.pattern)}|${str(input.path)}`, sample, raw: sample, paged: false }
  }
  const raw = JSON.stringify(input)
  return { sig: `${t}:${raw.slice(0, 120)}`, sample: raw.slice(0, 80), raw, paged: false }
}

const RULES: Array<[RegExp, Category]> = [
  [/doesn't want to proceed|user (?:rejected|denied)|was rejected|request interrupted|\[Request interrupted/i, 'user_rejected'],
  [/no such file|not found.*(?:file|path|director)|does not exist|ENOENT/i, 'file_not_found'],
  [/command not found|not recognized as|executable file not found/i, 'command_not_found'],
  [/permission denied|EACCES|operation not permitted|not allowed/i, 'permission_denied'],
  [/timed out|timeout|ETIMEDOUT/i, 'timeout'],
  [/syntax ?error|unexpected token|parse error/i, 'syntax_error'],
  [/exit code|exited with|returned non-zero/i, 'exit_code'],
]

export function categorize(text: string): Category {
  for (const [re, c] of RULES) if (re.test(text)) return c
  return 'unknown'
}

const errKey = (t: string) => t.replace(/\b\d+\b/g, '#').replace(/\s+/g, ' ').trim().slice(0, 160)
const firstLine = (t: string) => (t.split('\n').find(l => l.trim()) ?? '').trim()

function blank(c: Call, d: ReturnType<typeof describe>): Entry {
  return {
    tool: c.tool,
    sig: d.sig,
    sample: d.sample,
    count: 0,
    errors: 0,
    sameErr: 0,
    lastErr: '',
    errLine: '',
    category: null,
    variants: [],
    paged: false,
    bytes: 0,
    inBytes: 0,
    peak: 0,
    corrections: 0,
    hinted: 0,
    note: '',
    ev: [],
    turns: [],
    firstAt: c.at,
    lastAt: c.at,
  }
}

const tag = (n: number | undefined) => (n === undefined ? 't?' : `t${n}`)
function evidence(e: Entry, c: Call, line: string) {
  if (e.ev.length < MAX_EV) e.ev.push(line)
  if (c.turn !== undefined && e.turns.length < 12 && !e.turns.includes(c.turn)) e.turns.push(c.turn)
}

/** Folds one finished call in. Edits and writes reset what was learned about reading that file. */
export function track(map: Map<string, Entry>, c: Call): Entry {
  const t = c.tool.toLowerCase()
  if (t === 'edit' || t === 'write' || t === 'multiedit') map.delete(`read:${str(c.input.file_path)}`)
  const d = describe(c.tool, c.input)
  const e = map.get(d.sig) ?? blank(c, d)
  e.count++
  e.lastAt = c.at
  e.bytes += c.text.length
  e.inBytes += JSON.stringify(c.input).length
  e.paged = e.paged || d.paged
  if (!e.variants.includes(d.raw) && e.variants.length < MAX_VARIANTS) e.variants.push(d.raw)
  if (c.isError) {
    const cat = categorize(c.text)
    e.errors++
    e.category = cat
    if (cat === 'user_rejected') {
      e.corrections++
      e.sameErr = 0
      e.lastErr = ''
      evidence(e, c, `${tag(c.turn)}  you rejected  ${c.tool} ${d.sample}`)
    } else {
      const k = errKey(c.text)
      e.sameErr = k === e.lastErr ? e.sameErr + 1 : 1
      e.lastErr = k
      e.errLine = firstLine(c.text)
      evidence(e, c, `${tag(c.turn)}  ${c.tool}  ${d.sample}  → ${firstLine(c.text)}`)
    }
  } else {
    e.sameErr = 0
    e.lastErr = ''
    if (d.paged || e.paged) evidence(e, c, `${tag(c.turn)}  ${c.tool}  ${d.sample}  → ${c.text.length.toLocaleString('en-US')} chars`)
  }
  e.peak = Math.max(e.peak, loopSize(e))
  map.set(d.sig, e)
  return e
}

/** The person interrupted a turn that was running this call. */
export function interrupted(map: Map<string, Entry>, c: Omit<Call, 'text' | 'isError'>) {
  const d = describe(c.tool, c.input)
  const e = map.get(d.sig) ?? blank({ ...c, text: '', isError: false }, d)
  e.corrections++
  evidence(e, { ...c, text: '', isError: false }, `${tag(c.turn)}  you interrupted  ${c.tool} ${d.sample}`)
  map.set(d.sig, e)
  return e
}

/** Repeating the same failure, or re-running one command with different limits. */
export function loopSize(e: Entry): number {
  if (e.sameErr >= LOOP_MIN) return e.sameErr
  if (e.paged && e.variants.length >= LOOP_MIN && e.errors < e.count) return e.variants.length
  return 0
}

export const isLive = (e: Entry) => loopSize(e) >= LOOP_MIN
export const wasLoop = (e: Entry) => Math.max(e.peak, loopSize(e)) >= LOOP_MIN
/** Kept for callers that only ask "is it a loop". */
export const isLoop = wasLoop

const avgOut = (e: Entry) => (e.count ? e.bytes / e.count : 0)
const avgIn = (e: Entry) => (e.count ? e.inBytes / e.count : 0)

/** Measured, not guessed: repeats beyond the first (loops), failed calls (failures), rejected calls (corrections). */
export function wastedTokens(e: Entry): number {
  const per = (avgOut(e) + avgIn(e)) / BYTES_PER_TOKEN
  const n = Math.max(e.peak, loopSize(e))
  if (n >= LOOP_MIN) return Math.round((n - 1) * (avgOut(e) / BYTES_PER_TOKEN))
  if (e.corrections > 0) return Math.round(e.corrections * per)
  return Math.round(e.errors * per)
}

/** True once per HINT_AT step, so a stuck loop is nudged, not nagged. */
export function shouldHint(e: Entry): boolean {
  const n = loopSize(e)
  const step = [...HINT_AT].reverse().find(s => n >= s)
  return step !== undefined && step > e.hinted
}

const q = (e: Entry) => (e.tool.toLowerCase() === 'bash' ? `\`${e.sample}\`` : `${e.tool} ${e.sample}`)

export function ruleText(e: Entry): string {
  const what = q(e)
  let t: string
  if (e.corrections > 0 && !wasLoop(e)) t = `${what} was rejected or interrupted. Do not repeat it; ask what to do instead.`
  else if (e.paged && e.errors < e.count) t = `${what} was re-run with different limits; ask for the full output once instead of paging.`
  else {
    switch (e.category) {
      case 'file_not_found':
        t = `${what} failed: the path does not exist. Check it with Glob or ls before retrying.`
        break
      case 'command_not_found':
        t = `${what} failed: the command is not available here. Do not retry it; use another tool.`
        break
      case 'permission_denied':
        t = `${what} was denied. Do not retry; ask the person or pick another approach.`
        break
      case 'timeout':
        t = `${what} timed out. Narrow the scope or run it in the background instead of retrying as is.`
        break
      case 'user_rejected':
        t = `${what} was rejected by the person. Do not repeat it; ask what they would prefer.`
        break
      default:
        t = `${what} failed the same way repeatedly. Change the approach instead of retrying.`
    }
  }
  return t.length > RULE_CAP ? t.slice(0, RULE_CAP - 1).replace(/\s+\S*$/, '') + '…' : t
}

/** The one-line note shown to the model right after a result that continues a loop. */
export function liveHint(e: Entry): string {
  const n = loopSize(e)
  const kind = e.paged && e.errors < e.count ? `re-run ${n} times with different limits` : `failed ${n} times in a row with the same error`
  return `Lessons: this call has ${kind}. ${ruleText(e)}`
}

export const tokensOf = (s: string) => Math.max(1, Math.ceil(s.length / BYTES_PER_TOKEN))

// ---- matchers: when a just-in-time rule is shown ------------------------------------------
export type Matcher = { tools: string[]; prefix: string; label: string }

export function matcherFor(e: Entry): Matcher {
  const t = e.tool.toLowerCase()
  if (t === 'bash') {
    const w = e.sample.split(/\s+/)
    const two = w[1] && !w[1].startsWith('-') && !/[|;&<>$]/.test(w[1])
    const prefix = two ? `${w[0]} ${w[1]}` : (w[0] ?? '')
    return { tools: ['Bash'], prefix, label: `Bash(${prefix}*)` }
  }
  if (t === 'read' || t === 'edit' || t === 'write' || t === 'multiedit') {
    const i = e.sample.lastIndexOf('/')
    const dir = i > 0 ? e.sample.slice(0, i + 1) : ''
    return { tools: ['Read', 'Edit'], prefix: dir, label: `Read|Edit(${dir}*)` }
  }
  return { tools: [e.tool], prefix: '', label: `${e.tool}(*)` }
}

export function matches(m: Matcher, tool: string, key: string): boolean {
  if (!m.tools.some(x => x.toLowerCase() === tool.toLowerCase() || (x === 'Edit' && /^(write|multiedit)$/i.test(tool)))) return false
  return m.prefix === '' || key.startsWith(m.prefix)
}

/** What a call is matched on: the command for Bash, the path for file tools. */
export const keyOf = (tool: string, input: Record<string, unknown>) => (tool.toLowerCase() === 'bash' ? str(input.command).trim() : str(input.file_path))

// ---- proposals -----------------------------------------------------------------------------
export type Kind = 'failure' | 'loop' | 'correction'

export type Proposal = {
  id: string
  sig: string
  tool: string
  kind: Kind
  kl: string
  text: string
  n: number
  turns: string
  saved: number
  tokens: number
  fires: number
  carryJit: number
  carryAlways: number
  netJit: number
  netAlways: number
  matcher: Matcher
  ev: string[]
  /** Why this became a proposal, in a sentence or two. */
  why: string
}

export function idOf(sig: string): string {
  let h = 2166136261
  for (let i = 0; i < sig.length; i++) h = Math.imul(h ^ sig.charCodeAt(i), 16777619)
  return (h >>> 0).toString(36).slice(0, 4).padStart(4, '0')
}

export const DEFAULT_TURNS = 60

/** Proposals sorted by just-in-time net. A pattern needs a loop, a correction, or two failures. */
export function propose(map: Map<string, Entry>, taken: Set<string>, turns: number, skip: Set<string> = new Set()): Proposal[] {
  const out: Proposal[] = []
  for (const e of map.values()) {
    if (taken.has(e.sig) || skip.has(idOf(e.sig))) continue
    const loop = wasLoop(e)
    const kind: Kind | null = loop ? 'loop' : e.corrections > 0 ? 'correction' : e.errors >= 2 ? 'failure' : null
    if (!kind) continue
    const text = ruleText(e)
    const m = matcherFor(e)
    let fires = 0
    for (const o of map.values()) if (matches(m, o.tool, o.sample)) fires += o.count
    fires = Math.max(1, fires)
    const tokens = tokensOf(text)
    const saved = wastedTokens(e)
    const n = loop ? Math.max(e.peak, loopSize(e)) : e.corrections > 0 ? e.corrections : e.errors
    out.push({
      id: idOf(e.sig),
      sig: e.sig,
      tool: e.tool,
      kind,
      kl: kind === 'loop' ? (e.paged && e.errors < e.count ? 're-fetch loop' : 'error loop') : kind,
      text,
      n,
      turns: e.turns.join(', '),
      saved,
      tokens,
      fires,
      carryJit: tokens * Math.min(fires, JIT_SHOWS),
      carryAlways: tokens * Math.max(1, turns),
      netJit: saved - tokens * Math.min(fires, JIT_SHOWS),
      netAlways: saved - tokens * Math.max(1, turns),
      matcher: m,
      ev: e.ev.slice(),
      why: whyText(e, kind, n, saved),
    })
  }
  return out.sort((a, b) => b.netJit - a.netJit)
}

/** The reason a pattern became a proposal, from what was measured. */
export function whyText(e: Entry, kind: Kind, n: number, saved: number): string {
  const call = e.tool.toLowerCase() === 'bash' ? `\`${e.sample}\`` : `${e.tool} ${e.sample}`
  const tok = saved > 0 ? ` That is about ${saved.toLocaleString('en-US')} tokens of output you paid for more than once.` : ''
  if (kind === 'correction')
    return `You rejected or interrupted ${call} ${e.corrections === 1 ? 'once' : `${e.corrections} times`}. A rule asks the model to stop before you have to.`
  if (e.paged && e.errors < e.count)
    return `${call} was re-run ${n} times with different limits, each run returning output the previous one had cut off.${tok}`
  const why = e.errLine ? ` with "${e.errLine.slice(0, 80)}"` : ''
  if (kind === 'loop') return `${call} failed ${n} times in a row${why}, and the model retried it the same way each time.${tok}`
  return `${call} failed ${n} times${why}. A rule saves the retries.${tok}`
}

export type LoopRow = { sig: string; at: number; kl: string; call: string; n: number; wasted: number; live: boolean; err: string; note: string; proposal: string | null }

/** This session's loops, live ones first. */
export function loopRows(map: Map<string, Entry>, propIds: Set<string>): LoopRow[] {
  const rows: LoopRow[] = []
  for (const e of map.values()) {
    if (!wasLoop(e)) continue
    const live = isLive(e)
    rows.push({
      sig: e.sig,
      at: e.lastAt,
      kl: e.paged && e.errors < e.count ? 're-fetch loop' : 'error loop',
      call: `${e.tool} ${e.sample}`,
      n: Math.max(e.peak, loopSize(e)),
      wasted: wastedTokens(e),
      live,
      err: e.errLine,
      note: e.note,
      proposal: propIds.has(idOf(e.sig)) ? idOf(e.sig) : null,
    })
  }
  return rows.sort((a, b) => Number(b.live) - Number(a.live) || b.at - a.at)
}

// ---- active rules ----------------------------------------------------------------------------
export type ActiveRow = { id: string; text: string; where: string; st: 'ok' | 'warn' | 'dim'; a: string; b: string }

export function activeRows(rules: Rule[], sessions: number): ActiveRow[] {
  return rules.map(r => {
    const where = r.mode === 'always' ? `CLAUDE.local.md${r.line ? ':' + r.line : ''} · always on` : `just in time · ${r.matcher || r.tool}`
    if (r.recurred > 0) return { id: r.id, text: r.text, where, st: 'warn', a: `recurred ${r.recurred}× since accepted`, b: 'the same failure happened again' }
    if (r.fired > 0) return { id: r.id, text: r.text, where, st: 'ok', a: `fired ${r.fired}×`, b: 'not seen again since accepted' }
    return { id: r.id, text: r.text, where, st: 'dim', a: 'never fired', b: sessions > 1 ? `no matching calls in ${sessions} sessions` : 'no matching calls yet' }
  })
}

// ---- memory candidates ------------------------------------------------------------------------
export type MemFile = { name: string; content: string; dir?: string }
/** Key under which a missing path is recorded: the folder of the file that mentions it, then the path. */
export const missKey = (dir: string | undefined, ref: string) => `${dir ?? ''}\u0000${ref}`

/** A backticked token that names a thing in the repo, not a host, glob or placeholder. */
export const isRepoPath = (s: string) => !/[*<>{}$:@?]|^https?:|\.(com|org|net|io|dev|ai|app|co|sh)$/i.test(s) && !s.startsWith('~')
export type Cand = {
  id: string
  file: string
  from: number
  to: number
  text: string
  tokens: number
  st: 'stale' | 'never triggered' | 'in use'
  why: string
}

const REF = /`([^`\n]+)`/g
const looksPath = (s: string) => /\//.test(s) || /\.[a-z0-9]{1,5}$/i.test(s)
/** Backticked paths and the first word of backticked commands. */
export function refsOf(text: string): { paths: string[]; cmds: string[] } {
  const paths: string[] = []
  const cmds: string[] = []
  for (const m of text.matchAll(REF)) {
    const t = m[1].trim()
    if (!t) continue
    if (looksPath(t) && !/\s/.test(t)) paths.push(t.replace(/^\.\//, ''))
    else {
      const w = t.split(/\s+/)[0]
      if (/^[a-z][\w.-]*$/i.test(w)) cmds.push(w)
    }
  }
  return { paths, cmds }
}

/** Sections and lines of instruction files that look removable. Guesses from activity, labelled as such. */
export function memoryCandidates(files: MemFile[], used: Record<string, number>, sessions: number, missing: Set<string>): { cands: Cand[]; inUse: Cand[] } {
  const cands: Cand[] = []
  const inUse: Cand[] = []
  for (const f of files) {
    const lines = f.content.split('\n')
    let skip = false
    lines.forEach((ln, i) => {
      if (ln.includes('claude-mods:lessons:start')) skip = true
      if (!skip && ln.trim() && !/^\s*#/.test(ln)) {
        const { paths, cmds } = refsOf(ln)
        if (paths.length + cmds.length) {
          const tokens = tokensOf(ln)
          const base = { id: idOf(`${f.name}:${i + 1}`), file: f.name, from: i + 1, to: i + 1, text: ln.trim().replace(/^[-*]\s+/, ''), tokens }
          const gone = paths.find(p => isRepoPath(p) && missing.has(missKey(f.dir, p)))
          const unused = cmds.filter(c => !used[c])
          const hit = Math.max(0, ...cmds.map(c => used[c] ?? 0), ...paths.map(p => used[p] ?? 0))
          if (gone) cands.push({ ...base, st: 'stale', why: `\`${gone}\` was not found in this repo` })
          else if (sessions >= 3 && cmds.length > 0 && unused.length === cmds.length && paths.length === 0)
            cands.push({ ...base, st: 'never triggered', why: `no \`${unused[0]}\` calls in ${sessions} sessions` })
          else if (hit > 0) inUse.push({ ...base, st: 'in use', why: `relevant in ${hit} of ${sessions} sessions` })
        }
      }
      if (ln.includes('claude-mods:lessons:end')) skip = false
    })
  }
  cands.sort((a, b) => b.tokens - a.tokens)
  return { cands, inUse }
}

export function removeLines(content: string, from: number, to: number): { next: string; removed: string[] } {
  const lines = content.split('\n')
  const removed = lines.slice(from - 1, to)
  lines.splice(from - 1, to - from + 1)
  return { next: lines.join('\n'), removed }
}

export function restoreLines(content: string, at: number, removed: string[]): string {
  const lines = content.split('\n')
  lines.splice(at - 1, 0, ...removed)
  return lines.join('\n')
}

// ---- CLAUDE.local.md block ---------------------------------------------------------------------
export const BLOCK_START = '<!-- claude-mods:lessons:start -->'
export const BLOCK_END = '<!-- claude-mods:lessons:end -->'

/** Replaces the marked block (or appends one); an empty list removes it. Text outside is untouched. */
export function upsertBlock(file: string, texts: string[]): string {
  const a = file.indexOf(BLOCK_START)
  const b = file.indexOf(BLOCK_END)
  const has = a !== -1 && b > a
  const before = has ? file.slice(0, a).replace(/\n+$/, '') : file.replace(/\n+$/, '')
  const after = has ? file.slice(b + BLOCK_END.length).replace(/^\n+/, '') : ''
  const block = texts.length ? [BLOCK_START, '## Lessons', ...texts.map(t => `- ${t}`), BLOCK_END].join('\n') : ''
  const body = [before, block, after].filter(s => s.length > 0).join('\n\n')
  return body === '' ? '' : body + '\n'
}

/** Where a rule's line lands in the file `upsertBlock` would write (1-based). */
export function lineOf(file: string, texts: string[], text: string): number {
  const out = upsertBlock(file, texts).split('\n')
  return out.findIndex(l => l === `- ${text}`) + 1
}

// ---- persisted shapes ----------------------------------------------------------------------------
export function sanitizeRules(v: unknown): Rule[] {
  if (!Array.isArray(v)) return []
  const out: Rule[] = []
  for (const r of v) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    if (typeof o.id !== 'string' || typeof o.sig !== 'string' || typeof o.text !== 'string') continue
    out.push({
      id: o.id,
      sig: o.sig,
      tool: typeof o.tool === 'string' ? o.tool : '',
      text: o.text,
      mode: o.mode === 'always' ? 'always' : 'jit',
      matcher: typeof o.matcher === 'string' ? o.matcher : '',
      tools: Array.isArray(o.tools) ? o.tools.filter((x): x is string => typeof x === 'string') : [],
      prefix: typeof o.prefix === 'string' ? o.prefix : '',
      line: typeof o.line === 'number' ? o.line : 0,
      at: typeof o.at === 'number' ? o.at : 0,
      fired: typeof o.fired === 'number' ? o.fired : 0,
      recurred: typeof o.recurred === 'number' ? o.recurred : 0,
    })
  }
  return out.slice(0, 100)
}

export type History = { sessions: number; turns: number[]; trend: Array<{ w: number; r: boolean }>; used: Record<string, number>; kept: string[]; seen: Record<string, Seen> }
export const emptyHistory = (): History => ({ sessions: 0, turns: [], trend: [], used: {}, kept: [], seen: {} })

export function sanitizeHistory(v: unknown): History {
  const h = emptyHistory()
  if (!v || typeof v !== 'object') return h
  const o = v as Record<string, unknown>
  if (typeof o.sessions === 'number') h.sessions = Math.max(0, Math.floor(o.sessions))
  if (Array.isArray(o.turns)) h.turns = o.turns.filter((x): x is number => typeof x === 'number').slice(-20)
  if (Array.isArray(o.trend))
    h.trend = o.trend
      .filter((x): x is { w: number; r: boolean } => !!x && typeof (x as { w?: unknown }).w === 'number')
      .map(x => ({ w: x.w, r: x.r === true }))
      .slice(-10)
  if (o.used && typeof o.used === 'object') {
    for (const [k, n] of Object.entries(o.used as Record<string, unknown>)) if (typeof n === 'number' && Object.keys(h.used).length < 400) h.used[k] = n
  }
  if (Array.isArray(o.kept)) h.kept = o.kept.filter((x): x is string => typeof x === 'string').slice(-100)
  return h
}

/** Average turns per session, or the design's sample when there is no history yet. */
export const turnsPerSession = (h: History): number =>
  h.turns.length ? Math.max(20, Math.round(h.turns.reduce((a, b) => a + b, 0) / h.turns.length)) : DEFAULT_TURNS

/** $/MTok base input, from the Claude API price table; null for a model it does not know. */
export function priceOf(model: string): number | null {
  if (/fable-5|mythos/.test(model)) return 10
  if (/opus-5-5/.test(model)) return 4
  if (/opus/.test(model)) return 5
  if (/sonnet-5/.test(model)) return 2
  if (/sonnet/.test(model)) return 3
  if (/haiku-5/.test(model)) return 0.1
  if (/haiku/.test(model)) return 1
  return null
}

import type { Ui } from '../types'

export const DEFAULT_UI: Ui = { tab: 0, open: null, view: 'list', id: '', polished: '', msg: '', later: 0, rev: 0 }

const VIEWS = ['list', 'jit', 'always', 'written', 'error', 'polish', 'sending', 'polished', 'remove', 'retire', 'notice']
export function sanitizeUi(v: unknown): Ui {
  if (!v || typeof v !== 'object') return { ...DEFAULT_UI }
  const o = v as Record<string, unknown>
  const tab = o.tab === 1 || o.tab === 2 || o.tab === 3 ? o.tab : 0
  return {
    tab,
    open: typeof o.open === 'string' ? o.open : null,
    view: typeof o.view === 'string' && VIEWS.includes(o.view) ? (o.view as Ui['view']) : 'list',
    id: typeof o.id === 'string' ? o.id : '',
    polished: typeof o.polished === 'string' ? o.polished : '',
    msg: typeof o.msg === 'string' ? o.msg : '',
    later: typeof o.later === 'number' ? o.later : 0,
    rev: typeof o.rev === 'number' ? o.rev : 0,
  }
}
