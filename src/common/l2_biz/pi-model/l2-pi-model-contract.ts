import { z } from 'zod'
import { L2WorkIdSchema } from '@common/l2_biz/work-session/l2-work-session-contract'
import { L3PiModelThinkingLevelSchema } from '@common/l3_modules/pi-model/l3-pi-model-contract'

const L2PiModelProviderSchema = z.string().trim().min(1)
const L2PiModelIdSchema = z.string().trim().min(1)

export const L2PiModelOptionSchema = z
  .object({
    provider: L2PiModelProviderSchema,
    modelId: L2PiModelIdSchema,
    name: z.string().trim().min(1),
    input: z.array(z.enum(['text', 'image'])).min(1),
    kind: z.enum(['physical', 'virtual']),
    contextWindow: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    thinkingLevels: z.array(L3PiModelThinkingLevelSchema).min(1)
  })
  .strict()

export const L2PiModelPresetSchema = z
  .object({
    provider: L2PiModelProviderSchema,
    modelId: L2PiModelIdSchema,
    thinkingLevel: L3PiModelThinkingLevelSchema,
    color: z.string().trim().min(1).nullable()
  })
  .strict()

export const L2PiModelsListRequestSchema = z
  .object({
    workId: L2WorkIdSchema
  })
  .strict()

export const L2PiModelsListResponseSchema = z
  .object({
    models: z.array(L2PiModelOptionSchema),
    presets: z.array(L2PiModelPresetSchema)
  })
  .strict()

export type L2PiModelOption = z.infer<typeof L2PiModelOptionSchema>
export type L2PiModelPreset = z.infer<typeof L2PiModelPresetSchema>
export type L2PiModelsListRequest = z.infer<typeof L2PiModelsListRequestSchema>
export type L2PiModelsListResponse = z.infer<typeof L2PiModelsListResponseSchema>
