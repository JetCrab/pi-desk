'use client'

import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { L2WorkSessionListItem } from '@common/l2_biz/work-session/l2-work-session-contract'
import { useL4AppToast } from '@client/l4_foundation/ui/l4-app-toast'
import type { L2WorkbenchChatRuntime } from '../l2-workbench-chat'

export function useL2WorkbenchChatReload(
  runtime: L2WorkbenchChatRuntime,
  workSessions: readonly L2WorkSessionListItem[]
): {
  syncingWorkIds: readonly string[]
  reload: (workSession: L2WorkSessionListItem) => void
} {
  const { t } = useTranslation('workbench')
  const toast = useL4AppToast()
  const getSyncing = useCallback(
    (): string =>
      JSON.stringify(
        workSessions
          .filter(
            ({ workId, sessionId, branchId }) =>
              runtime.getSourceState({ workId, sessionId, branchId }).syncStatus === 'syncing'
          )
          .map((session) => session.workId)
      ),
    [runtime, workSessions]
  )
  const syncing = useSyncExternalStore(runtime.subscribe, getSyncing, getSyncing)
  const syncingWorkIds = useMemo((): string[] => JSON.parse(syncing), [syncing])
  const reload = useCallback(
    (session: L2WorkSessionListItem): void => {
      const { workId, sessionId, branchId } = session
      void runtime.reloadMessages({ workId, sessionId, branchId }).catch((cause: unknown) => {
        toast.error(cause instanceof Error ? cause.message : t('reloadChatDataFailed'))
      })
    },
    [runtime, t, toast]
  )
  return { syncingWorkIds, reload }
}
