'use client'

import type { L3ConversationTurn } from '@client/l3_modules/conversation/l3-conversation-display'
import { L3ConversationNavigation } from '@client/l3_modules/conversation/l3-conversation-navigation'
import type { L3ConversationProgressiveWindowState } from '@client/l3_modules/conversation/l3-conversation-progressive-window'

export function L2WorkbenchChatNavigation({
  active,
  turns,
  window
}: {
  active: boolean
  turns: readonly L3ConversationTurn[]
  window: L3ConversationProgressiveWindowState
}): React.JSX.Element | null {
  return active ? <L3ConversationNavigation turns={turns} window={window} /> : null
}
