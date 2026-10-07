import 'server-only'

import type {
  L3ConversationDurableMessageSnapshot,
  L3ConversationTemporaryMessageSnapshot
} from '@common/l3_modules/conversation/l3-conversation-contract'
import type { PluginMessageDeclarationInput, PluginSource } from '@jetcrab/pi-desk-sdk/entry'
import type { L4PiChatMessage } from '@server/l4_foundation/pi/l4-pi-chat-projection'
import { getL4PiGlobalPluginRuntime } from '@server/l4_foundation/pi/l4-pi-global-plugin-runtime'
import {
  projectL3ConversationDurableMessageCore,
  projectL3ConversationTemporaryMessageCore
} from './l3-conversation-projection-core'

export { buildL3ConversationMessageUpdate } from '@common/l3_modules/conversation/l3-conversation-diff'

export function projectL3ConversationTemporaryMessage(
  tempId: string,
  message: L4PiChatMessage,
  source: PluginSource,
  includeDeferredDetail = false,
  stage: PluginMessageDeclarationInput['stage'] = 'temporary',
  basic = false
): L3ConversationTemporaryMessageSnapshot {
  return projectL3ConversationTemporaryMessageCore(
    tempId,
    message,
    source,
    basic ? [] : getL4PiGlobalPluginRuntime().readMessageDeclarations(),
    includeDeferredDetail,
    stage
  )
}

export function projectL3ConversationDurableMessage(
  index: number,
  entryId: string,
  timestampMs: number,
  message: L4PiChatMessage,
  source: PluginSource,
  basic = false
): L3ConversationDurableMessageSnapshot {
  return projectL3ConversationDurableMessageCore(
    index,
    entryId,
    timestampMs,
    message,
    source,
    basic ? [] : getL4PiGlobalPluginRuntime().readMessageDeclarations()
  )
}

export function withoutL3ConversationMessageDetail(
  message: L3ConversationDurableMessageSnapshot
): L3ConversationDurableMessageSnapshot {
  const { detail: _detail, ...snapshot } = message
  return snapshot
}
