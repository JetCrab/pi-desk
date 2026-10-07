import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import {
  L4PiPluginHostBrowserResourceNotFoundError,
  readL4PiPluginHostBrowserResource
} from '../src/server/l4_foundation/pi/l4-pi-plugin-host-browser-resource'

test('Host Runtime 可以读取 SDK 基础公共资源', async () => {
  const resource = await readL4PiPluginHostBrowserResource('base.js')
  assert.ok(resource.size > 0)
  assert.match(resource.etag, /^W\/"[0-9a-f]+-[0-9a-f]+"$/)
  assert.match(await new Response(resource.stream).text(), /pi-desk-ui-root/)
})

test('Host Runtime 从 Pi Desk 包外部 cwd 启动时仍可解析 SDK', async () => {
  const originalCwd = process.cwd()
  const externalCwd = resolve('temp', 'pi', 'plugin-host-runtime-cwd-test', String(process.pid))
  const modulePath = resolve(
    originalCwd,
    'src/server/l4_foundation/pi/l4-pi-plugin-host-browser-resource.ts'
  )
  await mkdir(externalCwd, { recursive: true })

  try {
    process.chdir(externalCwd)
    const moduleUrl = `${pathToFileURL(modulePath).href}?external-cwd=${Date.now()}`
    const runtimeModule = await import(moduleUrl)
    const resource = await runtimeModule.readL4PiPluginHostBrowserResource('base.js')
    assert.ok(resource.size > 0)
  } finally {
    process.chdir(originalCwd)
    await rm(externalCwd, { recursive: true, force: true })
  }
})

test('Host Runtime 拒绝越界路径', async () => {
  await assert.rejects(
    () => readL4PiPluginHostBrowserResource('../package.json'),
    (error: unknown) => error instanceof L4PiPluginHostBrowserResourceNotFoundError
  )
  await assert.rejects(
    () => readL4PiPluginHostBrowserResource('base.js\\package.json'),
    (error: unknown) => error instanceof L4PiPluginHostBrowserResourceNotFoundError
  )
})
