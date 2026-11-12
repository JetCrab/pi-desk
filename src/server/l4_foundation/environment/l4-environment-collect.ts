import { createReadStream } from 'node:fs'
import { bindConfigStore } from '@jetcrab/pi-desk-sdk/config'
import { exportL4UnifiedConfig } from './l4-environment-unified-config'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { globL4Environment } from './l4-environment-glob'
import { basename, dirname, join, relative, resolve, win32, sep } from 'node:path'
import { homedir } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import {
  DefaultPackageManager,
  SettingsManager,
  getAgentDir
} from '@earendil-works/pi-coding-agent'
import {
  createSecretStore,
  isSecretReference,
  type SecretStore
} from '@jetcrab/pi-desk-sdk/secrets'
import { L4EnvironmentPackageDeclarationSchema } from '@common/l4_foundation/environment/l4-environment-file-contract'
import {
  canL4EnvironmentDesktop,
  exportL4EnvironmentDesktop,
  isL4EnvironmentDesktopOwnerFile
} from './l4-environment-desktop'
import {
  L4_ENVIRONMENT_NATIVE_FILES,
  L4_ENVIRONMENT_INSTRUCTION_FILES,
  isL4EnvironmentMachinePath,
  isL4EnvironmentSessionStoragePath,
  l4EnvironmentConfigTitle
} from './l4-environment-files'
import { L4_ENVIRONMENT_HOST_FILES } from './l4-environment-host-files'
import { captureL4EnvironmentGitSource, isL4EnvironmentGitSource } from './l4-environment-packages'
import { L4EnvironmentValidationError } from './l4-environment-error'
import { assertEnvironmentEntryPath, environmentPathKey } from './l4-environment-paths'
import { convertEnvironmentSessionLine } from './l4-environment-sessions'
import {
  collectL4EnvironmentSecretReferences,
  localPathsL4EnvironmentConfig,
  readL4EnvironmentStructured,
  transformL4EnvironmentConfig
} from './l4-environment-config'
import {
  ENVIRONMENT_ARCHIVE_DEFAULT_LIMITS,
  type EnvironmentArchiveEntry
} from './l4-environment-archive'
import {
  L4EnvironmentWorkStateSchema,
  type L4EnvironmentFile,
  type L4EnvironmentManifest
} from './l4-environment-manifest'

const MAX_CONFIG_BYTES = 32 * 1024 ** 2

export async function* linesL4Environment(
  content: AsyncIterable<Uint8Array>
): AsyncGenerator<{ text: string; ending: string }> {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  for await (const chunk of content) {
    pending += decoder.write(Buffer.from(chunk))
    let newline: number
    while ((newline = pending.indexOf('\n')) >= 0) {
      const cr = newline > 0 && pending[newline - 1] === '\r'
      yield { text: pending.slice(0, cr ? newline - 1 : newline), ending: cr ? '\r\n' : '\n' }
      pending = pending.slice(newline + 1)
    }
    if (Buffer.byteLength(pending) > 64 * 1024 ** 2) throw new Error('会话单行超过64MiB限制')
  }
  pending += decoder.end()
  if (pending) yield { text: pending, ending: '' }
}

export async function readL4EnvironmentBounded(
  content: AsyncIterable<Uint8Array>,
  maximum = MAX_CONFIG_BYTES
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of content) {
    size += chunk.length
    if (size > maximum) throw new Error('结构化环境配置超过容量限制')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

export async function* walkL4Environment(root: string): AsyncGenerator<string> {
  if (isL4EnvironmentMachinePath(basename(root))) return
  const info = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!info) return
  if (info.isSymbolicLink()) throw new Error('环境备份不跟随符号链接')
  if (info.isFile()) {
    yield root
    return
  }
  if (!info.isDirectory()) throw new Error('环境备份只接受普通文件')
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (isL4EnvironmentMachinePath(entry.name)) continue
    yield* walkL4Environment(join(root, entry.name))
  }
}

function containsSecretReference(value: unknown): boolean {
  if (isSecretReference(value)) return true
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.values(value).some(containsSecretReference)
  )
}

export interface L4EnvironmentCollection {
  manifest: L4EnvironmentManifest
  entries: () => AsyncGenerator<EnvironmentArchiveEntry>
}

export async function collectL4Environment(input: {
  agentDir: string
  cwd: string
  includeSessions: boolean
  includePluginData: boolean
  store?: SecretStore
}): Promise<L4EnvironmentCollection> {
  const agentDir = resolve(input.agentDir)
  const sourcePlatform =
    process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
  const platform = sourcePlatform === 'win32' ? 'win32' : 'posix'
  const store = input.store ?? createSecretStore({ agentDir })
  const files: L4EnvironmentFile[] = []
  let metadataBytes = 0
  const nativeConfigFiles = new Set<string>(L4_ENVIRONMENT_NATIVE_FILES)
  const rootEntries = await readdir(agentDir, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    }
  )
  const skippedRootFiles = rootEntries.filter(
    (entry) =>
      entry.isFile() &&
      !isL4EnvironmentMachinePath(entry.name) &&
      /\.(?:json|ya?ml)$/i.test(entry.name) &&
      !nativeConfigFiles.has(entry.name)
  )
  const overrides = new Map<string, Buffer>()
  const inlineSecrets = new Map<string, Record<string, string>>()
  const seen = new Set<string>()
  const settings = SettingsManager.create(input.cwd, agentDir, { projectTrusted: false })
  const manager = new DefaultPackageManager({ cwd: input.cwd, agentDir, settingsManager: settings })
  const manifest: L4EnvironmentManifest = {
    version: 1,
    sourcePlatform,
    sourceAgentDir: agentDir,
    files,
    workSessions: [],
    pinnedCount: 0,
    packages: [],
    warnings: [
      '包含配置、自定义资源和所选数据；普通项目源码、交付文件、日志及运行任务不在备份范围。',
      '请先停止其他正在使用同一配置目录的 Pi 或 Pi Desk 实例，避免它们在备份或恢复时修改文件。'
    ]
  }
  async function add(sourcePath: string, options: Partial<L4EnvironmentFile> = {}): Promise<void> {
    const key = environmentPathKey(sourcePath, platform)
    if (seen.has(key)) return
    const info = await lstat(sourcePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!info && !overrides.has(key)) return
    if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error('环境配置必须是普通文件')
    if (info && (await realpath(sourcePath)) !== resolve(sourcePath))
      throw new Error('环境配置祖先包含符号链接')
    seen.add(key)
    const path = relative(agentDir, sourcePath).split(win32.sep).join('/')
    const file: L4EnvironmentFile = {
      id: `item-${files.length}`,
      entry: `files/${files.length}`,
      title: basename(sourcePath),
      category: 'config',
      base: 'agent',
      path,
      sourcePath,
      bytes: overrides.get(key)?.length ?? info!.size,
      format: 'binary',
      localPaths: [],
      mappingSources: [],
      omitPaths: [],
      secretPaths: [],
      sourceCwd: null,
      sessionId: null,
      children: [],
      warnings: [],
      secretEntry: null,
      ...options
    }
    if (!options.title && file.category !== 'session' && file.base !== 'desktop')
      file.title =
        file.base === 'resource'
          ? sourcePath
          : l4EnvironmentConfigTitle(file.base, file.path, file.sourceCwd)
    assertEnvironmentEntryPath(file.path)
    if (file.format !== 'binary' && file.bytes > MAX_CONFIG_BYTES)
      throw new Error('配置文件超过32MiB限制')
    if (file.path === 'config/pi-desk.yaml')
      file.warnings.push('统一配置若含登录保护设置，恢复后需要使用备份中的登录密码。')
    metadataBytes += Buffer.byteLength(JSON.stringify(file))
    if (
      files.length >= ENVIRONMENT_ARCHIVE_DEFAULT_LIMITS.maxFiles ||
      metadataBytes > MAX_CONFIG_BYTES
    )
      throw new L4EnvironmentValidationError('备份文件数或清单容量超过归档限制')
    files.push(file)
  }
  const state = await readFile(join(agentDir, 'pi-desk', 'work-sessions.json'), 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    }
  )
  const bindingState = state
    ? L4EnvironmentWorkStateSchema.parse(JSON.parse(state))
    : { workSessions: [], pinnedCount: 0 }
  const bindings = bindingState.workSessions
  const pinnedCount = bindingState.pinnedCount
  const projectCwds = [...new Set([input.cwd, ...bindings.map((binding) => binding.cwd)])]
  const load = (path: string): Promise<Buffer> =>
    overrides.has(environmentPathKey(path, platform))
      ? Promise.resolve(overrides.get(environmentPathKey(path, platform))!)
      : readL4EnvironmentBounded(createReadStream(path))
  const desktopPath = join(agentDir, 'config', 'desktop.json')
  if (canL4EnvironmentDesktop(agentDir)) {
    const portable = await exportL4EnvironmentDesktop(agentDir)
    overrides.set(environmentPathKey(desktopPath, platform), portable)
    await add(desktopPath, {
      base: 'desktop',
      path: 'desktop.portable.json',
      title: '桌面环境',
      warnings: ['导入仅暂存桌面配置，需完整退出并重启桌面后生效；Node 服务重启不等于桌面重启。']
    })
  } else if (
    await lstat(desktopPath).then(
      () => true,
      () => false
    )
  ) {
    throw new L4EnvironmentValidationError(
      '存在桌面配置，但当前桌面程序不支持此备份功能；请先升级桌面程序，避免复制无法在其他机器解密的文件'
    )
  } else manifest.warnings.push('本包不包含桌面设置。恢复这些设置需要支持备份功能的桌面程序。')
  let skippedProjectFiles = 0
  async function collectNativeResources(): Promise<void> {
    for (const name of L4_ENVIRONMENT_NATIVE_FILES) {
      await add(
        join(agentDir, name),
        name === 'settings.json'
          ? {
              format: 'json',
              localPaths: [
                '/extensions/*',
                '/skills/*',
                '/prompts/*',
                '/themes/*',
                '/packages/*',
                '/packages/*/source'
              ],
              omitPaths: ['/shellPath']
            }
          : {}
      )
    }
    for (const name of ['skills', 'agents', 'prompts', 'themes', 'extensions']) {
      for await (const path of walkL4Environment(join(agentDir, name))) await add(path)
    }
    async function collectConfiguredResources(
      resourceSettings: Record<string, unknown>,
      baseDir: string
    ): Promise<void> {
      for (const kind of ['skills', 'agents', 'prompts', 'themes', 'extensions'] as const) {
        const values: unknown = resourceSettings[kind]
        if (!Array.isArray(values)) continue
        for (const value of values) {
          if (typeof value !== 'string') continue
          if (/^[!-]/.test(value)) continue
          const declaredPath = value.startsWith('+') ? value.slice(1) : value
          const pattern = (
            declaredPath.startsWith('~/')
              ? join(process.env.HOME || homedir(), declaredPath.slice(2))
              : resolve(baseDir, declaredPath)
          ).replaceAll('\\', '/')
          const sources: string[] = []
          if (/[*?\[\]{}]/.test(pattern)) {
            for await (const match of globL4Environment(pattern)) sources.push(resolve(match))
          } else sources.push(resolve(pattern))
          if (!sources.length)
            manifest.warnings.push('有外部资源声明未匹配任何文件，请核对源配置。')
          for (const source of sources) {
            const info = await lstat(source).catch((error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return null
              throw error
            })
            if (!info) {
              manifest.warnings.push('有全局资源指向不存在的外部路径，包中不包含缺失文件。')
              continue
            }
            const root = info.isDirectory() ? source : dirname(source)
            const resourceRoot =
              kind === 'skills' && basename(source) === 'SKILL.md' ? root : source
            for await (const resource of walkL4Environment(resourceRoot))
              await add(resource, {
                base: 'resource',
                path: `resources/${kind}/${files.length}/${basename(resource)}`,
                mappingSources: [root],
                warnings: [
                  '外部全局资源需要映射到实际目标目录；任意程序参数或源码中的字符串不自动改写。'
                ]
              })
          }
        }
      }
    }
    if (resolve(getAgentDir()) === agentDir) {
      const agentsSkills = join(process.env.HOME || homedir(), '.agents', 'skills')
      for await (const path of walkL4Environment(agentsSkills))
        await add(path, {
          base: 'resource',
          path: `resources/user-agents/${files.length}/${relative(agentsSkills, path).split(win32.sep).join('/')}`,
          mappingSources: [agentsSkills]
        })
    }
    await collectConfiguredResources(
      settings.getGlobalSettings() as Record<string, unknown>,
      agentDir
    )
    for (const cwd of projectCwds) {
      let directory = cwd
      while (true) {
        for (const instructionName of L4_ENVIRONMENT_INSTRUCTION_FILES) {
          const instruction = join(directory, instructionName)
          if (
            await lstat(instruction).then(
              (info) => info.isFile(),
              () => false
            )
          )
            await add(instruction, {
              base: 'resource',
              path: `resources/instructions/${files.length}/${instructionName}`,
              mappingSources: [directory]
            })
        }
        const agentsSkills = join(directory, '.agents', 'skills')
        for await (const path of walkL4Environment(agentsSkills))
          await add(path, {
            base: 'resource',
            path: `resources/project-agents/${files.length}/${relative(agentsSkills, path).split(win32.sep).join('/')}`,
            mappingSources: [directory]
          })
        const parent = dirname(directory)
        if (parent === directory) break
        directory = parent
      }
      const projectSettings = await load(join(cwd, '.pi', 'settings.json')).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null
          throw error
        }
      )
      if (projectSettings)
        await collectConfiguredResources(
          readL4EnvironmentStructured(projectSettings, 'json') as Record<string, unknown>,
          join(cwd, '.pi')
        )
      const rootMcp = join(cwd, 'mcp.json')
      const mcpContent = await load(rootMcp).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (mcpContent) {
        if (containsSecretReference(readL4EnvironmentStructured(mcpContent, 'json')))
          throw new L4EnvironmentValidationError('项目mcp.json含未声明凭据引用，不能原样恢复')
        await add(rootMcp, {
          base: 'resource',
          path: `resources/projects/${files.length}/mcp.json`,
          format: 'json',
          mappingSources: [cwd]
        })
      }
      for await (const projectPath of walkL4Environment(join(cwd, '.pi'))) {
        const name = relative(join(cwd, '.pi'), projectPath).split(win32.sep).join('/')
        const projectKey = environmentPathKey(projectPath, platform)
        if (seen.has(projectKey)) continue
        const currentConfig = name.startsWith('config/')
        const nativeFile = L4_ENVIRONMENT_NATIVE_FILES.some((file) => file === name)
        const resourceFile = ['extensions/', 'skills/', 'agents/', 'prompts/', 'themes/'].some(
          (prefix) => name.startsWith(prefix)
        )
        if (!currentConfig && !nativeFile && !resourceFile) {
          skippedProjectFiles++
          continue
        }
        const isStructured = currentConfig && /\.(json|ya?ml)$/i.test(name)
        if (isStructured && !seen.has(environmentPathKey(projectPath, platform))) {
          const format = /\.ya?ml$/i.test(name) ? ('yaml' as const) : ('json' as const)
          if (containsSecretReference(readL4EnvironmentStructured(await load(projectPath), format)))
            throw new L4EnvironmentValidationError(
              '未声明的项目配置含凭据引用，不能生成不可恢复的备份'
            )
        }
        await add(projectPath, {
          base: 'project',
          path: name,
          sourceCwd: cwd,
          ...(isStructured &&
          !declared.has(projectKey) &&
          !L4_ENVIRONMENT_NATIVE_FILES.some((file) => file === name)
            ? {
                warnings: ['此项目文件将按原格式恢复，请检查其中的本机路径和凭据设置。']
              }
            : {}),
          ...(isStructured ? { format: /\.ya?ml$/i.test(name) ? 'yaml' : 'json' } : {}),
          ...(name === 'settings.json'
            ? {
                format: 'json',
                localPaths: [
                  '/extensions/*',
                  '/skills/*',
                  '/prompts/*',
                  '/themes/*',
                  '/packages/*',
                  '/packages/*/source'
                ],
                omitPaths: ['/shellPath']
              }
            : {})
        })
      }
    }
  }
  const declared = new Set<string>()
  const localPackages: string[] = []
  const declarations = [...L4_ENVIRONMENT_HOST_FILES]
  const configuredPackages = manager
    .listConfiguredPackages()
    .filter((pkg) => pkg.scope === 'user')
    .map((pkg) => ({ ...pkg, projectCwd: undefined as string | undefined }))
  for (const cwd of projectCwds) {
    const projectSettings = await load(join(cwd, '.pi', 'settings.json')).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      }
    )
    if (
      !projectSettings ||
      !(readL4EnvironmentStructured(projectSettings, 'json') as { packages?: unknown[] }).packages
        ?.length
    )
      continue
    // 仅允许静态发现已安装资源，不创建 AgentSession、不加载代码、不写 trust.json。
    const projectManager = new DefaultPackageManager({
      cwd,
      agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true })
    })
    configuredPackages.push(
      ...projectManager
        .listConfiguredPackages()
        .filter((pkg) => pkg.scope === 'project')
        .map((pkg) => ({ ...pkg, projectCwd: cwd }))
    )
  }
  for (const pkg of configuredPackages) {
    const packageContent = pkg.installedPath
      ? await load(join(pkg.installedPath, 'package.json'))
          .then((content) => content.toString('utf8'))
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
            throw error
          })
      : null
    const raw: unknown = packageContent === null ? null : JSON.parse(packageContent)
    const metadata = raw as {
      name?: string
      version?: string
      piDesk?: { environment?: unknown }
    } | null
    const packageRecord: L4EnvironmentManifest['packages'][number] = {
      source: pkg.source,
      name: metadata?.name ?? null,
      version: metadata?.version ?? null,
      ...(pkg.projectCwd ? { projectCwd: pkg.projectCwd } : {})
    }
    if (!pkg.source.startsWith('npm:') && pkg.installedPath) {
      if (isL4EnvironmentGitSource(pkg.source)) {
        const pinned = await captureL4EnvironmentGitSource(pkg.source, pkg.installedPath)
        if (pinned) packageRecord.installSource = pinned
        else
          manifest.warnings.push('有Git安装无法确认干净的实际提交，未锁定来源不会自动拉取或升级。')
      } else {
        packageRecord.localPath = pkg.installedPath
        if (!localPackages.includes(pkg.installedPath)) localPackages.push(pkg.installedPath)
      }
    }
    manifest.packages.push(packageRecord)
    if (!metadata?.version)
      manifest.warnings.push('有安装包未安装或缺少精确版本，不能保证自动重装，请核对来源。')
    if (metadata?.piDesk?.environment === undefined) continue
    const declaration = L4EnvironmentPackageDeclarationSchema.parse(metadata.piDesk.environment)
    declarations.push(...declaration.files)
  }
  for (const file of declarations) {
    if (file.base === 'data' && !input.includePluginData) continue
    if (
      file.format === 'binary' &&
      [file.localPaths, file.omitPaths, file.secretPaths].some((paths) => paths?.length)
    )
      throw new L4EnvironmentValidationError('二进制文件不能声明结构化路径、排除或敏感字段')
    assertEnvironmentEntryPath(file.path)
    if (isL4EnvironmentMachinePath(file.path)) throw new Error('安装包声明包含不可移植数据')
    const cwds = file.base === 'project' ? projectCwds : [input.cwd]
    for (const cwd of cwds) {
      const base =
        file.base === 'project'
          ? join(cwd, '.pi')
          : join(agentDir, file.base === 'config' ? 'config' : 'pi-desk')
      const source = join(base, file.path)
      if (isL4EnvironmentSessionStoragePath(relative(agentDir, source).split(win32.sep).join('/')))
        throw new L4EnvironmentValidationError('安装包不能声明核心会话存储文件')
      if (isL4EnvironmentDesktopOwnerFile(agentDir, source))
        throw new L4EnvironmentValidationError('安装包不能把Rust Owner文件声明为普通配置')
      const options: Partial<L4EnvironmentFile> = {
        base: file.base === 'project' ? 'project' : 'agent',
        path:
          file.base === 'project'
            ? file.path
            : `${file.base === 'config' ? 'config' : 'pi-desk'}/${file.path}`,
        category: file.base === 'data' ? 'plugin-data' : 'config',
        sourceCwd: file.base === 'project' ? cwd : null,
        format: file.format,
        localPaths: file.localPaths ?? [],
        omitPaths: file.omitPaths ?? [],
        secretPaths: file.secretPaths ?? []
      }
      const info = await lstat(source).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (info?.isDirectory()) {
        if (file.format !== 'binary')
          throw new L4EnvironmentValidationError('目录声明只支持binary，JSON/YAML必须指向普通文件')
        for await (const child of walkL4Environment(source)) {
          const childPath = `${file.path}/${relative(source, child).split(sep).join('/')}`
          declared.add(environmentPathKey(child, platform))
          await add(child, {
            ...options,
            path:
              file.base === 'project'
                ? childPath
                : `${file.base === 'config' ? 'config' : 'pi-desk'}/${childPath}`
          })
        }
        continue
      }
      declared.add(environmentPathKey(source, platform))
      if (file.secretPaths === undefined && file.format !== 'binary') {
        const content = await load(source).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null
          throw error
        })
        if (content && containsSecretReference(readL4EnvironmentStructured(content, file.format)))
          throw new L4EnvironmentValidationError(
            '已安装包配置含未声明的凭据引用；请由插件 Owner 明确 secretPaths 后导出，不猜测普通字符串'
          )
      }
      if (
        file.base === 'project' &&
        file.format !== 'binary' &&
        file.secretPaths === undefined &&
        (await lstat(source).then(
          () => true,
          () => false
        ))
      )
        throw new L4EnvironmentValidationError(
          '项目配置缺少 secretPaths 声明，不能安全导出明文敏感字段'
        )
      await add(source, options)
    }
  }
  const preferences = await load(join(agentDir, 'config', 'pi-desk-plugins.json')).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    }
  )
  if (preferences) {
    const config = readL4EnvironmentStructured(preferences, 'json') as {
      registries?: Record<string, string>
    }
    for (const pkg of manifest.packages) {
      const name = /^npm:((?:@[^/]+\/)?[^@]+)(?:@.+)?$/.exec(pkg.source)?.[1]
      const registry = name ? config.registries?.[`npm:${name}`] : undefined
      if (registry) {
        const url = new URL(registry)
        if (
          !['https:', 'http:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new L4EnvironmentValidationError('安装包 Registry 配置无效')
        pkg.registry = registry
      }
    }
  }
  for (const root of localPackages) {
    const rootInfo = await lstat(root)
    const base = rootInfo.isDirectory() ? root : dirname(root)
    for await (const path of walkL4Environment(root)) {
      if (isL4EnvironmentSessionStoragePath(relative(agentDir, path).split(win32.sep).join('/')))
        continue
      await add(path, {
        base: 'resource',
        path: `resources/local-packages/${localPackages.indexOf(root)}/${relative(base, path).split(win32.sep).join('/')}`,
        title: `本地Pi包 / ${root} / ${relative(base, path)}`,
        mappingSources: [base],
        warnings: ['本地Pi包代码已收集；node_modules、缓存及运行数据不复制。']
      })
    }
  }
  await collectNativeResources()
  if (skippedProjectFiles)
    manifest.warnings.push(`跳过${skippedProjectFiles}个未登记项目文件，不读取或转换旧项目配置。`)
  const skippedCount = skippedRootFiles.filter(
    (entry) => !seen.has(environmentPathKey(join(agentDir, entry.name), platform))
  ).length
  if (skippedCount)
    manifest.warnings.push(
      `跳过${skippedCount}个未登记根目录文件；仅收集最新config、Pi原生文件、资源和已声明data，不识别或搬移旧配置。`
    )
  for await (const path of walkL4Environment(join(agentDir, 'config'))) {
    if (isL4EnvironmentDesktopOwnerFile(agentDir, path)) continue
    if (declared.has(environmentPathKey(path, platform))) continue
    const format = /\.json$/i.test(path) ? 'json' : /\.ya?ml$/i.test(path) ? 'yaml' : 'binary'
    if (
      format !== 'binary' &&
      containsSecretReference(readL4EnvironmentStructured(await load(path), format))
    )
      throw new L4EnvironmentValidationError(
        '未知自有配置含未声明的凭据引用，不能生成不可恢复的备份'
      )
    await add(path, {
      format,
      warnings: ['此配置将按原格式恢复，请检查其中的本机路径和凭据设置。']
    })
  }
  if (input.includeSessions) {
    const pending: string[] = []
    const discovered = new Set<string>()
    for await (const path of walkL4Environment(join(agentDir, 'sessions')))
      if (path.endsWith('.jsonl')) pending.push(path)
    for (let index = 0; index < pending.length; index += 1) {
      const path = pending[index]!
      const key = environmentPathKey(path, platform)
      if (discovered.has(key)) continue
      discovered.add(key)
      type SessionHeader = { type?: string; id?: string; cwd?: string; parentSession?: string }
      let header: SessionHeader | null = null
      let sessionName = ''
      let firstUser = ''
      const references: string[] = []
      for await (const line of linesL4Environment(createReadStream(path))) {
        if (!line.text.trim()) continue
        if (!header) {
          header = JSON.parse(line.text) as SessionHeader
          if (header.type !== 'session' || !header.id || !header.cwd) throw new Error('会话头无效')
        }
        const metadata = JSON.parse(line.text) as {
          type?: string
          name?: unknown
          message?: { role?: string; content?: unknown }
        }
        if (metadata.type === 'session_info' && typeof metadata.name === 'string')
          sessionName = metadata.name.replace(/\s+/g, ' ').trim().slice(0, 120)
        if (!firstUser && metadata.type === 'message' && metadata.message?.role === 'user') {
          const content = metadata.message.content
          firstUser =
            typeof content === 'string'
              ? content
              : Array.isArray(content)
                ? content
                    .filter(
                      (part): part is { type: string; text: string } =>
                        part?.type === 'text' && typeof part.text === 'string'
                    )
                    .map((part) => part.text)
                    .join(' ')
                : ''
          firstUser = firstUser.replace(/\s+/g, ' ').trim().slice(0, 120)
        }
        const converted = convertEnvironmentSessionLine(line.text, {
          sourcePlatform: platform,
          targetPlatform: platform,
          sourceSessionFile: path,
          targetSessionFile: path,
          projectMappings: [],
          sessionFileMappings: []
        })
        references.push(
          ...converted.missingReferences
            .filter((ref) => ref.kind === 'session')
            .map((ref) => resolve(dirname(path), ref.path))
        )
      }
      if (!header) throw new Error('会话为空')
      if (header.parentSession) {
        const parent = environmentPathKey(resolve(dirname(path), header.parentSession), platform)
        for (let index = references.length - 1; index >= 0; index -= 1)
          if (environmentPathKey(references[index]!, platform) === parent)
            references.splice(index, 1)
      }
      await add(path, {
        path: relative(agentDir, path).startsWith('..')
          ? `sessions/external/${basename(path)}`
          : relative(agentDir, path).split(win32.sep).join('/'),
        category: 'session',
        title: sessionName || firstUser || basename(path),
        sourceCwd: header.cwd!,
        sessionId: header.id!,
        children: references,
        warnings: header.parentSession
          ? [
              '该会话包含父会话引用；只有所选包内会话会重定位，未选父会话保留原引用，不复制外部文件。'
            ]
          : []
      })
      for (const reference of references) {
        if (
          !reference.endsWith('.jsonl') ||
          discovered.has(environmentPathKey(reference, platform))
        )
          continue
        const info = await lstat(reference).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null
          throw error
        })
        if (info?.isFile() && !info.isSymbolicLink()) pending.push(reference)
      }
    }
    const sessions = files.filter((file) => file.category === 'session')
    for (const child of sessions) {
      const parts = child.sourcePath.split(win32.sep).join('/').split('/')
      const marker = parts.lastIndexOf('subagents')
      if (marker < 0 || marker + 1 >= parts.length - 1) continue
      const parent = sessions.find(
        (file) => file.sessionId === parts[marker + 1] && file.sourceCwd === child.sourceCwd
      )
      if (parent) parent.children.push(child.sourcePath)
    }
    for (const file of sessions) {
      file.children = [...new Set(file.children)]
      if (
        file.children.some((child) => !sessions.some((candidate) => candidate.sourcePath === child))
      )
        file.warnings.push('存在包外子会话或结构引用，导入不会复制外部文件。')
    }
    manifest.workSessions = bindings
    manifest.pinnedCount = pinnedCount
    if (
      bindings.some(
        (binding) =>
          !sessions.some(
            (file) => file.sessionId === binding.sessionId && file.sourceCwd === binding.cwd
          )
      )
    )
      manifest.warnings.push(
        '有工作会话尚无可导出的JSONL或历史文件缺失；对应空/缺失历史绑定不会隐含创建。'
      )
  }
  for (const file of files) {
    if (file.base === 'agent' && file.path === 'config/pi-desk.yaml') {
      const portable = await exportL4UnifiedConfig(
        await load(file.sourcePath),
        bindConfigStore('pi-desk', 'environment', { agentDir })
      )
      overrides.set(environmentPathKey(file.sourcePath, platform), portable.content)
      inlineSecrets.set(file.id, portable.secrets)
      file.secretPaths = portable.paths
      file.bytes = portable.content.length
      file.warnings.push('统一配置中的本机路径保持原值，恢复后需按目标机器检查。')
    }
    if (file.format !== 'binary') {
      const content = transformL4EnvironmentConfig({
        content: await load(file.sourcePath),
        file,
        requireSecretReferences: true
      })
      const paths = localPathsL4EnvironmentConfig(content, file, platform)
      for (const path of paths) {
        const info = await lstat(path).catch(() => null)
        file.mappingSources.push(info?.isDirectory() ? path : dirname(path))
      }
      file.mappingSources = [...new Set(file.mappingSources)]
    }
    if (file.format === 'binary') continue
    if (file.secretPaths.length > 0) file.secretEntry = `secrets/${file.id}`
  }
  return {
    manifest,
    async *entries(): AsyncGenerator<EnvironmentArchiveEntry> {
      const content = Buffer.from(JSON.stringify(manifest))
      if (content.length > MAX_CONFIG_BYTES)
        throw new L4EnvironmentValidationError('备份清单超过32MiB限制')
      yield { path: 'manifest.json', size: content.length, content: toAsync(content) }
      for (const file of files) {
        if (file.format !== 'binary') {
          const content = transformL4EnvironmentConfig({
            content: await load(file.sourcePath),
            file,
            requireSecretReferences: true
          })
          yield { path: file.entry, size: content.length, content: toAsync(content) }
          if (file.secretEntry) {
            const refs = collectL4EnvironmentSecretReferences(
              readL4EnvironmentStructured(content, file.format),
              file.secretPaths
            )
            const secrets = Buffer.from(
              JSON.stringify(
                inlineSecrets.get(file.id) ?? (refs.length ? await store.export(refs) : {})
              )
            )
            if (secrets.length > MAX_CONFIG_BYTES)
              throw new L4EnvironmentValidationError(
                '单项凭据导出超过32MiB，不能生成无法预览的备份'
              )
            yield { path: file.secretEntry, size: secrets.length, content: toAsync(secrets) }
          }
        } else if (overrides.has(environmentPathKey(file.sourcePath, platform))) {
          const content = await load(file.sourcePath)
          yield { path: file.entry, size: content.length, content: toAsync(content) }
        } else
          yield { path: file.entry, size: file.bytes, content: createReadStream(file.sourcePath) }
      }
    }
  }
}

export async function* toAsync(content: Buffer): AsyncGenerator<Buffer> {
  yield content
}
