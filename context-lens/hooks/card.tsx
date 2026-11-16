// In-the-moment surfaces: the card placed in the transcript when the context crosses a level,
// and the line under a tool row whose result was big. One tree for every surface: the
// terminal ignores text sizes, and Box borders and theme colors work everywhere.
import type { Elements } from 'claude-code'

import { cardAfter, cardBody, cardTitle, resultNote, usd } from './model'
import type { Card } from '../types'
import type { Acts } from './terminal'

export type CardEl = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

/** `isLive` is true for the newest card while nothing since has answered it. */
export function ctxCard(el: CardEl, c: Card, isLive: boolean, acts: Acts) {
  const { Box, Text, Button } = el
  const tone = c.level >= 3 ? 'error' : 'warning'
  if (!isLive || c.status !== 'open') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>
          {cardTitle(c)} · {c.status === 'open' ? 'Compacting would have freed about ' + Math.round(c.frees / 1000) + 'k.' : cardAfter(c)}
        </Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={tone} paddingX={1}>
      <Text bold color={tone}>{cardTitle(c)}</Text>
      <Text>{cardBody(c, usd)}</Text>
      <Box gap={1}>
        <Button key={`${c.id}-compact`} label="Compact now" variant="primary" onPress={acts.compact!} />
        <Button key={`${c.id}-snooze`} label="Not now" variant="secondary" onPress={acts.snooze!} />
      </Box>
    </Box>
  )
}

/** The engine's own tool row, with one dim line under it. */
export function withResultNote(el: CardEl, row: unknown, tokens: number, window: number, results = 1) {
  const { Box, Text } = el
  return (
    <Box flexDirection="column">
      {row as never}
      <Box paddingLeft={5}>
        <Text dimColor>{resultNote(tokens, window, results)}</Text>
      </Box>
    </Box>
  )
}
