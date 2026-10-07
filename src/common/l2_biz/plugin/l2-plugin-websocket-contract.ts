import { z } from 'zod'
import { L3WorkSessionSourceSchema } from '@common/l3_modules/work-session/l3-work-session-source-contract'
import { defineL4AppSocketRequest } from '@common/l4_foundation/realtime/l4-app-websocket-contract'

const L2PluginIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)

export const L2PluginNameSchema = L2PluginIdentifierSchema
export const L2PluginMethodNameSchema = L2PluginIdentifierSchema
export const L2PluginMethodDataSchema = z.record(z.string(), z.json())

const L2GlobalPluginInvokeRequestSchema = z
  .object({
    pluginName: L2PluginNameSchema,
    method: L2PluginMethodNameSchema,
    scope: z.literal('global'),
    input: L2PluginMethodDataSchema
  })
  .strict()

const L2SessionPluginInvokeRequestSchema = z
  .object({
    pluginName: L2PluginNameSchema,
    method: L2PluginMethodNameSchema,
    scope: z.literal('session'),
    source: L3WorkSessionSourceSchema,
    input: L2PluginMethodDataSchema
  })
  .strict()

export const L2PluginInvokeRequestSchema = z.discriminatedUnion('scope', [
  L2GlobalPluginInvokeRequestSchema,
  L2SessionPluginInvokeRequestSchema
])

export const L2PluginInvokeResponseSchema = L2PluginMethodDataSchema

export const L2PluginSocketContracts = Object.freeze({
  invoke: defineL4AppSocketRequest({
    path: 'plugins/invoke',
    inputSchema: L2PluginInvokeRequestSchema,
    outputSchema: L2PluginInvokeResponseSchema
  })
})

export type L2PluginMethodData = z.infer<typeof L2PluginMethodDataSchema>
export type L2PluginInvokeRequest = z.infer<typeof L2PluginInvokeRequestSchema>
export type L2PluginInvokeResponse = z.infer<typeof L2PluginInvokeResponseSchema>
