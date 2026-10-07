import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { ToolCall, ToolResultMessage } from '@earendil-works/pi-ai'
import { basename, dirname, relative, resolve, sep } from 'node:path'

export interface ContextIgnoreTransformOptions {
  cwd?: string
  /** Pi 已发现的目录型 Skill 根目录。 */
  skillBaseDirs?: string[]
  /** Pi 已发现的根目录直放 Markdown Skill 文件。 */
  skillFilePaths?: string[]
  /** 从完整会话投影到压缩切片的严格消息身份。 */
  ignoredMessages?: WeakSet<AgentMessage>
}

function normalizePath(path: string): string {
  const normalized = resolve(path).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function resolveReadPath(path: string, cwd: string): string {
  return resolve(cwd, path.startsWith('@') ? path.slice(1) : path)
}

function isWithinPath(path: string, root: string): boolean {
  const pathRelative = relative(normalizePath(root), normalizePath(path))
  return (
    pathRelative === '' || (!pathRelative.startsWith('..') && !pathRelative.includes(`..${sep}`))
  )
}

function getReadPath(toolCall: ToolCall, cwd: string): string | undefined {
  if (toolCall.name !== 'read') return undefined
  const path = (toolCall.arguments as Record<string, unknown>).path
  return typeof path === 'string' && path.trim() ? resolveReadPath(path, cwd) : undefined
}

function isSkillDefinitionResult(result: ToolResultMessage | undefined): boolean {
  if (result === undefined || result.isError) return false
  const text = result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  return /^---\s*$/m.test(text) && /^name:\s*\S+/m.test(text) && /^description:\s*\S+/m.test(text)
}

/**
 * Uses Pi's discovered Skill roots for active sessions. Restored sessions can only
 * recover a root when their own read result proves that SKILL.md was a valid skill.
 */
export function getSkillBaseDirs(
  messages: AgentMessage[],
  options: ContextIgnoreTransformOptions = {}
): string[] {
  const cwd = options.cwd ?? process.cwd()
  const roots = new Set((options.skillBaseDirs ?? []).map(normalizePath))
  const toolResults = new Map<string, ToolResultMessage>()

  for (const message of messages) {
    if (message.role === 'toolResult') toolResults.set(message.toolCallId, message)
  }

  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type !== 'toolCall') continue
      const path = getReadPath(block, cwd)
      if (
        path !== undefined &&
        basename(path).toLowerCase() === 'skill.md' &&
        isSkillDefinitionResult(toolResults.get(block.id))
      ) {
        roots.add(normalizePath(dirname(path)))
      }
    }
  }

  return [...roots]
}

export function isSkillContentRead(
  toolCall: ToolCall,
  skillBaseDirs: string[],
  options: ContextIgnoreTransformOptions = {}
): boolean {
  const path = getReadPath(toolCall, options.cwd ?? process.cwd())
  if (path === undefined) return false
  if (
    (options.skillFilePaths ?? []).some(
      (filePath) => normalizePath(filePath) === normalizePath(path)
    )
  ) {
    return true
  }
  return skillBaseDirs.some((root) => isWithinPath(path, root))
}
