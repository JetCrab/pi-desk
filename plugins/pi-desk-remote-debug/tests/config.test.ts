import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { readRemoteDebugConfig } from '../src/config.js'

const root = resolve('temp', 'pi', 'remote-debug-config-test', String(process.pid))

test.after(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writeConfig(cwd: string, content: string): Promise<void> {
  await mkdir(join(cwd, '.pi'), { recursive: true })
  await writeFile(join(cwd, '.pi', 'remote_debug.yaml'), content, 'utf8')
}

test('读取单入口 Profile 并按最长路径优先排序', async () => {
  const cwd = join(root, 'valid')
  await writeConfig(
    cwd,
    `version: 1
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

  const config = await readRemoteDebugConfig(cwd)

  assert.equal(config?.profiles.Web开发?.command, 'pnpm dev')
  assert.deepEqual(config?.profiles.Web开发?.routes, [
    { path: '/api/socket', targetPort: 8081 },
    { path: '/api', targetPort: 8080 }
  ])
})

test('不存在配置时返回 null，未知字段和根路由被拒绝', async () => {
  const empty = join(root, 'empty')
  await mkdir(empty, { recursive: true })
  assert.equal(await readRemoteDebugConfig(empty), null)

  const unknown = join(root, 'unknown')
  await writeConfig(
    unknown,
    `version: 1
profiles:
  web:
    command: pnpm dev
    entryPort: 30333
    publicPort: 43333
    autoOpen: true
`
  )
  await assert.rejects(readRemoteDebugConfig(unknown), /Unrecognized key|未知|autoOpen/)

  const rootRoute = join(root, 'root-route')
  await writeConfig(
    rootRoute,
    `version: 1
profiles:
  web:
    command: pnpm dev
    entryPort: 30333
    publicPort: 43333
    routes:
      /: 8080
`
  )
  await assert.rejects(readRemoteDebugConfig(rootRoute), /路由路径无效/)
})
