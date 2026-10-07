import 'server-only'

import { L2PiDirectoryIgnoreReplaceRequestSchema } from '@common/l2_biz/pi-session/l2-pi-session-contract'
import { replaceL2PiDirectoryIgnore } from '@server/l2_biz/pi-session/l2-pi-session'
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

  const input = L2PiDirectoryIgnoreReplaceRequestSchema.safeParse(payload)
  if (!input.success)
    return createL4ApiErrorResponse(400, '忽略目录参数无效', {
      key: 'errors:directoryIgnoreInvalid'
    })

  try {
    return createL4ApiSuccessResponse(
      replaceL2PiDirectoryIgnore(input.data.cwd, input.data.ignored)
    )
  } catch (error) {
    console.error('[Pi Desk][PiDirectoryIgnoreReplaceApi] 更新忽略目录失败', {
      clientId,
      cwd: input.data.cwd,
      ignored: input.data.ignored,
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
    return createL4ApiErrorResponse(500, '更新忽略目录失败', {
      key: 'errors:directoryIgnoreFailed'
    })
  }
}
