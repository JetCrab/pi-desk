import { spawn as nodeSpawn, spawnSync, type SpawnOptions } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream, existsSync, type WriteStream } from 'node:fs'
import { mkdir, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import {
  formatSize,
  type ExtensionAPI,
  type ExtensionContext
} from '@earendil-works/pi-coding-agent'
import {
  bindSessionPlugin,
  type SessionPluginFacade,
  type TaskHandle,
  type TaskInfoItem
} from '@jetcrab/pi-desk-sdk/session'

export const MAX_OUTPUT_BYTES = 20 * 1024 * 1024
export const MAX_RECENT_TASKS = 100
export const MAX_TASK_ARTIFACTS = 100

const KILL_GRACE_MS = 3000
const FORCE_KILL_WAIT_MS = 1500
const COMPLETION_CUSTOM_TYPE = 'pi-desk-bg-run:completion:v1'
const WINDOWS_NODE_PACKAGE_MANAGERS = ['npm', 'npx', 'pnpm', 'yarn']

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted'

type StopReason = 'user' | 'timeout' | 'output-limit' | 'write-error' | 'shutdown'

type ProcessOutput = {
  on(event: 'data', listener: (data: Buffer | string) => void): unknown
  destroy?(): void
}

export type BackgroundTaskChild = {
  pid?: number
  stdout?: ProcessOutput | null
  stderr?: ProcessOutput | null
  kill(signal?: NodeJS.Signals | number): boolean
  on(event: 'error', listener: (error: Error) => void): unknown
  on(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): unknown
}

type BackgroundTaskSpawn = (
  command: string,
  args: string[],
  options: SpawnOptions
) => BackgroundTaskChild

export interface StartBackgroundTaskInput {
  name: string
  command: string
  timeoutSeconds?: number
}

export interface BackgroundTaskSnapshot {
  taskId: string
  name: string
  command: string
  status: BackgroundTaskStatus
  outputPath: string
  startedAt: number
  endedAt: number | null
  pid: number | null
  exitCode: number | null
  signal: string | null
  bytesWritten: number
  timeoutSeconds: number | null
  error: string | null
}

type ActiveSession = {
  cwd: string
  sessionId: string
}

type BackgroundTask = {
  taskId: string
  name: string
  command: string
  status: BackgroundTaskStatus
  outputPath: string
  outputAbsPath: string
  startedAt: number
  endedAt: number | null
  pid: number | null
  exitCode: number | null
  signal: string | null
  bytesWritten: number
  timeoutSeconds: number | null
  error: string | null
  stopReason: StopReason | null
  stopPromise: Promise<void> | null
  child: BackgroundTaskChild | null
  stream: WriteStream | null
  timeoutHandle: NodeJS.Timeout | null
  taskHandle: TaskHandle | null
  finalized: boolean
  settled: Promise<void>
  resolveSettled: () => void
}

type ArtifactEntry = {
  taskDir: string
  sessionDir: string
  mtimeMs: number
}

function normalizeTaskName(value: string): string {
  const normalized = stripMatchingQuotes(value).replace(/\s+/g, ' ').trim()
  if (!normalized) throw new Error('name 不能为空')
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 79)}…`
}

function normalizeCommand(value: string): string {
  const command = stripMatchingQuotes(value).trim()
  if (!command) throw new Error('command 不能为空')
  return command
}

function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length < 2) return trimmed
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function safePathPart(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, '-')
  return safe.replace(/^-+|-+$/g, '') || 'session'
}

function makeTaskId(): string {
  return `bg-${randomBytes(4).toString('hex')}`
}

function launchesPiAgent(command: string): boolean {
  return /(^|[\s;&|()])pi(?=\s)(?=[^\n;&|]*(?:\s-p(?:\s|$)|\s--print(?:\s|$)|\s--mode(?:=|\s+)json\b))/m.test(
    command
  )
}

function windowsCommandShimPrelude(): string {
  return WINDOWS_NODE_PACKAGE_MANAGERS.map(
    (name) =>
      `if command -v ${name}.cmd >/dev/null 2>&1; then ${name}() { command ${name}.cmd "$@"; }; fi`
  ).join('\n')
}

export function shellInvocation(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env
): { shell: string; args: string[] } {
  if (platform === 'win32') {
    return {
      shell: 'bash.exe',
      args: ['-c', `${windowsCommandShimPrelude()}\n${command}`]
    }
  }
  return {
    shell: env.SHELL || '/bin/sh',
    args: ['-c', command]
  }
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${milliseconds}ms`
  const seconds = Math.floor(milliseconds / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return `${minutes}m${remainingSeconds ? `${remainingSeconds}s` : ''}`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}h${remainingMinutes ? `${remainingMinutes}m` : ''}`
}

function statusIcon(status: BackgroundTaskStatus): string {
  switch (status) {
    case 'running':
      return '▶'
    case 'completed':
      return '✓'
    case 'failed':
      return '✗'
    case 'stopped':
      return '■'
    case 'interrupted':
      return '‖'
  }
}

function terminalActivity(task: BackgroundTask): string {
  switch (task.status) {
    case 'completed':
      return '执行完成'
    case 'failed':
      return task.error ?? '执行失败'
    case 'stopped':
      return '已停止'
    case 'interrupted':
      return '父会话已关闭'
    case 'running':
      return '运行中'
  }
}

function taskSnapshot(task: BackgroundTask): BackgroundTaskSnapshot {
  return {
    taskId: task.taskId,
    name: task.name,
    command: task.command,
    status: task.status,
    outputPath: task.outputPath,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    pid: task.pid,
    exitCode: task.exitCode,
    signal: task.signal,
    bytesWritten: task.bytesWritten,
    timeoutSeconds: task.timeoutSeconds,
    error: task.error
  }
}

function taskInfo(task: BackgroundTask): TaskInfoItem[] {
  const processInfo =
    task.status === 'running'
      ? task.pid === null
        ? '正在启动'
        : `PID ${task.pid}`
      : task.exitCode !== null
        ? `exit ${task.exitCode}`
        : (task.signal ?? task.status)
  const info: TaskInfoItem[] = [
    { label: '进程', value: processInfo },
    { label: '输出', value: `${formatSize(task.bytesWritten)} · ${task.outputPath}` }
  ]
  if (task.timeoutSeconds !== null) {
    info.push({ label: '超时', value: `${task.timeoutSeconds}s` })
  }
  return info
}

function formatTaskList(tasks: readonly BackgroundTaskSnapshot[], now = Date.now()): string {
  if (tasks.length === 0) return '当前 Session 没有后台任务。'
  return tasks
    .map((task) => {
      const duration = formatDuration((task.endedAt ?? now) - task.startedAt)
      const pid = task.pid === null ? '' : ` pid=${task.pid}`
      const exit = task.exitCode === null ? '' : ` exit=${task.exitCode}`
      const error = task.error ? ` error=${task.error}` : ''
      return `${statusIcon(task.status)} ${task.taskId} ${task.status} ${duration}${pid}${exit} — ${task.name}${error}\n    output: ${task.outputPath}`
    })
    .join('\n')
}

async function closeStream(stream: WriteStream | null): Promise<void> {
  if (!stream || stream.closed || stream.destroyed) return
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    stream.once('close', finish)
    stream.once('error', finish)
    stream.end(finish)
  })
}

async function artifactEntries(root: string): Promise<ArtifactEntry[]> {
  if (!existsSync(root)) return []
  const entries: ArtifactEntry[] = []
  const sessions = await readdir(root, { withFileTypes: true })
  for (const session of sessions) {
    if (!session.isDirectory()) continue
    const sessionDir = join(root, session.name)
    const tasks = await readdir(sessionDir, { withFileTypes: true }).catch(() => [])
    for (const task of tasks) {
      if (!task.isDirectory()) continue
      const taskDir = join(sessionDir, task.name)
      const outputPath = join(taskDir, 'output.log')
      const stats = await stat(existsSync(outputPath) ? outputPath : taskDir).catch(() => undefined)
      if (!stats) continue
      entries.push({ taskDir, sessionDir, mtimeMs: stats.mtimeMs })
    }
  }
  return entries
}

export async function pruneTaskArtifacts(
  root: string,
  protectedTaskDirs: ReadonlySet<string>,
  maxArtifacts = MAX_TASK_ARTIFACTS
): Promise<void> {
  const entries = (await artifactEntries(root)).sort((left, right) => left.mtimeMs - right.mtimeMs)
  let remaining = entries.length
  for (const entry of entries) {
    if (remaining <= maxArtifacts) break
    if (protectedTaskDirs.has(entry.taskDir)) continue
    await rm(entry.taskDir, { recursive: true, force: true })
    await rmdir(entry.sessionDir).catch(() => undefined)
    remaining -= 1
  }
}

export class BackgroundTaskRuntime {
  private readonly sessionPlugin: SessionPluginFacade
  private readonly tasks = new Map<string, BackgroundTask>()
  private activeSession: ActiveSession | null = null
  private shuttingDown = false
  private pruneQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly spawn: BackgroundTaskSpawn = (command, args, options) =>
      nodeSpawn(command, args, options) as unknown as BackgroundTaskChild
  ) {
    this.sessionPlugin = bindSessionPlugin(pi, 'bg-run')
  }

  startSession(ctx: ExtensionContext): void {
    this.activeSession = {
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId()
    }
    this.shuttingDown = false
    this.tasks.clear()
  }

  async beforeTree(signal: AbortSignal): Promise<{ cancel: true } | undefined> {
    if (signal.aborted) return { cancel: true }
    this.shuttingDown = true
    // 新引用只失效尚在准备日志目录的启动；保留现有任务映射和控制权。
    if (this.activeSession) this.activeSession = { ...this.activeSession }
    try {
      const results = await this.stopAndWait()
      const failure = results.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
      return signal.aborted ? { cancel: true } : undefined
    } finally {
      this.shuttingDown = false
    }
  }

  private async stopAndWait(): Promise<PromiseSettledResult<void>[]> {
    const running = [...this.tasks.values()].filter((task) => task.status === 'running')
    const results = await Promise.allSettled(
      running.map((task) => this.stopTask(task, 'shutdown', '父会话已关闭'))
    )
    await Promise.all(
      [...this.tasks.values()].filter((task) => task.finalized).map((task) => task.settled)
    )
    return results
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    const running = [...this.tasks.values()].filter((task) => task.status === 'running')
    const results = await this.stopAndWait()
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') continue
      const task = running[index]
      console.error(
        `[pi-desk-bg-run] 关闭任务 ${task?.taskId ?? 'unknown'} 失败：${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
      )
    }
    this.activeSession = null
    await this.pruneQueue
  }

  async startTask(
    ctx: ExtensionContext,
    input: StartBackgroundTaskInput
  ): Promise<BackgroundTaskSnapshot> {
    const session = this.requireSession(ctx)
    if (this.shuttingDown) throw new Error('父会话正在关闭，不能启动后台任务')

    const name = normalizeTaskName(input.name)
    const command = normalizeCommand(input.command)
    if (launchesPiAgent(command)) {
      throw new Error('后台子代理请使用 agent；bg_run 不启动 Pi Agent')
    }
    const timeoutSeconds =
      input.timeoutSeconds === undefined
        ? null
        : Number.isInteger(input.timeoutSeconds) && input.timeoutSeconds > 0
          ? input.timeoutSeconds
          : null
    if (input.timeoutSeconds !== undefined && timeoutSeconds === null) {
      throw new Error('timeoutSeconds 必须是正整数')
    }

    let taskId = makeTaskId()
    while (this.tasks.has(taskId)) taskId = makeTaskId()
    const root = join(session.cwd, 'temp', 'pi', 'pi-desk-bg-run')
    const taskDir = join(root, safePathPart(session.sessionId), taskId)
    const outputAbsPath = join(taskDir, 'output.log')
    const outputPath = relative(session.cwd, outputAbsPath)
    await mkdir(taskDir, { recursive: true })
    const header = `[Command]\n${command}\n\n[Output]\n`
    await writeFile(outputAbsPath, header, 'utf8')
    if (this.shuttingDown || this.activeSession !== session) {
      await rm(taskDir, { recursive: true, force: true })
      throw new Error('父会话已关闭，后台任务未启动')
    }

    let resolveSettled = (): void => undefined
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve
    })
    const task: BackgroundTask = {
      taskId,
      name,
      command,
      status: 'running',
      outputPath,
      outputAbsPath,
      startedAt: Date.now(),
      endedAt: null,
      pid: null,
      exitCode: null,
      signal: null,
      bytesWritten: Buffer.byteLength(header),
      timeoutSeconds,
      error: null,
      stopReason: null,
      stopPromise: null,
      child: null,
      stream: createWriteStream(outputAbsPath, { flags: 'a' }),
      timeoutHandle: null,
      taskHandle: null,
      finalized: false,
      settled,
      resolveSettled
    }
    this.tasks.set(taskId, task)

    try {
      task.taskHandle = this.sessionPlugin.startTask({
        taskId,
        taskKind: '后台任务',
        taskType: 'Shell',
        title: name,
        info: taskInfo(task),
        activity: '正在启动',
        startedAt: task.startedAt,
        detailSource: { kind: 'text-file', path: outputAbsPath },
        interrupt: async () => {
          await this.stopTask(task, 'user')
        }
      })
      const outputStream = task.stream
      if (!outputStream) throw new Error('后台任务输出流创建失败')
      outputStream.on('error', (error) => {
        if (task.status !== 'running' || task.finalized) return
        task.error = `输出文件写入失败：${error.message}`
        void this.stopTask(task, 'write-error', task.error).catch((stopError) => {
          console.error(
            `[pi-desk-bg-run] 写入失败后无法停止任务 ${task.taskId}：${stopError instanceof Error ? stopError.message : String(stopError)}`
          )
        })
      })

      const invocation = shellInvocation(command)
      const child = this.spawn(invocation.shell, invocation.args, {
        cwd: session.cwd,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
        windowsHide: true
      })
      task.child = child
      task.pid = child.pid ?? null
      child.stdout?.on('data', (data) => this.appendOutput(task, data))
      child.stderr?.on('data', (data) => this.appendOutput(task, data))
      child.on('error', (error) => {
        void this.finalizeTask(task, 'failed', null, null, error.message)
      })
      child.on('close', (code, signal) => {
        void this.finalizeFromClose(task, code, signal)
      })
      task.taskHandle.update({ activity: '运行中', info: taskInfo(task) })

      if (timeoutSeconds !== null) {
        task.timeoutHandle = setTimeout(() => {
          const message = `运行超过 ${timeoutSeconds}s，正在终止`
          void this.stopTask(task, 'timeout', message).catch((error) => {
            task.error = `${message}；终止失败：${error instanceof Error ? error.message : String(error)}`
            task.taskHandle?.update({ activity: task.error, info: taskInfo(task) })
            console.error(`[pi-desk-bg-run] ${task.error}`)
          })
        }, timeoutSeconds * 1000)
        task.timeoutHandle.unref?.()
      }

      this.scheduleArtifactPrune(root)
      return taskSnapshot(task)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.finalizeTask(task, 'failed', null, null, message, false)
      throw new Error(`后台任务启动失败：${message}`)
    }
  }

  listTasks(ctx: ExtensionContext, taskId?: string): BackgroundTaskSnapshot[] {
    this.requireSession(ctx)
    const tasks = taskId ? [this.resolveTask(taskId)] : [...this.tasks.values()]
    return tasks
      .sort((left, right) => left.startedAt - right.startedAt)
      .map((task) => taskSnapshot(task))
  }

  async stopTaskById(ctx: ExtensionContext, taskId: string): Promise<BackgroundTaskSnapshot> {
    this.requireSession(ctx)
    const task = this.resolveTask(taskId)
    if (task.status !== 'running') {
      throw new Error(`任务 ${task.taskId} 当前状态为 ${task.status}`)
    }
    await this.stopTask(task, 'user')
    return taskSnapshot(task)
  }

  formatTasks(tasks: readonly BackgroundTaskSnapshot[]): string {
    return formatTaskList(tasks)
  }

  private requireSession(ctx: ExtensionContext): ActiveSession {
    const session = this.activeSession
    if (
      !session ||
      session.cwd !== ctx.cwd ||
      session.sessionId !== ctx.sessionManager.getSessionId()
    ) {
      throw new Error('当前 Pi Session 已变化')
    }
    return session
  }

  private resolveTask(taskIdOrPrefix: string): BackgroundTask {
    const query = taskIdOrPrefix.trim()
    if (!query) throw new Error('taskId 不能为空')
    const exact = this.tasks.get(query)
    if (exact) return exact
    const matches = [...this.tasks.values()].filter((task) => task.taskId.startsWith(query))
    if (matches.length === 0) throw new Error(`未知后台任务：${taskIdOrPrefix}`)
    if (matches.length > 1) throw new Error(`taskId 前缀不唯一：${taskIdOrPrefix}`)
    return matches[0]!
  }

  private appendOutput(task: BackgroundTask, data: Buffer | string): void {
    if (task.status !== 'running' || !task.stream || task.stream.destroyed) return
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
    if (buffer.length === 0) return
    const remaining = MAX_OUTPUT_BYTES - task.bytesWritten
    if (remaining > 0) {
      const written = buffer.subarray(0, Math.min(remaining, buffer.length))
      task.stream.write(written)
      task.bytesWritten += written.length
    }
    if (buffer.length <= remaining || task.stopReason === 'output-limit') return

    task.error = `输出超过 ${formatSize(MAX_OUTPUT_BYTES)} 上限`
    void this.stopTask(task, 'output-limit', task.error).catch((error) => {
      task.error = `${task.error}；终止失败：${error instanceof Error ? error.message : String(error)}`
      task.taskHandle?.update({ activity: task.error, info: taskInfo(task) })
      console.error(`[pi-desk-bg-run] ${task.error}`)
    })
  }

  private async stopTask(task: BackgroundTask, reason: StopReason, error?: string): Promise<void> {
    if (task.status !== 'running' || task.finalized) return
    if (reason === 'shutdown' || task.stopReason === null) task.stopReason = reason
    if (error) task.error = error
    const activity =
      reason === 'user'
        ? '正在停止'
        : reason === 'shutdown'
          ? '父会话关闭，正在终止'
          : (task.error ?? '正在终止')
    task.taskHandle?.update({ activity, info: taskInfo(task) })

    if (task.stopPromise) {
      await task.stopPromise
      return
    }
    const stopPromise = this.performStop(task)
    task.stopPromise = stopPromise
    try {
      await stopPromise
    } finally {
      if (task.stopPromise === stopPromise) task.stopPromise = null
    }
  }

  private async performStop(task: BackgroundTask): Promise<void> {
    this.killProcessTree(task, false)
    if (await this.waitForSettlement(task, KILL_GRACE_MS)) return
    this.killProcessTree(task, true)
    if (await this.waitForSettlement(task, FORCE_KILL_WAIT_MS)) return
    throw new Error(`任务 ${task.taskId} 在终止请求后仍未退出`)
  }

  private killProcessTree(task: BackgroundTask, force: boolean): void {
    const child = task.child
    const pid = task.pid
    if (!child || pid === null) throw new Error(`任务 ${task.taskId} 尚未取得进程句柄`)

    if (process.platform === 'win32') {
      const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      })
      if (!result.error && result.status === 0) {
        child.stdout?.destroy?.()
        child.stderr?.destroy?.()
        return
      }
    } else {
      try {
        process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM')
        return
      } catch {
        // 进程组不可用时回退到直接终止子进程。
      }
    }

    const killed = child.kill(force ? 'SIGKILL' : 'SIGTERM')
    if (!killed) throw new Error(`无法终止任务 ${task.taskId} 的进程树`)
  }

  private waitForSettlement(task: BackgroundTask, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let finished = false
      const complete = (settled: boolean): void => {
        if (finished) return
        finished = true
        clearTimeout(timeout)
        resolve(settled)
      }
      const timeout = setTimeout(() => complete(false), timeoutMs)
      timeout.unref?.()
      void task.settled.then(() => complete(true))
    })
  }

  private async finalizeFromClose(
    task: BackgroundTask,
    exitCode: number | null,
    signal: NodeJS.Signals | null
  ): Promise<void> {
    if (task.stopReason === 'user') {
      await this.finalizeTask(task, 'stopped', exitCode, signal, null)
      return
    }
    if (task.stopReason === 'shutdown') {
      await this.finalizeTask(task, 'interrupted', exitCode, signal, task.error)
      return
    }
    if (
      task.stopReason === 'timeout' ||
      task.stopReason === 'output-limit' ||
      task.stopReason === 'write-error'
    ) {
      await this.finalizeTask(task, 'failed', exitCode, signal, task.error)
      return
    }
    if ((exitCode ?? 0) === 0) {
      await this.finalizeTask(task, 'completed', exitCode, signal, null)
      return
    }
    const error = `进程退出码 ${exitCode ?? 'null'}${signal ? `，signal ${signal}` : ''}`
    await this.finalizeTask(task, 'failed', exitCode, signal, error)
  }

  private async finalizeTask(
    task: BackgroundTask,
    status: Exclude<BackgroundTaskStatus, 'running'>,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    error: string | null,
    notify = true
  ): Promise<void> {
    if (task.finalized) return
    task.finalized = true
    if (task.timeoutHandle) clearTimeout(task.timeoutHandle)
    task.timeoutHandle = null
    task.status = status
    task.endedAt = Date.now()
    task.exitCode = exitCode
    task.signal = signal
    if (error) task.error = error
    await closeStream(task.stream)
    task.stream = null
    task.child = null

    const handle = task.taskHandle
    if (handle && this.tasks.get(task.taskId) === task) {
      try {
        handle.update({ info: taskInfo(task) })
        const activity = terminalActivity(task)
        if (status === 'completed') handle.complete(activity)
        else if (status === 'failed') handle.fail(activity)
        else if (status === 'stopped') handle.stopped(activity)
        else handle.interrupted(activity)
      } catch (taskError) {
        console.error(
          `[pi-desk-bg-run] 上报任务 ${task.taskId} 终态失败：${taskError instanceof Error ? taskError.message : String(taskError)}`
        )
      }
    }

    task.resolveSettled()
    task.resolveSettled = (): void => undefined
    if (notify && task.stopReason !== 'user' && task.stopReason !== 'shutdown') {
      this.notifyCompletion(task)
    }
    this.pruneRecentTasks()
    const session = this.activeSession
    if (session) {
      this.scheduleArtifactPrune(join(session.cwd, 'temp', 'pi', 'pi-desk-bg-run'))
    }
  }

  private notifyCompletion(task: BackgroundTask): void {
    if (this.shuttingDown || !this.activeSession || this.tasks.get(task.taskId) !== task) {
      return
    }
    const snapshot = taskSnapshot(task)
    const outcome =
      task.status === 'completed' ? '已完成' : task.status === 'failed' ? '执行失败' : '已结束'
    const content = [
      `后台任务${outcome}。`,
      '',
      `Task ID: ${task.taskId}`,
      `Name: ${task.name}`,
      `Status: ${task.status}`,
      task.exitCode === null ? '' : `Exit Code: ${task.exitCode}`,
      `Output: ${task.outputPath}`,
      task.error ? `Error: ${task.error}` : ''
    ]
      .filter((line, index) => line !== '' || index === 1)
      .join('\n')
    try {
      this.pi.sendMessage(
        {
          customType: COMPLETION_CUSTOM_TYPE,
          content,
          display: true,
          details: snapshot
        },
        { deliverAs: 'steer', triggerTurn: false }
      )
    } catch (error) {
      console.warn(
        `[pi-desk-bg-run] 任务 ${task.taskId} 完成通知失败：${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  private pruneRecentTasks(): void {
    const terminal = [...this.tasks.values()]
      .filter((task) => task.status !== 'running')
      .sort((left, right) => (left.endedAt ?? left.startedAt) - (right.endedAt ?? right.startedAt))
    while (terminal.length > MAX_RECENT_TASKS) {
      const task = terminal.shift()
      if (!task) return
      this.tasks.delete(task.taskId)
      try {
        task.taskHandle?.remove()
      } catch (error) {
        console.warn(
          `[pi-desk-bg-run] 移除旧任务 ${task.taskId} 失败：${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  }

  private scheduleArtifactPrune(root: string): void {
    this.pruneQueue = this.pruneQueue
      .then(async () => {
        const protectedTaskDirs = new Set(
          [...this.tasks.values()].map((task) => dirname(task.outputAbsPath))
        )
        await pruneTaskArtifacts(root, protectedTaskDirs)
      })
      .catch((error) => {
        console.warn(
          `[pi-desk-bg-run] 清理旧任务日志失败：${error instanceof Error ? error.message : String(error)}`
        )
      })
  }
}
