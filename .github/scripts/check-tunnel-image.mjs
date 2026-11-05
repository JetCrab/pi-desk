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
assert.equal(process.platform, 'linux', '镜像验收使用 Linux host network，不修改宿主网络配置')
const parent = resolve('temp/run/tunnel-image')
await mkdir(parent, { recursive: true })
const directory = await mkdtemp(join(parent, 'tcp-smoke-'))
const suffix = `${process.pid}-${randomBytes(4).toString('hex')}`
const containerPrefix = process.env.CONTAINER_NAME ?? `tunnel-smoke-${suffix}`
const containers = [`${containerPrefix}-relay`, `${containerPrefix}-gateway`]
const stop = new AbortController()
const interrupt = () => stop.abort(new Error('隧道镜像验收被中断'))
process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)
const controlKey = randomBytes(32).toString('hex')
const relayToken = randomBytes(32).toString('hex')
const env = {
  ...process.env,
  PI_DESK_TUNNEL_SERVER_KEY: controlKey,
  PI_DESK_TUNNEL_IROH_RELAY_TOKEN: relayToken,
  IROH_RELAY_ACCESS_TOKEN: relayToken
}
let succeeded = false
let failure

async function docker(args) {
  return execute('docker', args, { env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
}

async function reservePort() {
  const listener = net.createServer()
  await new Promise((resolveReady, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', resolveReady)
  })
  return {
    port: listener.address().port,
    close: () => new Promise((resolveClosed) => listener.close(resolveClosed))
  }
}

async function waitForHealth(url) {
  const deadline = Date.now() + 30_000
  let lastError
  while (Date.now() < deadline) {
    stop.signal.throwIfAborted()
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
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

try {
  const control = await reservePort()
  let relay
  try {
    relay = await reservePort()
  } finally {
    await control.close()
  }
  await relay.close()
  const relayUrl = `http://127.0.0.1:${relay.port}`
  env.PI_DESK_TUNNEL_BIND = `127.0.0.1:${control.port}`
  env.PI_DESK_TUNNEL_PUBLIC_HOST = '127.0.0.1'
  env.PI_DESK_TUNNEL_IROH_RELAY_URL = relayUrl
  env.PI_DESK_TUNNEL_CONTROL_URL = `http://${env.PI_DESK_TUNNEL_BIND}`
  const relayConfig = join(directory, 'relay.toml')
  await writeFile(
    relayConfig,
    `http_bind_addr = "127.0.0.1:${relay.port}"\nenable_quic_addr_discovery = false\n`
  )
  await docker([
    'run',
    '--detach',
    '--name',
    containers[0],
    '--pull=never',
    '--network=host',
    '--log-opt',
    'max-size=10m',
    '--log-opt',
    'max-file=2',
    '--env',
    'IROH_RELAY_ACCESS_TOKEN',
    '--volume',
    `${relayConfig}:/etc/iroh-relay.toml:ro`,
    '--entrypoint',
    'iroh-relay',
    gatewayImage,
    '--dev',
    '--config-path',
    '/etc/iroh-relay.toml'
  ])
  await docker([
    'run',
    '--detach',
    '--name',
    containers[1],
    '--pull=never',
    '--network=host',
    '--log-opt',
    'max-size=10m',
    '--log-opt',
    'max-file=2',
    '--env',
    'PI_DESK_TUNNEL_BIND',
    '--env',
    'PI_DESK_TUNNEL_PUBLIC_HOST',
    '--env',
    'PI_DESK_TUNNEL_SERVER_KEY',
    '--env',
    'PI_DESK_TUNNEL_IROH_RELAY_URL',
    '--env',
    'PI_DESK_TUNNEL_IROH_RELAY_TOKEN',
    gatewayImage
  ])
  await waitForHealth(`${env.PI_DESK_TUNNEL_CONTROL_URL}/api/v2/system/health`)
  const result = await execute(resolve(smokePath), [], {
    env,
    timeout: 180_000,
    signal: stop.signal,
    maxBuffer: 4 * 1024 * 1024
  })
  await writeFile(join(directory, 'transport.log'), `${result.stdout}\n${result.stderr}`)
  console.info(result.stdout.trim())
  succeeded = true
} catch (error) {
  failure = error
  await writeFile(
    join(directory, 'failure.log'),
    `${error.stack ?? error}\n${error.stdout ?? ''}\n${error.stderr ?? ''}`
  )
} finally {
  for (const name of containers.reverse()) {
    try {
      const { stdout, stderr } = await docker(['logs', '--tail', '1000', name])
      await writeFile(join(directory, `${name}.log`), `${stdout}\n${stderr}`)
    } catch {
      // 容器可能尚未创建，清理命令仍会核对实际结果。
    }
    try {
      await docker(['rm', '--force', name])
    } catch (error) {
      if (!`${error.stderr ?? ''}`.includes('No such container')) {
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
