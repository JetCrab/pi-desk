import 'server-only'

import { L2ChatModelContextGetRequestSchema } from '@common/l2_biz/chat/l2-chat-context-contract'
import {
  L2ChatLifecycleBlockedError,
  L2ChatSourceBindingError
} from '@server/l2_biz/work-session/l2-work-session-chat-runtime'
import { getL2WorkSessionManage } from '@server/l2_biz/work-session/l2-work-session-manage'
import { L4PiModelContextBusyError } from '@server/l4_foundation/pi/l4-pi-chat-worker'
import {
  createL4ApiErrorResponse,
  createL4ApiSuccessResponse
} from '@server/l4_foundation/http/l4-api-response'

export async function POST(request: Request): Promise<Response> {
  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return createL4ApiErrorResponse(400, '系统上下文请求 JSON 格式无效', {
      key: 'errors:chatContextJsonInvalid'
    })
  }

  const input = L2ChatModelContextGetRequestSchema.safeParse(payload)
  if (!input.success)
    return createL4ApiErrorResponse(400, '系统上下文请求参数无效', {
      key: 'errors:chatContextInvalid'
    })

  try {
    return createL4ApiSuccessResponse(
      await getL2WorkSessionManage().getChatModelContext(input.data)
    )
  } catch (error) {
    if (error instanceof L2ChatSourceBindingError) {
      return createL4ApiErrorResponse(409, '聊天 Source 已过期', { key: 'errors:sourceExpired' })
    }
    if (error instanceof L2ChatLifecycleBlockedError) {
      return createL4ApiErrorResponse(409, '工作会话正在替换或切换分支', {
        key: 'errors:chatSourceBusy'
      })
    }
    if (error instanceof L4PiModelContextBusyError) {
      return createL4ApiErrorResponse(409, error.message, { key: 'errors:chatContextBusy' })
    }

    console.error('[Pi Desk][ChatModelContextApi] 读取系统上下文失败', {
      workId: input.data.source.workId,
      sessionId: input.data.source.sessionId,
      branchId: input.data.source.branchId,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      errorMessage: error instanceof Error ? error.message : String(error)
    })
    return createL4ApiErrorResponse(500, '读取系统上下文失败', { key: 'errors:chatContextFailed' })
  }
}
