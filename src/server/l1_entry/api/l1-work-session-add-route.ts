import 'server-only'

import {
  L2CreateWorkSessionRequestSchema,
  L2CreateWorkSessionResponseSchema
} from '@common/l2_biz/work-session/l2-work-session-contract'
import {
  getL2WorkSessionManage,
  isWorkSessionDirectoryInvalidError,
  WorkSessionHistoryNotFoundError,
  WorkSessionSessionConflictError
} from '@server/l2_biz/work-session/l2-work-session-manage'
import { readL4ClientId } from '@server/l4_foundation/http/l4-client-id'
import {
  createL4ApiErrorResponse,
  createL4ApiSuccessResponse
} from '@server/l4_foundation/http/l4-api-response'

export async function POST(request: Request): Promise<Response> {
  const clientId = readL4ClientId(request)
  if (!clientId)
    return createL4ApiErrorResponse(400, '客户端标识无效', { key: 'errors:invalidClient' })

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return createL4ApiErrorResponse(400, '请求 JSON 格式无效', { key: 'errors:invalidJson' })
  }

  const input = L2CreateWorkSessionRequestSchema.safeParse(payload)
  if (!input.success)
    return createL4ApiErrorResponse(400, 'cwd 或 sessionId 无效', {
      key: 'errors:workSessionCreateInvalid'
    })

  try {
    const workSession = await getL2WorkSessionManage().createWorkSession(
      input.data.cwd,
      input.data.sessionId
    )
    const data = L2CreateWorkSessionResponseSchema.parse({ workSession })
    return createL4ApiSuccessResponse(data, 201)
  } catch (error) {
    if (isWorkSessionDirectoryInvalidError(error)) {
      return createL4ApiErrorResponse(400, '项目目录不存在或不是目录', {
        key: 'errors:workSessionDirectoryMissing'
      })
    }
    if (error instanceof WorkSessionHistoryNotFoundError) {
      return createL4ApiErrorResponse(404, '指定目录中不存在 Pi 会话', {
        key: 'errors:historySessionMissing'
      })
    }
    if (error instanceof WorkSessionSessionConflictError) {
      return createL4ApiErrorResponse(409, 'Pi 会话已经关联到其他工作会话', {
        key: 'errors:historySessionOccupied'
      })
    }
    console.error('[Pi Desk][WorkSessionAddApi] 创建工作会话失败', {
      clientId,
      cwd: input.data.cwd,
      sessionId: input.data.sessionId ?? null,
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
    return createL4ApiErrorResponse(500, '创建工作会话失败', {
      key: 'errors:workSessionCreateFailed'
    })
  }
}
