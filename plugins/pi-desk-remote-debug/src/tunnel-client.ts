import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { resolveDesktopTunnelHost } from './desktop-tunnel-host.js'
import type { RunLogger } from './log.js'
import { signalProcessTree } from './process.js'

const STOP_TIMEOUT_MS = 10_000
const FORCE_STOP_WAIT_MS = 1500

interface TunnelConnectionRow {
  peerId: string
  localPort: number
  source: 'public' | 'client'
  path: 'unknown' | 'direct' | 'relay'
  activeTcp: number
}

interface TunnelCliEvent {
  type: 'opening' | 'connecting' | 'listening' | 'recovering' | 'failed' | 'stopped' | 'connections'
  publicAddr?: string
  detail?: string
  rows?: TunnelConnectionRow[]
}

export interface TunnelClientResult {
  failed: boolean
  detail: string | null
  exitCode: number | null
}

export interface ManagedTunnelClient {
  readonly ready: Promise<string>
  readonly completion: Promise<TunnelClientResult>
  stop(): Promise<TunnelClientResult>
}

export function startTunnelClient(input: {
  localPort: number
  publicPort: number
  logger: RunLogger
}): ManagedTunnelClient {
  const host = resolveDesktopTunnelHost()
  if (!host) {
    throw new Error('公网调试需要由同机 Pi Desk 桌面端托管服务')
  }
  if (!existsSync(host.executable)) {
    throw new Error(`桌面隧道程序不存在：${host.executable}`)
  }
  const ports = `localPort=${input.localPort} publicPort=${input.publicPort}`
  let child: ChildProcessWithoutNullStreams
  try {
    child = spawn(
      host.executable,
      [
        '--tunnel-client',
        '--local',
        `127.0.0.1:${input.localPort}`,
        '--public-port',
        String(input.publicPort),
        '--stats'
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: { ...process.env, PI_DESK_DESKTOP_CONFIG: host.configPath }
      }
    )
  } catch (error) {
    input.logger.line(
      'tunnel:error',
      `CLI 启动失败 ${ports} reason=${error instanceof Error ? error.message : String(error)}`
    )
    throw error
  }
  const pid = child.pid
  if (!pid) {
    input.logger.line('tunnel:error', `CLI 启动失败 pid=null ${ports} reason=未取得进程 PID`)
    // 创建失败仍会异步发出 error；同步拒绝前先接住，避免变成宿主未处理异常。
    child.once('error', (error) => {
      input.logger.line('tunnel:error', `CLI 启动失败 pid=null ${ports} reason=${error.message}`)
      console.error(`[pi-desk-remote-debug] 隧道程序启动失败：${error.message}`)
    })
    throw new Error('无法启动桌面隧道程序')
  }
  const context = `pid=${pid} ${ports}`
  input.logger.line('tunnel', `CLI 已启动 ${context}`)

  let readySettled = false
  let resolveReady!: (publicAddr: string) => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<string>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  let completionSettled = false
  let resolveCompletion!: (result: TunnelClientResult) => void
  const completion = new Promise<TunnelClientResult>((resolve) => {
    resolveCompletion = resolve
  })
  let failureDetail: string | null = null
  let stopped = false

  const failReady = (detail: string): void => {
    if (readySettled) return
    readySettled = true
    rejectReady(new Error(detail))
  }
  const finish = (result: TunnelClientResult): void => {
    if (completionSettled) return
    completionSettled = true
    if (!readySettled) failReady(result.detail ?? 'Tunnel Client 在监听前退出')
    resolveCompletion(result)
  }

  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    let event: TunnelCliEvent
    try {
      event = parseTunnelEvent(line)
    } catch (error) {
      failureDetail = error instanceof Error ? error.message : String(error)
      input.logger.line('tunnel:error', failureDetail)
      failReady(failureDetail)
      child.stdin.end()
      return
    }
    if (failureDetail && event.type !== 'connections' && event.type !== 'stopped') return
    switch (event.type) {
      case 'opening':
        input.logger.line('tunnel', '正在请求公网端口')
        break
      case 'connecting':
        input.logger.line('tunnel', `正在连接 ${event.publicAddr}`)
        break
      case 'listening':
        input.logger.line('tunnel', `公网转发已监听 ${event.publicAddr}`)
        if (!readySettled && event.publicAddr) {
          readySettled = true
          resolveReady(event.publicAddr)
        }
        break
      case 'recovering':
        input.logger.line('tunnel', event.detail ?? '正在恢复连接')
        break
      case 'failed':
        failureDetail = desktopFailure(event.detail ?? 'Tunnel Client 运行失败')
        input.logger.line('tunnel:error', failureDetail)
        failReady(failureDetail)
        break
      case 'connections': {
        const rows = event.rows!
        const count = rows.reduce((total, row) => total + row.activeTcp, 0)
        const detail = rows
          .map(
            (row) =>
              `${row.source === 'public' ? '公网网关→提供端' : '原生客户端→提供端'} ${row.peerId} 本机端口 ${row.localPort} 实际路径 ${row.path} TCP=${row.activeTcp}`
          )
          .join('；')
        input.logger.line('tunnel', `当前活动 TCP=${count}${detail ? `；${detail}` : ''}`)
        break
      }
      case 'stopped':
        stopped = true
        input.logger.line('tunnel', '隧道资源已释放')
        break
    }
  })
  bindLines(child.stderr, (line) => {
    input.logger.line('tunnel:error', line)
    const detail = desktopFailure(line)
    if (detail !== line) {
      failureDetail = detail
      failReady(detail)
      child.stdin.end()
    }
  })
  child.once('error', (error) => {
    input.logger.line('tunnel:error', `CLI 进程错误 ${context} reason=${error.message}`)
    failureDetail = error.message
    failReady(error.message)
    finish({ failed: true, detail: error.message, exitCode: null })
  })
  child.once('close', (exitCode, signal) => {
    lines.close()
    const detail =
      failureDetail ??
      ((exitCode ?? 1) !== 0
        ? `Tunnel Client 退出码 ${exitCode ?? 'null'}`
        : !stopped
          ? 'Tunnel Client 未确认资源释放即退出'
          : null)
    input.logger.line(
      'tunnel',
      `CLI 已退出 ${context} exitCode=${exitCode ?? 'null'} signal=${signal ?? 'null'} reason=${detail ?? '已确认资源释放'}`
    )
    finish({ failed: detail !== null, detail, exitCode })
  })

  let stopPromise: Promise<TunnelClientResult> | null = null
  return {
    ready,
    completion,
    stop(): Promise<TunnelClientResult> {
      if (completionSettled) return completion
      if (stopPromise) return stopPromise
      input.logger.line('tunnel', `请求停止 CLI ${context} reason=运行资源清理`)
      stopPromise = stopTunnelChild(child, pid, completion, input.logger)
      return stopPromise
    }
  }
}

async function stopTunnelChild(
  child: ChildProcessWithoutNullStreams,
  pid: number,
  completion: Promise<TunnelClientResult>,
  logger: RunLogger
): Promise<TunnelClientResult> {
  child.stdin.end()
  const graceful = await waitForCompletion(completion, STOP_TIMEOUT_MS)
  if (graceful) return graceful

  logger.line('tunnel:error', `Tunnel Client PID ${pid} 未及时退出，正在强制终止`)
  signalProcessTree(child, pid, true)
  const forced = await waitForCompletion(completion, FORCE_STOP_WAIT_MS)
  if (forced) {
    return {
      ...forced,
      failed: true,
      detail: forced.detail ?? 'Tunnel Client 超时后被强制终止，未确认资源释放'
    }
  }
  throw new Error(`Tunnel Client PID ${pid} 在终止请求后仍未退出`)
}

function parseTunnelEvent(line: string): TunnelCliEvent {
  const value = JSON.parse(line) as Record<string, unknown>
  const type = value.type
  if (
    type !== 'opening' &&
    type !== 'connecting' &&
    type !== 'listening' &&
    type !== 'recovering' &&
    type !== 'failed' &&
    type !== 'stopped' &&
    type !== 'connections'
  ) {
    throw new Error(`Tunnel Client 返回未知事件：${line}`)
  }
  const publicAddr = typeof value.publicAddr === 'string' ? value.publicAddr : undefined
  const detail = typeof value.detail === 'string' ? value.detail : undefined
  if ((type === 'connecting' || type === 'listening') && !publicAddr) {
    throw new Error(`Tunnel Client ${type} 事件缺少 publicAddr`)
  }
  const rows = type === 'connections' ? parseConnectionRows(value.rows) : undefined
  return { type, publicAddr, detail, rows }
}

function desktopFailure(detail: string): string {
  if (
    /(未知|重复|不支持|unknown|unexpected|unrecognized|unsupported)/i.test(detail) &&
    /(--stats|参数|argument|option)/i.test(detail)
  ) {
    return `桌面隧道程序不支持 --stats，请同步升级 Pi Desk 桌面端：${detail}`
  }
  return detail
}

function parseConnectionRows(value: unknown): TunnelConnectionRow[] {
  if (!Array.isArray(value)) throw new Error('Tunnel Client connections 事件缺少 rows')
  return value.map((value: unknown) => {
    if (typeof value !== 'object' || value === null) {
      throw new Error('Tunnel Client connections 行格式无效')
    }
    const row = value as Record<string, unknown>
    if (
      typeof row.peerId !== 'string' ||
      !row.peerId ||
      typeof row.localPort !== 'number' ||
      !Number.isInteger(row.localPort) ||
      row.localPort < 1 ||
      row.localPort > 65535 ||
      (row.source !== 'public' && row.source !== 'client') ||
      (row.path !== 'unknown' && row.path !== 'direct' && row.path !== 'relay') ||
      typeof row.activeTcp !== 'number' ||
      !Number.isInteger(row.activeTcp) ||
      row.activeTcp < 0 ||
      row.activeTcp > 0xffffffff
    ) {
      throw new Error('Tunnel Client connections 行格式无效')
    }
    return {
      peerId: row.peerId,
      localPort: row.localPort,
      source: row.source,
      path: row.path,
      activeTcp: row.activeTcp
    }
  })
}

async function waitForCompletion(
  completion: Promise<TunnelClientResult>,
  timeoutMs: number
): Promise<TunnelClientResult | null> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      completion,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
        timer.unref?.()
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

function bindLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let pending = ''
  stream.on('data', (chunk: Buffer | string) => {
    pending += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
    const lines = pending.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (line) onLine(line)
    }
  })
  stream.on('end', () => {
    if (pending) onLine(pending)
  })
}
