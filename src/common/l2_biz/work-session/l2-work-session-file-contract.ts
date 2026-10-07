import { z } from 'zod'
import {
  L4_PROJECT_CODE_PARSE_MAX_BYTES,
  L4_PROJECT_FILE_LIST_MAX_ENTRIES,
  L4_PROJECT_FILE_PATH_MAX_LENGTH,
  L4_PROJECT_FILE_SEARCH_MAX_RESULTS,
  L4_PROJECT_IMAGE_FILE_MAX_BYTES,
  L4_PROJECT_IMAGE_MAX_PIXELS,
  L4_PROJECT_TEXT_FILE_MAX_BYTES,
  L4ProjectFileEntrySchema,
  L4ProjectFileListSchema,
  L4ProjectFileSearchSchema,
  L4ProjectFileContentSchema,
  L4ProjectDirectoryPathSchema,
  L4ProjectFileImageMimeTypeSchema,
  L4ProjectFileImagePreviewModeSchema,
  L4ProjectFilePathSchema,
  L4ProjectFilePreviewPathSchema
} from '@common/l4_foundation/file/l4-project-file-contract'
import { L2CwdSchema, L2WorkIdSchema } from './l2-work-session-contract'
import { L3ProjectFileReveal } from '@common/l3_modules/project-files/l3-project-files-contract'

export const L2_WORK_SESSION_FILE_PATH_MAX_LENGTH = L4_PROJECT_FILE_PATH_MAX_LENGTH
export const L2_WORK_SESSION_FILE_LIST_MAX_ENTRIES = L4_PROJECT_FILE_LIST_MAX_ENTRIES
export const L2_WORK_SESSION_FILE_SEARCH_MAX_RESULTS = L4_PROJECT_FILE_SEARCH_MAX_RESULTS
export const L2_WORK_SESSION_TEXT_FILE_MAX_BYTES = L4_PROJECT_TEXT_FILE_MAX_BYTES
export const L2_WORK_SESSION_CODE_PARSE_MAX_BYTES = L4_PROJECT_CODE_PARSE_MAX_BYTES
export const L2_WORK_SESSION_IMAGE_FILE_MAX_BYTES = L4_PROJECT_IMAGE_FILE_MAX_BYTES
export const L2_WORK_SESSION_IMAGE_MAX_PIXELS = L4_PROJECT_IMAGE_MAX_PIXELS

export const L2WorkSessionDirectoryPathSchema = L4ProjectDirectoryPathSchema
export const L2WorkSessionFilePathSchema = L4ProjectFilePathSchema
export const L2WorkSessionFilePreviewPathSchema = L4ProjectFilePreviewPathSchema

export const L2WorkSessionFileProjectRefSchema = z
  .object({
    workId: L2WorkIdSchema,
    cwd: L2CwdSchema
  })
  .strict()

export const L2WorkSessionFileEntrySchema = L4ProjectFileEntrySchema

export const L2WorkSessionFileListRequestSchema = L2WorkSessionFileProjectRefSchema.extend({
  path: L2WorkSessionDirectoryPathSchema
}).strict()

export const L2WorkSessionFileListResponseSchema = L4ProjectFileListSchema

export const L2WorkSessionFileSearchRequestSchema = L2WorkSessionFileProjectRefSchema.extend({
  query: z.string().trim().min(1).max(200)
}).strict()

export const L2WorkSessionFileSearchResponseSchema = L4ProjectFileSearchSchema

export const L2WorkSessionFileRevealRequestSchema = L3ProjectFileReveal.request.safeExtend({
  workId: L2WorkIdSchema
})

export const L2WorkSessionFileRevealResponseSchema = L3ProjectFileReveal.response

export const L2WorkSessionFileImagePreviewModeSchema = L4ProjectFileImagePreviewModeSchema
export const L2WorkSessionFileImageMimeTypeSchema = L4ProjectFileImageMimeTypeSchema

export const L2WorkSessionFileGetRequestSchema = L2WorkSessionFileProjectRefSchema.extend({
  path: L2WorkSessionFilePreviewPathSchema,
  imagePreviewMode: L2WorkSessionFileImagePreviewModeSchema
}).strict()

export const L2WorkSessionFileGetResponseSchema = L4ProjectFileContentSchema

export type L2WorkSessionFileEntry = z.infer<typeof L2WorkSessionFileEntrySchema>
export type L2WorkSessionFileListRequest = z.infer<typeof L2WorkSessionFileListRequestSchema>
export type L2WorkSessionFileListResponse = z.infer<typeof L2WorkSessionFileListResponseSchema>
export type L2WorkSessionFileSearchRequest = z.infer<typeof L2WorkSessionFileSearchRequestSchema>
export type L2WorkSessionFileSearchResponse = z.infer<typeof L2WorkSessionFileSearchResponseSchema>
export type L2WorkSessionFileRevealRequest = z.infer<typeof L2WorkSessionFileRevealRequestSchema>
export type L2WorkSessionFileRevealResponse = z.infer<typeof L2WorkSessionFileRevealResponseSchema>
export type L2WorkSessionFileImagePreviewMode = z.infer<
  typeof L2WorkSessionFileImagePreviewModeSchema
>
export type L2WorkSessionFileImageMimeType = z.infer<typeof L2WorkSessionFileImageMimeTypeSchema>
export type L2WorkSessionFileGetRequest = z.infer<typeof L2WorkSessionFileGetRequestSchema>
export type L2WorkSessionFileGetResponse = z.infer<typeof L2WorkSessionFileGetResponseSchema>
