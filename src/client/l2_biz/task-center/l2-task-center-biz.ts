'use client'

import type {
  L2TaskImageGetRequest,
  L2TaskImageGetResponse,
  L2TaskMessageGetRequest,
  L2TaskMessageGetResponse
} from '@common/l2_biz/task-center/l2-task-center-contract'
import {
  L2TaskCenterSocketContracts,
  type L2TaskDetailEventPush,
  type L2TaskDetailWatchRequest,
  type L2TaskDetailWatchResponse,
  type L2TaskInterruptRequest
} from '@common/l2_biz/task-center/l2-task-center-websocket-contract'
import type { L4AppSocketClient } from '@client/l4_foundation/realtime/app-socket/l4-app-socket'
import type { L4ErrorTranslation } from '@common/l4_foundation/locale/l4-error-translation'
import { l4LocalizedErrorMessage } from '@client/l4_foundation/locale/l4-localized-error'

interface L2ApiEnvelope<T> {
  code: number
  msg: string
  data: T | null
  i18n?: L4ErrorTranslation
}

export interface L2TaskCenterBiz {
  watchDetail: (input: L2TaskDetailWatchRequest) => Promise<L2TaskDetailWatchResponse>
  interrupt: (input: L2TaskInterruptRequest) => Promise<void>
  subscribeDetailEvents: (listener: (push: L2TaskDetailEventPush) => void) => () => void
  getMessageDetail: (input: L2TaskMessageGetRequest) => Promise<L2TaskMessageGetResponse>
  getImage: (input: L2TaskImageGetRequest) => Promise<L2TaskImageGetResponse>
}

export function createL2TaskCenterBiz(
  clientId: string,
  appSocket: L4AppSocketClient
): L2TaskCenterBiz {
  async function request<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Pi-Desk-Client-Id': clientId
      },
      body: JSON.stringify(body)
    })
    const envelope = (await response.json()) as L2ApiEnvelope<T>
    if (!response.ok || envelope.code !== 0 || envelope.data === null) {
      throw new Error(envelope.msg ? l4LocalizedErrorMessage(envelope) : '请求失败')
    }
    return envelope.data
  }

  return {
    watchDetail: (input) => appSocket.request(L2TaskCenterSocketContracts.detailWatch, input),
    async interrupt(input): Promise<void> {
      await appSocket.request(L2TaskCenterSocketContracts.interrupt, input)
    },
    subscribeDetailEvents: (listener) =>
      appSocket.subscribe(L2TaskCenterSocketContracts.detailEvent, listener),
    getMessageDetail: (input) =>
      request<L2TaskMessageGetResponse>('/api/task-center/messages/get', input),
    getImage: (input) => request<L2TaskImageGetResponse>('/api/task-center/images/get', input)
  }
}
