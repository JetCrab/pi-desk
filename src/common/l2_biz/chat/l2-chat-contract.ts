import { z } from 'zod'
import { L3CapabilityModeKeySchema } from '@common/l3_modules/capability-modes/l3-capability-modes-contract'
import {
  L2PiEntryIdSchema,
  L2PiSessionIdSchema,
  L2WorkSessionBranchIdSchema
} from '@common/l2_biz/work-session/l2-work-session-contract'
import {
  L3ConversationAssistantDetailSchema,
  L3ConversationAssistantFixedSchema,
  L3ConversationAssistantStatusSchema,
  L3ConversationAssistantSummarySchema,
  L3ConversationBashDetailSchema,
  L3ConversationBashFixedSchema,
  L3ConversationBashStatusSchema,
  L3ConversationBashSummarySchema,
  L3ConversationBashToolSummarySchema,
  L3ConversationBashToolTimingSchema,
  L3ConversationCustomFixedSchema,
  L3ConversationCustomSummarySchema,
  L3ConversationDurableMessageFixedSchema,
  L3ConversationEditDetailSchema,
  L3ConversationEditSummarySchema,
  L3ConversationGenericToolDetailSchema,
  L3ConversationGenericToolSummarySchema,
  L3ConversationDurableMessageLocationSchema,
  L3ConversationDurableMessageSnapshotSchema,
  L3ConversationImageGetResponseSchema,
  L3ConversationImageMetadataSchema,
  L3ConversationImageMimeTypeSchema,
  L3ConversationMessageDetailPatchSchema,
  L3ConversationMessageDetailResponseSchema,
  L3ConversationMessageDetailSchema,
  L3ConversationMessageFixedPatchSchema,
  L3ConversationMessageFixedSchema,
  L3ConversationMessageIncrementsSchema,
  L3ConversationMessageIndexSchema,
  L3ConversationMessageSummaryPatchSchema,
  L3ConversationMessageSummarySchema,
  L3ConversationMessageUsageSchema,
  L3ConversationStateSchema,
  L3ConversationTempIdSchema,
  L3ConversationTemporaryMessageFixedSchema,
  L3ConversationTemporaryMessageLocationSchema,
  L3ConversationTemporaryMessageSnapshotSchema,
  L3ConversationReadDetailSchema,
  L3ConversationReadSummarySchema,
  L3ConversationToolFixedSchema,
  L3ConversationToolStatusSchema,
  L3ConversationUserFixedSchema,
  L3ConversationWriteDetailSchema,
  L3ConversationWriteSummarySchema,
  L3ConversationUserSummarySchema,
  type L3ConversationDurableMessageLocation,
  type L3ConversationDurableMessageSnapshot,
  type L3ConversationImageMetadata,
  type L3ConversationImageMimeType,
  type L3ConversationMessageDetail,
  type L3ConversationMessageDetailPatch,
  type L3ConversationMessageFixed,
  type L3ConversationMessageFixedPatch,
  type L3ConversationMessageIncrements,
  type L3ConversationMessageSummary,
  type L3ConversationMessageSummaryPatch,
  type L3ConversationMessageUsage,
  type L3ConversationTemporaryMessageLocation,
  type L3ConversationTemporaryMessageSnapshot
} from '@common/l3_modules/conversation/l3-conversation-contract'
import { L3PiModelThinkingLevelSchema } from '@common/l3_modules/pi-model/l3-pi-model-contract'
import {
  L3WorkSessionSourceSchema,
  type L3WorkSessionSource
} from '@common/l3_modules/work-session/l3-work-session-source-contract'

export const L2ChatTempIdSchema = L3ConversationTempIdSchema
export const L2ChatMessageIndexSchema = L3ConversationMessageIndexSchema
export const L2ChatImageMimeTypeSchema = L3ConversationImageMimeTypeSchema
export const L2ChatImageMetadataSchema = L3ConversationImageMetadataSchema
export const L2ChatAssistantStatusSchema = L3ConversationAssistantStatusSchema
export const L2ChatToolStatusSchema = L3ConversationToolStatusSchema
export const L2ChatBashStatusSchema = L3ConversationBashStatusSchema
export const L2ChatMessageUsageSchema = L3ConversationMessageUsageSchema
export const L2ChatTemporaryMessageLocationSchema = L3ConversationTemporaryMessageLocationSchema
export const L2ChatDurableMessageLocationSchema = L3ConversationDurableMessageLocationSchema
export const L2ChatUserFixedSchema = L3ConversationUserFixedSchema
export const L2ChatAssistantFixedSchema = L3ConversationAssistantFixedSchema
export const L2ChatToolFixedSchema = L3ConversationToolFixedSchema
export const L2ChatBashFixedSchema = L3ConversationBashFixedSchema
export const L2ChatCustomFixedSchema = L3ConversationCustomFixedSchema
export const L2ChatMessageFixedSchema = L3ConversationMessageFixedSchema
export const L2ChatTemporaryMessageFixedSchema = L3ConversationTemporaryMessageFixedSchema
export const L2ChatDurableMessageFixedSchema = L3ConversationDurableMessageFixedSchema
export const L2ChatUserSummarySchema = L3ConversationUserSummarySchema
export const L2ChatAssistantSummarySchema = L3ConversationAssistantSummarySchema
export const L2ChatGenericToolSummarySchema = L3ConversationGenericToolSummarySchema
export const L2ChatBashToolTimingSchema = L3ConversationBashToolTimingSchema
export const L2ChatBashToolSummarySchema = L3ConversationBashToolSummarySchema
export const L2ChatReadSummarySchema = L3ConversationReadSummarySchema
export const L2ChatEditSummarySchema = L3ConversationEditSummarySchema
export const L2ChatWriteSummarySchema = L3ConversationWriteSummarySchema
export const L2ChatBashSummarySchema = L3ConversationBashSummarySchema
export const L2ChatCustomSummarySchema = L3ConversationCustomSummarySchema
export const L2ChatMessageSummarySchema = L3ConversationMessageSummarySchema
export const L2ChatAssistantDetailSchema = L3ConversationAssistantDetailSchema
export const L2ChatGenericToolDetailSchema = L3ConversationGenericToolDetailSchema
export const L2ChatReadDetailSchema = L3ConversationReadDetailSchema
export const L2ChatEditDetailSchema = L3ConversationEditDetailSchema
export const L2ChatWriteDetailSchema = L3ConversationWriteDetailSchema
export const L2ChatBashDetailSchema = L3ConversationBashDetailSchema
export const L2ChatMessageDetailSchema = L3ConversationMessageDetailSchema
export const L2ChatTemporaryMessageSnapshotSchema = L3ConversationTemporaryMessageSnapshotSchema
export const L2ChatDurableMessageSnapshotSchema = L3ConversationDurableMessageSnapshotSchema
export const L2ChatMessageFixedPatchSchema = L3ConversationMessageFixedPatchSchema
export const L2ChatMessageSummaryPatchSchema = L3ConversationMessageSummaryPatchSchema
export const L2ChatMessageDetailPatchSchema = L3ConversationMessageDetailPatchSchema
export const L2ChatMessageIncrementsSchema = L3ConversationMessageIncrementsSchema

export const L2ChatSourceSchema = L3WorkSessionSourceSchema

export const L2ChatCursorPositionSchema = z
  .object({
    index: L2ChatMessageIndexSchema,
    entryId: L2PiEntryIdSchema
  })
  .strict()

export const L2ChatCursorSchema = z.union([z.null(), L2ChatCursorPositionSchema])

export const L2ChatInputImageSchema = L2ChatImageMetadataSchema.extend({
  data: z.string().min(1)
}).strict()

export const L2ChatModelThinkingLevelSchema = L3PiModelThinkingLevelSchema

export const L2ChatQueuedInputSchema = z
  .object({
    tempId: L2ChatTempIdSchema,
    text: z.string(),
    images: z.array(L2ChatImageMetadataSchema).max(10)
  })
  .strict()

export const L2ChatModelStateSchema = z
  .object({
    provider: z.string().trim().min(1),
    modelId: z.string().trim().min(1),
    thinkingLevel: L2ChatModelThinkingLevelSchema
  })
  .strict()

export const L2ChatContextUsageSchema = z
  .object({
    tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    contextWindow: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  })
  .strict()

const L2ChatRuntimePluginStateSchema = z.record(z.string(), z.json())
const L2ChatRuntimePluginsSchema = z.record(z.string().min(1), L2ChatRuntimePluginStateSchema)

export const L2ChatModeSchema = z.enum(['normal', 'basic'])

export const L2ChatRuntimeSchema = z
  .object({
    extensionMode: L2ChatModeSchema.default('normal'),
    presentationMode: L2ChatModeSchema.default('normal'),
    initializationError: z.string().max(32_000).nullable().default(null),
    queues: z
      .object({
        steering: z.array(L2ChatQueuedInputSchema),
        followUp: z.array(L2ChatQueuedInputSchema)
      })
      .strict(),
    model: L2ChatModelStateSchema.nullable(),
    capabilityMode: L3CapabilityModeKeySchema.nullable(),
    contextUsage: L2ChatContextUsageSchema.nullable(),
    plugins: L2ChatRuntimePluginsSchema
  })
  .strict()

export const L2ChatSourceStateSchema = L3ConversationStateSchema.extend({
  runtime: L2ChatRuntimeSchema
}).strict()

export const L2ChatMessageDetailRequestSchema = z
  .object({
    sessionId: L2PiSessionIdSchema,
    branchId: L2WorkSessionBranchIdSchema,
    entryId: L2PiEntryIdSchema
  })
  .strict()

export const L2ChatMessageDetailResponseSchema = L3ConversationMessageDetailResponseSchema
export const L2ChatImageGetRequestSchema = L2ChatMessageDetailRequestSchema.extend({
  imageIndex: z.number().int().nonnegative()
}).strict()
export const L2ChatImageGetResponseSchema = L3ConversationImageGetResponseSchema

export type L2ChatSource = L3WorkSessionSource
export type L2ChatCursor = z.infer<typeof L2ChatCursorSchema>
export type L2ChatInputImage = z.infer<typeof L2ChatInputImageSchema>
export type L2ChatModelThinkingLevel = z.infer<typeof L2ChatModelThinkingLevelSchema>
export type L2ChatQueuedInput = z.infer<typeof L2ChatQueuedInputSchema>
export type L2ChatModelState = z.infer<typeof L2ChatModelStateSchema>
export type L2ChatContextUsage = z.infer<typeof L2ChatContextUsageSchema>
export type L2ChatMode = z.infer<typeof L2ChatModeSchema>
export type L2ChatRuntime = z.infer<typeof L2ChatRuntimeSchema>
export type L2ChatSourceState = z.infer<typeof L2ChatSourceStateSchema>
export type L2ChatMessageDetailRequest = z.infer<typeof L2ChatMessageDetailRequestSchema>
export type L2ChatMessageDetailResponse = z.infer<typeof L2ChatMessageDetailResponseSchema>
export type L2ChatImageGetRequest = z.infer<typeof L2ChatImageGetRequestSchema>
export type L2ChatImageGetResponse = z.infer<typeof L2ChatImageGetResponseSchema>

export type L2ChatImageMimeType = L3ConversationImageMimeType
export type L2ChatImageMetadata = L3ConversationImageMetadata
export type L2ChatTemporaryMessageLocation = L3ConversationTemporaryMessageLocation
export type L2ChatDurableMessageLocation = L3ConversationDurableMessageLocation
export type L2ChatMessageUsage = L3ConversationMessageUsage
export type L2ChatMessageFixed = L3ConversationMessageFixed
export type L2ChatMessageSummary = L3ConversationMessageSummary
export type L2ChatMessageDetail = L3ConversationMessageDetail
export type L2ChatTemporaryMessageSnapshot = L3ConversationTemporaryMessageSnapshot
export type L2ChatDurableMessageSnapshot = L3ConversationDurableMessageSnapshot
export type L2ChatMessageFixedPatch = L3ConversationMessageFixedPatch
export type L2ChatMessageSummaryPatch = L3ConversationMessageSummaryPatch
export type L2ChatMessageDetailPatch = L3ConversationMessageDetailPatch
export type L2ChatMessageIncrements = L3ConversationMessageIncrements
