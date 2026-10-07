'use client'

import { GitBranchIcon, LoaderCircleIcon } from 'lucide-react'
import { useEffect, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { useL4Region } from '@client/l4_foundation/locale/l4-region-provider'
import type { L2WorkSessionListItem } from '@common/l2_biz/work-session/l2-work-session-contract'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { PromptInputButton } from '@client/l4_foundation/ui/ai-elements/prompt-input'
import type { L2GitWorkspaceRuntime } from './l2-git-workspace-runtime'
import { getL2GitBranchSummary, type L2GitBranchPickerTarget } from './l2-git-workspace-model'
import styles from './l2-git-branch-button.module.css'

interface L2GitBranchButtonProps {
  workSession: L2WorkSessionListItem
  runtime: L2GitWorkspaceRuntime
  active: boolean
  chatReady: boolean
  onOpen: (target: L2GitBranchPickerTarget) => void
}

export function L2GitBranchButton({
  workSession,
  runtime,
  active,
  chatReady,
  onOpen
}: L2GitBranchButtonProps): React.JSX.Element | null {
  const { t } = useTranslation('workbench')
  const { locale } = useL4Region()
  useSyncExternalStore(runtime.subscribe, runtime.getRevision, runtime.getRevision)
  const heads = runtime.getWorkspace(workSession.cwd)?.heads
  useEffect(() => {
    if (!active || !chatReady) return
    let timer: number | undefined
    const cancel = (): void => {
      window.clearTimeout(timer)
      timer = undefined
    }
    const refresh = (): void => {
      cancel()
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return
      // 先让聊天同步结果完成展示，分支摘要不参与会话首屏加载。
      timer = window.setTimeout(() => {
        timer = undefined
        if (document.visibilityState === 'visible' && document.hasFocus()) {
          void runtime.refreshHeads(workSession.cwd)
        }
      }, 1_000)
    }
    const visibilityChange = (): void => {
      if (document.visibilityState !== 'visible') cancel()
    }
    refresh()
    window.addEventListener('focus', refresh)
    window.addEventListener('blur', cancel)
    document.addEventListener('visibilitychange', visibilityChange)
    return () => {
      cancel()
      window.removeEventListener('focus', refresh)
      window.removeEventListener('blur', cancel)
      document.removeEventListener('visibilitychange', visibilityChange)
    }
  }, [active, chatReady, runtime, workSession.cwd])

  const repositories = heads?.repositories ?? []
  const summary = getL2GitBranchSummary(workSession.projectName, repositories, locale)
  if (heads?.status === 'ready' && !summary) return null

  const loading = heads?.status === 'loading' && !summary
  const failed = heads?.status === 'error' && !summary
  const label = loading ? null : summary

  return (
    <PromptInputButton
      data-testid="composer-git-branch"
      tooltip={
        failed ? (heads.error ?? t('gitStatusReadFailed')) : (label?.title ?? t('gitBranches'))
      }
      aria-label={t('gitBranches')}
      className={styles.branchTrigger}
      disabled={loading}
      onClick={() =>
        onOpen({
          workId: workSession.workId,
          cwd: workSession.cwd,
          projectName: workSession.projectName,
          repositoryRoot: null
        })
      }
    >
      {loading ? (
        <LoaderCircleIcon className="size-4 shrink-0 animate-spin" />
      ) : (
        <GitBranchIcon className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
      )}
      {failed ? (
        <span className={cn(styles.branchFallback, 'text-amber-600 dark:text-amber-400')}>
          Git !
        </span>
      ) : label ? (
        <>
          <span
            data-git-branch-full
            className={cn(
              styles.branchFull,
              label.diverged && 'text-amber-600 dark:text-amber-400'
            )}
          >
            {label.full}
          </span>
        </>
      ) : null}
    </PromptInputButton>
  )
}
