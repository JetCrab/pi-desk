import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import {
  normalizeRoutePath,
  readRemoteDebugConfig,
  validateRemoteDebugConfig,
  writeRemoteDebugConfig,
  type RemoteDebugConfig
} from './config.js'
import {
  DEFAULT_REMOTE_DEBUG_RANGES,
  remoteDebugProjectSaveSchema,
  remoteDebugRangesSchema,
  remoteDebugRegistrationDeleteSchema,
  remoteDebugRegistrationSchema,
  type RemoteDebugProjectSave,
  type RemoteDebugRange,
  type RemoteDebugRanges,
  type RemoteDebugRegistration,
  type RemoteDebugRegistrationDelete,
  type RemoteDebugSettings
} from './l4-remote-debug-contract.js'
import { isLocalPortAvailable } from './l4-remote-debug-ports.js'
import { readDesktopTunnelServer } from './desktop-tunnel-host.js'

const persistedSettingsSchema = remoteDebugRangesSchema.extend({
  registrations: z.array(remoteDebugRegistrationSchema)
})
type PersistedSettings = z.infer<typeof persistedSettingsSchema>

interface SettingsStoreOptions {
  agentDir?: string
  readTunnelServer?: () => Promise<string | null>
  isPortAvailable?: (port: number) => Promise<boolean>
}

export class RemoteDebugSettingsStore {
  private readonly path: string
  private readonly queryTunnelServer: () => Promise<string | null>
  private readonly isPortAvailable: (port: number) => Promise<boolean>
  private queue: Promise<void> = Promise.resolve()

  constructor(options: SettingsStoreOptions = {}) {
    const agentDir =
      options.agentDir ??
      (process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent'))
    this.path = join(agentDir, 'pi-desk-remote-debug-ports.json')
    this.queryTunnelServer = options.readTunnelServer ?? readDesktopTunnelServer
    this.isPortAvailable = options.isPortAvailable ?? isLocalPortAvailable
  }

  async get(): Promise<RemoteDebugSettings> {
    await this.queue
    return { ...(await this.read()), tunnelServer: await this.readTunnelServer() }
  }

  saveRanges(value: RemoteDebugRanges): Promise<RemoteDebugSettings> {
    return this.enqueue(async () => {
      const ranges = remoteDebugRangesSchema.parse(value)
      const settings = await this.read()
      const tunnelServer = await this.readTunnelServer()
      const next = { ...settings, ...ranges }
      await this.persist(next)
      return { ...next, tunnelServer }
    })
  }

  syncProject(cwd: string): Promise<void> {
    return this.enqueue(async () => {
      const canonicalCwd = await realpath(cwd)
      const config = await readRemoteDebugConfig(canonicalCwd)
      if (!config) return
      const settings = await this.read()
      const tunnelServer = await this.readTunnelServer()
      if (syncRegistrations(settings, canonicalCwd, config, tunnelServer)) {
        await this.persist(settings)
      }
    })
  }

  async projectCwds(): Promise<string[]> {
    const settings = await this.get()
    const cwds = new Map<string, string>()
    for (const registration of settings.registrations) {
      cwds.set(cwdKey(registration.cwd), registration.cwd)
    }
    return [...cwds.values()]
  }

  saveProject(input: RemoteDebugProjectSave): Promise<RemoteDebugConfig> {
    return this.enqueue(async () => {
      const draft = remoteDebugProjectSaveSchema.parse(input)
      if (!isAbsolute(draft.cwd)) throw new Error('项目目录必须是服务端绝对路径')
      const cwd = await realpath(draft.cwd)
      const profiles = Object.create(null) as Record<
        string,
        {
          description: string
          command: string
          entryPort: number
          publicPort: number
          routes: Record<string, number>
        }
      >
      // 先以合法占位端口复用 YAML 校验；所有名称与路由错误均早于任何写入。
      for (const profile of draft.profiles) {
        if (Object.hasOwn(profiles, profile.name)) {
          throw new Error(`Profile 名称规范化后重复：${profile.name}`)
        }
        const routes = Object.create(null) as Record<string, number>
        for (const route of profile.routes) {
          const path = normalizeRoutePath(route.path)
          if (Object.hasOwn(routes, path)) {
            throw new Error(`Profile ${profile.name} 的路由重复：${path}`)
          }
          routes[path] = route.targetPort ?? 1
        }
        profiles[profile.name] = {
          description: profile.description,
          command: profile.command,
          entryPort: profile.entryPort ?? 1,
          publicPort: profile.publicPort ?? 1,
          routes
        }
      }
      validateRemoteDebugConfig({ version: 1, profiles })
      const existing = await readRemoteDebugConfig(cwd)
      const settings = await this.read()
      const tunnelServer = await this.readTunnelServer()
      if (existing) syncRegistrations(settings, cwd, existing, tunnelServer)
      const registeredLocal = settings.registrations.flatMap((item) => [
        item.entryPort,
        ...item.routePorts
      ])
      const registeredPublic = settings.registrations
        .filter((item) => item.tunnelServer === tunnelServer)
        .map((item) => item.publicPort)
      const localPorts = new Set(registeredLocal)
      const publicPorts = new Set(registeredPublic)
      const allocateLocal = createPortAllocator(
        settings.localRange,
        localPorts,
        registeredLocal,
        this.isPortAvailable,
        '本机'
      )
      const allocatePublic = createPortAllocator(
        settings.publicRange,
        publicPorts,
        registeredPublic,
        null,
        '公网'
      )
      // 手填值允许重复，但本批自动端口必须避开所有手填值（包括后面的 Profile）。
      for (const profile of draft.profiles) {
        if (profile.entryPort !== null) localPorts.add(profile.entryPort)
        if (profile.publicPort !== null) publicPorts.add(profile.publicPort)
        for (const route of profile.routes) {
          if (route.targetPort !== null) localPorts.add(route.targetPort)
        }
      }
      for (const profile of draft.profiles) {
        const target = profiles[profile.name]!
        target.entryPort = profile.entryPort ?? (await allocateLocal())
        target.publicPort = profile.publicPort ?? (await allocatePublic())
        for (const route of profile.routes) {
          target.routes[normalizeRoutePath(route.path)] =
            route.targetPort ?? (await allocateLocal())
        }
      }
      const config = validateRemoteDebugConfig({ version: 1, profiles })
      await writeRemoteDebugConfig(cwd, config)
      syncRegistrations(settings, cwd, config, tunnelServer)
      try {
        await this.persist(settings)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        console.error(`[pi-desk-remote-debug] 项目配置已保存但端口登记失败：${cwd}；${detail}`)
        throw new Error(`项目配置已保存，但全局端口登记失败；下次同步可修复：${detail}`)
      }
      return config
    })
  }

  removeRegistration(input: RemoteDebugRegistrationDelete): Promise<RemoteDebugSettings> {
    return this.enqueue(async () => {
      const value = remoteDebugRegistrationDeleteSchema.parse(input)
      // 失联或已删除的项目仍可手工删除，不依赖 realpath 成功。
      const cwd = await realpath(value.cwd).catch(() => resolve(value.cwd))
      const tunnelServer = value.tunnelServer
      const settings = await this.read()
      const currentServer = await this.readTunnelServer()
      settings.registrations = settings.registrations.filter(
        (registration) =>
          !(
            cwdKey(registration.cwd) === cwdKey(cwd) &&
            registration.profile === value.profile &&
            registration.tunnelServer === tunnelServer
          )
      )
      await this.persist(settings)
      return { ...settings, tunnelServer: currentServer }
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation)
    this.queue = pending.then(
      () => undefined,
      () => undefined
    )
    return pending
  }

  private async read(): Promise<PersistedSettings> {
    const metadata = await lstat(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (!metadata) return { ...structuredClone(DEFAULT_REMOTE_DEBUG_RANGES), registrations: [] }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`端口登记必须是非符号链接普通文件：${this.path}`)
    }
    const content = await readFile(this.path, 'utf8')
    try {
      return persistedSettingsSchema.parse(JSON.parse(content))
    } catch (error) {
      throw new Error(
        `端口登记文件无效：${this.path}；${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  private async persist(settings: PersistedSettings): Promise<void> {
    const directory = resolve(this.path, '..')
    await mkdir(directory, { recursive: true })
    const metadata = await lstat(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (metadata && (metadata.isSymbolicLink() || !metadata.isFile())) {
      throw new Error(`端口登记必须是非符号链接普通文件：${this.path}`)
    }
    const temporary = `${this.path}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx'
      })
      await rename(temporary, this.path)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  private async readTunnelServer(): Promise<string | null> {
    const server = await this.queryTunnelServer()
    return server?.trim() ? normalizeTunnelServer(server) : null
  }
}

function cwdKey(cwd: string): string {
  const normalized = resolve(cwd)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function normalizeTunnelServer(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('控制服务地址不是有效 URL')
  }
  if (url.protocol !== 'http:' || !url.hostname) {
    throw new Error('控制服务地址必须使用 http:// 并包含主机名')
  }
  if (url.username || url.password) throw new Error('控制服务地址不能包含账号或密码')
  return url.toString().replace(/\/+$/, '')
}

function syncRegistrations(
  settings: PersistedSettings,
  cwd: string,
  config: RemoteDebugConfig,
  tunnelServer: string | null
): boolean {
  const before = JSON.stringify(settings.registrations)
  const current = new Map<string, RemoteDebugRegistration>()
  for (const [profile, value] of Object.entries(config.profiles)) {
    current.set(profile, {
      cwd,
      profile,
      entryPort: value.entryPort,
      routePorts: [...new Set(value.routes.map((route) => route.targetPort))].filter(
        (port) => port !== value.entryPort
      ),
      publicPort: value.publicPort,
      tunnelServer
    })
  }
  // 本机配置不按服务器分组；历史服务器仅保留公网端口归属。
  settings.registrations = settings.registrations.flatMap((item) => {
    if (cwdKey(item.cwd) !== cwdKey(cwd)) return [item]
    const registration = current.get(item.profile)
    if (!registration || (tunnelServer !== null && item.tunnelServer === null)) return []
    return [
      {
        ...item,
        cwd,
        entryPort: registration.entryPort,
        routePorts: registration.routePorts
      }
    ]
  })
  for (const [profile, registration] of current) {
    const index = settings.registrations.findIndex(
      (item) =>
        cwdKey(item.cwd) === cwdKey(cwd) &&
        item.profile === profile &&
        item.tunnelServer === tunnelServer
    )
    if (index === -1) settings.registrations.push(registration)
    else settings.registrations[index] = registration
  }
  return before !== JSON.stringify(settings.registrations)
}

function createPortAllocator(
  range: RemoteDebugRange,
  ports: Set<number>,
  registered: readonly number[],
  available: ((port: number) => Promise<boolean>) | null,
  label: string
): () => Promise<number> {
  let maximum = range.start - 1
  for (const port of registered) {
    if (port >= range.start && port <= range.end) maximum = Math.max(maximum, port)
  }
  const length = range.end - range.start + 1
  let next = maximum + 1
  return async () => {
    for (let offset = 0; offset < length; offset += 1) {
      const port = range.start + ((next - range.start + offset) % length)
      if (ports.has(port) || (available && !(await available(port)))) continue
      ports.add(port)
      next = port + 1
      return port
    }
    throw new Error(`${label}端口范围 ${range.start}-${range.end} 已耗尽，请扩大范围或手动指定端口`)
  }
}
