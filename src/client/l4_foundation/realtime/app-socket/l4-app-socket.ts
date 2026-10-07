'use client'

import type {
  L4AppSocketPushContract,
  L4AppSocketRequestContract
} from '@common/l4_foundation/realtime/l4-app-websocket-contract'
import { L4_APP_SOCKET_REPLACED_CLOSE_CODE } from '@common/l4_foundation/realtime/l4-app-websocket-contract'
import {
  L4BrowserSocketConnection,
  type L4BrowserSocketCloseInfo
} from './runtime/l4-browser-socket-connection'

type PushListener = (body: unknown) => void

interface PushChannel {
  readonly contract: L4AppSocketPushContract<unknown>
  readonly listeners: Set<PushListener>
}

export interface L4AppSocketClient {
  connect: (signal: AbortSignal) => Promise<boolean>
  request: <TInput, TOutput>(
    contract: L4AppSocketRequestContract<TInput, TOutput>,
    input: TInput
  ) => Promise<TOutput>
  subscribe: <TBody>(
    contract: L4AppSocketPushContract<TBody>,
    listener: (data: TBody) => void
  ) => () => void
  waitForClose: () => Promise<L4BrowserSocketCloseInfo>
}

export interface L4AppSocketOwner extends L4AppSocketClient {
  close: () => void
}

export type { L4BrowserSocketCloseInfo }
export {
  L4AppSocketContext,
  useL4AppSocket,
  type L4AppSocketContextValue
} from './l4-app-socket-context'

export function isL4AppSocketReplaced(info: L4BrowserSocketCloseInfo): boolean {
  return info.code === L4_APP_SOCKET_REPLACED_CLOSE_CODE
}

export function createL4AppSocketClient(clientId: string): L4AppSocketOwner {
  const pushChannels = new Map<string, PushChannel>()
  let currentConnection: L4BrowserSocketConnection | null = null
  let currentClosePromise: Promise<L4BrowserSocketCloseInfo> = Promise.resolve({
    code: 1000,
    reason: ''
  })
  let connectPromise: Promise<boolean> | null = null

  const dispatchPush = (path: string, body: unknown): void => {
    const channel = pushChannels.get(path)
    if (!channel) return

    const parsed = channel.contract.bodySchema.parse(body)
    for (const listener of [...channel.listeners]) {
      try {
        listener(parsed)
      } catch (error) {
        console.error('[Pi Desk][AppSocketClient] 推送监听器执行失败', {
          path,
          errorName: error instanceof Error ? error.name : 'UnknownError'
        })
      }
    }
  }

  return {
    connect(signal): Promise<boolean> {
      if (currentConnection?.isOpen()) return Promise.resolve(false)
      if (connectPromise) return connectPromise

      connectPromise = (async () => {
        const previous = currentConnection
        if (previous) {
          await previous.waitForClose()
          if (currentConnection === previous) currentConnection = null
        }
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')

        const next = new L4BrowserSocketConnection(clientId, dispatchPush)
        currentConnection = next
        currentClosePromise = next.waitForClose()
        void currentClosePromise.then(() => {
          if (currentConnection === next) currentConnection = null
        })

        try {
          await next.open(signal)
        } catch (error) {
          next.close()
          await next.waitForClose()
          if (currentConnection === next) currentConnection = null
          throw error
        }
        return true
      })().finally(() => {
        connectPromise = null
      })

      return connectPromise
    },

    request<TInput, TOutput>(
      contract: L4AppSocketRequestContract<TInput, TOutput>,
      input: TInput
    ): Promise<TOutput> {
      const connection = currentConnection
      if (!connection) return Promise.reject(new Error('WebSocket 尚未连接'))
      return connection.request(contract, input)
    },

    subscribe<TBody>(
      contract: L4AppSocketPushContract<TBody>,
      listener: (data: TBody) => void
    ): () => void {
      const existing = pushChannels.get(contract.path)
      if (existing && existing.contract !== contract) {
        throw new Error(`WebSocket push path 使用了不同合同：${contract.path}`)
      }

      const channel =
        existing ??
        ({
          contract: contract as L4AppSocketPushContract<unknown>,
          listeners: new Set<PushListener>()
        } satisfies PushChannel)
      const wrapped: PushListener = (body) => listener(body as TBody)
      channel.listeners.add(wrapped)
      pushChannels.set(contract.path, channel)

      return () => {
        channel.listeners.delete(wrapped)
        if (channel.listeners.size === 0) pushChannels.delete(contract.path)
      }
    },

    waitForClose(): Promise<L4BrowserSocketCloseInfo> {
      return currentClosePromise
    },

    close(): void {
      currentConnection?.close()
    }
  }
}
