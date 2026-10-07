import 'server-only'

import { L2WorkSessionBranchRequestSchema } from '@common/l2_biz/work-session/l2-work-session-tree-contract'
import {
  getL2WorkSessionManage,
  WorkSessionBindingChangedError,
  WorkSessionBranchBlockedError,
  WorkSessionBranchEntryNotFoundError,
  WorkSessionBranchInvalidError,
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

  const input = L2WorkSessionBranchRequestSchema.safeParse(payload)
  if (!input.success)
    return createL4ApiErrorResponse(400, '分支操作参数无效', { key: 'errors:branchInputInvalid' })

  try {
    const data = await getL2WorkSessionManage().branchWorkSession(input.data)
    return createL4ApiSuccessResponse(data, input.data.action === 'tree' ? 200 : 201)
  } catch (error) {
    if (error instanceof WorkSessionNotFoundError) {
      return createL4ApiErrorResponse(404, '工作会话不存在', { key: 'errors:sessionMissing' })
    }
    if (error instanceof WorkSessionBranchEntryNotFoundError) {
      return createL4ApiErrorResponse(404, '分支节点不存在或已失效', {
        key: 'errors:branchEntryMissing'
      })
    }
    if (error instanceof WorkSessionBranchInvalidError) {
      return createL4ApiErrorResponse(400, error.message, {
        key: error.kind === 'fork-target' ? 'errors:branchForkUserOnly' : 'errors:branchCloneEmpty'
      })
    }
    if (error instanceof WorkSessionBindingChangedError) {
      return createL4ApiErrorResponse(409, '工作会话已切换，请重新打开会话树', {
        key: 'errors:sessionTreeChanged'
      })
    }
    if (error instanceof WorkSessionBranchBlockedError) {
      return createL4ApiErrorResponse(409, error.message)
    }
    console.error('[Pi Desk][WorkSessionBranchApi] 执行分支操作失败', {
      clientId,
      workId: input.data.workId,
      sessionId: input.data.sessionId,
      entryId: 'entryId' in input.data ? input.data.entryId : null,
      action: input.data.action,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      errorMessage: error instanceof Error ? error.message : String(error)
    })
    return createL4ApiErrorResponse(500, '执行分支操作失败', { key: 'errors:branchFailed' })
  }
}
