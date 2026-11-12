import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, lstatSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { terminateManagedTree } from '../process/l4-process-tree.js'
import { L4EnvironmentValidationError } from './l4-environment-error'

export const L4_ENVIRONMENT_DESKTOP_MAX_BYTES = 1024 * 1024
export const L4_ENVIRONMENT_DESKTOP_OWNER_FILES = [
  'desktop.json',
  'desktop.lock',
  'desktop-environment.pending.json',
  'desktop-environment.transaction.json'
] as const

export function isL4EnvironmentDesktopOwnerFile(agentDir: string, path: string): boolean {
  const key = (value: string): string =>
    process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
  return L4_ENVIRONMENT_DESKTOP_OWNER_FILES.some(
    (name) => key(path) === key(join(agentDir, 'config', name))
  )
}
export const L4EnvironmentDesktopPortableSchema = z
  .object({
    version: z.literal(1),
    sourcePlatform: z.enum(['windows', 'macos', 'linux']),
    config: z
      .object({ targets: z.array(z.unknown()), tunnel: z.record(z.string(), z.unknown()) })
      .strict(),
    preferences: z
      .object({
        hideOnStartup: z.boolean().optional(),
        hideOnOpen: z.boolean(),
        showOnClose: z.boolean(),
        autoStart: z.record(z.string(), z.boolean()),
        download: z.unknown().optional()
      })
      .strict()
  })
  .strict()
export type L4EnvironmentDesktopPortable = z.infer<typeof L4EnvironmentDesktopPortableSchema>

export function canL4EnvironmentDesktop(agentDir: string): boolean {
  const executable = process.env.PI_DESK_DESKTOP_EXECUTABLE
  const config = process.env.PI_DESK_DESKTOP_CONFIG
  try {
    return (
      process.env.PI_DESK_DESKTOP_ENVIRONMENT_VERSION === '1' &&
      Boolean(
        executable &&
        config &&
        isAbsolute(executable) &&
        isAbsolute(config) &&
        resolve(config) === resolve(join(agentDir, 'config', 'desktop.json')) &&
        existsSync(executable) &&
        lstatSync(executable).isFile()
      )
    )
  } catch {
    return false
  }
}

export class L4EnvironmentNativeProcessUnreleasedError extends Error {
  constructor() {
    super('桌面环境原调用进程树未能确认释放，不能安全撤销暂存')
    this.name = 'L4EnvironmentNativeProcessUnreleasedError'
  }
}

async function closeNativeL4Environment(child: ChildProcess): Promise<void> {
  if (process.platform === 'win32') return terminateManagedTree(child)
  // Rust 环境 CLI 不创建子进程，保持在维护进程组内，父级关闭也能整体释放。
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  const closed = once(child, 'close')
  child.kill('SIGKILL')
  await closed
}

async function nativeL4Environment(
  agentDir: string,
  flag: '--environment-export' | '--environment-stage' | '--environment-cancel',
  input?: Buffer
): Promise<unknown> {
  if (!canL4EnvironmentDesktop(agentDir))
    throw new L4EnvironmentValidationError('当前桌面未声明环境迁移能力，不能导出或导入桌面配置')
  if (input && input.length > L4_ENVIRONMENT_DESKTOP_MAX_BYTES)
    throw new L4EnvironmentValidationError('桌面配置超过1MiB限制')
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.env.PI_DESK_DESKTOP_EXECUTABLE!, [flag], {
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void closeNativeL4Environment(child).then(
        () => {
          if (error) reject(error)
          else {
            try {
              resolveResult(JSON.parse(Buffer.concat(chunks).toString('utf8')))
            } catch {
              reject(new Error('桌面环境响应格式无效'))
            }
          }
        },
        () => reject(new L4EnvironmentNativeProcessUnreleasedError())
      )
    }
    const timer = setTimeout(() => finish(new Error('桌面环境调用超时，结果未确认')), 15_000)
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > L4_ENVIRONMENT_DESKTOP_MAX_BYTES + 1) finish(new Error('桌面环境响应超过容量限制'))
      else chunks.push(chunk)
    })
    child.stderr.resume()
    child.stdin.on('error', () => finish(new Error('桌面环境stdin交付失败，结果未确认')))
    child.once('error', () => finish(new Error('桌面环境进程无法启动')))
    child.once('close', (code) => finish(code === 0 ? undefined : new Error('桌面环境操作失败')))
    child.stdin.end(input)
  })
}

export async function exportL4EnvironmentDesktop(agentDir: string): Promise<Buffer> {
  const portable = L4EnvironmentDesktopPortableSchema.parse(
    await nativeL4Environment(agentDir, '--environment-export')
  )
  const content = Buffer.from(JSON.stringify(portable))
  if (content.length > L4_ENVIRONMENT_DESKTOP_MAX_BYTES)
    throw new L4EnvironmentValidationError('桌面portable配置超过1MiB限制')
  return content
}

export function encodeL4EnvironmentDesktopStage(operationId: string, content: Buffer): Buffer {
  const environment = L4EnvironmentDesktopPortableSchema.parse(JSON.parse(content.toString('utf8')))
  z.string().uuid().parse(operationId)
  const payload = Buffer.from(JSON.stringify({ operationId, environment }))
  if (payload.length > L4_ENVIRONMENT_DESKTOP_MAX_BYTES)
    throw new L4EnvironmentValidationError('桌面暂存请求含操作UUID后超过1MiB限制')
  return payload
}

export async function stageL4EnvironmentDesktop(
  agentDir: string,
  operationId: string,
  content: Buffer
): Promise<void> {
  const payload = encodeL4EnvironmentDesktopStage(operationId, content)
  const response = z
    .object({ restartRequired: z.literal(true), operationId: z.string().uuid() })
    .strict()
    .parse(await nativeL4Environment(agentDir, '--environment-stage', payload))
  if (response.operationId !== operationId)
    throw new Error('桌面暂存响应未关联当前操作，结果未确认')
}

export async function cancelL4EnvironmentDesktop(
  agentDir: string,
  operationId: string
): Promise<boolean> {
  z.string().uuid().parse(operationId)
  const response = z
    .object({ cancelled: z.boolean() })
    .strict()
    .parse(
      await nativeL4Environment(
        agentDir,
        '--environment-cancel',
        Buffer.from(JSON.stringify({ operationId }))
      )
    )
  return response.cancelled
}
