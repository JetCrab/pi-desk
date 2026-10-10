import 'server-only'

import {
  createAgentSessionFromServices,
  type AgentSession,
  type AgentSessionServices,
  type ResourceLoader,
  type Extension,
  type ExtensionHandler,
  type InputEvent,
  type InputEventResult,
  type SessionManager,
  type SessionBeforeTreeEvent
} from '@earendil-works/pi-coding-agent'
import type { CapabilityMode } from '@jetcrab/pi-desk-sdk/capabilities'
import {
  createL4PiDeskTool,
  appendL4PiDeskSystemPrompt,
  type L4PiDeskCommandResult
} from '@server/l4_foundation/pidesk/l4-pidesk-runtime'
import { L4PiCapabilityRuntime } from './l4-pi-capability-runtime'
import { createL4PiBasicSessionServices } from './l4-pi-basic-session-services'
import { L4PiSessionResources } from './l4-pi-session-resources'
import { clearL4PiPluginCodeCache } from './l4-pi-plugin-module-loader'
import { reportL4PiPluginNativeDiagnostic } from './l4-pi-plugin-native-diagnostic'
import { L4PiSessionMessageGate } from './l4-pi-session-message-gate'
import { L4PiSessionPluginRuntime } from './l4-pi-session-plugin-runtime'
import { L4PiUiRuntime } from './l4-pi-ui-runtime'

const INITIALIZATION_TIMEOUT_MS = 60_000
const CLEANUP_TIMEOUT_MS = 1_500
const MAX_RETIRED_INITIALIZATIONS = 4
const retiredInitializations = new Set<Promise<unknown>>()
const STALE_MESSAGE = 'Pi 会话实例已失效，不能继续访问当前会话'

interface InitializationOptions {
  cwd: string
  sessionManager: SessionManager
  mode: 'normal' | 'basic'
  resources: L4PiSessionResources
  readCapabilities: () => CapabilityMode | undefined
  onInput: ExtensionHandler<InputEvent, InputEventResult>
  onTree?: () => void
  onCommand?: (args: string[], toolCallId: string) => Promise<L4PiDeskCommandResult>
  pluginEvents: ConstructorParameters<typeof L4PiSessionPluginRuntime>[0]
  ui?: L4PiUiRuntime
}

/** 每次创建独占资源和会话访问权；超时撤销不依赖扩展关闭钩子返回。 */
export class L4PiSessionInitialization {
  readonly capabilities: L4PiCapabilityRuntime
  readonly plugins: L4PiSessionPluginRuntime
  readonly messages: L4PiSessionMessageGate
  readonly ui: L4PiUiRuntime
  private readonly manager: SessionManager
  private readonly sessionId: string
  private active = true
  private accessRevoked = false
  private session: AgentSession | null = null
  private execution: Promise<AgentSession> | null = null
  private result: Promise<AgentSession> | null = null
  private onLifecycleError: ((error: Error) => void) | null = null
  private stage = '等待初始化资源'
  private stageStartedAt = performance.now()

  constructor(private readonly options: InitializationOptions) {
    this.sessionId = options.sessionManager.getSessionId()
    this.ui = options.ui ?? new L4PiUiRuntime()
    this.capabilities = new L4PiCapabilityRuntime(options.readCapabilities)
    this.plugins = new L4PiSessionPluginRuntime({
      onChanged: () => {
        if (this.active) options.pluginEvents.onChanged()
      },
      onPush: (event) => {
        if (this.active) options.pluginEvents.onPush(event)
      },
      onTasksChanged: (ids) => {
        if (this.active) options.pluginEvents.onTasksChanged(ids)
      },
      onInvalidUpdate: (error) => {
        if (this.active) options.pluginEvents.onInvalidUpdate(error)
      }
    })
    this.messages = new L4PiSessionMessageGate((source, error) => {
      console.warn('[Pi Desk][PiSession] 延后消息投递失败', {
        sessionId: this.sessionId,
        source,
        message: error instanceof Error ? error.message : String(error)
      })
    })
    this.manager = new Proxy(options.sessionManager, {
      get: (target, key) => {
        this.assertAccess()
        const value: unknown = Reflect.get(target, key, target)
        if (typeof value !== 'function') return value
        return (...args: unknown[]): unknown => {
          // 已被插件捕获的方法也要在调用时检查，不能只检查属性读取。
          this.assertAccess()
          return Reflect.apply(value, target, args)
        }
      },
      set: () => {
        throw new Error('Pi 会话只能通过 SessionManager 方法修改')
      }
    })
  }

  start(refreshResources = false): Promise<AgentSession> {
    this.result ??= this.initialize(refreshResources)
    return this.result
  }

  async reload(): Promise<void> {
    this.assertActive()
    const session = await this.start()
    let failure: Error | null = null
    this.onLifecycleError = (error) => {
      failure ??= error
    }
    this.setStage('重载 Pi 配置')
    try {
      await session.reload({
        beforeSessionStart: async () => {
          this.assertActive()
          this.validateResources(
            session.resourceLoader,
            session.settingsManager.drainErrors().map(({ error }) => ({
              type: 'error',
              message: error.message
            }))
          )
        }
      })
      this.assertActive()
      if (failure) throw failure
    } finally {
      this.onLifecycleError = null
    }
  }

  setStage(stage: string): void {
    if (!this.active) return
    this.stage = stage
    this.stageStartedAt = performance.now()
  }

  describeStage(): string {
    return `${this.stage}\n当前步骤耗时：${Math.round(performance.now() - this.stageStartedAt)} 毫秒`
  }

  private async initialize(refreshResources: boolean): Promise<AgentSession> {
    const startedAt = performance.now()
    this.assertActive()
    if (
      this.options.mode === 'normal' &&
      retiredInitializations.size >= MAX_RETIRED_INITIALIZATIONS
    ) {
      throw new Error('尚未结束的插件初始化或关闭任务过多，请重启服务后再加载插件')
    }
    const failure = new Promise<never>((_, reject) => {
      this.onLifecycleError = reject
    })
    const initialize = async (): Promise<AgentSession> => {
      this.assertActive()
      if (refreshResources) {
        this.setStage('刷新插件资源')
        clearL4PiPluginCodeCache()
        this.options.resources.reset()
        this.assertActive()
      }
      return this.create()
    }
    this.execution = initialize()
    try {
      const session = await this.ui.waitForOperation(
        Promise.race([this.execution, failure]),
        INITIALIZATION_TIMEOUT_MS,
        () => new Error('Pi 会话初始化超时（60 秒）；不含等待用户回答')
      )
      this.assertActive()
      this.setStage('会话已就绪')
      console.info('[Pi Desk][PiSession] 会话初始化完成', {
        sessionId: this.sessionId,
        cwd: this.options.cwd,
        mode: this.options.mode,
        durationMs: Math.round(performance.now() - startedAt)
      })
      return session
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      if (!this.active) {
        console.info('[Pi Desk][PiSession] 会话初始化已取消', {
          sessionId: this.sessionId,
          cwd: this.options.cwd,
          mode: this.options.mode,
          durationMs: Math.round(performance.now() - startedAt)
        })
        throw error
      }
      const diagnostic = `${error.stack ?? error.message}\n\n最后处理步骤：${this.describeStage()}`
      console.error('[Pi Desk][PiSession] 会话初始化失败', {
        sessionId: this.sessionId,
        cwd: this.options.cwd,
        mode: this.options.mode,
        durationMs: Math.round(performance.now() - startedAt),
        message: diagnostic
      })
      this.dispose()
      throw new Error(diagnostic)
    } finally {
      this.onLifecycleError = null
    }
  }

  dispose(emitShutdown = true): void {
    if (!this.active) return
    this.active = false
    this.onLifecycleError?.(new Error(STALE_MESSAGE))
    this.ui.reset(false)
    this.messages.dispose()
    this.plugins.dispose()
    this.capabilities.dispose()
    const session = this.session
    this.session = null
    try {
      // SDK dispose 同步清理由 sessionId 索引的资源，必须在替代实例创建前执行一次。
      session?.dispose()
    } catch (cause) {
      console.warn('[Pi Desk][PiSession] 释放会话失败', {
        sessionId: this.sessionId,
        message: cause instanceof Error ? cause.message : String(cause)
      })
    } finally {
      this.accessRevoked = true
    }
    if (!this.execution) return
    const shutdown =
      session && emitShutdown
        ? Promise.resolve().then(() =>
            session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
          )
        : Promise.resolve()
    const cleanup = Promise.allSettled([this.execution, shutdown])
    retiredInitializations.add(cleanup)
    const timer = setTimeout(() => {
      console.warn('[Pi Desk][PiSession] 旧实例仍在后台清理，不阻塞基础聊天', {
        sessionId: this.sessionId,
        cwd: this.options.cwd,
        stage: this.describeStage()
      })
    }, CLEANUP_TIMEOUT_MS)
    timer.unref()
    void cleanup.then(() => {
      clearTimeout(timer)
      retiredInitializations.delete(cleanup)
    })
  }

  private assertActive(): void {
    if (!this.active) throw new Error(STALE_MESSAGE)
  }

  private assertAccess(): void {
    if (this.accessRevoked) throw new Error(STALE_MESSAGE)
  }

  private validateResources(
    resourceLoader: ResourceLoader,
    diagnostics: AgentSessionServices['diagnostics']
  ): void {
    const failures = resourceLoader
      .getExtensions()
      .errors.map(({ path, error }) => `${error}\n插件入口：${path}`)
    for (const diagnostic of diagnostics) {
      if (diagnostic.type === 'error') failures.push(diagnostic.message)
      else console.info('[Pi Desk][PiSession] 初始化诊断', { cwd: this.options.cwd, ...diagnostic })
    }
    if (failures.length > 0) {
      for (const message of failures) reportL4PiPluginNativeDiagnostic(this.options.cwd, message)
      resourceLoader.getExtensions().runtime.invalidate(STALE_MESSAGE)
      throw new Error(failures.join('\n'))
    }
  }

  private async create(): Promise<AgentSession> {
    this.setStage('加载 Pi 配置与插件')
    const createHostExtension = (): Extension => {
      this.ui.reset()
      const extension = this.capabilities.createHostExtension(
        (event, context) => {
          this.assertActive()
          return this.options.onInput(event, context)
        },
        () => {
          this.ui.reset(false)
          this.plugins.reset()
        }
      )
      extension.handlers.set('session_tree', [async () => this.options.onTree?.()])
      extension.handlers.set('session_before_tree', [
        async (event) => {
          if ((event as SessionBeforeTreeEvent).signal.aborted) return { cancel: true }
        }
      ])
      const tool = this.options.onCommand ? createL4PiDeskTool(this.options.onCommand) : null
      if (tool)
        extension.tools.set(tool.name, { definition: tool, sourceInfo: extension.sourceInfo })
      return extension
    }
    const services =
      this.options.mode === 'basic'
        ? await createL4PiBasicSessionServices({ cwd: this.options.cwd, createHostExtension })
        : await this.options.resources.createServices(
            this.options.cwd,
            {
              appendSystemPromptOverride: appendL4PiDeskSystemPrompt,
              eventBus: this.capabilities.eventBus(this.plugins.eventBus),
              extensionsOverride: (loaded) => {
                if (!this.active) {
                  loaded.runtime.invalidate(STALE_MESSAGE)
                  throw new Error(STALE_MESSAGE)
                }
                const host = createHostExtension()
                const branchPath = '<inline:pi-desk-branch-state>'
                const branch: Extension = {
                  ...host,
                  path: branchPath,
                  resolvedPath: branchPath,
                  sourceInfo: { ...host.sourceInfo, path: branchPath },
                  handlers: new Map([['session_tree', host.handlers.get('session_tree')!]]),
                  tools: new Map()
                }
                host.handlers.delete('session_tree')
                // 分支状态须先清再由插件重建；输入校验与取消检查仍在插件之后。
                return { ...loaded, extensions: [branch, ...loaded.extensions, host] }
              }
            },
            (stage) => this.setStage(stage)
          )
    this.assertActive()
    this.validateResources(services.resourceLoader, services.diagnostics)
    this.setStage('创建会话与恢复模型')
    services.resourceLoader = this.capabilities.resources(services.resourceLoader)
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: this.manager
    })
    // 创建期间的迟到访问由 manager 拒绝，不能对共享 sessionId 再做一次 dispose。
    this.assertActive()
    this.session = session
    this.capabilities.attach(session)
    this.setStage('启动插件')
    await session.bindExtensions({
      mode: 'rpc',
      uiContext: this.ui.bind(session.extensionRunner.getUIContext(), () => this.assertActive()),
      onError: (error) => {
        const diagnostic = `${error.stack ?? error.error}\n插件入口：${error.extensionPath}\n事件：${error.event}`
        if (!this.active) return
        console.error('[Pi Desk][PiSession] 扩展处理失败', {
          sessionId: this.sessionId,
          message: diagnostic
        })
        this.onLifecycleError?.(new Error(diagnostic))
        if (error.event === 'session_tree' || error.event === 'session_before_tree') {
          this.session?.extensionRunner
            .getUIContext()
            .notify(`会话树扩展处理失败：${error.error}`, 'error')
        }
      }
    })
    this.assertActive()
    this.messages.installExtensionRuntime(services.resourceLoader.getExtensions().runtime)
    this.setStage('应用会话能力')
    await this.capabilities.apply()
    this.assertActive()
    return session
  }
}
