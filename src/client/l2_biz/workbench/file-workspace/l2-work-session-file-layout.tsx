'use client'

import dynamic from 'next/dynamic'
import { useGroupRef } from 'react-resizable-panels'
import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { L2WorkSessionListItem } from '@common/l2_biz/work-session/l2-work-session-contract'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle
} from '@client/l4_foundation/ui/shadcn/resizable'
import type { L2GitWorkspaceRuntime } from '../git-workspace/l2-git-workspace-runtime'
import type { L2GitBranchPickerTarget } from '../git-workspace/l2-git-workspace-model'
import type { L2FileWorkspaceRuntime } from './l2-file-workspace-runtime'
import motionStyles from '../l2-workbench-motion.module.css'
import styles from './l2-work-session-file-layout.module.css'

export const L2LazyFileWorkspaceView = dynamic(
  () => import('./l2-file-workspace-view').then((module) => module.L2FileWorkspaceView),
  { ssr: false }
)

interface L2WorkSessionFileLayoutProps {
  workSession: L2WorkSessionListItem
  runtime: L2FileWorkspaceRuntime
  gitRuntime: L2GitWorkspaceRuntime
  mobile: boolean
  onOpenGitBranches: (target: L2GitBranchPickerTarget) => void
  onOpenSidebar: () => void
  children: (chatVisible: boolean) => ReactNode
}

export function L2WorkSessionFileLayout({
  workSession,
  runtime,
  gitRuntime,
  mobile,
  onOpenGitBranches,
  onOpenSidebar,
  children
}: L2WorkSessionFileLayoutProps): React.JSX.Element {
  const { t } = useTranslation('workbench')
  useSyncExternalStore(runtime.subscribe, runtime.getRevision, runtime.getRevision)
  const rootRef = useRef<HTMLDivElement>(null)
  const panelGroupRef = useGroupRef()
  const chatRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLDivElement>(null)
  const lastChatFocusRef = useRef<HTMLElement | null>(null)
  const lastFileFocusRef = useRef<HTMLElement | null>(null)
  // 切换当前焦点面时，先等待 inert/可见性提交，再同步聚焦目标，避免浏览器先清空焦点。
  const pendingFocusPaneRef = useRef<'chat' | 'files' | null>(null)
  const [wide, setWide] = useState(false)
  const { workId } = workSession
  const workspace = runtime.getWorkspace(workId)
  const opened = workspace?.windowOpen === true
  const chatPanelId = `session-chat-pane-${workId}`
  const filePanelId = `session-file-pane-${workId}`
  const chatWidthPercent = workspace?.chatWidthPercent ?? 50
  // 默认比例只在挂载时确定；避免首次从半宽展开，也避免拖拽后重注册面板。
  const [initialChatWidthPercent] = useState(() => (opened ? chatWidthPercent : 100))
  const hasFiles = Boolean(workspace?.tabs.length || workspace?.activeDiff)
  const wideLayout = wide && !mobile
  const split = wideLayout && opened
  const expanded = runtime.getExpandedWorkId() === workId
  const fileVisible = opened && (split || workspace?.activePane === 'files')
  const chatVisible = !fileVisible || split

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0
      setWide(width >= 880)
    })
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    if (!wideLayout) return
    // 等子面板完成约束注册后恢复比例，避免模式切换重新创建正文实例。
    const frame = requestAnimationFrame(() => {
      panelGroupRef.current?.setLayout({
        [chatPanelId]: opened ? chatWidthPercent : 100,
        [filePanelId]: opened ? 100 - chatWidthPercent : 0
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [chatPanelId, chatWidthPercent, filePanelId, opened, panelGroupRef, wideLayout])

  const restorePaneFocus = (pane: 'chat' | 'files'): void => {
    const container = pane === 'chat' ? chatRef.current : fileRef.current
    const previous = pane === 'chat' ? lastChatFocusRef.current : lastFileFocusRef.current
    if (previous?.isConnected && container?.contains(previous) && !previous.closest('[inert]')) {
      previous.focus({ preventScroll: true })
      return
    }
    container
      ?.querySelector<HTMLElement>(
        pane === 'chat'
          ? 'textarea, [data-testid="session-files-entry"]'
          : '[data-testid="file-workspace"]'
      )
      ?.focus({ preventScroll: true })
  }
  const requestPaneFocus = (pane: 'chat' | 'files'): void => {
    pendingFocusPaneRef.current = pane
  }

  useLayoutEffect(() => {
    const pane = pendingFocusPaneRef.current
    if (!pane || (pane === 'chat' ? !chatVisible : !fileVisible)) return
    pendingFocusPaneRef.current = null
    restorePaneFocus(pane)
  }, [chatVisible, fileVisible, workspace?.activePane])

  const hide = (): void => {
    requestPaneFocus('chat')
    runtime.hideWindow(workId)
  }
  const switchPane = (): void => {
    if (!hasFiles) return
    const pane = runtime.getWorkspace(workId)?.activePane === 'files' ? 'chat' : 'files'
    requestPaneFocus(pane)
    if (pane === 'files') runtime.showWindow(workId)
    else runtime.setActivePane(workId, 'chat')
  }

  return (
    <div
      ref={rootRef}
      data-testid="session-file-layout"
      data-file-layout={split ? 'split' : 'single'}
      className="relative size-full min-h-0 min-w-0 overflow-hidden"
      onKeyDownCapture={(event) => {
        if (
          event.key !== 'Tab' ||
          !event.ctrlKey ||
          event.altKey ||
          event.metaKey ||
          event.repeat ||
          event.nativeEvent.isComposing ||
          !hasFiles
        )
          return
        if (
          event.target instanceof Element &&
          event.target.closest('[role="menu"], [data-slot="app-dialog-content"]')
        )
          return
        event.preventDefault()
        event.stopPropagation()
        switchPane()
      }}
    >
      <ResizablePanelGroup
        groupRef={panelGroupRef}
        className={cn(
          'pi-desk-workbench-resize-group relative size-full min-h-0 min-w-0',
          wideLayout ? [motionStyles.panelGroup, styles.wide] : styles.single
        )}
        orientation="horizontal"
        disabled={!split}
        resizeTargetMinimumSize={{ fine: 8, coarse: 20 }}
        onLayoutChanged={(layout, meta) => {
          if (!split || !meta.isUserInteraction) return
          const percentage = layout[chatPanelId]
          if (percentage !== undefined) runtime.setChatWidthPercent(workId, percentage)
        }}
      >
        {/* 隐藏即停用交互，退场只保留画面；窄屏叠层与宽屏收放都不重建正文。 */}
        <ResizablePanel
          id={chatPanelId}
          data-pane="chat"
          defaultSize={`${initialChatWidthPercent}%`}
          minSize={split ? 320 : 0}
          aria-hidden={!chatVisible || undefined}
          inert={!chatVisible || undefined}
          className="flex min-h-0 min-w-0 !overflow-hidden"
        >
          <div
            ref={chatRef}
            className="size-full min-h-0 min-w-0"
            onPointerDownCapture={() => runtime.setActivePane(workId, 'chat')}
            onFocusCapture={(event) => {
              lastChatFocusRef.current = event.target
              runtime.setActivePane(workId, 'chat')
            }}
          >
            {children(chatVisible)}
          </div>
        </ResizablePanel>
        <ResizableHandle
          id={`session-file-divider-${workId}`}
          aria-label={t('resizeChatFile')}
          aria-hidden={!split || undefined}
          disabled={!split}
          disableDoubleClick
          className={cn(
            'z-10 w-px cursor-col-resize bg-transparent aria-disabled:cursor-default',
            !split && 'hidden'
          )}
        />
        <ResizablePanel
          id={filePanelId}
          data-pane="files"
          defaultSize={`${100 - initialChatWidthPercent}%`}
          minSize={split ? 320 : 0}
          maxSize={wideLayout && !opened ? 0 : undefined}
          aria-hidden={!fileVisible || undefined}
          inert={!fileVisible || undefined}
          className="flex min-h-0 min-w-0 !overflow-hidden"
        >
          <div
            ref={fileRef}
            className="size-full min-h-0 min-w-0 overflow-hidden"
            onPointerDownCapture={() => runtime.setActivePane(workId, 'files')}
            onFocusCapture={(event) => {
              lastFileFocusRef.current = event.target
              runtime.setActivePane(workId, 'files')
            }}
          >
            {hasFiles && !expanded ? (
              <L2LazyFileWorkspaceView
                key={`${workSession.sessionId}:${workSession.branchId}`}
                workSession={workSession}
                runtime={runtime}
                gitRuntime={gitRuntime}
                mobile={mobile}
                presentation={wideLayout ? 'split' : 'single'}
                onOpenGitBranches={onOpenGitBranches}
                onOpenSidebar={onOpenSidebar}
                onHide={hide}
                onExpand={() => runtime.expandWindow(workId)}
                onSwitchPane={switchPane}
              />
            ) : null}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}
