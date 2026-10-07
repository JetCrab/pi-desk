import 'server-only'

import { L2ChatImageGetRequestSchema } from '@common/l2_biz/chat/l2-chat-contract'
import {
  L2ChatMessageNotFoundError,
  L2ChatSourceBindingError
} from '@server/l2_biz/work-session/l2-work-session-chat-runtime'
import { getL2WorkSessionManage } from '@server/l2_biz/work-session/l2-work-session-manage'
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

  const input = L2ChatImageGetRequestSchema.safeParse(payload)
  if (!input.success)
    return createL4ApiErrorResponse(400, '聊天图片参数无效', { key: 'errors:chatImageInvalid' })

  try {
    return createL4ApiSuccessResponse(await getL2WorkSessionManage().getChatImage(input.data))
  } catch (error) {
    if (error instanceof L2ChatSourceBindingError) {
      return createL4ApiErrorResponse(409, '聊天 Source 已过期', { key: 'errors:sourceExpired' })
    }
    if (error instanceof L2ChatMessageNotFoundError) {
      return createL4ApiErrorResponse(404, '聊天图片不存在', { key: 'errors:chatImageMissing' })
    }

    console.error('[Pi Desk][ChatImageApi] 查询聊天图片失败', {
      sessionId: input.data.sessionId,
      branchId: input.data.branchId,
      entryId: input.data.entryId,
      imageIndex: input.data.imageIndex,
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
    return createL4ApiErrorResponse(500, '查询聊天图片失败', { key: 'errors:chatImageFailed' })
  }
}
