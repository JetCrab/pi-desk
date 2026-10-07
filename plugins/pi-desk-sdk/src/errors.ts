export type PluginMethodErrorCode = 400 | 404 | 409

export class PluginMethodError extends Error {
  readonly code: PluginMethodErrorCode

  constructor(code: PluginMethodErrorCode, message: string) {
    super(message)
    this.name = 'PiDeskPluginMethodError'
    this.code = code
  }
}

export function isPluginMethodError(
  value: unknown
): value is Error & { readonly code: PluginMethodErrorCode } {
  if (!(value instanceof Error) || value.name !== 'PiDeskPluginMethodError') return false
  const code = (value as Error & { code?: unknown }).code
  return code === 400 || code === 404 || code === 409
}
