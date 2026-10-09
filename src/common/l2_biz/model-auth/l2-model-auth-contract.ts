import { z } from 'zod'
import {
  defineL4AppSocketPush,
  defineL4AppSocketRequest
} from '@common/l4_foundation/realtime/l4-app-websocket-contract'

const empty = z.object({}).strict()
const provider = z.string().trim().min(1).max(128)
const text = z.string().max(32_768)
const link = z.object({ url: text, label: text.optional() }).strict()

export const L2ModelAuthProviderSchema = z
  .object({
    provider,
    name: text,
    loggedIn: z.boolean(),
    conflict: z.string().nullable()
  })
  .strict()

export const L2ModelAuthPromptSchema = z
  .object({
    id: z.string().uuid(),
    type: z.enum(['text', 'secret', 'select', 'manual_code']),
    message: text,
    placeholder: text.optional(),
    options: z
      .array(z.object({ id: text, label: text, description: text.optional() }).strict())
      .optional()
  })
  .strict()

export const L2ModelAuthNoticeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth_url'), url: text, instructions: text.optional() }).strict(),
  z
    .object({
      type: z.literal('device_code'),
      userCode: text,
      verificationUri: text
    })
    .strict(),
  z.object({ type: z.literal('info'), message: text, links: z.array(link).optional() }).strict(),
  z.object({ type: z.literal('progress'), message: text }).strict()
])

export const L2ModelAuthStateSchema = z
  .object({
    loginId: z.string().uuid(),
    provider,
    status: z.enum(['running', 'completed', 'cancelled', 'error']),
    notice: L2ModelAuthNoticeSchema.nullable(),
    prompt: L2ModelAuthPromptSchema.nullable(),
    message: z.string().nullable()
  })
  .strict()

export const L2ModelAuthSocketContracts = Object.freeze({
  list: defineL4AppSocketRequest({
    path: 'model-auth/list',
    inputSchema: empty,
    outputSchema: z.object({ providers: z.array(L2ModelAuthProviderSchema) }).strict()
  }),
  start: defineL4AppSocketRequest({
    path: 'model-auth/start',
    inputSchema: z.object({ loginId: z.string().uuid(), provider }).strict(),
    outputSchema: empty
  }),
  respond: defineL4AppSocketRequest({
    path: 'model-auth/respond',
    inputSchema: z
      .object({ loginId: z.string().uuid(), promptId: z.string().uuid(), value: text })
      .strict(),
    outputSchema: empty
  }),
  cancel: defineL4AppSocketRequest({
    path: 'model-auth/cancel',
    inputSchema: z.object({ loginId: z.string().uuid() }).strict(),
    outputSchema: empty
  }),
  logout: defineL4AppSocketRequest({
    path: 'model-auth/logout',
    inputSchema: z.object({ provider }).strict(),
    outputSchema: empty
  }),
  state: defineL4AppSocketPush({ path: 'model-auth/state', bodySchema: L2ModelAuthStateSchema })
})

export type L2ModelAuthProvider = z.infer<typeof L2ModelAuthProviderSchema>
export type L2ModelAuthPrompt = z.infer<typeof L2ModelAuthPromptSchema>
export type L2ModelAuthNotice = z.infer<typeof L2ModelAuthNoticeSchema>
export type L2ModelAuthState = z.infer<typeof L2ModelAuthStateSchema>
