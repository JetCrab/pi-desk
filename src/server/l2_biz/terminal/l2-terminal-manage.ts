import 'server-only'

import { randomUUID } from 'node:crypto'
import type {
  L2TerminalSummary,
  L2TerminalSnapshot,
  L2TerminalEvent
} from '@common/l2_biz/terminal/l2-terminal-contract'
import {
  L4TerminalRuntime,
  L4TerminalError,
  resolveL4TerminalStart
} from '@server/l4_foundation/terminal/l4-terminal-runtime'

export { L4TerminalError as L2TerminalError } from '@server/l4_foundation/terminal/l4-terminal-runtime'

interface TerminalRecord {
  summary: L2TerminalSummary
  runtime: L4TerminalRuntime
  titleTimer: ReturnType<typeof setTimeout> | null
}

const MAX_RUNNING = 16
const MAX_EXITED = 16
const MAX_COLLECTION_OPERATIONS = 64
const TITLE_UPDATE_DELAY = 50

export class L2TerminalManage {
  private readonly records = new Map<string, TerminalRecord>()
  private readonly exitedIds: string[] = []
  // 成功后释放；失败保留至服务关闭并继续占用容量，避免无主进程无限累积。
  private readonly releases = new Map<string, Promise<void>>()
  private readonly listeners = new Set<(terminals: L2TerminalSummary[]) => void>()
  private tail: Promise<void> = Promise.resolve()
  private pending = 0
  private closing = false
  private disposing: Promise<void> | null = null

  create(cwd?: string): Promise<L2TerminalSummary> {
    const requestedAt = performance.now()
    return this.enqueue(async () => {
      const startedAt = performance.now()
      this.ensureOpen()
      if (
        this.list().filter((item) => item.status === 'running').length + this.releases.size >=
        MAX_RUNNING
      )
        throw new L4TerminalError(429, '运行中或尚未完成清理的终端已达 16 个上限')
      const start = await resolveL4TerminalStart(cwd)
      const resolvedAt = performance.now()
      this.ensureOpen()
      const terminalId = randomUUID()
      const runtime = new L4TerminalRuntime(
        terminalId,
        start,
        (exitCode) => this.handleExit(terminalId, exitCode),
        (title) => this.handleTitleChange(terminalId, title)
      )
      const summary: L2TerminalSummary = {
        terminalId,
        cwd: start.cwd,
        shell: start.shell,
        title: '',
        status: 'running',
        exitCode: null
      }
      this.records.set(terminalId, { summary, runtime, titleTimer: null })
      this.publish()
      console.info('[Pi Desk][TerminalManage] 已创建终端', {
        terminalId,
        cwd: start.cwd,
        shell: start.shell,
        queueMs: Math.round(startedAt - requestedAt),
        resolveMs: Math.round(resolvedAt - startedAt),
        startMs: Math.round(performance.now() - resolvedAt),
        totalMs: Math.round(performance.now() - requestedAt)
      })
      return { ...summary }
    })
  }

  list(): L2TerminalSummary[] {
    return Array.from(this.records.values(), ({ summary }) => ({ ...summary }))
  }

  subscribeList(listener: (terminals: L2TerminalSummary[]) => void): () => void {
    this.ensureOpen()
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  watch(
    id: string,
    listener: (event: L2TerminalEvent) => void
  ): Promise<{ snapshot: L2TerminalSnapshot; dispose: () => void }> {
    return this.get(id).runtime.watch(listener)
  }

  input(id: string, data: string): Promise<void> {
    return this.get(id).runtime.input(data)
  }

  activate(id: string, ownerId: string, cols: number, rows: number): Promise<void> {
    return this.get(id).runtime.activate(ownerId, cols, rows)
  }

  resize(id: string, ownerId: string, cols: number, rows: number): Promise<void> {
    return this.get(id).runtime.resize(ownerId, cols, rows)
  }

  releaseOwner(ownerId: string): void {
    for (const record of this.records.values()) record.runtime.releaseOwner(ownerId)
  }

  remove(id: string): Promise<void> {
    const requestedAt = performance.now()
    return this.enqueue(async () => {
      const record = this.get(id)
      this.clearTitleTimer(record)
      this.records.delete(id)
      const index = this.exitedIds.indexOf(id)
      if (index !== -1) this.exitedIds.splice(index, 1)
      this.release(record)
      this.publish()
      console.info('[Pi Desk][TerminalManage] 已接纳终端关闭', {
        terminalId: id,
        elapsedMs: Math.round(performance.now() - requestedAt)
      })
    })
  }

  private release(record: TerminalRecord): void {
    const terminalId = record.summary.terminalId
    const startedAt = performance.now()
    // 先让列表推送和接纳响应发出，再开始可能包含同步原生调用的资源清理。
    const release = new Promise<void>((resolve) => setImmediate(resolve)).then(() =>
      record.runtime.dispose()
    )
    this.releases.set(terminalId, release)
    void release.then(
      () => {
        this.releases.delete(terminalId)
        console.info('[Pi Desk][TerminalManage] 终端资源已释放', {
          terminalId,
          elapsedMs: Math.round(performance.now() - startedAt)
        })
      },
      (error: unknown) => {
        console.error('[Pi Desk][TerminalManage] 终端资源清理失败', {
          terminalId,
          elapsedMs: Math.round(performance.now() - startedAt),
          error
        })
      }
    )
  }

  dispose(): Promise<void> {
    if (!this.disposing) {
      this.closing = true
      this.listeners.clear()
      for (const record of this.records.values()) this.clearTitleTimer(record)
      this.disposing = this.disposeAll()
    }
    return this.disposing
  }

  private async disposeAll(): Promise<void> {
    await this.tail
    const results = await Promise.allSettled([
      ...this.releases.values(),
      ...Array.from(this.records.values(), (record) => record.runtime.dispose())
    ])
    this.records.clear()
    this.releases.clear()
    this.exitedIds.length = 0
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    if (failures.length) {
      console.error('[Pi Desk][TerminalManage] 终端集合释放失败', {
        errors: failures.map((failure) => failure.reason)
      })
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        '终端资源未完全释放'
      )
    }
  }

  private handleTitleChange(id: string, title: string): void {
    const record = this.records.get(id)
    if (!record || this.closing) return
    const normalized = title.replace(/\p{Cc}/gu, '').slice(0, 512)
    if (record.summary.title === normalized) return
    record.summary.title = normalized
    if (!record.titleTimer) {
      record.titleTimer = setTimeout(() => this.publish(), TITLE_UPDATE_DELAY)
    }
  }

  private clearTitleTimer(record: TerminalRecord): void {
    if (record.titleTimer) clearTimeout(record.titleTimer)
    record.titleTimer = null
  }

  private handleExit(id: string, exitCode: number): void {
    const record = this.records.get(id)
    if (!record || this.closing || record.summary.status === 'exited') return
    record.summary = { ...record.summary, status: 'exited', exitCode }
    this.exitedIds.push(id)
    // 退出画面按退出先后保留；从集合移除后立即释放 headless 和观察者。
    while (this.exitedIds.length > MAX_EXITED) {
      const oldest = this.exitedIds.shift()!
      const expired = this.records.get(oldest)
      this.records.delete(oldest)
      if (expired) {
        this.clearTitleTimer(expired)
        this.release(expired)
      }
    }
    this.publish()
  }

  private publish(): void {
    if (this.closing) return
    // 所有列表基线都包含最新标题，已合并的待发标题更新不再单独推送。
    for (const record of this.records.values()) this.clearTitleTimer(record)
    const terminals = this.list()
    for (const listener of this.listeners) {
      try {
        listener(terminals)
      } catch (error) {
        this.listeners.delete(listener)
        console.warn('[Pi Desk][TerminalManage] 列表观察失败', { error })
      }
    }
  }

  private get(id: string): TerminalRecord {
    this.ensureOpen()
    const record = this.records.get(id)
    if (!record) throw new L4TerminalError(404, '终端不存在')
    return record
  }

  private ensureOpen(): void {
    if (this.closing) throw new L4TerminalError(503, '终端服务正在关闭')
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new L4TerminalError(503, '终端服务正在关闭'))
    if (this.pending >= MAX_COLLECTION_OPERATIONS)
      return Promise.reject(new L4TerminalError(429, '终端集合操作队列已满'))
    this.pending += 1
    const result = this.tail.then(operation)
    this.tail = result
      .then(
        () => undefined,
        () => undefined
      )
      .finally(() => {
        this.pending -= 1
      })
    return result
  }
}

declare global {
  var __piDeskTerminalManage: L2TerminalManage | undefined
}

export function getL2TerminalManage(): L2TerminalManage {
  if (!globalThis.__piDeskTerminalManage) globalThis.__piDeskTerminalManage = new L2TerminalManage()
  return globalThis.__piDeskTerminalManage
}
