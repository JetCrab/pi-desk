import { z } from 'zod'

export const L4_PROJECT_FILE_PATH_MAX_LENGTH = 4096
export const L4_PROJECT_FILE_LIST_MAX_ENTRIES = 5000
export const L4_PROJECT_FILE_SEARCH_MAX_RESULTS = 100
export const L4_PROJECT_CONTENT_SEARCH_MAX_RESULTS = 200
export const L4_PROJECT_SEARCH_TEXT_MAX_LENGTH = 1000
export const L4_PROJECT_TEXT_FILE_MAX_BYTES = 5 * 1024 * 1024
export const L4_PROJECT_CODE_PARSE_MAX_BYTES = 1024 * 1024
export const L4_PROJECT_IMAGE_FILE_MAX_BYTES = 10 * 1024 * 1024
export const L4_PROJECT_IMAGE_MAX_PIXELS = 50_000_000

function isCanonicalProjectRelativePath(value: string, allowRoot: boolean): boolean {
  if (value === '') return allowRoot
  if (
    value.length > L4_PROJECT_FILE_PATH_MAX_LENGTH ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    /^[a-zA-Z]:/.test(value)
  ) {
    return false
  }

  return value
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

export const L4ProjectDirectoryPathSchema = z
  .string()
  .max(L4_PROJECT_FILE_PATH_MAX_LENGTH)
  .refine((value) => isCanonicalProjectRelativePath(value, true), '目录路径必须是规范相对路径')

export const L4ProjectFilePathSchema = z
  .string()
  .min(1)
  .max(L4_PROJECT_FILE_PATH_MAX_LENGTH)
  .refine((value) => isCanonicalProjectRelativePath(value, false), '文件路径必须是规范相对路径')

function isAbsoluteFilePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= L4_PROJECT_FILE_PATH_MAX_LENGTH &&
    !value.includes('\0') &&
    (value.startsWith('/') || value.startsWith('\\\\') || /^[a-zA-Z]:[\\/]/.test(value))
  )
}

export const L4ProjectFilePreviewPathSchema = z
  .string()
  .min(1)
  .max(L4_PROJECT_FILE_PATH_MAX_LENGTH)
  .refine(
    (value) => isCanonicalProjectRelativePath(value, false) || isAbsoluteFilePath(value),
    '预览路径必须是规范相对路径或绝对路径'
  )

export const L4ProjectFileImagePreviewModeSchema = z.enum(['compressed', 'original'])
export const L4ProjectFileImageMimeTypeSchema = z.enum([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif'
])

export const L4ProjectFileEntrySchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(['directory', 'file'])
  })
  .strict()

export const L4ProjectFileListSchema = z
  .object({
    entries: z.array(L4ProjectFileEntrySchema).max(L4_PROJECT_FILE_LIST_MAX_ENTRIES),
    truncated: z.boolean()
  })
  .strict()

export const L4ProjectSearchInputSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .max(200)
      .refine(
        (value) => value.trim().length > 0 && !/[\0\r\n]/.test(value),
        '搜索词必须是非空单行文本'
      ),
    scope: z.enum(['all', 'files', 'content']).default('all'),
    caseSensitive: z.boolean().default(false),
    wholeWord: z.boolean().default(false),
    regex: z.boolean().default(false)
  })
  .strict()

export const L4ProjectSearchRangeSchema = z
  .object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() })
  .strict()
  .refine((range) => range.start <= range.end, '搜索命中区间无效')

export const L4ProjectFileMatchSchema = z
  .object({ path: L4ProjectFilePathSchema, ranges: z.array(L4ProjectSearchRangeSchema) })
  .strict()
  .refine(
    (match) => match.ranges.every((range) => range.end <= match.path.length),
    '文件名命中区间越界'
  )

export const L4ProjectContentMatchSchema = z
  .object({
    path: L4ProjectFilePathSchema,
    line: z.number().int().positive(),
    text: z.string().max(L4_PROJECT_SEARCH_TEXT_MAX_LENGTH),
    ranges: z.array(L4ProjectSearchRangeSchema)
  })
  .strict()
  .refine(
    (match) => match.ranges.every((range) => range.end <= match.text.length),
    '正文命中区间越界'
  )

export const L4ProjectFileSearchSchema = z
  .object({
    fileMatches: z.array(L4ProjectFileMatchSchema).max(L4_PROJECT_FILE_SEARCH_MAX_RESULTS),
    contentMatches: z.array(L4ProjectContentMatchSchema).max(L4_PROJECT_CONTENT_SEARCH_MAX_RESULTS),
    truncated: z.boolean()
  })
  .strict()

export const L4ProjectFileContentSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('text'),
      content: z.string(),
      size: z.number().int().nonnegative().max(L4_PROJECT_TEXT_FILE_MAX_BYTES)
    })
    .strict(),
  z
    .object({
      kind: z.literal('image'),
      mimeType: L4ProjectFileImageMimeTypeSchema,
      data: z.string().min(1),
      size: z.number().int().positive().max(L4_PROJECT_IMAGE_FILE_MAX_BYTES)
    })
    .strict()
])

export type L4ProjectFileEntry = z.infer<typeof L4ProjectFileEntrySchema>
export type L4ProjectFileList = z.infer<typeof L4ProjectFileListSchema>
export type L4ProjectSearchInput = z.infer<typeof L4ProjectSearchInputSchema>
export type L4ProjectSearchRange = z.infer<typeof L4ProjectSearchRangeSchema>
export type L4ProjectFileMatch = z.infer<typeof L4ProjectFileMatchSchema>
export type L4ProjectContentMatch = z.infer<typeof L4ProjectContentMatchSchema>
export type L4ProjectFileSearch = z.infer<typeof L4ProjectFileSearchSchema>
export type L4ProjectFileContent = z.infer<typeof L4ProjectFileContentSchema>
export type L4ProjectFileImagePreviewMode = z.infer<typeof L4ProjectFileImagePreviewModeSchema>
export type L4ProjectFileImageMimeType = z.infer<typeof L4ProjectFileImageMimeTypeSchema>
