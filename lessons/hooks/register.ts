import type { EngineInterface, Register } from 'claude-code'

import type { Rule } from '../types'
import { BLOCK_END, BLOCK_START, idOf, liveHint, propose, sanitizeRules, shouldHint, track, upsertBlock, wastedTokens } from './model'
import type { Entry } from './model'

const PLUGIN = 'lessons'
const RULES_KEY = 'rules'
const LOCAL_FILE = 'CLAUDE.local.md'

// Per session, in memory; a reload starts these over, the store below keeps what was approved.
const entries = new Map<string, Entry>()
const shown = new Set<string>()
let rules: Rule[] = []
let isLive = true

function log($: EngineInterface, event: string, fields: Record<string, string | number | boolean> = {}) {
  const kv = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ')
  $.ui.log(`${PLUGIN} ${event}${kv ? ' ' + kv : ''}`, { to: 'debug' })
}

async function saveRules($: EngineInterface) {
  await $.store.set(RULES_KEY, rules)
}

/** Rewrites only the marked block of CLAUDE.local.md at the project root. */
async function syncFile($: EngineInterface) {
  const path = `${await $.session.root()}/${LOCAL_FILE}`
  const had = await $.fs.exists(path)
  const old = had ? await $.fs.read(path) : ''
  const text = typeof old === 'string' ? old : ''
  const always = rules.filter(r => r.mode === 'always').map(r => r.text)
  if (!had && always.length === 0) return path
  const next = upsertBlock(text, always)
  if (next !== (text.endsWith('\n') ? text : text + '\n') || !had) await $.fs.write(path, next)
  return path
}

const money = (n: number) => `${n < 0 ? '-' : ''}${Math.abs(n).toLocaleString('en-US')}`

async function listing($: EngineInterface): Promise<string> {
  const turns = await $.session.turns()
  const props = propose(entries, new Set(rules.map(r => r.sig)), turns)
  const lines: string[] = []
  if (props.length === 0) lines.push('Nothing to propose: no loops caught this session.')
  else {
    lines.push(`Proposals (${props.length}), tokens est.:`)
    for (const p of props) {
      lines.push(
        `  ${p.id}  ${p.kind}  x${p.count}  wasted ${money(p.saved)}  rule ${p.carry}/turn  ` +
          `net just-in-time ${money(p.netJit)}, always-on ${money(p.netAlways)} over ${turns} turns`,
      )
      lines.push(`        ${p.text}`)
    }
    lines.push('Accept with `/lessons accept <id>` (just in time) or `/lessons accept <id> always`.')
  }
  if (rules.length) {
    lines.push('', `Active (${rules.length}):`)
    for (const r of rules) {
      lines.push(`  ${r.id}  ${r.mode === 'jit' ? 'just in time' : 'always on'}  shown ${r.fired}x  failed again ${r.recurred}x`)
      lines.push(`        ${r.text}`)
    }
    lines.push('Remove with `/lessons retire <id>`.')
  }
  return lines.join('\n')
}

export const register: Register = (on, options) => {
  isLive = (options as Record<string, unknown>)?.liveHints !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'lessons',
      description: 'Loops caught this session as rules to accept; `accept <id> [always]`, `retire <id>`',
    })
    rules = sanitizeRules(await $.store.get(RULES_KEY))
    log($, 'start', { rules: rules.length, live: isLive })
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    try {
      const { tool, tool_use_id: _id, consent: _c, ...input } = e as unknown as Record<string, unknown> & { tool: string }
      const text = typeof ran.text === 'string' ? ran.text : ''
      const isError = ran.isError === true
      const entry = track(entries, { tool, input, text, isError, at: await $.clock.now() })
      if (!entry) return ran

      const notes: string[] = []
      const rule = rules.find(r => r.sig === entry.sig)
      if (rule) {
        if (isError) rule.recurred++
        // A just-in-time rule is shown once per session, and again whenever the call fails.
        if (rule.mode === 'jit' && (isError || !shown.has(rule.id))) {
          shown.add(rule.id)
          rule.fired++
          notes.push(`Lessons: ${rule.text}`)
          void saveRules($)
        }
      } else if (isLive && shouldHint(entry)) {
        entry.hinted = Math.max(entry.hinted, entry.sameErr, entry.variants.length)
        notes.push(liveHint(entry))
        log($, 'hint', { tool, wasted: wastedTokens(entry), n: entry.hinted })
      }
      if (notes.length === 0) return ran
      return { ...ran, context: [...(ran.context ?? []), ...notes] }
    } catch (err) {
      log($, 'error', { where: 'tool.call', msg: String(err).slice(0, 80) })
      return ran
    }
  }).catch(($, e, next) => (next.called ? next(e) : next(e)))

  on('command.run', { command: 'lessons' }, async ($, e) => {
    const [verb, id, how] = e.args.trim().split(/\s+/)
    if (verb === 'accept' && id) {
      const turns = await $.session.turns()
      const p = propose(entries, new Set(rules.map(r => r.sig)), turns).find(x => x.id === id)
      if (!p) return { text: `No open proposal ${id}. Run /lessons to list them.` }
      const mode = how === 'always' ? 'always' : 'jit'
      rules.push({ id: p.id, sig: p.sig, tool: p.tool, text: p.text, mode, at: await $.clock.now(), fired: 0, recurred: 0 })
      await saveRules($)
      log($, 'accept', { mode })
      if (mode === 'always') {
        const path = await syncFile($)
        return { text: `Accepted ${id} as always on. Written to ${path} between ${BLOCK_START} and ${BLOCK_END}; keep that file git-ignored.` }
      }
      return { text: `Accepted ${id}: shown after a matching tool result, once per session and again if it fails.` }
    }
    if (verb === 'retire' && id) {
      const had = rules.find(r => r.id === id)
      if (!had) return { text: `No active rule ${id}.` }
      rules = rules.filter(r => r.id !== id)
      await saveRules($)
      if (had.mode === 'always') await syncFile($)
      log($, 'retire', { mode: had.mode })
      return { text: `Retired ${id}.` }
    }
    return { text: await listing($) }
  })
}

export { idOf }
