import type { AgentSession, ExtensionAPI, ResourceLoader } from '@earendil-works/pi-coding-agent'
import { isCapabilityAllowed, type SessionCapabilityRules } from '@jetcrab/pi-desk-sdk/capabilities'

/** Child sessions keep their role registry; a mode only filters its current view. */
export class SubagentCapabilities {
  private session: AgentSession | null = null
  private requested = new Set<string>()
  // Current rules cannot distinguish a previously masked tool from an explicit deactivation.
  private appliedToolsRules: SessionCapabilityRules['tools'] = {}
  private setTools: ((names: string[]) => void) | null = null
  private originalSetTools: AgentSession['setActiveToolsByName'] | null = null

  constructor(private readonly rules: () => SessionCapabilityRules) {}

  extension(pi: ExtensionAPI): void {
    pi.on('tool_call', (event) => {
      if (!isCapabilityAllowed(this.rules().tools, event.toolName)) {
        return { block: true, reason: `当前能力模式不允许工具：${event.toolName}` }
      }
    })
    pi.on('session_shutdown', () => this.dispose())
  }

  resources(base: ResourceLoader, appendPrompt: () => string[]): ResourceLoader {
    return new Proxy(base, {
      get: (target, property) => {
        if (property === 'getSkills') {
          return (): ReturnType<ResourceLoader['getSkills']> => {
            const result = target.getSkills()
            return {
              ...result,
              skills: result.skills.filter((skill) =>
                isCapabilityAllowed(this.rules().skills, skill.name)
              )
            }
          }
        }
        if (property === 'getAppendSystemPrompt') {
          return (): string[] => [...target.getAppendSystemPrompt(), ...appendPrompt()]
        }
        const value: unknown = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  }

  attach(session: AgentSession): void {
    this.session = session
    this.requested = new Set(session.getActiveToolNames())
    this.originalSetTools = session.setActiveToolsByName
    this.setTools = session.setActiveToolsByName.bind(session)
    session.setActiveToolsByName = (names): void => {
      this.applyTools(names)
    }
    this.refresh()
  }

  refresh(): void {
    if (this.session) this.applyTools(this.session.getActiveToolNames())
  }

  private applyTools(names: string[]): void {
    if (!this.session || !this.setTools) return
    const registered = new Set(
      this.session
        .getAllTools()
        .filter((tool) => tool.exposure !== 'hidden')
        .map((tool) => tool.name)
    )
    const masked = [...this.requested].filter(
      (name) => registered.has(name) && !isCapabilityAllowed(this.appliedToolsRules, name)
    )
    const selected = new Set([...names, ...masked])
    this.requested = new Set(
      [...this.requested, ...names].filter((name) => registered.has(name) && selected.has(name))
    )
    const rules = this.rules().tools
    this.appliedToolsRules = {
      allow: rules.allow ? [...rules.allow] : undefined,
      deny: rules.deny ? [...rules.deny] : undefined
    }
    this.setTools([...this.requested].filter((name) => isCapabilityAllowed(rules, name)))
  }

  private dispose(): void {
    if (this.session && this.originalSetTools) {
      this.session.setActiveToolsByName = this.originalSetTools
    }
    this.session = null
    this.setTools = null
    this.originalSetTools = null
    this.requested.clear()
    this.appliedToolsRules = {}
  }
}
