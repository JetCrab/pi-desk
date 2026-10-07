import type { L4ApiResponse } from '@common/l4_foundation/http/l4-api-response-contract'
import { l4LocalizedErrorMessage } from '@client/l4_foundation/locale/l4-localized-error'
import {
  L2AuthLoginRequestSchema,
  L2AuthLoginResponseSchema,
  type L2AuthLoginRequest,
  type L2AuthLoginResponse
} from '@common/l2_biz/auth/l2-auth-contract'

export async function loginL2Auth(clientId: string, input: L2AuthLoginRequest): Promise<void> {
  const parsed = L2AuthLoginRequestSchema.safeParse(input)
  if (!parsed.success) {
    throw new Error(
      l4LocalizedErrorMessage({ msg: '登录参数无效', i18n: { key: 'auth:invalidInput' } })
    )
  }
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-Pi-Desk-Client-Id': clientId
    },
    body: JSON.stringify(parsed.data)
  })

  let envelope: L4ApiResponse<L2AuthLoginResponse>
  try {
    envelope = (await response.json()) as L4ApiResponse<L2AuthLoginResponse>
  } catch {
    throw new Error(
      l4LocalizedErrorMessage({ msg: '登录服务响应无效', i18n: { key: 'auth:invalidResponse' } })
    )
  }

  if (!response.ok || envelope.code !== 0 || envelope.data === null) {
    throw new Error(
      envelope.code === 0
        ? l4LocalizedErrorMessage({ msg: '登录失败', i18n: { key: 'auth:loginFailed' } })
        : l4LocalizedErrorMessage(envelope)
    )
  }
  L2AuthLoginResponseSchema.parse(envelope.data)
}
