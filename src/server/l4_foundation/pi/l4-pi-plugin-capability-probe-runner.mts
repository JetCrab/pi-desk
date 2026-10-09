import { basename, isAbsolute, relative, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import {
  createAgentSession,
  DefaultPackageManager,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionError
} from '@earendil-works/pi-coding-agent'
import { discoverL4PiPluginSources } from './l4-pi-plugin-sources'
import { createL4PiPluginDisabledFilter } from './l4-pi-plugin-disabled'

const RESULT_PREFIX = '__PI_DESK_PLUGIN_CAPABILITIES__'
const MAX_TEXT_LENGTH = 4 * 1024
const MAX_DETAIL_TEXT_LENGTH = 32 * 1024
const MAX_PROMPT_PREVIEW_LENGTH = 500

interface CapabilitySourceInfo {
  path: string
  source: string
  scope: 'user' | 'project' | 'temporary'
  origin: 'package' | 'top-level'
  baseDir?: string
}

interface ConfiguredPackageRoot {
  source: string
  installedPath: string
}

interface ProviderCapability {
  name: string
  kind: 'config' | 'native'
}

function normalizedPath(path: string): string {
  let canonical = path
  try {
    canonical = realpathSync(path)
  } catch {
    /* 虚拟入口和错误路径保留原定位。 */
  }
  const normalized = resolve(canonical).replaceAll('\\', '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function sourceInfoBelongsToPackage(
  sourceInfo: CapabilitySourceInfo | undefined,
  source: string
): boolean {
  return (
    sourceInfo?.scope === 'user' && sourceInfo.origin === 'package' && sourceInfo.source === source
  )
}

function packageRelativePath(
  packageRoot: string,
  path: string,
  sourceInfo?: CapabilitySourceInfo
): string {
  const root = resolve(sourceInfo?.baseDir ?? packageRoot)
  const target = resolve(path)
  const child = relative(root, target)
  if (child === '') return basename(target).replaceAll('\\', '/')
  if (!child.startsWith('..') && !isAbsolute(child)) return child.replaceAll('\\', '/')
  return basename(target).replaceAll('\\', '/')
}

function text(value: unknown): string {
  const content = typeof value === 'string' ? value : String(value ?? '')
  if (content.length <= MAX_TEXT_LENGTH) return content
  return `${content.slice(0, MAX_TEXT_LENGTH - 8)}\n…（已截断）`
}

function nullableText(value: unknown): string | null {
  return value === undefined || value === null ? null : text(value)
}

function detailText(value: unknown): string {
  const content = typeof value === 'string' ? value : String(value ?? '')
  if (content.length <= MAX_DETAIL_TEXT_LENGTH) return content
  return `${content.slice(0, MAX_DETAIL_TEXT_LENGTH - 8)}\n…（已截断）`
}

function nullableDetailText(value: unknown): string | null {
  return value === undefined || value === null ? null : detailText(value)
}

function jsonObject(value: unknown): Record<string, unknown> {
  const parsed: unknown = JSON.parse(JSON.stringify(value))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return parsed as Record<string, unknown>
}

function promptPreview(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const content = String(value).replace(/\s+/g, ' ').trim()
  if (!content) return null
  if (content.length <= MAX_PROMPT_PREVIEW_LENGTH) return content
  return `${content.slice(0, MAX_PROMPT_PREVIEW_LENGTH - 1)}…`
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

function sourceForPath(path: string, configured: readonly ConfiguredPackageRoot[]): string | null {
  const target = normalizedPath(path)
  const match = [...configured]
    .sort((left, right) => right.installedPath.length - left.installedPath.length)
    .find((item) => {
      const root = normalizedPath(item.installedPath)
      return target === root || target.startsWith(`${root}/`)
    })
  return match?.source ?? null
}

function combineErrors(values: readonly string[]): string | null {
  const errors = uniqueSorted(values.map((value) => value.trim()).filter(Boolean))
  return errors.length > 0 ? errors.join('; ') : null
}

async function main(): Promise<void> {
  const cwd = process.env.PI_DESK_PLUGIN_CAPABILITY_CWD
  const agentDir = process.env.PI_DESK_PLUGIN_CAPABILITY_AGENT_DIR
  if (!cwd || !agentDir) throw new Error('插件能力盘点缺少 cwd 或 agentDir')

  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false })
  const discovered = await discoverL4PiPluginSources(cwd, agentDir, {
    DefaultPackageManager,
    SettingsManager
  })
  const missing = discovered.sources.find((item) => item.kind === 'package' && !item.path)
  if (missing) throw new Error(`包未安装，跳过能力盘点以避免隐式安装：${missing.source}`)
  const configured = discovered.sources.flatMap((item) =>
    item.path ? [{ source: item.source, installedPath: item.path }] : []
  )
  const configuredSources = new Set(configured.map((item) => item.source))
  const extensionSource = (extension: {
    path: string
    resolvedPath: string
    sourceInfo: CapabilitySourceInfo
  }): string | null =>
    extension.sourceInfo.origin === 'package' && configuredSources.has(extension.sourceInfo.source)
      ? extension.sourceInfo.source
      : sourceForPath(extension.resolvedPath || extension.path, configured)

  const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager })
  const isDisabled = await createL4PiPluginDisabledFilter(agentDir, manager, settingsManager)
  const resolved = await manager.resolve(async () => 'skip')
  type Resource = (typeof resolved.extensions)[number]
  const select = async (resources: Resource[]): Promise<Resource[]> => {
    const result: Resource[] = []
    for (const resource of resources) {
      if (
        resource.enabled &&
        resource.metadata.scope === 'user' &&
        !(await isDisabled(
          resource.metadata.source,
          resource.path,
          resource.metadata.origin === 'package'
        ))
      )
        result.push(resource)
    }
    return result
  }
  const [extensions, skills, prompts, themes] = await Promise.all([
    select(resolved.extensions),
    select(resolved.skills),
    select(resolved.prompts),
    select(resolved.themes)
  ])
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory({}),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalExtensionPaths: extensions.map((item) => item.path),
    additionalSkillPaths: skills.map((item) => item.path),
    additionalPromptTemplatePaths: prompts.map((item) => item.path),
    additionalThemePaths: themes.map((item) => item.path)
  })
  await resourceLoader.reload()
  const restoreSource = (
    item: { sourceInfo?: CapabilitySourceInfo },
    path: string | undefined,
    resources: Resource[]
  ): void => {
    if (!path) return
    const selected = resources.find((resource) => {
      const child = relative(resource.path, path)
      return child === '' || (!child.startsWith('..') && !isAbsolute(child))
    })
    if (selected) item.sourceInfo = { ...selected.metadata, path }
  }
  const extensionsResult = resourceLoader.getExtensions()
  for (const extension of extensionsResult.extensions) {
    restoreSource(extension, extension.resolvedPath || extension.path, extensions)
    for (const tool of extension.tools.values()) tool.sourceInfo = extension.sourceInfo
    for (const command of extension.commands.values()) command.sourceInfo = extension.sourceInfo
  }
  for (const skill of resourceLoader.getSkills().skills)
    restoreSource(skill, skill.filePath, skills)
  for (const prompt of resourceLoader.getPrompts().prompts)
    restoreSource(prompt, prompt.filePath, prompts)
  for (const theme of resourceLoader.getThemes().themes)
    restoreSource(theme, theme.sourcePath, themes)
  const providerRecords = new Map<string, Map<string, ProviderCapability>>()

  const extensionsBeforeSession = extensionsResult.extensions.filter(
    (extension) =>
      !extension.hidden &&
      extension.sourceInfo.scope === 'user' &&
      extensionSource(extension) !== null
  )
  const extensionSourceByPath = new Map<string, string>()
  for (const extension of extensionsBeforeSession) {
    const source = extensionSource(extension)
    if (!source) continue
    extensionSourceByPath.set(normalizedPath(extension.path), source)
    extensionSourceByPath.set(normalizedPath(extension.resolvedPath), source)
  }

  const addProvider = (extensionPath: string | undefined, capability: ProviderCapability): void => {
    if (!extensionPath) return
    const source = extensionSourceByPath.get(normalizedPath(extensionPath))
    if (!source) return
    const providers = providerRecords.get(source) ?? new Map<string, ProviderCapability>()
    providers.set(`${capability.kind}\u0000${capability.name}`, capability)
    providerRecords.set(source, providers)
  }

  for (const registration of extensionsResult.runtime.pendingProviderRegistrations) {
    addProvider(registration.extensionPath, { name: registration.name, kind: 'config' })
  }
  for (const registration of extensionsResult.runtime.pendingNativeProviderRegistrations) {
    addProvider(registration.extensionPath, {
      name: registration.provider.id,
      kind: 'native'
    })
  }

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd)
  })
  let extensionsBound = false
  const nativeErrors: ExtensionError[] = []
  try {
    const runtime = resourceLoader.getExtensions().runtime
    const registerProvider = runtime.registerProvider
    const registerNativeProvider = runtime.registerNativeProvider
    runtime.registerProvider = (name, config, extensionPath): void => {
      addProvider(extensionPath, { name, kind: 'config' })
      registerProvider(name, config, extensionPath)
    }
    runtime.registerNativeProvider = (provider, extensionPath): void => {
      addProvider(extensionPath, { name: provider.id, kind: 'native' })
      registerNativeProvider(provider, extensionPath)
    }

    await session.bindExtensions({ onError: (error) => nativeErrors.push(error) })
    extensionsBound = true

    const activeTools = new Set(session.getActiveToolNames())
    const effectiveToolPaths = new Map(
      session
        .getAllTools()
        .map((tool) => [tool.name, normalizedPath(tool.sourceInfo.path)] as const)
    )
    const extensions = resourceLoader
      .getExtensions()
      .extensions.filter(
        (extension) =>
          !extension.hidden &&
          extension.sourceInfo.scope === 'user' &&
          extensionSource(extension) !== null
      )
    const skills = resourceLoader.getSkills()
    const prompts = resourceLoader.getPrompts()
    const themes = resourceLoader.getThemes()
    const errorsBySource = new Map<string, string[]>()
    const loadErrors: string[] = [
      ...discovered.errors,
      ...settingsManager.drainErrors().map((item) => item.error.message)
    ]

    const addSourceError = (source: string | null, message: string): void => {
      if (!source) {
        loadErrors.push(message)
        return
      }
      const errors = errorsBySource.get(source) ?? []
      errors.push(message)
      errorsBySource.set(source, errors)
    }

    for (const error of [
      ...resourceLoader.getExtensions().errors,
      ...nativeErrors.map((error) => ({ path: error.extensionPath, error: error.error }))
    ]) {
      addSourceError(sourceForPath(error.path, configured), error.error)
    }
    for (const diagnostic of [
      ...skills.diagnostics,
      ...prompts.diagnostics,
      ...themes.diagnostics
    ]) {
      if (diagnostic.type !== 'error') continue
      addSourceError(
        diagnostic.path ? sourceForPath(diagnostic.path, configured) : null,
        diagnostic.message
      )
    }

    const packages = configured
      .map((item) => {
        const packageExtensions = extensions.filter(
          (extension) => extensionSource(extension) === item.source
        )
        const extensionCapabilities = packageExtensions
          .map((extension) => ({
            path: packageRelativePath(item.installedPath, extension.path, extension.sourceInfo),
            events: [...extension.handlers.entries()]
              .map(([name, handlers]) => ({ name, count: handlers.length }))
              .sort((left, right) => left.name.localeCompare(right.name)),
            commands: [...extension.commands.values()]
              .map((command) => ({
                name: command.name,
                description: nullableText(command.description)
              }))
              .sort((left, right) => left.name.localeCompare(right.name)),
            shortcuts: [...extension.shortcuts.values()]
              .map((shortcut) => ({
                shortcut: String(shortcut.shortcut),
                description: nullableText(shortcut.description)
              }))
              .sort((left, right) => left.shortcut.localeCompare(right.shortcut)),
            flags: [...extension.flags.values()]
              .map((flag) => ({
                name: flag.name,
                type: flag.type,
                description: nullableText(flag.description),
                default: flag.default ?? null
              }))
              .sort((left, right) => left.name.localeCompare(right.name)),
            messageRenderers: uniqueSorted([...extension.messageRenderers.keys()]),
            entryRenderers: uniqueSorted([...(extension.entryRenderers?.keys() ?? [])])
          }))
          .sort((left, right) => left.path.localeCompare(right.path))
        const tools = packageExtensions
          .flatMap((extension) =>
            [...extension.tools.values()].map(({ definition, sourceInfo }) => {
              const effective =
                effectiveToolPaths.get(definition.name) === normalizedPath(sourceInfo.path)
              const promptGuidelines = definition.promptGuidelines ?? []
              return {
                name: definition.name,
                label: text(definition.label),
                state: effective
                  ? activeTools.has(definition.name)
                    ? ('active' as const)
                    : ('inactive' as const)
                  : ('shadowed' as const),
                description: text(definition.description),
                parameters: jsonObject(definition.parameters),
                promptSnippet: promptPreview(definition.promptSnippet),
                promptSnippetDetail: nullableDetailText(definition.promptSnippet),
                promptGuidelines: promptGuidelines.map(detailText),
                promptGuidelineCount: promptGuidelines.length,
                promptGuidelinePreview: promptPreview(promptGuidelines[0])
              }
            })
          )
          .sort((left, right) => left.name.localeCompare(right.name))

        return {
          source: item.source,
          error: combineErrors(errorsBySource.get(item.source) ?? []),
          extensions: extensionCapabilities,
          tools,
          skills: skills.skills
            .filter((skill) => sourceInfoBelongsToPackage(skill.sourceInfo, item.source))
            .map((skill) => ({
              name: skill.name,
              description: text(skill.description),
              path: packageRelativePath(item.installedPath, skill.filePath, skill.sourceInfo),
              filePath: skill.filePath,
              modelVisible: !skill.disableModelInvocation
            }))
            .sort((left, right) => left.name.localeCompare(right.name)),
          prompts: prompts.prompts
            .filter((prompt) => sourceInfoBelongsToPackage(prompt.sourceInfo, item.source))
            .map((prompt) => ({
              name: prompt.name,
              description: text(prompt.description),
              path: packageRelativePath(item.installedPath, prompt.filePath, prompt.sourceInfo),
              filePath: prompt.filePath
            }))
            .sort((left, right) => left.name.localeCompare(right.name)),
          themes: themes.themes
            .filter((theme) => sourceInfoBelongsToPackage(theme.sourceInfo, item.source))
            .map((theme) => ({
              name: theme.name ?? basename(theme.sourcePath ?? 'theme'),
              path: packageRelativePath(
                item.installedPath,
                theme.sourcePath ?? theme.name ?? 'theme',
                theme.sourceInfo
              )
            }))
            .sort((left, right) => left.name.localeCompare(right.name)),
          providers: [...(providerRecords.get(item.source)?.values() ?? [])].sort((left, right) => {
            const kind = left.kind.localeCompare(right.kind)
            return kind === 0 ? left.name.localeCompare(right.name) : kind
          })
        }
      })
      .sort((left, right) => left.source.localeCompare(right.source))

    process.stdout.write(
      `${RESULT_PREFIX}${JSON.stringify({ packages, loadError: combineErrors(loadErrors) })}\n`
    )
  } finally {
    if (extensionsBound) {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
    }
    session.dispose()
  }
}

void main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(
      `[Pi Desk][PluginCapabilityProbe] ${error instanceof Error ? error.message : String(error)}\n`
    )
    process.exit(1)
  }
)
