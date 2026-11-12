import {
  DefaultPackageManager,
  SettingsManager,
  getAgentDir
} from '@earendil-works/pi-coding-agent'
import { z } from 'zod'
import { readL4EnvironmentBounded } from './l4-environment-collect'

try {
  const input = z
    .object({
      source: z.string().min(1),
      cwd: z.string().min(1),
      agentDir: z.string().min(1),
      project: z.boolean(),
      registry: z.string().url().optional()
    })
    .strict()
    .parse(
      JSON.parse((await readL4EnvironmentBounded(process.stdin, 1024 * 1024)).toString('utf8'))
    )
  if (input.agentDir !== getAgentDir()) throw new Error('包安装环境不匹配')
  if (input.registry) {
    const url = new URL(input.registry)
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('Registry无效')
    const scope = /^npm:(@[^/]+)\//.exec(input.source)?.[1]
    process.env[scope ? `npm_config_${scope}:registry` : 'npm_config_registry'] = input.registry
  }
  const manager = new DefaultPackageManager({
    cwd: input.cwd,
    agentDir: input.agentDir,
    settingsManager: SettingsManager.create(input.cwd, input.agentDir, {
      projectTrusted: input.project
    })
  })
  await manager.install(input.source, input.project ? { local: true } : undefined)
  process.exit(0)
} catch {
  // 父进程只消费退出码；不输出第三方命令可能携带秘密的错误正文。
  process.exit(1)
}
