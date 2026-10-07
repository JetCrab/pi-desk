import 'server-only'

import { after } from 'next/server'
import {
  L2AuthLogoutRequestSchema,
  L2AuthLogoutResponseSchema
} from '@common/l2_biz/auth/l2-auth-contract'
import { L4_APP_SOCKET_AUTH_CHANGED_CLOSE_CODE } from '@common/l4_foundation/realtime/l4-app-websocket-contract'
import {
  isL2WebSessionAuthenticated,
  L2_WEB_SESSION_COOKIE_NAME
} from '@server/l2_biz/auth/l2-auth'
import { L4AuthConfigError } from '@server/l4_foundation/auth/l4-auth-config'
import {
  createL4WebAuthCookieHeader,
  readL4WebAuthCookie,
  shouldUseL4SecureWebCookie
} from '@server/l4_foundation/auth/l4-web-auth'
import {
  createL4ApiErrorResponse,
  createL4ApiSuccessResponse
} from '@server/l4_foundation/http/l4-api-response'
import { readL4ClientId } from '@server/l4_foundation/http/l4-client-id'
import { getL1AppSocketRuntime } from '@server/l1_entry/websocket/l1-app-socket-runtime'

export async function POST(request: Request): Promise<Response> {
  const clientId = readL4ClientId(request)
  if (!clientId)
    return createL4ApiErrorResponse(400, '客户端标识无效', { key: 'auth:invalidClient' })

  const secure = shouldUseL4SecureWebCookie(request.url, request.headers.get('x-forwarded-proto'))
  const expectedOrigin = `${secure ? 'https' : 'http'}://${request.headers.get('host') ?? new URL(request.url).host}`
  const origin = request.headers.get('origin')
  if (
    request.headers.get('sec-fetch-site') === 'cross-site' ||
    (origin && origin !== expectedOrigin)
  ) {
    return createL4ApiErrorResponse(403, '不允许跨站退出登录', {
      key: 'auth:logoutCrossOriginDenied'
    })
  }

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return createL4ApiErrorResponse(400, '请求 JSON 格式无效', { key: 'auth:invalidInput' })
  }
  if (!L2AuthLogoutRequestSchema.safeParse(payload).success) {
    return createL4ApiErrorResponse(400, '退出登录参数无效', { key: 'auth:logoutInvalid' })
  }

  const cookie = request.headers.get('cookie') ?? undefined
  try {
    if (!isL2WebSessionAuthenticated(cookie)) {
      return createL4ApiErrorResponse(401, '请先登录', { key: 'common:authenticationRequired' })
    }
    const response = createL4ApiSuccessResponse(L2AuthLogoutResponseSchema.parse({}))
    response.headers.set('Cache-Control', 'no-store')
    response.headers.append(
      'Set-Cookie',
      createL4WebAuthCookieHeader(L2_WEB_SESSION_COOKIE_NAME, '', 0, secure)
    )
    const token = readL4WebAuthCookie(cookie, L2_WEB_SESSION_COOKIE_NAME)
    if (token) {
      // 先发出清除 Cookie 的响应，再通知标签页跳转，避免仍携带旧 Cookie 返回工作台。
      after(async () => {
        try {
          await getL1AppSocketRuntime().closeByAuthToken(
            token,
            L4_APP_SOCKET_AUTH_CHANGED_CLOSE_CODE,
            '已退出登录'
          )
        } catch (error) {
          console.error('[Pi Desk][AuthLogoutApi] 关闭退出登录连接失败', {
            clientId,
            errorName: error instanceof Error ? error.name : 'UnknownError'
          })
        }
      })
    }
    console.info('[Pi Desk][AuthLogoutApi] 当前浏览器已退出登录', { clientId })
    return response
  } catch (error) {
    console.error('[Pi Desk][AuthLogoutApi] 退出登录失败', {
      clientId,
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
    if (error instanceof L4AuthConfigError) {
      return createL4ApiErrorResponse(503, error.message, { key: 'auth:configUnavailable' })
    }
    return createL4ApiErrorResponse(500, '退出登录失败，请稍后重试', { key: 'auth:logoutFailed' })
  }
}
