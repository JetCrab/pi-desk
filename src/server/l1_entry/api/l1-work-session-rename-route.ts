import 'server-only'

import { L2RenameWorkSessionRequestSchema } from '@common/l2_biz/work-session/l2-work-session-contract'
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

  const input = L2RenameWorkSessionRequestSchema.safeParse(payload)
  if (!input.success)
    return createL4ApiErrorResponse(400, '会话标题参数无效', {
      key: 'errors:workSessionRenameInvalid'
    })

  try {
    await getL2WorkSessionManage().renameWorkSession(input.data)
    return createL4ApiSuccessResponse({})
  } catch (error) {
    // 管理器由 Node 与 Next 共享，不依赖跨加载边界的业务异常构造器身份。
    if (error instanceof Error && error.name === 'WorkSessionNotFoundError') {
      return createL4ApiErrorResponse(404, '工作会话不存在', { key: 'errors:sessionMissing' })
    }
    if (error instanceof Error && error.name === 'WorkSessionBindingChangedError') {
      return createL4ApiErrorResponse(409, '工作会话已切换，请重新打开标题编辑', {
        key: 'errors:workSessionRenameChanged'
      })
    }
    console.error('[Pi Desk][WorkSessionRenameApi] 修改会话标题失败', {
      clientId,
      workId: input.data.workId,
      sessionId: input.data.sessionId,
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
    return createL4ApiErrorResponse(500, '修改会话标题失败', {
      key: 'errors:workSessionRenameFailed'
    })
  }
}
