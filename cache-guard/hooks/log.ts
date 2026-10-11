// Structured, content-free logging. Lines go to the debug log (`claude --debug`); nothing here
// ever carries prompt, transcript or file content: only counts, ids, enums and durations.
export type Level = 'debug' | 'info' | 'warn' | 'error'
export type Field = string | number | boolean | null | undefined

const safe = (v: Field): string => {
  if (v === null || v === undefined) return '-'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return v.replace(/\s+/g, '_').slice(0, 80)
}

/** `cache-guard warn ping.lapsed hit=0 need=205000`: one line, key=value, no free text. */
export function formatLine(plugin: string, level: Level, event: string, fields: Record<string, Field> = {}): string {
  const kv = Object.entries(fields)
    .map(([k, v]) => `${k}=${safe(v)}`)
    .join(' ')
  return `${plugin} ${level} ${event}${kv ? ` ${kv}` : ''}`
}
