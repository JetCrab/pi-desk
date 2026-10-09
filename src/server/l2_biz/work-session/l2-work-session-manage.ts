import 'server-only'

import { getL4PiDeskDataDir } from '@server/l4_foundation/pi/l4-pi-desk-data-dir'

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import type {
  L2ChatModelContextGetRequest,
  L2ChatModelContextGetResponse
} from '@common/l2_biz/chat/l2-chat-context-contract'
import type {
  L2ChatImageGetRequest,
  L2ChatImageGetResponse,
  L2ChatMessageDetailRequest,
  L2ChatMessageDetailResponse,
  L2ChatSource
} from '@common/l2_biz/chat/l2-chat-contract'
import type {
  L2ChatModelSetRequest,
  L2ChatCapabilityModeSetRequest,
  L2ChatQueueRestoreResponse,
  L2ChatSendRequest,
  L2ChatSendResponse,
  L2ChatSessionSyncEvent,
  L2ChatSubscribeRequest
} from '@common/l2_biz/chat/l2-chat-websocket-contract'
import type {
  L2PluginInvokeRequest,
  L2PluginInvokeResponse
} from '@common/l2_biz/plugin/l2-plugin-websocket-contract'
import {
  L3PiNativeBashResultSchema,
  L3PiNativeCommandsListResponseSchema,
  L3PiNativeToolsListResponseSchema,
  type L3PiNativeBashAbortRequest,
  type L3PiNativeBashExecuteRequest,
  type L3PiNativeBashResult,
  type L3PiNativeCommandExecuteRequest,
  type L3PiNativeCommandsListRequest,
  type L3PiNativeCommandsListResponse,
  type L3PiNativeToolsListRequest,
  type L3PiNativeToolsListResponse
} from '@common/l3_modules/plugin-host/l3-plugin-native-pi-contract'
import type { L3PluginPushMessage } from '@common/l3_modules/plugin-host/l3-plugin-push-contract'
import {
  L2PiModelsListResponseSchema,
  type L2PiModelsListResponse
} from '@common/l2_biz/pi-model/l2-pi-model-contract'
import {
  L2WorkSessionGitBranchAddRequestSchema,
  L2WorkSessionGitBranchOperationResponseSchema,
  L2WorkSessionGitBranchReplaceRequestSchema,
  type L2WorkSessionGitBranchAddRequest,
  type L2WorkSessionGitBranchOperationResponse,
  type L2WorkSessionGitBranchReplaceRequest
} from '@common/l2_biz/work-session/l2-work-session-git-contract'
import {
  L2CwdSchema,
  L2PiSessionIdSchema,
  L2WorkIdSchema,
  L2WorkSessionListItemSchema,
  L2WorkSessionListResponseSchema,
  L2WorkSessionPinnedCountSchema,
  L2WorkSessionRecordSchema,
  L2WorkSessionRecordsSchema,
  type L2WorkSessionListItem,
  type L2WorkSessionListResponse,
  type L2WorkSessionRecord,
  type L2WorkSessionStatus
} from '@common/l2_biz/work-session/l2-work-session-contract'
import {
  L2WorkSessionChangesSchema,
  L2WorkSessionsUpdateSchema,
  type L2WorkSessionChanges,
  type L2WorkSessionsUpdate
} from '@common/l2_biz/work-session/l2-work-session-realtime-contract'
import {
  L2WorkSessionBranchRequestSchema,
  L2WorkSessionBranchResponseSchema,
  L2WorkSessionTreeEntryGetRequestSchema,
  L2WorkSessionTreeEntryGetResponseSchema,
  L2WorkSessionTreeGetRequestSchema,
  L2WorkSessionTreeGetResponseSchema,
  type L2WorkSessionBranchRequest,
  type L2WorkSessionBranchResponse,
  type L2WorkSessionTreeEntryGetRequest,
  type L2WorkSessionTreeEntryGetResponse,
  type L2WorkSessionTreeGetRequest,
  type L2WorkSessionTreeGetResponse
} from '@common/l2_biz/work-session/l2-work-session-tree-contract'
import { WorkSession } from '@server/l3_modules/work-session/l3-work-session'
import {
  addL4WorkSessionGitBranch,
  replaceL4WorkSessionGitBranch
} from '@server/l4_foundation/git/l4-work-session-git'
import { resolveL4ExistingPiDirectory } from '@server/l4_foundation/pi/l4-pi-directory-browser'
import { resolveL4PiSessionPath } from '@server/l4_foundation/pi/l4-pi-session-catalog'
import {
  getL4PiWorkSessionRuntime,
  L4PiSessionBranchBlockedError,
  L4PiSessionCloneEmptyError
} from '@server/l4_foundation/pi/l4-pi-work-session-runtime'
import {
  L4PiSessionEntryNotFoundError,
  L4PiSessionForkTargetError
} from '@server/l4_foundation/pi/l4-pi-session-tree'
import {
  L2ChatSourceBindingError,
  L2WorkSessionChatRuntime,
  type L2WorkSessionChatMetadata,
  type L2WorkSessionChatRuntimeEvent
} from './l2-work-session-chat-runtime'

const WORK_SESSION_FILE_NAME = 'work-sessions.json'

const L2WorkSessionPersistedStateSchema = z
  .object({
    workSessions: L2WorkSessionRecordsSchema,
    pinnedCount: L2WorkSessionPinnedCountSchema
  })
  .strict()
  .refine((value) => value.pinnedCount <= value.workSessions.length, {
    message: 'pinnedCount cannot exceed persisted work session count',
    path: ['pinnedCount']
  })

interface RestoredWorkSessionState {
  workSessions: L2WorkSessionRecord[]
  pinnedCount: number
  rewriteLegacyStore: boolean
}

function defaultStorePath(): string {
  return join(getL4PiDeskDataDir(), WORK_SESSION_FILE_NAME)
}

export class WorkSessionOrderConflictError extends Error {
  constructor() {
    super('WorkSession order does not match the current collection')
    this.name = 'WorkSessionOrderConflictError'
  }
}

export class WorkSessionNotFoundError extends Error {
  constructor(workId: string) {
    super(`WorkSession not found: ${workId}`)
    this.name = 'WorkSessionNotFoundError'
  }
}

export class WorkSessionSessionConflictError extends Error {
  constructor(sessionId: string, workId: string) {
    super(`Pi session ${sessionId} is already bound to work session ${workId}`)
    this.name = 'WorkSessionSessionConflictError'
  }
}

export class WorkSessionHistoryNotFoundError extends Error {
  constructor(cwd: string, sessionId: string) {
    super(`Pi session ${sessionId} was not found in ${cwd}`)
    this.name = 'WorkSessionHistoryNotFoundError'
  }
}

export class WorkSessionProjectChangedError extends Error {
  constructor(workId: string, expectedCwd: string, actualCwd: string) {
    super(`WorkSession project changed: ${workId} (${expectedCwd} -> ${actualCwd})`)
    this.name = 'WorkSessionProjectChangedError'
  }
}

export class WorkSessionBindingChangedError extends Error {
  constructor(workId: string, expectedSessionId: string, actualSessionId: string) {
    super(`WorkSession binding changed: ${workId} (${expectedSessionId} -> ${actualSessionId})`)
    this.name = 'WorkSessionBindingChangedError'
  }
}

export class WorkSessionBranchEntryNotFoundError extends Error {
  constructor(entryId: string) {
    super(`WorkSession branch entry was not found: ${entryId}`)
    this.name = 'WorkSessionBranchEntryNotFoundError'
  }
}

export class WorkSessionBranchBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkSessionBranchBlockedError'
  }
}

export class WorkSessionBranchInvalidError extends Error {
  constructor(
    readonly kind: 'fork-target' | 'clone-empty',
    message: string
  ) {
    super(message)
    this.name = 'WorkSessionBranchInvalidError'
  }
}

class WorkSessionDirectoryInvalidError extends Error {
  constructor(cwd: string) {
    super(`WorkSession project directory is invalid: ${cwd}`)
    this.name = 'WorkSessionDirectoryInvalidError'
  }
}

export function isWorkSessionDirectoryInvalidError(error: unknown): boolean {
  return error instanceof Error && error.name === 'WorkSessionDirectoryInvalidError'
}

type WorkSessionUpdateListener = (update: L2WorkSessionsUpdate) => void
type WorkSessionMessageListener = (event: L2WorkSessionChatRuntimeEvent) => void
type WorkSessionPluginPushListener = (message: L3PluginPushMessage) => void

export class WorkSessionManage {
  private readonly workSessionsById = new Map<string, WorkSession>()
  private readonly updateListeners = new Set<WorkSessionUpdateListener>()
  private readonly chat = new L2WorkSessionChatRuntime()
  private readonly restoredRecords: L2WorkSessionRecord[]
  private pinnedCount: number
  private rewriteLegacyStore: boolean
  private hydrated = false
  private operationTail: Promise<void> = Promise.resolve()

  constructor(private readonly storePath = defaultStorePath()) {
    const restored = this.readPersistedState()
    this.restoredRecords = restored.workSessions
    this.pinnedCount = restored.pinnedCount
    this.rewriteLegacyStore = restored.rewriteLegacyStore
    this.chat.subscribeRecordChanges((workId, previousMetadata, previousStatus) =>
      this.publishChatRecordChange(workId, previousMetadata, previousStatus)
    )
  }

  initialize(): Promise<void> {
    return this.runExclusive(() => this.ensureHydrated())
  }

  listWorkSessions(): Promise<L2WorkSessionListResponse> {
    return this.runExclusive(async () => {
      await this.ensureHydrated()
      return this.createSnapshot()
    })
  }

  refreshPluginMessages(): void {
    this.chat.refreshPluginMessages()
  }

  runPluginRestart<T>(operation: () => Promise<T>): Promise<T> {
    return this.runExclusive(async () => {
      await this.ensureHydrated()
      const resume = await this.chat.pauseForProcessRestart()
      try {
        const result = await operation()
        console.info('[Pi Desk][WorkSessionManage] 全部工作会话已冻结，等待插件重载')
        return result
      } catch (error) {
        resume()
        throw error
      }
    })
  }

  subscribeUpdates(listener: WorkSessionUpdateListener): () => void {
    this.updateListeners.add(listener)
    return () => this.updateListeners.delete(listener)
  }

  subscribeMessageEvents(listener: WorkSessionMessageListener): () => void {
    return this.chat.subscribe(listener)
  }

  subscribePluginPushEvents(listener: WorkSessionPluginPushListener): () => void {
    return this.chat.subscribePluginPush(listener)
  }

  async prepareChatSourceSyncs(
    subscriptions: L2ChatSubscribeRequest['subscriptions']
  ): Promise<Array<{ source: L2ChatSource; event: L2ChatSessionSyncEvent; watermark: number }>> {
    await this.initialize()
    const invalid = subscriptions.find(
      (subscription) => !this.chat.isCurrentSource(subscription.source)
    )
    if (invalid) throw new L2ChatSourceBindingError(invalid.source)

    await Promise.all(
      subscriptions.map((subscription) =>
        this.chat.prepareSource(subscription.source).catch((error: unknown) => {
          // 初始化期间删除或替换的 Source 已无人消费，不再把取消当成订阅故障。
          if (this.chat.isCurrentSource(subscription.source)) throw error
        })
      )
    )
    return subscriptions
      .filter((subscription) => this.chat.isCurrentSource(subscription.source))
      .map((subscription) => {
        const sync = this.chat.createSync(subscription.source, subscription.cursor)
        return { source: subscription.source, event: sync.event, watermark: sync.watermark }
      })
  }

  async getChatMessageDetail(
    input: L2ChatMessageDetailRequest
  ): Promise<L2ChatMessageDetailResponse> {
    await this.initialize()
    return this.chat.getMessageDetail(input)
  }

  async getChatModelContext(
    input: L2ChatModelContextGetRequest
  ): Promise<L2ChatModelContextGetResponse> {
    await this.initialize()
    return this.chat.getModelContext(input)
  }

  async getChatImage(input: L2ChatImageGetRequest): Promise<L2ChatImageGetResponse> {
    await this.initialize()
    return this.chat.getImage(input)
  }

  async sendChat(input: L2ChatSendRequest): Promise<L2ChatSendResponse> {
    await this.initialize()
    return this.chat.send(input)
  }

  async interruptChat(source: L2ChatSource): Promise<void> {
    await this.initialize()
    await this.chat.interrupt(source)
  }

  async compactChat(source: L2ChatSource): Promise<void> {
    await this.initialize()
    await this.chat.compact(source)
  }

  async reloadChat(source: L2ChatSource, mode?: 'normal' | 'basic'): Promise<void> {
    await this.initialize()
    await this.chat.reload(source, mode)
  }

  async setChatPresentation(source: L2ChatSource, mode: 'normal' | 'basic'): Promise<void> {
    await this.initialize()
    await this.chat.setPresentation(source, mode)
  }

  async restoreChatQueue(source: L2ChatSource): Promise<L2ChatQueueRestoreResponse> {
    await this.initialize()
    return this.chat.restoreQueuedMessages(source)
  }

  async setChatModel(input: L2ChatModelSetRequest): Promise<void> {
    await this.initialize()
    await this.chat.setModel(input)
  }

  async setChatCapabilityMode(input: L2ChatCapabilityModeSetRequest): Promise<void> {
    await this.initialize()
    await this.chat.setCapabilityMode(input)
  }

  getNativeUi(
    source: L2ChatSource
  ): import('@server/l4_foundation/pi/l4-pi-ui-runtime').L4PiUiRuntime {
    if (!this.chat.isCurrentSource(source)) throw new L2ChatSourceBindingError(source)
    return getL4PiWorkSessionRuntime(source.sessionId).nativeUi
  }

  async invokeSessionPluginMethod(
    input: Extract<L2PluginInvokeRequest, { scope: 'session' }>
  ): Promise<L2PluginInvokeResponse> {
    await this.initialize()
    return this.chat.invokePluginMethod(input)
  }

  async listNativeCommands(
    input: L3PiNativeCommandsListRequest
  ): Promise<L3PiNativeCommandsListResponse> {
    await this.initialize()
    return L3PiNativeCommandsListResponseSchema.parse({
      commands: await this.chat.listNativeCommands(input.source)
    })
  }

  async executeNativeCommand(input: L3PiNativeCommandExecuteRequest): Promise<void> {
    await this.initialize()
    await this.chat.executeNativeCommand(input.source, input.command, input.args ?? '')
  }

  async listNativeTools(input: L3PiNativeToolsListRequest): Promise<L3PiNativeToolsListResponse> {
    await this.initialize()
    return L3PiNativeToolsListResponseSchema.parse({
      tools: await this.chat.listNativeTools(input.source)
    })
  }

  async executeDirectBash(input: L3PiNativeBashExecuteRequest): Promise<L3PiNativeBashResult> {
    await this.initialize()
    return L3PiNativeBashResultSchema.parse(
      await this.chat.executeDirectBash(input.source, {
        command: input.command,
        excludeFromContext: input.excludeFromContext
      })
    )
  }

  async abortDirectBash(input: L3PiNativeBashAbortRequest): Promise<void> {
    await this.initialize()
    await this.chat.abortDirectBash(input.source)
  }

  async listModels(workIdInput: string): Promise<L2PiModelsListResponse> {
    const workId = L2WorkIdSchema.parse(workIdInput)
    await this.initialize()
    const workSession = this.workSessionsById.get(workId)
    if (!workSession) throw new WorkSessionNotFoundError(workId)
    return L2PiModelsListResponseSchema.parse(
      await getL4PiWorkSessionRuntime(workSession.sessionId).listModels()
    )
  }

  async acknowledgeCompleted(workIdInput: string): Promise<boolean> {
    const workId = L2WorkIdSchema.parse(workIdInput)
    await this.initialize()
    if (!this.workSessionsById.has(workId)) throw new WorkSessionNotFoundError(workId)
    return this.chat.acknowledgeCompleted(workId)
  }

  setWorkSessionArrangement(
    workIdsInput: readonly string[],
    pinnedCountInput: number
  ): Promise<L2WorkSessionListResponse> {
    const workIds = workIdsInput.map((workId) => L2WorkIdSchema.parse(workId))
    const pinnedCount = L2WorkSessionPinnedCountSchema.parse(pinnedCountInput)
    return this.runExclusive(async () => {
      await this.ensureHydrated()
      const currentIds = Array.from(this.workSessionsById.keys())
      if (
        workIds.length !== currentIds.length ||
        pinnedCount > workIds.length ||
        new Set(workIds).size !== workIds.length ||
        workIds.some((workId) => !this.workSessionsById.has(workId))
      ) {
        throw new WorkSessionOrderConflictError()
      }

      const orderUnchanged = workIds.every((workId, index) => workId === currentIds[index])
      if (orderUnchanged && pinnedCount === this.pinnedCount) return this.createSnapshot()

      const ordered = workIds.map((workId) => this.workSessionsById.get(workId)!)
      this.workSessionsById.clear()
      for (const workSession of ordered) {
        this.workSessionsById.set(workSession.workId, workSession)
      }
      this.pinnedCount = pinnedCount
      this.persist()
      const snapshot = this.createSnapshot()
      this.publishUpdate({ type: 'snapshot', ...snapshot })
      console.info('[Pi Desk][WorkSessionManage] 已更新工作会话排列', {
        workIds,
        pinnedCount
      })
      return snapshot
    })
  }

  getWorkSession(workIdInput: string): Promise<WorkSession | null> {
    const workId = L2WorkIdSchema.parse(workIdInput)
    return this.runExclusive(async () => {
      await this.ensureHydrated()
      return this.workSessionsById.get(workId) ?? null
    })
  }

  async replaceProjectGitBranch(
    inputValue: L2WorkSessionGitBranchReplaceRequest
  ): Promise<L2WorkSessionGitBranchOperationResponse> {
    const input = L2WorkSessionGitBranchReplaceRequestSchema.parse(inputValue)
    const cwd = await this.authorizeProjectFiles(input.workId, input.cwd)
    const repository = await replaceL4WorkSessionGitBranch(cwd, input.repositoryRoot, input.target)
    console.info('[Pi Desk][WorkSessionManage] 已切换 Git 分支', {
      workId: input.workId,
      cwd,
      repositoryRoot: input.repositoryRoot,
      targetType: input.target.type,
      targetName: input.target.name
    })
    return L2WorkSessionGitBranchOperationResponseSchema.parse({ repository })
  }

  async addProjectGitBranch(
    inputValue: L2WorkSessionGitBranchAddRequest
  ): Promise<L2WorkSessionGitBranchOperationResponse> {
    const input = L2WorkSessionGitBranchAddRequestSchema.parse(inputValue)
    const cwd = await this.authorizeProjectFiles(input.workId, input.cwd)
    const repository = await addL4WorkSessionGitBranch(
      cwd,
      input.repositoryRoot,
      input.name,
      input.startPoint
    )
    console.info('[Pi Desk][WorkSessionManage] 已新建并切换 Git 分支', {
      workId: input.workId,
      cwd,
      repositoryRoot: input.repositoryRoot,
      branchName: input.name,
      startPointType: input.startPoint?.type ?? null,
      startPointName: input.startPoint?.name ?? null
    })
    return L2WorkSessionGitBranchOperationResponseSchema.parse({ repository })
  }

  createWorkSession(cwdInput: string, sessionIdInput?: string): Promise<L2WorkSessionListItem> {
    const cwdValue = L2CwdSchema.parse(cwdInput)
    const sessionId =
      sessionIdInput === undefined ? undefined : L2PiSessionIdSchema.parse(sessionIdInput)
    let cwd: string
    try {
      cwd = resolveL4ExistingPiDirectory(cwdValue)
    } catch {
      throw new WorkSessionDirectoryInvalidError(cwdValue)
    }
    return this.runExclusive(async () => {
      await this.ensureHydrated()
      if (sessionId) {
        const occupiedBy = this.findBoundWorkId(sessionId)
        if (occupiedBy) throw new WorkSessionSessionConflictError(sessionId, occupiedBy)
        if (!(await resolveL4PiSessionPath(cwd, sessionId))) {
          throw new WorkSessionHistoryNotFoundError(cwd, sessionId)
        }
      }

      const workSession = await WorkSession.create(randomUUID(), cwd, sessionId)
      this.chat.addWorkSession(workSession)
      this.insertUnpinnedWorkSession(workSession)
      this.persist()
      const item = this.toListItem(workSession)
      const snapshot = this.createSnapshot()
      this.publishUpdate({ type: 'snapshot', ...snapshot })
      console.info('[Pi Desk][WorkSessionManage] 已创建工作会话', {
        workId: workSession.workId,
        cwd: workSession.cwd,
        sessionId: workSession.sessionId,
        creationType: sessionId ? 'history' : 'empty'
      })
      return item
    })
  }

  replaceWorkSession(
    workIdInput: string,
    historySessionInput?: { cwd: string; sessionId: string }
  ): Promise<L2WorkSessionListResponse> {
    const workId = L2WorkIdSchema.parse(workIdInput)
    const historySession = historySessionInput
      ? {
          cwd: L2CwdSchema.parse(historySessionInput.cwd),
          sessionId: L2PiSessionIdSchema.parse(historySessionInput.sessionId)
        }
      : null

    return this.runExclusive(async () => {
      await this.ensureHydrated()
      const current = this.workSessionsById.get(workId)
      if (!current) throw new WorkSessionNotFoundError(workId)
      if (
        historySession &&
        current.cwd === historySession.cwd &&
        current.sessionId === historySession.sessionId
      ) {
        return this.createSnapshot()
      }

      if (historySession) {
        const occupiedBy = this.findBoundWorkId(historySession.sessionId)
        if (occupiedBy && occupiedBy !== workId) {
          throw new WorkSessionSessionConflictError(historySession.sessionId, occupiedBy)
        }
      }

      // 替换只变更 WorkSession 绑定；旧 JSONL 保留，旧运行态由 Chat Runtime 显式释放。
      const previousItem = this.toListItem(current)
      await this.chat.pauseWorkSession(workId)
      let next: WorkSession
      try {
        next = await WorkSession.create(
          workId,
          historySession?.cwd ?? current.cwd,
          historySession?.sessionId
        )
        await this.chat.replaceWorkSession(current, next)
      } catch (error) {
        this.chat.resumeWorkSession(workId)
        throw error
      }
      this.workSessionsById.set(workId, next)
      this.persist()
      const item = this.toListItem(next)
      const snapshot = this.createSnapshot()
      const changes = this.toChanges(previousItem, item)
      if (changes) this.publishUpdate({ type: 'update', workId, changes })
      console.info('[Pi Desk][WorkSessionManage] 已替换 Pi 会话', {
        workId,
        replacementType: historySession ? 'history' : 'empty',
        previousCwd: current.cwd,
        previousSessionId: current.sessionId,
        cwd: next.cwd,
        sessionId: next.sessionId,
        branchId: next.branchId
      })
      return snapshot
    })
  }

  getWorkSessionTree(
    inputValue: L2WorkSessionTreeGetRequest
  ): Promise<L2WorkSessionTreeGetResponse> {
    const input = L2WorkSessionTreeGetRequestSchema.parse(inputValue)
    return this.runExclusive(async () => {
      await this.ensureHydrated()
      const current = this.workSessionsById.get(input.workId)
      if (!current) throw new WorkSessionNotFoundError(input.workId)
      this.assertSessionBinding(current, input.sessionId)
      return L2WorkSessionTreeGetResponseSchema.parse(
        await getL4PiWorkSessionRuntime(current.sessionId).readSessionTree()
      )
    })
  }

  getWorkSessionTreeEntry(
    inputValue: L2WorkSessionTreeEntryGetRequest
  ): Promise<L2WorkSessionTreeEntryGetResponse> {
    const input = L2WorkSessionTreeEntryGetRequestSchema.parse(inputValue)
    return this.runExclusive(async () => {
      await this.ensureHydrated()
      const current = this.workSessionsById.get(input.workId)
      if (!current) throw new WorkSessionNotFoundError(input.workId)
      this.assertSessionBinding(current, input.sessionId)
      try {
        return L2WorkSessionTreeEntryGetResponseSchema.parse(
          await getL4PiWorkSessionRuntime(current.sessionId).readSessionTreeEntryDetail(
            input.entryId
          )
        )
      } catch (error) {
        if (error instanceof L4PiSessionEntryNotFoundError) {
          throw new WorkSessionBranchEntryNotFoundError(input.entryId)
        }
        throw error
      }
    })
  }

  branchWorkSession(inputValue: L2WorkSessionBranchRequest): Promise<L2WorkSessionBranchResponse> {
    const input = L2WorkSessionBranchRequestSchema.parse(inputValue)
    return this.runExclusive(async () => {
      await this.ensureHydrated()
      const source = this.workSessionsById.get(input.workId)
      if (!source) throw new WorkSessionNotFoundError(input.workId)
      this.assertSessionBinding(source, input.sessionId)

      if (input.action === 'tree') {
        const previousItem = this.toListItem(source)
        await this.chat.pauseWorkSession(source.workId)
        let result: Awaited<ReturnType<WorkSession['branch']>>
        try {
          result = await source.branch(input.entryId)
          if (result.changed) await this.chat.refreshWorkSession(source)
          else this.chat.resumeWorkSession(source.workId)
        } catch (error) {
          if (source.branchId !== previousItem.branchId) {
            await this.chat.refreshWorkSession(source)
            const changes = this.toChanges(previousItem, this.toListItem(source))
            if (changes) this.publishUpdate({ type: 'update', workId: source.workId, changes })
          } else {
            this.chat.resumeWorkSession(source.workId)
          }
          this.throwBranchError(error, input.entryId)
        }

        const item = this.toListItem(source)
        const changes = this.toChanges(previousItem, item)
        if (changes) this.publishUpdate({ type: 'update', workId: source.workId, changes })
        const snapshot = this.createSnapshot()
        console.info('[Pi Desk][WorkSessionManage] 已切换当前 JSONL 分支', {
          workId: source.workId,
          cwd: source.cwd,
          sessionId: source.sessionId,
          entryId: input.entryId,
          branchId: source.branchId,
          changed: result.changed
        })
        return L2WorkSessionBranchResponseSchema.parse({
          ...snapshot,
          targetWorkId: source.workId,
          editorText: result.editorText
        })
      }

      if (input.action === 'clone') await this.chat.pauseWorkSession(source.workId)
      let created: Awaited<ReturnType<WorkSession['createBranchedSession']>>
      try {
        created = await source.createBranchedSession(
          randomUUID(),
          input.action === 'fork'
            ? { position: 'before', entryId: input.entryId }
            : { position: 'at' }
        )
        this.chat.addWorkSession(created.workSession)
      } catch (error) {
        this.throwBranchError(error, 'entryId' in input ? input.entryId : null)
      } finally {
        if (input.action === 'clone') this.chat.resumeWorkSession(source.workId)
      }

      const next = created.workSession
      this.insertUnpinnedWorkSession(next)
      this.persist()
      const snapshot = this.createSnapshot()
      this.publishUpdate({ type: 'snapshot', ...snapshot })
      console.info('[Pi Desk][WorkSessionManage] 已创建分支 WorkSession', {
        action: input.action,
        sourceWorkId: source.workId,
        sourceSessionId: source.sessionId,
        workId: next.workId,
        cwd: next.cwd,
        entryId: 'entryId' in input ? input.entryId : null,
        sessionId: next.sessionId,
        branchId: next.branchId
      })
      return L2WorkSessionBranchResponseSchema.parse({
        ...snapshot,
        targetWorkId: next.workId,
        editorText: created.editorText
      })
    })
  }

  removeWorkSession(workIdInput: string): Promise<boolean> {
    const workId = L2WorkIdSchema.parse(workIdInput)
    return this.runExclusive(async () => {
      await this.ensureHydrated()
      const current = this.workSessionsById.get(workId)
      if (!current) return false
      const deletedIndex = Array.from(this.workSessionsById.keys()).indexOf(workId)

      await this.chat.pauseWorkSession(workId)
      await this.chat.removeWorkSession(current)
      this.workSessionsById.delete(workId)
      if (deletedIndex < this.pinnedCount) this.pinnedCount -= 1
      this.persist()
      this.publishUpdate({ type: 'delete', workId })
      console.info('[Pi Desk][WorkSessionManage] 已删除工作会话', {
        workId,
        pinnedCount: this.pinnedCount
      })
      return true
    })
  }

  private async ensureHydrated(): Promise<void> {
    if (this.hydrated) return

    const startedAt = performance.now()
    console.info('[Pi Desk][WorkSessionManage] 开始恢复工作会话', {
      workSessionCount: this.restoredRecords.length
    })
    const workSessions = await Promise.all(
      this.restoredRecords.map((record) =>
        WorkSession.create(record.workId, record.cwd, record.sessionId)
      )
    )
    const sessionsOpenedAt = performance.now()
    await this.chat.initialize(workSessions)
    const messagesProjectedAt = performance.now()
    console.info('[Pi Desk][WorkSessionManage] 工作会话恢复完成', {
      workSessionCount: workSessions.length,
      durationMs: Math.round(messagesProjectedAt - startedAt),
      sessionOpenMs: Math.round(sessionsOpenedAt - startedAt),
      messageProjectionMs: Math.round(messagesProjectedAt - sessionsOpenedAt)
    })
    for (const workSession of workSessions) {
      this.workSessionsById.set(workSession.workId, workSession)
    }
    this.hydrated = true
    if (this.rewriteLegacyStore) {
      this.persist()
      this.rewriteLegacyStore = false
      console.info('[Pi Desk][WorkSessionManage] 已升级工作会话持久化格式', {
        workSessionCount: workSessions.length,
        pinnedCount: this.pinnedCount
      })
    }
  }

  private async authorizeProjectFiles(workId: string, expectedCwd: string): Promise<string> {
    await this.initialize()
    const workSession = this.workSessionsById.get(workId)
    if (!workSession) throw new WorkSessionNotFoundError(workId)
    if (workSession.cwd !== expectedCwd) {
      throw new WorkSessionProjectChangedError(workId, expectedCwd, workSession.cwd)
    }
    return workSession.cwd
  }

  private findBoundWorkId(sessionId: string): string | undefined {
    for (const workSession of this.workSessionsById.values()) {
      if (workSession.sessionId === sessionId) return workSession.workId
    }
    return undefined
  }

  private insertUnpinnedWorkSession(workSession: WorkSession): void {
    const ordered = this.orderedWorkSessions()
    ordered.splice(this.pinnedCount, 0, workSession)
    this.workSessionsById.clear()
    for (const orderedWorkSession of ordered) {
      this.workSessionsById.set(orderedWorkSession.workId, orderedWorkSession)
    }
  }

  private assertSessionBinding(workSession: WorkSession, expectedSessionId: string): void {
    if (workSession.sessionId === expectedSessionId) return
    throw new WorkSessionBindingChangedError(
      workSession.workId,
      expectedSessionId,
      workSession.sessionId
    )
  }

  private throwBranchError(error: unknown, entryId: string | null): never {
    if (error instanceof L4PiSessionEntryNotFoundError) {
      throw new WorkSessionBranchEntryNotFoundError(entryId ?? '')
    }
    if (error instanceof L4PiSessionForkTargetError) {
      throw new WorkSessionBranchInvalidError('fork-target', '只有用户消息可以 Fork')
    }
    if (error instanceof L4PiSessionCloneEmptyError) {
      throw new WorkSessionBranchInvalidError('clone-empty', '当前会话还没有可克隆的消息')
    }
    if (error instanceof L4PiSessionBranchBlockedError) {
      throw new WorkSessionBranchBlockedError(error.message)
    }
    throw error
  }

  private orderedWorkSessions(): WorkSession[] {
    return Array.from(this.workSessionsById.values())
  }

  private createSnapshot(): L2WorkSessionListResponse {
    return L2WorkSessionListResponseSchema.parse({
      workSessions: this.orderedWorkSessions().map((workSession) => this.toListItem(workSession)),
      pinnedCount: this.pinnedCount
    })
  }

  private toRecord(workSession: WorkSession): L2WorkSessionRecord {
    return L2WorkSessionRecordSchema.parse({
      workId: workSession.workId,
      cwd: workSession.cwd,
      sessionId: workSession.sessionId
    })
  }

  private toListItem(workSession: WorkSession): L2WorkSessionListItem {
    const metadata = this.chat.metadataFor(workSession)
    return L2WorkSessionListItemSchema.parse({
      ...this.toRecord(workSession),
      branchId: workSession.branchId,
      projectName: basename(workSession.cwd) || workSession.cwd,
      sessionTitle: metadata.sessionTitle,
      status: this.chat.statusFor(workSession),
      messageCounts: metadata.messageCounts,
      lastMessageUpdatedAt: metadata.lastMessageUpdatedAt
    })
  }

  private toChanges(
    previous: L2WorkSessionListItem,
    next: L2WorkSessionListItem
  ): L2WorkSessionChanges | null {
    const changes: Record<string, unknown> = {}
    if (previous.cwd !== next.cwd) changes.cwd = next.cwd
    if (previous.sessionId !== next.sessionId) changes.sessionId = next.sessionId
    if (previous.branchId !== next.branchId) changes.branchId = next.branchId
    if (previous.projectName !== next.projectName) changes.projectName = next.projectName
    if (previous.sessionTitle !== next.sessionTitle) changes.sessionTitle = next.sessionTitle
    if (previous.status !== next.status) changes.status = next.status
    if (
      previous.messageCounts.user !== next.messageCounts.user ||
      previous.messageCounts.total !== next.messageCounts.total
    ) {
      changes.messageCounts = next.messageCounts
    }
    if (previous.lastMessageUpdatedAt !== next.lastMessageUpdatedAt) {
      changes.lastMessageUpdatedAt = next.lastMessageUpdatedAt
    }
    return Object.keys(changes).length === 0 ? null : L2WorkSessionChangesSchema.parse(changes)
  }

  private publishChatRecordChange(
    workId: string,
    previousMetadata: L2WorkSessionChatMetadata,
    previousStatus: L2WorkSessionStatus
  ): void {
    if (!this.hydrated) return
    const workSession = this.workSessionsById.get(workId)
    if (!workSession) return
    const item = this.toListItem(workSession)
    const changes = this.toChanges({ ...item, ...previousMetadata, status: previousStatus }, item)
    if (changes) this.publishUpdate({ type: 'update', workId, changes })
  }

  private publishUpdate(updateInput: L2WorkSessionsUpdate): void {
    const update = L2WorkSessionsUpdateSchema.parse(updateInput)
    for (const listener of [...this.updateListeners]) {
      try {
        listener(update)
      } catch (error) {
        console.error('[Pi Desk][WorkSessionManage] 推送工作会话变化失败', {
          updateType: update.type,
          errorName: error instanceof Error ? error.name : 'UnknownError'
        })
      }
    }
  }

  private readPersistedState(): RestoredWorkSessionState {
    if (!existsSync(this.storePath)) {
      return { workSessions: [], pinnedCount: 0, rewriteLegacyStore: false }
    }

    const parsed: unknown = JSON.parse(readFileSync(this.storePath, 'utf8'))
    const rewriteLegacyStore = Array.isArray(parsed)
    const state = rewriteLegacyStore
      ? L2WorkSessionPersistedStateSchema.parse({
          workSessions: L2WorkSessionRecordsSchema.parse(parsed),
          pinnedCount: 0
        })
      : L2WorkSessionPersistedStateSchema.parse(parsed)
    const workIds = new Set<string>()
    const sessionIds = new Set<string>()

    for (const record of state.workSessions) {
      if (workIds.has(record.workId)) {
        throw new Error(`Duplicate persisted workId: ${record.workId}`)
      }
      if (sessionIds.has(record.sessionId)) {
        throw new Error(`Duplicate persisted sessionId binding: ${record.sessionId}`)
      }

      workIds.add(record.workId)
      sessionIds.add(record.sessionId)
    }
    return { ...state, rewriteLegacyStore }
  }

  private persist(): void {
    const state = L2WorkSessionPersistedStateSchema.parse({
      workSessions: this.orderedWorkSessions().map((workSession) => this.toRecord(workSession)),
      pinnedCount: this.pinnedCount
    })
    mkdirSync(dirname(this.storePath), { recursive: true })

    const temporaryPath = `${this.storePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      renameSync(temporaryPath, this.storePath)
    } finally {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
    }
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation)
    this.operationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

declare global {
  var __piDeskWorkSessionManage: WorkSessionManage | undefined
}

export function getL2WorkSessionManage(): WorkSessionManage {
  if (!globalThis.__piDeskWorkSessionManage) {
    globalThis.__piDeskWorkSessionManage = new WorkSessionManage()
  }
  return globalThis.__piDeskWorkSessionManage
}
