import { z } from 'zod'
import {
  defineL4AppSocketPush,
  defineL4AppSocketRequest
} from '@common/l4_foundation/realtime/l4-app-websocket-contract'
import { L3PluginNameSchema } from './l3-plugin-json-contract'

export const L3PluginLogPathSchema = z.string().trim().min(1).max(32_768)

export const L3PluginLogSnapshotSchema = z
  .object({
    text: z.string(),
    truncated: z.boolean()
  })
  .strict()

export const L3PluginLogEventSchema = z.union([
  z
    .object({
      type: z.literal('text_append'),
      text: z.string().min(1)
    })
    .strict(),
  z
    .object({
      type: z.literal('snapshot'),
      snapshot: L3PluginLogSnapshotSchema
    })
    .strict(),
  z.object({ type: z.literal('unavailable') }).strict()
])

export const L3PluginLogWatchRequestSchema = z
  .object({
    pluginName: L3PluginNameSchema,
    path: L3PluginLogPathSchema
  })
  .strict()

export const L3PluginLogWatchResponseSchema = z
  .object({
    snapshot: L3PluginLogSnapshotSchema
  })
  .strict()

export const L3PluginLogUnwatchRequestSchema = L3PluginLogWatchRequestSchema
export const L3PluginLogUnwatchResponseSchema = z.object({}).strict()

export const L3PluginLogEventPushSchema = z
  .object({
    pluginName: L3PluginNameSchema,
    path: L3PluginLogPathSchema,
    event: L3PluginLogEventSchema
  })
  .strict()

export const L3PluginLogSocketContracts = Object.freeze({
  watch: defineL4AppSocketRequest({
    path: 'plugins/logs/watch',
    inputSchema: L3PluginLogWatchRequestSchema,
    outputSchema: L3PluginLogWatchResponseSchema
  }),
  unwatch: defineL4AppSocketRequest({
    path: 'plugins/logs/unwatch',
    inputSchema: L3PluginLogUnwatchRequestSchema,
    outputSchema: L3PluginLogUnwatchResponseSchema
  }),
  event: defineL4AppSocketPush({
    path: 'plugins/logs/event',
    bodySchema: L3PluginLogEventPushSchema
  })
})

export type L3PluginLogSnapshot = z.infer<typeof L3PluginLogSnapshotSchema>
export type L3PluginLogEvent = z.infer<typeof L3PluginLogEventSchema>
export type L3PluginLogWatchRequest = z.infer<typeof L3PluginLogWatchRequestSchema>
export type L3PluginLogWatchResponse = z.infer<typeof L3PluginLogWatchResponseSchema>
export type L3PluginLogUnwatchRequest = z.infer<typeof L3PluginLogUnwatchRequestSchema>
export type L3PluginLogEventPush = z.infer<typeof L3PluginLogEventPushSchema>
