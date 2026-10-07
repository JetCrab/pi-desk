import { z } from 'zod'
import { L3WorkSessionSourceSchema } from '@common/l3_modules/work-session/l3-work-session-source-contract'
import {
  L2TaskDetailEventSchema,
  L2TaskDetailSnapshotSchema,
  L2TaskIdSchema
} from './l2-task-center-contract'
import {
  defineL4AppSocketPush,
  defineL4AppSocketRequest
} from '@common/l4_foundation/realtime/l4-app-websocket-contract'

export const L2TaskDetailWatchRequestSchema = z
  .object({
    source: L3WorkSessionSourceSchema,
    taskId: L2TaskIdSchema.nullable()
  })
  .strict()

export const L2TaskDetailWatchResponseSchema = z
  .object({ snapshot: L2TaskDetailSnapshotSchema.nullable() })
  .strict()

export const L2TaskInterruptRequestSchema = z
  .object({
    source: L3WorkSessionSourceSchema,
    taskId: L2TaskIdSchema
  })
  .strict()

export const L2TaskInterruptResponseSchema = z.object({}).strict()

export const L2TaskDetailEventPushSchema = z
  .object({
    source: L3WorkSessionSourceSchema,
    taskId: L2TaskIdSchema,
    event: L2TaskDetailEventSchema
  })
  .strict()

export const L2TaskCenterSocketContracts = Object.freeze({
  detailWatch: defineL4AppSocketRequest({
    path: 'task-center/detail-watch',
    inputSchema: L2TaskDetailWatchRequestSchema,
    outputSchema: L2TaskDetailWatchResponseSchema
  }),
  interrupt: defineL4AppSocketRequest({
    path: 'task-center/interrupt',
    inputSchema: L2TaskInterruptRequestSchema,
    outputSchema: L2TaskInterruptResponseSchema
  }),
  detailEvent: defineL4AppSocketPush({
    path: 'task-center/detail-event',
    bodySchema: L2TaskDetailEventPushSchema
  })
})

export type L2TaskDetailWatchRequest = z.infer<typeof L2TaskDetailWatchRequestSchema>
export type L2TaskDetailWatchResponse = z.infer<typeof L2TaskDetailWatchResponseSchema>
export type L2TaskInterruptRequest = z.infer<typeof L2TaskInterruptRequestSchema>
export type L2TaskInterruptResponse = z.infer<typeof L2TaskInterruptResponseSchema>
export type L2TaskDetailEventPush = z.infer<typeof L2TaskDetailEventPushSchema>
