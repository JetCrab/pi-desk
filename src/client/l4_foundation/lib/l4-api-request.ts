import type { ZodType } from 'zod'
import type { L4ApiResponse } from '@common/l4_foundation/http/l4-api-response-contract'
import { l4LocalizedErrorMessage } from '@client/l4_foundation/locale/l4-localized-error'

export async function requestL4Api<T>(
  clientId: string,
  path: string,
  body: unknown,
  schema: ZodType<T>,
  options: { signal?: AbortSignal; fallbackMessage?: string } = {}
): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': clientId },
    body: JSON.stringify(body),
    signal: options.signal
  })
  const envelope = (await response.json()) as L4ApiResponse<unknown>
  if (!response.ok || envelope.code !== 0 || envelope.data === null) {
    throw new Error(
      envelope.msg ? l4LocalizedErrorMessage(envelope) : (options.fallbackMessage ?? '请求失败')
    )
  }
  return schema.parse(envelope.data)
}
