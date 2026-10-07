import 'server-only'

import { getCurrentSystemMessage } from '@earendil-works/pi-ai'
import type {
  AgentSession,
  EventBus,
  Extension,
  ExtensionContext,
  ExtensionHandler,
  InputEvent,
  InputEventResult,
  ResourceLoader,
  ToolCallEvent
} from '@earendil-works/pi-coding-agent'
import {
  SESSION_PLUGIN_CAPABILITIES_EVENT,
  type SessionCapabilityRegistration,
  type SessionCapabilityRegistrationEvent
} from '@jetcrab/pi-desk-sdk/session'
import { isCapabilityAllowed, type SessionCapabilityRules } from '@jetcrab/pi-desk-sdk/capabilities'
import type { CapabilityMode as L3CapabilityMode } from '@jetcrab/pi-desk-sdk/capabilities'

export class L4PiCapabilityRuntime {
  private readonly registrations = new Map<string, SessionCapabilityRegistration>()
  private rules: L3CapabilityMode | undefined
  private session: AgentSession | null = null
  private requestedTools = new Set<string>()
  private setTools: ((names: string[]) => void) | null = null
  private originalSetTools: AgentSession['setActiveToolsByName'] | null = null
  private ready = false
  private disposed = false

  constructor(private readonly readMode: () => L3CapabilityMode | undefined) {
    this.rules = readMode()
  }

  eventBus(base: EventBus): EventBus {
    return {
      on: (channel, handler) => base.on(channel, handler),
      emit: (channel, input) => {
        if (this.disposed) return
        if (channel === SESSION_PLUGIN_CAPABILITIES_EVENT) {
          this.register(input)
        } else {
          base.emit(channel, input)
        }
      }
    }
  }

  createHostExtension(
    onInput: ExtensionHandler<InputEvent, InputEventResult>,
    onShutdown?: () => void
  ): Extension {
    const path = '<inline:pi-desk-input-validator>'
    const handlers: Extension['handlers'] = new Map()
    handlers.set('input', [
      async (event, context) => onInput(event as InputEvent, context as ExtensionContext)
    ])
    handlers.set('tool_call', [
      async (input) => {
        const event = input as ToolCallEvent
        if (!this.isToolAllowed(event.toolName)) {
          return { block: true, reason: `当前能力模式不允许工具：${event.toolName}` }
        }
      }
    ])
    handlers.set('session_shutdown', [
      async () => {
        this.ready = false
        this.registrations.clear()
        onShutdown?.()
      }
    ])
    return {
      path,
      resolvedPath: path,
      hidden: true,
      sourceInfo: { path, source: 'inline', scope: 'temporary', origin: 'top-level' },
      handlers,
      tools: new Map(),
      commands: new Map(),
      flags: new Map(),
      shortcuts: new Map(),
      messageRenderers: new Map()
    }
  }

  resources(base: ResourceLoader): ResourceLoader {
    // Forward methods with the original receiver; only the public resource view changes.
    return new Proxy(base, {
      get: (target, property) => {
        if (property === 'getSkills') {
          return (): ReturnType<ResourceLoader['getSkills']> => {
            const result = target.getSkills()
            return {
              ...result,
              skills: result.skills.filter((skill) =>
                isCapabilityAllowed(this.rules?.skills, skill.name)
              )
            }
          }
        }
        const value: unknown = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  }

  attach(session: AgentSession): void {
    if (this.session === session) return
    this.session = session
    this.requestedTools = new Set(session.getActiveToolNames())
    this.originalSetTools = session.setActiveToolsByName
    this.setTools = session.setActiveToolsByName.bind(session)
    session.setActiveToolsByName = (names): void => {
      this.rememberRequestedTools(names)
      this.refreshTools()
    }
    this.refreshTools()
  }

  isToolAllowed(name: string): boolean {
    return isCapabilityAllowed(this.rules?.tools, name)
  }

  restoreBranchSelection(): void {
    const session = this.session
    if (this.disposed || !session) return
    // 无历史工具声明时 SDK 保留当前选择；否则以刚恢复的分支声明为准。
    if (getCurrentSystemMessage(session.messages)) {
      this.requestedTools = new Set(session.getActiveToolNames())
    }
    this.refreshTools()
  }

  async apply(): Promise<void> {
    const session = this.session
    if (this.disposed || !session) return
    // SDK 重载和动态注册可直接更新激活集合；不能用上一次模式的快照覆盖它。
    this.rememberRequestedTools(session.getActiveToolNames())
    this.rules = this.readMode()
    this.ready = true
    this.refreshTools()
    const failures: string[] = []
    for (const registration of [...this.registrations.values()]) {
      try {
        await this.applyRegistration(registration)
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        console.error('[Pi Desk][Capabilities] 插件应用能力规则失败', {
          sessionId: session.sessionId,
          pluginName: registration.pluginName,
          message
        })
        failures.push(`${registration.pluginName}：${message}`)
      }
    }
    this.refreshTools()
    if (failures.length > 0) throw new Error(`能力规则应用失败：${failures.join('；')}`)
  }

  dispose(): void {
    this.disposed = true
    this.detach()
  }

  detach(): void {
    this.ready = false
    this.registrations.clear()
    if (this.session && this.originalSetTools) {
      this.session.setActiveToolsByName = this.originalSetTools
    }
    this.session = null
    this.setTools = null
    this.originalSetTools = null
    this.requestedTools.clear()
  }

  private rememberRequestedTools(names: string[]): void {
    const registered = new Set(
      this.session
        ?.getAllTools()
        .filter((tool) => tool.exposure !== 'hidden')
        .map((tool) => tool.name)
    )
    // 只保留被旧模式隐藏的选择，不恢复用户显式关闭或已取消注册的工具。
    const masked = [...this.requestedTools].filter(
      (name) => registered.has(name) && !isCapabilityAllowed(this.rules?.tools, name)
    )
    this.requestedTools = new Set([...names, ...masked].filter((name) => registered.has(name)))
  }

  private refreshTools(): void {
    this.setTools?.(
      [...this.requestedTools].filter((name) => isCapabilityAllowed(this.rules?.tools, name))
    )
  }

  private async applyRegistration(registration: SessionCapabilityRegistration): Promise<void> {
    const session = this.session
    if (
      !session ||
      this.disposed ||
      this.registrations.get(registration.pluginName) !== registration
    )
      return
    const rules: SessionCapabilityRules = {
      tools: this.rules?.tools ?? {},
      skills: this.rules?.skills ?? {},
      capabilities: this.rules?.plugins?.[registration.pluginName] ?? {}
    }
    await registration.execute(structuredClone(rules), session.extensionRunner.createContext())
  }

  private register(input: unknown): void {
    if (!input || typeof input !== 'object') throw new Error('能力回调注册无效')
    const event = input as Partial<SessionCapabilityRegistrationEvent>
    const registration = event.registration
    if (
      !registration ||
      typeof registration.pluginName !== 'string' ||
      typeof registration.execute !== 'function'
    ) {
      throw new Error('能力回调缺少插件名称或处理函数')
    }
    if (event.type === 'unregister') {
      if (this.registrations.get(registration.pluginName) === registration) {
        this.registrations.delete(registration.pluginName)
      }
      return
    }
    if (event.type !== 'register') throw new Error('能力回调事件无效')
    if (this.registrations.has(registration.pluginName)) {
      throw new Error(`能力回调已注册：${registration.pluginName}`)
    }
    registration.hostManaged = true
    this.registrations.set(registration.pluginName, registration)
    if (this.ready) {
      void this.applyRegistration(registration).catch((cause: unknown) => {
        console.error('[Pi Desk][Capabilities] 新注册插件应用规则失败', {
          pluginName: registration.pluginName,
          message: cause instanceof Error ? cause.message : String(cause)
        })
      })
    }
  }
}
