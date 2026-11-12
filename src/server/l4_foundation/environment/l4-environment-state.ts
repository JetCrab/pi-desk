import { z } from 'zod'

export const L4EnvironmentSelectionSchema = z
  .object({
    id: z.string().uuid(),
    selectedIds: z.array(z.string().min(1)).min(1),
    mappings: z.array(z.object({ from: z.string().min(1), to: z.string().min(1) }).strict()),
    overwrite: z.boolean()
  })
  .strict()
export const L4EnvironmentOperationSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(['export', 'import']),
    status: z.enum(['pending', 'running', 'ready', 'completed', 'failed']),
    phase: z.string(),
    error: z.string().nullable(),
    warnings: z.array(z.string()),
    expiresAt: z.number().int()
  })
  .strict()
export type L4EnvironmentSelection = z.infer<typeof L4EnvironmentSelectionSchema>
export type L4EnvironmentOperation = z.infer<typeof L4EnvironmentOperationSchema>
export interface L4EnvironmentExportOptions {
  password: string
  includeSessions: boolean
  includePluginData: boolean
}
export interface L4EnvironmentPreviewSummary {
  id: string
  sourcePlatform: 'win32' | 'darwin' | 'linux'
  items: {
    id: string
    title: string
    category: 'config' | 'plugin-data' | 'session'
    files: number
    bytes: number
    sourceCwd: string | null
    sessionId: string | null
    mappingSources: string[]
    conflicts: string[]
    warnings: string[]
  }[]
  warnings: string[]
}
