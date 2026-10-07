import { z } from 'zod'
import {
  L4_GIT_MAX_BRANCHES,
  L4_GIT_MAX_CHANGES,
  L4_GIT_MAX_RECENT_BRANCHES,
  L4_GIT_MAX_REPOSITORIES,
  L4GitBranchesSchema,
  L4GitBranchTargetSchema,
  L4GitDiffSchema,
  L4GitFileChangeSchema,
  L4GitFileStatusSchema,
  L4GitHeadSchema,
  L4GitRefNameSchema,
  L4GitRepositoryReadySchema,
  L4GitRepositoryRootSchema,
  L4GitRepositorySchema,
  L4GitRepositoryUnavailableSchema
} from '@common/l4_foundation/git/l4-git-contract'
import { L4ProjectFilePathSchema } from '@common/l4_foundation/file/l4-project-file-contract'
import { L2CwdSchema, L2WorkIdSchema } from './l2-work-session-contract'

export const L2_WORK_SESSION_GIT_MAX_REPOSITORIES = L4_GIT_MAX_REPOSITORIES
export const L2_WORK_SESSION_GIT_MAX_CHANGES = L4_GIT_MAX_CHANGES
export const L2_WORK_SESSION_GIT_MAX_BRANCHES = L4_GIT_MAX_BRANCHES
export const L2_WORK_SESSION_GIT_MAX_RECENT_BRANCHES = L4_GIT_MAX_RECENT_BRANCHES

export const L2WorkSessionGitProjectRefSchema = z
  .object({
    workId: L2WorkIdSchema,
    cwd: L2CwdSchema
  })
  .strict()

export const L2WorkSessionGitRepositoryRootSchema = L4GitRepositoryRootSchema
export const L2WorkSessionGitRefNameSchema = L4GitRefNameSchema
export const L2WorkSessionGitHeadSchema = L4GitHeadSchema
export const L2WorkSessionGitFileStatusSchema = L4GitFileStatusSchema
export const L2WorkSessionGitFileChangeSchema = L4GitFileChangeSchema
export const L2WorkSessionGitRepositoryReadySchema = L4GitRepositoryReadySchema
export const L2WorkSessionGitRepositoryUnavailableSchema = L4GitRepositoryUnavailableSchema
export const L2WorkSessionGitRepositorySchema = L4GitRepositorySchema

export const L2WorkSessionGitGetRequestSchema = L2WorkSessionGitProjectRefSchema

export const L2WorkSessionGitGetResponseSchema = z
  .object({
    repositories: z
      .array(L2WorkSessionGitRepositorySchema)
      .max(L2_WORK_SESSION_GIT_MAX_REPOSITORIES)
  })
  .strict()

export const L2WorkSessionGitBranchesListRequestSchema = L2WorkSessionGitProjectRefSchema.extend({
  repositoryRoot: L2WorkSessionGitRepositoryRootSchema
}).strict()

export const L2WorkSessionGitBranchesListResponseSchema = L4GitBranchesSchema
export const L2WorkSessionGitBranchTargetSchema = L4GitBranchTargetSchema

export const L2WorkSessionGitBranchReplaceRequestSchema = L2WorkSessionGitProjectRefSchema.extend({
  repositoryRoot: L2WorkSessionGitRepositoryRootSchema,
  target: L2WorkSessionGitBranchTargetSchema
}).strict()

export const L2WorkSessionGitBranchStartPointSchema = L2WorkSessionGitBranchTargetSchema

export const L2WorkSessionGitBranchAddRequestSchema = L2WorkSessionGitProjectRefSchema.extend({
  repositoryRoot: L2WorkSessionGitRepositoryRootSchema,
  name: L2WorkSessionGitRefNameSchema,
  startPoint: L2WorkSessionGitBranchStartPointSchema.nullable()
}).strict()

export const L2WorkSessionGitBranchOperationResponseSchema = z
  .object({
    repository: L2WorkSessionGitRepositoryReadySchema
  })
  .strict()

export const L2WorkSessionGitDiffGetRequestSchema = L2WorkSessionGitProjectRefSchema.extend({
  repositoryRoot: L2WorkSessionGitRepositoryRootSchema,
  path: L4ProjectFilePathSchema
}).strict()

export const L2WorkSessionGitDiffGetResponseSchema = L4GitDiffSchema

export type L2WorkSessionGitHead = z.infer<typeof L2WorkSessionGitHeadSchema>
export type L2WorkSessionGitFileStatus = z.infer<typeof L2WorkSessionGitFileStatusSchema>
export type L2WorkSessionGitFileChange = z.infer<typeof L2WorkSessionGitFileChangeSchema>
export type L2WorkSessionGitRepositoryReady = z.infer<typeof L2WorkSessionGitRepositoryReadySchema>
export type L2WorkSessionGitRepository = z.infer<typeof L2WorkSessionGitRepositorySchema>
export type L2WorkSessionGitGetRequest = z.infer<typeof L2WorkSessionGitGetRequestSchema>
export type L2WorkSessionGitGetResponse = z.infer<typeof L2WorkSessionGitGetResponseSchema>
export type L2WorkSessionGitBranchesListRequest = z.infer<
  typeof L2WorkSessionGitBranchesListRequestSchema
>
export type L2WorkSessionGitBranchesListResponse = z.infer<
  typeof L2WorkSessionGitBranchesListResponseSchema
>
export type L2WorkSessionGitBranchTarget = z.infer<typeof L2WorkSessionGitBranchTargetSchema>
export type L2WorkSessionGitBranchReplaceRequest = z.infer<
  typeof L2WorkSessionGitBranchReplaceRequestSchema
>
export type L2WorkSessionGitBranchAddRequest = z.infer<
  typeof L2WorkSessionGitBranchAddRequestSchema
>
export type L2WorkSessionGitBranchOperationResponse = z.infer<
  typeof L2WorkSessionGitBranchOperationResponseSchema
>
export type L2WorkSessionGitDiffGetRequest = z.infer<typeof L2WorkSessionGitDiffGetRequestSchema>
export type L2WorkSessionGitDiffGetResponse = z.infer<typeof L2WorkSessionGitDiffGetResponseSchema>
