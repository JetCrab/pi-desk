'use client'

import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { L2WorkSessionListItem } from '@common/l2_biz/work-session/l2-work-session-contract'
import { copyL4BrowserText } from '@client/l4_foundation/lib/l4-browser-clipboard'
import { useL4AppToast } from '@client/l4_foundation/ui/l4-app-toast'
import type { L2WorkbenchChatRuntime } from '../l2-workbench-chat'

export function useL2WorkbenchInitializationIssue(
  workSession: L2WorkSessionListItem,
  chatRuntime: L2WorkbenchChatRuntime
): {
  error: string | null
  copied: boolean
  reloading: boolean
  canReload: boolean
  onCopy: () => void
  onReload: () => void
} {
  const { t } = useTranslation('workbench')
  const toast = useL4AppToast()
  const source = useMemo(
    () => ({
      workId: workSession.workId,
      sessionId: workSession.sessionId,
      branchId: workSession.branchId
    }),
    [workSession.workId, workSession.sessionId, workSession.branchId]
  )
  const getRuntime = useCallback(
    () => chatRuntime.getSourceState(source).runtime,
    [chatRuntime, source]
  )
  const runtime = useSyncExternalStore(chatRuntime.subscribe, getRuntime, getRuntime)
  const getSyncStatus = useCallback(
    () => chatRuntime.getSourceState(source).syncStatus,
    [chatRuntime, source]
  )
  const syncStatus = useSyncExternalStore(chatRuntime.subscribe, getSyncStatus, getSyncStatus)
  const error = runtime.extensionMode === 'basic' ? runtime.initializationError : null
  const [copiedText, setCopiedText] = useState<string | null>(null)
  const [reloading, setReloading] = useState(false)
  const canReload =
    !reloading &&
    syncStatus === 'ready' &&
    workSession.status !== 'main_running' &&
    workSession.status !== 'background_running'
  const diagnostic = error ? `${workSession.cwd}\n${source.sessionId}\n\n${error}` : ''

  const onCopy = (): void => {
    if (!diagnostic) return
    void copyL4BrowserText(diagnostic).then((success) => {
      if (success) setCopiedText(diagnostic)
      else toast.error(t('initializationCopyFailed'))
    })
  }

  const onReload = (): void => {
    if (!canReload) return
    setReloading(true)
    void chatRuntime
      .reload(source)
      .catch((cause: unknown) => {
        toast.error(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => setReloading(false))
  }

  return {
    error,
    copied: diagnostic !== '' && copiedText === diagnostic,
    reloading,
    canReload,
    onCopy,
    onReload
  }
}
