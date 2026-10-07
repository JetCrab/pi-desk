import { z } from 'zod'
import { L3PluginJsonObjectSchema } from '@common/l3_modules/plugin-host/l3-plugin-json-contract'
import { L2ChatSourceSchema } from './l2-chat-contract'

export const L2ChatModelContextToolSchema = z
  .object({
    name: z.string().trim().min(1),
    description: z.string(),
    parameters: L3PluginJsonObjectSchema
  })
  .strict()

export const L2ChatModelContextGetRequestSchema = z
  .object({
    source: L2ChatSourceSchema
  })
  .strict()

export const L2ChatModelContextGetResponseSchema = z
  .object({
    systemPrompt: z.string(),
    tools: z.array(L2ChatModelContextToolSchema)
  })
  .strict()

export type L2ChatModelContextTool = z.infer<typeof L2ChatModelContextToolSchema>
export type L2ChatModelContextGetRequest = z.infer<typeof L2ChatModelContextGetRequestSchema>
export type L2ChatModelContextGetResponse = z.infer<typeof L2ChatModelContextGetResponseSchema>
