import 'server-only'

import {
  DefaultResourceLoader,
  SettingsManager,
  type ExtensionAPI,
  type McpServerConfig,
  type McpServerEntry
} from '@earendil-works/pi-coding-agent'
import type { L4McpServerConfig } from './l4-pi-settings-types'

export interface L4McpDiagnostic {
  name: string | null
  message: string
  scope: 'global' | 'project'
}

export interface L4McpConfigSource {
  path: string
  servers: Record<string, unknown>
  autoEnableCodemode?: unknown
}

export async function resolveL4McpConfig(
  agentDir: string,
  cwd: string,
  global: L4McpConfigSource,
  project?: L4McpConfigSource
): Promise<{ entries: McpServerEntry[]; diagnostics: L4McpDiagnostic[] }> {
  const entries = new Map<string, McpServerEntry>()
  const diagnostics: L4McpDiagnostic[] = []
  let api: ExtensionAPI | undefined
  // No session_start, models or connections exist in this validation-only loader.
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: '',
    appendSystemPrompt: [],
    extensionFactories: [
      (pi): void => {
        api = pi
      }
    ]
  })
  await loader.reload()
  const errors = loader.getExtensions().errors
  if (errors.length > 0 || !api)
    throw new Error(`MCP 校验器加载失败：${errors.map((error) => error.error).join('; ')}`)
  // Factory registrations are queued until loading finishes; call the active public API now.
  const pi = api
  for (const [scope, source] of [
    ['global', global],
    ['project', project]
  ] as const) {
    if (!source) continue
    if (source.autoEnableCodemode !== undefined && typeof source.autoEnableCodemode !== 'boolean') {
      diagnostics.push({
        name: null,
        scope,
        message: `${source.path}: autoEnableCodemode 必须是布尔值`
      })
    }
    for (const [name, raw] of Object.entries(source.servers)) {
      try {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
          throw new Error('服务配置必须是 JSON 对象')
        let value = raw as L4McpServerConfig
        const base = entries.get(name)
        const shorthand =
          scope === 'project' &&
          value.command === undefined &&
          value.url === undefined &&
          value.type === undefined
        if (shorthand) {
          if (!base) throw new Error('项目简写需要同名的有效全局服务')
          if (
            Object.keys(value).some((key) => !['enabled', 'exposure', 'toolExposure'].includes(key))
          ) {
            throw new Error('项目简写只能设置 enabled、exposure、toolExposure')
          }
          value = { ...base.config, ...value } as L4McpServerConfig
        } else if (
          scope === 'project' &&
          typeof value.url === 'string' &&
          value.auth !== undefined
        ) {
          throw new Error('auth.provider 只允许在全局 mcp.json 中配置')
        }
        // The public registration API owns known-field validation and namespace collisions.
        pi.registerMcpServer(name, value as unknown as McpServerConfig)
        const registered = pi.getMcpServers().find((server) => server.name === name)!
        entries.set(
          name,
          shorthand
            ? { ...base!, config: registered.config, override: source.path }
            : { name, config: registered.config, source: source.path, scope }
        )
      } catch (error) {
        diagnostics.push({
          name,
          scope,
          message: `${source.path}: 服务「${name}」无效：${error instanceof Error ? error.message : String(error)}`
        })
      }
    }
  }
  return { entries: [...entries.values()], diagnostics }
}
