import 'server-only'

import type { z } from 'zod'
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

export async function handleCapabilityModesRequest<T>(
  request: Request,
  schema: z.ZodType<T>,
  operation: (input: T) => Promise<unknown>
): Promise<Response> {
  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return createL4ApiErrorResponse(400, '请求 JSON 格式无效', { key: 'errors:invalidJson' })
  }
  const input = schema.safeParse(payload)
  if (!input.success) {
    return createL4ApiErrorResponse(400, input.error.issues[0]?.message ?? '能力模式参数无效')
  }
  try {
    return createL4ApiSuccessResponse((await operation(input.data)) ?? {})
  } catch (cause) {
    // Store 会跨 Next 入口与热重载存活，不能依赖构造函数的引用身份。
    if (cause instanceof Error && cause.name === 'L4CapabilityModesInputError') {
      return createL4ApiErrorResponse(400, cause.message)
    }
    console.error('[Pi Desk][Capabilities] 配置请求失败', {
      path: new URL(request.url).pathname,
      message: cause instanceof Error ? cause.message : String(cause)
    })
    return createL4ApiErrorResponse(
      500,
      cause instanceof Error ? cause.message : '能力模式配置操作失败'
    )
  }
}

export async function getCapabilityModes(request: Request): Promise<Response> {
  return handleCapabilityModesRequest(
    request,
    L2CapabilityModesGetRequestSchema,
    getL2CapabilityModes
  )
}

export async function replaceCapabilityModes(request: Request): Promise<Response> {
  return handleCapabilityModesRequest(
    request,
    L2CapabilityModesReplaceRequestSchema,
    replaceL2CapabilityModes
  )
}
