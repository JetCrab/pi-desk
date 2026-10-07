import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HostSettingsSchema } from '@jetcrab/pi-desk-sdk/settings'
import {
  createAgentSession,
  DefaultPackageManager,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager
} from '@earendil-works/pi-coding-agent'
import {
  L4PiPluginOwnerRuntime,
  type L4PiPluginAppRuntimeSink,
  type L4PiPluginPackageSource
} from './l4-pi-plugin-owner-runtime'

import { discoverL4PiPluginSources } from './l4-pi-plugin-sources'

const RESULT_PREFIX = '__PI_DESK_PLUGIN_PROBE__'

async function checkNative(cwd: string, agentDir: string): Promise<string | null> {
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false })
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager })
  console.info('[Pi Desk][PluginProbe] Native资源加载')
  await resourceLoader.reload()
  const errors = resourceLoader.getExtensions().errors.map(({ path, error }) => `${path}: ${error}`)
  if (errors.length > 0) return errors.join('\n')
  console.info('[Pi Desk][PluginProbe] Native会话创建')
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd)
  })
  try {
    console.info('[Pi Desk][PluginProbe] Native启动事件')
    await session.bindExtensions({
      onError: (error) => {
        errors.push(`${error.extensionPath}: ${error.error}`)
      }
    })
    for (const diagnostic of [
      ...resourceLoader.getSkills().diagnostics,
      ...resourceLoader.getPrompts().diagnostics,
      ...resourceLoader.getThemes().diagnostics
    ]) {
      if (diagnostic.type === 'error') errors.push(diagnostic.message)
    }
  } finally {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        session.extensionRunner
          .emit({ type: 'session_shutdown', reason: 'quit' })
          .catch((error: unknown) => {
            console.warn('[Pi Desk][PluginProbe] Native清理失败', String(error))
          }),
        new Promise<void>((done) => {
          timer = setTimeout(done, 1500)
        })
      ])
    } finally {
      clearTimeout(timer)
      session.dispose()
    }
  }
  return errors.length ? errors.join('\n') : null
}

async function main(): Promise<void> {
  const cwd = process.env.PI_DESK_PLUGIN_PROBE_CWD
  const agentDir = process.env.PI_DESK_PLUGIN_PROBE_AGENT_DIR
  if (!cwd || !agentDir) throw new Error('插件预检缺少 cwd 或 agentDir')

  const provider = async (): Promise<readonly L4PiPluginPackageSource[]> => {
    const snapshot = await discoverL4PiPluginSources(cwd, agentDir, {
      DefaultPackageManager,
      SettingsManager
    })
    const errors = [
      ...snapshot.errors,
      ...snapshot.sources.flatMap((item) => (item.error ? [item.error] : []))
    ]
    if (errors.length > 0) throw new Error(errors.join('; '))
    return snapshot.sources.flatMap((item) =>
      item.enabled && item.piDeskRoot
        ? [{ source: item.source, installedPath: item.piDeskRoot }]
        : []
    )
  }

  const settingsPath = join(agentDir, 'pi-desk-settings.json')
  const settings = HostSettingsSchema.parse(
    existsSync(settingsPath)
      ? JSON.parse(readFileSync(settingsPath, 'utf8'))
      : { region: { locale: 'en', timeZone: 'UTC' } }
  )
  const runtime = new L4PiPluginOwnerRuntime(provider, {
    getSnapshot: () => settings,
    subscribe: () => () => undefined
  })
  const probeAppRuntimeSink: L4PiPluginAppRuntimeSink = {
    setState: () => undefined,
    publishNotification: () => randomUUID(),
    updateNotification: () => undefined,
    deleteNotification: () => undefined,
    releasePlugin: () => undefined
  }
  runtime.bindAppRuntimeSink(probeAppRuntimeSink)
  try {
    console.info('[Pi Desk][PluginProbe] Node入口初始化')
    await runtime.initialize()
    await runtime.listBrowserEntries()
    console.info('[Pi Desk][PluginProbe] Node入口完成')
    const diagnostic = runtime.readDiagnostics()
    if (process.env.PI_DESK_PLUGIN_PROBE_NATIVE === '1' && !diagnostic.loadError) {
      diagnostic.loadError = await checkNative(cwd, agentDir)
    }
    process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(diagnostic)}\n`)
  } finally {
    await runtime.dispose()
  }
}

void main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(
      `[Pi Desk][PluginProbe] ${error instanceof Error ? error.message : String(error)}\n`
    )
    process.exit(1)
  }
)
