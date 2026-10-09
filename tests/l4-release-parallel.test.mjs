import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'
import { format } from 'node:util'
import {
  runAsync,
  runPackageTasks,
  waitForRegistryPackage
} from '../.github/scripts/release-npm.mjs'

// 避免 Node 22 把轮询日志与测试报告帧混读。
beforeEach((context) => {
  context.mock.method(console, 'info', (...args) => context.diagnostic(format(...args)))
})

function entry(name, dependencies = {}) {
  return { manifest: { name: `@jetcrab/${name}`, dependencies } }
}

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('独立包真正并行执行，消费者等待本批依赖就绪', async () => {
  const sdk = deferred()
  const consumers = deferred()
  const started = []
  const tasks = runPackageTasks(
    [
      entry('pi-desk-sdk'),
      entry('pi-desk-usage', { '@jetcrab/pi-desk-sdk': '^1.0.1-dev.1' }),
      entry('pi-desk-bg-run', { '@jetcrab/pi-desk-sdk': '^1.0.1-dev.1' }),
      entry('pi-desk-tool-reason')
    ],
    async ({ manifest }) => {
      started.push(manifest.name)
      if (manifest.name.endsWith('-sdk')) await sdk.promise
      else if (!manifest.name.endsWith('-tool-reason')) await consumers.promise
    }
  )
  await new Promise(setImmediate)
  assert.deepEqual(started, ['@jetcrab/pi-desk-sdk', '@jetcrab/pi-desk-tool-reason'])
  sdk.resolve()
  await new Promise(setImmediate)
  assert.ok(started.includes('@jetcrab/pi-desk-usage'))
  assert.ok(started.includes('@jetcrab/pi-desk-bg-run'))
  consumers.resolve()
  await tasks
})

test('依赖失败不执行消费者且等待其他已启动任务释放', async () => {
  const independent = deferred()
  const started = []
  let completed = false
  const tasks = runPackageTasks(
    [
      entry('pi-desk-sdk'),
      entry('pi-desk-usage', { '@jetcrab/pi-desk-sdk': '^1.0.1' }),
      entry('pi-desk-tool-reason')
    ],
    async ({ manifest }) => {
      started.push(manifest.name)
      if (manifest.name.endsWith('-sdk')) throw new Error('SDK fixture failed')
      await independent.promise
      completed = true
    }
  )
  let settled = false
  const checked = assert.rejects(tasks, /SDK fixture failed|任务.*失败|包.*失败/).then(() => {
    settled = true
  })
  await new Promise(setImmediate)
  assert.equal(settled, false)
  assert.equal(started.includes('@jetcrab/pi-desk-usage'), false)
  independent.resolve()
  await checked
  assert.equal(completed, true)
})

test('异步命令保留带空格参数并传播实际退出失败', async () => {
  const output = await runAsync(
    process.execPath,
    ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', 'value with spaces'],
    { capture: true }
  )
  assert.deepEqual(JSON.parse(output), ['value with spaces'])
  await assert.rejects(runAsync(process.execPath, ['-e', 'process.exit(7)']))
})

test('SDK发布后的Registry版本和tarball都可用才允许消费者发布', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  let metadataReads = 0
  let archiveReads = 0
  context.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (options?.method === 'HEAD') {
      archiveReads += 1
      return new Response('', { status: archiveReads === 1 ? 404 : 200 })
    }
    metadataReads += 1
    if (metadataReads === 1) return new Response('', { status: 404 })
    return Response.json({
      version: '1.0.1-dev.2',
      dist: { tarball: 'https://registry.npmjs.org/fixture-sdk.tgz' }
    })
  })
  let ready = false
  const waiting = waitForRegistryPackage('@jetcrab/pi-desk-sdk', '1.0.1-dev.2').then(() => {
    ready = true
  })
  await new Promise(setImmediate)
  assert.equal(ready, false)
  context.mock.timers.tick(5_000)
  await new Promise(setImmediate)
  assert.equal(ready, false)
  context.mock.timers.tick(5_000)
  await waiting
  assert.ok(metadataReads >= 2)
  assert.equal(archiveReads, 2)
})
