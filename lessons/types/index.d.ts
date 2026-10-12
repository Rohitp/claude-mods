/** One approved rule. `jit` is shown after a matching tool result; `always` lives in CLAUDE.local.md. */
export type Rule = {
  id: string
  sig: string
  tool: string
  text: string
  mode: 'jit' | 'always'
  /** Display form, `Bash(pnpm test*)`. */
  matcher: string
  tools: string[]
  /** Command or path prefix a call must start with; empty matches every call of the tools. */
  prefix: string
  /** Line in CLAUDE.local.md for an always-on rule; 0 when unknown. */
  line: number
  at: number
  /** Times it was shown to the model. */
  fired: number
  /** Matching calls that failed again after it was accepted. */
  recurred: number
}

/** What was seen across earlier sessions for one signature. */
export type Seen = { sessions: number; loops: number; wasted: number; at: number; tool: string; sample: string; text: string }

/** The pane's own state: which tab, which row, which confirm view. */
export type UiView = 'list' | 'jit' | 'always' | 'written' | 'error' | 'polish' | 'sending' | 'polished' | 'remove' | 'retire' | 'notice'
export type Ui = {
  tab: 0 | 1 | 2 | 3
  open: string | null
  view: UiView
  id: string
  /** The polished wording the model returned, while the person decides. */
  polished: string
  /** One line for a notice or an error. */
  msg: string
  /** Proposal count at the moment the person pressed Later. */
  later: number
  /** Bumped on every change a drawing reads from module memory. */
  rev: number
}

declare module 'claude-code' {
  interface PluginState {
    lessons: {
      ui: Ui
    }
  }
}
