import 'server-only'

import { z } from 'zod'
import {
  L2PluginCatalogGetRequestSchema,
  L2PluginCatalogSearchRequestSchema,
  L2PluginCatalogSettingsRequestSchema
} from '@common/l2_biz/plugin/l2-plugin-catalog-contract'
import { getL2PluginCatalog } from '@server/l2_biz/plugin-management/l2-plugin-catalog'
import { shouldUseL4SecureWebCookie } from '@server/l4_foundation/auth/l4-web-auth'
import {
  createL4ApiErrorResponse,
  createL4ApiSuccessResponse
} from '@server/l4_foundation/http/l4-api-response'
import { readL4ClientId } from '@server/l4_foundation/http/l4-client-id'
import { L4PluginRegistryError } from '@server/l4_foundation/pi/l4-pi-plugin-registry'

async function handle<T>(
  request: Request,
  schema: z.ZodType<T>,
  execute: (input: T) => unknown | Promise<unknown>
): Promise<Response> {
  if (!readL4ClientId(request))
    return createL4ApiErrorResponse(400, '客户端标识无效', { key: 'errors:invalidClient' })
  const origin = request.headers.get('origin')
  const secure = shouldUseL4SecureWebCookie(request.url, request.headers.get('x-forwarded-proto'))
  const expectedOrigin = `${secure ? 'https' : 'http'}://${request.headers.get('host') ?? new URL(request.url).host}`
  if (
    request.headers.get('sec-fetch-site') === 'cross-site' ||
    (origin && origin !== expectedOrigin)
  )
    return createL4ApiErrorResponse(403, '不允许跨站访问插件商店', {
      key: 'auth:crossOriginDenied'
    })
  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return createL4ApiErrorResponse(400, '请求 JSON 格式无效', { key: 'errors:invalidJson' })
  }
  const input = schema.safeParse(payload)
  if (!input.success)
    return createL4ApiErrorResponse(400, '插件商店请求参数无效', { key: 'errors:invalidInput' })
  try {
    const response = createL4ApiSuccessResponse(await execute(input.data))
    response.headers.set('Cache-Control', 'no-store')
    return response
  } catch (error) {
    console.error('[Pi Desk][PluginCatalogApi] 插件商店请求失败', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
      reason: error instanceof L4PluginRegistryError ? error.reason : 'internal'
    })
    if (error instanceof L4PluginRegistryError)
      return createL4ApiErrorResponse(error.status, error.message)
    return createL4ApiErrorResponse(500, '插件商店请求失败')
  }
}

export function searchL1PluginCatalog(request: Request): Promise<Response> {
  return handle(request, L2PluginCatalogSearchRequestSchema, (input) =>
    getL2PluginCatalog().search(input)
  )
}

export function getL1PluginCatalog(request: Request): Promise<Response> {
  return handle(request, L2PluginCatalogGetRequestSchema, (input) =>
    getL2PluginCatalog().get(input)
  )
}

export function getL1PluginCatalogSettings(request: Request): Promise<Response> {
  return handle(request, z.object({}).strict(), () => getL2PluginCatalog().getSettings())
}

export function replaceL1PluginCatalogSettings(request: Request): Promise<Response> {
  return handle(request, L2PluginCatalogSettingsRequestSchema, async (input) => {
    getL2PluginCatalog().replaceSettings(input.downloadSource)
    return await getL2PluginCatalog().getSettings()
  })
}
