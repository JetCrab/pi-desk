import { z } from 'zod'

export const L4ErrorTranslationSchema = z
  .object({
    key: z.string().min(1).max(160),
    params: z
      .record(z.string().min(1).max(80), z.union([z.string().max(1000), z.number().finite()]))
      .optional()
  })
  .strict()

export type L4ErrorTranslation = z.infer<typeof L4ErrorTranslationSchema>
