import 'server-only'

import type { L4ErrorTranslation } from '@common/l4_foundation/locale/l4-error-translation'
import type {
  L4ApiErrorResponse,
  L4ApiSuccessResponse
} from '@common/l4_foundation/http/l4-api-response-contract'

export function createL4ApiSuccessResponse<T>(data: T, status = 200): Response {
  const body: L4ApiSuccessResponse<T> = {
    code: 0,
    msg: '',
    data
  }
  return Response.json(body, { status })
}

export function createL4ApiErrorResponse(
  status: number,
  msg: string,
  i18n?: L4ErrorTranslation
): Response {
  const body: L4ApiErrorResponse = {
    code: status,
    msg,
    data: null,
    ...(i18n ? { i18n } : {})
  }
  return Response.json(body, { status })
}
