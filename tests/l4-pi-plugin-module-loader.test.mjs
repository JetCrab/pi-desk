import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import {
  clearL4PiPluginCodeCache,
  loadL4PiDeskPluginEntry
} from '../src/server/l4_foundation/pi/l4-pi-plugin-module-loader.ts'

const runRoot = resolve(
  'temp',
  'tests',
  'l4-pi-plugin-module-loader',
  `${Date.now()}-${process.pid}`
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
