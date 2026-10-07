import 'server-only'

import { L2ProjectModelDefaultReplaceRequestSchema } from '@common/l2_biz/model-settings/l2-model-settings-contract'
import { replaceL2ProjectModelDefault } from '@server/l2_biz/model-settings/l2-model-settings'
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
  const input = L2ProjectModelDefaultReplaceRequestSchema.safeParse(payload)
  if (!input.success)
    return createL4ApiErrorResponse(400, '项目默认模型格式无效', {
      key: 'errors:projectDefaultSaveInvalid'
    })

  try {
    await replaceL2ProjectModelDefault(input.data)
    return createL4ApiSuccessResponse({})
  } catch (error) {
    console.error('[Pi Desk][ProjectModelDefaultReplaceApi] 保存项目默认模型失败', {
      cwd: input.data.cwd,
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
    return createL4ApiErrorResponse(
      400,
      error instanceof Error && error.message ? error.message : '保存项目默认模型失败',
      error instanceof Error && error.message
        ? undefined
        : { key: 'errors:projectDefaultSaveFailed' }
    )
  }
}
