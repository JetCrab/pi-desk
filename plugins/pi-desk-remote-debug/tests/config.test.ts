import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parse } from 'yaml'
import { bindConfigStore } from '@jetcrab/pi-desk-sdk/config'
import {
  readRemoteDebugConfig,
  remoteDebugConfigPath,
  writeRemoteDebugConfig
} from '../src/config.js'

const root = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
  'temp/run/remote-debug-config',
  `project-config-${process.pid}`
)
const store = bindConfigStore('plugins', 'remote-debug', { agentDir: join(root, 'agent') })

test.after(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writeConfig(cwd: string, content: string): Promise<void> {
  await mkdir(cwd, { recursive: true })
  await store.set(parse(content), { cwd })
}

const service = { command: 'pnpm dev', entryPort: 30333, publicPort: 43333 }

test('读取共享项目分组并按最长路径优先排序，范围字段可与服务共存', async () => {
  const cwd = join(root, 'valid')
  await writeConfig(
    cwd,
    `version: 1
localRange: { start: 43000, end: 43999 }
profiles:
  Web开发:
    command: pnpm dev
    entryPort: 30333
    publicPort: 43333
    routes:
      /api: 8080
      /api/socket: 8081
`
  )
  const config = await readRemoteDebugConfig(cwd, store)
  assert.equal(config?.profiles.Web开发?.command, 'pnpm dev')
  assert.deepEqual(config?.profiles.Web开发?.routes, [
    { path: '/api/socket', targetPort: 8081 },
    { path: '/api', targetPort: 8080 }
  ])
})

test('共享文件其他分组、旧文件和全局服务均不使未配置项目被识别', async () => {
  const cwd = join(root, 'unconfigured')
  await mkdir(join(cwd, '.pi'), { recursive: true })
  await store.set({ version: 1, profiles: { global: service } })
  await bindConfigStore('plugins', 'other-plugin', { agentDir: join(root, 'agent') }).set(
    { enabled: true },
    { cwd }
  )
  const legacy = join(cwd, '.pi', 'remote_debug.yaml')
  await writeFile(legacy, '{invalid legacy}')
  assert.equal(await readRemoteDebugConfig(cwd, store), null)
  assert.equal(await readFile(legacy, 'utf8'), '{invalid legacy}')
  await store.set({})
})

test('真实项目原始分组存在后才继承全局字段，且不向父目录查找', async () => {
  const cwd = join(root, 'inherited')
  const nested = join(cwd, 'nested')
  await mkdir(nested, { recursive: true })
  await store.set({ version: 1, profiles: { web: { ...service, description: '全局说明' } } })
  await store.set({ profiles: { web: { command: 'pnpm dev:project' } } }, { cwd })
  const before = await readFile(remoteDebugConfigPath(cwd), 'utf8')
  const config = await readRemoteDebugConfig(cwd, store)
  assert.equal(config?.profiles.web?.command, 'pnpm dev:project')
  assert.equal(config?.profiles.web?.entryPort, 30333)
  assert.equal(config?.profiles.web?.description, '全局说明')
  assert.equal(await readRemoteDebugConfig(nested, store), null)
  assert.equal(await readFile(remoteDebugConfigPath(cwd), 'utf8'), before)
  await store.set({})
})

test('未知服务字段和根路由被拒绝', async () => {
  const cwd = join(root, 'invalid')
  await mkdir(cwd, { recursive: true })
  await store.set({ version: 1, profiles: { web: { ...service, autoOpen: true } } }, { cwd })
  await assert.rejects(readRemoteDebugConfig(cwd, store), /Unrecognized key|未知|autoOpen/)
  await store.set({ version: 1, profiles: { web: { ...service, routes: { '/': 8080 } } } }, { cwd })
  await assert.rejects(readRemoteDebugConfig(cwd, store), /路由路径无效/)
})

test('项目保存保留同组范围和其他插件，不复制继承服务及默认范围', async () => {
  const cwd = join(root, 'save')
  await mkdir(cwd, { recursive: true })
  const range = { start: 43500 }
  await store.set({
    version: 1,
    profiles: { inherited: service },
    publicRange: { start: 11001, end: 11099 }
  })
  await store.set({ localRange: range }, { cwd })
  const other = bindConfigStore('plugins', 'other-plugin', { agentDir: join(root, 'agent') })
  await other.set({ keep: 'unchanged' }, { cwd })
  await writeRemoteDebugConfig(
    cwd,
    {
      version: 1,
      profiles: { local: { ...service, description: '项目', routes: [] } }
    },
    store
  )
  const own = await store.get({ cwd, inherit: false })
  assert.deepEqual(own, {
    localRange: range,
    version: 1,
    profiles: { local: { ...service, description: '项目', routes: {} } }
  })
  assert.deepEqual(await other.get({ cwd, inherit: false }), { keep: 'unchanged' })
  const before = await readFile(remoteDebugConfigPath(cwd), 'utf8')
  await assert.rejects(writeRemoteDebugConfig(cwd, { version: 1, profiles: {} }, store), /至少需要/)
  assert.equal(await readFile(remoteDebugConfigPath(cwd), 'utf8'), before)
  await store.set({})
})
