import 'server-only'

import {
  L2AuthLoginRequestSchema,
  L2AuthLoginResponseSchema
} from '@common/l2_biz/auth/l2-auth-contract'
import { authenticateL2WebLogin } from '@server/l2_biz/auth/l2-auth'
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

export async function POST(request: Request): Promise<Response> {
  const clientId = readL4ClientId(request)
  if (!clientId)
    return createL4ApiErrorResponse(400, '客户端标识无效', { key: 'auth:invalidClient' })

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return createL4ApiErrorResponse(400, '请求 JSON 格式无效', { key: 'auth:invalidInput' })
  }

  const input = L2AuthLoginRequestSchema.safeParse(payload)
  if (!input.success)
    return createL4ApiErrorResponse(400, '登录参数无效', { key: 'auth:invalidInput' })

  try {
    const result = await authenticateL2WebLogin(input.data)
    if (!result) {
      console.warn('[Pi Desk][AuthLoginApi] 登录凭据无效', { clientId })
      return createL4ApiErrorResponse(401, '密码不正确', { key: 'auth:invalidCredentials' })
    }

    const response = createL4ApiSuccessResponse(L2AuthLoginResponseSchema.parse({}))
    response.headers.set('Cache-Control', 'no-store')
    response.headers.append(
      'Set-Cookie',
      createL4WebAuthCookieHeader(
        result.cookieName,
        result.token,
        result.maxAgeSeconds,
        shouldUseL4SecureWebCookie(request.url, request.headers.get('x-forwarded-proto'))
      )
    )
    console.info('[Pi Desk][AuthLoginApi] 登录成功', { clientId })
    return response
  } catch (error) {
    console.error('[Pi Desk][AuthLoginApi] 登录处理失败', {
      clientId,
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
    if (error instanceof L4AuthConfigError) {
      return createL4ApiErrorResponse(503, error.message, { key: 'auth:configUnavailable' })
    }
    return createL4ApiErrorResponse(500, '登录失败，请稍后重试', { key: 'auth:loginFailed' })
  }
}
