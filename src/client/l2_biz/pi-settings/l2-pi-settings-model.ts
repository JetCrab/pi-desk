import {
  L2McpServerConfigSchema,
  type L2McpServerConfig
} from '@common/l2_biz/pi-settings/l2-pi-settings-contract'

export interface L2McpSettingsRow {
  name: string
  config: L2McpServerConfig
  local: L2McpServerConfig | null
  source: string
}

export interface L2McpKeyValue {
  key: string
  value: string
}

export interface L2McpDraft {
  originalName: string | null
  name: string
  transport: 'stdio' | 'http' | 'inherit'
  command: string
  args: string
  env: L2McpKeyValue[]
  headers: L2McpKeyValue[]
  url: string
  description: string
  enabled: boolean
  exposure: string
  advanced: string
}

const FORM_FIELDS = ['command', 'args', 'url', 'type', 'description', 'enabled', 'exposure']

function isStringMap(
  value: L2McpServerConfig[string] | undefined
): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every((item) => typeof item === 'string')
}

function createKeyValues(value: L2McpServerConfig[string] | undefined): L2McpKeyValue[] {
  return isStringMap(value)
    ? Object.entries(value).map(([key, item]) => ({ key, value: item }))
    : []
}

function buildKeyValues(rows: L2McpKeyValue[], field: 'env' | 'headers'): Record<string, string> {
  const entries: [string, string][] = []
  const keys = new Set<string>()
  for (const row of rows) {
    if (!row.key.trim() && !row.value) continue
    if (!row.key.trim()) throw new L2McpInputError(field, '请填写名称，或删除空白行。')
    const key = row.key.trim()
    const identity = field === 'headers' ? key.toLowerCase() : key
    if (keys.has(identity)) throw new L2McpInputError(field, '名称不能重复。')
    keys.add(identity)
    entries.push([key, row.value])
  }
  return Object.fromEntries(entries)
}

export function isL2McpShorthand(config: L2McpServerConfig): boolean {
  return !('command' in config) && !('url' in config) && !('type' in config)
}

export function createL2McpDraft(name: string | null, config?: L2McpServerConfig): L2McpDraft {
  const value = config ?? {}
  return {
    originalName: name,
    name: name ?? '',
    transport: config && isL2McpShorthand(config) ? 'inherit' : 'url' in value ? 'http' : 'stdio',
    command: typeof value.command === 'string' ? value.command : '',
    args: Array.isArray(value.args) ? value.args.join('\n') : '',
    env: createKeyValues(value.env),
    headers: createKeyValues(value.headers),
    url: typeof value.url === 'string' ? value.url : '',
    description: typeof value.description === 'string' ? value.description : '',
    enabled: value.enabled !== false,
    exposure: typeof value.exposure === 'string' ? value.exposure : '',
    advanced: JSON.stringify(
      Object.fromEntries(
        Object.entries(value).filter(
          ([key, item]) =>
            !FORM_FIELDS.includes(key) && !(['env', 'headers'].includes(key) && isStringMap(item))
        )
      ),
      null,
      2
    )
  }
}

export class L2McpInputError extends Error {
  constructor(
    public readonly field: 'name' | 'command' | 'url' | 'env' | 'headers' | 'advanced' | 'json',
    message: string
  ) {
    super(message)
  }
}

export function buildL2McpDraft(
  draft: L2McpDraft,
  original?: L2McpServerConfig
): Record<string, L2McpServerConfig> {
  const name = draft.name.trim()
  if (!name || name.length > 128) throw new L2McpInputError('name', '服务名称需要 1–128 个字符。')
  let advanced: L2McpServerConfig
  try {
    advanced = L2McpServerConfigSchema.parse(JSON.parse(draft.advanced))
  } catch {
    throw new L2McpInputError('advanced', '高级配置需要是 JSON 对象。')
  }
  if (FORM_FIELDS.some((key) => key in advanced))
    throw new L2McpInputError('advanced', '连接、说明、启用和曝光字段请在上方表单中填写。')
  if (
    draft.transport === 'inherit' &&
    Object.keys(advanced).some((key) => key !== 'toolExposure')
  ) {
    throw new L2McpInputError('advanced', '继承连接只允许启用、曝光和 toolExposure 设置。')
  }
  const config: L2McpServerConfig = { ...advanced, enabled: draft.enabled }
  if (draft.exposure) config.exposure = draft.exposure
  if (draft.transport !== 'inherit') {
    if (draft.description) config.description = draft.description
    for (const field of ['env', 'headers'] as const) {
      if (draft[field].length > 0 || isStringMap(original?.[field])) {
        if (field in advanced)
          throw new L2McpInputError('advanced', '环境变量和请求头不能在表单与 JSON 中重复配置。')
        config[field] = buildKeyValues(draft[field], field)
      }
    }
  }
  if (draft.transport === 'stdio') {
    if (!draft.command.trim()) throw new L2McpInputError('command', '请输入启动程序。')
    config.command = draft.command.trim()
    config.args =
      Array.isArray(original?.args) && original.args.join('\n') === draft.args
        ? original.args
        : draft.args
          ? draft.args.split(/\r?\n/)
          : []
    if (original?.type !== undefined || !original || 'url' in original) config.type = 'stdio'
  } else if (draft.transport === 'http') {
    try {
      const url = new URL(draft.url.trim())
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error()
    } catch {
      throw new L2McpInputError('url', '请输入有效的 HTTP 或 HTTPS 地址。')
    }
    config.url = draft.url.trim()
    if (original?.type !== undefined || !original || 'command' in original) config.type = 'http'
  }
  return { [name]: config }
}

export function validateL2McpImport(
  servers: Record<string, L2McpServerConfig>,
  cwd: string | null,
  inherited: Record<string, L2McpServerConfig>
): void {
  for (const [name, config] of Object.entries(servers)) {
    if (!name.trim() || name !== name.trim())
      throw new L2McpInputError('json', '服务名称不能为空或带有首尾空格。')
    if (isL2McpShorthand(config)) {
      if (
        cwd === null ||
        !Object.hasOwn(inherited, name) ||
        Object.keys(config).some((key) => !['enabled', 'exposure', 'toolExposure'].includes(key))
      ) {
        throw new L2McpInputError(
          'json',
          `${name}：继承配置需要同名全局服务，且只允许启用和曝光设置。`
        )
      }
    } else if (config.type === 'sse') {
      throw new L2McpInputError('json', `${name}：不支持 SSE，请使用 HTTP 连接。`)
    } else if (typeof config.command !== 'string' && typeof config.url !== 'string') {
      throw new L2McpInputError('json', `${name}：请提供启动程序或服务地址。`)
    }
  }
}

export function l2McpConnectionLabel(config: L2McpServerConfig): string {
  return typeof config.url === 'string'
    ? config.url
    : typeof config.command === 'string'
      ? config.command
      : '继承全局连接'
}
