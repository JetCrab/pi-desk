import { L2EnvironmentIdSchema } from '@common/l2_biz/environment/l2-environment-contract'
import type {
  L2EnvironmentExportRequest,
  L2EnvironmentGetResponse,
  L2EnvironmentImportRequest,
  L2EnvironmentItem,
  L2EnvironmentOperation,
  L2EnvironmentPreviewResponse
} from '@common/l2_biz/environment/l2-environment-contract'
import type { L2PiDirectoryEntryListResponse } from '@common/l2_biz/pi-session/l2-pi-session-contract'
import { L2EnvironmentRequestError, type L2EnvironmentBiz } from './l2-environment-biz'

export const L2_ENVIRONMENT_OPERATION_STORAGE_KEY = 'pi-desk:environment:operation-id'
type OperationHandleStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function sessionHandleStorage(): OperationHandleStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    console.warn('[Pi Desk][Environment] 无法访问标签页存储，关闭后不能恢复任务查询')
    return null
  }
}

export function selectedL2EnvironmentItems(
  preview: L2EnvironmentPreviewResponse,
  selectedIds: readonly string[]
): L2EnvironmentItem[] {
  const selected = new Set(selectedIds)
  return preview.items.filter((item) => selected.has(item.id))
}

export function sourceL2EnvironmentDirectories(items: readonly L2EnvironmentItem[]): string[] {
  return [
    ...new Set(
      items.flatMap((item) => [...(item.sourceCwd ? [item.sourceCwd] : []), ...item.mappingSources])
    )
  ]
}

export function buildL2EnvironmentImport(
  preview: L2EnvironmentPreviewResponse,
  selectedIds: readonly string[],
  targets: Readonly<Record<string, string>>,
  overwrite: boolean
): L2EnvironmentImportRequest {
  const items = selectedL2EnvironmentItems(preview, selectedIds)
  return {
    id: preview.id,
    selectedIds: items.map((item) => item.id),
    mappings: sourceL2EnvironmentDirectories(items).map((from) => ({
      from,
      to: (targets[from] ?? '').trim()
    })),
    overwrite
  }
}

type Pending = 'load' | 'export' | 'preview' | 'import' | 'download' | 'cancel' | null
export interface L2EnvironmentState {
  capabilities: L2EnvironmentGetResponse | null
  pending: Pending
  error: string | null
  notice: 'unknown-outcome' | 'poll-stopped' | 'operation-expired' | null
  file: File | null
  password: string
  exportDraft: L2EnvironmentExportRequest & { confirmation: string }
  preview: L2EnvironmentPreviewResponse | null
  previewFresh: boolean
  selectedIds: string[]
  targets: Record<string, string>
  overwrite: boolean
  operationId: { id: string; kind: 'export' | 'import' | null } | null
  operation: L2EnvironmentOperation | null
  polling: boolean
  browser: {
    from: string
    listing: L2PiDirectoryEntryListResponse | null
    loading: boolean
    error: string | null
  } | null
}

export function activeL2EnvironmentOperation(state: L2EnvironmentState): boolean {
  return (
    state.operationId !== null &&
    (!state.operation || ['pending', 'running'].includes(state.operation.status))
  )
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export class L2EnvironmentRuntime {
  private state: L2EnvironmentState = {
    capabilities: null,
    pending: null,
    error: null,
    notice: null,
    file: null,
    password: '',
    exportDraft: {
      password: '',
      confirmation: '',
      includeSessions: false,
      includePluginData: false
    },
    preview: null,
    previewFresh: false,
    selectedIds: [],
    targets: {},
    overwrite: false,
    operationId: null,
    operation: null,
    polling: false,
    browser: null
  }
  private listeners = new Set<() => void>()
  private controller = new AbortController()
  private previewController: AbortController | null = null
  private browseController: AbortController | null = null
  private stagedId: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private pollCount = 0

  constructor(
    private readonly biz: L2EnvironmentBiz,
    private readonly storage: OperationHandleStorage | null = sessionHandleStorage()
  ) {}

  private readHandle(): string | null {
    try {
      const id = this.storage?.getItem(L2_ENVIRONMENT_OPERATION_STORAGE_KEY) ?? null
      if (id === null || L2EnvironmentIdSchema.safeParse(id).success) return id
      this.storage?.removeItem(L2_ENVIRONMENT_OPERATION_STORAGE_KEY)
    } catch {
      console.warn('[Pi Desk][Environment] 读取任务查询句柄失败')
    }
    return null
  }

  private saveHandle(id: string): void {
    try {
      this.storage?.setItem(L2_ENVIRONMENT_OPERATION_STORAGE_KEY, id)
    } catch {
      console.warn('[Pi Desk][Environment] 保存任务查询句柄失败，关闭后不能恢复任务查询')
    }
  }

  private clearHandle(id: string): void {
    try {
      if (this.storage?.getItem(L2_ENVIRONMENT_OPERATION_STORAGE_KEY) === id) {
        this.storage.removeItem(L2_ENVIRONMENT_OPERATION_STORAGE_KEY)
      }
    } catch {
      console.warn('[Pi Desk][Environment] 清理任务查询句柄失败')
    }
  }

  private expireHandle(id: string): void {
    this.clearHandle(id)
    this.update({
      operationId: null,
      operation: null,
      polling: false,
      error: null,
      notice: 'operation-expired'
    })
  }

  getSnapshot = (): L2EnvironmentState => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private update(patch: Partial<L2EnvironmentState>): void {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((listener) => listener())
  }

  start = (): void => {
    if (this.controller.signal.aborted) this.controller = new AbortController()
    const id = this.readHandle()
    if (id && this.state.operationId?.id !== id) {
      this.update({ operationId: { id, kind: null }, operation: null })
    }
    void this.load()
    if (id && !this.state.polling) {
      this.pollCount = 0
      void this.poll()
    }
  }

  load = async (): Promise<void> => {
    if (this.state.pending) return
    const { signal } = this.controller
    this.update({ pending: 'load', error: null })
    try {
      const capabilities = await this.biz.get(signal)
      if (!signal.aborted) this.update({ capabilities })
    } catch (error) {
      if (!signal.aborted) this.update({ error: message(error) })
    } finally {
      if (!signal.aborted) this.update({ pending: null })
    }
  }

  editExport = (patch: Partial<L2EnvironmentState['exportDraft']>): void => {
    this.update({ exportDraft: { ...this.state.exportDraft, ...patch } })
  }
  editPassword = (password: string): void => {
    if (this.state.preview || this.stagedId) this.discardPreview()
    this.update({ password })
  }
  setFile = (file: File | null): void => {
    this.discardPreview()
    this.update({ file })
  }
  select = (ids: readonly string[], checked: boolean): void => {
    if (!this.state.preview) return
    const selected = new Set(this.state.selectedIds)
    for (const id of ids) {
      if (checked) selected.add(id)
      else selected.delete(id)
    }
    this.update({ selectedIds: [...selected], previewFresh: false, overwrite: false })
  }
  setTarget = (from: string, to: string): void => {
    if (this.state.targets[from] === to) return
    this.update({
      targets: { ...this.state.targets, [from]: to },
      previewFresh: false,
      overwrite: false
    })
  }
  setOverwrite = (overwrite: boolean): void => {
    if (overwrite && !this.state.previewFresh) return
    this.update({ overwrite })
  }

  private release(id: string): void {
    void this.biz.cancel(id, AbortSignal.timeout(10_000)).catch(() => {
      console.warn('[Pi Desk][Environment] 清理临时预览失败，服务端将在到期后释放')
    })
  }

  private discardPreview(): void {
    this.previewController?.abort()
    this.previewController = null
    this.closeBrowser()
    if (this.stagedId) this.release(this.stagedId)
    this.stagedId = null
    this.update({
      preview: null,
      previewFresh: false,
      selectedIds: [],
      targets: {},
      overwrite: false,
      pending: this.state.pending === 'preview' ? null : this.state.pending
    })
  }

  cancelPreview = async (): Promise<void> => {
    if (this.state.pending || activeL2EnvironmentOperation(this.state)) return
    const id = this.stagedId
    if (!id) return
    const { signal } = this.controller
    this.update({ pending: 'cancel', error: null })
    try {
      await this.biz.cancel(id, signal)
      this.clearHandle(id)
      if (signal.aborted) return
      this.stagedId = null
      this.discardPreview()
    } catch (error) {
      if (!signal.aborted) this.update({ error: message(error) })
    } finally {
      if (!signal.aborted) this.update({ pending: null })
    }
  }

  preview = async (): Promise<void> => {
    if (
      this.state.pending ||
      activeL2EnvironmentOperation(this.state) ||
      !this.state.file ||
      !this.state.password
    )
      return
    const { file, password, preview: previousPreview, selectedIds, targets } = this.state
    const mappings = previousPreview
      ? buildL2EnvironmentImport(previousPreview, selectedIds, targets, false).mappings
      : undefined
    if (mappings?.some((mapping) => !mapping.to)) return
    this.previewController?.abort()
    const controller = new AbortController()
    this.previewController = controller
    const { signal } = controller
    this.update({
      pending: 'preview',
      error: null,
      notice: null,
      previewFresh: false,
      overwrite: false
    })
    try {
      let id = this.stagedId
      if (!id) {
        const uploaded = await this.biz.upload(file!, signal)
        id = uploaded.id
        if (signal.aborted) {
          this.release(id)
          return
        }
        this.stagedId = id
      }
      const preview = await this.biz.preview({ id, password, mappings }, signal)
      if (signal.aborted) return
      const nextSelectedIds = previousPreview
        ? selectedIds.filter((selectedId) => preview.items.some((item) => item.id === selectedId))
        : preview.items.filter((item) => item.category === 'config').map((item) => item.id)
      const requestedTargets = new Map((mappings ?? []).map(({ from, to }) => [from, to]))
      const nextMappings = buildL2EnvironmentImport(
        preview,
        nextSelectedIds,
        this.state.targets,
        false
      ).mappings
      this.update({
        preview,
        selectedIds: nextSelectedIds,
        previewFresh: nextMappings.every(
          ({ from, to }) => Boolean(to) && requestedTargets.get(from) === to
        )
      })
    } catch (error) {
      if (!signal.aborted) this.update({ error: message(error) })
    } finally {
      if (!signal.aborted) this.update({ pending: null })
    }
  }

  export = async (): Promise<void> => {
    const { password, confirmation, includeSessions, includePluginData } = this.state.exportDraft
    if (
      !password ||
      password !== confirmation ||
      this.state.pending ||
      activeL2EnvironmentOperation(this.state) ||
      !this.state.capabilities?.canRestart
    )
      return
    await this.begin('export', () =>
      this.biz.export({ password, includeSessions, includePluginData }, this.controller.signal)
    )
  }

  apply = async (): Promise<void> => {
    const { preview, selectedIds, targets, overwrite } = this.state
    if (
      !preview ||
      !this.state.previewFresh ||
      this.state.pending ||
      activeL2EnvironmentOperation(this.state) ||
      !this.state.capabilities?.canRestart
    )
      return
    const input = buildL2EnvironmentImport(preview, selectedIds, targets, overwrite)
    if (!input.selectedIds.length || input.mappings.some((mapping) => !mapping.to)) return
    if (
      !overwrite &&
      selectedL2EnvironmentItems(preview, selectedIds).some((item) => item.conflicts.length)
    )
      return
    await this.begin('import', () => this.biz.import(input, this.controller.signal))
  }

  private async begin(
    kind: 'export' | 'import',
    request: () => Promise<{ id: string }>
  ): Promise<void> {
    const { signal } = this.controller
    this.update({ pending: kind, error: null, notice: null, operation: null, operationId: null })
    try {
      const { id } = await request()
      this.saveHandle(id)
      if (signal.aborted) return
      if (kind === 'import') {
        this.stagedId = null
        this.update({
          preview: null,
          previewFresh: false,
          selectedIds: [],
          targets: {},
          overwrite: false
        })
      }
      this.update({ operationId: { id, kind } })
      this.pollCount = 0
      await this.poll()
    } catch (error) {
      if (!signal.aborted) this.update({ error: message(error), notice: 'unknown-outcome' })
    } finally {
      if (!signal.aborted) this.update({ pending: null })
    }
  }

  resumePolling = (): void => {
    if (this.state.polling || !activeL2EnvironmentOperation(this.state)) return
    this.pollCount = 0
    this.update({ error: null, notice: null })
    void this.poll()
  }

  private async poll(): Promise<void> {
    const operationId = this.state.operationId
    const { signal } = this.controller
    if (!operationId || signal.aborted) return
    this.update({ polling: true })
    try {
      const operation = await this.biz.getOperation(
        operationId.id,
        AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      )
      if (signal.aborted) return
      if (operation.expiresAt <= Date.now()) {
        this.expireHandle(operationId.id)
        return
      }
      if (operation.status === 'completed') this.clearHandle(operationId.id)
      this.update({ operation, operationId: { id: operation.id, kind: operation.kind } })
      this.pollCount += 1
      if (operation.status !== 'pending' && operation.status !== 'running') {
        this.update({ polling: false })
        return
      }
      if (this.pollCount >= 300) {
        this.update({ notice: 'poll-stopped', polling: false })
        return
      }
      this.timer = setTimeout(() => {
        this.timer = null
        void this.poll()
      }, 2000)
    } catch (error) {
      if (signal.aborted) return
      if (error instanceof L2EnvironmentRequestError && error.status === 404) {
        this.expireHandle(operationId.id)
        return
      }
      this.update({ error: message(error), notice: 'poll-stopped', polling: false })
    }
  }

  download = async (): Promise<Blob | null> => {
    const operation = this.state.operation
    if (this.state.pending || operation?.kind !== 'export' || operation.status !== 'ready')
      return null
    if (operation.expiresAt <= Date.now()) {
      this.expireHandle(operation.id)
      return null
    }
    const { signal } = this.controller
    this.update({ pending: 'download', error: null })
    try {
      const blob = await this.biz.download(operation.id, signal)
      if (signal.aborted) return null
      this.clearHandle(operation.id)
      return blob
    } catch (error) {
      if (signal.aborted) return null
      if (error instanceof L2EnvironmentRequestError && error.status === 404) {
        this.expireHandle(operation.id)
      } else this.update({ error: message(error) })
      return null
    } finally {
      if (!signal.aborted) this.update({ pending: null })
    }
  }

  browse = async (from: string, cwd: string | null): Promise<void> => {
    this.browseController?.abort()
    const controller = new AbortController()
    this.browseController = controller
    this.update({ browser: { from, listing: null, loading: true, error: null } })
    try {
      const listing = await this.biz.browse(cwd, controller.signal)
      if (!controller.signal.aborted)
        this.update({ browser: { from, listing, loading: false, error: null } })
    } catch (error) {
      if (!controller.signal.aborted)
        this.update({ browser: { from, listing: null, loading: false, error: message(error) } })
    }
  }
  closeBrowser = (): void => {
    this.browseController?.abort()
    this.browseController = null
    this.update({ browser: null })
  }

  dispose = (): void => {
    this.controller.abort()
    this.previewController?.abort()
    this.browseController?.abort()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.stagedId) this.release(this.stagedId)
    this.stagedId = null
    this.state = {
      ...this.state,
      pending: null,
      polling: false,
      password: '',
      exportDraft: { ...this.state.exportDraft, password: '', confirmation: '' }
    }
  }
}
