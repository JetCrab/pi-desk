import 'server-only'

import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path'
import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultPackageManager,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SettingsManager,
  type AgentSessionServices,
  type ExtensionFactory,
  type ResourceLoader,
  type SourceInfo
} from '@earendil-works/pi-coding-agent'
import { clearL4PiPluginCodeCache, loadL4PiDeskPluginEntry } from './l4-pi-plugin-module-loader'
import { runL4PiPackageRootExclusive } from './l4-pi-package-root-gate'

type LoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0]
type Resource = Awaited<ReturnType<DefaultPackageManager['resolve']>>['extensions'][number]
type Selection = {
  extensions: Resource[]
  skills: Resource[]
  prompts: Resource[]
  themes: Resource[]
}

type LoadProgress = (stage: string) => void

const BUILTIN_EXTENSIONS = [
  { name: 'codemode', create: createCodemodeExtension },
  { name: 'tool-search', create: createToolSearchExtension },
  {
    name: 'mcp',
    // RPC 登录已通过 notify 提供授权链接，由网页打开而非服务端启动浏览器。
    create: () => createMcpExtension({ openUrl: () => undefined })
  }
] as const

function resourceLabel(resource: Resource): string {
  const file = basename(resource.path)
  const name =
    resource.metadata.origin === 'package'
      ? resource.metadata.source.replace(/^npm:/, '')
      : /^(index\.[^.]+|SKILL\.md)$/.test(file)
        ? basename(dirname(resource.path))
        : basename(resource.path, extname(resource.path))
  return `插件 ${name}\n来源：${resource.path}`
}

async function runLoadStage<T>(
  stage: string,
  onProgress: LoadProgress | undefined,
  operation: () => Promise<T>
): Promise<T> {
  onProgress?.(stage)
  const startedAt = performance.now()
  try {
    return await operation()
  } catch (cause) {
    const durationMs = Math.round(performance.now() - startedAt)
    console.error('[Pi Desk][PluginResources] 资源步骤失败', {
      stage,
      durationMs,
      message: cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)
    })
    throw new Error(
      `${stage}\n当前步骤耗时：${durationMs} 毫秒\n原因：${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    )
  } finally {
    const durationMs = Math.round(performance.now() - startedAt)
    if (durationMs >= 1000) {
      console.info('[Pi Desk][PluginResources] 资源步骤耗时', { stage, durationMs })
    }
  }
}

/** 只缓存选中的原始路径；Worker/Branch重建复用，显式reload才重新发现。 */
export class L4PiSessionResources {
  private selection: Promise<Selection> | null = null

  private current(
    cwd: string,
    agentDir: string,
    settings: SettingsManager,
    onProgress?: LoadProgress
  ): Promise<Selection> {
    if (this.selection) {
      onProgress?.('等待已选择的插件资源准备完成')
      return this.selection
    }
    onProgress?.(`等待插件资源队列\n工作目录：${cwd}`)
    const queuedAt = performance.now()
    this.selection = runL4PiPackageRootExclusive(() => {
      const durationMs = Math.round(performance.now() - queuedAt)
      if (durationMs >= 1000) {
        console.info('[Pi Desk][PluginResources] 插件资源队列等待结束', { cwd, durationMs })
      }
      return this.discover(cwd, agentDir, settings, onProgress)
    })
    return this.selection
  }

  private async discover(
    cwd: string,
    agentDir: string,
    settings: SettingsManager,
    onProgress?: LoadProgress
  ): Promise<Selection> {
    await runLoadStage(`读取 Pi 配置\n配置目录：${agentDir}\n工作目录：${cwd}`, onProgress, () =>
      settings.reload()
    )
    const manager = new DefaultPackageManager({
      cwd,
      agentDir,
      settingsManager: settings,
      builtinExtensions: BUILTIN_EXTENSIONS.map((extension) => extension.name)
    })
    const paths = await runLoadStage('发现已配置的插件与资源', onProgress, () =>
      manager.resolve(async (source) => {
        throw new Error(`插件包未安装：${source}`)
      })
    )
    return {
      extensions: paths.extensions.filter((resource) => resource.enabled),
      skills: paths.skills.filter((resource) => resource.enabled),
      prompts: paths.prompts.filter((resource) => resource.enabled),
      themes: paths.themes.filter((resource) => resource.enabled)
    }
  }

  reset(): void {
    this.selection = null
  }

  async createServices(
    cwd: string,
    options: Omit<LoaderOptions, 'cwd' | 'agentDir' | 'settingsManager'>,
    onProgress?: LoadProgress
  ): Promise<AgentSessionServices> {
    const agentDir = getAgentDir()
    const settingsManager = SettingsManager.create(cwd, agentDir)
    const diagnostics: AgentSessionServices['diagnostics'] = []
    const modelRuntime = await runLoadStage(
      `读取模型与认证配置\n配置目录：${agentDir}`,
      onProgress,
      () =>
        ModelRuntime.create({
          authPath: join(agentDir, 'auth.json'),
          modelsPath: join(agentDir, 'models.json')
        })
    )
    let loader: DefaultResourceLoader
    const load = async (refresh: boolean): Promise<void> => {
      if (refresh) {
        clearL4PiPluginCodeCache()
        this.reset()
        await runLoadStage('重新读取 Pi 配置', onProgress, () => settingsManager.reload())
      }
      const selected = await this.current(cwd, agentDir, settingsManager, onProgress)
      const builtinPaths = selected.extensions
        .filter((resource) => resource.path.startsWith('builtin:'))
        .map((resource) => resource.path)
      const factories = selected.extensions
        .filter((resource) => !resource.path.startsWith('builtin:'))
        .map((resource) => ({
          name: resource.path,
          factory: async (pi: Parameters<ExtensionFactory>[0]): Promise<void> => {
            const label = resourceLabel(resource)
            const loaded = await runLoadStage(`${label}\n步骤：导入插件模块`, onProgress, () =>
              loadL4PiDeskPluginEntry(resource.path).catch((cause: unknown) => {
                if (cause instanceof Error && cause.message.includes('不支持模块顶层 await')) {
                  throw new Error(
                    '原生扩展不支持模块顶层 await，请将异步初始化放入 async 工厂函数',
                    {
                      cause
                    }
                  )
                }
                throw cause
              })
            )
            await runLoadStage(`${label}\n步骤：执行插件工厂`, onProgress, async () => {
              if (typeof loaded.default !== 'function')
                throw new Error(`扩展必须导出工厂函数：${resource.path}`)
              await (loaded.default as ExtensionFactory)(pi)
            })
          }
        }))
      // 只加载已选择的原始路径，不隐式安装或重新发现资源。
      const resourceSettings = SettingsManager.inMemory(
        {},
        {
          projectTrusted: settingsManager.isProjectTrusted()
        }
      )
      loader = new DefaultResourceLoader({
        ...options,
        cwd,
        agentDir,
        settingsManager: resourceSettings,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories: [
          ...BUILTIN_EXTENSIONS.map(({ name, create }) => ({
            name,
            factory: create(),
            builtin: true as const,
            replaceable: true
          })),
          ...factories
        ],
        // 资源选择已由官方 PackageManager 完成；只显式加载未被配置禁用的内置项。
        additionalExtensionPaths: builtinPaths,
        additionalSkillPaths: selected.skills.map((item) => item.path),
        additionalPromptTemplatePaths: selected.prompts.map((item) => item.path),
        additionalThemePaths: selected.themes.map((item) => item.path)
      })
      onProgress?.('装配插件与会话资源')
      await loader.reload()
      const restoreSource = (
        item: { sourceInfo?: SourceInfo },
        path: string | undefined,
        resources: Resource[]
      ): void => {
        if (!path) return
        for (const resource of resources) {
          const local = relative(resource.path, path)
          if (local.startsWith('..') || isAbsolute(local)) continue
          item.sourceInfo = {
            ...resource.metadata,
            path
          }
          break
        }
      }
      for (const skill of loader.getSkills().skills)
        restoreSource(skill, skill.filePath, selected.skills)
      for (const prompt of loader.getPrompts().prompts)
        restoreSource(prompt, prompt.filePath, selected.prompts)
      for (const theme of loader.getThemes().themes)
        restoreSource(theme, theme.sourcePath, selected.themes)
      const extensions = loader.getExtensions()
      for (const extension of extensions.extensions) {
        const resource = selected.extensions.find(
          (item) => extension.path === `<inline:${item.path}>`
        )
        if (!resource) continue
        extension.path = resource.path
        extension.resolvedPath = resource.path
        extension.sourceInfo = { ...resource.metadata, path: resource.path }
        for (const [event, label] of [
          ['session_start', '启动会话（session_start）'],
          ['session_shutdown', '关闭会话（session_shutdown）'],
          ['resources_discover', '补充会话资源（resources_discover）']
        ] as const) {
          const handlers = extension.handlers.get(event)
          if (!handlers) continue
          extension.handlers.set(
            event,
            handlers.map(
              (handler) =>
                (...args: unknown[]) =>
                  runLoadStage(`${resourceLabel(resource)}\n步骤：${label}`, onProgress, () =>
                    handler(...args)
                  )
            )
          )
        }
        for (const tool of extension.tools.values()) tool.sourceInfo = extension.sourceInfo
        for (const command of extension.commands.values()) command.sourceInfo = extension.sourceInfo
      }
      for (const failure of extensions.errors) {
        const resource = selected.extensions.find(
          (item) => failure.path === `<inline:${item.path}>`
        )
        if (resource) failure.path = resource.path
      }
    }
    await load(false)
    const resourceLoader: ResourceLoader = new Proxy(loader!, {
      get: (_target, key) => {
        if (key === 'reload') return (): Promise<void> => load(true)
        const value: unknown = Reflect.get(loader, key, loader)
        return typeof value === 'function' ? value.bind(loader) : value
      }
    })
    const runtime = resourceLoader.getExtensions().runtime
    for (const { name, config, extensionPath } of runtime.pendingProviderRegistrations) {
      try {
        modelRuntime.registerProvider(name, config)
      } catch (cause) {
        diagnostics.push({ type: 'error', message: `${extensionPath}: ${String(cause)}` })
      }
    }
    for (const { provider, extensionPath } of runtime.pendingNativeProviderRegistrations) {
      try {
        modelRuntime.registerNativeProvider(provider)
      } catch (cause) {
        diagnostics.push({ type: 'error', message: `${extensionPath}: ${String(cause)}` })
      }
    }
    for (const { definition, extensionPath } of runtime.pendingVirtualModelRegistrations) {
      try {
        modelRuntime.registerVirtualModel(definition)
      } catch (cause) {
        diagnostics.push({ type: 'error', message: `${extensionPath}: ${String(cause)}` })
      }
    }
    runtime.pendingProviderRegistrations = []
    runtime.pendingNativeProviderRegistrations = []
    runtime.pendingVirtualModelRegistrations = []
    await runLoadStage('刷新模型与认证配置', onProgress, () =>
      modelRuntime.refresh({ allowNetwork: false })
    )
    diagnostics.push(
      ...settingsManager.drainErrors().map(({ error }) => ({
        type: 'error' as const,
        message: error.message
      }))
    )
    return { cwd, agentDir, settingsManager, modelRuntime, resourceLoader, diagnostics }
  }
}
