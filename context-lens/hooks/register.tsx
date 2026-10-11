import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Item, Lens, Tab } from '../types'

const PANE = 'context-lens'
const lensAtom = atom({ plugin: 'context-lens', key: 'lens' } as const, null)
const bandAtom = atom({ plugin: 'context-lens', key: 'isBandOn' } as const, true)
const tabAtom = atom({ plugin: 'context-lens', key: 'tab' } as const, 'category')
const historyAtom = atom({ plugin: 'context-lens', key: 'history' } as const, [])

const WRITE = 1.25
const TABS: { id: Tab; label: string }[] = [
  { id: 'category', label: 'Category' },
  { id: 'items', label: 'Items' },
  { id: 'whatif', label: 'What-if' },
  { id: 'trend', label: 'Trend' },
]

// $/MTok base input and cache-read multiplier (Claude API price table).
type Price = { base: number; read: number }
function priceOf(model: string): Price | null {
  if (/fable-5|mythos/.test(model)) return { base: 10, read: 0.025 }
  if (/opus-5-5/.test(model)) return { base: 4, read: 0.05 }
  if (/opus/.test(model)) return { base: 5, read: 0.1 }
  if (/sonnet-5/.test(model)) return { base: 2, read: 0.1 }
  if (/sonnet/.test(model)) return { base: 3, read: 0.1 }
  if (/haiku-5/.test(model)) return { base: 0.1, read: 0.1 }
  if (/haiku/.test(model)) return { base: 1, read: 0.1 }
  return null
}
const money = (tokens: number, mult: number, model: string): string | null => {
  const p = priceOf(model)
  if (!p) return null
  const v = (tokens / 1e6) * p.base * mult
  return `$${v < 0.1 ? v.toFixed(3) : v.toFixed(2)}`
}

const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
const base = (path: string): string => path.split('/').slice(-2).join('/')
const SPARK = '▁▂▃▄▅▆▇█'

const bar = (parts: { tokens: number; color: string }[], max: number, width: number) => {
  let used = 0
  const cells = parts.map(p => {
    const n = max > 0 ? Math.round((p.tokens / max) * width) : 0
    const take = Math.max(0, Math.min(n, width - used))
    used += take
    return { color: p.color, n: take }
  })
  return { cells, rest: Math.max(0, width - used) }
}

// Where the Messages tokens came from. Estimated from text length, then scaled so the groups
// add up to the breakdown's own Messages row.
async function messageGroups($: EngineInterface, target: number): Promise<Item[]> {
  const rows = await $.session.messages()
  const toolOf = new Map<string, string>()
  const sums = new Map<string, number>()
  const add = (k: string, chars: number) => sums.set(k, (sums.get(k) ?? 0) + chars)
  const label = (tool: string): string => {
    const m = /^mcp__(.+?)__/.exec(tool)
    return m ? `MCP ${m[1]}` : tool
  }
  for (const m of rows) {
    if (m.role === 'user') add('Your prompts', m.text.length)
    else add('Assistant text', m.text.length)
    for (const u of m.toolUses ?? []) {
      toolOf.set(u.tool_use_id, label(u.tool))
      add('Tool call inputs', JSON.stringify(u.input ?? {}).length)
    }
    for (const r of m.toolResults ?? []) {
      add(`${toolOf.get(r.tool_use_id) ?? 'tool'} results`, r.text.length)
    }
  }
  const all = [...sums.entries()].map(([k, chars]) => ({ k, est: Math.ceil(chars / 4) }))
  const sum = all.reduce((a, x) => a + x.est, 0)
  const scale = target > 0 && sum > 0 ? target / sum : 1
  return all
    .map(x => ({ label: x.k, group: 'Messages', tokens: Math.round(x.est * scale) }))
    .filter(x => x.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 10)
}

async function measure($: EngineInterface): Promise<Lens | null> {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const b = usage.context.breakdown
  if (!b) return null

  const items: Item[] = [
    ...b.memoryFiles.map(f => ({ label: base(f.path), group: 'Memory', tokens: f.tokens })),
    ...b.mcpTools.filter(t => t.isLoaded).map(t => ({ label: `${t.serverName}:${t.name}`, group: 'MCP', tokens: t.tokens })),
    ...(b.skills?.skillFrontmatter ?? []).map(s => ({ label: s.name, group: 'Skill', tokens: s.tokens })),
    ...b.agents.map(a => ({ label: a.agentType, group: 'Agent', tokens: a.tokens })),
  ]
    .sort((x, y) => y.tokens - x.tokens)
    .slice(0, 12)

  const byServer = new Map<string, number>()
  for (const t of b.mcpTools) if (t.isLoaded) byServer.set(t.serverName, (byServer.get(t.serverName) ?? 0) + t.tokens)
  const servers: Item[] = [...byServer.entries()]
    .map(([label, tokens]) => ({ label, group: 'MCP server', tokens }))
    .sort((x, y) => y.tokens - x.tokens)

  const msgRow = b.categories.find(c => c.kind === 'used' && /message/i.test(c.name))
  const w = usage.rateLimits.find(l => l.kind === 'five_hour') ?? usage.rateLimits[0]

  return {
    rows: b.categories.map(c => ({ name: c.name, tokens: c.tokens, color: c.color, kind: c.kind })),
    items,
    messages: await messageGroups($, msgRow?.tokens ?? 0),
    servers,
    total: b.totalTokens,
    max: b.rawMaxTokens,
    percent: b.percentage,
    model: b.model,
    autoCompactAt: b.autoCompactThreshold,
    mode: usage.rateLimits.length > 0 ? 'sub' : 'api',
    limitPct: w ? w.percentUsed : null,
  }
}

async function refresh($: EngineInterface) {
  const lens = await measure($)
  if (!lens) return
  await update($, lensAtom, () => lens)
  await update($, historyAtom, h => [...h, lens.percent].slice(-60))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'ctx', description: 'Show what fills the context window' })
    return next(e)
  })

  on('command.run', { command: 'ctx' }, async ($, e) => {
    if (e.args.trim() === 'band') {
      const isOn = !(await read($, bandAtom))
      await update($, bandAtom, () => isOn)
      return { text: isOn ? 'Context band on.' : 'Context band off.' }
    }
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Context' })
    return { text: 'Context pane opened. `/ctx band` toggles the one-line band.' }
  })

  // After every turn. The summary breakdown is a local estimate and costs no request.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) await refresh($)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const lens = await read($, lensAtom)
    if (!lens) return <Text dimColor>No measurement yet: send a prompt.</Text>

    const tab = await read($, tabAtom)
    const width = Math.max(20, Math.min(80, (e.props.bodyColumns ?? 60) - 2))
    const used = lens.rows.filter(r => r.kind === 'used' && r.tokens > 0)
    const { cells, rest } = bar(used, lens.max, width)
    const carry = lens.mode === 'api' ? money(lens.total, 1, lens.model) : null
    const p = priceOf(lens.model)
    const read_ = p ? p.read : 0.1
    const history = await read($, historyAtom)

    const header = (
      <Box flexDirection="column">
        <Text bold>
          {fmt(lens.total)} / {fmt(lens.max)} tokens ({lens.percent}%)
          <Text dimColor> · {lens.model} · {lens.mode === 'sub' ? 'subscription' : 'API billing'}</Text>
        </Text>
        <Box>
          {cells.map((c, i) => (
            <Text key={`c${i}`} color={c.color}>{'█'.repeat(c.n)}</Text>
          ))}
          <Text dimColor>{'░'.repeat(rest)}</Text>
        </Box>
        {lens.percent >= 80 && (
          <Text color="warning">
            Past 80%{lens.autoCompactAt ? `: auto-compact at ${fmt(lens.autoCompactAt)}` : ''}
          </Text>
        )}
        <Text dimColor>
          {carry
            ? `Carrying this costs ~${money(lens.total, read_, lens.model)} per turn (cache reads); a full rewrite ~${money(lens.total, WRITE, lens.model)}.`
            : `Every turn re-reads ${fmt(lens.total)} tokens at ${read_}x${lens.limitPct !== null ? ` · 5h window ${lens.limitPct}%` : ''}.`}
        </Text>
        <Box>
          {TABS.map(t => (
            <Button
              key={`t-${t.id}`}
              label={t.id === tab ? `[${t.label}]` : t.label}
              onPress={() => update($, tabAtom, () => t.id)}
            />
          ))}
        </Box>
        <Text> </Text>
      </Box>
    )

    if (tab === 'items') {
      return (
        <Box flexDirection="column">
          {header}
          <Text bold>Messages, by source</Text>
          {lens.messages.length === 0 && <Text dimColor>Nothing yet.</Text>}
          {lens.messages.map((it, i) => (
            <Text key={`m${i}`}>
              {fmt(it.tokens).padStart(7)} {it.label}
            </Text>
          ))}
          <Text> </Text>
          <Text bold>Biggest fixed items</Text>
          {lens.items.map((it, i) => (
            <Text key={`i${i}`}>
              {fmt(it.tokens).padStart(7)} <Text dimColor>{it.group.padEnd(7)}</Text> {it.label}
            </Text>
          ))}
        </Box>
      )
    }

    if (tab === 'whatif') {
      // Tools render first in the prompt, so changing them rebuilds the whole cached prefix once.
      // Payback = the rebuild's extra cost over a read, divided by what each turn then saves.
      const rows = [...lens.servers, ...lens.items.filter(i => i.group === 'Memory')].slice(0, 10)
      return (
        <Box flexDirection="column">
          {header}
          <Text bold>If you removed it</Text>
          <Text dimColor>one rebuild of the prefix, then smaller reads every turn</Text>
          {rows.length === 0 && <Text dimColor>Nothing removable found.</Text>}
          {rows.map((r, i) => {
            const turns = Math.ceil((lens.total * (WRITE - read_)) / (r.tokens * read_))
            const save = lens.mode === 'api' ? money(r.tokens, read_, lens.model) : null
            return (
              <Text key={`w${i}`}>
                {('−' + fmt(r.tokens)).padStart(8)} {r.label.padEnd(22)}
                <Text dimColor>
                  {' '}
                  {((r.tokens / Math.max(1, lens.max)) * 100).toFixed(1)}% of window
                  {save ? ` · saves ${save}/turn` : ''} · pays back in ~{turns} turns
                </Text>
              </Text>
            )
          })}
        </Box>
      )
    }

    if (tab === 'trend') {
      const spark = history
        .map(v => SPARK[Math.max(0, Math.min(7, Math.floor((v / 100) * 8)))])
        .join('')
      return (
        <Box flexDirection="column">
          {header}
          <Text bold>Window fill per turn</Text>
          <Text>{spark || '—'}</Text>
          <Text dimColor>
            {history.length} turns · now {lens.percent}% · peak {Math.max(0, ...history)}%
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {header}
        {lens.rows.map((r, i) => (
          <Text key={`r${i}`} dimColor={r.kind !== 'used'}>
            <Text color={r.color}>■</Text> {r.name.padEnd(26)} {fmt(r.tokens).padStart(7)}{' '}
            {lens.max > 0 ? `${((r.tokens / lens.max) * 100).toFixed(1)}%` : ''}
          </Text>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const lens = await read($, lensAtom)
    if (!lens || e.props.hasSurvey || !(await read($, bandAtom))) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const used = lens.rows.filter(r => r.kind === 'used' && r.tokens > 0)
    const { cells, rest } = bar(used, lens.max, 24)
    const top = [...used].sort((a, b) => b.tokens - a.tokens).slice(0, 3)

    return (
      <Box>
        <Text dimColor>ctx </Text>
        {cells.map((c, i) => (
          <Text key={`c${i}`} color={c.color}>{'█'.repeat(c.n)}</Text>
        ))}
        <Text dimColor>{'░'.repeat(rest)} </Text>
        <Text color={lens.percent >= 80 ? 'warning' : undefined}>{lens.percent}%</Text>
        <Text dimColor> {top.map(r => `${r.name} ${fmt(r.tokens)}`).join(' · ')}  (/ctx)</Text>
      </Box>
    )
  })
}
