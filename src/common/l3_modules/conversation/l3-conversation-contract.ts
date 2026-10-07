import { z } from 'zod'
import { L3PiEntryIdSchema } from '@common/l3_modules/pi/l3-pi-contract'
import { L4ProjectFilePreviewPathSchema } from '@common/l4_foundation/file/l4-project-file-contract'
import { L4TimestampMsSchema } from '@common/l4_foundation/l4-timestamp-contract'
import { parseL3ConversationIncrementPath } from './l3-conversation-increment-path'

export const L3ConversationTempIdSchema = z.string().uuid()
export const L3ConversationMessageIndexSchema = z.number().int().nonnegative()
export const L3ConversationViewKeySchema = z
  .string()
  .trim()
  .min(3)
  .max(129)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/)

export const L3ConversationImageMimeTypeSchema = z.enum([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif'
])

export const L3ConversationImageMetadataSchema = z
  .object({
    mimeType: L3ConversationImageMimeTypeSchema,
    width: z.number().int().positive(),
    height: z.number().int().positive()
  })
  .strict()

export const L3ConversationAssistantStatusSchema = z.enum([
  'running',
  'completed',
  'error',
  'aborted'
])
export const L3ConversationToolStatusSchema = z.enum(['running', 'completed', 'error'])
export const L3ConversationBashStatusSchema = L3ConversationAssistantStatusSchema

const L3ConversationTokenCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const L3ConversationMessageUsageSchema = z
  .object({
    inputTokens: L3ConversationTokenCountSchema,
    outputTokens: L3ConversationTokenCountSchema,
    cacheReadTokens: L3ConversationTokenCountSchema,
    costUsd: z.number().finite().nonnegative()
  })
  .strict()

const L3ConversationToolDisplayTextSchema = z.string().trim().min(1).nullable()

export const L3ConversationTemporaryMessageLocationSchema = z
  .object({ tempId: L3ConversationTempIdSchema })
  .strict()

export const L3ConversationDurableMessageLocationSchema = z
  .object({
    index: L3ConversationMessageIndexSchema,
    entryId: L3PiEntryIdSchema
  })
  .strict()

export const L3ConversationUserFixedSchema = z
  .object({
    timestampMs: L4TimestampMsSchema.nullable(),
    type: z.literal('user'),
    viewKey: L3ConversationViewKeySchema,
    hasDetail: z.boolean()
  })
  .strict()

export const L3ConversationAssistantFixedSchema = z
  .object({
    timestampMs: L4TimestampMsSchema.nullable(),
    type: z.literal('assistant'),
    viewKey: L3ConversationViewKeySchema,
    status: L3ConversationAssistantStatusSchema,
    hasDetail: z.boolean(),
    usage: L3ConversationMessageUsageSchema
  })
  .strict()

export const L3ConversationToolFixedSchema = z
  .object({
    timestampMs: L4TimestampMsSchema.nullable(),
    type: z.literal('tool'),
    viewKey: L3ConversationViewKeySchema,
    status: L3ConversationToolStatusSchema,
    hasDetail: z.boolean(),
    usage: L3ConversationMessageUsageSchema.nullable()
  })
  .strict()

export const L3ConversationBashFixedSchema = z
  .object({
    timestampMs: L4TimestampMsSchema.nullable(),
    type: z.literal('bash'),
    viewKey: L3ConversationViewKeySchema,
    status: L3ConversationBashStatusSchema,
    hasDetail: z.boolean()
  })
  .strict()

export const L3ConversationCustomFixedSchema = z
  .object({
    timestampMs: L4TimestampMsSchema.nullable(),
    type: z.literal('custom'),
    viewKey: L3ConversationViewKeySchema,
    hasDetail: z.boolean()
  })
  .strict()

export const L3ConversationMessageFixedSchema = z.discriminatedUnion('type', [
  L3ConversationUserFixedSchema,
  L3ConversationAssistantFixedSchema,
  L3ConversationToolFixedSchema,
  L3ConversationBashFixedSchema,
  L3ConversationCustomFixedSchema
])

function messageFixedSchemas<TTimestamp extends z.ZodType>(timestampMs: TTimestamp) {
  const user = L3ConversationUserFixedSchema.extend({ timestampMs }).strict()
  const assistant = L3ConversationAssistantFixedSchema.extend({ timestampMs }).strict()
  const tool = L3ConversationToolFixedSchema.extend({ timestampMs }).strict()
  const bash = L3ConversationBashFixedSchema.extend({ timestampMs }).strict()
  const custom = L3ConversationCustomFixedSchema.extend({ timestampMs }).strict()
  return {
    user,
    assistant,
    tool,
    bash,
    custom,
    message: z.discriminatedUnion('type', [user, assistant, tool, bash, custom])
  }
}

export const L3ConversationTemporaryMessageFixedSchema = messageFixedSchemas(z.null()).message
export const L3ConversationDurableMessageFixedSchema =
  messageFixedSchemas(L4TimestampMsSchema).message

export const L3ConversationUserSummarySchema = z
  .object({
    text: z.string(),
    images: z.array(L3ConversationImageMetadataSchema)
  })
  .strict()
export const L3ConversationAssistantModelSchema = z
  .object({ provider: z.string(), modelId: z.string() })
  .strict()
export const L3ConversationAssistantSummarySchema = z
  .object({
    text: z.string(),
    errorMessage: z.string().nullable().default(null),
    model: L3ConversationAssistantModelSchema.nullable().optional()
  })
  .strict()
const L3ConversationToolSummaryFields = {
  name: z.string().trim().min(1),
  reasoning: L3ConversationToolDisplayTextSchema,
  inputPreview: L3ConversationToolDisplayTextSchema,
  activity: L3ConversationToolDisplayTextSchema
}

function fileToolSummarySchema() {
  return z
    .object({
      ...L3ConversationToolSummaryFields,
      path: L4ProjectFilePreviewPathSchema.nullable()
    })
    .strict()
}

export const L3ConversationGenericToolSummarySchema = z
  .object({
    ...L3ConversationToolSummaryFields,
    images: z.array(L3ConversationImageMetadataSchema).optional()
  })
  .strict()
export const L3ConversationCodemodeSummarySchema = L3ConversationGenericToolSummarySchema
export const L3ConversationBashToolTimingSchema = z.union([
  z.object({ startedAtMs: L4TimestampMsSchema }).strict(),
  z.object({ durationMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict()
])
export const L3ConversationBashToolSummarySchema = z
  .object({
    ...L3ConversationToolSummaryFields,
    timing: L3ConversationBashToolTimingSchema.nullable()
  })
  .strict()
export const L3ConversationReadSummarySchema = fileToolSummarySchema()
  .extend({
    images: z.array(L3ConversationImageMetadataSchema).optional()
  })
  .strict()
export const L3ConversationEditSummarySchema = fileToolSummarySchema()
export const L3ConversationWriteSummarySchema = fileToolSummarySchema()
export const L3ConversationBashSummarySchema = z.object({ command: z.string().min(1) }).strict()
export const L3ConversationCustomSummarySchema = z.object({ text: z.string() }).strict()

export const L3ConversationAssistantDetailSchema = z.object({ thinking: z.string() }).strict()
export const L3ConversationCodemodeNestedCallsSchema = z
  .object({
    complete: z.boolean(),
    calls: z.array(
      z
        .object({
          name: z.string(),
          arguments: z.record(z.string(), z.json()).optional(),
          argumentsBytes: z.number().int().nonnegative().optional(),
          status: z.enum(['ok', 'error', 'unfinished']),
          durationMs: z.number().finite().nonnegative().optional(),
          error: z.string().optional()
        })
        .strict()
    )
  })
  .strict()
export const L3ConversationCodemodeDetailSchema = z
  .object({
    output: z.string(),
    nestedCalls: L3ConversationCodemodeNestedCallsSchema.optional()
  })
  .strict()
export const L3ConversationGenericToolDetailSchema = z.object({ output: z.string() }).strict()
export const L3ConversationReadDetailSchema = z.object({ content: z.string() }).strict()
export const L3ConversationEditDetailSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('diff'), content: z.string() }).strict(),
  z.object({ kind: z.literal('output'), content: z.string() }).strict()
])
export const L3ConversationWriteDetailSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('content'), content: z.string() }).strict(),
  z.object({ kind: z.literal('output'), content: z.string() }).strict()
])
export const L3ConversationBashDetailSchema = z.object({ output: z.string() }).strict()
export const L3ConversationCompactionDetailSchema = z.object({ text: z.string().min(1) }).strict()

export const L3ConversationMessageSummarySchema = z.record(z.string(), z.json())
export const L3ConversationMessageDetailObjectSchema = z.record(z.string(), z.json())
export const L3ConversationMessageDetailSchema = z.union([
  L3ConversationMessageDetailObjectSchema,
  z.null()
])

function messageSnapshotSchema<TLocation extends z.ZodType, TTimestamp extends z.ZodType>(
  location: TLocation,
  timestampMs: TTimestamp
) {
  return z
    .object({
      location,
      fixed: messageFixedSchemas(timestampMs).message,
      summary: L3ConversationMessageSummarySchema,
      detail: L3ConversationMessageDetailObjectSchema.optional()
    })
    .strict()
    .superRefine((snapshot, context) => {
      if (snapshot.detail !== undefined && !snapshot.fixed.hasDetail) {
        context.addIssue({
          code: 'custom',
          message: 'message detail requires hasDetail=true',
          path: ['detail']
        })
      }
    })
}

export const L3ConversationTemporaryMessageSnapshotSchema = messageSnapshotSchema(
  L3ConversationTemporaryMessageLocationSchema,
  z.null()
)
export const L3ConversationDurableMessageSnapshotSchema = messageSnapshotSchema(
  L3ConversationDurableMessageLocationSchema,
  L4TimestampMsSchema
)

function requireChangedField(value: object, context: z.RefinementCtx): void {
  if (Object.keys(value).length === 0) {
    context.addIssue({ code: 'custom', message: 'patch requires at least one changed field' })
  }
}

export const L3ConversationMessageFixedPatchSchema = z
  .object({
    viewKey: L3ConversationViewKeySchema.optional(),
    status: z
      .union([L3ConversationAssistantStatusSchema, L3ConversationToolStatusSchema])
      .optional(),
    hasDetail: z.boolean().optional(),
    usage: L3ConversationMessageUsageSchema.nullable().optional()
  })
  .strict()
  .superRefine(requireChangedField)

export const L3ConversationMessageSummaryPatchSchema = z
  .record(z.string(), z.json())
  .superRefine(requireChangedField)
export const L3ConversationMessageDetailPatchSchema = z
  .record(z.string(), z.json())
  .superRefine(requireChangedField)

const L3ConversationIncrementValueSchema = z.union([z.string().min(1), z.array(z.json()).min(1)])

export const L3ConversationMessageIncrementsSchema = z
  .record(z.string(), L3ConversationIncrementValueSchema)
  .superRefine((value, context) => {
    requireChangedField(value, context)
    for (const path of Object.keys(value)) {
      try {
        parseL3ConversationIncrementPath(path)
      } catch (error) {
        context.addIssue({
          code: 'custom',
          message: error instanceof Error ? error.message : 'increment path is invalid',
          path: [path]
        })
      }
    }
  })

export const L3ConversationStateSchema = z
  .object({
    messages: z.array(L3ConversationDurableMessageSnapshotSchema),
    temporaryMessages: z.array(L3ConversationTemporaryMessageSnapshotSchema)
  })
  .strict()

export const L3ConversationMessageDetailResponseSchema = z
  .object({
    index: L3ConversationMessageIndexSchema,
    entryId: L3PiEntryIdSchema,
    detail: L3ConversationMessageDetailSchema
  })
  .strict()

export const L3ConversationImageGetResponseSchema = z
  .object({
    mimeType: L3ConversationImageMimeTypeSchema,
    data: z.string().min(1)
  })
  .strict()

export type L3ConversationImageMimeType = z.infer<typeof L3ConversationImageMimeTypeSchema>
export type L3ConversationImageMetadata = z.infer<typeof L3ConversationImageMetadataSchema>
export type L3ConversationTemporaryMessageLocation = z.infer<
  typeof L3ConversationTemporaryMessageLocationSchema
>
export type L3ConversationDurableMessageLocation = z.infer<
  typeof L3ConversationDurableMessageLocationSchema
>
export type L3ConversationMessageUsage = z.infer<typeof L3ConversationMessageUsageSchema>
export type L3ConversationBashToolTiming = z.infer<typeof L3ConversationBashToolTimingSchema>
export type L3ConversationMessageFixed = z.infer<typeof L3ConversationMessageFixedSchema>
export type L3ConversationMessageSummary = z.infer<typeof L3ConversationMessageSummarySchema>
export type L3ConversationMessageDetailObject = z.infer<
  typeof L3ConversationMessageDetailObjectSchema
>
export type L3ConversationMessageDetail = z.infer<typeof L3ConversationMessageDetailSchema>
export type L3ConversationTemporaryMessageSnapshot = z.infer<
  typeof L3ConversationTemporaryMessageSnapshotSchema
>
export type L3ConversationDurableMessageSnapshot = z.infer<
  typeof L3ConversationDurableMessageSnapshotSchema
>
export type L3ConversationMessageFixedPatch = z.infer<typeof L3ConversationMessageFixedPatchSchema>
export type L3ConversationMessageSummaryPatch = z.infer<
  typeof L3ConversationMessageSummaryPatchSchema
>
export type L3ConversationMessageDetailPatch = z.infer<
  typeof L3ConversationMessageDetailPatchSchema
>
export type L3ConversationMessageIncrements = z.infer<typeof L3ConversationMessageIncrementsSchema>
export type L3ConversationState = z.infer<typeof L3ConversationStateSchema>
export type L3ConversationMessageDetailResponse = z.infer<
  typeof L3ConversationMessageDetailResponseSchema
>
export type L3ConversationImageGetResponse = z.infer<typeof L3ConversationImageGetResponseSchema>
