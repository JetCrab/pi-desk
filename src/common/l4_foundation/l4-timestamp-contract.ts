import { z } from 'zod'

export const L4TimestampMsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export type L4TimestampMs = z.infer<typeof L4TimestampMsSchema>
