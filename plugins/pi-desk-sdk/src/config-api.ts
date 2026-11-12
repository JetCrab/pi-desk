import type { PluginJsonObject, PluginJsonValue } from './shared.js'

/** 宿主按插件身份绑定；不暴露文件位置或密钥。 */
export interface PluginConfig {
  encrypt(value: PluginJsonValue): Promise<string>
  decrypt(value: string): Promise<PluginJsonValue>
  set(conf: PluginJsonObject, encryptPaths?: readonly string[]): Promise<void>
  get(decryptPaths?: readonly string[]): Promise<PluginJsonObject>
}
