import { z } from 'zod'
import { L3WorkSessionSourceSchema } from '@common/l3_modules/work-session/l3-work-session-source-contract'
import { defineL4AppSocketPush } from '@common/l4_foundation/realtime/l4-app-websocket-contract'
import {
  L3PluginEventNameSchema,
  L3PluginJsonObjectSchema,
  L3PluginNameSchema
} from './l3-plugin-json-contract'

export const L3PluginPushTargetSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('global') }).strict(),
  z
    .object({
      scope: z.literal('session'),
      source: L3WorkSessionSourceSchema
    })
    .strict()
])

export const L3PluginPushMessageSchema = z
  .object({
    pluginName: L3PluginNameSchema,
    target: L3PluginPushTargetSchema,
    event: L3PluginEventNameSchema,
    data: L3PluginJsonObjectSchema
  })
  .strict()

export const L3PluginPushSocketContract = defineL4AppSocketPush({
  path: 'plugins/push',
  bodySchema: L3PluginPushMessageSchema
})

export type L3PluginPushTarget = z.infer<typeof L3PluginPushTargetSchema>
export type L3PluginPushMessage = z.infer<typeof L3PluginPushMessageSchema>
