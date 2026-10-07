'use client'

import {
  L2TerminalSocketContracts as contracts,
  L2_TERMINAL_MAX_INPUT,
  type L2TerminalEvent,
  type L2TerminalSnapshot,
  type L2TerminalSummary
} from '@common/l2_biz/terminal/l2-terminal-contract'
import type { L4AppSocketClient } from '@client/l4_foundation/realtime/app-socket/l4-app-socket'
import type {
  L4TerminalDimensions,
  L4TerminalRenderer
} from '@client/l4_foundation/terminal/l4-terminal-renderer'

interface TabState {
  retained: boolean
  syncing: boolean
  error: string | null
}

interface TerminalState {
  terminals: readonly L2TerminalSummary[]
  selectedId: string | null
  expanded: boolean
  ready: boolean
  busy: boolean
  opening: boolean
  error: string | null
  // 已展示的标签负责保留 DOM；仅删除记录或卸载页面时释放。
  tabs: Readonly<Record<string, TabState>>
}

interface Watch {
  owner: Screen
  connection: number
  buffered: L2TerminalEvent[]
  bytes: number
  baseline: boolean
  observing: boolean
  draining: boolean
}

interface Screen {
  id: string
  sink: L4TerminalRenderer
  watch: Watch | null
  parsing: Promise<void>
  operated: boolean
}

interface Command {
  id: string
  dimensions: L4TerminalDimensions
  connection: number
  watch: Watch
}

const MAX_OUTPUT_QUEUE = 1024 * 1024
const MAX_INPUT_QUEUE = 256 * 1024
const encoder = new TextEncoder()

export function splitL2TerminalInput(data: string): string[] {
  const chunks: string[] = []
  let chunk = ''
  let bytes = 0
  for (const character of data) {
    const length = encoder.encode(character).length
    if (bytes + length > L2_TERMINAL_MAX_INPUT) {
      chunks.push(chunk)
      chunk = ''
      bytes = 0
    }
    chunk += character
    bytes += length
  }
  if (chunk) chunks.push(chunk)
  return chunks
}

export class L2TerminalBiz {
  private state: TerminalState = {
    terminals: [],
    selectedId: null,
    expanded: false,
    ready: false,
    busy: false,
    opening: false,
    error: null,
    tabs: {}
  }
  private readonly listeners = new Set<() => void>()
  private readonly screens = new Map<string, Screen>()
  // 当前连接已发送的观察；取消成功、记录删除或断线后释放，失败时保留隔离屏障。
  private readonly observedIds = new Set<string>()
  private unsubscribers: Array<() => void> = []
  private connectionEpoch = 0
  private listEpoch = 0
  private pageVisible = true
  private watchChain: Promise<void> = Promise.resolve()
  private commandRunning = false
  private pendingActivation: Command | null = null
  private pendingResize: Command | null = null
  private inputQueue: Array<Command & { data: string }> = []
  private inputBytes = 0
  private inputTimer: ReturnType<typeof setTimeout> | null = null
  private resizeTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly socket: L4AppSocketClient,
    private readonly onError: (message: string) => void = () => undefined
  ) {}

  getSnapshot = (): TerminalState => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start = (): void => {
    if (this.unsubscribers.length) return
    this.unsubscribers = [
      this.socket.subscribe(contracts.update, ({ terminals }) => {
        if (!this.state.ready) return
        this.listEpoch += 1
        this.replaceList(terminals)
      }),
      this.socket.subscribe(contracts.event, ({ terminalId, event }) => {
        const watch = this.screens.get(terminalId)?.watch
        if (watch?.observing && this.valid(watch)) this.enqueue(watch, event)
      })
    ]
  }

  connected = async (): Promise<void> => {
    this.start()
    const epoch = ++this.connectionEpoch
    this.clearInput()
    for (const screen of this.screens.values()) screen.watch = null
    this.patch({ ready: true })
    try {
      await this.refreshList()
      if (epoch !== this.connectionEpoch || !this.state.ready) return
      for (const screen of this.screens.values()) {
        if (!screen.watch) this.scheduleWatch(screen)
      }
    } catch (cause) {
      if (epoch === this.connectionEpoch) this.fail(cause)
    }
  }

  disconnected = (): void => {
    this.connectionEpoch += 1
    this.listEpoch += 1
    this.observedIds.clear()
    for (const screen of this.screens.values()) {
      screen.watch = null
      screen.operated = false
    }
    this.clearInput()
    const tabs = Object.fromEntries(
      Object.entries(this.state.tabs).map(([id, tab]) => [id, { ...tab, syncing: false }])
    )
    this.patch({ ready: false, tabs })
  }

  dispose = (): void => {
    if (this.state.ready)
      void this.socket.request(contracts.watch, { terminalId: null }).catch(() => undefined)
    this.disconnected()
    for (const unsubscribe of this.unsubscribers) unsubscribe()
    this.unsubscribers = []
    this.screens.clear()
  }

  open = async (cwd?: string, signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted()
    if (!this.state.ready) throw new Error('终端尚未连接')
    if (this.state.busy) return
    const epoch = this.connectionEpoch
    const startedAt = performance.now()
    this.patch({ busy: true, opening: true, expanded: true, error: null })
    this.retainSelected()
    try {
      const terminal = await this.socket.request(contracts.create, cwd ? { cwd } : {})
      if (epoch !== this.connectionEpoch) throw new Error('连接已变化，请查看终端列表确认创建结果')
      // 其他页面只接收列表；旧插件请求已产生的 Shell 保留，但不抢展示。
      if (!this.state.terminals.some((item) => item.terminalId === terminal.terminalId)) {
        this.replaceList([...this.state.terminals, terminal])
      }
      signal?.throwIfAborted()
      this.patch({ selectedId: terminal.terminalId })
      this.retainSelected()
      console.info('[Pi Desk][Terminal] 已收到创建结果', {
        terminalId: terminal.terminalId,
        elapsedMs: Math.round(performance.now() - startedAt)
      })
    } catch (cause) {
      if (!signal?.aborted) this.fail(cause)
      if (this.state.ready) void this.refreshList().catch((error: unknown) => this.fail(error))
      throw cause
    } finally {
      this.patch({
        busy: false,
        opening: false,
        expanded:
          this.state.expanded && (this.state.terminals.length > 0 || this.state.error !== null)
      })
    }
  }

  remove = async (terminalId: string): Promise<void> => {
    if (!this.state.ready || this.state.busy) return
    const startedAt = performance.now()
    this.patch({ busy: true, error: null })
    try {
      await this.socket.request(contracts.remove, { terminalId })
      console.info('[Pi Desk][Terminal] 服务端已接纳关闭', {
        terminalId,
        elapsedMs: Math.round(performance.now() - startedAt)
      })
    } catch (cause) {
      this.fail(cause, terminalId)
      if (this.state.ready) void this.refreshList().catch((error: unknown) => this.fail(error))
    } finally {
      this.patch({ busy: false })
    }
  }

  refreshList = async (): Promise<void> => {
    const epoch = this.connectionEpoch
    const listEpoch = ++this.listEpoch
    const response = await this.socket.request(contracts.list, {})
    if (epoch === this.connectionEpoch && listEpoch === this.listEpoch && this.state.ready) {
      this.replaceList(response.terminals)
    }
  }

  retry = (): void => {
    if (!this.state.ready) return
    this.patch({ error: null })
    const screen = this.state.selectedId ? this.screens.get(this.state.selectedId) : undefined
    void this.refreshList()
      .then(() => {
        if (screen && this.screens.get(screen.id) === screen) this.scheduleWatch(screen)
      })
      .catch((cause: unknown) => this.fail(cause))
  }

  setPageVisible = (visible: boolean): void => {
    this.pageVisible = visible
  }

  select = (terminalId: string): void => {
    if (!this.state.terminals.some((item) => item.terminalId === terminalId)) return
    this.patch({ selectedId: terminalId, expanded: true })
    this.retainSelected()
  }

  setExpanded = (expanded: boolean): void => {
    this.patch({ expanded })
    this.retainSelected()
  }

  attach = (terminalId: string, sink: L4TerminalRenderer): (() => void) => {
    const previous = this.screens.get(terminalId)
    if (previous) {
      previous.watch = null
      this.cancelInput(terminalId)
    }
    const screen: Screen = {
      id: terminalId,
      sink,
      watch: null,
      parsing: previous?.parsing ?? Promise.resolve(),
      operated: false
    }
    this.screens.set(terminalId, screen)
    this.patchTab(terminalId, { retained: true })
    if (this.state.ready) this.scheduleWatch(screen)
    return () => {
      if (this.screens.get(terminalId) !== screen) return
      screen.watch = null
      this.screens.delete(terminalId)
      this.cancelInput(terminalId)
      this.unwatch(terminalId)
    }
  }

  activate = (terminalId: string, dimensions: L4TerminalDimensions): void => {
    const command = this.inputTarget(terminalId, dimensions)
    if (!command) return
    command.watch.owner.operated = true
    this.pendingActivation = command
    void this.flushCommands()
  }

  input = (terminalId: string, data: string, dimensions: L4TerminalDimensions): void => {
    const command = this.inputTarget(terminalId, dimensions)
    if (!command || !data) return
    command.watch.owner.operated = true
    const bytes = encoder.encode(data).length
    if (this.inputBytes + bytes > MAX_INPUT_QUEUE || this.inputQueue.length >= 256) {
      this.clearInput()
      this.fail(new Error('输入过多，尚未发送的内容已取消'), terminalId)
      return
    }
    this.inputBytes += bytes
    this.inputQueue.push({ ...command, data })
    if (!this.inputTimer)
      this.inputTimer = setTimeout(() => {
        this.inputTimer = null
        void this.flushCommands()
      }, 8)
  }

  resize = (terminalId: string, dimensions: L4TerminalDimensions): void => {
    const command = this.inputTarget(terminalId, dimensions)
    if (!command || !command.watch.owner.operated) return
    if (this.resizeTimer) clearTimeout(this.resizeTimer)
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null
      if (!this.viewCommandValid(command)) return
      this.pendingResize = command
      void this.flushCommands()
    }, 80)
  }

  private async flushCommands(): Promise<void> {
    if (this.commandRunning) return
    this.commandRunning = true
    let activeCommand: Command | undefined
    try {
      while (this.pendingActivation || this.inputQueue.length || this.pendingResize) {
        if (this.pendingActivation) {
          const action = this.pendingActivation
          this.pendingActivation = null
          if (!this.viewCommandValid(action)) continue
          activeCommand = action
          await this.socket.request(contracts.activate, {
            terminalId: action.id,
            ...action.dimensions
          })
        } else if (this.inputQueue.length) {
          const first = this.inputQueue.shift()!
          let data = first.data
          while (
            this.inputQueue[0]?.watch === first.watch &&
            encoder.encode(data + this.inputQueue[0].data).length <= L2_TERMINAL_MAX_INPUT
          ) {
            data += this.inputQueue.shift()!.data
          }
          this.inputBytes -= encoder.encode(data).length
          if (!this.commandValid(first)) continue
          activeCommand = first
          await this.socket.request(contracts.activate, {
            terminalId: first.id,
            ...first.dimensions
          })
          for (const chunk of splitL2TerminalInput(data)) {
            if (!this.commandValid(first)) break
            await this.socket.request(contracts.input, { terminalId: first.id, data: chunk })
          }
        } else if (this.pendingResize) {
          const action = this.pendingResize
          this.pendingResize = null
          if (!this.viewCommandValid(action)) continue
          activeCommand = action
          // 自动测量不 activate，非操作页由服务端忽略。
          await this.socket.request(contracts.resize, {
            terminalId: action.id,
            ...action.dimensions
          })
        }
      }
    } catch (cause) {
      if (activeCommand && this.commandValid(activeCommand)) {
        this.cancelInput(activeCommand.id)
        this.fail(cause, activeCommand.id)
      }
    } finally {
      this.commandRunning = false
      if (this.pendingActivation || this.inputQueue.length || this.pendingResize)
        void this.flushCommands()
    }
  }

  private inputTarget(id: string, dimensions: L4TerminalDimensions): Command | null {
    const watch = this.screens.get(id)?.watch
    return this.state.ready &&
      this.pageVisible &&
      this.state.expanded &&
      this.state.selectedId === id &&
      watch?.baseline &&
      !this.state.tabs[id]?.syncing &&
      this.valid(watch) &&
      this.state.terminals.some((item) => item.terminalId === id && item.status === 'running')
      ? { id, dimensions, connection: this.connectionEpoch, watch }
      : null
  }

  private commandValid(command: Command): boolean {
    return (
      command.connection === this.connectionEpoch &&
      this.valid(command.watch) &&
      command.watch.baseline &&
      this.state.terminals.some(
        (item) => item.terminalId === command.id && item.status === 'running'
      )
    )
  }

  private viewCommandValid(command: Command): boolean {
    return this.commandValid(command) && Boolean(this.inputTarget(command.id, command.dimensions))
  }

  private cancelInput(id: string): void {
    this.inputQueue = this.inputQueue.filter((command) => command.id !== id)
    this.inputBytes = this.inputQueue.reduce(
      (bytes, command) => bytes + encoder.encode(command.data).length,
      0
    )
    if (this.pendingActivation?.id === id) this.pendingActivation = null
    if (this.pendingResize?.id === id) this.pendingResize = null
    if (!this.inputQueue.length && this.inputTimer) {
      clearTimeout(this.inputTimer)
      this.inputTimer = null
    }
  }

  private clearInput(): void {
    if (this.inputTimer) clearTimeout(this.inputTimer)
    if (this.resizeTimer) clearTimeout(this.resizeTimer)
    this.inputTimer = null
    this.resizeTimer = null
    this.inputQueue = []
    this.inputBytes = 0
    this.pendingActivation = null
    this.pendingResize = null
  }

  private replaceList(terminals: readonly L2TerminalSummary[]): void {
    const ids = new Set(terminals.map((terminal) => terminal.terminalId))
    for (const id of this.observedIds) {
      if (!ids.has(id)) this.observedIds.delete(id)
    }
    for (const screen of this.screens.values()) {
      if (ids.has(screen.id)) continue
      screen.watch = null
      this.screens.delete(screen.id)
      this.cancelInput(screen.id)
    }
    const tabs = Object.fromEntries(Object.entries(this.state.tabs).filter(([id]) => ids.has(id)))
    const selectedId = ids.has(this.state.selectedId ?? '')
      ? this.state.selectedId
      : (terminals[0]?.terminalId ?? null)
    this.patch({
      terminals,
      tabs,
      selectedId,
      expanded:
        this.state.expanded &&
        (terminals.length > 0 || this.state.opening || this.state.error !== null)
    })
    this.retainSelected()
  }

  private retainSelected(): void {
    const id = this.state.expanded ? this.state.selectedId : null
    if (id && !this.state.tabs[id]?.retained) this.patchTab(id, { retained: true })
  }

  private unwatch(id: string): void {
    const connection = this.connectionEpoch
    this.watchChain = this.watchChain
      .then(async () => {
        if (connection !== this.connectionEpoch || !this.state.ready) return
        await this.socket.request(contracts.unwatch, { terminalId: id })
        if (connection === this.connectionEpoch) this.observedIds.delete(id)
      })
      .catch((cause: unknown) => {
        if (connection === this.connectionEpoch) this.fail(cause, id)
      })
  }

  private scheduleWatch(screen: Screen): void {
    const connection = this.connectionEpoch
    const watch: Watch = {
      owner: screen,
      connection,
      buffered: [],
      bytes: 0,
      baseline: false,
      observing: false,
      draining: false
    }
    screen.watch = watch
    this.cancelInput(screen.id)
    this.patchTab(screen.id, { syncing: true, error: null })
    this.watchChain = this.watchChain
      .then(async () => {
        if (!this.valid(watch)) return
        const startedAt = performance.now()
        // 只有同连接已有观察时才需要屏障，首次观察直接请求快照。
        if (this.observedIds.has(screen.id)) {
          await this.socket.request(contracts.unwatch, { terminalId: screen.id })
          if (!this.valid(watch)) return
          this.observedIds.delete(screen.id)
        }
        watch.observing = true
        this.observedIds.add(screen.id)
        const { snapshot } = await this.socket.request(contracts.watch, { terminalId: screen.id })
        if (!this.valid(watch)) return
        if (!snapshot) throw new Error('终端画面不可用')
        // 仅物理请求串行；其他标签不等待此实例的恢复与解析。
        void this.restoreWatch(watch, snapshot)
          .then(() => {
            if (this.valid(watch))
              console.info('[Pi Desk][Terminal] 终端画面同步完成', {
                terminalId: screen.id,
                elapsedMs: Math.round(performance.now() - startedAt)
              })
          })
          .catch((cause: unknown) => this.failWatch(watch, cause))
      })
      .catch((cause: unknown) => this.failWatch(watch, cause))
  }

  private async restoreWatch(watch: Watch, snapshot: L2TerminalSnapshot): Promise<void> {
    const screen = watch.owner
    screen.parsing = screen.parsing
      .catch(() => undefined)
      .then(async () => {
        if (this.valid(watch)) await screen.sink.restore(snapshot)
      })
    await screen.parsing
    if (!this.valid(watch)) return
    watch.baseline = true
    await this.drain(watch)
    if (this.valid(watch)) this.patchTab(screen.id, { syncing: false, error: null })
  }

  private failWatch(watch: Watch, cause: unknown): void {
    if (!this.valid(watch)) return
    watch.owner.watch = null
    this.patchTab(watch.owner.id, { syncing: false })
    this.fail(cause, watch.owner.id)
  }

  private valid(watch: Watch): boolean {
    return (
      this.state.ready &&
      watch.connection === this.connectionEpoch &&
      this.screens.get(watch.owner.id) === watch.owner &&
      watch.owner.watch === watch
    )
  }

  private enqueue(watch: Watch, event: L2TerminalEvent): void {
    const bytes =
      event.type === 'output'
        ? encoder.encode(event.data).length
        : event.type === 'snapshot'
          ? encoder.encode(event.snapshot.data).length
          : 32
    if (watch.bytes + bytes > MAX_OUTPUT_QUEUE || watch.buffered.length >= 256) {
      console.warn('[Pi Desk][Terminal] 渲染队列已满，重新建立画面', { terminalId: watch.owner.id })
      this.scheduleWatch(watch.owner)
      return
    }
    watch.bytes += bytes
    watch.buffered.push(event)
    if (watch.baseline) void this.drain(watch)
  }

  private async drain(watch: Watch): Promise<void> {
    if (watch.draining) return
    watch.draining = true
    const screen = watch.owner
    screen.parsing = screen.parsing
      .catch(() => undefined)
      .then(async () => {
        while (this.valid(watch) && watch.buffered.length) {
          const event = watch.buffered.shift()!
          if (event.type === 'output') {
            watch.bytes -= encoder.encode(event.data).length
            await screen.sink.write(event.data)
          } else if (event.type === 'resize') {
            watch.bytes -= 32
            screen.sink.resize(event)
          } else if (event.type === 'snapshot') {
            watch.bytes -= encoder.encode(event.snapshot.data).length
            await screen.sink.restore(event.snapshot)
          } else {
            watch.bytes -= 32
          }
        }
      })
    try {
      await screen.parsing
    } catch (cause) {
      if (this.valid(watch)) {
        this.fail(cause, screen.id)
        this.scheduleWatch(screen)
      }
    } finally {
      watch.draining = false
      if (this.valid(watch) && watch.buffered.length) await this.drain(watch)
    }
  }

  private patchTab(id: string, change: Partial<TabState>): void {
    const previous = this.state.tabs[id] ?? { retained: false, syncing: false, error: null }
    this.patch({ tabs: { ...this.state.tabs, [id]: { ...previous, ...change } } })
  }

  private patch(change: Partial<TerminalState>): void {
    this.state = { ...this.state, ...change }
    for (const listener of this.listeners) listener()
  }

  private fail(cause: unknown, id?: string): void {
    const error = cause instanceof Error ? cause.message : '终端操作失败'
    console.warn('[Pi Desk][Terminal] 终端操作失败', { terminalId: id, message: error })
    if (id) {
      if (this.state.terminals.some((item) => item.terminalId === id)) this.patchTab(id, { error })
      return
    }
    if (error !== this.state.error) this.onError(error)
    this.patch({ error })
  }
}
