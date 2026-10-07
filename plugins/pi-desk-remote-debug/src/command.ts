import { spawn, type ChildProcess } from 'node:child_process'
import type { RunLogger } from './log.js'
import { shellInvocation, signalProcessTree } from './process.js'

const STOP_GRACE_MS = 3000
const FORCE_STOP_WAIT_MS = 1500

export interface CommandResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  error: string | null
}

export interface ManagedCommand {
  readonly pid: number
  readonly completion: Promise<CommandResult>
  stop(): Promise<CommandResult>
}

export function startManagedCommand(input: {
  cwd: string
  command: string
  logger: RunLogger
}): ManagedCommand {
  const invocation = shellInvocation(input.command)
  input.logger.line('command', `$ ${input.command}`)
  const child = spawn(invocation.shell, invocation.args, {
    cwd: input.cwd,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    windowsHide: true
  })
  const pid = child.pid
  if (!pid) {
    child.kill()
    throw new Error('项目命令未返回进程 ID')
  }

  const stdout = bindLines(child.stdout, (line) => input.logger.line('command', line))
  const stderr = bindLines(child.stderr, (line) => input.logger.line('command:error', line))
  let settled = false
  let resolveCompletion!: (result: CommandResult) => void
  const completion = new Promise<CommandResult>((resolve) => {
    resolveCompletion = resolve
  })
  const finish = (result: CommandResult): void => {
    if (settled) return
    settled = true
    stdout.flush()
    stderr.flush()
    resolveCompletion(result)
  }

  child.once('error', (error) => {
    finish({ exitCode: null, signal: null, error: error.message })
  })
  child.once('close', (exitCode, signal) => {
    finish({ exitCode, signal, error: null })
  })

  let stopPromise: Promise<CommandResult> | null = null
  return {
    pid,
    completion,
    async stop(): Promise<CommandResult> {
      if (settled) return completion
      if (stopPromise) return stopPromise
      stopPromise = stopChild(child, pid, completion, input.logger)
      return stopPromise
    }
  }
}

async function stopChild(
  child: ChildProcess,
  pid: number,
  completion: Promise<CommandResult>,
  logger: RunLogger
): Promise<CommandResult> {
  logger.line('system', `正在停止项目命令 PID ${pid}`)
  signalProcessTree(child, pid, false)
  const graceful = await waitForCompletion(completion, STOP_GRACE_MS)
  if (graceful) return graceful

  logger.line('system', `项目命令 PID ${pid} 未及时退出，正在强制终止`)
  signalProcessTree(child, pid, true)
  const forced = await waitForCompletion(completion, FORCE_STOP_WAIT_MS)
  if (forced) return forced
  throw new Error(`项目命令 PID ${pid} 在终止请求后仍未退出`)
}

async function waitForCompletion(
  completion: Promise<CommandResult>,
  timeoutMs: number
): Promise<CommandResult | null> {
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

function bindLines(
  stream: NodeJS.ReadableStream | null,
  onLine: (line: string) => void
): { flush(): void } {
  let pending = ''
  stream?.on('data', (chunk: Buffer | string) => {
    pending += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
    const lines = pending.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (line) onLine(line)
    }
  })
  return {
    flush(): void {
      if (pending) onLine(pending)
      pending = ''
    }
  }
}
