import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { resolveDesktopTunnelHost } from './desktop-tunnel-host.js'
import type { RunLogger } from './log.js'
import { signalProcessTree } from './process.js'

const STOP_TIMEOUT_MS = 10_000
const FORCE_STOP_WAIT_MS = 1500

interface TunnelCliEvent {
  type: 'opening' | 'connecting' | 'listening' | 'recovering' | 'failed' | 'stopped'
  publicAddr?: string
  detail?: string
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
  const child = spawn(
    host.executable,
    [
      '--tunnel-client',
      '--local',
      `127.0.0.1:${input.localPort}`,
      '--public-port',
      String(input.publicPort)
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PI_DESK_DESKTOP_CONFIG: host.configPath }
    }
  )
  const pid = child.pid
  if (!pid) {
    child.kill()
    throw new Error('Tunnel Client 未返回进程 ID')
  }

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
  let stopRequested = false

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
      child.stdin.end()
      return
    }
    switch (event.type) {
      case 'opening':
        input.logger.line('tunnel', '正在请求公网端口')
        break
      case 'connecting':
        input.logger.line('tunnel', `正在连接 ${event.publicAddr}`)
        break
      case 'listening':
        input.logger.line('tunnel', `已监听 ${event.publicAddr}`)
        if (!readySettled && event.publicAddr) {
          readySettled = true
          resolveReady(event.publicAddr)
        }
        break
      case 'recovering':
        input.logger.line('tunnel', event.detail ?? '正在恢复连接')
        break
      case 'failed':
        failureDetail = event.detail ?? 'Tunnel Client 运行失败'
        input.logger.line('tunnel:error', failureDetail)
        failReady(failureDetail)
        break
      case 'stopped':
        input.logger.line('tunnel', '已停止')
        break
    }
  })
  bindLines(child.stderr, (line) => input.logger.line('tunnel:error', line))
  child.once('error', (error) => {
    failureDetail = error.message
    failReady(error.message)
    finish({ failed: true, detail: error.message, exitCode: null })
  })
  child.once('close', (exitCode) => {
    lines.close()
    const failed = !stopRequested && (failureDetail !== null || (exitCode ?? 1) !== 0)
    finish({
      failed,
      detail: failed ? (failureDetail ?? `Tunnel Client 退出码 ${exitCode ?? 'null'}`) : null,
      exitCode
    })
  })

  let stopPromise: Promise<TunnelClientResult> | null = null
  return {
    ready,
    completion,
    stop(): Promise<TunnelClientResult> {
      if (completionSettled) return completion
      if (stopPromise) return stopPromise
      stopRequested = true
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
  if (forced) return forced
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
    type !== 'stopped'
  ) {
    throw new Error(`Tunnel Client 返回未知事件：${line}`)
  }
  const publicAddr = typeof value.publicAddr === 'string' ? value.publicAddr : undefined
  const detail = typeof value.detail === 'string' ? value.detail : undefined
  if ((type === 'connecting' || type === 'listening') && !publicAddr) {
    throw new Error(`Tunnel Client ${type} 事件缺少 publicAddr`)
  }
  return { type, publicAddr, detail }
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
