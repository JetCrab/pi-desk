import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execute = promisify(execFile)
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PluginJsonObject } from '../src/shared.ts'
import { fileURLToPath } from 'node:url'
import test, { type TestContext } from 'node:test'
import { parse } from 'yaml'
import { bindConfigStore, getUnifiedConfigPath } from '../src/config-store.ts'

async function fixture(t: TestContext) {
  const root = fileURLToPath(new URL('../../../temp/run/unified-config/', import.meta.url))
  await mkdir(root, { recursive: true })
  const agentDir = await mkdtemp(join(root, 'inline-encryption-'))
  const key = randomBytes(32)
  const options = { agentDir, keyProvider: async () => key }
  t.after(() => rm(agentDir, { recursive: true, force: true }))
  return {
    agentDir,
    key,
    options,
    path: getUnifiedConfigPath(agentDir),
    config: bindConfigStore('plugins', 'example-plugin', options)
  }
}

test('分组原子保存保留宿主、其他插件、注释及旧配置', async (t) => {
  const { agentDir, config, options, path } = await fixture(t)
  await mkdir(join(agentDir, 'config'), { recursive: true })
  const legacy = join(agentDir, 'config', 'example-plugin.json')
  await writeFile(legacy, '{"legacy":"unchanged"}')
  await writeFile(path, '# 用户注释\npi-desk:\n  region:\n    locale: zh-CN\nplugins: {}\n')
  assert.deepEqual(await config.get(), {})
  const other = bindConfigStore('plugins', 'second-plugin', options)
  await Promise.all([config.set({ value: 1 }), other.set({ value: 2 })])
  assert.deepEqual(await config.get(), { value: 1 })
  assert.deepEqual(await other.get(), { value: 2 })
  await config.set({ replaced: true })
  const text = await readFile(path, 'utf8')
  assert.match(text, /# 用户注释/u)
  assert.equal(parse(text)['pi-desk'].region.locale, 'zh-CN')
  assert.deepEqual(await config.get(), { replaced: true })
  assert.equal(await readFile(legacy, 'utf8'), '{"legacy":"unchanged"}')
})

test('多层通配处理用户名、IP、密码、数组及转义字段', async (t) => {
  const { config, path } = await fixture(t)
  const input: PluginJsonObject = {
    groups: [
      {
        services: [
          { host: '192.0.2.1', username: 'fixture-user', password: 'fixture-password' },
          { host: '192.0.2.2' }
        ]
      }
    ],
    tokens: ['first-token', 'second-token'],
    'a/b': { '~key': false },
    plain: 10
  }
  const before = structuredClone(input)
  const paths = [
    '/groups/*/services/*/host',
    '/groups/*/services/*/username',
    '/groups/*/services/*/password',
    '/tokens/*',
    '/a~1b/~0key'
  ]
  await config.set(input, { encryptPaths: paths })
  assert.deepEqual(input, before)
  const bytes = await readFile(path)
  for (const plaintext of ['192.0.2.1', 'fixture-user', 'fixture-password', 'first-token']) {
    assert.equal(bytes.includes(Buffer.from(plaintext)), false)
  }
  const stored = await config.get()
  assert.notDeepEqual(stored, input)
  assert.deepEqual(await config.get({ decryptPaths: paths }), input)
  assert.deepEqual(await readFile(path), bytes)
  assert.deepEqual(await config.get({ decryptPaths: paths }), input)
})

test('手工加解密保留 JSON 类型并与路径方式组合', async (t) => {
  const { config } = await fixture(t)
  for (const value of [null, false, 0, '', [1, 'value'], { nested: { value: true } }]) {
    const encrypted = await config.encrypt(value)
    assert.deepEqual(await config.decrypt(encrypted), value)
    await config.set({ value: encrypted, plain: 'readable' })
    assert.deepEqual(await config.get(), { value: encrypted, plain: 'readable' })
    assert.deepEqual(await config.get({ decryptPaths: ['/value', '/plain'] }), {
      value,
      plain: 'readable'
    })
  }
})

test('重复通配不重复加密，父子重叠、无效路径和认证失败不覆盖配置', async (t) => {
  const { config, path, options } = await fixture(t)
  await config.set(
    { servers: [{ token: 'fixture-token' }] },
    {
      encryptPaths: ['/servers/*/token', '/servers/0/token']
    }
  )
  assert.deepEqual(await config.get({ decryptPaths: ['/servers/*/token'] }), {
    servers: [{ token: 'fixture-token' }]
  })
  const before = await readFile(path)
  await assert.rejects(
    config.set({ servers: [{ token: 'new' }] }, { encryptPaths: ['/servers', '/servers/*/token'] }),
    /父节点/u
  )
  await assert.rejects(config.set({}, { encryptPaths: ['not-a-pointer'] }), /JSON Pointer/u)
  await assert.rejects(config.set({}, { encryptPaths: ['/invalid~2escape'] }), /JSON Pointer/u)
  const wrong = bindConfigStore('plugins', 'example-plugin', {
    ...options,
    keyProvider: async () => randomBytes(32)
  })
  await assert.rejects(wrong.get({ decryptPaths: ['/servers/*/token'] }), /认证失败/u)
  await assert.rejects(config.decrypt('enc:v1:invalid'), /认证失败/u)
  assert.deepEqual(await readFile(path), before)
})

test('真实跨进程保存不同分组不互相覆盖', async (t) => {
  const { agentDir } = await fixture(t)
  const moduleUrl = new URL('../src/config-store.ts', import.meta.url).href
  const script = `import { bindConfigStore } from ${JSON.stringify(moduleUrl)}; await bindConfigStore('plugins', process.argv[2], {agentDir: process.argv[1]}).set({value: process.argv[2]});`
  await Promise.all(
    ['first', 'second', 'third'].map((name) =>
      execute(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script, agentDir, name],
        {
          timeout: 20_000,
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: agentDir,
            PI_CODING_AGENT_SESSION_DIR: join(agentDir, 'sessions')
          }
        }
      )
    )
  )
  for (const name of ['first', 'second', 'third']) {
    assert.deepEqual(await bindConfigStore('plugins', name, { agentDir }).get(), { value: name })
  }
})

test('锁外修改与密文损坏不得造成覆盖或静默解密', async (t) => {
  const { options, config, path, key } = await fixture(t)
  await config.set({ value: 'before' })
  let ready!: () => void
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    ready = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const pendingStore = bindConfigStore('plugins', 'example-plugin', {
    ...options,
    keyProvider: async () => {
      ready()
      await gate
      return key
    }
  })
  const pending = pendingStore.set({ value: 'pending' }, { encryptPaths: ['/value'] })
  const rejected = assert.rejects(pending, /已变化/u)
  await waiting
  const changed = 'plugins:\n  example-plugin:\n    value: external\n'
  await writeFile(path, changed)
  release()
  await rejected
  assert.equal(await readFile(path, 'utf8'), changed)
  const encrypted = await config.encrypt('authenticated')
  const payload = Buffer.from(encrypted.slice('enc:v1:'.length), 'base64')
  payload[payload.length - 1]! ^= 1
  await assert.rejects(config.decrypt('enc:v1:' + payload.toString('base64')), /认证失败/u)
  await assert.rejects(config.set({ value: 'x'.repeat(8 * 1024 * 1024) }), /8 MiB/u)
  assert.equal(await readFile(path, 'utf8'), changed)
})

test('损坏 YAML 和失效 Owner 不得被保存覆盖', async (t) => {
  const { config, path, options } = await fixture(t)
  await config.set({ value: 1 })
  await writeFile(path, 'plugins: [broken\n')
  await assert.rejects(config.set({ value: 2 }), /YAML/u)
  assert.equal(await readFile(path, 'utf8'), 'plugins: [broken\n')
  const inactive = bindConfigStore('plugins', 'example-plugin', {
    ...options,
    assertActive() {
      throw new Error('Owner 已失效')
    }
  })
  await assert.rejects(inactive.set({}), /Owner/u)
  await assert.rejects(inactive.get(), /Owner/u)
})
