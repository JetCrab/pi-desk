import 'server-only'

import { disposeL4PiDeskCommands } from '@server/l4_foundation/pidesk/l4-pidesk-runtime'

import type { L3PluginPushMessage } from '@common/l3_modules/plugin-host/l3-plugin-push-contract'
import { L2_WEB_SESSION_COOKIE_NAME } from '@server/l2_biz/auth/l2-auth'
import { readL4WebAuthCookie } from '@server/l4_foundation/auth/l4-web-auth'
import { disposeL2PluginManagement } from '@server/l2_biz/plugin-management/l2-plugin-management'
import { disposeL2AppRuntime, getL2AppRuntime } from '@server/l2_biz/app-runtime/l2-app-runtime'
import { getL2WorkSessionManage } from '@server/l2_biz/work-session/l2-work-session-manage'
import { disposeL4PiPluginBrowserResourceRegistry } from '@server/l4_foundation/pi/l4-pi-plugin-browser-resource'
import { disposeL4PiGlobalPluginRuntime } from '@server/l4_foundation/pi/l4-pi-global-plugin-runtime'
import { disposeAllL4PiWorkSessionRuntimes } from '@server/l4_foundation/pi/l4-pi-work-session-runtime'
import type { WebSocket } from 'ws'
import { getL1TaskCenterRuntime } from '@server/l1_entry/l1-task-center-runtime'
import { getL2TerminalManage } from '@server/l2_biz/terminal/l2-terminal-manage'
import { L1AppSocketSession } from './l1-app-socket-session'

export interface L1AppSocketRuntime {
  accept: (socket: WebSocket, clientId: string, cookieHeader?: string) => void
  closeByAuthToken: (token: string, code: number, reason: string) => Promise<void>
  closeAll: (code: number, reason: string) => Promise<void>
  terminateAll: () => void
  connectionCount: () => number
  pushPlugin: (message: L3PluginPushMessage) => void
  disposePlugins: () => Promise<void>
  disposeWorkSessions: () => Promise<void>
  disposeTerminals: () => Promise<void>
}

class AppSocketRuntime implements L1AppSocketRuntime {
  private readonly sessionsByClientId = new Map<string, L1AppSocketSession>()
  private readonly manage = getL2WorkSessionManage()
  private readonly appRuntime = getL2AppRuntime()
  private readonly taskCenter = getL1TaskCenterRuntime()
  private readonly terminals = getL2TerminalManage()

  constructor() {
    this.manage.subscribePluginPushEvents((message) => this.pushPlugin(message))
  }

  accept(socket: WebSocket, clientId: string, cookieHeader?: string): void {
    const previous = this.sessionsByClientId.get(clientId)
    const session = new L1AppSocketSession(
      socket,
      clientId,
      readL4WebAuthCookie(cookieHeader, L2_WEB_SESSION_COOKIE_NAME),
      this.manage,
      this.appRuntime,
      this.taskCenter,
      this.terminals,
      (closed, info) => {
        if (this.sessionsByClientId.get(clientId) === closed) {
          this.sessionsByClientId.delete(clientId)
        }
        console.info('[Pi Desk][AppSocketRuntime] 应用连接已断开', {
          clientId,
          connectionId: closed.connection.connectionId,
          code: info.code
        })
      }
    )

    this.sessionsByClientId.set(clientId, session)
    try {
      session.start()
    } catch (error) {
      if (previous) this.sessionsByClientId.set(clientId, previous)
      else this.sessionsByClientId.delete(clientId)
      session.terminate()
      throw error
    }

    previous?.supersede()
  }

  async closeByAuthToken(token: string, code: number, reason: string): Promise<void> {
    const sessions: L1AppSocketSession[] = []
    for (const [clientId, session] of this.sessionsByClientId) {
      if (session.authToken !== token) continue
      this.sessionsByClientId.delete(clientId)
      session.close(code, reason)
      sessions.push(session)
    }
    await Promise.all(sessions.map((session) => session.waitForClose()))
  }

  async closeAll(code: number, reason: string): Promise<void> {
    const sessions = [...this.sessionsByClientId.values()]
    this.sessionsByClientId.clear()
    for (const session of sessions) session.close(code, reason)
    await Promise.all(sessions.map((session) => session.waitForClose()))
  }

  terminateAll(): void {
    const sessions = [...this.sessionsByClientId.values()]
    this.sessionsByClientId.clear()
    for (const session of sessions) session.terminate()
  }

  connectionCount(): number {
    return this.sessionsByClientId.size
  }

  pushPlugin(message: L3PluginPushMessage): void {
    for (const session of this.sessionsByClientId.values()) session.pushPlugin(message)
  }

  async disposePlugins(): Promise<void> {
    disposeL4PiDeskCommands()
    disposeL2PluginManagement()
    await disposeL4PiGlobalPluginRuntime()
    disposeL4PiPluginBrowserResourceRegistry()
    disposeL2AppRuntime()
  }

  async disposeTerminals(): Promise<void> {
    await this.terminals.dispose()
  }

  async disposeWorkSessions(): Promise<void> {
    await disposeAllL4PiWorkSessionRuntimes()
  }
}

declare global {
  var __piDeskAppSocketRuntime: L1AppSocketRuntime | undefined
}

export function getL1AppSocketRuntime(): L1AppSocketRuntime {
  if (!globalThis.__piDeskAppSocketRuntime) {
    globalThis.__piDeskAppSocketRuntime = new AppSocketRuntime()
  }
  return globalThis.__piDeskAppSocketRuntime
}
