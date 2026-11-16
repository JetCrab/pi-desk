import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DefaultPackageManager, SettingsManager } from '@earendil-works/pi-coding-agent'

function assertSettingsSaved(settings: SettingsManager): void {
  const errors = settings.drainErrors()
  if (errors.length) {
    throw new Error(
      `插件重装配置读写失败：${errors.map(({ scope, error }) => `${scope}: ${error.message}`).join('; ')}`
    )
  }
}

async function main(): Promise<void> {
  const source = process.argv[2]
  const agentDir = process.env.PI_CODING_AGENT_DIR
  if (!source || !agentDir) throw new Error('插件重装缺少来源或配置目录')
  const cwd = process.cwd()
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false })
  assertSettingsSaved(settings)
  const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings })

  const packageName = /^npm:((?:@[^/]+\/)?[^@]+)(?:@.+)?$/.exec(source)?.[1]
  const installed = manager
    .listConfiguredPackages()
    .find(
      (item) =>
        item.scope === 'user' &&
        /^npm:((?:@[^/]+\/)?[^@]+)(?:@.+)?$/.exec(item.source)?.[1] === packageName
    )
  // installedPath 由官方包管理器检查实际路径，配置声明不代表文件已安装。
  if (installed?.installedPath) {
    process.stdout.write(`[Pi Desk][PackageReinstall] 正在清理插件文件并保留依赖锁：${source}\n`)
    // npm uninstall 会剪除独占依赖及其锁记录；只清理受管目标，让官方安装复用原依赖树。
    await rm(join(agentDir, 'npm', 'node_modules', packageName!), {
      recursive: true,
      force: true
    })
  }
  process.stdout.write(`[Pi Desk][PackageReinstall] 正在重新安装插件：${source}\n`)
  if (source === `npm:${packageName}`) {
    await manager.install(`${source}@latest`)
    manager.addSourceToSettings(source)
  } else {
    await manager.installAndPersist(source)
  }
  await settings.flush()
  assertSettingsSaved(settings)
  process.stdout.write(`[Pi Desk][PackageReinstall] 插件重装完成：${source}\n`)
}

void main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(
      `[Pi Desk][PackageReinstall] 插件重装失败：${error instanceof Error ? error.message : String(error)}\n`
    )
    process.exit(1)
  }
)
