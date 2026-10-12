// Desktop surface (also VS Code and mobile): themed Box/Text/Button for words, Svg for the trend.
import type { Elements } from 'claude-code'

import { cut, fkd, sg } from './layout'
import type { ActiveRow, Cand, LoopRow, Proposal } from './model'
import { trendSvg } from './svg'
import type { Acts, View } from './terminal'
import { TABS } from './terminal'

export type DesktopEl = Pick<Elements['desktop'], 'Box' | 'Text' | 'Button' | 'Svg'>
type El = DesktopEl

const GL: Record<string, string> = { failure: '✕ failure', loop: '↻ loop', correction: '↩ correction' }
const isApi = (v: View) => v.mode === 'api' && v.price !== null
const usd = (t: number, price: number | null): string => {
  if (price === null) return ''
  const x = (Math.abs(t) * price) / 1e6
  return x < 0.01 ? '<$0.01' : `${t < 0 ? '−' : '~'}$${x.toFixed(2)}`
}
const netColor = (n: number) => (n < 0 ? 'warning' : 'success')
const modeLabel = (v: View) => (v.mode === 'api' ? 'API billing · est.' : 'Subscription · tokens')

// ---- band ------------------------------------------------------------------------------------------
export function lessonsBandDesktop(el: El, v: View, acts: Acts) {
  const { Box, Text, Button } = el
  const live = v.loops.find(l => l.live)
  const hidden = !live && (v.props.length === 0 || v.props.length <= v.ui.later)
  if (hidden) return null
  const p = v.props[0]
  return (
    <Box key="lessons-band" gap={1} alignItems="center" borderStyle="round" paddingX={1}>
      <Text dimColor>lessons</Text>
      {live ? (
        <Box gap={1}>
          <Text bold color="warning">loop caught</Text>
          <Text wrap="truncate">
            {live.call} {live.kl === 're-fetch loop' ? `re-run ${live.n}× with different limits` : `failed ${live.n}× with the same error`}
          </Text>
          <Text>
            {fkd(live.wasted)} wasted <Text dimColor>est.{isApi(v) ? ` (${usd(live.wasted, v.price)})` : ''}</Text>
          </Text>
        </Box>
      ) : (
        <Box gap={1}>
          <Text bold color="claude">{v.props.length}</Text>
          <Text>to review</Text>
          <Text wrap="truncate">{GL[p.kind].split(' ')[0]} {p.text}</Text>
          <Text>
            net <Text bold color={netColor(p.netJit)}>{sg(p.netJit)}</Text> <Text dimColor>est.{isApi(v) ? ` (${usd(p.netJit, v.price)})` : ''}</Text>
          </Text>
        </Box>
      )}
      <Button key="review" label="[ Review ]" onPress={acts.review} />
      <Button key="later" label="Later" onPress={acts.later} />
    </Box>
  )
}

// ---- pane -------------------------------------------------------------------------------------------
export function lessonsPaneDesktop(el: El, v: View, acts: Acts) {
  const { Box, Text, Button } = el
  const counts = [v.props.length, v.active.length, v.loops.length, v.cands.length]
  const tabs = (
    <Box key="tabs" gap={1}>
      {TABS.map((t, i) => (
        <Button key={t} label={i === v.ui.tab ? `[ ${t} ${counts[i]} ]` : `${t} ${counts[i]}`} onPress={acts[`tab:${i}`]} />
      ))}
    </Box>
  )
  const note = v.ui.msg && v.ui.view === 'list' && (
    <Box key="msg" gap={1}>
      <Text>{v.ui.msg}</Text>
      {v.canUndo && <Button key="undo" label="Undo" onPress={acts.undo} />}
    </Box>
  )
  return (
    <Box flexDirection="column" gap={1}>
      <Box justifyContent="space-between">
        <Text bold>Lessons</Text>
        <Text dimColor>{modeLabel(v)}</Text>
      </Box>
      {tabs}
      {note}
      {confirmDesktop(el, v, acts) ?? (v.ui.tab === 0 ? proposals(el, v, acts) : v.ui.tab === 1 ? active(el, v, acts) : v.ui.tab === 2 ? loopsTab(el, v, acts) : memory(el, v, acts))}
      <Text dimColor>Tab moves between buttons · Enter presses · Esc closes</Text>
    </Box>
  )
}

function num(label: string, value: string, color?: string, el?: El) {
  const { Box, Text } = el as El
  return (
    <Box key={label} flexDirection="column" minWidth={8}>
      <Text dimColor>{label}</Text>
      <Text bold color={color}>{value}</Text>
    </Box>
  )
}

function proposals(el: El, v: View, acts: Acts) {
  const { Box, Text, Button } = el
  if (v.props.length === 0) return empty(el, v)
  return (
    <Box flexDirection="column" gap={1}>
      <Box justifyContent="space-between">
        <Text bold>{v.props.length} proposal{v.props.length === 1 ? '' : 's'}</Text>
        <Text dimColor>tokens per session, est.</Text>
      </Box>
      <Text dimColor>Saved is measured this session. Carry and net are estimates.</Text>
      {v.props.map(p => {
        const open = p.id === v.ui.open
        const neg = p.netJit < 0
        return (
          <Box key={p.id} flexDirection="column" borderStyle="round" paddingX={1} gap={1}>
            <Box gap={1}>
              <Button key={`exp:${p.id}`} label={open ? '−' : '+'} onPress={acts[`exp:${p.id}`]} />
              <Text dimColor>{GL[p.kind]}</Text>
              <Text dimColor={neg} wrap="truncate">{p.text}</Text>
            </Box>
            <Box gap={3}>
              {num('Seen', `${p.n}×`, undefined, el)}
              {num('Saved', fkd(p.saved), undefined, el)}
              {num('Carry', fkd(p.carryJit), undefined, el)}
              {num('Net', `${sg(p.netJit)}${isApi(v) ? ` · ${usd(p.netJit, v.price)}` : ''}`, netColor(p.netJit), el)}
            </Box>
            {open && (
              <Box flexDirection="column" gap={1}>
                <Box flexDirection="column" borderStyle="round" paddingX={1}>
                  <Text dimColor>Rule</Text>
                  <Text>{p.text}</Text>
                </Box>
                <Box flexDirection="column">
                  <Text bold>Evidence <Text dimColor>· {p.turns ? `turns ${p.turns}` : p.kl}</Text></Text>
                  {p.ev.slice(0, 3).map((e, i) => (
                    <Text key={`ev${i}`} dimColor wrap="truncate">{e}</Text>
                  ))}
                  {p.n > p.ev.length && <Text dimColor>+ {p.n - p.ev.length} more like these</Text>}
                </Box>
                <Text bold>Deliver as</Text>
                <Box flexDirection="column" gap={1}>
                  <Box flexDirection="column">
                    <Box gap={1}>
                      <Button key={`jit:${p.id}`} label="Just in time" onPress={acts[`jit:${p.id}`]} />
                      <Text dimColor>carry {fkd(p.carryJit)} · net </Text>
                      <Text bold color={netColor(p.netJit)}>{sg(p.netJit)}</Text>
                      {!neg && <Text bold color="claude">Recommended</Text>}
                    </Box>
                    <Text dimColor>Shown to the model when {p.matcher.label} runs: once a session, once more if it fails again.</Text>
                  </Box>
                  <Box flexDirection="column">
                    <Box gap={1}>
                      <Button key={`alw:${p.id}`} label="Always on" onPress={acts[`alw:${p.id}`]} />
                      <Text dimColor>carry {fkd(p.carryAlways)} · net </Text>
                      <Text bold color={netColor(p.netAlways)}>{sg(p.netAlways)}</Text>
                    </Box>
                    <Text dimColor>Written to CLAUDE.local.md. Read every turn.</Text>
                  </Box>
                </Box>
                {neg && <Text color="warning">Costs more than it saves at this session's rate (est.). Dismiss is probably right.</Text>}
                <Box gap={1}>
                  <Button key={`dis:${p.id}`} label="Dismiss" onPress={acts[`dis:${p.id}`]} />
                  <Button key={`pol:${p.id}`} label="Polish wording" onPress={acts[`pol:${p.id}`]} />
                </Box>
                <Text dimColor>Only Polish wording sends anything: the rule and its evidence, to the model. Otherwise nothing leaves this machine.</Text>
              </Box>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

function empty(el: El, v: View) {
  const { Box, Text } = el
  if (v.turns < 5 && v.failures + v.corrections === 0)
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Watching this session.</Text>
        <Text>Proposals appear here when a tool call fails, the same call repeats 3+ times, or you interrupt or reject something.</Text>
        <Text dimColor>Nothing is written until you accept it. Lessons runs on this machine; nothing is sent anywhere.</Text>
      </Box>
    )
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Nothing to learn this session.</Text>
      <Text>{v.turns} turns · {v.failures} failures · {v.loops.length} loops · {v.corrections} corrections</Text>
      <Text dimColor>The band stays hidden until something is worth a rule.</Text>
    </Box>
  )
}

const STATUS = { ok: ['●', 'success'], warn: ['▲', 'warning'], dim: ['○', undefined] } as const

function active(el: El, v: View, acts: Acts) {
  const { Box, Text, Button } = el
  if (v.active.length === 0)
    return (
      <Box flexDirection="column">
        <Text bold>No rules yet.</Text>
        <Text dimColor>Accepted rules appear here, with whether the failure came back.</Text>
      </Box>
    )
  return (
    <Box flexDirection="column" gap={1}>
      {v.active.map((a: ActiveRow) => (
        <Box key={a.id} flexDirection="column" borderStyle="round" paddingX={1}>
          <Box justifyContent="space-between" gap={1}>
            <Text wrap="truncate">{a.text}</Text>
            <Button key={`ret:${a.id}`} label="Retire" onPress={acts[`ret:${a.id}`]} />
          </Box>
          <Text dimColor>{a.where}</Text>
          <Text color={STATUS[a.st][1]}>{STATUS[a.st][0]} {a.a} · {a.b}</Text>
        </Box>
      ))}
      <Text dimColor>Recurred means the same failure happened again after the rule was accepted. Retire removes the rule; you can undo it until the next turn.</Text>
    </Box>
  )
}

function loopsTab(el: El, v: View, acts: Acts) {
  const { Box, Text, Button, Svg } = el
  const tot = v.loops.reduce((n, l) => n + l.wasted, 0)
  const tips = v.trend.map((t, i) => `${i === v.trend.length - 1 ? 'This session so far' : `${v.trend.length - 1 - i} sessions ago`} · ${fkd(t.w)} wasted, est.`)
  return (
    <Box flexDirection="column" gap={1}>
      {v.loops.length === 0 ? (
        <Text bold>Nothing wasted this session.</Text>
      ) : (
        <Box justifyContent="space-between">
          <Text bold>This session</Text>
          <Text>{fkd(tot)} wasted <Text dimColor>est.{isApi(v) ? ` ${usd(tot, v.price)}` : ''}</Text></Text>
        </Box>
      )}
      {v.loops.map((l: LoopRow) => (
        <Box key={l.sig} flexDirection="column" borderStyle="round" paddingX={1}>
          <Box justifyContent="space-between" gap={1}>
            <Text wrap="truncate">↻ {l.call}</Text>
            <Text bold color={l.live ? 'warning' : undefined}>{l.n}× · {fkd(l.wasted)}</Text>
          </Box>
          <Text dimColor>{l.kl} · {l.live ? 'live, still counting' : l.proposal ? 'became a proposal' : 'ended'}</Text>
          {l.err !== '' && <Text dimColor wrap="truncate">{cut(l.err, 80)}</Text>}
          {l.live && l.note !== '' && (
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
              <Text dimColor>Added to the model's next turn · {Math.ceil(l.note.length / 4)} tokens, not saved</Text>
              <Text>{l.note}</Text>
            </Box>
          )}
          {l.proposal && <Button key={`view:${l.proposal}`} label="View proposal" onPress={acts[`view:${l.proposal}`]} />}
        </Box>
      ))}
      {v.trend.length > 0 && (
        <Box flexDirection="column">
          <Box justifyContent="space-between">
            <Text bold>Waste per session</Text>
            <Text dimColor>last {v.trend.length}</Text>
          </Box>
          <Svg
            source={trendSvg(v.trend, tips)}
            alt={`Waste per session over the last ${v.trend.length} sessions: ${v.trend.map(t => fkd(t.w)).join(', ')}`}
            width={360}
            height={70}
          />
          <Text dimColor>Green dots: sessions after a rule was accepted.</Text>
        </Box>
      )}
    </Box>
  )
}

function memory(el: El, v: View, acts: Acts) {
  const { Box, Text, Button } = el
  if (!v.hasMemory)
    return (
      <Box flexDirection="column">
        <Text bold>No CLAUDE.md files in this repo.</Text>
        <Text dimColor>Instruction files above the working directory show here with what carrying each line costs.</Text>
      </Box>
    )
  const row = (c: Cand, cand: boolean) => (
    <Box key={c.id} flexDirection="column" borderStyle="round" paddingX={1}>
      <Box justifyContent="space-between" gap={1}>
        <Text dimColor>{c.file}:{c.from}</Text>
        <Text>{fkd(c.tokens)}/turn</Text>
      </Box>
      <Text wrap="truncate">{c.text}</Text>
      <Text color={c.st === 'stale' ? 'warning' : c.st === 'in use' ? 'success' : undefined} dimColor={c.st === 'never triggered'}>
        {c.st}: {c.why} (est.)
      </Text>
      {cand && (
        <Box justifyContent="space-between">
          <Text dimColor>{fkd(c.tokens * Math.max(1, v.turns))}/session{isApi(v) ? ` · ${usd(c.tokens * Math.max(1, v.turns), v.price)}` : ''} est.</Text>
          <Box gap={1}>
            <Button key={`rm:${c.id}`} label="Remove…" onPress={acts[`rm:${c.id}`]} />
            <Button key={`keep:${c.id}`} label="Keep" onPress={acts[`keep:${c.id}`]} />
          </Box>
        </Box>
      )}
    </Box>
  )
  return (
    <Box flexDirection="column" gap={1}>
      <Box justifyContent="space-between">
        <Text bold>Memory files</Text>
        <Text dimColor>{fkd(v.memTokens)}/turn total</Text>
      </Box>
      {v.cands.length === 0 ? <Text>Nothing looks removable.</Text> : v.cands.map(c => row(c, true))}
      {v.inUse.length > 0 && <Text bold>In use</Text>}
      {v.inUse.slice(0, 5).map(c => row(c, false))}
      <Text dimColor>Lessons can't see whether the model used a line. Stale and never triggered are guesses from activity in this repo.</Text>
    </Box>
  )
}

function confirmDesktop(el: El, v: View, acts: Acts) {
  const { Box, Text, Button } = el
  const u = v.ui
  const p: Proposal | undefined = v.props.find(x => x.id === u.id)
  if ((u.view === 'jit' || u.view === 'always') && p) {
    const j = u.view === 'jit'
    const c = j ? p.carryJit : p.carryAlways
    const n = j ? p.netJit : p.netAlways
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Accept · {j ? 'just in time' : 'always on'}</Text>
        {j ? (
          <Text>Writes to Lessons' local store (this machine only, not in the repo). Shown when {p.matcher.label} runs.</Text>
        ) : (
          <Text>Appends to {v.append?.file ?? 'CLAUDE.local.md'}{v.append ? `, line ${v.append.line}` : ''}. Read every turn.</Text>
        )}
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          <Text dimColor>{j ? 'Rule' : 'Diff · CLAUDE.local.md'}</Text>
          {!j && v.append?.prev ? <Text dimColor>  {v.append.line - 1}  {v.append.prev}</Text> : null}
          <Text color={j ? undefined : 'success'}>{j ? '' : `+ ${v.append?.line ?? 1}  `}{p.text}</Text>
        </Box>
        <Text>Carry {fkd(c)}/session · net <Text bold color={netColor(n)}>{sg(n)}</Text> <Text dimColor>est.{isApi(v) ? ` (${usd(n, v.price)})` : ''}</Text></Text>
        <Text dimColor>Nothing leaves this machine.</Text>
        <Box gap={1}>
          <Button key="write" label="[ Write rule ]" onPress={acts.write} />
          <Button key="back" label="Back" onPress={acts.back} />
        </Box>
      </Box>
    )
  }
  if (u.view === 'written')
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold color="success">✓ {u.msg || 'Written'}</Text>
        <Text>Active from your next turn. Undo reverses it; it is available until the next turn.</Text>
        <Box gap={1}>
          <Button key="undo" label="Undo" onPress={acts.undo} />
          <Button key="next" label="[ Next proposal ]" onPress={acts.next} />
        </Box>
      </Box>
    )
  if (u.view === 'error')
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold color="error">✕ Couldn't write</Text>
        <Text>{u.msg || 'The write failed.'} Nothing changed. The proposal is still here.</Text>
        <Box gap={1}>
          <Button key="write" label="[ Try again ]" onPress={acts.write} />
          <Button key="back" label="Back" onPress={acts.back} />
        </Box>
      </Box>
    )
  if (u.view === 'polish' && p)
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Polish wording</Text>
        <Text>Sends the rule text and its {Math.min(3, p.ev.length)} evidence lines to the model to tighten the wording. Nothing else from this session is sent.</Text>
        <Box gap={1}>
          <Button key="send" label="[ Send ]" onPress={acts.send} />
          <Button key="back" label="Cancel" onPress={acts.back} />
        </Box>
      </Box>
    )
  if (u.view === 'sending') return <Text dimColor>Asking the model…</Text>
  if (u.view === 'polished' && p)
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Polish wording <Text dimColor>· from the model</Text></Text>
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          <Text dimColor>Yours</Text>
          <Text>{p.text}</Text>
        </Box>
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          <Text dimColor>Polished</Text>
          <Text>{u.polished}</Text>
        </Box>
        <Box gap={1}>
          <Button key="usepol" label="[ Use polished ]" onPress={acts.usepol} />
          <Button key="back" label="Keep mine" onPress={acts.back} />
        </Box>
      </Box>
    )
  if (u.view === 'retire') {
    const a = v.active.find(x => x.id === u.id)
    if (!a) return null
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Retire this rule?</Text>
        <Box borderStyle="round" paddingX={1}>
          <Text>{a.text}</Text>
        </Box>
        <Text dimColor>{a.where.includes('always on') ? 'The line is removed from CLAUDE.local.md.' : 'It stops being shown to the model.'}</Text>
        <Box gap={1}>
          <Button key="retYes" label="[ Retire ]" onPress={acts.retYes} />
          <Button key="back" label="Keep" onPress={acts.back} />
        </Box>
      </Box>
    )
  }
  if (u.view === 'remove' && v.removal) {
    const r = v.removal
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Remove from {r.file}</Text>
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          {r.lines.slice(0, 4).map((l, i) => (
            <Text key={`rm${i}`} color="error" wrap="truncate">− {r.from + i}  {l}</Text>
          ))}
          {r.lines.length > 4 && <Text dimColor>… {r.lines.length - 4} more lines</Text>}
        </Box>
        <Text>Frees {fkd(r.tokens)}/turn · {fkd(r.tokens * Math.max(1, v.turns))}/session <Text dimColor>est.</Text></Text>
        <Text dimColor>A copy is kept in Lessons' local store so you can undo this until the next turn.</Text>
        <Box gap={1}>
          <Button key="rmYes" label={`[ Remove ${r.lines.length} line${r.lines.length === 1 ? '' : 's'} ]`} onPress={acts.rmYes} />
          <Button key="back" label="Back" onPress={acts.back} />
        </Box>
      </Box>
    )
  }
  return null
}
