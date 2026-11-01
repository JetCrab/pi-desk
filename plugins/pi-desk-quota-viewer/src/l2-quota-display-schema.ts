import { z } from 'zod'
import { MAX_HIDDEN_ITEMS } from './protocol.js'
import { migrateQuotaVisibilityKey } from './l2-quota-display-key.js'

const itemIdentitySchema = z.tuple([
  z.enum(['balance', 'quota']),
  z.string().min(1),
  z.string(),
  z.string()
])
const hiddenItemKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => {
    const migrated = migrateQuotaVisibilityKey(value)
    if (!migrated) return false
    return itemIdentitySchema.safeParse(JSON.parse(migrated.slice(migrated.indexOf(':') + 1)))
      .success
  }, '显示项标识格式无效')
  .transform((value) => migrateQuotaVisibilityKey(value) ?? value)

export const QuotaDisplaySettingsSchema = z
  .object({
    resetTimeFormat: z.enum(['countdown', 'absolute']).default('countdown'),
    hiddenItemKeys: z.array(hiddenItemKeySchema).max(MAX_HIDDEN_ITEMS).default([])
  })
  .strict()

export type QuotaDisplaySettings = z.infer<typeof QuotaDisplaySettingsSchema>
