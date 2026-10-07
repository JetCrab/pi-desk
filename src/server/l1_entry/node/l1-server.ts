import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { URL } from 'node:url'
import {
  L4_APP_WEBSOCKET_ENDPOINT,
  L4_APP_WEBSOCKET_PROTOCOL,
  L4AppSocketClientIdSchema
} from '@common/l4_foundation/realtime/l4-app-websocket-contract'
import { getL1AppSocketRuntimeBridge } from './l1-app-socket-bridge'
import { getL1WebAuthRuntimeBridge } from './l1-web-auth-bridge'
import type { L4PiDeskPackageMaintenanceRequest } from '@server/l4_foundation/pi/l4-pi-desk-process-control'
import { WebSocketServer } from 'ws'
import { startManagedHeartbeat } from '@server/l4_foundation/process/l4-pi-desk-supervisor.js'

const supervisorHeartbeat = startManagedHeartbeat()

const APP_MAX_PAYLOAD_BYTES = 32 * 1024 * 1024
const APP_COMPRESSION_THRESHOLD_BYTES = 1024
const APP_COMPRESSION_CONCURRENCY_LIMIT = 4
const SHUTDOWN_GRACE_PERIOD_MS = 5_000
const SHUTDOWN_FORCE_EXIT_MS = 10_000
const RESTART_GRACE_PERIOD_MS = 1_000
const RESTART_FORCE_EXIT_MS = 3_000
const MANAGED_RESTART_EXIT_CODE = 75
const LOGIN_PAGE_PATH = '/login'
const LOGIN_API_PATH = '/api/auth/login'
const HEALTH_API_PATH = '/api/health'

function readPort(): number {
  const port = Number.parseInt(process.env.PORT ?? '6233', 10)
  return Number.isInteger(port) && port > 0 ? port : 6233
}

function hasAppProtocol(protocolHeader: string | string[] | undefined): boolean {
  return (
    typeof protocolHeader === 'string' &&
    protocolHeader
      .split(',')
      .map((protocol) => protocol.trim())
      .includes(L4_APP_WEBSOCKET_PROTOCOL)
  )
}

function rejectUpgrade(socket: Duplex, status: 400 | 401 | 503, message: string): void {
  const statusText =
    status === 400 ? 'Bad Request' : status === 401 ? 'Unauthorized' : 'Service Unavailable'
  socket.end(
    `HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${message}`
  )
}

function endShutdownResponse(request: IncomingMessage, response: ServerResponse): void {
  response.statusCode = 503
  if ((request.url ?? '').startsWith('/api/')) {
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.end(
      JSON.stringify({
        code: 503,
        msg: '服务正在关闭',
        data: null,
        i18n: { key: 'common:shuttingDown' }
      })
    )
    return
  }
  response.end('Service unavailable / 服务暂时不可用')
}

function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/')
}

function isPublicHttpPath(pathname: string): boolean {
  return (
    pathname === LOGIN_PAGE_PATH ||
    pathname === LOGIN_API_PATH ||
    pathname === HEALTH_API_PATH ||
    pathname === '/favicon.ico' ||
    pathname.startsWith('/_next/')
  )
}

function endHttpAuthError(
  response: ServerResponse,
  status: 401 | 503,
  msg: string,
  key: string
): void {
  response.statusCode = status
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.end(JSON.stringify({ code: status, msg, data: null, i18n: { key } }))
}

function allowHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  hostname: string
): boolean {
  let pathname: string
  try {
    pathname = new URL(request.url ?? '/', `http://${request.headers.host ?? hostname}`).pathname
  } catch {
    response.statusCode = 400
    response.end('Bad Request')
    return false
  }

  if (isPublicHttpPath(pathname) && pathname !== LOGIN_PAGE_PATH) return true

  const authRuntime = getL1WebAuthRuntimeBridge()
  let authenticated = false
  try {
    authenticated = authRuntime?.isAuthenticated(request.headers.cookie) ?? false
  } catch {
    endHttpAuthError(
      response,
      503,
      '登录保护配置无法读取，请修复配置或删除 auth.json 后重新设置',
      'auth:configUnavailable'
    )
    return false
  }
  if (pathname === LOGIN_PAGE_PATH) {
    if (!authenticated) return true
    response.statusCode = 302
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Location', '/')
    response.end()
    return false
  }
  if (isPublicHttpPath(pathname)) return true

  if (!authRuntime) {
    if (isApiPath(pathname))
      endHttpAuthError(response, 503, '登录认证尚未就绪', 'common:authUnavailable')
    else {
      response.statusCode = 503
      response.setHeader('Cache-Control', 'no-store')
      response.end('Service unavailable / 服务暂时不可用')
    }
    return false
  }
  if (authenticated) return true

  if (isApiPath(pathname)) {
    endHttpAuthError(response, 401, '请先登录', 'common:authenticationRequired')
    return false
  }

  response.statusCode = 302
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Location', LOGIN_PAGE_PATH)
  response.end()
  return false
}

function parseAppClientId(requestUrl: URL): string | null {
  const clientIds = requestUrl.searchParams.getAll('clientId')
  if (clientIds.length !== 1) return null
  const result = L4AppSocketClientIdSchema.safeParse(clientIds[0])
  return result.success ? result.data : null
}

async function startServer(): Promise<void> {
  // 安装到 node_modules 后，原生 ESM 加载不会应用 TypeScript 路径别名。
  await import('../../l4_foundation/pi/l4-pi-runtime-register.mjs')
  const startedAt = performance.now()
  const dev = process.argv.includes('--dev')
  const { default: next } = await import('next')
  const port = readPort()
  const hostname = process.env.HOST ?? 'localhost'
  const nextApp = next({ dev, hostname, port })
  const appWebSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: APP_MAX_PAYLOAD_BYTES,
    perMessageDeflate: {
      threshold: APP_COMPRESSION_THRESHOLD_BYTES,
      concurrencyLimit: APP_COMPRESSION_CONCURRENCY_LIMIT,
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
      zlibDeflateOptions: { level: 3 }
    },
    handleProtocols: (protocols) =>
      protocols.has(L4_APP_WEBSOCKET_PROTOCOL) ? L4_APP_WEBSOCKET_PROTOCOL : false
  })
  const nextUpgradeSockets = new Set<Duplex>()
  let shuttingDown = false
  const standby = process.env.PI_DESK_STANDBY === '1'
  let listening = false

  const prepareStartedAt = performance.now()
  console.info('[Pi Desk][NodeServer] 开始准备 Next Runtime', { dev })
  await nextApp.prepare()
  console.info('[Pi Desk][NodeServer] Next Runtime 准备完成', {
    durationMs: Math.round(performance.now() - prepareStartedAt)
  })
  const requestHandler = nextApp.getRequestHandler()
  const upgradeHandler = nextApp.getUpgradeHandler()

  const server = createServer((request, response) => {
    if (shuttingDown) {
      endShutdownResponse(request, response)
      return
    }
    if (!allowHttpRequest(request, response, hostname)) return

    void requestHandler(request, response).catch((error: unknown) => {
      console.error('[Pi Desk][NodeServer] HTTP 请求处理失败', {
        errorName: error instanceof Error ? error.name : 'UnknownError'
      })
      if (!response.headersSent) response.statusCode = 500
      response.end('Internal server error / 页面处理失败')
    })
  })

  let managedRestartHandler:
    | ((
        maintenance?:
          L4PiDeskPackageMaintenanceRequest | readonly L4PiDeskPackageMaintenanceRequest[],
        mode?: 'normal' | 'basic'
      ) => void)
    | null = null

  const shutdown = (source: 'SIGINT' | 'SIGTERM' | 'IPC' | 'RESTART'): void => {
    if (shuttingDown) return
    shuttingDown = true
    supervisorHeartbeat.closing(source)
    const runtime = getL1AppSocketRuntimeBridge()
    console.info('[Pi Desk][NodeServer] 开始优雅关闭', {
      source,
      appConnectionCount: runtime?.connectionCount() ?? 0
    })

    let pendingCloseSteps = 7
    let finished = false
    const gracePeriodMs = source === 'RESTART' ? RESTART_GRACE_PERIOD_MS : SHUTDOWN_GRACE_PERIOD_MS
    const forceExitMs = source === 'RESTART' ? RESTART_FORCE_EXIT_MS : SHUTDOWN_FORCE_EXIT_MS
    const forceCloseTimer = setTimeout(() => {
      if (finished) return
      console.warn('[Pi Desk][NodeServer] 优雅关闭超时，终止剩余连接', {
        appConnectionCount: runtime?.connectionCount() ?? 0
      })
      server.closeAllConnections()
      runtime?.terminateAll()
      for (const socket of appWebSocketServer.clients) socket.terminate()
    }, gracePeriodMs)
    const forceExitTimer = setTimeout(() => {
      if (finished) return
      const exitCode = source === 'RESTART' ? MANAGED_RESTART_EXIT_CODE : 1
      console.error('[Pi Desk][NodeServer] 关闭未完成，强制退出', { source, exitCode })
      process.exit(exitCode)
    }, forceExitMs)
    forceCloseTimer.unref()
    forceExitTimer.unref()

    const closeStep = (name: string, error?: Error): void => {
      if (finished) return
      if (error) {
        console.error('[Pi Desk][NodeServer] 关闭组件失败', {
          name,
          errorName: error.name
        })
      }
      pendingCloseSteps -= 1
      console.info('[Pi Desk][NodeServer] 关闭步骤完成', {
        name,
        failed: Boolean(error),
        pendingCloseSteps
      })
      if (pendingCloseSteps !== 0) return

      finished = true
      clearTimeout(forceCloseTimer)
      clearTimeout(forceExitTimer)
      process.removeListener('SIGINT', onSigint)
      process.removeListener('SIGTERM', onSigterm)
      process.removeListener('message', onMessage)
      if (globalThis.__piDeskRestartHandler === managedRestartHandler) {
        globalThis.__piDeskRestartHandler = undefined
      }
      supervisorHeartbeat.dispose()
      if (process.connected) process.disconnect()
      console.info('[Pi Desk][NodeServer] 优雅关闭完成')
      const exitCode = source === 'RESTART' ? MANAGED_RESTART_EXIT_CODE : 0
      setImmediate(() => process.exit(exitCode))
    }

    // HTTP close 不会结束已经 upgrade 的 Next/HMR 连接，Node 入口负责其关闭。
    for (const socket of nextUpgradeSockets) socket.destroy()
    nextUpgradeSockets.clear()
    server.close((error) => closeStep('HTTP Server', error))
    appWebSocketServer.close((error) => closeStep('App WebSocket Server', error))
    if (runtime) {
      void runtime.closeAll(1001, '服务正在关闭').then(
        () => closeStep('App WebSocket Runtime'),
        (error: unknown) =>
          closeStep(
            'App WebSocket Runtime',
            error instanceof Error ? error : new Error('Unknown runtime close error')
          )
      )
    } else {
      closeStep('App WebSocket Runtime')
    }
    if (runtime) {
      void runtime.disposePlugins().then(
        () => closeStep('Global Plugin Runtime'),
        (error: unknown) =>
          closeStep(
            'Global Plugin Runtime',
            error instanceof Error ? error : new Error('Unknown plugin runtime close error')
          )
      )
    } else {
      closeStep('Global Plugin Runtime')
    }
    if (runtime) {
      void runtime.disposeWorkSessions().then(
        () => closeStep('Pi WorkSession Runtimes'),
        (error: unknown) =>
          closeStep(
            'Pi WorkSession Runtimes',
            error instanceof Error ? error : new Error('Unknown Pi runtime close error')
          )
      )
    } else {
      closeStep('Pi WorkSession Runtimes')
    }
    if (runtime) {
      void runtime.disposeTerminals().then(
        () => closeStep('Terminal Runtime'),
        (error: unknown) =>
          closeStep(
            'Terminal Runtime',
            error instanceof Error ? error : new Error('Unknown terminal close error')
          )
      )
    } else {
      closeStep('Terminal Runtime')
    }
    void nextApp.close().then(
      () => closeStep('Next App'),
      (error: unknown) =>
        closeStep(
          'Next App',
          error instanceof Error ? error : new Error('Unknown Next close error')
        )
    )
  }

  const onSigint = (): void => shutdown('SIGINT')
  const onSigterm = (): void => shutdown('SIGTERM')
  const onMessage = (message: unknown): void => {
    if (message === 'pi-desk.shutdown') shutdown('IPC')
    if (message === 'pi-desk.restart' && managedRestartHandler) managedRestartHandler()
    if (message === 'pi-desk.activate' && standby) startListening()
  }

  if (process.env.PI_DESK_MANAGED_RESTART === '1' && process.send) {
    managedRestartHandler = (maintenance, mode) => {
      if (mode) process.send?.({ type: 'pi-desk.restart-mode', mode })
      if (maintenance && mode !== 'basic') {
        process.send?.({
          type: 'pi-desk.plugin-maintenance',
          maintenance
        })
      }
      shutdown('RESTART')
    }
    globalThis.__piDeskRestartHandler = managedRestartHandler
  }

  server.on('upgrade', (request, socket, head) => {
    if (shuttingDown) {
      socket.destroy()
      return
    }

    const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? hostname}`)
    if (requestUrl.pathname !== L4_APP_WEBSOCKET_ENDPOINT) {
      nextUpgradeSockets.add(socket)
      socket.once('close', () => nextUpgradeSockets.delete(socket))
      void upgradeHandler(request, socket, head).catch((error: unknown) => {
        console.error('[Pi Desk][NodeServer] 非应用升级处理失败', {
          errorName: error instanceof Error ? error.name : 'UnknownError'
        })
        socket.destroy()
      })
      return
    }

    const authRuntime = getL1WebAuthRuntimeBridge()
    if (!authRuntime) {
      rejectUpgrade(socket, 503, '登录认证尚未就绪')
      return
    }
    let authenticated = false
    try {
      authenticated = authRuntime.isAuthenticated(request.headers.cookie)
    } catch {
      rejectUpgrade(socket, 503, '登录保护配置无法读取')
      return
    }
    if (!authenticated) {
      console.warn('[Pi Desk][NodeServer] 拒绝未登录应用握手')
      rejectUpgrade(socket, 401, 'Authentication Required')
      return
    }

    const clientId = parseAppClientId(requestUrl)
    if (!clientId || !hasAppProtocol(request.headers['sec-websocket-protocol'])) {
      console.warn('[Pi Desk][NodeServer] 拒绝无效应用握手', {
        hasClientId: clientId !== null,
        hasProtocol: hasAppProtocol(request.headers['sec-websocket-protocol'])
      })
      rejectUpgrade(socket, 400, '应用 WebSocket 握手参数无效')
      return
    }

    const runtime = getL1AppSocketRuntimeBridge()
    if (!runtime) {
      rejectUpgrade(socket, 503, '应用 WebSocket Runtime 尚未就绪')
      return
    }

    appWebSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      try {
        runtime.accept(webSocket, clientId, request.headers.cookie)
      } catch (error) {
        console.error('[Pi Desk][NodeServer] 接入应用连接失败', {
          clientId,
          errorName: error instanceof Error ? error.name : 'UnknownError'
        })
        webSocket.close(1011, '应用连接初始化失败')
      }
    })
  })

  server.on('error', (error) => {
    console.error('[Pi Desk][NodeServer] 监听失败', { message: error.message })
  })

  const startListening = (): void => {
    if (listening || shuttingDown) return
    listening = true
    server.listen(port, hostname, () => {
      supervisorHeartbeat.ready()
      console.info(`[Pi Desk][NodeServer] ${dev ? '开发' : '生产'}服务已启动`, {
        url: `http://${hostname}:${port}`,
        listenDurationMs: Math.round(performance.now() - startedAt)
      })
    })
  }

  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)
  if (process.channel) process.on('message', onMessage)

  if (standby) {
    supervisorHeartbeat.ready()
    console.info('[Pi Desk][NodeServer] 候选服务预热完成，等待激活')
    process.send?.({ type: 'pi-desk.standby-ready' })
  } else {
    startListening()
  }
}

void startServer().catch((error: unknown) => {
  supervisorHeartbeat.dispose()
  console.error('[Pi Desk][NodeServer] 启动失败', {
    errorName: error instanceof Error ? error.name : 'UnknownError',
    message: error instanceof Error ? error.message : undefined
  })
  process.exitCode = 1
})
