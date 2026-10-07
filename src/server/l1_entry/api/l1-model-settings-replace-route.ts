import 'server-only'

import { L2ModelSettingsReplaceRequestSchema } from '@common/l2_biz/model-settings/l2-model-settings-contract'
import { replaceL2ModelSettings } from '@server/l2_biz/model-settings/l2-model-settings'
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
  const input = L2ModelSettingsReplaceRequestSchema.safeParse(payload)
  if (!input.success)
    return createL4ApiErrorResponse(400, '模型配置格式无效', { key: 'errors:modelSettingsInvalid' })

  try {
    await replaceL2ModelSettings(input.data)
    return createL4ApiSuccessResponse({})
  } catch (error) {
    console.error('[Pi Desk][ModelSettingsReplaceApi] 保存模型配置失败', {
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
    return createL4ApiErrorResponse(
      400,
      error instanceof Error && error.message ? error.message : '保存模型配置失败',
      error instanceof Error && error.message ? undefined : { key: 'errors:modelSaveFailed' }
    )
  }
}
