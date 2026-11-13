import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { type TestContext } from 'node:test'
import { bindConfigStore, getUnifiedConfigPath } from '../src/config-store.ts'

async function fixture(t: TestContext) {
  const runs = fileURLToPath(new URL('../../../temp/run/project-config/', import.meta.url))
  await mkdir(runs, { recursive: true })
  const root = await mkdtemp(join(runs, 'layered-values-'))
  const cwd = join(root, 'project')
  const agentDir = join(root, 'agent')
  await mkdir(cwd)
  const key = randomBytes(32)
  const options = { agentDir, keyProvider: async () => key }
  t.after(() => rm(root, { recursive: true, force: true }))
  return {
    root,
    cwd,
    agentDir,
    options,
    config: bindConfigStore('plugins', 'example', options),
    projectPath: join(cwd, '.pi/pi-desk.yaml')
  }
}

test('项目逐字段覆盖全局及默认，多层对象递归，数组整体替换', async (t) => {
  const { config, cwd } = await fixture(t)
  const defaults = {
    A: 4,
    B: 4,
    C: 4,
    server: { host: 'default', port: 22, flags: { active: true } },
    items: [1, 2]
  }
  await config.set({ B: 3, C: 5, server: { host: 'global' }, items: [3, 4] })
  const project = { A: 1, B: 2, server: { port: 2222, flags: { active: false } }, items: [5] }
  await config.set(project, { cwd })
  assert.deepEqual(await config.get({ cwd, defaults }), {
    A: 1,
    B: 2,
    C: 5,
    server: { host: 'global', port: 2222, flags: { active: false } },
    items: [5]
  })
  assert.deepEqual(defaults.server, { host: 'default', port: 22, flags: { active: true } })
  assert.deepEqual(project.server, { port: 2222, flags: { active: false } })
  assert.deepEqual(await config.get(), { B: 3, C: 5, server: { host: 'global' }, items: [3, 4] })
})

test('空值是显式覆盖，空对象继承字段，不按真假值选择', async (t) => {
  const { config, cwd } = await fixture(t)
  await config.set({
    nil: { x: 1 },
    flag: true,
    number: 10,
    text: 'value',
    items: [1],
    object: { retained: true }
  })
  await config.set({ nil: null, flag: false, number: 0, text: '', items: [], object: {} }, { cwd })
  assert.deepEqual(await config.get({ cwd }), {
    nil: null,
    flag: false,
    number: 0,
    text: '',
    items: [],
    object: { retained: true }
  })
})

test('项目写入只保存输入分组，保留其他插件，不固化全局或默认值', async (t) => {
  const { config, options, cwd, agentDir, projectPath } = await fixture(t)
  await config.set({ inherited: true })
  const before = await readFile(getUnifiedConfigPath(agentDir))
  const other = bindConfigStore('plugins', 'other', options)
  await other.set({ retained: 1 }, { cwd })
  await config.set({ explicit: 2 }, { cwd })
  assert.deepEqual(await config.get({ cwd, defaults: { fallback: 3 } }), {
    fallback: 3,
    inherited: true,
    explicit: 2
  })
  const text = await readFile(projectPath, 'utf8')
  assert.doesNotMatch(text, /inherited|fallback/u)
  assert.deepEqual(await other.get({ cwd }), { retained: 1 })
  assert.deepEqual(await readFile(getUnifiedConfigPath(agentDir)), before)
  await config.set({}, { cwd })
  assert.deepEqual(await config.get({ cwd }), { inherited: true })
})

test('各层按路径解密后合并完整加密对象，同一 Agent 密钥处理项目值', async (t) => {
  const { config, cwd, projectPath } = await fixture(t)
  await config.set(
    { server: { host: 'global-host', port: 22, password: 'global-secret' } },
    { encryptPaths: ['/server'] }
  )
  await config.set({ server: { port: 2222 } }, { cwd, encryptPaths: ['/server'] })
  assert.deepEqual(await config.get({ cwd, decryptPaths: ['/server'] }), {
    server: { host: 'global-host', port: 2222, password: 'global-secret' }
  })
  const opaque = await config.get({ cwd })
  assert.equal(typeof opaque.server, 'string')
  assert.deepEqual(await config.decrypt(String(opaque.server)), { port: 2222 })
  assert.doesNotMatch(await readFile(projectPath, 'utf8'), /2222|global-secret/u)
})

test('缺少配置只使用已有层，旧格式不回退且未读取的旧文件保持不变', async (t) => {
  const { config, cwd, projectPath } = await fixture(t)
  await mkdir(join(cwd, '.pi/config'), { recursive: true })
  const legacy = join(cwd, '.pi/config/example.json')
  await writeFile(legacy, '{"legacy":true}')
  assert.deepEqual(await config.get({ cwd, defaults: { fallback: true } }), { fallback: true })
  await assert.rejects(readFile(projectPath), { code: 'ENOENT' })
  assert.equal(await readFile(legacy, 'utf8'), '{"legacy":true}')
})

test('损坏项目配置报错不回退，读取和失败写入不覆盖原文件', async (t) => {
  const { config, cwd, projectPath } = await fixture(t)
  await config.set({ valid: true })
  await mkdir(join(cwd, '.pi'))
  const invalid = 'plugins: [broken\n'
  await writeFile(projectPath, invalid)
  await assert.rejects(config.get({ cwd, defaults: { valid: true } }), /YAML/u)
  await assert.rejects(config.set({ changed: true }, { cwd }), /YAML/u)
  assert.equal(await readFile(projectPath, 'utf8'), invalid)
})

test('原始层读取不混入全局或默认，并可无损修改项目自身配置', async (t) => {
  const { config, cwd } = await fixture(t)
  await config.set({ inherited: 1, nested: { shared: true } })
  await config.set({ nested: { own: 2 }, untouched: 'keep' }, { cwd })
  const own = await config.get({ cwd, inherit: false, defaults: { fallback: true } })
  assert.deepEqual(own, { nested: { own: 2 }, untouched: 'keep' })
  await config.set({ ...own, edited: 3 }, { cwd })
  assert.deepEqual(await config.get({ cwd, inherit: false }), {
    nested: { own: 2 },
    untouched: 'keep',
    edited: 3
  })
  assert.deepEqual(await config.get({ inherit: false, defaults: { fallback: true } }), {
    inherited: 1,
    nested: { shared: true }
  })
})

test('缺少项目原始层为空，不因全局损坏回退或阻止读取有效项目', async (t) => {
  const { config, cwd, agentDir } = await fixture(t)
  await config.set({ inherited: true })
  assert.deepEqual(await config.get({ cwd, inherit: false }), {})
  await config.set({ local: true }, { cwd })
  await writeFile(getUnifiedConfigPath(agentDir), 'plugins: [broken\n')
  assert.deepEqual(await config.get({ cwd, inherit: false }), { local: true })
  await assert.rejects(config.get({ cwd }), /YAML/u)
})

test('原始层可按路径解密，且不解开未被读取的全局密文', async (t) => {
  const { config, cwd } = await fixture(t)
  await config.set({ token: 'enc:v1:invalid' })
  await config.set({ token: await config.encrypt('project-token') }, { cwd })
  assert.deepEqual(await config.get({ cwd, inherit: false, decryptPaths: ['/token'] }), {
    token: 'project-token'
  })
  await assert.rejects(config.get({ cwd, decryptPaths: ['/token'] }), /认证失败/u)
})

test('不同项目调用隔离，无项目参数不会借用进程工作目录', async (t) => {
  const { config, cwd, root } = await fixture(t)
  const second = join(root, 'second')
  await mkdir(second)
  await config.set({ value: 'global' })
  await Promise.all([
    config.set({ value: 'first' }, { cwd }),
    config.set({ value: 'second' }, { cwd: second })
  ])
  assert.deepEqual(await config.get({ cwd }), { value: 'first' })
  assert.deepEqual(await config.get({ cwd: second }), { value: 'second' })
  assert.deepEqual(await config.get(), { value: 'global' })
})
