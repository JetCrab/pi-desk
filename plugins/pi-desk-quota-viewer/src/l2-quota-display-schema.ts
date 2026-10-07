import { z } from 'zod'
import { MAX_HIDDEN_ITEMS } from './protocol.js'

const itemIdentitySchema = z.tuple([z.enum(['balance', 'quota']), z.string().min(1), z.string()])
const hiddenItemKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => {
    const separator = value.indexOf(':')
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.slice(0, separator))) return false
    try {
      return itemIdentitySchema.safeParse(JSON.parse(value.slice(separator + 1))).success
    } catch {
      return false
    }
  }, '显示项标识格式无效')

export const QuotaDisplaySettingsSchema = z
  .object({
    resetTimeFormat: z.enum(['countdown', 'absolute']).default('countdown'),
    hiddenItemKeys: z.array(hiddenItemKeySchema).max(MAX_HIDDEN_ITEMS).default([])
  })
  .strict()

export type QuotaDisplaySettings = z.infer<typeof QuotaDisplaySettingsSchema>
