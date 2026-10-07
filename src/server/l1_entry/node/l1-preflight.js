'use strict'

const { spawn } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs/promises')
const { createServer } = require('node:net')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const { terminateManagedTree } = require('../../l4_foundation/process/l4-process-tree.js')
const { PI_RUNTIME_EXIT_CODE } = require('../../l4_foundation/pi/l4-pi-global-runtime.js')
const { packageRoot } = require('../../l4_foundation/process/l4-package-root.js')
const timeoutMs = 120_000

async function reservePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  return port
}

async function assertPortReleased(port) {
  const server = createServer()
  server.listen(port, '127.0.0.1')
  await once(server, 'listening')
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
}

async function runPreflight() {
  const temporaryRoot = path.join(packageRoot, 'temp')
  await fs.mkdir(temporaryRoot, { recursive: true })
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'preflight-'))
  const agentDir = path.join(directory, 'agent')
  let child
  let exit
  let port
  let failure
  try {
    await fs.mkdir(path.join(agentDir, 'sessions'), { recursive: true })
    port = await reservePort()
    const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'))
    console.info(`[Pi Desk][Preflight] 开始隔离启动检查：版本 ${manifest.version}，端口 ${port}`)
    child = spawn(
      process.execPath,
      [
        path.join(packageRoot, 'bin', 'pi-desk.js'),
        '--no-open',
        '--safe-mode',
        '-H',
        '127.0.0.1',
        '-p',
        String(port)
      ],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          NODE_ENV: 'production',
          PI_CODING_AGENT_DIR: agentDir,
          PI_CODING_AGENT_SESSION_DIR: path.join(agentDir, 'sessions'),
          PI_DESK_E2E: '',
          PI_DESK_LOG_FILE: '',
          PI_DESK_STANDBY: '',
          PI_DESK_PLUGIN_MAINTENANCE_ERROR: ''
        },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        windowsHide: true,
        detached: process.platform !== 'win32'
      }
    )
    let spawnError
    child.once('error', (error) => {
      spawnError = error
    })
    exit = new Promise((resolve) => child.once('close', resolve))
    const started = Date.now()
    let lastError = '服务尚未响应'
    while (Date.now() - started < timeoutMs) {
      if (spawnError) throw spawnError
      if (child.exitCode !== null || child.signalCode !== null) {
        throw Object.assign(new Error(`候选服务提前退出：${child.exitCode ?? child.signalCode}`), {
          exitCode: child.exitCode
        })
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
          signal: AbortSignal.timeout(2000)
        })
        const body = await response.json()
        if (
          response.ok &&
          body.code === 0 &&
          body.data?.status === 'ready' &&
          body.data?.version === manifest.version
        ) {
          console.info(`[Pi Desk][Preflight] 候选包健康检查通过，耗时 ${Date.now() - started} 毫秒`)
          return
        }
        lastError = `HTTP ${response.status}，版本 ${body.data?.version ?? '未知'}`
      } catch (error) {
        lastError = error.message
      }
      await delay(250)
    }
    throw new Error(`候选服务在 ${timeoutMs / 1000} 秒内未就绪：${lastError}`)
  } catch (error) {
    failure = error
    throw error
  } finally {
    try {
      if (child) {
        if (child.connected) child.send('pi-desk.shutdown', () => {})
        await Promise.race([exit, delay(5000, undefined, { ref: false })])
        await terminateManagedTree(child)
        await Promise.race([exit, delay(5000, undefined, { ref: false })])
        if (child.exitCode === null && child.signalCode === null) {
          throw new Error('候选服务进程尚未退出')
        }
      }
      if (port) await assertPortReleased(port)
      await fs.rm(directory, { recursive: true, force: true })
      console.info('[Pi Desk][Preflight] 隔离服务与临时数据已清理')
    } catch (error) {
      console.error(`[Pi Desk][Preflight] 清理失败，保留诊断目录 ${directory}：${error.message}`)
      if (!failure) throw error
    }
  }
}

runPreflight().catch((error) => {
  console.error(`[Pi Desk][Preflight] 启动检查失败：${error.message}`)
  process.exitCode = error.exitCode === PI_RUNTIME_EXIT_CODE ? PI_RUNTIME_EXIT_CODE : 1
})
