import { z } from 'zod'
import { L4TimestampMsSchema } from '@common/l4_foundation/l4-timestamp-contract'
import {
  L2PiEntryIdSchema,
  L2PiSessionIdSchema,
  L2WorkIdSchema,
  L2WorkSessionListItemSchema,
  L2WorkSessionPinnedCountSchema
} from './l2-work-session-contract'

export const L2WorkSessionTreeNodeKindSchema = z.enum([
  'user',
  'assistant',
  'tool',
  'bash',
  'custom_message',
  'compaction',
  'branch_summary',
  'custom',
  'model_change',
  'thinking_level_change',
  'session_info',
  'label'
])

export const L2WorkSessionTreeNodeSchema = z
  .object({
    entryId: L2PiEntryIdSchema,
    parentEntryId: L2PiEntryIdSchema.nullable(),
    timestampMs: L4TimestampMsSchema,
    kind: L2WorkSessionTreeNodeKindSchema,
    preview: z.string(),
    label: z.string().trim().min(1).nullable()
  })
  .strict()

export const L2WorkSessionTreeGetRequestSchema = z
  .object({
    workId: L2WorkIdSchema,
    sessionId: L2PiSessionIdSchema
  })
  .strict()

export const L2WorkSessionTreeGetResponseSchema = z
  .object({
    sessionId: L2PiSessionIdSchema,
    leafEntryId: L2PiEntryIdSchema.nullable(),
    nodes: z.array(L2WorkSessionTreeNodeSchema)
  })
  .strict()
  .superRefine((value, context) => {
    const entryIds = new Set<string>()
    for (const [index, node] of value.nodes.entries()) {
      if (entryIds.has(node.entryId)) {
        context.addIssue({
          code: 'custom',
          message: 'work session tree entryId values must be unique',
          path: ['nodes', index, 'entryId']
        })
      }
      entryIds.add(node.entryId)
    }
    if (value.leafEntryId !== null && !entryIds.has(value.leafEntryId)) {
      context.addIssue({
        code: 'custom',
        message: 'work session tree leafEntryId must reference a node',
        path: ['leafEntryId']
      })
    }
  })

export const L2WorkSessionTreeEntryGetRequestSchema = z
  .object({
    workId: L2WorkIdSchema,
    sessionId: L2PiSessionIdSchema,
    entryId: L2PiEntryIdSchema
  })
  .strict()

export const L2WorkSessionTreeEntryGetResponseSchema = z
  .object({
    entryId: L2PiEntryIdSchema,
    kind: L2WorkSessionTreeNodeKindSchema,
    content: z.string(),
    truncated: z.boolean()
  })
  .strict()

export const L2WorkSessionBranchActionSchema = z.enum(['tree', 'fork', 'clone'])

export const L2WorkSessionBranchRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('tree'),
      workId: L2WorkIdSchema,
      sessionId: L2PiSessionIdSchema,
      entryId: L2PiEntryIdSchema
    })
    .strict(),
  z
    .object({
      action: z.literal('fork'),
      workId: L2WorkIdSchema,
      sessionId: L2PiSessionIdSchema,
      entryId: L2PiEntryIdSchema
    })
    .strict(),
  z
    .object({
      action: z.literal('clone'),
      workId: L2WorkIdSchema,
      sessionId: L2PiSessionIdSchema
    })
    .strict()
])

export const L2WorkSessionBranchResponseSchema = z
  .object({
    workSessions: z.array(L2WorkSessionListItemSchema),
    pinnedCount: L2WorkSessionPinnedCountSchema,
    targetWorkId: L2WorkIdSchema,
    editorText: z.string().nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.pinnedCount > value.workSessions.length) {
      context.addIssue({
        code: 'custom',
        message: 'pinnedCount cannot exceed work session count',
        path: ['pinnedCount']
      })
    }
    if (!value.workSessions.some((workSession) => workSession.workId === value.targetWorkId)) {
      context.addIssue({
        code: 'custom',
        message: 'targetWorkId must reference a returned work session',
        path: ['targetWorkId']
      })
    }
  })

export type L2WorkSessionTreeNodeKind = z.infer<typeof L2WorkSessionTreeNodeKindSchema>
export type L2WorkSessionTreeNode = z.infer<typeof L2WorkSessionTreeNodeSchema>
export type L2WorkSessionTreeGetRequest = z.infer<typeof L2WorkSessionTreeGetRequestSchema>
export type L2WorkSessionTreeGetResponse = z.infer<typeof L2WorkSessionTreeGetResponseSchema>
export type L2WorkSessionTreeEntryGetRequest = z.infer<
  typeof L2WorkSessionTreeEntryGetRequestSchema
>
export type L2WorkSessionTreeEntryGetResponse = z.infer<
  typeof L2WorkSessionTreeEntryGetResponseSchema
>
export type L2WorkSessionBranchAction = z.infer<typeof L2WorkSessionBranchActionSchema>
export type L2WorkSessionBranchRequest = z.infer<typeof L2WorkSessionBranchRequestSchema>
export type L2WorkSessionBranchResponse = z.infer<typeof L2WorkSessionBranchResponseSchema>
