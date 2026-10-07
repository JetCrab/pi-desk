import 'server-only'

import { L2WorkSessionTreeGetRequestSchema } from '@common/l2_biz/work-session/l2-work-session-tree-contract'
import {
  getL2WorkSessionManage,
  WorkSessionBindingChangedError,
  WorkSessionNotFoundError
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

  const input = L2WorkSessionTreeGetRequestSchema.safeParse(payload)
  if (!input.success)
    return createL4ApiErrorResponse(400, '会话树查询参数无效', { key: 'errors:sessionTreeInvalid' })

  try {
    return createL4ApiSuccessResponse(await getL2WorkSessionManage().getWorkSessionTree(input.data))
  } catch (error) {
    if (error instanceof WorkSessionNotFoundError) {
      return createL4ApiErrorResponse(404, '工作会话不存在', { key: 'errors:sessionMissing' })
    }
    if (error instanceof WorkSessionBindingChangedError) {
      return createL4ApiErrorResponse(409, '工作会话已切换，请重新打开会话树', {
        key: 'errors:sessionTreeChanged'
      })
    }
    console.error('[Pi Desk][WorkSessionTreeGetApi] 读取会话树失败', {
      clientId,
      workId: input.data.workId,
      sessionId: input.data.sessionId,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined
    })
    return createL4ApiErrorResponse(500, '读取会话树失败', { key: 'errors:sessionTreeFailed' })
  }
}
