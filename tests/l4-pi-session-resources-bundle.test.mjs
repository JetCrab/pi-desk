import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { bundleL4ServerModule } from './l4-webpack-test-runtime.mjs'

const require = createRequire(import.meta.url)
const execute = promisify(execFile)

test('生产产物迁移安装目录后仍可直接加载原目录插件资源', async () => {
  const projectRoot = process.cwd()
  const id = `plugin-resources-${randomUUID()}`
  const build = resolve('temp/build/pi-session-resources', id)
  const run = resolve('temp/run/pi-session-resources', id)
  const host = join(run, '应用安装目录 with spaces')
  let passed = false
  try {
    await bundleL4ServerModule(build, './src/server/l4_foundation/pi/l4-pi-session-resources.ts')
    await mkdir(host, { recursive: true })
    await writeFile(join(host, 'package.json'), '{"private":true}\n')
    await symlink(
      join(projectRoot, 'node_modules'),
      join(host, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const bundle = join(host, 'runtime.mjs')
    await copyFile(join(build, 'runtime.mjs'), bundle)
    await rm(build, { recursive: true, force: true })
    const env = {
      ...process.env,
      NODE_ENV: 'production',
      PI_DESK_TEST_RESOURCE_BUNDLE: pathToFileURL(bundle).href
    }
    // 子测试是独立运行器，不继承当前 node:test 的内部通信通道。
    delete env.NODE_TEST_CONTEXT
    let result
    try {
      result = await execute(
        process.execPath,
        [
          '--import',
          pathToFileURL(require.resolve('tsx')).href,
          '--test',
          join(projectRoot, 'tests/l4-pi-session-resources.test.ts')
        ],
        {
          cwd: host,
          env,
          timeout: 45_000,
          windowsHide: true
        }
      )
    } catch (error) {
      await writeFile(join(run, 'failure.log'), `${error.stdout ?? ''}\n${error.stderr ?? ''}`)
      throw error
    }
    await writeFile(join(run, 'result.log'), `${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /# fail 0/)
    const content = await readFile(bundle, 'utf8')
    for (const fileName of ['l4-pi-session-resources.ts', 'l4-pi-plugin-module-loader.ts']) {
      const source = pathToFileURL(join(projectRoot, 'src/server/l4_foundation/pi', fileName)).href
      assert.ok(!content.includes(source), '运行时加载器不得绑定构建机源码的绝对地址')
    }
    passed = true
  } finally {
    if (passed) {
      await Promise.all([build, run].map((path) => rm(path, { recursive: true, force: true })))
    } else {
      console.error(`插件会话打包回归失败，现场：${run}`)
    }
  }
})
