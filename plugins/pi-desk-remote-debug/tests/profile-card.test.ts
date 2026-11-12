import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { BrowserPluginHost } from '@jetcrab/pi-desk-sdk/browser'
import { ProfileCard } from '../src/views/l2-profile-card.js'
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

for (const hostname of ['localhost', '127.0.0.1', '[::1]', 'remote.example']) {
  test(`${hostname} 在公网失败且 Gateway 未就绪时只展示实际可用的地址`, () => {
    const location = Object.getOwnPropertyDescriptor(globalThis, 'location')
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { hostname } })
    try {
      const html = renderToStaticMarkup(
        createElement(ProfileCard, {
          profile: {
            name: 'web',
            description: '',
            command: 'node server.mjs',
            entryPort: 43191,
            publicPort: 11001,
            routes: []
          },
          cwd: run.cwd,
          latest: run,
          active: run,
          pending: null,
          host: {} as BrowserPluginHost,
          mappingEnabled: true,
          tunnel: null,
          locale: 'zh-CN',
          timeZone: 'UTC',
          onStart: () => undefined,
          onRestart: () => undefined,
          onStop: () => undefined,
          onSendFailure: () => undefined
        })
      )
      if (hostname === 'remote.example') {
        assert.doesNotMatch(html, /href="http:\/\/127\.0\.0\.1:43191"/)
        assert.match(html, /正在建立本地连接/)
      } else {
        assert.match(html, /href="http:\/\/127\.0\.0\.1:43191"/)
        assert.doesNotMatch(html, /正在建立本地连接|本地连接失败/)
      }
      assert.match(html, /运行中/)
    } finally {
      if (location) Object.defineProperty(globalThis, 'location', location)
      else Reflect.deleteProperty(globalThis, 'location')
    }
  })
}
