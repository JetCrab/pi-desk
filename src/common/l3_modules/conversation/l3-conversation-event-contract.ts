import { z } from 'zod'
import {
  L3ConversationDurableMessageLocationSchema,
  L3ConversationDurableMessageSnapshotSchema,
  L3ConversationMessageDetailPatchSchema,
  L3ConversationMessageFixedPatchSchema,
  L3ConversationMessageIncrementsSchema,
  L3ConversationMessageSummaryPatchSchema,
  L3ConversationTemporaryMessageLocationSchema,
  L3ConversationTemporaryMessageSnapshotSchema
} from './l3-conversation-contract'
import { L4TimestampMsSchema } from '@common/l4_foundation/l4-timestamp-contract'
import {
  isL3ConversationIncrementPathPrefix,
  parseL3ConversationIncrementPath
} from './l3-conversation-increment-path'

export const L3ConversationMessageStartEventSchema = z
  .object({
    type: z.literal('message_start'),
    snapshot: L3ConversationTemporaryMessageSnapshotSchema
  })
  .strict()

export const L3ConversationMessageUpdateEventSchema = z
  .object({
    type: z.literal('message_update'),
    location: L3ConversationTemporaryMessageLocationSchema,
    fixed: L3ConversationMessageFixedPatchSchema.optional(),
    summary: L3ConversationMessageSummaryPatchSchema.optional(),
    detail: L3ConversationMessageDetailPatchSchema.optional(),
    increments: L3ConversationMessageIncrementsSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.fixed && !value.summary && !value.detail && !value.increments) {
      context.addIssue({ code: 'custom', message: 'message update requires a changed layer' })
      return
    }

    const increments: Array<{
      raw: string
      parsed: ReturnType<typeof parseL3ConversationIncrementPath>
    }> = []
    for (const path of Object.keys(value.increments ?? {})) {
      try {
        increments.push({ raw: path, parsed: parseL3ConversationIncrementPath(path) })
      } catch {
        // increments 字段 Schema 已报告精确路径错误。
      }
    }
    for (const increment of increments) {
      const replacements =
        increment.parsed.root === 'summary'
          ? Object.keys(value.summary ?? {})
          : Object.keys(value.detail ?? {})
      const firstSegment = increment.parsed.segments[0]
      if (
        increment.parsed.segments.length === 0 ||
        (typeof firstSegment === 'string' && replacements.includes(firstSegment))
      ) {
        context.addIssue({
          code: 'custom',
          message: 'replacement and increment paths cannot overlap',
          path: ['increments', increment.raw]
        })
      }
    }

    for (let leftIndex = 0; leftIndex < increments.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < increments.length; rightIndex += 1) {
        const left = increments[leftIndex]!
        const right = increments[rightIndex]!
        if (
          isL3ConversationIncrementPathPrefix(left.parsed, right.parsed) ||
          isL3ConversationIncrementPathPrefix(right.parsed, left.parsed)
        ) {
          context.addIssue({
            code: 'custom',
            message: 'increment parent and child paths cannot overlap',
            path: ['increments', right.raw]
          })
        }
      }
    }
  })

export const L3ConversationMessageCommitEventSchema = z
  .object({
    type: z.literal('message_commit'),
    location: L3ConversationTemporaryMessageLocationSchema,
    durable: L3ConversationDurableMessageLocationSchema,
    fixed: z.object({ timestampMs: L4TimestampMsSchema }).strict()
  })
  .strict()

export const L3ConversationMessageDiscardEventSchema = z
  .object({
    type: z.literal('message_discard'),
    location: L3ConversationTemporaryMessageLocationSchema
  })
  .strict()

export const L3ConversationDurableAppendEventSchema = z
  .object({
    type: z.literal('durable_append'),
    messages: z.array(L3ConversationDurableMessageSnapshotSchema).min(1)
  })
  .strict()
  .superRefine((value, context) => {
    const entryIds = new Set<string>()
    for (const [index, message] of value.messages.entries()) {
      if (index > 0 && message.location.index !== value.messages[index - 1]!.location.index + 1) {
        context.addIssue({
          code: 'custom',
          message: 'durable append message indexes must be continuous',
          path: ['messages', index, 'location', 'index']
        })
      }
      if (entryIds.has(message.location.entryId)) {
        context.addIssue({
          code: 'custom',
          message: 'durable append entryId values must be unique',
          path: ['messages', index, 'location', 'entryId']
        })
      }
      entryIds.add(message.location.entryId)
    }
  })

export const L3ConversationRealtimeEventSchema = z.union([
  L3ConversationMessageStartEventSchema,
  L3ConversationMessageUpdateEventSchema,
  L3ConversationMessageCommitEventSchema,
  L3ConversationMessageDiscardEventSchema
])

export const L3ConversationEventSchema = z.union([
  L3ConversationDurableAppendEventSchema,
  L3ConversationRealtimeEventSchema
])

export type L3ConversationMessageStartEvent = z.infer<typeof L3ConversationMessageStartEventSchema>
export type L3ConversationMessageUpdateEvent = z.infer<
  typeof L3ConversationMessageUpdateEventSchema
>
export type L3ConversationMessageCommitEvent = z.infer<
  typeof L3ConversationMessageCommitEventSchema
>
export type L3ConversationMessageDiscardEvent = z.infer<
  typeof L3ConversationMessageDiscardEventSchema
>
export type L3ConversationDurableAppendEvent = z.infer<
  typeof L3ConversationDurableAppendEventSchema
>
export type L3ConversationRealtimeEvent = z.infer<typeof L3ConversationRealtimeEventSchema>
export type L3ConversationEvent = z.infer<typeof L3ConversationEventSchema>
