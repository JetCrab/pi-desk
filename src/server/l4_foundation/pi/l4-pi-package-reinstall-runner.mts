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
    .some(
      (item) =>
        item.scope === 'user' &&
        /^npm:((?:@[^/]+\/)?[^@]+)(?:@.+)?$/.exec(item.source)?.[1] === packageName
    )
  if (installed) {
    process.stdout.write(`[Pi Desk][PackageReinstall] 正在卸载插件文件：${source}\n`)
    // remove 不删除配置声明，installAndPersist 由官方实现保留原有对象过滤设置。
    await manager.remove(source)
  }
  process.stdout.write(`[Pi Desk][PackageReinstall] 正在重新安装插件：${source}\n`)
  await manager.installAndPersist(source)
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
