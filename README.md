# claude-mods

Two small mods for Claude Code that show what fills your context window and when your prompt cache is about to go cold.

| Mod | Answers |
|---|---|
| **context-lens** | What is using my context window, and what does carrying it cost? |
| **cache-guard** | When does my prompt cache expire, and what will the next turn cost if it does? |

![Context Lens in the terminal](docs/images/terminal-context-lens.png)

## Install

```
/plugin install context-lens --marketplace Rohitp/claude-mods
/plugin install cache-guard  --marketplace Rohitp/claude-mods
```

Answer `y` to add the marketplace, then choose a scope. To try them from a checkout instead:

```
claude --plugin-dir ./context-lens --plugin-dir ./cache-guard
```

Needs a Claude Code build with mod support (written against 2.1.296).

## Context Lens

A one-row band above the prompt and a side panel opened with `/ctx`.

- **Band:** a stacked bar, percent used, the biggest categories, and what carrying the context costs each turn. From 80% it estimates the turns left before autocompact and adds a **Compact now** button.
- **Category:** every category with its tokens and share of the window.
- **Items:** each memory file, MCP server, skill and agent, plus messages split by source.
- **What-if:** an estimate of what removing a memory file or MCP server frees, and how many turns until the one-time cache rebuild pays back.
- **Trend:** window fill per turn, growth rate and turns to autocompact.

`/ctx band` toggles the band.

![What-if tab](docs/images/terminal-what-if.png)

## Cache Guard

A countdown for the prompt cache, so an idle gap doesn't turn into an expensive full re-send.

- **Warning:** at 60 seconds before expiry you get a note, and a band showing what a miss would cost.
- **When it's cold:** the band says the next turn rewrites everything anyway, which is the cheapest moment to compact.
- **Panel (`/cache`):** countdown, cost of a miss vs a keep-alive ping, recent hits and misses, and a log of cache busts with the cause (idle past the TTL, model change, effort change, compaction).
- **Keep warm:** a manual toggle. It sends a cheap cache-read ping shortly before expiry and stops by itself once another ping would cost more than the miss it avoids, or after 2 hours without a turn. It never turns itself on.

`/cache warm` toggles keep warm; `/cache 5m` or `/cache 1h` sets the TTL it assumes.

![Cache Guard with keep warm on](docs/images/terminal-cache-guard.png)

The cache band appears above the context band in the last minute before expiry (staged here so it shows at 4:50):

![Cache band above the context band](docs/images/terminal-bands.png)

## Desktop app

The mods also draw for the desktop app. These are the design previews the desktop renderer was built from; it has not been verified in the app yet.

![Context Lens, desktop design](docs/images/desktop-context-lens.jpg)
![Cache Guard, desktop design](docs/images/desktop-cache-guard.jpg)

## Good to know

- **Billing mode is detected for you.** On API billing, costs are shown in dollars and marked "est."; on a subscription you get tokens, multipliers and your 5-hour window instead. A model without a known price shows tokens only.
- **The cache TTL is assumed.** Claude Code doesn't report it, so the default is 5 minutes. `/cache stats` compares that assumption with the idle gaps it has actually seen and tells you if `/cache 1h` fits better.
- **Numbers are estimates.** Prices come from a small built-in table, and the per-source message split is estimated from text length and scaled to the engine's own total.
- **Bust causes are best effort.** Anything it can't attribute is shown as "cause unknown".
- **The mod API is early access** and can change between Claude Code releases.

## Privacy

Nothing is sent anywhere. The mods write debug lines (counts, ids and durations, never prompt or file content) to `claude --debug`, and keep counters in their own local store for `/cache stats` and `/ctx stats`. Set the `metrics` option to `false` to turn the counters off. The only network traffic is the keep-warm pings, which are ordinary model requests you switch on yourself.

## Development

```
npm install
npm test                         # model, layout and rendering tests
claude plugin validate ./cache-guard
```
