/** One approved rule. `jit` is shown after a matching tool result; `always` lives in CLAUDE.local.md. */
export type Rule = {
  id: string
  sig: string
  tool: string
  text: string
  mode: 'jit' | 'always'
  at: number
  /** Times it was shown to the model. */
  fired: number
  /** Matching calls that failed again after it was accepted. */
  recurred: number
}

/** What was seen across earlier sessions for one signature. */
export type Seen = { sessions: number; loops: number; wasted: number; at: number; tool: string; sample: string; text: string }
