// SVG builders for the desktop surface. Shapes only: words are drawn by themed Text elements.
// Mid-tone palette that reads on light and dark; `<title>` gives hover tooltips when the Svg is
// drawn interactive, and the embedded CSS dims the other segments on hover.
import type { Cat, Point } from '../types'

export const PALETTE = {
  sys: '#8a84c0',
  tools: '#4f8fcf',
  mcp: '#2fa392',
  memory: '#cf9a2c',
  skills: '#78ab58',
  agents: '#a96bc4',
  messages: '#d9784a',
  buffer: '#9a9a9a',
  warn: '#d08f12',
  ink: '#8a8a8a',
}

export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A category's colour by its name, so the same row keeps one colour on every view. */
export function colorOf(name: string): string {
  if (/message/i.test(name)) return PALETTE.messages
  if (/mcp/i.test(name)) return PALETTE.mcp
  if (/memory/i.test(name)) return PALETTE.memory
  if (/skill/i.test(name)) return PALETTE.skills
  if (/agent/i.test(name)) return PALETTE.agents
  if (/tool/i.test(name)) return PALETTE.tools
  if (/system/i.test(name)) return PALETTE.sys
  return PALETTE.buffer
}

export type BarSeg = { cat: Cat; tip: string }

const CSS =
  '<style>.s{transition:opacity .12s}.b:hover .s{opacity:.4}.b .s:hover{opacity:1;stroke:#777;stroke-width:2}</style>'
const HATCH =
  '<pattern id="clh" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">' +
  '<rect width="6" height="6" fill="rgba(128,128,128,0.10)"/><rect width="2" height="6" fill="rgba(128,128,128,0.35)"/></pattern>'

/** The stacked window bar: used categories in colour, free hatched, buffer grey, a tick at the
 *  compaction threshold. */
export function stackedBarSvg(segs: BarSeg[], thresholdFrac: number | null, w = 360, h = 16, windowTokens = 0): string {
  // The bar is the whole window, so a breakdown that leaves out free space still shows it.
  const sum = Math.max(windowTokens, segs.reduce((n, s) => n + (s.cat.kind === 'deferred' ? 0 : Math.max(0, s.cat.tokens)), 0))
  if (sum <= 0) return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"/>`
  let x = 0
  const rects = segs
    .filter(s => s.cat.tokens > 0 && s.cat.kind !== 'deferred')
    .map(s => {
      const width = (s.cat.tokens / sum) * w
      const fill = s.cat.kind === 'free' ? 'url(#clh)' : s.cat.kind === 'buffer' ? PALETTE.buffer : colorOf(s.cat.name)
      const r = `<rect class="s" x="${x.toFixed(2)}" y="0" width="${Math.max(0.5, width - 1).toFixed(2)}" height="${h}" rx="3" fill="${fill}"><title>${esc(s.tip)}</title></rect>`
      x += width
      return r
    })
    .join('')
  const tick =
    thresholdFrac !== null
      ? `<rect x="${(thresholdFrac * w - 1).toFixed(1)}" y="-2" width="2" height="${h + 4}" fill="${PALETTE.ink}"/>`
      : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h + 4}" width="${w}" height="${h + 4}">` +
    `<defs>${HATCH}</defs>${CSS}<g class="b" transform="translate(0 2)">${rects}</g>${tick}</svg>`
  )
}

/** The band's small stacked bar, no tooltips. */
export function miniStackSvg(cats: Cat[], w = 96, h = 6): string {
  const used = cats.filter(c => c.kind !== 'deferred' && c.tokens > 0)
  const sum = used.reduce((n, c) => n + c.tokens, 0)
  let x = 0
  const rects = used
    .map(c => {
      const width = (c.tokens / Math.max(1, sum)) * w
      const fill = c.kind === 'free' ? 'rgba(128,128,128,0.22)' : c.kind === 'buffer' ? PALETTE.buffer : colorOf(c.name)
      const r = `<rect x="${x.toFixed(2)}" y="0" width="${Math.max(0.5, width).toFixed(2)}" height="${h}" fill="${fill}"/>`
      x += width
      return r
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><clipPath id="clc"><rect width="${w}" height="${h}" rx="${h / 2}"/></clipPath><g clip-path="url(#clc)">${rects}</g></svg>`
}

/** One horizontal bar for a category row. */
export function rowBarSvg(frac: number, color: string, w = 84, h = 6): string {
  const f = Math.max(0, Math.min(1, frac))
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
    `<rect width="${w}" height="${h}" rx="${h / 2}" fill="rgba(128,128,128,0.2)"/>` +
    `<rect width="${Math.max(h, w * f).toFixed(1)}" height="${h}" rx="${h / 2}" fill="${color}"/></svg>`
  )
}

/** The trend: one stacked column per turn (overhead under messages), a dashed line at the
 *  compaction threshold and a triangle where a compaction happened. */
export function columnsSvg(points: Point[], window: number, thresholdPct: number | null, w = 360, h = 170): string {
  const n = Math.max(1, points.length)
  const pad = 14
  const cw = (w - pad) / n
  const y = (v: number) => h - 8 - (Math.min(1.05, v / window) * (h - 24))
  const cols = points
    .map((p, i) => {
      const x = pad + i * cw
      const ov = y(p.overhead)
      const tot = y(p.total)
      const pct = Math.round((p.total / window) * 100)
      const tip = `Turn ${i + 1} · ${Math.round(p.total / 1000)}k (${pct}%)\nOverhead ${Math.round(p.overhead / 1000)}k${p.isCompaction ? '\nCompacted' : ''}`
      return (
        `<g class="s"><title>${esc(tip)}</title>` +
        `<rect x="${x.toFixed(1)}" y="${tot.toFixed(1)}" width="${Math.max(1, cw - 1.5).toFixed(1)}" height="${Math.max(0, ov - tot).toFixed(1)}" fill="${PALETTE.messages}"/>` +
        `<rect x="${x.toFixed(1)}" y="${ov.toFixed(1)}" width="${Math.max(1, cw - 1.5).toFixed(1)}" height="${Math.max(0, h - 8 - ov).toFixed(1)}" fill="${PALETTE.mcp}"/>` +
        (p.isCompaction ? `<path d="M${(x + cw / 2).toFixed(1)} ${h - 2} l-4 7 h8 z" fill="${PALETTE.ink}"/>` : '') +
        `</g>`
      )
    })
    .join('')
  const line =
    thresholdPct !== null
      ? `<line x1="${pad}" x2="${w}" y1="${y(thresholdPct / 100).toFixed(1)}" y2="${y(thresholdPct / 100).toFixed(1)}" stroke="${PALETTE.warn}" stroke-width="1.5" stroke-dasharray="5 4"/>`
      : ''
  const axis = `<line x1="${pad}" x2="${w}" y1="${h - 8}" y2="${h - 8}" stroke="rgba(128,128,128,0.5)"/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h + 6}" width="${w}" height="${h + 6}">` +
    `<style>.s:hover{opacity:.7}</style>${axis}${line}${cols}</svg>`
  )
}
