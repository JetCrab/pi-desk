import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { readRemoteDebugConfig } from '../src/config.js'
import { RemoteDebugSettingsStore } from '../src/l4-remote-debug-settings.js'
import type { RemoteDebugProfileDraft } from '../src/l4-remote-debug-contract.js'

const root = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
  'temp/run/remote-debug-settings',
  `allocation-${process.pid}`
)
let sequence = 0

test.after(async () => {
  await rm(root, { recursive: true, force: true })
})

async function fixture(): Promise<{
  store: RemoteDebugSettingsStore
  agentDir: string
  desktopConfigPath: string
  cwd: string
  directory: string
}> {
  const directory = join(root, `case-${++sequence}`)
  const agentDir = join(directory, 'agent')
  const cwd = join(directory, '项目一')
  const desktopConfigPath = join(directory, 'desktop.json')
  await mkdir(cwd, { recursive: true })
  await writeFile(
    desktopConfigPath,
    JSON.stringify({ tunnel: { controlServerUrl: 'http://tunnel.example:7001' } })
  )
  const store = new RemoteDebugSettingsStore({
    agentDir,
    readTunnelServer: () => readFixtureServer(desktopConfigPath),
    isPortAvailable: async () => true
  })
  return { store, agentDir, desktopConfigPath, cwd, directory }
}

async function readFixtureServer(path: string): Promise<string> {
  const config = JSON.parse(await readFile(path, 'utf8')) as {
    tunnel: { controlServerUrl: string }
  }
  return config.tunnel.controlServerUrl
}

function draft(overrides: Partial<RemoteDebugProfileDraft> = {}): RemoteDebugProfileDraft {
  return {
    name: 'web',
    description: '网站与接口',
    command: 'pnpm dev',
    entryPort: null,
    publicPort: null,
    routes: [],
    ...overrides
  }
}

async function existingConfig(cwd: string, entryPort: number, publicPort: number): Promise<void> {
  await mkdir(join(cwd, '.pi'), { recursive: true })
  await writeFile(
    join(cwd, '.pi', 'remote_debug.yaml'),
    `version: 1\nprofiles:\n  web:\n    command: pnpm dev\n    entryPort: ${entryPort}\n    publicPort: ${publicPort}\n    routes:\n      /api: ${entryPort - 1}\n      /ws: ${entryPort - 1}\n`
  )
}

test('已有项目在空全局表补登记，去重路由端口且不修改项目文件', async () => {
  const { store, cwd } = await fixture()
  await existingConfig(cwd, 6240, 11004)
  const path = join(cwd, '.pi', 'remote_debug.yaml')
  const before = await readFile(path, 'utf8')
  await store.syncProject(cwd)
  await store.syncProject(cwd)
  const settings = await store.get()
  assert.equal(await readFile(path, 'utf8'), before)
  assert.equal(settings.registrations.length, 1)
  const registration = settings.registrations[0]!
  assert.equal(registration.entryPort, 6240)
  assert.deepEqual(registration.routePorts, [6239])
  assert.equal(registration.publicPort, 11004)
  assert.equal(registration.tunnelServer, 'http://tunnel.example:7001')
  assert.equal(resolve(registration.cwd), resolve(cwd))
  assert.deepEqual(settings.localRange, { start: 43000, end: 43999 })
  assert.equal((await readRemoteDebugConfig(cwd))?.profiles.web?.description, '')
})

test('新建配置按范围递增，显式端口先预留，同批自动分配不重复', async () => {
  const { store, cwd } = await fixture()
  await store.saveRanges({
    localRange: { start: 44000, end: 44005 },
    publicRange: { start: 12000, end: 12005 }
  })
  const config = await store.saveProject({
    cwd,
    profiles: [
      draft({ name: 'auto', routes: [{ path: '/api', targetPort: null }] }),
      draft({ name: 'fixed', entryPort: 44000, publicPort: 12000 })
    ]
  })
  assert.equal(config.profiles.auto?.entryPort, 44001)
  assert.equal(config.profiles.auto?.publicPort, 12001)
  assert.equal(config.profiles.auto?.routes[0]?.targetPort, 44002)
  assert.equal(config.profiles.auto?.command, 'pnpm dev')
  const persisted = await readRemoteDebugConfig(cwd)
  assert.equal(persisted?.profiles.auto?.description, '网站与接口')
  assert.equal(persisted?.profiles.fixed?.entryPort, 44000)
  const storeSnapshot = await store.get()
  assert.equal(storeSnapshot.registrations.length, 2)
  assert.deepEqual(
    storeSnapshot.registrations.find((item) => item.profile === 'auto')?.routePorts,
    [44002]
  )
})

test('端口登记是软规则，手动重复和范围外配置均允许', async () => {
  const { store, cwd, directory } = await fixture()
  const second = join(directory, '项目二')
  await mkdir(second)
  const profiles = [draft({ entryPort: 6233, publicPort: 11003 })]
  await store.saveProject({ cwd, profiles })
  await store.saveProject({ cwd: second, profiles })
  const settings = await store.get()
  assert.equal(settings.registrations.length, 2)
  assert.ok(
    settings.registrations.every((item) => item.entryPort === 6233 && item.publicPort === 11003)
  )
  assert.equal(new Set(settings.registrations.map((item) => item.cwd)).size, 2)
  assert.equal((await store.projectCwds()).length, 2)
})

test('更换设备只迁项目即可重建登记，不依赖旧全局路径', async () => {
  const { cwd, directory, desktopConfigPath } = await fixture()
  await existingConfig(cwd, 43726, 11006)
  const moved = join(directory, '新目录', '项目')
  await mkdir(join(moved, '.pi'), { recursive: true })
  await writeFile(
    join(moved, '.pi', 'remote_debug.yaml'),
    await readFile(join(cwd, '.pi', 'remote_debug.yaml'))
  )
  const fresh = new RemoteDebugSettingsStore({
    agentDir: join(directory, 'new-device-agent'),
    readTunnelServer: () => readFixtureServer(desktopConfigPath),
    isPortAvailable: async () => true
  })
  await fresh.syncProject(moved)
  const settings = await fresh.get()
  assert.equal(settings.registrations.length, 1)
  assert.equal(resolve(settings.registrations[0]!.cwd), resolve(moved))
  assert.equal(settings.registrations[0]!.publicPort, 11006)
})

test('公网按隧道服务分组，本机端口仍跨服务统一避让', async () => {
  const { store, cwd, desktopConfigPath, directory } = await fixture()
  await store.saveProject({ cwd, profiles: [draft({ entryPort: 43000, publicPort: 11001 })] })
  await writeFile(
    desktopConfigPath,
    JSON.stringify({ tunnel: { controlServerUrl: 'http://second.example:7001' } })
  )
  const second = join(directory, '项目二')
  await mkdir(second)
  const config = await store.saveProject({ cwd: second, profiles: [draft()] })
  assert.equal(config.profiles.web?.entryPort, 43001)
  assert.equal(config.profiles.web?.publicPort, 11001)
})

test('范围末尾复用未登记空位，耗尽不越界且不损坏项目', async () => {
  const { store, cwd, directory } = await fixture()
  await store.saveRanges({
    localRange: { start: 44000, end: 44001 },
    publicRange: { start: 12000, end: 12001 }
  })
  await store.saveProject({ cwd, profiles: [draft({ entryPort: 44001, publicPort: 12001 })] })
  const second = join(directory, '项目二')
  await mkdir(second)
  const config = await store.saveProject({ cwd: second, profiles: [draft()] })
  assert.equal(config.profiles.web?.entryPort, 44000)
  assert.equal(config.profiles.web?.publicPort, 12000)
  const original = await readFile(join(second, '.pi', 'remote_debug.yaml'), 'utf8')
  await assert.rejects(
    store.saveProject({ cwd: second, profiles: [draft(), draft({ name: 'another' })] }),
    /端口|范围/
  )
  assert.equal(await readFile(join(second, '.pi', 'remote_debug.yaml'), 'utf8'), original)
})

test('移除登记保留项目文件，再次发现恢复该条登记', async () => {
  const { store, cwd } = await fixture()
  await store.saveProject({ cwd, profiles: [draft({ entryPort: 43000, publicPort: 11001 })] })
  const registration = (await store.get()).registrations[0]!
  const afterDelete = await store.removeRegistration({
    cwd: registration.cwd,
    profile: registration.profile,
    tunnelServer: registration.tunnelServer
  })
  assert.equal(afterDelete.registrations.length, 0)
  assert.ok(await readRemoteDebugConfig(cwd))
  await store.syncProject(cwd)
  assert.equal((await store.get()).registrations.length, 1)
})

test('非法范围与路由不修改现有文件，损坏登记不被当作空表覆盖', async () => {
  const { store, cwd, agentDir } = await fixture()
  await existingConfig(cwd, 43000, 11001)
  const original = await readFile(join(cwd, '.pi', 'remote_debug.yaml'), 'utf8')
  await assert.rejects(
    store.saveRanges({
      localRange: { start: 44000, end: 43000 },
      publicRange: { start: 11001, end: 11099 }
    })
  )
  await assert.rejects(
    store.saveProject({ cwd, profiles: [draft({ routes: [{ path: '/', targetPort: 44000 }] })] })
  )
  assert.equal(await readFile(join(cwd, '.pi', 'remote_debug.yaml'), 'utf8'), original)
  await mkdir(agentDir, { recursive: true })
  const registry = join(agentDir, 'pi-desk-remote-debug-ports.json')
  await writeFile(registry, '{broken')
  await assert.rejects(store.get())
  await assert.rejects(store.syncProject(cwd))
  assert.equal(await readFile(registry, 'utf8'), '{broken')
})

test('真实本机监听被自动分配跳过且不影响已有服务', async () => {
  const { cwd, agentDir, desktopConfigPath } = await fixture()
  const server = createServer()
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const port = address.port
    const store = new RemoteDebugSettingsStore({
      agentDir,
      readTunnelServer: () => readFixtureServer(desktopConfigPath)
    })
    await store.saveRanges({
      localRange: { start: port, end: port },
      publicRange: { start: 12000, end: 12001 }
    })
    await assert.rejects(store.saveProject({ cwd, profiles: [draft()] }), /端口|范围/)
    assert.ok(server.listening)
    assert.equal(await readRemoteDebugConfig(cwd), null)
  } finally {
    await new Promise<void>((resolveClose, reject) =>
      server.close((error) => (error ? reject(error) : resolveClose()))
    )
  }
})
