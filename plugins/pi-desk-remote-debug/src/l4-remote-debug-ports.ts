import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { z } from 'zod'
import {
  remoteDebugPortConflictSchema,
  type RemoteDebugPortConflict,
  type RemoteDebugPortProcess
} from './l4-remote-debug-contract.js'

const execFileAsync = promisify(execFile)
const COMMAND_TIMEOUT_MS = 10_000
const PORT_RELEASE_TIMEOUT_MS = 5_000

export function isLocalPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false)
      else reject(error)
    })
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.close((error) => {
        if (error) reject(error)
        else resolve(true)
      })
    })
  })
}

export async function prepareLocalPorts(
  ports: readonly number[],
  confirmedProcesses: readonly RemoteDebugPortProcess[] = [],
  signal?: AbortSignal
): Promise<RemoteDebugPortConflict[]> {
  const unavailable = await unavailablePorts(ports)
  signal?.throwIfAborted()
  if (unavailable.length === 0) return []
  const conflicts = await findPortProcesses(unavailable, signal)
  for (const port of unavailable) {
    const owners = conflicts.filter((conflict) => conflict.port === port)
    if (owners.length === 0) {
      throw new Error(
        `本机端口 ${port} 不可绑定，无法识别占用进程；请检查端口权限或手动停止对应服务`
      )
    }
    if (owners.some((owner) => owner.pid === process.pid || owner.pid <= 4)) {
      throw new Error(`本机端口 ${port} 由 Pi Desk 自身或系统进程使用，不能强制结束；请更换端口`)
    }
  }
  // 先核对全部占用者；有任何变化时重新确认，不先结束其中一部分进程。
  if (
    conflicts.some(
      (conflict) =>
        !confirmedProcesses.some(
          (confirmed) => confirmed.port === conflict.port && confirmed.pid === conflict.pid
        )
    )
  ) {
    return conflicts
  }

  for (const pid of new Set(conflicts.map((conflict) => conflict.pid))) {
    signal?.throwIfAborted()
    const ownedPorts = conflicts.filter((conflict) => conflict.pid === pid).map((item) => item.port)
    console.info(
      `[pi-desk-remote-debug] 用户已确认，强制结束 PID ${pid}，占用端口 ${ownedPorts.join('、')}`
    )
    try {
      if (process.platform === 'win32') {
        await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          timeout: COMMAND_TIMEOUT_MS,
          signal
        })
      } else {
        process.kill(pid, 'SIGKILL')
      }
    } catch (error) {
      signal?.throwIfAborted()
      if ((await unavailablePorts(ownedPorts)).length > 0) {
        throw new Error(
          `无法结束占用端口的进程 PID ${pid}：${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  }

  const deadline = Date.now() + PORT_RELEASE_TIMEOUT_MS
  let remaining = await unavailablePorts(ports)
  while (remaining.length > 0 && Date.now() < deadline) {
    await delay(100, undefined, { signal })
    remaining = await unavailablePorts(ports)
  }
  if (remaining.length > 0) {
    throw new Error(
      `强制结束进程后，本机端口 ${remaining.join('、')} 仍不可绑定，请检查服务是否自动重启或更换端口`
    )
  }
  signal?.throwIfAborted()
  return []
}

async function unavailablePorts(ports: readonly number[]): Promise<number[]> {
  const unavailable: number[] = []
  for (const port of new Set(ports)) {
    if (!(await isLocalPortAvailable(port))) unavailable.push(port)
  }
  return unavailable
}

async function findPortProcesses(
  ports: readonly number[],
  signal?: AbortSignal
): Promise<RemoteDebugPortConflict[]> {
  try {
    if (process.platform === 'win32') {
      const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ports = @(${ports.join(',')})
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {
  $_.LocalPort -in $ports -and $_.LocalAddress -in @('127.0.0.1', '0.0.0.0', '::', '::ffff:127.0.0.1')
})
$result = @($listeners | ForEach-Object {
  $owner = Get-Process -Id $_.OwningProcess -ErrorAction Stop
  [PSCustomObject]@{ port = [int]$_.LocalPort; pid = [int]$_.OwningProcess; processName = $owner.ProcessName }
} | Sort-Object port, pid -Unique)
ConvertTo-Json -InputObject $result -Compress
`
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        {
          windowsHide: true,
          timeout: COMMAND_TIMEOUT_MS,
          signal
        }
      )
      return z
        .array(remoteDebugPortConflictSchema)
        .parse(JSON.parse(stdout.replace(/^\uFEFF/, '').trim()))
    }

    const conflicts: RemoteDebugPortConflict[] = []
    for (const port of ports) {
      let output: string
      try {
        const result = await execFileAsync(
          'lsof',
          ['-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpcn'],
          {
            timeout: COMMAND_TIMEOUT_MS,
            signal
          }
        )
        output = result.stdout
      } catch (error) {
        if ((error as { code?: unknown }).code === 1) continue
        throw error
      }
      let pid = 0
      let processName = ''
      for (const line of output.split('\n')) {
        if (line.startsWith('p')) pid = Number(line.slice(1))
        else if (line.startsWith('c')) processName = line.slice(1)
        else if (line.startsWith('n') && /^(?:\*|127\.0\.0\.1|\[::\]):\d+$/.test(line.slice(1))) {
          if (!conflicts.some((item) => item.port === port && item.pid === pid)) {
            conflicts.push(remoteDebugPortConflictSchema.parse({ port, pid, processName }))
          }
        }
      }
    }
    return conflicts
  } catch (error) {
    signal?.throwIfAborted()
    throw new Error(
      `无法查询本机端口 ${ports.join('、')} 的占用进程：${error instanceof Error ? error.message : String(error)}`
    )
  }
}
