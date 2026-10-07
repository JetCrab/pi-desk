import { z } from 'zod'

export const L2McpScopeSchema = z.object({ cwd: z.string().trim().min(1).nullable() }).strict()
export const L2McpServerConfigSchema = z.record(z.string(), z.json())
export const L2McpServersSchema = z.record(z.string().min(1).max(128), L2McpServerConfigSchema)
export const L2McpSettingsGetRequestSchema = L2McpScopeSchema
export const L2McpSettingsGetResponseSchema = z
  .object({
    local: L2McpServersSchema,
    inherited: L2McpServersSchema,
    projectTrusted: z.boolean().nullable(),
    diagnostics: z.array(z.object({ name: z.string().nullable(), message: z.string() }).strict())
  })
  .strict()
export const L2McpSettingsReplaceRequestSchema = L2McpScopeSchema.extend({
  servers: L2McpServersSchema
}).strict()
export const L2McpSettingsDelRequestSchema = L2McpScopeSchema.extend({
  name: z.string().min(1).max(128)
}).strict()
export const L2McpCheckRequestSchema = L2McpSettingsDelRequestSchema
export const L2McpCheckResponseSchema = z.object({ output: z.string() }).strict()
export const L2PiSettingsMutationResponseSchema = z.object({}).strict()

export type L2McpServerConfig = z.infer<typeof L2McpServerConfigSchema>
export type L2McpSettings = z.infer<typeof L2McpSettingsGetResponseSchema>
export type L2McpSettingsReplaceRequest = z.infer<typeof L2McpSettingsReplaceRequestSchema>
