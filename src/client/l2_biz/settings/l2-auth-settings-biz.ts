import type { z } from 'zod'
import type { L4ApiResponse } from '@common/l4_foundation/http/l4-api-response-contract'
import {
  L2AuthLogoutResponseSchema,
  L2AuthSettingsGetResponseSchema,
  L2AuthSettingsReplaceRequestSchema,
  L2AuthSettingsReplaceResponseSchema,
  type L2AuthSettings,
  type L2AuthSettingsReplaceRequest
} from '@common/l2_biz/auth/l2-auth-contract'
import { l4LocalizedErrorMessage } from '@client/l4_foundation/locale/l4-localized-error'

async function request<T>(
  clientId: string,
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
  signal?: AbortSignal
): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': clientId },
    body: JSON.stringify(body),
    signal
  })
  if (response.status === 401) window.location.replace('/login')
  const envelope = (await response.json()) as L4ApiResponse<unknown>
  if (!response.ok || envelope.code !== 0 || envelope.data === null) {
    throw new Error(
      envelope.code === 0
        ? l4LocalizedErrorMessage({
            msg: '登录保护设置处理失败',
            i18n: { key: 'auth:settingsFailed' }
          })
        : l4LocalizedErrorMessage(envelope)
    )
  }
  return schema.parse(envelope.data)
}

export function getL2AuthSettings(clientId: string, signal: AbortSignal): Promise<L2AuthSettings> {
  return request(clientId, '/api/auth-settings/get', {}, L2AuthSettingsGetResponseSchema, signal)
}

export async function logoutL2Auth(clientId: string): Promise<void> {
  await request(clientId, '/api/auth/logout', {}, L2AuthLogoutResponseSchema)
  window.location.replace('/login')
}

export async function replaceL2AuthSettings(
  clientId: string,
  input: L2AuthSettingsReplaceRequest
): Promise<void> {
  const parsed = L2AuthSettingsReplaceRequestSchema.safeParse(input)
  if (!parsed.success) {
    throw new Error(
      l4LocalizedErrorMessage({
        msg: '请填写至少 8 位密码',
        i18n: { key: 'auth:settingsInvalid' }
      })
    )
  }
  await request(
    clientId,
    '/api/auth-settings/replace',
    parsed.data,
    L2AuthSettingsReplaceResponseSchema
  )
  window.location.replace(input.password === null ? '/' : '/login')
}
