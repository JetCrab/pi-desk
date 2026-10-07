import { randomBytes } from 'node:crypto'
import { createConnection } from 'node:net'
import { realpath } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { PiDeskPluginFacade, PluginWorkSession } from '@jetcrab/pi-desk-sdk/entry'
import {
  readRemoteDebugConfig,
  type RemoteDebugConfig,
  type RemoteDebugProfile,
  type RemoteDebugRoute
} from './config.js'
import { assertLocalPortsAvailable } from './l4-remote-debug-ports.js'
import { RemoteDebugSettingsStore } from './l4-remote-debug-settings.js'
import { startManagedCommand, type CommandResult, type ManagedCommand } from './command.js'
import { startDebugGateway, type DebugGatewayHandle } from './gateway.js'
import { pruneRunArtifacts, RunLogger } from './log.js'
import {
  startTunnelClient,
  type ManagedTunnelClient,
  type TunnelClientResult
} from './tunnel-client.js'

const ENTRY_READY_TIMEOUT_MS = 60_000
const ENTRY_READY_POLL_MS = 250
const MAX_RECENT_RUNS = 20

export type RemoteDebugRunStatus =
  'starting' | 'running' | 'stopping' | 'completed' | 'failed' | 'stopped'

export interface RemoteDebugRun {
  runId: string
  cwd: string
  profile: string
  status: RemoteDebugRunStatus
  activity: string
  startedAt: number
  endedAt: number | null
  publicUrl: string | null
  localUrl: string | null
  logPath: string
  failure: { message: string } | null
}

export interface RemoteDebugProjectProfile {
  name: string
  description: string
  command: string
  entryPort: number
  publicPort: number
  routes: RemoteDebugRoute[]
}

export interface RemoteDebugProject {
  cwd: string
  label: string
  status: 'ready' | 'invalid' | 'unconfigured'
  error: string | null
  profiles: RemoteDebugProjectProfile[]
}

interface RuntimeDependencies {
  startCommand: typeof startManagedCommand
  startGateway: typeof startDebugGateway
  startTunnel: typeof startTunnelClient
  waitForPort(port: number, signal: AbortSignal): Promise<void>
  createLogger(path: string, command: string): Promise<RunLogger>
  settingsStore: RemoteDebugSettingsStore
  assertPortsAvailable(ports: readonly number[]): Promise<void>
}

interface ActiveRun {
  run: RemoteDebugRun
  profile: RemoteDebugProfile
  tunnelServer: string | null
  runDirectory: string
  logger: RunLogger
  abort: AbortController
  stopRequested: boolean
  command: ManagedCommand | null
  gateway: DebugGatewayHandle | null
  tunnel: ManagedTunnelClient | null
  execution: Promise<void>
}

type RunOutcome = {
  status: 'completed' | 'failed' | 'stopped'
  activity: string
  failure: string | null
}

type StageResult<T> =
  { kind: 'ready'; value: T } | { kind: 'command'; result: CommandResult } | { kind: 'aborted' }

export class RemoteDebugRuntime {
  private readonly runs = new Map<string, RemoteDebugRun>()
  private readonly active = new Map<string, ActiveRun>()
  private readonly dependencies: RuntimeDependencies
  private disposed = false
  private pruneQueue: Promise<void> = Promise.resolve()
  private startQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly plugin: PiDeskPluginFacade,
    dependencies: Partial<RuntimeDependencies> = {}
  ) {
    this.dependencies = {
      startCommand: dependencies.startCommand ?? startManagedCommand,
      startGateway: dependencies.startGateway ?? startDebugGateway,
      startTunnel: dependencies.startTunnel ?? startTunnelClient,
      waitForPort: dependencies.waitForPort ?? waitForTcpPort,
      createLogger: dependencies.createLogger ?? RunLogger.create,
      settingsStore: dependencies.settingsStore ?? new RemoteDebugSettingsStore(),
      assertPortsAvailable: dependencies.assertPortsAvailable ?? assertLocalPortsAvailable
    }
    this.publishState()
  }

  async catalog(workSessionsInput?: readonly PluginWorkSession[]): Promise<RemoteDebugProject[]> {
    const workSessions =
      workSessionsInput ?? (await this.plugin.host.workSessions.listWorkSessions())
    const candidates = [
      ...workSessions.map((session) => session.cwd),
      ...[...this.runs.values()].map((run) => run.cwd),
      ...(await this.dependencies.settingsStore.projectCwds())
    ]
    const cwds = await Promise.all(
      candidates.map(async (cwd) => realpath(cwd).catch(() => resolve(cwd)))
    )
    const uniqueCwds = new Map<string, string>()
    for (const cwd of cwds) {
      uniqueCwds.set(projectCwdKey(cwd), cwd)
    }
    return Promise.all(
      [...uniqueCwds.values()].map((cwd) =>
        loadRemoteDebugProject(cwd, this.dependencies.settingsStore)
      )
    )
  }

  state(): { runs: RemoteDebugRun[] } {
    return { runs: [...this.runs.values()].map((run) => structuredClone(run)) }
  }

  start(cwd: string, profileName: string): Promise<{ runId: string }> {
    // 串行直到 active 登记，包含 logger 的异步准备；dispose 不等待准备队列。
    const pending = this.startQueue.then(() => this.prepareStart(cwd, profileName))
    this.startQueue = pending.then(
      () => undefined,
      () => undefined
    )
    return pending
  }

  private async prepareStart(cwd: string, profileName: string): Promise<{ runId: string }> {
    if (this.disposed) throw new Error('Remote Debug Runtime 已关闭')
    cwd = await realpath(cwd)
    await this.dependencies.settingsStore.syncProject(cwd)
    const settings = await this.dependencies.settingsStore.get()
    const config = await readRemoteDebugConfig(cwd)
    if (this.disposed) throw new Error('Remote Debug Runtime 已关闭')
    if (!config) throw new Error('项目没有 .pi/remote_debug.yaml')
    const profile = config.profiles[profileName]
    if (!profile) throw new Error(`调试配置不存在：${profileName}`)
    if (
      [...this.active.values()].some(
        (active) =>
          projectCwdKey(active.run.cwd) === projectCwdKey(cwd) && active.run.profile === profileName
      )
    ) {
      throw new Error(`调试配置正在运行：${profileName}`)
    }
    const portOwner = [...this.active.values()].find(
      (active) =>
        active.tunnelServer === settings.tunnelServer &&
        active.profile.publicPort === profile.publicPort
    )
    if (portOwner) {
      throw new Error(`公网端口 ${profile.publicPort} 正在被 ${portOwner.run.profile} 使用`)
    }

    const ports = profilePorts(profile)
    for (const active of this.active.values()) {
      const overlap = profilePorts(active.profile).find((port) => ports.includes(port))
      if (overlap !== undefined) {
        throw new Error(`本机端口 ${overlap} 正在被 ${active.run.profile} 使用`)
      }
    }
    await this.dependencies.assertPortsAvailable(ports)
    if (this.disposed) throw new Error('Remote Debug Runtime 已关闭')

    const runId = makeRunId()
    const runDirectory = join(cwd, 'temp', 'pi', 'remote-debug', runId)
    const logPath = join(runDirectory, 'run.log')
    const logger = await this.dependencies.createLogger(logPath, profile.command)
    const run: RemoteDebugRun = {
      runId,
      cwd,
      profile: profileName,
      status: 'starting',
      activity: '正在启动项目命令',
      startedAt: Date.now(),
      endedAt: null,
      publicUrl: null,
      localUrl: null,
      logPath,
      failure: null
    }
    const active: ActiveRun = {
      run,
      profile,
      tunnelServer: settings.tunnelServer,
      runDirectory,
      logger,
      abort: new AbortController(),
      stopRequested: false,
      command: null,
      gateway: null,
      tunnel: null,
      execution: Promise.resolve()
    }
    try {
      if (this.disposed) throw new Error('Remote Debug Runtime 已关闭')
      this.runs.set(runId, run)
      this.active.set(runId, active)
      this.publishState()
    } catch (error) {
      this.active.delete(runId)
      this.runs.delete(runId)
      await logger.close()
      throw error
    }
    active.execution = this.execute(active)
    this.scheduleArtifactPrune(cwd)
    return { runId }
  }

  async stop(runId: string): Promise<RemoteDebugRun> {
    const active = this.active.get(runId)
    if (!active) {
      const run = this.runs.get(runId)
      if (run) return structuredClone(run)
      throw new Error(`Remote Debug Run 不存在：${runId}`)
    }
    if (!active.stopRequested) {
      active.stopRequested = true
      active.run.status = 'stopping'
      active.run.activity = '正在停止'
      this.publishState()
      active.abort.abort()
    }
    await active.execution
    return structuredClone(this.runs.get(runId) ?? active.run)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const active of this.active.values()) {
      active.stopRequested = true
      active.run.status = 'stopping'
      active.run.activity = '插件关闭，正在停止'
      active.abort.abort()
    }
    await Promise.allSettled([...this.active.values()].map((active) => active.execution))
    await this.pruneQueue
    this.active.clear()
    this.runs.clear()
  }

  private async execute(active: ActiveRun): Promise<void> {
    let outcome: RunOutcome = {
      status: 'failed',
      activity: '远程调试启动失败',
      failure: '远程调试启动失败'
    }
    try {
      active.logger.line('system', `启动 Profile ${active.run.profile}`)
      active.command = this.dependencies.startCommand({
        cwd: active.run.cwd,
        command: active.profile.command,
        logger: active.logger
      })
      active.run.activity = `等待本机端口 ${active.profile.entryPort}`
      this.publishState()

      const entry = await raceStage(active, (signal) =>
        this.dependencies.waitForPort(active.profile.entryPort, signal)
      )
      if (entry.kind === 'command') {
        outcome = commandOutcome(entry.result, active.stopRequested)
        return
      }
      if (entry.kind === 'aborted') {
        outcome = stoppedOutcome()
        return
      }

      active.run.localUrl = `http://127.0.0.1:${active.profile.entryPort}`
      active.run.activity = '正在启动单入口 Gateway'
      this.publishState()
      active.gateway = await this.dependencies.startGateway({
        entryPort: active.profile.entryPort,
        routes: active.profile.routes,
        logger: active.logger
      })
      if (active.abort.signal.aborted) {
        outcome = stoppedOutcome()
        return
      }

      active.run.activity = `正在开放公网端口 ${active.profile.publicPort}`
      this.publishState()
      active.tunnel = this.dependencies.startTunnel({
        localPort: active.gateway.port,
        publicPort: active.profile.publicPort,
        logger: active.logger
      })
      const tunnelReady = await raceStage(active, () => active.tunnel!.ready)
      if (tunnelReady.kind === 'command') {
        outcome = commandOutcome(tunnelReady.result, active.stopRequested)
        return
      }
      if (tunnelReady.kind === 'aborted') {
        outcome = stoppedOutcome()
        return
      }

      active.run.status = 'running'
      active.run.activity = '公网访问已就绪'
      active.run.publicUrl = `http://${tunnelReady.value}`
      this.publishState()
      active.logger.line('system', `远程地址 ${active.run.publicUrl}`)

      const terminal = await raceTerminal(active)
      if (terminal.kind === 'command') {
        outcome = commandOutcome(terminal.result, active.stopRequested)
      } else if (terminal.kind === 'tunnel') {
        outcome = active.stopRequested
          ? stoppedOutcome()
          : {
              status: 'failed',
              activity: 'Tunnel Client 已退出',
              failure: terminal.result.detail ?? 'Tunnel Client 意外退出'
            }
      } else {
        outcome = stoppedOutcome()
      }
    } catch (error) {
      outcome = active.stopRequested
        ? stoppedOutcome()
        : {
            status: 'failed',
            activity: '远程调试失败',
            failure: error instanceof Error ? error.message : String(error)
          }
    } finally {
      active.abort.abort()
      const cleanupErrors = await cleanupActiveRun(active)
      if (cleanupErrors.length > 0 && outcome.status !== 'failed') {
        outcome = {
          status: 'failed',
          activity: '远程调试清理失败',
          failure: cleanupErrors.join('；')
        }
      } else if (cleanupErrors.length > 0) {
        outcome.failure = [outcome.failure, ...cleanupErrors].filter(Boolean).join('；')
      }
      if (outcome.failure) active.logger.line('system:error', outcome.failure)
      active.logger.line('system', outcome.activity)
      await active.logger.close()
      this.finalize(active, outcome)
    }
  }

  private finalize(active: ActiveRun, outcome: RunOutcome): void {
    active.run.status = outcome.status
    active.run.activity = outcome.activity
    active.run.endedAt = Date.now()
    active.run.publicUrl = null
    active.run.localUrl = null
    active.run.failure = outcome.failure ? { message: outcome.failure } : null
    this.active.delete(active.run.runId)
    this.pruneRecentRuns()
    this.publishState()
    this.scheduleArtifactPrune(active.run.cwd)
  }

  private publishState(): void {
    if (!this.disposed) this.plugin.setState(JSON.parse(JSON.stringify(this.state())))
  }

  private pruneRecentRuns(): void {
    const terminal = [...this.runs.values()]
      .filter(
        (run) => run.status !== 'starting' && run.status !== 'running' && run.status !== 'stopping'
      )
      .sort((left, right) => (left.endedAt ?? left.startedAt) - (right.endedAt ?? right.startedAt))
    while (terminal.length > MAX_RECENT_RUNS) {
      const run = terminal.shift()
      if (run) this.runs.delete(run.runId)
    }
  }

  private scheduleArtifactPrune(cwd: string): void {
    const root = join(cwd, 'temp', 'pi', 'remote-debug')
    this.pruneQueue = this.pruneQueue
      .then(() =>
        pruneRunArtifacts(
          root,
          new Set(
            [...this.active.values()]
              .filter((active) => projectCwdKey(active.run.cwd) === projectCwdKey(cwd))
              .map((active) => active.runDirectory)
          )
        )
      )
      .catch((error) => {
        console.warn(
          `[pi-desk-remote-debug] 清理旧日志失败：${error instanceof Error ? error.message : String(error)}`
        )
      })
  }
}

async function loadRemoteDebugProject(
  cwd: string,
  settingsStore: RemoteDebugSettingsStore
): Promise<RemoteDebugProject> {
  try {
    await settingsStore.syncProject(cwd)
    const config = await readRemoteDebugConfig(cwd)
    if (!config) {
      return {
        cwd,
        label: basename(cwd) || cwd,
        status: 'unconfigured',
        error: null,
        profiles: []
      }
    }
    return projectFromConfig(cwd, config)
  } catch (error) {
    return {
      cwd,
      label: basename(cwd) || cwd,
      status: 'invalid',
      error: error instanceof Error ? error.message : String(error),
      profiles: []
    }
  }
}

function projectFromConfig(cwd: string, config: RemoteDebugConfig): RemoteDebugProject {
  return {
    cwd,
    label: basename(cwd) || cwd,
    status: 'ready',
    error: null,
    profiles: Object.entries(config.profiles).map(([name, profile]) => ({
      name,
      description: profile.description,
      command: profile.command,
      entryPort: profile.entryPort,
      publicPort: profile.publicPort,
      routes: profile.routes.map((route) => ({ ...route }))
    }))
  }
}

function projectCwdKey(cwd: string): string {
  const normalized = resolve(cwd)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function profilePorts(profile: RemoteDebugProfile): number[] {
  return [...new Set([profile.entryPort, ...profile.routes.map((route) => route.targetPort)])]
}

async function raceStage<T>(
  active: ActiveRun,
  stage: (signal: AbortSignal) => Promise<T>
): Promise<StageResult<T>> {
  const controller = new AbortController()
  const abortStage = (): void => controller.abort()
  active.abort.signal.addEventListener('abort', abortStage, { once: true })
  try {
    const result = await Promise.race<StageResult<T>>([
      stage(controller.signal).then((value) => ({ kind: 'ready', value })),
      active.command!.completion.then((command) => ({ kind: 'command', result: command })),
      aborted(active.abort.signal).then(() => ({ kind: 'aborted' }))
    ])
    return result
  } finally {
    controller.abort()
    active.abort.signal.removeEventListener('abort', abortStage)
  }
}

async function raceTerminal(
  active: ActiveRun
): Promise<
  | { kind: 'command'; result: CommandResult }
  | { kind: 'tunnel'; result: TunnelClientResult }
  | { kind: 'aborted' }
> {
  return Promise.race([
    active.command!.completion.then((result) => ({ kind: 'command' as const, result })),
    active.tunnel!.completion.then((result) => ({ kind: 'tunnel' as const, result })),
    aborted(active.abort.signal).then(() => ({ kind: 'aborted' as const }))
  ])
}

function commandOutcome(result: CommandResult, stopped: boolean): RunOutcome {
  if (stopped) return stoppedOutcome()
  if (result.error) {
    return { status: 'failed', activity: '项目命令启动失败', failure: result.error }
  }
  if (result.exitCode === 0) {
    return { status: 'completed', activity: '项目命令已完成', failure: null }
  }
  const signal = result.signal ? `，signal ${result.signal}` : ''
  return {
    status: 'failed',
    activity: '项目命令已退出',
    failure: `项目命令退出码 ${result.exitCode ?? 'null'}${signal}`
  }
}

function stoppedOutcome(): RunOutcome {
  return { status: 'stopped', activity: '已停止', failure: null }
}

async function cleanupActiveRun(active: ActiveRun): Promise<string[]> {
  const errors: string[] = []
  if (active.tunnel) {
    await active.tunnel.stop().catch((error) => errors.push(formatCleanupError('Tunnel', error)))
  }
  if (active.gateway) {
    await active.gateway.close().catch((error) => errors.push(formatCleanupError('Gateway', error)))
  }
  if (active.command) {
    await active.command.stop().catch((error) => errors.push(formatCleanupError('项目命令', error)))
  }
  return errors
}

function formatCleanupError(label: string, error: unknown): string {
  return `${label} 清理失败：${error instanceof Error ? error.message : String(error)}`
}

function makeRunId(): string {
  return `debug-${randomBytes(6).toString('hex')}`
}

async function waitForTcpPort(port: number, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + ENTRY_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('等待本机入口端口已取消')
    if (await canConnect(port)) return
    await delay(ENTRY_READY_POLL_MS, signal)
  }
  throw new Error(`等待本机入口端口 ${port} 超时`)
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let settled = false
    const finish = (connected: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(connected)
    }
    socket.setTimeout(500)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('操作已取消'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('操作已取消'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    timer.unref?.()
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
}
