import { z } from 'zod'

const L4EnvironmentPointerSchema = z.string().regex(/^(?:\/(?:[^~/]|~[01])*)*$/)
export const L4EnvironmentFileDeclarationSchema = z
  .object({
    base: z.enum(['config', 'data', 'project']),
    // 相对base的路径；binary可指目录，宿主只展开其普通文件。
    path: z.string().min(1),
    format: z.enum(['json', 'yaml', 'binary']),
    localPaths: z.array(L4EnvironmentPointerSchema).optional(),
    omitPaths: z.array(L4EnvironmentPointerSchema).optional(),
    secretPaths: z.array(L4EnvironmentPointerSchema).optional()
  })
  .strict()
export const L4EnvironmentPackageDeclarationSchema = z
  .object({ files: z.array(L4EnvironmentFileDeclarationSchema) })
  .strict()
export type L4EnvironmentFileDeclaration = z.infer<typeof L4EnvironmentFileDeclarationSchema>
