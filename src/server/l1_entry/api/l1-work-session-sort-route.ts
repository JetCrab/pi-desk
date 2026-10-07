import 'server-only'

import { L2SortWorkSessionsRequestSchema } from '@common/l2_biz/work-session/l2-work-session-contract'
import {
  getL2WorkSessionManage,
  WorkSessionOrderConflictError
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

  const input = L2SortWorkSessionsRequestSchema.safeParse(payload)
  if (!input.success)
    return createL4ApiErrorResponse(400, 'workIds 或 pinnedCount 格式无效', {
      key: 'errors:workSessionSortInvalid'
    })

  try {
    return createL4ApiSuccessResponse(
      await getL2WorkSessionManage().setWorkSessionArrangement(
        input.data.workIds,
        input.data.pinnedCount
      )
    )
  } catch (error) {
    if (error instanceof WorkSessionOrderConflictError) {
      return createL4ApiErrorResponse(409, '工作会话列表已变化，请刷新后重试', {
        key: 'errors:workSessionOrderChanged'
      })
    }
    console.error('[Pi Desk][WorkSessionSortApi] 更新工作会话排列失败', {
      clientId,
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
    return createL4ApiErrorResponse(500, '更新工作会话排列失败', {
      key: 'errors:workSessionSortFailed'
    })
  }
}
