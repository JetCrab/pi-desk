import 'server-only'

import { L2ReplaceWorkSessionRequestSchema } from '@common/l2_biz/work-session/l2-work-session-contract'
import {
  getL2WorkSessionManage,
  WorkSessionNotFoundError,
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

  const input = L2ReplaceWorkSessionRequestSchema.safeParse(payload)
  if (!input.success)
    return createL4ApiErrorResponse(400, '替换会话参数无效', {
      key: 'errors:workSessionReplaceInvalid'
    })

  const historySession =
    'sessionId' in input.data ? { cwd: input.data.cwd, sessionId: input.data.sessionId } : undefined

  try {
    return createL4ApiSuccessResponse(
      await getL2WorkSessionManage().replaceWorkSession(input.data.workId, historySession)
    )
  } catch (error) {
    if (error instanceof WorkSessionNotFoundError) {
      return createL4ApiErrorResponse(404, '工作会话不存在', { key: 'errors:sessionMissing' })
    }
    if (error instanceof WorkSessionSessionConflictError) {
      return createL4ApiErrorResponse(409, 'Pi 会话已绑定到其他工作会话', {
        key: 'errors:workSessionReplaceOccupied'
      })
    }
    console.error('[Pi Desk][WorkSessionReplaceApi] 替换 Pi 会话失败', {
      clientId,
      workId: input.data.workId,
      replacementType: historySession ? 'history' : 'empty',
      ...historySession,
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
    return createL4ApiErrorResponse(500, '替换 Pi 会话失败', {
      key: 'errors:workSessionReplaceFailed'
    })
  }
}
