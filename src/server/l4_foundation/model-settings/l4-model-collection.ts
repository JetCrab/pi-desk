import 'server-only'

import type { Api, Model } from '@earendil-works/pi-ai'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { isDeepStrictEqual } from 'node:util'
import type { L4AccountModelSelection } from './l4-model-settings-types'

type RecordValue = Record<string, unknown>
const COST_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const

function record(value: unknown): RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as RecordValue)
    : {}
}

export function collectedModelKey(provider: string, modelId: string): string {
  return `${provider}\u0000${modelId}`
}

export function readAccountModelSelections(root: RecordValue): L4AccountModelSelection[] {
  if (root.modelSelections === undefined) return []
  if (!Array.isArray(root.modelSelections)) throw new Error('modelSelections 必须是模型引用数组')
  const seen = new Set<string>()
  return root.modelSelections.map((value) => {
    const ref = record(value)
    if (
      typeof ref.provider !== 'string' ||
      !ref.provider.trim() ||
      typeof ref.modelId !== 'string' ||
      !ref.modelId.trim()
    ) {
      throw new Error('modelSelections 中的模型必须包含服务 ID 和模型 ID')
    }
    const key = collectedModelKey(ref.provider, ref.modelId)
    if (seen.has(key)) throw new Error(`重复收录模型：${ref.provider}/${ref.modelId}`)
    seen.add(key)
    const raw = record(record(record(root.providers)[ref.provider]).modelOverrides)[ref.modelId]
    const override = record(raw)
    const overrides: L4AccountModelSelection['overrides'] = {}
    for (const field of ['contextWindow', 'maxTokens'] as const) {
      if (typeof override[field] === 'number') overrides[field] = override[field]
    }
    if (override.cost !== undefined) {
      const cost = record(override.cost)
      overrides.cost = Object.fromEntries(
        COST_FIELDS.filter((field) => typeof cost[field] === 'number').map((field) => [
          field,
          cost[field]
        ])
      )
    }
    return { provider: ref.provider, modelId: ref.modelId, overrides }
  })
}

export function collectedModelKeys(root: RecordValue): Set<string> {
  const keys = new Set(
    readAccountModelSelections(root).map((item) => collectedModelKey(item.provider, item.modelId))
  )
  for (const [provider, value] of Object.entries(record(root.providers))) {
    const models = record(value).models
    if (!Array.isArray(models)) continue
    for (const raw of models) {
      const model = record(raw)
      if (typeof model.id === 'string') keys.add(collectedModelKey(provider, model.id))
    }
  }
  return keys
}

export function filterCollectedModels(
  models: readonly Model<Api>[],
  runtime: ModelRuntime,
  root: RecordValue
): Model<Api>[] {
  const keys = collectedModelKeys(root)
  const registered = new Set(runtime.getRegisteredProviderIds())
  return models.filter(
    (model) =>
      keys.has(collectedModelKey(model.provider, model.id)) ||
      registered.has(model.provider) ||
      runtime.getRegisteredNativeProvider(model.provider) !== undefined ||
      !runtime.getPhysicalModel(model.provider, model.id)
  )
}

export function applyAccountModelSelections(
  current: RecordValue,
  next: RecordValue,
  selections: L4AccountModelSelection[],
  defaults: ModelRuntime
): void {
  const previous = new Map(
    readAccountModelSelections(current).map((item) => [
      collectedModelKey(item.provider, item.modelId),
      item
    ])
  )
  const seen = new Set<string>()
  const providers = { ...record(next.providers) }
  for (const selection of selections) {
    const key = collectedModelKey(selection.provider, selection.modelId)
    if (seen.has(key)) throw new Error(`重复收录模型：${selection.provider}/${selection.modelId}`)
    seen.add(key)
    const baseline = previous.get(key)
    const model = defaults.getModel(selection.provider, selection.modelId)
    if (!baseline && (!model || !defaults.getProvider(selection.provider)?.auth.oauth)) {
      throw new Error(`登录服务未提供模型：${selection.provider}/${selection.modelId}`)
    }
    const provider = { ...record(providers[selection.provider]) }
    if (
      Array.isArray(provider.models) &&
      provider.models.some((item) => record(item).id === selection.modelId)
    ) {
      throw new Error(`模型已存在于自定义配置：${selection.provider}/${selection.modelId}`)
    }
    const overrides = { ...record(provider.modelOverrides) }
    const raw = { ...record(overrides[selection.modelId]) }
    let changed = false
    for (const field of ['contextWindow', 'maxTokens', 'cost'] as const) {
      const value = selection.overrides[field]
      const old = baseline?.overrides[field]
      if (isDeepStrictEqual(old, value)) continue
      changed = true
      if (value === undefined) delete raw[field]
      else if (field === 'cost') {
        const cost = { ...record(raw.cost) }
        for (const rate of COST_FIELDS) {
          const price = selection.overrides.cost?.[rate]
          if (price === undefined) delete cost[rate]
          else cost[rate] = price
        }
        if (Object.keys(cost).length) raw.cost = cost
        else delete raw.cost
      } else raw[field] = value
    }
    if (changed) {
      if (Object.keys(raw).length) overrides[selection.modelId] = raw
      else delete overrides[selection.modelId]
      if (Object.keys(overrides).length) provider.modelOverrides = overrides
      else delete provider.modelOverrides
      if (Object.keys(provider).length) providers[selection.provider] = provider
      else delete providers[selection.provider]
    }
  }
  const refs = selections.map(({ provider, modelId }) => ({ provider, modelId }))
  const oldRefs = readAccountModelSelections(current).map(({ provider, modelId }) => ({
    provider,
    modelId
  }))
  if (!isDeepStrictEqual(oldRefs, refs)) next.modelSelections = refs
  if (!isDeepStrictEqual(providers, record(next.providers))) next.providers = providers
}
