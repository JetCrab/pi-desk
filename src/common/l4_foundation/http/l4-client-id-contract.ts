import { z } from 'zod'

export const L4_CLIENT_ID_HEADER = 'X-Pi-Desk-Client-Id'
export const L4ClientIdSchema = z.string().uuid()
