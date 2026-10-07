import { L2SystemStatusSchema } from '@common/l2_biz/system/l2-system-contract'
import type {
  L2ChatModelContextGetRequest,
  L2ChatModelContextGetResponse
} from '@common/l2_biz/chat/l2-chat-context-contract'
import type {
  L2ChatImageGetRequest,
  L2ChatImageGetResponse,
  L2ChatMessageDetailRequest,
  L2ChatMessageDetailResponse
} from '@common/l2_biz/chat/l2-chat-contract'
import {
  L2ChatSocketContracts,
  type L2ChatModelSetRequest,
  type L2ChatCapabilityModeSetRequest,
  type L2ChatQueueRestoreResponse,
  type L2ChatSendRequest,
  type L2ChatSendResponse
} from '@common/l2_biz/chat/l2-chat-websocket-contract'
import {
  L2PluginSocketContracts,
  type L2PluginInvokeRequest,
  type L2PluginInvokeResponse
} from '@common/l2_biz/plugin/l2-plugin-websocket-contract'
import type {
  L2PiModelsListRequest,
  L2PiModelsListResponse
} from '@common/l2_biz/pi-model/l2-pi-model-contract'
import type {
  L2PiDirectoryEntryListResponse,
  L2PiDirectoryIgnoreListResponse,
  L2PiDirectoryIgnoreReplaceRequest,
  L2PiDirectoryListResponse,
  L2PiSessionHistoryQuery,
  L2PiSessionHistoryResponse,
  L2PiSessionUserMessageListRequest,
  L2PiSessionUserMessageListResponse
} from '@common/l2_biz/pi-session/l2-pi-session-contract'
import type {
  L2CreateWorkSessionRequest,
  L2CreateWorkSessionResponse,
  L2ReplaceWorkSessionRequest,
  L2SortWorkSessionsRequest,
  L2WorkSessionListResponse
} from '@common/l2_biz/work-session/l2-work-session-contract'
import type {
  L2WorkSessionBranchRequest,
  L2WorkSessionBranchResponse,
  L2WorkSessionTreeEntryGetRequest,
  L2WorkSessionTreeEntryGetResponse,
  L2WorkSessionTreeGetRequest,
  L2WorkSessionTreeGetResponse
} from '@common/l2_biz/work-session/l2-work-session-tree-contract'
import {
  L2WorkSessionSocketContracts,
  type L2AppBootstrapResponse,
  type L2WorkSessionsUpdate
} from '@common/l2_biz/work-session/l2-work-session-realtime-contract'
import type {
  L3AppRuntimeApplyRequest,
  L3AppRuntimeEvent
} from '@common/l3_modules/app-runtime/l3-app-runtime-contract'
import {
  L3PiNativeSocketContracts,
  type L3PiNativeCommandsListRequest,
  type L3PiNativeCommandsListResponse,
  type L3PiNativeToolsListRequest,
  type L3PiNativeToolsListResponse
} from '@common/l3_modules/plugin-host/l3-plugin-native-pi-contract'
import { L3AppRuntimeSocketContracts } from '@common/l3_modules/app-runtime/l3-app-runtime-websocket-contract'
import type {
  L4AppSocketClient,
  L4BrowserSocketCloseInfo
} from '@client/l4_foundation/realtime/app-socket/l4-app-socket'
import { L4_APP_SOCKET_AUTH_CHANGED_CLOSE_CODE } from '@common/l4_foundation/realtime/l4-app-websocket-contract'
import type { L4ErrorTranslation } from '@common/l4_foundation/locale/l4-error-translation'
import { l4LocalizedErrorMessage } from '@client/l4_foundation/locale/l4-localized-error'
import {
  saveL4PiDirectoriesCache,
  saveL4PiDirectoryEntriesCache,
  saveL4PiIgnoredDirectoriesCache
} from '@client/l4_foundation/storage/l4-pi-directory-cache'

interface L2ApiEnvelope<T> {
  code: number
  msg: string
  data: T | null
  i18n?: L4ErrorTranslation
}

export interface L2WorkbenchBiz {
  readServerVersion: (signal: AbortSignal) => Promise<string | null>
  getChatMessageDetail: (input: L2ChatMessageDetailRequest) => Promise<L2ChatMessageDetailResponse>
  getChatModelContext: (
    input: L2ChatModelContextGetRequest
  ) => Promise<L2ChatModelContextGetResponse>
  getChatImage: (input: L2ChatImageGetRequest) => Promise<L2ChatImageGetResponse>
  listModels: (input: L2PiModelsListRequest) => Promise<L2PiModelsListResponse>
  listPiCommands: (input: L3PiNativeCommandsListRequest) => Promise<L3PiNativeCommandsListResponse>
  listPiTools: (input: L3PiNativeToolsListRequest) => Promise<L3PiNativeToolsListResponse>
  sendChat: (input: L2ChatSendRequest) => Promise<L2ChatSendResponse>
  interruptChat: (input: { source: L2ChatSendRequest['source'] }) => Promise<void>
  restoreChatQueue: (input: {
    source: L2ChatSendRequest['source']
  }) => Promise<L2ChatQueueRestoreResponse>
  setChatModel: (input: L2ChatModelSetRequest) => Promise<void>
  setChatCapabilityMode: (input: L2ChatCapabilityModeSetRequest) => Promise<void>
  invokePluginMethod: (input: L2PluginInvokeRequest) => Promise<L2PluginInvokeResponse>
  listWorkSessions: () => Promise<L2AppBootstrapResponse>
  applyAppRuntimeUpdate: (input: L3AppRuntimeApplyRequest) => Promise<void>
  sortWorkSessions: (input: L2SortWorkSessionsRequest) => Promise<L2WorkSessionListResponse>
  deleteWorkSession: (workId: string) => Promise<L2WorkSessionListResponse>
  listDirectories: (forceRefresh: boolean) => Promise<L2PiDirectoryListResponse>
  listIgnoredDirectories: (forceRefresh: boolean) => Promise<L2PiDirectoryIgnoreListResponse>
  replaceDirectoryIgnore: (input: L2PiDirectoryIgnoreReplaceRequest) => Promise<void>
  listDirectoryEntries: (cwd: string | null) => Promise<L2PiDirectoryEntryListResponse>
  listSessionHistory: (
    input: L2PiSessionHistoryQuery,
    signal?: AbortSignal
  ) => Promise<L2PiSessionHistoryResponse>
  listSessionUserMessages: (
    input: L2PiSessionUserMessageListRequest,
    signal?: AbortSignal
  ) => Promise<L2PiSessionUserMessageListResponse>
  createWorkSession: (input: L2CreateWorkSessionRequest) => Promise<L2CreateWorkSessionResponse>
  replaceWorkSession: (input: L2ReplaceWorkSessionRequest) => Promise<L2WorkSessionListResponse>
  getWorkSessionTree: (
    input: L2WorkSessionTreeGetRequest,
    signal?: AbortSignal
  ) => Promise<L2WorkSessionTreeGetResponse>
  getWorkSessionTreeEntry: (
    input: L2WorkSessionTreeEntryGetRequest,
    signal?: AbortSignal
  ) => Promise<L2WorkSessionTreeEntryGetResponse>
  branchWorkSession: (input: L2WorkSessionBranchRequest) => Promise<L2WorkSessionBranchResponse>
  acknowledgeCompleted: (workId: string) => Promise<void>
  readWorkSessionUpdates: (
    signal: AbortSignal,
    onSnapshot: (
      snapshot: L2AppBootstrapResponse,
      openedNewConnection: boolean
    ) => void | Promise<void>,
    onWorkSessionUpdate: (update: L2WorkSessionsUpdate) => void,
    onAppRuntimeUpdate: (event: L3AppRuntimeEvent) => void
  ) => Promise<L4BrowserSocketCloseInfo>
}

export function createL2WorkbenchBiz(
  clientId: string,
  appSocket: L4AppSocketClient
): L2WorkbenchBiz {
  async function request<T>(
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    method: 'GET' | 'POST' = 'POST'
  ): Promise<T> {
    const response = await fetch(path, {
      method,
      ...(method === 'GET' ? { cache: 'no-store' as const } : {}),
      headers: {
        'Content-Type': 'application/json',
        'X-Pi-Desk-Client-Id': clientId
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {})
    })
    const envelope = (await response.json()) as L2ApiEnvelope<T>
    if (!response.ok || envelope.code !== 0 || envelope.data === null) {
      throw new Error(envelope.msg ? l4LocalizedErrorMessage(envelope) : '请求失败')
    }
    return envelope.data
  }

  return {
    async readServerVersion(signal): Promise<string | null> {
      const status = await request<unknown>('/api/health', undefined, signal, 'GET')
      return L2SystemStatusSchema.parse(status).version
    },
    getChatMessageDetail: (input) =>
      request<L2ChatMessageDetailResponse>('/api/chat/messages/get', input),
    getChatModelContext: (input) =>
      request<L2ChatModelContextGetResponse>('/api/chat/context/get', input),
    getChatImage: (input) => request<L2ChatImageGetResponse>('/api/chat/images/get', input),
    listModels: (input) => request<L2PiModelsListResponse>('/api/pi/models/list', input),
    listPiCommands: (input) => appSocket.request(L3PiNativeSocketContracts.commandsList, input),
    listPiTools: (input) => appSocket.request(L3PiNativeSocketContracts.toolsList, input),
    sendChat: (input) => appSocket.request(L2ChatSocketContracts.send, input),
    async interruptChat(input): Promise<void> {
      await appSocket.request(L2ChatSocketContracts.interrupt, input)
    },
    restoreChatQueue: (input) => appSocket.request(L2ChatSocketContracts.queueRestore, input),
    async setChatModel(input): Promise<void> {
      await appSocket.request(L2ChatSocketContracts.modelSet, input)
    },
    async setChatCapabilityMode(input): Promise<void> {
      await appSocket.request(L2ChatSocketContracts.capabilityModeSet, input)
    },
    invokePluginMethod: (input) => appSocket.request(L2PluginSocketContracts.invoke, input),
    listWorkSessions: () => appSocket.request(L2WorkSessionSocketContracts.list, {}),
    async applyAppRuntimeUpdate(input): Promise<void> {
      await appSocket.request(L3AppRuntimeSocketContracts.apply, input)
    },
    sortWorkSessions: (input) =>
      request<L2WorkSessionListResponse>('/api/work-sessions/sort', input),
    deleteWorkSession: (workId) =>
      request<L2WorkSessionListResponse>('/api/work-sessions/del', { workId }),
    async listDirectories(forceRefresh): Promise<L2PiDirectoryListResponse> {
      const response = await request<L2PiDirectoryListResponse>('/api/pi/directories/list', {
        forceRefresh
      })
      saveL4PiDirectoriesCache(response)
      return response
    },
    async listIgnoredDirectories(forceRefresh): Promise<L2PiDirectoryIgnoreListResponse> {
      const response = await request<L2PiDirectoryIgnoreListResponse>(
        '/api/pi/directory-ignores/list',
        { forceRefresh }
      )
      saveL4PiIgnoredDirectoriesCache(response)
      return response
    },
    async replaceDirectoryIgnore(input): Promise<void> {
      await request<Record<string, never>>('/api/pi/directory-ignores/replace', input)
    },
    async listDirectoryEntries(cwd): Promise<L2PiDirectoryEntryListResponse> {
      const response = await request<L2PiDirectoryEntryListResponse>(
        '/api/pi/directory-entries/list',
        { cwd }
      )
      saveL4PiDirectoryEntriesCache(response)
      return response
    },
    listSessionHistory: (input, signal) =>
      request<L2PiSessionHistoryResponse>('/api/pi/sessions/list', input, signal),
    listSessionUserMessages: (input, signal) =>
      request<L2PiSessionUserMessageListResponse>(
        '/api/pi/session-user-messages/list',
        input,
        signal
      ),
    createWorkSession: (input) =>
      request<L2CreateWorkSessionResponse>('/api/work-sessions/add', input),
    replaceWorkSession: (input) =>
      request<L2WorkSessionListResponse>('/api/work-sessions/replace', input),
    getWorkSessionTree: (input, signal) =>
      request<L2WorkSessionTreeGetResponse>('/api/work-session-tree/get', input, signal),
    getWorkSessionTreeEntry: (input, signal) =>
      request<L2WorkSessionTreeEntryGetResponse>('/api/work-session-tree-entry/get', input, signal),
    branchWorkSession: (input) =>
      request<L2WorkSessionBranchResponse>('/api/work-sessions/branch', input),
    async acknowledgeCompleted(workId): Promise<void> {
      await appSocket.request(L2WorkSessionSocketContracts.acknowledgeCompleted, { workId })
    },
    async readWorkSessionUpdates(
      signal,
      onSnapshot,
      onWorkSessionUpdate,
      onAppRuntimeUpdate
    ): Promise<L4BrowserSocketCloseInfo> {
      const unsubscribeWorkSessions = appSocket.subscribe(
        L2WorkSessionSocketContracts.update,
        onWorkSessionUpdate
      )
      const unsubscribeAppRuntime = appSocket.subscribe(
        L3AppRuntimeSocketContracts.update,
        onAppRuntimeUpdate
      )
      let removeAbortListener = (): void => undefined
      const aborted = new Promise<L4BrowserSocketCloseInfo>((resolve) => {
        const handleAbort = (): void => resolve({ code: 1000, reason: '页面业务已卸载' })
        signal.addEventListener('abort', handleAbort, { once: true })
        removeAbortListener = () => signal.removeEventListener('abort', handleAbort)
      })

      try {
        const openedNewConnection = await appSocket.connect(signal)
        if (signal.aborted) return await aborted
        const snapshot = await appSocket.request(L2WorkSessionSocketContracts.list, {})
        if (signal.aborted) return await aborted
        await onSnapshot(snapshot, openedNewConnection)
        const closed = await Promise.race([appSocket.waitForClose(), aborted])
        if (!signal.aborted && closed.code === L4_APP_SOCKET_AUTH_CHANGED_CLOSE_CODE) {
          window.location.replace('/login')
        }
        return closed
      } catch (error) {
        if (!signal.aborted) {
          // 浏览器不暴露 WebSocket 握手的 HTTP 状态，使用既有设置接口确认认证状态。
          const response = await fetch('/api/auth-settings/get', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': clientId },
            body: '{}',
            signal
          }).catch(() => null)
          if (response?.status === 401) window.location.replace('/login')
        }
        throw error
      } finally {
        removeAbortListener()
        unsubscribeAppRuntime()
        unsubscribeWorkSessions()
      }
    }
  }
}
