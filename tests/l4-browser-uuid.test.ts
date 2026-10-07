import assert from 'node:assert/strict'
import test from 'node:test'
import { createL4BrowserUuid } from '../src/client/l4_foundation/lib/l4-browser-uuid'

test('浏览器 UUID 优先使用原生能力并在公网 HTTP 下生成标准 v4 UUID', () => {
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  assert.ok(originalCrypto)

  try {
    const nativeUuid = '11111111-1111-4111-8111-111111111111'
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {
        randomUUID: () => nativeUuid,
        getRandomValues: () => {
          throw new Error('原生 randomUUID 可用时不应生成随机字节')
        }
      }
    })
    assert.equal(createL4BrowserUuid(), nativeUuid)

    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {
        getRandomValues: (bytes: Uint8Array) => {
          bytes.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
          return bytes
        }
      }
    })
    assert.equal(createL4BrowserUuid(), '00010203-0405-4607-8809-0a0b0c0d0e0f')
  } finally {
    Object.defineProperty(globalThis, 'crypto', originalCrypto)
  }
})
