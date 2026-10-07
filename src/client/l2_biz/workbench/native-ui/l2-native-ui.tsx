'use client'

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { L2ChatSource } from '@common/l2_biz/chat/l2-chat-contract'
import { useL4AppToast } from '@client/l4_foundation/ui/l4-app-toast'
import type { L2WorkbenchChatInputRuntime } from '../l2-workbench-chat-input-runtime'
import type { L2NativeUiBiz, L2NativeUiState } from './l2-native-ui-biz'

export interface L2NativeUiModel {
  state: L2NativeUiState
  canStop: boolean
  setAnswer(id: string, value: string): void
  setCollapsed(value: boolean): void
  answer(id: string, value: string | boolean | null): void
  refresh(): void
  dismissError(): void
  dismissNotices(): void
  usePrefill(mode: 'append' | 'replace' | 'dismiss'): void
  stop(): void
}

export function useL2NativeUi(
  source: L2ChatSource,
  biz: L2NativeUiBiz,
  input: L2WorkbenchChatInputRuntime,
  canStop: boolean
): L2NativeUiModel {
  const toast = useL4AppToast()
  const getSnapshot = useCallback(() => biz.getState(source), [biz, source])
  const state = useSyncExternalStore(biz.subscribe, getSnapshot, getSnapshot)
  const getInput = useCallback(() => input.getState(source), [input, source])
  const draft = useSyncExternalStore(input.subscribe, getInput, getInput)

  useEffect(() => {
    biz.watch(source)
  }, [biz, source])
  useEffect(
    () =>
      biz.onNotice((origin, event) => {
        if (
          origin.workId === source.workId &&
          origin.sessionId === source.sessionId &&
          origin.branchId === source.branchId
        ) {
          toast.show({ level: event.level, title: event.message })
        }
      }),
    [biz, source, toast]
  )

  useEffect(() => {
    if (!state.prefill || !draft.loaded || draft.loading || draft.outbox || draft.text.length > 0)
      return
    input.setText(source, state.prefill.text)
    biz.edit(source, { prefill: null })
  }, [biz, source, input, state.prefill, draft.loaded, draft.loading, draft.outbox, draft.text])

  return {
    state,
    canStop,
    setAnswer: (id, value) =>
      biz.edit(source, { answers: { ...biz.getState(source).answers, [id]: value } }),
    setCollapsed: (value) => biz.edit(source, { collapsed: value }),
    answer: (id, value) => {
      void biz.respond(source, { id, value })
    },
    refresh: () => {
      void biz.refreshSource(source)
    },
    dismissError: () => biz.edit(source, { error: null }),
    dismissNotices: () => biz.edit(source, { notices: [] }),
    usePrefill: (mode) => {
      const prefill = biz.getState(source).prefill
      if (!prefill) return
      if (mode !== 'dismiss') {
        const text = input.getState(source).text
        input.setText(
          source,
          mode === 'replace' ? prefill.text : `${text}${text ? '\n' : ''}${prefill.text}`
        )
      }
      biz.edit(source, { prefill: null })
    },
    stop: () => {
      void input
        .interrupt(source)
        .catch((cause: unknown) =>
          toast.error(cause instanceof Error ? cause.message : String(cause))
        )
    }
  }
}
