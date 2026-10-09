import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { L4PluginRegistrySchema } from '@common/l4_foundation/plugin/l4-plugin-package'
import { createJiti } from 'jiti'

const PACKAGE_CLI_TIMEOUT_MS = 5 * 60 * 1000

type PackageAction = 'install' | 'update' | 'remove' | 'reinstall'

let activeChild: ChildProcess | null = null
let stopping = false

function readAction(input: string | undefined): PackageAction {
  if (input === 'install' || input === 'update' || input === 'remove' || input === 'reinstall')
    return input
  throw new Error('插件维护操作无效')
}

async function commandArgs(
  action: Exclude<PackageAction, 'reinstall'>,
  source: string
): Promise<string[]> {
  const piRoot = process.env.PI_DESK_PI_PACKAGE_DIR
  if (!piRoot) throw new Error('插件维护缺少全局 Pi 运行目录')
  const manifest = JSON.parse(await readFile(join(piRoot, 'package.json'), 'utf8')) as {
    bin: string | { pi: string }
  }
  const cliPath = join(piRoot, typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.pi)
  if (action === 'install') return [cliPath, 'install', source, '--no-approve']
  if (action === 'update') return [cliPath, 'update', '--extension', source, '--no-approve']
  return [cliPath, 'remove', source, '--no-approve']
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    await new Promise<void>((resolveTerminate) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      })
      killer.once('error', () => resolveTerminate())
      killer.once('close', () => resolveTerminate())
    })
    return
  }
  child.kill('SIGKILL')
}

function stop(signal: 'SIGINT' | 'SIGTERM'): void {
  if (stopping) return
  stopping = true
  const child = activeChild
  void (child ? terminateProcessTree(child) : Promise.resolve()).finally(() => {
    process.exit(signal === 'SIGINT' ? 130 : 143)
  })
}

async function main(): Promise<void> {
  const action = readAction(process.argv[2])
  const source = process.argv[3]?.trim()
  if (!source || source.length > 2048) throw new Error('插件维护来源无效')
  const registry = process.argv[4] ? L4PluginRegistrySchema.parse(process.argv[4]) : undefined
  const scope = /^npm:(@[^/]+)\//.exec(source)?.[1]
  const inheritedEnvironment = { ...process.env }
  if (registry) {
    // Windows 子进程的环境名不区分大小写，不能同时保留两种拼写。
    const replaced = new Set([
      'npm_config_registry',
      ...(scope ? [`npm_config_${scope}:registry`.toLowerCase()] : [])
    ])
    for (const key of Object.keys(inheritedEnvironment)) {
      if (replaced.has(key.toLowerCase())) delete inheritedEnvironment[key]
    }
  }
  const registryEnvironment: Record<string, string> = registry
    ? {
        npm_config_registry: registry,
        ...(scope ? { [`npm_config_${scope}:registry`]: registry } : {})
      }
    : {}

  const configuredAgentDir = process.env.PI_CODING_AGENT_DIR
  const agentDir =
    configuredAgentDir && isAbsolute(configuredAgentDir)
      ? configuredAgentDir
      : (await import('@earendil-works/pi-coding-agent')).getAgentDir()
  // 维护 cwd 是可重建目录；独立 CLI 不加载 Next 模块或触发应用数据迁移。
  const cwd =
    process.env.PI_DESK_PACKAGE_MAINTENANCE_CWD ??
    join(agentDir, 'pi-desk', 'plugin-package-manager')
  await mkdir(cwd, { recursive: true })

  let actions: Array<Exclude<PackageAction, 'reinstall'>>
  if (action === 'reinstall') {
    const packageName = /^npm:((?:@[^/]+\/)?[^@]+)(?:@.+)?$/.exec(source)?.[1]
    if (!packageName) throw new Error('重装维护只接受 npm 包来源')
    const { SettingsManager } = await import('@earendil-works/pi-coding-agent')
    const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false })
    const errors = settings.drainErrors()
    if (errors.length) throw new Error(errors.map(({ error }) => error.message).join('; '))
    const configured = settings.getGlobalSettings().packages ?? []
    const installed = configured.some((item) => {
      const value = typeof item === 'string' ? item : item.source
      return /^npm:((?:@[^/]+\/)?[^@]+)(?:@.+)?$/.exec(value)?.[1] === packageName
    })
    actions = installed ? ['remove', 'install'] : ['install']
  } else {
    actions = [action]
  }

  for (const step of actions) {
    const args = await commandArgs(step, source)
    await new Promise<void>((resolveRun, rejectRun) => {
      const child = spawn(process.execPath, args, {
        cwd,
        env: {
          ...inheritedEnvironment,
          ...registryEnvironment,
          FORCE_COLOR: '0',
          NO_COLOR: '1',
          PI_CODING_AGENT_DIR: agentDir,
          PI_CODING_AGENT_SESSION_DIR: join(agentDir, 'sessions')
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
      activeChild = child
      let timedOut = false
      let settled = false
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        activeChild = null
        clearTimeout(timeout)
        callback()
      }

      child.stdout.on('data', (chunk: Buffer) => process.stdout.write(chunk))
      child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk))
      child.once('error', (error) => finish(() => rejectRun(error)))
      child.once('close', (code) => {
        finish(() => {
          if (timedOut) {
            rejectRun(new Error(`Pi ${step} ${source} 超时`))
            return
          }
          if (code !== 0) {
            rejectRun(new Error(`Pi ${step} ${source} 退出码 ${code ?? 'null'}`))
            return
          }
          resolveRun()
        })
      })

      const timeout = setTimeout(() => {
        timedOut = true
        void terminateProcessTree(child)
      }, PACKAGE_CLI_TIMEOUT_MS)
      timeout.unref()
    })
  }
  const jiti = createJiti(import.meta.url, {
    nativeModules: [
      '@earendil-works/pi-coding-agent',
      '@earendil-works/pi-agent-core',
      '@earendil-works/pi-ai'
    ],
    tsconfigPaths: join(process.cwd(), 'tsconfig.json')
  })
  const preferences = await jiti.import<typeof import('./l4-pi-plugin-preferences')>(
    './l4-pi-plugin-preferences.ts'
  )
  if (action === 'remove') preferences.removeL4PiPluginPreference(source, agentDir)
  else if (registry) preferences.setL4PiPluginRegistry(source, registry, agentDir)
}

process.on('SIGINT', () => stop('SIGINT'))
process.on('SIGTERM', () => stop('SIGTERM'))

void main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(
      `[Pi Desk][PackageMaintenance] ${error instanceof Error ? error.message : String(error)}\n`
    )
    process.exit(1)
  }
)
