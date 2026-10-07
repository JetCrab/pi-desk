import { z } from 'zod'
import {
  L4ProjectDirectoryPathSchema,
  L4ProjectFilePathSchema,
  L4ProjectFilePreviewPathSchema,
  L4ProjectFileImagePreviewModeSchema,
  L4ProjectFileListSchema,
  L4ProjectFileSearchSchema,
  L4ProjectFileContentSchema
} from '@common/l4_foundation/file/l4-project-file-contract'
import {
  L4_GIT_MAX_REPOSITORIES,
  L4GitRepositoryHeadSchema,
  L4GitRepositorySchema
} from '@common/l4_foundation/git/l4-git-contract'
import {
  L4GitLogQuerySchema,
  L4GitLogSchema,
  L4GitChangesQuerySchema,
  L4GitChangesSchema,
  L4GitReadBranchesSchema,
  L4GitHistoricalDiffSchema,
  L4GitPreviewDiffSchema
} from '@common/l4_foundation/git/l4-git-history-contract'

export const L3ProjectReadContextSchema = z
  .object({
    cwd: z.string().trim().min(1).max(4096),
    workId: z.string().trim().min(1).optional()
  })
  .strict()
export type L3ProjectReadContext = z.infer<typeof L3ProjectReadContextSchema>
const repository = L3ProjectReadContextSchema.extend({
  repositoryRoot: L4ProjectDirectoryPathSchema
})
const fileGet = L3ProjectReadContextSchema.extend({
  path: L4ProjectFilePreviewPathSchema,
  imagePreviewMode: L4ProjectFileImagePreviewModeSchema
}).superRefine((input, context) => {
  if (!input.workId && !L4ProjectFilePathSchema.safeParse(input.path).success) {
    context.addIssue({ code: 'custom', path: ['path'], message: '独立项目预览只接受根内相对路径' })
  }
})

export const L3ProjectRevealTargetTypeSchema = z.enum(['file', 'directory'])
export type L3ProjectRevealTargetType = z.infer<typeof L3ProjectRevealTargetTypeSchema>
export const L3ProjectFileReveal = {
  path: '/api/project-files/reveal',
  request: L3ProjectReadContextSchema.extend({
    path: L4ProjectDirectoryPathSchema,
    targetType: L3ProjectRevealTargetTypeSchema.optional()
  }).refine((input) => input.path !== '' || input.targetType === 'directory', '文件路径不能为空'),
  response: z.object({}).strict()
} as const

export const L3ProjectFileList = {
  path: '/api/project-files/list',
  request: L3ProjectReadContextSchema.extend({ path: L4ProjectDirectoryPathSchema }).strict(),
  response: L4ProjectFileListSchema
} as const
export const L3ProjectFileSearch = {
  path: '/api/project-files/search',
  request: L3ProjectReadContextSchema.extend({
    query: z.string().trim().min(1).max(200)
  }).strict(),
  response: L4ProjectFileSearchSchema
} as const
export const L3ProjectFileGet = {
  path: '/api/project-files/get',
  request: fileGet,
  response: L4ProjectFileContentSchema
} as const
export const L3ProjectGitGet = {
  path: '/api/project-git/get',
  request: L3ProjectReadContextSchema.extend({ refresh: z.boolean().optional() }).strict(),
  response: z.object({ repositories: z.array(L4GitRepositorySchema).max(100) }).strict()
} as const
export const L3ProjectGitHeads = {
  path: '/api/project-git-heads/get',
  request: L3ProjectReadContextSchema,
  response: z
    .object({ repositories: z.array(L4GitRepositoryHeadSchema).max(L4_GIT_MAX_REPOSITORIES) })
    .strict()
} as const
export const L3ProjectGitBranches = {
  path: '/api/project-git-branches/list',
  request: repository.strict(),
  response: L4GitReadBranchesSchema
} as const
export const L3ProjectGitLog = {
  path: '/api/project-git-log/list',
  request: repository.extend(L4GitLogQuerySchema.shape).strict(),
  response: L4GitLogSchema
} as const
export const L3ProjectGitChanges = {
  path: '/api/project-git-changes/list',
  request: repository.extend(L4GitChangesQuerySchema.shape).strict(),
  response: L4GitChangesSchema
} as const
export const L3ProjectGitDiff = {
  path: '/api/project-git-diff/get',
  request: repository
    .extend({ path: L4ProjectFilePathSchema, comparison: L4GitHistoricalDiffSchema.optional() })
    .strict(),
  response: L4GitPreviewDiffSchema
} as const
