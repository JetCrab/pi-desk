import 'server-only'

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { terminateL4PiProcessTree } from './l4-pi-process-tree'

interface L4PiRunnerProcessResult {
  stdout: string
  stderr: string
  code: number | null
}

export function runL4PiRunnerProcess(input: {
  args: string[]
  agentDir: string
  env: Record<string, string | undefined>
  maxOutputBytes: number
  timeoutMs: number
  timeoutError: () => Error
  cleanupError: (stderr: string, error: unknown) => Error
}): Promise<L4PiRunnerProcessResult> {
  return new Promise<L4PiRunnerProcessResult>((resolveRun, rejectRun) => {
    const runtimeImport = pathToFileURL(
      join(process.cwd(), 'src/server/l4_foundation/pi/l4-pi-runtime-register.mjs')
    ).href
    const child = spawn(process.execPath, ['--import', runtimeImport, ...input.args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: input.agentDir,
        PI_CODING_AGENT_SESSION_DIR: join(input.agentDir, 'sessions'),
        TSX_TSCONFIG_PATH: join(process.cwd(), 'tsconfig.json'),
        ...input.env
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32'
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null

    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      void terminateL4PiProcessTree(child).then(callback, (error: unknown) => {
        rejectRun(input.cleanupError(stderr.trim(), error))
      })
    }
    const append = (current: string, chunk: Buffer): string =>
      `${current}${chunk.toString('utf8')}`.slice(-input.maxOutputBytes)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk)
    })
    child.once('error', (error) => finish(() => rejectRun(error)))
    child.once('close', (code) => finish(() => resolveRun({ stdout, stderr, code })))
    timeout = setTimeout(() => {
      const error = input.timeoutError()
      const output = `${stderr}\n${stdout}`.trim().slice(-4000)
      if (output) error.message += `\n${output}`
      finish(() => rejectRun(error))
    }, input.timeoutMs)
    timeout.unref()
  })
}
