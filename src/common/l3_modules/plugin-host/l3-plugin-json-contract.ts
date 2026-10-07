import { z } from 'zod'

export const L3PluginIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)

export const L3PluginNameSchema = L3PluginIdentifierSchema
export const L3PluginContributionNameSchema = L3PluginIdentifierSchema
export const L3PluginEventNameSchema = L3PluginIdentifierSchema
export const L3PluginJsonObjectSchema = z.record(z.string(), z.json())
export const L3PluginViewKeySchema = z
  .string()
  .trim()
  .min(3)
  .max(129)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/)

export const L3PluginBuiltinIconNameSchema = z.enum([
  'plugin',
  'server',
  'rocket',
  'settings',
  'panel',
  'message',
  'terminal',
  'file',
  'folder',
  'bot',
  'wrench',
  'database',
  'globe'
])

export const L3PluginContributionIconSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('builtin'),
      name: L3PluginBuiltinIconNameSchema
    })
    .strict(),
  z
    .object({
      type: z.literal('svg'),
      content: z
        .string()
        .trim()
        .min(1)
        .max(16 * 1024)
    })
    .strict()
])

export type L3PluginJsonObject = z.infer<typeof L3PluginJsonObjectSchema>
export type L3PluginContributionIcon = z.infer<typeof L3PluginContributionIconSchema>
