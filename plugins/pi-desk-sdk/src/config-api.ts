import type { PluginJsonObject, PluginJsonValue } from './shared.js'

/** cwd 由调用方确认可信；仅使用该项目，不搜索父目录。 */
export interface PluginConfigGetOptions {
  cwd?: string
  /** false 时只读目标层，不应用全局继承或 defaults。 */
  inherit?: boolean
  defaults?: PluginJsonObject
  decryptPaths?: readonly string[]
}

export interface PluginConfigSetOptions {
  cwd?: string
  encryptPaths?: readonly string[]
}

/** 宿主按插件身份绑定；不暴露任意文件位置或密钥。 */
export interface PluginConfig {
  encrypt(value: PluginJsonValue): Promise<string>
  decrypt(value: string): Promise<PluginJsonValue>
  set(conf: PluginJsonObject, options?: PluginConfigSetOptions): Promise<void>
  get(options?: PluginConfigGetOptions): Promise<PluginJsonObject>
}
