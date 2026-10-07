import { z } from 'zod'
import {
  L2McpServersSchema,
  L2McpSettingsGetResponseSchema,
  L2McpCheckResponseSchema,
  L2PiSettingsMutationResponseSchema,
  type L2McpServerConfig,
  type L2McpSettings,
  type L2McpSettingsReplaceRequest
} from '@common/l2_biz/pi-settings/l2-pi-settings-contract'
import { requestL4Api } from '@client/l4_foundation/lib/l4-api-request'

export function parseL2McpImport(text: string): Record<string, L2McpServerConfig> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('请输入有效的 JSON。')
  }
  const parsed = z.object({ mcpServers: L2McpServersSchema }).strict().safeParse(value)
  if (!parsed.success) throw new Error('仅接受包含 mcpServers 的标准配置，不允许其他根级字段。')
  if (Object.keys(parsed.data.mcpServers).length === 0) throw new Error('配置中至少需要一个服务。')
  return parsed.data.mcpServers
}

export interface L2PiSettingsBiz {
  getMcp(cwd: string | null, signal?: AbortSignal): Promise<L2McpSettings>
  replaceMcp(
    input: L2McpSettingsReplaceRequest,
    signal?: AbortSignal
  ): Promise<Record<string, never>>
  deleteMcp(cwd: string | null, name: string, signal?: AbortSignal): Promise<Record<string, never>>
  checkMcp(cwd: string | null, name: string, signal?: AbortSignal): Promise<{ output: string }>
}

export function createL2PiSettingsBiz(clientId: string): L2PiSettingsBiz {
  return {
    getMcp: (cwd: string | null, signal?: AbortSignal) =>
      requestL4Api(clientId, '/api/mcp-settings/get', { cwd }, L2McpSettingsGetResponseSchema, {
        signal
      }),
    replaceMcp: (input: L2McpSettingsReplaceRequest, signal?: AbortSignal) =>
      requestL4Api(
        clientId,
        '/api/mcp-settings/replace',
        input,
        L2PiSettingsMutationResponseSchema,
        { signal }
      ),
    deleteMcp: (cwd: string | null, name: string, signal?: AbortSignal) =>
      requestL4Api(
        clientId,
        '/api/mcp-settings/del',
        { cwd, name },
        L2PiSettingsMutationResponseSchema,
        { signal }
      ),
    checkMcp: (cwd: string | null, name: string, signal?: AbortSignal) =>
      requestL4Api(clientId, '/api/mcp-check/get', { cwd, name }, L2McpCheckResponseSchema, {
        signal
      })
  }
}
