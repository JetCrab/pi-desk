import { z } from 'zod'
import { L4ClientIdSchema } from '@common/l4_foundation/http/l4-client-id-contract'
import { L4ErrorTranslationSchema } from '@common/l4_foundation/locale/l4-error-translation'

export const L4_APP_WEBSOCKET_ENDPOINT = '/api/ws'
export const L4_APP_WEBSOCKET_PROTOCOL = 'pi-desk.v1'
export const L4_APP_SOCKET_REPLACED_CLOSE_CODE = 4001
export const L4_APP_SOCKET_AUTH_CHANGED_CLOSE_CODE = 4003

export const L4AppSocketWirePathSchema = z.string().trim().min(1)
export const L4AppSocketRequestIdSchema = z.string().uuid()
export const L4AppSocketClientIdSchema = L4ClientIdSchema

export interface L4AppSocketRequestContract<TInput, TOutput> {
  readonly op: 'req'
  readonly path: string
  readonly inputSchema: z.ZodType<TInput>
  readonly outputSchema: z.ZodType<TOutput>
  readonly timeoutMs?: number
}

export interface L4AppSocketPushContract<TBody> {
  readonly op: 'push'
  readonly path: string
  readonly bodySchema: z.ZodType<TBody>
}

export function defineL4AppSocketRequest<TInput, TOutput>(contract: {
  path: string
  inputSchema: z.ZodType<TInput>
  outputSchema: z.ZodType<TOutput>
  timeoutMs?: number
}): L4AppSocketRequestContract<TInput, TOutput> {
  return Object.freeze({
    op: 'req' as const,
    path: L4AppSocketWirePathSchema.parse(contract.path),
    inputSchema: contract.inputSchema,
    outputSchema: contract.outputSchema,
    ...(contract.timeoutMs === undefined
      ? {}
      : { timeoutMs: z.number().int().positive().parse(contract.timeoutMs) })
  })
}

export function defineL4AppSocketPush<TBody>(contract: {
  path: string
  bodySchema: z.ZodType<TBody>
}): L4AppSocketPushContract<TBody> {
  return Object.freeze({
    op: 'push' as const,
    path: L4AppSocketWirePathSchema.parse(contract.path),
    bodySchema: contract.bodySchema
  })
}

const L4AppSocketRequestHeadSchema = z
  .object({
    op: z.literal('req'),
    path: L4AppSocketWirePathSchema,
    requestId: L4AppSocketRequestIdSchema
  })
  .strict()

const L4AppSocketResponseHeadSchema = z
  .object({
    op: z.literal('resp'),
    path: L4AppSocketWirePathSchema,
    requestId: L4AppSocketRequestIdSchema
  })
  .strict()

const L4AppSocketPushHeadSchema = z
  .object({
    op: z.literal('push'),
    path: L4AppSocketWirePathSchema
  })
  .strict()

export const L4AppSocketRequestSchema = z
  .object({
    head: L4AppSocketRequestHeadSchema,
    body: z.json()
  })
  .strict()

export const L4AppSocketSuccessResponseSchema = z
  .object({
    head: L4AppSocketResponseHeadSchema,
    body: z
      .object({
        code: z.literal(0),
        msg: z.literal(''),
        data: z.json()
      })
      .strict()
  })
  .strict()

export const L4AppSocketErrorResponseSchema = z
  .object({
    head: L4AppSocketResponseHeadSchema,
    body: z
      .object({
        code: z.number().int().positive(),
        msg: z.string().min(1),
        data: z.null(),
        i18n: L4ErrorTranslationSchema.optional()
      })
      .strict()
  })
  .strict()

export const L4AppSocketResponseSchema = z.union([
  L4AppSocketSuccessResponseSchema,
  L4AppSocketErrorResponseSchema
])

export const L4AppSocketPushSchema = z
  .object({
    head: L4AppSocketPushHeadSchema,
    body: z.json()
  })
  .strict()

export type L4AppSocketRequest = z.infer<typeof L4AppSocketRequestSchema>
export type L4AppSocketResponse = z.infer<typeof L4AppSocketResponseSchema>
export type L4AppSocketPush = z.infer<typeof L4AppSocketPushSchema>
