import 'server-only'

import { L2ModelSettingsGetRequestSchema } from '@common/l2_biz/model-settings/l2-model-settings-contract'
import { getL2ModelSettings } from '@server/l2_biz/model-settings/l2-model-settings'
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
  if (!L2ModelSettingsGetRequestSchema.safeParse(payload).success) {
    return createL4ApiErrorResponse(400, '模型配置参数无效', {
      key: 'errors:modelSettingsGetInvalid'
    })
  }

  try {
    return createL4ApiSuccessResponse(await getL2ModelSettings())
  } catch (error) {
    console.error('[Pi Desk][ModelSettingsGetApi] 读取模型配置失败', {
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
    return createL4ApiErrorResponse(500, '读取模型配置失败', {
      key: 'errors:modelSettingsGetFailed'
    })
  }
}
