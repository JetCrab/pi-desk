import 'server-only'

import { L2WorkSessionSearchRequestSchema } from '@common/l2_biz/work-session/l2-work-session-search-contract'
import { getL2WorkSessionManage } from '@server/l2_biz/work-session/l2-work-session-manage'
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

  const input = L2WorkSessionSearchRequestSchema.safeParse(payload)
  if (!input.success) return createL4ApiErrorResponse(400, '工作会话搜索参数无效')

  try {
    return createL4ApiSuccessResponse(await getL2WorkSessionManage().searchWorkSessions(input.data))
  } catch (error) {
    console.error('[Pi Desk][WorkSessionSearchApi] 搜索工作会话失败', {
      clientId,
      queryLength: input.data.query.length,
      searchIn: input.data.searchIn,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      errorMessage: error instanceof Error ? error.message : String(error)
    })
    return createL4ApiErrorResponse(500, '搜索工作会话失败')
  }
}
