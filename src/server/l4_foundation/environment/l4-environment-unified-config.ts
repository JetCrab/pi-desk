import { randomUUID } from 'node:crypto'
import { parseDocument } from 'yaml'
import { z } from 'zod'
import type { PluginConfig, PluginJsonValue } from '@jetcrab/pi-desk-sdk/entry'

/** 归档内部使用既有逻辑凭据条目；目标环境重新加密，不复制系统主密钥。 */
export async function exportL4UnifiedConfig(
  content: Buffer,
  config: PluginConfig
): Promise<{ content: Buffer; paths: string[]; secrets: Record<string, string> }> {
  const document = parseDocument(content.toString('utf8'), { uniqueKeys: true, schema: 'core' })
  if (document.errors.length) throw new Error('统一配置 YAML 无法解析')
  const value = z.record(z.string(), z.json()).parse(document.toJS() ?? {})
  const paths: string[] = []
  const secrets: Record<string, string> = {}
  async function visit(value: PluginJsonValue, path: (string | number)[]): Promise<void> {
    if (typeof value === 'string' && value.startsWith('enc:v1:')) {
      const reference = `secret://${randomUUID()}`
      secrets[reference] = JSON.stringify(await config.decrypt(value))
      paths.push(
        '/' + path.map((part) => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')
      )
      document.setIn(path, reference)
    } else if (Array.isArray(value)) {
      for (const [index, child] of value.entries()) await visit(child, [...path, index])
    } else if (value !== null && typeof value === 'object') {
      for (const [name, child] of Object.entries(value)) await visit(child, [...path, name])
    }
  }
  await visit(value, [])
  return { content: paths.length ? Buffer.from(document.toString()) : content, paths, secrets }
}

export async function importL4UnifiedConfigSecrets(
  secrets: Readonly<Record<string, string>>,
  config: PluginConfig
): Promise<Record<string, string>> {
  const encrypted: Record<string, string> = {}
  for (const [reference, encoded] of Object.entries(secrets)) {
    encrypted[reference] = await config.encrypt(z.json().parse(JSON.parse(encoded)))
  }
  return encrypted
}
