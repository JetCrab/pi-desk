import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { terminateManagedTree } from '../src/server/l4_foundation/process/l4-process-tree.js'

const execFileAsync = promisify(execFile)
const processExitTimeoutMs = 10_000
const windowsExitObservationTimeoutMs = 1_000

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

export function isolatedPiEnvironment(agentDir) {
  return {
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: join(agentDir, 'sessions')
  }
}

export async function prepareIsolatedPiDirectory(agentDir) {
  await mkdir(join(agentDir, 'sessions'), { recursive: true })
}

export function spawnE2eServer({
  projectRoot,
  agentDir,
  port,
  piPackageDir,
  development = false,
  target = 'pi-desk',
  managed = false,
  safeMode = false,
  standbyReadyFile,
  standbyActivateFile,
  websiteDistDir,
  nextDirectory,
  onOutput
}) {
  assert.ok(Number.isInteger(port) && port > 0, 'E2E 服务端口必须是正整数')
  assert.ok(target === 'pi-desk' || target === 'website', '未知的 E2E 服务目标')
  assert.ok(!managed || target === 'pi-desk', '托管启动仅支持 Pi Desk')
  assert.ok(!safeMode || managed, 'safeMode 仅支持托管 Pi Desk')
  assert.ok(
    Boolean(standbyReadyFile) === Boolean(standbyActivateFile),
    'standby ready/activate 文件必须同时提供'
  )
  assert.ok(!standbyReadyFile || managed, 'standby 仅支持托管 Pi Desk')
  if (target === 'website') {
    assert.ok(websiteDistDir, '官网 E2E 必须指定隔离的 Next 缓存目录')
  }
  const website = target === 'website'
  const env = {
    ...process.env,
    ...isolatedPiEnvironment(agentDir),
    ...(!website
      ? {
          PI_DESK_PI_PACKAGE_DIR:
            piPackageDir ?? join(projectRoot, 'node_modules', '@earendil-works', 'pi-coding-agent')
        }
      : {}),
    TSX_TSCONFIG_PATH: join(projectRoot, 'tsconfig.json'),
    HOST: '127.0.0.1',
    PORT: String(port),
    NODE_ENV: website || development ? 'development' : 'production',
    ...(website ? { PI_WEBSITE_DIST_DIR: websiteDistDir } : {}),
    ...(!website && development ? { PI_DESK_E2E: '1' } : {})
  }
  if (!website && development) {
    // 仅复用Next开发缓存；Agent、Session和浏览器仍由每次运行独立持有。
    const relativeNextDirectory = relative(
      projectRoot,
      nextDirectory ?? join(dirname(agentDir), 'next')
    )
    assert.ok(
      relativeNextDirectory &&
        relativeNextDirectory.startsWith(`temp${sep}`) &&
        relativeNextDirectory !== '..' &&
        !relativeNextDirectory.startsWith(`..${sep}`) &&
        !isAbsolute(relativeNextDirectory),
      'Pi Desk E2E Next 缓存必须位于项目根目录下的隔离运行目录'
    )
    env.PI_DESK_E2E_NEXT_DIR = relativeNextDirectory.split(sep).join('/')
  }
  if (website) delete env.TURBOPACK
  const restoreNextEnv =
    website || development
      ? captureNextEnvRestore(
          website ? join(projectRoot, 'apps/website') : projectRoot,
          website ? websiteDistDir : env.PI_DESK_E2E_NEXT_DIR
        )
      : () => undefined

  const args = website
    ? [
        join(projectRoot, 'apps/website/node_modules/next/dist/bin/next'),
        'dev',
        '--webpack',
        '--hostname',
        '127.0.0.1',
        '--port',
        String(port)
      ]
    : managed
      ? [
          join(projectRoot, 'bin/pi-desk.js'),
          '--no-open',
          '--hostname',
          '127.0.0.1',
          '--port',
          String(port),
          ...(safeMode ? ['--safe-mode'] : []),
          ...(standbyReadyFile
            ? [
                '--standby-ready-file',
                standbyReadyFile,
                '--standby-activate-file',
                standbyActivateFile
              ]
            : [])
        ]
      : [
          '--import',
          'tsx',
          'src/server/l1_entry/node/l1-server.ts',
          development ? '--dev' : '--start'
        ]
  const child = spawn(process.execPath, args, {
    cwd: website ? join(projectRoot, 'apps/website') : projectRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
    detached: managed && process.platform !== 'win32'
  })
  const exit = once(child, 'exit')
  const publishOutput = (data) => onOutput?.(data.toString())
  child.stdout.on('data', publishOutput)
  child.stderr.on('data', publishOutput)
  return { child, exit, port, managed, restoreNextEnv }
}

function captureNextEnvRestore(projectDirectory, nextDirectory) {
  const path = join(projectDirectory, 'next-env.d.ts')
  const previous = existsSync(path) ? readFileSync(path) : null
  const marker = `${nextDirectory.split(sep).join('/')}/`
  let restored = false
  return () => {
    if (restored) return
    restored = true
    if (!existsSync(path)) return
    const current = readFileSync(path)
    if (previous?.equals(current) || !current.toString('utf8').includes(marker)) return
    if (previous === null) unlinkSync(path)
    else writeFileSync(path, previous)
  }
}

export async function stopE2eServerTree(runtime) {
  const child = runtime.child
  if (runtime.managed && !processHasExited(child) && child.connected) {
    child.send('pi-desk.shutdown')
    await Promise.race([runtime.exit.catch(() => undefined), delay(processExitTimeoutMs)])
  }

  if (runtime.managed) {
    await terminateManagedTree(child)
  } else if (!processHasExited(child)) {
    await terminateProcessTree(child)
  }

  await Promise.race([runtime.exit.catch(() => undefined), delay(processExitTimeoutMs)])
  assert.equal(processHasExited(child), true, 'E2E 服务进程树未在截止时间内退出')
  await assertPortReleased(runtime.port)
  runtime.restoreNextEnv?.()
}

export async function assertPortReleased(port) {
  const server = createServer()
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, '127.0.0.1', () => {
      server.close((error) => (error ? rejectListen(error) : resolveListen()))
    })
  })
}

function processHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null
}

async function terminateProcessTree(child) {
  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true
      })
    } catch (error) {
      if (!processHasExited(child)) {
        await Promise.race([
          once(child, 'exit').catch(() => undefined),
          delay(windowsExitObservationTimeoutMs)
        ])
      }
      if (!processHasExited(child)) throw error
    }
    return
  }

  try {
    process.kill(child.pid, 'SIGKILL')
  } catch (error) {
    if (!processHasExited(child)) throw error
  }
}
