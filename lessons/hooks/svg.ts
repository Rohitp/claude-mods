// SVG builders for the desktop surface. Shapes only; words are themed Text elements.
export const COLORS = {
  ok: '#3f9a4a',
  accent: '#c46a3a',
  line: 'rgba(128,128,128,0.55)',
  track: 'rgba(128,128,128,0.28)',
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Waste per session as a polyline with one dot per session; green dots follow an accepted rule. */
export function trendSvg(vals: Array<{ w: number; r: boolean }>, tips: string[], w = 360, h = 70): string {
  if (vals.length === 0) return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"/>`
  const mx = Math.max(1, ...vals.map(v => v.w))
  const step = vals.length > 1 ? (w - 16) / (vals.length - 1) : 0
  const X = (i: number) => 8 + i * step
  const Y = (v: number) => h - 6 - (v / mx) * (h - 12)
  const pts = vals.map((v, i) => `${X(i).toFixed(1)},${Y(v.w).toFixed(1)}`).join(' ')
  const dots = vals
    .map((v, i) => {
      const last = i === vals.length - 1
      const col = last ? COLORS.accent : v.r ? COLORS.ok : COLORS.line
      return `<g><title>${esc(tips[i] ?? '')}</title><circle cx="${X(i).toFixed(1)}" cy="${Y(v.w).toFixed(1)}" r="${last ? 5 : 4}" fill="${last ? col : 'none'}" stroke="${col}" stroke-width="1.5"/></g>`
    })
    .join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
    `<line x1="8" y1="${h - 6}" x2="${w - 8}" y2="${h - 6}" stroke="${COLORS.track}" stroke-width="1"/>` +
    `<polyline points="${pts}" fill="none" stroke="${COLORS.line}" stroke-width="1.5"/>${dots}</svg>`
  )
}
