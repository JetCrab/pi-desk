import 'server-only'

import { L2ModelSettingsPreviewRequestSchema } from '@common/l2_biz/model-settings/l2-model-settings-contract'
import { previewL2ModelSettings } from '@server/l2_biz/model-settings/l2-model-settings'
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
  const input = L2ModelSettingsPreviewRequestSchema.safeParse(payload)
  if (!input.success)
    return createL4ApiErrorResponse(400, '模型配置格式无效', { key: 'errors:modelSettingsInvalid' })

  try {
    return createL4ApiSuccessResponse(await previewL2ModelSettings(input.data))
  } catch (error) {
    console.error('[Pi Desk][ModelSettingsPreviewApi] 预览模型配置失败', {
      message: error instanceof Error ? error.message : String(error)
    })
    return createL4ApiErrorResponse(
      400,
      error instanceof Error && error.message ? error.message : '预览模型配置失败'
    )
  }
}
