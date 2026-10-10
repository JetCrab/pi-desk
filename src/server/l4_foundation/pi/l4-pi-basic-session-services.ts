import 'server-only'

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendL4PiDeskSystemPrompt } from '@server/l4_foundation/pidesk/l4-pidesk-runtime'
import {
  CONFIG_DIR_NAME,
  createExtensionRuntime,
  getAgentDir,
  loadProjectContextFiles,
  ModelRuntime,
  SettingsManager,
  type AgentSessionServices,
  type Extension,
  type LoadExtensionsResult,
  type ResourceLoader
} from '@earendil-works/pi-coding-agent'

class BasicResourceLoader implements ResourceLoader {
  private extensions: LoadExtensionsResult = {
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime()
  }
  private agentsFiles: ReturnType<ResourceLoader['getAgentsFiles']> = { agentsFiles: [] }
  private systemPrompt: { path: string; content: string } | undefined
  private appendPrompt: { path: string; content: string } | undefined

  constructor(
    private readonly cwd: string,
    private readonly agentDir: string,
    private readonly settings: SettingsManager,
    private readonly createHostExtension: () => Extension
  ) {}

  getExtensions(): LoadExtensionsResult {
    return this.extensions
  }

  getSkills(): ReturnType<ResourceLoader['getSkills']> {
    return { skills: [], diagnostics: [] }
  }

  getPrompts(): ReturnType<ResourceLoader['getPrompts']> {
    return { prompts: [], diagnostics: [] }
  }

  getThemes(): ReturnType<ResourceLoader['getThemes']> {
    return { themes: [], diagnostics: [] }
  }

  getAgentsFiles(): ReturnType<ResourceLoader['getAgentsFiles']> {
    return this.agentsFiles
  }

  getSystemPrompt(): string | undefined {
    return this.systemPrompt?.content
  }

  getSystemPromptSource(): { path: string } | undefined {
    return this.systemPrompt ? { path: this.systemPrompt.path } : undefined
  }

  getAppendSystemPrompt(): string[] {
    return appendL4PiDeskSystemPrompt(this.appendPrompt ? [this.appendPrompt.content] : [])
  }

  getAppendSystemPromptSources(): Array<{ path: string }> {
    return this.appendPrompt ? [{ path: this.appendPrompt.path }] : []
  }

  extendResources(): void {
    // 基础模式不接纳通过扩展事件追加的资源。
  }

  async reload(): Promise<void> {
    await this.settings.reload()
    this.extensions = {
      extensions: [this.createHostExtension()],
      errors: [],
      runtime: createExtensionRuntime()
    }
    this.agentsFiles = {
      agentsFiles: loadProjectContextFiles({ cwd: this.cwd, agentDir: this.agentDir })
    }
    this.systemPrompt = this.readPrompt('SYSTEM.md')
    this.appendPrompt = this.readPrompt('APPEND_SYSTEM.md')
  }

  private readPrompt(name: string): { path: string; content: string } | undefined {
    // 沿用 Pi 的项目可信优先、全局回退顺序，不改写用户提示内容。
    const paths = [
      ...(this.settings.isProjectTrusted() ? [join(this.cwd, CONFIG_DIR_NAME, name)] : []),
      join(this.agentDir, name)
    ]
    const path = paths.find((candidate) => existsSync(candidate))
    return path ? { path, content: readFileSync(path, 'utf8') } : undefined
  }
}

export async function createL4PiBasicSessionServices(input: {
  cwd: string
  createHostExtension: () => Extension
}): Promise<AgentSessionServices> {
  const agentDir = getAgentDir()
  const settingsManager = SettingsManager.create(input.cwd, agentDir)
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json')
  })
  const resourceLoader = new BasicResourceLoader(
    input.cwd,
    agentDir,
    settingsManager,
    input.createHostExtension
  )
  await resourceLoader.reload()
  await modelRuntime.refresh({ allowNetwork: false })
  return {
    cwd: input.cwd,
    agentDir,
    settingsManager,
    modelRuntime,
    resourceLoader,
    diagnostics: settingsManager.drainErrors().map(({ error }) => ({
      type: 'error' as const,
      message: error.message
    }))
  }
}
