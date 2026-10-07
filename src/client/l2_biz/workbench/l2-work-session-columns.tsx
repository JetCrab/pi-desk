import { FilesIcon, MenuIcon, PanelLeftCloseIcon, XIcon } from 'lucide-react'
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { useTranslation } from 'react-i18next'
import { useGroupRef } from 'react-resizable-panels'
import { AnimatePresence } from 'motion/react'
import type { L2ChatSource } from '@common/l2_biz/chat/l2-chat-contract'
import type { L3CapabilityModeNames } from '@common/l3_modules/capability-modes/l3-capability-modes-contract'
import type { L2WorkSessionListItem } from '@common/l2_biz/work-session/l2-work-session-contract'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { useL4WindowReveal } from '@client/l4_foundation/ui/l4-window-reveal'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup
} from '@client/l4_foundation/ui/shadcn/resizable'
import type { L2WorkbenchBiz } from './l2-workbench-biz'
import {
  L2WorkbenchBranchPicker,
  type L2WorkbenchBranchPickerModel
} from './l2-workbench-branch-picker'
import type { L2WorkbenchChatRuntime } from './l2-workbench-chat'
import {
  L2WorkbenchChatComposer,
  type L2WorkbenchComposerSlots
} from './l2-workbench-chat-composer'
import type { L2WorkbenchChatInputRuntime } from './l2-workbench-chat-input-runtime'
import type { L2GitWorkspaceRuntime } from './git-workspace/l2-git-workspace-runtime'
import type { L2GitBranchPickerTarget } from './git-workspace/l2-git-workspace-model'
import { L2WorkbenchChatView } from './l2-workbench-chat-view'
import { L2WorkbenchInitializationNotice } from './l2-workbench-initialization-notice'
import { useL2WorkbenchInitializationIssue } from './hooks/l2-workbench-initialization-issue'
import { L2WorkbenchEmptyState } from './l2-workbench-empty-state'
import { L2WorkbenchSessionGuide } from './l2-workbench-session-guide'
import {
  L2WorkSessionMobileCarousel,
  type L2WorkSessionMobileCarouselItem
} from './l2-work-session-mobile-carousel'
import {
  calculateL2WorkSessionColumnModes,
  L2_WORK_SESSION_COLLAPSED_COLUMN_WIDTH,
  L2_WORK_SESSION_EXPANDED_COLUMN_MIN_WIDTH
} from './l2-work-session-column-layout'
import styles from './l2-work-session-columns.module.css'
import motionStyles from './l2-workbench-motion.module.css'
import { useL2WorkSessionColumnCapacity } from './hooks/l2-work-session-column-capacity'
import { useL2WorkSessionColumnMotion } from './hooks/l2-work-session-column-motion'
import type { L2FileWorkspaceRuntime } from './file-workspace/l2-file-workspace-runtime'
import { L2WorkSessionFileLayout } from './file-workspace/l2-work-session-file-layout'
import { Button, buttonVariants } from '@client/l4_foundation/ui/shadcn/button'

interface L2WorkSessionColumnsProps extends L2WorkbenchComposerSlots {
  onOpenSettings?: (target?: 'model-presets') => void
  workSessions: readonly L2WorkSessionListItem[]
  primaryWorkId: string | null
  pinnedWorkIds: readonly string[]
  focusedWorkId: string | null
  sidebarOpen: boolean
  mobile: boolean
  loading: boolean
  replacingWithEmptyWorkId: string | null
  chatRuntime: L2WorkbenchChatRuntime
  chatInputRuntime: L2WorkbenchChatInputRuntime
  gitRuntime: L2GitWorkspaceRuntime
  invokePluginMethod: L2WorkbenchBiz['invokePluginMethod']
  listPiCommands: L2WorkbenchBiz['listPiCommands']
  getChatModelContext: L2WorkbenchBiz['getChatModelContext']
  capabilityModes: L3CapabilityModeNames
  setChatCapabilityMode: L2WorkbenchBiz['setChatCapabilityMode']
  branchPicker: L2WorkbenchBranchPickerModel | null
  branchPendingWorkId: string | null
  fileRuntime: L2FileWorkspaceRuntime
  onOpenFileSidebar: (workId: string) => void
  onPreviewFile: (source: L2ChatSource, path: string) => void
  onAcknowledgeCompleted: (workId: string) => void
  onFocusWorkSession: (workId: string) => void
  onReplaceWithEmptyWorkSession: (workId: string) => void
  onOpenBranchPicker: (workId: string) => void
  onOpenGitBranchPicker: (target: L2GitBranchPickerTarget) => void
  onCloseBranchPicker: () => void
  onRetryBranchPicker: () => void
  onSelectBranchEntry: (entryId: string) => void
  onBranchAction: (entryId: string, action: 'tree' | 'fork') => void
  onConfirmRunningBranch: () => void
  onCancelRunningBranch: () => void
  onCloneWorkSession: (workId: string) => void
  onUnpinWorkSession: (workId: string) => void
  onToggleSidebar: () => void
}

interface WorkSessionColumnItem {
  key: string
  workSession: L2WorkSessionListItem | null
  fixed: boolean
}

const PANEL_LAYOUT_READY_FRAME_LIMIT = 8

function sessionTitle(workSession: L2WorkSessionListItem): string {
  return workSession.sessionTitle ?? workSession.projectName
}

function SidebarToggle({
  sidebarOpen,
  onToggle
}: {
  sidebarOpen: boolean
  onToggle: () => void
}): React.JSX.Element {
  const { t } = useTranslation('workbench')
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={t(sidebarOpen ? 'hideSessionMenu' : 'showSessionMenu')}
      className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'text-muted-foreground')}
    >
      {sidebarOpen ? <PanelLeftCloseIcon className="size-4" /> : <MenuIcon className="size-5" />}
    </button>
  )
}

interface WorkSessionColumnProps extends L2WorkbenchComposerSlots {
  onOpenSettings?: (target?: 'model-presets') => void
  workSession: L2WorkSessionListItem
  fixed: boolean
  focused: boolean
  contentActive: boolean
  composerActive: boolean
  sidebarOpen: boolean
  replacingWithEmpty: boolean
  replacementDisabled: boolean
  chatRuntime: L2WorkbenchChatRuntime
  chatInputRuntime: L2WorkbenchChatInputRuntime
  gitRuntime: L2GitWorkspaceRuntime
  invokePluginMethod: L2WorkbenchBiz['invokePluginMethod']
  listPiCommands: L2WorkbenchBiz['listPiCommands']
  getChatModelContext: L2WorkbenchBiz['getChatModelContext']
  capabilityModes: L3CapabilityModeNames
  setChatCapabilityMode: L2WorkbenchBiz['setChatCapabilityMode']
  branchPicker: L2WorkbenchBranchPickerModel | null
  branchPending: boolean
  mobile: boolean
  fileRuntime: L2FileWorkspaceRuntime
  onOpenFileSidebar: (workId: string) => void
  onPreviewFile: (source: L2ChatSource, path: string) => void
  onAcknowledgeCompleted: (workId: string) => void
  onFocusWorkSession: (workId: string) => void
  onReplaceWithEmptyWorkSession: (workId: string) => void
  onOpenBranchPicker: (workId: string) => void
  onOpenGitBranchPicker: (target: L2GitBranchPickerTarget) => void
  onCloseBranchPicker: () => void
  onRetryBranchPicker: () => void
  onSelectBranchEntry: (entryId: string) => void
  onBranchAction: (entryId: string, action: 'tree' | 'fork') => void
  onConfirmRunningBranch: () => void
  onCancelRunningBranch: () => void
  onCloneWorkSession: (workId: string) => void
  onUnpinWorkSession: ((workId: string) => void) | null
  onToggleSidebar: () => void
}

const WorkSessionColumn = memo(function WorkSessionColumn({
  onOpenSettings,
  workSession,
  fixed,
  focused,
  contentActive,
  composerActive,
  sidebarOpen,
  replacingWithEmpty,
  replacementDisabled,
  chatRuntime,
  chatInputRuntime,
  renderTaskSummary,
  renderTaskMenu,
  renderPluginComposerPanel,
  gitRuntime,
  invokePluginMethod,
  listPiCommands,
  getChatModelContext,
  capabilityModes,
  setChatCapabilityMode,
  branchPicker,
  branchPending,
  mobile,
  fileRuntime,
  onOpenFileSidebar,
  onPreviewFile,
  onAcknowledgeCompleted,
  onFocusWorkSession,
  onReplaceWithEmptyWorkSession,
  onOpenBranchPicker,
  onOpenGitBranchPicker,
  onCloseBranchPicker,
  onRetryBranchPicker,
  onSelectBranchEntry,
  onBranchAction,
  onConfirmRunningBranch,
  onCancelRunningBranch,
  onCloneWorkSession,
  onUnpinWorkSession,
  onToggleSidebar
}: WorkSessionColumnProps): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const columnRef = useRef<HTMLElement>(null)
  useL4WindowReveal(
    columnRef,
    `${workSession.workId}:${workSession.sessionId}:${workSession.branchId}`
  )
  const initializationIssue = useL2WorkbenchInitializationIssue(workSession, chatRuntime)
  useSyncExternalStore(fileRuntime.subscribe, fileRuntime.getRevision, fileRuntime.getRevision)
  const fileWorkspace = fileRuntime.getWorkspace(workSession.workId)
  const fileCount = (fileWorkspace?.tabs.length ?? 0) + (fileWorkspace?.activeDiff ? 1 : 0)

  useEffect(() => {
    const column = columnRef.current
    if (!column || workSession.status !== 'completed') return

    let acknowledged = false
    const handleViewed = (): void => {
      if (acknowledged) return
      acknowledged = true
      onAcknowledgeCompleted(workSession.workId)
    }
    column.addEventListener('pointerdown', handleViewed, { once: true })
    column.addEventListener('wheel', handleViewed, { passive: true, once: true })
    column.addEventListener('keydown', handleViewed, { once: true })
    return () => {
      column.removeEventListener('pointerdown', handleViewed)
      column.removeEventListener('wheel', handleViewed)
      column.removeEventListener('keydown', handleViewed)
    }
  }, [onAcknowledgeCompleted, workSession.status, workSession.workId])

  return (
    <section
      ref={columnRef}
      className="pi-desk-workbench-resize-interactions relative flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background"
      data-work-id={workSession.workId}
      data-degraded={initializationIssue.error ? 'true' : undefined}
      onPointerDown={() => onFocusWorkSession(workSession.workId)}
      onFocusCapture={() => onFocusWorkSession(workSession.workId)}
    >
      {initializationIssue.error ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-20 border border-destructive"
        />
      ) : null}
      <L2WorkSessionFileLayout
        workSession={workSession}
        runtime={fileRuntime}
        gitRuntime={gitRuntime}
        mobile={mobile}
        onOpenGitBranches={onOpenGitBranchPicker}
        onOpenSidebar={() => onOpenFileSidebar(workSession.workId)}
      >
        {(chatVisible) => (
          <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
            <header className="flex min-h-14 items-center gap-3 px-3">
              {fixed && !mobile ? null : (
                <SidebarToggle sidebarOpen={sidebarOpen} onToggle={onToggleSidebar} />
              )}
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    'truncate text-sm transition-colors duration-150 motion-reduce:transition-none',
                    focused ? 'font-semibold text-foreground' : 'font-medium text-muted-foreground'
                  )}
                >
                  {workSession.projectName}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {workSession.sessionTitle ?? t('newSession')}
                </p>
              </div>
              <div className="-mr-1 flex shrink-0 items-center">
                {initializationIssue.error ? (
                  <L2WorkbenchInitializationNotice
                    key={`${workSession.sessionId}:${workSession.branchId}`}
                    error={initializationIssue.error}
                    copied={initializationIssue.copied}
                    reloading={initializationIssue.reloading}
                    canReload={initializationIssue.canReload}
                    onCopy={initializationIssue.onCopy}
                    onReload={initializationIssue.onReload}
                  />
                ) : null}
                {fileCount > 0 ? (
                  <Button
                    variant="ghost"
                    data-testid="session-files-entry"
                    aria-label={t('openSessionFiles')}
                    aria-pressed={fileWorkspace?.windowOpen ?? false}
                    onClick={() => fileRuntime.showWindow(workSession.workId)}
                  >
                    <FilesIcon className="size-4" />
                    {t('sessionFiles', { count: fileCount })}
                  </Button>
                ) : null}
                {onUnpinWorkSession ? (
                  <button
                    type="button"
                    disabled={replacementDisabled}
                    aria-label={t('unpinWorkSession', { name: sessionTitle(workSession) })}
                    title={t('unpin')}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation()
                      onUnpinWorkSession(workSession.workId)
                    }}
                    className={cn(
                      buttonVariants({ variant: 'ghost', size: 'icon-sm' }),
                      'text-muted-foreground'
                    )}
                  >
                    <XIcon className="size-4" />
                  </button>
                ) : null}
              </div>
            </header>
            <L2WorkbenchChatView
              visible={chatVisible && contentActive}
              workSession={workSession}
              chatRuntime={chatRuntime}
              inputRuntime={chatInputRuntime}
              onPreviewFile={onPreviewFile}
            />
            <footer className="bg-background pt-3" data-carousel-swipe-lock>
              <L2WorkbenchChatComposer
                workSession={workSession}
                chatRuntime={chatRuntime}
                inputRuntime={chatInputRuntime}
                renderTaskSummary={renderTaskSummary}
                renderTaskMenu={renderTaskMenu}
                renderPluginComposerPanel={renderPluginComposerPanel}
                gitRuntime={gitRuntime}
                active={composerActive}
                mobile={mobile}
                invokePluginMethod={invokePluginMethod}
                listPiCommands={listPiCommands}
                getChatModelContext={getChatModelContext}
                capabilityModes={capabilityModes}
                setChatCapabilityMode={setChatCapabilityMode}
                newSessionPending={replacingWithEmpty}
                newSessionDisabled={replacementDisabled || branchPending}
                onNewSession={() => onReplaceWithEmptyWorkSession(workSession.workId)}
                clonePending={branchPending}
                cloneDisabled={replacementDisabled || workSession.messageCounts.total === 0}
                onCloneWorkSession={() => onCloneWorkSession(workSession.workId)}
                onOpenBranchPicker={onOpenBranchPicker}
                onOpenGitBranchPicker={onOpenGitBranchPicker}
                onOpenSettings={onOpenSettings}
              />
            </footer>
          </div>
        )}
      </L2WorkSessionFileLayout>
      <AnimatePresence>
        {branchPicker ? (
          <L2WorkbenchBranchPicker
            key="branch-picker"
            model={branchPicker}
            projectName={workSession.projectName}
            sessionTitle={workSession.sessionTitle}
            mobile={mobile}
            onClose={onCloseBranchPicker}
            onRetry={onRetryBranchPicker}
            onSelectEntry={onSelectBranchEntry}
            onAction={onBranchAction}
            onConfirmRunning={onConfirmRunningBranch}
            onCancelRunning={onCancelRunningBranch}
          />
        ) : null}
      </AnimatePresence>
    </section>
  )
})

interface CollapsedWorkSessionRailProps {
  position: number
  workSession: L2WorkSessionListItem | null
  loading: boolean
  onExpand: (position: number, workId: string | null) => void
}

const CollapsedWorkSessionRail = memo(function CollapsedWorkSessionRail({
  position,
  workSession,
  loading,
  onExpand
}: CollapsedWorkSessionRailProps): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const projectName = workSession?.projectName ?? t('workSession')
  const title = workSession
    ? (workSession.sessionTitle ?? t('newSession'))
    : loading
      ? t('loading')
      : t('chooseSession')
  const fullTitle = `${projectName} · ${title}`

  return (
    <section
      className="relative isolate flex h-full min-h-0 min-w-0 flex-1 bg-background"
      data-work-id={workSession?.workId}
    >
      <button
        type="button"
        title={fullTitle}
        aria-label={t('expandSession', { name: fullTitle })}
        onClick={() => onExpand(position, workSession?.workId ?? null)}
        className="flex h-full w-full min-w-0 flex-col items-center overflow-hidden bg-background px-1 text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:z-30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-hidden py-3">
          <span
            className={cn(
              styles.collapsedText,
              'max-h-[38%] text-xs leading-none text-muted-foreground'
            )}
          >
            {projectName}
          </span>
          <span
            className={cn(styles.collapsedText, 'max-h-[55%] text-xs font-semibold leading-none')}
          >
            {title}
          </span>
        </span>
      </button>
    </section>
  )
})

function EmptyWorkSessionColumn({
  loading,
  sidebarOpen,
  onToggleSidebar
}: {
  loading: boolean
  sidebarOpen: boolean
  onToggleSidebar: () => void
}): React.JSX.Element {
  return (
    <section className="relative isolate flex h-full min-w-0 flex-1 overflow-hidden bg-background">
      <div className="absolute left-3 top-3 z-20">
        <SidebarToggle sidebarOpen={sidebarOpen} onToggle={onToggleSidebar} />
      </div>
      <L2WorkbenchEmptyState variant={loading ? 'loading' : 'select-session'}>
        {!loading ? (
          <L2WorkbenchSessionGuide sidebarOpen={sidebarOpen} onOpen={onToggleSidebar} />
        ) : null}
      </L2WorkbenchEmptyState>
    </section>
  )
}

export function L2WorkSessionColumns({
  onOpenSettings,
  workSessions,
  primaryWorkId,
  pinnedWorkIds,
  focusedWorkId,
  sidebarOpen,
  mobile,
  loading,
  replacingWithEmptyWorkId,
  chatRuntime,
  chatInputRuntime,
  renderTaskSummary,
  renderTaskMenu,
  renderPluginComposerPanel,
  gitRuntime,
  invokePluginMethod,
  listPiCommands,
  getChatModelContext,
  capabilityModes,
  setChatCapabilityMode,
  branchPicker,
  branchPendingWorkId,
  fileRuntime,
  onOpenFileSidebar,
  onPreviewFile,
  onAcknowledgeCompleted,
  onFocusWorkSession,
  onReplaceWithEmptyWorkSession,
  onOpenBranchPicker,
  onOpenGitBranchPicker,
  onCloseBranchPicker,
  onRetryBranchPicker,
  onSelectBranchEntry,
  onBranchAction,
  onConfirmRunningBranch,
  onCancelRunningBranch,
  onCloneWorkSession,
  onUnpinWorkSession,
  onToggleSidebar
}: L2WorkSessionColumnsProps): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const columnItems = useMemo<WorkSessionColumnItem[]>(() => {
    const primary = workSessions.find((workSession) => workSession.workId === primaryWorkId) ?? null
    const pinnedWorkIdSet = new Set(pinnedWorkIds)
    const pinned = workSessions.filter(
      (workSession) =>
        workSession.workId !== primaryWorkId && pinnedWorkIdSet.has(workSession.workId)
    )

    return [
      { key: 'work-session-primary', workSession: primary, fixed: false },
      ...pinned.map((workSession) => ({
        key: `work-session-${workSession.workId}`,
        workSession,
        fixed: true
      }))
    ]
  }, [pinnedWorkIds, primaryWorkId, workSessions])
  const mobileCarouselItems = useMemo<L2WorkSessionMobileCarouselItem[]>(
    () =>
      columnItems.flatMap((item) =>
        item.workSession
          ? [
              {
                workId: item.workSession.workId,
                projectName: item.workSession.projectName,
                sessionTitle: item.workSession.sessionTitle,
                fixed: item.fixed
              }
            ]
          : []
      ),
    [columnItems]
  )
  const columnCount = columnItems.length
  const { containerRef, expandedCount } = useL2WorkSessionColumnCapacity(columnCount)
  const [protectedExpandedIndex, setProtectedExpandedIndex] = useState<number | null>(null)
  const branchPickerIndex = branchPicker
    ? columnItems.findIndex((item) => item.workSession?.workId === branchPicker.workId)
    : -1
  const effectiveProtectedExpandedIndex =
    branchPickerIndex >= 0
      ? branchPickerIndex
      : protectedExpandedIndex !== null &&
          protectedExpandedIndex >= 0 &&
          protectedExpandedIndex < columnCount
        ? protectedExpandedIndex
        : null

  const columnModes = useMemo(
    () =>
      calculateL2WorkSessionColumnModes(
        columnCount,
        expandedCount,
        effectiveProtectedExpandedIndex
      ),
    [columnCount, effectiveProtectedExpandedIndex, expandedCount]
  )
  const panelGroupRef = useGroupRef()
  const panelIdsJson = JSON.stringify(columnItems.map((item) => item.key))
  const columnModesKey = columnModes.map((mode) => (mode === 'expanded' ? 'e' : 'c')).join('')
  useL2WorkSessionColumnMotion(
    containerRef,
    `${panelIdsJson}:${columnModesKey}:${primaryWorkId}`,
    !mobile
  )

  useLayoutEffect(() => {
    const panelIds = JSON.parse(panelIdsJson) as string[]
    if (panelIds.length <= 1 || panelIds.length !== columnModesKey.length) return

    let frameId: number | null = null
    let attempts = 0
    const applyEqualLayout = (): void => {
      const panelGroup = panelGroupRef.current
      const container = containerRef.current
      if (!panelGroup || !container || container.clientWidth <= 0) return

      const registeredPanelIds = Object.keys(panelGroup.getLayout())
      const topologyReady =
        registeredPanelIds.length === panelIds.length &&
        panelIds.every((panelId) => registeredPanelIds.includes(panelId))
      if (!topologyReady) {
        attempts += 1
        if (attempts < PANEL_LAYOUT_READY_FRAME_LIMIT) {
          frameId = window.requestAnimationFrame(applyEqualLayout)
        } else {
          console.warn('[Pi Desk][WorkbenchColumns] 面板拓扑未及时就绪，跳过本次均分', {
            expectedPanelCount: panelIds.length,
            registeredPanelCount: registeredPanelIds.length
          })
        }
        return
      }

      const collapsedCount = [...columnModesKey].filter((mode) => mode === 'c').length
      const expandedPanelCount = panelIds.length - collapsedCount
      if (expandedPanelCount <= 0) return

      const collapsedPercentage =
        (L2_WORK_SESSION_COLLAPSED_COLUMN_WIDTH / container.clientWidth) * 100
      const expandedPercentage = (100 - collapsedCount * collapsedPercentage) / expandedPanelCount
      if (!Number.isFinite(expandedPercentage) || expandedPercentage <= 0) return

      const layout: Record<string, number> = {}
      for (const [index, panelId] of panelIds.entries()) {
        layout[panelId] = columnModesKey[index] === 'c' ? collapsedPercentage : expandedPercentage
      }
      panelGroup.setLayout(layout)
    }

    frameId = window.requestAnimationFrame(applyEqualLayout)
    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId)
    }
  }, [columnModesKey, containerRef, panelGroupRef, panelIdsJson])

  const primary = columnItems[0]?.workSession ?? null
  const sessionCount = columnItems.reduce((count, item) => count + (item.workSession ? 1 : 0), 0)
  const showFocus = sessionCount > 1
  const activeWorkId = focusedWorkId ?? primary?.workId ?? null
  const replacementDisabled = loading || replacingWithEmptyWorkId !== null
  const expandCollapsedColumn = useCallback(
    (position: number, workId: string | null): void => {
      setProtectedExpandedIndex(position)
      if (workId) onFocusWorkSession(workId)
    },
    [onFocusWorkSession]
  )

  if (mobile) {
    if (sessionCount === 0) {
      return (
        <EmptyWorkSessionColumn
          loading={loading}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={onToggleSidebar}
        />
      )
    }

    return (
      <L2WorkSessionMobileCarousel
        items={mobileCarouselItems}
        activeWorkId={activeWorkId}
        onActiveWorkSessionChange={onFocusWorkSession}
      >
        {columnItems.flatMap((item) => {
          const workSession = item.workSession
          if (!workSession) return []

          return [
            <WorkSessionColumn
              key={`${workSession.workId}:${workSession.sessionId}:${workSession.branchId}`}
              workSession={workSession}
              fixed={item.fixed}
              focused={showFocus && workSession.workId === activeWorkId}
              contentActive={workSession.workId === activeWorkId}
              composerActive={workSession.workId === activeWorkId}
              sidebarOpen={sidebarOpen}
              replacingWithEmpty={replacingWithEmptyWorkId === workSession.workId}
              replacementDisabled={replacementDisabled}
              chatRuntime={chatRuntime}
              chatInputRuntime={chatInputRuntime}
              renderTaskSummary={renderTaskSummary}
              renderTaskMenu={renderTaskMenu}
              renderPluginComposerPanel={renderPluginComposerPanel}
              gitRuntime={gitRuntime}
              invokePluginMethod={invokePluginMethod}
              listPiCommands={listPiCommands}
              getChatModelContext={getChatModelContext}
              capabilityModes={capabilityModes}
              setChatCapabilityMode={setChatCapabilityMode}
              branchPicker={branchPicker?.workId === workSession.workId ? branchPicker : null}
              branchPending={branchPendingWorkId === workSession.workId}
              mobile
              fileRuntime={fileRuntime}
              onOpenFileSidebar={onOpenFileSidebar}
              onPreviewFile={onPreviewFile}
              onAcknowledgeCompleted={onAcknowledgeCompleted}
              onFocusWorkSession={onFocusWorkSession}
              onReplaceWithEmptyWorkSession={onReplaceWithEmptyWorkSession}
              onOpenBranchPicker={onOpenBranchPicker}
              onOpenGitBranchPicker={onOpenGitBranchPicker}
              onOpenSettings={onOpenSettings}
              onCloseBranchPicker={onCloseBranchPicker}
              onRetryBranchPicker={onRetryBranchPicker}
              onSelectBranchEntry={onSelectBranchEntry}
              onBranchAction={onBranchAction}
              onConfirmRunningBranch={onConfirmRunningBranch}
              onCancelRunningBranch={onCancelRunningBranch}
              onCloneWorkSession={onCloneWorkSession}
              onUnpinWorkSession={item.fixed ? onUnpinWorkSession : null}
              onToggleSidebar={onToggleSidebar}
            />
          ]
        })}
      </L2WorkSessionMobileCarousel>
    )
  }

  return (
    <ResizablePanelGroup
      id="work-session-columns"
      orientation="horizontal"
      disableCursor
      elementRef={containerRef}
      groupRef={panelGroupRef}
      className={cn(
        motionStyles.sessionPanelGroup,
        'relative h-full min-h-0 min-w-0 flex-1 overflow-hidden',
        !mobile && 'pi-desk-workbench-resize-group'
      )}
    >
      {columnItems.flatMap((item, position) => {
        const workSession = item.workSession
        const collapsed = columnModes[position] === 'collapsed'
        const previousCollapsed = position > 0 && columnModes[position - 1] === 'collapsed'
        const separatorDisabled = collapsed && previousCollapsed
        const panel = (
          <ResizablePanel
            key={item.key}
            id={item.key}
            minSize={
              collapsed
                ? L2_WORK_SESSION_COLLAPSED_COLUMN_WIDTH
                : L2_WORK_SESSION_EXPANDED_COLUMN_MIN_WIDTH
            }
            maxSize={collapsed ? L2_WORK_SESSION_COLLAPSED_COLUMN_WIDTH : undefined}
            defaultSize={
              collapsed
                ? L2_WORK_SESSION_COLLAPSED_COLUMN_WIDTH
                : L2_WORK_SESSION_EXPANDED_COLUMN_MIN_WIDTH
            }
            disabled={collapsed}
            groupResizeBehavior={collapsed ? 'preserve-pixel-size' : 'preserve-relative-size'}
            className={cn(
              'flex h-full min-h-0 min-w-0 !overflow-hidden bg-background',
              position > 0 && 'border-l'
            )}
          >
            <div className={motionStyles.columnContent}>
              {collapsed ? (
                <CollapsedWorkSessionRail
                  position={position}
                  workSession={workSession}
                  loading={loading}
                  onExpand={expandCollapsedColumn}
                />
              ) : workSession ? (
                <WorkSessionColumn
                  key={`${workSession.workId}:${workSession.sessionId}:${workSession.branchId}`}
                  workSession={workSession}
                  fixed={item.fixed}
                  focused={showFocus && workSession.workId === activeWorkId}
                  contentActive
                  composerActive={workSession.workId === activeWorkId}
                  sidebarOpen={sidebarOpen}
                  replacingWithEmpty={replacingWithEmptyWorkId === workSession.workId}
                  replacementDisabled={replacementDisabled}
                  chatRuntime={chatRuntime}
                  chatInputRuntime={chatInputRuntime}
                  renderTaskSummary={renderTaskSummary}
                  renderTaskMenu={renderTaskMenu}
                  renderPluginComposerPanel={renderPluginComposerPanel}
                  gitRuntime={gitRuntime}
                  invokePluginMethod={invokePluginMethod}
                  listPiCommands={listPiCommands}
                  getChatModelContext={getChatModelContext}
                  capabilityModes={capabilityModes}
                  setChatCapabilityMode={setChatCapabilityMode}
                  branchPicker={branchPicker?.workId === workSession.workId ? branchPicker : null}
                  branchPending={branchPendingWorkId === workSession.workId}
                  mobile={mobile}
                  fileRuntime={fileRuntime}
                  onOpenFileSidebar={onOpenFileSidebar}
                  onPreviewFile={onPreviewFile}
                  onAcknowledgeCompleted={onAcknowledgeCompleted}
                  onFocusWorkSession={onFocusWorkSession}
                  onReplaceWithEmptyWorkSession={onReplaceWithEmptyWorkSession}
                  onOpenBranchPicker={onOpenBranchPicker}
                  onOpenGitBranchPicker={onOpenGitBranchPicker}
                  onOpenSettings={onOpenSettings}
                  onCloseBranchPicker={onCloseBranchPicker}
                  onRetryBranchPicker={onRetryBranchPicker}
                  onSelectBranchEntry={onSelectBranchEntry}
                  onBranchAction={onBranchAction}
                  onConfirmRunningBranch={onConfirmRunningBranch}
                  onCancelRunningBranch={onCancelRunningBranch}
                  onCloneWorkSession={onCloneWorkSession}
                  onUnpinWorkSession={item.fixed ? onUnpinWorkSession : null}
                  onToggleSidebar={onToggleSidebar}
                />
              ) : (
                <EmptyWorkSessionColumn
                  loading={loading}
                  sidebarOpen={sidebarOpen}
                  onToggleSidebar={onToggleSidebar}
                />
              )}
            </div>
          </ResizablePanel>
        )

        if (position === 0) return [panel]
        return [
          <ResizableHandle
            key={`${columnItems[position - 1]!.key}-${item.key}-resize-handle`}
            withHandle={!separatorDisabled}
            disabled={separatorDisabled}
            aria-label={t('resizeColumns', { left: position, right: position + 1 })}
            className="w-0 cursor-col-resize bg-transparent aria-disabled:cursor-default"
          />,
          panel
        ]
      })}
    </ResizablePanelGroup>
  )
}
