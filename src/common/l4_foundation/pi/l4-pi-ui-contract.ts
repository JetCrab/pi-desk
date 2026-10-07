import { z } from 'zod'

const text = z.string().max(64 * 1024)
const base = z.object({
  id: z.string().uuid(),
  title: text,
  expiresAt: z.number().int().nonnegative().nullable()
})

export const L4PiUiRequestSchema = z.discriminatedUnion('method', [
  base.extend({ method: z.literal('confirm'), message: text }).strict(),
  base.extend({ method: z.literal('select'), options: z.array(text).max(200) }).strict(),
  base.extend({ method: z.literal('input'), placeholder: text }).strict(),
  base.extend({ method: z.literal('editor'), prefill: text }).strict()
])

export const L4PiUiSnapshotSchema = z
  .object({
    requests: z.array(L4PiUiRequestSchema).max(32),
    statuses: z.record(z.string().max(128), text),
    widgets: z.record(
      z.string().max(128),
      z
        .object({
          lines: z.array(text).max(200),
          placement: z.enum(['aboveEditor', 'belowEditor'])
        })
        .strict()
    )
  })
  .strict()

export const L4PiUiResponseSchema = z
  .object({
    id: z.string().uuid(),
    value: z.union([z.boolean(), text, z.null()])
  })
  .strict()

export const L4PiUiEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), snapshot: L4PiUiSnapshotSchema }).strict(),
  z
    .object({
      type: z.literal('notify'),
      message: text,
      level: z.enum(['info', 'warning', 'error'])
    })
    .strict(),
  z.object({ type: z.literal('editor_text'), text, mode: z.enum(['replace', 'paste']) }).strict()
])

export type L4PiUiRequest = z.infer<typeof L4PiUiRequestSchema>
export type L4PiUiSnapshot = z.infer<typeof L4PiUiSnapshotSchema>
export type L4PiUiResponse = z.infer<typeof L4PiUiResponseSchema>
export type L4PiUiEvent = z.infer<typeof L4PiUiEventSchema>

export function emptyL4PiUiSnapshot(): L4PiUiSnapshot {
  return { requests: [], statuses: {}, widgets: {} }
}
