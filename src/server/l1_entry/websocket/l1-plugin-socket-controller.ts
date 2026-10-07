import 'server-only'

import { L2PluginManagementChangedContract } from '@common/l2_biz/plugin/l2-plugin-management-contract'
import { getL2PluginManagement } from '@server/l2_biz/plugin-management/l2-plugin-management'
import { L2PluginSocketContracts } from '@common/l2_biz/plugin/l2-plugin-websocket-contract'
import { L3PluginBrowserSocketContracts } from '@common/l3_modules/plugin-host/l3-plugin-browser-contract'
import { L3PiNativeSocketContracts } from '@common/l3_modules/plugin-host/l3-plugin-native-pi-contract'
import type { L4AppSocketRequest } from '@common/l4_foundation/realtime/l4-app-websocket-contract'
import { isPluginMethodError } from '@jetcrab/pi-desk-sdk'
import type { WorkSessionManage } from '@server/l2_biz/work-session/l2-work-session-manage'
import {
  L2ChatLifecycleBlockedError,
  L2ChatSourceBindingError
} from '@server/l2_biz/work-session/l2-work-session-chat-runtime'
import {
  L4PiDirectBashRunningError,
  L4PiNativeCommandNotFoundError
} from '@server/l4_foundation/pi/l4-pi-chat-worker'
import { getL4PiPluginBrowserResourceRegistry } from '@server/l4_foundation/pi/l4-pi-plugin-browser-resource'
import { getL4PiGlobalPluginRuntime } from '@server/l4_foundation/pi/l4-pi-global-plugin-runtime'
import {
  L4PiPluginMethodNotFoundError,
  L4PiPluginMethodPayloadTooLargeError
} from '@server/l4_foundation/pi/l4-pi-plugin-method-runtime'
import { L4PiPluginRuntimeBusyError } from '@server/l4_foundation/pi/l4-pi-plugin-owner-runtime'
import type { L4AppSocketConnection } from '@server/l4_foundation/realtime/app-socket/l4-app-socket'
import type { L1AppSocketRoute } from './l1-app-socket-route'

export class L1PluginSocketController {
  readonly routes: readonly L1AppSocketRoute[]
  private readonly unsubscribeManagement: () => void
  private disposed = false

  constructor(
    private readonly connection: L4AppSocketConnection,
    private readonly manage: WorkSessionManage,
    isReady: () => boolean
  ) {
    this.unsubscribeManagement = getL2PluginManagement().subscribe(() => {
      if (!this.disposed && isReady() && this.connection.isCurrent()) {
        this.connection.sendPush(L2PluginManagementChangedContract, {})
      }
    })
    this.routes = Object.freeze([
      {
        path: L2PluginSocketContracts.invoke.path,
        access: 'ready',
        handle: (request) => this.invoke(request)
      },
      {
        path: L3PluginBrowserSocketContracts.list.path,
        access: 'ready',
        handle: (request) => this.listBrowserEntries(request)
      },
      {
        path: L3PiNativeSocketContracts.commandsList.path,
        access: 'ready',
        handle: (request) => this.listCommands(request)
      },
      {
        path: L3PiNativeSocketContracts.commandExecute.path,
        access: 'ready',
        handle: (request) => this.executeCommand(request)
      },
      {
        path: L3PiNativeSocketContracts.toolsList.path,
        access: 'ready',
        handle: (request) => this.listTools(request)
      },
      {
        path: L3PiNativeSocketContracts.bashExecute.path,
        access: 'ready',
        handle: (request) => this.executeBash(request)
      },
      {
        path: L3PiNativeSocketContracts.bashAbort.path,
        access: 'ready',
        handle: (request) => this.abortBash(request)
      }
    ])
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeManagement()
  }

  private async invoke(request: L4AppSocketRequest): Promise<void> {
    const contract = L2PluginSocketContracts.invoke
    const input = contract.inputSchema.safeParse(request.body)
    if (!input.success) {
      this.connection.sendError(contract.path, request.head.requestId, 400, '插件调用参数无效')
      return
    }

    try {
      const output =
        input.data.scope === 'global'
          ? await getL4PiGlobalPluginRuntime().invoke(
              input.data.pluginName,
              input.data.method,
              input.data.input
            )
          : await this.manage.invokeSessionPluginMethod(input.data)
      this.connection.sendSuccess(contract, request.head.requestId, output)
    } catch (error) {
      this.sendInvokeError(
        contract.path,
        request.head.requestId,
        error,
        input.data.pluginName,
        input.data.method
      )
    }
  }

  private async listBrowserEntries(request: L4AppSocketRequest): Promise<void> {
    const contract = L3PluginBrowserSocketContracts.list
    if (!contract.inputSchema.safeParse(request.body).success) {
      this.connection.sendError(contract.path, request.head.requestId, 400, '插件入口参数无效')
      return
    }

    try {
      const entries = await getL4PiGlobalPluginRuntime().listBrowserEntries()
      const resources = getL4PiPluginBrowserResourceRegistry().replace(entries)
      this.connection.sendSuccess(contract, request.head.requestId, {
        entries: resources.map((resource) => ({
          pluginName: resource.entry.pluginName,
          url: resource.url
        }))
      })
    } catch (error) {
      console.error('[Pi Desk][PluginSocket] 查询 Browser Entry 失败', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
        message: error instanceof Error ? error.message : String(error)
      })
      this.connection.sendError(contract.path, request.head.requestId, 500, '查询插件入口失败')
    }
  }

  private async listCommands(request: L4AppSocketRequest): Promise<void> {
    const contract = L3PiNativeSocketContracts.commandsList
    const input = contract.inputSchema.safeParse(request.body)
    if (!input.success) {
      this.connection.sendError(contract.path, request.head.requestId, 400, 'Pi 命令参数无效')
      return
    }
    try {
      this.connection.sendSuccess(
        contract,
        request.head.requestId,
        await this.manage.listNativeCommands(input.data)
      )
    } catch (error) {
      this.sendNativeError(contract.path, request.head.requestId, error, '查询 Pi 命令失败')
    }
  }

  private async executeCommand(request: L4AppSocketRequest): Promise<void> {
    const contract = L3PiNativeSocketContracts.commandExecute
    const input = contract.inputSchema.safeParse(request.body)
    if (!input.success) {
      this.connection.sendError(contract.path, request.head.requestId, 400, 'Pi 命令参数无效')
      return
    }
    try {
      await this.manage.executeNativeCommand(input.data)
      this.connection.sendSuccess(contract, request.head.requestId, {})
    } catch (error) {
      this.sendNativeError(contract.path, request.head.requestId, error, '执行 Pi 命令失败')
    }
  }

  private async listTools(request: L4AppSocketRequest): Promise<void> {
    const contract = L3PiNativeSocketContracts.toolsList
    const input = contract.inputSchema.safeParse(request.body)
    if (!input.success) {
      this.connection.sendError(contract.path, request.head.requestId, 400, 'Pi Tool 参数无效')
      return
    }
    try {
      this.connection.sendSuccess(
        contract,
        request.head.requestId,
        await this.manage.listNativeTools(input.data)
      )
    } catch (error) {
      this.sendNativeError(contract.path, request.head.requestId, error, '查询 Pi Tool 失败')
    }
  }

  private async executeBash(request: L4AppSocketRequest): Promise<void> {
    const contract = L3PiNativeSocketContracts.bashExecute
    const input = contract.inputSchema.safeParse(request.body)
    if (!input.success) {
      this.connection.sendError(contract.path, request.head.requestId, 400, 'Pi Bash 参数无效')
      return
    }
    try {
      this.connection.sendSuccess(
        contract,
        request.head.requestId,
        await this.manage.executeDirectBash(input.data)
      )
    } catch (error) {
      this.sendNativeError(contract.path, request.head.requestId, error, '执行 Pi Bash 失败')
    }
  }

  private async abortBash(request: L4AppSocketRequest): Promise<void> {
    const contract = L3PiNativeSocketContracts.bashAbort
    const input = contract.inputSchema.safeParse(request.body)
    if (!input.success) {
      this.connection.sendError(contract.path, request.head.requestId, 400, 'Pi Bash 参数无效')
      return
    }
    try {
      await this.manage.abortDirectBash(input.data)
      this.connection.sendSuccess(contract, request.head.requestId, {})
    } catch (error) {
      this.sendNativeError(contract.path, request.head.requestId, error, '中止 Pi Bash 失败')
    }
  }

  private sendNativeError(
    path: string,
    requestId: string,
    error: unknown,
    fallbackMessage: string
  ): void {
    if (error instanceof L2ChatSourceBindingError) {
      this.connection.sendError(path, requestId, 409, '工作会话来源已变化')
      return
    }
    if (error instanceof L2ChatLifecycleBlockedError) {
      this.connection.sendError(path, requestId, 409, '工作会话正在变更')
      return
    }
    if (error instanceof L4PiNativeCommandNotFoundError) {
      this.connection.sendError(path, requestId, 404, 'Pi 命令不存在')
      return
    }
    if (error instanceof L4PiDirectBashRunningError) {
      this.connection.sendError(path, requestId, 409, '当前工作会话已有 Bash 正在执行')
      return
    }

    console.warn('[Pi Desk][PluginSocket] Native Pi 调用失败', {
      path,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      message: error instanceof Error ? error.message : String(error)
    })
    this.connection.sendError(
      path,
      requestId,
      500,
      error instanceof Error && error.message ? error.message : fallbackMessage
    )
  }

  private sendInvokeError(
    path: string,
    requestId: string,
    error: unknown,
    pluginName: string,
    method: string
  ): void {
    if (error instanceof L2ChatSourceBindingError) {
      this.connection.sendError(path, requestId, 409, '工作会话来源已变化')
      return
    }
    if (error instanceof L2ChatLifecycleBlockedError) {
      this.connection.sendError(path, requestId, 409, '工作会话正在变更')
      return
    }
    if (
      error instanceof L4PiPluginRuntimeBusyError ||
      (error instanceof Error && error.name === 'L4PiPluginRuntimeBusyError')
    ) {
      this.connection.sendError(path, requestId, 409, '插件正在重载')
      return
    }
    if (
      error instanceof L4PiPluginMethodNotFoundError ||
      (error instanceof Error && error.name === 'L4PiPluginMethodNotFoundError')
    ) {
      this.connection.sendError(path, requestId, 404, '插件方法不存在')
      return
    }
    if (error instanceof L4PiPluginMethodPayloadTooLargeError) {
      if (error.direction === 'input') {
        this.connection.sendError(path, requestId, 413, '插件调用数据超过 2MB')
        return
      }
      console.warn('[Pi Desk][PluginSocket] 插件方法输出超过限制', {
        pluginName,
        method,
        path,
        errorName: error.name
      })
      this.connection.sendError(
        path,
        requestId,
        500,
        `插件方法执行失败：${pluginName}/${method} 返回数据超过 2MB，请缩小查询范围或减少返回内容`
      )
      return
    }
    if (isPluginMethodError(error)) {
      this.connection.sendError(path, requestId, error.code, error.message)
      return
    }

    console.warn('[Pi Desk][PluginSocket] 插件方法执行失败', {
      pluginName,
      method,
      path,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      message: error instanceof Error ? error.message : 'Unknown plugin method error'
    })
    this.connection.sendError(path, requestId, 500, '插件方法执行失败')
  }
}
