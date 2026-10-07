'use client'

import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { L2WorkSessionListItem } from '@common/l2_biz/work-session/l2-work-session-contract'
import {
  L4AppDialogContent,
  L4AppDialogRoot,
  L4AppDialogTitle
} from '@client/l4_foundation/ui/l4-app-dialog'
import type { L2GitWorkspaceRuntime } from '../git-workspace/l2-git-workspace-runtime'
import type { L2GitBranchPickerTarget } from '../git-workspace/l2-git-workspace-model'
import type { L2FileWorkspaceRuntime } from './l2-file-workspace-runtime'
import { L2LazyFileWorkspaceView } from './l2-work-session-file-layout'

interface L2WorkSessionFilePreviewProps {
  workSessions: readonly L2WorkSessionListItem[]
  runtime: L2FileWorkspaceRuntime
  gitRuntime: L2GitWorkspaceRuntime
  mobile: boolean
  onOpenGitBranches: (target: L2GitBranchPickerTarget) => void
  onOpenSidebar: (workId: string) => void
  onOpenTerminal: (cwd: string) => void
}

export function L2WorkSessionFilePreview({
  workSessions,
  runtime,
  gitRuntime,
  mobile,
  onOpenGitBranches,
  onOpenSidebar,
  onOpenTerminal
}: L2WorkSessionFilePreviewProps): React.JSX.Element | null {
  const { t } = useTranslation('workbench')
  useSyncExternalStore(runtime.subscribe, runtime.getRevision, runtime.getRevision)
  const workSession = workSessions.find((item) => item.workId === runtime.getExpandedWorkId())
  if (!workSession) return null
  const switchToChat = (): void => {
    const input = document.querySelector<HTMLElement>(
      `[data-work-id="${CSS.escape(workSession.workId)}"] textarea`
    )
    if (!input) return
    runtime.hideWindow(workSession.workId)
    requestAnimationFrame(() => input.focus({ preventScroll: true }))
  }

  return (
    <L4AppDialogRoot
      open
      onOpenChange={(open) => {
        if (!open) runtime.collapseExpandedWindow()
      }}
    >
      <L4AppDialogContent
        showCloseButton={false}
        onKeyDownCapture={(event) => {
          if (
            event.key !== 'Tab' ||
            !event.ctrlKey ||
            event.altKey ||
            event.metaKey ||
            event.repeat ||
            event.nativeEvent.isComposing
          )
            return
          if (event.target instanceof Element && event.target.closest('[role="menu"]')) return
          event.preventDefault()
          event.stopPropagation()
          switchToChat()
        }}
        className={
          mobile
            ? 'inset-0 h-dvh max-h-none w-dvw max-w-none translate-x-0 translate-y-0 rounded-none border-0 ring-0'
            : 'h-[min(94dvh,1080px)] w-[min(96dvw,1600px)] max-w-none'
        }
        finalFocus={() => {
          const column = document.querySelector(
            `[data-work-id="${CSS.escape(workSession.workId)}"]`
          )
          return (
            column?.querySelector<HTMLElement>('[data-file-expand-trigger]') ??
            column?.querySelector<HTMLElement>('[data-testid="session-files-entry"]') ??
            false
          )
        }}
      >
        <L4AppDialogTitle className="sr-only">
          {t('fileViewer', { name: workSession.projectName })}
        </L4AppDialogTitle>
        <L2LazyFileWorkspaceView
          key={`${workSession.workId}:${workSession.sessionId}:${workSession.branchId}`}
          workSession={workSession}
          runtime={runtime}
          gitRuntime={gitRuntime}
          mobile={mobile}
          presentation={mobile ? 'single' : 'expanded'}
          onOpenGitBranches={onOpenGitBranches}
          onOpenSidebar={() => {
            runtime.collapseExpandedWindow()
            onOpenSidebar(workSession.workId)
          }}
          onSwitchPane={switchToChat}
          onOpenTerminal={onOpenTerminal}
          onHide={() => runtime.hideWindow(workSession.workId)}
          onExpand={() => runtime.collapseExpandedWindow()}
        />
      </L4AppDialogContent>
    </L4AppDialogRoot>
  )
}
