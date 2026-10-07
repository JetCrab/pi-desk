import { z } from 'zod'
import {
  L2CwdSchema,
  L2PiSessionIdSchema,
  L2WorkIdSchema,
  L2WorkSessionListItemSchema,
  L2WorkSessionPinnedCountSchema,
  L2WorkSessionMessageCountsSchema,
  L2WorkSessionStatusSchema
} from './l2-work-session-contract'
import { L3AppRuntimeSchema } from '@common/l3_modules/app-runtime/l3-app-runtime-contract'
import { L4TimestampMsSchema } from '@common/l4_foundation/l4-timestamp-contract'
import {
  defineL4AppSocketPush,
  defineL4AppSocketRequest
} from '@common/l4_foundation/realtime/l4-app-websocket-contract'

const L2EmptyRequestSchema = z.object({}).strict()

export const L2AckCompletedWorkSessionRequestSchema = z
  .object({
    workId: L2WorkIdSchema
  })
  .strict()

export const L2AckCompletedWorkSessionResponseSchema = z
  .object({
    workId: L2WorkIdSchema
  })
  .strict()

export const L2WorkSessionChangesSchema = z
  .object({
    cwd: L2CwdSchema.optional(),
    sessionId: L2PiSessionIdSchema.optional(),
    branchId: z.string().min(1).optional(),
    projectName: z.string().trim().min(1).optional(),
    sessionTitle: z.string().trim().min(1).nullable().optional(),
    status: L2WorkSessionStatusSchema.optional(),
    messageCounts: L2WorkSessionMessageCountsSchema.optional(),
    lastMessageUpdatedAt: L4TimestampMsSchema.nullable().optional()
  })
  .strict()
  .refine((changes) => Object.keys(changes).length > 0, {
    message: 'work session changes cannot be empty'
  })

export const L2AppBootstrapResponseSchema = z
  .object({
    workSessions: z.array(L2WorkSessionListItemSchema),
    pinnedCount: L2WorkSessionPinnedCountSchema,
    appRuntime: L3AppRuntimeSchema
  })
  .strict()
  .refine((value) => value.pinnedCount <= value.workSessions.length, {
    message: 'pinnedCount cannot exceed work session count',
    path: ['pinnedCount']
  })

export const L2WorkSessionsUpdateSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('snapshot'),
      workSessions: z.array(L2WorkSessionListItemSchema),
      pinnedCount: L2WorkSessionPinnedCountSchema
    })
    .strict()
    .refine((value) => value.pinnedCount <= value.workSessions.length, {
      message: 'pinnedCount cannot exceed work session count',
      path: ['pinnedCount']
    }),
  z
    .object({
      type: z.literal('update'),
      workId: L2WorkIdSchema,
      changes: L2WorkSessionChangesSchema
    })
    .strict(),
  z
    .object({
      type: z.literal('delete'),
      workId: L2WorkIdSchema
    })
    .strict()
])

export const L2WorkSessionSocketContracts = Object.freeze({
  list: defineL4AppSocketRequest({
    path: 'work-sessions/list',
    inputSchema: L2EmptyRequestSchema,
    outputSchema: L2AppBootstrapResponseSchema
  }),
  acknowledgeCompleted: defineL4AppSocketRequest({
    path: 'work-sessions/ack-completed',
    inputSchema: L2AckCompletedWorkSessionRequestSchema,
    outputSchema: L2AckCompletedWorkSessionResponseSchema
  }),
  update: defineL4AppSocketPush({
    path: 'work-sessions/update',
    bodySchema: L2WorkSessionsUpdateSchema
  })
})

export type L2AppBootstrapResponse = z.infer<typeof L2AppBootstrapResponseSchema>
export type L2AckCompletedWorkSessionRequest = z.infer<
  typeof L2AckCompletedWorkSessionRequestSchema
>
export type L2AckCompletedWorkSessionResponse = z.infer<
  typeof L2AckCompletedWorkSessionResponseSchema
>
export type L2WorkSessionChanges = z.infer<typeof L2WorkSessionChangesSchema>
export type L2WorkSessionsUpdate = z.infer<typeof L2WorkSessionsUpdateSchema>
