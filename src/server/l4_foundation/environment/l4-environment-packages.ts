import { execFile, spawn } from 'node:child_process'
import { join } from 'node:path'
import packageRootApi from '../process/l4-package-root.js'
import { promisify } from 'node:util'

const execute = promisify(execFile)

export async function installL4EnvironmentPackage(input: {
  source: string
  cwd: string
  agentDir: string
  project: boolean
  registry?: string
}): Promise<void> {
  // 官方 manager 的子命令可能继承 stdout/stderr；隔离输出，避免来源/凭据进入维护日志。
  await new Promise<void>((resolveInstall, reject) => {
    const child = spawn(
      process.execPath,
      [
        ...process.execArgv,
        join(
          packageRootApi.packageRoot,
          'src/server/l4_foundation/environment/l4-environment-package-install.mts'
        )
      ],
      { env: process.env, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true }
    )
    let failed = false
    child.once('error', () => {
      failed = true
    })
    child.stdin.on('error', () => {
      failed = true
    })
    child.once('close', (code) => {
      if (!failed && code === 0) resolveInstall()
      else reject(new Error('官方Pi包安装未确认成功'))
    })
    child.stdin.end(JSON.stringify(input))
  })
}

export function isL4EnvironmentGitSource(source: string): boolean {
  return /^(?:git:|https?:\/\/|ssh:\/\/)/i.test(source)
}

/** 沿官方 manager 的 @ref 语法，仅把记录的实际 commit 固定到原仓库来源。 */
export function pinL4EnvironmentGitSource(source: string, commit: string): string {
  if (!/^[0-9a-f]{40,64}$/i.test(commit)) throw new Error('Git提交格式无效')
  const prefix = source.startsWith('git:') && !source.startsWith('git://') ? 'git:' : ''
  let repo = prefix ? source.slice(4) : source
  repo = repo.split('#')[0]!
  const protocol = repo.indexOf('://')
  const pathStart =
    protocol >= 0
      ? repo.indexOf('/', protocol + 3)
      : repo.startsWith('git@')
        ? repo.indexOf(':')
        : repo.indexOf('/')
  const ref = repo.indexOf('@', pathStart + 1)
  if (ref >= 0) repo = repo.slice(0, ref)
  return `${prefix}${repo}@${commit}`
}

export async function captureL4EnvironmentGitSource(
  source: string,
  root: string
): Promise<string | null> {
  try {
    const { stdout } = await execute('git', ['-C', root, 'rev-parse', 'HEAD'], {
      timeout: 5000,
      maxBuffer: 1024,
      windowsHide: true
    })
    const { stdout: dirty } = await execute(
      'git',
      ['-C', root, 'status', '--porcelain', '--untracked-files=normal'],
      { timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true }
    )
    if (dirty.trim()) return null
    return pinL4EnvironmentGitSource(source, stdout.trim())
  } catch {
    return null
  }
}
