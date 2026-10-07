import 'server-only'

import {
  L2CapabilityModesGetRequestSchema,
  L2CapabilityModesReplaceRequestSchema
} from '@common/l2_biz/capability-modes/l2-capability-modes-contract'
import {
  getL2CapabilityModes,
  replaceL2CapabilityModes
} from '@server/l2_biz/capability-modes/l2-capability-modes'
import {
  createL4ApiErrorResponse,
  createL4ApiSuccessResponse
} from '@server/l4_foundation/http/l4-api-response'

export async function getCapabilityModes(request: Request): Promise<Response> {
  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return createL4ApiErrorResponse(400, '请求 JSON 格式无效', { key: 'errors:invalidJson' })
  }
  if (!L2CapabilityModesGetRequestSchema.safeParse(payload).success) {
    return createL4ApiErrorResponse(400, '能力模式查询参数无效', {
      key: 'errors:capabilityGetInvalid'
    })
  }
  try {
    return createL4ApiSuccessResponse(await getL2CapabilityModes())
  } catch (cause) {
    console.error('[Pi Desk][Capabilities] 读取模式设置失败', cause)
    return createL4ApiErrorResponse(
      500,
      cause instanceof Error ? cause.message : '读取能力模式失败',
      cause instanceof Error ? undefined : { key: 'errors:capabilityGetFailed' }
    )
  }
}

export async function replaceCapabilityModes(request: Request): Promise<Response> {
  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return createL4ApiErrorResponse(400, '请求 JSON 格式无效', { key: 'errors:invalidJson' })
  }
  const input = L2CapabilityModesReplaceRequestSchema.safeParse(payload)
  if (!input.success) {
    return createL4ApiErrorResponse(
      400,
      input.error.issues[0]?.message ?? '能力模式格式无效',
      input.error.issues[0] ? undefined : { key: 'errors:capabilityReplaceInvalid' }
    )
  }
  try {
    await replaceL2CapabilityModes(input.data)
    return createL4ApiSuccessResponse({})
  } catch (cause) {
    console.error('[Pi Desk][Capabilities] 保存模式设置失败', cause)
    return createL4ApiErrorResponse(
      500,
      cause instanceof Error ? cause.message : '保存能力模式失败',
      cause instanceof Error ? undefined : { key: 'errors:capabilityReplaceFailed' }
    )
  }
}
