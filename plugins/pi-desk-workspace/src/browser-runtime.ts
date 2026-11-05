import type {
  PluginJsonObject,
  PluginPushMessage,
  PluginSource
} from '@jetcrab/pi-desk-sdk/browser'
import type { WorkspaceChangedEvent, WorkspaceSnapshot } from './contract.js'
import type { WorkspaceCommandDraft } from './l2-workspace-browser-model.js'

export type BrowserWorkspaceChangedEvent = WorkspaceChangedEvent & {
  source: PluginSource
}

type Listener = (event: BrowserWorkspaceChangedEvent) => void

const listeners = new Set<Listener>()

export type WorkspaceSubmission = {
  source: PluginSource
  workspaceId: string
  draft: WorkspaceCommandDraft
  error: string | null
}

type SubmissionListener = (failure?: WorkspaceSubmission) => void
const submissionListeners = new Set<SubmissionListener>()
let submissions: readonly WorkspaceSubmission[] = []

export function sameWorkspaceSource(left: PluginSource, right: PluginSource): boolean {
  return (
    left.workId === right.workId &&
    left.sessionId === right.sessionId &&
    left.branchId === right.branchId
  )
}

export function getWorkspaceSubmissions(): readonly WorkspaceSubmission[] {
  return submissions
}

export function subscribeWorkspaceSubmissions(listener: SubmissionListener): () => void {
  submissionListeners.add(listener)
  return () => submissionListeners.delete(listener)
}

function updateSubmissions(
  next: readonly WorkspaceSubmission[],
  failure?: WorkspaceSubmission
): void {
  submissions = next
  for (const listener of submissionListeners) listener(failure)
}

export function reconcileWorkspaceSubmissions(
  source: PluginSource,
  snapshot: WorkspaceSnapshot
): void {
  const next = submissions.filter((item) => {
    if (!item.error || !sameWorkspaceSource(item.source, source)) return true
    return snapshot.workspaces.some(
      (workspace) =>
        workspace.id === item.workspaceId &&
        (workspace.workspaceRef ?? workspace.id) === item.draft.workspaceRef
    )
  })
  if (next.length !== submissions.length) updateSubmissions(next)
}

export async function submitWorkspaceCommand(
  input: Omit<WorkspaceSubmission, 'error'>,
  invoke: () => Promise<PluginJsonObject>
): Promise<PluginJsonObject | null> {
  const matches = (item: WorkspaceSubmission): boolean =>
    sameWorkspaceSource(item.source, input.source) && item.workspaceId === input.workspaceId
  if (submissions.some((item) => matches(item) && !item.error)) return null
  const submission: WorkspaceSubmission = {
    ...input,
    draft: { ...input.draft, confirmation: null },
    error: null
  }
  updateSubmissions([...submissions.filter((item) => !matches(item)), submission])
  try {
    const value = await invoke()
    if (!submissions.includes(submission)) return null
    updateSubmissions(submissions.filter((item) => item !== submission))
    return value
  } catch (cause) {
    if (!submissions.includes(submission)) return null
    const message = cause instanceof Error ? cause.message : String(cause)
    console.warn('[workspace] 工作区命令提交失败', {
      workspaceId: input.workspaceId,
      command: input.draft.commandId,
      error: message
    })
    const failure = {
      ...submission,
      error: `提交未确认：${message}。请查看活动记录或刷新状态，确认后再操作。`
    }
    const others = submissions.filter((item) => item !== submission)
    // 仅保留最近20份失败草稿；在途请求由完成回调释放，插件释放时全部清空。
    updateSubmissions(
      [
        ...others.filter((item) => !item.error),
        ...others.filter((item) => item.error).slice(-19),
        failure
      ],
      failure
    )
    return null
  }
}

export const WORKSPACE_SNAPSHOT_TIMEOUT_MS = 10_000

export async function withWorkspaceSnapshotTimeout<T>(
  request: Promise<T>,
  timeoutMs = WORKSPACE_SNAPSHOT_TIMEOUT_MS
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      request,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`读取工作区超时（${Math.ceil(timeoutMs / 1_000)} 秒）`)),
          timeoutMs
        )
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function publishWorkspaceChanged(
  message: PluginPushMessage
): BrowserWorkspaceChangedEvent | null {
  if (
    message.pluginName !== 'workspace' ||
    message.event !== 'changed' ||
    message.target.scope !== 'session'
  ) {
    return null
  }

  const workspaceId = message.data.workspaceId
  const summary = message.data.summary
  const level = message.data.level
  if (workspaceId !== null && typeof workspaceId !== 'string') return null
  if (summary !== undefined && typeof summary !== 'string') return null
  if (level !== undefined && level !== 'error') return null

  const event: BrowserWorkspaceChangedEvent = {
    source: message.target.source,
    workspaceId,
    ...(summary ? { summary } : {}),
    ...(level ? { level } : {})
  }
  for (const listener of listeners) listener(event)
  return event
}

export function subscribeWorkspaceChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function resetWorkspaceBrowserRuntime(): void {
  listeners.clear()
  submissionListeners.clear()
  submissions = []
}
