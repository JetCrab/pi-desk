import 'server-only'

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { ModelRuntime, SessionManager, type SessionEntry } from '@earendil-works/pi-coding-agent'
import type { PluginJsonObject, SessionPluginSource } from '@jetcrab/pi-desk-sdk'
import { getL4CapabilityModesStore } from '@server/l4_foundation/capability-modes/l4-capability-modes-store'
import {
  L4PiChatWorker,
  type L4PiChatModelInput,
  type L4PiChatRuntimeSnapshot,
  type L4PiModelContext,
  type L4PiChatSendInput,
  type L4PiChatWorkerEvent,
  type L4PiDirectBashInput,
  type L4PiDirectBashResult,
  type L4PiNativeCommandInfo,
  type L4PiNativeToolInfo
} from './l4-pi-chat-worker'
import type { L4PiInputImage } from './l4-pi-image'
import type { L4PiModelCatalog } from './l4-pi-model-catalog'
import { L4PiSessionBranchIndex, type L4PendingBranchAppend } from './l4-pi-session-branch'
import {
  projectL4PiChatSnapshot,
  readL4PiChatImageContent,
  type L4PiChatSnapshot
} from './l4-pi-chat-projection'
import { invalidateL4PiDirectoryCache, resolveL4PiSessionPath } from './l4-pi-session-catalog'
import { materializeL4PiSessionFile } from './l4-pi-session-file'
import {
  L4PiSessionEntryNotFoundError,
  readL4PiSessionTree,
  readL4PiSessionTreeEntryDetail,
  resolveL4PiBranchSelection,
  resolveL4PiForkSelection,
  type L4PiBranchSelection,
  type L4PiSessionTree,
  type L4PiSessionTreeEntryDetail
} from './l4-pi-session-tree'
import type { L4PiTaskDetailEvent, L4PiTaskDetailWatch } from './l4-pi-task-detail-runtime'
import { L4PiSessionResources } from './l4-pi-session-resources'
import type { L4PiUiRuntime } from './l4-pi-ui-runtime'

export class L4PiSessionBranchBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'L4PiSessionBranchBlockedError'
  }
}

export class L4PiSessionCloneEmptyError extends Error {
  constructor() {
    super('Pi session has no durable entry to clone')
    this.name = 'L4PiSessionCloneEmptyError'
  }
}

export interface L4PiCreateBranchedSessionInput {
  position: 'before' | 'at'
  entryId?: string
}

export interface L4PiCreateBranchedSessionResult {
  runtime: L4PiWorkSessionRuntime
  editorText: string | null
}

function runtimeRegistry(): Map<string, L4PiWorkSessionRuntime> {
  if (!globalThis.__piDeskPiWorkSessionRuntimes) {
    globalThis.__piDeskPiWorkSessionRuntimes = new Map()
  }
  return globalThis.__piDeskPiWorkSessionRuntimes
}

/** Pi-specific runtime hidden behind the L3 WorkSession orchestration boundary. */
export class L4PiWorkSessionRuntime {
  private branchIdValue: string
  private chatWorker: L4PiChatWorker
  private readonly resources = new L4PiSessionResources()
  private indexedEntryCount: number
  private pendingBranchAppend: L4PendingBranchAppend | null = null
  private capabilityModeValue: string | null = null
  private capabilityTail: Promise<void> = Promise.resolve()
  private readonly unsubscribeCapabilities: () => void
  private disposed = false
  private closePromise: Promise<void> | null = null

  private constructor(
    private readonly sessionManager: SessionManager,
    private readonly branchIndex: L4PiSessionBranchIndex
  ) {
    this.indexedEntryCount = sessionManager.getEntries().length
    this.branchIdValue = branchIndex.branchIdForHead(sessionManager.getLeafId())
    this.chatWorker = this.createChatWorker()
    this.unsubscribeCapabilities = getL4CapabilityModesStore().subscribe(() => {
      if (this.capabilityModeValue === null || this.disposed) return
      const modes = getL4CapabilityModesStore().read()
      const key = Object.hasOwn(modes, this.capabilityModeValue) ? this.capabilityModeValue : null
      void this.setCapabilityMode(key).catch((cause: unknown) => {
        console.error('[Pi Desk][Capabilities] 会话同步模式配置失败', {
          sessionId: this.sessionId,
          message: cause instanceof Error ? cause.message : String(cause)
        })
      })
    })
  }

  static create(cwd: string): L4PiWorkSessionRuntime {
    const sessionManager = SessionManager.create(cwd)
    const sessionFile = materializeL4PiSessionFile(sessionManager)
    invalidateL4PiDirectoryCache(cwd)
    return L4PiWorkSessionRuntime.fromManager(
      SessionManager.open(sessionFile, sessionManager.getSessionDir())
    )
  }

  static async open(cwd: string, sessionId: string): Promise<L4PiWorkSessionRuntime> {
    const existing = runtimeRegistry().get(sessionId)
    if (existing) {
      existing.assertActive()
      if (resolve(existing.cwd) !== resolve(cwd)) {
        throw new Error(`Pi session ${sessionId} cwd does not match requested cwd`)
      }
      return existing
    }

    const sessionPath = await resolveL4PiSessionPath(cwd, sessionId)
    if (!sessionPath) throw new Error(`Pi session ${sessionId} was not found in ${cwd}`)

    const runtime = L4PiWorkSessionRuntime.fromManager(SessionManager.open(sessionPath))
    if (resolve(runtime.cwd) !== resolve(cwd)) {
      throw new Error(`Pi session ${sessionId} cwd does not match persisted cwd`)
    }
    return runtime
  }

  get cwd(): string {
    return this.sessionManager.getCwd()
  }

  get sessionId(): string {
    return this.sessionManager.getSessionId()
  }

  get branchId(): string {
    return this.branchIdValue
  }

  get isWorkerInitialized(): boolean {
    this.assertActive()
    return this.chatWorker.isInitialized
  }

  readChatBackgroundTaskIds(): string[] {
    this.assertActive()
    return this.chatWorker.getBackgroundTaskIds()
  }

  readPluginReloadBlockReason(): string | null {
    this.assertActive()
    return this.chatWorker.readPluginReloadBlockReason()
  }

  readChatSnapshot(): L4PiChatSnapshot {
    this.assertActive()
    return projectL4PiChatSnapshot(this.sessionManager)
  }

  async readSessionTree(): Promise<L4PiSessionTree> {
    this.assertActive()
    const models = this.sessionManager.getEntries().some((entry) => entry.type === 'model_change')
      ? await ModelRuntime.create()
      : undefined
    return readL4PiSessionTree(this.sessionManager, models)
  }

  async readSessionTreeEntryDetail(entryId: string): Promise<L4PiSessionTreeEntryDetail> {
    this.assertActive()
    const models =
      this.sessionManager.getEntry(entryId)?.type === 'model_change'
        ? await ModelRuntime.create()
        : undefined
    return readL4PiSessionTreeEntryDetail(this.sessionManager, entryId, models)
  }

  readChatImage(entryId: string, imageIndex: number): { mimeType: string; data: string } {
    this.assertActive()
    if (!Number.isSafeInteger(imageIndex) || imageIndex < 0) {
      throw new Error('图片位置无效')
    }
    if (!this.sessionManager.getBranch().some((entry) => entry.id === entryId)) {
      throw new Error(`Pi session entry is not on the current branch: ${entryId}`)
    }
    const entry = this.sessionManager.getEntry(entryId)
    if (
      entry?.type !== 'message' ||
      (entry.message.role !== 'user' && entry.message.role !== 'toolResult')
    ) {
      throw new Error(`Pi session entry has no message images: ${entryId}`)
    }
    const image = readL4PiChatImageContent(entry.message.content, imageIndex)
    if (!image) throw new Error(`Pi message image was not found: ${entryId}/${imageIndex}`)
    return image
  }

  subscribeChat(listener: (event: L4PiChatWorkerEvent) => void): () => void {
    this.assertActive()
    return this.chatWorker.subscribe(listener)
  }

  get nativeUi(): L4PiUiRuntime {
    this.assertActive()
    return this.chatWorker.nativeUi
  }

  async readChatRuntime(): Promise<L4PiChatRuntimeSnapshot> {
    this.assertActive()
    return this.chatWorker.getRuntime()
  }

  async readModelContext(): Promise<L4PiModelContext> {
    this.assertActive()
    return this.chatWorker.readModelContext()
  }

  watchTaskDetail(
    taskId: string,
    listener: (event: L4PiTaskDetailEvent) => void
  ): Promise<L4PiTaskDetailWatch> {
    this.assertActive()
    return this.chatWorker.watchTaskDetail(taskId, listener)
  }

  readTaskMessage(taskId: string, entryId: string) {
    this.assertActive()
    return this.chatWorker.readTaskMessage(taskId, entryId)
  }

  readTaskImage(taskId: string, entryId: string, imageIndex: number) {
    this.assertActive()
    return this.chatWorker.readTaskImage(taskId, entryId, imageIndex)
  }

  async interruptTask(taskId: string): Promise<void> {
    this.assertActive()
    await this.chatWorker.interruptTask(taskId)
  }

  async invokePluginMethod(
    source: SessionPluginSource,
    pluginName: string,
    method: string,
    input: PluginJsonObject
  ): Promise<PluginJsonObject> {
    this.assertActive()
    if (source.sessionId !== this.sessionId || source.branchId !== this.branchId) {
      throw new Error('Pi session plugin source does not match the current runtime')
    }
    return this.chatWorker.invokePluginMethod(pluginName, method, input, source)
  }

  async listModels(): Promise<L4PiModelCatalog> {
    this.assertActive()
    return this.chatWorker.listModels()
  }

  async listNativeCommands(): Promise<readonly L4PiNativeCommandInfo[]> {
    this.assertActive()
    return this.chatWorker.listNativeCommands()
  }

  async executeNativeCommand(command: string, args: string): Promise<void> {
    this.assertActive()
    await this.chatWorker.executeNativeCommand(command, args)
  }

  async listNativeTools(loadedOnly = false): Promise<readonly L4PiNativeToolInfo[]> {
    if (loadedOnly && this.disposed) return []
    this.assertActive()
    return this.chatWorker.listNativeTools(loadedOnly)
  }

  async executeDirectBash(input: L4PiDirectBashInput): Promise<L4PiDirectBashResult> {
    this.assertActive()
    return this.chatWorker.executeDirectBash(input)
  }

  async abortDirectBash(): Promise<void> {
    this.assertActive()
    await this.chatWorker.abortDirectBash()
  }

  async send(input: L4PiChatSendInput): Promise<{ tempId: string }> {
    this.assertActive()
    return this.chatWorker.send(input)
  }

  async interrupt(): Promise<void> {
    this.assertActive()
    await this.chatWorker.interrupt()
  }

  async compact(): Promise<void> {
    this.assertActive()
    await this.chatWorker.compact()
  }

  async reload(mode?: 'normal' | 'basic'): Promise<void> {
    this.assertActive()
    await this.chatWorker.reload(mode)
  }

  async restoreQueuedMessages(): Promise<{ text: string; images: L4PiInputImage[] }> {
    this.assertActive()
    return this.chatWorker.restoreQueuedMessages()
  }

  async setModel(input: L4PiChatModelInput): Promise<void> {
    this.assertActive()
    await this.chatWorker.setModel(input)
  }

  setCapabilityMode(key: string | null): Promise<void> {
    const apply = this.capabilityTail.then(async () => {
      this.assertActive()
      if (key !== null && !Object.hasOwn(getL4CapabilityModesStore().read(), key)) {
        throw new Error('能力模式已不存在，请重新选择')
      }
      this.capabilityModeValue = key
      await this.chatWorker.applyCapabilityMode()
    })
    this.capabilityTail = apply.catch(() => undefined)
    return apply
  }

  async dispose(): Promise<void> {
    if (!this.closePromise) {
      this.disposed = true
      this.unsubscribeCapabilities()
      this.closePromise = this.chatWorker.dispose().finally(() => this.resources.reset())
      void this.closePromise.then(
        () => {
          if (runtimeRegistry().get(this.sessionId) === this)
            runtimeRegistry().delete(this.sessionId)
        },
        (error: unknown) => {
          console.warn('[Pi Desk][WorkSessionRuntime] 会话关闭未确认，保留实例占用直到重启', {
            sessionId: this.sessionId,
            message: error instanceof Error ? error.message : String(error)
          })
        }
      )
    }
    // 不让坏扩展占住工作会话列表；但未收敛实例仍占用原sessionId，不能双写JSONL。
    await this.waitForWorkerClose(this.closePromise, 1500).catch(() => undefined)
  }

  private async waitForWorkerClose(execution: Promise<void>, timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        execution.then(() => true),
        new Promise<false>((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout(false), timeoutMs)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async branch(entryId: string): Promise<L4PiBranchSelection> {
    this.assertActive()
    this.assertBranchable()
    this.syncBranchIndex()
    const selection = resolveL4PiBranchSelection(this.sessionManager, entryId)
    if (!selection.changed) return selection

    const previousLeaf = this.sessionManager.getLeafId()
    const previousPending = this.pendingBranchAppend
    // 导航钩子可在旧/新分支合法追加，不能让上次未落盘的预测约束这些条目。
    this.pendingBranchAppend = null
    let changed = false
    try {
      changed = await this.chatWorker.navigateTree(selection.selectedEntryId)
      return changed
        ? selection
        : {
            ...selection,
            changed: false,
            targetLeafEntryId: this.sessionManager.getLeafId(),
            editorText: null
          }
    } finally {
      this.syncBranchIndex()
      const leaf = this.sessionManager.getLeafId()
      if (changed || leaf !== previousLeaf) {
        this.pendingBranchAppend = this.branchIndex.predictAppend(leaf)
        this.branchIdValue = this.pendingBranchAppend.branchId
      } else {
        this.pendingBranchAppend = previousPending
      }
    }
  }

  createBranchedSession(input: L4PiCreateBranchedSessionInput): L4PiCreateBranchedSessionResult {
    this.assertActive()
    // Fork 只复制已落盘历史，不切换或关闭源 Worker。
    if (input.position === 'at') this.assertBranchable()
    this.syncBranchIndex()
    const sourceSessionFile = this.sessionManager.getSessionFile()
    if (!sourceSessionFile || !existsSync(sourceSessionFile)) {
      throw new Error(`Pi session ${this.sessionId} has no authoritative JSONL file`)
    }

    let selectedEntryId: string
    let targetLeafEntryId: string | null
    let editorText: string | null
    if (input.position === 'before') {
      if (!input.entryId) throw new L4PiSessionEntryNotFoundError('')
      const selection = resolveL4PiForkSelection(this.sessionManager, input.entryId)
      selectedEntryId = selection.selectedEntryId
      targetLeafEntryId = selection.targetLeafEntryId
      editorText = selection.editorText
    } else {
      selectedEntryId = input.entryId ?? this.sessionManager.getLeafId() ?? ''
      if (!selectedEntryId) throw new L4PiSessionCloneEmptyError()
      if (!this.sessionManager.getEntry(selectedEntryId)) {
        throw new L4PiSessionEntryNotFoundError(selectedEntryId)
      }
      targetLeafEntryId = selectedEntryId
      editorText = null
    }

    let branchedManager: SessionManager
    let branchedPath: string | undefined
    if (targetLeafEntryId === null) {
      branchedManager = SessionManager.create(this.cwd, this.sessionManager.getSessionDir())
      branchedPath = branchedManager.newSession({ parentSession: sourceSessionFile })
    } else {
      branchedManager = SessionManager.open(sourceSessionFile, this.sessionManager.getSessionDir())
      branchedPath = branchedManager.createBranchedSession(targetLeafEntryId)
    }
    if (!branchedPath) {
      throw new Error(`Failed to create Pi session from entry: ${selectedEntryId}`)
    }

    materializeL4PiSessionFile(branchedManager)
    invalidateL4PiDirectoryCache(this.cwd)
    const runtime = L4PiWorkSessionRuntime.fromManager(
      SessionManager.open(branchedPath, this.sessionManager.getSessionDir())
    )
    console.info('[Pi Desk][PiWorkSessionRuntime] 已创建路径分支 Pi 会话', {
      sourceSessionId: this.sessionId,
      sourceBranchId: this.branchIndex.branchIdForEntry(selectedEntryId),
      selectedEntryId,
      targetLeafEntryId,
      position: input.position,
      sessionId: runtime.sessionId,
      branchId: runtime.branchId
    })
    return { runtime, editorText }
  }

  private assertBranchable(): void {
    try {
      this.chatWorker.assertIdle()
    } catch (error) {
      throw new L4PiSessionBranchBlockedError(
        error instanceof Error ? error.message : '当前 Pi 会话不能切换分支'
      )
    }
  }

  private createChatWorker(): L4PiChatWorker {
    return new L4PiChatWorker(
      this.cwd,
      this.sessionManager,
      (entry) => this.confirmAppendedEntry(entry),
      {
        mode: () => this.capabilityModeValue,
        rules: () =>
          this.capabilityModeValue === null
            ? undefined
            : getL4CapabilityModesStore().read()[this.capabilityModeValue]
      },
      this.resources
    )
  }

  private confirmAppendedEntry(entry: SessionEntry): void {
    try {
      // Pi only emits entry_appended for selected append paths. Always catch up from the
      // authoritative in-memory append list so ordinary messages cannot leave parent gaps.
      this.syncBranchIndex()
      this.branchIndex.branchIdForEntry(entry.id)
    } catch (error) {
      console.error('[Pi Desk][PiWorkSessionRuntime] 增量同步 Pi 分支索引失败', {
        sessionId: this.sessionId,
        entryId: entry.id,
        parentId: entry.parentId,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        errorMessage: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  }

  private syncBranchIndex(): void {
    const entries = this.sessionManager.getEntries()
    while (this.indexedEntryCount < entries.length) {
      const entry = entries[this.indexedEntryCount]!
      let branchId: string
      if (this.pendingBranchAppend) {
        branchId = this.branchIndex.confirmAppend(this.pendingBranchAppend, entry)
        this.pendingBranchAppend = null
      } else {
        branchId = this.branchIndex.appendEntry(entry).branchId
      }
      this.indexedEntryCount += 1
      if (this.sessionManager.getLeafId() === entry.id) this.branchIdValue = branchId
    }
  }

  private static fromManager(sessionManager: SessionManager): L4PiWorkSessionRuntime {
    const existing = runtimeRegistry().get(sessionManager.getSessionId())
    if (existing) {
      existing.assertActive()
      return existing
    }

    const runtime = new L4PiWorkSessionRuntime(
      sessionManager,
      new L4PiSessionBranchIndex(sessionManager.getEntries())
    )
    runtimeRegistry().set(runtime.sessionId, runtime)
    return runtime
  }

  private assertActive(): void {
    if (this.disposed) throw new Error(`Pi session runtime has been disposed: ${this.sessionId}`)
  }
}

export function getL4PiWorkSessionRuntime(sessionId: string): L4PiWorkSessionRuntime {
  const runtime = runtimeRegistry().get(sessionId)
  if (!runtime) throw new Error(`Pi session runtime is not initialized: ${sessionId}`)
  return runtime
}

export async function listL4PiLoadedNativeTools(): Promise<readonly L4PiNativeToolInfo[]> {
  const lists = await Promise.all(
    [...runtimeRegistry().values()].map((runtime) => runtime.listNativeTools(true))
  )
  return [...new Map(lists.flat().map((tool) => [tool.name, tool])).values()]
}

export async function disposeL4PiWorkSessionRuntime(sessionId: string): Promise<void> {
  await runtimeRegistry().get(sessionId)?.dispose()
}

export async function disposeAllL4PiWorkSessionRuntimes(): Promise<void> {
  await Promise.all([...runtimeRegistry().values()].map((runtime) => runtime.dispose()))
}

declare global {
  var __piDeskPiWorkSessionRuntimes: Map<string, L4PiWorkSessionRuntime> | undefined
}
