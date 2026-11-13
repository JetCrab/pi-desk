import type { PluginConfig } from '../../src/config-api.js'
import type { PluginJsonObject } from '../../src/shared.js'

export function memoryConfig(initial: PluginJsonObject = {}): PluginConfig {
  let value = structuredClone(initial)
  return {
    async get(): Promise<PluginJsonObject> {
      return structuredClone(value)
    },
    async set(next, options): Promise<void> {
      if (options?.encryptPaths?.length) {
        throw new Error('此业务夹具不提供加密；加密测试使用真实配置存储')
      }
      value = structuredClone(next)
    },
    async encrypt(): Promise<string> {
      throw new Error('此业务夹具不提供加密')
    },
    async decrypt(): Promise<never> {
      throw new Error('此业务夹具不提供解密')
    }
  }
}
