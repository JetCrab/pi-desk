import 'server-only'

import { L2TaskMessageGetRequestSchema } from '@common/l2_biz/task-center/l2-task-center-contract'
import {
  L2TaskDetailUnavailableError,
  L2TaskDetailUnsupportedError,
  L2TaskMessageDetailUnavailableError,
  L2TaskMessageNotFoundError,
  L2TaskNotFoundError
} from '@server/l2_biz/task-center/l2-task-center-runtime'
import { L2ChatSourceBindingError } from '@server/l2_biz/work-session/l2-work-session-chat-runtime'
import { getL1TaskCenterRuntime } from '@server/l1_entry/l1-task-center-runtime'
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

  const input = L2TaskMessageGetRequestSchema.safeParse(payload)
  if (!input.success)
    return createL4ApiErrorResponse(400, '任务详情参数无效', { key: 'errors:taskDetailInvalid' })

  try {
    return createL4ApiSuccessResponse(
      await getL1TaskCenterRuntime().getMessageDetail(
        input.data.source,
        input.data.taskId,
        input.data.entryId
      )
    )
  } catch (error) {
    if (error instanceof L2ChatSourceBindingError) {
      return createL4ApiErrorResponse(409, '工作会话来源已变化', {
        key: 'errors:taskSourceChanged'
      })
    }
    if (error instanceof L2TaskNotFoundError) {
      return createL4ApiErrorResponse(404, '任务不存在', { key: 'errors:taskMissing' })
    }
    if (error instanceof L2TaskDetailUnsupportedError) {
      return createL4ApiErrorResponse(409, '任务不支持会话详情', {
        key: 'errors:taskDetailUnsupported'
      })
    }
    if (error instanceof L2TaskMessageNotFoundError) {
      return createL4ApiErrorResponse(404, '任务消息不存在', { key: 'errors:taskMessageMissing' })
    }
    if (error instanceof L2TaskMessageDetailUnavailableError) {
      return createL4ApiErrorResponse(409, '任务消息没有详情', {
        key: 'errors:taskMessageNoDetail'
      })
    }
    if (error instanceof L2TaskDetailUnavailableError) {
      return createL4ApiErrorResponse(409, '任务会话暂不可用', {
        key: 'errors:taskConversationUnavailable'
      })
    }

    console.error('[Pi Desk][TaskMessageDetailApi] 查询任务消息详情失败', {
      workId: input.data.source.workId,
      taskId: input.data.taskId,
      entryId: input.data.entryId,
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
    return createL4ApiErrorResponse(500, '查询任务消息详情失败', {
      key: 'errors:taskMessageFailed'
    })
  }
}
