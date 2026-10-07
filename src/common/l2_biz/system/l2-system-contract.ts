import { z } from 'zod'

export const L2SystemStatusSchema = z.object({
  application: z.literal('Pi Desk'),
  status: z.literal('ready'),
  version: z.string().trim().min(1).nullable().default(null),
  boundaries: z.object({
    client: z.literal('isolated'),
    server: z.literal('isolated'),
    common: z.literal('shared')
  }),
  layers: z.tuple([
    z.literal('L1 Entry'),
    z.literal('L2 Biz'),
    z.literal('L3 Modules'),
    z.literal('L4 Foundation')
  ])
})

export type L2SystemStatus = z.infer<typeof L2SystemStatusSchema>
