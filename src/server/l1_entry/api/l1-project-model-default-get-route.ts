import 'server-only'

import { L2ProjectModelDefaultGetRequestSchema } from '@common/l2_biz/model-settings/l2-model-settings-contract'
import { getL2ProjectModelDefault } from '@server/l2_biz/model-settings/l2-model-settings'
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
  const input = L2ProjectModelDefaultGetRequestSchema.safeParse(payload)
  if (!input.success)
    return createL4ApiErrorResponse(400, '项目目录参数无效', {
      key: 'errors:projectDefaultInputInvalid'
    })

  try {
    return createL4ApiSuccessResponse(await getL2ProjectModelDefault(input.data.cwd))
  } catch (error) {
    console.error('[Pi Desk][ProjectModelDefaultGetApi] 读取项目默认模型失败', {
      cwd: input.data.cwd,
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
    return createL4ApiErrorResponse(400, '读取项目默认模型失败', {
      key: 'errors:projectDefaultGetFailed'
    })
  }
}
