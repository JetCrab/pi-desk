import 'server-only'

import { join } from 'node:path'
import type { Terminal } from '@xterm/headless'
import type { SerializeAddon } from '@xterm/addon-serialize'
import type { IDisposable } from 'node-pty'
import {
  L4_TERMINAL_MAX_COLS,
  L4_TERMINAL_MAX_ROWS,
  L4_TERMINAL_MAX_INPUT,
  L4_TERMINAL_MAX_SNAPSHOT,
  L4_TERMINAL_SCROLLBACK,
  type L4TerminalSnapshot,
  type L4TerminalEvent
} from '@common/l4_foundation/terminal/l4-terminal-screen'
import { L4TerminalError, L4TerminalPty } from './l4-terminal-pty'
import { L4TerminalOutput, splitL4TerminalOutput } from './l4-terminal-output'

const MAX_QUEUE_BYTES = 1024 * 1024
const PAUSE_BYTES = 256 * 1024
const RESUME_BYTES = 64 * 1024
const MAX_OPERATIONS = 256
const { createRequire } = process.getBuiltinModule('module')
const load = createRequire(join(process.cwd(), 'package.json'))

export { L4TerminalError, resolveL4TerminalStart } from './l4-terminal-pty'

export class L4TerminalRuntime {
  private readonly screen: Terminal
  private readonly serializer: SerializeAddon
  private readonly child: L4TerminalPty
  private readonly framing = new L4TerminalOutput()
  private readonly listeners = new Set<(event: L4TerminalEvent) => void>()
  private readonly subscriptions: IDisposable[]
  private tail: Promise<void> = Promise.resolve()
  private queueBytes = 0
  private operations = 0
  private paused = false
  private ended = false
  private failed = false
  private disposed = false
  private disposing: Promise<void> | null = null
  private ownerId: string | null = null
  private readonly pendingActivations = new Set<{ ownerId: string; released: boolean }>()

  constructor(
    readonly terminalId: string,
    start: { cwd: string; file: string; args: string[] },
    private readonly onExit: (exitCode: number) => void,
    onTitleChange: (title: string) => void
  ) {
    try {
      const headless = load('@xterm/headless') as typeof import('@xterm/headless')
      const serialize = load('@xterm/addon-serialize') as typeof import('@xterm/addon-serialize')
      this.screen = new headless.Terminal({
        cols: 100,
        rows: 28,
        scrollback: L4_TERMINAL_SCROLLBACK,
        allowProposedApi: true,
        windowOptions: { pushTitle: true, popTitle: true }
      })
      this.serializer = new serialize.SerializeAddon()
      this.screen.loadAddon(this.serializer as unknown as import('@xterm/headless').ITerminalAddon)
    } catch (error) {
      console.error('[Pi Desk][Terminal] 权威屏幕加载失败', { terminalId, error })
      throw new L4TerminalError(503, '终端屏幕依赖不可用')
    }
    try {
      this.child = new L4TerminalPty(start, this.screen.cols, this.screen.rows)
      console.info('[Pi Desk][Terminal] PTY 已启动', { terminalId, pid: this.child.pty.pid })
    } catch (error) {
      this.screen.dispose()
      throw error
    }
    this.subscriptions = [
      this.screen.onTitleChange((title) => {
        if (!this.disposed) onTitleChange(title)
      }),
      this.screen.onData((data) => {
        if (this.ended || this.disposed || this.failed) return
        try {
          // 设备查询应答只由权威 headless 产生，浏览器不拥有 PTY。
          this.child.write(data)
        } catch (error) {
          this.fail(error)
        }
      }),
      this.child.pty.onData((data) => this.acceptOutput(data)),
      this.child.pty.onExit(({ exitCode }) => {
        this.ended = true
        this.ownerId = null
        void this.enqueue(async () => {
          await this.child.released
          if (this.disposed) return
          this.emit({ type: 'exit', exitCode })
          this.onExit(exitCode)
          console.info('[Pi Desk][Terminal] Shell 已退出', { terminalId, exitCode })
        }, false).catch((error: unknown) => this.fail(error))
      })
    ]
  }

  watch(
    listener: (event: L4TerminalEvent) => void
  ): Promise<{ snapshot: L4TerminalSnapshot; dispose: () => void }> {
    return this.enqueue(async () => {
      this.ensureAvailable()
      if (this.listeners.size >= 64) throw new L4TerminalError(429, '终端观察连接过多')
      const snapshot = this.snapshot()
      this.listeners.add(listener)
      return {
        snapshot,
        dispose: () => {
          this.listeners.delete(listener)
        }
      }
    })
  }

  input(data: string): Promise<void> {
    if (!data || Buffer.byteLength(data) > L4_TERMINAL_MAX_INPUT)
      return Promise.reject(new L4TerminalError(400, '终端输入必须为 1～16KiB UTF-8'))
    return this.enqueue(async () => {
      this.ensureRunning()
      this.child.write(data)
    })
  }

  activate(ownerId: string, cols: number, rows: number): Promise<void> {
    const activation = { ownerId, released: false }
    this.pendingActivations.add(activation)
    return this.enqueue(async () => {
      this.ensureRunning()
      if (activation.released) return
      this.validateDimensions(cols, rows)
      this.resizeScreen(cols, rows)
      this.ownerId = ownerId
    }).finally(() => {
      this.pendingActivations.delete(activation)
    })
  }

  resize(ownerId: string, cols: number, rows: number): Promise<void> {
    return this.enqueue(async () => {
      this.ensureAvailable()
      if (this.ownerId !== ownerId || this.ended) return
      this.validateDimensions(cols, rows)
      this.resizeScreen(cols, rows)
    })
  }

  releaseOwner(ownerId: string): void {
    if (this.ownerId === ownerId) this.ownerId = null
    // 令牌只属于尚未完成的有界 activate；断线取消，完成后立即释放。
    for (const activation of this.pendingActivations) {
      if (activation.ownerId === ownerId) activation.released = true
    }
  }

  dispose(): Promise<void> {
    if (!this.disposing) this.disposing = this.disposeRuntime()
    return this.disposing
  }

  private async disposeRuntime(): Promise<void> {
    this.disposed = true
    this.ownerId = null
    this.listeners.clear()
    // stop 前先恢复输出，ConPTY 清理要求排空 pipe，不能把自己暂停的 socket 留住。
    if (this.paused) this.child.pty.resume()
    try {
      await this.child.stop()
      await this.tail
    } finally {
      for (const subscription of this.subscriptions) subscription.dispose()
      this.framing.dispose()
      this.screen.dispose()
    }
  }

  private acceptOutput(data: string): void {
    if (this.disposed || this.failed) return
    let complete: string
    try {
      if (Buffer.byteLength(data) > MAX_QUEUE_BYTES)
        throw new L4TerminalError(429, 'PTY 单批输出超限')
      complete = this.framing.frame(data)
    } catch (error) {
      this.fail(error)
      return
    }
    if (!complete) return
    const size = Buffer.byteLength(complete)
    if (this.queueBytes + size > MAX_QUEUE_BYTES || this.operations >= MAX_OPERATIONS) {
      this.fail(new L4TerminalError(429, 'PTY 解析队列溢出'))
      return
    }
    this.queueBytes += size
    if (!this.paused && this.queueBytes >= PAUSE_BYTES) {
      this.paused = true
      this.child.pty.pause()
    }
    void this.enqueue(async () => {
      try {
        if (this.disposed) return
        for (const chunk of splitL4TerminalOutput(complete)) {
          await new Promise<void>((resolve) => this.screen.write(chunk, resolve))
          this.emit({ type: 'output', data: chunk })
        }
      } finally {
        this.queueBytes -= size
        if (this.paused && this.queueBytes <= RESUME_BYTES && !this.disposed) {
          this.paused = false
          this.child.pty.resume()
        }
      }
    }, false).catch((error: unknown) => this.fail(error))
  }

  private enqueue<T>(operation: () => Promise<T>, bounded = true): Promise<T> {
    if (bounded && this.operations >= MAX_OPERATIONS)
      return Promise.reject(new L4TerminalError(429, '终端操作队列已满'))
    this.operations += 1
    const result = this.tail.then(operation)
    this.tail = result
      .then(
        () => undefined,
        () => undefined
      )
      .finally(() => {
        this.operations -= 1
      })
    return result
  }

  private snapshot(): L4TerminalSnapshot {
    let scrollback = L4_TERMINAL_SCROLLBACK
    while (true) {
      const data = this.serializer.serialize({ scrollback })
      if (Buffer.byteLength(data) <= L4_TERMINAL_MAX_SNAPSHOT)
        return { cols: this.screen.cols, rows: this.screen.rows, data }
      if (scrollback === 0) throw new L4TerminalError(429, '终端当前画面超过快照上限')
      scrollback = Math.floor(scrollback / 2)
    }
  }

  private resizeScreen(cols: number, rows: number): void {
    if (this.screen.cols === cols && this.screen.rows === rows) return
    this.child.resize(cols, rows)
    this.screen.resize(cols, rows)
    this.emit({ type: 'resize', cols, rows })
  }

  private validateDimensions(cols: number, rows: number): void {
    if (
      !Number.isInteger(cols) ||
      !Number.isInteger(rows) ||
      cols < 2 ||
      cols > L4_TERMINAL_MAX_COLS ||
      rows < 2 ||
      rows > L4_TERMINAL_MAX_ROWS
    ) {
      throw new L4TerminalError(400, '终端尺寸必须为 2～400 列、2～200 行')
    }
  }

  private ensureAvailable(): void {
    if (this.disposed) throw new L4TerminalError(503, '终端正在关闭')
  }

  private ensureRunning(): void {
    this.ensureAvailable()
    if (this.ended || this.failed) throw new L4TerminalError(409, '终端已经退出')
  }

  private emit(event: L4TerminalEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        this.listeners.delete(listener)
        console.warn('[Pi Desk][Terminal] 释放失败的观察者', { terminalId: this.terminalId, error })
      }
    }
  }

  private fail(error: unknown): void {
    if (this.failed || this.disposed) return
    this.failed = true
    console.error('[Pi Desk][Terminal] 终端处理失败，结束目标进程', {
      terminalId: this.terminalId,
      error
    })
    if (this.paused) {
      this.paused = false
      this.child.pty.resume()
    }
    void this.child.stop().catch((stopError: unknown) =>
      console.error('[Pi Desk][Terminal] 结束失败', {
        terminalId: this.terminalId,
        error: stopError
      })
    )
  }
}
