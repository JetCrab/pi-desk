'use client'

import { memo, useCallback, useMemo, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { L2ChatSourceSchema, type L2ChatSource } from '@common/l2_biz/chat/l2-chat-contract'
import type { L2WorkSessionListItem } from '@common/l2_biz/work-session/l2-work-session-contract'
import {
  Conversation,
  ConversationContent
} from '@client/l4_foundation/ui/ai-elements/conversation'
import { buildL3ConversationTurns } from '@client/l3_modules/conversation/l3-conversation-display'
import { L3ConversationProgressiveWindow } from '@client/l3_modules/conversation/l3-conversation-progressive-window'
import { L3ConversationTailSpacerObserver } from '@client/l3_modules/conversation/l3-conversation-viewport'
import {
  L3ConversationPresentationProvider,
  L3ConversationStickToBottomBridge,
  L3ConversationTurnView,
  type L3ConversationAcquireImage,
  type L3ConversationLoadDetail
} from '@client/l3_modules/conversation/l3-conversation-messages'
import type { L2WorkbenchChatRuntime, L2WorkbenchChatViewportSnapshot } from './l2-workbench-chat'
import { L2WorkbenchChatWelcome } from './l2-workbench-chat-welcome'
import type { L2WorkbenchChatInputRuntime } from './l2-workbench-chat-input-runtime'
import { L2WorkbenchChatNavigation } from './hooks/l2-workbench-chat-navigation'
import { L2WorkbenchChatViewportManager } from './hooks/l2-workbench-chat-viewport'

interface L2WorkbenchChatViewProps {
  visible: boolean
  workSession: L2WorkSessionListItem
  chatRuntime: L2WorkbenchChatRuntime
  inputRuntime: L2WorkbenchChatInputRuntime
  onPreviewFile: (source: L2ChatSource, path: string) => void
}

function L2WorkbenchChatViewComponent({
  visible,
  workSession,
  chatRuntime,
  inputRuntime,
  onPreviewFile
}: L2WorkbenchChatViewProps): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const source = useMemo(
    () =>
      L2ChatSourceSchema.parse({
        workId: workSession.workId,
        sessionId: workSession.sessionId,
        branchId: workSession.branchId
      }),
    [workSession.branchId, workSession.sessionId, workSession.workId]
  )
  const entrySnapshot = useMemo(
    () => chatRuntime.getViewportSnapshot(source),
    [chatRuntime, source]
  )
  const getSnapshot = useCallback(() => chatRuntime.getSourceState(source), [chatRuntime, source])
  const state = useSyncExternalStore(chatRuntime.subscribe, getSnapshot, getSnapshot)
  // 异步任务仍是当前轮次的延续，不能只用 main_running 判断处理过程结束。
  const running =
    workSession.status === 'main_running' || workSession.status === 'background_running'
  const turns = useMemo(
    () =>
      buildL3ConversationTurns(
        { messages: state.messages, temporaryMessages: state.temporaryMessages },
        running
      ),
    [running, state.messages, state.temporaryMessages]
  )
  const hasMessages = state.messages.length > 0 || state.temporaryMessages.length > 0
  const hasUserMessage =
    state.messages.some((message) => message.fixed.type === 'user') ||
    state.temporaryMessages.some((message) => message.fixed.type === 'user')
  // 首条临时消息先于 WorkSession running 推送，视口需在消息出现时立即进入吸底。
  const viewportRunning = running || state.temporaryMessages.length > 0
  const latestUserTurn = turns.findLast((turn) => turn.user !== null) ?? null
  const latestUser = latestUserTurn?.user ?? null
  const latestUserAnchor = latestUser ? `${latestUser.identity}:user` : null

  const loadDetail = useCallback<L3ConversationLoadDetail>(
    async (message) => {
      if (!message.durable) return null
      if (message.detail !== undefined) return message.detail
      return chatRuntime.loadMessageDetail(
        source,
        message.durable.location.index,
        message.durable.location.entryId
      )
    },
    [chatRuntime, source]
  )
  const acquireImage = useCallback<L3ConversationAcquireImage>(
    (message, imageIndex) =>
      inputRuntime.acquireMessageImage({
        source,
        tempId: message.tempId,
        entryId: message.durable?.location.entryId ?? null,
        imageIndex
      }),
    [inputRuntime, source]
  )
  const previewFile = useCallback(
    (path: string): void => onPreviewFile(source, path),
    [onPreviewFile, source]
  )
  const saveViewportSnapshot = useCallback(
    (snapshot: L2WorkbenchChatViewportSnapshot): void => {
      chatRuntime.saveViewportSnapshot(source, snapshot)
    },
    [chatRuntime, source]
  )
  const clearViewportSnapshot = useCallback((): void => {
    chatRuntime.clearViewportSnapshot(source)
  }, [chatRuntime, source])
  const recoverPresentation = useCallback(
    (): Promise<void> => chatRuntime.setPresentation(source, 'basic'),
    [chatRuntime, source]
  )

  return (
    <L3ConversationPresentationProvider
      basic={state.runtime.presentationMode === 'basic'}
      onRecover={recoverPresentation}
    >
      <Conversation
        className="min-h-0"
        initial={false}
        resize="instant"
        aria-label={t('chatMessages', {
          name: workSession.sessionTitle ?? workSession.projectName
        })}
      >
        <L3ConversationProgressiveWindow
          key={`window:${source.sessionId}:${source.branchId}`}
          turns={turns}
          active={visible}
          focusTurnIdentity={latestUserTurn?.identity ?? null}
          initialAnchor={entrySnapshot?.messageId ?? null}
        >
          {(turnWindow) => (
            <>
              <L2WorkbenchChatViewportManager
                key={`viewport:${source.sessionId}:${source.branchId}`}
                visible={visible}
                running={viewportRunning}
                ready={hasMessages}
                containsTail={turnWindow.containsTail}
                latestUserAnchor={latestUserAnchor}
                entrySnapshot={entrySnapshot}
                onSaveSnapshot={saveViewportSnapshot}
                onClearSnapshot={clearViewportSnapshot}
              />
              <L3ConversationTailSpacerObserver active={visible} />
              <L3ConversationStickToBottomBridge>
                <ConversationContent
                  scrollClassName="pi-desk-chat-scrollbar pi-desk-chat-conversation-scroll"
                  className="mx-auto min-h-full w-full max-w-3xl gap-6 px-3 pt-3 pb-4 sm:px-5"
                >
                  {turnWindow.visibleTurns.map((turn, index) => {
                    const turnIndex = turnWindow.startIndex + index
                    return (
                      <L3ConversationTurnView
                        key={turn.identity}
                        turn={turn}
                        cwd={workSession.cwd}
                        logicalTail={turnWindow.containsTail && turnIndex === turns.length - 1}
                        onLoadDetail={loadDetail}
                        onAcquireImage={acquireImage}
                        onPreviewFile={previewFile}
                      />
                    )
                  })}
                </ConversationContent>
              </L3ConversationStickToBottomBridge>
              <L2WorkbenchChatNavigation
                key={`navigation:${source.sessionId}:${source.branchId}`}
                active={visible}
                turns={turns}
                window={turnWindow}
              />
            </>
          )}
        </L3ConversationProgressiveWindow>
        <L2WorkbenchChatWelcome
          active={visible}
          ready={state.syncStatus === 'ready'}
          empty={!hasMessages}
          hasUserMessage={hasUserMessage}
        />
      </Conversation>
    </L3ConversationPresentationProvider>
  )
}

export const L2WorkbenchChatView = memo(L2WorkbenchChatViewComponent)

L2WorkbenchChatView.displayName = 'L2WorkbenchChatView'
