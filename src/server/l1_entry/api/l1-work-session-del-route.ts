import 'server-only'

import { L2DeleteWorkSessionRequestSchema } from '@common/l2_biz/work-session/l2-work-session-contract'
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

  const input = L2DeleteWorkSessionRequestSchema.safeParse(payload)
  if (!input.success)
    return createL4ApiErrorResponse(400, 'workId 格式无效', {
      key: 'errors:workSessionDeleteInvalid'
    })

  try {
    const manage = getL2WorkSessionManage()
    if (!(await manage.removeWorkSession(input.data.workId))) {
      return createL4ApiErrorResponse(404, '工作会话不存在', { key: 'errors:sessionMissing' })
    }

    return createL4ApiSuccessResponse(await manage.listWorkSessions())
  } catch (error) {
    console.error('[Pi Desk][WorkSessionDelApi] 删除工作会话失败', {
      clientId,
      workId: input.data.workId,
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
    return createL4ApiErrorResponse(500, '删除工作会话失败', {
      key: 'errors:workSessionDeleteFailed'
    })
  }
}
