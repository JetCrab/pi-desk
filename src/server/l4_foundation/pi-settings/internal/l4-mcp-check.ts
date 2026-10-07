import 'server-only'

import { join } from 'node:path'
import {
  CONFIG_DIR_NAME,
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager
} from '@earendil-works/pi-coding-agent'
import { L4PiSettingsStore } from '../l4-pi-settings-store'
import { L4PiSettingsError } from '../l4-pi-settings-error'
import { resolveL4McpConfig } from './l4-mcp-config'

export async function checkL4McpServer(
  input: { cwd: string | null; name: string },
  signal?: AbortSignal
): Promise<{ output: string }> {
  const { cwd, name } = input
  const agentDir = getAgentDir()
  const store = new L4PiSettingsStore(agentDir)
  const snapshot = await store.readMcp(cwd)
  if (snapshot.projectTrusted === false)
    throw new L4PiSettingsError(403, '项目尚未获得 Pi 信任，不能执行 MCP 检查')
  if (!Object.hasOwn(snapshot.local, name) && !Object.hasOwn(snapshot.inherited, name)) {
    const diagnostic = snapshot.diagnostics.find((item) => item.name === name)
    if (diagnostic) throw new L4PiSettingsError(400, diagnostic.message)
    throw new L4PiSettingsError(404, `未找到有效 MCP 服务「${name}」`)
  }
  const globalPath = join(agentDir, 'mcp.json')
  const checked = await resolveL4McpConfig(
    agentDir,
    cwd ?? agentDir,
    {
      path: globalPath,
      servers: cwd === null ? snapshot.local : snapshot.inherited
    },
    cwd !== null
      ? { path: join(cwd, CONFIG_DIR_NAME, 'mcp.json'), servers: snapshot.local }
      : undefined
  )
  const entry = checked.entries.find((item) => item.name === name)
  if (!entry)
    throw new L4PiSettingsError(
      400,
      checked.diagnostics.find((item) => item.name === name)?.message ?? 'MCP 配置无效'
    )
  if (entry.config.enabled === false) throw new L4PiSettingsError(400, `MCP 服务「${name}」已停用`)
  const target = {
    ...entry,
    config: { ...entry.config, timeout: Math.min(entry.config.timeout ?? 10, 10) }
  }
  const settingsManager = SettingsManager.inMemory({
    cacheWarming: 'off',
    retry: { enabled: false },
    compaction: { enabled: false }
  })
  const sessionCwd = cwd ?? agentDir
  const loader = new DefaultResourceLoader({
    cwd: sessionCwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: '',
    appendSystemPrompt: [],
    extensionFactories: [
      createCodemodeExtension(),
      createToolSearchExtension(),
      createMcpExtension({
        // Keep the defining scope so global provider/OAuth credentials stay with Pi's own store.
        loadConfig: () => ({ servers: [target], errors: [] }),
        openUrl: (): never => {
          throw new L4PiSettingsError(403, 'MCP 检查不允许自动打开登录授权')
        },
        updateConfig: (): never => {
          throw new L4PiSettingsError(403, 'MCP 检查不允许修改配置')
        }
      })
    ]
  })
  await loader.reload()
  if (loader.getExtensions().errors.length > 0)
    throw new L4PiSettingsError(500, 'MCP 检查扩展加载失败')
  if (signal?.aborted) throw new L4PiSettingsError(408, 'MCP 检查已取消')
  const { session } = await createAgentSession({
    cwd: sessionCwd,
    agentDir,
    settingsManager,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(sessionCwd),
    noTools: 'builtin'
  })
  const output = Buffer.alloc(32 * 1024)
  let outputSize = 0
  let nativeFailure: string | undefined
  let failure: unknown
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const operation = (async (): Promise<void> => {
    await session.bindExtensions({
      mode: 'rpc',
      uiContext: {
        ...session.extensionRunner.getUIContext(),
        notify: (message, level = 'info'): void => {
          outputSize += output.write(
            `${outputSize > 0 ? '\n' : ''}${message}`,
            outputSize,
            output.length - outputSize,
            'utf8'
          )
          if (level === 'error') nativeFailure = message.slice(0, 8192)
        }
      }
    })
    const command = session.extensionRunner.getCommand('mcp')
    if (!command) throw new L4PiSettingsError(500, '官方 MCP 检查命令不可用')
    await command.handler(`reconnect ${name}`, session.extensionRunner.createCommandContext())
    if (nativeFailure) throw new L4PiSettingsError(502, `MCP 检查失败：${nativeFailure}`)
  })()
  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new L4PiSettingsError(504, 'MCP 检查超时')), 10_000)
        onAbort = (): void => reject(new L4PiSettingsError(408, 'MCP 检查已取消'))
        signal?.addEventListener('abort', onAbort, { once: true })
        if (signal?.aborted) onAbort()
      })
    ])
  } catch (error) {
    failure = error
  } finally {
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
    try {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
    } catch (error) {
      console.error('[Pi Desk][McpCheck] 关闭检查会话失败', { name, error })
      failure ??= error
    } finally {
      try {
        session.dispose()
      } catch (error) {
        console.error('[Pi Desk][McpCheck] 释放检查会话失败', { name, error })
        failure ??= error
      }
      // Shutdown cannot interrupt SDK handshakes immediately; await the bounded request's tail.
      await Promise.allSettled([operation])
    }
  }
  if (failure) throw failure
  return { output: output.toString('utf8', 0, outputSize) }
}
