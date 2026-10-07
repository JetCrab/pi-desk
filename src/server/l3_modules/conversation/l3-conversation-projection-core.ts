import {
  L3ConversationDurableMessageSnapshotSchema,
  L3ConversationTemporaryMessageSnapshotSchema,
  type L3ConversationDurableMessageLocation,
  type L3ConversationDurableMessageSnapshot,
  type L3ConversationTemporaryMessageLocation,
  type L3ConversationTemporaryMessageSnapshot
} from '@common/l3_modules/conversation/l3-conversation-contract'
import type {
  PluginMessageDeclaration,
  PluginMessageDeclarationInput,
  PluginMessageProjectionResult,
  PluginSource
} from '@jetcrab/pi-desk-sdk/entry'
import type { L4PiChatMessage } from '@server/l4_foundation/pi/l4-pi-chat-projection'
import { projectL4PiMessageDeclarationCore } from '@server/l4_foundation/pi/l4-pi-message-declaration-core'

export interface L3ConversationProjectionDeclaration {
  pluginName: string
  declarationName: string
  declaration: PluginMessageDeclaration
}

function fixedLayer(
  timestampMs: number | null,
  message: L4PiChatMessage,
  projection: PluginMessageProjectionResult
): object {
  const common = {
    timestampMs,
    viewKey: projection.viewKey,
    hasDetail: projection.detail !== null
  }
  switch (message.type) {
    case 'user':
      return { ...common, type: 'user' as const }
    case 'assistant':
      return {
        ...common,
        type: 'assistant' as const,
        status: message.status,
        usage: message.usage
      }
    case 'tool':
      return {
        ...common,
        type: 'tool' as const,
        status: message.status,
        usage: message.usage
      }
    case 'bash':
      return { ...common, type: 'bash' as const, status: message.status }
    case 'custom':
    case 'compaction':
      return { ...common, type: 'custom' as const }
  }
}

function projectSnapshot(
  location: L3ConversationTemporaryMessageLocation,
  timestampMs: null,
  message: L4PiChatMessage,
  source: PluginSource,
  stage: PluginMessageDeclarationInput['stage'],
  includeDeferredDetail: boolean,
  declarations: readonly L3ConversationProjectionDeclaration[]
): L3ConversationTemporaryMessageSnapshot
function projectSnapshot(
  location: L3ConversationDurableMessageLocation,
  timestampMs: number,
  message: L4PiChatMessage,
  source: PluginSource,
  stage: PluginMessageDeclarationInput['stage'],
  includeDeferredDetail: boolean,
  declarations: readonly L3ConversationProjectionDeclaration[]
): L3ConversationDurableMessageSnapshot
function projectSnapshot(
  location: L3ConversationTemporaryMessageLocation | L3ConversationDurableMessageLocation,
  timestampMs: number | null,
  message: L4PiChatMessage,
  source: PluginSource,
  stage: PluginMessageDeclarationInput['stage'],
  includeDeferredDetail: boolean,
  declarations: readonly L3ConversationProjectionDeclaration[]
): L3ConversationTemporaryMessageSnapshot | L3ConversationDurableMessageSnapshot {
  const projection = projectL4PiMessageDeclarationCore({
    source,
    stage,
    message,
    declarations
  })
  const deferredDetail =
    message.type === 'tool' ||
    message.type === 'bash' ||
    message.type === 'custom' ||
    message.type === 'compaction'
  const transmitDetail = projection.detail !== null && (!deferredDetail || includeDeferredDetail)
  const snapshot = {
    location,
    fixed: fixedLayer(timestampMs, message, projection),
    summary: projection.summary,
    ...(transmitDetail ? { detail: projection.detail } : {})
  }
  return 'tempId' in location
    ? L3ConversationTemporaryMessageSnapshotSchema.parse(snapshot)
    : L3ConversationDurableMessageSnapshotSchema.parse(snapshot)
}

export function projectL3ConversationTemporaryMessageCore(
  tempId: string,
  message: L4PiChatMessage,
  source: PluginSource,
  declarations: readonly L3ConversationProjectionDeclaration[],
  includeDeferredDetail = false,
  stage: PluginMessageDeclarationInput['stage'] = 'temporary'
): L3ConversationTemporaryMessageSnapshot {
  return projectSnapshot(
    { tempId },
    null,
    message,
    source,
    stage,
    includeDeferredDetail,
    declarations
  )
}

export function projectL3ConversationDurableMessageCore(
  index: number,
  entryId: string,
  timestampMs: number,
  message: L4PiChatMessage,
  source: PluginSource,
  declarations: readonly L3ConversationProjectionDeclaration[]
): L3ConversationDurableMessageSnapshot {
  return projectSnapshot(
    { index, entryId },
    timestampMs,
    message,
    source,
    'durable',
    true,
    declarations
  )
}
