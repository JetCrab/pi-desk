import { z } from 'zod'

export const L2AuthLoginRequestSchema = z
  .object({
    password: z.string().min(1).max(256)
  })
  .strict()

export type L2AuthLoginRequest = z.infer<typeof L2AuthLoginRequestSchema>

export const L2AuthLoginResponseSchema = z.object({}).strict()

export type L2AuthLoginResponse = z.infer<typeof L2AuthLoginResponseSchema>

export const L2AuthLogoutRequestSchema = z.object({}).strict()
export const L2AuthLogoutResponseSchema = z.object({}).strict()

export const L2AuthSettingsGetRequestSchema = z.object({}).strict()
export const L2AuthSettingsGetResponseSchema = z
  .object({
    enabled: z.boolean(),
    configPath: z.string()
  })
  .strict()

export const L2AuthSettingsReplaceRequestSchema = z.union([
  L2AuthLoginRequestSchema.extend({ password: z.string().min(8).max(256) }),
  z.object({ password: z.null() }).strict()
])
export const L2AuthSettingsReplaceResponseSchema = z.object({}).strict()

export type L2AuthSettings = z.infer<typeof L2AuthSettingsGetResponseSchema>
export type L2AuthSettingsReplaceRequest = z.infer<typeof L2AuthSettingsReplaceRequestSchema>
