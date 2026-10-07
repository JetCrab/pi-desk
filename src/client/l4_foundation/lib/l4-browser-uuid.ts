export function createL4BrowserUuid(): string {
  const browserCrypto = globalThis.crypto
  if (typeof browserCrypto.randomUUID === 'function') return browserCrypto.randomUUID()

  // 公网 HTTP 不暴露 randomUUID，但 getRandomValues 仍可用；保持 UUID v4 格式以满足公共协议。
  const bytes = browserCrypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
