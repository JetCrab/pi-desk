import { posix, win32 } from 'node:path'
import {
  environmentPathKey,
  mapEnvironmentPath,
  normalizeEnvironmentPath,
  type EnvironmentPathMapping,
  type EnvironmentPlatform
} from './l4-environment-paths'

export interface EnvironmentSessionConversion {
  sourcePlatform: EnvironmentPlatform
  targetPlatform: EnvironmentPlatform
  sourceSessionFile: string
  targetSessionFile: string
  projectMappings: readonly EnvironmentPathMapping[]
  sessionFileMappings: readonly EnvironmentPathMapping[]
}

export interface EnvironmentMissingReference {
  kind: 'project' | 'session'
  path: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 单行转换便于上层逐行处理大 JSONL；未改动的行保持字节文本，不扫描正文或工具参数。 */
export function convertEnvironmentSessionLine(
  line: string,
  options: EnvironmentSessionConversion
): { line: string; missingReferences: EnvironmentMissingReference[] } {
  if (!line.trim()) return { line, missingReferences: [] }
  const entry: unknown = JSON.parse(line)
  if (!isRecord(entry)) throw new Error('会话 JSONL 条目必须是对象')
  const sourceApi = options.sourcePlatform === 'win32' ? win32 : posix
  const targetApi = options.targetPlatform === 'win32' ? win32 : posix
  const missingReferences: EnvironmentMissingReference[] = []
  let changed = false

  function rewrite(
    record: Record<string, unknown>,
    field: string,
    kind: 'project' | 'session'
  ): void {
    const original = record[field]
    if (typeof original !== 'string' || !original) return
    let target: string | null = null
    if (kind === 'project') {
      target = mapEnvironmentPath(
        original,
        options.projectMappings,
        options.sourcePlatform,
        options.targetPlatform
      )
    } else {
      const relative = !sourceApi.isAbsolute(original)
      if (relative && options.sourcePlatform === 'win32' && /^(?:[a-z]:|[\\/])/i.test(original)) {
        throw new Error('会话引用不支持隐式 Windows 盘符')
      }
      const absolute = normalizeEnvironmentPath(
        relative
          ? sourceApi.join(sourceApi.dirname(options.sourceSessionFile), original)
          : original,
        options.sourcePlatform
      )
      const key = environmentPathKey(absolute, options.sourcePlatform)
      const mapping = options.sessionFileMappings.find(
        (item) => environmentPathKey(item.source, options.sourcePlatform) === key
      )
      if (mapping) {
        target = normalizeEnvironmentPath(mapping.target, options.targetPlatform)
        if (relative) {
          const relativeTarget = targetApi.relative(
            targetApi.dirname(options.targetSessionFile),
            target
          )
          // Windows 跨卷没有相对表示，保留目标绝对路径。
          if (!targetApi.isAbsolute(relativeTarget)) target = relativeTarget
        }
      }
    }
    if (target === null) {
      missingReferences.push({ kind, path: original })
    } else if (target !== original) {
      record[field] = target
      changed = true
    }
  }

  function sessionReference(value: unknown): void {
    if (isRecord(value)) rewrite(value, 'sessionFile', 'session')
  }

  if (entry.type === 'session') {
    rewrite(entry, 'cwd', 'project')
    rewrite(entry, 'parentSession', 'session')
  } else if (entry.type === 'message' && isRecord(entry.message)) {
    const message = entry.message
    if (message.role === 'toolResult') {
      if (message.toolName === 'agent' || message.toolName === 'agent_resume') {
        sessionReference(message.details)
      } else if (message.toolName === 'research_delegate' && isRecord(message.details)) {
        if (Array.isArray(message.details.workers)) {
          for (const worker of message.details.workers) sessionReference(worker)
        }
      }
    }
  } else if (
    entry.type === 'custom' &&
    typeof entry.customType === 'string' &&
    /^pi-desk-subagent:(?:launch|state):v1$/.test(entry.customType)
  ) {
    sessionReference(entry.data)
  } else if (
    entry.type === 'custom_message' &&
    typeof entry.customType === 'string' &&
    /^pi-desk-subagent:completion:v1$/.test(entry.customType)
  ) {
    sessionReference(entry.details)
  }
  return { line: changed ? JSON.stringify(entry) : line, missingReferences }
}
