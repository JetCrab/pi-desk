import 'server-only'

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CredentialSynchronizationError,
  getAgentDir,
  ModelRuntime,
  SettingsManager
} from '@earendil-works/pi-coding-agent'
import type { AuthInteraction } from '@earendil-works/pi-ai'

export interface L4ModelAuthProvider {
  provider: string
  name: string
  loggedIn: boolean
  conflict: string | null
}

export type {
  AuthEvent as L4ModelAuthNotice,
  AuthPrompt as L4ModelAuthPrompt
} from '@earendil-works/pi-ai'

export class L4ModelAuthError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message)
    this.name = 'L4ModelAuthError'
  }
}

type JsonRecord = Record<string, unknown>
const CONNECTION_FIELDS = ['baseUrl', 'apiKey', 'headers', 'api', 'oauth', 'authHeader', 'compat']

async function waitForOperation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation
  let onAbort!: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException('账号操作已取消', 'AbortError'))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([operation, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function overridesConnection(value: JsonRecord): boolean {
  return CONNECTION_FIELDS.some((field) => value[field] !== undefined)
}

async function readConflicts(path: string): Promise<Set<string>> {
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return new Set()
    throw new L4ModelAuthError(500, '无法读取模型配置，暂时不能进行账号操作')
  }
  let root: unknown
  try {
    // Pi 未公开 JSONC 解析器；保持其 BOM、单行注释和尾逗号语法，并保留字符串。
    const json = (content.charCodeAt(0) === 0xfeff ? content.slice(1) : content)
      .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ''))
      .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail: string | undefined) => tail ?? match)
    root = JSON.parse(json)
  } catch {
    throw new L4ModelAuthError(409, '模型配置格式无效，请先修正 models.json')
  }
  if (!isRecord(root) || (root.providers !== undefined && !isRecord(root.providers))) {
    throw new L4ModelAuthError(409, '模型配置格式无效，请先修正 models.json')
  }
  const conflicts = new Set<string>()
  for (const [provider, value] of Object.entries(root.providers ?? {})) {
    if (!isRecord(value)) throw new L4ModelAuthError(409, '模型服务配置格式无效')
    if (
      overridesConnection(value) ||
      (Array.isArray(value.models) &&
        value.models.some((model) => isRecord(model) && overridesConnection(model)))
    ) {
      conflicts.add(provider)
    }
  }
  return conflicts
}

export class L4ModelAuth {
  private constructor(
    private readonly runtime: ModelRuntime,
    private readonly conflicts: ReadonlySet<string>,
    private readonly agentDir: string
  ) {}

  static async create(signal?: AbortSignal): Promise<L4ModelAuth> {
    const agentDir = getAgentDir()
    const modelsPath = join(agentDir, 'models.json')
    const conflicts = await waitForOperation(readConflicts(modelsPath), signal)
    signal?.throwIfAborted()
    const runtime = await waitForOperation(
      ModelRuntime.create({
        authPath: join(agentDir, 'auth.json'),
        modelsPath,
        refreshOnCreate: false,
        allowModelNetwork: false,
        signal
      }),
      signal
    )
    signal?.throwIfAborted()
    return new L4ModelAuth(runtime, conflicts, agentDir)
  }

  async list(signal?: AbortSignal): Promise<L4ModelAuthProvider[]> {
    const credentials = await waitForOperation(this.runtime.listCredentials({ signal }), signal)
    const loggedIn = new Set(
      credentials.filter((entry) => entry.type === 'oauth').map((entry) => entry.providerId)
    )
    return this.runtime
      .getProviders()
      .filter((provider) => provider.auth.oauth)
      .map((provider) => ({
        provider: provider.id,
        name: provider.name,
        loggedIn: loggedIn.has(provider.id),
        conflict: this.conflicts.has(provider.id)
          ? '同名服务已有自定义连接，会改变账号凭据的使用方式。请先将自定义连接改为独立服务 ID，再登录账号。'
          : null
      }))
  }

  async login(provider: string, interaction: AuthInteraction): Promise<boolean> {
    try {
      await waitForOperation(
        this.runtime.login(provider, 'oauth', interaction, {
          getDeviceId: () =>
            SettingsManager.create(process.cwd(), this.agentDir).getOrCreateDeviceId()
        }),
        interaction.signal
      )
      return true
    } catch (error) {
      if (error instanceof CredentialSynchronizationError && error.operation === 'login')
        return false
      throw error
    }
  }

  async refreshCatalog(provider: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const result = await waitForOperation(
      this.runtime.refresh({ allowNetwork: true, providers: [provider], signal }),
      signal
    )
    signal.throwIfAborted()
    if (result.aborted) throw new Error('CatalogRefreshAborted')
    const error = result.errors.get(provider)
    if (error) throw error
  }

  async logout(provider: string, signal: AbortSignal): Promise<void> {
    try {
      await waitForOperation(this.runtime.logout(provider, { signal }), signal)
    } catch (error) {
      if (error instanceof CredentialSynchronizationError && error.operation === 'logout') {
        throw new L4ModelAuthError(500, '账号已退出，但本地模型目录同步失败，请重新获取模型列表')
      }
      throw error
    }
  }
}
