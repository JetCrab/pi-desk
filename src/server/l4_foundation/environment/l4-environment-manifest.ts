import { z } from 'zod'
import { L4EnvironmentFileDeclarationSchema } from '@common/l4_foundation/environment/l4-environment-file-contract'

export const L4EnvironmentFileSchema = z
  .object({
    id: z.string().min(1),
    entry: z.string().min(1),
    title: z.string(),
    category: z.enum(['config', 'plugin-data', 'session']),
    base: z.enum(['agent', 'project', 'resource', 'desktop']),
    path: z.string(),
    sourcePath: z.string(),
    bytes: z.number().int().nonnegative(),
    format: z.enum(['json', 'yaml', 'binary']),
    localPaths: z.array(z.string()),
    mappingSources: z.array(z.string()),
    omitPaths: z.array(z.string()),
    secretPaths: z.array(z.string()),
    sourceCwd: z.string().nullable(),
    sessionId: z.string().nullable(),
    children: z.array(z.string()),
    warnings: z.array(z.string()),
    secretEntry: z.string().nullable()
  })
  .strict()
const WorkRecordsSchema = z.array(
  z
    .object({ workId: z.string().min(1), cwd: z.string().min(1), sessionId: z.string().min(1) })
    .strict()
)
const PinnedCountSchema = z.number().int().nonnegative()
function validBindings(value: {
  workSessions: z.infer<typeof WorkRecordsSchema>
  pinnedCount: number
}): boolean {
  return (
    value.pinnedCount <= value.workSessions.length &&
    new Set(value.workSessions.map((binding) => binding.workId)).size ===
      value.workSessions.length &&
    new Set(value.workSessions.map((binding) => binding.sessionId)).size ===
      value.workSessions.length
  )
}
export const L4EnvironmentWorkStateSchema = z
  .object({ workSessions: WorkRecordsSchema, pinnedCount: PinnedCountSchema })
  .strict()
  .refine(validBindings, { message: '工作会话集合不是当前有效格式' })

export const L4EnvironmentManifestSchema = z
  .object({
    version: z.literal(1),
    sourcePlatform: z.enum(['win32', 'darwin', 'linux']),
    sourceAgentDir: z.string(),
    files: z.array(L4EnvironmentFileSchema),
    workSessions: WorkRecordsSchema,
    pinnedCount: PinnedCountSchema,
    packages: z.array(
      z
        .object({
          source: z.string(),
          name: z.string().nullable(),
          version: z.string().nullable(),
          registry: z.string().optional(),
          localPath: z.string().optional(),
          installSource: z.string().optional(),
          projectCwd: z.string().optional()
        })
        .strict()
    ),
    warnings: z.array(z.string())
  })
  .strict()
  .refine(validBindings, { message: '环境包工作会话集合不是当前有效格式' })
export type L4EnvironmentFile = z.infer<typeof L4EnvironmentFileSchema>
export type L4EnvironmentManifest = z.infer<typeof L4EnvironmentManifestSchema>
export { L4EnvironmentFileDeclarationSchema as L4EnvironmentDeclarationSchema }
