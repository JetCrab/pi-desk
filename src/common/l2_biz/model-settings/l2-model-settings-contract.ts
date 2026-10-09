import { z } from 'zod'
import { L3PiCwdSchema } from '@common/l3_modules/pi/l3-pi-contract'
import { L3PiModelThinkingLevelSchema } from '@common/l3_modules/pi-model/l3-pi-model-contract'
import { L4TimestampMsSchema } from '@common/l4_foundation/l4-timestamp-contract'

const L2ModelProviderIdSchema = z.string().trim().min(1).max(128)
const L2ModelIdSchema = z.string().trim().min(1).max(256)
const L2ModelNameSchema = z.string().trim().min(1).max(256)
const L2NullableTextSchema = z.string().trim().min(1).nullable()
const L2HeadersSchema = z.record(z.string().trim().min(1), z.string())

export const L2ModelKnownApis = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
  'mistral-conversations',
  'azure-openai-responses',
  'openai-codex-responses',
  'bedrock-converse-stream',
  'google-vertex',
  'pi-messages'
] as const

export const L2ModelApiSchema = z.string().trim().min(1).max(128)
export const L2ModelNativeConfigSchema = z.record(z.string(), z.json())

export const L2ModelThinkingLevelConfigSchema = z
  .object({
    level: L3PiModelThinkingLevelSchema,
    providerValue: z.string().trim().min(1).nullable()
  })
  .strict()

export const L2ModelCostSchema = z
  .object({
    input: z.number().nonnegative().finite(),
    output: z.number().nonnegative().finite(),
    cacheRead: z.number().nonnegative().finite(),
    cacheWrite: z.number().nonnegative().finite()
  })
  .strict()

export const L2ModelCompatConfigSchema = z
  .object({
    supportsDeveloperRole: z.boolean().nullable(),
    thinkingFormat: z.string().trim().min(1).max(128).nullable(),
    requiresReasoningContentOnAssistantMessages: z.boolean().nullable()
  })
  .strict()

export const L2ModelConfigSchema = z
  .object({
    modelId: L2ModelIdSchema,
    name: L2ModelNameSchema,
    api: L2ModelApiSchema.nullable(),
    baseUrl: L2NullableTextSchema,
    reasoning: z.boolean(),
    thinkingLevels: z.array(L2ModelThinkingLevelConfigSchema).min(1).max(7),
    input: z
      .array(z.enum(['text', 'image']))
      .min(1)
      .max(2),
    contextWindow: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    maxTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    cost: L2ModelCostSchema.nullable(),
    headers: L2HeadersSchema,
    compat: L2ModelCompatConfigSchema.nullable()
  })
  .strict()
  .superRefine((model, context) => {
    const levels = new Set<string>()
    for (const item of model.thinkingLevels) {
      if (levels.has(item.level)) {
        context.addIssue({ code: 'custom', message: `思考等级 ${item.level} 重复` })
      }
      levels.add(item.level)
      if ((item.level === 'xhigh' || item.level === 'max') && item.providerValue === null) {
        context.addIssue({ code: 'custom', message: `${item.level} 必须配置 Provider 映射` })
      }
    }

    if (!model.reasoning && (model.thinkingLevels.length !== 1 || !levels.has('off'))) {
      context.addIssue({ code: 'custom', message: '非推理模型只允许 off 思考等级' })
    }
  })

export const L2ModelProviderConfigSchema = z
  .object({
    provider: L2ModelProviderIdSchema,
    name: L2NullableTextSchema,
    baseUrl: L2NullableTextSchema,
    api: L2ModelApiSchema.nullable(),
    apiKey: z.string().nullable(),
    authHeader: z.boolean().nullable(),
    headers: L2HeadersSchema,
    models: z.array(L2ModelConfigSchema)
  })
  .strict()
  .superRefine((provider, context) => {
    const ids = new Set<string>()
    for (const model of provider.models) {
      if (ids.has(model.modelId)) {
        context.addIssue({ code: 'custom', message: `模型 ${model.modelId} 重复` })
      }
      ids.add(model.modelId)
    }
  })

export const L2ModelPresetSchema = z
  .object({
    provider: L2ModelProviderIdSchema,
    modelId: L2ModelIdSchema,
    thinkingLevel: L3PiModelThinkingLevelSchema,
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullable()
  })
  .strict()

export const L2ModelOptionSchema = z
  .object({
    provider: L2ModelProviderIdSchema,
    modelId: L2ModelIdSchema,
    name: L2ModelNameSchema,
    input: z
      .array(z.enum(['text', 'image']))
      .min(1)
      .max(2),
    contextWindow: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    thinkingLevels: z.array(L3PiModelThinkingLevelSchema).min(1).max(7)
  })
  .strict()

export const L2ModelSelectionSchema = z
  .object({
    provider: L2ModelProviderIdSchema,
    modelId: L2ModelIdSchema,
    thinkingLevel: L3PiModelThinkingLevelSchema
  })
  .strict()

export const L2AccountModelOverridesSchema = z
  .object({
    contextWindow: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    maxTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    cost: L2ModelCostSchema.partial().optional()
  })
  .strict()

export const L2AccountModelSelectionSchema = z
  .object({
    provider: L2ModelProviderIdSchema,
    modelId: L2ModelIdSchema,
    overrides: L2AccountModelOverridesSchema
  })
  .strict()

export const L2ModelAccountSchema = z
  .object({
    provider: L2ModelProviderIdSchema,
    name: L2ModelNameSchema,
    loggedIn: z.boolean(),
    subscription: z.boolean(),
    models: z.array(L2ModelConfigSchema)
  })
  .strict()

export type L2AccountModelOverrides = z.infer<typeof L2AccountModelOverridesSchema>
export type L2AccountModelSelection = z.infer<typeof L2AccountModelSelectionSchema>
export type L2ModelAccount = z.infer<typeof L2ModelAccountSchema>

export const L2ModelSettingsGetRequestSchema = z.object({}).strict()

export const L2ModelSettingsGetResponseSchema = z
  .object({
    providers: z.array(L2ModelProviderConfigSchema),
    presets: z.array(L2ModelPresetSchema),
    models: z.array(L2ModelOptionSchema),
    nativeConfig: L2ModelNativeConfigSchema,
    accountModels: z.array(L2AccountModelSelectionSchema),
    accounts: z.array(L2ModelAccountSchema)
  })
  .strict()

const L2ModelSettingsReplaceFormSchema = z
  .object({
    providers: z.array(L2ModelProviderConfigSchema).optional(),
    presets: z.array(L2ModelPresetSchema).optional(),
    accountModels: z.array(L2AccountModelSelectionSchema).optional()
  })
  .strict()
  .refine(
    (input) =>
      input.providers !== undefined ||
      input.presets !== undefined ||
      input.accountModels !== undefined,
    {
      message: '请提交需要保存的模型配置'
    }
  )

export const L2ModelSettingsReplaceRequestSchema = z.union([
  L2ModelSettingsReplaceFormSchema,
  z.object({ nativeConfig: L2ModelNativeConfigSchema }).strict()
])

export const L2ModelSettingsReplaceResponseSchema = z.object({}).strict()

export const L2ModelCatalogListRequestSchema = z
  .object({
    query: z.string().trim().max(256),
    refresh: z.boolean(),
    page: z
      .object({
        index: z.number().int().positive(),
        size: z.number().int().positive().max(100)
      })
      .strict()
  })
  .strict()

export const L2ModelCatalogDefaultsSchema = z
  .object({
    reasoning: z.boolean(),
    thinkingLevels: z.array(L2ModelThinkingLevelConfigSchema).min(1).max(7),
    input: z
      .array(z.enum(['text', 'image']))
      .min(1)
      .max(2),
    contextWindow: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    maxTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    cost: L2ModelCostSchema.nullable()
  })
  .strict()

export const L2ModelCatalogSourceSchema = z
  .object({
    provider: L2ModelProviderIdSchema,
    providerName: L2ModelNameSchema,
    modelId: L2ModelIdSchema,
    official: z.boolean(),
    defaults: L2ModelCatalogDefaultsSchema
  })
  .strict()

export const L2ModelCatalogItemSchema = z
  .object({
    referenceId: z.string().trim().min(1).max(512),
    name: L2ModelNameSchema,
    match: z.enum(['exact', 'similar']).nullable(),
    sources: z.array(L2ModelCatalogSourceSchema).min(1)
  })
  .strict()

export const L2ModelCatalogListResponseSchema = z
  .object({
    updatedAt: L4TimestampMsSchema,
    refreshResult: z.enum(['not-requested', 'updated', 'unchanged', 'partial', 'cached']),
    page: z
      .object({
        index: z.number().int().positive(),
        size: z.number().int().positive(),
        total: z.number().int().nonnegative()
      })
      .strict(),
    models: z.array(L2ModelCatalogItemSchema)
  })
  .strict()

export const L2ProjectModelDefaultGetRequestSchema = z.object({ cwd: L3PiCwdSchema }).strict()

export const L2ProjectModelDefaultGetResponseSchema = z
  .object({
    cwd: L3PiCwdSchema,
    default: L2ModelSelectionSchema.nullable(),
    models: z.array(L2ModelOptionSchema)
  })
  .strict()

export const L2ProjectModelDefaultReplaceRequestSchema = z
  .object({
    cwd: L3PiCwdSchema,
    default: L2ModelSelectionSchema.nullable()
  })
  .strict()

export const L2ProjectModelDefaultReplaceResponseSchema = z.object({}).strict()

export type L2ModelApi = z.infer<typeof L2ModelApiSchema>
export type L2ModelNativeConfig = z.infer<typeof L2ModelNativeConfigSchema>
export type L2ModelThinkingLevelConfig = z.infer<typeof L2ModelThinkingLevelConfigSchema>
export type L2ModelCost = z.infer<typeof L2ModelCostSchema>
export type L2ModelCompatConfig = z.infer<typeof L2ModelCompatConfigSchema>
export type L2ModelConfig = z.infer<typeof L2ModelConfigSchema>
export type L2ModelProviderConfig = z.infer<typeof L2ModelProviderConfigSchema>
export type L2ModelPreset = z.infer<typeof L2ModelPresetSchema>
export type L2ModelOption = z.infer<typeof L2ModelOptionSchema>
export type L2ModelSelection = z.infer<typeof L2ModelSelectionSchema>
export type L2ModelSettingsGetResponse = z.infer<typeof L2ModelSettingsGetResponseSchema>
export type L2ModelSettingsReplaceRequest = z.infer<typeof L2ModelSettingsReplaceRequestSchema>
export type L2ModelCatalogListRequest = z.infer<typeof L2ModelCatalogListRequestSchema>
export type L2ModelCatalogSource = z.infer<typeof L2ModelCatalogSourceSchema>
export type L2ModelCatalogItem = z.infer<typeof L2ModelCatalogItemSchema>
export type L2ModelCatalogListResponse = z.infer<typeof L2ModelCatalogListResponseSchema>
export type L2ProjectModelDefaultGetResponse = z.infer<
  typeof L2ProjectModelDefaultGetResponseSchema
>
export type L2ProjectModelDefaultReplaceRequest = z.infer<
  typeof L2ProjectModelDefaultReplaceRequestSchema
>
