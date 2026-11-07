import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const [gatewayImage, smokePath] = process.argv.slice(2)
assert.ok(gatewayImage && smokePath, '需要隧道镜像和验收程序路径')
const architecture = process.env.IMAGE_ARCH ?? { x64: 'amd64', arm64: 'arm64' }[process.arch]
assert.ok(['amd64', 'arm64'].includes(architecture), '需要当前架构对应的镜像验收制品')
const parent = resolve('temp/run/tunnel-image')
await mkdir(parent, { recursive: true })
const directory = await mkdtemp(join(parent, 'single-container-'))
const suffix = `${process.pid}-${randomBytes(4).toString('hex')}`
const prefix = process.env.CONTAINER_NAME ?? `tunnel-smoke-${suffix}`
const container = `${prefix}-gateway`
const volume = `${prefix}-data`
const stop = new AbortController()
const interrupt = () => stop.abort(new Error('隧道镜像验收被中断'))
process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)
const env = { ...process.env }
let succeeded = false
let failure

async function docker(args) {
  return execute('docker', args, { env, timeout: 45_000, maxBuffer: 4 * 1024 * 1024 })
}

async function reservePort(port = 0) {
  const listener = net.createServer()
  await new Promise((resolveReady, reject) => {
    listener.once('error', reject)
    listener.listen(port, '127.0.0.1', resolveReady)
  })
  const boundPort = listener.address().port
  await new Promise((resolveClosed) => listener.close(resolveClosed))
  return boundPort
}

async function waitForHealth() {
  const deadline = Date.now() + 30_000
  let lastError
  while (Date.now() < deadline) {
    stop.signal.throwIfAborted()
    try {
      const response = await fetch(`${env.PI_DESK_TUNNEL_CONTROL_URL}/api/v2/system/health`, {
        signal: AbortSignal.timeout(2000)
      })
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { status: 'ok' })
      return
    } catch (error) {
      lastError = error
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
    }
  }
  throw new Error(`网关健康检查超时：${lastError?.message}`)
}

async function startContainer(suppliedKey = null) {
  if (suppliedKey !== null) env.PI_DESK_TUNNEL_SERVER_KEY = suppliedKey
  await docker([
    'run',
    '--detach',
    '--name',
    container,
    '--pull=never',
    '--network=host',
    '--log-opt',
    'max-size=10m',
    '--log-opt',
    'max-file=2',
    '--env',
    'PI_DESK_TUNNEL_BIND',
    '--volume',
    `${volume}:/data`,
    ...(suppliedKey === null ? [] : ['--env', 'PI_DESK_TUNNEL_SERVER_KEY']),
    gatewayImage
  ])
  await waitForHealth()
}

async function readKey(path = '/data/server-key') {
  const { stdout } = await docker(['exec', container, 'cat', path])
  const key = stdout.trim()
  assert.match(key, /^[a-fA-F0-9]{64}$/)
  return key
}

async function checkPortsReleased() {
  await reservePort(Number(env.PI_DESK_TUNNEL_BIND.split(':').at(-1)))
}

async function stopContainer() {
  await docker(['stop', '--time', '30', container])
  const { stdout } = await docker([
    'inspect',
    '--format',
    '{{.State.Running}}:{{.State.ExitCode}}',
    container
  ])
  assert.equal(stdout.trim(), 'false:0', '容器应正常退出，而不是超时后被强杀')
  await checkPortsReleased()
}

async function verifyTransport(label) {
  const result = await execute(resolve(smokePath), [], {
    env,
    timeout: 180_000,
    signal: stop.signal,
    maxBuffer: 4 * 1024 * 1024
  })
  await writeFile(join(directory, `${label}-transport.log`), `${result.stdout}\n${result.stderr}`)
  console.info(`${label}：${result.stdout.trim()}`)
}

try {
  const { stdout: inspection } = await docker(['image', 'inspect', gatewayImage])
  const [image] = JSON.parse(inspection)
  assert.equal(image.Os, 'linux', '验收目标必须是 Linux 容器镜像')
  assert.equal(image.Architecture, architecture, '验收镜像与当前架构不一致')
  const controlPort = await reservePort()
  env.PI_DESK_TUNNEL_BIND = `127.0.0.1:${controlPort}`
  env.PI_DESK_TUNNEL_CONTROL_URL = `http://${env.PI_DESK_TUNNEL_BIND}`
  await docker(['volume', 'create', volume])
  await startContainer()
  const { stdout: pidOne } = await docker(['exec', container, 'readlink', '/proc/1/exe'])
  assert.equal(pidOne.trim(), '/usr/local/bin/pi-desk-tunnel-server')
  const generated = await readKey()
  const relayToken = await readKey('/data/relay-token')
  assert.notEqual(generated, relayToken)
  const { stdout: permissions } = await docker([
    'exec',
    container,
    'stat',
    '-c',
    '%a:%u',
    '/data/server-key'
  ])
  assert.equal(permissions.trim(), '600:10001')
  env.PI_DESK_TUNNEL_SERVER_KEY = generated
  await verifyTransport('自动生成密钥')

  await stopContainer()
  await docker(['start', container])
  await waitForHealth()
  assert.equal(await readKey(), generated)
  assert.equal(await readKey('/data/relay-token'), relayToken)
  console.info('容器重启：控制密钥与 relay token 保持不变。')

  await stopContainer()
  await docker(['rm', container])
  await startContainer()
  assert.equal(await readKey(), generated)
  console.info('容器重建：命名卷中的控制密钥继续生效。')

  await stopContainer()
  await docker(['rm', container])
  env.PI_DESK_TUNNEL_SERVER_KEY = randomBytes(32).toString('hex')
  await startContainer(env.PI_DESK_TUNNEL_SERVER_KEY)
  assert.equal(await readKey(), env.PI_DESK_TUNNEL_SERVER_KEY)
  assert.equal(await readKey('/data/relay-token'), relayToken)
  await verifyTransport('显式传入密钥')
  const { stdout: logs, stderr: errorLogs } = await docker(['logs', container])
  for (const key of [generated, env.PI_DESK_TUNNEL_SERVER_KEY, relayToken]) {
    assert.ok(!`${logs}\n${errorLogs}`.includes(key), '容器日志不得打印密钥')
  }

  await stopContainer()
  succeeded = true
} catch (error) {
  failure = error
  await writeFile(
    join(directory, 'failure.log'),
    `${error.stack ?? error}\n${error.stdout ?? ''}\n${error.stderr ?? ''}`
  )
} finally {
  try {
    const { stdout, stderr } = await docker(['logs', '--tail', '1000', container])
    await writeFile(join(directory, 'container.log'), `${stdout}\n${stderr}`)
  } catch {
    // 容器可能尚未创建，清理命令仍会核对实际结果。
  }
  for (const args of [
    ['rm', '--force', container],
    ['volume', 'rm', volume]
  ]) {
    try {
      await docker(args)
    } catch (error) {
      if (!/No such (?:container|volume)/.test(`${error.stderr ?? ''}`)) {
        failure ??= error
        succeeded = false
      }
    }
  }
  if (succeeded) {
    await rm(directory, { recursive: true, force: true })
  } else {
    console.error(`隧道镜像验收失败现场：${directory}`)
  }
}
process.removeListener('SIGINT', interrupt)
process.removeListener('SIGTERM', interrupt)
if (failure) throw failure
