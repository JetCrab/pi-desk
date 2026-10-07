import type {
  L2ChatCursor,
  L2ChatDurableMessageSnapshot,
  L2ChatMessageDetailResponse,
  L2ChatRuntime,
  L2ChatSourceState
} from './l2-chat-contract'
import type { L2ChatSessionSyncEvent, L2ChatSourceEvent } from './l2-chat-websocket-contract'
import {
  applyL3ConversationMessageDetail,
  applyL3ConversationRealtimeEvent,
  replaceL3ConversationSnapshot
} from '@common/l3_modules/conversation/l3-conversation-state'

export const L2_EMPTY_CHAT_RUNTIME: L2ChatRuntime = {
  extensionMode: 'normal',
  presentationMode: 'normal',
  initializationError: null,
  queues: { steering: [], followUp: [] },
  model: null,
  capabilityMode: null,
  contextUsage: null,
  plugins: {}
}

export const L2_EMPTY_CHAT_SOURCE_STATE: L2ChatSourceState = Object.freeze({
  messages: [],
  temporaryMessages: [],
  runtime: L2_EMPTY_CHAT_RUNTIME
})

function applySessionSync(
  current: L2ChatSourceState,
  event: L2ChatSessionSyncEvent
): L2ChatSourceState {
  if (event.mode === 'full') {
    return {
      ...replaceL3ConversationSnapshot(current, event.messages, event.temporaryMessages),
      runtime: event.runtime
    }
  }

  const latest = current.messages.at(-1)
  if (
    !latest ||
    latest.location.index !== event.baseCursor.index ||
    latest.location.entryId !== event.baseCursor.entryId
  ) {
    throw new Error('Incremental chat sync does not match the current durable cursor')
  }

  const knownEntryIds = new Set(current.messages.map((message) => message.location.entryId))
  for (const message of event.messages) {
    if (knownEntryIds.has(message.location.entryId)) {
      throw new Error(
        `Incremental chat sync contains a duplicate entryId: ${message.location.entryId}`
      )
    }
    knownEntryIds.add(message.location.entryId)
  }

  return {
    messages: [...current.messages, ...event.messages],
    temporaryMessages: event.temporaryMessages,
    runtime: event.runtime
  }
}

// State 和事件已在存储、同步或传输边界完成校验；实时热路径只维护本地不变量。
export function applyL2ChatSourceEvent(
  current: L2ChatSourceState,
  event: L2ChatSourceEvent
): L2ChatSourceState {
  if (event.type === 'session_sync') return applySessionSync(current, event)
  if (event.type === 'runtime_update') return { ...current, runtime: event.runtime }
  return {
    ...applyL3ConversationRealtimeEvent(current, event),
    runtime: current.runtime
  }
}

export function applyL2ChatMessageDetail(
  current: L2ChatSourceState,
  response: L2ChatMessageDetailResponse
): L2ChatSourceState {
  return {
    ...applyL3ConversationMessageDetail(current, response),
    runtime: current.runtime
  }
}

export function getL2ChatLatestCursor(
  messages: readonly L2ChatDurableMessageSnapshot[]
): L2ChatCursor {
  const entryIds = new Set<string>()
  for (const [expectedIndex, message] of messages.entries()) {
    if (message.location.index !== expectedIndex || entryIds.has(message.location.entryId)) {
      return null
    }
    entryIds.add(message.location.entryId)
  }

  const latest = messages.at(-1)
  return latest ? { index: latest.location.index, entryId: latest.location.entryId } : null
}
