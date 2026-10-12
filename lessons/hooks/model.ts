// Pure model: call signatures, loop detection, rules and their price. No engine access.
import type { Rule } from '../types'

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
  category: Category | null
  /** Distinct raw spellings seen, capped. */
  variants: string[]
  /** A pagination or limit fragment was stripped from at least one spelling. */
  paged: boolean
  bytes: number
  /** Loop size at which the model was last nudged. */
  hinted: number
  firstAt: number
  lastAt: number
}

export type Call = { tool: string; input: Record<string, unknown>; text: string; isError: boolean; at: number }

export const LOOP_MIN = 3
const HINT_AT = [3, 6, 10]
const MAX_VARIANTS = 8
const BYTES_PER_TOKEN = 4

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
  [/no such file|not found.*(?:file|path|director)|does not exist|ENOENT/i, 'file_not_found'],
  [/command not found|not recognized as|executable file not found/i, 'command_not_found'],
  [/permission denied|EACCES|operation not permitted|not allowed/i, 'permission_denied'],
  [/timed out|timeout|ETIMEDOUT/i, 'timeout'],
  [/user (?:rejected|denied|doesn't want)|request interrupted|was rejected/i, 'user_rejected'],
  [/syntax ?error|unexpected token|parse error/i, 'syntax_error'],
  [/exit code|exited with|returned non-zero/i, 'exit_code'],
]

export function categorize(text: string): Category {
  for (const [re, c] of RULES) if (re.test(text)) return c
  return 'unknown'
}

const errKey = (t: string) => t.replace(/\b\d+\b/g, '#').replace(/\s+/g, ' ').trim().slice(0, 160)

/** Folds one finished call in. Edits and writes reset what was learned about reading that file. */
export function track(map: Map<string, Entry>, c: Call): Entry | null {
  const t = c.tool.toLowerCase()
  if (t === 'edit' || t === 'write' || t === 'multiedit') map.delete(`read:${str(c.input.file_path)}`)
  const d = describe(c.tool, c.input)
  const e: Entry = map.get(d.sig) ?? {
    tool: c.tool,
    sig: d.sig,
    sample: d.sample,
    count: 0,
    errors: 0,
    sameErr: 0,
    lastErr: '',
    category: null,
    variants: [],
    paged: false,
    bytes: 0,
    hinted: 0,
    firstAt: c.at,
    lastAt: c.at,
  }
  e.count++
  e.lastAt = c.at
  e.bytes += c.text.length
  e.paged = e.paged || d.paged
  if (!e.variants.includes(d.raw) && e.variants.length < MAX_VARIANTS) e.variants.push(d.raw)
  if (c.isError) {
    const k = errKey(c.text)
    e.errors++
    e.sameErr = k === e.lastErr ? e.sameErr + 1 : 1
    e.lastErr = k
    e.category = categorize(c.text)
  } else {
    e.sameErr = 0
    e.lastErr = ''
  }
  map.set(d.sig, e)
  return e
}

/** Repeating the same failure, or re-running one command with different limits. */
export function loopSize(e: Entry): number {
  if (e.sameErr >= LOOP_MIN) return e.sameErr
  if (e.paged && e.variants.length >= LOOP_MIN && e.errors < e.count) return e.variants.length
  return 0
}

export const isLoop = (e: Entry) => loopSize(e) >= LOOP_MIN

/** Measured, not guessed: the repeats beyond the first, at this entry's average output size. */
export function wastedTokens(e: Entry): number {
  const n = loopSize(e)
  if (n < LOOP_MIN || e.count === 0) return 0
  return Math.round(((n - 1) * (e.bytes / e.count)) / BYTES_PER_TOKEN)
}

/** True once per HINT_AT step, so a stuck loop is nudged, not nagged. */
export function shouldHint(e: Entry): boolean {
  const n = loopSize(e)
  const step = [...HINT_AT].reverse().find(s => n >= s)
  return step !== undefined && step > e.hinted
}

export function ruleText(e: Entry): string {
  const what = e.tool.toLowerCase() === 'bash' ? `\`${e.sample}\`` : `${e.tool} ${e.sample}`
  if (e.paged && e.errors < e.count) {
    return `${what} was re-run with different limits; ask for the full output once instead of paging.`
  }
  switch (e.category) {
    case 'file_not_found':
      return `${what} failed: the path does not exist. Check it with Glob or ls before retrying.`
    case 'command_not_found':
      return `${what} failed: the command is not available here. Do not retry it; use another tool.`
    case 'permission_denied':
      return `${what} was denied. Do not retry; ask the person or pick another approach.`
    case 'timeout':
      return `${what} timed out. Narrow the scope or run it in the background instead of retrying as is.`
    case 'user_rejected':
      return `${what} was rejected by the person. Do not repeat it; ask what they would prefer.`
    default:
      return `${what} failed the same way repeatedly. Change the approach instead of retrying.`
  }
}

/** The one-line note shown to the model right after a result that continues a loop. */
export function liveHint(e: Entry): string {
  const n = loopSize(e)
  const kind = e.paged && e.errors < e.count ? `re-run ${n} times with different limits` : `failed ${n} times in a row with the same error`
  return `Lessons: this call has ${kind}. ${ruleText(e)}`
}

export const tokensOf = (s: string) => Math.max(1, Math.ceil(s.length / BYTES_PER_TOKEN))

export type Proposal = {
  id: string
  sig: string
  tool: string
  text: string
  kind: 'error-loop' | 'refetch-loop'
  count: number
  saved: number
  /** What the rule costs per turn while it is carried (always-on). */
  carry: number
  /** Always-on over `turns`, minus nothing: saved minus carried tokens. */
  netAlways: number
  /** Just-in-time: shown about once, so its cost is one copy of the text. */
  netJit: number
}

export function idOf(sig: string): string {
  let h = 2166136261
  for (let i = 0; i < sig.length; i++) h = Math.imul(h ^ sig.charCodeAt(i), 16777619)
  return (h >>> 0).toString(36).slice(0, 4).padStart(4, '0')
}

export function propose(map: Map<string, Entry>, taken: Set<string>, turns: number): Proposal[] {
  const out: Proposal[] = []
  for (const e of map.values()) {
    if (!isLoop(e) || taken.has(e.sig)) continue
    const text = ruleText(e)
    const carry = tokensOf(text)
    const saved = wastedTokens(e)
    out.push({
      id: idOf(e.sig),
      sig: e.sig,
      tool: e.tool,
      text,
      kind: e.paged && e.errors < e.count ? 'refetch-loop' : 'error-loop',
      count: loopSize(e),
      saved,
      carry,
      netAlways: saved - carry * Math.max(1, turns),
      netJit: saved - carry,
    })
  }
  return out.sort((a, b) => b.netJit - a.netJit)
}

// ---- CLAUDE.local.md block ------------------------------------------------------------
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
  return [before, block, after].filter(s => s.length > 0).join('\n\n') + '\n'
}

// ---- persisted shapes ------------------------------------------------------------------
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
      at: typeof o.at === 'number' ? o.at : 0,
      fired: typeof o.fired === 'number' ? o.fired : 0,
      recurred: typeof o.recurred === 'number' ? o.recurred : 0,
    })
  }
  return out.slice(0, 100)
}
