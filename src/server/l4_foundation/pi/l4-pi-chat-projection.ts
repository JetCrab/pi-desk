import 'server-only'

import type {
  CompactionEntry,
  CustomMessageEntry,
  SessionEntry,
  SessionManager,
  SessionMessageEntry
} from '@earendil-works/pi-coding-agent'
import type { Usage } from '@earendil-works/pi-ai'
import type {
  PluginJsonObject,
  PluginJsonValue,
  PluginNativePiMessage
} from '@jetcrab/pi-desk-sdk/entry'
import { decodeL4PiImage, type L4PiImageMetadata } from './l4-pi-image'

export interface L4PiChatMessageUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  costUsd: number
}

type L4PiChatMessageBody =
  | {
      type: 'user'
      text: string
      images: L4PiImageMetadata[]
    }
  | {
      type: 'assistant'
      text: string
      thinking: string
      model?: { provider: string; modelId: string } | null
      status: 'running' | 'completed' | 'error' | 'aborted'
      errorMessage: string | null
      usage: L4PiChatMessageUsage
    }
  | {
      type: 'tool'
      name: string
      reasoning: string | null
      inputPreview: string | null
      activity: string | null
      status: 'running' | 'completed' | 'error'
      usage: L4PiChatMessageUsage | null
      output: string
      images?: L4PiImageMetadata[]
      nestedCalls?: PluginJsonObject
      startedAtMs?: number | null
      durationMs?: number | null
    }
  | {
      type: 'bash'
      command: string
      status: 'running' | 'completed' | 'error' | 'aborted'
      output: string
    }
  | {
      type: 'custom'
      text: string
    }
  | {
      type: 'compaction'
      summary: string
    }

export type L4PiChatMessage = L4PiChatMessageBody & {
  declaration?: {
    message: PluginNativePiMessage
    raw: unknown
  }
}

export interface L4PiChatProjectedEntry {
  entryId: string
  timestampMs: number
  message: L4PiChatMessage
}

export interface L4PiChatSnapshot {
  sessionName: string | null
  entries: L4PiChatProjectedEntry[]
}

export interface L4PiToolCallDisplay {
  reasoning: string | null
  inputPreview: string | null
  activity: string | null
}

export interface L4PiToolCallDisplayCache {
  writeContent?: string
  writeCharacters?: number
  writeLines?: number
}

export interface L4PiToolCallSnapshot {
  id: string
  name: string
  input: Readonly<Record<string, unknown>>
}

const TOOL_DISPLAY_TEXT_LIMIT = 500
const integerFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

function compactToolDisplayText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const compact = value.replace(/\s+/g, ' ').trim()
  if (!compact) return null
  return compact.length <= TOOL_DISPLAY_TEXT_LIMIT
    ? compact
    : `${compact.slice(0, TOOL_DISPLAY_TEXT_LIMIT - 1)}…`
}

function toolArgument(
  input: Readonly<Record<string, unknown>>,
  ...keys: readonly string[]
): string | null {
  for (const key of keys) {
    const value = compactToolDisplayText(input[key])
    if (value) return value
  }
  return null
}

function toolInteger(input: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = input[key]
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function bashToolDurationMs(toolName: string, details: unknown): number | null {
  if (toolName !== 'bash' || !details || typeof details !== 'object' || Array.isArray(details)) {
    return null
  }
  const value = (details as { durationMs?: unknown }).durationMs
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function textLineCount(text: string): number {
  if (text.length === 0) return 0
  let lines = 1
  for (const char of text) {
    if (char === '\n') lines += 1
  }
  return lines
}

function textCharacterCount(text: string): number {
  let count = 0
  for (const _char of text) count += 1
  return count
}

function readActivity(input: Readonly<Record<string, unknown>>): string | null {
  const offset = toolInteger(input, 'offset')
  const limit = toolInteger(input, 'limit')
  if (limit !== null) {
    const start = offset ?? 1
    return `${start}-${start + Math.max(0, limit - 1)}`
  }
  return offset === null ? null : `${offset}-`
}

function writeActivity(
  input: Readonly<Record<string, unknown>>,
  cache?: L4PiToolCallDisplayCache
): string | null {
  const content = input.content
  if (typeof content !== 'string') return null

  let characters: number
  let lines: number
  const previous = cache?.writeContent
  if (
    cache &&
    previous !== undefined &&
    cache.writeCharacters !== undefined &&
    cache.writeLines !== undefined &&
    content.startsWith(previous)
  ) {
    const appended = content.slice(previous.length)
    if (appended.length === 0) {
      characters = cache.writeCharacters
      lines = cache.writeLines
    } else {
      characters = cache.writeCharacters + textCharacterCount(appended)
      lines = cache.writeLines + textLineCount(appended) - (previous.length === 0 ? 0 : 1)
    }
  } else {
    characters = textCharacterCount(content)
    lines = textLineCount(content)
  }

  if (cache) {
    cache.writeContent = content
    cache.writeCharacters = characters
    cache.writeLines = lines
  }
  return `${integerFormatter.format(characters)} · L${integerFormatter.format(lines)}`
}

function editTexts(
  input: Readonly<Record<string, unknown>>
): ReadonlyArray<Record<string, unknown>> {
  if (Array.isArray(input.edits)) {
    return input.edits.filter(
      (edit): edit is Record<string, unknown> =>
        edit !== null && typeof edit === 'object' && !Array.isArray(edit)
    )
  }
  if (typeof input.oldText === 'string' || typeof input.newText === 'string') return [input]
  return []
}

function editActivity(input: Readonly<Record<string, unknown>>): string | null {
  const edits = editTexts(input)
  if (edits.length === 0) return null

  let oldLines = 0
  let newLines = 0
  let hasOld = false
  let hasNew = false
  for (const edit of edits) {
    if (typeof edit.oldText === 'string') {
      hasOld = true
      oldLines += textLineCount(edit.oldText)
    }
    if (typeof edit.newText === 'string') {
      hasNew = true
      newLines += textLineCount(edit.newText)
    }
  }

  const changes = [
    ...(hasOld ? [`-${integerFormatter.format(oldLines)}`] : []),
    ...(hasNew ? [`+${integerFormatter.format(newLines)}`] : [])
  ].join(' ')
  return changes
    ? `${integerFormatter.format(edits.length)} · ${changes}`
    : integerFormatter.format(edits.length)
}

function toolActivity(
  name: string,
  input: Readonly<Record<string, unknown>>,
  cache?: L4PiToolCallDisplayCache
): string | null {
  const normalizedName = name.toLowerCase().split('.').at(-1) ?? name.toLowerCase()
  switch (normalizedName) {
    case 'read':
      return readActivity(input)
    case 'write':
      return writeActivity(input, cache)
    case 'edit':
      return editActivity(input)
    default:
      return null
  }
}

function toolInputPreview(name: string, input: Readonly<Record<string, unknown>>): string | null {
  const normalizedName = name.toLowerCase().split('.').at(-1) ?? name.toLowerCase()

  switch (normalizedName) {
    case 'bash':
      return toolArgument(input, 'command')
    case 'read':
    case 'write':
    case 'edit':
      return toolArgument(input, 'path', 'file_path')
    case 'grep': {
      const pattern = toolArgument(input, 'pattern', 'query')
      const path = toolArgument(input, 'path')
      return pattern && path ? compactToolDisplayText(`${pattern} · ${path}`) : (pattern ?? path)
    }
    case 'find':
      return toolArgument(input, 'pattern', 'path')
    case 'ls':
      return toolArgument(input, 'path')
    case 'agent':
      return toolArgument(input, 'description')
    case 'agent_resume':
      return toolArgument(input, 'description', 'prompt')
    default:
      return toolArgument(
        input,
        'command',
        'path',
        'file_path',
        'pattern',
        'query',
        'description',
        'prompt'
      )
  }
}

export function projectL4PiToolCallDisplay(
  name: string,
  input: Readonly<Record<string, unknown>>,
  cache?: L4PiToolCallDisplayCache
): L4PiToolCallDisplay {
  return {
    reasoning: compactToolDisplayText(input.reasoning),
    inputPreview: toolInputPreview(name, input),
    activity: toolActivity(name, input, cache)
  }
}

export function readL4PiToolCalls(content: unknown): L4PiToolCallSnapshot[] {
  if (!Array.isArray(content)) return []
  const calls: L4PiToolCallSnapshot[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const value = part as {
      type?: unknown
      id?: unknown
      name?: unknown
      arguments?: unknown
    }
    if (
      value.type !== 'toolCall' ||
      typeof value.id !== 'string' ||
      !value.id ||
      typeof value.name !== 'string' ||
      !value.name
    ) {
      continue
    }
    const input =
      value.arguments && typeof value.arguments === 'object' && !Array.isArray(value.arguments)
        ? (value.arguments as Record<string, unknown>)
        : {}
    calls.push({ id: value.id, name: value.name, input })
  }
  return calls
}

function collectToolCallDisplays(
  content: unknown,
  toolCallsById: Map<string, L4PiToolCallDisplay>,
  toolInputsById?: Map<string, Readonly<Record<string, unknown>>>
): void {
  for (const call of readL4PiToolCalls(content)) {
    toolCallsById.set(call.id, projectL4PiToolCallDisplay(call.name, call.input))
    toolInputsById?.set(call.id, { ...call.input })
  }
}

function pluginJsonValue(value: unknown): PluginJsonValue {
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? null : (JSON.parse(serialized) as PluginJsonValue)
  } catch {
    return null
  }
}

function pluginJsonObject(value: unknown): Record<string, PluginJsonValue> {
  const json = pluginJsonValue(value)
  return json && typeof json === 'object' && !Array.isArray(json) ? json : {}
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .flatMap((part) => {
      if (!part || typeof part !== 'object') return []
      const value = part as { type?: unknown; text?: unknown }
      return value.type === 'text' && typeof value.text === 'string' ? [value.text] : []
    })
    .join('\n')
}

function imagePartsFromContent(
  content: unknown
): Array<{ data: string; metadata: L4PiImageMetadata }> {
  if (!Array.isArray(content)) return []

  return content.flatMap((part) => {
    if (!part || typeof part !== 'object') return []
    const value = part as { type?: unknown; data?: unknown }
    if (value.type !== 'image' || typeof value.data !== 'string') return []
    try {
      return [{ data: value.data, metadata: decodeL4PiImage(value.data).metadata }]
    } catch (error) {
      console.warn('[Pi Desk][PiChatProjection] 已忽略损坏的历史图片', {
        errorName: error instanceof Error ? error.name : 'UnknownError'
      })
      return []
    }
  })
}

function imagesFromContent(content: unknown): L4PiImageMetadata[] {
  return imagePartsFromContent(content).map((image) => image.metadata)
}

export function readL4PiChatImageContent(
  content: unknown,
  imageIndex: number
): { mimeType: string; data: string } | null {
  const image = imagePartsFromContent(content)[imageIndex]
  return image ? { mimeType: image.metadata.mimeType, data: image.data } : null
}

function assistantText(content: unknown, type: 'text' | 'thinking'): string {
  if (!Array.isArray(content)) return ''

  return content
    .flatMap((part) => {
      if (!part || typeof part !== 'object') return []
      const value = part as { type?: unknown; text?: unknown; thinking?: unknown }
      if (value.type !== type) return []
      const text = type === 'text' ? value.text : value.thinking
      return typeof text === 'string' ? [text] : []
    })
    .join('\n')
}

function assistantStatus(
  stopReason: string
): Extract<L4PiChatMessage, { type: 'assistant' }>['status'] {
  switch (stopReason) {
    case 'pending':
      return 'running'
    case 'stop':
    case 'length':
    case 'toolUse':
      return 'completed'
    case 'aborted':
      return 'aborted'
    default:
      return 'error'
  }
}

function projectUsage(usage: Usage): L4PiChatMessageUsage
function projectUsage(usage: Usage | undefined): L4PiChatMessageUsage | null
function projectUsage(usage: Usage | undefined): L4PiChatMessageUsage | null {
  return usage
    ? {
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        costUsd: usage.cost.total
      }
    : null
}

export function projectL4PiAgentMessage(
  message: SessionMessageEntry['message'],
  toolCallsById?: Map<string, L4PiToolCallDisplay>,
  toolInputsById?: Map<string, Readonly<Record<string, unknown>>>
): L4PiChatMessage | null {
  switch (message.role) {
    case 'user': {
      const text = textFromContent(message.content)
      const images = imagesFromContent(message.content)
      return {
        type: 'user',
        text,
        images,
        declaration: {
          message: { kind: 'user', text, images },
          raw: message
        }
      }
    }
    case 'assistant': {
      if (toolCallsById) collectToolCallDisplays(message.content, toolCallsById, toolInputsById)
      const text = assistantText(message.content, 'text')
      const thinking = assistantText(message.content, 'thinking')
      return {
        type: 'assistant',
        text,
        thinking,
        model:
          message.api !== 'pi-virtual' &&
          typeof message.provider === 'string' &&
          typeof (message.responseModel ?? message.model) === 'string'
            ? { provider: message.provider, modelId: message.responseModel ?? message.model }
            : null,
        status: assistantStatus(message.stopReason),
        errorMessage: message.errorMessage ?? null,
        usage: projectUsage(message.usage),
        declaration: {
          message: {
            kind: 'assistant',
            text,
            thinking,
            stopReason: message.stopReason
          },
          raw: message
        }
      }
    }
    case 'toolResult': {
      const display = toolCallsById?.get(message.toolCallId)
      const input = toolInputsById?.get(message.toolCallId)
      toolCallsById?.delete(message.toolCallId)
      toolInputsById?.delete(message.toolCallId)
      const output = textFromContent(message.content)
      const images = imagesFromContent(message.content)
      // 子调用仅投影父 ToolResult 的 canonical 记录；SDK 原始合同不增加宿主字段。
      const nested = message.nestedCalls
        ? {
            complete: message.nestedCalls.complete,
            calls: message.nestedCalls.calls.map((call) => ({
              name: call.name,
              ...(call.arguments === undefined
                ? {}
                : { arguments: pluginJsonObject(call.arguments) }),
              ...(call.argumentsBytes === undefined ? {} : { argumentsBytes: call.argumentsBytes }),
              status: call.status,
              ...(call.durationMs === undefined ? {} : { durationMs: call.durationMs }),
              ...(call.error === undefined ? {} : { error: call.error })
            }))
          }
        : null
      return {
        type: 'tool',
        name: message.toolName,
        reasoning: display?.reasoning ?? null,
        inputPreview: display?.inputPreview ?? null,
        activity: display?.activity ?? null,
        status: message.isError ? 'error' : 'completed',
        usage: projectUsage(message.usage),
        output,
        ...(images.length > 0 ? { images } : {}),
        ...(nested ? { nestedCalls: nested } : {}),
        startedAtMs: null,
        durationMs: bashToolDurationMs(message.toolName, message.details),
        declaration: {
          message: {
            kind: 'tool',
            toolName: message.toolName,
            toolCallId: message.toolCallId,
            arguments: pluginJsonObject(input),
            partialResult: null,
            result: pluginJsonValue({ content: message.content, details: message.details, output }),
            isError: message.isError
          },
          raw: message
        }
      }
    }
    case 'bashExecution':
      return {
        type: 'bash',
        command: message.command,
        status: message.cancelled ? 'aborted' : message.exitCode === 0 ? 'completed' : 'error',
        output: message.output,
        declaration: {
          message: {
            kind: 'bash',
            command: message.command,
            output: message.output,
            exitCode: message.exitCode ?? null,
            cancelled: message.cancelled,
            truncated: message.truncated
          },
          raw: message
        }
      }
    case 'custom': {
      if (!message.display) return null
      const text = textFromContent(message.content)
      return {
        type: 'custom',
        text,
        declaration: {
          message: {
            kind: 'custom',
            customType: message.customType,
            content: text,
            details: pluginJsonValue(message.details)
          },
          raw: message
        }
      }
    }
    default:
      return null
  }
}

export function projectL4PiLiveToolResultMessage(
  message: SessionMessageEntry['message'],
  toolCallId: string,
  display: L4PiToolCallDisplay | undefined,
  input: Readonly<Record<string, unknown>> | undefined
): L4PiChatMessage | null {
  const displays = new Map<string, L4PiToolCallDisplay>()
  const inputs = new Map<string, Readonly<Record<string, unknown>>>()
  if (display) displays.set(toolCallId, display)
  if (input) inputs.set(toolCallId, input)
  return projectL4PiAgentMessage(message, displays, inputs)
}

function projectCustomMessage(entry: CustomMessageEntry): L4PiChatMessage | null {
  if (!entry.display) return null
  const text = textFromContent(entry.content)
  return {
    type: 'custom',
    text,
    declaration: {
      message: {
        kind: 'custom',
        customType: entry.customType,
        content: text,
        details: pluginJsonValue(entry.details)
      },
      raw: entry
    }
  }
}

function projectCompactionMessage(entry: CompactionEntry): L4PiChatMessage {
  return {
    type: 'compaction',
    summary: entry.summary,
    declaration: {
      message: {
        kind: 'custom',
        customType: 'pi-desk/compaction',
        content: '',
        details: { text: entry.summary }
      },
      raw: entry
    }
  }
}

function projectEntry(
  entry: SessionEntry,
  toolCallsById: Map<string, L4PiToolCallDisplay>,
  toolInputsById: Map<string, Readonly<Record<string, unknown>>>
): L4PiChatProjectedEntry | null {
  const message =
    entry.type === 'message'
      ? projectL4PiAgentMessage(entry.message, toolCallsById, toolInputsById)
      : entry.type === 'custom_message'
        ? projectCustomMessage(entry)
        : entry.type === 'compaction'
          ? projectCompactionMessage(entry)
          : null
  if (!message) return null

  const timestampMs = Date.parse(entry.timestamp)
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) {
    throw new Error(`Pi session entry has an invalid timestamp: ${entry.id}`)
  }

  return { entryId: entry.id, timestampMs, message }
}

export function projectL4PiChatEntry(entry: SessionEntry): L4PiChatProjectedEntry | null {
  return projectEntry(entry, new Map(), new Map())
}

export function projectL4PiChatEntries(
  branch: readonly SessionEntry[],
  maxEntries?: number
): L4PiChatProjectedEntry[] {
  const entries: L4PiChatProjectedEntry[] = []
  const toolCallsById = new Map<string, L4PiToolCallDisplay>()
  const toolInputsById = new Map<string, Readonly<Record<string, unknown>>>()
  for (const entry of branch) {
    const projected = projectEntry(entry, toolCallsById, toolInputsById)
    if (!projected) continue
    entries.push(projected)
    if (maxEntries !== undefined && entries.length > maxEntries) entries.shift()
  }
  return entries
}

export function projectL4PiChatSnapshot(sessionManager: SessionManager): L4PiChatSnapshot {
  return {
    sessionName: sessionManager.getSessionName()?.trim() || null,
    entries: projectL4PiChatEntries(sessionManager.getBranch())
  }
}
