import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  reservePort,
  spawnEdge,
  stopBrowserTree,
  waitForBrowserReady
} from './l4-browser-cdp-runtime.mjs'

test('验收浏览器提前退出时报告启动错误而非空的HTTP超时', { timeout: 15_000 }, async (context) => {
  const root = resolve('temp/run/browser-startup')
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(join(root, 'invalid-browser-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const port = await reservePort()
  const browser = spawnEdge(process.execPath, port, directory)
  try {
    await assert.rejects(waitForBrowserReady(browser, port), /浏览器.*退出|浏览器.*启动失败/)
  } finally {
    await stopBrowserTree(browser, port)
  }
})
