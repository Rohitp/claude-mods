# claude-mods

Two small mods for Claude Code that make the context window and the prompt cache visible.

| Mod | Answers | Commands |
|---|---|---|
| **context-lens** | What fills my context window, and what does carrying it cost? | `/ctx`, `/ctx band`, `/ctx stats` |
| **cache-guard** | When does my prompt cache go stale, and what will a miss cost? | `/cache`, `/cache warm`, `/cache 5m`, `/cache 1h`, `/cache stats` |

## Install

```
/plugin install context-lens --marketplace rohitp/claude-mods
/plugin install cache-guard  --marketplace rohitp/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. To try them from a checkout instead:

```
claude --plugin-dir ./context-lens --plugin-dir ./cache-guard
```

## context-lens

- One-line band above the prompt: stacked bar by category, percent, top categories, carry cost or 5h window. Drops segments in a fixed order as the width shrinks and never drops the percent or the alert action.
- `/ctx` opens a pane with tabs: **Category**, **Items** (grouped, with messages by source), **What-if** (what removing an MCP server or memory file frees, the one-time rebuild and pay-back), **Trend** (window fill per turn, growth, turns to autocompact, compaction marks).
- Warning at 80%, critical when it autocompacts next turn; each comes with one action, **Compact now**.

## cache-guard

- Status line entry (`cache 3:12`, `cache STALE`, `↻` when keep warm is on), one toast 60s before expiry, and a band within 60s of expiry or when stale.
- `/cache` opens a pane: state and countdown, cost of a miss vs a ping, keep-warm toggle with a tally, recent steps (hit / partial / miss), and a log of cache busts with the cause when it can be named.
- **Keep warm is manual and never turns itself on.** It pings 30s before expiry and stops by itself when another ping would cost more than the miss it avoids, or after 2h without a turn.
- When the cache is cold, the next turn rewrites everything anyway: that is the cheapest moment to compact, and the band says so.

## Surfaces

The same plugin draws on every surface and picks its rendering from `e.surface`:

- **Terminal:** character-grid layouts from `designs/`, themed with the engine's colour roles.
- **Both bands compose:** each plugin draws its row around whatever the plugin beneath draws, so the cache band sits above the context band instead of replacing it.
- **Desktop / VS Code:** themed Box/Text/Button for words, Svg for the ring, bars, step dots and trend (tooltips come from `<title>` in an interactive Svg).

## Billing mode

Both mods detect it from the account: rate-limit windows are only reported on a subscription.
API billing shows dollars, always suffixed "est."; a subscription shows tokens, multipliers and the 5h window; an unknown model shows tokens and multipliers and says prices are unknown.

## Where this differs from the design handoff

| Design | Here | Why |
|---|---|---|
| Global keys `alt+l`, `alt+g`, `alt+k`, `alt+c` | None yet: buttons are drawn plain or primary so widths stay exact, and a hotkey prefix would shift them | The mod API has no global key chords; a binding needs a decision before shipping |
| `~2.0% of 5h` per ping or miss | The actual 5h window reading, plus multipliers | Plan limits are not exposed, so a per-action percentage would be invented |
| Toast with a button | Plain text toast | The engine toast carries text only |
| Fixed-height boxed pane | The engine's pane frame, title and close | The engine owns the frame and height |
| `Disable github` action | Advisory only | There is no API to toggle an MCP server or memory file |
| Miss costs the full write price | Miss costs the write price above a hit (`1.25x - read`) | It is the extra you actually pay: $1.98 vs $2.06 on the design's sample |
| Keep warm ends after 2h | Ends after 2h or at break-even, whichever is first | Beyond break-even a ping costs more than the miss it avoids |
| Cold-cache state shared between mods | Context Lens infers it from its own last turn, assuming a 5-minute TTL | Separate plugins; Cache Guard's state is not read across |
| Status entry coloured | Plain text | The engine draws the status line |

## Logging and metrics

Everything stays on your machine.

- **Debug log:** structured, content-free lines (`cache-guard info bust kind=idle tokens=412000 gapMs=401000`) in `claude --debug`. They carry counts, ids and durations only, never prompt, transcript or file content. A first error of each kind also leaves one dim line in the transcript.
- **Local metrics:** counters and a short ring of recent events in each mod's own store, flushed every 15s and on exit. `/cache stats` and `/ctx stats` print them; `... stats reset` clears them. Switch them off with the `metrics` option.
- **What they answer:**
  - Cache Guard checks its own TTL assumption from observed idle gaps ("a hit after 8m idle outlived the assumed 5m: try /cache 1h"), counts busts by cause, and records what pings really consumed.
  - Context Lens reports how far its text-length estimate was from the engine's own Messages figure.
- **Failures are visible:** render faults are caught, logged, and degrade to a one-line message or the engine's default instead of a blank UI; state left by an earlier version is repaired and counted.
- **No outbound telemetry.** The mods do not call `$.telemetry`, which feeds Anthropic's first-party analytics or an operator's collector, and make no network requests.

## Limits you should know about

- The cache TTL is not reported to plugins. It is assumed to be 5 minutes; use `/cache 1h` if yours is an hour.
- Prices are a small hardcoded table, so unknown models show tokens only.
- Per-source token counts are estimated from text length and scaled to the engine's own Messages total.
- Cache-bust causes cover idle, model change, effort change and compaction; anything else is "cause unknown".
- Ping cost includes the output and uncached input each ping used, priced at 5x input for output (true of the current price table).
- "Cache data unavailable" is inferred after three steps with no cache tokens at all.
- Tests cover the model, layouts and trees. The mods have not been exercised in a live desktop session.
- The mod API is early access and moves between Claude Code releases. Written against 2.1.296.

## Checking what the engine really draws

`scripts/capture.py` runs Claude Code in a pseudo-terminal with both mods loaded, sends prompts and
slash commands, clicks controls with mouse events, and prints the screen with its colours. It is how
the tab, colour and band-stacking problems were found. See the header of the script for usage.

## Development

```
npm install
npm test        # model, layout and tree tests (no Claude Code needed)
claude plugin validate ./cache-guard
claude --plugin-dir ./context-lens --plugin-dir ./cache-guard
```

## Layout

```
.claude-plugin/marketplace.json
context-lens/   hooks/{register,model,layout,terminal,desktop,svg}, types/, tests
cache-guard/    hooks/{register,model,layout,terminal,desktop,svg}, types/, tests
designs/        design handoff: HTML prototypes, screenshots, spec
scripts/        local test runner
```
