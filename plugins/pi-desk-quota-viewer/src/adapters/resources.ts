import type { QuotaValue } from '../protocol.js'

export function known(value: number): QuotaValue {
  return { state: 'known', value }
}

export function unknown(): QuotaValue {
  return { state: 'unknown' }
}

export function unlimited(): QuotaValue {
  return { state: 'unlimited' }
}

export function notApplicable(): QuotaValue {
  return { state: 'not_applicable' }
}

export function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}格式无效`)
  }
  return value as Record<string, unknown>
}

export function optionalObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function numberValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function timestampMs(value: unknown): number | null {
  const numeric = numberValue(value)
  if (numeric !== null) {
    if (numeric <= 0) return null
    return numeric < 1_000_000_000_000 ? Math.round(numeric * 1000) : Math.round(numeric)
  }
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function field(record: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (Object.hasOwn(record, name)) return record[name]
  }
  return undefined
}

export function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function normalizedLines(value: string): string[] {
  return [
    ...new Set(
      value
        .replaceAll('\r\n', '\n')
        .replaceAll('\r', '\n')
        .split('\n')
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ]
}

export function normalizedLineText(value: string): string {
  return normalizedLines(value).join('\n')
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function resourceKey(...parts: Array<string | number>): string {
  return parts.map((part) => encodeURIComponent(String(part).trim().toLowerCase())).join('/')
}
