import { z } from 'zod'
import { L3WorkSessionSourceSchema } from '@common/l3_modules/work-session/l3-work-session-source-contract'
import { defineL4AppSocketRequest } from '@common/l4_foundation/realtime/l4-app-websocket-contract'
import { L3PluginJsonObjectSchema } from './l3-plugin-json-contract'

export const L3PiNativeCommandSourceSchema = z.enum(['extension', 'prompt', 'skill'])

export const L3PiNativeCommandInfoSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    description: z.string().max(500).nullable(),
    source: L3PiNativeCommandSourceSchema
  })
  .strict()

export const L3PiNativeCommandsListRequestSchema = z
  .object({ source: L3WorkSessionSourceSchema })
  .strict()
export const L3PiNativeCommandsListResponseSchema = z
  .object({ commands: z.array(L3PiNativeCommandInfoSchema) })
  .strict()

export const L3PiNativeCommandExecuteRequestSchema = z
  .object({
    source: L3WorkSessionSourceSchema,
    command: z.string().trim().min(1).max(128),
    args: z
      .string()
      .max(32 * 1024)
      .optional()
  })
  .strict()
export const L3PiNativeCommandExecuteResponseSchema = z.object({}).strict()

export const L3PiNativeToolInfoSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    description: z.string(),
    parameters: L3PluginJsonObjectSchema,
    active: z.boolean(),
    exposure: z.enum(['direct', 'model-only', 'codemode', 'deferred', 'hidden']),
    source: z.string().nullable(),
    blockedByMode: z.boolean()
  })
  .strict()

export const L3PiNativeToolsListRequestSchema = z
  .object({ source: L3WorkSessionSourceSchema })
  .strict()
export const L3PiNativeToolsListResponseSchema = z
  .object({ tools: z.array(L3PiNativeToolInfoSchema) })
  .strict()

export const L3PiNativeBashExecuteRequestSchema = z
  .object({
    source: L3WorkSessionSourceSchema,
    command: z
      .string()
      .min(1)
      .max(32 * 1024),
    excludeFromContext: z.boolean()
  })
  .strict()

export const L3PiNativeBashResultSchema = z
  .object({
    output: z.string(),
    exitCode: z.number().int().nullable(),
    cancelled: z.boolean(),
    truncated: z.boolean(),
    fullOutputPath: z.string().nullable()
  })
  .strict()

export const L3PiNativeBashAbortRequestSchema = z
  .object({ source: L3WorkSessionSourceSchema })
  .strict()
export const L3PiNativeBashAbortResponseSchema = z.object({}).strict()

export const L3PiNativeSocketContracts = Object.freeze({
  commandsList: defineL4AppSocketRequest({
    path: 'pi/commands/list',
    inputSchema: L3PiNativeCommandsListRequestSchema,
    outputSchema: L3PiNativeCommandsListResponseSchema
  }),
  commandExecute: defineL4AppSocketRequest({
    path: 'pi/commands/execute',
    inputSchema: L3PiNativeCommandExecuteRequestSchema,
    outputSchema: L3PiNativeCommandExecuteResponseSchema,
    timeoutMs: 300_000
  }),
  toolsList: defineL4AppSocketRequest({
    path: 'pi/tools/list',
    inputSchema: L3PiNativeToolsListRequestSchema,
    outputSchema: L3PiNativeToolsListResponseSchema
  }),
  bashExecute: defineL4AppSocketRequest({
    path: 'pi/bash/execute',
    inputSchema: L3PiNativeBashExecuteRequestSchema,
    outputSchema: L3PiNativeBashResultSchema,
    timeoutMs: 120_000
  }),
  bashAbort: defineL4AppSocketRequest({
    path: 'pi/bash/abort',
    inputSchema: L3PiNativeBashAbortRequestSchema,
    outputSchema: L3PiNativeBashAbortResponseSchema
  })
})

export type L3PiNativeCommandSource = z.infer<typeof L3PiNativeCommandSourceSchema>
export type L3PiNativeCommandInfo = z.infer<typeof L3PiNativeCommandInfoSchema>
export type L3PiNativeCommandsListRequest = z.infer<typeof L3PiNativeCommandsListRequestSchema>
export type L3PiNativeCommandsListResponse = z.infer<typeof L3PiNativeCommandsListResponseSchema>
export type L3PiNativeCommandExecuteRequest = z.infer<typeof L3PiNativeCommandExecuteRequestSchema>
export type L3PiNativeToolInfo = z.infer<typeof L3PiNativeToolInfoSchema>
export type L3PiNativeToolsListRequest = z.infer<typeof L3PiNativeToolsListRequestSchema>
export type L3PiNativeToolsListResponse = z.infer<typeof L3PiNativeToolsListResponseSchema>
export type L3PiNativeBashExecuteRequest = z.infer<typeof L3PiNativeBashExecuteRequestSchema>
export type L3PiNativeBashResult = z.infer<typeof L3PiNativeBashResultSchema>
export type L3PiNativeBashAbortRequest = z.infer<typeof L3PiNativeBashAbortRequestSchema>
