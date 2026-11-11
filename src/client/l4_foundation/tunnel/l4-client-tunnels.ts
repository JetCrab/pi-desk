'use client'

import { z } from 'zod'
import { createL4BrowserUuid } from '@client/l4_foundation/lib/l4-browser-uuid'
import type {
  BrowserTunnelHandle,
  BrowserTunnelHost,
  BrowserTunnelSnapshot
} from '@jetcrab/pi-desk-sdk/browser'
import {
  L4TunnelPortSchema,
  L4TunnelPublicationSchema,
  type L4TunnelPublication
} from '@common/l4_foundation/tunnel/l4-client-tunnel-contract'

const SnapshotSchema = z
  .object({
    status: z.enum(['connecting', 'ready', 'recovering', 'failed', 'closed']),
    localPort: L4TunnelPortSchema.nullable(),
    path: z.enum(['direct', 'relay', 'unknown']).nullable(),
    error: z.string().nullable()
  })
  .strict()
const StatusSchema = z.object({ ready: z.boolean(), error: z.string().nullable() }).strict()

export type L4NativeTunnelRequest =
  | { action: 'status' }
  | ({ action: 'open'; id: string } & L4TunnelPublication)
  | { action: 'get' | 'close'; id: string }

export interface L4NativeTunnelBridge {
  invoke(request: L4NativeTunnelRequest): Promise<unknown>
}

declare global {
  interface Window {
    readonly __PI_DESK_TUNNELS__?: L4NativeTunnelBridge
  }
}

interface Environment {
  hostname: string
  bridge: L4NativeTunnelBridge | undefined
}

function readEnvironment(): Environment {
  return typeof window === 'undefined'
    ? { hostname: '', bridge: undefined }
    : { hostname: window.location.hostname, bridge: window.__PI_DESK_TUNNELS__ }
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return (
    host === 'localhost' ||
    host === '[::1]' ||
    host === '::1' ||
    /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host)
  )
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export class L4ClientTunnelHostRuntime implements BrowserTunnelHost {
  private readonly handles = new Set<Mapping>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(
    private readonly resolve: (remotePort: number) => Promise<L4TunnelPublication>,
    private readonly environment: () => Environment = readEnvironment
  ) {}

  available(): boolean {
    const environment = this.environment()
    return !this.disposed && (isLoopback(environment.hostname) || Boolean(environment.bridge))
  }

  open(input: { remotePort: number }): BrowserTunnelHandle {
    if (this.disposed) throw new Error('插件隧道能力已释放')
    const port = L4TunnelPortSchema.parse(input.remotePort)
    if (this.handles.size >= 64) throw new Error('当前插件的本地映射数量已达上限')
    const environment = this.environment()
    const mapping = new Mapping(
      port,
      isLoopback(environment.hostname),
      environment.bridge,
      this.resolve,
      () => {
        this.handles.delete(mapping)
        if (!this.handles.size) {
          clearTimeout(this.timer)
          this.timer = undefined
        }
      }
    )
    this.handles.add(mapping)
    mapping.start()
    this.schedule()
    return mapping
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    clearTimeout(this.timer)
    this.timer = undefined
    await Promise.all([...this.handles].map((handle) => handle.close()))
  }

  private schedule(): void {
    if (this.disposed || this.timer || ![...this.handles].some((handle) => handle.needsPoll()))
      return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void Promise.all([...this.handles].map((handle) => handle.poll())).finally(() =>
        this.schedule()
      )
    }, 1_000)
  }
}

class Mapping implements BrowserTunnelHandle {
  private snapshot: BrowserTunnelSnapshot
  private readonly listeners = new Set<() => void>()
  private readonly id = createL4BrowserUuid()
  private closed = false
  private nativeStarted = false
  private nativeReady = false
  private initializing: Promise<void> = Promise.resolve()
  private closing: Promise<void> | null = null
  private nativeClosing: Promise<void> | null = null

  constructor(
    private readonly remotePort: number,
    private readonly local: boolean,
    private readonly bridge: L4NativeTunnelBridge | undefined,
    private readonly resolve: (port: number) => Promise<L4TunnelPublication>,
    private readonly release: () => void
  ) {
    this.snapshot = Object.freeze({
      status: local ? 'ready' : 'connecting',
      localPort: local ? remotePort : null,
      path: local ? null : 'unknown',
      error: null
    })
  }

  start(): void {
    if (!this.local) this.initializing = this.initialize()
  }

  getSnapshot(): BrowserTunnelSnapshot {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    if (!this.closed) this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  needsPoll(): boolean {
    return (
      !this.local &&
      !this.closed &&
      this.snapshot.status !== 'failed' &&
      this.snapshot.status !== 'closed'
    )
  }

  async poll(): Promise<void> {
    if (!this.needsPoll() || !this.nativeReady) return
    try {
      const next = SnapshotSchema.parse(await this.bridge!.invoke({ action: 'get', id: this.id }))
      if (this.closed) return
      this.update(next)
      if (next.status === 'failed' || next.status === 'closed') await this.closeNative()
    } catch (cause) {
      this.fail(cause)
      await this.closeNative().catch((error: unknown) => this.logCleanup(error))
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.update({ status: 'closed', localPort: null, path: null, error: null })
    this.listeners.clear()
    this.release()
    this.closing = this.initializing.then(() => this.closeNative())
    return this.closing
  }

  private async initialize(): Promise<void> {
    try {
      if (!this.bridge) throw new Error('当前浏览器不支持客户端 TCP 映射')
      const status = StatusSchema.parse(await this.bridge.invoke({ action: 'status' }))
      if (this.closed) return
      if (!status.ready) throw new Error(status.error ?? '当前客户端隧道尚未配置')
      const target = L4TunnelPublicationSchema.parse(await this.resolve(this.remotePort))
      if (this.closed) return
      if (target.remotePort !== this.remotePort) throw new Error('后端发布端口与请求不一致')
      // 先记住操作归属；请求超时也要关闭可能已创建的原生资源，不自动重发 open。
      this.nativeStarted = true
      const next = SnapshotSchema.parse(
        await this.bridge.invoke({ action: 'open', id: this.id, ...target })
      )
      this.nativeReady = true
      if (!this.closed) this.update(next)
    } catch (cause) {
      this.fail(cause)
    } finally {
      if (this.closed || this.snapshot.status === 'failed') {
        await this.closeNative().catch((cause: unknown) => this.logCleanup(cause))
      }
    }
  }

  private closeNative(): Promise<void> {
    if (!this.nativeStarted) return Promise.resolve()
    if (!this.nativeClosing) {
      this.nativeClosing = this.bridge!.invoke({ action: 'close', id: this.id }).then(
        () => undefined
      )
    }
    return this.nativeClosing
  }

  private fail(cause: unknown): void {
    if (this.closed) return
    this.update({ status: 'failed', localPort: null, path: null, error: message(cause) })
    console.warn('[Pi Desk][ClientTunnel] 本地端口映射失败', {
      remotePort: this.remotePort,
      message: message(cause)
    })
  }

  private update(snapshot: BrowserTunnelSnapshot): void {
    if (JSON.stringify(this.snapshot) === JSON.stringify(snapshot)) return
    this.snapshot = Object.freeze({ ...snapshot })
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (cause) {
        console.error('[Pi Desk][ClientTunnel] 连接状态订阅失败', cause)
      }
    }
  }

  private logCleanup(cause: unknown): void {
    console.error('[Pi Desk][ClientTunnel] 本地映射释放失败', {
      remotePort: this.remotePort,
      message: message(cause)
    })
  }
}
