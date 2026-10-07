import type { ThinkingLevel } from '@earendil-works/pi-agent-core'

export type L4ModelApi = string

export type L4ModelJsonValue =
  string | number | boolean | null | L4ModelJsonValue[] | { [key: string]: L4ModelJsonValue }

export type L4ModelNativeConfig = Record<string, L4ModelJsonValue>

export interface L4ModelThinkingLevelConfig {
  level: ThinkingLevel
  providerValue: string | null
}

export interface L4ModelCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface L4ModelCompatConfig {
  supportsDeveloperRole: boolean | null
  thinkingFormat: string | null
  requiresReasoningContentOnAssistantMessages: boolean | null
}

export interface L4ModelConfig {
  modelId: string
  name: string
  api: L4ModelApi | null
  baseUrl: string | null
  reasoning: boolean
  thinkingLevels: L4ModelThinkingLevelConfig[]
  input: Array<'text' | 'image'>
  contextWindow: number
  maxTokens: number
  cost: L4ModelCost | null
  headers: Record<string, string>
  compat: L4ModelCompatConfig | null
}

export interface L4ModelProviderConfig {
  provider: string
  name: string | null
  baseUrl: string | null
  api: L4ModelApi | null
  apiKey: string | null
  authHeader: boolean | null
  headers: Record<string, string>
  models: L4ModelConfig[]
}

export interface L4ModelPreset {
  provider: string
  modelId: string
  thinkingLevel: ThinkingLevel
  color: string | null
}

export interface L4ModelOption {
  provider: string
  modelId: string
  name: string
  input: Array<'text' | 'image'>
  contextWindow: number
  thinkingLevels: ThinkingLevel[]
}

export interface L4ModelSelection {
  provider: string
  modelId: string
  thinkingLevel: ThinkingLevel
}

export type L4ModelSettingsReplaceInput =
  | { providers: L4ModelProviderConfig[]; presets?: L4ModelPreset[]; nativeConfig?: never }
  | { providers?: L4ModelProviderConfig[]; presets: L4ModelPreset[]; nativeConfig?: never }
  | { nativeConfig: L4ModelNativeConfig; providers?: never; presets?: never }

export interface L4ModelCatalogRequest {
  query: string
  refresh: boolean
  page: { index: number; size: number }
}

export interface L4ModelCatalogSource {
  provider: string
  providerName: string
  modelId: string
  official: boolean
  defaults: {
    reasoning: boolean
    thinkingLevels: L4ModelThinkingLevelConfig[]
    input: Array<'text' | 'image'>
    contextWindow: number
    maxTokens: number
    cost: L4ModelCost | null
  }
}

export interface L4ModelCatalogItem {
  referenceId: string
  name: string
  match: 'exact' | 'similar' | null
  sources: L4ModelCatalogSource[]
}

export type L4ModelCatalogRefreshResult =
  'not-requested' | 'updated' | 'unchanged' | 'partial' | 'cached'

export interface L4ModelCatalogResponse {
  updatedAt: number
  refreshResult: L4ModelCatalogRefreshResult
  page: { index: number; size: number; total: number }
  models: L4ModelCatalogItem[]
}
