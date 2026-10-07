import { z } from 'zod'
import { HostRegionSchema } from '@jetcrab/pi-desk-sdk/settings'

export const PRIMARY_RSS_URL = 'https://fxtwitter.com/thsottiaux/feed.xml'
export const MAX_POSTS = 200
export const MAX_POST_TEXT = 32_000

export const modelSelectionSchema = z
  .object({
    provider: z.string().trim().min(1).max(200),
    modelId: z.string().trim().min(1).max(300)
  })
  .strict()

export const settingsSchema = z
  .object({
    enabled: z.boolean(),
    intervalSeconds: z.number().int().min(30).max(86_400),
    retentionCount: z.number().int().min(10).max(MAX_POSTS),
    model: modelSelectionSchema.nullable()
  })
  .strict()
  .refine((value) => !value.enabled || value.model !== null, '启用监听前请选择翻译模型')

export type TiboSettings = z.infer<typeof settingsSchema>
export type ModelSelection = z.infer<typeof modelSelectionSchema>

export function defaultSettings(): TiboSettings {
  return { enabled: false, intervalSeconds: 60, retentionCount: 100, model: null }
}

export const analysisSchema = z
  .object({
    translation: z.string().trim().min(1).max(MAX_POST_TEXT),
    quoteTranslation: z.string().trim().min(1).max(MAX_POST_TEXT).optional(),
    reset: z
      .object({
        level: z.enum(['announced', 'possible', 'none']),
        reason: z.string().trim().min(1).max(1600)
      })
      .strict(),
    times: z
      .array(
        z.preprocess(
          (value) => {
            if (
              !value ||
              typeof value !== 'object' ||
              !('beijing' in value) ||
              'localTime' in value
            )
              return value
            const { beijing, ...rest } = value
            return { ...rest, localTime: beijing }
          },
          z
            .object({
              source: z.string().trim().min(1).max(500),
              localTime: z.string().trim().min(1).max(700),
              assumption: z.string().trim().max(700)
            })
            .strict()
        )
      )
      .max(8)
  })
  .strict()
export type TiboAnalysis = z.infer<typeof analysisSchema>

export const postLinkSchema = z
  .string()
  .url()
  .max(1000)
  .refine((value) => {
    // 仅信任最终原帖链接；浏览器不渲染 RSS HTML。
    return /^https:\/\/x\.com\/[a-zA-Z0-9_]+\/status\/\d+$/.test(value)
  }, '原帖链接必须指向 X 帖子')

export const postSchema = z
  .object({
    id: z.string().min(1).max(1200),
    title: z.string().min(1).max(1000),
    text: z.string().min(1).max(MAX_POST_TEXT),
    link: postLinkSchema,
    quote: z
      .object({
        author: z.string().min(1).max(200),
        link: postLinkSchema,
        text: z.string().min(1).max(MAX_POST_TEXT)
      })
      .strict()
      .optional(),
    publishedAt: z.number().int().nonnegative()
  })
  .strict()
export type TiboPost = z.infer<typeof postSchema>

export const recordSchema = postSchema.extend({ analysis: analysisSchema.nullable() })
export type TiboRecord = z.infer<typeof recordSchema>
export const storedSchema = z
  .object({
    settings: settingsSchema,
    records: z.array(recordSchema).max(MAX_POSTS),
    analysisRegion: HostRegionSchema.optional()
  })
  .strict()
export type TiboStored = z.infer<typeof storedSchema>

export const runtimeStatusSchema = z
  .object({
    polling: z.boolean(),
    translating: z.boolean(),
    lastCheckedAt: z.number().nullable(),
    lastSuccessAt: z.number().nullable(),
    sourceUrl: z.string().nullable(),
    error: z.string().nullable()
  })
  .strict()
export type TiboRuntimeStatus = z.infer<typeof runtimeStatusSchema>

export const summarySchema = postSchema.omit({ text: true, quote: true }).extend({
  preview: z.string(),
  quotePreview: z.string().nullable(),
  resetLevel: analysisSchema.shape.reset.shape.level.nullable(),
  translated: z.boolean()
})
export type TiboSummary = z.infer<typeof summarySchema>
export const snapshotSchema = z
  .object({
    settings: settingsSchema,
    status: runtimeStatusSchema,
    records: z.array(summarySchema).max(MAX_POSTS)
  })
  .strict()
export type TiboSnapshot = z.infer<typeof snapshotSchema>

export const modelOptionSchema = modelSelectionSchema.extend({ name: z.string() })
export type TiboModelOption = z.infer<typeof modelOptionSchema>
export const modelsResponseSchema = z.object({ models: z.array(modelOptionSchema) }).strict()
export const recordResponseSchema = z.object({ record: recordSchema.nullable() }).strict()
export const recordInputSchema = z.object({ id: postSchema.shape.id }).strict()
export const notificationDataSchema = recordInputSchema.extend({ link: postLinkSchema })
export const emptyInputSchema = z.object({}).strict()

export function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1600)
}
