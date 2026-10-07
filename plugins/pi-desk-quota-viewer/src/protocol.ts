import type { QuotaDisplaySettings } from './l2-quota-display-schema.js'
export type { QuotaDisplaySettings } from './l2-quota-display-schema.js'

export const MAX_HIDDEN_ITEMS = 500

export type QuotaDataSource =
  'official_api' | 'official_product' | 'internal_api' | 'local_estimate'

export type QuotaValue =
  | { state: 'known'; value: number }
  | { state: 'unknown' }
  | { state: 'unlimited' }
  | { state: 'not_applicable' }

export type QuotaUnit =
  | { kind: 'currency'; code: string }
  | { kind: 'tokens' }
  | { kind: 'requests' }
  | { kind: 'percentage' }
  | { kind: 'custom'; label: string }

export type QuotaScope = Record<string, string>

export interface QuotaResourceBase {
  /** Stable within one configured source. */
  key: string
  label: string
  scope: QuotaScope
  unit: QuotaUnit
}

export interface QuotaBalanceResource extends QuotaResourceBase {
  kind: 'balance'
  available: QuotaValue
  expiresAt: number | null
}

export interface QuotaWindow {
  kind: 'fixed' | 'rolling' | 'billing' | 'concurrent' | 'unknown'
  durationSeconds: number | null
  resetAt: number | null
}

export interface QuotaLimitResource extends QuotaResourceBase {
  kind: 'quota'
  values: {
    limit: QuotaValue
    used: QuotaValue
    remaining: QuotaValue
  }
  window: QuotaWindow
}

export type QuotaResource = QuotaBalanceResource | QuotaLimitResource

export interface QuotaSourceSnapshot {
  sourceId: string
  adapter: string
  adapterLabel: string
  name: string
  dataSource: QuotaDataSource
  refreshing: boolean
  observedAt: number | null
  staleAt: number | null
  error: string | null
  resources: QuotaResource[]
}

export interface QuotaSnapshot {
  error: string | null
  sources: QuotaSourceSnapshot[]
  display: QuotaDisplaySettings
}

interface QuotaAdapterSettingFieldBase {
  key: string
  label: string
  required: boolean
  description?: string
  placeholder?: string
  defaultValue?: string
}

export type QuotaAdapterSettingField =
  | (QuotaAdapterSettingFieldBase & {
      kind: 'text' | 'url' | 'secret' | 'textarea'
    })
  | (QuotaAdapterSettingFieldBase & {
      kind: 'select'
      options: Array<{
        value: string
        label: string
      }>
    })

export interface QuotaAdapterDescriptor {
  adapter: string
  label: string
  description: string
  dataSource: QuotaDataSource
  resourceKinds: Array<'balance' | 'quota'>
  fields: QuotaAdapterSettingField[]
}

export interface QuotaSettingsSource {
  sourceId: string
  adapter: string
  name: string
  enabled: boolean
  values: Record<string, string>
}

export interface QuotaSettingsSnapshot {
  error: string | null
  adapters: QuotaAdapterDescriptor[]
  sources: QuotaSettingsSource[]
  display: QuotaDisplaySettings
}

export interface QuotaSettingsSaveSource {
  sourceId?: string
  adapter: string
  name: string
  enabled: boolean
  values: Record<string, string>
}
