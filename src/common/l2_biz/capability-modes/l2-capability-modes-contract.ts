import { z } from 'zod'
import {
  L3CapabilityCatalogSchema,
  L3CapabilityModeKeySchema,
  L3CapabilityModesSchema
} from '@common/l3_modules/capability-modes/l3-capability-modes-contract'

export const L2CapabilityModesGetRequestSchema = z.object({}).strict()
export const L2CapabilityModesGetResponseSchema = z
  .object({ modes: L3CapabilityModesSchema, catalog: L3CapabilityCatalogSchema })
  .strict()
export const L2CapabilityModesReplaceRequestSchema = z
  .object({
    modes: L3CapabilityModesSchema,
    promptContents: z.record(L3CapabilityModeKeySchema, z.string()).optional()
  })
  .strict()
  .superRefine((input, context) => {
    for (const key of Object.keys(input.promptContents ?? {})) {
      if (!Object.hasOwn(input.modes, key)) {
        context.addIssue({
          code: 'custom',
          path: ['promptContents', key],
          message: '提示词正文必须属于本次保存的模式'
        })
      }
    }
  })
export const L2CapabilityModesReplaceResponseSchema = z.object({}).strict()

export const L2SystemPromptGetRequestSchema = z
  .object({ modeKey: L3CapabilityModeKeySchema.optional() })
  .strict()
export const L2SystemPromptGetResponseSchema = z.object({ content: z.string() }).strict()
export const L2SystemPromptReplaceRequestSchema = z.object({ content: z.string() }).strict()
export const L2SystemPromptReplaceResponseSchema = z.object({}).strict()

const defaultModeSchema = L3CapabilityModeKeySchema.nullable().optional()
const cwdSchema = z.string().min(1).nullable()
export const L2CapabilityModeDefaultsGetRequestSchema = z.object({ cwd: cwdSchema }).strict()
export const L2CapabilityModeDefaultsGetResponseSchema = z
  .object({ defaultMode: defaultModeSchema })
  .strict()
export const L2CapabilityModeDefaultsReplaceRequestSchema = z
  .object({ cwd: cwdSchema, defaultMode: defaultModeSchema })
  .strict()
  .refine((input) => input.cwd !== null || input.defaultMode !== undefined, {
    path: ['defaultMode'],
    message: '保存全局默认模式必须显式指定 defaultMode'
  })
export const L2CapabilityModeDefaultsReplaceResponseSchema = z.object({}).strict()

export type L2SystemPromptGetRequest = z.infer<typeof L2SystemPromptGetRequestSchema>
export type L2SystemPromptGetResponse = z.infer<typeof L2SystemPromptGetResponseSchema>
export type L2SystemPromptReplaceRequest = z.infer<typeof L2SystemPromptReplaceRequestSchema>
export type L2SystemPromptReplaceResponse = z.infer<typeof L2SystemPromptReplaceResponseSchema>
export type L2CapabilityModeDefaultsGetRequest = z.infer<
  typeof L2CapabilityModeDefaultsGetRequestSchema
>
export type L2CapabilityModeDefaultsGetResponse = z.infer<
  typeof L2CapabilityModeDefaultsGetResponseSchema
>
export type L2CapabilityModeDefaultsReplaceRequest = z.infer<
  typeof L2CapabilityModeDefaultsReplaceRequestSchema
>
export type L2CapabilityModeDefaultsReplaceResponse = z.infer<
  typeof L2CapabilityModeDefaultsReplaceResponseSchema
>

export type L2CapabilityModesGetResponse = z.infer<typeof L2CapabilityModesGetResponseSchema>
export type L2CapabilityModesReplaceRequest = z.infer<typeof L2CapabilityModesReplaceRequestSchema>
