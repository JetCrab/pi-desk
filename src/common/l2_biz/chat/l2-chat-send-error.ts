export function isL2ChatSendResultUnknown(cause: unknown): boolean {
  const raw = cause instanceof Error && 'rawMessage' in cause ? cause.rawMessage : null
  const message =
    typeof raw === 'string' ? raw : cause instanceof Error && cause.message ? cause.message : ''
  return /WebSocket.*(?:断开|连接|替换)|请求超时|尚未连接/.test(message)
}
