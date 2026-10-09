import 'server-only'

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  getAgentDir,
  ModelRuntime,
  SettingsManager,
  resolveModelScopeWithDiagnostics,
  type AgentSession
} from '@earendil-works/pi-coding-agent'
import { filterL4CollectedModels } from '@server/l4_foundation/model-settings/l4-model-settings'
import type { ThinkingLevel } from '@earendil-works/pi-agent-core'
import { getSupportedThinkingLevels, type Api, type Model } from '@earendil-works/pi-ai'

export interface L4PiModelOption {
  provider: string
  modelId: string
  name: string
  input: Array<'text' | 'image'>
  kind: 'physical' | 'virtual'
  contextWindow: number | null
  thinkingLevels: ThinkingLevel[]
}

export interface L4PiModelPreset {
  provider: string
  modelId: string
  thinkingLevel: ThinkingLevel
  color: string | null
}

export interface L4PiModelCatalog {
  models: L4PiModelOption[]
  presets: L4PiModelPreset[]
}

interface RawPreset {
  provider?: unknown
  modelId?: unknown
  thinkingLevel?: unknown
  color?: unknown
}

const THINKING_LEVELS = new Set<ThinkingLevel>([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
])

function modelKey(provider: string, modelId: string): string {
  return `${provider}\u0000${modelId}`
}

function readRawPresets(): RawPreset[] {
  const path = join(getAgentDir(), 'models.json')
  if (!existsSync(path)) return []
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { modelPresets?: unknown }
    return Array.isArray(value.modelPresets) ? value.modelPresets : []
  } catch (error) {
    console.warn('[Pi Desk][PiModelCatalog] models.json 读取失败', {
      path,
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
    return []
  }
}

function toOption(model: Model<Api>, runtime: ModelRuntime): L4PiModelOption {
  return {
    provider: model.provider,
    modelId: model.id,
    name: model.name,
    input: [...model.input],
    kind: runtime.getPhysicalModel(model.provider, model.id) ? 'physical' : 'virtual',
    contextWindow: model.contextWindow > 0 ? model.contextWindow : null,
    thinkingLevels: [...getSupportedThinkingLevels(model)]
  }
}

export async function readL4PiModelCatalog(
  session: AgentSession | null,
  cwd = process.cwd()
): Promise<L4PiModelCatalog> {
  // 模型下拉框先于用户选择恢复模式出现，不能为列目录执行 Native Extension。
  const agentDir = getAgentDir()
  const runtime =
    session?.modelRuntime ??
    (await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: join(agentDir, 'models.json')
    }))
  const settings = session?.settingsManager ?? SettingsManager.create(cwd, agentDir)
  await runtime.refresh({ allowNetwork: false })
  const enabledModels = settings.getEnabledModels()
  const models = enabledModels?.length
    ? (await resolveModelScopeWithDiagnostics(enabledModels, runtime)).scopedModels.map(
        (item) => item.model
      )
    : [...(await runtime.getAvailable())]

  const uniqueModels = new Map<string, Model<Api>>()
  for (const model of filterL4CollectedModels(models, runtime)) {
    uniqueModels.set(modelKey(model.provider, model.id), model)
  }
  const options = [...uniqueModels.values()].map((model) => toOption(model, runtime))
  const optionsByKey = new Map(
    options.map((option) => [modelKey(option.provider, option.modelId), option])
  )
  const presets: L4PiModelPreset[] = []
  let invalidPresetCount = 0

  for (const preset of readRawPresets()) {
    if (
      typeof preset.provider !== 'string' ||
      !preset.provider.trim() ||
      typeof preset.modelId !== 'string' ||
      !preset.modelId.trim() ||
      typeof preset.thinkingLevel !== 'string' ||
      !THINKING_LEVELS.has(preset.thinkingLevel as ThinkingLevel) ||
      (preset.color !== undefined && preset.color !== null && typeof preset.color !== 'string')
    ) {
      invalidPresetCount += 1
      continue
    }

    const thinkingLevel = preset.thinkingLevel as ThinkingLevel
    const option = optionsByKey.get(modelKey(preset.provider, preset.modelId))
    if (!option || !option.thinkingLevels.includes(thinkingLevel)) {
      invalidPresetCount += 1
      continue
    }
    presets.push({
      provider: preset.provider,
      modelId: preset.modelId,
      thinkingLevel,
      color: typeof preset.color === 'string' && preset.color.trim() ? preset.color : null
    })
  }

  if (invalidPresetCount > 0) {
    console.warn('[Pi Desk][PiModelCatalog] 已忽略无效或不可用的模型预设', {
      cwd: session?.sessionManager.getCwd() ?? cwd,
      count: invalidPresetCount
    })
  }
  return { models: options, presets }
}
