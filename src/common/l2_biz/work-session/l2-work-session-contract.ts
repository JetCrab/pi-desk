import { z } from 'zod'
import {
  L3PiCwdSchema,
  L3PiEntryIdSchema,
  L3PiSessionIdSchema
} from '@common/l3_modules/pi/l3-pi-contract'
import { L4TimestampMsSchema } from '@common/l4_foundation/l4-timestamp-contract'

export const L2WorkIdSchema = z.string().trim().min(1)
export const L2CwdSchema = L3PiCwdSchema
export const L2PiSessionIdSchema = L3PiSessionIdSchema
export const L2PiEntryIdSchema = L3PiEntryIdSchema
export const L2WorkSessionBranchIdSchema = z.string().trim().min(1)
export const L2WorkSessionPinnedCountSchema = z.number().int().nonnegative()

export const L2WorkSessionRecordSchema = z
  .object({
    workId: L2WorkIdSchema,
    cwd: L2CwdSchema,
    sessionId: L2PiSessionIdSchema
  })
  .strict()

export const L2WorkSessionRecordsSchema = z.array(L2WorkSessionRecordSchema)

export const L2WorkSessionStatusSchema = z.enum([
  'main_running',
  'background_running',
  'completed',
  'idle'
])

export const L2WorkSessionMessageCountsSchema = z
  .object({
    user: z.number().int().nonnegative(),
    total: z.number().int().nonnegative()
  })
  .strict()
  .refine((counts) => counts.user <= counts.total, {
    message: 'user message count cannot exceed total message count'
  })

export const L2WorkSessionListItemSchema = L2WorkSessionRecordSchema.extend({
  branchId: L2WorkSessionBranchIdSchema,
  projectName: z.string().trim().min(1),
  sessionTitle: z.string().trim().min(1).nullable(),
  status: L2WorkSessionStatusSchema,
  messageCounts: L2WorkSessionMessageCountsSchema,
  lastMessageUpdatedAt: L4TimestampMsSchema.nullable()
}).strict()

export const L2WorkSessionListResponseSchema = z
  .object({
    workSessions: z.array(L2WorkSessionListItemSchema),
    pinnedCount: L2WorkSessionPinnedCountSchema
  })
  .strict()
  .refine((value) => value.pinnedCount <= value.workSessions.length, {
    message: 'pinnedCount cannot exceed work session count',
    path: ['pinnedCount']
  })

export const L2CreateWorkSessionRequestSchema = z
  .object({
    cwd: L2CwdSchema,
    sessionId: L2PiSessionIdSchema.optional()
  })
  .strict()

export const L2CreateWorkSessionResponseSchema = z
  .object({
    workSession: L2WorkSessionListItemSchema
  })
  .strict()

export const L2DeleteWorkSessionRequestSchema = z
  .object({
    workId: L2WorkIdSchema
  })
  .strict()

export const L2SortWorkSessionsRequestSchema = z
  .object({
    workIds: z.array(L2WorkIdSchema),
    pinnedCount: L2WorkSessionPinnedCountSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.workIds).size !== value.workIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'workIds cannot contain duplicates',
        path: ['workIds']
      })
    }
    if (value.pinnedCount > value.workIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'pinnedCount cannot exceed workIds length',
        path: ['pinnedCount']
      })
    }
  })

export const L2ReplaceWorkSessionRequestSchema = z.union([
  z
    .object({
      workId: L2WorkIdSchema,
      cwd: L2CwdSchema,
      sessionId: L2PiSessionIdSchema
    })
    .strict(),
  z
    .object({
      workId: L2WorkIdSchema
    })
    .strict()
])

export type L2WorkSessionRecord = z.infer<typeof L2WorkSessionRecordSchema>
export type L2WorkSessionStatus = z.infer<typeof L2WorkSessionStatusSchema>
export type L2WorkSessionMessageCounts = z.infer<typeof L2WorkSessionMessageCountsSchema>
export type L2WorkSessionListItem = z.infer<typeof L2WorkSessionListItemSchema>
export type L2WorkSessionListResponse = z.infer<typeof L2WorkSessionListResponseSchema>
export type L2CreateWorkSessionRequest = z.infer<typeof L2CreateWorkSessionRequestSchema>
export type L2CreateWorkSessionResponse = z.infer<typeof L2CreateWorkSessionResponseSchema>
export type L2SortWorkSessionsRequest = z.infer<typeof L2SortWorkSessionsRequestSchema>
export type L2ReplaceWorkSessionRequest = z.infer<typeof L2ReplaceWorkSessionRequestSchema>
