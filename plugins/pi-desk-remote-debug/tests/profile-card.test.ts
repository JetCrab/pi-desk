import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { BrowserPluginHost } from '@jetcrab/pi-desk-sdk/browser'
import { ProfileCard } from '../src/views/l2-profile-card.js'
import type { RemoteDebugTunnelSnapshot } from '../src/l4-browser-tunnels.js'
import type { RemoteDebugRun } from '../src/runtime.js'

const run: RemoteDebugRun = {
  runId: 'local-first',
  cwd: '/fixture',
  profile: 'web',
  status: 'running',
  activity: '本地运行中，远程访问不可用',
  startedAt: 0,
  endedAt: null,
  publicUrl: null,
  localUrl: 'http://127.0.0.1:43191',
  gatewayPort: null,
  logPath: '/fixture/run.log',
  failure: { message: '远程访问不可用；本地访问仍可用' }
}
const publishedRun: RemoteDebugRun = {
  ...run,
  gatewayPort: 60497,
  publicUrl: 'http://tunnel.example:11001',
  failure: null
}

function renderCard(
  hostname: string,
  active: RemoteDebugRun = run,
  tunnel: RemoteDebugTunnelSnapshot | null = null
): string {
  const location = Object.getOwnPropertyDescriptor(globalThis, 'location')
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { hostname } })
  try {
    return renderToStaticMarkup(
      createElement(ProfileCard, {
        profile: {
          name: 'web',
          description: '',
          command: 'node server.mjs',
          entryPort: 43191,
          publicPort: 11001,
          routes: []
        },
        cwd: active.cwd,
        latest: active,
        active,
        pending: null,
        host: {} as BrowserPluginHost,
        mappingEnabled: true,
        tunnel,
        locale: 'zh-CN',
        timeZone: 'UTC',
        onStart: () => undefined,
        onRestart: () => undefined,
        onStop: () => undefined,
        onSendFailure: () => undefined
      })
    )
  } finally {
    if (location) Object.defineProperty(globalThis, 'location', location)
    else Reflect.deleteProperty(globalThis, 'location')
  }
}

for (const hostname of ['localhost', '127.0.0.1', '[::1]', 'remote.example']) {
  test(`${hostname} 在公网失败且 Gateway 未就绪时只展示实际可用的地址`, () => {
    const html = renderCard(hostname)
    if (hostname === 'remote.example') {
      assert.doesNotMatch(html, /href="http:\/\/127\.0\.0\.1:43191"/)
      assert.match(html, /本地连接不可用：远端隧道未就绪/)
      assert.match(html, /color:var\(--destructive\)/)
    } else {
      assert.match(html, /href="http:\/\/127\.0\.0\.1:43191"/)
      assert.doesNotMatch(html, /本地连接不可用|本地连接失败/)
    }
    assert.match(html, /运行中/)
  })
}

test('网关已创建但隧道发布未就绪时显示中性的准备状态', () => {
  const html = renderCard('remote.example', { ...publishedRun, publicUrl: null })
  assert.match(html, /正在准备本地连接…/)
  assert.doesNotMatch(html, /失败|color:var\(--destructive\)/)
  assert.doesNotMatch(html, /href="http:\/\/127\.0\.0\.1:/)
})

test('隧道发布就绪且映射正在建立时保留公网入口', () => {
  const html = renderCard('remote.example', publishedRun, {
    status: 'connecting',
    localPort: null,
    path: 'unknown',
    error: null
  })
  assert.match(html, /正在建立本地连接…/)
  assert.match(html, /href="http:\/\/tunnel\.example:11001"/)
  assert.doesNotMatch(html, /失败|color:var\(--destructive\)/)
})

for (const [error, reason] of [
  ['启用隧道前请填写控制服务地址', '当前电脑尚未配置隧道控制服务地址'],
  ['启用隧道前请填写控制密钥', '当前电脑尚未配置隧道控制密钥']
]) {
  test(`${error} 只显示未启用原因，不作为连接故障`, () => {
    const html = renderCard('remote.example', publishedRun, {
      status: 'failed',
      localPort: null,
      path: null,
      error
    })
    assert.ok(html.includes(`未启用：${reason}`))
    assert.match(html, /href="http:\/\/tunnel\.example:11001"/)
    assert.doesNotMatch(html, /失败|请填写|color:var\(--destructive\)/)
  })
}

test('实际连接超时仍显示故障原因和错误样式', () => {
  const html = renderCard('remote.example', publishedRun, {
    status: 'failed',
    localPort: null,
    path: null,
    error: '连接超时'
  })
  assert.match(html, /本地连接失败：连接超时/)
  assert.match(html, /color:var\(--destructive\)/)
  assert.match(html, /href="http:\/\/tunnel\.example:11001"/)
})

for (const [path, label] of [
  ['direct', '直连'],
  ['relay', '中继']
] as const) {
  test(`${label}映射就绪后展示当前电脑的映射地址`, () => {
    const html = renderCard('remote.example', publishedRun, {
      status: 'ready',
      localPort: 53191,
      path,
      error: null
    })
    assert.match(html, /href="http:\/\/127\.0\.0\.1:53191"/)
    assert.ok(html.includes(label))
    assert.match(html, /href="http:\/\/tunnel\.example:11001"/)
    assert.doesNotMatch(html, /href="http:\/\/127\.0\.0\.1:43191"|正在准备|正在建立|失败/)
  })
}
