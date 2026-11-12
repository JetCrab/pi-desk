import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'
import {
  clearL4PiPluginCodeCache,
  loadL4PiDeskPluginEntry
} from '../src/server/l4_foundation/pi/l4-pi-plugin-module-loader.ts'

const runRoot = resolve(
  'temp',
  'tests',
  'l4-pi-plugin-module-loader',
  `hot-update-${Date.now()}-${process.pid}`
)
const packageRoot = join(runRoot, 'package')
const entryPath = join(packageRoot, 'entry.mjs')
const helperPath = join(packageRoot, 'helper.cjs')
const tlaEntryPath = join(packageRoot, 'top-level-await.mjs')

async function writeVersion(version) {
  await writeFile(helperPath, `module.exports = { version: '${version}' }\n`, 'utf8')
  await writeFile(
    entryPath,
    `import helper from './helper.cjs'\nexport default {\n  name: 'cache-fixture',\n  async setup(plugin) {\n    await Promise.resolve()\n    plugin.registerMethod('version', async () => ({ entryVersion: '${version}', helperVersion: helper.version }))\n  }\n}\n`,
    'utf8'
  )
}

test.after(async () => {
  clearL4PiPluginCodeCache()
  await rm(runRoot, { recursive: true, force: true })
})

test('复用代码缓存但为每次加载分别创建模块顶层和工厂状态', async () => {
  const root = join(runRoot, 'isolated-modules')
  const entry = join(root, 'entry.mjs')
  await mkdir(root, { recursive: true })
  await writeFile(
    join(root, 'helper.mjs'),
    'let count = 0\nexport function next() { return ++count }\n',
    'utf8'
  )
  await writeFile(
    entry,
    `import { next } from './helper.mjs'
let count = 0
export default function () {
  let factoryCount = 0
  return () => ({ module: ++count, helper: next(), factory: ++factoryCount })
}
`,
    'utf8'
  )
  const [first, second] = await Promise.all([
    loadL4PiDeskPluginEntry(entry, root),
    loadL4PiDeskPluginEntry(entry, root)
  ])
  const readFirst = first.default()
  const readSecond = second.default()
  assert.deepEqual(readFirst(), { module: 1, helper: 1, factory: 1 })
  assert.deepEqual(readFirst(), { module: 2, helper: 2, factory: 2 })
  assert.deepEqual(readSecond(), { module: 1, helper: 1, factory: 1 })
})

test('新加载读取入口及相对依赖的新代码而不替换旧模块', async () => {
  const root = join(runRoot, 'explicit-invalidation')
  const entry = join(root, 'entry.mjs')
  const helper = join(root, 'helper.mjs')
  await mkdir(root, { recursive: true })
  const update = async (version) => {
    await writeFile(helper, `export const version = '${version}'\n`, 'utf8')
    await writeFile(
      entry,
      `import { version } from './helper.mjs'\nexport default () => ({ entry: '${version}', helper: version })\n`,
      'utf8'
    )
  }
  await update('v1')
  const first = await loadL4PiDeskPluginEntry(entry, root)
  assert.deepEqual(first.default(), { entry: 'v1', helper: 'v1' })
  await update('v2')
  const second = await loadL4PiDeskPluginEntry(entry, root)
  assert.deepEqual(second.default(), { entry: 'v2', helper: 'v2' })
  await writeFile(helper, `export const version = 'v3'\n`, 'utf8')
  const dependencyChanged = await loadL4PiDeskPluginEntry(entry, root)
  assert.deepEqual(dependencyChanged.default(), { entry: 'v2', helper: 'v3' })
  clearL4PiPluginCodeCache()
  const refreshed = await loadL4PiDeskPluginEntry(entry, root)
  assert.deepEqual(refreshed.default(), { entry: 'v2', helper: 'v3' })
  assert.deepEqual(first.default(), { entry: 'v1', helper: 'v1' })
  assert.deepEqual(second.default(), { entry: 'v2', helper: 'v2' })
})

test('导入失败不保留坏源码，修复后可以再次加载', async () => {
  const root = join(runRoot, 'failed-import')
  const entry = join(root, 'entry.mjs')
  await mkdir(root, { recursive: true })
  await writeFile(entry, 'export default (\n', 'utf8')
  await assert.rejects(loadL4PiDeskPluginEntry(entry, root))
  await writeFile(entry, 'export default () => 42\n', 'utf8')
  const fixed = await loadL4PiDeskPluginEntry(entry, root)
  assert.equal(fixed.default(), 42)
})

test('同一进程升级依赖后读取新增及改写的 exports，不改变旧实例', async () => {
  const root = join(runRoot, 'sdk-exports-upgrade')
  const dependency = join(root, 'node_modules/test-hot-sdk')
  const entry = join(root, 'entry.mjs')
  await mkdir(dependency, { recursive: true })
  const manifest = (exports) => JSON.stringify({ name: 'test-hot-sdk', type: 'module', exports })
  await writeFile(join(dependency, 'package.json'), manifest({ './entry': './old.mjs' }))
  await writeFile(join(dependency, 'old.mjs'), 'export const version = 1')
  await writeFile(
    entry,
    "import { version } from 'test-hot-sdk/entry'; export default () => version"
  )
  const nativeRequire = createRequire(entry)
  nativeRequire.resolve('test-hot-sdk/entry')
  assert.throws(() => nativeRequire.resolve('test-hot-sdk/config'), {
    code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'
  })
  const old = await loadL4PiDeskPluginEntry(entry, root)
  assert.equal(old.default(), 1)
  const probe = join(root, 'probe.mjs')
  await writeFile(probe, "import 'test-hot-sdk/config'; export default {}")
  await assert.rejects(loadL4PiDeskPluginEntry(probe, root), /not exported|not defined/)

  await writeFile(join(dependency, 'new.mjs'), 'export const version = 2')
  await writeFile(join(dependency, 'config.mjs'), "export const config = 'new-config'")
  await writeFile(
    join(dependency, 'package.json'),
    manifest({
      './entry': './new.mjs',
      './config': {
        types: './config.d.ts',
        node: { import: './config.mjs', default: './config.mjs' }
      }
    })
  )
  await writeFile(
    entry,
    "import { version } from 'test-hot-sdk/entry'; import { config } from 'test-hot-sdk/config'; export default () => ({ version, config })"
  )
  const updated = await loadL4PiDeskPluginEntry(entry, root)
  assert.deepEqual(updated.default(), { version: 2, config: 'new-config' })
  assert.equal(old.default(), 1)
})

test('已加载的子入口取消导出后立即拒绝，即使原文件仍存在', async () => {
  const root = join(runRoot, 'exports-revoked')
  const dependency = join(root, 'node_modules/test-hot-sdk')
  const entry = join(root, 'entry.mjs')
  await mkdir(dependency, { recursive: true })
  await writeFile(join(dependency, 'config.mjs'), 'export default 1')
  await writeFile(
    join(dependency, 'package.json'),
    JSON.stringify({
      name: 'test-hot-sdk',
      exports: { './config': './config.mjs' }
    })
  )
  await writeFile(entry, "export { default } from 'test-hot-sdk/config'")
  assert.equal((await loadL4PiDeskPluginEntry(entry, root)).default, 1)
  await writeFile(
    join(dependency, 'package.json'),
    JSON.stringify({
      name: 'test-hot-sdk',
      exports: { './config': null }
    })
  )
  await assert.rejects(loadL4PiDeskPluginEntry(entry, root), /not exported/)
})

test('按每层调用模块查找依赖，嵌套 SDK 与另一个插件版本不混用', async () => {
  const loaded = []
  for (const [name, value] of [
    ['plugin-a', 'A'],
    ['plugin-b', 'B']
  ]) {
    const root = join(runRoot, 'dependency-isolation', name)
    const inner = join(root, 'node_modules/test-consumer')
    for (const [parent, label] of [
      [root, value],
      [inner, `${value}-inner`]
    ]) {
      const dependency = join(parent, 'node_modules/test-hot-sdk')
      await mkdir(dependency, { recursive: true })
      await writeFile(
        join(dependency, 'package.json'),
        JSON.stringify({
          name: 'test-hot-sdk',
          exports: { './features/*': { browser: './absent.mjs', node: ['./*.mjs'] } }
        })
      )
      await writeFile(join(dependency, 'config.mjs'), `export default '${label}'`)
    }
    await writeFile(
      join(inner, 'package.json'),
      JSON.stringify({
        name: 'test-consumer',
        exports: './index.mjs'
      })
    )
    await writeFile(
      join(inner, 'index.mjs'),
      "export { default } from 'test-hot-sdk/features/config'"
    )
    const entry = join(root, 'entry.mjs')
    await writeFile(
      entry,
      "import own from 'test-hot-sdk/features/config'; import inner from 'test-consumer'; export default { own, inner }"
    )
    loaded.push(await loadL4PiDeskPluginEntry(entry, root))
  }
  assert.deepEqual(loaded[0].default, { own: 'A', inner: 'A-inner' })
  assert.deepEqual(loaded[1].default, { own: 'B', inner: 'B-inner' })
})

test('延迟 import 和 require.resolve 使用当前 exports，并保留模块严格模式', async () => {
  const root = join(runRoot, 'deferred-resolution')
  const dependency = join(root, 'node_modules/test-hot-sdk')
  const entry = join(root, 'entry.mjs')
  await mkdir(dependency, { recursive: true })
  const manifest = (file) => JSON.stringify({ name: 'test-hot-sdk', exports: { './config': file } })
  await writeFile(join(dependency, 'package.json'), manifest('./old.mjs'))
  await writeFile(join(dependency, 'old.mjs'), 'export default 1')
  await writeFile(join(dependency, 'new.mjs'), 'export default 2')
  await writeFile(
    entry,
    `#!/usr/bin/env node
/* fixture module header */
export default {
  read: async () => (await import('test-hot-sdk/config')).default,
  locate: () => require.resolve('test-hot-sdk/config'),
  strict: () => (function () { return this })()
}
`
  )
  const loaded = (await loadL4PiDeskPluginEntry(entry, root)).default
  assert.equal(await loaded.read(), 1)
  assert.equal(loaded.strict(), undefined)
  assert.match(loaded.locate(), /old\.mjs$/)
  await writeFile(join(dependency, 'package.json'), manifest('./new.mjs'))
  assert.equal(await loaded.read(), 2)
  assert.match(loaded.locate(), /new\.mjs$/)
})

test('CommonJS入口也采用最新包入口，不影响宿主提供的 Pi 模块', async () => {
  const root = join(runRoot, 'cjs-entry')
  const dependency = join(root, 'node_modules/test-hot-sdk')
  const entry = join(root, 'entry.cjs')
  await mkdir(dependency, { recursive: true })
  await writeFile(
    join(dependency, 'package.json'),
    JSON.stringify({
      name: 'test-hot-sdk',
      exports: { '.': { require: './entry.mjs', import: './absent.mjs' } }
    })
  )
  await writeFile(join(dependency, 'entry.mjs'), 'export const value = 7')
  await writeFile(
    entry,
    `
const { value } = require('test-hot-sdk')
const { getAgentDir } = require('@earendil-works/pi-coding-agent')
module.exports = { value, coreAvailable: typeof getAgentDir === 'function' }
`
  )
  assert.deepEqual((await loadL4PiDeskPluginEntry(entry, root)).default, {
    value: 7,
    coreAvailable: true
  })
})

test('Node Entry 同路径重载刷新 CJS helper 并保留 async setup 边界', async () => {
  await mkdir(dirname(entryPath), { recursive: true })
  await writeVersion('v1')
  const readVersion = async () => {
    const loaded = await loadL4PiDeskPluginEntry(entryPath, packageRoot)
    let execute
    await loaded.default.setup({
      registerMethod(_name, handler) {
        execute = handler
      }
    })
    assert.ok(execute)
    return execute({}, {})
  }

  assert.deepEqual(await readVersion(), { entryVersion: 'v1', helperVersion: 'v1' })
  await writeVersion('v2')
  clearL4PiPluginCodeCache()
  assert.deepEqual(await readVersion(), { entryVersion: 'v2', helperVersion: 'v2' })

  await writeFile(tlaEntryPath, `await Promise.resolve()\nexport default {}\n`, 'utf8')
  await assert.rejects(
    loadL4PiDeskPluginEntry(tlaEntryPath, packageRoot),
    /不支持模块顶层 await，请将异步初始化放入 async setup\(\)/
  )
})
