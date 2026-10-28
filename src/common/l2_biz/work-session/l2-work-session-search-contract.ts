import { z } from 'zod'
import {
  L3PiSessionSearchMatchSchema,
  L3PiSessionSearchQuerySchema
} from '@common/l3_modules/pi/l3-pi-session-search-contract'
import { L2WorkIdSchema } from './l2-work-session-contract'

export const L2WorkSessionSearchRequestSchema = L3PiSessionSearchQuerySchema.extend({
  query: z.string().trim().min(1).max(120)
})

export const L2WorkSessionSearchResponseSchema = z
  .object({
    sessions: z.array(
      z
        .object({
          workId: L2WorkIdSchema,
          matches: z.array(L3PiSessionSearchMatchSchema).min(1).max(4)
        })
        .strict()
    )
  })
  .strict()

export type L2WorkSessionSearchRequest = z.infer<typeof L2WorkSessionSearchRequestSchema>
export type L2WorkSessionSearchResponse = z.infer<typeof L2WorkSessionSearchResponseSchema>
