import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  copyBrowserText,
  type BrowserPluginHost,
  type BrowserSessionSidebarTabTarget,
  type PluginJsonObject
} from '@jetcrab/pi-desk-sdk/browser'
import { subscribeWorkspaceChanged, withWorkspaceSnapshotTimeout } from './browser-runtime.js'
import type {
  JsonValue,
  WorkspaceCommandSummary,
  WorkspaceSnapshot,
  WorkspaceSnapshotItem
} from './contract.js'
import {
  initialWorkspaceForm,
  parseWorkspaceForm,
  type WorkspaceDetailTab,
  type WorkspaceDialogState,
  type WorkspaceFormValue
} from './l2-workspace-browser-model.js'

function snapshotFrom(value: PluginJsonObject): WorkspaceSnapshot {
  if (!Array.isArray(value.definitions) || !Array.isArray(value.workspaces)) {
    throw new Error('工作区快照格式无效')
  }
  return value as unknown as WorkspaceSnapshot
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type WorkspaceBrowserController = {
  snapshot: WorkspaceSnapshot | null
  refreshing: boolean
  error: string | null
  pending: string | null
  connectionReady: boolean
  dialog: WorkspaceDialogState | null
  workspace: WorkspaceSnapshotItem | null
  command: WorkspaceCommandSummary | null
  commandInvalid: boolean
  refresh(): Promise<WorkspaceSnapshot | null>
  openDetail(workspaceId: string): void
  closeDetail(): void
  selectTab(tab: WorkspaceDetailTab): void
  openCommand(commandId: string): void
  backToDetail(): void
  setValue(name: string, value: WorkspaceFormValue): void
  executeCommand(): void
  confirmCommand(): Promise<void>
  cancelConfirm(): void
  switchActive(): Promise<void>
  goToSourceSession(): Promise<void>
  previewProject(): void
  copyWorkspace(): Promise<void>
}

export function useWorkspaceBrowserBiz(
  target: BrowserSessionSidebarTabTarget,
  host: BrowserPluginHost,
  signal: AbortSignal
): WorkspaceBrowserController {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null)
  const [dialog, setDialog] = useState<WorkspaceDialogState | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const pendingRef = useRef<string | null>(null)
  const refreshEpoch = useRef(0)
  const connectionReady = useSyncExternalStore(
    host.connection.subscribe,
    () => host.connection.getSnapshot().status === 'ready',
    () => false
  )

  const invoke = useCallback(
    (method: string, input: PluginJsonObject = {}): Promise<PluginJsonObject> =>
      host.piDesk.invokeSession(target.source, method, input),
    [host, target.source]
  )

  const applySnapshot = useCallback((next: WorkspaceSnapshot): void => {
    const running = pendingRef.current?.startsWith('run:') === true
    setSnapshot(next)
    setDialog((current) => {
      if (!current) return null
      const item = next.workspaces.find((entry) => entry.id === current.workspaceId)
      if (!item) return null
      // 手工表单只绑定打开时的 assignment，不能悄悄接管重新分配后的工作区。
      if (!running && current.command) {
        const selected = next.definitions
          .find((entry) => entry.id === item.definition)
          ?.commands.find((entry) => entry.id === current.command?.commandId)
        if (
          current.command.workspaceRef !== (item.workspaceRef ?? item.id) ||
          !selected?.from.includes(item.status)
        ) {
          return { ...current, tab: 'actions', command: null }
        }
      }
      return current
    })
  }, [])

  const refresh = useCallback(async (): Promise<WorkspaceSnapshot | null> => {
    if (signal.aborted) return null
    const epoch = ++refreshEpoch.current
    setRefreshing(true)
    try {
      const next = snapshotFrom(await withWorkspaceSnapshotTimeout(invoke('snapshot')))
      if (signal.aborted || epoch !== refreshEpoch.current) return null
      setRefreshError(null)
      applySnapshot(next)
      return next
    } catch (cause) {
      if (!signal.aborted && epoch === refreshEpoch.current) {
        console.warn('[workspace] 读取工作区失败', {
          workId: target.source.workId,
          error: messageOf(cause)
        })
        setRefreshError(messageOf(cause))
      }
      return null
    } finally {
      if (!signal.aborted && epoch === refreshEpoch.current) setRefreshing(false)
    }
  }, [applySnapshot, invoke, signal, target.source.workId])

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (!active) return
      if (connectionReady) {
        void refresh()
      } else {
        setDialog((current) =>
          current?.command?.confirmation
            ? { ...current, command: { ...current.command, confirmation: null } }
            : current
        )
      }
    })
    const unsubscribe = subscribeWorkspaceChanged((event) => {
      const source = target.source
      if (
        connectionReady &&
        event.source.workId === source.workId &&
        event.source.sessionId === source.sessionId &&
        event.source.branchId === source.branchId
      ) {
        void refresh()
      }
    })
    return () => {
      active = false
      refreshEpoch.current += 1
      unsubscribe()
    }
  }, [connectionReady, refresh, target.source])

  const workspace = snapshot?.workspaces.find((item) => item.id === dialog?.workspaceId) ?? null
  const definition = snapshot?.definitions.find((item) => item.id === workspace?.definition)
  const command =
    definition?.commands.find((item) => item.id === dialog?.command?.commandId) ?? null
  const commandInvalid = Boolean(
    dialog?.command &&
    (!workspace ||
      !command ||
      dialog.command.workspaceRef !== (workspace.workspaceRef ?? workspace.id) ||
      !command.from.includes(workspace.status))
  )

  function beginAction(key: string): boolean {
    if (pendingRef.current || !connectionReady || signal.aborted) return false
    pendingRef.current = key
    setPending(key)
    setActionError(null)
    return true
  }

  function endAction(): void {
    pendingRef.current = null
    if (!signal.aborted) setPending(null)
  }

  function reportActionError(cause: unknown): void {
    console.warn('[workspace] 工作区操作失败', {
      action: pendingRef.current,
      workId: target.source.workId,
      error: messageOf(cause)
    })
    if (!signal.aborted) setActionError(messageOf(cause))
  }

  function closeDetail(): void {
    setDialog(null)
    setActionError(null)
  }

  function openDetail(workspaceId: string): void {
    if (pendingRef.current) return
    setActionError(null)
    setDialog({ workspaceId, tab: 'records', command: null })
  }

  function selectTab(tab: WorkspaceDetailTab): void {
    setDialog((current) => (current ? { ...current, tab } : null))
  }

  function openCommand(commandId: string): void {
    if (!workspace || !dialog || pendingRef.current || workspace.issue) return
    const selected = definition?.commands.find(
      (item) => item.id === commandId && item.from.includes(workspace.status)
    )
    if (!selected) return
    setActionError(null)
    setDialog({
      ...dialog,
      command: {
        commandId,
        workspaceRef: workspace.workspaceRef ?? workspace.id,
        values: initialWorkspaceForm(selected.parameters),
        confirmation:
          selected.onSuccess !== 'occupied' &&
          Object.keys(selected.parameters.properties).length === 0
            ? {}
            : null
      }
    })
  }

  function backToDetail(): void {
    if (pendingRef.current) return
    setActionError(null)
    setDialog((current) => (current ? { ...current, command: null } : null))
  }

  function setValue(name: string, value: WorkspaceFormValue): void {
    setDialog((current) =>
      current?.command
        ? {
            ...current,
            command: { ...current.command, values: { ...current.command.values, [name]: value } }
          }
        : current
    )
  }

  function cancelConfirm(): void {
    if (pendingRef.current) return
    setDialog((current) =>
      current?.command
        ? {
            ...current,
            command:
              command && Object.keys(command.parameters.properties).length === 0
                ? null
                : { ...current.command, confirmation: null }
          }
        : current
    )
  }

  async function runCommand(parameters: Record<string, JsonValue>): Promise<void> {
    const draft = dialog?.command
    if (!draft || !workspace || !command || commandInvalid || workspace.issue) return
    if (!beginAction(`run:${workspace.id}:${command.id}`)) return
    try {
      const value = await invoke('run', {
        workspace: draft.workspaceRef,
        command: command.id,
        parameters
      })
      if (signal.aborted) return
      // 命令响应建立新基线，之前发出的读取不能覆盖操作结果。
      refreshEpoch.current += 1
      setRefreshing(false)
      const next =
        value.snapshot && typeof value.snapshot === 'object' && !Array.isArray(value.snapshot)
          ? snapshotFrom(value.snapshot as PluginJsonObject)
          : await refresh()
      if (signal.aborted) return
      if (next) applySnapshot(next)
      setDialog((current) => {
        if (current?.command !== draft) return current
        const item = next?.workspaces.find((entry) => entry.id === workspace.id)
        if (command.onSuccess === 'removed' || (next && !item)) return null
        return { ...current, command: null, tab: 'records' }
      })
      host.notify({ level: 'success', title: '工作区命令已完成' })
    } catch (cause) {
      reportActionError(cause)
      await refresh()
      // 失败回到表单，原参数保留；不自动重放结果未知的调用。
      if (!signal.aborted)
        setDialog((current) =>
          current?.command === draft
            ? {
                ...current,
                command: { ...draft, confirmation: null }
              }
            : current
        )
    } finally {
      endAction()
    }
  }

  function executeCommand(): void {
    if (!dialog?.command || !command || commandInvalid || workspace?.issue || pendingRef.current)
      return
    try {
      const parameters = parseWorkspaceForm(command.parameters, dialog.command.values)
      setActionError(null)
      if (command.onSuccess === 'occupied') {
        void runCommand(parameters)
      } else {
        setDialog({ ...dialog, command: { ...dialog.command, confirmation: parameters } })
      }
    } catch (cause) {
      setActionError(messageOf(cause))
    }
  }

  async function confirmCommand(): Promise<void> {
    if (dialog?.command?.confirmation) await runCommand(dialog.command.confirmation)
  }

  async function switchActive(): Promise<void> {
    if (!workspace?.workspaceRef || workspace.issue || !beginAction(`use:${workspace.id}`)) return
    try {
      const next = snapshotFrom(
        await invoke('use', { workspace: workspace.active ? null : workspace.workspaceRef })
      )
      if (!signal.aborted) {
        refreshEpoch.current += 1
        setRefreshing(false)
        applySnapshot(next)
      }
    } catch (cause) {
      reportActionError(cause)
    } finally {
      endAction()
    }
  }

  async function goToSourceSession(): Promise<void> {
    const sessionId = workspace?.occupation?.sourceSessionId
    if (!sessionId || !beginAction(`session:${workspace.id}`)) return
    try {
      await host.workSessions.goTo({ sessionId, cwd: target.cwd })
      if (!signal.aborted) closeDetail()
    } catch (cause) {
      reportActionError(cause)
    } finally {
      endAction()
    }
  }

  function previewProject(): void {
    if (!workspace || !host.projects?.preview) return
    const directory = workspace.root
    closeDetail()
    try {
      host.projects.preview(directory)
    } catch (cause) {
      host.notify({ level: 'error', title: '打开项目预览失败', description: messageOf(cause) })
    }
  }

  async function copyWorkspace(): Promise<void> {
    if (!workspace) return
    const separator = workspace.root.includes('\\') ? '\\' : '/'
    const metadata = `${workspace.root.replace(/[\\/]$/u, '')}${separator}.pi-workspace`
    const content = [
      '隔离工作区信息：',
      `工作区引用：${workspace.workspaceRef ?? workspace.id}`,
      `需求：${workspace.occupation?.requirement ?? '未占用'}`,
      `状态：${workspace.status}`,
      `Definition：${workspace.definition}`,
      `Root：${workspace.root}`,
      `插件元数据：${metadata}`
    ].join('\n')
    const copied = await copyBrowserText(content)
    if (!signal.aborted)
      host.notify({
        level: copied ? 'success' : 'error',
        title: copied ? '工作区信息已复制' : '复制失败'
      })
  }

  return {
    snapshot,
    refreshing,
    error: actionError ?? refreshError,
    pending,
    connectionReady,
    dialog,
    workspace,
    command,
    commandInvalid,
    refresh,
    openDetail,
    closeDetail,
    selectTab,
    openCommand,
    backToDetail,
    setValue,
    executeCommand,
    confirmCommand,
    cancelConfirm,
    switchActive,
    goToSourceSession,
    previewProject,
    copyWorkspace
  }
}
