import {
  L2TaskDetailSnapshotSchema,
  type L2TaskDetailEvent,
  type L2TaskDetailSnapshot,
  type L2TaskMessageGetResponse
} from './l2-task-center-contract'
import {
  applyL3ConversationEvent,
  applyL3ConversationMessageDetail,
  replaceL3ConversationSnapshot
} from '@common/l3_modules/conversation/l3-conversation-state'

export function replaceL2TaskDetailSnapshot(
  current: L2TaskDetailSnapshot,
  next: L2TaskDetailSnapshot
): L2TaskDetailSnapshot {
  if (
    current.taskId !== next.taskId ||
    current.body?.kind !== 'conversation' ||
    next.body?.kind !== 'conversation'
  ) {
    return next
  }

  return L2TaskDetailSnapshotSchema.parse({
    ...next,
    body: {
      kind: 'conversation',
      truncated: next.body.truncated,
      ...replaceL3ConversationSnapshot(
        current.body,
        next.body.messages,
        next.body.temporaryMessages
      )
    }
  })
}

export function applyL2TaskDetailEvent(
  current: L2TaskDetailSnapshot,
  event: L2TaskDetailEvent
): L2TaskDetailSnapshot | null {
  if (event.type === 'snapshot') return replaceL2TaskDetailSnapshot(current, event.snapshot)
  if (event.type === 'unavailable') return null

  // Snapshot 和 Event 已在传输或映射边界校验；实时热路径必须保留未变化消息引用，
  // 避免每个流式增量深度解析整段历史并击穿客户端 Turn memo。
  if (event.type === 'text_append') {
    if (current.body?.kind !== 'text') {
      throw new Error('Text append requires a text task detail snapshot')
    }
    return {
      ...current,
      body: { ...current.body, text: current.body.text + event.text }
    }
  }

  if (current.body?.kind !== 'conversation') {
    throw new Error('Conversation event requires a conversation task detail snapshot')
  }
  return {
    ...current,
    body: {
      ...applyL3ConversationEvent(current.body, event.event),
      kind: 'conversation',
      truncated: current.body.truncated
    }
  }
}

export function applyL2TaskMessageDetail(
  current: L2TaskDetailSnapshot,
  response: L2TaskMessageGetResponse
): L2TaskDetailSnapshot {
  if (current.body?.kind !== 'conversation') {
    throw new Error('Task message detail requires a conversation snapshot')
  }
  return L2TaskDetailSnapshotSchema.parse({
    ...current,
    body: {
      kind: 'conversation',
      truncated: current.body.truncated,
      ...applyL3ConversationMessageDetail(current.body, response)
    }
  })
}
