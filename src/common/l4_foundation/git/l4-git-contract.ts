import { z } from 'zod'
import { L4LocalizedTextSchema } from '@common/l4_foundation/locale/l4-localized-text'
import {
  L4ProjectDirectoryPathSchema,
  L4ProjectFilePathSchema
} from '@common/l4_foundation/file/l4-project-file-contract'

export const L4_GIT_MAX_REPOSITORIES = 100
export const L4_GIT_MAX_CHANGES = 50_000
export const L4_GIT_MAX_BRANCHES = 10_000
export const L4_GIT_MAX_RECENT_BRANCHES = 5

export const L4GitRepositoryRootSchema = L4ProjectDirectoryPathSchema
export const L4GitRefNameSchema = z.string().trim().min(1).max(1024)

export const L4GitHeadSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('branch'),
      name: L4GitRefNameSchema
    })
    .strict(),
  z
    .object({
      type: z.literal('detached'),
      commit: z.string().regex(/^[0-9a-f]{40,64}$/)
    })
    .strict()
])

export const L4GitFileStatusSchema = z.enum([
  'added',
  'modified',
  'deleted',
  'renamed',
  'unmerged',
  'untracked'
])

export const L4GitFileChangeSchema = z
  .object({
    path: L4ProjectFilePathSchema,
    oldPath: L4ProjectFilePathSchema.nullable(),
    indexStatus: L4GitFileStatusSchema.nullable(),
    worktreeStatus: L4GitFileStatusSchema.nullable()
  })
  .strict()

export const L4GitRepositoryReadySchema = z
  .object({
    root: L4GitRepositoryRootSchema,
    state: z.literal('ready'),
    head: L4GitHeadSchema,
    changes: z.array(L4GitFileChangeSchema).max(L4_GIT_MAX_CHANGES)
  })
  .strict()

export const L4GitRepositoryUnavailableSchema = z
  .object({
    root: L4GitRepositoryRootSchema,
    state: z.literal('unavailable'),
    message: L4LocalizedTextSchema.refine((text) => {
      const versions =
        typeof text === 'string' ? [text] : [text.default, ...Object.values(text.translations)]
      return versions.every((version) => version.length > 0 && version.length <= 2000)
    })
  })
  .strict()

export const L4GitRepositoryHeadSchema = z.discriminatedUnion('state', [
  L4GitRepositoryReadySchema.omit({ changes: true }),
  L4GitRepositoryUnavailableSchema
])

export const L4GitRepositorySchema = z.discriminatedUnion('state', [
  L4GitRepositoryReadySchema,
  L4GitRepositoryUnavailableSchema
])

export const L4GitBranchTargetSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('local'),
      name: L4GitRefNameSchema
    })
    .strict(),
  z
    .object({
      type: z.literal('remote'),
      name: L4GitRefNameSchema
    })
    .strict()
])

export const L4GitBranchesSchema = z
  .object({
    head: L4GitHeadSchema,
    recent: z.array(L4GitRefNameSchema).max(L4_GIT_MAX_RECENT_BRANCHES),
    local: z.array(L4GitRefNameSchema).max(L4_GIT_MAX_BRANCHES),
    remote: z.array(L4GitRefNameSchema).max(L4_GIT_MAX_BRANCHES)
  })
  .strict()

const L4GitDiffSideSchema = z
  .object({
    path: L4ProjectFilePathSchema,
    content: z.string()
  })
  .strict()

export const L4GitDiffSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('text'),
      original: L4GitDiffSideSchema,
      modified: L4GitDiffSideSchema
    })
    .strict(),
  z.object({ kind: z.literal('binary') }).strict(),
  z.object({ kind: z.literal('too_large') }).strict()
])

export type L4GitHead = z.infer<typeof L4GitHeadSchema>
export type L4GitFileStatus = z.infer<typeof L4GitFileStatusSchema>
export type L4GitFileChange = z.infer<typeof L4GitFileChangeSchema>
export type L4GitRepositoryHead = z.infer<typeof L4GitRepositoryHeadSchema>
export type L4GitRepositoryReady = z.infer<typeof L4GitRepositoryReadySchema>
export type L4GitRepository = z.infer<typeof L4GitRepositorySchema>
export type L4GitBranchTarget = z.infer<typeof L4GitBranchTargetSchema>
export type L4GitBranches = z.infer<typeof L4GitBranchesSchema>
export type L4GitDiff = z.infer<typeof L4GitDiffSchema>
