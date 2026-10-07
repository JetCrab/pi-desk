import { z } from 'zod'
import { L3PiSessionIdSchema } from '@common/l3_modules/pi/l3-pi-contract'

export const L3WorkSessionSourceSchema = z
  .object({
    workId: z.string().trim().min(1),
    sessionId: L3PiSessionIdSchema,
    branchId: z.string().trim().min(1)
  })
  .strict()

export type L3WorkSessionSource = z.infer<typeof L3WorkSessionSourceSchema>
