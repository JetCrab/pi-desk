import 'server-only'

import type { ExtensionRuntime } from '@earendil-works/pi-coding-agent'

interface L4PiDeferredSessionMessage {
  source: string
  dispatch: () => void | Promise<void>
}

export class L4PiSessionMessageGate {
  private readonly deferred: L4PiDeferredSessionMessage[] = []
  private restoreExtensionRuntime: (() => void) | null = null
  private draining: Promise<void> | null = null
  private paused = false
  private disposed = false

  constructor(
    private readonly onDispatchError: (source: string, error: unknown) => void = () => undefined
  ) {}

  get isBlocking(): boolean {
    return this.paused || this.draining !== null || this.deferred.length > 0
  }

  pause(): void {
    if (this.disposed) return
    this.paused = true
  }

  defer(source: string, dispatch: () => void | Promise<void>): boolean {
    if (!this.isBlocking || this.disposed) return false
    this.deferred.push({ source, dispatch })
    return true
  }

  resume(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.paused = false
    if (this.draining) return this.draining

    const draining = this.drain().finally(() => {
      if (this.draining === draining) this.draining = null
      if (!this.paused && this.deferred.length > 0) void this.resume()
    })
    this.draining = draining
    return draining
  }

  installExtensionRuntime(runtime: ExtensionRuntime): void {
    if (this.disposed) return
    this.restoreExtensionRuntime?.()

    const sendMessage = runtime.sendMessage
    const sendUserMessage = runtime.sendUserMessage
    const wrappedSendMessage: ExtensionRuntime['sendMessage'] = (message, options): void => {
      if (this.defer('extension-message', () => sendMessage(message, options))) return
      sendMessage(message, options)
    }
    const wrappedSendUserMessage: ExtensionRuntime['sendUserMessage'] = (
      content,
      options
    ): void => {
      if (this.defer('extension-user-message', () => sendUserMessage(content, options))) return
      sendUserMessage(content, options)
    }

    runtime.sendMessage = wrappedSendMessage
    runtime.sendUserMessage = wrappedSendUserMessage
    this.restoreExtensionRuntime = (): void => {
      if (runtime.sendMessage === wrappedSendMessage) runtime.sendMessage = sendMessage
      if (runtime.sendUserMessage === wrappedSendUserMessage) {
        runtime.sendUserMessage = sendUserMessage
      }
    }
  }

  discardPending(): void {
    this.deferred.length = 0
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.paused = true
    this.deferred.length = 0
    this.restoreExtensionRuntime?.()
    this.restoreExtensionRuntime = null
  }

  private async drain(): Promise<void> {
    while (!this.paused && !this.disposed) {
      const message = this.deferred.shift()
      if (!message) return
      try {
        await message.dispatch()
      } catch (error) {
        this.onDispatchError(message.source, error)
      }
    }
  }
}
