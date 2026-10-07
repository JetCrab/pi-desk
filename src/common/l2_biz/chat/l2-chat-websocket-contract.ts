import { z } from 'zod'
import {
  L2ChatCursorPositionSchema,
  L2ChatCursorSchema,
  L2ChatDurableMessageSnapshotSchema,
  L2ChatInputImageSchema,
  L2ChatModelStateSchema,
  L2ChatModeSchema,
  L2ChatRuntimeSchema,
  L2ChatSourceSchema,
  L2ChatTemporaryMessageLocationSchema,
  L2ChatTemporaryMessageSnapshotSchema
} from './l2-chat-contract'
import {
  L3ConversationMessageCommitEventSchema,
  L3ConversationMessageDiscardEventSchema,
  L3ConversationMessageStartEventSchema,
  L3ConversationMessageUpdateEventSchema
} from '@common/l3_modules/conversation/l3-conversation-event-contract'
import {
  defineL4AppSocketPush,
  defineL4AppSocketRequest
} from '@common/l4_foundation/realtime/l4-app-websocket-contract'

const L2ChatSubscribeItemSchema = z
  .object({
    source: L2ChatSourceSchema,
    cursor: L2ChatCursorSchema
  })
  .strict()

export const L2ChatSubscribeRequestSchema = z
  .object({
    subscriptions: z.array(L2ChatSubscribeItemSchema).min(1)
  })
  .strict()
  .superRefine((value, context) => {
    const workIds = new Set<string>()
    for (const [index, subscription] of value.subscriptions.entries()) {
      if (workIds.has(subscription.source.workId)) {
        context.addIssue({
          code: 'custom',
          message: 'subscriptions cannot contain duplicate workId values',
          path: ['subscriptions', index, 'source', 'workId']
        })
      }
      workIds.add(subscription.source.workId)
    }
  })

export const L2ChatSubscribeResponseSchema = z.object({}).strict()

const L2ChatSyncMessagesSchema = z
  .array(L2ChatDurableMessageSnapshotSchema)
  .superRefine((messages, context) => {
    const entryIds = new Set<string>()
    for (const [index, message] of messages.entries()) {
      if (index > 0 && message.location.index !== messages[index - 1]!.location.index + 1) {
        context.addIssue({
          code: 'custom',
          message: 'chat sync message indexes must be continuous',
          path: [index, 'location', 'index']
        })
      }
      if (entryIds.has(message.location.entryId)) {
        context.addIssue({
          code: 'custom',
          message: 'chat sync entryId values must be unique',
          path: [index, 'location', 'entryId']
        })
      }
      entryIds.add(message.location.entryId)
    }
  })

const L2ChatFullSessionSyncEventSchema = z
  .object({
    type: z.literal('session_sync'),
    mode: z.literal('full'),
    baseCursor: z.null(),
    messages: L2ChatSyncMessagesSchema,
    temporaryMessages: z.array(L2ChatTemporaryMessageSnapshotSchema),
    runtime: L2ChatRuntimeSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.messages[0] && value.messages[0].location.index !== 0) {
      context.addIssue({
        code: 'custom',
        message: 'full sync must start at index 0',
        path: ['messages', 0, 'location', 'index']
      })
    }
  })

const L2ChatIncrementalSessionSyncEventSchema = z
  .object({
    type: z.literal('session_sync'),
    mode: z.literal('incremental'),
    baseCursor: L2ChatCursorPositionSchema,
    messages: L2ChatSyncMessagesSchema,
    temporaryMessages: z.array(L2ChatTemporaryMessageSnapshotSchema),
    runtime: L2ChatRuntimeSchema
  })
  .strict()
  .superRefine((value, context) => {
    const first = value.messages[0]
    if (first && first.location.index !== value.baseCursor.index + 1) {
      context.addIssue({
        code: 'custom',
        message: 'incremental sync must start after baseCursor',
        path: ['messages', 0, 'location', 'index']
      })
    }
  })

export const L2ChatSessionSyncEventSchema = z.union([
  L2ChatFullSessionSyncEventSchema,
  L2ChatIncrementalSessionSyncEventSchema
])

export const L2ChatMessageStartEventSchema = L3ConversationMessageStartEventSchema
export const L2ChatMessageUpdateEventSchema = L3ConversationMessageUpdateEventSchema
export const L2ChatMessageCommitEventSchema = L3ConversationMessageCommitEventSchema
export const L2ChatMessageDiscardEventSchema = L3ConversationMessageDiscardEventSchema

export const L2ChatRuntimeUpdateEventSchema = z
  .object({
    type: z.literal('runtime_update'),
    runtime: L2ChatRuntimeSchema
  })
  .strict()

export const L2ChatSourceEventSchema = z.union([
  L2ChatSessionSyncEventSchema,
  L2ChatMessageStartEventSchema,
  L2ChatMessageUpdateEventSchema,
  L2ChatMessageCommitEventSchema,
  L2ChatMessageDiscardEventSchema,
  L2ChatRuntimeUpdateEventSchema
])

export const L2ChatSourceEventPushSchema = z
  .object({
    source: L2ChatSourceSchema,
    event: L2ChatSourceEventSchema
  })
  .strict()

export const L2ChatSendModeSchema = z.enum(['auto', 'follow_up'])

export const L2ChatSendRequestSchema = z
  .object({
    source: L2ChatSourceSchema,
    mode: L2ChatSendModeSchema,
    text: z.string(),
    images: z.array(L2ChatInputImageSchema).max(10)
  })
  .strict()
  .refine((value) => value.text.trim().length > 0 || value.images.length > 0, {
    message: 'chat input requires text or images'
  })

export const L2ChatSendResponseSchema = z
  .object({
    tempId: L2ChatTemporaryMessageLocationSchema.shape.tempId
  })
  .strict()

export const L2ChatInterruptRequestSchema = z
  .object({
    source: L2ChatSourceSchema
  })
  .strict()

export const L2ChatInterruptResponseSchema = z.object({}).strict()

export const L2ChatReloadRequestSchema = L2ChatInterruptRequestSchema.extend({
  mode: L2ChatModeSchema.optional()
}).strict()
export const L2ChatPresentationSetRequestSchema = L2ChatInterruptRequestSchema.extend({
  mode: L2ChatModeSchema
}).strict()
export const L2ChatReloadResponseSchema = z.object({}).strict()

export const L2ChatCompactRequestSchema = L2ChatInterruptRequestSchema
export const L2ChatCompactResponseSchema = z.object({}).strict()

export const L2ChatQueueRestoreRequestSchema = L2ChatInterruptRequestSchema

export const L2ChatQueueRestoreResponseSchema = z
  .object({
    text: z.string(),
    images: z.array(L2ChatInputImageSchema)
  })
  .strict()

export const L2ChatModelSetRequestSchema = z
  .object({
    source: L2ChatSourceSchema,
    model: L2ChatModelStateSchema
  })
  .strict()

export const L2ChatModelSetResponseSchema = z.object({}).strict()

export const L2ChatCapabilityModeSetRequestSchema = z
  .object({
    source: L2ChatSourceSchema,
    capabilityMode: L2ChatRuntimeSchema.shape.capabilityMode
  })
  .strict()
export const L2ChatCapabilityModeSetResponseSchema = z.object({}).strict()

export const L2ChatSocketKnownRequestPathSchema = z.enum([
  'chat/subscribe',
  'chat/send',
  'chat/interrupt',
  'chat/reload',
  'chat/presentation-set',
  'chat/compact',
  'chat/queue-restore',
  'chat/model-set',
  'chat/capability-mode-set'
])
export const L2ChatSocketPushPathSchema = z.literal('chat/source-event')

export const L2ChatSocketContracts = Object.freeze({
  subscribe: defineL4AppSocketRequest({
    path: 'chat/subscribe',
    inputSchema: L2ChatSubscribeRequestSchema,
    outputSchema: L2ChatSubscribeResponseSchema,
    timeoutMs: 125_000
  }),
  send: defineL4AppSocketRequest({
    path: 'chat/send',
    inputSchema: L2ChatSendRequestSchema,
    outputSchema: L2ChatSendResponseSchema,
    timeoutMs: 120_000
  }),
  interrupt: defineL4AppSocketRequest({
    path: 'chat/interrupt',
    inputSchema: L2ChatInterruptRequestSchema,
    outputSchema: L2ChatInterruptResponseSchema
  }),
  reload: defineL4AppSocketRequest({
    path: 'chat/reload',
    inputSchema: L2ChatReloadRequestSchema,
    outputSchema: L2ChatReloadResponseSchema,
    timeoutMs: 125_000
  }),
  presentationSet: defineL4AppSocketRequest({
    path: 'chat/presentation-set',
    inputSchema: L2ChatPresentationSetRequestSchema,
    outputSchema: L2ChatReloadResponseSchema
  }),
  compact: defineL4AppSocketRequest({
    path: 'chat/compact',
    inputSchema: L2ChatCompactRequestSchema,
    outputSchema: L2ChatCompactResponseSchema,
    timeoutMs: 600_000
  }),
  queueRestore: defineL4AppSocketRequest({
    path: 'chat/queue-restore',
    inputSchema: L2ChatQueueRestoreRequestSchema,
    outputSchema: L2ChatQueueRestoreResponseSchema
  }),
  modelSet: defineL4AppSocketRequest({
    path: 'chat/model-set',
    inputSchema: L2ChatModelSetRequestSchema,
    outputSchema: L2ChatModelSetResponseSchema
  }),
  capabilityModeSet: defineL4AppSocketRequest({
    path: 'chat/capability-mode-set',
    inputSchema: L2ChatCapabilityModeSetRequestSchema,
    outputSchema: L2ChatCapabilityModeSetResponseSchema
  }),
  sourceEvent: defineL4AppSocketPush({
    path: L2ChatSocketPushPathSchema.value,
    bodySchema: L2ChatSourceEventPushSchema
  })
})

export type L2ChatSubscribeRequest = z.infer<typeof L2ChatSubscribeRequestSchema>
export type L2ChatSubscribeResponse = z.infer<typeof L2ChatSubscribeResponseSchema>
export type L2ChatSessionSyncEvent = z.infer<typeof L2ChatSessionSyncEventSchema>
export type L2ChatMessageStartEvent = z.infer<typeof L2ChatMessageStartEventSchema>
export type L2ChatMessageUpdateEvent = z.infer<typeof L2ChatMessageUpdateEventSchema>
export type L2ChatMessageCommitEvent = z.infer<typeof L2ChatMessageCommitEventSchema>
export type L2ChatMessageDiscardEvent = z.infer<typeof L2ChatMessageDiscardEventSchema>
export type L2ChatRuntimeUpdateEvent = z.infer<typeof L2ChatRuntimeUpdateEventSchema>
export type L2ChatSourceEvent = z.infer<typeof L2ChatSourceEventSchema>
export type L2ChatSourceEventPush = z.infer<typeof L2ChatSourceEventPushSchema>
export type L2ChatSendMode = z.infer<typeof L2ChatSendModeSchema>
export type L2ChatSendRequest = z.infer<typeof L2ChatSendRequestSchema>
export type L2ChatSendResponse = z.infer<typeof L2ChatSendResponseSchema>
export type L2ChatInterruptRequest = z.infer<typeof L2ChatInterruptRequestSchema>
export type L2ChatInterruptResponse = z.infer<typeof L2ChatInterruptResponseSchema>
export type L2ChatReloadRequest = z.infer<typeof L2ChatReloadRequestSchema>
export type L2ChatReloadResponse = z.infer<typeof L2ChatReloadResponseSchema>
export type L2ChatCompactRequest = z.infer<typeof L2ChatCompactRequestSchema>
export type L2ChatCompactResponse = z.infer<typeof L2ChatCompactResponseSchema>
export type L2ChatQueueRestoreRequest = z.infer<typeof L2ChatQueueRestoreRequestSchema>
export type L2ChatQueueRestoreResponse = z.infer<typeof L2ChatQueueRestoreResponseSchema>
export type L2ChatModelSetRequest = z.infer<typeof L2ChatModelSetRequestSchema>
export type L2ChatModelSetResponse = z.infer<typeof L2ChatModelSetResponseSchema>
export type L2ChatCapabilityModeSetRequest = z.infer<typeof L2ChatCapabilityModeSetRequestSchema>
export type L2ChatSocketKnownRequestPath = z.infer<typeof L2ChatSocketKnownRequestPathSchema>
