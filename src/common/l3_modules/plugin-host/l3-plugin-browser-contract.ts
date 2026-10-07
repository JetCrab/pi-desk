import { z } from 'zod'
import { defineL4AppSocketRequest } from '@common/l4_foundation/realtime/l4-app-websocket-contract'
import { L3PluginNameSchema } from './l3-plugin-json-contract'

export const L3PluginBrowserResourceGroupSchema = z
  .string()
  .min(32)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/)

export const L3_PLUGIN_HOST_BROWSER_RUNTIME_VERSION = 'v1' as const
export const L3_PLUGIN_HOST_BROWSER_RUNTIME_BASE_PATH = `/api/plugins/host-runtime/${L3_PLUGIN_HOST_BROWSER_RUNTIME_VERSION}`
export const L3_PLUGIN_HOST_BROWSER_RUNTIME_IMPORT_MAP = Object.freeze({
  imports: Object.freeze({
    react: `${L3_PLUGIN_HOST_BROWSER_RUNTIME_BASE_PATH}/base.js`,
    'react/jsx-runtime': `${L3_PLUGIN_HOST_BROWSER_RUNTIME_BASE_PATH}/base.js`,
    'react/jsx-dev-runtime': `${L3_PLUGIN_HOST_BROWSER_RUNTIME_BASE_PATH}/base.js`,
    'react-dom': `${L3_PLUGIN_HOST_BROWSER_RUNTIME_BASE_PATH}/base.js`,
    'react-dom/client': `${L3_PLUGIN_HOST_BROWSER_RUNTIME_BASE_PATH}/base.js`,
    '@jetcrab/pi-desk-sdk/react/base': `${L3_PLUGIN_HOST_BROWSER_RUNTIME_BASE_PATH}/base.js`,
    '@jetcrab/pi-desk-sdk/react/markdown': `${L3_PLUGIN_HOST_BROWSER_RUNTIME_BASE_PATH}/markdown.js`
  })
})
export const L3PluginHostBrowserRuntimeVersionSchema = z.literal(
  L3_PLUGIN_HOST_BROWSER_RUNTIME_VERSION
)

export const L3PluginBrowserEntryDescriptorSchema = z
  .object({
    pluginName: L3PluginNameSchema,
    url: z
      .string()
      .regex(
        /^\/api\/plugins\/browser-resources\/[A-Za-z0-9_-]{32,128}\/entry\.js$/,
        'Browser Entry URL 无效'
      )
  })
  .strict()

export const L3PluginBrowserEntriesListRequestSchema = z.object({}).strict()
export const L3PluginBrowserEntriesListResponseSchema = z
  .object({
    entries: z.array(L3PluginBrowserEntryDescriptorSchema)
  })
  .strict()

export const L3PluginBrowserSocketContracts = Object.freeze({
  list: defineL4AppSocketRequest({
    path: 'plugins/browser-entries/list',
    inputSchema: L3PluginBrowserEntriesListRequestSchema,
    outputSchema: L3PluginBrowserEntriesListResponseSchema
  })
})

export type L3PluginBrowserEntryDescriptor = z.infer<typeof L3PluginBrowserEntryDescriptorSchema>
export type L3PluginBrowserEntriesListResponse = z.infer<
  typeof L3PluginBrowserEntriesListResponseSchema
>
