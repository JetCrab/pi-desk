import { z } from 'zod'
import { L3PiEntryIdSchema } from './l3-pi-contract'
import { L4TimestampMsSchema } from '@common/l4_foundation/l4-timestamp-contract'

export const L3PiSessionSearchScopeSchema = z.enum(['title', 'user', 'assistant', 'sessionId'])

export const L3PiSessionSearchMatchSchema = z
  .object({
    scope: L3PiSessionSearchScopeSchema,
    count: z.number().int().positive(),
    entryId: L3PiEntryIdSchema.nullable(),
    timestampMs: L4TimestampMsSchema.nullable(),
    preview: z.string().min(1).max(160)
  })
  .strict()

export const L3PiSessionSearchQuerySchema = z
  .object({
    query: z.string().trim().max(120).default(''),
    searchIn: z.array(L3PiSessionSearchScopeSchema).min(1).max(4).default(['title', 'user'])
  })
  .strict()

export type L3PiSessionSearchScope = z.infer<typeof L3PiSessionSearchScopeSchema>
export type L3PiSessionSearchMatch = z.infer<typeof L3PiSessionSearchMatchSchema>
export type L3PiSessionSearchQuery = z.infer<typeof L3PiSessionSearchQuerySchema>
