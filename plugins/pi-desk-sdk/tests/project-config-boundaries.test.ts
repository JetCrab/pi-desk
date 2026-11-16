import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs, { existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { type TestContext } from 'node:test'
import {
  bindConfigStore,
  getProjectConfigPath,
  getUnifiedConfigPath,
  readConfigSection
} from '../src/config.ts'

function fixture(t: TestContext) {
  const runs = fileURLToPath(
    new URL('../../../temp/run/project-config-boundaries/', import.meta.url)
  )
  mkdirSync(runs, { recursive: true })
  const root = mkdtempSync(join(runs, 'project-boundaries-'))
  const cwd = join(root, 'project')
  const agentDir = join(root, 'agent')
  mkdirSync(cwd)
  const key = randomBytes(32)
  const options = { agentDir, keyProvider: async () => key }
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, cwd, options, config: bindConfigStore('plugins', 'example', options) }
}

test('项目路径拒绝相对目录及不存在目录，不创建误选项目', async (t) => {
  const { root, config } = fixture(t)
  const missing = join(root, 'missing')
  assert.throws(() => getProjectConfigPath('relative-project'), /绝对目录/u)
  await assert.rejects(config.get({ cwd: 'relative-project' }), /绝对目录/u)
  await assert.rejects(config.set({}, { cwd: 'relative-project' }), /绝对目录/u)
  await assert.rejects(config.get({ cwd: missing }), { code: 'ENOENT' })
  await assert.rejects(config.set({}, { cwd: missing }), { code: 'ENOENT' })
  assert.equal(existsSync(missing), false)
})

test('项目符号链接目录与非普通配置目标不得读写', async (t) => {
  const { root, cwd, config } = fixture(t)
  const outside = join(root, 'outside')
  mkdirSync(outside)
  symlinkSync(outside, join(cwd, '.pi'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(config.get({ cwd }), /普通目录/u)
  await assert.rejects(config.set({}, { cwd }), /普通目录/u)
  assert.equal(existsSync(join(outside, 'pi-desk.yaml')), false)
  await rm(join(cwd, '.pi'))
  mkdirSync(getProjectConfigPath(cwd), { recursive: true })
  await assert.rejects(config.get({ cwd }), /非普通配置文件/u)
  await assert.rejects(config.set({}, { cwd }), /非普通配置文件/u)
})

test('全局密文解密失败不能因项目覆盖而静默回退', async (t) => {
  const { cwd, options, config } = fixture(t)
  await config.set({ secret: 'global' }, { encryptPaths: ['/secret'] })
  await config.set({ secret: 'project' }, { cwd })
  const wrong = bindConfigStore('plugins', 'example', {
    ...options,
    keyProvider: async () => randomBytes(32)
  })
  await assert.rejects(wrong.get({ cwd, decryptPaths: ['/secret'] }), /认证失败/u)
  assert.deepEqual(await wrong.get({ cwd }), { secret: 'project' })
})

test('默认值不解密、不持久化，结果与输入不共享嵌套对象', async (t) => {
  const { cwd, config } = fixture(t)
  const encrypted = await config.encrypt({ value: 'default-secret' })
  const defaults = { nested: { secret: encrypted }, items: [{ value: 1 }] }
  const before = structuredClone(defaults)
  const result = await config.get({ cwd, defaults, decryptPaths: ['/nested/secret'] })
  assert.deepEqual(result, before)
  assert.notEqual(result.nested, defaults.nested)
  assert.notEqual(result.items, defaults.items)
  assert.deepEqual(defaults, before)
  assert.equal(existsSync(getProjectConfigPath(cwd)), false)
})

test('项目权限错误明确失败，不覆盖已有文件或使用默认值', async (t) => {
  const { cwd, config } = fixture(t)
  await config.set({ value: 'retained' }, { cwd })
  const target = getProjectConfigPath(cwd)
  const before = await readFile(target)
  const original = fs.openSync
  const mock = t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    if (args[0] === target) throw Object.assign(new Error('测试权限拒绝'), { code: 'EACCES' })
    return original(...args)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(config.get({ cwd, defaults: { value: 'fallback' } }), /EACCES/u)
    await assert.rejects(config.set({ value: 'changed' }, { cwd }), /EACCES/u)
  } finally {
    mock.mock.restore()
    syncBuiltinESMExports()
  }
  assert.deepEqual(await readFile(target), before)
})

test('项目写入保留其他分组注释与全局同步读取边界', async (t) => {
  const { cwd, options, config } = fixture(t)
  mkdirSync(join(cwd, '.pi'))
  const target = getProjectConfigPath(cwd)
  await writeFile(target, '# 项目注释\nplugins:\n  other: # 其他插件\n    retained: true\n')
  await config.set({ value: 'project' }, { cwd })
  const text = await readFile(target, 'utf8')
  assert.match(text, /# 项目注释/u)
  assert.match(text, /# 其他插件/u)
  assert.match(text, /retained: true/u)
  assert.deepEqual(await config.get(), {})
  assert.deepEqual(readConfigSection('plugins', 'example', options.agentDir), {})
})

test('项目加密期间 Owner 失效时禁止发布，保留项目及全局文件', async (t) => {
  const { cwd, options, config } = fixture(t)
  await config.set({ global: true })
  await config.set({ value: 'before' }, { cwd })
  const projectPath = getProjectConfigPath(cwd)
  const globalPath = getUnifiedConfigPath(options.agentDir)
  const projectBefore = await readFile(projectPath)
  const globalBefore = await readFile(globalPath)
  let active = true
  const store = bindConfigStore('plugins', 'example', {
    ...options,
    assertActive() {
      if (!active) throw new Error('Owner 已失效')
    },
    keyProvider: async () => {
      active = false
      return options.keyProvider()
    }
  })
  await assert.rejects(store.set({ value: 'changed' }, { cwd, encryptPaths: ['/value'] }), /Owner/u)
  assert.deepEqual(await readFile(projectPath), projectBefore)
  assert.deepEqual(await readFile(globalPath), globalBefore)
})
