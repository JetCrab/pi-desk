'use client'

import type { L4ErrorTranslation } from '@common/l4_foundation/locale/l4-error-translation'

type ErrorTranslator = (key: string, params: L4ErrorTranslation['params']) => string | null
let translator: ErrorTranslator | null = null

export function registerL4ErrorTranslator(next: ErrorTranslator | null): void {
  translator = next
}

export function l4LocalizedErrorMessage(error: { msg: string; i18n?: L4ErrorTranslation }): string {
  if (!error.i18n) return error.msg
  return translator?.(error.i18n.key, error.i18n.params) ?? error.msg
}
