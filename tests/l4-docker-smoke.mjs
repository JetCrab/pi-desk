import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { assertPortReleased } from './l4-e2e-server-runtime.mjs'

const [image, version] = process.argv.slice(2)
assert.ok(image && /^\d+\.\d+\.\d+$/.test(version), '用法：l4-docker-smoke.mjs <image> <version>')
assert.equal(process.platform, 'linux', 'Docker验收在Linux执行')
const root = resolve(import.meta.dirname, '..')
const task = `image-${randomUUID()}`
const directory = join(root, 'temp/run/docker-smoke', task)
const home = join(root, 'temp/pi/docker-smoke', task, 'home')
const workspace = join(directory, 'workspace')
const validation = join(directory, 'validation')
const container = `pi-desk-${task}`
let exists = false
let port
let success = false
let failure
const docker = (args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()

async function removeContainer() {
  if (!exists) return
  docker(['rm', '--force', container])
  exists = false
  if (port) await assertPortReleased(port)
}

try {
  for (const path of [home, workspace, join(validation, 'tests')])
    await mkdir(path, { recursive: true })
  for (const name of ['l4-e2e-server-runtime.mjs', 'l4-docker-runtime-smoke.mjs']) {
    await cp(join(root, 'tests', name), join(validation, 'tests', name))
  }
  await symlink('/opt/pi-desk/node_modules/@jetcrab/pi-desk/src', join(validation, 'src'))
  const mounts = [
    '--mount',
    `type=bind,src=${home},dst=/data/home`,
    '--mount',
    `type=bind,src=${workspace},dst=/workspace`,
    '--mount',
    `type=bind,src=${validation},dst=/validation,readonly`
  ]
  // Runner 用户不固定为 UID 1000，只调整本次独立挂载目录。
  docker([
    'run',
    '--rm',
    '--user',
    '0:0',
    ...mounts,
    image,
    'chown',
    '-R',
    '1000:1000',
    '/data/home',
    '/workspace'
  ])
  const options = [
    '--name',
    container,
    '--pull=never',
    '--log-opt',
    'max-size=10m',
    '--log-opt',
    'max-file=2',
    '--tmpfs',
    '/tmp:rw,nosuid,size=512m',
    ...mounts
  ]
  console.info('[Docker验收] 启动容器内核心与插件验证')
  docker([
    'create',
    ...options,
    image,
    'node',
    '/validation/tests/l4-docker-runtime-smoke.mjs',
    version
  ])
  exists = true
  const logs = docker(['start', '--attach', container])
  await writeFile(join(directory, 'runtime.log'), logs)
  console.info(logs)
  const state = JSON.parse(docker(['inspect', '--format', '{{json .State}}', container]))
  assert.equal(state.ExitCode, 0, logs)
  assert.equal(state.OOMKilled, false)
  await removeContainer()

  console.info('[Docker验收] 默认入口重建容器并恢复原数据')
  docker(['create', ...options, '--publish', '127.0.0.1::6233', image])
  exists = true
  docker(['start', container])
  const address = docker(['port', container, '6233/tcp'])
  port = Number(address.split(':').at(-1))
  const deadline = Date.now() + 90000
  while (true) {
    const state = JSON.parse(docker(['inspect', '--format', '{{json .State}}', container]))
    assert.equal(state.Running, true, docker(['logs', container]))
    if (state.Health?.Status === 'healthy') break
    assert.ok(Date.now() < deadline, 'Docker HEALTHCHECK未通过')
    await delay(500)
  }
  const response = await fetch(`http://${address}`, { signal: AbortSignal.timeout(15000) })
  assert.equal(response.status, 200)
  assert.match(await response.text(), /<html/)
  console.info(
    docker([
      'exec',
      container,
      'node',
      '/validation/tests/l4-docker-runtime-smoke.mjs',
      '--persisted'
    ])
  )
  docker(['stop', '--timeout', '30', container])
  const stopped = JSON.parse(docker(['inspect', '--format', '{{json .State}}', container]))
  assert.equal(stopped.ExitCode, 0)
  assert.equal(stopped.OOMKilled, false)
  await writeFile(join(directory, 'default-entry.log'), docker(['logs', container]))
  await removeContainer()
  success = true
  console.info('Docker 镜像运行、持久化、正常停止与端口释放全部通过。')
} catch (error) {
  failure = error
  await writeFile(join(directory, 'failure.log'), `${error.stack}\n${error.stderr ?? ''}`)
  if (exists) await writeFile(join(directory, 'container.log'), docker(['logs', container]))
  throw error
} finally {
  try {
    await removeContainer()
    // GitHub Runner 与镜像 UID 不一定相同，清理前恢复本次目录的所有者。
    docker([
      'run',
      '--rm',
      '--user',
      '0:0',
      '--mount',
      `type=bind,src=${home},dst=/data/home`,
      '--mount',
      `type=bind,src=${workspace},dst=/workspace`,
      image,
      'chown',
      '-R',
      `${process.getuid()}:${process.getgid()}`,
      '/data/home',
      '/workspace'
    ])
    if (success) {
      await rm(join(root, 'temp/pi/docker-smoke', task), { recursive: true, force: true })
      await rm(directory, { recursive: true, force: true })
    } else {
      console.error(`Docker验收失败现场：${directory}；隔离用户数据：${home}`)
    }
  } catch (error) {
    console.error('Docker验收资源清理失败', error.message)
    if (!failure) throw error
  }
}
