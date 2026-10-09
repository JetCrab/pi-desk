import 'server-only'

import {
  L3PluginPushSocketContract,
  type L3PluginPushMessage
} from '@common/l3_modules/plugin-host/l3-plugin-push-contract'
import type { L4AppSocketRequest } from '@common/l4_foundation/realtime/l4-app-websocket-contract'
import type { L2AppRuntime } from '@server/l2_biz/app-runtime/l2-app-runtime'
import type { WorkSessionManage } from '@server/l2_biz/work-session/l2-work-session-manage'
import type { L2TaskCenterRuntime } from '@server/l2_biz/task-center/l2-task-center-runtime'
import type { L2TerminalManage } from '@server/l2_biz/terminal/l2-terminal-manage'
import {
  L4AppSocketConnection,
  type L4AppSocketCloseInfo
} from '@server/l4_foundation/realtime/app-socket/l4-app-socket'
import type { WebSocket } from 'ws'
import type { L1AppSocketRoute } from './l1-app-socket-route'
import { L1AppRuntimeSocketController } from './l1-app-runtime-socket-controller'
import { L1ChatSocketController } from './l1-chat-socket-controller'
import { L1PluginLogSocketController } from './l1-plugin-log-socket-controller'
import { L1NativeUiSocketController } from './l1-native-ui-socket-controller'
import { L1ModelAuthSocketController } from './l1-model-auth-socket-controller'
import { L1PluginSocketController } from './l1-plugin-socket-controller'
import { L1TaskCenterSocketController } from './l1-task-center-socket-controller'
import { L1TerminalSocketController } from './l1-terminal-socket-controller'
import { L1WorkSessionSocketController } from './l1-work-session-socket-controller'

export class L1AppSocketSession {
  readonly connection: L4AppSocketConnection

  private readonly routes = new Map<string, L1AppSocketRoute>()
  private readonly workSessions: L1WorkSessionSocketController
  private readonly appRuntime: L1AppRuntimeSocketController
  private readonly chat: L1ChatSocketController
  private readonly plugins: L1PluginSocketController
  private readonly nativeUi: L1NativeUiSocketController
  private readonly modelAuth: L1ModelAuthSocketController
  private readonly pluginLogs: L1PluginLogSocketController
  private readonly taskCenter: L1TaskCenterSocketController
  private readonly terminals: L1TerminalSocketController
  private disposed = false

  constructor(
    socket: WebSocket,
    clientId: string,
    readonly authToken: string | undefined,
    manage: WorkSessionManage,
    appRuntime: L2AppRuntime,
    taskCenter: L2TaskCenterRuntime,
    terminals: L2TerminalManage,
    private readonly onClose: (session: L1AppSocketSession, info: L4AppSocketCloseInfo) => void
  ) {
    this.connection = new L4AppSocketConnection(clientId, socket)
    this.workSessions = new L1WorkSessionSocketController(this.connection, manage, appRuntime)
    this.appRuntime = new L1AppRuntimeSocketController(this.connection, appRuntime)
    this.chat = new L1ChatSocketController(this.connection, manage)
    this.plugins = new L1PluginSocketController(this.connection, manage, () =>
      this.workSessions.isReady()
    )
    this.nativeUi = new L1NativeUiSocketController(this.connection, manage)
    this.modelAuth = new L1ModelAuthSocketController(this.connection)
    this.pluginLogs = new L1PluginLogSocketController(this.connection)
    this.taskCenter = new L1TaskCenterSocketController(this.connection, manage, taskCenter)
    this.terminals = new L1TerminalSocketController(this.connection, terminals, () =>
      this.workSessions.isReady()
    )
    this.registerRoutes(this.workSessions.routes)
    this.registerRoutes(this.appRuntime.routes)
    this.registerRoutes(this.chat.routes)
    this.registerRoutes(this.plugins.routes)
    this.registerRoutes(this.nativeUi.routes)
    this.registerRoutes(this.modelAuth.routes)
    this.registerRoutes(this.pluginLogs.routes)
    this.registerRoutes(this.taskCenter.routes)
    this.registerRoutes(this.terminals.routes)
  }

  start(): void {
    this.connection.start(
      (request) => this.handleRequest(request),
      (info) => {
        this.dispose()
        this.onClose(this, info)
      }
    )
    console.info('[Pi Desk][AppSocketSession] 应用连接已建立', {
      clientId: this.connection.clientId,
      connectionId: this.connection.connectionId
    })
  }

  supersede(): void {
    this.disposeControllers()
    this.connection.supersede()
  }

  close(code: number, reason: string): void {
    this.disposeControllers()
    this.connection.close(code, reason)
  }

  terminate(): void {
    this.disposeControllers()
    this.connection.terminate()
  }

  waitForClose(): Promise<L4AppSocketCloseInfo> {
    return this.connection.waitForClose()
  }

  pushPlugin(message: L3PluginPushMessage): void {
    if (this.disposed || !this.workSessions.isReady()) return
    this.connection.sendPush(L3PluginPushSocketContract, message)
  }

  private registerRoutes(routes: readonly L1AppSocketRoute[]): void {
    for (const route of routes) {
      if (this.routes.has(route.path)) {
        throw new Error(`Duplicate WebSocket route: ${route.path}`)
      }
      this.routes.set(route.path, route)
    }
  }

  private async handleRequest(request: L4AppSocketRequest): Promise<void> {
    const route = this.routes.get(request.head.path)
    if (!route) {
      this.connection.sendError(
        request.head.path,
        request.head.requestId,
        404,
        '未知 WebSocket 路径',
        { key: 'errors:socketUnknownPath' }
      )
      return
    }

    if (route.access === 'ready' && !this.workSessions.isReady()) {
      this.connection.sendError(
        request.head.path,
        request.head.requestId,
        409,
        '工作会话尚未初始化',
        { key: 'errors:sessionsNotReady' }
      )
      return
    }

    await route.handle(request)
  }

  private disposeControllers(): void {
    this.plugins.dispose()
    this.nativeUi.dispose()
    this.modelAuth.dispose()
    this.pluginLogs.dispose()
    this.taskCenter.dispose()
    this.terminals.dispose()
    this.chat.dispose()
    this.appRuntime.dispose()
    this.workSessions.dispose()
  }

  private dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disposeControllers()
  }
}
