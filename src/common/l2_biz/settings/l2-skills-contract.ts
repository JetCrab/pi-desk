import { z } from 'zod'
import { L3PiCwdSchema } from '@common/l3_modules/pi/l3-pi-contract'
import { L4LocalizedTextSchema } from '@common/l4_foundation/locale/l4-localized-text'
import {
  L4_PROJECT_FILE_LIST_MAX_ENTRIES,
  L4_PROJECT_FILE_PATH_MAX_LENGTH,
  L4_PROJECT_TEXT_FILE_MAX_BYTES,
  L4ProjectDirectoryPathSchema,
  L4ProjectFileImageMimeTypeSchema,
  L4ProjectFilePathSchema
} from '@common/l4_foundation/file/l4-project-file-contract'

const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(L4_PROJECT_FILE_PATH_MAX_LENGTH)
  .refine(
    (value) =>
      !value.includes('\0') &&
      (value.startsWith('/') || value.startsWith('\\\\') || /^[a-zA-Z]:[\\/]/.test(value)),
    '必须是绝对路径'
  )

export const L2SkillsListRequestSchema = z.object({ cwd: L3PiCwdSchema.nullable() }).strict()
export const L2SkillItemSchema = z
  .object({
    skillPath: AbsolutePathSchema,
    name: z.string().min(1),
    description: z.string(),
    packageSource: z.string().nullable()
  })
  .strict()
export const L2SkillsListResponseSchema = z
  .object({
    skills: z.array(L2SkillItemSchema),
    diagnostics: z.array(z.object({ path: z.string(), message: L4LocalizedTextSchema }).strict())
  })
  .strict()

const SkillTargetSchema = L2SkillsListRequestSchema.extend({ skillPath: AbsolutePathSchema })
export const L2SkillFilesListRequestSchema = SkillTargetSchema.extend({
  path: L4ProjectDirectoryPathSchema
}).strict()
export const L2SkillFilesListResponseSchema = z
  .object({
    entries: z
      .array(z.object({ name: z.string().min(1), type: z.enum(['directory', 'file']) }).strict())
      .max(L4_PROJECT_FILE_LIST_MAX_ENTRIES),
    truncated: z.boolean()
  })
  .strict()
export const L2SkillFileGetRequestSchema = SkillTargetSchema.extend({
  path: L4ProjectFilePathSchema
}).strict()
export const L2SkillFileGetResponseSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('text'),
      content: z.string(),
      size: z.number().int().nonnegative().max(L4_PROJECT_TEXT_FILE_MAX_BYTES),
      readOnlyReason: L4LocalizedTextSchema.nullable()
    })
    .strict(),
  z
    .object({
      kind: z.literal('image'),
      mimeType: L4ProjectFileImageMimeTypeSchema,
      data: z.string(),
      size: z.number().int().nonnegative()
    })
    .strict(),
  z
    .object({
      kind: z.literal('unsupported'),
      size: z.number().int().nonnegative(),
      reason: z.string()
    })
    .strict()
])
export const L2SkillFileReplaceRequestSchema = L2SkillFileGetRequestSchema.extend({
  content: z.string().max(L4_PROJECT_TEXT_FILE_MAX_BYTES)
}).strict()
export const L2SkillFileReplaceResponseSchema = z.object({}).strict()

export const L2SkillsContracts = {
  list: {
    path: '/api/skills/list',
    request: L2SkillsListRequestSchema,
    response: L2SkillsListResponseSchema
  },
  listFiles: {
    path: '/api/skill-files/list',
    request: L2SkillFilesListRequestSchema,
    response: L2SkillFilesListResponseSchema
  },
  getFile: {
    path: '/api/skill-files/get',
    request: L2SkillFileGetRequestSchema,
    response: L2SkillFileGetResponseSchema
  },
  replaceFile: {
    path: '/api/skill-files/replace',
    request: L2SkillFileReplaceRequestSchema,
    response: L2SkillFileReplaceResponseSchema
  }
} as const

export type L2SkillItem = z.infer<typeof L2SkillItemSchema>
export type L2SkillsListRequest = z.infer<typeof L2SkillsListRequestSchema>
export type L2SkillsListResponse = z.infer<typeof L2SkillsListResponseSchema>
export type L2SkillFilesListRequest = z.infer<typeof L2SkillFilesListRequestSchema>
export type L2SkillFilesListResponse = z.infer<typeof L2SkillFilesListResponseSchema>
export type L2SkillFileGetRequest = z.infer<typeof L2SkillFileGetRequestSchema>
export type L2SkillFileGetResponse = z.infer<typeof L2SkillFileGetResponseSchema>
export type L2SkillFileReplaceRequest = z.infer<typeof L2SkillFileReplaceRequestSchema>
