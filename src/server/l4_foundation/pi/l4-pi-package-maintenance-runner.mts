import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { L4PluginRegistrySchema } from '@common/l4_foundation/plugin/l4-plugin-package'
import { createJiti } from 'jiti'
import packageRootApi from '../process/l4-package-root.js'

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
  const publicRegistry = process.argv[5] ? L4PluginRegistrySchema.parse(process.argv[5]) : undefined
  const scope = /^npm:(@[^/]+)\//.exec(source)?.[1]
  const registryKey = scope ? `npm_config_${scope}:registry` : 'npm_config_registry'
  const inheritedEnvironment = { ...process.env }
  // 自动审计会查询整个共享依赖树，不能让无关包的联网检查阻塞维护。
  const maintenanceEnvironment: Record<string, string> = {
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    ...(publicRegistry
      ? { npm_config_registry: publicRegistry, 'npm_config_@jetcrab:registry': publicRegistry }
      : {}),
    ...(registry ? { [registryKey]: registry } : {})
  }
  const maintenanceKeys = new Set(
    Object.keys(maintenanceEnvironment).map((key) => key.toLowerCase())
  )
  for (const key of Object.keys(inheritedEnvironment)) {
    // Windows 子进程的环境名不区分大小写，不能同时保留两种拼写。
    if (maintenanceKeys.has(key.toLowerCase())) delete inheritedEnvironment[key]
  }

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

  if (action === 'reinstall' && !/^npm:((?:@[^/]+\/)?[^@]+)(?:@.+)?$/.test(source)) {
    throw new Error('重装维护只接受 npm 包来源')
  }
  const args =
    action === 'reinstall'
      ? [
          ...process.execArgv,
          fileURLToPath(new URL('./l4-pi-package-reinstall-runner.mts', import.meta.url)),
          source
        ]
      : await commandArgs(action, source)
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: {
        ...inheritedEnvironment,
        ...maintenanceEnvironment,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        PI_CODING_AGENT_DIR: agentDir,
        PI_CODING_AGENT_SESSION_DIR: join(agentDir, 'sessions')
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    activeChild = child
    // 在线 Runner 与托管父进程各自按单次启动计时；此层不再设置第二份截止时间。
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      activeChild = null
      callback()
    }

    child.stdout.on('data', (chunk: Buffer) => process.stdout.write(chunk))
    child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk))
    child.once('error', (error) => finish(() => rejectRun(error)))
    child.once('close', (code) => {
      finish(() => {
        if (code !== 0) {
          rejectRun(new Error(`Pi ${action} ${source} 退出码 ${code ?? 'null'}`))
          return
        }
        resolveRun()
      })
    })
  })
  const jiti = createJiti(import.meta.url, {
    nativeModules: [
      '@earendil-works/pi-coding-agent',
      '@earendil-works/pi-agent-core',
      '@earendil-works/pi-ai'
    ],
    tsconfigPaths: join(packageRootApi.packageRoot, 'tsconfig.json')
  })
  const preferences = await jiti.import<typeof import('./l4-pi-plugin-preferences')>(
    './l4-pi-plugin-preferences.ts'
  )
  if (action === 'remove') await preferences.removeL4PiPluginPreference(source, agentDir)
  else if (registry) await preferences.setL4PiPluginRegistry(source, registry, agentDir)
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
