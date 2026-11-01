import type { QuotaResource } from './protocol.js'

export function quotaTypeFromLegacyAdapter(adapter: string): string {
  if (adapter === 'cpa-codex') return 'codex'
  if (adapter === 'cpa-devin') return 'devin'
  if (adapter === 'antigravity-manager') return 'antigravity'
  return adapter
}

export function quotaVisibilityKey(type: string, resource: QuotaResource): string {
  return `${type}:${JSON.stringify([
    resource.kind,
    resource.label,
    resource.scope.feature ?? '',
    resource.scope.model ?? ''
  ])}`
}

export function migrateQuotaVisibilityKey(key: string): string | null {
  const separator = key.indexOf(':')
  if (separator < 1) return null
  const type = quotaTypeFromLegacyAdapter(key.slice(0, separator))
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(type)) return null
  try {
    const parts: unknown = JSON.parse(key.slice(separator + 1))
    if (
      !Array.isArray(parts) ||
      (parts.length !== 3 && parts.length !== 4) ||
      !parts.every((part) => typeof part === 'string') ||
      !['balance', 'quota'].includes(parts[0])
    ) {
      return null
    }
    return `${type}:${JSON.stringify(parts.length === 3 ? [...parts, ''] : parts)}`
  } catch {
    return null
  }
}
