import { z } from 'zod'
import { L3WorkSessionSourceSchema } from '@common/l3_modules/work-session/l3-work-session-source-contract'
import {
  L3ConversationImageGetResponseSchema,
  L3ConversationMessageDetailResponseSchema,
  L3ConversationStateSchema
} from '@common/l3_modules/conversation/l3-conversation-contract'
import { L3ConversationEventSchema } from '@common/l3_modules/conversation/l3-conversation-event-contract'
import { L3PiEntryIdSchema } from '@common/l3_modules/pi/l3-pi-contract'
import { L4TimestampMsSchema } from '@common/l4_foundation/l4-timestamp-contract'

export const L2TaskIdSchema = z.string().trim().min(1).max(200)
export const L2TaskKindSchema = z.string().trim().min(1).max(100).nullable()
export const L2TaskTypeSchema = z.string().trim().min(1).max(100).nullable()
export const L2TaskTitleSchema = z.string().trim().min(1).max(200)
export const L2TaskInfoItemSchema = z
  .object({
    label: z.string().trim().min(1).max(64),
    value: z.string().trim().min(1).max(500)
  })
  .strict()
export const L2TaskActivitySchema = z.string().trim().min(1).max(300).nullable()
export const L2TaskStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'stopped',
  'interrupted'
])

export const L2TaskSummarySchema = z
  .object({
    taskId: L2TaskIdSchema,
    taskKind: L2TaskKindSchema,
    taskType: L2TaskTypeSchema,
    title: L2TaskTitleSchema,
    info: z.array(L2TaskInfoItemSchema).max(12),
    status: L2TaskStatusSchema,
    activity: L2TaskActivitySchema,
    startedAt: L4TimestampMsSchema,
    endedAt: L4TimestampMsSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === 'running' && value.endedAt !== null) {
      context.addIssue({
        code: 'custom',
        message: 'running task requires endedAt=null',
        path: ['endedAt']
      })
    }
    if (value.status !== 'running' && value.endedAt === null) {
      context.addIssue({
        code: 'custom',
        message: 'terminal task requires endedAt',
        path: ['endedAt']
      })
    }
  })

export const L2TaskCenterPluginStateSchema = z
  .object({ tasks: z.array(L2TaskSummarySchema) })
  .strict()
  .superRefine((value, context) => {
    const taskIds = new Set<string>()
    for (const [index, task] of value.tasks.entries()) {
      if (taskIds.has(task.taskId)) {
        context.addIssue({
          code: 'custom',
          message: 'taskId values must be unique',
          path: ['tasks', index, 'taskId']
        })
      }
      taskIds.add(task.taskId)
    }
  })

const L2TaskTextDetailBodySchema = z
  .object({
    kind: z.literal('text'),
    text: z.string(),
    truncated: z.boolean()
  })
  .strict()

const L2TaskConversationDetailBodySchema = L3ConversationStateSchema.extend({
  kind: z.literal('conversation'),
  truncated: z.boolean()
}).strict()

export const L2TaskDetailBodySchema = z.union([
  z.null(),
  L2TaskTextDetailBodySchema,
  L2TaskConversationDetailBodySchema
])

export const L2TaskDetailSnapshotSchema = z
  .object({
    taskId: L2TaskIdSchema,
    canInterrupt: z.boolean(),
    body: L2TaskDetailBodySchema
  })
  .strict()

export const L2TaskConversationEventSchema = L3ConversationEventSchema

export const L2TaskDetailEventSchema = z.union([
  z
    .object({
      type: z.literal('snapshot'),
      snapshot: L2TaskDetailSnapshotSchema
    })
    .strict(),
  z
    .object({
      type: z.literal('text_append'),
      text: z.string().min(1)
    })
    .strict(),
  z
    .object({
      type: z.literal('conversation_event'),
      event: L2TaskConversationEventSchema
    })
    .strict(),
  z.object({ type: z.literal('unavailable') }).strict()
])

export const L2TaskMessageGetRequestSchema = z
  .object({
    source: L3WorkSessionSourceSchema,
    taskId: L2TaskIdSchema,
    entryId: L3PiEntryIdSchema
  })
  .strict()

export const L2TaskMessageGetResponseSchema = L3ConversationMessageDetailResponseSchema

export const L2TaskImageGetRequestSchema = L2TaskMessageGetRequestSchema.extend({
  imageIndex: z.number().int().nonnegative()
}).strict()

export const L2TaskImageGetResponseSchema = L3ConversationImageGetResponseSchema

export type L2TaskId = z.infer<typeof L2TaskIdSchema>
export type L2TaskStatus = z.infer<typeof L2TaskStatusSchema>
export type L2TaskInfoItem = z.infer<typeof L2TaskInfoItemSchema>
export type L2TaskSummary = z.infer<typeof L2TaskSummarySchema>
export type L2TaskCenterPluginState = z.infer<typeof L2TaskCenterPluginStateSchema>
export type L2TaskDetailBody = z.infer<typeof L2TaskDetailBodySchema>
export type L2TaskDetailSnapshot = z.infer<typeof L2TaskDetailSnapshotSchema>
export type L2TaskConversationEvent = z.infer<typeof L2TaskConversationEventSchema>
export type L2TaskDetailEvent = z.infer<typeof L2TaskDetailEventSchema>
export type L2TaskMessageGetRequest = z.infer<typeof L2TaskMessageGetRequestSchema>
export type L2TaskMessageGetResponse = z.infer<typeof L2TaskMessageGetResponseSchema>
export type L2TaskImageGetRequest = z.infer<typeof L2TaskImageGetRequestSchema>
export type L2TaskImageGetResponse = z.infer<typeof L2TaskImageGetResponseSchema>
