import 'server-only'

import { L2PiModelsListRequestSchema } from '@common/l2_biz/pi-model/l2-pi-model-contract'
import {
  WorkSessionNotFoundError,
  getL2WorkSessionManage
} from '@server/l2_biz/work-session/l2-work-session-manage'
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

  const input = L2PiModelsListRequestSchema.safeParse(payload)
  if (!input.success)
    return createL4ApiErrorResponse(400, '模型目录参数无效', { key: 'errors:modelCatalogInvalid' })

  try {
    return createL4ApiSuccessResponse(await getL2WorkSessionManage().listModels(input.data.workId))
  } catch (error) {
    if (error instanceof WorkSessionNotFoundError) {
      return createL4ApiErrorResponse(404, '工作会话不存在', { key: 'errors:sessionMissing' })
    }

    console.error('[Pi Desk][PiModelsListApi] 查询模型目录失败', {
      workId: input.data.workId,
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
    return createL4ApiErrorResponse(500, '查询模型目录失败', { key: 'errors:modelsListFailed' })
  }
}
