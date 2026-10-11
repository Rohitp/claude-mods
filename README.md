# claude-mods

Two small mods for Claude Code that make the context window and the prompt cache visible.

| Mod | Answers | Commands |
|---|---|---|
| **context-lens** | What fills my context window, and what does carrying it cost? | `/ctx`, `/ctx band` |
| **cache-guard** | When does my prompt cache go stale, and what will a miss cost? | `/cache`, `/cache warm`, `/cache 5m`, `/cache 1h` |

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

- One-line band above the prompt: stacked bar, percent used, top three categories.
- `/ctx` opens a pane with tabs: **Category**, **Items** (messages by source, biggest fixed items), **What-if** (tokens freed and turns to pay back if you drop an MCP server or memory file), **Trend**.

## cache-guard

- Status line countdown (`cache 3:12`), a toast 60s before expiry, and a band when expiry is close or the cache is stale.
- `/cache` opens a pane: countdown, cost of a miss vs a ping, keep-warm toggle with a tally, step timeline, and a log of cache busts with the cause when it can be named.
- **Keep-warm is manual.** It pings with a cache read shortly before expiry and stops itself once a ping costs more than the rewrite it avoids.

## Billing mode

Both mods detect it from the account: rate-limit windows are only reported on a subscription.
API billing shows dollars; a subscription shows tokens, multipliers and rate-limit percent.

## Limits you should know about

- The cache TTL is not reported to plugins. It is assumed to be 5 minutes; use `/cache 1h` if yours is an hour.
- Prices are a small hardcoded table, so unknown models show tokens only.
- Per-source token counts are estimated from text length and scaled to the engine's own Messages total.
- Cache-bust causes cover idle, model change, effort change and compaction; anything else is "cause unknown".
- A keep-warm ping still generates a few output tokens, which the tally does not include.
- The mod API is early access and moves between Claude Code releases. Written against 2.1.296.

## Layout

```
.claude-plugin/marketplace.json
context-lens/   hooks/register.tsx, types/index.d.ts
cache-guard/    hooks/register.tsx, types/index.d.ts
docs/design/    design notes and mockups
```
