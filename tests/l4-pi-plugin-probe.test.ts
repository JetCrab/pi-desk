import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { runL4PiPluginProbe } from '../src/server/l4_foundation/pi/l4-pi-plugin-probe'

async function createFixture(
  context: test.TestContext,
  entry: string
): Promise<{ cwd: string; agentDir: string; packageRoot: string }> {
  const testRoot = resolve('temp', 'pi', 'plugin-probe-test')
  await mkdir(testRoot, { recursive: true })
  const root = await mkdtemp(join(testRoot, 'run-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'workspace')
  const packageRoot = join(root, 'fixture-package')
  await mkdir(join(agentDir, 'sessions'), { recursive: true })
  await mkdir(cwd, { recursive: true })
  await mkdir(packageRoot, { recursive: true })
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({ packages: [packageRoot] }),
    'utf8'
  )
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({
      name: 'plugin-probe-fixture',
      version: '1.0.0',
      type: 'module',
      piDesk: { entry: './entry.mjs' }
    }),
    'utf8'
  )
  await writeFile(join(packageRoot, 'entry.mjs'), entry, 'utf8')
  return { cwd, agentDir, packageRoot }
}

test('合并预检报告Native启动失败，修复后同一来源可通过', async (context) => {
  const { cwd, agentDir, packageRoot } = await createFixture(
    context,
    `export default { name: 'probe-fixture', setup() {} }`
  )
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({
      name: 'plugin-probe-fixture',
      type: 'module',
      piDesk: { entry: './entry.mjs' },
      pi: { extensions: ['./native.mjs'] }
    })
  )
  await writeFile(
    join(packageRoot, 'native.mjs'),
    `export default pi => {
    pi.on('session_start', () => { throw new Error('native startup fixture') })
  }`
  )
  const failed = await runL4PiPluginProbe(cwd, agentDir, true)
  assert.equal(failed.packages[0]?.status, 'ready')
  assert.match(failed.loadError ?? '', /native startup fixture/)
  await writeFile(join(packageRoot, 'native.mjs'), 'export default () => undefined')
  assert.equal((await runL4PiPluginProbe(cwd, agentDir, true)).loadError, null)
})

// 父进程通过 CLI 的 --conditions=react-server 加载服务端入口；
// 不通过 NODE_OPTIONS 给子进程补条件，确保验证生产启动参数。
test('安装预检子进程加载服务端模块并返回有效插件诊断', async (context) => {
  const { cwd, agentDir, packageRoot } = await createFixture(
    context,
    `export default {
  name: 'probe-fixture',
  setup() {
    return () => {}
  }
}
`
  )

  const diagnostics = await runL4PiPluginProbe(cwd, agentDir)
  assert.deepEqual(diagnostics, {
    loadError: null,
    packages: [
      {
        source: packageRoot,
        packageName: 'plugin-probe-fixture',
        version: '1.0.0',
        pluginName: 'probe-fixture',
        status: 'ready',
        error: null
      }
    ]
  })
})

test('安装预检子进程返回插件 setup 异常而非启动错误', async (context) => {
  const { cwd, agentDir } = await createFixture(
    context,
    `export default {
  name: 'probe-fixture',
  setup() {
    throw new Error('测试插件初始化失败')
  }
}
`
  )

  const diagnostics = await runL4PiPluginProbe(cwd, agentDir)
  assert.equal(diagnostics.loadError, null)
  assert.equal(diagnostics.packages.length, 1)
  assert.equal(diagnostics.packages[0]?.status, 'failed')
  assert.deepEqual(diagnostics.packages[0]?.error, {
    phase: 'setup',
    message: '测试插件初始化失败'
  })
})
