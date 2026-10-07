import { z } from 'zod'
import { L4ProjectFilePathSchema } from '@common/l4_foundation/file/l4-project-file-contract'
import { L4GitBranchesSchema, L4GitDiffSchema } from './l4-git-contract'

export const L4GitOidSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
export const L4GitRevisionSchema = z
  .union([
    L4GitOidSchema,
    z.literal('HEAD'),
    z
      .string()
      .max(1024)
      .regex(/^refs\/(?:heads|remotes)\/[^\0\r\n]+$/)
  ])
  .refine((value) => !value.includes('..') && !value.endsWith('/'), 'Git 版本无效')

export const L4GitHistorySelectionSchema = z.union([
  z.object({ commit: L4GitRevisionSchema, parent: L4GitOidSchema.optional() }).strict(),
  z
    .object({
      base: L4GitRevisionSchema,
      target: L4GitRevisionSchema,
      strategy: z.enum(['merge-base', 'direct'])
    })
    .strict()
])

export const L4GitResolvedComparisonSchema = z
  .object({
    base: L4GitOidSchema.nullable(),
    target: L4GitOidSchema,
    original: L4GitOidSchema.nullable()
  })
  .strict()

export const L4GitHistoricalDiffSchema = z
  .object({
    baseCommit: L4GitOidSchema.nullable(),
    targetCommit: L4GitOidSchema,
    oldPath: L4ProjectFilePathSchema.optional()
  })
  .strict()

export const L4GitCommitSchema = z
  .object({
    oid: L4GitOidSchema,
    parents: z.array(L4GitOidSchema),
    subject: z.string(),
    author: z.string(),
    timestampMs: z.number().int(),
    refs: z.array(z.string())
  })
  .strict()

export const L4GitLogQuerySchema = z
  .object({
    tip: L4GitRevisionSchema,
    exclude: L4GitRevisionSchema.optional(),
    query: z.string().trim().max(200).default(''),
    author: z.string().trim().max(200).optional(),
    page: z
      .object({ index: z.number().int().min(1).max(2000), size: z.number().int().min(1).max(100) })
      .strict()
  })
  .strict()
export const L4GitLogSchema = z
  .object({
    tip: L4GitOidSchema.nullable(),
    exclude: L4GitOidSchema.nullable(),
    items: z.array(L4GitCommitSchema),
    hasMore: z.boolean(),
    truncated: z.boolean()
  })
  .strict()

export const L4GitHistoryChangeSchema = z
  .object({
    path: L4ProjectFilePathSchema,
    oldPath: L4ProjectFilePathSchema.nullable(),
    status: z.enum(['added', 'modified', 'deleted', 'renamed', 'type-changed'])
  })
  .strict()
export const L4GitChangesQuerySchema = z
  .object({
    selection: L4GitHistorySelectionSchema,
    page: z
      .object({ index: z.number().int().min(1).max(50000), size: z.number().int().min(1).max(500) })
      .strict()
  })
  .strict()
export const L4GitChangesSchema = z
  .object({
    comparison: L4GitResolvedComparisonSchema,
    commit: L4GitCommitSchema.extend({
      message: z.string(),
      selectedParent: L4GitOidSchema.nullable()
    }).nullable(),
    items: z.array(L4GitHistoryChangeSchema),
    hasMore: z.boolean(),
    truncated: z.boolean()
  })
  .strict()

export const L4GitReadBranchesSchema = L4GitBranchesSchema.extend({
  upstream: z
    .object({
      ref: z.string(),
      ahead: z.number().int().nonnegative().nullable(),
      behind: z.number().int().nonnegative().nullable()
    })
    .strict()
    .nullable()
}).strict()

export const L4GitPreviewDiffSchema = z.union([
  L4GitDiffSchema,
  z.object({ kind: z.literal('metadata'), original: z.string(), modified: z.string() }).strict()
])

export type L4GitHistorySelection = z.infer<typeof L4GitHistorySelectionSchema>
export type L4GitHistoricalDiff = z.infer<typeof L4GitHistoricalDiffSchema>
export type L4GitCommit = z.infer<typeof L4GitCommitSchema>
export type L4GitLogQuery = z.infer<typeof L4GitLogQuerySchema>
export type L4GitLog = z.infer<typeof L4GitLogSchema>
export type L4GitChangesQuery = z.infer<typeof L4GitChangesQuerySchema>
export type L4GitChanges = z.infer<typeof L4GitChangesSchema>
export type L4GitReadBranches = z.infer<typeof L4GitReadBranchesSchema>
export type L4GitPreviewDiff = z.infer<typeof L4GitPreviewDiffSchema>
