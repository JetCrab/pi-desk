import { z } from 'zod'
import type { PluginDisposer } from './shared.js'

export const HostRegionSchema = z
  .object({
    locale: z.enum(['zh-CN', 'en']),
    timeZone: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value })
          return true
        } catch {
          return false
        }
      }, '无效的 IANA 时区')
  })
  .strict()
  .readonly()

export const HostSettingsSchema = z.object({ region: HostRegionSchema }).strict().readonly()

export type HostRegion = z.infer<typeof HostRegionSchema>
export type HostSettingsSnapshot = z.infer<typeof HostSettingsSchema>

export interface HostSettings {
  getSnapshot(): HostSettingsSnapshot
  subscribe(listener: () => void): PluginDisposer
}
