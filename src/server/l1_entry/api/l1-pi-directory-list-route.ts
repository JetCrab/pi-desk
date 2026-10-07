import 'server-only'

import { L2PiDirectoryListRequestSchema } from '@common/l2_biz/pi-session/l2-pi-session-contract'
import { listL2PiDirectories } from '@server/l2_biz/pi-session/l2-pi-session'
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

  const input = L2PiDirectoryListRequestSchema.safeParse(payload)
  if (!input.success)
    return createL4ApiErrorResponse(400, 'forceRefresh 格式无效', { key: 'errors:refreshInvalid' })

  try {
    return createL4ApiSuccessResponse(await listL2PiDirectories(input.data.forceRefresh))
  } catch (error) {
    console.error('[Pi Desk][PiDirectoryListApi] 查询 Pi 目录失败', {
      forceRefresh: input.data.forceRefresh,
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
    return createL4ApiErrorResponse(500, '查询 Pi 目录失败', { key: 'errors:piDirectoriesFailed' })
  }
}
