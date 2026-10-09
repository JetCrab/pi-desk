import { z } from 'zod'
import { L3PluginJsonObjectSchema } from '@common/l3_modules/plugin-host/l3-plugin-json-contract'
import { L4LocalizedTextSchema } from '@common/l4_foundation/locale/l4-localized-text'
import { L4PluginUpdateTagSchema } from '@common/l4_foundation/plugin/l4-plugin-package'
import { defineL4AppSocketPush } from '@common/l4_foundation/realtime/l4-app-websocket-contract'
import { L2PluginDownloadSourceSchema, L2PluginRegistrySchema } from './l2-plugin-catalog-contract'

export const L2PluginManagementSourceSchema = z.string().trim().min(1).max(2048)
export const L2PluginManagementTagSchema = L4PluginUpdateTagSchema
const L2PluginManagementSourcesSchema = z.array(L2PluginManagementSourceSchema).min(1).max(32)

export const L2PluginManagementErrorSchema = z
  .object({
    phase: z.enum(['package', 'entry', 'setup', 'resources', 'resolve', 'native']),
    message: L4LocalizedTextSchema.refine((text) =>
      typeof text === 'string' ? text.length > 0 : text.default.length > 0
    )
  })
  .strict()

const L2PluginCapabilityPathSchema = z.string().trim().min(1).max(4096)
const L2PluginCapabilityNameSchema = z.string().trim().min(1).max(256)
const L2PluginCapabilityTextSchema = z.string().max(32 * 1024)

export const L2PluginManagementToolCapabilitySchema = z
  .object({
    name: L2PluginCapabilityNameSchema,
    label: L2PluginCapabilityTextSchema,
    state: z.enum(['active', 'inactive', 'shadowed']),
    description: L2PluginCapabilityTextSchema,
    promptSnippet: L2PluginCapabilityTextSchema.nullable(),
    promptGuidelineCount: z.number().int().nonnegative(),
    promptGuidelinePreview: L2PluginCapabilityTextSchema.nullable()
  })
  .strict()

const L2PluginManagementToolDetailSchema = z
  .object({
    name: L2PluginCapabilityNameSchema,
    label: L2PluginCapabilityTextSchema,
    state: z.enum(['active', 'inactive', 'shadowed']),
    description: L2PluginCapabilityTextSchema,
    parameters: L3PluginJsonObjectSchema,
    promptSnippet: L2PluginCapabilityTextSchema.nullable(),
    promptGuidelines: z.array(L2PluginCapabilityTextSchema)
  })
  .strict()

const L2PluginManagementExtensionCapabilitySchema = z
  .object({
    path: L2PluginCapabilityPathSchema,
    events: z.array(
      z
        .object({
          name: L2PluginCapabilityNameSchema,
          count: z.number().int().positive()
        })
        .strict()
    ),
    commands: z.array(
      z
        .object({
          name: L2PluginCapabilityNameSchema,
          description: L2PluginCapabilityTextSchema.nullable()
        })
        .strict()
    ),
    shortcuts: z.array(
      z
        .object({
          shortcut: L2PluginCapabilityNameSchema,
          description: L2PluginCapabilityTextSchema.nullable()
        })
        .strict()
    ),
    flags: z.array(
      z
        .object({
          name: L2PluginCapabilityNameSchema,
          type: z.enum(['boolean', 'string']),
          description: L2PluginCapabilityTextSchema.nullable(),
          default: z.union([z.boolean(), z.string(), z.null()])
        })
        .strict()
    ),
    messageRenderers: z.array(L2PluginCapabilityNameSchema),
    entryRenderers: z.array(L2PluginCapabilityNameSchema)
  })
  .strict()

const L2PluginManagementResourceCapabilitySchema = z
  .object({
    name: L2PluginCapabilityNameSchema,
    description: L2PluginCapabilityTextSchema,
    path: L2PluginCapabilityPathSchema
  })
  .strict()

const L2PluginManagementSkillCapabilitySchema = L2PluginManagementResourceCapabilitySchema.extend({
  modelVisible: z.boolean()
}).strict()

const L2PluginManagementResourceDetailSchema = L2PluginManagementResourceCapabilitySchema.extend({
  content: z.string().max(64 * 1024),
  truncated: z.boolean()
}).strict()

const L2PluginManagementSkillDetailSchema = L2PluginManagementResourceDetailSchema.extend({
  modelVisible: z.boolean()
}).strict()

const L2PluginManagementThemeCapabilitySchema = z
  .object({
    name: L2PluginCapabilityNameSchema,
    path: L2PluginCapabilityPathSchema
  })
  .strict()

const L2PluginManagementProviderCapabilitySchema = z
  .object({
    name: L2PluginCapabilityNameSchema,
    kind: z.enum(['config', 'native'])
  })
  .strict()

const L2PluginManagementPiDeskCapabilitySchema = z
  .object({
    methods: z.array(
      z
        .object({
          pluginName: L2PluginCapabilityNameSchema,
          method: L2PluginCapabilityNameSchema
        })
        .strict()
    ),
    browserEntries: z.array(z.object({ pluginName: L2PluginCapabilityNameSchema }).strict()),
    messageDeclarations: z.array(
      z
        .object({
          pluginName: L2PluginCapabilityNameSchema,
          declarationName: L2PluginCapabilityNameSchema,
          priority: z.number().int().safe()
        })
        .strict()
    )
  })
  .strict()

export const L2PluginManagementCapabilitiesSchema = z
  .object({
    error: L4LocalizedTextSchema.refine((text) =>
      typeof text === 'string'
        ? text.length <= 32 * 1024
        : [text.default, ...Object.values(text.translations)].every(
            (value) => value.length <= 32 * 1024
          )
    ).nullable(),
    extensions: z.array(L2PluginManagementExtensionCapabilitySchema),
    tools: z.array(L2PluginManagementToolCapabilitySchema),
    skills: z.array(L2PluginManagementSkillCapabilitySchema),
    prompts: z.array(L2PluginManagementResourceCapabilitySchema),
    themes: z.array(L2PluginManagementThemeCapabilitySchema),
    providers: z.array(L2PluginManagementProviderCapabilitySchema),
    piDesk: L2PluginManagementPiDeskCapabilitySchema
  })
  .strict()

export const L2PluginManagementOperationSchema = z
  .object({
    action: z.enum(['add', 'update', 'del', 'apply', 'enable', 'disable']),
    phase: z.enum(['queued', 'checking', 'applying', 'waiting', 'failed']),
    message: z.string().max(4000).nullable()
  })
  .strict()

export const L2PluginManagementChangedContract = defineL4AppSocketPush({
  path: 'plugins/management-update',
  bodySchema: z.object({}).strict()
})

export const L2PluginManagementItemSchema = z
  .object({
    source: L2PluginManagementSourceSchema,
    kind: z.enum(['package', 'extension']).default('package'),
    operation: L2PluginManagementOperationSchema.nullable().default(null),
    pluginName: z.string().trim().min(1).nullable(),
    description: L4LocalizedTextSchema.nullable().default(null),
    version: z.string().trim().min(1).nullable(),
    updateAvailable: z.boolean().nullable(),
    updateTag: L2PluginManagementTagSchema.nullable().optional(),
    availableVersion: z.string().min(1).nullable().optional(),
    updateError: z.string().max(4000).nullable().optional(),
    status: z.enum(['ready', 'available', 'disabled', 'failed']),
    error: L2PluginManagementErrorSchema.nullable(),
    capabilities: L2PluginManagementCapabilitiesSchema
  })
  .strict()

export const L2PluginManagementDetailSchema = z
  .object({
    source: L2PluginManagementSourceSchema,
    readme: L4LocalizedTextSchema.nullable().default(null),
    tools: z.array(L2PluginManagementToolDetailSchema),
    skills: z.array(L2PluginManagementSkillDetailSchema),
    prompts: z.array(L2PluginManagementResourceDetailSchema)
  })
  .strict()

export const L2PluginManagementSnapshotSchema = z
  .object({
    plugins: z.array(L2PluginManagementItemSchema),
    restartRequired: z.boolean(),
    loadError: L4LocalizedTextSchema.refine((text) =>
      typeof text === 'string' ? text.length > 0 : text.default.length > 0
    ).nullable()
  })
  .strict()

export const L2PluginManagementApplyRequestSchema = z
  .object({ sources: z.array(L2PluginManagementSourceSchema).min(1).max(32).optional() })
  .strict()
export const L2PluginManagementEmptyRequestSchema = z.object({}).strict()
export const L2PluginManagementReloadRequestSchema = L2PluginManagementEmptyRequestSchema.extend({
  mode: z.enum(['normal', 'basic']).optional()
}).strict()
export const L2PluginManagementListRequestSchema = z
  .object({
    checkUpdates: z.boolean().optional(),
    sources: L2PluginManagementSourcesSchema.optional(),
    tag: L2PluginManagementTagSchema.optional()
  })
  .strict()
export const L2PluginManagementSourceRequestSchema = z
  .object({ source: L2PluginManagementSourceSchema })
  .strict()

export const L2PluginManagementInstallRequestSchema = L2PluginManagementSourceRequestSchema.extend({
  downloadSource: L2PluginDownloadSourceSchema.optional(),
  registry: L2PluginRegistrySchema.optional(),
  tag: L2PluginManagementTagSchema.optional()
}).strict()
export const L2PluginManagementBatchRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('add'),
      items: z.array(L2PluginManagementInstallRequestSchema).min(1).max(32)
    })
    .strict(),
  z.object({ action: z.literal('update'), sources: L2PluginManagementSourcesSchema }).strict(),
  z.object({ action: z.literal('del'), sources: L2PluginManagementSourcesSchema }).strict(),
  z
    .object({
      action: z.literal('tag'),
      sources: L2PluginManagementSourcesSchema,
      tag: L2PluginManagementTagSchema
    })
    .strict()
])
export const L2PluginManagementBatchResponseSchema = z
  .object({
    snapshot: L2PluginManagementSnapshotSchema,
    results: z
      .array(
        z
          .object({
            source: L2PluginManagementSourceSchema,
            error: z.string().max(4000).nullable()
          })
          .strict()
      )
      .max(32)
  })
  .strict()
export type L2PluginManagementBatchRequest = z.infer<typeof L2PluginManagementBatchRequestSchema>
export type L2PluginManagementBatchResponse = z.infer<typeof L2PluginManagementBatchResponseSchema>

export const L2PluginManagementEnabledRequestSchema = L2PluginManagementSourceRequestSchema.extend({
  enabled: z.boolean()
}).strict()
export type L2PluginManagementInstallRequest = z.infer<
  typeof L2PluginManagementInstallRequestSchema
>

export type L2PluginManagementOperation = z.infer<typeof L2PluginManagementOperationSchema>
export type L2PluginManagementError = z.infer<typeof L2PluginManagementErrorSchema>
export type L2PluginManagementToolCapability = z.infer<
  typeof L2PluginManagementToolCapabilitySchema
>
export type L2PluginManagementToolDetail = z.infer<typeof L2PluginManagementToolDetailSchema>
export type L2PluginManagementCapabilities = z.infer<typeof L2PluginManagementCapabilitiesSchema>
export type L2PluginManagementItem = z.infer<typeof L2PluginManagementItemSchema>
export type L2PluginManagementDetail = z.infer<typeof L2PluginManagementDetailSchema>
export type L2PluginManagementSnapshot = z.infer<typeof L2PluginManagementSnapshotSchema>
export type L2PluginManagementListRequest = z.infer<typeof L2PluginManagementListRequestSchema>
export type L2PluginManagementSourceRequest = z.infer<typeof L2PluginManagementSourceRequestSchema>
