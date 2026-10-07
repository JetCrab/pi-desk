import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { CapabilityOption } from '@jetcrab/pi-desk-sdk/capabilities'
import { fileURLToPath } from 'node:url'
import type { ThinkingLevel } from '@earendil-works/pi-agent-core'
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from '@earendil-works/pi-coding-agent'

const BUILTIN_AGENTS_DIR = fileURLToPath(new URL('../agents/', import.meta.url))
const AGENT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const THINKING_LEVELS = new Set<ThinkingLevel>([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
])

export type SubagentName = string

export interface SubagentConfig {
  name: SubagentName
  description: string
  tools: string[]
  model?: string
  thinking?: ThinkingLevel
  systemPrompt: string
}

export interface DiscoverSubagentConfigsOptions {
  cwd: string
  projectTrusted: boolean
  agentDir?: string
  builtinAgentsDir?: string | null
}

export interface DiscoverSubagentConfigsResult {
  configs: Map<SubagentName, SubagentConfig>
  diagnostics: string[]
}

type AgentFrontmatter = {
  description?: unknown
  tools?: unknown
  model?: unknown
  thinking?: unknown
}

type AgentSettings = {
  agents?: unknown
}

type AgentSetting = {
  modelSelection?: { model: string; thinking?: ThinkingLevel }
  disabled?: boolean
}

type AgentFile = {
  name: SubagentName
  filePath: string
}

export function isSubagentName(value: unknown): value is SubagentName {
  return typeof value === 'string' && AGENT_NAME_PATTERN.test(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function parseTools(value: unknown, name: SubagentName): string[] {
  const text = nonEmptyString(value)
  if (!text) throw new Error(`Agent "${name}" must define a tools allowlist`)
  const tools = [
    ...new Set(
      text
        .split(',')
        .map((tool) => tool.trim())
        .filter(Boolean)
    )
  ]
  const invalid = tools.filter((tool) => !TOOL_NAME_PATTERN.test(tool))
  if (invalid.length > 0) {
    throw new Error(`Agent "${name}" has invalid tool names: ${invalid.join(', ')}`)
  }
  return tools
}

function parseThinking(value: unknown, name: SubagentName): ThinkingLevel | undefined {
  const thinking = nonEmptyString(value)
  if (!thinking) return undefined
  if (!THINKING_LEVELS.has(thinking as ThinkingLevel)) {
    throw new Error(`Agent "${name}" has unsupported thinking level: ${thinking}`)
  }
  return thinking as ThinkingLevel
}

function findProjectConfigDir(cwd: string): string | undefined {
  let current = cwd
  while (true) {
    const candidate = join(current, CONFIG_DIR_NAME)
    if (existsSync(candidate)) return candidate
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

// model 只表示 provider/modelId，模型 ID 自身可能含 "/"，因此在第一个分隔符处切分后整段保留。
// thinking 是独立字段，避免用字符串后缀表达，防止模型 ID 与 thinking 相互歧义。
function parseModelSelection(
  selection: string,
  name: SubagentName
): { model: string; thinking?: ThinkingLevel } {
  const separator = selection.indexOf('/')
  if (separator <= 0 || separator === selection.length - 1) {
    throw new Error(`Agent "${name}" setting must use provider/model format`)
  }
  return { model: selection }
}

function readAgentSetting(
  settingsPath: string | undefined,
  name: SubagentName
): AgentSetting | undefined {
  if (!settingsPath || !existsSync(settingsPath)) return undefined
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as AgentSettings
  if (settings.agents === undefined) return undefined
  if (!settings.agents || typeof settings.agents !== 'object' || Array.isArray(settings.agents)) {
    throw new Error(`Agent settings must be an object: ${settingsPath}`)
  }

  const value = (settings.agents as Record<string, unknown>)[name]
  if (value === undefined) return undefined
  if (typeof value === 'string') {
    const selection = nonEmptyString(value)
    if (!selection) throw new Error(`Agent "${name}" model cannot be empty: ${settingsPath}`)
    return { modelSelection: parseModelSelection(selection, name) }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Agent "${name}" setting must be a model string or object: ${settingsPath}`)
  }

  const setting = value as Record<string, unknown>
  let modelSelection: { model: string; thinking?: ThinkingLevel } | undefined
  if (setting.model !== undefined) {
    const model = nonEmptyString(setting.model)
    if (!model) throw new Error(`Agent "${name}" model cannot be empty: ${settingsPath}`)
    modelSelection = parseModelSelection(model, name)
    if (setting.thinking !== undefined) {
      modelSelection.thinking = parseThinking(setting.thinking, name)
    }
  }

  let disabled: boolean | undefined
  if (setting.disabled !== undefined) {
    if (typeof setting.disabled !== 'boolean') {
      throw new Error(`Agent "${name}" disabled must be boolean: ${settingsPath}`)
    }
    disabled = setting.disabled
  }
  return { modelSelection, disabled }
}

function listAgentFiles(
  directory: string | undefined,
  diagnostics: string[]
): Map<string, AgentFile> {
  const files = new Map<string, AgentFile>()
  if (!directory || !existsSync(directory)) return files

  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch (error) {
    diagnostics.push(
      `Unable to read Agent directory "${directory}": ${error instanceof Error ? error.message : String(error)}`
    )
    return files
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const name = entry.name.slice(0, -3)
    const filePath = join(directory, entry.name)
    if (!isSubagentName(name)) {
      diagnostics.push(`Agent file has an invalid agent name: ${filePath}`)
      continue
    }
    files.set(name, { name, filePath })
  }
  return files
}

function loadConfig(params: {
  name: SubagentName
  filePath: string
  modelSelection?: { model: string; thinking?: ThinkingLevel }
}): SubagentConfig {
  const content = readFileSync(params.filePath, 'utf8')
  const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content)
  const description = nonEmptyString(frontmatter.description)
  if (!description) throw new Error(`Agent "${params.name}" must define a description`)
  const systemPrompt = body.trim()
  if (!systemPrompt) throw new Error(`Agent "${params.name}" has an empty system prompt`)
  return {
    name: params.name,
    description,
    tools: parseTools(frontmatter.tools, params.name),
    model: params.modelSelection?.model ?? nonEmptyString(frontmatter.model),
    thinking: params.modelSelection?.thinking ?? parseThinking(frontmatter.thinking, params.name),
    systemPrompt
  }
}

export function discoverSubagentConfigs(
  options: DiscoverSubagentConfigsOptions
): DiscoverSubagentConfigsResult {
  const agentDir = options.agentDir ?? getAgentDir()
  const projectConfigDir = options.projectTrusted ? findProjectConfigDir(options.cwd) : undefined
  const globalSettingsPath = join(agentDir, 'settings.json')
  const projectSettingsPath = projectConfigDir ? join(projectConfigDir, 'settings.json') : undefined
  const diagnostics: string[] = []
  const selectedFiles = new Map<string, AgentFile>()
  const builtinAgentsDir =
    options.builtinAgentsDir === undefined ? BUILTIN_AGENTS_DIR : options.builtinAgentsDir

  for (const file of listAgentFiles(builtinAgentsDir ?? undefined, diagnostics).values()) {
    selectedFiles.set(file.name, file)
  }
  for (const file of listAgentFiles(join(agentDir, 'agents'), diagnostics).values()) {
    selectedFiles.set(file.name, file)
  }
  if (projectConfigDir) {
    for (const file of listAgentFiles(join(projectConfigDir, 'agents'), diagnostics).values()) {
      selectedFiles.set(file.name, file)
    }
  }

  const configs = new Map<SubagentName, SubagentConfig>()

  for (const name of [...selectedFiles.keys()].sort()) {
    const file = selectedFiles.get(name)
    if (!file) continue

    try {
      const globalSetting = readAgentSetting(globalSettingsPath, name)
      const projectSetting = readAgentSetting(projectSettingsPath, name)
      if (projectSetting?.disabled ?? globalSetting?.disabled ?? false) continue
      const modelSelection = projectSetting?.modelSelection ?? globalSetting?.modelSelection
      configs.set(
        name,
        loadConfig({
          name,
          filePath: file.filePath,
          modelSelection
        })
      )
    } catch (error) {
      diagnostics.push(error instanceof Error ? error.message : String(error))
    }
  }

  return { configs, diagnostics }
}

export function listGlobalSubagentSettings(agentDir = getAgentDir()): Array<{
  name: string
  model: string
  thinking: ThinkingLevel | null
  disabled: boolean
}> {
  const names = new Set([
    ...listAgentFiles(BUILTIN_AGENTS_DIR, []).keys(),
    ...listAgentFiles(join(agentDir, 'agents'), []).keys()
  ])
  const settingsPath = join(agentDir, 'settings.json')
  return [...names].sort().map((name) => {
    const setting = readAgentSetting(settingsPath, name)
    return {
      name,
      model: setting?.modelSelection?.model ?? '',
      thinking: setting?.modelSelection?.thinking ?? null,
      disabled: setting?.disabled ?? false
    }
  })
}

export function collectSubagentCapabilityOptions(
  cwds: readonly string[],
  signal?: AbortSignal,
  agentDir = getAgentDir()
): CapabilityOption[] {
  const uniqueCwds = new Map<string, string>()
  for (const cwd of cwds) {
    const path = resolve(cwd)
    uniqueCwds.set(process.platform === 'win32' ? path.toLowerCase() : path, path)
  }
  const sources = [
    { cwd: agentDir, projectTrusted: false, agentDir },
    ...[...uniqueCwds.values()].map((cwd) => ({ cwd, projectTrusted: true, agentDir }))
  ]
  const options = new Map<string, CapabilityOption>()
  for (const source of sources) {
    signal?.throwIfAborted()
    // A settings catalog only reads definitions; it does not grant project execution trust.
    const { configs } = discoverSubagentConfigs(source)
    for (const config of configs.values()) {
      const description = config.description.slice(0, 1000)
      const previous = options.get(config.name)
      if (!previous) options.set(config.name, { value: config.name, description })
      else if (previous.description !== description)
        options.set(config.name, { value: config.name })
    }
  }
  return [...options.values()].sort((left, right) => left.value.localeCompare(right.value))
}
