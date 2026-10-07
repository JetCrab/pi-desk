import { spawn } from 'node:child_process'
import { copyFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const projectRoot = resolve(desktopRoot, '../..')
const { version } = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8'))
const releaseRoot = join(projectRoot, 'temp', 'package', 'desktop', version)
const buildRoot = resolve(
  desktopRoot,
  process.env.CARGO_TARGET_DIR || '../../temp/build/desktop-rust/local'
)
const nsisRoot = join(buildRoot, 'i686-pc-windows-msvc', 'release', 'bundle', 'nsis')
const installedExecutable = join(process.env.LOCALAPPDATA ?? '', 'Pi Desk', 'pi-desk-desktop.exe')

function commandName(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const isWindowsCommand = process.platform === 'win32' && command.endsWith('.cmd')
    const child = spawn(
      isWindowsCommand ? (process.env.ComSpec ?? 'cmd.exe') : command,
      isWindowsCommand ? ['/d', '/s', '/c', [command, ...args].join(' ')] : args,
      {
        cwd: options.cwd,
        detached: options.detached,
        stdio: options.stdio ?? 'inherit',
        windowsHide: true
      }
    )
    child.once('error', rejectRun)
    child.once('close', (code) => {
      if (code === 0 || options.allowFailure) {
        resolveRun()
        return
      }
      rejectRun(new Error(`${command} ${args.join(' ')} 退出码：${code ?? 'null'}`))
    })
  })
}

async function findInstaller() {
  const entries = await readdir(nsisRoot, { withFileTypes: true })
  const installers = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.exe'))
      .map(async (entry) => {
        const path = join(nsisRoot, entry.name)
        return { path, modifiedAt: (await stat(path)).mtimeMs }
      })
  )
  const installer = installers.sort((left, right) => right.modifiedAt - left.modifiedAt)[0]
  if (!installer) throw new Error('未找到 NSIS 安装程序。')
  return installer.path
}

async function stopPreviousShell() {
  if (process.platform !== 'win32') return
  for (const executable of ['jetcrab-desktop.exe', 'pi-desk-desktop.exe']) {
    await run('taskkill.exe', ['/IM', executable, '/T', '/F'], { allowFailure: true })
  }
}

async function installAndStart(installer) {
  if (process.platform !== 'win32') {
    throw new Error('桌面壳安装脚本目前仅支持 Windows。')
  }
  await run(installer, ['/S'])
  try {
    await stat(installedExecutable)
  } catch {
    throw new Error(`安装完成后未找到桌面壳：${installedExecutable}`)
  }

  const child = spawn(installedExecutable, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  child.unref()
}

async function main() {
  console.info('构建 Pi Desk 安装程序。')
  await run(commandName('pnpm'), ['--dir', desktopRoot, 'build'], { cwd: projectRoot })

  const installer = await findInstaller()
  await rm(releaseRoot, { recursive: true, force: true })
  await mkdir(releaseRoot, { recursive: true })
  const releaseInstaller = join(releaseRoot, installer.split(/[\\/]/).at(-1))
  await copyFile(installer, releaseInstaller)
  console.info(`安装程序已生成：${releaseInstaller}`)

  console.info('停止旧桌面壳及其托管进程。')
  await stopPreviousShell()
  console.info('静默安装并启动新桌面壳。')
  await installAndStart(releaseInstaller)
  console.info('Pi Desk 已启动。')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
