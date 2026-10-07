'use client'

import {
  emptyL4PiUiSnapshot,
  type L4PiUiEvent,
  type L4PiUiResponse,
  type L4PiUiSnapshot
} from '@common/l4_foundation/pi/l4-pi-ui-contract'
import { L3PiUiSocketContracts } from '@common/l3_modules/plugin-host/l3-plugin-native-ui-contract'
import { L3PiNativeSocketContracts } from '@common/l3_modules/plugin-host/l3-plugin-native-pi-contract'
import type { L3WorkSessionSource } from '@common/l3_modules/work-session/l3-work-session-source-contract'
import type { L4AppSocketClient } from '@client/l4_foundation/realtime/app-socket/l4-app-socket'
import { l2WorkbenchText } from '../l2-workbench-text'

export interface L2NativeUiState {
  snapshot: L4PiUiSnapshot
  notices: Array<Pick<Extract<L4PiUiEvent, { type: 'notify' }>, 'level' | 'message'>>
  commandPending: string | null
  ready: boolean
  refreshing: boolean
  error: string | null
  submitting: string | null
  unknown: string | null
  answers: Record<string, string>
  collapsed: boolean
  prefill: Extract<L4PiUiEvent, { type: 'editor_text' }> | null
}
interface RecordState {
  source: L3WorkSessionSource
  state: L2NativeUiState
  latest: L4PiUiSnapshot | null
}
function key(source: L3WorkSessionSource): string {
  return JSON.stringify([source.workId, source.sessionId, source.branchId])
}

export class L2NativeUiBiz {
  private readonly records = new Map<string, RecordState>()
  private readonly listeners = new Set<() => void>()
  private readonly notices = new Set<
    (source: L3WorkSessionSource, event: Extract<L4PiUiEvent, { type: 'notify' }>) => void
  >()
  private releasePush: (() => void) | null = null
  private connected = false
  private epoch = 0

  constructor(private readonly socket: L4AppSocketClient) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onNotice(
    listener: (source: L3WorkSessionSource, event: Extract<L4PiUiEvent, { type: 'notify' }>) => void
  ): () => void {
    this.notices.add(listener)
    return () => this.notices.delete(listener)
  }

  getState(source: L3WorkSessionSource): L2NativeUiState {
    return this.record(source).state
  }

  watch(source: L3WorkSessionSource): void {
    if (!this.releasePush)
      this.releasePush = this.socket.subscribe(L3PiUiSocketContracts.event, ({ source, event }) => {
        const record = this.records.get(key(source))
        if (!record || !this.connected) return
        if (event.type === 'snapshot') {
          if (record.state.refreshing) record.latest = event.snapshot
          else this.apply(record, event.snapshot)
        } else if (event.type === 'editor_text') {
          this.patch(record, { prefill: event })
        } else {
          this.appendNotice(record, event)
          for (const listener of this.notices) listener(source, event)
        }
      })
    const record = this.record(source)
    if (this.connected && !record.state.ready && !record.state.refreshing) void this.refresh(record)
  }

  ready(sources: readonly L3WorkSessionSource[]): void {
    this.reconcile(sources)
    this.connected = true
    for (const record of this.records.values()) void this.refresh(record)
  }

  reconcile(sources: readonly L3WorkSessionSource[]): void {
    const valid = new Set(sources.map(key))
    for (const [id, record] of this.records) {
      if (valid.has(id)) continue
      this.records.delete(id)
      if (this.connected)
        void this.socket
          .request(L3PiUiSocketContracts.unsubscribe, { source: record.source })
          .catch(() => undefined)
    }
    this.emit()
  }

  disconnected(): void {
    this.connected = false
    this.epoch += 1
    for (const record of this.records.values()) {
      record.latest = null
      this.patch(record, {
        ready: false,
        refreshing: false,
        submitting: null,
        commandPending: null,
        unknown: record.state.submitting ?? record.state.unknown
      })
    }
  }

  edit(
    source: L3WorkSessionSource,
    changes: Pick<
      Partial<L2NativeUiState>,
      'answers' | 'collapsed' | 'prefill' | 'error' | 'notices'
    >
  ): void {
    this.patch(this.record(source), changes)
  }

  refreshSource(source: L3WorkSessionSource): Promise<void> {
    return this.refresh(this.record(source))
  }

  async respond(source: L3WorkSessionSource, response: L4PiUiResponse): Promise<void> {
    const record = this.record(source)
    if (!record.state.ready || record.state.submitting || record.state.unknown) return
    const epoch = this.epoch
    this.patch(record, { submitting: response.id, error: null })
    try {
      await this.socket.request(L3PiUiSocketContracts.respond, { source, response })
      if (this.current(record, epoch) && record.state.submitting === response.id)
        this.patch(record, { submitting: null })
    } catch (cause) {
      if (
        !this.current(record, epoch) ||
        !record.state.snapshot.requests.some((request) => request.id === response.id)
      )
        return
      const known = cause instanceof Error && 'code' in cause
      this.patch(record, {
        submitting: null,
        unknown: known ? null : response.id,
        error: known ? cause.message : l2WorkbenchText('nativeUiUnknown')
      })
      // 只重新读取权威快照，不自动重发未知结果的回答。
      if (this.connected) await this.refresh(record, known)
    }
  }

  async executeCommand(source: L3WorkSessionSource, command: string, args: string): Promise<void> {
    const record = this.record(source)
    if (!record.state.ready || record.state.commandPending) return
    const epoch = this.epoch
    this.patch(record, { commandPending: `/${command}${args ? ` ${args}` : ''}` })
    try {
      await this.socket.request(L3PiNativeSocketContracts.commandExecute, { source, command, args })
    } catch (cause) {
      if (this.current(record, epoch)) {
        this.appendNotice(record, {
          level: 'error',
          message: cause instanceof Error ? cause.message : l2WorkbenchText('operationFailed')
        })
      }
    } finally {
      if (this.current(record, epoch)) this.patch(record, { commandPending: null })
    }
  }

  dispose(): void {
    this.disconnected()
    this.releasePush?.()
    this.releasePush = null
    this.records.clear()
    this.listeners.clear()
    this.notices.clear()
  }

  private record(source: L3WorkSessionSource): RecordState {
    const id = key(source)
    let record = this.records.get(id)
    if (!record) {
      record = {
        source,
        latest: null,
        state: {
          snapshot: emptyL4PiUiSnapshot(),
          notices: [],
          commandPending: null,
          ready: false,
          refreshing: false,
          error: null,
          submitting: null,
          unknown: null,
          answers: {},
          collapsed: false,
          prefill: null
        }
      }
      this.records.set(id, record)
    }
    return record
  }

  private current(record: RecordState, epoch: number): boolean {
    return this.epoch === epoch && this.records.get(key(record.source)) === record
  }

  private async refresh(record: RecordState, preserveResponseError = false): Promise<void> {
    if (!this.connected || record.state.refreshing) return
    const epoch = this.epoch
    record.latest = null
    this.patch(record, { ready: false, refreshing: true })
    try {
      const snapshot = await this.socket.request(L3PiUiSocketContracts.subscribe, {
        source: record.source
      })
      if (!this.current(record, epoch)) return
      this.apply(record, record.latest ?? snapshot)
      this.patch(record, {
        ready: true,
        unknown: null,
        ...(!preserveResponseError ? { error: null } : {})
      })
    } catch (cause) {
      if (this.current(record, epoch))
        this.patch(record, {
          ready: false,
          error: cause instanceof Error ? cause.message : l2WorkbenchText('nativeUiFailed')
        })
    } finally {
      if (this.current(record, epoch)) {
        record.latest = null
        this.patch(record, { refreshing: false })
      }
    }
  }

  private apply(record: RecordState, snapshot: L4PiUiSnapshot): void {
    const ids = new Set(snapshot.requests.map((request) => request.id))
    const answers = Object.fromEntries(
      Object.entries(record.state.answers).filter(([id]) => ids.has(id))
    )
    this.patch(record, {
      snapshot,
      answers,
      submitting:
        record.state.submitting && ids.has(record.state.submitting)
          ? record.state.submitting
          : null,
      unknown: record.state.unknown && ids.has(record.state.unknown) ? record.state.unknown : null,
      ...(snapshot.requests[0]?.id !== record.state.snapshot.requests[0]?.id ? { error: null } : {})
    })
  }

  private appendNotice(
    record: RecordState,
    notice: Pick<Extract<L4PiUiEvent, { type: 'notify' }>, 'level' | 'message'>
  ): void {
    // 只保存当前 Source 的文本流，不把通知猜测关联到某次命令。
    const notices = [
      ...record.state.notices,
      { level: notice.level, message: notice.message.slice(0, 64 * 1024) }
    ].slice(-32)
    let characters = notices.reduce((total, item) => total + item.message.length, 0)
    while (characters > 64 * 1024 && notices.length > 1) {
      characters -= notices.shift()!.message.length
    }
    this.patch(record, { notices })
  }

  private patch(record: RecordState, changes: Partial<L2NativeUiState>): void {
    record.state = { ...record.state, ...changes }
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
