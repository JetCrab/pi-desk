import 'server-only'

import { L2PiSessionHistoryQuerySchema } from '@common/l2_biz/pi-session/l2-pi-session-contract'
import { listL2PiSessionHistory } from '@server/l2_biz/pi-session/l2-pi-session'
import {
  createL4ApiErrorResponse,
  createL4ApiSuccessResponse
} from '@server/l4_foundation/http/l4-api-response'

export async function POST(request: Request): Promise<Response> {
  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return createL4ApiErrorResponse(400, '请求 JSON 格式无效', { key: 'errors:invalidJson' })
  }

  const input = L2PiSessionHistoryQuerySchema.safeParse(payload)
  if (!input.success)
    return createL4ApiErrorResponse(400, '历史会话查询参数无效', {
      key: 'errors:historyQueryInvalid'
    })

  try {
    return createL4ApiSuccessResponse(await listL2PiSessionHistory(input.data))
  } catch (error) {
    console.error('[Pi Desk][PiSessionListApi] 查询目录历史会话失败', {
      cwd: input.data.cwd,
      queryLength: input.data.query.length,
      searchIn: input.data.searchIn,
      forceRefresh: input.data.forceRefresh,
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
    return createL4ApiErrorResponse(500, '查询 Pi 历史会话失败', {
      key: 'errors:historyQueryFailed'
    })
  }
}
