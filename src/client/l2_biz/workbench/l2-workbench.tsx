'use client'

import { replaceL4HostSettings } from '@client/l4_foundation/locale/l4-region-store'

import {
  Activity,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode
} from 'react'
import { useTranslation } from 'react-i18next'
import type {
  BrowserFilePreviewMode,
  BrowserFilePreviewOptions,
  PluginSource
} from '@jetcrab/pi-desk-sdk/browser'
import {
  L2PiDirectoryEntryListResponseSchema,
  L2PiDirectoryListResponseSchema,
  type L2PiDirectoryEntryListResponse,
  type L2PiDirectoryListResponse
} from '@common/l2_biz/pi-session/l2-pi-session-contract'
import type { L2PluginManagementSnapshot } from '@common/l2_biz/plugin/l2-plugin-management-contract'
import {
  L2WorkSessionFilePathSchema,
  L2WorkSessionFilePreviewPathSchema
} from '@common/l2_biz/work-session/l2-work-session-file-contract'
import type {
  L2WorkSessionListItem,
  L2WorkSessionListResponse
} from '@common/l2_biz/work-session/l2-work-session-contract'
import type {
  L2AppBootstrapResponse,
  L2WorkSessionsUpdate
} from '@common/l2_biz/work-session/l2-work-session-realtime-contract'
import { L4_APP_SOCKET_AUTH_CHANGED_CLOSE_CODE } from '@common/l4_foundation/realtime/l4-app-websocket-contract'
import { applyL2WorkSessionsUpdate } from '@common/l2_biz/work-session/l2-work-session-update'
import type {
  L3AppNotification,
  L3AppRuntime,
  L3AppRuntimeEvent
} from '@common/l3_modules/app-runtime/l3-app-runtime-contract'
import { applyL3AppRuntimeEvent } from '@common/l3_modules/app-runtime/l3-app-runtime-state'
import {
  useL4PluginHost,
  useL4PluginRegistry
} from '@client/l4_foundation/plugin-host/l4-plugin-host-context'
import {
  isL4AppSocketReplaced,
  useL4AppSocket
} from '@client/l4_foundation/realtime/app-socket/l4-app-socket'
import {
  readL3NewWorkSessionBehavior,
  subscribeL3NewWorkSessionBehavior
} from '@client/l3_modules/preferences/l3-work-session-create-preferences'
import {
  readL4PiDirectoriesCache,
  readL4PiDirectoryEntriesCache,
  readL4PiIgnoredDirectoriesCache
} from '@client/l4_foundation/storage/l4-pi-directory-cache'
import { useL4AppToast } from '@client/l4_foundation/ui/l4-app-toast'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { L4_APP_VERSION } from '@client/l4_foundation/l4-app-info'
import { L2WorkbenchSidebarLayout } from './l2-workbench-sidebar-layout'
import type { L4PluginBrowserContributionDescriptor } from '@client/l4_foundation/plugin-host/l4-plugin-host-runtime'
import type { L2WorkbenchComposerSlots } from './l2-workbench-chat-composer'
import { createL2WorkbenchBiz } from './l2-workbench-biz'
import { createL2WorkbenchVersionRefresh } from './l2-workbench-version-refresh'
import { L2FileWorkspaceRuntime } from './file-workspace/l2-file-workspace-runtime'
import { L2ProjectFileBrowser } from './file-workspace/l2-project-file-browser'
import {
  L2PluginStandaloneFilePreview,
  type L2PluginStandaloneFilePreviewTarget
} from './file-workspace/l2-plugin-standalone-file-preview'
import { L2WorkSessionFilePreview } from './file-workspace/l2-work-session-file-preview'
import {
  createL2WorkSessionFilesBiz,
  readL2WorkSessionImage
} from './file-workspace/l2-work-session-files-biz'
import { L2GitBranchPicker } from './git-workspace/l2-git-branch-picker'
import { L2GitWorkspaceRuntime } from './git-workspace/l2-git-workspace-runtime'
import type { L2GitBranchPickerTarget } from './git-workspace/l2-git-workspace-model'
import { createL2WorkSessionGitBiz } from './git-workspace/l2-work-session-git-biz'
import { createL2WorkbenchChatRuntime } from './l2-workbench-chat'
import { createL2WorkbenchChatInputRuntime } from './l2-workbench-chat-input-runtime'
import {
  L2WorkbenchPickerDialog,
  type L2WorkbenchPickerMode,
  type L2WorkbenchPickerView,
  type L2WorkbenchReplacementTarget
} from './l2-workbench-picker-dialog'
import {
  findL2InvalidatedWorkSessionIds,
  getL2DisplayedWorkSessionIds,
  loadL2WorkbenchLayout,
  reconcileL2WorkbenchLayout,
  saveL2WorkbenchLayout,
  type L2WorkbenchLayoutState
} from './l2-workbench-layout'
import { L2WorkbenchEmptyState } from './l2-workbench-empty-state'
import { L2WorkSessionColumns } from './l2-work-session-columns'
import {
  pinL2CreatedWorkSession,
  toggleL2WorkSessionPinned,
  type L2WorkSessionArrangement
} from './l2-work-session-sidebar-order'
import { useL2WorkbenchBranchPicker } from './hooks/l2-workbench-branch-picker'
import { useL2WorkbenchPluginHealth } from './hooks/l2-workbench-plugin-health'
import { useL2WorkbenchSessionHistory } from './hooks/l2-workbench-session-history'
import {
  getL2PluginSessionSidebarMode,
  L2WorkSessionSidebar,
  type L2SidebarPluginApplication,
  type L2SidebarPluginSessionTab,
  type L2WorkSessionSidebarMode
} from './l2-work-session-sidebar'

const EMPTY_LAYOUT: L2WorkbenchLayoutState = {
  primaryWorkId: null
}

const EMPTY_APP_RUNTIME: L3AppRuntime = {
  mode: 'normal',
  notifications: [],
  plugins: {},
  capabilityModes: {},
  settings: { region: { locale: 'en', timeZone: 'UTC' } }
}

const BRANCH_PICKER_SHORTCUT_INTERVAL_MS = 500

function subscribeMobileViewport(listener: () => void): () => void {
  const media = window.matchMedia('(max-width: 1023px)')
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}

function readMobileViewport(): boolean {
  return window.matchMedia('(max-width: 1023px)').matches
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}

function readCachedDirectoryList(value: unknown): L2PiDirectoryListResponse['directories'] | null {
  const parsed = L2PiDirectoryListResponseSchema.safeParse(value)
  return parsed.success ? parsed.data.directories : null
}

function readCachedDirectoryEntries(value: unknown): L2PiDirectoryEntryListResponse | null {
  const parsed = L2PiDirectoryEntryListResponseSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function WorkbenchDisplaySlot<Input>({
  render,
  input
}: {
  render: (input: Input) => ReactNode
  input: Input
}): ReactNode {
  return render(input)
}

interface L2WorkbenchProps extends L2WorkbenchComposerSlots {
  onTerminalReady: () => Promise<void>
  onTerminalDisconnected: () => void
  onOpenTerminal: (cwd?: string) => Promise<void>
  renderTerminalWorkspace: (input: { mobile: boolean; children: ReactNode }) => ReactNode
  listPluginManagement: () => Promise<L2PluginManagementSnapshot>
  subscribePluginManagementChanges: (listener: () => void) => () => void
  onTaskCenterStart: (onError: (cause: unknown) => void) => void
  onTaskCenterDispose: () => void
  onTaskCenterReconcileWorkSessions: (workSessions: readonly L2WorkSessionListItem[]) => void
  onTaskCenterDisconnected: () => void
  onTaskCenterReconnected: () => void
  renderPluginApplication: (input: {
    pluginName: string
    descriptor: Extract<L4PluginBrowserContributionDescriptor, { kind: 'application' }>
    workSessions: readonly L2WorkSessionListItem[]
    preferredWorkId: string | null
    onClose: () => void
  }) => ReactNode
  renderPluginSessionSidebarTab: (input: {
    pluginName: string
    descriptor: Extract<L4PluginBrowserContributionDescriptor, { kind: 'session-sidebar-tab' }>
    source: PluginSource
    cwd: string
    onPreviewFile: (path: string, options?: BrowserFilePreviewOptions) => void
    onRevealFile: (path: string) => Promise<void>
  }) => ReactNode
  renderSettings: (input: {
    open: boolean
    connectionReady: boolean
    initialPage?: 'model-presets'
    capabilityModes: L3AppRuntime['capabilityModes']
    workSessions: readonly L2WorkSessionListItem[]
    focusedCwd: string | null
    basicMode: boolean
    pluginManagementSnapshot: L2PluginManagementSnapshot | null
    pluginAttention: 'error' | 'notice' | null
    onPluginManagementSnapshot: (snapshot: L2PluginManagementSnapshot) => void
    onPluginRestartScheduled: () => void
    onOpenChange: (open: boolean) => void
    onBeforeReload: () => Promise<boolean>
  }) => ReactNode
}

export function L2Workbench({
  onTerminalReady,
  onTerminalDisconnected,
  onOpenTerminal,
  renderTerminalWorkspace,
  listPluginManagement,
  subscribePluginManagementChanges,
  onTaskCenterStart,
  onTaskCenterDispose,
  onTaskCenterReconcileWorkSessions,
  onTaskCenterDisconnected,
  onTaskCenterReconnected,
  renderPluginApplication,
  renderPluginSessionSidebarTab,
  renderSettings,
  renderTaskSummary,
  renderTaskMenu,
  renderPluginComposerPanel
}: L2WorkbenchProps): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const { clientId, appSocket } = useL4AppSocket()
  const toast = useL4AppToast()
  const pluginHost = useL4PluginHost()
  const pluginDescriptors = useL4PluginRegistry()
  const workbenchBiz = useMemo(
    () => createL2WorkbenchBiz(clientId, appSocket),
    [appSocket, clientId]
  )
  const refreshAfterReconnect = useMemo(
    () =>
      createL2WorkbenchVersionRefresh(L4_APP_VERSION, workbenchBiz.readServerVersion, () => {
        window.location.reload()
      }),
    [workbenchBiz]
  )
  const workSessionsRef = useRef<L2WorkSessionListItem[]>([])
  const pinnedCountRef = useRef(0)
  const appRuntimeRef = useRef<L3AppRuntime>(EMPTY_APP_RUNTIME)
  const workSessionsInitializedRef = useRef(false)
  const focusedWorkIdRef = useRef<string | null>(null)
  const branchPickerShortcutLastEscapeRef = useRef(0)
  const allowDefaultSelectionRef = useRef(true)
  const localBindingOperationsRef = useRef(new Set<string>())
  const acknowledgingCompletedWorkIdsRef = useRef(new Set<string>())
  const mobile = useSyncExternalStore(subscribeMobileViewport, readMobileViewport, () => true)
  const newWorkSessionBehavior = useSyncExternalStore(
    subscribeL3NewWorkSessionBehavior,
    readL3NewWorkSessionBehavior,
    readL3NewWorkSessionBehavior
  )
  const fileBiz = useMemo(() => createL2WorkSessionFilesBiz(clientId), [clientId])
  const gitBiz = useMemo(() => createL2WorkSessionGitBiz(clientId), [clientId])
  const [fileRuntime] = useState(
    () =>
      new L2FileWorkspaceRuntime(fileBiz, gitBiz, (message) => {
        toast.show({ level: 'info', title: message })
      })
  )
  const [gitRuntime] = useState(
    () =>
      new L2GitWorkspaceRuntime(gitBiz, (cwd, repositoryRoot) => {
        fileRuntime.handleGitBranchChanged(cwd, repositoryRoot)
      })
  )
  useSyncExternalStore(
    fileRuntime.subscribe.bind(fileRuntime),
    fileRuntime.getRevision,
    fileRuntime.getRevision
  )
  const [workSessions, setWorkSessions] = useState<L2WorkSessionListResponse['workSessions']>([])
  const [pinnedCount, setPinnedCount] = useState(0)
  const [appRuntime, setAppRuntime] = useState<L3AppRuntime>(EMPTY_APP_RUNTIME)
  const [layout, setLayout] = useState<L2WorkbenchLayoutState>(EMPTY_LAYOUT)
  const [layoutLoaded, setLayoutLoaded] = useState(false)
  const [focusedWorkId, setFocusedWorkId] = useState<string | null>(null)
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true)
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false)
  const mobileDrawerOpenRef = useRef(mobileDrawerOpen)
  useEffect(() => {
    mobileDrawerOpenRef.current = mobileDrawerOpen
  }, [mobileDrawerOpen])
  const closeMobileDrawer = useCallback((): void => {
    mobileDrawerOpenRef.current = false
    setMobileDrawerOpen(false)
  }, [])
  const [sidebarMode, setSidebarMode] = useState<L2WorkSessionSidebarMode>('sessions')
  const [fileBrowserMounted, setFileBrowserMounted] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsInitialPage, setSettingsInitialPage] = useState<'model-presets' | undefined>()
  const [pluginManagementSnapshot, setPluginManagementSnapshot] =
    useState<L2PluginManagementSnapshot | null>(null)
  const [pluginManagementRequestError, setPluginManagementRequestError] = useState<string | null>(
    null
  )
  const [activePluginApplication, setActivePluginApplication] =
    useState<L2SidebarPluginApplication | null>(null)
  const [pluginStandaloneFilePreview, setPluginStandaloneFilePreview] =
    useState<L2PluginStandaloneFilePreviewTarget | null>(null)
  const [gitBranchPickerTarget, setGitBranchPickerTarget] =
    useState<L2GitBranchPickerTarget | null>(null)
  const closePluginApplication = useCallback((): void => {
    setActivePluginApplication(null)
  }, [])
  const [loadPhase, setLoadPhase] = useState<'initial' | 'refresh' | 'ready'>('initial')
  const loading = loadPhase !== 'ready'
  const [ordering, setOrdering] = useState(false)
  const [deletingWorkId, setDeletingWorkId] = useState<string | null>(null)
  const [directoryDialogOpen, setDirectoryDialogOpen] = useState(false)
  const [pickerMode, setPickerMode] = useState<L2WorkbenchPickerMode>(null)
  const [pickerView, setPickerView] = useState<L2WorkbenchPickerView>('directories')
  const [replacementWorkId, setReplacementWorkId] = useState<string | null>(null)
  const [pickerCwd, setPickerCwd] = useState<string | null>(null)
  const [directories, setDirectories] = useState(
    [] as Awaited<ReturnType<typeof workbenchBiz.listDirectories>>['directories']
  )
  const [ignoredDirectories, setIgnoredDirectories] = useState(
    [] as Awaited<ReturnType<typeof workbenchBiz.listIgnoredDirectories>>['directories']
  )
  const [directoryBrowser, setDirectoryBrowser] = useState(
    null as Awaited<ReturnType<typeof workbenchBiz.listDirectoryEntries>> | null
  )
  const [directoriesLoading, setDirectoriesLoading] = useState(false)
  const [ignoredDirectoriesLoading, setIgnoredDirectoriesLoading] = useState(false)
  const [directoryBrowserLoading, setDirectoryBrowserLoading] = useState(false)
  const [creatingCwd, setCreatingCwd] = useState<string | null>(null)
  const [replacingSessionId, setReplacingSessionId] = useState<string | null>(null)
  const [updatingIgnoreCwd, setUpdatingIgnoreCwd] = useState<string | null>(null)
  const [replacingWithEmptyWorkId, setReplacingWithEmptyWorkId] = useState<string | null>(null)
  const [pickerError, setPickerError] = useState<string | null>(null)
  const {
    sessions: historySessions,
    loading: historyLoading,
    load: loadSessionHistory,
    cancel: cancelSessionHistory,
    showCached: showCachedSessionHistory
  } = useL2WorkbenchSessionHistory(workbenchBiz, setPickerError)
  const [error, setError] = useState<string | null>(null)
  const [connectionAttempt, setConnectionAttempt] = useState(0)
  const reloadPromiseRef = useRef<Promise<void> | null>(null)
  const directoryRequestIdRef = useRef(0)
  const ignoredDirectoryRequestIdRef = useRef(0)
  const directoryBrowserRequestIdRef = useRef(0)
  const pluginManagementRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pluginManagementRefreshEpochRef = useRef(0)
  const chatRuntime = useMemo(
    () =>
      createL2WorkbenchChatRuntime(appSocket, (input) => workbenchBiz.getChatMessageDetail(input)),
    [appSocket, workbenchBiz]
  )
  const chatInputRuntime = useMemo(
    () => createL2WorkbenchChatInputRuntime(workbenchBiz, chatRuntime),
    [chatRuntime, workbenchBiz]
  )
  const runtimeLifecycleRef = useRef<{
    token: object
    chatRuntime: typeof chatRuntime
    chatInputRuntime: typeof chatInputRuntime
    taskCenterStart: typeof onTaskCenterStart
  } | null>(null)
  const fileRuntimeLifecycleRef = useRef<{
    token: object
    fileRuntime: L2FileWorkspaceRuntime
    gitRuntime: L2GitWorkspaceRuntime
  } | null>(null)
  const pinnedWorkIds = useMemo(
    () => workSessions.slice(0, pinnedCount).map((workSession) => workSession.workId),
    [pinnedCount, workSessions]
  )
  const pluginApplications = useMemo<L2SidebarPluginApplication[]>(
    () =>
      pluginDescriptors.flatMap((pluginModule) =>
        pluginModule.contributions.flatMap((descriptor) =>
          descriptor.kind === 'application'
            ? [
                {
                  pluginName: pluginModule.pluginName,
                  contributionName: descriptor.contributionName,
                  label: descriptor.label,
                  ...(descriptor.icon ? { icon: descriptor.icon } : {})
                }
              ]
            : []
        )
      ),
    [pluginDescriptors]
  )
  const pluginSessionTabs = useMemo<L2SidebarPluginSessionTab[]>(
    () =>
      pluginDescriptors.flatMap((pluginEntry) =>
        pluginEntry.contributions.flatMap((descriptor) =>
          descriptor.kind === 'session-sidebar-tab'
            ? [
                {
                  pluginName: pluginEntry.pluginName,
                  contributionName: descriptor.contributionName,
                  label: descriptor.label,
                  ...(descriptor.icon ? { icon: descriptor.icon } : {})
                }
              ]
            : []
        )
      ),
    [pluginDescriptors]
  )
  const pluginManagementHasError = Boolean(
    pluginManagementRequestError ||
    pluginManagementSnapshot?.loadError ||
    pluginManagementSnapshot?.plugins.some(
      (plugin) => plugin.status === 'failed' || plugin.operation?.phase === 'failed'
    ) ||
    pluginHost.getEntryListError() ||
    pluginHost.getFailedEntries().length > 0
  )
  const pluginManagementHasNotice = Boolean(
    pluginManagementSnapshot?.restartRequired ||
    pluginManagementSnapshot?.plugins.some((plugin) => plugin.updateAvailable === true)
  )
  const settingsAttention = pluginManagementHasError
    ? ('error' as const)
    : pluginManagementHasNotice
      ? ('notice' as const)
      : null
  const activePluginApplicationDescriptor = activePluginApplication
    ? pluginDescriptors
        .find((pluginModule) => pluginModule.pluginName === activePluginApplication.pluginName)
        ?.contributions.find(
          (descriptor) =>
            descriptor.kind === 'application' &&
            descriptor.contributionName === activePluginApplication.contributionName
        )
    : undefined
  const activeWorkId = focusedWorkId
  const activeWorkSession =
    workSessions.find((workSession) => workSession.workId === activeWorkId) ?? null
  const activeCwd = activeWorkSession?.cwd ?? null
  const activePluginSessionTab = sidebarMode.startsWith('plugin:')
    ? pluginSessionTabs.find(
        (tab) => getL2PluginSessionSidebarMode(tab.pluginName, tab.contributionName) === sidebarMode
      )
    : undefined
  const activePluginSessionTabDescriptor = activePluginSessionTab
    ? pluginDescriptors
        .find((pluginEntry) => pluginEntry.pluginName === activePluginSessionTab.pluginName)
        ?.contributions.find(
          (descriptor) =>
            descriptor.kind === 'session-sidebar-tab' &&
            descriptor.contributionName === activePluginSessionTab.contributionName
        )
    : undefined
  const activePluginWorkId = activeWorkSession?.workId ?? null
  const activePluginSessionId = activeWorkSession?.sessionId ?? null
  const activePluginBranchId = activeWorkSession?.branchId ?? null
  const activePluginSource =
    activePluginWorkId && activePluginSessionId && activePluginBranchId
      ? {
          workId: activePluginWorkId,
          sessionId: activePluginSessionId,
          branchId: activePluginBranchId
        }
      : null
  const activeFileWorkspace = fileRuntime.getWorkspace(activeWorkId)

  useEffect(() => {
    if (!sidebarMode.startsWith('plugin:')) return
    if (
      activeWorkSession &&
      activePluginSessionTab &&
      activePluginSessionTabDescriptor?.kind === 'session-sidebar-tab'
    ) {
      return
    }
    let active = true
    queueMicrotask(() => {
      if (active) setSidebarMode('sessions')
    })
    return () => {
      active = false
    }
  }, [activePluginSessionTab, activePluginSessionTabDescriptor, activeWorkSession, sidebarMode])

  const pickerLoading =
    pickerView === 'history'
      ? historyLoading
      : pickerView === 'ignored'
        ? ignoredDirectoriesLoading
        : pickerView === 'browser'
          ? directoryBrowserLoading
          : directoriesLoading
  const replacementTarget = useMemo<L2WorkbenchReplacementTarget | null>(() => {
    const target = workSessions.find((workSession) => workSession.workId === replacementWorkId)
    if (!target) return null

    return {
      projectName: target.projectName,
      sessionTitle: target.sessionTitle,
      sessionId: target.sessionId
    }
  }, [replacementWorkId, workSessions])
  const unavailableSessionIds = useMemo(
    () =>
      workSessions
        .filter((workSession) => workSession.workId !== replacementWorkId)
        .map((workSession) => workSession.sessionId),
    [replacementWorkId, workSessions]
  )
  const applyPluginManagementSnapshot = useCallback(
    (snapshot: L2PluginManagementSnapshot): void => {
      setPluginManagementSnapshot(snapshot)
      setPluginManagementRequestError(null)
      // 维护会先撤销Node入口；中间清单不代表插件已被最终删除。
      const maintaining = snapshot.plugins.some(
        (plugin) =>
          plugin.operation !== null &&
          plugin.operation.phase !== 'failed' &&
          plugin.operation.phase !== 'waiting'
      )
      if (!maintaining) void pluginHost.refreshEntries().catch(() => undefined)
      pluginHost.setEntriesMaintaining(maintaining)
    },
    [pluginHost]
  )

  const schedulePluginManagementRefresh = useCallback((): void => {
    if (pluginManagementRefreshTimerRef.current) {
      clearTimeout(pluginManagementRefreshTimerRef.current)
    }
    const epoch = ++pluginManagementRefreshEpochRef.current
    let remainingAttempts = 15

    const refresh = (delayMs: number): void => {
      pluginManagementRefreshTimerRef.current = setTimeout(() => {
        pluginManagementRefreshTimerRef.current = null
        if (pluginManagementRefreshEpochRef.current !== epoch) return
        void listPluginManagement()
          .then((snapshot) => {
            if (pluginManagementRefreshEpochRef.current !== epoch) return
            applyPluginManagementSnapshot(snapshot)
          })
          .catch((cause: unknown) => {
            if (pluginManagementRefreshEpochRef.current !== epoch) return
            remainingAttempts -= 1
            if (remainingAttempts > 0) {
              refresh(2_000)
              return
            }
            setPluginManagementRequestError(
              cause instanceof Error ? cause.message : t('pluginRestoreFailed')
            )
          })
      }, delayMs)
    }

    refresh(1_500)
  }, [applyPluginManagementSnapshot, listPluginManagement, t])

  const updateFocusedWorkId = useCallback((workId: string | null): void => {
    if (focusedWorkIdRef.current === workId) return
    focusedWorkIdRef.current = workId
    branchPickerShortcutLastEscapeRef.current = 0
    setFocusedWorkId(workId)
  }, [])

  const acknowledgeCompleted = useCallback(
    (workId: string): void => {
      if (loading || acknowledgingCompletedWorkIdsRef.current.has(workId)) return

      acknowledgingCompletedWorkIdsRef.current.add(workId)
      void workbenchBiz
        .acknowledgeCompleted(workId)
        .catch((cause: unknown) => {
          // 阅读动作不因断线弹出错误，完成标记仍以服务端后续推送为准。
          console.warn('[Pi Desk][Workbench] 确认工作会话完成状态失败', {
            workId,
            message: errorMessage(cause, '请求失败')
          })
        })
        .finally(() => {
          acknowledgingCompletedWorkIdsRef.current.delete(workId)
        })
    },
    [loading, workbenchBiz]
  )

  const applyWorkSessionState = useCallback(
    (next: L2WorkSessionListResponse): void => {
      const invalidatedWorkIds = findL2InvalidatedWorkSessionIds(
        workSessionsRef.current,
        next.workSessions
      )
      const nextWorkIds = new Set(next.workSessions.map((workSession) => workSession.workId))
      const passiveInvalidatedWorkIds = invalidatedWorkIds.filter(
        (workId) => !localBindingOperationsRef.current.has(workId) || !nextWorkIds.has(workId)
      )

      workSessionsInitializedRef.current = true
      pluginHost.replaceWorkSessions(next.workSessions)
      fileRuntime.reconcileWorkSessions(next.workSessions)
      workSessionsRef.current = next.workSessions
      pinnedCountRef.current = next.pinnedCount
      setPluginStandaloneFilePreview((current) => {
        if (!current) return null
        const workSession = next.workSessions.find((item) => item.workId === current.source.workId)
        return workSession?.sessionId === current.source.sessionId &&
          workSession.branchId === current.source.branchId &&
          workSession.cwd === current.cwd
          ? current
          : null
      })
      setWorkSessions(next.workSessions)
      setPinnedCount(next.pinnedCount)
      setLayout((current) =>
        reconcileL2WorkbenchLayout(current, next.workSessions, passiveInvalidatedWorkIds)
      )

      const focusedId = focusedWorkIdRef.current
      if (focusedId && passiveInvalidatedWorkIds.includes(focusedId)) {
        allowDefaultSelectionRef.current = false
        updateFocusedWorkId(null)
      }
    },
    [fileRuntime, pluginHost, updateFocusedWorkId]
  )

  const applyWorkSessionSnapshot = useCallback(
    (snapshot: L2WorkSessionListResponse): void => {
      applyWorkSessionState(snapshot)
      chatRuntime.reconcileWorkSessions(snapshot.workSessions)
      chatInputRuntime.reconcileWorkSessions(snapshot.workSessions)
      onTaskCenterReconcileWorkSessions(snapshot.workSessions)
    },
    [applyWorkSessionState, chatInputRuntime, chatRuntime, onTaskCenterReconcileWorkSessions]
  )

  const applyAppRuntimeState = useCallback(
    (next: L3AppRuntime): void => {
      appRuntimeRef.current = next
      setAppRuntime(next)
      pluginHost.replaceGlobalPluginStates(next.plugins)
      replaceL4HostSettings(next.settings)
    },
    [pluginHost]
  )

  const applyBootstrapSnapshot = useCallback(
    (snapshot: L2AppBootstrapResponse): void => {
      applyWorkSessionSnapshot(snapshot)
      applyAppRuntimeState(snapshot.appRuntime)
    },
    [applyAppRuntimeState, applyWorkSessionSnapshot]
  )

  const reloadWorkSessions = useCallback((): void => {
    if (reloadPromiseRef.current) return

    setLoadPhase((current) => (current === 'initial' ? 'initial' : 'refresh'))
    const reload = (async (): Promise<void> => {
      const snapshot = await workbenchBiz.listWorkSessions()
      applyBootstrapSnapshot(snapshot)
      await chatRuntime.applyWorkSessionsList(snapshot.workSessions)
      setError(null)
      setLoadPhase('ready')
    })()
      .catch((cause: unknown) => {
        setError(errorMessage(cause, t('syncFailed')))
      })
      .finally(() => {
        if (reloadPromiseRef.current === reload) reloadPromiseRef.current = null
      })
    reloadPromiseRef.current = reload
  }, [applyBootstrapSnapshot, chatRuntime, workbenchBiz, t])
  const applyWorkSessionUpdate = useCallback(
    (update: L2WorkSessionsUpdate): void => {
      try {
        const next = applyL2WorkSessionsUpdate(
          {
            workSessions: workSessionsRef.current,
            pinnedCount: pinnedCountRef.current
          },
          update
        )
        applyWorkSessionSnapshot(next)
      } catch (cause) {
        setError(errorMessage(cause, t('workSessionUpdateInvalid')))
        reloadWorkSessions()
      }
    },
    [applyWorkSessionSnapshot, reloadWorkSessions, t]
  )

  const applyAppRuntimeUpdate = useCallback(
    (event: L3AppRuntimeEvent): void => {
      try {
        applyAppRuntimeState(applyL3AppRuntimeEvent(appRuntimeRef.current, event))
      } catch (cause) {
        setError(errorMessage(cause, t('appRuntimeUpdateInvalid')))
        reloadWorkSessions()
      }
    },
    [applyAppRuntimeState, reloadWorkSessions, t]
  )

  const loadDirectories = useCallback(
    async (forceRefresh = false): Promise<L2PiDirectoryListResponse['directories'] | null> => {
      const requestId = ++directoryRequestIdRef.current
      setDirectoriesLoading(true)
      setPickerError(null)
      try {
        const response = await workbenchBiz.listDirectories(forceRefresh)
        if (directoryRequestIdRef.current !== requestId) return null
        setDirectories(response.directories)
        return response.directories
      } catch (cause) {
        if (directoryRequestIdRef.current !== requestId) return null
        setPickerError(errorMessage(cause, t('projectDirectoriesFailed')))
        return null
      } finally {
        if (directoryRequestIdRef.current === requestId) setDirectoriesLoading(false)
      }
    },
    [workbenchBiz, t]
  )

  const loadIgnoredDirectories = useCallback(
    async (forceRefresh = false): Promise<void> => {
      const requestId = ++ignoredDirectoryRequestIdRef.current
      setIgnoredDirectoriesLoading(true)
      setPickerError(null)
      try {
        const response = await workbenchBiz.listIgnoredDirectories(forceRefresh)
        if (ignoredDirectoryRequestIdRef.current !== requestId) return
        setIgnoredDirectories(response.directories)
      } catch (cause) {
        if (ignoredDirectoryRequestIdRef.current !== requestId) return
        setPickerError(errorMessage(cause, t('ignoredDirectoriesFailed')))
      } finally {
        if (ignoredDirectoryRequestIdRef.current === requestId) {
          setIgnoredDirectoriesLoading(false)
        }
      }
    },
    [workbenchBiz, t]
  )

  const loadDirectoryEntries = useCallback(
    async (cwd: string | null): Promise<void> => {
      const requestId = ++directoryBrowserRequestIdRef.current
      setDirectoryBrowserLoading(true)
      setPickerError(null)
      try {
        const response = await workbenchBiz.listDirectoryEntries(cwd)
        if (directoryBrowserRequestIdRef.current !== requestId) return
        setDirectoryBrowser(response)
      } catch (cause) {
        if (directoryBrowserRequestIdRef.current !== requestId) return
        setPickerError(errorMessage(cause, t('browseDirectoryFailed')))
      } finally {
        if (directoryBrowserRequestIdRef.current === requestId) {
          setDirectoryBrowserLoading(false)
        }
      }
    },
    [workbenchBiz, t]
  )

  useL2WorkbenchPluginHealth(
    loadPhase !== 'initial',
    listPluginManagement,
    applyPluginManagementSnapshot,
    setPluginManagementRequestError,
    subscribePluginManagementChanges
  )

  useEffect(
    () => () => {
      pluginManagementRefreshEpochRef.current += 1
      if (pluginManagementRefreshTimerRef.current) {
        clearTimeout(pluginManagementRefreshTimerRef.current)
      }
    },
    []
  )

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (!active) return
      const saved = loadL2WorkbenchLayout()
      setLayout(
        workSessionsInitializedRef.current
          ? reconcileL2WorkbenchLayout(saved, workSessionsRef.current)
          : saved
      )
      setLayoutLoaded(true)
    })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    gitRuntime.reconcileWorkSessions(workSessions, focusedWorkId)
  }, [focusedWorkId, gitRuntime, workSessions])

  useEffect(() => {
    const token = {}
    fileRuntimeLifecycleRef.current = { token, fileRuntime, gitRuntime }
    return () => {
      if (fileRuntimeLifecycleRef.current?.token === token) fileRuntimeLifecycleRef.current = null
      queueMicrotask(() => {
        const active = fileRuntimeLifecycleRef.current
        if (active?.fileRuntime !== fileRuntime) fileRuntime.dispose()
        if (active?.gitRuntime !== gitRuntime) gitRuntime.dispose()
      })
    }
  }, [fileRuntime, gitRuntime])

  useEffect(() => {
    const token = {}
    runtimeLifecycleRef.current = {
      token,
      chatRuntime,
      chatInputRuntime,
      taskCenterStart: onTaskCenterStart
    }
    chatRuntime.start((cause) => {
      setError(errorMessage(cause, t('chatSyncFailed')))
      reloadWorkSessions()
    })
    onTaskCenterStart((cause) => {
      setError(errorMessage(cause, t('taskSyncFailed')))
    })
    return () => {
      if (runtimeLifecycleRef.current?.token === token) runtimeLifecycleRef.current = null
      // React 开发模式会立即重跑 Effect；同一 Runtime 被重新激活时不能提前销毁。
      queueMicrotask(() => {
        const active = runtimeLifecycleRef.current
        if (
          active?.chatRuntime === chatRuntime &&
          active.chatInputRuntime === chatInputRuntime &&
          active.taskCenterStart === onTaskCenterStart
        ) {
          return
        }
        onTaskCenterDispose()
        chatInputRuntime.dispose()
        chatRuntime.dispose()
      })
    }
  }, [chatInputRuntime, chatRuntime, reloadWorkSessions, onTaskCenterStart, onTaskCenterDispose, t])

  useEffect(() => {
    const controller = new AbortController()
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let startTimer: ReturnType<typeof setTimeout> | null = null

    const connect = async (): Promise<void> => {
      setLoadPhase((current) => (current === 'initial' ? 'initial' : 'refresh'))
      let shouldReconnect = true
      try {
        const closeInfo = await workbenchBiz.readWorkSessionUpdates(
          controller.signal,
          async (snapshot, openedNewConnection) => {
            if (openedNewConnection) {
              chatRuntime.disconnected()
              onTaskCenterDisconnected()
              onTerminalDisconnected()
            }
            applyBootstrapSnapshot(snapshot)
            await chatRuntime.applyWorkSessionsList(snapshot.workSessions)
            onTaskCenterReconnected()
            void onTerminalReady()
            setError(null)
            setLoadPhase('ready')
            void refreshAfterReconnect(
              openedNewConnection,
              controller.signal,
              appSocket.waitForClose()
            )
          },
          applyWorkSessionUpdate,
          applyAppRuntimeUpdate
        )
        // Effect abort 只停止业务监听，共享物理 WebSocket 可能仍然保持连接。
        if (controller.signal.aborted) return
        chatRuntime.disconnected()
        onTaskCenterDisconnected()
        onTerminalDisconnected()
        setLoadPhase((current) => (current === 'initial' ? 'initial' : 'refresh'))
        if (closeInfo.code === L4_APP_SOCKET_AUTH_CHANGED_CLOSE_CODE) shouldReconnect = false
        if (isL4AppSocketReplaced(closeInfo)) {
          shouldReconnect = false
          setError(t('replacedConnection'))
        }
      } catch (cause) {
        if (controller.signal.aborted) return
        chatRuntime.disconnected()
        onTaskCenterDisconnected()
        onTerminalDisconnected()
        console.warn('[Pi Desk][Workbench] 工作会话实时连接失败，将重新连接', {
          message: errorMessage(cause, '连接失败')
        })
        if (!workSessionsInitializedRef.current) {
          setError(errorMessage(cause, t('realtimeFailed')))
        }
      }

      if (!controller.signal.aborted && shouldReconnect) {
        reconnectTimer = setTimeout(() => void connect(), 1_000)
      }
    }

    startTimer = setTimeout(() => void connect(), 0)
    return () => {
      controller.abort()
      if (startTimer) clearTimeout(startTimer)
      if (reconnectTimer) clearTimeout(reconnectTimer)
    }
  }, [
    appSocket,
    applyAppRuntimeUpdate,
    applyBootstrapSnapshot,
    applyWorkSessionUpdate,
    chatRuntime,
    refreshAfterReconnect,
    onTaskCenterDisconnected,
    onTaskCenterReconnected,
    onTerminalReady,
    onTerminalDisconnected,
    workbenchBiz,
    t,
    connectionAttempt
  ])

  useEffect(() => {
    if (
      !layoutLoaded ||
      loading ||
      focusedWorkId !== null ||
      !allowDefaultSelectionRef.current ||
      !layout.primaryWorkId
    ) {
      return
    }

    const target = workSessionsRef.current.find(
      (workSession) => workSession.workId === layout.primaryWorkId
    )
    allowDefaultSelectionRef.current = false
    if (!target) {
      setLayout((current) => ({ ...current, primaryWorkId: null }))
      return
    }

    updateFocusedWorkId(target.workId)
  }, [focusedWorkId, layout.primaryWorkId, layoutLoaded, loading, updateFocusedWorkId])

  useEffect(() => {
    if (!layoutLoaded) return

    const workSessionById = new Map(
      workSessions.map((workSession) => [workSession.workId, workSession])
    )
    const displayed = getL2DisplayedWorkSessionIds(layout, pinnedWorkIds)
      .map((workId) => workSessionById.get(workId))
      .filter((workSession): workSession is L2WorkSessionListItem => workSession !== undefined)
    chatRuntime.ensureDisplayedWorkSessions(displayed)
  }, [chatRuntime, layout, layoutLoaded, pinnedWorkIds, workSessions])

  useEffect(() => {
    if (!layoutLoaded) return
    saveL2WorkbenchLayout(layout)
  }, [layout, layoutLoaded])

  const focusWorkSession = useCallback(
    (workId: string): void => {
      const target = workSessionsRef.current.find((workSession) => workSession.workId === workId)
      if (!target) return

      allowDefaultSelectionRef.current = false
      const currentPinnedWorkIds = workSessionsRef.current
        .slice(0, pinnedCountRef.current)
        .map((workSession) => workSession.workId)

      const alreadyFocused = focusedWorkIdRef.current === workId
      const fixed = currentPinnedWorkIds.includes(workId)
      if (fixed && workId !== layout.primaryWorkId) {
        if (!alreadyFocused) updateFocusedWorkId(workId)
        if (mobile) setMobileDrawerOpen(false)
        return
      }

      if (layout.primaryWorkId !== workId) {
        setLayout((current) =>
          current.primaryWorkId === workId ? current : { ...current, primaryWorkId: workId }
        )
      }
      if (!alreadyFocused) updateFocusedWorkId(workId)
      if (mobile) setMobileDrawerOpen(false)
    },
    [layout, mobile, updateFocusedWorkId]
  )

  const selectSidebarWorkSession = useCallback(
    (workId: string): void => {
      const target = workSessionsRef.current.find((workSession) => workSession.workId === workId)
      if (target?.status === 'completed') acknowledgeCompleted(workId)
      focusWorkSession(workId)
    },
    [acknowledgeCompleted, focusWorkSession]
  )

  const goToPluginWorkSession = useCallback(
    async (input: { workId: string } | { sessionId: string; cwd?: string }) => {
      if (loading) throw new Error(t('workSessionInitializing'))
      const existing =
        'workId' in input
          ? workSessionsRef.current.find((workSession) => workSession.workId === input.workId)
          : workSessionsRef.current.find((workSession) => workSession.sessionId === input.sessionId)
      if (existing) {
        selectSidebarWorkSession(existing.workId)
        return existing
      }
      if ('workId' in input || !input.cwd) {
        throw new Error(t('sessionNotFound'))
      }

      const { workSession } = await workbenchBiz.createWorkSession({
        cwd: input.cwd,
        sessionId: input.sessionId
      })
      allowDefaultSelectionRef.current = false
      setLayout({ primaryWorkId: workSession.workId })
      updateFocusedWorkId(workSession.workId)
      if (mobile) setMobileDrawerOpen(false)
      return workSession
    },
    [loading, mobile, selectSidebarWorkSession, updateFocusedWorkId, workbenchBiz, t]
  )

  const updateArrangement = useCallback(
    async (arrangement: L2WorkSessionArrangement, movedWorkId: string): Promise<void> => {
      if (loading || ordering) return

      const previous: L2WorkSessionListResponse = {
        workSessions: workSessionsRef.current,
        pinnedCount: pinnedCountRef.current
      }
      const previousIndex = previous.workSessions.findIndex(
        (workSession) => workSession.workId === movedWorkId
      )
      const nextIndex = arrangement.workIds.indexOf(movedWorkId)
      if (previousIndex < 0 || nextIndex < 0) return

      const workSessionById = new Map(
        previous.workSessions.map((workSession) => [workSession.workId, workSession])
      )
      const optimistic = arrangement.workIds
        .map((workId) => workSessionById.get(workId))
        .filter(
          (workSession): workSession is L2WorkSessionListResponse['workSessions'][number] =>
            workSession !== undefined
        )
      if (optimistic.length !== previous.workSessions.length) return

      const wasPinned = previousIndex < previous.pinnedCount
      const pinned = nextIndex < arrangement.pinnedCount
      applyWorkSessionState({
        workSessions: optimistic,
        pinnedCount: arrangement.pinnedCount
      })

      setOrdering(true)
      setError(null)
      let succeeded = false
      try {
        applyWorkSessionSnapshot(await workbenchBiz.sortWorkSessions(arrangement))
        succeeded = true
      } catch (cause) {
        applyWorkSessionState(previous)
        setError(errorMessage(cause, t('sortFailed')))
      } finally {
        setOrdering(false)
      }

      if (!succeeded || wasPinned === pinned) return
      if (mobile) {
        if (
          !pinned &&
          focusedWorkIdRef.current === movedWorkId &&
          movedWorkId !== layout.primaryWorkId
        ) {
          updateFocusedWorkId(layout.primaryWorkId)
        }
        return
      }
      if (pinned) {
        setLayout((current) =>
          current.primaryWorkId === movedWorkId ? { primaryWorkId: null } : current
        )
        return
      }

      if (focusedWorkIdRef.current === movedWorkId) updateFocusedWorkId(layout.primaryWorkId)
    },
    [
      applyWorkSessionSnapshot,
      applyWorkSessionState,
      layout.primaryWorkId,
      loading,
      mobile,
      ordering,
      updateFocusedWorkId,
      workbenchBiz,
      t
    ]
  )

  const togglePinnedWorkSession = useCallback(
    (workId: string): void => {
      if (loading || ordering) return
      const arrangement = toggleL2WorkSessionPinned(
        workSessionsRef.current.map((workSession) => workSession.workId),
        pinnedCountRef.current,
        workId
      )
      if (arrangement) void updateArrangement(arrangement, workId)
    },
    [loading, ordering, updateArrangement]
  )

  const deleteWorkSession = useCallback(
    async (workId: string): Promise<void> => {
      if (loading) return
      setDeletingWorkId(workId)
      setError(null)
      try {
        applyWorkSessionSnapshot(await workbenchBiz.deleteWorkSession(workId))
      } catch (cause) {
        setError(errorMessage(cause, t('deleteFailed')))
      } finally {
        setDeletingWorkId(null)
      }
    },
    [applyWorkSessionSnapshot, loading, workbenchBiz, t]
  )

  const openCreatePicker = useCallback((): void => {
    if (loading) return
    const cachedDirectories = readCachedDirectoryList(readL4PiDirectoriesCache())
    if (cachedDirectories) setDirectories(cachedDirectories)
    setPickerError(null)
    setPickerMode('create')
    setPickerView('directories')
    setReplacementWorkId(null)
    ignoredDirectoryRequestIdRef.current += 1
    setIgnoredDirectoriesLoading(false)
    directoryBrowserRequestIdRef.current += 1
    setDirectoryBrowserLoading(false)
    cancelSessionHistory()
    setPickerCwd(null)
    setDirectoryDialogOpen(true)
    void loadDirectories().then((loadedDirectories) => {
      if (loadedDirectories?.length !== 0) return
      setPickerView('browser')
      setDirectoryBrowser(readCachedDirectoryEntries(readL4PiDirectoryEntriesCache(null)))
      void loadDirectoryEntries(null)
    })
  }, [cancelSessionHistory, loadDirectories, loadDirectoryEntries, loading])

  const openReplacePicker = useCallback((): void => {
    if (loading) return
    const target = workSessions.find((workSession) => workSession.workId === activeWorkId)
    if (!target) return

    setPickerError(null)
    directoryRequestIdRef.current += 1
    setDirectoriesLoading(false)
    ignoredDirectoryRequestIdRef.current += 1
    setIgnoredDirectoriesLoading(false)
    directoryBrowserRequestIdRef.current += 1
    setDirectoryBrowserLoading(false)
    setPickerMode('replace')
    setPickerView('history')
    setReplacementWorkId(target.workId)
    setPickerCwd(target.cwd)
    showCachedSessionHistory(target.cwd)
    setDirectoryDialogOpen(true)
    void loadSessionHistory(target.cwd)
  }, [activeWorkId, loadSessionHistory, loading, showCachedSessionHistory, workSessions])

  const returnToDirectoryList = (): void => {
    setPickerError(null)
    ignoredDirectoryRequestIdRef.current += 1
    setIgnoredDirectoriesLoading(false)
    directoryBrowserRequestIdRef.current += 1
    setDirectoryBrowserLoading(false)
    cancelSessionHistory()
    const cachedDirectories = readCachedDirectoryList(readL4PiDirectoriesCache())
    if (cachedDirectories) setDirectories(cachedDirectories)
    setPickerView('directories')
    setPickerCwd(null)
    void loadDirectories()
  }

  const openIgnoredDirectoryList = (): void => {
    if (loading || pickerMode !== 'create') return
    const cachedDirectories = readCachedDirectoryList(readL4PiIgnoredDirectoriesCache())
    if (cachedDirectories) setIgnoredDirectories(cachedDirectories)
    else setIgnoredDirectories([])
    setPickerError(null)
    directoryRequestIdRef.current += 1
    setDirectoriesLoading(false)
    directoryBrowserRequestIdRef.current += 1
    setDirectoryBrowserLoading(false)
    setPickerView('ignored')
    void loadIgnoredDirectories()
  }

  const openDirectoryBrowser = (): void => {
    if (loading || pickerMode !== 'create') return
    setPickerError(null)
    directoryRequestIdRef.current += 1
    setDirectoriesLoading(false)
    ignoredDirectoryRequestIdRef.current += 1
    setIgnoredDirectoriesLoading(false)
    setPickerView('browser')
    setDirectoryBrowser(readCachedDirectoryEntries(readL4PiDirectoryEntriesCache(null)))
    void loadDirectoryEntries(null)
  }

  const navigateDirectoryBrowser = (cwd: string | null): void => {
    if (loading || pickerMode !== 'create') return
    const cachedEntries = readCachedDirectoryEntries(readL4PiDirectoryEntriesCache(cwd))
    if (cachedEntries) setDirectoryBrowser(cachedEntries)
    void loadDirectoryEntries(cwd)
  }

  const replaceDirectoryIgnore = async (cwd: string, ignored: boolean): Promise<void> => {
    if (loading || pickerMode !== 'create' || updatingIgnoreCwd !== null) return

    setUpdatingIgnoreCwd(cwd)
    setPickerError(null)
    try {
      await workbenchBiz.replaceDirectoryIgnore({ cwd, ignored })
      await Promise.all([loadDirectories(), loadIgnoredDirectories()])
    } catch (cause) {
      setPickerError(errorMessage(cause, t(ignored ? 'ignoreFailed' : 'restoreIgnoredFailed')))
    } finally {
      setUpdatingIgnoreCwd(null)
    }
  }

  const applyCreatedWorkSessionBehavior = useCallback(
    async (workSession: L2WorkSessionListItem): Promise<void> => {
      const behavior = mobile ? 'activate' : newWorkSessionBehavior
      if (behavior === 'activate') {
        allowDefaultSelectionRef.current = false
        setLayout({ primaryWorkId: workSession.workId })
        updateFocusedWorkId(workSession.workId)
        if (mobile) setMobileDrawerOpen(false)
        return
      }
      if (behavior !== 'pin') return

      const arrangement = pinL2CreatedWorkSession(
        workSessionsRef.current.map((item) => item.workId),
        pinnedCountRef.current,
        workSession.workId
      )
      if (!arrangement) return

      setOrdering(true)
      try {
        applyWorkSessionSnapshot(await workbenchBiz.sortWorkSessions(arrangement))
      } catch (cause) {
        setError(errorMessage(cause, t('autoPinFailed')))
      } finally {
        setOrdering(false)
      }
    },
    [applyWorkSessionSnapshot, mobile, newWorkSessionBehavior, updateFocusedWorkId, workbenchBiz, t]
  )

  const showBranchOperationError = useCallback(
    (message: string): void => {
      toast.error(message)
    },
    [toast]
  )

  const {
    model: branchPicker,
    open: openBranchPicker,
    close: closeBranchPicker,
    retry: retryBranchPicker,
    selectEntry: selectBranchEntry,
    requestAction: requestBranchAction,
    clone: cloneWorkSession,
    confirmRunning: confirmRunningBranch,
    cancelRunning: cancelRunningBranch,
    pendingWorkId: branchPendingWorkId
  } = useL2WorkbenchBranchPicker({
    disabled: loading,
    workSessions,
    workbenchBiz,
    chatInputRuntime,
    applyWorkSessionSnapshot,
    applyCreatedWorkSessionBehavior,
    focusWorkSession: updateFocusedWorkId,
    onError: showBranchOperationError,
    mobile
  })

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (
        event.defaultPrevented ||
        (event.target instanceof Element &&
          event.target.closest(
            '[data-testid="file-workspace"], [role="menu"], [data-slot="app-dialog-content"]'
          ))
      ) {
        branchPickerShortcutLastEscapeRef.current = 0
        return
      }
      if (
        event.repeat ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.isComposing ||
        branchPicker !== null
      ) {
        return
      }

      if (mobile && mobileDrawerOpenRef.current) {
        event.preventDefault()
        branchPickerShortcutLastEscapeRef.current = 0
        closeMobileDrawer()
        return
      }

      const workId = focusedWorkIdRef.current
      if (!workId) return

      const now = Date.now()
      if (now - branchPickerShortcutLastEscapeRef.current >= BRANCH_PICKER_SHORTCUT_INTERVAL_MS) {
        branchPickerShortcutLastEscapeRef.current = now
        return
      }

      event.preventDefault()
      branchPickerShortcutLastEscapeRef.current = 0
      openBranchPicker(workId)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [branchPicker, closeMobileDrawer, mobile, openBranchPicker])

  useEffect(
    () =>
      pluginHost.bindWorkSessionCreate(async (cwd) => {
        if (loading) throw new Error(t('workSessionInitializing'))
        const { workSession } = await workbenchBiz.createWorkSession({ cwd })
        await applyCreatedWorkSessionBehavior(workSession)
        return workSession
      }),
    [applyCreatedWorkSessionBehavior, loading, pluginHost, workbenchBiz, t]
  )

  useEffect(
    () => pluginHost.bindWorkSessionGoTo(goToPluginWorkSession),
    [goToPluginWorkSession, pluginHost]
  )

  const createWorkSession = async (cwd: string): Promise<void> => {
    if (loading) return
    directoryRequestIdRef.current += 1
    setDirectoriesLoading(false)
    directoryBrowserRequestIdRef.current += 1
    setDirectoryBrowserLoading(false)
    setCreatingCwd(cwd)
    setPickerError(null)
    try {
      const { workSession } = await workbenchBiz.createWorkSession({ cwd })
      setPickerError(null)
      setDirectoryDialogOpen(false)
      await applyCreatedWorkSessionBehavior(workSession)
    } catch (cause) {
      setPickerError(errorMessage(cause, t('createFailed')))
    } finally {
      setCreatingCwd(null)
    }
  }

  const replaceWorkSession = async (sessionId: string): Promise<void> => {
    if (loading || !replacementWorkId || !pickerCwd) return
    if (!workSessionsRef.current.some((workSession) => workSession.workId === replacementWorkId)) {
      setPickerError(t('replaceTargetMissing'))
      return
    }

    const workId = replacementWorkId
    cancelSessionHistory()
    localBindingOperationsRef.current.add(workId)
    setReplacingSessionId(sessionId)
    setPickerError(null)
    try {
      const snapshot = await workbenchBiz.replaceWorkSession({
        workId,
        cwd: pickerCwd,
        sessionId
      })
      applyWorkSessionSnapshot(snapshot)
      const replaced = snapshot.workSessions.find((workSession) => workSession.workId === workId)
      if (!replaced) throw new Error(t('replacementMissing'))

      allowDefaultSelectionRef.current = false
      updateFocusedWorkId(workId)
      setPickerError(null)
      setDirectoryDialogOpen(false)
      if (mobile) setMobileDrawerOpen(false)
    } catch (cause) {
      setPickerError(errorMessage(cause, t('replaceFailed')))
    } finally {
      localBindingOperationsRef.current.delete(workId)
      setReplacingSessionId(null)
    }
  }

  const replaceWithEmptyWorkSession = useCallback(
    async (workId: string): Promise<void> => {
      if (loading || replacingWithEmptyWorkId !== null) return
      if (!workSessionsRef.current.some((workSession) => workSession.workId === workId)) return

      localBindingOperationsRef.current.add(workId)
      setReplacingWithEmptyWorkId(workId)
      setError(null)
      try {
        const snapshot = await workbenchBiz.replaceWorkSession({ workId })
        applyWorkSessionSnapshot(snapshot)
        const replaced = snapshot.workSessions.find((workSession) => workSession.workId === workId)
        if (!replaced) throw new Error(t('emptyReplacementMissing'))

        allowDefaultSelectionRef.current = false
        updateFocusedWorkId(workId)
      } catch (cause) {
        setError(errorMessage(cause, t('replaceEmptyFailed')))
      } finally {
        localBindingOperationsRef.current.delete(workId)
        setReplacingWithEmptyWorkId(null)
      }
    },
    [
      applyWorkSessionSnapshot,
      loading,
      replacingWithEmptyWorkId,
      updateFocusedWorkId,
      workbenchBiz,
      t
    ]
  )

  const changeSidebarMode = useCallback((mode: L2WorkSessionSidebarMode): void => {
    setSidebarMode(mode)
    if (mode === 'files') setFileBrowserMounted(true)
  }, [])
  const handleSidebarFileOpened = useCallback((): void => {
    if (mobile) closeMobileDrawer()
    if (
      activeWorkId &&
      !document.querySelector(
        `[data-work-id="${CSS.escape(activeWorkId)}"] [data-testid="session-file-layout"]`
      )
    ) {
      fileRuntime.expandWindow(activeWorkId)
    }
  }, [activeWorkId, closeMobileDrawer, fileRuntime, mobile])
  const handleSidebarRefreshFiles = useCallback((): void => {
    if (!activeCwd || !activeWorkId) return
    fileRuntime.refreshTree(activeWorkId)
    void gitRuntime.refreshSnapshot(activeCwd)
  }, [activeCwd, activeWorkId, fileRuntime, gitRuntime])
  const openGitBranchPicker = useCallback((target: L2GitBranchPickerTarget): void => {
    setGitBranchPickerTarget(target)
  }, [])
  const closeGitBranchPicker = useCallback((): void => {
    setGitBranchPickerTarget(null)
  }, [])
  const openWorkSessionFilePreview = useCallback(
    (
      source: PluginSource,
      path: string,
      mode: BrowserFilePreviewMode = 'session',
      imagePaths?: readonly string[]
    ): void => {
      const current = workSessionsRef.current.find(
        (item) =>
          item.workId === source.workId &&
          item.sessionId === source.sessionId &&
          item.branchId === source.branchId
      )
      if (!current) {
        toast.error(t('sourceChanged'))
        return
      }
      if (mode === 'standalone') {
        setPluginStandaloneFilePreview({
          source: {
            workId: current.workId,
            sessionId: current.sessionId,
            branchId: current.branchId
          },
          cwd: current.cwd,
          projectName: current.projectName,
          path,
          imagePaths
        })
        closeMobileDrawer()
        return
      }
      fileRuntime.openFile(current.workId, path)
      focusWorkSession(current.workId)
      closeMobileDrawer()
      const visibleColumn = document.querySelector(
        `[data-work-id="${CSS.escape(current.workId)}"] [data-testid="session-file-layout"]`
      )
      if (mode === 'expanded' || !visibleColumn) {
        fileRuntime.expandWindow(current.workId)
      } else if (activePluginApplication) {
        // 会话内模式优先显示用户要求的会话面，而不是把文件留在插件 Application 背后。
        closePluginApplication()
      }
    },
    [
      activePluginApplication,
      closeMobileDrawer,
      closePluginApplication,
      fileRuntime,
      focusWorkSession,
      toast,
      t
    ]
  )
  const previewWorkSessionFile = useCallback(
    (
      source: PluginSource,
      pathInput: string,
      mode: BrowserFilePreviewMode,
      imagePathsInput?: readonly string[]
    ): void => {
      const path = L2WorkSessionFilePathSchema.safeParse(pathInput)
      const images = L2WorkSessionFilePathSchema.array()
        .nonempty()
        .optional()
        .safeParse(imagePathsInput)
      if (
        !path.success ||
        !images.success ||
        (images.data && (mode !== 'standalone' || !images.data.includes(path.data)))
      ) {
        toast.error(t('invalidFilePath'))
        return
      }
      openWorkSessionFilePreview(
        source,
        path.data,
        mode,
        images.data ? [...new Set(images.data)] : undefined
      )
    },
    [openWorkSessionFilePreview, toast, t]
  )
  const previewConversationFile = useCallback(
    (source: PluginSource, pathInput: string): void => {
      const path = L2WorkSessionFilePreviewPathSchema.safeParse(pathInput)
      if (!path.success) {
        toast.error(t('invalidToolFilePath'))
        return
      }
      openWorkSessionFilePreview(source, path.data)
    },
    [openWorkSessionFilePreview, toast, t]
  )
  useEffect(
    () =>
      pluginHost.bindWorkSessionFilePreview(({ source, path, mode, imagePaths }) => {
        previewWorkSessionFile(source, path, mode ?? 'session', imagePaths)
      }),
    [pluginHost, previewWorkSessionFile]
  )
  useEffect(
    () =>
      pluginHost.bindImageReader(({ source, cwd, path }, signal) =>
        readL2WorkSessionImage(fileBiz, { workId: source.workId, cwd, path }, signal)
      ),
    [pluginHost, fileBiz]
  )
  const revealWorkSessionFile = useCallback(
    async (source: PluginSource, pathInput: string): Promise<void> => {
      const path = L2WorkSessionFilePathSchema.safeParse(pathInput)
      if (!path.success) throw new Error(t('invalidFilePath'))
      const current = workSessionsRef.current.find(
        (item) =>
          item.workId === source.workId &&
          item.sessionId === source.sessionId &&
          item.branchId === source.branchId
      )
      if (!current) throw new Error(t('sourceChanged'))
      await fileBiz.reveal({ workId: current.workId, cwd: current.cwd, path: path.data })
    },
    [fileBiz, t]
  )
  useEffect(
    () =>
      pluginHost.bindWorkSessionFileReveal(({ source, path }) =>
        revealWorkSessionFile(source, path)
      ),
    [pluginHost, revealWorkSessionFile]
  )
  const previewPluginFile = useCallback(
    (path: string, options?: BrowserFilePreviewOptions): void => {
      if (!activePluginWorkId || !activePluginSessionId || !activePluginBranchId) {
        toast.error(t('noPreviewSession'))
        return
      }
      previewWorkSessionFile(
        {
          workId: activePluginWorkId,
          sessionId: activePluginSessionId,
          branchId: activePluginBranchId
        },
        path,
        options?.mode ?? 'session',
        options?.imagePaths
      )
    },
    [
      activePluginBranchId,
      activePluginSessionId,
      activePluginWorkId,
      previewWorkSessionFile,
      toast,
      t
    ]
  )
  const revealPluginFile = useCallback(
    (path: string): Promise<void> => {
      if (!activePluginWorkId || !activePluginSessionId || !activePluginBranchId) {
        return Promise.reject(new Error(t('noRevealSession')))
      }
      return revealWorkSessionFile(
        {
          workId: activePluginWorkId,
          sessionId: activePluginSessionId,
          branchId: activePluginBranchId
        },
        path
      )
    },
    [activePluginBranchId, activePluginSessionId, activePluginWorkId, revealWorkSessionFile, t]
  )
  const deleteAppNotification = useCallback(
    async (notificationId: string): Promise<void> => {
      await workbenchBiz.applyAppRuntimeUpdate({
        key: 'notifications',
        update: { type: 'delete', notificationId }
      })
    },
    [workbenchBiz]
  )
  const consumeAppNotification = useCallback(
    async (notification: L3AppNotification): Promise<void> => {
      if (!notification.event) return
      try {
        await pluginHost.dispatchNotificationEvent(notification.notificationId, notification.event)
        await deleteAppNotification(notification.notificationId)
      } catch (cause) {
        toast.error(errorMessage(cause, t('notificationActionFailed')))
      }
    },
    [deleteAppNotification, pluginHost, toast, t]
  )
  const dismissAppNotification = useCallback(
    async (notificationId: string): Promise<void> => {
      try {
        await deleteAppNotification(notificationId)
      } catch (cause) {
        toast.error(errorMessage(cause, t('notificationDeleteFailed')))
      }
    },
    [deleteAppNotification, toast, t]
  )

  const handleSidebarOpenSettings = useCallback(
    (target?: 'model-presets'): void => {
      closeMobileDrawer()
      setSettingsInitialPage(target)
      setSettingsOpen(true)
    },
    [closeMobileDrawer]
  )
  const handleSidebarOpenPluginApplication = useCallback(
    (application: L2SidebarPluginApplication): void => {
      closeMobileDrawer()
      setActivePluginApplication(application)
    },
    [closeMobileDrawer]
  )
  const requestDeleteWorkSession = useCallback(
    (workId: string): void => void deleteWorkSession(workId),
    [deleteWorkSession]
  )
  const requestArrangementUpdate = useCallback(
    (arrangement: L2WorkSessionArrangement, movedWorkId: string): void =>
      void updateArrangement(arrangement, movedWorkId),
    [updateArrangement]
  )
  const requestReplaceWithEmptyWorkSession = useCallback(
    (workId: string): void => void replaceWithEmptyWorkSession(workId),
    [replaceWithEmptyWorkSession]
  )
  const toggleSidebar = useCallback((): void => {
    if (mobile) setMobileDrawerOpen((open) => !open)
    else setDesktopSidebarOpen((open) => !open)
  }, [mobile])

  const openFileSidebar = useCallback(
    (workId: string): void => {
      focusWorkSession(workId)
      if (mobile) setMobileDrawerOpen(true)
      else setDesktopSidebarOpen(true)
    },
    [focusWorkSession, mobile]
  )

  const sidebarOpen = mobile ? mobileDrawerOpen : desktopSidebarOpen
  const validGitBranchPickerTarget =
    gitBranchPickerTarget &&
    workSessions.some(
      (workSession) =>
        workSession.workId === gitBranchPickerTarget.workId &&
        workSession.cwd === gitBranchPickerTarget.cwd
    )
      ? gitBranchPickerTarget
      : null
  // 隐藏时保留浏览状态并暂停加载，避免切换会话触发后台目录请求。
  const fileBrowser = useMemo(
    () =>
      fileBrowserMounted && activeWorkSession ? (
        <Activity mode={sidebarOpen && sidebarMode === 'files' ? 'visible' : 'hidden'}>
          <L2ProjectFileBrowser
            key={`${activeWorkSession.workId}:${activeWorkSession.sessionId}:${activeWorkSession.branchId}`}
            workId={activeWorkSession.workId}
            cwd={activeWorkSession.cwd}
            projectName={activeWorkSession.projectName}
            runtime={fileRuntime}
            gitRuntime={gitRuntime}
            onOpenGitBranches={openGitBranchPicker}
            onFileOpened={handleSidebarFileOpened}
          />
        </Activity>
      ) : null,
    [
      activeWorkSession,
      fileBrowserMounted,
      fileRuntime,
      gitRuntime,
      handleSidebarFileOpened,
      openGitBranchPicker,
      sidebarMode,
      sidebarOpen
    ]
  )
  const pluginTabContent =
    sidebarOpen &&
    activePluginSessionTab &&
    activePluginSessionTabDescriptor?.kind === 'session-sidebar-tab' &&
    activePluginSource &&
    activeWorkSession ? (
      <WorkbenchDisplaySlot
        render={renderPluginSessionSidebarTab}
        input={{
          pluginName: activePluginSessionTab.pluginName,
          descriptor: activePluginSessionTabDescriptor,
          source: activePluginSource,
          cwd: activeWorkSession.cwd,
          onPreviewFile: previewPluginFile,
          onRevealFile: revealPluginFile
        }}
      />
    ) : null
  const sidebar = (
    <L2WorkSessionSidebar
      mode={sidebarMode}
      mobile={mobile}
      fileBrowser={fileBrowser}
      pluginTabContent={pluginTabContent}
      pluginSessionTabs={pluginSessionTabs}
      fileRefreshLoading={activeFileWorkspace?.directories.get('')?.status === 'loading'}
      canBrowseFiles={activeCwd !== null}
      workSessions={workSessions}
      focusedWorkId={activeWorkId}
      pinnedCount={pinnedCount}
      ordering={ordering}
      deletingWorkId={deletingWorkId}
      canReplace={activeWorkId !== null}
      disabled={loading}
      pluginApplications={pluginApplications}
      settingsAttention={settingsAttention}
      notifications={appRuntime.notifications}
      onConsumeNotification={consumeAppNotification}
      onDismissNotification={dismissAppNotification}
      onModeChange={changeSidebarMode}
      onRefreshFiles={handleSidebarRefreshFiles}
      onPreviewProject={() => {
        if (!activeCwd) return
        closeMobileDrawer()
        fileRuntime.collapseExpandedWindow()
        pluginHost.previewProject(activeCwd)
      }}
      onOpenTerminal={() => {
        closeMobileDrawer()
        fileRuntime.collapseExpandedWindow()
        void onOpenTerminal(activeCwd ?? undefined).catch(() => undefined)
      }}
      onCreate={openCreatePicker}
      onReplace={openReplacePicker}
      onSettings={() => handleSidebarOpenSettings()}
      onOpenPluginApplication={handleSidebarOpenPluginApplication}
      onSelect={selectSidebarWorkSession}
      onTogglePin={togglePinnedWorkSession}
      onDelete={requestDeleteWorkSession}
      onArrangementChange={requestArrangementUpdate}
    />
  )
  const workSessionContent = (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive"
        >
          <span className="min-w-0 flex-1 wrap-anywhere">{error}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setConnectionAttempt((attempt) => attempt + 1)}
          >
            {t('retry', { ns: 'common' })}
          </Button>
          {loadPhase !== 'initial' ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setError(null)}>
              {t('close', { ns: 'common' })}
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="relative h-full min-h-0 min-w-0 flex-1">
        <L2WorkSessionColumns
          workSessions={workSessions}
          primaryWorkId={layout.primaryWorkId}
          pinnedWorkIds={pinnedWorkIds}
          focusedWorkId={activeWorkId}
          sidebarOpen={sidebarOpen}
          mobile={mobile}
          loading={loading}
          replacingWithEmptyWorkId={replacingWithEmptyWorkId}
          chatRuntime={chatRuntime}
          chatInputRuntime={chatInputRuntime}
          renderTaskSummary={renderTaskSummary}
          renderTaskMenu={renderTaskMenu}
          renderPluginComposerPanel={renderPluginComposerPanel}
          gitRuntime={gitRuntime}
          invokePluginMethod={workbenchBiz.invokePluginMethod}
          listPiCommands={workbenchBiz.listPiCommands}
          getChatModelContext={workbenchBiz.getChatModelContext}
          capabilityModes={appRuntime.capabilityModes}
          setChatCapabilityMode={workbenchBiz.setChatCapabilityMode}
          branchPicker={branchPicker}
          branchPendingWorkId={branchPendingWorkId}
          fileRuntime={fileRuntime}
          onOpenFileSidebar={openFileSidebar}
          onPreviewFile={previewConversationFile}
          onAcknowledgeCompleted={acknowledgeCompleted}
          onFocusWorkSession={focusWorkSession}
          onReplaceWithEmptyWorkSession={requestReplaceWithEmptyWorkSession}
          onOpenBranchPicker={openBranchPicker}
          onOpenGitBranchPicker={openGitBranchPicker}
          onOpenSettings={handleSidebarOpenSettings}
          onCloseBranchPicker={closeBranchPicker}
          onRetryBranchPicker={retryBranchPicker}
          onSelectBranchEntry={selectBranchEntry}
          onBranchAction={requestBranchAction}
          onConfirmRunningBranch={confirmRunningBranch}
          onCancelRunningBranch={cancelRunningBranch}
          onCloneWorkSession={cloneWorkSession}
          onUnpinWorkSession={togglePinnedWorkSession}
          onToggleSidebar={toggleSidebar}
        />
        {loadPhase === 'initial' ? (
          <L2WorkbenchEmptyState
            variant="loading"
            className="absolute inset-0 z-20 bg-background"
          />
        ) : null}
      </div>
    </div>
  )
  const pluginApplicationOpen =
    activePluginApplication !== null && activePluginApplicationDescriptor?.kind === 'application'
  const mainContent = (
    <div className="flex min-h-0 min-w-0 flex-1">
      <WorkbenchDisplaySlot
        render={renderTerminalWorkspace}
        input={{ mobile, children: workSessionContent }}
      />
      {pluginApplicationOpen ? (
        <WorkbenchDisplaySlot
          render={renderPluginApplication}
          input={{
            pluginName: activePluginApplication.pluginName,
            descriptor: activePluginApplicationDescriptor,
            workSessions,
            preferredWorkId: activeWorkId,
            onClose: closePluginApplication
          }}
        />
      ) : null}
    </div>
  )

  return (
    <main className="flex h-dvh overflow-hidden bg-background">
      <L2WorkbenchSidebarLayout
        mobile={mobile}
        open={sidebarOpen}
        sidebar={sidebar}
        onClose={closeMobileDrawer}
      >
        {mainContent}
      </L2WorkbenchSidebarLayout>
      <L2PluginStandaloneFilePreview
        key={
          pluginStandaloneFilePreview
            ? `${pluginStandaloneFilePreview.source.workId}:${pluginStandaloneFilePreview.source.sessionId}:${pluginStandaloneFilePreview.source.branchId}:${pluginStandaloneFilePreview.path}`
            : 'closed'
        }
        target={pluginStandaloneFilePreview}
        biz={fileBiz}
        images={fileRuntime.standaloneImages}
        mobile={mobile}
        onClose={() => setPluginStandaloneFilePreview(null)}
      />
      <L2WorkSessionFilePreview
        workSessions={workSessions}
        runtime={fileRuntime}
        gitRuntime={gitRuntime}
        mobile={mobile}
        onOpenGitBranches={openGitBranchPicker}
        onOpenSidebar={openFileSidebar}
        onOpenTerminal={(cwd) => {
          fileRuntime.collapseExpandedWindow()
          closeMobileDrawer()
          void onOpenTerminal(cwd).catch(() => undefined)
        }}
      />
      <L2GitBranchPicker
        key={
          validGitBranchPickerTarget
            ? `${validGitBranchPickerTarget.workId}:${validGitBranchPickerTarget.cwd}:${validGitBranchPickerTarget.repositoryRoot ?? ''}`
            : 'git-branch-picker-closed'
        }
        target={validGitBranchPickerTarget}
        runtime={gitRuntime}
        mobile={mobile}
        onClose={closeGitBranchPicker}
      />
      <WorkbenchDisplaySlot
        render={renderSettings}
        input={{
          open: settingsOpen,
          connectionReady: loadPhase === 'ready',
          initialPage: settingsInitialPage,
          capabilityModes: appRuntime.capabilityModes,
          workSessions,
          focusedCwd: activeCwd,
          basicMode: appRuntime.mode === 'basic',
          pluginManagementSnapshot,
          pluginAttention: settingsAttention,
          onPluginManagementSnapshot: applyPluginManagementSnapshot,
          onPluginRestartScheduled: schedulePluginManagementRefresh,
          onOpenChange: setSettingsOpen,
          onBeforeReload: () => chatInputRuntime.prepareForPageReload()
        }}
      />
      <L2WorkbenchPickerDialog
        open={directoryDialogOpen}
        pickerMode={pickerMode}
        pickerView={pickerView}
        pickerCwd={pickerCwd}
        directories={directories}
        ignoredDirectories={ignoredDirectories}
        directoryBrowser={directoryBrowser}
        historySessions={historySessions}
        replacementTarget={pickerMode === 'create' ? null : replacementTarget}
        unavailableSessionIds={unavailableSessionIds}
        error={pickerError}
        loading={pickerLoading}
        creatingCwd={creatingCwd}
        replacingSessionId={replacingSessionId}
        updatingIgnoreCwd={updatingIgnoreCwd}
        onOpenChange={(open) => {
          setDirectoryDialogOpen(open)
          if (!open) {
            directoryRequestIdRef.current += 1
            setDirectoriesLoading(false)
            ignoredDirectoryRequestIdRef.current += 1
            setIgnoredDirectoriesLoading(false)
            directoryBrowserRequestIdRef.current += 1
            setDirectoryBrowserLoading(false)
            cancelSessionHistory()
            setPickerMode(null)
            setPickerView('directories')
            setPickerError(null)
          }
        }}
        onBack={returnToDirectoryList}
        onSearchHistory={(query, searchIn) => {
          if (pickerView === 'history' && pickerCwd) {
            void loadSessionHistory(pickerCwd, query, searchIn)
          }
        }}
        onListSessionUserMessages={(input, signal) =>
          workbenchBiz.listSessionUserMessages(input, signal)
        }
        onRefresh={(query, searchIn) => {
          if (pickerView === 'history' && pickerCwd) {
            void loadSessionHistory(pickerCwd, query, searchIn, true)
          } else if (pickerView === 'ignored') void loadIgnoredDirectories(true)
          else if (pickerView === 'browser') {
            void loadDirectoryEntries(directoryBrowser?.cwd ?? null)
          } else void loadDirectories(true)
        }}
        onOpenIgnoredDirectories={openIgnoredDirectoryList}
        onOpenDirectoryBrowser={openDirectoryBrowser}
        onNavigateDirectory={navigateDirectoryBrowser}
        onSelectBrowserDirectory={(cwd) => void createWorkSession(cwd)}
        onReplaceDirectoryIgnore={(cwd, ignored) => void replaceDirectoryIgnore(cwd, ignored)}
        onSelectDirectory={(cwd) => {
          if (pickerMode === 'replace') {
            directoryRequestIdRef.current += 1
            setDirectoriesLoading(false)
            setPickerView('history')
            setPickerCwd(cwd)
            showCachedSessionHistory(cwd)
            void loadSessionHistory(cwd)
          } else {
            void createWorkSession(cwd)
          }
        }}
        onSelectSession={(sessionId) => void replaceWorkSession(sessionId)}
      />
    </main>
  )
}
