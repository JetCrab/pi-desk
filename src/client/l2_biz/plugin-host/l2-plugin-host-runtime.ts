'use client'

import { replaceL4HostSettings } from '@client/l4_foundation/locale/l4-region-store'
import type {
  PiNativeBrowserChannel,
  PiDeskBrowserChannel,
  PluginPushMessage
} from '@jetcrab/pi-desk-sdk/browser'
import { L2ChatSocketContracts } from '@common/l2_biz/chat/l2-chat-websocket-contract'
import { L2PluginSocketContracts } from '@common/l2_biz/plugin/l2-plugin-websocket-contract'
import {
  L2AppBootstrapResponseSchema,
  L2WorkSessionSocketContracts
} from '@common/l2_biz/work-session/l2-work-session-realtime-contract'
import { L3PluginBrowserSocketContracts } from '@common/l3_modules/plugin-host/l3-plugin-browser-contract'
import { L3PluginLogSocketContracts } from '@common/l3_modules/plugin-host/l3-plugin-log-contract'
import { L3PiNativeSocketContracts } from '@common/l3_modules/plugin-host/l3-plugin-native-pi-contract'
import { L3PluginPushSocketContract } from '@common/l3_modules/plugin-host/l3-plugin-push-contract'
import type {
  L4AppSocketPushContract,
  L4AppSocketRequestContract
} from '@common/l4_foundation/realtime/l4-app-websocket-contract'
import {
  createL4PluginHostRuntime,
  type L4PluginHostRuntime,
  type L4PluginHostTransport,
  type L4PluginNotificationSink
} from '@client/l4_foundation/plugin-host/l4-plugin-host-runtime'
import type { L4PluginLogChannel } from '@client/l4_foundation/plugin-host/l4-plugin-log-runtime'
import type {
  L4AppSocketOwner,
  L4BrowserSocketCloseInfo
} from '@client/l4_foundation/realtime/app-socket/l4-app-socket'

export interface L2PluginHostRuntimeOwner {
  appSocket: L4AppSocketOwner
  pluginHost: L4PluginHostRuntime
}

function createTransport(
  owner: L4AppSocketOwner,
  canLoadEntries: () => boolean
): L4PluginHostTransport {
  const pi: PiNativeBrowserChannel = {
    prompt: (source, input) =>
      owner.request(L2ChatSocketContracts.send, {
        source,
        mode: input.mode,
        text: input.text,
        images: (input.images ?? []).map((image) => ({ ...image }))
      }),
    commands: {
      list: async (source) =>
        (await owner.request(L3PiNativeSocketContracts.commandsList, { source })).commands
          .filter((command) => command.source === 'extension')
          .map(({ name, description }) => ({ name, description })),
      execute: async (source, command, args): Promise<void> => {
        await owner.request(L3PiNativeSocketContracts.commandExecute, {
          source,
          command,
          ...(args === undefined ? {} : { args })
        })
      }
    },
    tools: {
      list: async (source) =>
        (await owner.request(L3PiNativeSocketContracts.toolsList, { source })).tools
    },
    bash: {
      execute: (source, input) =>
        owner.request(L3PiNativeSocketContracts.bashExecute, {
          source,
          command: input.command,
          excludeFromContext: input.excludeFromContext
        }),
      abort: async (source): Promise<void> => {
        await owner.request(L3PiNativeSocketContracts.bashAbort, { source })
      }
    },
    interrupt: async (source): Promise<void> => {
      await owner.request(L2ChatSocketContracts.interrupt, { source })
    }
  }

  return {
    pi,
    listBrowserEntries: async () => {
      if (!canLoadEntries()) return []
      const { entries } = await owner.request(L3PluginBrowserSocketContracts.list, {})
      return canLoadEntries() ? entries : []
    },
    subscribePush: (listener: (message: PluginPushMessage) => void) =>
      owner.subscribe(L3PluginPushSocketContract, listener),
    createPiDeskChannel(pluginName: string): PiDeskBrowserChannel {
      return {
        invokeGlobal: (method, input) =>
          owner.request(L2PluginSocketContracts.invoke, {
            pluginName,
            method,
            scope: 'global',
            input
          }),
        invokeSession: (source, method, input) =>
          owner.request(L2PluginSocketContracts.invoke, {
            pluginName,
            method,
            scope: 'session',
            source,
            input
          })
      }
    },
    createLogChannel(pluginName: string): L4PluginLogChannel {
      return {
        watch: async (path) =>
          (
            await owner.request(L3PluginLogSocketContracts.watch, {
              pluginName,
              path
            })
          ).snapshot,
        unwatch: async (path): Promise<void> => {
          await owner.request(L3PluginLogSocketContracts.unwatch, {
            pluginName,
            path
          })
        },
        subscribe: (listener) =>
          owner.subscribe(L3PluginLogSocketContracts.event, (message) => {
            if (message.pluginName !== pluginName) return
            listener({ path: message.path, event: message.event })
          })
      }
    }
  }
}

function createPluginAwareSocket(
  owner: L4AppSocketOwner,
  pluginHost: L4PluginHostRuntime,
  setServiceMode: (mode: 'normal' | 'basic') => void
): L4AppSocketOwner {
  return {
    async connect(signal): Promise<boolean> {
      pluginHost.markConnecting()
      try {
        return await owner.connect(signal)
      } catch (cause) {
        pluginHost.markDisconnected(cause instanceof Error ? cause.message : 'WebSocket 连接失败')
        throw cause
      }
    },

    async request<TInput, TOutput>(
      contract: L4AppSocketRequestContract<TInput, TOutput>,
      input: TInput
    ): Promise<TOutput> {
      const output = await owner.request(contract, input)
      if (contract.path !== L2WorkSessionSocketContracts.list.path) return output

      const snapshot = L2AppBootstrapResponseSchema.parse(output)
      setServiceMode(snapshot.appRuntime.mode)
      replaceL4HostSettings(snapshot.appRuntime.settings)
      pluginHost.replaceGlobalPluginStates(snapshot.appRuntime.plugins)
      pluginHost.replaceWorkSessions(snapshot.workSessions)
      pluginHost.markReady()
      void pluginHost.refreshEntries().catch((error: unknown) => {
        console.error('[Pi Desk][PluginHost] 初始化 Browser Entry 失败', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
          message: error instanceof Error ? error.message : String(error)
        })
      })
      return output
    },

    subscribe<TBody>(
      contract: L4AppSocketPushContract<TBody>,
      listener: (data: TBody) => void
    ): () => void {
      return owner.subscribe(contract, listener)
    },

    async waitForClose(): Promise<L4BrowserSocketCloseInfo> {
      const info = await owner.waitForClose()
      pluginHost.markDisconnected(info.reason || null)
      return info
    },

    close(): void {
      owner.close()
    }
  }
}

export function createL2PluginHostRuntime(
  owner: L4AppSocketOwner,
  notifyPlugin?: L4PluginNotificationSink
): L2PluginHostRuntimeOwner {
  const bypassEntries =
    typeof window !== 'undefined' &&
    new URL(window.location.href).searchParams.get('plugins') === 'off'
  let serviceMode: 'normal' | 'basic' = 'normal'
  const pluginHost = createL4PluginHostRuntime(
    createTransport(owner, () => !bypassEntries && serviceMode === 'normal'),
    undefined,
    notifyPlugin
  )
  return {
    appSocket: createPluginAwareSocket(owner, pluginHost, (mode) => {
      serviceMode = mode
    }),
    pluginHost
  }
}
