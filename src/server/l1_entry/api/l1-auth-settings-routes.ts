import 'server-only'

import {
  L2AuthSettingsGetRequestSchema,
  L2AuthSettingsGetResponseSchema,
  L2AuthSettingsReplaceRequestSchema,
  L2AuthSettingsReplaceResponseSchema
} from '@common/l2_biz/auth/l2-auth-contract'
import { L4_APP_SOCKET_AUTH_CHANGED_CLOSE_CODE } from '@common/l4_foundation/realtime/l4-app-websocket-contract'
import {
  getL2AuthSettings,
  L2AuthRequiredError,
  L2_WEB_SESSION_COOKIE_NAME,
  replaceL2AuthSettings
} from '@server/l2_biz/auth/l2-auth'
import { L4AuthConfigError } from '@server/l4_foundation/auth/l4-auth-config'
import {
  createL4WebAuthCookieHeader,
  shouldUseL4SecureWebCookie
} from '@server/l4_foundation/auth/l4-web-auth'
import {
  createL4ApiErrorResponse,
  createL4ApiSuccessResponse
} from '@server/l4_foundation/http/l4-api-response'
import { readL4ClientId } from '@server/l4_foundation/http/l4-client-id'
import { getL1AppSocketRuntime } from '@server/l1_entry/websocket/l1-app-socket-runtime'

async function handle(request: Request, action: 'get' | 'replace'): Promise<Response> {
  const clientId = readL4ClientId(request)
  if (!clientId)
    return createL4ApiErrorResponse(400, '客户端标识无效', { key: 'auth:invalidClient' })

  // 默认未启用保护时也只接受同源页面发起的修改。
  const origin = request.headers.get('origin')
  const secure = shouldUseL4SecureWebCookie(request.url, request.headers.get('x-forwarded-proto'))
  const expectedOrigin = `${secure ? 'https' : 'http'}://${request.headers.get('host') ?? new URL(request.url).host}`
  if (
    action === 'replace' &&
    (request.headers.get('sec-fetch-site') === 'cross-site' ||
      (origin && origin !== expectedOrigin))
  ) {
    return createL4ApiErrorResponse(403, '不允许跨站修改登录保护', {
      key: 'auth:crossOriginDenied'
    })
  }

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return createL4ApiErrorResponse(400, '请求 JSON 格式无效', { key: 'auth:settingsInvalid' })
  }
  const cookie = request.headers.get('cookie') ?? undefined
  try {
    if (action === 'get') {
      if (!L2AuthSettingsGetRequestSchema.safeParse(payload).success) {
        return createL4ApiErrorResponse(400, '登录保护参数无效', { key: 'auth:settingsInvalid' })
      }
      const response = createL4ApiSuccessResponse(
        L2AuthSettingsGetResponseSchema.parse(getL2AuthSettings(cookie))
      )
      response.headers.set('Cache-Control', 'no-store')
      return response
    }

    const input = L2AuthSettingsReplaceRequestSchema.safeParse(payload)
    if (!input.success) {
      return createL4ApiErrorResponse(400, '请填写至少 8 位密码', {
        key: 'auth:settingsInvalid'
      })
    }
    await replaceL2AuthSettings(input.data, cookie)
    // closeAll 在首次 await 前同步清理订阅，不能让旧连接继续推送。
    void getL1AppSocketRuntime()
      .closeAll(L4_APP_SOCKET_AUTH_CHANGED_CLOSE_CODE, '登录保护已更新')
      .catch((error: unknown) => {
        console.error('[Pi Desk][AuthSettingsApi] 关闭旧登录连接失败', {
          errorName: error instanceof Error ? error.name : 'UnknownError'
        })
      })
    const response = createL4ApiSuccessResponse(L2AuthSettingsReplaceResponseSchema.parse({}))
    response.headers.set('Cache-Control', 'no-store')
    response.headers.append(
      'Set-Cookie',
      createL4WebAuthCookieHeader(
        L2_WEB_SESSION_COOKIE_NAME,
        '',
        0,
        shouldUseL4SecureWebCookie(request.url, request.headers.get('x-forwarded-proto'))
      )
    )
    console.info('[Pi Desk][AuthSettingsApi] 登录保护设置已保存', { clientId })
    return response
  } catch (error) {
    if (error instanceof L2AuthRequiredError) {
      return createL4ApiErrorResponse(401, error.message, { key: 'common:authenticationRequired' })
    }
    console.error('[Pi Desk][AuthSettingsApi] 登录保护设置处理失败', {
      action,
      clientId,
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
    if (error instanceof L4AuthConfigError) {
      return createL4ApiErrorResponse(503, error.message, { key: 'auth:configUnavailable' })
    }
    return createL4ApiErrorResponse(500, '登录保护设置处理失败', { key: 'auth:settingsFailed' })
  }
}

export function getAuthSettings(request: Request): Promise<Response> {
  return handle(request, 'get')
}

export function replaceAuthSettings(request: Request): Promise<Response> {
  return handle(request, 'replace')
}
