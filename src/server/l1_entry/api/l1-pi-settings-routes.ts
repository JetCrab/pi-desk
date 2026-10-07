import 'server-only'

import { z } from 'zod'
import {
  L2McpSettingsGetRequestSchema,
  L2McpSettingsGetResponseSchema,
  L2McpSettingsReplaceRequestSchema,
  L2McpSettingsDelRequestSchema,
  L2McpCheckRequestSchema,
  L2McpCheckResponseSchema,
  L2PiSettingsMutationResponseSchema
} from '@common/l2_biz/pi-settings/l2-pi-settings-contract'
import {
  getL2McpSettings,
  replaceL2McpSettings,
  deleteL2McpSettings,
  checkL2McpServer
} from '@server/l2_biz/pi-settings/l2-pi-settings'
import { getL2WorkSessionManage } from '@server/l2_biz/work-session/l2-work-session-manage'
import { L4PiSettingsError } from '@server/l4_foundation/pi-settings/l4-pi-settings'
import {
  createL4ApiErrorResponse,
  createL4ApiSuccessResponse
} from '@server/l4_foundation/http/l4-api-response'

function route<T>(
  action: string,
  schema: z.ZodType<T>,
  execute: (input: T, request: Request) => Promise<unknown>
): (request: Request) => Promise<Response> {
  return async (request): Promise<Response> => {
    let payload: unknown
    try {
      payload = await request.json()
    } catch {
      return createL4ApiErrorResponse(400, '请求 JSON 格式无效', { key: 'errors:invalidJson' })
    }
    const parsed = schema.safeParse(payload)
    if (!parsed.success) return createL4ApiErrorResponse(400, 'MCP 设置参数无效')
    try {
      const input = parsed.data
      if (
        typeof input === 'object' &&
        input !== null &&
        'cwd' in input &&
        typeof input.cwd === 'string'
      ) {
        const snapshot = await getL2WorkSessionManage().listWorkSessions()
        if (!snapshot.workSessions.some((item) => item.cwd === input.cwd)) {
          throw new L4PiSettingsError(400, '项目目录不属于当前有效工作会话')
        }
      }
      return createL4ApiSuccessResponse(await execute(input, request))
    } catch (error) {
      console.error('[Pi Desk][PiSettingsApi] MCP 设置操作失败', {
        action,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        reason: error instanceof Error ? error.message : String(error)
      })
      return createL4ApiErrorResponse(
        error instanceof L4PiSettingsError ? error.status : 500,
        error instanceof L4PiSettingsError ? error.message : 'MCP 设置操作失败'
      )
    }
  }
}

export const mcpSettingsGetPOST = route(
  'mcp-settings/get',
  L2McpSettingsGetRequestSchema,
  async ({ cwd }) => L2McpSettingsGetResponseSchema.parse(await getL2McpSettings(cwd))
)
export const mcpSettingsReplacePOST = route(
  'mcp-settings/replace',
  L2McpSettingsReplaceRequestSchema,
  async (input) => L2PiSettingsMutationResponseSchema.parse(await replaceL2McpSettings(input))
)
export const mcpSettingsDelPOST = route(
  'mcp-settings/del',
  L2McpSettingsDelRequestSchema,
  async (input) => L2PiSettingsMutationResponseSchema.parse(await deleteL2McpSettings(input))
)
export const mcpCheckGetPOST = route(
  'mcp-check/get',
  L2McpCheckRequestSchema,
  async (input, request) =>
    L2McpCheckResponseSchema.parse(await checkL2McpServer(input, request.signal))
)
