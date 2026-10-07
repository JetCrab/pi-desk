import type { QuotaAdapterDescriptor, QuotaResource } from '../protocol.js'

export interface QuotaAdapterLoadContext {
  config: Record<string, string>
  signal: AbortSignal
  fetch: typeof fetch
  now: number
}

export interface QuotaAdapterLoadResult {
  resources: QuotaResource[]
  warning: string | null
  /** Internal source cooldown; never enters the Browser snapshot. */
  retryAt?: number | null
}

export interface QuotaAdapter {
  descriptor: QuotaAdapterDescriptor
  cacheTtlMs: number
  minRefreshIntervalMs: number
  timeoutMs: number
  validateConfig(input: Record<string, string>): Record<string, string>
  load(context: QuotaAdapterLoadContext): Promise<QuotaAdapterLoadResult>
}
