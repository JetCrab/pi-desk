import { z } from 'zod'

export const L3PiCwdSchema = z.string().trim().min(1)
export const L3PiSessionIdSchema = z.string().trim().min(1)
export const L3PiEntryIdSchema = z.string().trim().min(1)
