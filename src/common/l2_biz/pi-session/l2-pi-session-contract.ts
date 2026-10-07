import { z } from 'zod'
import {
  L3PiCwdSchema,
  L3PiEntryIdSchema,
  L3PiSessionIdSchema
} from '@common/l3_modules/pi/l3-pi-contract'
import { L4TimestampMsSchema } from '@common/l4_foundation/l4-timestamp-contract'

export const L2PiDirectorySchema = z
  .object({
    cwd: L3PiCwdSchema,
    sessionCount: z.number().int().nonnegative(),
    updatedAt: L4TimestampMsSchema
  })
  .strict()

export const L2PiDirectoryListRequestSchema = z
  .object({
    forceRefresh: z.boolean().default(false)
  })
  .strict()

export const L2PiDirectoryListResponseSchema = z
  .object({
    directories: z.array(L2PiDirectorySchema)
  })
  .strict()

export const L2PiDirectoryIgnoreListRequestSchema = L2PiDirectoryListRequestSchema
export const L2PiDirectoryIgnoreListResponseSchema = L2PiDirectoryListResponseSchema

export const L2PiDirectoryIgnoreReplaceRequestSchema = z
  .object({
    cwd: L3PiCwdSchema,
    ignored: z.boolean()
  })
  .strict()

export const L2PiDirectoryIgnoreReplaceResponseSchema = z.object({}).strict()

export const L2PiDirectoryEntrySchema = z
  .object({
    cwd: L3PiCwdSchema,
    name: z.string().trim().min(1)
  })
  .strict()

export const L2PiDirectoryEntryListRequestSchema = z
  .object({
    cwd: L3PiCwdSchema.nullable()
  })
  .strict()

export const L2PiDirectoryEntryListResponseSchema = z
  .object({
    cwd: L3PiCwdSchema.nullable(),
    parentCwd: L3PiCwdSchema.nullable(),
    directories: z.array(L2PiDirectoryEntrySchema)
  })
  .strict()

export const L2PiSessionHistorySearchScopeSchema = z.enum([
  'title',
  'user',
  'assistant',
  'sessionId'
])

export const L2PiSessionHistoryMatchSchema = z
  .object({
    scope: L2PiSessionHistorySearchScopeSchema,
    count: z.number().int().positive(),
    entryId: L3PiEntryIdSchema.nullable(),
    timestampMs: L4TimestampMsSchema.nullable(),
    preview: z.string().min(1).max(160)
  })
  .strict()

export const L2PiSessionHistoryItemSchema = z
  .object({
    sessionId: L3PiSessionIdSchema,
    cwd: L3PiCwdSchema,
    name: z.string().nullable(),
    createdAt: L4TimestampMsSchema,
    updatedAt: L4TimestampMsSchema,
    messageCount: z.number().int().nonnegative(),
    userMessageCount: z.number().int().nonnegative(),
    firstMessage: z.string().max(160),
    matches: z.array(L2PiSessionHistoryMatchSchema).min(1).max(4).nullable()
  })
  .strict()

export const L2PiSessionHistoryQuerySchema = z
  .object({
    cwd: L3PiCwdSchema,
    query: z.string().trim().max(120).default(''),
    forceRefresh: z.boolean().default(false),
    searchIn: z.array(L2PiSessionHistorySearchScopeSchema).min(1).max(4).default(['title', 'user'])
  })
  .strict()

export const L2PiSessionHistoryResponseSchema = z
  .object({
    cwd: L3PiCwdSchema,
    sessions: z.array(L2PiSessionHistoryItemSchema)
  })
  .strict()

export const L2PiSessionUserMessageListRequestSchema = z
  .object({
    cwd: L3PiCwdSchema,
    sessionId: L3PiSessionIdSchema,
    query: z.string().trim().max(120).default(''),
    page: z
      .object({
        index: z.number().int().positive(),
        size: z.number().int().positive().max(50)
      })
      .strict()
  })
  .strict()

export const L2PiSessionUserMessageSchema = z
  .object({
    entryId: L3PiEntryIdSchema,
    timestampMs: L4TimestampMsSchema,
    text: z.string()
  })
  .strict()

export const L2PiSessionUserMessageListResponseSchema = z
  .object({
    page: z
      .object({
        index: z.number().int().positive(),
        size: z.number().int().positive(),
        total: z.number().int().nonnegative()
      })
      .strict(),
    messages: z.array(L2PiSessionUserMessageSchema)
  })
  .strict()

export type L2PiDirectoryListResponse = z.infer<typeof L2PiDirectoryListResponseSchema>
export type L2PiDirectoryIgnoreListResponse = z.infer<typeof L2PiDirectoryIgnoreListResponseSchema>
export type L2PiDirectoryIgnoreReplaceRequest = z.infer<
  typeof L2PiDirectoryIgnoreReplaceRequestSchema
>
export type L2PiDirectoryIgnoreReplaceResponse = z.infer<
  typeof L2PiDirectoryIgnoreReplaceResponseSchema
>
export type L2PiDirectoryEntryListResponse = z.infer<typeof L2PiDirectoryEntryListResponseSchema>
export type L2PiSessionHistoryQuery = z.infer<typeof L2PiSessionHistoryQuerySchema>
export type L2PiSessionHistoryResponse = z.infer<typeof L2PiSessionHistoryResponseSchema>
export type L2PiSessionHistorySearchScope = z.infer<typeof L2PiSessionHistorySearchScopeSchema>
export type L2PiSessionUserMessageListRequest = z.infer<
  typeof L2PiSessionUserMessageListRequestSchema
>
export type L2PiSessionUserMessageListResponse = z.infer<
  typeof L2PiSessionUserMessageListResponseSchema
>
