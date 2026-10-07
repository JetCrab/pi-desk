import type { L4ErrorTranslation } from '@common/l4_foundation/locale/l4-error-translation'

export interface L4ApiSuccessResponse<T> {
  code: 0
  msg: ''
  data: T
}

export interface L4ApiErrorResponse {
  code: number
  msg: string
  data: null
  i18n?: L4ErrorTranslation
}

export type L4ApiResponse<T> = L4ApiSuccessResponse<T> | L4ApiErrorResponse
