import { execFileSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function restoreSdkArchive(archive, directory) {
  directory = resolve(directory)
  await mkdir(directory, { recursive: true })
  // Windows tar 会将带盘符的参数误识别为远端路径，统一从目标目录使用相对路径。
  const file = relative(directory, resolve(archive)).replaceAll('\\', '/')
  execFileSync(
    process.platform === 'win32' ? 'tar.exe' : 'tar',
    ['-xzf', file, '--strip-components=1'],
    {
      cwd: directory,
      stdio: 'inherit'
    }
  )
  console.info('同批 SDK 制品已恢复。')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [archive, directory] = process.argv.slice(2)
  if (!archive || !directory) throw new Error('用法：restore-sdk.mjs <制品> <目标目录>')
  await restoreSdkArchive(archive, directory)
}
