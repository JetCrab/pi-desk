import 'server-only'

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  SettingsManager
} from '@earendil-works/pi-coding-agent'
import type {
  L4McpServerConfig,
  L4McpSettings,
  L4McpSettingsReplaceInput
} from './internal/l4-pi-settings-types'
import { L4PiSettingsError } from './l4-pi-settings-error'
import { resolveL4McpConfig, type L4McpConfigSource } from './internal/l4-mcp-config'

const fileTails = new Map<string, Promise<void>>()

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readObject(path: string): Promise<JsonObject> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  try {
    const value: unknown = JSON.parse(text)
    if (!isObject(value)) throw new Error('根节点必须是对象')
    return value
  } catch (error) {
    throw new L4PiSettingsError(
      500,
      `配置文件损坏，未作修改：${path}（${error instanceof Error ? error.message : String(error)}）`
    )
  }
}

function source(path: string, root: JsonObject): L4McpConfigSource {
  if (root.mcpServers !== undefined && !isObject(root.mcpServers)) {
    throw new L4PiSettingsError(500, `配置文件损坏，mcpServers 必须是对象：${path}`)
  }
  return {
    path,
    servers: (root.mcpServers as JsonObject | undefined) ?? {},
    autoEnableCodemode: root.autoEnableCodemode
  }
}

function publicServers(servers: JsonObject): L4McpSettings['local'] {
  return Object.fromEntries(
    Object.entries(servers).flatMap(([name, value]) =>
      isObject(value) ? [[name, value as L4McpServerConfig]] : []
    )
  )
}

async function mutateFile<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(path)
  const result = (fileTails.get(key) ?? Promise.resolve()).then(operation)
  const tail = result.then(
    () => undefined,
    () => undefined
  )
  fileTails.set(key, tail)
  try {
    return await result
  } finally {
    if (fileTails.get(key) === tail) fileTails.delete(key)
  }
}

async function atomicWrite(path: string, root: JsonObject): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(root, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx'
    })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

function officialSettings(root: JsonObject): SettingsManager {
  return SettingsManager.fromStorage(
    {
      withLock: (scope, fn): void => {
        fn(scope === 'global' ? JSON.stringify(root) : undefined)
      }
    },
    { projectTrusted: false }
  )
}

export class L4PiSettingsStore {
  constructor(private readonly agentDir = getAgentDir()) {}

  async readMcp(cwd: string | null): Promise<L4McpSettings> {
    const globalPath = this.mcpPath(null)
    const global = source(globalPath, await readObject(globalPath))
    const projectPath = cwd === null ? undefined : this.mcpPath(cwd)
    const project = projectPath ? source(projectPath, await readObject(projectPath)) : undefined
    const resolved = await resolveL4McpConfig(this.agentDir, cwd ?? this.agentDir, global, project)
    let projectTrusted: boolean | null = null
    if (cwd !== null) {
      if (!hasTrustRequiringProjectResources(cwd)) projectTrusted = true
      else {
        const decision = new ProjectTrustStore(this.agentDir).get(cwd)
        projectTrusted =
          decision ??
          officialSettings(
            await readObject(join(this.agentDir, 'settings.json'))
          ).getDefaultProjectTrust() === 'always'
      }
    }
    return {
      local: publicServers((project ?? global).servers),
      inherited: project ? publicServers(global.servers) : {},
      projectTrusted,
      diagnostics: resolved.diagnostics.map(({ name, message }) => ({ name, message }))
    }
  }

  async replaceMcp(input: L4McpSettingsReplaceInput): Promise<Record<string, never>> {
    const { cwd, servers } = input
    const path = this.mcpPath(cwd)
    return mutateFile(path, async () => {
      const root = await readObject(path)
      const current = source(path, root)
      const next = { ...current, servers: { ...current.servers, ...servers } }
      const globalPath = this.mcpPath(null)
      const global = cwd === null ? next : source(globalPath, await readObject(globalPath))
      const names = new Set([...Object.keys(global.servers), ...Object.keys(next.servers)])
      for (const name of Object.keys(servers)) {
        const clash = [...names].find(
          (other) => other !== name && other.replace(/-/g, '_') === name.replace(/-/g, '_')
        )
        if (clash) throw new L4PiSettingsError(400, `MCP 服务「${name}」与「${clash}」名称冲突`)
      }
      const checked = await resolveL4McpConfig(
        this.agentDir,
        cwd ?? this.agentDir,
        global,
        cwd === null ? undefined : next
      )
      const invalid = checked.diagnostics.find(
        (diagnostic) =>
          diagnostic.scope === (cwd === null ? 'global' : 'project') &&
          diagnostic.name !== null &&
          Object.hasOwn(servers, diagnostic.name)
      )
      if (invalid) throw new L4PiSettingsError(400, invalid.message)
      await atomicWrite(path, { ...root, mcpServers: next.servers })
      return {}
    })
  }

  async deleteMcp(input: { cwd: string | null; name: string }): Promise<Record<string, never>> {
    const { cwd, name } = input
    const path = this.mcpPath(cwd)
    return mutateFile(path, async () => {
      const root = await readObject(path)
      const current = source(path, root)
      if (!Object.hasOwn(current.servers, name))
        throw new L4PiSettingsError(404, `当前范围未定义 MCP 服务「${name}」`)
      const servers = { ...current.servers }
      delete servers[name]
      await atomicWrite(path, { ...root, mcpServers: servers })
      return {}
    })
  }

  private mcpPath(cwd: string | null): string {
    return cwd === null ? join(this.agentDir, 'mcp.json') : join(cwd, CONFIG_DIR_NAME, 'mcp.json')
  }
}
