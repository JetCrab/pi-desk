import 'server-only'

import { L2PiSessionUserMessageListRequestSchema } from '@common/l2_biz/pi-session/l2-pi-session-contract'
import {
  L2PiSessionHistoryNotFoundError,
  listL2PiSessionUserMessages
} from '@server/l2_biz/pi-session/l2-pi-session'
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

  const input = L2PiSessionUserMessageListRequestSchema.safeParse(payload)
  if (!input.success)
    return createL4ApiErrorResponse(400, '用户消息参数无效', { key: 'errors:userMessagesInvalid' })

  try {
    return createL4ApiSuccessResponse(await listL2PiSessionUserMessages(input.data))
  } catch (error) {
    if (error instanceof L2PiSessionHistoryNotFoundError) {
      return createL4ApiErrorResponse(404, 'Pi 会话不存在', { key: 'errors:piSessionMissing' })
    }
    console.error('[Pi Desk][PiSessionUserMessageListApi] 查询历史用户消息失败', {
      cwd: input.data.cwd,
      sessionId: input.data.sessionId,
      queryLength: input.data.query.length,
      pageIndex: input.data.page.index,
      pageSize: input.data.page.size,
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
    return createL4ApiErrorResponse(500, '查询历史用户消息失败', {
      key: 'errors:userMessagesFailed'
    })
  }
}
