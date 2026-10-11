// SVG builders for the desktop surface. Shapes only: words are drawn by themed Text elements,
// and the palette is mid-tone so it reads on both light and dark. `<title>` gives hover tooltips
// when the Svg is drawn interactive.
import type { Beat } from '../types'

export const COLORS = {
  ok: '#3f9a4a',
  warn: '#d08f12',
  err: '#d4503f',
  track: 'rgba(128,128,128,0.28)',
  mute: 'rgba(128,128,128,0.55)',
}

export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A countdown ring, `frac` full now and `next` one second later: SMIL draws the tick between. */
export function ringSvg(frac: number, next: number, color: string, size = 88): string {
  const r = 38
  const c = 2 * Math.PI * r
  const f = Math.max(0, Math.min(1, frac))
  const n = Math.max(0, Math.min(1, next))
  const dash = (x: number) => `${(c * x).toFixed(2)} ${c.toFixed(2)}`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 88 88" width="${size}" height="${size}">` +
    `<circle cx="44" cy="44" r="${r}" fill="none" stroke="${COLORS.track}" stroke-width="7"/>` +
    `<circle cx="44" cy="44" r="${r}" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" ` +
    `transform="rotate(-90 44 44)" stroke-dasharray="${dash(f)}">` +
    (n !== f ? `<animate attributeName="stroke-dasharray" from="${dash(f)}" to="${dash(n)}" dur="1s" fill="freeze"/>` : '') +
    `</circle></svg>`
  )
}

export type Dot = { beat: Beat; tip: string }
/** One dot per recent step: filled hit, half partial, hollow miss; shape as well as colour. */
export function stepsSvg(dots: Dot[]): string {
  const step = 16
  const w = Math.max(1, dots.length) * step
  const body = dots
    .map((d, i) => {
      const cx = i * step + 8
      const col = d.beat === 'hit' ? COLORS.ok : d.beat === 'part' ? COLORS.warn : COLORS.err
      const shape =
        d.beat === 'hit'
          ? `<circle cx="${cx}" cy="8" r="5" fill="${col}"/>`
          : d.beat === 'miss'
            ? `<circle cx="${cx}" cy="8" r="4.2" fill="none" stroke="${col}" stroke-width="2"/>`
            : `<circle cx="${cx}" cy="8" r="4.2" fill="none" stroke="${col}" stroke-width="2"/>` +
              `<path d="M${cx} 3.8 A4.2 4.2 0 0 1 ${cx} 12.2 Z" fill="${col}"/>`
      return `<g><title>${esc(d.tip)}</title><rect x="${i * step}" y="0" width="${step}" height="16" fill="transparent"/>${shape}</g>`
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 16" width="${w}" height="16">${body}</svg>`
}

/** A thin remaining-time bar for the band chip. */
export function miniBarSvg(frac: number, color: string, w = 96, h = 6): string {
  const f = Math.max(0, Math.min(1, frac))
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
    `<rect width="${w}" height="${h}" rx="${h / 2}" fill="${COLORS.track}"/>` +
    `<rect width="${(w * f).toFixed(1)}" height="${h}" rx="${h / 2}" fill="${color}"/></svg>`
  )
}
