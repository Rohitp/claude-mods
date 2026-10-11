// Character-grid layout helpers, ported from the terminal design reference
// (designs/design/Mods Terminal.dc.html): segments, fit, left/right, and the
// priority drop used by every one-row band.

/** One styled run of text. `r` is a semantic role, `c` an explicit theme colour key. */
export type Seg = {
  t: string
  r?: string
  b?: boolean
  c?: string
  /** Name of an action; drawn as a Button and pressed through the `acts` map. */
  act?: string
  /** Drawn as the engine's primary button, `[ label ]`; `t` holds the bracketed text for width. */
  primary?: boolean
  tight?: boolean
}
export type Item = { p: number; tight?: boolean; segs: Seg[] }

/** `S('text', 'warn b')`: first word is the role, a `b` word makes it bold. */
export const S = (t: string | number, spec = 'fg', extra: Partial<Seg> = {}): Seg => {
  const parts = spec.split(' ')
  return { t: String(t), r: parts[0], b: parts.includes('b'), ...extra }
}

export const len = (a: Seg[]): number => a.reduce((n, x) => n + [...x.t].length, 0)
export const sp = (n: number): Seg => S(' '.repeat(Math.max(0, n)))
export const padR = (t: string, n: number): string => {
  const c = [...t]
  return c.length >= n ? c.slice(0, n).join('') : t + ' '.repeat(n - c.length)
}
export const padL = (t: string, n: number): string => {
  const c = [...t]
  return c.length >= n ? t : ' '.repeat(n - c.length) + t
}

/** Clip a line to `w` cells, ending with an ellipsis; pads to `w` when `pad`. */
export function fit(a: Seg[], w: number, pad = false): Seg[] {
  const o: Seg[] = []
  let n = 0
  for (const x of a) {
    const c = [...x.t]
    if (n + c.length <= w) {
      o.push(x)
      n += c.length
    } else {
      const k = w - n
      if (k > 0) {
        o.push({ ...x, t: c.slice(0, k - 1).join('') + '…' })
        n = w
      }
      break
    }
  }
  if (pad && n < w) o.push(sp(w - n))
  return o
}

/** Left text, right text, spaces between; the left clips first when they collide. */
export function lr(l: Seg[], r: Seg[], w: number): Seg[] {
  const g = w - len(l) - len(r)
  if (g >= 1) return [...l, sp(g), ...r]
  return fit([...fit(l, Math.max(0, w - len(r) - 1)), S(' '), ...r], w)
}

/** Join items with ` · `, repeatedly dropping the highest-`p` item until the row fits `w`. */
export function prio(items: Item[], w: number): Seg[] {
  const build = (a: Item[]): Seg[] => {
    const o: Seg[] = []
    a.forEach((it, i) => {
      if (i > 0) o.push(S(it.tight ? ' ' : ' · ', 'dim'))
      o.push(...it.segs)
    })
    return o
  }
  const c = items.slice()
  while (len(build(c)) > w) {
    let mx = 0
    let ix = -1
    c.forEach((it, i) => {
      if (it.p > mx) {
        mx = it.p
        ix = i
      }
    })
    if (ix < 0) break
    c.splice(ix, 1)
  }
  return build(c)
}

/** Word-wrap `text` to `w` cells, one role. */
export function wrap(text: string, w: number, r = 'fg'): Seg[][] {
  const out: Seg[][] = []
  let cur = ''
  for (const wd of text.split(' ')) {
    if (!cur) cur = wd
    else if ([...(cur + ' ' + wd)].length <= w) cur += ' ' + wd
    else {
      out.push([S(cur, r)])
      cur = wd
    }
  }
  if (cur) out.push([S(cur, r)])
  return out
}

/** Eighth-block horizontal bar for a fraction 0..1 over `n` cells. */
export function hbar(f: number, n: number): string {
  const x = Math.max(0, Math.min(1, f)) * n
  let full = Math.floor(x)
  let r = Math.round((x - full) * 8)
  if (r === 8) {
    full++
    r = 0
  }
  let t = '█'.repeat(full) + (r > 0 ? '▏▎▍▌▋▊▉'[r - 1] : '')
  if (!t && f > 0) t = '▏'
  return t
}

export const fk = (tokens: number): string => {
  if (tokens >= 1e6) return `${Number((tokens / 1e6).toFixed(1))}M`
  if (tokens >= 1e5) return `${Math.round(tokens / 1e3)}k`
  return `${(tokens / 1e3).toFixed(1)}k`
}
export const fk1 = (tokens: number): string => `${(tokens / 1e3).toFixed(1)}k`
export const mmss = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
export const dur = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m ${s % 60}s`
}
