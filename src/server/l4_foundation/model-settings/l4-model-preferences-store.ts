import 'server-only'

import { existsSync, readFileSync } from 'node:fs'
import { getUnifiedConfigPath, readConfigSection } from '@jetcrab/pi-desk-sdk/config'

export function readModelJsonRecord(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  const content = readFileSync(path, 'utf8')
  let value: unknown
  try {
    // Pi 的解析器未公开导出；保持相同的单行注释/尾逗号语法，匹配时保留字符串。
    const json = (content.charCodeAt(0) === 0xfeff ? content.slice(1) : content)
      .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ''))
      .replace(
        /"(?:\\.|[^"\\])*"|,(\s*[}\]])/g,
        (match, tail: string | undefined) => tail ?? (match[0] === '"' ? match : '')
      )
    value = JSON.parse(json)
  } catch (cause) {
    throw new Error(
      `配置文件 ${path} 解析失败：${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    )
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} 必须是 JSON 对象`)
  }
  return value as Record<string, unknown>
}

export function modelPreferencesPath(): string {
  return getUnifiedConfigPath()
}

export function readL4ModelPreferences(): Record<string, unknown> {
  return readConfigSection('pi-desk', 'models')
}
