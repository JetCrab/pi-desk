import 'server-only'

import type { ModelRuntime, SessionEntry, SessionManager } from '@earendil-works/pi-coding-agent'
import {
  projectL4PiToolCallDisplay,
  readL4PiToolCalls,
  type L4PiToolCallDisplay
} from './l4-pi-chat-projection'

const PREVIEW_LIMIT = 240
const DETAIL_LIMIT = 64 * 1024

export type L4PiSessionTreeNodeKind =
  | 'user'
  | 'assistant'
  | 'tool'
  | 'bash'
  | 'custom_message'
  | 'compaction'
  | 'branch_summary'
  | 'custom'
  | 'model_change'
  | 'thinking_level_change'
  | 'session_info'
  | 'label'

export interface L4PiSessionTreeNode {
  entryId: string
  parentEntryId: string | null
  timestampMs: number
  kind: L4PiSessionTreeNodeKind
  preview: string
  label: string | null
}

export interface L4PiSessionTree {
  sessionId: string
  leafEntryId: string | null
  nodes: L4PiSessionTreeNode[]
}

export interface L4PiBranchSelection {
  selectedEntryId: string
  targetLeafEntryId: string | null
  editorText: string | null
  changed: boolean
}

export interface L4PiForkSelection {
  selectedEntryId: string
  targetLeafEntryId: string | null
  editorText: string
}

export interface L4PiSessionTreeEntryDetail {
  entryId: string
  kind: L4PiSessionTreeNodeKind
  content: string
  truncated: boolean
}

interface L4PiSessionTreeToolCall {
  name: string
  input: Readonly<Record<string, unknown>>
  display: L4PiToolCallDisplay
}

interface L4PiSessionTreeToolCallIndexCache {
  entryCount: number
  callsById: ReadonlyMap<string, L4PiSessionTreeToolCall>
}

const toolCallIndexBySessionManager = new WeakMap<
  SessionManager,
  L4PiSessionTreeToolCallIndexCache
>()

export class L4PiSessionEntryNotFoundError extends Error {
  constructor(entryId: string) {
    super(`Pi session entry was not found: ${entryId}`)
    this.name = 'L4PiSessionEntryNotFoundError'
  }
}

export class L4PiSessionForkTargetError extends Error {
  constructor(entryId: string) {
    super(`Pi session fork target is not a user message: ${entryId}`)
    this.name = 'L4PiSessionForkTargetError'
  }
}

function contentText(content: unknown): string {
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

function imageCount(content: unknown): number {
  if (!Array.isArray(content)) return 0
  return content.filter(
    (part) =>
      part !== null && typeof part === 'object' && (part as { type?: unknown }).type === 'image'
  ).length
}

function compactPreview(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (compact.length <= PREVIEW_LIMIT) return compact
  return `${compact.slice(0, PREVIEW_LIMIT - 1)}…`
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? ''
  } catch {
    return ''
  }
}

function readToolCallIndex(
  sessionManager: SessionManager
): ReadonlyMap<string, L4PiSessionTreeToolCall> {
  const entries = sessionManager.getEntries()
  const cached = toolCallIndexBySessionManager.get(sessionManager)
  if (cached?.entryCount === entries.length) return cached.callsById

  const callsById = new Map<string, L4PiSessionTreeToolCall>()
  for (const entry of entries) {
    if (entry.type !== 'message' || entry.message.role !== 'assistant') continue
    for (const call of readL4PiToolCalls(entry.message.content)) {
      callsById.set(call.id, {
        name: call.name,
        input: call.input,
        display: projectL4PiToolCallDisplay(call.name, call.input)
      })
    }
  }
  toolCallIndexBySessionManager.set(sessionManager, {
    entryCount: entries.length,
    callsById
  })
  return callsById
}

function compactJsonPreview(value: unknown): string {
  try {
    const json = JSON.stringify(value)
    return json === '{}' ? '' : compactPreview(json)
  } catch {
    return ''
  }
}

function toolCallPreview(
  fallbackToolName: string,
  toolCall: L4PiSessionTreeToolCall | undefined
): string {
  if (!toolCall) return compactPreview(fallbackToolName)
  const inputPreview = toolCall.display.inputPreview ?? compactJsonPreview(toolCall.input)
  const call = inputPreview ? `${toolCall.name}: ${inputPreview}` : toolCall.name
  return compactPreview(toolCall.display.activity ? `${call} · ${toolCall.display.activity}` : call)
}

function toolCallDetail(
  fallbackToolName: string,
  toolCall: L4PiSessionTreeToolCall | undefined
): string {
  if (!toolCall) {
    return `工具：${fallbackToolName}\n\n未找到对应的 Tool Call 参数`
  }

  const lines = [`工具：${toolCall.name}`]
  if (toolCall.display.reasoning) lines.push(`目的：${toolCall.display.reasoning}`)
  if (toolCall.display.inputPreview) lines.push(`调用：${toolCall.display.inputPreview}`)
  if (toolCall.display.activity) lines.push(`范围/变化：${toolCall.display.activity}`)

  const parameters = Object.fromEntries(
    Object.entries(toolCall.input).filter(([key]) => key !== 'reasoning')
  )
  if (Object.keys(parameters).length > 0) {
    lines.push('', '调用参数：', jsonText(parameters))
  }
  return lines.join('\n')
}

function messageDetail(
  entry: Extract<SessionEntry, { type: 'message' }>,
  toolCallsById: ReadonlyMap<string, L4PiSessionTreeToolCall>
): string {
  const message = entry.message
  switch (message.role) {
    case 'user': {
      const text = contentText(message.content)
      const images = imageCount(message.content)
      return [text, images > 0 ? `[图片 ${images} 张]` : ''].filter(Boolean).join('\n\n')
    }
    case 'assistant':
      return (
        contentText(message.content) ||
        message.errorMessage ||
        (message.stopReason === 'aborted' ? '已中断' : '')
      )
    case 'toolResult':
      return toolCallDetail(message.toolName, toolCallsById.get(message.toolCallId))
    case 'bashExecution':
      return `命令：${message.command}`
    case 'custom':
      return contentText(message.content)
    default:
      return ''
  }
}

function entryDetail(
  entry: SessionEntry,
  toolCallsById: ReadonlyMap<string, L4PiSessionTreeToolCall>,
  models: Pick<ModelRuntime, 'getModel'> | undefined
): string {
  switch (entry.type) {
    case 'message':
      return messageDetail(entry, toolCallsById)
    case 'custom_message':
      return contentText(entry.content)
    case 'compaction':
    case 'branch_summary':
      return entry.summary
    case 'custom':
      return [`类型：${entry.customType}`, jsonText(entry.data)].filter(Boolean).join('\n\n')
    case 'context_edit':
      // 替换内容可能是工具输出；树详情只展示编辑操作，不读取替换正文。
      return `操作：${entry.replacement === null ? '从上下文移除' : '替换上下文内容'}\n目标节点：${entry.targetId}`
    case 'usage':
      return `用量记录：${entry.kind}\n模型：${entry.provider}/${entry.model}\n\n${jsonText(entry.usage)}`
    case 'model_change':
      return `${entry.provider}/${models?.getModel(entry.provider, entry.modelId)?.name || entry.modelId}`
    case 'thinking_level_change':
      return entry.thinkingLevel
    case 'session_info':
      return entry.name ?? ''
    case 'label':
      return entry.label ?? '已清除标签'
  }
}

function messageKind(entry: Extract<SessionEntry, { type: 'message' }>): L4PiSessionTreeNodeKind {
  switch (entry.message.role) {
    case 'user':
      return 'user'
    case 'assistant':
      return 'assistant'
    case 'toolResult':
      return 'tool'
    case 'bashExecution':
      return 'bash'
    case 'custom':
      return 'custom_message'
    default:
      return 'custom'
  }
}

function messagePreview(
  entry: Extract<SessionEntry, { type: 'message' }>,
  toolCallsById: ReadonlyMap<string, L4PiSessionTreeToolCall>
): string {
  const message = entry.message
  switch (message.role) {
    case 'user': {
      const text = contentText(message.content)
      const images = imageCount(message.content)
      return compactPreview(text || (images > 0 ? `${images} 张图片` : ''))
    }
    case 'assistant': {
      const text = contentText(message.content)
      if (text) return compactPreview(text)
      if (message.errorMessage) return compactPreview(message.errorMessage)
      return message.stopReason === 'aborted' ? '已中断' : ''
    }
    case 'toolResult':
      return toolCallPreview(message.toolName, toolCallsById.get(message.toolCallId))
    case 'bashExecution':
      return compactPreview(message.command)
    case 'custom':
      return compactPreview(contentText(message.content))
    default:
      return ''
  }
}

function entryKind(entry: SessionEntry): L4PiSessionTreeNodeKind {
  switch (entry.type) {
    case 'message':
      return messageKind(entry)
    case 'custom_message':
      return 'custom_message'
    case 'compaction':
      return 'compaction'
    case 'branch_summary':
      return 'branch_summary'
    case 'custom':
    case 'context_edit':
    case 'usage':
      return 'custom'
    case 'model_change':
      return 'model_change'
    case 'thinking_level_change':
      return 'thinking_level_change'
    case 'session_info':
      return 'session_info'
    case 'label':
      return 'label'
  }
}

function entryPreview(
  entry: SessionEntry,
  toolCallsById: ReadonlyMap<string, L4PiSessionTreeToolCall>,
  models: Pick<ModelRuntime, 'getModel'> | undefined
): string {
  switch (entry.type) {
    case 'message':
      return messagePreview(entry, toolCallsById)
    case 'custom_message':
      return compactPreview(contentText(entry.content))
    case 'compaction':
    case 'branch_summary':
      return compactPreview(entry.summary)
    case 'custom':
      return compactPreview(entry.customType)
    case 'context_edit':
      return compactPreview(
        `${entry.replacement === null ? '从上下文移除' : '替换上下文内容'}：${entry.targetId}`
      )
    case 'usage':
      return compactPreview(`用量记录：${entry.kind}`)
    case 'model_change':
      return compactPreview(
        `${entry.provider}/${models?.getModel(entry.provider, entry.modelId)?.name || entry.modelId}`
      )
    case 'thinking_level_change':
      return compactPreview(entry.thinkingLevel)
    case 'session_info':
      return compactPreview(entry.name ?? '')
    case 'label':
      return compactPreview(entry.label ?? '已清除标签')
  }
}

function entryTimestampMs(entry: SessionEntry): number {
  const timestampMs = Date.parse(entry.timestamp)
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) {
    throw new Error(`Pi session entry has an invalid timestamp: ${entry.id}`)
  }
  return timestampMs
}

export function readL4PiSessionTree(
  sessionManager: SessionManager,
  models?: Pick<ModelRuntime, 'getModel'>
): L4PiSessionTree {
  const toolCallsById = readToolCallIndex(sessionManager)
  return {
    sessionId: sessionManager.getSessionId(),
    leafEntryId: sessionManager.getLeafId(),
    nodes: sessionManager.getEntries().map((entry) => ({
      entryId: entry.id,
      parentEntryId: entry.parentId,
      timestampMs: entryTimestampMs(entry),
      kind: entryKind(entry),
      preview: entryPreview(entry, toolCallsById, models),
      label: sessionManager.getLabel(entry.id)?.trim() || null
    }))
  }
}

export function readL4PiSessionTreeEntryDetail(
  sessionManager: SessionManager,
  entryId: string,
  models?: Pick<ModelRuntime, 'getModel'>
): L4PiSessionTreeEntryDetail {
  const entry = sessionManager.getEntry(entryId)
  if (!entry) throw new L4PiSessionEntryNotFoundError(entryId)
  const content = entryDetail(entry, readToolCallIndex(sessionManager), models)
  return {
    entryId,
    kind: entryKind(entry),
    content: content.length <= DETAIL_LIMIT ? content : content.slice(0, DETAIL_LIMIT),
    truncated: content.length > DETAIL_LIMIT
  }
}

export function resolveL4PiForkSelection(
  sessionManager: SessionManager,
  selectedEntryId: string
): L4PiForkSelection {
  const selected = sessionManager.getEntry(selectedEntryId)
  if (!selected) throw new L4PiSessionEntryNotFoundError(selectedEntryId)
  if (selected.type !== 'message' || selected.message.role !== 'user') {
    throw new L4PiSessionForkTargetError(selectedEntryId)
  }
  return {
    selectedEntryId,
    targetLeafEntryId: selected.parentId,
    editorText: contentText(selected.message.content)
  }
}

export function resolveL4PiBranchSelection(
  sessionManager: SessionManager,
  selectedEntryId: string
): L4PiBranchSelection {
  const selected = sessionManager.getEntry(selectedEntryId)
  if (!selected) throw new L4PiSessionEntryNotFoundError(selectedEntryId)

  if (sessionManager.getLeafId() === selectedEntryId) {
    return {
      selectedEntryId,
      targetLeafEntryId: selectedEntryId,
      editorText: null,
      changed: false
    }
  }

  if (selected.type === 'message' && selected.message.role === 'user') {
    return {
      selectedEntryId,
      targetLeafEntryId: selected.parentId,
      editorText: contentText(selected.message.content),
      changed: sessionManager.getLeafId() !== selected.parentId
    }
  }

  if (selected.type === 'custom_message') {
    return {
      selectedEntryId,
      targetLeafEntryId: selected.parentId,
      editorText: contentText(selected.content),
      changed: sessionManager.getLeafId() !== selected.parentId
    }
  }

  return {
    selectedEntryId,
    targetLeafEntryId: selectedEntryId,
    editorText: null,
    changed: true
  }
}
