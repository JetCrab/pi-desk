import 'server-only'

import { L2PiDirectoryEntryListRequestSchema } from '@common/l2_biz/pi-session/l2-pi-session-contract'
import { listL2PiDirectoryEntries } from '@server/l2_biz/pi-session/l2-pi-session'
import {
  isL4PiDirectoryInvalidError,
  isL4PiDirectoryReadError
} from '@server/l4_foundation/pi/l4-pi-directory-browser'
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

  const input = L2PiDirectoryEntryListRequestSchema.safeParse(payload)
  if (!input.success)
    return createL4ApiErrorResponse(400, '目录浏览参数无效', {
      key: 'errors:directoryBrowseInvalid'
    })

  try {
    return createL4ApiSuccessResponse(await listL2PiDirectoryEntries(input.data.cwd))
  } catch (error) {
    if (isL4PiDirectoryInvalidError(error)) {
      return createL4ApiErrorResponse(400, '目录不存在或不是目录', {
        key: 'errors:directoryMissing'
      })
    }
    if (isL4PiDirectoryReadError(error)) {
      return createL4ApiErrorResponse(403, '无法读取目录', { key: 'errors:directoryReadDenied' })
    }
    console.error('[Pi Desk][PiDirectoryEntryListApi] 浏览服务端目录失败', {
      cwd: input.data.cwd,
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
    return createL4ApiErrorResponse(500, '浏览服务端目录失败', {
      key: 'errors:directoryBrowseFailed'
    })
  }
}
