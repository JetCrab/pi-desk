import { z } from 'zod'

export const L4_PROJECT_PREVIEW_PLUGIN_KEY = 'project-preview'
export const L4_PROJECT_PREVIEW_MAX_DIRECTORIES = 32

export const L4ProjectPreviewStateSchema = z
  .object({
    directories: z.array(z.string().min(1).max(4096)).max(L4_PROJECT_PREVIEW_MAX_DIRECTORIES),
    defaultDirectory: z.string().min(1).max(4096).nullable()
  })
  .strict()

export type L4ProjectPreviewState = z.infer<typeof L4ProjectPreviewStateSchema>

export function readL4ProjectPreviewState(value: unknown): L4ProjectPreviewState {
  const result = L4ProjectPreviewStateSchema.safeParse(value)
  return result.success ? result.data : { directories: [], defaultDirectory: null }
}

export function projectPreviewDirectoryKey(directory: string): string {
  const normalized = directory.replaceAll('\\', '/').replace(/\/+$/, '') || '/'
  return /^[a-z]:/i.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized
}
