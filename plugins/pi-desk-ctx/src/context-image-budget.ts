import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { ContextImageBudgetSettings } from './context-settings.js'

const OMITTED_IMAGE_TEXT =
  '此历史图片已从当前请求移除，不再可见；需要时重新读取原图或请用户重新提供。'

interface ImageGroup {
  assistantTurns: number
  textTurns: number
  bytes: number
  images: Array<{ messageIndex: number; blockIndex: number }>
}

export interface ImageBudgetResult {
  messages: AgentMessage[]
  beforeBytes: number
  afterBytes: number
  unseenBytes: number
  removedImages: number
  blocked: boolean
}

export function applyImageBudget(
  messages: AgentMessage[],
  settings: ContextImageBudgetSettings
): ImageBudgetResult {
  const result: ImageBudgetResult = {
    messages,
    beforeBytes: 0,
    afterBytes: 0,
    unseenBytes: 0,
    removedImages: 0,
    blocked: false
  }
  if (!settings.enabled) return result

  const groups: ImageGroup[] = []
  let assistantTurns = 0
  let textTurns = 0
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]!
    if (!('content' in message) || !Array.isArray(message.content)) continue
    if (
      message.role === 'assistant' &&
      (message.stopReason === 'stop' ||
        message.stopReason === 'toolUse' ||
        message.stopReason === 'length')
    ) {
      const hasText = message.content.some(
        (block) => block.type === 'text' && block.text.trim() !== ''
      )
      const hasToolCall = message.content.some((block) => block.type === 'toolCall')
      if (hasText || hasToolCall) {
        assistantTurns += 1
        if (hasText) textTurns += 1
      }
    }
    for (const [blockIndex, block] of message.content.entries()) {
      if (block.type !== 'image') continue
      // Base64 为 ASCII；直接取长度，不为预估解码图片或复制整份请求。
      const bytes = block.data.length
      result.beforeBytes += bytes
      let group = groups.at(-1)
      if (!group || group.assistantTurns !== assistantTurns) {
        group = { assistantTurns, textTurns, bytes: 0, images: [] }
        groups.push(group)
      }
      group.bytes += bytes
      group.images.push({ messageIndex, blockIndex })
    }
  }
  result.afterBytes = result.beforeBytes
  if (result.beforeBytes <= settings.triggerBytes) return result

  result.unseenBytes = groups.find((group) => group.assistantTurns === 0)?.bytes ?? 0
  if (result.unseenBytes > settings.triggerBytes) {
    result.blocked = true
    return result
  }

  const omitted = new Map<number, Set<number>>()
  // groups 按新到旧收集；只在模型确实有过后续有效回应后才允许淘汰。
  for (const group of [...groups].reverse()) {
    if (group.assistantTurns === 0) continue
    const outsideWindow =
      group.assistantTurns > settings.keepAssistantTurns || group.textTurns > settings.keepTextTurns
    if (!outsideWindow && result.afterBytes <= settings.targetBytes) continue
    result.afterBytes -= group.bytes
    result.removedImages += group.images.length
    for (const { messageIndex, blockIndex } of group.images) {
      let indexes = omitted.get(messageIndex)
      if (!indexes) {
        indexes = new Set()
        omitted.set(messageIndex, indexes)
      }
      indexes.add(blockIndex)
    }
  }

  if (omitted.size > 0) {
    result.messages = messages.map((message, index): AgentMessage => {
      const indexes = omitted.get(index)
      if (!indexes || !('content' in message) || !Array.isArray(message.content)) return message
      if (message.role !== 'user' && message.role !== 'toolResult' && message.role !== 'custom')
        return message
      return {
        ...message,
        content: message.content.map((block, blockIndex) =>
          indexes.has(blockIndex) ? { type: 'text' as const, text: OMITTED_IMAGE_TEXT } : block
        )
      }
    })
  }
  return result
}
