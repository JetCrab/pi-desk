import { z } from 'zod'
import { L4LocalizedTextSchema } from '@common/l4_foundation/locale/l4-localized-text'

import {
  L4PluginRegistrySchema,
  L4PluginDownloadSourceSchema
} from '@common/l4_foundation/plugin/l4-plugin-package'

export const L2PluginRegistrySchema = L4PluginRegistrySchema
export const L2PluginDownloadSourceSchema = L4PluginDownloadSourceSchema
export const L2PluginCatalogSettingsSchema = z
  .object({
    downloadSource: L2PluginDownloadSourceSchema,
    recommendedRegistry: L2PluginRegistrySchema
  })
  .strict()
export const L2PluginCatalogSettingsRequestSchema = z
  .object({ downloadSource: L2PluginDownloadSourceSchema })
  .strict()
export const L2PluginCatalogSearchRequestSchema = z
  .object({
    query: z.string().trim().max(200).default(''),
    page: z.number().int().min(1).max(100).default(1),
    kind: z.enum(['all', 'desk', 'pi']).default('all'),
    registry: L2PluginRegistrySchema.optional()
  })
  .strict()
export const L2PluginCatalogGetRequestSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(214)
      .regex(/^(?:@[a-z0-9_.-]+\/)?[a-z0-9][a-z0-9_.-]*$/i),
    version: z.string().trim().min(1).max(128).optional(),
    registry: L2PluginRegistrySchema.optional()
  })
  .strict()
export const L2PluginCatalogItemSchema = z
  .object({
    name: z.string(),
    description: L4LocalizedTextSchema.nullable(),
    version: z.string(),
    publisher: z.string().nullable(),
    kind: z.enum(['desk', 'pi', 'unknown']),
    official: z.boolean(),
    registry: L2PluginRegistrySchema
  })
  .strict()
export const L2PluginCatalogSearchResultSchema = z
  .object({
    items: z.array(L2PluginCatalogItemSchema),
    hasMore: z.boolean()
  })
  .strict()
export const L2PluginCatalogDetailSchema = L2PluginCatalogItemSchema.extend({
  versions: z.array(z.string()),
  readme: L4LocalizedTextSchema.nullable(),
  homepage: z.string().nullable(),
  repository: z.string().nullable(),
  compatible: z.boolean().nullable(),
  compatibilityNote: z.string().nullable()
}).strict()

export type L2PluginDownloadSource = z.infer<typeof L2PluginDownloadSourceSchema>
export type L2PluginCatalogSettings = z.infer<typeof L2PluginCatalogSettingsSchema>
export type L2PluginCatalogSearchRequest = z.infer<typeof L2PluginCatalogSearchRequestSchema>
export type L2PluginCatalogGetRequest = z.infer<typeof L2PluginCatalogGetRequestSchema>
export type L2PluginCatalogItem = z.infer<typeof L2PluginCatalogItemSchema>
export type L2PluginCatalogSearchResult = z.infer<typeof L2PluginCatalogSearchResultSchema>
export type L2PluginCatalogDetail = z.infer<typeof L2PluginCatalogDetailSchema>
