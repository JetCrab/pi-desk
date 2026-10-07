import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ThinkingLevel } from '@earendil-works/pi-agent-core'
import { getAgentDir, ModelRuntime, withFileMutationQueue } from '@earendil-works/pi-coding-agent'
import { PluginMethodError } from '@jetcrab/pi-desk-sdk/session'
import { listGlobalSubagentSettings } from './agent-config.js'

const levels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

type AgentSettingInput = {
  name: string
  model: string
  thinking: ThinkingLevel | null
  disabled: boolean
}

function parseSettings(input: unknown): AgentSettingInput[] {
  if (!input || typeof input !== 'object' || !('agents' in input) || !Array.isArray(input.agents)) {
    throw new PluginMethodError(400, '子代理设置参数无效')
  }
  const names = new Set(listGlobalSubagentSettings().map((agent) => agent.name))
  const seen = new Set<string>()
  return input.agents.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new PluginMethodError(400, '子代理设置参数无效')
    const value = item as Record<string, unknown>
    if (
      typeof value.name !== 'string' ||
      !names.has(value.name) ||
      seen.has(value.name) ||
      typeof value.model !== 'string' ||
      (value.model !== '' && !/^[^/\s]+\/\S+$/.test(value.model)) ||
      (value.thinking !== null && !levels.has(String(value.thinking))) ||
      typeof value.disabled !== 'boolean'
    ) {
      throw new PluginMethodError(400, '子代理设置参数无效')
    }
    seen.add(value.name)
    return value as AgentSettingInput
  })
}

async function availableModels(): Promise<
  Array<{ provider: string; modelId: string; name: string }>
> {
  const runtime = await ModelRuntime.create({ allowModelNetwork: false })
  const error = runtime.getError()
  if (error) throw new Error(error)
  return (await runtime.getAvailable())
    .filter((model) => model.input.includes('text'))
    .map((model) => ({ provider: model.provider, modelId: model.id, name: model.name }))
    .sort((a, b) => `${a.provider}/${a.modelId}`.localeCompare(`${b.provider}/${b.modelId}`))
}

export async function getGlobalSubagentSettings(): Promise<{
  agents: AgentSettingInput[]
  models: Awaited<ReturnType<typeof availableModels>>
}> {
  return { agents: listGlobalSubagentSettings(), models: await availableModels() }
}

export async function saveGlobalSubagentSettings(
  input: unknown
): Promise<{ agents: AgentSettingInput[] }> {
  const changes = parseSettings(input)
  const models = changes.some((item) => item.model && !item.disabled)
    ? new Set((await availableModels()).map((model) => `${model.provider}/${model.modelId}`))
    : null
  for (const item of changes) {
    if (item.model && !item.disabled && !models?.has(item.model)) {
      throw new PluginMethodError(400, `模型当前不可用：${item.model}`)
    }
  }
  const path = join(getAgentDir(), 'settings.json')
  await withFileMutationQueue(path, async () => {
    const settings = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    const agents = settings.agents
    if (agents !== undefined && (!agents || typeof agents !== 'object' || Array.isArray(agents))) {
      throw new Error('全局 agents 配置不是对象')
    }
    const next: Record<string, unknown> = { ...(agents as Record<string, unknown> | undefined) }
    for (const item of changes) {
      const previous = next[item.name]
      const original =
        previous && typeof previous === 'object' && !Array.isArray(previous)
          ? (previous as Record<string, unknown>)
          : {}
      const entry = { ...original }
      if (item.model) entry.model = item.model
      else delete entry.model
      if (item.thinking !== null && item.model) entry.thinking = item.thinking
      else delete entry.thinking
      if (item.disabled) entry.disabled = true
      else delete entry.disabled
      if (Object.keys(entry).length) next[item.name] = entry
      else delete next[item.name]
    }
    settings.agents = next
    const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
      await rename(temporary, path)
    } catch (error) {
      const { rm } = await import('node:fs/promises')
      await rm(temporary, { force: true })
      throw error
    }
  })
  console.info('[pi-desk-subagent] 全局子代理配置已保存', {
    agents: changes.map((item) => item.name)
  })
  return { agents: listGlobalSubagentSettings() }
}
