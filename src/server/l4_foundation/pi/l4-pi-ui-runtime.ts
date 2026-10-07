import 'server-only'

import { randomUUID } from 'node:crypto'
import { stripVTControlCharacters } from 'node:util'
import type { ExtensionUIDialogOptions, ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import {
  emptyL4PiUiSnapshot,
  L4PiUiRequestSchema,
  L4PiUiSnapshotSchema,
  type L4PiUiEvent,
  type L4PiUiRequest,
  type L4PiUiResponse,
  type L4PiUiSnapshot
} from '@common/l4_foundation/pi/l4-pi-ui-contract'

type RequestBody = {
  [Method in L4PiUiRequest['method']]: Omit<
    Extract<L4PiUiRequest, { method: Method }>,
    'id' | 'expiresAt'
  >
}[L4PiUiRequest['method']]
type Listener = (event: L4PiUiEvent) => void
interface Pending {
  request: L4PiUiRequest
  resolve: (value: string | boolean | undefined) => void
  cleanup: () => void
}

export class L4PiUiResponseError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message)
    this.name = 'L4PiUiResponseError'
  }
}

/** 原生 UI 的权威等待项只属于当前 Worker；不读取或写入 Pi 消息。 */
export class L4PiUiRuntime {
  private state = emptyL4PiUiSnapshot()
  private readonly pending = new Map<string, Pending>()
  private readonly listeners = new Set<Listener>()
  private active = true
  private snapshotImmediate: ReturnType<typeof setImmediate> | null = null

  get hasPending(): boolean {
    return this.pending.size > 0
  }

  snapshot(): L4PiUiSnapshot {
    return structuredClone(this.state)
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  bind(base: ExtensionUIContext, assertOwner: () => void): ExtensionUIContext {
    const check = (): void => {
      assertOwner()
    }
    const ask = (
      input: RequestBody,
      options?: ExtensionUIDialogOptions
    ): Promise<string | boolean | undefined> => {
      check()
      return this.request(input, options)
    }
    return {
      ...base,
      select: async (title, options, opts) =>
        (await ask({ method: 'select', title, options }, opts)) as string | undefined,
      confirm: async (title, message, opts) =>
        (await ask({ method: 'confirm', title, message }, opts)) === true,
      input: async (title, placeholder = '', opts) =>
        (await ask({ method: 'input', title, placeholder }, opts)) as string | undefined,
      editor: async (title, prefill = '') =>
        (await ask({ method: 'editor', title, prefill })) as string | undefined,
      notify: (message, level = 'info') => {
        check()
        if (this.active)
          this.emit({
            type: 'notify',
            message: stripVTControlCharacters(message).slice(0, 64 * 1024),
            level
          })
      },
      setStatus: (key, text) => {
        check()
        if (!this.active) return
        const statuses = { ...this.state.statuses }
        if (text === undefined) delete statuses[key]
        else statuses[key] = stripVTControlCharacters(text)
        this.replace({ ...this.state, statuses })
      },
      setWidget: (key, content, options) => {
        check()
        if (!this.active) return
        if (typeof content === 'function') {
          this.emit({
            type: 'notify',
            level: 'warning',
            message: '该插件挂件需要终端界面，当前仅支持文本挂件。'
          })
          return
        }
        const widgets = { ...this.state.widgets }
        if (content === undefined) delete widgets[key]
        else
          widgets[key] = {
            lines: content.map(stripVTControlCharacters),
            placement: options?.placement ?? 'aboveEditor'
          }
        this.replace({ ...this.state, widgets })
      },
      setEditorText: (text) => {
        check()
        if (this.active)
          this.emit({ type: 'editor_text', mode: 'replace', text: text.slice(0, 64 * 1024) })
      },
      pasteToEditor: (text) => {
        check()
        if (this.active)
          this.emit({ type: 'editor_text', mode: 'paste', text: text.slice(0, 64 * 1024) })
      },
      custom: async () => {
        check()
        throw new Error('当前界面不支持自定义终端组件，请使用插件提供的网页界面。')
      }
    }
  }

  respond(input: L4PiUiResponse): void {
    const pending = this.pending.get(input.id)
    if (!pending) throw new L4PiUiResponseError(409, '问题已结束或已失效，请查看最新状态')
    const { request } = pending
    if (request.expiresAt !== null && request.expiresAt <= Date.now()) {
      this.finish(input.id, undefined)
      throw new L4PiUiResponseError(409, '问题已超时')
    }
    if (input.value !== null) {
      if (
        request.method === 'confirm'
          ? typeof input.value !== 'boolean'
          : typeof input.value !== 'string'
      ) {
        throw new L4PiUiResponseError(400, '回答类型不正确')
      }
      if (request.method === 'select' && !request.options.includes(input.value as string)) {
        throw new L4PiUiResponseError(400, '选择的选项已无效')
      }
    }
    this.finish(input.id, input.value ?? undefined)
  }

  cancelAll(): void {
    const pending = [...this.pending.values()]
    this.pending.clear()
    this.state = { ...this.state, requests: [] }
    for (const item of pending) item.cleanup()
    if (pending.length > 0) {
      this.publishSnapshot()
      console.info('[Pi Desk][NativeUI] 已取消待处理交互', { count: pending.length })
    }
    for (const item of pending) item.resolve(undefined)
  }

  reset(active = true): void {
    this.active = active
    this.cancelAll()
    this.state = emptyL4PiUiSnapshot()
    this.publishSnapshot()
  }

  dispose(): void {
    this.reset(false)
    this.listeners.clear()
  }

  async waitForOperation<T>(
    operation: Promise<T>,
    timeoutMs: number,
    error: () => Error
  ): Promise<T> {
    let remaining = timeoutMs
    let started = performance.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    let rejectTimeout: (error: Error) => void = () => undefined
    const timeout = new Promise<never>((_, reject) => {
      rejectTimeout = reject
    })
    const schedule = (): void => {
      if (timer) {
        remaining -= performance.now() - started
        clearTimeout(timer)
        timer = undefined
      }
      if (!this.hasPending) {
        started = performance.now()
        timer = setTimeout(() => rejectTimeout(error()), Math.max(0, remaining))
      }
    }
    const release = this.subscribe((event) => {
      if (event.type === 'snapshot') schedule()
    })
    schedule()
    try {
      return await Promise.race([operation, timeout])
    } finally {
      if (timer) clearTimeout(timer)
      release()
    }
  }

  private request(
    input: RequestBody,
    options?: ExtensionUIDialogOptions
  ): Promise<string | boolean | undefined> {
    if (!this.active || options?.signal?.aborted) return Promise.resolve(undefined)
    const request = L4PiUiRequestSchema.parse({
      ...input,
      id: randomUUID(),
      expiresAt: options?.timeout === undefined ? null : Date.now() + Math.max(0, options.timeout)
    })
    const state = { ...this.state, requests: [...this.state.requests, request] }
    this.validate(state)
    return new Promise((resolve) => {
      const abort = (): void => this.finish(request.id, undefined)
      const timer =
        request.expiresAt === null
          ? undefined
          : setTimeout(abort, Math.max(0, request.expiresAt - Date.now()))
      options?.signal?.addEventListener('abort', abort, { once: true })
      this.pending.set(request.id, {
        request,
        resolve,
        cleanup: () => {
          if (timer) clearTimeout(timer)
          options?.signal?.removeEventListener('abort', abort)
        }
      })
      this.state = state
      this.publishSnapshot()
    })
  }

  private finish(id: string, value: string | boolean | undefined): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    pending.cleanup()
    this.state = {
      ...this.state,
      requests: this.state.requests.filter((request) => request.id !== id)
    }
    pending.resolve(value)
    // 让当前 Promise 链先推进，连续提问可直接交接而不发布短暂空状态。
    if (this.snapshotImmediate === null) {
      this.snapshotImmediate = setImmediate(() => {
        this.snapshotImmediate = null
        this.publishSnapshot()
      })
    }
  }

  private validate(state: L4PiUiSnapshot): void {
    L4PiUiSnapshotSchema.parse(state)
    if (
      Object.keys(state.statuses).length > 32 ||
      Object.keys(state.widgets).length > 16 ||
      Buffer.byteLength(JSON.stringify(state), 'utf8') > 256 * 1024
    ) {
      throw new Error('插件交互内容过多，请先清理已有状态或缩短内容')
    }
  }

  private replace(state: L4PiUiSnapshot): void {
    this.validate(state)
    this.state = state
    this.publishSnapshot()
  }

  private publishSnapshot(): void {
    if (this.snapshotImmediate !== null) {
      clearImmediate(this.snapshotImmediate)
      this.snapshotImmediate = null
    }
    this.emit({ type: 'snapshot', snapshot: this.snapshot() })
  }

  private emit(event: L4PiUiEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[Pi Desk][NativeUI] 交互推送失败', {
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }
}
