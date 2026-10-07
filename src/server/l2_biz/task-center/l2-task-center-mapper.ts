import 'server-only'

import type { L2ChatSource } from '@common/l2_biz/chat/l2-chat-contract'
import {
  L2TaskDetailEventSchema,
  L2TaskDetailSnapshotSchema,
  type L2TaskDetailEvent,
  type L2TaskDetailSnapshot
} from '@common/l2_biz/task-center/l2-task-center-contract'
import {
  buildL3ConversationMessageUpdate,
  projectL3ConversationDurableMessage,
  projectL3ConversationTemporaryMessage,
  withoutL3ConversationMessageDetail
} from '@server/l3_modules/conversation/l3-conversation-mapper'
import type {
  L4PiTaskConversationEvent,
  L4PiTaskDetailEvent,
  L4PiTaskDetailSnapshot
} from '@server/l4_foundation/pi/l4-pi-task-detail-runtime'

export function projectL2TaskDetailSnapshot(
  source: L2ChatSource,
  snapshot: L4PiTaskDetailSnapshot
): L2TaskDetailSnapshot {
  const body = (() => {
    if (snapshot.body === null) return null
    if (snapshot.body.kind === 'text') return snapshot.body
    return {
      kind: 'conversation' as const,
      messages: snapshot.body.entries.map((entry, index) =>
        withoutL3ConversationMessageDetail(
          projectL3ConversationDurableMessage(
            index,
            entry.entryId,
            entry.timestampMs,
            entry.message,
            source
          )
        )
      ),
      temporaryMessages: snapshot.body.temporaryMessages.map(({ tempId, message }) =>
        projectL3ConversationTemporaryMessage(tempId, message, source)
      ),
      truncated: snapshot.body.truncated
    }
  })()
  return L2TaskDetailSnapshotSchema.parse({
    taskId: snapshot.taskId,
    canInterrupt: snapshot.canInterrupt,
    body
  })
}

function projectConversationEvent(
  source: L2ChatSource,
  current: L2TaskDetailSnapshot,
  event: L4PiTaskConversationEvent
): L2TaskDetailEvent | null {
  if (current.body?.kind !== 'conversation') {
    throw new Error('Task conversation event requires a conversation snapshot')
  }
  const body = current.body
  if (event.type === 'durable_append') {
    return L2TaskDetailEventSchema.parse({
      type: 'conversation_event',
      event: {
        type: 'durable_append',
        messages: event.entries.map((entry, offset) =>
          withoutL3ConversationMessageDetail(
            projectL3ConversationDurableMessage(
              body.messages.length + offset,
              entry.entryId,
              entry.timestampMs,
              entry.message,
              source
            )
          )
        )
      }
    })
  }
  if (event.type === 'message_start') {
    return L2TaskDetailEventSchema.parse({
      type: 'conversation_event',
      event: {
        type: 'message_start',
        snapshot: projectL3ConversationTemporaryMessage(event.tempId, event.message, source)
      }
    })
  }
  if (event.type === 'message_update') {
    const previous = body.temporaryMessages.find(
      (message) => message.location.tempId === event.tempId
    )
    if (!previous) throw new Error(`Task Temporary message was not found: ${event.tempId}`)
    const update = buildL3ConversationMessageUpdate(
      previous,
      projectL3ConversationTemporaryMessage(event.tempId, event.message, source, false, 'update')
    )
    return update
      ? L2TaskDetailEventSchema.parse({ type: 'conversation_event', event: update })
      : null
  }
  if (event.type === 'message_commit') {
    return L2TaskDetailEventSchema.parse({
      type: 'conversation_event',
      event: {
        type: 'message_commit',
        location: { tempId: event.tempId },
        durable: {
          index: body.messages.length,
          entryId: event.entryId
        },
        fixed: { timestampMs: event.timestampMs }
      }
    })
  }
  return L2TaskDetailEventSchema.parse({
    type: 'conversation_event',
    event: { type: 'message_discard', location: { tempId: event.tempId } }
  })
}

export function projectL2TaskDetailEvent(
  source: L2ChatSource,
  current: L2TaskDetailSnapshot,
  event: L4PiTaskDetailEvent
): L2TaskDetailEvent | null {
  if (event.type === 'snapshot') {
    return L2TaskDetailEventSchema.parse({
      type: 'snapshot',
      snapshot: projectL2TaskDetailSnapshot(source, event.snapshot)
    })
  }
  if (event.type === 'text_append') {
    return L2TaskDetailEventSchema.parse(event)
  }
  if (event.type === 'unavailable') return L2TaskDetailEventSchema.parse(event)
  return projectConversationEvent(source, current, event.event)
}
